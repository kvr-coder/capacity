/**
 * Domain contract for the capacity modeling cockpit.
 *
 * The physical model, in one paragraph:
 *
 *   A **SKU** is made by walking a **routing** — an ordered list of
 *   **operations**, each performed at one **work center**. A work center owns
 *   two independent **capacity pools**, machine and labour; an operation
 *   consumes hours from both, and either can be the binding constraint. What a
 *   work center is *allowed* to run comes from the **production version**
 *   allow-list, which is master-data truth. What it is *physically capable* of
 *   is computed separately from its **feature** set, and exists only so the
 *   tool can propose retrofits it was never told about. The **supply plan** is
 *   what loads capacity; the **demand plan** and **inventory** are reference,
 *   showing what the plan chose not to serve. **OEE** and **run rate** are two
 *   independent knobs that together give an effective rate, and OEE may follow
 *   a dated **glide path** rather than a constant.
 *
 * Two things this model deliberately refuses to blur:
 *
 *   - A **transfer** (the source changes between buckets) is not the same as
 *     **dual sourcing** (two sources in one bucket). Different approvals,
 *     different risk, different objects.
 *   - **Planned** downtime is a dated event you can argue with. **Unplanned**
 *     loss lives inside OEE and has no date, because giving it one would be a
 *     precise-looking lie.
 *
 * Sizing note: the default profile is 15,000 SKUs x 150 work centers x 78
 * weekly buckets. Master data is held as objects (tens of thousands of rows,
 * fine); anything that scales with SKU x week is columnar in typed arrays and
 * never crosses into React state. The UI receives aggregates only.
 *
 * `noUncheckedIndexedAccess` is on. Use the helpers in `./lookup`.
 */

// ---------------------------------------------------------------------------
// Identity & time
// ---------------------------------------------------------------------------

export type PlantId = string
export type WorkCenterId = string
export type MachineClassId = string
export type FeatureId = string
export type MaterialId = string
export type FamilyId = string
export type GroupId = string
export type OperationId = string
export type RoutingId = string
export type MoveId = string
export type ScenarioId = string

export type Region = 'NAM' | 'EUR' | 'APAC' | 'LATAM' | 'MEA'
export const REGIONS: readonly Region[] = ['NAM', 'EUR', 'APAC', 'LATAM', 'MEA'] as const

export type Currency = 'USD' | 'EUR' | 'MXN' | 'PLN' | 'CNY'

/** Position in the weekly grid. All hot-path time arithmetic uses this. */
export type WeekIndex = number

/**
 * The time grid. Weekly is the planning bucket; month and quarter are
 * roll-up views over the same weeks, never a separate model.
 */
export interface TimeGrid {
  /** ISO week labels, e.g. `2026-W36`. Length defines the horizon. */
  weeks: string[]
  /** ISO date (Monday) of each week, for calendars and shutdown alignment. */
  weekStart: string[]
  /** `YYYY-MM` of the month each week predominantly falls in. */
  monthOfWeek: string[]
  /** `YYYY-Qn` of the quarter each week falls in. */
  quarterOfWeek: string[]
  /** Distinct months in order — the monthly roll-up axis. */
  months: string[]
  /** Distinct quarters in order. */
  quarters: string[]
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export interface Plant {
  id: PlantId
  code: string
  name: string
  city: string
  country: string
  countryCode: string
  region: Region
  currency: Currency
  /** Local currency units per 1 USD. */
  fxPerUsd: number
  timezone: string
  /** For the globe view. */
  lat: number
  lon: number
  /** Permanent categorical slot 1..5. Colour follows the entity, forever. */
  colorSlot: 1 | 2 | 3 | 4 | 5
  /** Fully burdened labour cost per hour, local currency. */
  labourCostPerHourLocal: number
  /** Default OEE, the bottom of the cascade. */
  defaultOee: number
  /** kg CO2e per kWh equivalent — drives the footprint roll-up. */
  gridIntensity: number
}

// ---------------------------------------------------------------------------
// Capability: what a machine may do, and what it could do
// ---------------------------------------------------------------------------

export type FeatureGroup = 'process' | 'quality' | 'material' | 'handling' | 'compliance'

export interface Feature {
  id: FeatureId
  name: string
  group: FeatureGroup
  description: string
}

/** A retrofit turns a machine into a more capable one, for money and time. */
export interface RetrofitOption {
  id: string
  name: string
  addsFeatures: FeatureId[]
  capexUsd: number
  leadTimeWeeks: number
  /** Additive OEE effect once installed, e.g. +0.03. May be negative. */
  oeeDelta: number
  description: string
}

/**
 * Machines from the same supplier and generation share a class. Class is what
 * makes "which machine could we repurpose?" answerable — siblings are the
 * first place to look.
 */
export interface MachineClass {
  id: MachineClassId
  name: string
  supplier: string
  /** Higher generation = newer, more capable, usually higher base OEE. */
  generation: number
  baseFeatures: FeatureId[]
  retrofits: RetrofitOption[]
}

// ---------------------------------------------------------------------------
// Work centers & capacity pools
// ---------------------------------------------------------------------------

/**
 * Machine and labour are separate constraining pools. An operation consumes
 * both; whichever saturates first is the bottleneck, and the fix differs —
 * a machine constraint wants capex, a labour constraint wants hiring.
 */
export type CapacityPool = 'machine' | 'labour'
export const CAPACITY_POOLS: readonly CapacityPool[] = ['machine', 'labour'] as const

export interface PoolCapacity {
  pool: CapacityPool
  /** Individual capacities: machines in the group, or operators on shift. */
  count: number
  shiftsPerDay: number
  hoursPerShift: number
  daysPerWeek: number
  /** SAP-style capacity utilisation factor on the pool itself, 0..1.2. */
  utilisationFactor: number
}

export interface WorkCenter {
  id: WorkCenterId
  plantId: PlantId
  code: string
  name: string
  classId: MachineClassId
  /** Commissioning year — the "old machine vs new machine" axis. */
  vintage: number
  /** Exactly one entry per CapacityPool. */
  pools: PoolCapacity[]
  /** Granted features. Class base features plus anything already retrofitted. */
  features: FeatureId[]
  /** Bottom-but-one of the OEE cascade, above the plant default. */
  baseOee: number
  /**
   * `active` exists in master data. `proposed` was invented in the cockpit —
   * a machine that does not exist yet, seeded by copying a sibling's features.
   */
  status: 'active' | 'proposed'
  /** For proposed work centers: the work center whose features were copied. */
  clonedFromId?: WorkCenterId
  /** First week the work center can run. Undefined means "from week 0". */
  availableFromWeek?: WeekIndex
  /** Machine-hour cost rate, USD. Labour is priced from the plant. */
  costRateUsdPerHour: number
  co2PerMachineHourKg: number
}

// ---------------------------------------------------------------------------
// Materials & product hierarchy
// ---------------------------------------------------------------------------

/** FERT = finished, HALB = semi-finished (a declared WIP transfer point). */
export type MaterialType = 'FERT' | 'HALB' | 'ROH'

export interface ProductFamily {
  id: FamilyId
  code: string
  name: string
}

export interface ProductGroup {
  id: GroupId
  familyId: FamilyId
  code: string
  name: string
}

export interface Material {
  id: MaterialId
  code: string
  description: string
  type: MaterialType
  groupId: GroupId
  familyId: FamilyId
  baseUom: string
  /** Plants where this material may be produced (MARC). */
  plantIds: PlantId[]
  pricePerUnitUsd: number
  materialCostPerUnitUsd: number
  /**
   * The semi-finished material this one consumes, when the chain has a
   * declared transfer point. This — and only this — is where WIP may cross a
   * plant boundary in plan mode.
   */
  componentId?: MaterialId
  abcClass: 'A' | 'B' | 'C'
  /** Units per pallet / handling unit — drives WIP transfer freight. */
  unitsPerHandlingUnit: number
  weightKgPerUnit: number
}

// ---------------------------------------------------------------------------
// Routings
// ---------------------------------------------------------------------------

/**
 * A standard operation type (OP-MOLD-A, OP-PAINT-STD). Its feature
 * requirements are what the capability engine matches against.
 */
export interface StandardOperation {
  id: OperationId
  code: string
  name: string
  requiredFeatures: FeatureId[]
  /** Ordering hint for the routing generator and the canvas process lanes. */
  stage: number
}

export interface RoutingOperation {
  /** 10, 20, 30 — SAP operation sequence. */
  seq: number
  opId: OperationId
  workCenterId: WorkCenterId
  /** The quantity the times below refer to (SAP base quantity). */
  baseQty: number
  /** Charged once per production lot in a bucket, not per unit. */
  setupHours: number
  machineHoursPerBase: number
  labourHoursPerBase: number
  /** 0..1 good-parts yield at this operation. Scrap inflates upstream demand. */
  yield: number
}

/**
 * A routing for one material at one plant. Multiple routings per
 * (material, plant) are alternate production versions.
 */
export interface Routing {
  id: RoutingId
  materialId: MaterialId
  plantId: PlantId
  /** Production version key, e.g. `0001`. */
  version: string
  /** The version planning picks by default. Exactly one primary per pair. */
  primary: boolean
  operations: RoutingOperation[]
  /** Undefined = approved for the whole horizon. */
  validFromWeek?: WeekIndex
  validToWeek?: WeekIndex
}

// ---------------------------------------------------------------------------
// The two knobs: rate and OEE
// ---------------------------------------------------------------------------

/**
 * A SKU-specific rate that beats the routing operation's own times. This is
 * the third and highest step of rate resolution.
 */
export interface RateOverride {
  materialId: MaterialId
  workCenterId: WorkCenterId
  opId: OperationId
  /** Eaches per hour, replacing the value derived from the routing. */
  ratePerHour: number
  note?: string
}

/**
 * OEE resolves plant -> work center -> (material x work center), most specific
 * winning. Held separately from rate so moving one knob never disturbs the
 * other — a planner must always be able to see which one they changed.
 */
export interface OeeOverride {
  /** Exactly one of these three shapes. */
  scope: 'plant' | 'workCenter' | 'materialWorkCenter'
  plantId?: PlantId
  workCenterId?: WorkCenterId
  materialId?: MaterialId
  value: number
  fromWeek?: WeekIndex
  toWeek?: WeekIndex
  note?: string
}

/**
 * A dated OEE improvement plan. Real improvement programmes ramp; a step
 * change on the week the project closes is not what happens on a shop floor.
 */
export interface OeeGlidePath {
  id: string
  /** Applies to one work center, or every work center in a plant. */
  scope: 'plant' | 'workCenter'
  plantId?: PlantId
  workCenterId?: WorkCenterId
  fromWeek: WeekIndex
  toWeek: WeekIndex
  /** OEE at fromWeek. Undefined means "start from whatever resolves today". */
  startValue?: number
  /** OEE reached at toWeek and held afterwards. */
  endValue: number
  /**
   * `linear` ramps evenly. `sCurve` is slow-fast-slow, which is how
   * improvement programmes actually land. `step` jumps at toWeek.
   */
  curve: 'linear' | 'sCurve' | 'step'
  label: string
}

// ---------------------------------------------------------------------------
// Calendars & downtime
// ---------------------------------------------------------------------------

/**
 * Every kind of *planned* capacity loss. Unplanned loss is not here — it lives
 * in OEE, because it has no date.
 *
 * Events are always work-center scoped. A plant-wide shutdown is expanded into
 * one event per work center at authoring time, so there is exactly one place
 * to look when a week is blocked.
 */
export type DowntimeKind =
  | 'shutdown' // collective vacation, seasonal close
  | 'project' // capex install, line move, IT cutover
  | 'qualification' // PPAP, customer validation, trial runs
  | 'maintenance' // planned preventive maintenance
  | 'installation' // commissioning a new or retrofitted asset
  | 'changeover' // a planned major reconfiguration

export type DowntimeStatus = 'planned' | 'confirmed' | 'atRisk'

export interface DowntimeEvent {
  id: string
  workCenterId: WorkCenterId
  kind: DowntimeKind
  status: DowntimeStatus
  fromWeek: WeekIndex
  toWeek: WeekIndex
  /** Which pools are blocked. Vacation hits labour; maintenance hits machine. */
  pools: CapacityPool[]
  /**
   * Hours removed per week. Undefined blocks the pool entirely for the
   * week range, which is what a shutdown means.
   */
  hoursPerWeek?: number
  label: string
  /** For `atRisk` events: the slip being modelled, in weeks. */
  slipWeeks?: number
}

// ---------------------------------------------------------------------------
// Plans & inventory
// ---------------------------------------------------------------------------

/**
 * Columnar quantity matrix: `values[rowIndex * weekCount + weekIndex]`.
 * Rows are described by `rowKeys`, whose meaning depends on the matrix.
 */
export interface PlanMatrix {
  rowKeys: string[]
  weekCount: number
  values: Float64Array
}

export interface InventoryRow {
  materialId: MaterialId
  plantId: PlantId
  onHand: number
  inTransit: number
  safetyStock: number
}

// ---------------------------------------------------------------------------
// The snapshot — everything the engine reads
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  profile: string
  generatedBy: 'factory' | 'sap-extract'
  seed: number
  skuCount: number
  workCenterCount: number
  weekCount: number
  /** Set when loaded from CSVs, so the UI can name its source. */
  sourceLabel?: string
}

export interface Snapshot {
  meta: SnapshotMeta
  time: TimeGrid
  plants: Plant[]
  features: Feature[]
  machineClasses: MachineClass[]
  workCenters: WorkCenter[]
  standardOperations: StandardOperation[]
  families: ProductFamily[]
  groups: ProductGroup[]
  materials: Material[]
  routings: Routing[]
  rateOverrides: RateOverride[]
  oeeOverrides: OeeOverride[]
  glidePaths: OeeGlidePath[]
  downtime: DowntimeEvent[]
  /** Rows are `materialId|plantId`. The plan that loads capacity. */
  supplyPlan: PlanMatrix
  /** Rows are `materialId|region`. Reference only — never loads capacity. */
  demandPlan: PlanMatrix
  inventory: InventoryRow[]
}

// ---------------------------------------------------------------------------
// Scenario moves — every change a planner can make
// ---------------------------------------------------------------------------

/**
 * Moves apply immediately and are undoable. Each is a named, dated object, so
 * a scenario reads as a decision log rather than a blob of mutated state.
 */
export type Move =
  | {
      kind: 'resourceMove'
      /** Move a single SKU, a whole product group, or a whole family. */
      selector: MaterialSelector
      fromWorkCenterId: WorkCenterId
      toWorkCenterId: WorkCenterId
      fromWeek: WeekIndex
      toWeek: WeekIndex
      /** 0..1 of the volume on the source work center. */
      share: number
      /** False rejects any bucket that would end up with two sources. */
      allowDualSource: boolean
    }
  | {
      kind: 'oeeSet'
      scope: 'plant' | 'workCenter' | 'materialWorkCenter'
      plantId?: PlantId
      workCenterId?: WorkCenterId
      materialId?: MaterialId
      value: number
      fromWeek?: WeekIndex
      toWeek?: WeekIndex
    }
  | { kind: 'oeeGlide'; path: OeeGlidePath }
  | {
      kind: 'rateSet'
      materialId: MaterialId
      workCenterId: WorkCenterId
      opId: OperationId
      ratePerHour: number
    }
  | {
      kind: 'shiftChange'
      workCenterId: WorkCenterId
      pool: CapacityPool
      fromWeek: WeekIndex
      toWeek: WeekIndex
      count?: number
      shiftsPerDay?: number
      hoursPerShift?: number
      daysPerWeek?: number
    }
  | { kind: 'downtimeUpsert'; event: DowntimeEvent }
  | { kind: 'downtimeRemove'; eventId: string }
  | {
      kind: 'utilisationCeiling'
      scope: 'global' | 'plant' | 'workCenter'
      plantId?: PlantId
      workCenterId?: WorkCenterId
      /** 0..1.2. Load above this reads as overload even if hours exist. */
      ceiling: number
    }
  | {
      kind: 'retrofit'
      workCenterId: WorkCenterId
      retrofitId: string
      /** The week the added features become usable. */
      availableFromWeek: WeekIndex
    }
  | {
      kind: 'addWorkCenter'
      workCenter: WorkCenter
      /** Capex for standing the asset up. */
      capexUsd: number
    }
  | {
      kind: 'wipTransfer'
      /** Must be a HALB in plan mode; any operation boundary in what-if mode. */
      materialId: MaterialId
      fromPlantId: PlantId
      toPlantId: PlantId
      fromWeek: WeekIndex
      toWeek: WeekIndex
      share: number
      freightCostPerUnitUsd: number
      transitWeeks: number
    }
  | {
      kind: 'planScale'
      plan: 'supply' | 'demand'
      selector: MaterialSelector
      plantId?: PlantId
      region?: Region
      fromWeek: WeekIndex
      toWeek: WeekIndex
      factor: number
    }
  | {
      kind: 'sourceSwitch'
      /** The fluid stop-here / start-there decision, as one dated object. */
      selector: MaterialSelector
      fromPlantId: PlantId
      toPlantId: PlantId
      /** The week production stops at the origin and starts at the target. */
      switchWeek: WeekIndex
      /** Weeks of parallel run allowed for qualification, 0 for a clean cut. */
      overlapWeeks: number
    }

/** Targets a set of materials without enumerating 15,000 ids. */
export interface MaterialSelector {
  kind: 'material' | 'group' | 'family' | 'all'
  id?: string
}

export interface ScenarioMove {
  id: MoveId
  label: string
  enabled: boolean
  /** Monotonic counter, for the undo stack and stable ordering. */
  seq: number
  move: Move
}

export interface Scenario {
  id: ScenarioId
  name: string
  description: string
  moves: ScenarioMove[]
  colorSlot: 1 | 2 | 3 | 4 | 5
  /** The baseline is immutable and always present. */
  readonly?: boolean
}

// ---------------------------------------------------------------------------
// Engine output
// ---------------------------------------------------------------------------

/**
 * Per (work center, pool, week). This is the only dense result the engine
 * always materialises — 150 x 2 x 78 is 23,400 cells, which is nothing.
 * Everything SKU-level is computed on demand for the selected slice.
 */
export interface PoolLoadGrid {
  workCenterIds: WorkCenterId[]
  weekCount: number
  /** Hours the pool can offer after downtime, before the ceiling. */
  availableHours: Float64Array
  /** Hours the supply plan requires. */
  requiredHours: Float64Array
  /** Hours lost to dated downtime events. */
  downtimeHours: Float64Array
  /** Hours the plan could not place because the ceiling was reached. */
  overloadHours: Float64Array
  /** Setup hours included in requiredHours, tracked separately for reporting. */
  setupHours: Float64Array
}

export interface WorkCenterWeekLoad {
  workCenterId: WorkCenterId
  week: WeekIndex
  machineRequired: number
  machineAvailable: number
  labourRequired: number
  labourAvailable: number
  /** Ceiling actually applied to this cell. */
  ceiling: number
  /** required / (available x ceiling) for the binding pool. */
  utilisation: number
  /** Which pool is binding — the answer to "capex or hiring?". */
  bindingPool: CapacityPool
  /** Hours above the ceiling on the binding pool. */
  overloadHours: number
  /** Eaches the plan wanted here but the ceiling refused. */
  shortfallUnits: number
  oee: number
  downtimeHours: number
  events: string[]
}

/** Supply-plan load vs demand reference, at whatever level was rolled up. */
export interface RollupCell {
  key: string
  label: string
  week: WeekIndex
  requiredHours: number
  availableHours: number
  utilisation: number
  overloadHours: number
  supplyUnits: number
  demandUnits: number
  /** demandUnits - supplyUnits: what the plan chose not to serve. */
  gapUnits: number
  shortfallUnits: number
  costUsd: number
  co2Kg: number
}

export type RollupLevel =
  | 'global'
  | 'region'
  | 'plant'
  | 'workCenter'
  | 'machineClass'
  | 'family'
  | 'group'
  | 'material'

export interface Kpis {
  /** Weighted mean utilisation across the slice. */
  utilisation: number
  peakUtilisation: number
  availableHours: number
  requiredHours: number
  overloadHours: number
  setupHours: number
  downtimeHours: number
  supplyUnits: number
  demandUnits: number
  /** Demand the supply plan does not cover. */
  planGapUnits: number
  /** Supply the network cannot physically make. */
  shortfallUnits: number
  costUsd: number
  co2Kg: number
  /** Work-center weeks above their ceiling. */
  overloadedCells: number
  /** Work-center weeks below 40% — the repurposing opportunity. */
  underloadedCells: number
  machineBoundCells: number
  labourBoundCells: number
  capexUsd: number
}

/** A work center in trouble, ranked. */
export interface Bottleneck {
  workCenterId: WorkCenterId
  plantId: PlantId
  peakWeek: WeekIndex
  peakUtilisation: number
  weeksOverCeiling: number
  overloadHours: number
  shortfallUnits: number
  bindingPool: CapacityPool
  severity: 'watch' | 'tight' | 'critical'
  /** Product groups carrying the load, biggest first. */
  topGroups: Array<{ groupId: GroupId; hours: number }>
}

/**
 * Somewhere else that could take the load. This is the payoff of holding the
 * feature model alongside the allow-list.
 */
export interface ReliefCandidate {
  fromWorkCenterId: WorkCenterId
  toWorkCenterId: WorkCenterId
  /** `approved` needs no permission. The others are proposals with a price. */
  basis: 'approved' | 'featureCapable' | 'retrofit'
  retrofit?: RetrofitOption
  /** Materials that could move, and the hours that would move with them. */
  movableGroups: Array<{ groupId: GroupId; hours: number; materials: number }>
  /** Spare hours at the target across the window, after its own ceiling. */
  spareHours: number
  /** Utilisation at the target if the whole movable set arrived. */
  resultingUtilisation: number
  sameePlant: boolean
  capexUsd: number
  leadTimeWeeks: number
}

export interface ModelResult {
  scenarioId: ScenarioId
  time: TimeGrid
  grids: Record<CapacityPool, PoolLoadGrid>
  cells: WorkCenterWeekLoad[]
  kpis: Kpis
  kpisByWeek: Array<{ week: WeekIndex } & Kpis>
  bottlenecks: Bottleneck[]
  /** Resolved OEE per work center per week, after overrides and glide paths. */
  oeeByWorkCenterWeek: Float64Array
  /** Milliseconds the run took — surfaced so performance stays honest. */
  runtimeMs: number
  capexUsd: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** An empty array always means "all", never "none". */
export interface Filters {
  plantIds: PlantId[]
  regions: Region[]
  familyIds: FamilyId[]
  groupIds: GroupId[]
  workCenterIds: WorkCenterId[]
  machineClassIds: MachineClassId[]
  fromWeek: WeekIndex
  toWeek: WeekIndex
  /** Roll-up bucket for the time axis. */
  bucket: 'week' | 'month' | 'quarter'
}

export interface EngineOptions {
  /** Global default; plant and work-center ceilings override it. */
  utilisationCeiling?: number
  /** Skip the SKU-level detail pass when only aggregates are needed. */
  aggregatesOnly?: boolean
  /** Cap on relief candidates returned per bottleneck. */
  maxReliefCandidates?: number
}
