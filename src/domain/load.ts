/**
 * Load explosion — the hot path of the whole application.
 *
 * 15,000 materials x ~78 weeks x ~3.6 operations is several million iterations
 * that have to finish in well under 300ms, so the shape of this file is
 * dictated by that budget:
 *
 *   - Every `Map` lookup, string build and routing resolution is hoisted out
 *     of the week loop. A routing is resolved **once per (row, routing run)**,
 *     never per week.
 *   - Per-operation hours-per-unit are pre-resolved into a flat
 *     `Float64Array` indexed `opPosition * weekCount + week`, because OEE
 *     varies by week but nothing else in the resolution does.
 *   - Only weeks that actually carry volume are visited. A supply row is
 *     compacted once into (week, quantity) pairs, and every operation then
 *     walks that short list instead of the horizon.
 *   - The inner loops are `for` loops over typed arrays. No object allocation,
 *     no `.map`/`.filter`/`.reduce`, no string concatenation.
 *   - The only dense outputs are the pool grids. There is never an
 *     intermediate array of per-SKU-per-week records.
 *
 * The physics: walk a routing's operations **in reverse**, because yield
 * compounds upstream. To ship `q` good units the last operation must start
 * `q / yield_last`, the one before it must start that divided by *its* yield,
 * and so on. Setup is charged once per (work center, material, week) that has
 * volume — it is a lot cost, not a unit cost and not a per-visit cost.
 */

import type {
  CapacityPool,
  GroupId,
  MaterialId,
  PoolLoadGrid,
  Snapshot,
  WorkCenterId,
  WorkCenterWeekLoad,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import type { CapacityGrids, CeilingSet } from '@/domain/capacity'
import { resolveCeiling, slippedWindow } from '@/domain/capacity'
import type { SourcingPlan } from '@/domain/sourcing'
import { SOURCING_PLANES } from '@/domain/sourcing'
import { resolveOperation } from '@/domain/rates'
import { resolveOee } from '@/domain/oee'
import { at, key, safeDiv } from '@/domain/lookup'

export interface LoadOutput {
  grids: Record<CapacityPool, PoolLoadGrid>
  cells: WorkCenterWeekLoad[]
  /** `key(workCenterId, groupId)` -> machine hours per week, for composition charts. */
  hoursByGroup: Map<string, Float64Array>
  /** Units actually placed, `supplyRow * weekCount + week`. */
  unitsByRow: Float64Array
  warnings: string[]
}

/** Beyond this the warning list stops being read and starts being scrolled. */
const MAX_WARNINGS = 40

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}
function i32(a: Int32Array, i: number): number {
  return a[i] ?? 0
}
function routingAt(a: Int32Array, i: number): number {
  return a[i] ?? -1
}

/** Downtime labels per week for one work center, in the modelled (slipped) position. */
function downtimeLabels(
  idx: SnapshotIndexes,
  workCenterId: WorkCenterId,
  weeks: number,
): Array<string[] | undefined> {
  const events = idx.downtimeByWorkCenter.get(workCenterId)
  if (events === undefined || events.length === 0) return []
  const out: Array<string[] | undefined> = new Array<string[] | undefined>(weeks)
  for (const ev of events) {
    const window = slippedWindow(ev)
    const from = window.from > 0 ? window.from : 0
    const to = window.to < weeks - 1 ? window.to : weeks - 1
    for (let w = from; w <= to; w++) {
      const existing = out[w]
      if (existing === undefined) out[w] = [ev.label]
      else existing.push(ev.label)
    }
  }
  return out
}

/**
 * Explode the supply plan into required hours per (work center, pool, week),
 * then judge each work-center week against its ceiling.
 *
 * `oeeGrid` is the work-center x week grid from `buildOeeGrid`; `capacity` the
 * available/downtime grids from `buildCapacity`; `sourcing` decides which
 * routing (and what share) applies to each supply row in each week.
 */
export function buildLoad(
  snap: Snapshot,
  idx: SnapshotIndexes,
  sourcing: SourcingPlan,
  capacity: CapacityGrids,
  oeeGrid: Float64Array,
  ceilings: CeilingSet,
): LoadOutput {
  const weeks = idx.weekCount
  const workCenterIds = idx.workCenterOrder
  const wcCount = workCenterIds.length
  const rows = snap.supplyPlan.rowKeys.length
  const planeSize = rows * weeks
  const gridSize = wcCount * weeks
  const supply = snap.supplyPlan.values
  const routingOfRow = sourcing.routingOfRow
  const shareOfRow = sourcing.shareOfRow

  const machineRequired = new Float64Array(gridSize)
  const labourRequired = new Float64Array(gridSize)
  const machineSetup = new Float64Array(gridSize)
  const labourSetup = new Float64Array(gridSize)
  const machineOverload = new Float64Array(gridSize)
  const labourOverload = new Float64Array(gridSize)
  /** Gross units passing through a work center — the volume-weighted rate's numerator. */
  const unitsAtWorkCenter = new Float64Array(gridSize)
  const unitsByRow = new Float64Array(planeSize)

  const warnings: string[] = []
  let suppressedWarnings = 0
  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message)
    else suppressedWarnings++
  }

  /**
   * Materials carrying a `materialWorkCenter` OEE override. Everything else
   * reads the pre-built work-center x week reciprocal below, which is the
   * difference between one typed-array load and a function call with map
   * lookups, several million times over.
   */
  const materialsWithOeeOverride = new Set<MaterialId>()
  for (const override of snap.oeeOverrides) {
    if (override.scope === 'materialWorkCenter' && override.materialId !== undefined) {
      materialsWithOeeOverride.add(override.materialId)
    }
  }

  // 1/OEE per (work center, week), computed once. Hours per unit are nominal
  // hours divided by OEE, so this table turns the hot path's division into a
  // multiply.
  const inverseOee = new Float64Array(gridSize)
  const workCenterHasZeroOee = new Uint8Array(wcCount)
  const workCenterHasCapacity = new Uint8Array(wcCount)
  for (let r = 0; r < wcCount; r++) {
    const base = r * weeks
    for (let w = 0; w < weeks; w++) {
      const i = base + w
      const oee = f64(oeeGrid, i)
      if (oee > 0) inverseOee[i] = 1 / oee
      else workCenterHasZeroOee[r] = 1
      if (workCenterHasCapacity[r] === 0 && (f64(capacity.machine, i) > 0 || f64(capacity.labour, i) > 0)) {
        workCenterHasCapacity[r] = 1
      }
    }
  }

  // ---- scratch reused across every routing, so the hot path allocates nothing
  const rowWeek = new Int32Array(weeks)
  const rowQty = new Float64Array(weeks)
  const runWeek = new Int32Array(weeks)
  const runQty = new Float64Array(weeks)

  let scratchOps = 8
  let opWorkCenterRow = new Int32Array(scratchOps)
  let opInvCumYield = new Float64Array(scratchOps)
  let opYield = new Float64Array(scratchOps)
  let opSetupHours = new Float64Array(scratchOps)
  let opMachinePerUnit = new Float64Array(scratchOps * weeks)
  let opLabourPerUnit = new Float64Array(scratchOps * weeks)
  let opGroupHours: Array<Float64Array | null> = new Array<Float64Array | null>(scratchOps).fill(
    null,
  )
  const ensureScratch = (opCount: number): void => {
    if (opCount <= scratchOps) return
    scratchOps = opCount
    opWorkCenterRow = new Int32Array(scratchOps)
    opInvCumYield = new Float64Array(scratchOps)
    opYield = new Float64Array(scratchOps)
    opSetupHours = new Float64Array(scratchOps)
    opMachinePerUnit = new Float64Array(scratchOps * weeks)
    opLabourPerUnit = new Float64Array(scratchOps * weeks)
    opGroupHours = new Array<Float64Array | null>(scratchOps).fill(null)
  }

  /**
   * Group hours held as work-center row -> group -> weekly hours, so the hot
   * path never builds the composite key string. Flattened to the contracted
   * `key(workCenterId, groupId)` map once, at the end.
   */
  const groupHoursByWorkCenter: Array<Map<GroupId, Float64Array> | undefined> = new Array<
    Map<GroupId, Float64Array> | undefined
  >(wcCount)

  /**
   * Setup is charged once per (work center, material, week). The stamp is the
   * supply row + 1, so a work-center week already stamped by this row — by an
   * earlier operation of the same routing, or by the row's second source —
   * is not charged again. No clearing pass is needed: the next row carries a
   * different stamp.
   */
  const setupStamp = new Int32Array(gridSize)

  /**
   * A single-sourced plan — the overwhelmingly common case — leaves the whole
   * second plane empty. One early-exiting scan here saves walking it once per
   * supply row below. Derived from the planes rather than from
   * `sourcing.dualSourced`, so a hand-built plan cannot silently lose volume.
   */
  let planeCount = 1
  for (let i = 0; i < planeSize; i++) {
    if (routingAt(routingOfRow, planeSize + i) >= 0) {
      planeCount = SOURCING_PLANES
      break
    }
  }

  const zeroOeeWorkCenters = new Set<WorkCenterId>()
  const warnedZeroCapacity = new Set<string>()
  const warnedBadYield = new Set<string>()

  /**
   * Accumulate one run of weeks that share a routing.
   *
   * `aFrom`/`aTo` index into the row's compacted (week, quantity) list, not
   * into the week grid. Everything that does not vary by week is resolved
   * here, above the week loops.
   */
  const processRun = (
    routingIndex: number,
    planeBase: number,
    rowBase: number,
    aFrom: number,
    aTo: number,
    materialId: MaterialId,
    groupId: GroupId,
    stamp: number,
    perMaterialOee: boolean,
  ): void => {
    // Every array the week loops touch is pulled into a local first. These are
    // closure captures, and a captured `let` is a context load on every read —
    // at several million reads that is the difference between 200ms and 50ms.
    const weekList = runWeek
    const qtyList = runQty
    const machineGridOut = machineRequired
    const labourGridOut = labourRequired
    const unitsGridOut = unitsAtWorkCenter
    const stampGrid = setupStamp

    // Compact again to the weeks this source actually carries: a share of zero
    // means the other plane has the volume.
    let n = 0
    for (let a = aFrom; a < aTo; a++) {
      const w = i32(rowWeek, a)
      const share = f64(shareOfRow, planeBase + w)
      if (share <= 0) continue
      const qty = f64(rowQty, a) * share
      if (qty <= 0) continue
      weekList[n] = w
      qtyList[n] = qty
      n++
    }
    if (n === 0) return

    const routing = at(snap.routings, routingIndex, 'routing')
    let ops = routing.operations
    const opCount = ops.length
    if (opCount === 0) return

    // Reverse yield compounding depends on sequence order. Routings arrive
    // sorted; the check is cheap insurance against one that is not.
    let sorted = true
    for (let p = 1; p < opCount; p++) {
      if (at(ops, p, 'routing operation').seq < at(ops, p - 1, 'routing operation').seq) {
        sorted = false
        break
      }
    }
    if (!sorted) ops = [...ops].sort((a, b) => a.seq - b.seq)

    ensureScratch(opCount)

    for (let i = 0; i < n; i++) {
      const w = i32(weekList, i)
      unitsByRow[rowBase + w] = f64(unitsByRow, rowBase + w) + f64(qtyList, i)
    }

    for (let p = 0; p < opCount; p++) {
      const op = at(ops, p, 'routing operation')
      const workCenterRow = idx.workCenterRow.get(op.workCenterId)
      if (workCenterRow === undefined) {
        // The operation loads nothing, but its scrap still inflates everything
        // upstream of it, so the yield still has to be carried.
        opWorkCenterRow[p] = -1
        opGroupHours[p] = null
        opYield[p] = op.yield
        opSetupHours[p] = 0
        const warnKey = key(op.workCenterId, op.opId)
        if (!warnedZeroCapacity.has(warnKey)) {
          warnedZeroCapacity.add(warnKey)
          warn(
            `Routing ${routing.id} operation ${op.seq} (${op.opId}) names work center ${op.workCenterId}, which is not in the snapshot.`,
          )
        }
        continue
      }
      opWorkCenterRow[p] = workCenterRow

      if (workCenterHasCapacity[workCenterRow] === 0) {
        const warnKey = key(op.workCenterId, op.opId)
        if (!warnedZeroCapacity.has(warnKey)) {
          warnedZeroCapacity.add(warnKey)
          warn(
            `Routing ${routing.id} operation ${op.seq} (${op.opId}) runs on ${op.workCenterId}, which offers zero hours across the horizon.`,
          )
        }
      }
      if (workCenterHasZeroOee[workCenterRow] === 1) zeroOeeWorkCenters.add(op.workCenterId)

      // Resolved at OEE = 1, i.e. nominal hours per unit. `ResolvedOp` defines
      // machine and labour hours per unit as the nominal figure divided by
      // OEE, so they are exactly proportional to 1/OEE — which is what lets a
      // single resolution here cover all 78 weeks. Resolving per week instead
      // would mean millions of `resolveOperation` calls and as many
      // short-lived objects.
      const resolved = resolveOperation(snap, idx, materialId, op, 1)
      opSetupHours[p] = resolved.setupHours
      // Yield comes from the SAME resolution as the times. `resolveOperation`
      // may substitute an alternate production version's operation wholesale,
      // and taking the times from one version and the yield from another would
      // describe no real process.
      opYield[p] = resolved.yield
      let machineBase = resolved.machineHoursPerUnit
      let labourBase = resolved.labourHoursPerUnit
      // `resolveOperation` reports an impossible operation as Infinity hours.
      // That must not reach a grid: one bad master-data row would turn a whole
      // work center — and every KPI derived from it — into Infinity or NaN.
      if (!Number.isFinite(machineBase) || !Number.isFinite(labourBase)) {
        const warnKey = key(op.workCenterId, op.opId)
        if (!warnedZeroCapacity.has(warnKey)) {
          warnedZeroCapacity.add(warnKey)
          warn(
            `Routing ${routing.id} operation ${op.seq} (${op.opId}) on ${op.workCenterId} has no usable rate; it contributed no hours.`,
          )
        }
        machineBase = 0
        labourBase = 0
      }

      let byGroup = groupHoursByWorkCenter[workCenterRow]
      if (byGroup === undefined) {
        byGroup = new Map<GroupId, Float64Array>()
        groupHoursByWorkCenter[workCenterRow] = byGroup
      }
      let groupArray = byGroup.get(groupId)
      if (groupArray === undefined) {
        groupArray = new Float64Array(weeks)
        byGroup.set(groupId, groupArray)
      }
      opGroupHours[p] = groupArray

      // Per-operation hours per unit, filled in one pass, indexed
      // [opPosition * weekCount + week].
      const opOffset = p * weeks
      const oeeOffset = workCenterRow * weeks
      const machinePerUnit = opMachinePerUnit
      const labourPerUnit = opLabourPerUnit
      if (perMaterialOee) {
        for (let i = 0; i < n; i++) {
          const w = i32(weekList, i)
          const oee = resolveOee(snap, idx, oeeGrid, op.workCenterId, materialId, w)
          const factor = oee > 0 ? 1 / oee : 0
          if (factor === 0) zeroOeeWorkCenters.add(op.workCenterId)
          machinePerUnit[opOffset + w] = machineBase * factor
          labourPerUnit[opOffset + w] = labourBase * factor
        }
      } else {
        const inverse = inverseOee
        for (let i = 0; i < n; i++) {
          const w = i32(weekList, i)
          const factor = f64(inverse, oeeOffset + w)
          machinePerUnit[opOffset + w] = machineBase * factor
          labourPerUnit[opOffset + w] = labourBase * factor
        }
      }
    }

    // gross[p] = qty / product(yield[j] for j >= p). Walking the operations
    // BACKWARDS is what makes scrap at the last operation inflate every
    // operation before it: the last must start qty/yield_last, the one before
    // it must start that divided by its own yield, and so on upstream.
    let cumulative = 1
    for (let p = opCount - 1; p >= 0; p--) {
      let y = f64(opYield, p)
      if (!(y > 0) || y > 1) {
        if (!warnedBadYield.has(routing.id)) {
          warnedBadYield.add(routing.id)
          warn(
            `Routing ${routing.id} operation ${at(ops, p, 'routing operation').seq} has yield ${y}; treated as 1.0.`,
          )
        }
        y = 1
      }
      cumulative *= y
      opInvCumYield[p] = 1 / cumulative
    }

    for (let p = 0; p < opCount; p++) {
      const workCenterRow = i32(opWorkCenterRow, p)
      if (workCenterRow < 0) continue
      const groupArray = opGroupHours[p]
      if (groupArray === undefined || groupArray === null) continue
      const invCumYield = f64(opInvCumYield, p)
      const setup = f64(opSetupHours, p)
      const opOffset = p * weeks
      const gridOffset = workCenterRow * weeks
      const machinePerUnit = opMachinePerUnit
      const labourPerUnit = opLabourPerUnit
      const chargesSetup = setup > 0

      for (let i = 0; i < n; i++) {
        const w = i32(weekList, i)
        const grossQty = f64(qtyList, i) * invCumYield
        const gi = gridOffset + w
        let machineHours = grossQty * f64(machinePerUnit, opOffset + w)
        let labourHours = grossQty * f64(labourPerUnit, opOffset + w)

        if (chargesSetup && i32(stampGrid, gi) !== stamp) {
          stampGrid[gi] = stamp
          // A changeover occupies the machine and the operator who runs it, so
          // it is charged to both pools.
          machineSetup[gi] = f64(machineSetup, gi) + setup
          labourSetup[gi] = f64(labourSetup, gi) + setup
          machineHours += setup
          labourHours += setup
        }

        machineGridOut[gi] = f64(machineGridOut, gi) + machineHours
        labourGridOut[gi] = f64(labourGridOut, gi) + labourHours
        unitsGridOut[gi] = f64(unitsGridOut, gi) + grossQty
        groupArray[w] = f64(groupArray, w) + machineHours
      }
    }
  }

  // ---- the row loop --------------------------------------------------------
  const warnedNoRouting = new Set<string>()
  for (let row = 0; row < rows; row++) {
    const rowBase = row * weeks

    // Compact the row to the weeks that carry volume. Everything downstream
    // walks this list, so empty weeks cost one comparison each and no more.
    let activeCount = 0
    for (let w = 0; w < weeks; w++) {
      const qty = f64(supply, rowBase + w)
      if (qty > 0) {
        rowWeek[activeCount] = w
        rowQty[activeCount] = qty
        activeCount++
      }
    }
    if (activeCount === 0) continue

    const rowKey = at(snap.supplyPlan.rowKeys, row, 'supply row key')
    const separator = rowKey.indexOf('|')
    const materialId = separator < 0 ? rowKey : rowKey.slice(0, separator)
    const material = idx.materialById.get(materialId)
    if (material === undefined) {
      if (!warnedNoRouting.has(rowKey)) {
        warnedNoRouting.add(rowKey)
        warn(
          `Supply row ${rowKey} names a material that is not in the snapshot; its volume is ignored.`,
        )
      }
      continue
    }

    for (let a = 0; a < activeCount; a++) {
      const w = i32(rowWeek, a)
      if (routingAt(routingOfRow, rowBase + w) < 0) {
        if (!warnedNoRouting.has(rowKey)) {
          warnedNoRouting.add(rowKey)
          warn(
            `Supply row ${rowKey} has volume but no valid routing from week ${w}; those units load no capacity.`,
          )
        }
        break
      }
    }

    const groupId = material.groupId
    const perMaterialOee = materialsWithOeeOverride.has(materialId)
    const stamp = row + 1

    for (let plane = 0; plane < planeCount; plane++) {
      const planeBase = plane * planeSize + rowBase
      let a = 0
      while (a < activeCount) {
        const routingIndex = routingAt(routingOfRow, planeBase + i32(rowWeek, a))
        let end = a + 1
        while (
          end < activeCount &&
          routingAt(routingOfRow, planeBase + i32(rowWeek, end)) === routingIndex
        )
          end++
        if (routingIndex >= 0) {
          processRun(
            routingIndex,
            planeBase,
            rowBase,
            a,
            end,
            materialId,
            groupId,
            stamp,
            perMaterialOee,
          )
        }
        a = end
      }
    }
  }

  // ---- judge every work-center week against its ceiling --------------------
  const cells: WorkCenterWeekLoad[] = []
  for (let r = 0; r < wcCount; r++) {
    const workCenterId = at(workCenterIds, r, 'work center')
    const workCenter = idx.workCenterById.get(workCenterId)
    if (workCenter === undefined) continue
    const ceiling = resolveCeiling(ceilings, workCenter)
    const labelsByWeek = downtimeLabels(idx, workCenterId, weeks)
    const base = r * weeks
    let warnedExcess = false

    for (let w = 0; w < weeks; w++) {
      const i = base + w
      const machineAvailable = f64(capacity.machine, i)
      const labourAvailable = f64(capacity.labour, i)
      const machineReq = f64(machineRequired, i)
      const labourReq = f64(labourRequired, i)
      const machineCeiling = machineAvailable * ceiling
      const labourCeiling = labourAvailable * ceiling

      machineOverload[i] = machineReq > machineCeiling ? machineReq - machineCeiling : 0
      labourOverload[i] = labourReq > labourCeiling ? labourReq - labourCeiling : 0

      // A zero-capacity cell carrying load reports utilisation 0 rather than
      // Infinity — it is a data error, flagged by `overloadHours` and by a
      // warning, and a non-finite number would poison every chart downstream.
      const machineUtil = safeDiv(machineReq, machineCeiling)
      const labourUtil = safeDiv(labourReq, labourCeiling)

      // …but a pool with work to do and NO hours at all is the hardest
      // constraint there is, not the softest. Because `safeDiv` reports a zero
      // denominator as 0, comparing the two ratios alone would rank such a pool
      // BELOW every pool that has hours — so blocking a pool outright (a
      // collective vacation, a shiftChange down to nothing) made the work
      // center's reported utilisation FALL. The impossible case is therefore
      // detected explicitly rather than inferred from a ratio that cannot
      // express it. Both impossible falls through to the hours comparison.
      const machineImpossible = machineCeiling <= 0 && machineReq > 0
      const labourImpossible = labourCeiling <= 0 && labourReq > 0
      const bindingPool: CapacityPool =
        machineImpossible !== labourImpossible
          ? machineImpossible
            ? 'machine'
            : 'labour'
          : labourUtil > machineUtil
            ? 'labour'
            : labourUtil < machineUtil
              ? 'machine'
              : labourReq > machineReq
                ? 'labour'
                : 'machine'

      const bindingRequired = bindingPool === 'machine' ? machineReq : labourReq
      const bindingAvailable = bindingPool === 'machine' ? machineAvailable : labourAvailable
      const overloadHours = f64(bindingPool === 'machine' ? machineOverload : labourOverload, i)

      // Back to eaches at the rate this work center actually achieves in this
      // week: gross units placed here per hour of the binding pool. Setup is
      // inside those hours, which is correct — it is time the asset is not
      // making anything.
      const achievedRate = safeDiv(f64(unitsAtWorkCenter, i), bindingRequired)

      if (!warnedExcess && bindingRequired > 0 && bindingAvailable <= 0) {
        warnedExcess = true
        warn(
          `${workCenterId} week ${w} requires ${Math.round(bindingRequired)}h of ${bindingPool} but that pool offers no hours at all that week. Nothing can be made there: either the volume needs another source or the downtime needs to move.`,
        )
      } else if (!warnedExcess && bindingAvailable > 0 && bindingRequired > 3 * bindingAvailable) {
        warnedExcess = true
        warn(
          `${workCenterId} week ${w} requires ${Math.round(bindingRequired)}h of ${bindingPool} against ${Math.round(bindingAvailable)}h available (>3x). That is a data error, not a bottleneck.`,
        )
      }

      cells.push({
        workCenterId,
        week: w,
        machineRequired: machineReq,
        machineAvailable,
        labourRequired: labourReq,
        labourAvailable,
        ceiling,
        utilisation: machineUtil > labourUtil ? machineUtil : labourUtil,
        bindingPool,
        overloadHours,
        shortfallUnits: overloadHours * achievedRate,
        oee: f64(oeeGrid, i),
        // Every planned hour removed at this work center this week, across
        // both pools — an installation that blocks machine and labour lost
        // both, and reporting one of them would understate it.
        downtimeHours: f64(capacity.machineDowntime, i) + f64(capacity.labourDowntime, i),
        events: labelsByWeek[w] ?? [],
      })
    }
  }

  const hoursByGroup = new Map<string, Float64Array>()
  for (let r = 0; r < wcCount; r++) {
    const byGroup = groupHoursByWorkCenter[r]
    if (byGroup === undefined) continue
    const workCenterId = at(workCenterIds, r, 'work center')
    for (const [groupId, hours] of byGroup) hoursByGroup.set(key(workCenterId, groupId), hours)
  }

  if (zeroOeeWorkCenters.size > 0) {
    const sample = [...zeroOeeWorkCenters].slice(0, 5).join(', ')
    warn(
      `${zeroOeeWorkCenters.size} loaded work center(s) resolve to zero OEE in at least one week (${sample}); their operations contributed no hours there.`,
    )
  }
  if (suppressedWarnings > 0) {
    warnings.push(`…and ${suppressedWarnings} more warning(s) of the same kinds.`)
  }

  // `availableHours` and `downtimeHours` alias the capacity grids rather than
  // copying them: there is one source of truth for available hours, and the
  // load pass never writes to them.
  const machineGrid: PoolLoadGrid = {
    workCenterIds,
    weekCount: weeks,
    availableHours: capacity.machine,
    requiredHours: machineRequired,
    downtimeHours: capacity.machineDowntime,
    overloadHours: machineOverload,
    setupHours: machineSetup,
  }
  const labourGrid: PoolLoadGrid = {
    workCenterIds,
    weekCount: weeks,
    availableHours: capacity.labour,
    requiredHours: labourRequired,
    downtimeHours: capacity.labourDowntime,
    overloadHours: labourOverload,
    setupHours: labourSetup,
  }

  return {
    grids: { machine: machineGrid, labour: labourGrid },
    cells,
    hoursByGroup,
    unitsByRow,
    warnings,
  }
}
