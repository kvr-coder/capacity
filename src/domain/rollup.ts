/**
 * Aggregation: any `RollupLevel` x any bucket, over a filtered slice.
 *
 * Three rules this file exists to enforce.
 *
 * 1. **Filters narrow first, then we aggregate.** An empty filter array means
 *    ALL, never none — a fresh cockpit shows the network, not an empty screen.
 *
 * 2. **Utilisation is recomputed, never averaged.** Hours and units sum; a
 *    ratio does not. A 10h/100h week and a 90h/100h week is 100h/200h = 50%,
 *    and the mean of 10% and 90% is also 50% — which is why the naive version
 *    survives so long. Give the two weeks different capacities (10h/10h and
 *    10h/990h) and averaging says 55% where the truth is 2%. Every cell here
 *    divides a summed numerator by a summed denominator, and a test pins
 *    exactly that case.
 *
 * 3. **Available hours are the hours the plan is allowed to use** — after
 *    downtime and after the utilisation ceiling — so `utilisation` is always
 *    literally `requiredHours / availableHours` on the returned cell. Reporting
 *    raw hours in one field and a ceiling-relative ratio in another would make
 *    the two disagree on screen.
 *
 * ---------------------------------------------------------------------------
 * Two pools, one number
 * ---------------------------------------------------------------------------
 * A `RollupCell` carries one required/available/utilisation triple, but a work
 * center has two independent pools and either can bind. Each cell therefore
 * accumulates both pools and then reports **the binding one** — the pool with
 * the higher summed ratio. That keeps `utilisation === required / available`
 * true and keeps the number a planner reads as "how close is this to the wall".
 * Cost always uses BOTH pools, because both are paid for.
 *
 * ---------------------------------------------------------------------------
 * Products do not own capacity
 * ---------------------------------------------------------------------------
 * At asset levels (`global`, `region`, `plant`, `workCenter`, `machineClass`)
 * `availableHours` is the asset's full planable hours: filtering to one product
 * group does not shrink the factory, and utilisation then reads as "how much of
 * this asset that slice consumes".
 *
 * At product levels (`family`, `group`, `material`) available hours are
 * **allocated** pro-rata by the machine-hour share the entity holds in each
 * work-center week. Summing a work center's hours into every group that touches
 * it would count the same machine several times over; the allocation makes the
 * group totals add back up to the network total. `material` goes one step
 * further and splits its group's measured hours by unit share, because per-SKU
 * hours are never materialised — that is the whole reason the engine stays
 * under its time budget.
 */

import type {
  CapacityPool,
  Filters,
  GroupId,
  Kpis,
  MaterialId,
  PlantId,
  Region,
  RollupCell,
  RollupLevel,
  Snapshot,
  WeekIndex,
  WorkCenterId,
  WorkCenterWeekLoad,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import type { LoadOutput } from '@/domain/load'
import { bucketKeys, weeksInBucket } from '@/domain/time'
import { at, safeDiv } from '@/domain/lookup'

/** Below this a work-center week is a repurposing opportunity, not a machine. */
export const UNDERLOADED_BELOW = 0.4

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

// ---------------------------------------------------------------------------
// Filter context
// ---------------------------------------------------------------------------

/**
 * Everything a filtered pass needs, resolved once.
 *
 * Built by `buildFilterContext` and shared by `rollup`, `summarise` and
 * `relief.ts`, so "what does this filter mean" is answered in exactly one place.
 */
export interface FilterContext {
  /** Inclusive week window, clamped to the horizon. */
  fromWeek: WeekIndex
  toWeek: WeekIndex
  weekCount: number
  workCenterIds: WorkCenterId[]
  /** 1 = this work-center row survives the filter. */
  workCenterPass: Uint8Array
  /** Utilisation ceiling actually applied to each work-center row. */
  ceilingByRow: Float64Array
  /** `row * weekCount + week` -> the judged cell, for the counts and the peak. */
  cellByRowWeek: Array<WorkCenterWeekLoad | undefined>
  /** null = every product group passes. */
  groupPass: Set<GroupId> | null
  /** null = every plant passes. */
  plantPass: Set<PlantId> | null
  regionPass: Set<Region>
  /** True when a family/group filter narrows the material set. */
  productFiltered: boolean
  /**
   * Fraction of each work-center week's machine hours belonging to the filtered
   * product slice. `null` when nothing narrows it (the fraction is 1 and the
   * multiply is skipped entirely on the hot path).
   */
  selectedShare: Float64Array | null
  supplyRowPass: Uint8Array
  supplyRowMaterial: MaterialId[]
  supplyRowPlant: PlantId[]
  demandRowPass: Uint8Array
  demandRowMaterial: MaterialId[]
  /** USD per machine hour, per work-center row. */
  machineRateUsd: Float64Array
  /** USD per labour hour, per work-center row, converted from plant local currency. */
  labourRateUsd: Float64Array
  co2PerMachineHourKg: Float64Array
}

function intersect<T>(a: Set<T> | null, b: Set<T>): Set<T> {
  if (a === null) return b
  const out = new Set<T>()
  for (const value of a) if (b.has(value)) out.add(value)
  return out
}

export function buildFilterContext(
  snap: Snapshot,
  idx: SnapshotIndexes,
  load: LoadOutput,
  filters: Filters,
): FilterContext {
  const weekCount = idx.weekCount
  const workCenterIds = idx.workCenterOrder
  const wcCount = workCenterIds.length

  const lastWeek = Math.max(0, weekCount - 1)
  const fromWeek = Math.min(Math.max(0, Math.floor(filters.fromWeek)), lastWeek)
  const toWeek = Math.min(Math.max(0, Math.floor(filters.toWeek)), lastWeek)

  // ---- which plants and regions survive ------------------------------------
  let plantPass: Set<PlantId> | null =
    filters.plantIds.length > 0 ? new Set(filters.plantIds) : null
  if (filters.regions.length > 0) {
    const wanted = new Set<Region>(filters.regions)
    const inRegion = new Set<PlantId>()
    for (const plant of snap.plants) if (wanted.has(plant.region)) inRegion.add(plant.id)
    plantPass = intersect(plantPass, inRegion)
  }
  const regionPass = new Set<Region>()
  if (filters.regions.length > 0) {
    for (const region of filters.regions) regionPass.add(region)
  } else {
    for (const plant of snap.plants) {
      if (plantPass === null || plantPass.has(plant.id)) regionPass.add(plant.region)
    }
  }

  // ---- which product groups survive ----------------------------------------
  let groupPass: Set<GroupId> | null = filters.groupIds.length > 0 ? new Set(filters.groupIds) : null
  if (filters.familyIds.length > 0) {
    const families = new Set(filters.familyIds)
    const inFamily = new Set<GroupId>()
    for (const group of snap.groups) if (families.has(group.familyId)) inFamily.add(group.id)
    groupPass = intersect(groupPass, inFamily)
  }
  const productFiltered = groupPass !== null

  // ---- which work centers survive ------------------------------------------
  const wantedWorkCenters = filters.workCenterIds.length > 0 ? new Set(filters.workCenterIds) : null
  const wantedClasses = filters.machineClassIds.length > 0 ? new Set(filters.machineClassIds) : null
  const workCenterPass = new Uint8Array(wcCount)
  const ceilingByRow = new Float64Array(wcCount).fill(1)
  const machineRateUsd = new Float64Array(wcCount)
  const labourRateUsd = new Float64Array(wcCount)
  const co2PerMachineHourKg = new Float64Array(wcCount)

  for (let row = 0; row < wcCount; row += 1) {
    const wcId = at(workCenterIds, row, 'work center')
    const wc = idx.workCenterById.get(wcId)
    if (wc === undefined) continue
    if (wantedWorkCenters !== null && !wantedWorkCenters.has(wcId)) continue
    if (wantedClasses !== null && !wantedClasses.has(wc.classId)) continue
    if (plantPass !== null && !plantPass.has(wc.plantId)) continue
    workCenterPass[row] = 1

    machineRateUsd[row] = Number.isFinite(wc.costRateUsdPerHour) ? wc.costRateUsdPerHour : 0
    co2PerMachineHourKg[row] = Number.isFinite(wc.co2PerMachineHourKg) ? wc.co2PerMachineHourKg : 0
    const plant = idx.plantById.get(wc.plantId)
    if (plant !== undefined) {
      // Money is USD past the plant boundary; `fxPerUsd` is local units per USD.
      const fx = Number.isFinite(plant.fxPerUsd) && plant.fxPerUsd > 0 ? plant.fxPerUsd : 1
      labourRateUsd[row] = plant.labourCostPerHourLocal / fx
    }
  }

  // ---- the judged cells, addressable by row and week -----------------------
  const cellByRowWeek = new Array<WorkCenterWeekLoad | undefined>(wcCount * weekCount)
  for (const cell of load.cells) {
    const row = idx.workCenterRow.get(cell.workCenterId)
    if (row === undefined) continue
    if (cell.week < 0 || cell.week >= weekCount) continue
    cellByRowWeek[row * weekCount + cell.week] = cell
    ceilingByRow[row] = Number.isFinite(cell.ceiling) && cell.ceiling > 0 ? cell.ceiling : 1
  }

  // ---- the product slice's share of each work-center week ------------------
  let selectedShare: Float64Array | null = null
  if (groupPass !== null) {
    const selected = new Float64Array(wcCount * weekCount)
    for (const [composite, hours] of load.hoursByGroup) {
      const separator = composite.indexOf('|')
      if (separator < 0) continue
      const groupId = composite.slice(separator + 1)
      if (!groupPass.has(groupId)) continue
      const row = idx.workCenterRow.get(composite.slice(0, separator))
      if (row === undefined) continue
      const base = row * weekCount
      for (let w = 0; w < weekCount; w += 1) selected[base + w] = f64(selected, base + w) + f64(hours, w)
    }
    const machineRequired = load.grids.machine.requiredHours
    selectedShare = new Float64Array(wcCount * weekCount)
    for (let i = 0; i < selectedShare.length; i += 1) {
      const total = f64(machineRequired, i)
      selectedShare[i] = total > 0 ? f64(selected, i) / total : 0
    }
  }

  // ---- plan rows -----------------------------------------------------------
  const supplyKeys = snap.supplyPlan.rowKeys
  const supplyRowPass = new Uint8Array(supplyKeys.length)
  const supplyRowMaterial = new Array<MaterialId>(supplyKeys.length)
  const supplyRowPlant = new Array<PlantId>(supplyKeys.length)
  for (let r = 0; r < supplyKeys.length; r += 1) {
    const rowKey = supplyKeys[r]
    if (rowKey === undefined) {
      supplyRowMaterial[r] = ''
      supplyRowPlant[r] = ''
      continue
    }
    const separator = rowKey.indexOf('|')
    const materialId = separator < 0 ? rowKey : rowKey.slice(0, separator)
    const plantId = separator < 0 ? '' : rowKey.slice(separator + 1)
    supplyRowMaterial[r] = materialId
    supplyRowPlant[r] = plantId
    if (plantPass !== null && !plantPass.has(plantId)) continue
    if (groupPass !== null) {
      const material = idx.materialById.get(materialId)
      if (material === undefined || !groupPass.has(material.groupId)) continue
    }
    supplyRowPass[r] = 1
  }

  const demandKeys = snap.demandPlan.rowKeys
  const demandRowPass = new Uint8Array(demandKeys.length)
  const demandRowMaterial = new Array<MaterialId>(demandKeys.length)
  for (let r = 0; r < demandKeys.length; r += 1) {
    const rowKey = demandKeys[r]
    if (rowKey === undefined) {
      demandRowMaterial[r] = ''
      continue
    }
    const separator = rowKey.indexOf('|')
    const materialId = separator < 0 ? rowKey : rowKey.slice(0, separator)
    const region = separator < 0 ? '' : rowKey.slice(separator + 1)
    demandRowMaterial[r] = materialId
    if (!regionPass.has(region as Region)) continue
    if (groupPass !== null) {
      const material = idx.materialById.get(materialId)
      if (material === undefined || !groupPass.has(material.groupId)) continue
    }
    demandRowPass[r] = 1
  }

  return {
    fromWeek,
    toWeek,
    weekCount,
    workCenterIds,
    workCenterPass,
    ceilingByRow,
    cellByRowWeek,
    groupPass,
    plantPass,
    regionPass,
    productFiltered,
    selectedShare,
    supplyRowPass,
    supplyRowMaterial,
    supplyRowPlant,
    demandRowPass,
    demandRowMaterial,
    machineRateUsd,
    labourRateUsd,
    co2PerMachineHourKg,
  }
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

interface BucketAxis {
  /** `bucketOfWeek[w]` = bucket ordinal, or -1 when the week is outside the window. */
  bucketOfWeek: Int32Array
  /** Grid week that names each bucket — its first week inside the window. */
  weekOfBucket: WeekIndex[]
  count: number
}

function buildBucketAxis(snap: Snapshot, ctx: FilterContext, bucket: Filters['bucket']): BucketAxis {
  const keys = bucketKeys(snap.time, bucket)
  const members = weeksInBucket(snap.time, bucket)
  const bucketOfWeek = new Int32Array(ctx.weekCount).fill(-1)
  const weekOfBucket: WeekIndex[] = []
  let ordinal = 0
  for (let b = 0; b < keys.length; b += 1) {
    const weeks = members[b]
    if (weeks === undefined) continue
    let first = -1
    for (const w of weeks) {
      if (w < ctx.fromWeek || w > ctx.toWeek || w >= ctx.weekCount) continue
      if (first < 0) first = w
      bucketOfWeek[w] = ordinal
    }
    if (first < 0) continue
    weekOfBucket.push(first)
    ordinal += 1
  }
  return { bucketOfWeek, weekOfBucket, count: ordinal }
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

interface Acc {
  machineRequired: number
  machineAvailable: number
  machineOverload: number
  labourRequired: number
  labourAvailable: number
  labourOverload: number
  setupHours: number
  downtimeHours: number
  supplyUnits: number
  demandUnits: number
  shortfallUnits: number
  costUsd: number
  co2Kg: number
}

function newAcc(): Acc {
  return {
    machineRequired: 0,
    machineAvailable: 0,
    machineOverload: 0,
    labourRequired: 0,
    labourAvailable: 0,
    labourOverload: 0,
    setupHours: 0,
    downtimeHours: 0,
    supplyUnits: 0,
    demandUnits: 0,
    shortfallUnits: 0,
    costUsd: 0,
    co2Kg: 0,
  }
}

/** The binding pool is the one with the higher summed ratio, ties to machine. */
function bindingOf(acc: Acc): CapacityPool {
  const machine = safeDiv(acc.machineRequired, acc.machineAvailable)
  const labour = safeDiv(acc.labourRequired, acc.labourAvailable)
  if (labour > machine) return 'labour'
  if (machine > labour) return 'machine'
  return acc.labourRequired > acc.machineRequired ? 'labour' : 'machine'
}

function toCell(entityKey: string, label: string, week: WeekIndex, acc: Acc): RollupCell {
  const pool = bindingOf(acc)
  const requiredHours = pool === 'machine' ? acc.machineRequired : acc.labourRequired
  const availableHours = pool === 'machine' ? acc.machineAvailable : acc.labourAvailable
  const overloadHours = pool === 'machine' ? acc.machineOverload : acc.labourOverload
  return {
    key: entityKey,
    label,
    week,
    requiredHours,
    availableHours,
    // Recomputed from the sums. Never an average of per-week ratios.
    utilisation: safeDiv(requiredHours, availableHours),
    overloadHours,
    supplyUnits: acc.supplyUnits,
    demandUnits: acc.demandUnits,
    gapUnits: acc.demandUnits - acc.supplyUnits,
    shortfallUnits: acc.shortfallUnits,
    costUsd: acc.costUsd,
    co2Kg: acc.co2Kg,
  }
}

/** Insertion-ordered entity table, so output order is stable across runs. */
class Table {
  private readonly order: string[] = []
  private readonly labels = new Map<string, string>()
  private readonly rows = new Map<string, Map<number, Acc>>()

  cell(entityKey: string, label: string, bucket: number): Acc {
    let byBucket = this.rows.get(entityKey)
    if (byBucket === undefined) {
      byBucket = new Map<number, Acc>()
      this.rows.set(entityKey, byBucket)
      this.order.push(entityKey)
      this.labels.set(entityKey, label)
    }
    let acc = byBucket.get(bucket)
    if (acc === undefined) {
      acc = newAcc()
      byBucket.set(bucket, acc)
    }
    return acc
  }

  emit(weekOfBucket: WeekIndex[]): RollupCell[] {
    const cells: RollupCell[] = []
    for (const entityKey of this.order) {
      const byBucket = this.rows.get(entityKey)
      if (byBucket === undefined) continue
      const label = this.labels.get(entityKey) ?? entityKey
      const buckets = [...byBucket.keys()].sort((a, b) => a - b)
      for (const bucket of buckets) {
        const acc = byBucket.get(bucket)
        if (acc === undefined) continue
        cells.push(toCell(entityKey, label, weekOfBucket[bucket] ?? 0, acc))
      }
    }
    return cells
  }

  /** Per-entity totals across all buckets, for the material split. */
  entries(): Array<{ entityKey: string; byBucket: Map<number, Acc> }> {
    const out: Array<{ entityKey: string; byBucket: Map<number, Acc> }> = []
    for (const entityKey of this.order) {
      const byBucket = this.rows.get(entityKey)
      if (byBucket !== undefined) out.push({ entityKey, byBucket })
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// rollup
// ---------------------------------------------------------------------------

export interface RollupArgs {
  snap: Snapshot
  idx: SnapshotIndexes
  load: LoadOutput
  filters: Filters
  level: RollupLevel
  /**
   * Restrict to one parent. `workCenter` and `machineClass` take a plant id,
   * `plant` takes a region, `group` takes a family id, `material` takes a group
   * id. Ignored at `global`, `region` and `family`.
   */
  parentKey?: string
}

const ASSET_LEVELS: ReadonlySet<RollupLevel> = new Set<RollupLevel>([
  'global',
  'region',
  'plant',
  'workCenter',
  'machineClass',
])

export function rollup(args: RollupArgs): { cells: RollupCell[]; kpis: Kpis } {
  const { snap, idx, load, filters, level } = args
  // One filter context for both halves of the answer. Building it walks every
  // plan row, which at 15,000 SKUs is the most expensive thing in this file.
  const ctx = buildFilterContext(snap, idx, load, filters)
  const axis = buildBucketAxis(snap, ctx, filters.bucket)
  const kpis = kpiPass(load, snap, 0, ctx).total

  const cells = ASSET_LEVELS.has(level)
    ? rollupAssets(snap, idx, load, ctx, axis, level, args.parentKey)
    : rollupProducts(snap, idx, load, ctx, axis, level, args.parentKey)

  return { cells, kpis }
}

function rollupAssets(
  snap: Snapshot,
  idx: SnapshotIndexes,
  load: LoadOutput,
  ctx: FilterContext,
  axis: BucketAxis,
  level: RollupLevel,
  parentKey: string | undefined,
): RollupCell[] {
  const table = new Table()
  const weeks = ctx.weekCount
  const machine = load.grids.machine
  const labour = load.grids.labour

  for (let row = 0; row < ctx.workCenterPass.length; row += 1) {
    if (ctx.workCenterPass[row] !== 1) continue
    const wcId = at(ctx.workCenterIds, row, 'work center')
    const wc = idx.workCenterById.get(wcId)
    if (wc === undefined) continue
    const plant = idx.plantById.get(wc.plantId)

    let entityKey: string
    let label: string
    switch (level) {
      case 'region':
        entityKey = plant?.region ?? 'unknown'
        label = entityKey
        if (parentKey !== undefined && parentKey !== entityKey) continue
        break
      case 'plant':
        entityKey = wc.plantId
        label = plant?.name ?? wc.plantId
        if (parentKey !== undefined && plant?.region !== parentKey) continue
        break
      case 'workCenter':
        entityKey = wcId
        label = wc.code.length > 0 ? wc.code : wc.name
        if (parentKey !== undefined && wc.plantId !== parentKey) continue
        break
      case 'machineClass':
        entityKey = wc.classId
        label = idx.classById.get(wc.classId)?.name ?? wc.classId
        if (parentKey !== undefined && wc.plantId !== parentKey) continue
        break
      default:
        entityKey = 'global'
        label = 'Network'
        break
    }

    const ceiling = ctx.ceilingByRow[row] ?? 1
    const machineRate = ctx.machineRateUsd[row] ?? 0
    const labourRate = ctx.labourRateUsd[row] ?? 0
    const co2Rate = ctx.co2PerMachineHourKg[row] ?? 0
    const base = row * weeks

    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const bucket = axis.bucketOfWeek[w] ?? -1
      if (bucket < 0) continue
      const i = base + w
      const share = ctx.selectedShare === null ? 1 : f64(ctx.selectedShare, i)
      const acc = table.cell(entityKey, label, bucket)

      const machineRequired = f64(machine.requiredHours, i) * share
      const labourRequired = f64(labour.requiredHours, i) * share
      acc.machineRequired += machineRequired
      acc.labourRequired += labourRequired
      // The asset keeps all its hours no matter which product you are looking at.
      acc.machineAvailable += f64(machine.availableHours, i) * ceiling
      acc.labourAvailable += f64(labour.availableHours, i) * ceiling
      acc.machineOverload += f64(machine.overloadHours, i) * share
      acc.labourOverload += f64(labour.overloadHours, i) * share
      acc.setupHours += f64(machine.setupHours, i) * share
      acc.downtimeHours += f64(machine.downtimeHours, i) + f64(labour.downtimeHours, i)
      acc.costUsd += machineRequired * machineRate + labourRequired * labourRate
      acc.co2Kg += machineRequired * co2Rate
      const cell = ctx.cellByRowWeek[i]
      if (cell !== undefined) acc.shortfallUnits += cell.shortfallUnits * share
    }
  }

  // Units are a plan concept keyed by plant, so they only attach to levels that
  // have a plant. The same unit crosses several work centers on its routing;
  // summing units by work center would count it once per operation.
  if (level === 'global' || level === 'region' || level === 'plant') {
    addPlanUnits(snap, idx, load, ctx, axis, table, level, parentKey)
  }

  return table.emit(axis.weekOfBucket)
}

function addPlanUnits(
  snap: Snapshot,
  idx: SnapshotIndexes,
  load: LoadOutput,
  ctx: FilterContext,
  axis: BucketAxis,
  table: Table,
  level: RollupLevel,
  parentKey: string | undefined,
): void {
  const weeks = ctx.weekCount

  for (let r = 0; r < ctx.supplyRowPass.length; r += 1) {
    if (ctx.supplyRowPass[r] !== 1) continue
    const plantId = at(ctx.supplyRowPlant, r, 'supply row plant')
    const plant = idx.plantById.get(plantId)
    let entityKey: string
    let label: string
    if (level === 'plant') {
      entityKey = plantId
      label = plant?.name ?? plantId
      if (parentKey !== undefined && plant?.region !== parentKey) continue
    } else if (level === 'region') {
      entityKey = plant?.region ?? 'unknown'
      label = entityKey
      if (parentKey !== undefined && parentKey !== entityKey) continue
    } else {
      entityKey = 'global'
      label = 'Network'
    }
    const base = r * weeks
    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const bucket = axis.bucketOfWeek[w] ?? -1
      if (bucket < 0) continue
      const units = f64(load.unitsByRow, base + w)
      if (units === 0) continue
      table.cell(entityKey, label, bucket).supplyUnits += units
    }
  }

  const demand = snap.demandPlan
  for (let r = 0; r < ctx.demandRowPass.length; r += 1) {
    if (ctx.demandRowPass[r] !== 1) continue
    const rowKey = at(snap.demandPlan.rowKeys, r, 'demand row key')
    const separator = rowKey.indexOf('|')
    const region = separator < 0 ? '' : rowKey.slice(separator + 1)
    let entityKey: string
    let label: string
    if (level === 'region') {
      entityKey = region
      label = region
      if (parentKey !== undefined && parentKey !== entityKey) continue
    } else if (level === 'plant') {
      // Demand is regional and a region is served by several plants; there is no
      // honest way to split it per plant, so it is not claimed at plant level.
      continue
    } else {
      entityKey = 'global'
      label = 'Network'
    }
    const base = r * demand.weekCount
    for (let w = ctx.fromWeek; w <= ctx.toWeek && w < demand.weekCount; w += 1) {
      const bucket = axis.bucketOfWeek[w] ?? -1
      if (bucket < 0) continue
      const units = f64(demand.values, base + w)
      if (units === 0) continue
      table.cell(entityKey, label, bucket).demandUnits += units
    }
  }
}

function rollupProducts(
  snap: Snapshot,
  idx: SnapshotIndexes,
  load: LoadOutput,
  ctx: FilterContext,
  axis: BucketAxis,
  level: RollupLevel,
  parentKey: string | undefined,
): RollupCell[] {
  const weeks = ctx.weekCount
  const machine = load.grids.machine
  const labour = load.grids.labour

  // Stage 1: measured hours per (group, bucket), allocated out of each work
  // center by the group's machine-hour share of that work-center week.
  const groupTable = new Table()

  for (const [composite, groupHours] of load.hoursByGroup) {
    const separator = composite.indexOf('|')
    if (separator < 0) continue
    const wcId = composite.slice(0, separator)
    const groupId = composite.slice(separator + 1)
    if (ctx.groupPass !== null && !ctx.groupPass.has(groupId)) continue
    const row = idx.workCenterRow.get(wcId)
    if (row === undefined || ctx.workCenterPass[row] !== 1) continue

    const group = idx.groupById.get(groupId)
    if (level === 'group' && parentKey !== undefined && group?.familyId !== parentKey) continue
    if (level === 'material' && parentKey !== undefined && groupId !== parentKey) continue

    const ceiling = ctx.ceilingByRow[row] ?? 1
    const machineRate = ctx.machineRateUsd[row] ?? 0
    const labourRate = ctx.labourRateUsd[row] ?? 0
    const co2Rate = ctx.co2PerMachineHourKg[row] ?? 0
    const base = row * weeks

    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const bucket = axis.bucketOfWeek[w] ?? -1
      if (bucket < 0) continue
      const hours = f64(groupHours, w)
      if (hours <= 0) continue
      const i = base + w
      const total = f64(machine.requiredHours, i)
      if (total <= 0) continue
      const frac = hours / total

      const acc = groupTable.cell(groupId, group?.name ?? groupId, bucket)
      const labourRequired = f64(labour.requiredHours, i) * frac
      acc.machineRequired += hours
      acc.labourRequired += labourRequired
      // Allocated, not summed: a work center's hours belong to every group that
      // uses it in proportion, or the network total stops adding up.
      acc.machineAvailable += f64(machine.availableHours, i) * ceiling * frac
      acc.labourAvailable += f64(labour.availableHours, i) * ceiling * frac
      acc.machineOverload += f64(machine.overloadHours, i) * frac
      acc.labourOverload += f64(labour.overloadHours, i) * frac
      acc.setupHours += f64(machine.setupHours, i) * frac
      acc.downtimeHours += (f64(machine.downtimeHours, i) + f64(labour.downtimeHours, i)) * frac
      acc.costUsd += hours * machineRate + labourRequired * labourRate
      acc.co2Kg += hours * co2Rate
      const cell = ctx.cellByRowWeek[i]
      if (cell !== undefined) acc.shortfallUnits += cell.shortfallUnits * frac
    }
  }

  // ---- units --------------------------------------------------------------
  // Buckets are contiguous in week order, so one accumulator lookup per
  // (row, bucket) is the minimum possible. At 15,000 rows x 78 weeks that is
  // the difference between a map operation per cell and one per bucket.
  const demand = snap.demandPlan

  if (level === 'group' || level === 'family') {
    const table = level === 'group' ? groupTable : new Table()
    if (level === 'family') {
      for (const { entityKey, byBucket } of groupTable.entries()) {
        const group = idx.groupById.get(entityKey)
        const familyId = group?.familyId ?? 'unknown'
        const label = idx.familyById.get(familyId)?.name ?? familyId
        for (const [bucket, acc] of byBucket) mergeInto(table.cell(familyId, label, bucket), acc)
      }
    }

    // Units follow the material's own group/family, independent of where it ran.
    const entityOf = (
      materialId: MaterialId,
    ): { entityKey: string; label: string } | undefined => {
      const material = idx.materialById.get(materialId)
      if (material === undefined) return undefined
      if (level === 'group') {
        if (parentKey !== undefined && material.familyId !== parentKey) return undefined
        return {
          entityKey: material.groupId,
          label: idx.groupById.get(material.groupId)?.name ?? material.groupId,
        }
      }
      return {
        entityKey: material.familyId,
        label: idx.familyById.get(material.familyId)?.name ?? material.familyId,
      }
    }

    for (let r = 0; r < ctx.supplyRowPass.length; r += 1) {
      if (ctx.supplyRowPass[r] !== 1) continue
      const entity = entityOf(at(ctx.supplyRowMaterial, r, 'supply row material'))
      if (entity === undefined) continue
      const base = r * weeks
      let currentBucket = -1
      let acc: Acc | undefined
      for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
        const bucket = axis.bucketOfWeek[w] ?? -1
        if (bucket < 0) continue
        const units = f64(load.unitsByRow, base + w)
        if (units === 0) continue
        if (bucket !== currentBucket) {
          currentBucket = bucket
          acc = table.cell(entity.entityKey, entity.label, bucket)
        }
        if (acc !== undefined) acc.supplyUnits += units
      }
    }

    for (let r = 0; r < ctx.demandRowPass.length; r += 1) {
      if (ctx.demandRowPass[r] !== 1) continue
      const entity = entityOf(at(ctx.demandRowMaterial, r, 'demand row material'))
      if (entity === undefined) continue
      const base = r * demand.weekCount
      let currentBucket = -1
      let acc: Acc | undefined
      for (let w = ctx.fromWeek; w <= ctx.toWeek && w < demand.weekCount; w += 1) {
        const bucket = axis.bucketOfWeek[w] ?? -1
        if (bucket < 0) continue
        const units = f64(demand.values, base + w)
        if (units === 0) continue
        if (bucket !== currentBucket) {
          currentBucket = bucket
          acc = table.cell(entity.entityKey, entity.label, bucket)
        }
        if (acc !== undefined) acc.demandUnits += units
      }
    }

    return table.emit(axis.weekOfBucket)
  }

  // ---- level === 'material' ------------------------------------------------
  // Per-SKU hours are never materialised — that is what keeps the load
  // explosion inside its time budget — so a material's hours are its group's
  // measured hours, split by its share of the group's units in that bucket.
  //
  // Only this level pays for the per-material unit table, and only for the
  // materials the filter (and `parentKey`) left standing.
  const table = new Table()
  const unitsByMaterialBucket = new Map<MaterialId, Map<number, number>>()
  const materialsOfGroup = new Map<GroupId, MaterialId[]>()
  const groupUnits = new Map<string, number>()

  for (let r = 0; r < ctx.supplyRowPass.length; r += 1) {
    if (ctx.supplyRowPass[r] !== 1) continue
    const materialId = at(ctx.supplyRowMaterial, r, 'supply row material')
    const material = idx.materialById.get(materialId)
    if (material === undefined) continue
    if (parentKey !== undefined && material.groupId !== parentKey) continue
    const base = r * weeks
    let byBucket = unitsByMaterialBucket.get(materialId)
    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const bucket = axis.bucketOfWeek[w] ?? -1
      if (bucket < 0) continue
      const units = f64(load.unitsByRow, base + w)
      if (units === 0) continue
      if (byBucket === undefined) {
        byBucket = new Map<number, number>()
        unitsByMaterialBucket.set(materialId, byBucket)
        const list = materialsOfGroup.get(material.groupId)
        if (list) list.push(materialId)
        else materialsOfGroup.set(material.groupId, [materialId])
      }
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + units)
      const k = `${material.groupId}|${bucket}`
      groupUnits.set(k, (groupUnits.get(k) ?? 0) + units)
      table.cell(materialId, material.code, bucket).supplyUnits += units
    }
  }

  for (const { entityKey: groupId, byBucket } of groupTable.entries()) {
    const materials = materialsOfGroup.get(groupId) ?? []
    for (const [bucket, acc] of byBucket) {
      const total = groupUnits.get(`${groupId}|${bucket}`) ?? 0
      if (total <= 0) continue
      for (const materialId of materials) {
        const units = unitsByMaterialBucket.get(materialId)?.get(bucket) ?? 0
        if (units <= 0) continue
        const label = idx.materialById.get(materialId)?.code ?? materialId
        scaleInto(table.cell(materialId, label, bucket), acc, units / total)
      }
    }
  }

  for (let r = 0; r < ctx.demandRowPass.length; r += 1) {
    if (ctx.demandRowPass[r] !== 1) continue
    const materialId = at(ctx.demandRowMaterial, r, 'demand row material')
    const material = idx.materialById.get(materialId)
    if (material === undefined) continue
    if (parentKey !== undefined && material.groupId !== parentKey) continue
    const base = r * demand.weekCount
    let currentBucket = -1
    let acc: Acc | undefined
    for (let w = ctx.fromWeek; w <= ctx.toWeek && w < demand.weekCount; w += 1) {
      const bucket = axis.bucketOfWeek[w] ?? -1
      if (bucket < 0) continue
      const units = f64(demand.values, base + w)
      if (units === 0) continue
      if (bucket !== currentBucket) {
        currentBucket = bucket
        acc = table.cell(materialId, material.code, bucket)
      }
      if (acc !== undefined) acc.demandUnits += units
    }
  }

  return table.emit(axis.weekOfBucket)
}

function mergeInto(target: Acc, source: Acc): void {
  scaleInto(target, source, 1)
}

function scaleInto(target: Acc, source: Acc, factor: number): void {
  target.machineRequired += source.machineRequired * factor
  target.machineAvailable += source.machineAvailable * factor
  target.machineOverload += source.machineOverload * factor
  target.labourRequired += source.labourRequired * factor
  target.labourAvailable += source.labourAvailable * factor
  target.labourOverload += source.labourOverload * factor
  target.setupHours += source.setupHours * factor
  target.downtimeHours += source.downtimeHours * factor
  target.shortfallUnits += source.shortfallUnits * factor
  target.costUsd += source.costUsd * factor
  target.co2Kg += source.co2Kg * factor
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

interface KpiAcc extends Acc {
  peakUtilisation: number
  overloadedCells: number
  underloadedCells: number
  machineBoundCells: number
  labourBoundCells: number
}

function newKpiAcc(): KpiAcc {
  return {
    ...newAcc(),
    peakUtilisation: 0,
    overloadedCells: 0,
    underloadedCells: 0,
    machineBoundCells: 0,
    labourBoundCells: 0,
  }
}

function finishKpis(acc: KpiAcc, capexUsd: number): Kpis {
  const pool = bindingOf(acc)
  const requiredHours = pool === 'machine' ? acc.machineRequired : acc.labourRequired
  const availableHours = pool === 'machine' ? acc.machineAvailable : acc.labourAvailable
  const overloadHours = pool === 'machine' ? acc.machineOverload : acc.labourOverload
  return {
    utilisation: safeDiv(requiredHours, availableHours),
    peakUtilisation: acc.peakUtilisation,
    availableHours,
    requiredHours,
    overloadHours,
    setupHours: acc.setupHours,
    downtimeHours: acc.downtimeHours,
    supplyUnits: acc.supplyUnits,
    demandUnits: acc.demandUnits,
    planGapUnits: acc.demandUnits - acc.supplyUnits,
    shortfallUnits: acc.shortfallUnits,
    costUsd: acc.costUsd,
    co2Kg: acc.co2Kg,
    overloadedCells: acc.overloadedCells,
    underloadedCells: acc.underloadedCells,
    machineBoundCells: acc.machineBoundCells,
    labourBoundCells: acc.labourBoundCells,
    capexUsd,
  }
}

interface KpiPass {
  total: Kpis
  byWeek: Array<{ week: WeekIndex } & Kpis>
}

/**
 * One pass over the slice producing both the totals and the per-week series.
 *
 * The engine needs both and the units loop walks every supply row, so doing it
 * once and slicing is the difference between one pass over the plan and 78.
 *
 * Cell **counts** (overloaded, underloaded, machine/labour bound) and the peak
 * describe the ASSET and use the judged cell's own utilisation, unfiltered by
 * product: a machine is not less full because you are looking at one group.
 * Hour and unit **totals** describe the SLICE and are narrowed by every filter.
 */
function kpiPass(
  load: LoadOutput,
  snap: Snapshot,
  capexUsd: number,
  ctx: FilterContext,
): KpiPass {
  const weeks = ctx.weekCount
  const machine = load.grids.machine
  const labour = load.grids.labour

  const total = newKpiAcc()
  const perWeek = new Map<WeekIndex, KpiAcc>()
  const weekAcc = (w: WeekIndex): KpiAcc => {
    let acc = perWeek.get(w)
    if (acc === undefined) {
      acc = newKpiAcc()
      perWeek.set(w, acc)
    }
    return acc
  }
  for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) weekAcc(w)

  for (let row = 0; row < ctx.workCenterPass.length; row += 1) {
    if (ctx.workCenterPass[row] !== 1) continue
    const ceiling = ctx.ceilingByRow[row] ?? 1
    const machineRate = ctx.machineRateUsd[row] ?? 0
    const labourRate = ctx.labourRateUsd[row] ?? 0
    const co2Rate = ctx.co2PerMachineHourKg[row] ?? 0
    const base = row * weeks

    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const i = base + w
      const share = ctx.selectedShare === null ? 1 : f64(ctx.selectedShare, i)
      const week = weekAcc(w)

      const machineRequired = f64(machine.requiredHours, i) * share
      const labourRequired = f64(labour.requiredHours, i) * share
      const machineAvailable = f64(machine.availableHours, i) * ceiling
      const labourAvailable = f64(labour.availableHours, i) * ceiling
      const machineOverload = f64(machine.overloadHours, i) * share
      const labourOverload = f64(labour.overloadHours, i) * share
      const setup = f64(machine.setupHours, i) * share
      const downtime = f64(machine.downtimeHours, i) + f64(labour.downtimeHours, i)
      const cost = machineRequired * machineRate + labourRequired * labourRate
      const co2 = machineRequired * co2Rate

      for (const acc of [total, week]) {
        acc.machineRequired += machineRequired
        acc.labourRequired += labourRequired
        acc.machineAvailable += machineAvailable
        acc.labourAvailable += labourAvailable
        acc.machineOverload += machineOverload
        acc.labourOverload += labourOverload
        acc.setupHours += setup
        acc.downtimeHours += downtime
        acc.costUsd += cost
        acc.co2Kg += co2
      }

      const cell = ctx.cellByRowWeek[i]
      if (cell === undefined) continue
      const utilisation = cell.utilisation
      const hasCapacity = cell.machineAvailable > 0 || cell.labourAvailable > 0
      const hasLoad = cell.machineRequired > 0 || cell.labourRequired > 0
      for (const acc of [total, week]) {
        acc.shortfallUnits += cell.shortfallUnits * share
        if (utilisation > acc.peakUtilisation) acc.peakUtilisation = utilisation
        if (cell.overloadHours > 0) acc.overloadedCells += 1
        // An asset with no hours this week is not an opportunity, it is off.
        else if (hasCapacity && utilisation < UNDERLOADED_BELOW) acc.underloadedCells += 1
        if (hasLoad) {
          if (cell.bindingPool === 'machine') acc.machineBoundCells += 1
          else acc.labourBoundCells += 1
        }
      }
    }
  }

  // ---- units ---------------------------------------------------------------
  for (let r = 0; r < ctx.supplyRowPass.length; r += 1) {
    if (ctx.supplyRowPass[r] !== 1) continue
    const base = r * weeks
    for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
      const units = f64(load.unitsByRow, base + w)
      if (units === 0) continue
      total.supplyUnits += units
      weekAcc(w).supplyUnits += units
    }
  }
  const demand = snap.demandPlan
  for (let r = 0; r < ctx.demandRowPass.length; r += 1) {
    if (ctx.demandRowPass[r] !== 1) continue
    const base = r * demand.weekCount
    for (let w = ctx.fromWeek; w <= ctx.toWeek && w < demand.weekCount; w += 1) {
      const units = f64(demand.values, base + w)
      if (units === 0) continue
      total.demandUnits += units
      weekAcc(w).demandUnits += units
    }
  }

  const byWeek: Array<{ week: WeekIndex } & Kpis> = []
  for (let w = ctx.fromWeek; w <= ctx.toWeek; w += 1) {
    const acc = perWeek.get(w)
    if (acc === undefined) continue
    // Capex is a scenario total, not a weekly one: it is carried on the
    // aggregate KPI only, and reported as 0 on each week so a chart that sums
    // the series does not multiply it by 78.
    byWeek.push({ week: w, ...finishKpis(acc, 0) })
  }

  return { total: finishKpis(total, capexUsd), byWeek }
}

/**
 * KPIs over the filtered slice.
 *
 * `requiredHours` / `availableHours` report the **binding** pool, so
 * `utilisation === requiredHours / availableHours` holds. `costUsd` prices both
 * pools regardless, because both are paid for. `planGapUnits` is signed:
 * negative means the supply plan builds more than the demand plan asked for,
 * which is a real and interesting answer, not an error.
 */
export function summarise(
  load: LoadOutput,
  snap: Snapshot,
  idx: SnapshotIndexes,
  filters: Filters,
  capexUsd: number,
): Kpis {
  return summariseAll(load, snap, idx, filters, capexUsd).total
}

/** The same KPIs, one entry per week in the filtered window. */
export function summariseByWeek(
  load: LoadOutput,
  snap: Snapshot,
  idx: SnapshotIndexes,
  filters: Filters,
): Array<{ week: WeekIndex } & Kpis> {
  return summariseAll(load, snap, idx, filters, 0).byWeek
}

/**
 * Totals and the weekly series from ONE pass.
 *
 * The engine needs both on every run; calling `summarise` and `summariseByWeek`
 * separately walks all 15,000 supply rows and all 15,000 demand rows twice for
 * an answer that was already computed. Use this whenever both are wanted.
 */
export function summariseAll(
  load: LoadOutput,
  snap: Snapshot,
  idx: SnapshotIndexes,
  filters: Filters,
  capexUsd: number,
): { total: Kpis; byWeek: Array<{ week: WeekIndex } & Kpis> } {
  return kpiPass(load, snap, capexUsd, buildFilterContext(snap, idx, load, filters))
}
