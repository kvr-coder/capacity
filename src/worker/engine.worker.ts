/**
 * The model, running off the main thread.
 *
 * ---------------------------------------------------------------------------
 * What lives here and what leaves
 * ---------------------------------------------------------------------------
 * The `Snapshot` — 15,000 materials, ~54,000 routing operations, two plan
 * matrices of a million-odd doubles — is created here on `init` and **never
 * leaves**. What crosses to the main thread is:
 *
 *   - the {@link CatalogPayload} once, after init: plants, work centers,
 *     classes, features, standard operations, families, groups, and a group ->
 *     material COUNT. Tens of kilobytes, not tens of megabytes.
 *   - a `ModelResult` per run: the 150 x 78 pool grids and the judged cells.
 *   - a page of answers per detail request, sorted and sliced **here**, so the
 *     UI never receives 15,000 of anything.
 *
 * `LoadOutput.hoursByGroup`, `LoadOutput.unitsByRow`, the `SourcingPlan` planes
 * and the routing resolution stay in this file. They are what the detail
 * requests are answered *from*, not what is posted.
 *
 * ---------------------------------------------------------------------------
 * Caching, because a drag re-runs the model on every drop
 * ---------------------------------------------------------------------------
 * Three caches, four entries each, keyed off the scenario's **enabled-move
 * fingerprint**:
 *
 *   appliedCache   fingerprint -> applied snapshot. `exportCsv` needs only this.
 *   ctxCache       (fingerprint, ceiling) -> the whole {@link RunContext}. This
 *                  is the expensive one: indexes, OEE grid, capacity, sourcing
 *                  and the load explosion.
 *   resultCache    (fingerprint, ceiling, filters, aggregatesOnly) -> the posted
 *                  `ModelResult`.
 *
 * A repeat request with an unchanged scenario and filter is a `Map.get`. A
 * filter-only change re-runs `summariseAll` + `rankBottlenecks` over the cached
 * load — milliseconds, not the whole explosion — because filters cannot change
 * a single hour in the grids, only which of them are counted.
 *
 * ---------------------------------------------------------------------------
 * Why the posted arrays are copies that are then transferred
 * ---------------------------------------------------------------------------
 * Transferring a `Float64Array` detaches it in the sender. Transferring the
 * grids the cache holds would empty the cache on the first post, which is the
 * exact opposite of the point. So each post copies the arrays (one memcpy of
 * ~1MB, sub-millisecond) and transfers **the copies** — the structured clone
 * algorithm would have copied them anyway, so this is one copy instead of two
 * and the cache survives.
 */

import type {
  CapacityPool,
  EngineOptions,
  Filters,
  GroupId,
  MaterialId,
  ModelResult,
  PlantId,
  PoolLoadGrid,
  RoutingOperation,
  Scenario,
  Snapshot,
  WeekIndex,
  WorkCenterId,
  WorkCenterWeekLoad,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import type { RunContext } from '@/domain/engine'
import type { AppliedMoves } from '@/domain/moves'
import type {
  CatalogPayload,
  MaterialSliceRow,
  WorkCenterDetail,
  WorkerRequest,
  WorkerResponse,
} from '@/worker/protocol'

import { buildSnapshot, profileById } from '@/data/factory'
import { loadSnapshot } from '@/data/sap-loader'
import { writeTable } from '@/data/sap-writer'
import { buildIndexes } from '@/domain/indexes'
import { baselineScenario, defaultFilters, runModelWithContext } from '@/domain/engine'
import { applyMoves } from '@/domain/moves'
import { buildFilterContext, rollup, summariseAll } from '@/domain/rollup'
import { findRelief, rankBottlenecks } from '@/domain/relief'
import { sharedCapacityLinks } from '@/domain/capability'
import { slippedWindow } from '@/domain/capacity'
import { findMaterial, quoteRate, resolveOperation } from '@/domain/rates'
import { buildOeeGrid, resolveOee } from '@/domain/oee'
import { SOURCING_PLANES } from '@/domain/sourcing'
import { at, clamp, key, round, safeDiv } from '@/domain/lookup'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Entries held per cache. Four covers baseline + the scenario being edited. */
const CACHE_ENTRIES = 4

/**
 * Composition series per work center before the tail folds into "Other". The
 * palette has five categorical slots and a reserved `--series-other`; inventing
 * a ninth hue is forbidden, so the fold happens here where the hours are,
 * rather than in a component that would have to guess.
 */
const MAX_GROUP_SERIES = 7

/** The id carried by the folded series. Colour it with `var(--series-other)`. */
export const OTHER_GROUP_ID = '__other__'

/** Shared-capacity links returned with a work-center detail. */
const MAX_SIBLINGS = 12

/** Materials named in a work-center detail. The full list is `materialSlice`. */
const MAX_TOP_MATERIALS = 12

/** Hard cap on a `materialSlice` page, whatever the caller asked for. */
const MAX_SLICE_ROWS = 500

/** Relief candidates when the request does not say. */
const DEFAULT_RELIEF_CANDIDATES = 8

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

function i32(a: Int32Array, i: number): number {
  return a[i] ?? -1
}

function nowMs(): number {
  return typeof performance === 'object' ? performance.now() : 0
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined
}

/** Insertion-ordered LRU. Small enough that `Map` re-insertion is the whole trick. */
class Lru<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly limit: number) {}

  get(k: string): V | undefined {
    const value = this.entries.get(k)
    if (value === undefined) return undefined
    this.entries.delete(k)
    this.entries.set(k, value)
    return value
  }

  set(k: string, value: V): void {
    if (this.entries.has(k)) this.entries.delete(k)
    this.entries.set(k, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

/**
 * A scenario's identity for caching: its id plus every ENABLED move, in `seq`
 * order. Toggling a move off must miss; re-ordering the log without changing
 * what is enabled must hit.
 *
 * Key collisions are impossible (the move payloads are serialised in full);
 * false misses are possible if two structurally identical moves were built with
 * their keys in a different order, and a false miss only costs a re-run.
 */
function scenarioFingerprint(scenario: Scenario): string {
  const enabled = scenario.moves.filter((m) => m.enabled)
  enabled.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const parts: string[] = [scenario.id, String(enabled.length)]
  for (const move of enabled) parts.push(`${move.seq}~${move.id}~${JSON.stringify(move.move)}`)
  return parts.join('')
}

function sortedJoin(values: readonly string[]): string {
  return [...values].sort().join(',')
}

function filtersKey(filters: Filters): string {
  return [
    sortedJoin(filters.plantIds),
    sortedJoin(filters.regions),
    sortedJoin(filters.familyIds),
    sortedJoin(filters.groupIds),
    sortedJoin(filters.workCenterIds),
    sortedJoin(filters.machineClassIds),
    filters.fromWeek,
    filters.toWeek,
    filters.bucket,
  ].join('')
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type Emit = (response: WorkerResponse, transfer?: Transferable[]) => void

export interface EngineSession {
  /** Handle one request, emitting progress and exactly one terminal response. */
  handle(request: WorkerRequest, emit: Emit): void
}

/** A cached run, plus the lazily-derived tables the detail requests need. */
interface RunEntry {
  ctx: RunContext
  fingerprint: string
  /** 1/OEE per work-center week. Built on first SKU-level request, not per run. */
  inverseOee: Float64Array | null
  /** Materials carrying a `materialWorkCenter` OEE override — the slow path. */
  materialOee: Set<MaterialId> | null
  /** `row * weekCount + week` -> judged cell. */
  cellByRowWeek: Array<WorkCenterWeekLoad | undefined> | null
}

interface MaterialAgg {
  units: number
  hours: number
  workCenters: Set<WorkCenterId>
  plants: Set<PlantId>
  dualSourced: boolean
}

/**
 * Everything the worker owns for one dataset. A second `init` replaces it
 * wholesale — including every cache, because a cached run over the previous
 * snapshot is not a stale answer, it is a wrong one.
 */
export function createEngineSession(): EngineSession {
  let snapshot: Snapshot | null = null
  let loadWarnings: string[] = []

  /**
   * The global ceiling the last `run` used. Follow-up requests (rollup, detail,
   * relief, slice) carry no `EngineOptions`, and answering them off a context
   * built with a different ceiling would quietly contradict the numbers already
   * on screen.
   */
  let sessionCeiling: number | undefined

  const appliedCache = new Lru<AppliedMoves>(CACHE_ENTRIES)
  const ctxCache = new Lru<RunEntry>(CACHE_ENTRIES)
  const resultCache = new Lru<ModelResult>(CACHE_ENTRIES)
  const aggregateCache = new Lru<Map<MaterialId, MaterialAgg>>(CACHE_ENTRIES)

  function clearCaches(): void {
    appliedCache.clear()
    ctxCache.clear()
    resultCache.clear()
    aggregateCache.clear()
    sessionCeiling = undefined
  }

  function requireSnapshot(): Snapshot {
    if (snapshot === null) {
      throw new Error('Engine not initialised — send an `init` request before anything else.')
    }
    return snapshot
  }

  // -------------------------------------------------------------------------
  // Pipeline access
  // -------------------------------------------------------------------------

  function applied(scenario: Scenario): AppliedMoves {
    const fingerprint = scenarioFingerprint(scenario)
    const cached = appliedCache.get(fingerprint)
    if (cached !== undefined) return cached
    const result = applyMoves(requireSnapshot(), scenario)
    appliedCache.set(fingerprint, result)
    return result
  }

  function ctxKey(fingerprint: string, ceiling: number | undefined): string {
    return `${fingerprint}${ceiling === undefined ? 'default' : String(ceiling)}`
  }

  /**
   * The run context for a scenario, from cache when possible.
   *
   * `filters` only reach the KPI and bottleneck passes, so a cached context
   * built under a different filter is still correct — see {@link resultFor}.
   */
  function ensureRun(
    scenario: Scenario,
    filters: Filters,
    options: EngineOptions | undefined,
  ): RunEntry {
    const ceiling = options?.utilisationCeiling ?? sessionCeiling
    const fingerprint = scenarioFingerprint(scenario)
    const cacheKey = ctxKey(fingerprint, ceiling)
    const cached = ctxCache.get(cacheKey)
    if (cached !== undefined) return cached

    const snap = requireSnapshot()
    const ctx = runModelWithContext(snap, scenario, filters, {
      ...options,
      utilisationCeiling: ceiling,
      now: nowMs,
    })
    const entry: RunEntry = {
      ctx,
      fingerprint,
      inverseOee: null,
      materialOee: null,
      cellByRowWeek: null,
    }
    ctxCache.set(cacheKey, entry)
    // The moved snapshot came free with the run; `exportCsv` should never pay
    // for `applyMoves` again.
    appliedCache.set(fingerprint, {
      snapshot: ctx.snapshot,
      capexUsd: ctx.capexUsd,
      warnings: ctx.warnings,
      effectiveScenario: scenario,
      freightUsd: ctx.freightUsd,
    })
    resultCache.set(resultKey(cacheKey, filters, options), ctx.result)
    return entry
  }

  function resultKey(
    contextKey: string,
    filters: Filters,
    options: EngineOptions | undefined,
  ): string {
    return `${contextKey}${filtersKey(filters)}${options?.aggregatesOnly === true ? 'agg' : 'full'}`
  }

  /**
   * The `ModelResult` for a filter, off an already-computed context.
   *
   * This is the same assembly `runModelWithContext` performs — deliberately, so
   * that changing a filter costs the two passes that actually depend on it
   * rather than the whole explosion. Every number comes from the same domain
   * functions the engine itself calls; nothing is recomputed differently here.
   */
  function resultFor(
    entry: RunEntry,
    scenario: Scenario,
    filters: Filters,
    options: EngineOptions | undefined,
  ): ModelResult {
    const startedAt = nowMs()
    const ctx = entry.ctx
    const { total, byWeek } = summariseAll(ctx.load, ctx.snapshot, ctx.indexes, filters, ctx.capexUsd)
    const bottlenecks = rankBottlenecks(ctx.snapshot, ctx.indexes, ctx.load, filters)
    return {
      scenarioId: scenario.id,
      time: ctx.snapshot.time,
      grids: ctx.load.grids,
      cells: options?.aggregatesOnly === true ? [] : ctx.load.cells,
      kpis: total,
      kpisByWeek: byWeek,
      bottlenecks,
      oeeByWorkCenterWeek: ctx.oeeGrid,
      runtimeMs: nowMs() - startedAt,
      capexUsd: ctx.capexUsd,
      warnings: ctx.warnings,
    }
  }

  function runFor(
    scenario: Scenario,
    filters: Filters,
    options: EngineOptions | undefined,
  ): ModelResult {
    const ceiling = options?.utilisationCeiling ?? sessionCeiling
    const entry = ensureRun(scenario, filters, options)
    const cacheKey = resultKey(ctxKey(entry.fingerprint, ceiling), filters, options)
    const cached = resultCache.get(cacheKey)
    if (cached !== undefined) return cached
    const result = resultFor(entry, scenario, filters, options)
    resultCache.set(cacheKey, result)
    return result
  }

  // -------------------------------------------------------------------------
  // Lazily-derived tables
  // -------------------------------------------------------------------------

  function inverseOeeOf(entry: RunEntry): Float64Array {
    const existing = entry.inverseOee
    if (existing !== null) return existing
    const grid = entry.ctx.oeeGrid
    const inverse = new Float64Array(grid.length)
    for (let i = 0; i < grid.length; i += 1) {
      const oee = f64(grid, i)
      inverse[i] = oee > 0 ? 1 / oee : 0
    }
    entry.inverseOee = inverse
    return inverse
  }

  function materialOeeOf(entry: RunEntry): Set<MaterialId> {
    const existing = entry.materialOee
    if (existing !== null) return existing
    const set = new Set<MaterialId>()
    for (const override of entry.ctx.snapshot.oeeOverrides) {
      if (override.scope === 'materialWorkCenter' && override.materialId !== undefined) {
        set.add(override.materialId)
      }
    }
    entry.materialOee = set
    return set
  }

  function cellsOf(entry: RunEntry): Array<WorkCenterWeekLoad | undefined> {
    const existing = entry.cellByRowWeek
    if (existing !== null) return existing
    const idx = entry.ctx.indexes
    const weeks = idx.weekCount
    const table = new Array<WorkCenterWeekLoad | undefined>(idx.workCenterOrder.length * weeks)
    for (const cell of entry.ctx.load.cells) {
      const row = idx.workCenterRow.get(cell.workCenterId)
      if (row === undefined || cell.week < 0 || cell.week >= weeks) continue
      table[row * weeks + cell.week] = cell
    }
    entry.cellByRowWeek = table
    return table
  }

  // -------------------------------------------------------------------------
  // SKU-level aggregation — the only pass that touches all 15,000 materials
  // -------------------------------------------------------------------------

  /**
   * Machine hours and units per material over the filtered window.
   *
   * This mirrors the arithmetic in `buildLoad` exactly — reverse yield
   * compounding, OEE applied through the same reciprocal table, setup charged
   * once per (work center, material, week) — so a material's hours here sum to
   * the hours in the grids rather than merely resembling them.
   *
   * It is the expensive call in this file (one walk of the supply plan), which
   * is why the result is cached per (scenario, filters, focus) and why nothing
   * on the aggregate path ever calls it.
   */
  function aggregateMaterials(
    entry: RunEntry,
    filters: Filters,
    focusWorkCenter: WorkCenterId | undefined,
    focusGroup: GroupId | undefined,
  ): Map<MaterialId, MaterialAgg> {
    const ctx = entry.ctx
    const snap = ctx.snapshot
    const idx = ctx.indexes
    const weeks = idx.weekCount
    const wcCount = idx.workCenterOrder.length
    const rows = snap.supplyPlan.rowKeys.length
    const planeSize = rows * weeks

    const out = new Map<MaterialId, MaterialAgg>()
    if (rows === 0 || weeks === 0) return out

    let focusRow = -1
    if (focusWorkCenter !== undefined) {
      const resolved = idx.workCenterRow.get(focusWorkCenter)
      if (resolved === undefined) return out
      focusRow = resolved
    }

    const fc = buildFilterContext(snap, idx, ctx.load, filters)
    const from = fc.fromWeek
    const to = fc.toWeek
    const supply = snap.supplyPlan.values
    const units = ctx.load.unitsByRow
    const routingOf = ctx.sourcing.routingOfRow
    const shareOf = ctx.sourcing.shareOfRow
    const inverse = inverseOeeOf(entry)
    const perMaterialOee = materialOeeOf(entry)
    const wcPass = fc.workCenterPass

    // Setup is a lot cost: charged once per (work center, material, week). The
    // stamp is the supply row + 1, exactly as in `buildLoad`, so no clearing
    // pass is needed between rows.
    const setupStamp = new Int32Array(wcCount * weeks)

    /**
     * With a work-center focus, most of the 15,000 materials never go near it.
     * Deciding that from the routing's operation list — before any rate
     * resolution — is what turns "click a work center" from a quarter of a
     * second into a few milliseconds. 0 unknown, 1 touches, 2 does not.
     */
    const routingTouchesFocus = focusRow >= 0 ? new Uint8Array(snap.routings.length) : null
    const touchesFocus = (routingIndex: number): boolean => {
      if (routingTouchesFocus === null) return true
      const memo = routingTouchesFocus[routingIndex] ?? 0
      if (memo !== 0) return memo === 1
      let hit = false
      for (const op of at(snap.routings, routingIndex, 'routing').operations) {
        if (op.workCenterId === focusWorkCenter) {
          hit = true
          break
        }
      }
      routingTouchesFocus[routingIndex] = hit ? 1 : 2
      return hit
    }

    // Scratch reused across every routing run; nothing is allocated per week.
    let scratch = 8
    let opWcRow = new Int32Array(scratch)
    let opMachinePerUnit = new Float64Array(scratch)
    let opSetup = new Float64Array(scratch)
    let opInvCumYield = new Float64Array(scratch)
    const ensureScratch = (n: number): void => {
      if (n <= scratch) return
      scratch = n
      opWcRow = new Int32Array(scratch)
      opMachinePerUnit = new Float64Array(scratch)
      opSetup = new Float64Array(scratch)
      opInvCumYield = new Float64Array(scratch)
    }

    for (let row = 0; row < rows; row += 1) {
      if (fc.supplyRowPass[row] !== 1) continue
      const materialId = fc.supplyRowMaterial[row] ?? ''
      if (materialId === '') continue
      const material = idx.materialById.get(materialId)
      if (material === undefined) continue
      if (focusGroup !== undefined && material.groupId !== focusGroup) continue

      const rowBase = row * weeks

      // With a focus, a row that never runs there is not part of the answer at
      // all — not even as a zero. Decided before anything is allocated for it.
      if (focusRow >= 0) {
        let relevant = false
        for (let plane = 0; plane < SOURCING_PLANES && !relevant; plane += 1) {
          const planeBase = plane * planeSize + rowBase
          let seen = -1
          for (let w = from; w <= to; w += 1) {
            const routingIndex = i32(routingOf, planeBase + w)
            if (routingIndex < 0 || routingIndex === seen) continue
            seen = routingIndex
            if (touchesFocus(routingIndex)) {
              relevant = true
              break
            }
          }
        }
        if (!relevant) continue
      }

      let placed = 0
      for (let w = from; w <= to; w += 1) placed += f64(units, rowBase + w)

      let agg = out.get(materialId)
      if (agg === undefined) {
        agg = {
          units: 0,
          hours: 0,
          workCenters: new Set<WorkCenterId>(),
          plants: new Set<PlantId>(),
          dualSourced: false,
        }
        out.set(materialId, agg)
      }
      agg.units += placed
      const plantId = fc.supplyRowPlant[row] ?? ''
      if (plantId !== '') agg.plants.add(plantId)
      const rowKey = at(snap.supplyPlan.rowKeys, row, 'supply row key')
      if (ctx.sourcing.dualSourced.has(rowKey)) agg.dualSourced = true

      const stamp = row + 1
      const slowOee = perMaterialOee.has(materialId)

      for (let plane = 0; plane < SOURCING_PLANES; plane += 1) {
        const planeBase = plane * planeSize + rowBase
        let w = from
        while (w <= to) {
          const routingIndex = i32(routingOf, planeBase + w)
          if (routingIndex < 0) {
            w += 1
            continue
          }
          // Weeks that share a routing share its resolution — resolve once.
          let end = w + 1
          while (end <= to && i32(routingOf, planeBase + end) === routingIndex) end += 1
          if (!touchesFocus(routingIndex)) {
            w = end
            continue
          }

          const routing = at(snap.routings, routingIndex, 'routing')
          const ops = orderedOperations(routing.operations)
          const opCount = ops.length
          if (opCount > 0) {
            ensureScratch(opCount)
            let cumulative = 1
            for (let p = opCount - 1; p >= 0; p -= 1) {
              const op = at(ops, p, 'routing operation')
              const resolved = resolveOperation(snap, idx, materialId, op, 1)
              const wcRow = idx.workCenterRow.get(op.workCenterId)
              opWcRow[p] = wcRow === undefined ? -1 : wcRow
              opMachinePerUnit[p] = Number.isFinite(resolved.machineHoursPerUnit)
                ? resolved.machineHoursPerUnit
                : 0
              opSetup[p] = resolved.setupHours
              const y = resolved.yield > 0 && resolved.yield <= 1 ? resolved.yield : 1
              cumulative *= y
              opInvCumYield[p] = 1 / cumulative
            }

            for (let week = w; week < end; week += 1) {
              const share = f64(shareOf, planeBase + week)
              if (share <= 0) continue
              const qty = f64(supply, rowBase + week) * share
              if (qty <= 0) continue
              for (let p = 0; p < opCount; p += 1) {
                const wcRow = i32(opWcRow, p)
                if (wcRow < 0) continue
                if (wcPass[wcRow] !== 1) continue
                if (focusRow >= 0 && wcRow !== focusRow) continue
                const op = at(ops, p, 'routing operation')
                const gridIndex = wcRow * weeks + week
                const factor = slowOee
                  ? inverseFor(snap, idx, ctx.oeeGrid, op.workCenterId, materialId, week)
                  : f64(inverse, gridIndex)
                const gross = qty * f64(opInvCumYield, p)
                let hours = gross * f64(opMachinePerUnit, p) * factor
                const setup = f64(opSetup, p)
                if (setup > 0 && i32(setupStamp, gridIndex) !== stamp) {
                  setupStamp[gridIndex] = stamp
                  hours += setup
                }
                if (hours <= 0) continue
                agg.hours += hours
                agg.workCenters.add(op.workCenterId)
              }
            }
          }
          w = end
        }
      }
    }

    return out
  }

  function cachedAggregate(
    entry: RunEntry,
    filters: Filters,
    focusWorkCenter: WorkCenterId | undefined,
    focusGroup: GroupId | undefined,
  ): Map<MaterialId, MaterialAgg> {
    const cacheKey = [
      entry.fingerprint,
      filtersKey(filters),
      focusWorkCenter ?? '',
      focusGroup ?? '',
    ].join('')
    const cached = aggregateCache.get(cacheKey)
    if (cached !== undefined) return cached
    const computed = aggregateMaterials(entry, filters, focusWorkCenter, focusGroup)
    aggregateCache.set(cacheKey, computed)
    return computed
  }

  // -------------------------------------------------------------------------
  // Request handlers
  // -------------------------------------------------------------------------

  function handleInit(request: Extract<WorkerRequest, { type: 'init' }>, emit: Emit): void {
    const startedAt = nowMs()
    snapshot = null
    loadWarnings = []
    clearCaches()

    let built: Snapshot
    if (request.source.kind === 'factory') {
      const profile = profileById(request.source.profile)
      const seed = Number.isFinite(request.source.seed) ? request.source.seed : profile.seed
      emit({
        id: request.id,
        type: 'progress',
        phase: `Generating ${profile.label}`,
        pct: 0.04,
      })
      try {
        built = buildSnapshot({ ...profile, seed })
      } catch (error) {
        // The factory asserts its own invariants (every operation must have
        // somewhere to move load to, or the cockpit has nothing to show), and
        // not every seed satisfies them at every profile size. A rejected seed
        // must not leave the planner with an empty screen: fall back to the
        // profile's own seed, which is the one the factory is calibrated for.
        // `catalog.meta.seed` reports what was actually used.
        if (seed === profile.seed) throw error
        emit({
          id: request.id,
          type: 'progress',
          phase: `Seed ${seed} was rejected by the data factory — regenerating with ${profile.seed}`,
          pct: 0.05,
        })
        built = buildSnapshot(profile)
      }
    } else {
      emit({ id: request.id, type: 'progress', phase: 'Parsing SAP extract', pct: 0.04 })
      const loaded = loadSnapshot(request.source.files, {
        generatedBy: 'sap-extract',
        sourceLabel: 'SAP extract',
      })
      if (loaded.errors.length > 0) {
        const head = loaded.errors.slice(0, 10).join('\n')
        const more = loaded.errors.length > 10 ? `\n…and ${loaded.errors.length - 10} more` : ''
        throw new Error(`SAP extract rejected:\n${head}${more}`)
      }
      built = loaded.snapshot
      loadWarnings = loaded.warnings
    }
    const generatedAt = nowMs()

    emit({ id: request.id, type: 'progress', phase: 'Indexing master data', pct: 0.62 })
    snapshot = built
    const indexes = buildIndexes(built)
    const indexedAt = nowMs()

    // Warm the caches with the baseline over the whole horizon, so the first
    // `run` the UI sends after `ready` is a cache hit rather than a stall.
    emit({ id: request.id, type: 'progress', phase: 'Running the baseline', pct: 0.76 })
    const entry = ensureRun(baselineScenario(), defaultFilters(built), undefined)
    const ranAt = nowMs()

    emit({ id: request.id, type: 'progress', phase: 'Ready', pct: 1 })
    emit({
      id: request.id,
      type: 'ready',
      catalog: buildCatalog(built, indexes),
      timings: {
        generateMs: round(generatedAt - startedAt, 1),
        indexMs: round(indexedAt - generatedAt, 1),
        firstRunMs: round(ranAt - indexedAt, 1),
        totalMs: round(ranAt - startedAt, 1),
        modelRuntimeMs: round(entry.ctx.result.runtimeMs, 1),
        warnings: entry.ctx.warnings.length + loadWarnings.length,
      },
    })
  }

  function handleRun(request: Extract<WorkerRequest, { type: 'run' }>, emit: Emit): void {
    // A `run` is the authority on the global ceiling; dropping the option means
    // "back to the default", not "keep the last one I sent".
    sessionCeiling = request.options?.utilisationCeiling
    const result = runFor(request.scenario, request.filters, request.options)
    const transported = transportResult(result, loadWarnings)
    emit({ id: request.id, type: 'result', result: transported.result }, transported.transfer)
  }

  function handleRollup(request: Extract<WorkerRequest, { type: 'rollup' }>, emit: Emit): void {
    const entry = ensureRun(request.scenario, request.filters, undefined)
    const ctx = entry.ctx
    const { cells, kpis } = rollup({
      snap: ctx.snapshot,
      idx: ctx.indexes,
      load: ctx.load,
      filters: request.filters,
      level: request.level,
      parentKey: request.parentKey,
    })
    emit({ id: request.id, type: 'rollup', level: request.level, cells, kpis })
  }

  function handleWorkCenterDetail(
    request: Extract<WorkerRequest, { type: 'workCenterDetail' }>,
    emit: Emit,
  ): void {
    const entry = ensureRun(request.scenario, request.filters, undefined)
    const ctx = entry.ctx
    const idx = ctx.indexes
    const weeks = idx.weekCount
    const row = idx.workCenterRow.get(request.workCenterId)
    if (row === undefined) {
      throw new Error(`Work center not in this snapshot: ${request.workCenterId}`)
    }
    const lastWeek = Math.max(0, weeks - 1)
    const from = clamp(Math.floor(request.filters.fromWeek), 0, lastWeek)
    const to = Math.max(from, clamp(Math.floor(request.filters.toWeek), 0, lastWeek))
    const width = to - from + 1
    const cellTable = cellsOf(entry)

    // ---- judged cells, week-ordered ---------------------------------------
    const cells: WorkCenterWeekLoad[] = []
    for (let w = from; w <= to; w += 1) {
      const cell = cellTable[row * weeks + w]
      if (cell !== undefined) cells.push(cell)
    }

    // ---- composition by product group -------------------------------------
    const prefix = key(request.workCenterId, '')
    const series: Array<{ groupId: string; label: string; hours: number[]; total: number }> = []
    for (const [composite, weekly] of ctx.load.hoursByGroup) {
      if (!composite.startsWith(prefix)) continue
      const groupId = composite.slice(prefix.length)
      const hours: number[] = []
      let total = 0
      for (let w = from; w <= to; w += 1) {
        const value = f64(weekly, w)
        hours.push(round(value, 2))
        total += value
      }
      if (total <= 0) continue
      series.push({
        groupId,
        label: idx.groupById.get(groupId)?.name ?? groupId,
        hours,
        total,
      })
    }
    series.sort((a, b) => b.total - a.total || (a.groupId < b.groupId ? -1 : 1))
    const groupHours = foldTail(series, width)

    // ---- shared capacity ---------------------------------------------------
    const siblings: WorkCenterDetail['siblings'] = []
    for (const link of sharedCapacityLinks(idx, request.workCenterId)) {
      if (link.basis === 'none') continue
      const siblingRow = idx.workCenterRow.get(link.workCenterId)
      if (siblingRow === undefined) continue
      siblings.push({
        workCenterId: link.workCenterId,
        basis: link.basis,
        sharedOperations: link.sharedOperations,
        utilisation: round(
          windowUtilisation(ctx, cellTable, siblingRow, weeks, from, to),
          4,
        ),
      })
      if (siblings.length >= MAX_SIBLINGS) break
    }

    // ---- OEE ---------------------------------------------------------------
    const oeeByWeek: number[] = []
    for (let w = from; w <= to; w += 1) oeeByWeek.push(round(f64(ctx.oeeGrid, row * weeks + w), 4))

    // ---- planned downtime, in its MODELLED (slipped) position --------------
    const downtimeByWeek: WorkCenterDetail['downtimeByWeek'] = []
    for (const event of idx.downtimeByWorkCenter.get(request.workCenterId) ?? []) {
      const window = slippedWindow(event)
      const start = Math.max(window.from, from)
      const finish = Math.min(window.to, to)
      for (let w = start; w <= finish; w += 1) {
        // Attribution when events overlap is ambiguous by construction; the
        // grid is the ceiling, so a request for more hours than existed is
        // reported as the hours actually lost, never as the ask.
        const removable = poolDowntime(ctx, event.pools, row, weeks, w)
        const requested = event.hoursPerWeek === undefined ? removable : event.hoursPerWeek
        const lost = Math.min(requested, removable)
        if (lost <= 0) continue
        downtimeByWeek.push({
          week: w,
          hours: round(lost, 2),
          kind: event.kind,
          label: event.label,
        })
      }
    }
    downtimeByWeek.sort((a, b) => a.week - b.week || (a.label < b.label ? -1 : 1))

    // ---- the SKUs behind the hours ----------------------------------------
    const aggregates = cachedAggregate(entry, request.filters, request.workCenterId, undefined)
    const ranked: Array<{ materialId: MaterialId; hours: number; units: number }> = []
    for (const [materialId, agg] of aggregates) {
      if (agg.hours <= 0) continue
      ranked.push({ materialId, hours: agg.hours, units: agg.units })
    }
    ranked.sort((a, b) => b.hours - a.hours || (a.materialId < b.materialId ? -1 : 1))
    const topMaterials: WorkCenterDetail['topMaterials'] = []
    for (const item of ranked.slice(0, MAX_TOP_MATERIALS)) {
      const material = idx.materialById.get(item.materialId)
      topMaterials.push({
        materialId: item.materialId,
        code: material?.code ?? item.materialId,
        hours: round(item.hours, 2),
        units: round(item.units, 2),
      })
    }

    const detail: WorkCenterDetail = {
      workCenterId: request.workCenterId,
      cells,
      groupHours,
      siblings,
      oeeByWeek,
      downtimeByWeek,
      topMaterials,
    }
    emit({ id: request.id, type: 'workCenterDetail', detail })
  }

  function handleRelief(request: Extract<WorkerRequest, { type: 'relief' }>, emit: Emit): void {
    const entry = ensureRun(request.scenario, request.filters, undefined)
    const ctx = entry.ctx
    const max =
      request.maxCandidates !== undefined && request.maxCandidates > 0
        ? request.maxCandidates
        : DEFAULT_RELIEF_CANDIDATES
    const candidates = findRelief(
      ctx.snapshot,
      ctx.indexes,
      ctx.load,
      request.filters,
      request.workCenterId,
      max,
    )
    emit({
      id: request.id,
      type: 'relief',
      workCenterId: request.workCenterId,
      candidates,
    })
  }

  function handleMaterialSlice(
    request: Extract<WorkerRequest, { type: 'materialSlice' }>,
    emit: Emit,
  ): void {
    const entry = ensureRun(request.scenario, request.filters, undefined)
    const idx = entry.ctx.indexes
    const aggregates = cachedAggregate(
      entry,
      request.filters,
      request.workCenterId,
      request.groupId,
    )

    const rows: MaterialSliceRow[] = []
    for (const [materialId, agg] of aggregates) {
      // A work-center focus means "SKUs that run here" — a material with no
      // hours on it is not in the answer, however much volume it has elsewhere.
      if (request.workCenterId !== undefined && agg.hours <= 0) continue
      if (agg.units <= 0 && agg.hours <= 0) continue
      const material = idx.materialById.get(materialId)
      if (material === undefined) continue
      rows.push({
        materialId,
        code: material.code,
        description: material.description,
        groupId: material.groupId,
        familyId: material.familyId,
        units: round(agg.units, 2),
        hours: round(agg.hours, 2),
        workCenterIds: [...agg.workCenters].sort(),
        plantIds: [...agg.plants].sort(),
        dualSourced: agg.dualSourced,
      })
    }

    // Sorting and paging happen HERE. The main thread receives at most `limit`.
    switch (request.sortBy) {
      case 'units':
        rows.sort((a, b) => b.units - a.units || (a.code < b.code ? -1 : 1))
        break
      case 'code':
        rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        break
      case 'hours':
      default:
        rows.sort((a, b) => b.hours - a.hours || (a.code < b.code ? -1 : 1))
        break
    }

    const total = rows.length
    const offset = clamp(Math.floor(request.offset), 0, total)
    const limit = clamp(Math.floor(request.limit), 0, MAX_SLICE_ROWS)
    emit({
      id: request.id,
      type: 'materialSlice',
      rows: rows.slice(offset, offset + limit),
      total,
    })
  }

  /**
   * What one (material, work center, operation) runs at today.
   *
   * Answered off the SCENARIO being edited, so the number the form starts from
   * is the number on screen — including a rate override an earlier move in the
   * same log already placed. Unresolvable triples come back with a status and
   * no rate: a form that invents 100 eaches/hour is the bug this exists to
   * remove, and inventing one here instead would only move it.
   */
  function handleResolveRate(
    request: Extract<WorkerRequest, { type: 'resolveRate' }>,
    emit: Emit,
  ): void {
    const entry = ensureRun(request.scenario, request.filters, undefined)
    const ctx = entry.ctx
    const idx = ctx.indexes
    const weeks = idx.weekCount
    const week = weeks === 0 ? 0 : clamp(Math.round(request.week), 0, weeks - 1)

    const materialId = findMaterial(ctx.snapshot, idx, request.material)
    // `resolveOee` throws for a work center outside the grid, and an unknown
    // work center is a question to answer, not a failure to report.
    const known =
      materialId !== undefined && idx.workCenterRow.get(request.workCenterId) !== undefined
    const oee = known
      ? resolveOee(ctx.snapshot, idx, ctx.oeeGrid, request.workCenterId, materialId, week)
      : 0
    const quote = quoteRate(
      ctx.snapshot,
      idx,
      request.material,
      request.workCenterId,
      request.opId,
      oee,
    )
    emit({ id: request.id, type: 'resolvedRate', quote })
  }

  function handleExportCsv(
    request: Extract<WorkerRequest, { type: 'exportCsv' }>,
    emit: Emit,
  ): void {
    // The export must describe the scenario on screen, so it is written off the
    // MOVED snapshot — which the applied cache usually already holds.
    const moved = applied(request.scenario).snapshot
    emit({
      id: request.id,
      type: 'csv',
      table: request.table,
      content: writeTable(moved, request.table),
    })
  }

  function handle(request: WorkerRequest, emit: Emit): void {
    try {
      switch (request.type) {
        case 'init':
          handleInit(request, emit)
          return
        case 'run':
          handleRun(request, emit)
          return
        case 'rollup':
          handleRollup(request, emit)
          return
        case 'workCenterDetail':
          handleWorkCenterDetail(request, emit)
          return
        case 'relief':
          handleRelief(request, emit)
          return
        case 'materialSlice':
          handleMaterialSlice(request, emit)
          return
        case 'resolveRate':
          handleResolveRate(request, emit)
          return
        case 'exportCsv':
          handleExportCsv(request, emit)
          return
        default: {
          // Exhaustive: `request` is `never` here unless the protocol grew.
          const unknown: { id?: unknown; type?: unknown } = request
          emit({
            id: typeof unknown.id === 'number' ? unknown.id : 0,
            type: 'error',
            message: `Unknown request type: ${String(unknown.type)}`,
          })
          return
        }
      }
    } catch (error) {
      // A throw inside a worker with no handler is invisible. Every failure
      // becomes a typed response carrying the message AND the stack, addressed
      // to the request that caused it, so the client can reject one promise
      // rather than hanging every one of them.
      emit({
        id: request.id,
        type: 'error',
        message: messageOf(error),
        stack: stackOf(error),
      })
    }
  }

  return { handle }
}

// ---------------------------------------------------------------------------
// Pure helpers used by the session
// ---------------------------------------------------------------------------

/** Routing operations in `seq` order, copying only when they are not already. */
function orderedOperations(ops: readonly RoutingOperation[]): readonly RoutingOperation[] {
  for (let p = 1; p < ops.length; p += 1) {
    const prev = ops[p - 1]
    const current = ops[p]
    if (prev !== undefined && current !== undefined && current.seq < prev.seq) {
      return [...ops].sort((a, b) => a.seq - b.seq)
    }
  }
  return ops
}

function inverseFor(
  snap: Snapshot,
  idx: SnapshotIndexes,
  grid: Float64Array,
  workCenterId: WorkCenterId,
  materialId: MaterialId,
  week: WeekIndex,
): number {
  const oee = resolveOee(snap, idx, grid, workCenterId, materialId, week)
  return oee > 0 ? 1 / oee : 0
}

/** Window utilisation of the binding pool, against the ceiling on that row. */
function windowUtilisation(
  ctx: RunContext,
  cells: Array<WorkCenterWeekLoad | undefined>,
  row: number,
  weeks: number,
  from: WeekIndex,
  to: WeekIndex,
): number {
  const machine = ctx.load.grids.machine
  const labour = ctx.load.grids.labour
  let ceiling = 1
  let machineRequired = 0
  let machineAvailable = 0
  let labourRequired = 0
  let labourAvailable = 0
  for (let w = from; w <= to; w += 1) {
    const i = row * weeks + w
    machineRequired += f64(machine.requiredHours, i)
    machineAvailable += f64(machine.availableHours, i)
    labourRequired += f64(labour.requiredHours, i)
    labourAvailable += f64(labour.availableHours, i)
    const cell = cells[i]
    if (cell !== undefined && Number.isFinite(cell.ceiling) && cell.ceiling > 0) ceiling = cell.ceiling
  }
  const machineUtilisation = safeDiv(machineRequired, machineAvailable * ceiling)
  const labourUtilisation = safeDiv(labourRequired, labourAvailable * ceiling)
  return Math.max(machineUtilisation, labourUtilisation)
}

/** Hours the grids say were lost in one week, on the pools an event blocks. */
function poolDowntime(
  ctx: RunContext,
  pools: readonly CapacityPool[],
  row: number,
  weeks: number,
  week: WeekIndex,
): number {
  let most = 0
  for (const pool of pools) {
    const lost = f64(ctx.load.grids[pool].downtimeHours, row * weeks + week)
    if (lost > most) most = lost
  }
  return most
}

/**
 * Keep the loudest groups, fold the rest into one "Other" series.
 *
 * The palette has five categorical slots plus a reserved neutral; a chart that
 * invents a ninth hue has left the validated palette behind. Folding here means
 * the component never has to.
 */
function foldTail(
  series: Array<{ groupId: string; label: string; hours: number[]; total: number }>,
  width: number,
): WorkCenterDetail['groupHours'] {
  const strip = (s: { groupId: string; label: string; hours: number[] }): {
    groupId: string
    label: string
    hours: number[]
  } => ({ groupId: s.groupId, label: s.label, hours: s.hours })

  if (series.length <= MAX_GROUP_SERIES + 1) return series.map(strip)

  const head = series.slice(0, MAX_GROUP_SERIES).map(strip)
  const other = new Array<number>(width).fill(0)
  for (const rest of series.slice(MAX_GROUP_SERIES)) {
    for (let w = 0; w < width; w += 1) other[w] = (other[w] ?? 0) + (rest.hours[w] ?? 0)
  }
  head.push({
    groupId: OTHER_GROUP_ID,
    label: 'Other',
    hours: other.map((h) => round(h, 2)),
  })
  return head
}

function buildCatalog(snap: Snapshot, idx: SnapshotIndexes): CatalogPayload {
  const materialCountByGroup: Record<string, number> = {}
  for (const group of snap.groups) {
    materialCountByGroup[group.id] = idx.materialsByGroup.get(group.id)?.length ?? 0
  }
  return {
    meta: snap.meta,
    time: snap.time,
    plants: snap.plants,
    workCenters: snap.workCenters,
    machineClasses: snap.machineClasses,
    features: snap.features,
    standardOperations: snap.standardOperations,
    families: snap.families,
    groups: snap.groups,
    materialCountByGroup,
    // The cascade lives here; the move editor needs its answer to default a
    // glide's start value to where the chosen scope actually runs today.
    baselineOee: {
      workCenterIds: [...idx.workCenterOrder],
      weekCount: idx.weekCount,
      values: buildOeeGrid(snap, idx),
    },
  }
}

/**
 * Copy the dense arrays out of the cached result and hand the copies over by
 * transfer. See the file header for why this is a copy rather than a transfer
 * of the originals.
 */
function transportResult(
  result: ModelResult,
  extraWarnings: readonly string[],
): { result: ModelResult; transfer: Transferable[] } {
  const transfer: Transferable[] = []
  const copy = (source: Float64Array): Float64Array => {
    const clone = new Float64Array(source)
    transfer.push(clone.buffer as ArrayBuffer)
    return clone
  }
  const copyPool = (grid: PoolLoadGrid): PoolLoadGrid => ({
    workCenterIds: grid.workCenterIds,
    weekCount: grid.weekCount,
    availableHours: copy(grid.availableHours),
    requiredHours: copy(grid.requiredHours),
    downtimeHours: copy(grid.downtimeHours),
    overloadHours: copy(grid.overloadHours),
    setupHours: copy(grid.setupHours),
  })
  return {
    result: {
      ...result,
      grids: {
        machine: copyPool(result.grids.machine),
        labour: copyPool(result.grids.labour),
      },
      oeeByWorkCenterWeek: copy(result.oeeByWorkCenterWeek),
      warnings:
        extraWarnings.length > 0 ? [...extraWarnings, ...result.warnings] : result.warnings,
    },
    transfer,
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

interface IncomingMessage {
  readonly data: unknown
}

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: IncomingMessage) => void): void
}

/**
 * True only inside a dedicated worker.
 *
 * This module is also imported directly by `client.ts` when a worker cannot be
 * constructed, and installing a `message` listener on `window` in that case
 * would make the page answer every `postMessage` any script on it sends.
 */
function isWorkerScope(): boolean {
  const scope: { WorkerGlobalScope?: unknown; document?: unknown } = globalThis
  return typeof scope.WorkerGlobalScope !== 'undefined' && typeof scope.document === 'undefined'
}

function asRequest(value: unknown): WorkerRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate: { id?: unknown; type?: unknown } = value
  if (typeof candidate.id !== 'number' || typeof candidate.type !== 'string') return null
  return value as WorkerRequest
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as WorkerScope
  const session = createEngineSession()
  scope.addEventListener('message', (event: IncomingMessage) => {
    const request = asRequest(event.data)
    if (request === null) {
      scope.postMessage({
        id: 0,
        type: 'error',
        message: 'Worker received a message that is not a WorkerRequest.',
      })
      return
    }
    try {
      session.handle(request, (response, transfer) => {
        if (transfer !== undefined && transfer.length > 0) scope.postMessage(response, transfer)
        else scope.postMessage(response)
      })
    } catch (error) {
      // `handle` catches its own failures; this covers a failure to POST one —
      // a non-cloneable payload, for instance, which would otherwise be silent.
      scope.postMessage({
        id: request.id,
        type: 'error',
        message: messageOf(error),
        stack: stackOf(error),
      })
    }
  })
}
