/**
 * Worker protocol.
 *
 * The main thread never holds the operation grid. It sends a scenario and a
 * filter, and receives aggregates sized for the screen — a few thousand
 * numbers at most, never a few million.
 *
 * Every request carries an `id`; every response echoes it. The client wrapper
 * in `./client.ts` turns that into a promise per request and drops responses
 * whose request has been superseded, so a fast drag never renders a stale run.
 */

import type {
  Bottleneck,
  CapacityPool,
  EngineOptions,
  Feature,
  Filters,
  Kpis,
  MachineClass,
  MaterialId,
  ModelResult,
  Plant,
  ProductFamily,
  ProductGroup,
  ReliefCandidate,
  RollupCell,
  RollupLevel,
  Scenario,
  SnapshotMeta,
  StandardOperation,
  TimeGrid,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
  WorkCenterWeekLoad,
} from '@/domain/types'

/** Master data the UI needs resident — small, sent once after init. */
export interface CatalogPayload {
  meta: SnapshotMeta
  time: TimeGrid
  plants: Plant[]
  workCenters: WorkCenter[]
  machineClasses: MachineClass[]
  features: Feature[]
  standardOperations: StandardOperation[]
  families: ProductFamily[]
  groups: ProductGroup[]
  /** Group -> material count. The 15,000 materials themselves stay in the worker. */
  materialCountByGroup: Record<string, number>
}

export type WorkerRequest =
  | {
      id: number
      type: 'init'
      /** `factory` generates deterministically; `csv` parses supplied extracts. */
      source: { kind: 'factory'; profile: string; seed: number } | { kind: 'csv'; files: Record<string, string> }
    }
  | { id: number; type: 'run'; scenario: Scenario; filters: Filters; options?: EngineOptions }
  | {
      id: number
      type: 'rollup'
      scenario: Scenario
      filters: Filters
      level: RollupLevel
      /** Restrict to one parent, e.g. the work centers of one plant. */
      parentKey?: string
    }
  | {
      id: number
      type: 'workCenterDetail'
      scenario: Scenario
      filters: Filters
      workCenterId: WorkCenterId
    }
  | {
      id: number
      type: 'relief'
      scenario: Scenario
      filters: Filters
      workCenterId: WorkCenterId
      maxCandidates?: number
    }
  | {
      id: number
      type: 'materialSlice'
      scenario: Scenario
      filters: Filters
      /** Only ever a page of materials — the UI never asks for all 15,000. */
      groupId?: string
      workCenterId?: WorkCenterId
      offset: number
      limit: number
      sortBy: 'hours' | 'units' | 'code'
    }
  | { id: number; type: 'exportCsv'; scenario: Scenario; table: SapTable }

export type SapTable =
  | 'MARA'
  | 'MARC'
  | 'MAST'
  | 'STPO'
  | 'PLKO'
  | 'PLPO'
  | 'MAPL'
  | 'CRHD'
  | 'CRCA'
  | 'KAKO'
  | 'KAPA'
  | 'DEMAND'
  | 'SUPPLY'
  | 'INVENTORY'

export interface WorkCenterDetail {
  workCenterId: WorkCenterId
  cells: WorkCenterWeekLoad[]
  /** Hours by product group per week, for the composition chart. */
  groupHours: Array<{ groupId: string; label: string; hours: number[] }>
  /** Approved elsewhere for the same operations — the shared-capacity links. */
  siblings: Array<{
    workCenterId: WorkCenterId
    basis: 'approved' | 'featureCapable' | 'retrofit'
    sharedOperations: number
    utilisation: number
  }>
  oeeByWeek: number[]
  downtimeByWeek: Array<{ week: WeekIndex; hours: number; kind: string; label: string }>
  topMaterials: Array<{ materialId: MaterialId; code: string; hours: number; units: number }>
}

export interface MaterialSliceRow {
  materialId: MaterialId
  code: string
  description: string
  groupId: string
  familyId: string
  units: number
  hours: number
  workCenterIds: WorkCenterId[]
  plantIds: string[]
  dualSourced: boolean
}

export type WorkerResponse =
  | { id: number; type: 'ready'; catalog: CatalogPayload; timings: Record<string, number> }
  | { id: number; type: 'result'; result: ModelResult }
  | { id: number; type: 'rollup'; level: RollupLevel; cells: RollupCell[]; kpis: Kpis }
  | { id: number; type: 'workCenterDetail'; detail: WorkCenterDetail }
  | { id: number; type: 'relief'; workCenterId: WorkCenterId; candidates: ReliefCandidate[] }
  | {
      id: number
      type: 'materialSlice'
      rows: MaterialSliceRow[]
      total: number
    }
  | { id: number; type: 'csv'; table: SapTable; content: string }
  | { id: number; type: 'progress'; phase: string; pct: number }
  | { id: number; type: 'error'; message: string; stack?: string }

/** Re-exported so the client and worker agree without importing the world. */
export type { Bottleneck, CapacityPool, ModelResult, RollupCell }
