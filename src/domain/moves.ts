/**
 * Scenario moves, applied onto a Snapshot.
 *
 * A scenario is a decision log, not a blob of mutated state, so this file has
 * exactly two jobs: replay the log in `seq` order onto a **new** Snapshot, and
 * say in plain English what each entry did.
 *
 * ---------------------------------------------------------------------------
 * Structural sharing
 * ---------------------------------------------------------------------------
 * The snapshot is large — 15,000 materials, ~54,000 routing operations, two
 * plan matrices of a million doubles each. A blind deep clone costs more than
 * the entire model run it precedes, so `applyMoves` copies **only** the
 * collections a move actually touches, and inside `workCenters` only the
 * individual work centers a move actually edits. Everything else is shared by
 * reference with the input. The input is never mutated; that is asserted by a
 * test, because it is the property every scenario comparison depends on.
 *
 * ---------------------------------------------------------------------------
 * Moves that do not change the snapshot
 * ---------------------------------------------------------------------------
 * Three variants are consumed elsewhere and deliberately leave the snapshot
 * alone:
 *
 *   `resourceMove`  and `sourceSwitch`   -> `sourcing.ts` reads them off the
 *                   scenario, because "which routing makes this in which week"
 *                   is not a property of master data.
 *   `utilisationCeiling`                 -> `buildCeilings` in `capacity.ts`.
 *
 * They are still *validated* here, and an illegal one is switched off in the
 * returned `effectiveScenario` rather than being left to produce a plan nobody
 * could execute. Callers must pass `effectiveScenario` — not the scenario they
 * handed in — to `resolveSourcing` and `buildCeilings`. `runModel` does.
 *
 * ---------------------------------------------------------------------------
 * Week-windowed shift changes: the negative-hours contract
 * ---------------------------------------------------------------------------
 * `PoolCapacity` is a static record with no dates on it. A shift change that
 * covers the whole horizon is therefore patched straight onto the record. A
 * shift change with a *window* cannot live there, so it is expressed as a
 * `changeover` downtime event over the window carrying the hour delta:
 *
 *     hoursPerWeek = oldWeeklyHours - newWeeklyHours
 *
 * A **reduction** yields a positive number and removes hours, which is what a
 * downtime event already means. An **increase** yields a NEGATIVE number, and
 * the contract `capacity.ts` must honour is:
 *
 *     >>> a DowntimeEvent with a negative `hoursPerWeek` ADDS capacity. <<<
 *
 * There is nowhere else in the model to put "three extra shifts in weeks
 * 20..26", and inventing a second dated-capacity object to carry it would
 * duplicate the one place a planner already looks when a week is odd.
 */

import type {
  DowntimeEvent,
  MachineClass,
  MachineClassId,
  Material,
  MaterialId,
  MaterialSelector,
  Move,
  OeeGlidePath,
  OeeOverride,
  OperationId,
  PlanMatrix,
  Plant,
  PlantId,
  RateOverride,
  RetrofitOption,
  Scenario,
  ScenarioMove,
  Snapshot,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import { at, key } from '@/domain/lookup'

/** Beyond this the warning list stops being read and starts being scrolled. */
const MAX_WARNINGS = 40

/** Reached only when a work center references a plant that is not in the snapshot. */
const FALLBACK_OEE = 0.85

/**
 * The result of replaying a scenario.
 *
 * `snapshot`, `capexUsd` and `warnings` are the declared contract. The other
 * two are additions the engine needs and no caller is obliged to read:
 *
 *   `effectiveScenario` — the same scenario with illegal moves switched off.
 *                         Pass THIS to `resolveSourcing` and `buildCeilings`.
 *   `freightUsd`        — one-off freight implied by `wipTransfer` moves. It is
 *                         an operating cost, not capex, so it is kept apart
 *                         from `capexUsd` rather than quietly folded in.
 */
export interface AppliedMoves {
  snapshot: Snapshot
  capexUsd: number
  warnings: string[]
  effectiveScenario: Scenario
  freightUsd: number
}

// ---------------------------------------------------------------------------
// Copy-on-write draft
// ---------------------------------------------------------------------------

interface Working {
  base: Snapshot
  workCenters: WorkCenter[] | null
  workCenterIndex: Map<WorkCenterId, number> | null
  editedWorkCenters: Set<WorkCenterId>
  oeeOverrides: OeeOverride[] | null
  glidePaths: OeeGlidePath[] | null
  rateOverrides: RateOverride[] | null
  downtime: DowntimeEvent[] | null
  supplyPlan: PlanMatrix | null
  demandPlan: PlanMatrix | null
}

function newWorking(base: Snapshot): Working {
  return {
    base,
    workCenters: null,
    workCenterIndex: null,
    editedWorkCenters: new Set<WorkCenterId>(),
    oeeOverrides: null,
    glidePaths: null,
    rateOverrides: null,
    downtime: null,
    supplyPlan: null,
    demandPlan: null,
  }
}

function workCentersOf(w: Working): WorkCenter[] {
  if (w.workCenters === null) w.workCenters = [...w.base.workCenters]
  return w.workCenters
}

function workCenterIndexOf(w: Working): Map<WorkCenterId, number> {
  if (w.workCenterIndex === null) {
    const map = new Map<WorkCenterId, number>()
    const list = w.workCenters ?? w.base.workCenters
    for (let i = 0; i < list.length; i += 1) {
      const wc = list[i]
      if (wc !== undefined) map.set(wc.id, i)
    }
    w.workCenterIndex = map
  }
  return w.workCenterIndex
}

/** The current (possibly already edited) work center, read-only. */
function readWorkCenter(w: Working, id: WorkCenterId): WorkCenter | undefined {
  const index = workCenterIndexOf(w).get(id)
  if (index === undefined) return undefined
  return (w.workCenters ?? w.base.workCenters)[index]
}

/**
 * A private copy of one work center, installed into the draft list. Pools and
 * features are copied too, since both are edited in place by moves.
 */
function editWorkCenter(w: Working, id: WorkCenterId): WorkCenter | undefined {
  const list = workCentersOf(w)
  const index = workCenterIndexOf(w).get(id)
  if (index === undefined) return undefined
  const current = list[index]
  if (current === undefined) return undefined
  if (w.editedWorkCenters.has(id)) return current
  const copy: WorkCenter = {
    ...current,
    pools: current.pools.map((pool) => ({ ...pool })),
    features: [...current.features],
  }
  list[index] = copy
  w.editedWorkCenters.add(id)
  return copy
}

function oeeOverridesOf(w: Working): OeeOverride[] {
  if (w.oeeOverrides === null) w.oeeOverrides = [...w.base.oeeOverrides]
  return w.oeeOverrides
}
function glidePathsOf(w: Working): OeeGlidePath[] {
  if (w.glidePaths === null) w.glidePaths = [...w.base.glidePaths]
  return w.glidePaths
}
function rateOverridesOf(w: Working): RateOverride[] {
  if (w.rateOverrides === null) w.rateOverrides = [...w.base.rateOverrides]
  return w.rateOverrides
}
function downtimeOf(w: Working): DowntimeEvent[] {
  if (w.downtime === null) w.downtime = [...w.base.downtime]
  return w.downtime
}

/** Row keys are shared; only the values are copied, and only once. */
function planOf(w: Working, plan: 'supply' | 'demand'): PlanMatrix {
  if (plan === 'supply') {
    if (w.supplyPlan === null) {
      const source = w.base.supplyPlan
      w.supplyPlan = {
        rowKeys: source.rowKeys,
        weekCount: source.weekCount,
        values: new Float64Array(source.values),
      }
    }
    return w.supplyPlan
  }
  if (w.demandPlan === null) {
    const source = w.base.demandPlan
    w.demandPlan = {
      rowKeys: source.rowKeys,
      weekCount: source.weekCount,
      values: new Float64Array(source.values),
    }
  }
  return w.demandPlan
}

function finish(w: Working): Snapshot {
  const base = w.base
  if (
    w.workCenters === null &&
    w.oeeOverrides === null &&
    w.glidePaths === null &&
    w.rateOverrides === null &&
    w.downtime === null &&
    w.supplyPlan === null &&
    w.demandPlan === null
  ) {
    return base
  }
  return {
    ...base,
    workCenters: w.workCenters ?? base.workCenters,
    oeeOverrides: w.oeeOverrides ?? base.oeeOverrides,
    glidePaths: w.glidePaths ?? base.glidePaths,
    rateOverrides: w.rateOverrides ?? base.rateOverrides,
    downtime: w.downtime ?? base.downtime,
    supplyPlan: w.supplyPlan ?? base.supplyPlan,
    demandPlan: w.demandPlan ?? base.demandPlan,
    meta:
      w.workCenters === null
        ? base.meta
        : { ...base.meta, workCenterCount: w.workCenters.length },
  }
}

// ---------------------------------------------------------------------------
// Lazily-derived lookups
// ---------------------------------------------------------------------------

/**
 * Everything `applyMoves` needs to look up, built on first use.
 *
 * `applyMoves` runs *before* `buildIndexes` (the indexes have to describe the
 * moved snapshot), so it cannot use `SnapshotIndexes`. Building a second full
 * index just to validate two or three moves would cost more than the moves do,
 * hence: each map here is built only if a move actually asks for it, and the
 * expensive one — the routing scan — is built at most once.
 */
interface Derived {
  snap: Snapshot
  materialById: Map<MaterialId, Material> | null
  materialsByGroup: Map<string, MaterialId[]> | null
  materialsByFamily: Map<string, MaterialId[]> | null
  classById: Map<MachineClassId, MachineClass> | null
  plantById: Map<PlantId, Plant> | null
  /** Operations master data permits at each work center. One routing scan. */
  approvedOpsByWorkCenter: Map<WorkCenterId, Set<OperationId>> | null
}

function newDerived(snap: Snapshot): Derived {
  return {
    snap,
    materialById: null,
    materialsByGroup: null,
    materialsByFamily: null,
    classById: null,
    plantById: null,
    approvedOpsByWorkCenter: null,
  }
}

function materialsById(d: Derived): Map<MaterialId, Material> {
  if (d.materialById === null) {
    const map = new Map<MaterialId, Material>()
    for (const material of d.snap.materials) map.set(material.id, material)
    d.materialById = map
  }
  return d.materialById
}

function materialBuckets(d: Derived): void {
  if (d.materialsByGroup !== null && d.materialsByFamily !== null) return
  const byGroup = new Map<string, MaterialId[]>()
  const byFamily = new Map<string, MaterialId[]>()
  for (const material of d.snap.materials) {
    const g = byGroup.get(material.groupId)
    if (g) g.push(material.id)
    else byGroup.set(material.groupId, [material.id])
    const f = byFamily.get(material.familyId)
    if (f) f.push(material.id)
    else byFamily.set(material.familyId, [material.id])
  }
  d.materialsByGroup = byGroup
  d.materialsByFamily = byFamily
}

function classesById(d: Derived): Map<MachineClassId, MachineClass> {
  if (d.classById === null) {
    const map = new Map<MachineClassId, MachineClass>()
    for (const machineClass of d.snap.machineClasses) map.set(machineClass.id, machineClass)
    d.classById = map
  }
  return d.classById
}

function plantsById(d: Derived): Map<PlantId, Plant> {
  if (d.plantById === null) {
    const map = new Map<PlantId, Plant>()
    for (const plant of d.snap.plants) map.set(plant.id, plant)
    d.plantById = map
  }
  return d.plantById
}

function approvedOps(d: Derived): Map<WorkCenterId, Set<OperationId>> {
  if (d.approvedOpsByWorkCenter === null) {
    const map = new Map<WorkCenterId, Set<OperationId>>()
    for (const routing of d.snap.routings) {
      for (const op of routing.operations) {
        const set = map.get(op.workCenterId)
        if (set) set.add(op.opId)
        else map.set(op.workCenterId, new Set([op.opId]))
      }
    }
    d.approvedOpsByWorkCenter = map
  }
  return d.approvedOpsByWorkCenter
}

/**
 * The material ids a selector names.
 *
 * `null` means "every material", which lets a plan-scale over `all` skip
 * building a 15,000-entry set it would only ever test membership against.
 */
function selectedMaterials(d: Derived, selector: MaterialSelector): Set<MaterialId> | null {
  switch (selector.kind) {
    case 'all':
      return null
    case 'material':
      return selector.id === undefined ? new Set<MaterialId>() : new Set([selector.id])
    case 'group': {
      materialBuckets(d)
      const ids = selector.id === undefined ? [] : (d.materialsByGroup?.get(selector.id) ?? [])
      return new Set(ids)
    }
    case 'family': {
      materialBuckets(d)
      const ids = selector.id === undefined ? [] : (d.materialsByFamily?.get(selector.id) ?? [])
      return new Set(ids)
    }
  }
}

// ---------------------------------------------------------------------------
// Small numeric helpers (local, so `src/domain` keeps its zero dependencies)
// ---------------------------------------------------------------------------

function weeklyHoursOf(pool: {
  count: number
  shiftsPerDay: number
  hoursPerShift: number
  daysPerWeek: number
  utilisationFactor: number
}): number {
  const h =
    pool.count * pool.shiftsPerDay * pool.hoursPerShift * pool.daysPerWeek * pool.utilisationFactor
  return Number.isFinite(h) && h > 0 ? h : 0
}

function clampWeek(week: number, weekCount: number): WeekIndex {
  const value = Math.floor(week)
  if (!Number.isFinite(value) || value < 0) return 0
  return value > weekCount - 1 ? Math.max(0, weekCount - 1) : value
}

function pct1(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function pct0(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

function money(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function num(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(2)))
}

function weekSpan(fromWeek: WeekIndex, toWeek: WeekIndex): string {
  return fromWeek === toWeek ? `W${fromWeek}` : `W${fromWeek}-W${toWeek}`
}

// ---------------------------------------------------------------------------
// applyMoves
// ---------------------------------------------------------------------------

/**
 * Replay a scenario onto a new Snapshot.
 *
 * Enabled moves run in ascending `seq`; disabled ones are skipped entirely and
 * never partially applied. Where two moves touch the same thing the later `seq`
 * wins, which is what "decision log" has to mean for a planner to be able to
 * read one.
 */
export function applyMoves(snap: Snapshot, scenario: Scenario): AppliedMoves {
  const working = newWorking(snap)
  const derived = newDerived(snap)
  const weekCount = snap.time.weeks.length

  const warnings: string[] = []
  let suppressed = 0
  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message)
    else suppressed += 1
  }

  let capexUsd = 0
  let freightUsd = 0

  const ordered = [...scenario.moves].sort((a, b) => a.seq - b.seq)
  /** Move ids switched off because they would produce a plan nobody could run. */
  const disabled = new Set<string>()
  /** Enabled retrofit moves by target work center — resourceMove validation reads this. */
  const retrofitTargets = new Set<WorkCenterId>()
  for (const entry of ordered) {
    if (entry.enabled && entry.move.kind === 'retrofit') retrofitTargets.add(entry.move.workCenterId)
  }

  for (const entry of ordered) {
    if (!entry.enabled) continue
    const label = entry.label.length > 0 ? entry.label : entry.id
    const move = entry.move

    switch (move.kind) {
      // ---- consumed by sourcing.ts; validated here -------------------------
      case 'resourceMove': {
        const source = readWorkCenter(working, move.fromWorkCenterId)
        const target = readWorkCenter(working, move.toWorkCenterId)
        if (source === undefined || target === undefined) {
          const missing = source === undefined ? move.fromWorkCenterId : move.toWorkCenterId
          warn(`resourceMove "${label}" disabled: work center ${missing} is not in the snapshot.`)
          disabled.add(entry.id)
          break
        }
        const ops = approvedOps(derived)
        const sourceOps = ops.get(move.fromWorkCenterId) ?? new Set<OperationId>()
        const targetOps = ops.get(move.toWorkCenterId) ?? new Set<OperationId>()
        let sharedApproved = 0
        for (const opId of sourceOps) if (targetOps.has(opId)) sharedApproved += 1
        if (sharedApproved === 0 && !retrofitTargets.has(move.toWorkCenterId)) {
          warn(
            `resourceMove "${label}" disabled: ${move.toWorkCenterId} is not approved for any operation ${move.fromWorkCenterId} runs, and the scenario carries no retrofit for it. Add a retrofit move, or qualify the work center in master data.`,
          )
          disabled.add(entry.id)
        }
        break
      }

      case 'sourceSwitch': {
        const plants = plantsById(derived)
        if (!plants.has(move.fromPlantId) || !plants.has(move.toPlantId)) {
          const missing = plants.has(move.fromPlantId) ? move.toPlantId : move.fromPlantId
          warn(`sourceSwitch "${label}" disabled: plant ${missing} is not in the snapshot.`)
          disabled.add(entry.id)
        }
        break
      }

      // ---- consumed by capacity.ts buildCeilings ---------------------------
      case 'utilisationCeiling': {
        if (!Number.isFinite(move.ceiling) || move.ceiling < 0) {
          warn(`utilisationCeiling "${label}" disabled: ceiling ${move.ceiling} is not a ratio.`)
          disabled.add(entry.id)
        }
        break
      }

      // ---- the two knobs ---------------------------------------------------
      case 'oeeSet': {
        if (!Number.isFinite(move.value) || move.value <= 0) {
          warn(`oeeSet "${label}" ignored: ${move.value} is not a usable OEE.`)
          break
        }
        const override: OeeOverride = {
          scope: move.scope,
          plantId: move.plantId,
          workCenterId: move.workCenterId,
          materialId: move.materialId,
          value: move.value,
          fromWeek: move.fromWeek,
          toWeek: move.toWeek,
          note: label,
        }
        // The cascade takes the LAST matching entry, so appending is exactly
        // "this decision beats the ones before it".
        oeeOverridesOf(working).push(override)
        break
      }

      case 'oeeGlide': {
        glidePathsOf(working).push({ ...move.path })
        break
      }

      case 'rateSet': {
        if (!Number.isFinite(move.ratePerHour) || move.ratePerHour <= 0) {
          warn(`rateSet "${label}" ignored: ${move.ratePerHour} is not a usable rate.`)
          break
        }
        rateOverridesOf(working).push({
          materialId: move.materialId,
          workCenterId: move.workCenterId,
          opId: move.opId,
          ratePerHour: move.ratePerHour,
          note: label,
        })
        break
      }

      // ---- capacity --------------------------------------------------------
      case 'shiftChange': {
        const wc = readWorkCenter(working, move.workCenterId)
        if (wc === undefined) {
          warn(`shiftChange "${label}" ignored: work center ${move.workCenterId} is not in the snapshot.`)
          break
        }
        const poolIndex = wc.pools.findIndex((pool) => pool.pool === move.pool)
        if (poolIndex < 0) {
          warn(
            `shiftChange "${label}" ignored: ${move.workCenterId} has no ${move.pool} pool to change.`,
          )
          break
        }
        const editable = editWorkCenter(working, move.workCenterId)
        if (editable === undefined) break
        const pool = editable.pools[poolIndex]
        if (pool === undefined) break

        const before = weeklyHoursOf(pool)
        const next = {
          count: move.count ?? pool.count,
          shiftsPerDay: move.shiftsPerDay ?? pool.shiftsPerDay,
          hoursPerShift: move.hoursPerShift ?? pool.hoursPerShift,
          daysPerWeek: move.daysPerWeek ?? pool.daysPerWeek,
          utilisationFactor: pool.utilisationFactor,
        }
        const after = weeklyHoursOf(next)
        const from = clampWeek(move.fromWeek, weekCount)
        const to = clampWeek(move.toWeek, weekCount)
        if (to < from) {
          warn(`shiftChange "${label}" ignored: window ${move.fromWeek}..${move.toWeek} is empty.`)
          break
        }

        const wholeHorizon = move.fromWeek <= 0 && move.toWeek >= weekCount - 1
        if (wholeHorizon) {
          // No window to express: this is simply what the pool is now.
          pool.count = next.count
          pool.shiftsPerDay = next.shiftsPerDay
          pool.hoursPerShift = next.hoursPerShift
          pool.daysPerWeek = next.daysPerWeek
          break
        }

        const delta = before - after
        if (Math.abs(delta) < 1e-9) break
        // See the file header: negative hoursPerWeek ADDS capacity.
        downtimeOf(working).push({
          id: `shift:${entry.id}`,
          workCenterId: move.workCenterId,
          kind: 'changeover',
          status: 'planned',
          fromWeek: from,
          toWeek: to,
          pools: [move.pool],
          hoursPerWeek: delta,
          label:
            delta > 0
              ? `${label}: ${num(delta)}h/week less ${move.pool}`
              : `${label}: ${num(-delta)}h/week more ${move.pool}`,
        })
        break
      }

      case 'downtimeUpsert': {
        const list = downtimeOf(working)
        const index = list.findIndex((event) => event.id === move.event.id)
        if (index >= 0) list[index] = { ...move.event }
        else list.push({ ...move.event })
        break
      }

      case 'downtimeRemove': {
        const list = downtimeOf(working)
        const index = list.findIndex((event) => event.id === move.eventId)
        if (index < 0) {
          warn(`downtimeRemove "${label}" changed nothing: no downtime event ${move.eventId}.`)
          break
        }
        list.splice(index, 1)
        break
      }

      // ---- assets ----------------------------------------------------------
      case 'retrofit': {
        const wc = readWorkCenter(working, move.workCenterId)
        if (wc === undefined) {
          warn(`retrofit "${label}" ignored: work center ${move.workCenterId} is not in the snapshot.`)
          break
        }
        const machineClass = classesById(derived).get(wc.classId)
        const option = machineClass?.retrofits.find((candidate) => candidate.id === move.retrofitId)
        if (option === undefined) {
          warn(
            `retrofit "${label}" ignored: ${wc.classId} sells no retrofit ${move.retrofitId}.`,
          )
          break
        }
        const editable = editWorkCenter(working, move.workCenterId)
        if (editable === undefined) break

        const granted = new Set(editable.features)
        let added = 0
        for (const featureId of option.addsFeatures) {
          if (granted.has(featureId)) continue
          granted.add(featureId)
          editable.features.push(featureId)
          added += 1
        }

        if (option.oeeDelta !== 0) {
          const plant = plantsById(derived).get(editable.plantId)
          const baseOee =
            editable.baseOee > 0 ? editable.baseOee : (plant?.defaultOee ?? FALLBACK_OEE)
          // The delta is applied to the work center's OWN base OEE, not to the
          // fully-resolved cascade: a retrofit changes the machine, and a
          // planner who also set an override later in the log meant that
          // override to win.
          oeeOverridesOf(working).push({
            scope: 'workCenter',
            workCenterId: editable.id,
            value: baseOee + option.oeeDelta,
            fromWeek: clampWeek(move.availableFromWeek, weekCount),
            note: `${label}: ${option.name}`,
          })
        }

        capexUsd += Number.isFinite(option.capexUsd) ? option.capexUsd : 0

        if (move.availableFromWeek > 0 && added > 0) {
          // Being explicit rather than precise-but-wrong: the capability model
          // has no dates on it, so the added features read as granted across
          // the whole horizon while the OEE effect starts when the install does.
          warn(
            `retrofit "${label}": ${editable.id} gains ${added} feature(s) from W${clampWeek(move.availableFromWeek, weekCount)}, but work-center features carry no date in this model — capability proposals will treat them as granted across the horizon. The OEE effect is dated correctly.`,
          )
        }
        break
      }

      case 'addWorkCenter': {
        const list = workCentersOf(working)
        const index = workCenterIndexOf(working)
        if (index.has(move.workCenter.id)) {
          warn(
            `addWorkCenter "${label}" rejected: work center ${move.workCenter.id} already exists.`,
          )
          break
        }
        const copy: WorkCenter = {
          ...move.workCenter,
          pools: move.workCenter.pools.map((pool) => ({ ...pool })),
          features: [...move.workCenter.features],
        }
        index.set(copy.id, list.length)
        list.push(copy)
        // Already a private copy, so later edits must not clone it again.
        working.editedWorkCenters.add(copy.id)
        capexUsd += Number.isFinite(move.capexUsd) ? move.capexUsd : 0
        break
      }

      // ---- plans -----------------------------------------------------------
      case 'wipTransfer': {
        const material = materialsById(derived).get(move.materialId)
        if (material === undefined) {
          warn(`wipTransfer "${label}" ignored: material ${move.materialId} is not in the snapshot.`)
          break
        }
        if (material.type !== 'HALB') {
          // "What-if is allowed, plan mode is not", made visible.
          const component =
            material.componentId === undefined
              ? 'no semi-finished component is declared on it'
              : `its declared component ${material.componentId} is the only WIP that may legally cross a plant boundary`
          warn(
            `wipTransfer "${label}" applied as a WHAT-IF only: ${material.code} is a ${material.type}, not a HALB, and ${component}. Executing this needs a semi-finished material master at ${move.toPlantId} and a qualification (PPAP) for it before it becomes a plan.`,
          )
        }

        const plan = planOf(working, 'supply')
        const rowIndex = new Map<string, number>()
        for (let r = 0; r < plan.rowKeys.length; r += 1) {
          const rowKey = plan.rowKeys[r]
          if (rowKey !== undefined) rowIndex.set(rowKey, r)
        }
        const originRow = rowIndex.get(key(move.materialId, move.fromPlantId))
        if (originRow === undefined) {
          warn(
            `wipTransfer "${label}" changed nothing: ${material.code} has no supply row at ${move.fromPlantId}.`,
          )
          break
        }
        const targetRow = rowIndex.get(key(move.materialId, move.toPlantId))
        if (targetRow === undefined) {
          warn(
            `wipTransfer "${label}" changed nothing: ${material.code} has no supply row at ${move.toPlantId}, so there is nowhere to place the volume. Extend the plan first.`,
          )
          break
        }

        const share = move.share > 1 ? 1 : move.share > 0 ? move.share : 0
        if (share === 0) {
          warn(`wipTransfer "${label}" ignored: share ${move.share} moves nothing.`)
          break
        }
        const transit = Number.isFinite(move.transitWeeks) ? Math.max(0, Math.floor(move.transitWeeks)) : 0
        const from = clampWeek(move.fromWeek, weekCount)
        const to = clampWeek(move.toWeek, weekCount)
        if (to < from) {
          warn(`wipTransfer "${label}" ignored: window ${move.fromWeek}..${move.toWeek} is empty.`)
          break
        }

        const originBase = originRow * weekCount
        const targetBase = targetRow * weekCount
        let movedUnits = 0
        let droppedUnits = 0
        for (let w = from; w <= to; w += 1) {
          const have = plan.values[originBase + w] ?? 0
          if (have <= 0) continue
          const moved = have * share
          plan.values[originBase + w] = have - moved
          // Production at the origin must finish `transitWeeks` earlier for the
          // parts to be at the receiving plant when the plan wanted them.
          const arrival = w - transit
          if (arrival < 0) {
            droppedUnits += moved
            continue
          }
          plan.values[targetBase + arrival] = (plan.values[targetBase + arrival] ?? 0) + moved
          movedUnits += moved
        }
        freightUsd +=
          movedUnits *
          (Number.isFinite(move.freightCostPerUnitUsd) ? move.freightCostPerUnitUsd : 0)
        if (droppedUnits > 0) {
          warn(
            `wipTransfer "${label}": ${Math.round(droppedUnits)} unit(s) would have had to be produced before week 0 to survive ${transit} week(s) in transit, and were dropped from the plan.`,
          )
        }
        break
      }

      case 'planScale': {
        if (!Number.isFinite(move.factor) || move.factor < 0) {
          warn(`planScale "${label}" ignored: factor ${move.factor} is not a usable multiplier.`)
          break
        }
        const plan = planOf(working, move.plan)
        const materials = selectedMaterials(derived, move.selector)
        const from = clampWeek(move.fromWeek, weekCount)
        const to = clampWeek(move.toWeek, weekCount)
        if (to < from) {
          warn(`planScale "${label}" ignored: window ${move.fromWeek}..${move.toWeek} is empty.`)
          break
        }
        // Supply rows are `materialId|plantId`; demand rows are
        // `materialId|region`. One pass over the row keys covers both.
        const qualifier = move.plan === 'supply' ? move.plantId : move.region
        let touched = 0
        for (let r = 0; r < plan.rowKeys.length; r += 1) {
          const rowKey = plan.rowKeys[r]
          if (rowKey === undefined) continue
          const separator = rowKey.indexOf('|')
          const materialId = separator < 0 ? rowKey : rowKey.slice(0, separator)
          if (materials !== null && !materials.has(materialId)) continue
          if (qualifier !== undefined && separator >= 0 && rowKey.slice(separator + 1) !== qualifier) {
            continue
          }
          const base = r * plan.weekCount
          for (let w = from; w <= to && w < plan.weekCount; w += 1) {
            plan.values[base + w] = (plan.values[base + w] ?? 0) * move.factor
          }
          touched += 1
        }
        if (touched === 0) {
          warn(
            `planScale "${label}" changed nothing: no ${move.plan} rows matched ${describeSelectorRaw(move.selector)}${qualifier === undefined ? '' : ` at ${qualifier}`}.`,
          )
        }
        break
      }
    }
  }

  if (suppressed > 0) warnings.push(`…and ${suppressed} more move warning(s).`)

  const effectiveScenario: Scenario =
    disabled.size === 0
      ? scenario
      : {
          ...scenario,
          moves: scenario.moves.map((entry): ScenarioMove =>
            disabled.has(entry.id) ? { ...entry, enabled: false } : entry,
          ),
        }

  return { snapshot: finish(working), capexUsd, warnings, effectiveScenario, freightUsd }
}

// ---------------------------------------------------------------------------
// describeMove
// ---------------------------------------------------------------------------

function describeSelectorRaw(selector: MaterialSelector): string {
  return selector.kind === 'all' ? 'all materials' : `${selector.kind} ${selector.id ?? '?'}`
}

/** `PAINT-2 (Wroclaw)` — the code a planner reads on the shop floor, plus its site. */
function workCenterLabel(idx: SnapshotIndexes, id: WorkCenterId): string {
  const wc = idx.workCenterById.get(id)
  if (wc === undefined) return id
  const plant = idx.plantById.get(wc.plantId)
  const name = wc.code.length > 0 ? wc.code : wc.name
  return plant === undefined ? name : `${name} (${plant.city})`
}

function plantLabel(idx: SnapshotIndexes, id: PlantId | undefined): string {
  if (id === undefined) return 'an unnamed plant'
  const plant = idx.plantById.get(id)
  return plant === undefined ? id : plant.city
}

function materialLabel(idx: SnapshotIndexes, id: MaterialId | undefined): string {
  if (id === undefined) return 'an unnamed material'
  const material = idx.materialById.get(id)
  return material === undefined ? id : material.code
}

function selectorLabel(idx: SnapshotIndexes, selector: MaterialSelector): string {
  switch (selector.kind) {
    case 'all':
      return 'everything'
    case 'material':
      return materialLabel(idx, selector.id)
    case 'group': {
      if (selector.id === undefined) return 'an unnamed group'
      return idx.groupById.get(selector.id)?.name ?? selector.id
    }
    case 'family': {
      if (selector.id === undefined) return 'an unnamed family'
      return idx.familyById.get(selector.id)?.name ?? selector.id
    }
  }
}

function retrofitOptionOf(
  idx: SnapshotIndexes,
  workCenterId: WorkCenterId,
  retrofitId: string,
): RetrofitOption | undefined {
  const wc = idx.workCenterById.get(workCenterId)
  if (wc === undefined) return undefined
  return idx.classById.get(wc.classId)?.retrofits.find((option) => option.id === retrofitId)
}

/**
 * One line of plain English a planner would recognise, with every id resolved
 * to the name it has on the shop floor.
 *
 * Weeks are named by their grid position (`W14`) rather than their ISO label:
 * `SnapshotIndexes` deliberately does not carry the time grid, and a move is
 * authored against grid positions in the first place.
 */
export function describeMove(move: Move, idx: SnapshotIndexes): string {
  switch (move.kind) {
    case 'resourceMove': {
      const what = selectorLabel(idx, move.selector)
      const dual = move.allowDualSource ? 'dual source on' : 'dual source off'
      return `Move ${pct0(move.share)} of ${what} from ${workCenterLabel(idx, move.fromWorkCenterId)} to ${workCenterLabel(idx, move.toWorkCenterId)}, ${weekSpan(move.fromWeek, move.toWeek)}, ${dual}`
    }

    case 'oeeSet': {
      const window =
        move.fromWeek === undefined && move.toWeek === undefined
          ? 'for the whole horizon'
          : `${weekSpan(move.fromWeek ?? 0, move.toWeek ?? move.fromWeek ?? 0)}`
      const where =
        move.scope === 'plant'
          ? `every work center at ${plantLabel(idx, move.plantId)}`
          : move.scope === 'workCenter'
            ? workCenterLabel(idx, move.workCenterId ?? '')
            : `${materialLabel(idx, move.materialId)} on ${workCenterLabel(idx, move.workCenterId ?? '')}`
      return `Set OEE to ${pct1(move.value)} for ${where}, ${window}`
    }

    case 'oeeGlide': {
      const path = move.path
      const where =
        path.scope === 'plant'
          ? `every work center at ${plantLabel(idx, path.plantId)}`
          : workCenterLabel(idx, path.workCenterId ?? '')
      const shape =
        path.curve === 'sCurve' ? 'on an S-curve' : path.curve === 'step' ? 'as a step' : 'linearly'
      const start = path.startValue === undefined ? 'today’s OEE' : pct1(path.startValue)
      return `Ramp OEE at ${where} from ${start} to ${pct1(path.endValue)} ${shape}, ${weekSpan(path.fromWeek, path.toWeek)} — ${path.label}`
    }

    case 'rateSet':
      return `Set the run rate for ${materialLabel(idx, move.materialId)} on ${workCenterLabel(idx, move.workCenterId)}, operation ${idx.stdOpById.get(move.opId)?.code ?? move.opId}, to ${num(move.ratePerHour)} units/hour`

    case 'shiftChange': {
      const parts: string[] = []
      if (move.count !== undefined) {
        parts.push(move.pool === 'machine' ? `${num(move.count)} machines` : `${num(move.count)} operators`)
      }
      if (move.shiftsPerDay !== undefined) parts.push(`${num(move.shiftsPerDay)} shifts/day`)
      if (move.hoursPerShift !== undefined) parts.push(`${num(move.hoursPerShift)} h/shift`)
      if (move.daysPerWeek !== undefined) parts.push(`${num(move.daysPerWeek)} days/week`)
      const detail = parts.length === 0 ? 'no change' : parts.join(', ')
      return `Run ${workCenterLabel(idx, move.workCenterId)} ${move.pool} capacity at ${detail}, ${weekSpan(move.fromWeek, move.toWeek)}`
    }

    case 'downtimeUpsert': {
      const event = move.event
      const pools = event.pools.join(' and ')
      const hours =
        event.hoursPerWeek === undefined
          ? `blocking ${pools} entirely`
          : event.hoursPerWeek >= 0
            ? `removing ${num(event.hoursPerWeek)} ${pools} h/week`
            : `adding ${num(-event.hoursPerWeek)} ${pools} h/week`
      const slip =
        event.status === 'atRisk' && event.slipWeeks !== undefined && event.slipWeeks !== 0
          ? `, modelled ${num(event.slipWeeks)} week(s) late`
          : ''
      return `Plan ${event.kind} at ${workCenterLabel(idx, event.workCenterId)}, ${weekSpan(event.fromWeek, event.toWeek)}, ${hours}${slip} — ${event.label}`
    }

    case 'downtimeRemove':
      return `Remove the downtime event ${move.eventId} from the plan`

    case 'utilisationCeiling': {
      const where =
        move.scope === 'global'
          ? 'across the network'
          : move.scope === 'plant'
            ? `at ${plantLabel(idx, move.plantId)}`
            : `on ${workCenterLabel(idx, move.workCenterId ?? '')}`
      return `Cap planned utilisation at ${pct0(move.ceiling)} ${where}`
    }

    case 'retrofit': {
      const option = retrofitOptionOf(idx, move.workCenterId, move.retrofitId)
      if (option === undefined) {
        return `Retrofit ${workCenterLabel(idx, move.workCenterId)} with ${move.retrofitId}, available from ${weekSpan(move.availableFromWeek, move.availableFromWeek)}`
      }
      const oee =
        option.oeeDelta === 0
          ? ''
          : `, OEE ${option.oeeDelta > 0 ? '+' : ''}${(option.oeeDelta * 100).toFixed(1)}pp`
      return `Retrofit ${workCenterLabel(idx, move.workCenterId)} with ${option.name} (${money(option.capexUsd)}, ${num(option.leadTimeWeeks)} week lead time${oee}), available from W${move.availableFromWeek}`
    }

    case 'addWorkCenter': {
      const wc = move.workCenter
      const plant = idx.plantById.get(wc.plantId)
      const site = plant === undefined ? wc.plantId : plant.city
      const from = wc.availableFromWeek === undefined ? '' : `, from W${wc.availableFromWeek}`
      return `Add work center ${wc.code} (${wc.name}) at ${site} for ${money(move.capexUsd)}${from}`
    }

    case 'wipTransfer':
      return `Ship ${pct0(move.share)} of ${materialLabel(idx, move.materialId)} as WIP from ${plantLabel(idx, move.fromPlantId)} to ${plantLabel(idx, move.toPlantId)}, ${weekSpan(move.fromWeek, move.toWeek)}, ${num(move.transitWeeks)} week(s) in transit at ${money(move.freightCostPerUnitUsd)}/unit`

    case 'planScale': {
      const where =
        move.plan === 'supply'
          ? move.plantId === undefined
            ? 'every plant'
            : plantLabel(idx, move.plantId)
          : (move.region ?? 'every region')
      const direction = move.factor >= 1 ? 'Raise' : 'Cut'
      return `${direction} the ${move.plan} plan for ${selectorLabel(idx, move.selector)} at ${where} by x${num(move.factor)}, ${weekSpan(move.fromWeek, move.toWeek)}`
    }

    case 'sourceSwitch': {
      const overlap =
        move.overlapWeeks > 0
          ? `${num(move.overlapWeeks)} week(s) of parallel run`
          : 'a clean cut, no parallel run'
      return `Switch ${selectorLabel(idx, move.selector)} from ${plantLabel(idx, move.fromPlantId)} to ${plantLabel(idx, move.toPlantId)} at W${move.switchWeek}, ${overlap}`
    }
  }
}

/** Every enabled move in a scenario, described in `seq` order. */
export function describeScenario(scenario: Scenario, idx: SnapshotIndexes): string[] {
  const ordered = [...scenario.moves].sort((a, b) => a.seq - b.seq)
  const out: string[] = []
  for (const entry of ordered) {
    if (!entry.enabled) continue
    out.push(describeMove(entry.move, idx))
  }
  return out
}

/** Total capex a scenario commits, without applying it. Used by the compare view. */
export function scenarioCapex(snap: Snapshot, scenario: Scenario): number {
  const derived = newDerived(snap)
  let total = 0
  for (const entry of scenario.moves) {
    if (!entry.enabled) continue
    const move = entry.move
    if (move.kind === 'addWorkCenter') {
      total += Number.isFinite(move.capexUsd) ? move.capexUsd : 0
    } else if (move.kind === 'retrofit') {
      const wc = snap.workCenters.find((candidate) => candidate.id === move.workCenterId)
      if (wc === undefined) continue
      const option = classesById(derived)
        .get(wc.classId)
        ?.retrofits.find((candidate) => candidate.id === move.retrofitId)
      if (option !== undefined && Number.isFinite(option.capexUsd)) total += option.capexUsd
    }
  }
  return total
}

/** Exported for tests and for the scenario inspector: weekly hours of a pool. */
export function poolWeeklyHours(snap: Snapshot, workCenterId: WorkCenterId, pool: 'machine' | 'labour'): number {
  const wc = snap.workCenters.find((candidate) => candidate.id === workCenterId)
  if (wc === undefined) return 0
  let total = 0
  for (let i = 0; i < wc.pools.length; i += 1) {
    const entry = at(wc.pools, i, 'pool')
    if (entry.pool === pool) total += weeklyHoursOf(entry)
  }
  return total
}
