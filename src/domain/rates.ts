/**
 * Rate resolution: routing -> production version -> SKU override.
 *
 * Rate and OEE are two independent knobs whose PRODUCT is the effective rate.
 * That convention is the whole reason a planner can change one and see which
 * one they changed, so it is worth being exact about:
 *
 *     effectiveRatePerHour = ratePerHour x oee
 *     machineHoursPerUnit  = 1 / effectiveRatePerHour
 *     labourHoursPerUnit   = (labourHoursPerBase / baseQty) / oee
 *
 * ===========================================================================
 *  OEE IS APPLIED HERE, TO THE RATE, AND NOWHERE ELSE.
 *
 *  Available hours in `capacity.ts` stay RAW shift hours minus DATED downtime.
 *  They must never be multiplied by OEE as well: unplanned loss is already
 *  inside the rate, and applying it twice would inflate every required hour by
 *  ~1/OEE — a 15% error that looks entirely plausible on a chart and survives
 *  a long way into a capex conversation. If you are about to multiply hours by
 *  OEE somewhere else in this codebase, you are about to do it twice.
 * ===========================================================================
 *
 * Resolution order, most specific winning:
 *
 *   1. the routing operation's own times (baseQty / machineHoursPerBase)
 *   2. an alternate production version — a non-primary `Routing` for the same
 *      material and plant that carries the same operation at the same work
 *      center. Its times replace the primary's wholesale, because half the
 *      times from one version and half from another describes no real process.
 *   3. a `RateOverride` for (materialId, workCenterId, opId) — highest, and the
 *      only step that touches the rate alone.
 *
 * Step 2 applies only when the operation handed in belongs to the PRIMARY
 * routing. A caller that already chose a version (sourcing does exactly that)
 * has made the decision, and this function must not second-guess it.
 */

import type {
  MaterialId,
  RoutingOperation,
  Snapshot,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import { clamp, key } from '@/domain/lookup'

export interface ResolvedOp {
  /** Nominal eaches/hour from the routing, before OEE. */
  ratePerHour: number
  /** ratePerHour x OEE — the number planners see. */
  effectiveRatePerHour: number
  /** AFTER OEE. */
  machineHoursPerUnit: number
  /** AFTER OEE. */
  labourHoursPerUnit: number
  /** Charged once per production lot in a bucket, not per unit. Not scaled by OEE. */
  setupHours: number
  /**
   * 0..1 good-parts yield. A zero yield means the operation makes nothing;
   * callers inflating upstream quantities must guard the division (`safeDiv`).
   */
  yield: number
}

interface SnapshotMemo {
  /** Every operation object reachable from a primary routing, by reference. */
  primaryOps: Set<RoutingOperation>
  /** key(materialId, plantId, opId, workCenterId) -> alternate-version operation. */
  alternates: Map<string, RoutingOperation>
  /**
   * Materials that have ANY alternate-version operation, and materials that
   * have ANY rate override.
   *
   * Both lookup keys below begin with the material id, so a material absent
   * from these sets cannot possibly hit either map. Testing a `Set` first is
   * not a micro-optimisation: `resolveOperation` runs once per (supply row,
   * operation) — ~80,000 times per run on the standard profile — and each of
   * those two lookups costs a composite key BUILT FROM A REST ARRAY AND A
   * JOIN. At 15,000 SKUs only ~12% carry an alternate and ~13% a rate
   * override, so the sets skip roughly three quarters of the string building
   * on the hottest path in the engine.
   */
  materialsWithAlternate: Set<MaterialId>
  materialsWithRateOverride: Set<MaterialId>
}

/**
 * Memoised per snapshot. `resolveOperation` is called once per (material,
 * operation, week) on the hot path, so the alternate-version search has to be a
 * map hit rather than a scan of the routings for that pair. `applyMoves`
 * returns a fresh Snapshot per scenario, so the WeakMap expires on its own.
 */
const memoBySnapshot = new WeakMap<Snapshot, SnapshotMemo>()

function memoFor(snap: Snapshot, idx: SnapshotIndexes): SnapshotMemo {
  const cached = memoBySnapshot.get(snap)
  if (cached) return cached
  const memo: SnapshotMemo = {
    primaryOps: new Set<RoutingOperation>(),
    alternates: new Map<string, RoutingOperation>(),
    materialsWithAlternate: new Set<MaterialId>(),
    materialsWithRateOverride: new Set<MaterialId>(),
  }
  for (const routing of idx.primaryRouting.values()) {
    for (const op of routing.operations) memo.primaryOps.add(op)
  }
  for (const [pairKey, routings] of idx.routingsByMaterialPlant) {
    const primary = idx.primaryRouting.get(pairKey)
    for (const routing of routings) {
      if (routing === primary) continue
      for (const op of routing.operations) {
        const k = key(pairKey, op.opId, op.workCenterId)
        // First alternate in snapshot order wins, so the result does not depend
        // on how many versions master data happens to carry.
        if (!memo.alternates.has(k)) memo.alternates.set(k, op)
        memo.materialsWithAlternate.add(routing.materialId)
      }
    }
  }
  for (const override of snap.rateOverrides) memo.materialsWithRateOverride.add(override.materialId)
  memoBySnapshot.set(snap, memo)
  return memo
}

function plantOf(idx: SnapshotIndexes, workCenterId: WorkCenterId): string | undefined {
  return idx.workCenterById.get(workCenterId)?.plantId
}

/** Nominal eaches/hour implied by an operation's own times. 0 when unusable. */
function nominalRate(op: RoutingOperation): number {
  if (!Number.isFinite(op.baseQty) || !Number.isFinite(op.machineHoursPerBase)) return 0
  if (op.baseQty <= 0 || op.machineHoursPerBase <= 0) return 0
  return op.baseQty / op.machineHoursPerBase
}

/**
 * Resolve one routing operation for one material at one OEE.
 *
 * `oee` is the value from `resolveOee` — already clamped, already
 * material-aware. This function never looks OEE up itself, so there is exactly
 * one place in the engine where the two knobs meet.
 */
export function resolveOperation(
  snap: Snapshot,
  idx: SnapshotIndexes,
  materialId: MaterialId,
  op: RoutingOperation,
  oee: number,
): ResolvedOp {
  const memo = memoFor(snap, idx)

  // --- step 1 + 2: which operation's times are we using at all? -------------
  // The material-level guard is exact, not an approximation: every key in
  // `alternates` starts with the material id, so a material outside the set
  // has no alternate to find.
  let source = op
  if (memo.materialsWithAlternate.has(materialId)) {
    const plantId = plantOf(idx, op.workCenterId)
    if (plantId !== undefined && memo.primaryOps.has(op)) {
      const alternate = memo.alternates.get(
        key(materialId, plantId, op.opId, op.workCenterId),
      )
      if (alternate !== undefined) source = alternate
    }
  }

  let ratePerHour = nominalRate(source)

  // --- step 3: the SKU-specific override beats everything ------------------
  if (memo.materialsWithRateOverride.has(materialId)) {
    const override = idx.rateOverrideByKey.get(key(materialId, op.workCenterId, op.opId))
    if (override !== undefined && Number.isFinite(override.ratePerHour) && override.ratePerHour > 0) {
      ratePerHour = override.ratePerHour
    }
  }

  const setupHours = Number.isFinite(source.setupHours) && source.setupHours > 0 ? source.setupHours : 0
  const yieldValue = Number.isFinite(source.yield) ? clamp(source.yield, 0, 1) : 1

  // --- OEE, applied once, to the rate --------------------------------------
  const oeeUsable = Number.isFinite(oee) && oee > 0
  if (!oeeUsable || ratePerHour <= 0) {
    // A dead rate or a dead OEE means the work is impossible here, which reads
    // as infinite hours. Never NaN, never a divide-by-zero that quietly becomes
    // a very large finite number two multiplications later.
    return {
      ratePerHour: ratePerHour > 0 ? ratePerHour : 0,
      effectiveRatePerHour: 0,
      machineHoursPerUnit: Infinity,
      labourHoursPerUnit: Infinity,
      setupHours,
      yield: yieldValue,
    }
  }

  const effectiveRatePerHour = ratePerHour * oee
  const machineHoursPerUnit = 1 / effectiveRatePerHour

  const labourPerBase = Number.isFinite(source.labourHoursPerBase) ? source.labourHoursPerBase : 0
  const baseQty = Number.isFinite(source.baseQty) ? source.baseQty : 0
  const labourHoursPerUnit =
    baseQty > 0 ? labourPerBase / baseQty / oee : labourPerBase > 0 ? Infinity : 0

  return {
    ratePerHour,
    effectiveRatePerHour,
    machineHoursPerUnit,
    labourHoursPerUnit,
    setupHours,
    yield: yieldValue,
  }
}
