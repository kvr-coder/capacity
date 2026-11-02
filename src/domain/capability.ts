/**
 * Capability: what a work center MAY run, and what it COULD run.
 *
 * These are two different claims and the tool must never blur them.
 *
 *   approved       Master-data truth. A routing exists whose operation runs at
 *                  this work center, so the work center appears in
 *                  `approvedWorkCentersByOp` for that operation. THIS AND ONLY
 *                  THIS is what planning may use. No approval, no plan.
 *   featureCapable The machine's granted features are a superset of the
 *                  standard operation's required features — it could do the
 *                  work today — but nobody has approved it. A proposal, with a
 *                  qualification conversation attached.
 *   retrofit       Not capable as it stands, but its machine class sells a
 *                  retrofit whose added features close the whole gap. A
 *                  proposal with a price and a lead time attached.
 *   none           The gap cannot be closed on that class at any price.
 *
 * The feature model exists ONLY to propose. `capabilityBasis` checks the
 * allow-list first and returns `approved` before it looks at a single feature,
 * so an unapproved-but-capable work center can never be mistaken for an
 * approved one no matter how capable it looks.
 *
 * Everything derived here is memoised against the `SnapshotIndexes` object.
 * `sharedCapacityLinks` is what the canvas draws as capability edges — it runs
 * on every hover, so it walks an operation -> work-center index rather than
 * scanning 150 work centers x their features per call.
 */

import type { FeatureId, OperationId, RetrofitOption, WorkCenterId } from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import { key } from '@/domain/lookup'

export type Basis = 'approved' | 'featureCapable' | 'retrofit' | 'none'

/** Strongest first. Used to pick the best basis across several shared operations. */
const BASIS_RANK: Record<Basis, number> = {
  approved: 0,
  featureCapable: 1,
  retrofit: 2,
  none: 3,
}

interface OpCapability {
  /** Work centers master data permits. */
  approved: WorkCenterId[]
  /** Feature-capable but NOT approved. Disjoint from `approved`. */
  capable: WorkCenterId[]
  /** Retrofittable only. Disjoint from both lists above. */
  retrofit: WorkCenterId[]
}

interface Derived {
  approvedByOp: Map<OperationId, Set<WorkCenterId>>
  opsByWorkCenter: Map<WorkCenterId, OperationId[]>
  /** Lazily filled, one entry per operation actually asked about. */
  opCapability: Map<OperationId, OpCapability>
  /** Lazily filled: key(workCenterId, opId) -> cheapest closing retrofit, or null. */
  retrofitByWcOp: Map<string, RetrofitOption | null>
}

const derivedCache = new WeakMap<SnapshotIndexes, Derived>()

function derive(idx: SnapshotIndexes): Derived {
  const cached = derivedCache.get(idx)
  if (cached) return cached
  const approvedByOp = new Map<OperationId, Set<WorkCenterId>>()
  const opsByWorkCenter = new Map<WorkCenterId, OperationId[]>()
  for (const [opId, wcIds] of idx.approvedWorkCentersByOp) {
    approvedByOp.set(opId, new Set(wcIds))
    for (const wcId of wcIds) {
      const list = opsByWorkCenter.get(wcId)
      if (list) list.push(opId)
      else opsByWorkCenter.set(wcId, [opId])
    }
  }
  const derived: Derived = {
    approvedByOp,
    opsByWorkCenter,
    opCapability: new Map<OperationId, OpCapability>(),
    retrofitByWcOp: new Map<string, RetrofitOption | null>(),
  }
  derivedCache.set(idx, derived)
  return derived
}

/**
 * Required features the work center does not have, in the order the standard
 * operation declares them.
 *
 * An operation with no standard-operation record has unknown requirements. It
 * returns an empty list here — there is nothing to name — but
 * {@link capabilityBasis} still refuses to call the work center capable, since
 * "we do not know what this needs" is not the same as "it needs nothing".
 */
export function missingFeatures(
  idx: SnapshotIndexes,
  wcId: WorkCenterId,
  opId: OperationId,
): FeatureId[] {
  const stdOp = idx.stdOpById.get(opId)
  if (stdOp === undefined) return []
  const granted = idx.workCenterFeatures.get(wcId)
  if (granted === undefined) return [...stdOp.requiredFeatures]
  return stdOp.requiredFeatures.filter((featureId) => !granted.has(featureId))
}

/**
 * The cheapest retrofit on this work center's machine class whose added
 * features close the entire gap for this operation.
 *
 * Returns null when there is no gap to close (the work center is already
 * capable — a retrofit would buy nothing) and when no single option covers
 * every missing feature. Ties on capex break on the shorter lead time, then on
 * id, so the recommendation is stable across runs.
 */
export function findRetrofit(
  idx: SnapshotIndexes,
  wcId: WorkCenterId,
  opId: OperationId,
): RetrofitOption | null {
  const derived = derive(idx)
  const cacheKey = key(wcId, opId)
  const cached = derived.retrofitByWcOp.get(cacheKey)
  if (cached !== undefined) return cached

  const answer = searchRetrofit(idx, wcId, opId)
  derived.retrofitByWcOp.set(cacheKey, answer)
  return answer
}

function searchRetrofit(
  idx: SnapshotIndexes,
  wcId: WorkCenterId,
  opId: OperationId,
): RetrofitOption | null {
  const stdOp = idx.stdOpById.get(opId)
  if (stdOp === undefined) return null
  const missing = missingFeatures(idx, wcId, opId)
  if (missing.length === 0) return null
  const wc = idx.workCenterById.get(wcId)
  if (wc === undefined) return null
  const machineClass = idx.classById.get(wc.classId)
  if (machineClass === undefined) return null

  let best: RetrofitOption | null = null
  for (const option of machineClass.retrofits) {
    const adds = new Set(option.addsFeatures)
    let closes = true
    for (const featureId of missing) {
      if (!adds.has(featureId)) {
        closes = false
        break
      }
    }
    if (!closes) continue
    if (best === null) {
      best = option
      continue
    }
    if (option.capexUsd < best.capexUsd) best = option
    else if (option.capexUsd === best.capexUsd && option.leadTimeWeeks < best.leadTimeWeeks) best = option
    else if (
      option.capexUsd === best.capexUsd &&
      option.leadTimeWeeks === best.leadTimeWeeks &&
      option.id < best.id
    ) {
      best = option
    }
  }
  return best
}

/**
 * Which of the four claims this work center can make about this operation.
 *
 * The allow-list is checked first and short-circuits. Everything after it is a
 * proposal, never a plan.
 */
export function capabilityBasis(
  idx: SnapshotIndexes,
  wcId: WorkCenterId,
  opId: OperationId,
): Basis {
  const derived = derive(idx)
  if (derived.approvedByOp.get(opId)?.has(wcId) === true) return 'approved'

  const stdOp = idx.stdOpById.get(opId)
  // Unknown requirements: refuse to claim capability rather than assume none.
  if (stdOp === undefined) return 'none'
  if (idx.workCenterById.get(wcId) === undefined) return 'none'

  if (missingFeatures(idx, wcId, opId).length === 0) return 'featureCapable'
  return findRetrofit(idx, wcId, opId) !== null ? 'retrofit' : 'none'
}

function opCapabilityFor(idx: SnapshotIndexes, opId: OperationId): OpCapability {
  const derived = derive(idx)
  const cached = derived.opCapability.get(opId)
  if (cached) return cached

  const result: OpCapability = { approved: [], capable: [], retrofit: [] }
  const approved = derived.approvedByOp.get(opId)
  // Walking `workCenterOrder` (rather than the approved set) both fixes the
  // output order and drops any ghost id a stale routing still points at.
  for (const wcId of idx.workCenterOrder) {
    if (approved?.has(wcId) === true) {
      result.approved.push(wcId)
      continue
    }
    switch (capabilityBasis(idx, wcId, opId)) {
      case 'featureCapable':
        result.capable.push(wcId)
        break
      case 'retrofit':
        result.retrofit.push(wcId)
        break
      default:
        break
    }
  }
  derived.opCapability.set(opId, result)
  return result
}

export interface CapabilityLink {
  workCenterId: WorkCenterId
  basis: Basis
  sharedOperations: number
}

/**
 * Every OTHER work center that could run at least one operation this one runs,
 * with the strongest basis it can claim across those operations and how many of
 * them it shares.
 *
 * "Runs" means approved: the set of operations considered is the ones master
 * data permits here. Sorted approved-first, then by breadth of overlap, so the
 * canvas can draw the strongest edges without re-sorting.
 */
export function sharedCapacityLinks(
  idx: SnapshotIndexes,
  wcId: WorkCenterId,
): CapabilityLink[] {
  const derived = derive(idx)
  const ops = derived.opsByWorkCenter.get(wcId) ?? []
  const acc = new Map<WorkCenterId, { basis: Basis; sharedOperations: number }>()

  const bump = (other: WorkCenterId, basis: Basis): void => {
    if (other === wcId) return
    const entry = acc.get(other)
    if (entry === undefined) {
      acc.set(other, { basis, sharedOperations: 1 })
      return
    }
    entry.sharedOperations += 1
    if (BASIS_RANK[basis] < BASIS_RANK[entry.basis]) entry.basis = basis
  }

  for (const opId of ops) {
    const capability = opCapabilityFor(idx, opId)
    // The three lists are disjoint, so each work center is counted at most once
    // per operation and `sharedOperations` stays a count of operations.
    for (const other of capability.approved) bump(other, 'approved')
    for (const other of capability.capable) bump(other, 'featureCapable')
    for (const other of capability.retrofit) bump(other, 'retrofit')
  }

  const links: CapabilityLink[] = []
  for (const [workCenterId, entry] of acc) {
    links.push({ workCenterId, basis: entry.basis, sharedOperations: entry.sharedOperations })
  }
  links.sort(
    (a, b) =>
      BASIS_RANK[a.basis] - BASIS_RANK[b.basis] ||
      b.sharedOperations - a.sharedOperations ||
      (a.workCenterId < b.workCenterId ? -1 : a.workCenterId > b.workCenterId ? 1 : 0),
  )
  return links
}
