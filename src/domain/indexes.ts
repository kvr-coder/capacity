/**
 * Lookup structures over a `Snapshot`.
 *
 * Built once per run, immediately after moves are applied and before anything
 * numeric happens. Every other module in `src/domain` reads these instead of
 * scanning arrays: at 15,000 materials and 150 work centers, a single linear
 * scan inside a per-SKU-per-week loop is the difference between a 200ms run and
 * a run the planner watches happen.
 *
 * Two conventions worth knowing before reading further:
 *
 *   - **Row numbers are identity.** `workCenterRow` fixes the row a work center
 *     occupies in *every* work-center x week grid the engine builds, so grids
 *     from different modules can be added together without a join.
 *   - **Composite keys use `key(...)` from `./lookup`.** `|` is not legal in any
 *     id in this dataset, which is what makes the flat string key safe. The
 *     supply and demand plans already ship their rows in that shape, so their
 *     row maps are the plan's own `rowKeys` with no re-encoding.
 *
 * Nothing here throws on inconsistent master data. A routing that references a
 * work center which no longer exists is a data problem for the layer that can
 * report it to a planner; the index just records what it was given.
 */

import type {
  DowntimeEvent,
  FamilyId,
  Feature,
  FeatureId,
  GroupId,
  MachineClass,
  MachineClassId,
  Material,
  MaterialId,
  OperationId,
  Plant,
  PlantId,
  ProductFamily,
  ProductGroup,
  RateOverride,
  Routing,
  Snapshot,
  StandardOperation,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import { key } from '@/domain/lookup'

export interface SnapshotIndexes {
  plantById: Map<PlantId, Plant>
  plantOrder: PlantId[]
  workCenterById: Map<WorkCenterId, WorkCenter>
  /** Row in every work-center x week grid. Stable for the life of the snapshot. */
  workCenterRow: Map<WorkCenterId, number>
  workCenterOrder: WorkCenterId[]
  workCentersByPlant: Map<PlantId, WorkCenter[]>
  workCentersByClass: Map<MachineClassId, WorkCenter[]>
  materialById: Map<MaterialId, Material>
  materialsByGroup: Map<GroupId, MaterialId[]>
  materialsByFamily: Map<FamilyId, MaterialId[]>
  groupById: Map<GroupId, ProductGroup>
  familyById: Map<FamilyId, ProductFamily>
  classById: Map<MachineClassId, MachineClass>
  featureById: Map<FeatureId, Feature>
  stdOpById: Map<OperationId, StandardOperation>
  /** key(materialId, plantId) -> every production version, snapshot order. */
  routingsByMaterialPlant: Map<string, Routing[]>
  /** key(materialId, plantId) -> the version planning picks by default. */
  primaryRouting: Map<string, Routing>
  /**
   * The allow-list, inverted: which work centers master data actually permits
   * for an operation. THIS is what planning may use — feature capability is a
   * separate, weaker claim computed in `capability.ts`.
   */
  approvedWorkCentersByOp: Map<OperationId, WorkCenterId[]>
  workCenterFeatures: Map<WorkCenterId, Set<FeatureId>>
  rateOverrideByKey: Map<string, RateOverride>
  downtimeByWorkCenter: Map<WorkCenterId, DowntimeEvent[]>
  /** key(materialId, plantId) -> row in `supplyPlan.values`. */
  supplyRow: Map<string, number>
  /** key(materialId, region) -> row in `demandPlan.values`. */
  demandRow: Map<string, number>
  weekCount: number
}

function push<T>(map: Map<string, T[]>, k: string, value: T): void {
  const bucket = map.get(k)
  if (bucket) bucket.push(value)
  else map.set(k, [value])
}

export function buildIndexes(snap: Snapshot): SnapshotIndexes {
  const plantById = new Map<PlantId, Plant>()
  const plantOrder: PlantId[] = []
  for (const plant of snap.plants) {
    plantById.set(plant.id, plant)
    plantOrder.push(plant.id)
  }

  const workCenterById = new Map<WorkCenterId, WorkCenter>()
  const workCenterRow = new Map<WorkCenterId, number>()
  const workCenterOrder: WorkCenterId[] = []
  const workCentersByPlant = new Map<PlantId, WorkCenter[]>()
  const workCentersByClass = new Map<MachineClassId, WorkCenter[]>()
  const workCenterFeatures = new Map<WorkCenterId, Set<FeatureId>>()
  for (const wc of snap.workCenters) {
    // Snapshot order is grid order. Anything that renumbers work centers must
    // rebuild the indexes, which is why moves run before this and never after.
    workCenterRow.set(wc.id, workCenterOrder.length)
    workCenterOrder.push(wc.id)
    workCenterById.set(wc.id, wc)
    push(workCentersByPlant, wc.plantId, wc)
    push(workCentersByClass, wc.classId, wc)
    workCenterFeatures.set(wc.id, new Set(wc.features))
  }

  const materialById = new Map<MaterialId, Material>()
  const materialsByGroup = new Map<GroupId, MaterialId[]>()
  const materialsByFamily = new Map<FamilyId, MaterialId[]>()
  for (const material of snap.materials) {
    materialById.set(material.id, material)
    push(materialsByGroup, material.groupId, material.id)
    push(materialsByFamily, material.familyId, material.id)
  }

  const groupById = new Map<GroupId, ProductGroup>()
  for (const group of snap.groups) groupById.set(group.id, group)
  const familyById = new Map<FamilyId, ProductFamily>()
  for (const family of snap.families) familyById.set(family.id, family)
  const classById = new Map<MachineClassId, MachineClass>()
  for (const machineClass of snap.machineClasses) classById.set(machineClass.id, machineClass)
  const featureById = new Map<FeatureId, Feature>()
  for (const feature of snap.features) featureById.set(feature.id, feature)
  const stdOpById = new Map<OperationId, StandardOperation>()
  for (const op of snap.standardOperations) stdOpById.set(op.id, op)

  const routingsByMaterialPlant = new Map<string, Routing[]>()
  const primaryRouting = new Map<string, Routing>()
  const approvedByOp = new Map<OperationId, Set<WorkCenterId>>()
  for (const routing of snap.routings) {
    const k = key(routing.materialId, routing.plantId)
    push(routingsByMaterialPlant, k, routing)
    // Exactly one primary per pair is the contract; if master data disagrees,
    // the first one wins so the run stays deterministic rather than refusing.
    if (routing.primary && !primaryRouting.has(k)) primaryRouting.set(k, routing)
    for (const op of routing.operations) {
      const set = approvedByOp.get(op.opId)
      if (set) set.add(op.workCenterId)
      else approvedByOp.set(op.opId, new Set([op.workCenterId]))
    }
  }
  // A pair with versions but no primary flag still needs a default, or planning
  // would silently produce nothing for that material at that plant.
  for (const [k, routings] of routingsByMaterialPlant) {
    if (!primaryRouting.has(k)) {
      const first = routings[0]
      if (first) primaryRouting.set(k, first)
    }
  }

  const approvedWorkCentersByOp = new Map<OperationId, WorkCenterId[]>()
  for (const [opId, set] of approvedByOp) approvedWorkCentersByOp.set(opId, Array.from(set))

  const rateOverrideByKey = new Map<string, RateOverride>()
  for (const override of snap.rateOverrides) {
    // Later entries win: a scenario appends its `rateSet` moves to the tail.
    rateOverrideByKey.set(
      key(override.materialId, override.workCenterId, override.opId),
      override,
    )
  }

  const downtimeByWorkCenter = new Map<WorkCenterId, DowntimeEvent[]>()
  for (const event of snap.downtime) push(downtimeByWorkCenter, event.workCenterId, event)

  const supplyRow = new Map<string, number>()
  for (let r = 0; r < snap.supplyPlan.rowKeys.length; r += 1) {
    const rowKey = snap.supplyPlan.rowKeys[r]
    if (rowKey !== undefined) supplyRow.set(rowKey, r)
  }
  const demandRow = new Map<string, number>()
  for (let r = 0; r < snap.demandPlan.rowKeys.length; r += 1) {
    const rowKey = snap.demandPlan.rowKeys[r]
    if (rowKey !== undefined) demandRow.set(rowKey, r)
  }

  return {
    plantById,
    plantOrder,
    workCenterById,
    workCenterRow,
    workCenterOrder,
    workCentersByPlant,
    workCentersByClass,
    materialById,
    materialsByGroup,
    materialsByFamily,
    groupById,
    familyById,
    classById,
    featureById,
    stdOpById,
    routingsByMaterialPlant,
    primaryRouting,
    approvedWorkCentersByOp,
    workCenterFeatures,
    rateOverrideByKey,
    downtimeByWorkCenter,
    supplyRow,
    demandRow,
    // The time grid is the horizon of record; the plan matrices must agree with
    // it, and if they do not, the loader is the layer that should have said so.
    weekCount: snap.time.weeks.length,
  }
}
