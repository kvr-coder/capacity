/**
 * OEE: the cascade and the glide path.
 *
 * OEE is one of the two independent knobs (the other is rate). It carries every
 * *unplanned* loss — the losses that have no date and never will. Planned loss
 * is a dated `DowntimeEvent` and is subtracted from available hours somewhere
 * else entirely; giving unplanned loss a date would be a precise-looking lie.
 *
 * Resolution is most-specific-wins, in this order:
 *
 *   plant default -> workCenter.baseOee -> OeeOverride(plant)
 *     -> OeeOverride(workCenter) -> glide path -> OeeOverride(materialWorkCenter)
 *
 * Every step except the last depends only on (work center, week), so the whole
 * cascade up to and including glide paths is materialised once per run into a
 * work-center x week `Float64Array` by {@link buildOeeGrid}. `resolveOee` reads
 * that grid and only does extra work when a material-specific override exists —
 * which is the rare case, and must not cost anything in the common one.
 *
 * Overrides carrying `fromWeek`/`toWeek` apply only inside that window. Where
 * two overrides of the same scope cover the same week, the later entry in
 * `snapshot.oeeOverrides` wins — scenario moves append, so "last edit wins" is
 * what a planner expects.
 *
 * PROVENANCE OUTRANKS ALL OF IT. Both `OeeOverride` and `OeeGlidePath` carry a
 * `source`, and an entry a scenario move introduced beats one from master data
 * over every week both cover — whatever its scope, window or `fromWeek`. The
 * cascade above orders background data against background data; it must never
 * be the reason a planner's own logged decision disappears. Within one
 * provenance tier the ordering above is unchanged.
 */

import type {
  OeeGlidePath,
  OeeOverride,
  MaterialId,
  PlantId,
  Snapshot,
  WeekIndex,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import { clamp, key } from '@/domain/lookup'

/**
 * Every resolved OEE is clamped to this band. Nothing in a factory runs at 0%
 * (that is a downtime event, not an efficiency) and nothing sustains above 98%
 * (that is a data error, and it would quietly manufacture capacity). The clamp
 * is applied at the end of the cascade, so an override of 1.4 reads as 0.98
 * rather than being silently discarded.
 */
export const OEE_MIN = 0.05
export const OEE_MAX = 0.98

/** Reached only when a work center references a plant that is not in the snapshot. */
const FALLBACK_OEE = 0.85

function inWindow(override: OeeOverride, week: WeekIndex): boolean {
  if (override.fromWeek !== undefined && week < override.fromWeek) return false
  if (override.toWeek !== undefined && week > override.toWeek) return false
  return true
}

function usable(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0
}

/**
 * The value a glide path produces at `week`.
 *
 * - Before `fromWeek` the path has no effect at all — `startValue` (the value
 *   that resolved without it) is returned untouched.
 * - At and after `toWeek` the path HOLDS `endValue`. An improvement programme
 *   that landed does not decay because the chart ran out of weeks.
 * - `path.startValue` beats the passed `startValue`; the argument is the "or
 *   whatever resolves today" fallback for paths that do not declare one.
 *
 * Deliberately NOT clamped: this is the interpolator, and clamping here would
 * make a test of the curve shape depend on the band. {@link resolveOee} and
 * {@link buildOeeGrid} apply the OEE_MIN..OEE_MAX clamp.
 */
export function evaluateGlide(path: OeeGlidePath, week: WeekIndex, startValue: number): number {
  if (week < path.fromWeek) return startValue
  const start = path.startValue !== undefined ? path.startValue : startValue
  if (week >= path.toWeek || path.toWeek <= path.fromWeek) return path.endValue
  const t = (week - path.fromWeek) / (path.toWeek - path.fromWeek)
  let f: number
  switch (path.curve) {
    case 'linear':
      f = t
      break
    case 'sCurve':
      // Smoothstep: slow, fast, slow. How improvement programmes actually land.
      f = t * t * (3 - 2 * t)
      break
    case 'step':
      // Nothing happens until the week it lands; the >= toWeek branch above is
      // the jump itself.
      f = 0
      break
  }
  return start + (path.endValue - start) * f
}

/** 1 for a path or override a scenario move introduced, 0 for master data. */
function tierOf(item: { source?: 'master' | 'scenario' }): number {
  return item.source === 'scenario' ? 1 : 0
}

interface RankedPath {
  path: OeeGlidePath
  /** 1 = introduced by a scenario move, 0 = master data. Outranks everything. */
  tier: number
  /** plant-scope 0, workCenter-scope 1 — the tie-break at equal fromWeek. */
  specificity: number
  order: number
}

/**
 * Sorted ascending in precedence, so for a given week the winner is the LAST
 * entry whose `fromWeek` is at or before it.
 *
 * PROVENANCE FIRST: a path a scenario move introduced beats one that came from
 * master data over any week both cover, whatever their `fromWeek`. A planner's
 * logged decision is not background data and must not lose to it.
 *
 * Within one provenance tier the older rule stands: greatest `fromWeek` wins in
 * its window, equal `fromWeek` broken by scope (a work-center path beats a
 * plant-wide one) and then by declaration order.
 */
function rankPaths(entries: RankedPath[]): RankedPath[] {
  return entries.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.path.fromWeek - b.path.fromWeek ||
      a.specificity - b.specificity ||
      a.order - b.order,
  )
}

interface RankedOverride {
  override: OeeOverride
  /** 1 = introduced by a scenario move, 0 = master data. Outranks everything. */
  tier: number
  /** plant-scope 0, workCenter-scope 1. */
  specificity: number
  order: number
}

/**
 * The same rule, for the plant- and work-center-scope overrides `oeeSet`
 * writes. Before provenance was carried, a scenario `oeeSet` at plant scope
 * lost to any SEEDED work-center override covering the same week, because
 * specificity was applied first — the identical silent defeat the glide paths
 * suffered. With all entries at one tier this reproduces the old order exactly
 * (plant list first, then work-center list, later entry winning).
 */
function rankOverrides(entries: RankedOverride[]): RankedOverride[] {
  return entries.sort(
    (a, b) => a.tier - b.tier || a.specificity - b.specificity || a.order - b.order,
  )
}

function pushInto<T>(map: Map<string, T[]>, k: string, value: T): void {
  const bucket = map.get(k)
  if (bucket) bucket.push(value)
  else map.set(k, [value])
}

/**
 * The cascade up to and including glide paths, as a work-center x week grid
 * indexed `row * weekCount + week` with `row` from `idx.workCenterRow`.
 *
 * 150 x 78 is 11,700 doubles — built once per run, read millions of times.
 */
export function buildOeeGrid(snap: Snapshot, idx: SnapshotIndexes): Float64Array {
  const weekCount = idx.weekCount
  const grid = new Float64Array(idx.workCenterOrder.length * weekCount)

  const plantOverrides = new Map<PlantId, RankedOverride[]>()
  const wcOverrides = new Map<WorkCenterId, RankedOverride[]>()
  for (let i = 0; i < snap.oeeOverrides.length; i += 1) {
    const override = snap.oeeOverrides[i]
    if (override === undefined) continue
    if (override.scope === 'plant' && override.plantId !== undefined) {
      pushInto(plantOverrides, override.plantId, {
        override,
        tier: tierOf(override),
        specificity: 0,
        order: i,
      })
    } else if (override.scope === 'workCenter' && override.workCenterId !== undefined) {
      pushInto(wcOverrides, override.workCenterId, {
        override,
        tier: tierOf(override),
        specificity: 1,
        order: i,
      })
    }
  }

  // A plant-scope glide path is expanded to its work centers here, so the
  // per-work-center loop below never has to ask which scope it is looking at.
  const pathsByWc = new Map<WorkCenterId, RankedPath[]>()
  for (let i = 0; i < snap.glidePaths.length; i += 1) {
    const path = snap.glidePaths[i]
    if (path === undefined) continue
    const tier = tierOf(path)
    if (path.scope === 'workCenter' && path.workCenterId !== undefined) {
      pushInto(pathsByWc, path.workCenterId, { path, tier, specificity: 1, order: i })
    } else if (path.scope === 'plant' && path.plantId !== undefined) {
      for (const wc of idx.workCentersByPlant.get(path.plantId) ?? []) {
        pushInto(pathsByWc, wc.id, { path, tier, specificity: 0, order: i })
      }
    }
  }
  for (const entries of pathsByWc.values()) rankPaths(entries)

  // Pre-glide values for the row being built. The glide pass reads this rather
  // than the grid, because the start of a path is "whatever resolved at
  // fromWeek" — a week the glide pass may already have overwritten.
  const preGlide = new Float64Array(weekCount)

  for (const wcId of idx.workCenterOrder) {
    const wc = idx.workCenterById.get(wcId)
    const row = idx.workCenterRow.get(wcId)
    if (wc === undefined || row === undefined) continue
    const offset = row * weekCount

    const plant = idx.plantById.get(wc.plantId)
    const plantDefault = usable(plant?.defaultOee) && plant ? plant.defaultOee : FALLBACK_OEE
    const base = usable(wc.baseOee) ? wc.baseOee : plantDefault

    // One list, ranked provenance-first: the LAST applicable entry wins.
    const overrides = rankOverrides([
      ...(plantOverrides.get(wc.plantId) ?? []),
      ...(wcOverrides.get(wcId) ?? []),
    ])
    for (let w = 0; w < weekCount; w += 1) {
      let value = base
      for (let i = overrides.length - 1; i >= 0; i -= 1) {
        const entry = overrides[i]
        if (entry !== undefined && inWindow(entry.override, w)) {
          value = entry.override.value
          break
        }
      }
      preGlide[w] = value
    }

    const paths = pathsByWc.get(wcId)
    if (paths === undefined || paths.length === 0) {
      for (let w = 0; w < weekCount; w += 1) {
        grid[offset + w] = clamp(preGlide[w] ?? base, OEE_MIN, OEE_MAX)
      }
      continue
    }

    for (let w = 0; w < weekCount; w += 1) {
      // `paths` is sorted ascending in precedence, so the winner is the last
      // applicable entry. A single forward walk no longer works: provenance
      // ranks above fromWeek, so fromWeek is not monotonic across the list.
      let entry: RankedPath | undefined
      for (let i = paths.length - 1; i >= 0; i -= 1) {
        const candidate = paths[i]
        if (candidate !== undefined && candidate.path.fromWeek <= w) {
          entry = candidate
          break
        }
      }
      const resolved = preGlide[w] ?? base
      if (entry === undefined) {
        grid[offset + w] = clamp(resolved, OEE_MIN, OEE_MAX)
        continue
      }
      const startWeek = clamp(entry.path.fromWeek, 0, Math.max(0, weekCount - 1))
      const startValue = preGlide[startWeek] ?? resolved
      grid[offset + w] = clamp(evaluateGlide(entry.path, w, startValue), OEE_MIN, OEE_MAX)
    }
  }

  return grid
}

/**
 * Material x work-center overrides, bucketed by key(materialId, workCenterId).
 * Cached against the snapshot object: `applyMoves` produces a new Snapshot per
 * scenario, so a WeakMap invalidates itself exactly when it should.
 */
const materialOverrideCache = new WeakMap<Snapshot, Map<string, OeeOverride[]>>()

function materialOverrides(snap: Snapshot): Map<string, OeeOverride[]> {
  const cached = materialOverrideCache.get(snap)
  if (cached) return cached
  const map = new Map<string, OeeOverride[]>()
  for (const override of snap.oeeOverrides) {
    if (
      override.scope !== 'materialWorkCenter' ||
      override.materialId === undefined ||
      override.workCenterId === undefined
    ) {
      continue
    }
    pushInto(map, key(override.materialId, override.workCenterId), override)
  }
  materialOverrideCache.set(snap, map)
  return map
}

/**
 * The final step of the cascade. `grid` is the output of {@link buildOeeGrid};
 * passing it in rather than rebuilding is the whole point of this signature.
 *
 * `materialId` undefined asks for the work center's own OEE — what the machine
 * runs at when nobody has argued about a specific SKU.
 */
export function resolveOee(
  snap: Snapshot,
  idx: SnapshotIndexes,
  grid: Float64Array,
  workCenterId: WorkCenterId,
  materialId: MaterialId | undefined,
  week: WeekIndex,
): number {
  const row = idx.workCenterRow.get(workCenterId)
  if (row === undefined) {
    throw new Error(`work center not in the grid: ${workCenterId}`)
  }
  if (!Number.isInteger(week) || week < 0 || week >= idx.weekCount) {
    throw new Error(`week outside the horizon: ${week}`)
  }
  let value = grid[row * idx.weekCount + week] ?? FALLBACK_OEE

  if (materialId !== undefined) {
    const overrides = materialOverrides(snap).get(key(materialId, workCenterId))
    if (overrides !== undefined) {
      // Most specific wins, and within the same specificity the later entry does.
      for (const override of overrides) if (inWindow(override, week)) value = override.value
    }
  }

  return clamp(value, OEE_MIN, OEE_MAX)
}
