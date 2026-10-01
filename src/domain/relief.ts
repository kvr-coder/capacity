/**
 * Bottleneck ranking and relief search.
 *
 * This is the payoff of holding the **feature model** beside the **allow-list**.
 * The allow-list answers "where may this run today"; on its own it can only ever
 * propose work centers someone already approved, which is exactly the set a
 * planner has already tried. The feature model answers "where could this run",
 * and the retrofit catalogue answers "where could it run for money". The three
 * answers have different prices and different lead times, and this file keeps
 * them separate all the way to the UI rather than blending them into one
 * suggestion nobody can act on.
 *
 * ---------------------------------------------------------------------------
 * Moving the bottleneck is not relief
 * ---------------------------------------------------------------------------
 * A candidate that ends up at 130% has not helped; it has renamed the problem.
 * Those candidates are dropped — UNLESS the resulting utilisation is still
 * below where the source sits today, in which case the network genuinely is
 * better off and the candidate is returned with `movesBottleneck: true` and a
 * note saying so. Hiding it would be the tool making a judgement it is not
 * entitled to make.
 *
 * ---------------------------------------------------------------------------
 * Hours do not transfer one for one
 * ---------------------------------------------------------------------------
 * An hour at a work center running 0.90 OEE is not an hour at one running 0.60.
 * Moved hours are converted:
 *
 *     hoursAtTarget = hoursAtSource x oeeSource / oeeTarget
 *
 * which is the same 1/OEE that `rates.ts` applies, arriving from the other
 * direction. Labour comes with it, in the ratio the source actually runs.
 *
 * The search deliberately ignores the plant/work-center view filter and looks
 * at the whole network: hiding the one machine in Suzhou that could take the
 * load because the planner is currently looking at Wroclaw would hide the
 * answer. The week window and the product filter DO apply — they say which
 * hours and which products are in question.
 */

import type {
  Bottleneck,
  CapacityPool,
  Filters,
  GroupId,
  MaterialId,
  OperationId,
  ReliefCandidate,
  RetrofitOption,
  Snapshot,
  WeekIndex,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import type { LoadOutput } from '@/domain/load'
import type { Basis } from '@/domain/capability'
import { capabilityBasis, missingFeatures } from '@/domain/capability'
import { buildFilterContext } from '@/domain/rollup'
import { at, key, safeDiv } from '@/domain/lookup'

/** Peak utilisation at or above this is worth a planner's attention. */
export const WATCH_AT = 0.85
/** …at or above this it has no slack left. */
export const TIGHT_AT = 0.95
/** …at or above this the plan does not fit. */
export const CRITICAL_AT = 1.0

/** Above this a relief candidate has taken the bottleneck rather than removed it. */
export const MOVES_BOTTLENECK_ABOVE = 0.95

/**
 * Qualifying an unapproved work center is PPAP-shaped work: trial runs, a
 * customer sign-off, a production-version change. Eight weeks is the
 * placeholder a planner can argue with; it is never zero, which is the point —
 * `featureCapable` is free in capex and expensive in calendar.
 */
export const QUALIFICATION_LEAD_WEEKS = 8

const SEVERITY_RANK: Record<Bottleneck['severity'], number> = { critical: 0, tight: 1, watch: 2 }
const BASIS_RANK: Record<ReliefCandidate['basis'], number> = {
  approved: 0,
  featureCapable: 1,
  retrofit: 2,
}

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

// ---------------------------------------------------------------------------
// rankBottlenecks
// ---------------------------------------------------------------------------

/**
 * Work centers in trouble over the filtered window, worst first.
 *
 * Severity is read off the PEAK week, not the mean: a line that is fine for
 * fifty weeks and 140% for two has a problem in those two weeks, and averaging
 * it away is how a plan gets signed off and then misses.
 */
export function rankBottlenecks(
  snap: Snapshot,
  idx: SnapshotIndexes,
  load: LoadOutput,
  filters: Filters,
): Bottleneck[] {
  const ctx = buildFilterContext(snap, idx, load, filters)
  const weeks = ctx.weekCount
  const out: Bottleneck[] = []

  for (let row = 0; row < ctx.workCenterPass.length; row += 1) {
    if (ctx.workCenterPass[row] !== 1) continue
    const workCenterId = at(ctx.workCenterIds, row, 'work center')
    const wc = idx.workCenterById.get(workCenterId)
    if (wc === undefined) continue

    let peakUtilisation = 0
    let peakWeek: WeekIndex = ctx.fromWeek
    let bindingPool: CapacityPool = 'machine'
    let weeksOverCeiling = 0
    let overloadHours = 0
    let shortfallUnits = 0
    let sawCell = false

    const base = row * weeks
    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const cell = ctx.cellByRowWeek[base + w]
      if (cell === undefined) continue
      sawCell = true
      if (cell.utilisation > peakUtilisation) {
        peakUtilisation = cell.utilisation
        peakWeek = w
        bindingPool = cell.bindingPool
      }
      if (cell.overloadHours > 0) weeksOverCeiling += 1
      overloadHours += cell.overloadHours
      shortfallUnits += cell.shortfallUnits
    }
    if (!sawCell) continue

    const severity: Bottleneck['severity'] | null =
      peakUtilisation >= CRITICAL_AT || shortfallUnits > 0
        ? 'critical'
        : peakUtilisation >= TIGHT_AT
          ? 'tight'
          : peakUtilisation >= WATCH_AT
            ? 'watch'
            : null
    if (severity === null) continue

    out.push({
      workCenterId,
      plantId: wc.plantId,
      peakWeek,
      peakUtilisation,
      weeksOverCeiling,
      overloadHours,
      shortfallUnits,
      bindingPool,
      severity,
      topGroups: topGroupsAt(load, ctx.groupPass, workCenterId, ctx.fromWeek, ctx.toWeek, 5),
    })
  }

  out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.peakUtilisation - a.peakUtilisation ||
      b.overloadHours - a.overloadHours ||
      (a.workCenterId < b.workCenterId ? -1 : a.workCenterId > b.workCenterId ? 1 : 0),
  )
  return out
}

/** Product groups carrying the machine hours at one work center, biggest first. */
function topGroupsAt(
  load: LoadOutput,
  groupPass: Set<GroupId> | null,
  workCenterId: WorkCenterId,
  fromWeek: WeekIndex,
  toWeek: WeekIndex,
  limit: number,
): Array<{ groupId: GroupId; hours: number }> {
  const rows = hoursByGroupAt(load, groupPass, workCenterId, fromWeek, toWeek)
  const out: Array<{ groupId: GroupId; hours: number }> = []
  for (const [groupId, hours] of rows) out.push({ groupId, hours })
  // Ids break ties so the ranking is stable between runs.
  out.sort((a, b) => b.hours - a.hours || (a.groupId < b.groupId ? -1 : 1))
  return out.slice(0, limit)
}

function hoursByGroupAt(
  load: LoadOutput,
  groupPass: Set<GroupId> | null,
  workCenterId: WorkCenterId,
  fromWeek: WeekIndex,
  toWeek: WeekIndex,
): Map<GroupId, number> {
  const out = new Map<GroupId, number>()
  const prefix = `${workCenterId}|`
  for (const [composite, series] of load.hoursByGroup) {
    if (!composite.startsWith(prefix)) continue
    const groupId = composite.slice(prefix.length)
    if (groupPass !== null && !groupPass.has(groupId)) continue
    let total = 0
    for (let w = fromWeek; w <= toWeek; w += 1) total += f64(series, w)
    if (total > 0) out.set(groupId, total)
  }
  return out
}

// ---------------------------------------------------------------------------
// findRelief
// ---------------------------------------------------------------------------

/**
 * A relief candidate, plus the reasoning the UI needs to be honest about it.
 *
 * A superset of {@link ReliefCandidate}, so the declared return type is
 * satisfied and callers who only know the contract are unaffected.
 */
export interface ReliefCandidateDetail extends ReliefCandidate {
  /** Hours that would actually leave the source, after the target's own room. */
  reliefHours: number
  /** True when the target ends above its own comfort line taking this load. */
  movesBottleneck: boolean
  /** Operations the target can run out of the ones the source runs. */
  sharedOperations: number
  /** Plain English: why this is offered, and what is wrong with it. */
  note: string
}

interface WindowStats {
  machineRequired: number
  labourRequired: number
  machineAvailable: number
  labourAvailable: number
  machineSpare: number
  labourSpare: number
  peakUtilisation: number
  meanOee: number
}

function windowStats(
  load: LoadOutput,
  ceiling: number,
  cellAt: (week: WeekIndex) => { utilisation: number; oee: number } | undefined,
  row: number,
  weeks: number,
  fromWeek: WeekIndex,
  toWeek: WeekIndex,
): WindowStats {
  const machine = load.grids.machine
  const labour = load.grids.labour
  const stats: WindowStats = {
    machineRequired: 0,
    labourRequired: 0,
    machineAvailable: 0,
    labourAvailable: 0,
    machineSpare: 0,
    labourSpare: 0,
    peakUtilisation: 0,
    meanOee: 0,
  }
  let oeeSum = 0
  let oeeCount = 0
  const base = row * weeks
  for (let w = fromWeek; w <= toWeek; w += 1) {
    const i = base + w
    const machineAvailable = f64(machine.availableHours, i) * ceiling
    const labourAvailable = f64(labour.availableHours, i) * ceiling
    const machineRequired = f64(machine.requiredHours, i)
    const labourRequired = f64(labour.requiredHours, i)
    stats.machineRequired += machineRequired
    stats.labourRequired += labourRequired
    stats.machineAvailable += machineAvailable
    stats.labourAvailable += labourAvailable
    if (machineAvailable > machineRequired) stats.machineSpare += machineAvailable - machineRequired
    if (labourAvailable > labourRequired) stats.labourSpare += labourAvailable - labourRequired
    const cell = cellAt(w)
    if (cell === undefined) continue
    if (cell.utilisation > stats.peakUtilisation) stats.peakUtilisation = cell.utilisation
    if (cell.oee > 0) {
      oeeSum += cell.oee
      oeeCount += 1
    }
  }
  stats.meanOee = oeeCount > 0 ? oeeSum / oeeCount : 0
  return stats
}

/** Operations master data permits at a work center. */
function approvedOpsAt(idx: SnapshotIndexes, workCenterId: WorkCenterId): Set<OperationId> {
  const out = new Set<OperationId>()
  for (const [opId, workCenterIds] of idx.approvedWorkCentersByOp) {
    for (const candidate of workCenterIds) {
      if (candidate === workCenterId) {
        out.add(opId)
        break
      }
    }
  }
  return out
}

interface GroupFootprint {
  /** Operations this group actually performs AT the source work center. */
  ops: Set<OperationId>
  materials: Set<MaterialId>
}

/**
 * What each product group does at one work center.
 *
 * A group can only move if the target can run EVERY operation the group
 * performs at the source — taking half a group's operations elsewhere splits a
 * routing across two sites, which is a different (and much bigger) decision
 * than moving load.
 */
function footprintAt(
  snap: Snapshot,
  idx: SnapshotIndexes,
  workCenterId: WorkCenterId,
): Map<GroupId, GroupFootprint> {
  const out = new Map<GroupId, GroupFootprint>()
  for (const routing of snap.routings) {
    let touches = false
    for (const op of routing.operations) {
      if (op.workCenterId === workCenterId) {
        touches = true
        break
      }
    }
    if (!touches) continue
    const material = idx.materialById.get(routing.materialId)
    if (material === undefined) continue
    let entry = out.get(material.groupId)
    if (entry === undefined) {
      entry = { ops: new Set<OperationId>(), materials: new Set<MaterialId>() }
      out.set(material.groupId, entry)
    }
    entry.materials.add(routing.materialId)
    for (const op of routing.operations) {
      if (op.workCenterId === workCenterId) entry.ops.add(op.opId)
    }
  }
  return out
}

/** The class retrofit that closes the most of `wanted`, cheapest first on ties. */
function bestRetrofit(
  idx: SnapshotIndexes,
  workCenterId: WorkCenterId,
  wanted: Set<OperationId>,
): { option: RetrofitOption; closes: Set<OperationId> } | null {
  const wc = idx.workCenterById.get(workCenterId)
  if (wc === undefined) return null
  const machineClass = idx.classById.get(wc.classId)
  if (machineClass === undefined) return null

  let best: { option: RetrofitOption; closes: Set<OperationId> } | null = null
  for (const option of machineClass.retrofits) {
    const adds = new Set(option.addsFeatures)
    const closes = new Set<OperationId>()
    for (const opId of wanted) {
      const missing = missingFeatures(idx, workCenterId, opId)
      if (missing.length === 0) continue
      let covered = true
      for (const featureId of missing) {
        if (!adds.has(featureId)) {
          covered = false
          break
        }
      }
      if (covered) closes.add(opId)
    }
    if (closes.size === 0) continue
    if (
      best === null ||
      closes.size > best.closes.size ||
      (closes.size === best.closes.size && option.capexUsd < best.option.capexUsd)
    ) {
      best = { option, closes }
    }
  }
  return best
}

function movableFor(
  footprints: Map<GroupId, GroupFootprint>,
  hoursByGroup: Map<GroupId, number>,
  runnable: Set<OperationId>,
): Array<{ groupId: GroupId; hours: number; materials: number }> {
  const out: Array<{ groupId: GroupId; hours: number; materials: number }> = []
  for (const [groupId, hours] of hoursByGroup) {
    const footprint = footprints.get(groupId)
    if (footprint === undefined || footprint.ops.size === 0) continue
    let all = true
    for (const opId of footprint.ops) {
      if (!runnable.has(opId)) {
        all = false
        break
      }
    }
    if (!all) continue
    out.push({ groupId, hours, materials: footprint.materials.size })
  }
  out.sort((a, b) => b.hours - a.hours || (a.groupId < b.groupId ? -1 : 1))
  return out
}

/**
 * Somewhere else that could take the load off `wcId`, ranked by how much
 * genuine relief it offers.
 *
 * Sorted approved-first (usable today, no permission needed), then same-plant
 * (no freight, no customs, no new material master), then by the hours that
 * would actually leave the source.
 */
export function findRelief(
  snap: Snapshot,
  idx: SnapshotIndexes,
  load: LoadOutput,
  filters: Filters,
  wcId: WorkCenterId,
  max: number,
): ReliefCandidateDetail[] {
  const ctx = buildFilterContext(snap, idx, load, filters)
  const weeks = ctx.weekCount
  const sourceRow = idx.workCenterRow.get(wcId)
  const source = idx.workCenterById.get(wcId)
  if (sourceRow === undefined || source === undefined) return []

  const sourceStats = windowStats(
    load,
    ctx.ceilingByRow[sourceRow] ?? 1,
    (w) => ctx.cellByRowWeek[sourceRow * weeks + w],
    sourceRow,
    weeks,
    ctx.fromWeek,
    ctx.toWeek,
  )
  if (sourceStats.meanOee <= 0) return []

  const sourceOps = approvedOpsAt(idx, wcId)
  if (sourceOps.size === 0) return []
  const footprints = footprintAt(snap, idx, wcId)
  const hoursByGroup = hoursByGroupAt(load, ctx.groupPass, wcId, ctx.fromWeek, ctx.toWeek)
  if (hoursByGroup.size === 0) return []

  // Labour rides along in the ratio the source actually runs it.
  const labourRatio = safeDiv(sourceStats.labourRequired, sourceStats.machineRequired)

  const out: ReliefCandidateDetail[] = []

  for (const targetId of idx.workCenterOrder) {
    if (targetId === wcId) continue
    const targetRow = idx.workCenterRow.get(targetId)
    const target = idx.workCenterById.get(targetId)
    if (targetRow === undefined || target === undefined) continue

    // ---- what can this work center claim about the source's operations -----
    const approved = new Set<OperationId>()
    const capable = new Set<OperationId>()
    const retrofittable = new Set<OperationId>()
    for (const opId of sourceOps) {
      switch (capabilityBasis(idx, targetId, opId)) {
        case 'approved':
          approved.add(opId)
          break
        case 'featureCapable':
          capable.add(opId)
          break
        case 'retrofit':
          retrofittable.add(opId)
          break
        default:
          break
      }
    }
    if (approved.size === 0 && capable.size === 0 && retrofittable.size === 0) continue

    const targetStats = windowStats(
      load,
      ctx.ceilingByRow[targetRow] ?? 1,
      (w) => ctx.cellByRowWeek[targetRow * weeks + w],
      targetRow,
      weeks,
      ctx.fromWeek,
      ctx.toWeek,
    )
    if (targetStats.meanOee <= 0) continue
    if (targetStats.machineAvailable <= 0) continue

    const samePlant = target.plantId === source.plantId
    const emit = (
      basis: Basis,
      runnable: Set<OperationId>,
      option: RetrofitOption | undefined,
    ): void => {
      if (basis === 'none') return
      const movable = movableFor(footprints, hoursByGroup, runnable)
      if (movable.length === 0) return
      let movableHours = 0
      for (const entry of movable) movableHours += entry.hours
      if (movableHours <= 0) return

      // An hour here is not an hour there.
      const conversion = sourceStats.meanOee / targetStats.meanOee
      const arrivingMachine = movableHours * conversion
      const arrivingLabour = arrivingMachine * labourRatio
      const spareHours = Math.min(targetStats.machineSpare, targetStats.labourSpare)
      const absorbable = spareHours > 0 ? spareHours / conversion : 0
      const reliefHours = Math.max(0, Math.min(movableHours, absorbable))

      const resultingUtilisation = Math.max(
        safeDiv(targetStats.machineRequired + arrivingMachine, targetStats.machineAvailable),
        safeDiv(targetStats.labourRequired + arrivingLabour, targetStats.labourAvailable),
      )

      const movesBottleneck = resultingUtilisation > MOVES_BOTTLENECK_ABOVE
      const betterOff = resultingUtilisation < sourceStats.peakUtilisation
      if (movesBottleneck && !betterOff) return

      const sharedOperations = runnable.size
      const capexUsd = option === undefined ? 0 : option.capexUsd
      const leadTimeWeeks =
        basis === 'approved'
          ? 0
          : basis === 'featureCapable'
            ? QUALIFICATION_LEAD_WEEKS
            : (option?.leadTimeWeeks ?? 0) + QUALIFICATION_LEAD_WEEKS

      const reason =
        basis === 'approved'
          ? `Approved for ${sharedOperations} of the ${sourceOps.size} operations ${wcId} runs — usable today.`
          : basis === 'featureCapable'
            ? `Physically capable but not approved: needs qualification (~${QUALIFICATION_LEAD_WEEKS} weeks) before it can carry plan volume.`
            : `Needs the ${option?.name ?? 'retrofit'} retrofit before it is capable, then qualification.`
      const freight = samePlant
        ? 'Same plant: no freight, no customs, no new material master.'
        : `Cross-plant move from ${source.plantId} to ${target.plantId}: freight, customs and a material master at the receiving plant.`
      const verdict = movesBottleneck
        ? `Taking the whole movable set puts ${targetId} at ${(resultingUtilisation * 100).toFixed(0)}%, above its comfort line — but still below the ${(sourceStats.peakUtilisation * 100).toFixed(0)}% peak at ${wcId}, so the network is better off. Move part of it.`
        : `Taking the whole movable set puts ${targetId} at ${(resultingUtilisation * 100).toFixed(0)}%.`

      out.push({
        fromWorkCenterId: wcId,
        toWorkCenterId: targetId,
        basis,
        retrofit: option,
        movableGroups: movable,
        spareHours,
        resultingUtilisation,
        // NOTE: the field is spelled `sameePlant` in the domain contract. See
        // the return summary — it is a typo in `types.ts`, which this agent may
        // not edit, and renaming it here would break every consumer.
        sameePlant: samePlant,
        capexUsd,
        leadTimeWeeks,
        reliefHours,
        movesBottleneck,
        sharedOperations,
        note: `${reason} ${freight} ${verdict}`,
      })
    }

    // Tiers, cheapest claim first. A tier is only offered when it unlocks
    // groups the cheaper tier could not take, so a work center that is already
    // approved for everything never also appears as a retrofit proposal.
    const tierApproved = new Set(approved)
    const approvedGroups = movableFor(footprints, hoursByGroup, tierApproved).length
    if (approvedGroups > 0) emit('approved', tierApproved, undefined)

    const tierCapable = new Set(approved)
    for (const opId of capable) tierCapable.add(opId)
    const capableGroups =
      capable.size === 0 ? approvedGroups : movableFor(footprints, hoursByGroup, tierCapable).length
    if (capableGroups > approvedGroups) emit('featureCapable', tierCapable, undefined)

    if (retrofittable.size > 0) {
      const best = bestRetrofit(idx, targetId, retrofittable)
      if (best !== null) {
        const tierRetrofit = new Set(tierCapable)
        for (const opId of best.closes) tierRetrofit.add(opId)
        if (movableFor(footprints, hoursByGroup, tierRetrofit).length > capableGroups) {
          emit('retrofit', tierRetrofit, best.option)
        }
      }
    }
  }

  out.sort(
    (a, b) =>
      BASIS_RANK[a.basis] - BASIS_RANK[b.basis] ||
      Number(b.sameePlant) - Number(a.sameePlant) ||
      b.reliefHours - a.reliefHours ||
      (a.toWorkCenterId < b.toWorkCenterId ? -1 : a.toWorkCenterId > b.toWorkCenterId ? 1 : 0),
  )

  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : out.length
  return out.slice(0, limit)
}

/** Composite key for a (work center, group) hours series, matching `buildLoad`. */
export function groupHoursKey(workCenterId: WorkCenterId, groupId: GroupId): string {
  return key(workCenterId, groupId)
}
