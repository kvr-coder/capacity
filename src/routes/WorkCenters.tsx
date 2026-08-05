/**
 * The work-center register, and the panel that makes one machine trustworthy.
 *
 * The register is the flat answer to "which of the 150 assets is in trouble, and
 * which is idle enough to repurpose". The detail panel underneath is the
 * opposite: everything about one work center, with the capacity arithmetic
 * written out operand by operand. A planner who cannot reproduce the available
 * hours by hand will not act on the utilisation figure, so this screen shows the
 * multiplication rather than asking for faith in it.
 *
 * Three behaviours are product decisions rather than implementation details:
 *
 * 1. **The two knobs are visibly independent.** OEE (a flat override, or a dated
 *    glide) and the run rate are separate controls with separate local state.
 *    Moving one never moves the other's control — each is seeded once, when the
 *    selection changes, and never re-seeded from a model answer, because a knob
 *    that drifts because a *different* knob moved is a knob nobody trusts.
 *
 * 2. **A drag is one undo step.** The glide handle and the OEE slider both fire
 *    continuously; the commit is coalesced so forty pointer events become one
 *    move in the decision log, applied immediately and undoable.
 *
 * 3. **Master-data downtime is read-only here.** `WorkCenterDetail` carries the
 *    modelled hours of an event but not its id, pools or status, so events
 *    authored in this scenario are editable and the ones that came from master
 *    data say so instead of pretending to be editable and silently adding a
 *    second event on save.
 *
 * Nothing sized SKU x week reaches this file. The register reads the work-center
 * grids (150 x 78), the detail panel reads one work center, and the SKU list is
 * one page at a time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CapacityPool,
  DowntimeEvent,
  DowntimeKind,
  DowntimeStatus,
  ModelResult,
  Move,
  PoolCapacity,
  ScenarioMove,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import type { WorkCenterDetail } from '@/worker/protocol'
import type { SeriesSlot, StackedBarSeries, TableViewProps } from '@/charts/types'
import { at, clamp, safeDiv } from '@/domain/lookup'
import { compact, hours as fmtHours, units as fmtUnits, pct } from '@/lib/format'
import { ChartCard, GlideCurve, SparkBar, StackedBarChart, StatTile } from '@/charts'
import {
  Badge,
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  InfoTip,
  Modal,
  NumberField,
  SectionHeading,
  SegmentedControl,
  Select,
  Slider,
  TextField,
} from '@/components'
import type { BadgeTone, DataTableColumn } from '@/components'
import { nextLocalId, useActiveScenario, useUiStore } from '@/state/store'
import { useMaterialSlice, useModelResult, usePlantSlot, useWorkCenterDetail } from '@/state/model'
import styles from '@/routes/WorkCenters.module.css'

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

type Slot = 1 | 2 | 3 | 4 | 5

/** Typed-array read under `noUncheckedIndexedAccess`. */
function f64(array: Float64Array, index: number): number {
  return array[index] ?? 0
}

/** How many points a register sparkline carries, whatever the window is. */
const SPARK_POINTS = 16

/** Page size for the SKU list. The UI never asks for all 15,000. */
const MATERIAL_PAGE = 25

/** Product-group series in the composition chart, before folding to "Other". */
const MAX_GROUP_SERIES = 7

/**
 * The worker has already folded the long tail of product groups into one row
 * under this id. It is an aggregate, not an entity, so it must keep the
 * de-emphasis grey — it can never be handed a categorical slot.
 */
const WORKER_OTHER_GROUP_ID = '__other__'

/** How long a continuous control waits before it becomes one undoable move. */
const COMMIT_MS = 320

const UNDER_LOADED = 0.4

function utilisationTone(utilisation: number): BadgeTone {
  if (utilisation > 1) return 'critical'
  if (utilisation > 0.92) return 'serious'
  if (utilisation > 0.8) return 'warning'
  if (utilisation < UNDER_LOADED) return 'neutral'
  return 'good'
}

function utilisationStatus(
  utilisation: number,
): { level: 'good' | 'warning' | 'serious' | 'critical'; label: string } {
  if (utilisation > 1) return { level: 'critical', label: 'Over the ceiling' }
  if (utilisation > 0.92) return { level: 'serious', label: 'Tight' }
  if (utilisation > 0.8) return { level: 'warning', label: 'Watch' }
  return { level: 'good', label: 'Inside the ceiling' }
}

const KIND_LABEL: Record<DowntimeKind, string> = {
  shutdown: 'Shutdown',
  project: 'Project',
  qualification: 'Qualification',
  maintenance: 'Maintenance',
  installation: 'Installation',
  changeover: 'Changeover',
}

const STATUS_TONE: Record<DowntimeStatus, BadgeTone> = {
  planned: 'neutral',
  confirmed: 'good',
  atRisk: 'warning',
}

const STATUS_LABEL: Record<DowntimeStatus, string> = {
  planned: 'Planned',
  confirmed: 'Confirmed',
  atRisk: 'At risk',
}

const BASIS_TONE: Record<'approved' | 'featureCapable' | 'retrofit', BadgeTone> = {
  approved: 'good',
  featureCapable: 'warning',
  retrofit: 'serious',
}

const BASIS_LABEL: Record<'approved' | 'featureCapable' | 'retrofit', string> = {
  approved: 'Approved',
  featureCapable: 'Capable',
  retrofit: 'Retrofit',
}

/** Weekly hours a pool offers before downtime — the master-data arithmetic. */
function grossHours(pool: PoolCapacity): number {
  return pool.count * pool.shiftsPerDay * pool.hoursPerShift * pool.daysPerWeek * pool.utilisationFactor
}

function poolOf(workCenter: WorkCenter, pool: CapacityPool): PoolCapacity | undefined {
  return workCenter.pools.find((entry) => entry.pool === pool)
}

function poolSummary(pool: PoolCapacity | undefined): string {
  if (pool === undefined) return '—'
  return `${pool.count} × ${pool.shiftsPerDay} × ${pool.hoursPerShift}h`
}

/**
 * A continuous control that becomes one undoable move.
 *
 * The value is echoed locally on every event so the control never lags the
 * pointer, and the move is applied once the interaction settles. Unmounting
 * flushes, so a planner who drags and immediately clicks away still keeps the
 * change they made.
 */
function useCoalescedCommit<T>(commit: (value: T) => void): (value: T) => void {
  const commitRef = useRef(commit)
  commitRef.current = commit
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ value: T } | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      const queued = pending.current
      if (queued !== null) commitRef.current(queued.value)
      pending.current = null
    }
  }, [])

  return useCallback((value: T) => {
    pending.current = { value }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const queued = pending.current
      pending.current = null
      if (queued !== null) commitRef.current(queued.value)
    }, COMMIT_MS)
  }, [])
}

// ---------------------------------------------------------------------------
// The register row
// ---------------------------------------------------------------------------

interface RegisterRow {
  id: WorkCenterId
  code: string
  name: string
  plantId: string
  plantCode: string
  plantSlot: Slot
  className: string
  supplier: string
  vintage: number
  status: WorkCenter['status']
  machine: PoolCapacity | undefined
  labour: PoolCapacity | undefined
  featureCount: number
  meanUtilisation: number
  peakUtilisation: number
  peakWeek: WeekIndex
  weeksOverCeiling: number
  downtimeHours: number
  requiredHours: number
  permittedHours: number
  bindingPool: CapacityPool
  labourWeeks: number
  oeeNow: number
  oeeEnd: number
  spark: number[]
}

interface RegisterTotals {
  count: number
  meanUtilisation: number
  overCeiling: number
  underLoaded: number
  machineBound: number
  labourBound: number
  downtimeHours: number
}

interface Accumulator {
  utilSum: number
  peak: number
  peakWeek: number
  weeksOver: number
  downtime: number
  required: number
  permitted: number
  labourWeeks: number
  weeks: number
  perWeek: number[]
}

/** Mean-downsample a per-week series onto a fixed number of spark points. */
function downsample(values: readonly number[], points: number): number[] {
  if (values.length === 0) return []
  if (values.length <= points) return values.slice()
  const out: number[] = []
  for (let bucket = 0; bucket < points; bucket += 1) {
    const start = Math.floor((bucket * values.length) / points)
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * values.length) / points))
    let total = 0
    for (let i = start; i < end; i += 1) total += values[i] ?? 0
    out.push(total / (end - start))
  }
  return out
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function WorkCenters() {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const selection = useUiStore((state) => state.selection)
  const setSelection = useUiStore((state) => state.setSelection)
  const plantSlot = usePlantSlot()

  const model = useModelResult()

  const { rows, totals } = useMemo((): { rows: RegisterRow[]; totals: RegisterTotals } => {
    const empty: RegisterTotals = {
      count: 0,
      meanUtilisation: 0,
      overCeiling: 0,
      underLoaded: 0,
      machineBound: 0,
      labourBound: 0,
      downtimeHours: 0,
    }
    const result = model.data
    if (result === null || catalog === null) return { rows: [], totals: empty }

    const weekCount = result.grids.machine.weekCount
    const lastWeek = Math.max(0, weekCount - 1)
    const lo = clamp(Math.min(filters.fromWeek, filters.toWeek), 0, lastWeek)
    const hi = clamp(Math.max(filters.fromWeek, filters.toWeek), 0, lastWeek)

    const rowOf = new Map<WorkCenterId, number>()
    result.grids.machine.workCenterIds.forEach((id, index) => rowOf.set(id, index))

    const plantById = new Map(catalog.plants.map((plant) => [plant.id, plant]))
    const classById = new Map(catalog.machineClasses.map((cls) => [cls.id, cls]))

    const plantSet = new Set(filters.plantIds)
    const regionSet = new Set<string>(filters.regions)
    const classSet = new Set(filters.machineClassIds)
    const wcSet = new Set(filters.workCenterIds)

    const visible = catalog.workCenters.filter((wc) => {
      if (plantSet.size > 0 && !plantSet.has(wc.plantId)) return false
      if (classSet.size > 0 && !classSet.has(wc.classId)) return false
      if (wcSet.size > 0 && !wcSet.has(wc.id)) return false
      if (regionSet.size > 0) {
        const region = plantById.get(wc.plantId)?.region
        if (region === undefined || !regionSet.has(region)) return false
      }
      return rowOf.has(wc.id)
    })

    const acc = new Map<WorkCenterId, Accumulator>()
    for (const wc of visible) {
      acc.set(wc.id, {
        utilSum: 0,
        peak: 0,
        peakWeek: lo,
        weeksOver: 0,
        downtime: 0,
        required: 0,
        permitted: 0,
        labourWeeks: 0,
        weeks: 0,
        perWeek: [],
      })
    }

    for (const cell of result.cells) {
      if (cell.week < lo || cell.week > hi) continue
      const entry = acc.get(cell.workCenterId)
      if (entry === undefined) continue
      const required = cell.bindingPool === 'labour' ? cell.labourRequired : cell.machineRequired
      const available = cell.bindingPool === 'labour' ? cell.labourAvailable : cell.machineAvailable
      entry.utilSum += cell.utilisation
      entry.weeks += 1
      entry.required += required
      entry.permitted += available * cell.ceiling
      entry.downtime += cell.downtimeHours
      entry.perWeek.push(cell.utilisation)
      if (cell.utilisation > entry.peak) {
        entry.peak = cell.utilisation
        entry.peakWeek = cell.week
      }
      if (cell.utilisation > 1) entry.weeksOver += 1
      if (cell.bindingPool === 'labour') entry.labourWeeks += 1
    }

    const built: RegisterRow[] = []
    for (const wc of visible) {
      const entry = acc.get(wc.id)
      if (entry === undefined) continue
      const row = rowOf.get(wc.id) ?? 0
      const cls = classById.get(wc.classId)
      const plant = plantById.get(wc.plantId)
      const weeks = Math.max(1, entry.weeks)
      built.push({
        id: wc.id,
        code: wc.code,
        name: wc.name,
        plantId: wc.plantId,
        plantCode: plant?.code ?? wc.plantId,
        plantSlot: plantSlot(wc.plantId),
        className: cls?.name ?? wc.classId,
        supplier: cls?.supplier ?? '—',
        vintage: wc.vintage,
        status: wc.status,
        machine: poolOf(wc, 'machine'),
        labour: poolOf(wc, 'labour'),
        featureCount: wc.features.length,
        meanUtilisation: entry.utilSum / weeks,
        peakUtilisation: entry.peak,
        peakWeek: entry.peakWeek,
        weeksOverCeiling: entry.weeksOver,
        downtimeHours: entry.downtime,
        requiredHours: entry.required,
        permittedHours: entry.permitted,
        bindingPool: entry.labourWeeks * 2 > weeks ? 'labour' : 'machine',
        labourWeeks: entry.labourWeeks,
        oeeNow: f64(result.oeeByWorkCenterWeek, row * weekCount + lo),
        oeeEnd: f64(result.oeeByWorkCenterWeek, row * weekCount + hi),
        spark: downsample(entry.perWeek, SPARK_POINTS),
      })
    }

    let required = 0
    let permitted = 0
    let downtime = 0
    let overCeiling = 0
    let underLoaded = 0
    let machineBound = 0
    let labourBound = 0
    for (const row of built) {
      required += row.requiredHours
      permitted += row.permittedHours
      downtime += row.downtimeHours
      if (row.weeksOverCeiling > 0) overCeiling += 1
      if (row.peakUtilisation < UNDER_LOADED) underLoaded += 1
      if (row.bindingPool === 'labour') labourBound += 1
      else machineBound += 1
    }

    return {
      rows: built,
      totals: {
        count: built.length,
        meanUtilisation: safeDiv(required, permitted),
        overCeiling,
        underLoaded,
        machineBound,
        labourBound,
        downtimeHours: downtime,
      },
    }
  }, [catalog, filters.fromWeek, filters.toWeek, filters.machineClassIds, filters.plantIds, filters.regions, filters.workCenterIds, model.data, plantSlot])

  const selectedId = selection.workCenterId
  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedId),
    [rows, selectedId],
  )

  const columns = useMemo((): Array<DataTableColumn<RegisterRow>> => {
    return [
      {
        key: 'plant',
        header: 'Plant',
        width: 92,
        sortValue: (row) => row.plantCode,
        render: (row) => <Chip slot={row.plantSlot}>{row.plantCode}</Chip>,
      },
      {
        key: 'code',
        header: 'Code',
        width: 108,
        sortValue: (row) => row.code,
        render: (row) => <span className={styles.stepStrong}>{row.code}</span>,
      },
      {
        key: 'name',
        header: 'Name',
        sortValue: (row) => row.name,
        render: (row) => (
          <span className={styles.cellName} title={row.name}>
            {row.name}
          </span>
        ),
      },
      {
        key: 'class',
        header: 'Machine class',
        sortValue: (row) => row.className,
        render: (row) => (
          <span className={styles.cellName} title={`${row.className} · ${row.supplier}`}>
            {row.className}
          </span>
        ),
      },
      {
        key: 'vintage',
        header: 'Vintage',
        align: 'right',
        width: 78,
        sortValue: (row) => row.vintage,
        render: (row) => <span className={styles.numeric}>{row.vintage}</span>,
      },
      {
        key: 'machinePool',
        header: 'Machine pool',
        width: 118,
        sortValue: (row) => (row.machine === undefined ? 0 : grossHours(row.machine)),
        render: (row) => <span className={styles.pool}>{poolSummary(row.machine)}</span>,
      },
      {
        key: 'labourPool',
        header: 'Labour pool',
        width: 118,
        sortValue: (row) => (row.labour === undefined ? 0 : grossHours(row.labour)),
        render: (row) => (
          <span className={`${styles.pool} ${styles.poolMuted}`}>{poolSummary(row.labour)}</span>
        ),
      },
      {
        key: 'mean',
        header: 'Mean util.',
        align: 'right',
        width: 92,
        sortValue: (row) => row.meanUtilisation,
        render: (row) => <span className={styles.numeric}>{pct(row.meanUtilisation, 0)}</span>,
      },
      {
        key: 'peak',
        header: 'Peak util.',
        align: 'right',
        width: 150,
        sortValue: (row) => row.peakUtilisation,
        render: (row) => (
          <span className={styles.peakCell}>
            <span className={styles.numeric}>{pct(row.peakUtilisation, 0)}</span>
            <SparkBar
              values={row.spark}
              slot={row.plantSlot}
              width={68}
              height={16}
              ariaLabel={`Utilisation by week for ${row.code}, peak ${pct(row.peakUtilisation, 0)}`}
            />
          </span>
        ),
      },
      {
        key: 'binding',
        header: 'Binding pool',
        width: 128,
        sortValue: (row) => row.bindingPool,
        render: (row) => (
          <Badge size="sm" tone={row.bindingPool === 'labour' ? 'warning' : 'neutral'}>
            {row.bindingPool === 'labour' ? 'Labour' : 'Machine'}
          </Badge>
        ),
      },
      {
        key: 'over',
        header: 'Weeks over',
        align: 'right',
        width: 96,
        sortValue: (row) => row.weeksOverCeiling,
        render: (row) => <span className={styles.numeric}>{row.weeksOverCeiling}</span>,
      },
      {
        key: 'oeeNow',
        header: 'OEE now',
        align: 'right',
        width: 88,
        sortValue: (row) => row.oeeNow,
        render: (row) => <span className={styles.numeric}>{pct(row.oeeNow, 1)}</span>,
      },
      {
        key: 'oeeEnd',
        header: 'OEE at end',
        align: 'right',
        width: 96,
        sortValue: (row) => row.oeeEnd,
        render: (row) => <span className={styles.numeric}>{pct(row.oeeEnd, 1)}</span>,
      },
      {
        key: 'downtime',
        header: 'Downtime',
        align: 'right',
        width: 96,
        sortValue: (row) => row.downtimeHours,
        render: (row) => <span className={styles.numeric}>{fmtHours(row.downtimeHours, { compact: true })}</span>,
      },
      {
        key: 'features',
        header: 'Features',
        align: 'right',
        width: 88,
        sortValue: (row) => row.featureCount,
        render: (row) => <span className={styles.numeric}>{row.featureCount}</span>,
      },
    ]
  }, [])

  const stale = model.loading && model.data !== null

  return (
    <div className={styles.page}>
      <FilterBar />

      <SectionHeading
        level={1}
        description="Every asset in the filter, its two capacity pools, and which of them binds. Select a row for the arithmetic behind its available hours."
      >
        Work centers
      </SectionHeading>

      {model.error !== null ? (
        <ErrorState
          message={model.error}
          detail="The register needs a model run. Widen the filter or try again."
        />
      ) : null}

      <div className={styles.kpis}>
        <StatTile
          label="Work centers in view"
          value={fmtUnits(totals.count)}
          hint="Assets matching the filter that the run actually judged."
        />
        <StatTile
          label="Mean utilisation"
          value={pct(totals.meanUtilisation, 1)}
          status={utilisationStatus(totals.meanUtilisation)}
          hint="Required hours over permitted hours across every work-center week in the window."
        />
        <StatTile
          label="Over the ceiling"
          value={fmtUnits(totals.overCeiling)}
          status={
            totals.overCeiling > 0
              ? { level: 'critical', label: 'Needs relief' }
              : { level: 'good', label: 'All inside' }
          }
          hint="Work centers with at least one week above their own ceiling."
        />
        <StatTile
          label="Peak under 40%"
          value={fmtUnits(totals.underLoaded)}
          hint="Never reaches 40% of its ceiling in the whole window — the repurposing opportunity."
        />
        <StatTile
          label="Machine vs labour bound"
          value={`${totals.machineBound} / ${totals.labourBound}`}
          hint="Which pool saturates first. Machine-bound wants capex; labour-bound wants operators."
        />
        <StatTile
          label="Downtime hours"
          value={fmtHours(totals.downtimeHours, { compact: true })}
          hint="Dated, planned loss across both pools. Unplanned loss lives inside OEE and has no date."
        />
      </div>

      <Card
        title="The register"
        subtitle={`${rows.length} work centers · sorted by peak utilisation`}
        aside={<span className={styles.hint}>Select a row to open its detail below</span>}
        flush
        stale={stale}
      >
        <DataTable<RegisterRow>
          caption="Work centers in the current filter, with both capacity pools, utilisation against each cell's own ceiling, OEE and downtime."
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          initialSort={{ key: 'peak', dir: 'desc' }}
          selectedKey={selectedId}
          maxHeight={520}
          stale={stale}
          onRowClick={(row) => setSelection({ workCenterId: row.id, plantId: row.plantId })}
          empty={
            <EmptyState
              title="No work center matches this filter"
              description="Every filter is an intersection. Clear a plant or a machine class to bring assets back."
            />
          }
        />
      </Card>

      {selectedRow === undefined ? (
        <Card>
          <EmptyState
            icon="machine"
            title="Nothing selected yet"
            description="Pick a work center above to see its capacity build-up, its load by product group, its OEE curve, its downtime and the SKUs behind the hours."
          />
        </Card>
      ) : (
        <DetailPanel row={selectedRow} result={model.data} />
      )}
    </div>
  )
}

export default WorkCenters

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

interface DetailPanelProps {
  row: RegisterRow
  /** The authoritative run, passed down rather than re-requested per card. */
  result: ModelResult | null
}

function DetailPanel({ row, result }: DetailPanelProps) {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const applyMove = useUiStore((state) => state.applyMove)
  const scenario = useActiveScenario()
  const detail = useWorkCenterDetail(row.id)

  const weeks = useMemo(() => catalog?.time.weeks ?? [], [catalog])
  const weekCount = weeks.length
  const lastWeek = Math.max(0, weekCount - 1)
  const fromWeek = clamp(Math.min(filters.fromWeek, filters.toWeek), 0, lastWeek)
  const toWeek = clamp(Math.max(filters.fromWeek, filters.toWeek), 0, lastWeek)

  const workCenter = useMemo(
    () => catalog?.workCenters.find((wc) => wc.id === row.id),
    [catalog, row.id],
  )

  const weekLabel = useCallback(
    (week: WeekIndex): string => weeks[week] ?? `W${week}`,
    [weeks],
  )

  const verdict =
    row.bindingPool === 'labour'
      ? 'Labour bound — adding a shift will not help; this needs operators.'
      : 'Machine bound — the machine pool saturates first; this needs capex or a move, not hiring.'

  const stale = detail.loading && detail.data !== null

  return (
    <section className={styles.detail} aria-label={`Detail for ${row.code}`}>
      <Card>
        <div className={styles.detailHeader}>
          <Chip slot={row.plantSlot}>{row.plantCode}</Chip>
          <h2 className={styles.detailTitle}>
            {row.code} · {row.name}
          </h2>
          <Badge tone={row.status === 'proposed' ? 'warning' : 'neutral'}>
            {row.status === 'proposed' ? 'Proposed asset' : 'Active'}
          </Badge>
          <Badge tone={utilisationTone(row.peakUtilisation)}>
            Peak {pct(row.peakUtilisation, 0)} in {weekLabel(row.peakWeek)}
          </Badge>
        </div>
        <p className={styles.detailSub}>
          {row.className} from {row.supplier} · commissioned {row.vintage} ·{' '}
          {row.featureCount} features · machine pool {poolSummary(row.machine)} · labour pool{' '}
          {poolSummary(row.labour)}
        </p>
        <p className={styles.verdict}>
          <span className={styles.verdictLead}>{verdict}</span>
          <InfoTip>
            The binding pool is whichever of machine and labour reaches its ceiling first. It was
            labour in {row.labourWeeks} of the {Math.max(1, toWeek - fromWeek + 1)} weeks in this
            window.
          </InfoTip>
        </p>
      </Card>

      {detail.error !== null ? (
        <ErrorState
          message={detail.error}
          detail="The detail for this work center could not be computed. The register above is still the authoritative run."
        />
      ) : null}

      <div className={styles.split}>
        <BuildUpCard
          row={row}
          result={result}
          workCenter={workCenter}
          detail={detail.data}
          fromWeek={fromWeek}
          toWeek={toWeek}
          weekLabel={weekLabel}
          stale={stale}
        />
        <LoadByWeekCard
          row={row}
          detail={detail.data}
          fromWeek={fromWeek}
          weekLabel={weekLabel}
          stale={stale}
        />
      </div>

      <OeeCard
        row={row}
        detail={detail.data}
        fromWeek={fromWeek}
        toWeek={toWeek}
        weekCount={weekCount}
        weekLabel={weekLabel}
        workCenter={workCenter}
        applyMove={applyMove}
        stale={stale}
      />

      <DowntimeCard
        row={row}
        detail={detail.data}
        scenarioMoves={scenario.moves}
        fromWeek={fromWeek}
        toWeek={toWeek}
        lastWeek={lastWeek}
        weekLabel={weekLabel}
        applyMove={applyMove}
        stale={stale}
      />

      <SharedCapacityCard
        row={row}
        detail={detail.data}
        fromWeek={fromWeek}
        toWeek={toWeek}
        applyMove={applyMove}
        stale={stale}
      />

      <TopMaterialsCard row={row} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// (b) Capacity build-up
// ---------------------------------------------------------------------------

interface BuildUpRow {
  id: string
  step: string
  operand: string
  result: string
  emphasis?: boolean
}

interface BuildUpCardProps {
  row: RegisterRow
  result: ModelResult | null
  workCenter: WorkCenter | undefined
  detail: WorkCenterDetail | null
  fromWeek: WeekIndex
  toWeek: WeekIndex
  weekLabel: (week: WeekIndex) => string
  stale: boolean
}

function BuildUpCard({
  row,
  result,
  workCenter,
  detail,
  fromWeek,
  toWeek,
  weekLabel,
  stale,
}: BuildUpCardProps) {
  const [pool, setPool] = useState<CapacityPool>(row.bindingPool)
  const [week, setWeek] = useState<WeekIndex>(row.peakWeek)

  // Re-seed only when the selection changes — never when a model answer lands,
  // so the week a planner is reading does not move under them.
  const seed = useRef({ pool: row.bindingPool, week: row.peakWeek })
  seed.current = { pool: row.bindingPool, week: row.peakWeek }
  useEffect(() => {
    setPool(seed.current.pool)
    setWeek(seed.current.week)
  }, [row.id])

  const chosenWeek = clamp(week, fromWeek, toWeek)
  const cell = detail?.cells.find((entry) => entry.week === chosenWeek)
  const capacity = workCenter === undefined ? undefined : poolOf(workCenter, pool)

  const buildUp = useMemo((): BuildUpRow[] => {
    if (capacity === undefined || cell === undefined || result === null) return []
    const grid = result.grids[pool]
    const rowIndex = grid.workCenterIds.indexOf(row.id)
    if (rowIndex < 0) return []
    const index = rowIndex * grid.weekCount + chosenWeek
    const available = f64(grid.availableHours, index)
    const downtime = f64(grid.downtimeHours, index)
    const required = f64(grid.requiredHours, index)
    const master = grossHours(capacity)
    const modelled = available + downtime
    const noun = pool === 'machine' ? 'machines in the pool' : 'operators on shift'

    const out: BuildUpRow[] = [
      { id: 'count', step: noun, operand: fmtUnits(capacity.count), result: fmtUnits(capacity.count) },
      {
        id: 'shifts',
        step: '× shifts per day',
        operand: `× ${capacity.shiftsPerDay}`,
        result: fmtUnits(capacity.count * capacity.shiftsPerDay),
      },
      {
        id: 'hours',
        step: '× hours per shift',
        operand: `× ${capacity.hoursPerShift}`,
        result: fmtHours(capacity.count * capacity.shiftsPerDay * capacity.hoursPerShift),
      },
      {
        id: 'days',
        step: '× days per week',
        operand: `× ${capacity.daysPerWeek}`,
        result: fmtHours(
          capacity.count * capacity.shiftsPerDay * capacity.hoursPerShift * capacity.daysPerWeek,
        ),
      },
      {
        id: 'factor',
        step: '× capacity utilisation factor',
        operand: `× ${capacity.utilisationFactor}`,
        result: fmtHours(master),
        emphasis: true,
      },
    ]

    if (Math.abs(modelled - master) > 0.05) {
      out.push({
        id: 'scenario',
        step: modelled > master ? '+ scenario shift change' : '− scenario shift change',
        operand: `${modelled > master ? '+' : '−'} ${fmtHours(Math.abs(modelled - master))}`,
        result: fmtHours(modelled),
      })
    }

    const events = (detail?.downtimeByWeek ?? []).filter((entry) => entry.week === chosenWeek)
    let running = modelled
    let listed = 0
    for (const [order, event] of events.entries()) {
      listed += event.hours
      running = Math.max(0, running - event.hours)
      out.push({
        id: `dt-${order}-${event.label}`,
        step: `− ${event.label}`,
        operand: `− ${fmtHours(event.hours)}`,
        result: fmtHours(running),
      })
    }
    const residual = downtime - listed
    if (Math.abs(residual) > 0.05) {
      out.push({
        id: 'residual',
        step: residual > 0 ? '− other planned downtime' : '+ overlap between events, not counted twice',
        operand: `${residual > 0 ? '−' : '+'} ${fmtHours(Math.abs(residual))}`,
        result: fmtHours(modelled - downtime),
      })
    }

    out.push({
      id: 'available',
      step: '= available hours',
      operand: '',
      result: fmtHours(available),
      emphasis: true,
    })
    out.push({
      id: 'ceiling',
      step: '× utilisation ceiling',
      operand: `× ${cell.ceiling.toFixed(2)}`,
      result: fmtHours(available * cell.ceiling),
    })
    out.push({
      id: 'required',
      step: 'required hours from the supply plan',
      operand: fmtHours(required),
      result: fmtHours(required),
    })
    out.push({
      id: 'utilisation',
      step: '= utilisation, required over permitted',
      operand: '',
      result: pct(safeDiv(required, available * cell.ceiling), 1),
      emphasis: true,
    })
    return out
  }, [capacity, cell, chosenWeek, detail, pool, result, row.id])

  const columns: Array<DataTableColumn<BuildUpRow>> = useMemo(
    () => [
      {
        key: 'step',
        header: 'Step',
        render: (entry) => (
          <span className={entry.emphasis === true ? styles.stepStrong : styles.stepLabel}>
            {entry.step}
          </span>
        ),
      },
      {
        key: 'operand',
        header: 'Operand',
        align: 'right',
        width: 110,
        render: (entry) => <span className={styles.operand}>{entry.operand}</span>,
      },
      {
        key: 'result',
        header: 'Running result',
        align: 'right',
        width: 130,
        render: (entry) => (
          <span className={entry.emphasis === true ? styles.resultStrong : styles.result}>
            {entry.result}
          </span>
        ),
      },
    ],
    [],
  )

  const weekOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = []
    for (let w = fromWeek; w <= toWeek; w += 1) options.push({ value: String(w), label: weekLabel(w) })
    return options
  }, [fromWeek, toWeek, weekLabel])

  return (
    <Card
      title="Capacity build-up"
      subtitle={`${pool === 'machine' ? 'Machine' : 'Labour'} pool · ${weekLabel(chosenWeek)}`}
      stale={stale}
      aside={
        <div className={styles.controlRow}>
          <SegmentedControl<CapacityPool>
            label="Capacity pool"
            size="sm"
            value={pool}
            options={[
              { value: 'machine', label: 'Machine' },
              { value: 'labour', label: 'Labour' },
            ]}
            onChange={setPool}
          />
          <Select
            label="Week"
            hideLabel
            size="sm"
            value={String(chosenWeek)}
            options={weekOptions}
            onChange={(value) => setWeek(Number(value))}
          />
        </div>
      }
    >
      {buildUp.length === 0 ? (
        <EmptyState
          icon="table"
          title="No capacity in this week"
          description="This work center has no pool of that kind in the chosen week, or the run has not answered yet."
        />
      ) : (
        <DataTable<BuildUpRow>
          caption={`Capacity arithmetic for ${row.code}, ${pool} pool, week ${weekLabel(chosenWeek)}: master data, dated downtime, the ceiling and the resulting utilisation.`}
          columns={columns}
          rows={buildUp}
          rowKey={(entry) => entry.id}
          maxHeight={420}
          rowHeight={30}
        />
      )}
      <p className={styles.formNote}>
        Unplanned loss is not on this list. It lives inside OEE, which has no date — giving it one
        would be a precise-looking lie.
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// (c) Load by week
// ---------------------------------------------------------------------------

interface LoadByWeekCardProps {
  row: RegisterRow
  detail: WorkCenterDetail | null
  fromWeek: WeekIndex
  weekLabel: (week: WeekIndex) => string
  stale: boolean
}

function LoadByWeekCard({ row, detail, fromWeek, weekLabel, stale }: LoadByWeekCardProps) {
  const composition = useMemo(() => {
    const groups = detail?.groupHours ?? []
    const cells = detail?.cells ?? []
    const categories = cells.map((cell) => weekLabel(cell.week))
    const limits = cells.map((cell) => {
      const available = cell.bindingPool === 'labour' ? cell.labourAvailable : cell.machineAvailable
      return available * cell.ceiling
    })

    // The worker's pre-folded "Other" row is pulled out before ranking, so it
    // can never win one of the categorical slots — a fold is grey, always.
    const preFolded = groups.filter((group) => group.groupId === WORKER_OTHER_GROUP_ID)
    const named = groups.filter((group) => group.groupId !== WORKER_OTHER_GROUP_ID)

    const totals = named.map((group) => ({
      group,
      total: group.hours.reduce((sum, value) => sum + value, 0),
    }))
    totals.sort((a, b) => b.total - a.total)
    const head = totals.slice(0, MAX_GROUP_SERIES).map((entry) => entry.group)
    const tail = [...totals.slice(MAX_GROUP_SERIES).map((entry) => entry.group), ...preFolded]

    // Slot follows the group's own id, in a stable order — never the current
    // rank, so a move that reorders the stack does not repaint it.
    head.sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))

    const series: StackedBarSeries[] = head.map((group, index) => ({
      id: group.groupId,
      label: group.label,
      slot: (index + 1) as SeriesSlot,
      values: categories.map((_, position) => group.hours[position] ?? 0),
    }))

    if (tail.length > 0) {
      series.push({
        id: 'other',
        // The pre-folded row already stands for an unknown number of groups,
        // so a count would be a precise-looking lie once it is in the tail.
        label: preFolded.length > 0 ? 'Other groups' : `Other (${tail.length} groups)`,
        slot: 'other',
        values: categories.map((_, position) =>
          tail.reduce((sum, group) => sum + (group.hours[position] ?? 0), 0),
        ),
      })
    }

    const table: TableViewProps = {
      caption: `Required hours at ${row.code} by product group and week, against the hours the ceiling permits.`,
      columns: [
        { key: 'week', label: 'Week' },
        ...series.map((entry) => ({ key: entry.id, label: entry.label, align: 'right' as const })),
        { key: 'total', label: 'Total', align: 'right' as const },
        { key: 'limit', label: 'Permitted', align: 'right' as const },
      ],
      rows: categories.map((category, position) => {
        const record: Record<string, string | number> = { week: category }
        let total = 0
        for (const entry of series) {
          const value = entry.values[position] ?? 0
          total += value
          record[entry.id] = fmtHours(value)
        }
        record['total'] = fmtHours(total)
        record['limit'] = fmtHours(limits[position] ?? 0)
        return record
      }),
    }

    return { categories, series, limits, table }
  }, [detail, row.code, weekLabel])

  return (
    <ChartCard
      title="Load by week"
      subtitle="Required hours stacked by product group; the rule is the hours the ceiling permits"
      stale={stale}
      table={composition.table}
    >
      {composition.categories.length === 0 || composition.series.length === 0 ? (
        <EmptyState
          icon="product"
          title="No load on this work center"
          description="The supply plan places nothing here in this window. Widen the weeks, or check the product filter."
        />
      ) : (
        <StackedBarChart
          categories={composition.categories}
          categoryLabel={(category) => category}
          series={composition.series}
          limits={composition.limits}
          limitLabel="Permitted by the ceiling"
          height={260}
          yLabel="Hours"
          format={(value) => fmtHours(value, { compact: true })}
        />
      )}
      <p className={styles.formNote}>
        Weeks are the planning bucket. The first week drawn is {weekLabel(fromWeek)}.
      </p>
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// (d) OEE — glide, flat override and the rate knob beside it
// ---------------------------------------------------------------------------

interface OeeCardProps {
  row: RegisterRow
  detail: WorkCenterDetail | null
  fromWeek: WeekIndex
  toWeek: WeekIndex
  weekCount: number
  weekLabel: (week: WeekIndex) => string
  workCenter: WorkCenter | undefined
  applyMove: (move: Move, label?: string) => void
  stale: boolean
}

function OeeCard({
  row,
  detail,
  fromWeek,
  toWeek,
  weekCount,
  weekLabel,
  workCenter,
  applyMove,
  stale,
}: OeeCardProps) {
  const catalog = useUiStore((state) => state.catalog)

  const [rampFrom, setRampFrom] = useState<WeekIndex>(fromWeek)
  const [rampTo, setRampTo] = useState<WeekIndex>(toWeek)
  const [curve, setCurve] = useState<'linear' | 'sCurve' | 'step'>('sCurve')
  const [endValue, setEndValue] = useState<number>(row.oeeEnd)
  const [flatOee, setFlatOee] = useState<number>(row.oeeNow)

  // Each knob is seeded once per selection and never again. A model answer must
  // not move a control the planner did not touch.
  const seeds = useRef({ end: row.oeeEnd, flat: row.oeeNow, from: fromWeek, to: toWeek })
  seeds.current = { end: row.oeeEnd, flat: row.oeeNow, from: fromWeek, to: toWeek }
  useEffect(() => {
    setEndValue(seeds.current.end)
    setFlatOee(seeds.current.flat)
    setRampFrom(seeds.current.from)
    setRampTo(seeds.current.to)
  }, [row.id])

  const wholeHorizon = rampFrom === 0 && rampTo === Math.max(0, weekCount - 1)

  const commitGlide = useCoalescedCommit<number>(
    useCallback(
      (value: number) => {
        if (wholeHorizon) {
          applyMove({
            kind: 'oeeSet',
            scope: 'workCenter',
            workCenterId: row.id,
            value,
          })
          return
        }
        applyMove({
          kind: 'oeeGlide',
          path: {
            id: nextLocalId('glide'),
            scope: 'workCenter',
            workCenterId: row.id,
            fromWeek: rampFrom,
            toWeek: rampTo,
            endValue: value,
            curve,
            label: `${row.code} to ${pct(value, 0)} OEE by ${weekLabel(rampTo)}`,
          },
        })
      },
      [applyMove, curve, rampFrom, rampTo, row.code, row.id, weekLabel, wholeHorizon],
    ),
  )

  const commitFlat = useCoalescedCommit<number>(
    useCallback(
      (value: number) => {
        applyMove({
          kind: 'oeeSet',
          scope: 'workCenter',
          workCenterId: row.id,
          value,
          fromWeek,
          toWeek,
        })
      },
      [applyMove, fromWeek, row.id, toWeek],
    ),
  )

  const weeksInWindow = useMemo(() => {
    const labels: string[] = []
    for (let w = fromWeek; w <= toWeek; w += 1) labels.push(weekLabel(w))
    return labels
  }, [fromWeek, toWeek, weekLabel])

  const oeeSeries = useMemo(() => detail?.oeeByWeek ?? [], [detail])

  const table: TableViewProps = useMemo(
    () => ({
      caption: `Resolved OEE at ${row.code} by week, after every override and glide path in this scenario.`,
      columns: [
        { key: 'week', label: 'Week' },
        { key: 'oee', label: 'Resolved OEE', align: 'right' as const },
      ],
      rows: weeksInWindow.map((label, index) => ({
        week: label,
        oee: pct(oeeSeries[index] ?? 0, 1),
      })),
    }),
    [oeeSeries, row.code, weeksInWindow],
  )

  const rampOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = []
    for (let w = 0; w < weekCount; w += 1) options.push({ value: String(w), label: weekLabel(w) })
    return options
  }, [weekCount, weekLabel])

  return (
    <Card
      title="OEE"
      subtitle="Two knobs that never touch each other: the OEE ramp, and the run rate on the busiest SKU"
      stale={stale}
    >
      <div className={styles.split}>
        <ChartCard
          title="Resolved OEE by week"
          subtitle={
            wholeHorizon
              ? 'The window is the whole horizon, so dragging the handle sets a flat OEE'
              : `Ramping ${weekLabel(rampFrom)} → ${weekLabel(rampTo)}`
          }
          table={table}
          stale={stale}
        >
          {oeeSeries.length === 0 ? (
            <EmptyState
              icon="zap"
              title="No OEE resolved yet"
              description="The work-center detail has not answered for this window."
            />
          ) : (
            <GlideCurve
              weeks={weeksInWindow}
              series={[
                {
                  id: row.id,
                  label: `${row.code} resolved OEE`,
                  slot: row.plantSlot,
                  values: oeeSeries,
                },
              ]}
              ramp={{
                fromWeek: clamp(rampFrom - fromWeek, 0, Math.max(0, weeksInWindow.length - 1)),
                toWeek: clamp(rampTo - fromWeek, 0, Math.max(0, weeksInWindow.length - 1)),
                label: 'Improvement programme',
              }}
              endValue={endValue}
              endValueBounds={{ min: 0.2, max: 0.98 }}
              onEndValueChange={(value) => {
                setEndValue(value)
                commitGlide(value)
              }}
              weekLabel={(week) => week}
              height={260}
            />
          )}
        </ChartCard>

        <div className={styles.controls}>
          <div className={styles.knob}>
            <p className={styles.knobTitle}>
              Glide window
              <InfoTip>
                A dated improvement plan. Real programmes ramp; a step change on the week the
                project closes is not what happens on a shop floor. Set the window to the whole
                horizon and the handle writes a flat OEE instead.
              </InfoTip>
            </p>
            <div className={styles.controlRow}>
              <Select
                label="From"
                size="sm"
                className={styles.grow}
                value={String(rampFrom)}
                options={rampOptions}
                onChange={(value) => setRampFrom(clamp(Number(value), 0, rampTo))}
              />
              <Select
                label="To"
                size="sm"
                className={styles.grow}
                value={String(rampTo)}
                options={rampOptions}
                onChange={(value) => setRampTo(clamp(Number(value), rampFrom, Math.max(0, weekCount - 1)))}
              />
            </div>
            <SegmentedControl<'linear' | 'sCurve' | 'step'>
              label="Curve"
              size="sm"
              value={curve}
              options={[
                { value: 'linear', label: 'Linear', hint: 'even ramp' },
                { value: 'sCurve', label: 'S-curve', hint: 'slow, fast, slow' },
                { value: 'step', label: 'Step', hint: 'jumps at the end week' },
              ]}
              onChange={setCurve}
            />
            <p className={styles.knobNote}>
              Drag the end handle on the curve, or use the arrow keys on it. The change applies
              immediately and one drag is one undo step.
            </p>
          </div>

          <div className={styles.knob}>
            <p className={styles.knobTitle}>
              Flat OEE override
              <InfoTip>
                A constant OEE across the filtered weeks, independent of the glide path above.
                Whichever override is most specific wins in the cascade.
              </InfoTip>
            </p>
            <Slider
              label={`OEE for ${weekLabel(fromWeek)} – ${weekLabel(toWeek)}`}
              min={0.2}
              max={0.98}
              step={0.01}
              value={flatOee}
              format={(value) => pct(value, 0)}
              onChange={(value) => {
                setFlatOee(value)
                commitFlat(value)
              }}
              hint={`Work-center base OEE is ${pct(workCenter?.baseOee ?? 0, 0)}.`}
            />
          </div>

          <RateKnob row={row} detail={detail} applyMove={applyMove} catalogOperations={catalog?.standardOperations ?? []} workCenter={workCenter} />
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// The rate knob — deliberately independent of everything above
// ---------------------------------------------------------------------------

interface RateKnobProps {
  row: RegisterRow
  detail: WorkCenterDetail | null
  workCenter: WorkCenter | undefined
  catalogOperations: Array<{ id: string; code: string; name: string; requiredFeatures: string[] }>
  applyMove: (move: Move, label?: string) => void
}

function RateKnob({ row, detail, workCenter, catalogOperations, applyMove }: RateKnobProps) {
  const top = detail?.topMaterials[0]
  const observed = top === undefined ? 0 : safeDiv(top.units, top.hours)
  const observedRef = useRef(observed)
  observedRef.current = observed

  const [rate, setRate] = useState<number>(0)
  const materialId = top?.materialId

  // Seeded from the observed eaches per hour when the SKU changes, and never
  // again — the OEE knob must not be able to move this number.
  useEffect(() => {
    setRate(Math.round(observedRef.current * 10) / 10)
  }, [materialId])

  const operations = useMemo(() => {
    const granted = new Set(workCenter?.features ?? [])
    return catalogOperations.filter((operation) =>
      operation.requiredFeatures.every((feature) => granted.has(feature)),
    )
  }, [catalogOperations, workCenter])

  const [opId, setOpId] = useState<string>('')
  const firstOp = operations[0]?.id ?? ''
  useEffect(() => {
    setOpId(firstOp)
  }, [firstOp, row.id])

  if (top === undefined) {
    return (
      <div className={styles.knob}>
        <p className={styles.knobTitle}>Rate override</p>
        <p className={styles.knobNote}>
          Nothing runs here in this window, so there is no SKU to re-rate.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.knob}>
      <p className={styles.knobTitle}>
        Rate override · {top.code}
        <InfoTip>
          Rate and OEE are independent knobs whose product is the effective rate. This one replaces
          the routing&rsquo;s own times for one SKU at one operation on this work center; it does
          not touch OEE, and OEE does not touch it.
        </InfoTip>
      </p>
      <Select
        label="Operation"
        size="sm"
        value={opId}
        options={
          operations.length === 0
            ? [{ value: '', label: 'No operation this asset is capable of' }]
            : operations.map((operation) => ({
                value: operation.id,
                label: `${operation.code} — ${operation.name}`,
              }))
        }
        onChange={setOpId}
        hint="Which operation the new rate applies to."
      />
      <NumberField
        label="Eaches per hour"
        size="sm"
        value={rate}
        min={0}
        step={0.5}
        suffix="ea/h"
        disabled={opId === ''}
        onChange={(value) => {
          setRate(value)
          if (opId === '') return
          applyMove({
            kind: 'rateSet',
            materialId: top.materialId,
            workCenterId: row.id,
            opId,
            ratePerHour: value,
          })
        }}
        hint={`Observed over this window: ${compact(observed)} ea/h across ${fmtHours(top.hours, { compact: true })}.`}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// (e) Downtime
// ---------------------------------------------------------------------------

interface DowntimeRow {
  key: string
  /** Present only for events this scenario authored — the ones that are editable. */
  eventId: string | null
  kind: DowntimeKind
  status: DowntimeStatus | null
  label: string
  fromWeek: WeekIndex
  toWeek: WeekIndex
  pools: CapacityPool[] | null
  hours: number
  hoursPerWeek: number | undefined
  slipWeeks: number | undefined
  source: 'scenario' | 'master'
}

interface DowntimeDraft {
  eventId: string | null
  label: string
  kind: DowntimeKind
  status: DowntimeStatus
  fromWeek: number
  toWeek: number
  pools: 'machine' | 'labour' | 'both'
  blockEntirely: boolean
  hoursPerWeek: number
  slipWeeks: number
}

function poolsOf(choice: DowntimeDraft['pools']): CapacityPool[] {
  if (choice === 'both') return ['machine', 'labour']
  return [choice]
}

function poolChoiceOf(pools: CapacityPool[] | null): DowntimeDraft['pools'] {
  if (pools === null || pools.length === 0) return 'machine'
  if (pools.length > 1) return 'both'
  return at(pools, 0, 'pool')
}

interface DowntimeCardProps {
  row: RegisterRow
  detail: WorkCenterDetail | null
  scenarioMoves: ScenarioMove[]
  fromWeek: WeekIndex
  toWeek: WeekIndex
  lastWeek: WeekIndex
  weekLabel: (week: WeekIndex) => string
  applyMove: (move: Move, label?: string) => void
  stale: boolean
}

function DowntimeCard({
  row,
  detail,
  scenarioMoves,
  fromWeek,
  toWeek,
  lastWeek,
  weekLabel,
  applyMove,
  stale,
}: DowntimeCardProps) {
  const [draft, setDraft] = useState<DowntimeDraft | null>(null)

  const events = useMemo((): DowntimeRow[] => {
    // Events this scenario authored carry their whole shape, including the id
    // that makes them editable.
    const removed = new Set<string>()
    const authored = new Map<string, DowntimeEvent>()
    for (const entry of scenarioMoves) {
      if (!entry.enabled) continue
      if (entry.move.kind === 'downtimeUpsert') {
        if (entry.move.event.workCenterId !== row.id) continue
        authored.set(entry.move.event.id, entry.move.event)
      } else if (entry.move.kind === 'downtimeRemove') {
        removed.add(entry.move.eventId)
      }
    }
    for (const id of removed) authored.delete(id)

    const modelled = detail?.downtimeByWeek ?? []
    const hoursByLabel = new Map<string, number>()
    for (const entry of modelled) {
      const composite = `${entry.kind}|${entry.label}`
      hoursByLabel.set(composite, (hoursByLabel.get(composite) ?? 0) + entry.hours)
    }

    const out: DowntimeRow[] = []
    const claimed = new Set<string>()
    for (const event of authored.values()) {
      const composite = `${event.kind}|${event.label}`
      claimed.add(composite)
      out.push({
        key: event.id,
        eventId: event.id,
        kind: event.kind,
        status: event.status,
        label: event.label,
        fromWeek: event.fromWeek,
        toWeek: event.toWeek,
        pools: event.pools,
        hours: hoursByLabel.get(composite) ?? 0,
        hoursPerWeek: event.hoursPerWeek,
        slipWeeks: event.slipWeeks,
        source: 'scenario',
      })
    }

    // Master-data events arrive as modelled weeks. Consecutive weeks of the same
    // event are one row again.
    const runs = new Map<string, { from: number; to: number; hours: number }>()
    for (const entry of modelled) {
      const composite = `${entry.kind}|${entry.label}`
      if (claimed.has(composite)) continue
      const run = runs.get(composite)
      if (run === undefined) runs.set(composite, { from: entry.week, to: entry.week, hours: entry.hours })
      else {
        run.from = Math.min(run.from, entry.week)
        run.to = Math.max(run.to, entry.week)
        run.hours += entry.hours
      }
    }
    for (const [composite, run] of runs) {
      const [kind = 'maintenance', ...rest] = composite.split('|')
      out.push({
        key: composite,
        eventId: null,
        kind: kind as DowntimeKind,
        status: null,
        label: rest.join('|'),
        fromWeek: run.from,
        toWeek: run.to,
        pools: null,
        hours: run.hours,
        hoursPerWeek: undefined,
        slipWeeks: undefined,
        source: 'master',
      })
    }

    out.sort((a, b) => a.fromWeek - b.fromWeek || (a.label < b.label ? -1 : 1))
    return out
  }, [detail, row.id, scenarioMoves])

  const openNew = useCallback(() => {
    setDraft({
      eventId: null,
      label: `Planned stop — ${row.code}`,
      kind: 'maintenance',
      status: 'planned',
      fromWeek,
      toWeek: Math.min(fromWeek + 1, toWeek),
      pools: 'machine',
      blockEntirely: false,
      hoursPerWeek: 16,
      slipWeeks: 0,
    })
  }, [fromWeek, row.code, toWeek])

  const openEdit = useCallback((entry: DowntimeRow) => {
    if (entry.eventId === null) return
    setDraft({
      eventId: entry.eventId,
      label: entry.label,
      kind: entry.kind,
      status: entry.status ?? 'planned',
      fromWeek: entry.fromWeek,
      toWeek: entry.toWeek,
      pools: poolChoiceOf(entry.pools),
      blockEntirely: entry.hoursPerWeek === undefined,
      hoursPerWeek: entry.hoursPerWeek ?? 16,
      slipWeeks: entry.slipWeeks ?? 0,
    })
  }, [])

  const save = useCallback(() => {
    if (draft === null) return
    const event: DowntimeEvent = {
      id: draft.eventId ?? nextLocalId('dt'),
      workCenterId: row.id,
      kind: draft.kind,
      status: draft.status,
      fromWeek: Math.min(draft.fromWeek, draft.toWeek),
      toWeek: Math.max(draft.fromWeek, draft.toWeek),
      pools: poolsOf(draft.pools),
      hoursPerWeek: draft.blockEntirely ? undefined : draft.hoursPerWeek,
      label: draft.label.trim() === '' ? `Planned stop — ${row.code}` : draft.label.trim(),
      slipWeeks: draft.status === 'atRisk' ? draft.slipWeeks : undefined,
    }
    applyMove({ kind: 'downtimeUpsert', event })
    setDraft(null)
  }, [applyMove, draft, row.code, row.id])

  const columns = useMemo((): Array<DataTableColumn<DowntimeRow>> => {
    return [
      {
        key: 'kind',
        header: 'Kind',
        width: 140,
        sortValue: (entry) => entry.kind,
        render: (entry) => (
          <Badge size="sm" tone="neutral">
            {KIND_LABEL[entry.kind]}
          </Badge>
        ),
      },
      {
        key: 'label',
        header: 'Event',
        sortValue: (entry) => entry.label,
        render: (entry) => (
          <span className={styles.cellStack}>
            <span className={styles.cellName} title={entry.label}>
              {entry.label}
            </span>
            {entry.source === 'master' ? (
              <span className={styles.sourceNote}>master data</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        width: 148,
        sortValue: (entry) => entry.status ?? 'unknown',
        render: (entry) =>
          entry.status === null ? (
            <span className={styles.sourceNote}>not carried</span>
          ) : (
            <span className={styles.cellStack}>
              <Badge size="sm" tone={STATUS_TONE[entry.status]}>
                {STATUS_LABEL[entry.status]}
              </Badge>
              {entry.status === 'atRisk' && entry.slipWeeks !== undefined && entry.slipWeeks !== 0 ? (
                <span className={styles.sourceNote}>slips {entry.slipWeeks}w</span>
              ) : null}
            </span>
          ),
      },
      {
        key: 'weeks',
        header: 'Weeks',
        width: 168,
        sortValue: (entry) => entry.fromWeek,
        render: (entry) => (
          <span className={styles.numeric}>
            {weekLabel(entry.fromWeek)}
            {entry.toWeek === entry.fromWeek ? '' : ` – ${weekLabel(entry.toWeek)}`}
          </span>
        ),
      },
      {
        key: 'pools',
        header: 'Pools',
        width: 132,
        sortValue: (entry) => (entry.pools ?? []).join(','),
        render: (entry) =>
          entry.pools === null ? (
            <span className={styles.sourceNote}>not carried</span>
          ) : (
            <span className={styles.pool}>
              {entry.pools.map((pool) => (pool === 'labour' ? 'Labour' : 'Machine')).join(' + ')}
            </span>
          ),
      },
      {
        key: 'hours',
        header: 'Hours lost',
        align: 'right',
        width: 108,
        sortValue: (entry) => entry.hours,
        render: (entry) => <span className={styles.numeric}>{fmtHours(entry.hours)}</span>,
      },
      {
        key: 'actions',
        header: 'Actions',
        align: 'right',
        width: 150,
        render: (entry) =>
          entry.eventId === null ? (
            <span className={styles.sourceNote}>read-only</span>
          ) : (
            <span className={styles.inlineActions}>
              <Button size="sm" variant="ghost" icon="sliders" onClick={() => openEdit(entry)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                onClick={() =>
                  applyMove({ kind: 'downtimeRemove', eventId: entry.eventId ?? '' })
                }
              >
                Remove
              </Button>
            </span>
          ),
      },
    ]
  }, [applyMove, openEdit, weekLabel])

  const weekOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = []
    for (let w = 0; w <= lastWeek; w += 1) options.push({ value: String(w), label: weekLabel(w) })
    return options
  }, [lastWeek, weekLabel])

  return (
    <Card
      title="Downtime"
      subtitle="Dated, planned loss. Unplanned loss has no date and lives inside OEE."
      stale={stale}
      aside={
        <Button size="sm" variant="primary" icon="plus" onClick={openNew}>
          Add event
        </Button>
      }
      flush
    >
      <DataTable<DowntimeRow>
        caption={`Planned downtime at ${row.code}: kind, status, the weeks it occupies, the pools it blocks and the hours it removes.`}
        columns={columns}
        rows={events}
        rowKey={(entry) => entry.key}
        initialSort={{ key: 'weeks', dir: 'asc' }}
        maxHeight={320}
        empty={
          <EmptyState
            icon="clock"
            title="No planned downtime in this window"
            description="Nothing is scheduled to stop this work center in the filtered weeks."
            action={
              <Button variant="primary" icon="plus" onClick={openNew}>
                Add event
              </Button>
            }
          />
        }
      />

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.eventId === null ? 'Add a downtime event' : 'Edit this downtime event'}
        description="Planned capacity loss, dated. Applies immediately and is undoable."
        width={620}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" icon="check" onClick={save}>
              {draft?.eventId === null ? 'Add event' : 'Save event'}
            </Button>
          </>
        }
      >
        {draft === null ? null : (
          <div className={styles.form}>
            <TextField
              label="Label"
              className={styles.formWide}
              value={draft.label}
              onChange={(label) => setDraft({ ...draft, label })}
              hint="What a planner will read on the calendar."
            />
            <Select
              label="Kind"
              value={draft.kind}
              options={(Object.keys(KIND_LABEL) as DowntimeKind[]).map((kind) => ({
                value: kind,
                label: KIND_LABEL[kind],
              }))}
              onChange={(kind) => setDraft({ ...draft, kind: kind as DowntimeKind })}
            />
            <Select
              label="Status"
              value={draft.status}
              options={(Object.keys(STATUS_LABEL) as DowntimeStatus[]).map((status) => ({
                value: status,
                label: STATUS_LABEL[status],
              }))}
              onChange={(status) => setDraft({ ...draft, status: status as DowntimeStatus })}
            />
            <Select
              label="First week"
              value={String(draft.fromWeek)}
              options={weekOptions}
              onChange={(value) => setDraft({ ...draft, fromWeek: Number(value) })}
            />
            <Select
              label="Last week"
              value={String(draft.toWeek)}
              options={weekOptions}
              onChange={(value) => setDraft({ ...draft, toWeek: Number(value) })}
            />
            <SegmentedControl<DowntimeDraft['pools']>
              label="Pools blocked"
              value={draft.pools}
              options={[
                { value: 'machine', label: 'Machine' },
                { value: 'labour', label: 'Labour' },
                { value: 'both', label: 'Both' },
              ]}
              onChange={(pools) => setDraft({ ...draft, pools })}
            />
            <SegmentedControl<'partial' | 'whole'>
              label="Extent"
              value={draft.blockEntirely ? 'whole' : 'partial'}
              options={[
                { value: 'partial', label: 'Hours per week' },
                { value: 'whole', label: 'Whole week' },
              ]}
              onChange={(extent) => setDraft({ ...draft, blockEntirely: extent === 'whole' })}
            />
            {draft.blockEntirely ? null : (
              <NumberField
                label="Hours removed per week"
                value={draft.hoursPerWeek}
                min={0}
                step={1}
                suffix="h"
                onChange={(hoursPerWeek) => setDraft({ ...draft, hoursPerWeek })}
              />
            )}
            {draft.status === 'atRisk' ? (
              <NumberField
                label="Slip being modelled"
                value={draft.slipWeeks}
                min={0}
                step={1}
                suffix="weeks"
                onChange={(slipWeeks) => setDraft({ ...draft, slipWeeks })}
                hint="An at-risk event is modelled in its slipped position."
              />
            ) : null}
            <p className={styles.formNote}>
              A shutdown blocks the pool entirely; a maintenance window removes a number of hours.
              Vacation hits labour, maintenance hits machine — which is why the two pools are
              separate objects.
            </p>
          </div>
        )}
      </Modal>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// (f) Shared capacity
// ---------------------------------------------------------------------------

interface SiblingRow {
  workCenterId: WorkCenterId
  code: string
  plantCode: string
  plantSlot: Slot
  basis: 'approved' | 'featureCapable' | 'retrofit'
  sharedOperations: number
  utilisation: number
}

interface SharedCapacityCardProps {
  row: RegisterRow
  detail: WorkCenterDetail | null
  fromWeek: WeekIndex
  toWeek: WeekIndex
  applyMove: (move: Move, label?: string) => void
  stale: boolean
}

function SharedCapacityCard({
  row,
  detail,
  fromWeek,
  toWeek,
  applyMove,
  stale,
}: SharedCapacityCardProps) {
  const catalog = useUiStore((state) => state.catalog)
  const plantSlot = usePlantSlot()
  const [share, setShare] = useState<'0.25' | '0.5' | '1'>('0.5')
  const [dual, setDual] = useState<'single' | 'dual'>('single')

  const siblings = useMemo((): SiblingRow[] => {
    const byId = new Map((catalog?.workCenters ?? []).map((wc) => [wc.id, wc]))
    const plantById = new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant]))
    return (detail?.siblings ?? []).map((sibling) => {
      const wc = byId.get(sibling.workCenterId)
      const plant = wc === undefined ? undefined : plantById.get(wc.plantId)
      return {
        workCenterId: sibling.workCenterId,
        code: wc?.code ?? sibling.workCenterId,
        plantCode: plant?.code ?? '—',
        plantSlot: wc === undefined ? 1 : plantSlot(wc.plantId),
        basis: sibling.basis,
        sharedOperations: sibling.sharedOperations,
        utilisation: sibling.utilisation,
      }
    })
  }, [catalog, detail, plantSlot])

  const moveHere = useCallback(
    (sibling: SiblingRow) => {
      applyMove({
        kind: 'resourceMove',
        selector: { kind: 'all' },
        fromWorkCenterId: sibling.workCenterId,
        toWorkCenterId: row.id,
        fromWeek,
        toWeek,
        share: Number(share),
        allowDualSource: dual === 'dual',
      })
    },
    [applyMove, dual, fromWeek, row.id, share, toWeek],
  )

  const columns = useMemo((): Array<DataTableColumn<SiblingRow>> => {
    return [
      {
        key: 'plant',
        header: 'Plant',
        width: 92,
        sortValue: (sibling) => sibling.plantCode,
        render: (sibling) => <Chip slot={sibling.plantSlot}>{sibling.plantCode}</Chip>,
      },
      {
        key: 'code',
        header: 'Work center',
        width: 130,
        sortValue: (sibling) => sibling.code,
        render: (sibling) => <span className={styles.stepStrong}>{sibling.code}</span>,
      },
      {
        key: 'shared',
        header: 'Shared operations',
        align: 'right',
        width: 150,
        sortValue: (sibling) => sibling.sharedOperations,
        render: (sibling) => <span className={styles.numeric}>{sibling.sharedOperations}</span>,
      },
      {
        key: 'basis',
        header: 'Basis',
        width: 150,
        sortValue: (sibling) => sibling.basis,
        render: (sibling) => (
          <Badge size="sm" tone={BASIS_TONE[sibling.basis]}>
            {BASIS_LABEL[sibling.basis]}
          </Badge>
        ),
      },
      {
        key: 'utilisation',
        header: 'Utilisation',
        align: 'right',
        width: 110,
        sortValue: (sibling) => sibling.utilisation,
        render: (sibling) => <span className={styles.numeric}>{pct(sibling.utilisation, 0)}</span>,
      },
      {
        key: 'action',
        header: 'Actions',
        align: 'right',
        width: 160,
        render: (sibling) => (
          <span className={styles.inlineActions}>
            <Button size="sm" variant="primary" icon="drag" onClick={() => moveHere(sibling)}>
              Move load here
            </Button>
          </span>
        ),
      },
    ]
  }, [moveHere])

  return (
    <Card
      title="Shared capacity"
      subtitle={`Work centers that can run the same operations as ${row.code}`}
      stale={stale}
      flush
      aside={
        <div className={styles.controlRow}>
          <SegmentedControl<'0.25' | '0.5' | '1'>
            label="Share to move"
            size="sm"
            value={share}
            options={[
              { value: '0.25', label: '25%' },
              { value: '0.5', label: '50%' },
              { value: '1', label: 'All' },
            ]}
            onChange={setShare}
          />
          <SegmentedControl<'single' | 'dual'>
            label="Sourcing"
            size="sm"
            value={dual}
            options={[
              { value: 'single', label: 'Single source', hint: 'reject any bucket that would end up with two sources' },
              { value: 'dual', label: 'Allow dual', hint: 'two sources in one bucket is a different approval' },
            ]}
            onChange={setDual}
          />
        </div>
      }
    >
      <DataTable<SiblingRow>
        caption={`Shared-capacity links for ${row.code}: how many operations each sibling shares, on what basis, and how loaded it already is.`}
        columns={columns}
        rows={siblings}
        rowKey={(sibling) => sibling.workCenterId}
        initialSort={{ key: 'shared', dir: 'desc' }}
        maxHeight={320}
        empty={
          <EmptyState
            icon="machine"
            title="Nothing else can run these operations"
            description="No other work center in the snapshot shares an operation with this one — not approved, not feature-capable, not with a retrofit."
          />
        }
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// (g) Top materials
// ---------------------------------------------------------------------------

interface MaterialRow {
  materialId: string
  code: string
  description: string
  groupLabel: string
  units: number
  hours: number
}

function TopMaterialsCard({ row }: { row: RegisterRow }) {
  const catalog = useUiStore((state) => state.catalog)
  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState<'hours' | 'units' | 'code'>('hours')

  useEffect(() => {
    setPage(0)
  }, [row.id, sortBy])

  const slice = useMaterialSlice({
    workCenterId: row.id,
    offset: page * MATERIAL_PAGE,
    limit: MATERIAL_PAGE,
    sortBy,
  })

  const groupName = useMemo(() => {
    const map = new Map((catalog?.groups ?? []).map((group) => [group.id, group.name]))
    return (groupId: string): string => map.get(groupId) ?? groupId
  }, [catalog])

  const rows = useMemo((): MaterialRow[] => {
    return (slice.data?.rows ?? []).map((entry) => ({
      materialId: entry.materialId,
      code: entry.code,
      description: entry.description,
      groupLabel: groupName(entry.groupId),
      units: entry.units,
      hours: entry.hours,
    }))
  }, [groupName, slice.data])

  const total = slice.data?.total ?? 0
  const first = total === 0 ? 0 : page * MATERIAL_PAGE + 1
  const last = Math.min(total, (page + 1) * MATERIAL_PAGE)

  const columns = useMemo((): Array<DataTableColumn<MaterialRow>> => {
    return [
      { key: 'code', header: 'Material', width: 130, render: (entry) => <span className={styles.stepStrong}>{entry.code}</span> },
      {
        key: 'description',
        header: 'Description',
        render: (entry) => (
          <span className={styles.cellName} title={entry.description}>
            {entry.description}
          </span>
        ),
      },
      { key: 'group', header: 'Product group', width: 200, render: (entry) => entry.groupLabel },
      {
        key: 'units',
        header: 'Units',
        align: 'right',
        width: 120,
        render: (entry) => <span className={styles.numeric}>{fmtUnits(entry.units, { compact: true })}</span>,
      },
      {
        key: 'hours',
        header: 'Hours',
        align: 'right',
        width: 120,
        render: (entry) => <span className={styles.numeric}>{fmtHours(entry.hours, { compact: true })}</span>,
      },
    ]
  }, [])

  return (
    <Card
      title="Top materials"
      subtitle={`The SKUs behind the hours on ${row.code}`}
      stale={slice.loading && slice.data !== null}
      aside={
        <SegmentedControl<'hours' | 'units' | 'code'>
          label="Order by"
          size="sm"
          value={sortBy}
          options={[
            { value: 'hours', label: 'Hours' },
            { value: 'units', label: 'Units' },
            { value: 'code', label: 'Code' },
          ]}
          onChange={setSortBy}
        />
      }
    >
      {slice.error !== null ? (
        <ErrorState message={slice.error} detail="The SKU page could not be fetched." />
      ) : (
        <>
          <DataTable<MaterialRow>
            caption={`One page of the materials that run on ${row.code}, with the units placed and the hours they consume.`}
            columns={columns}
            rows={rows}
            rowKey={(entry) => entry.materialId}
            maxHeight={380}
            stale={slice.loading && slice.data !== null}
            empty={
              <EmptyState
                icon="product"
                title="No SKU runs here in this window"
                description="The supply plan places nothing on this work center under the current filter."
              />
            }
          />
          <div className={styles.pager}>
            <span className={styles.pagerLabel}>
              {total === 0 ? 'Nothing to page through' : `Showing ${first}–${last} of ${fmtUnits(total)}`}
            </span>
            <span className={styles.pagerButtons}>
              <Button
                size="sm"
                variant="ghost"
                icon="chevronLeft"
                disabled={page === 0}
                onClick={() => setPage((prior) => Math.max(0, prior - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                iconRight="chevronRight"
                disabled={last >= total}
                onClick={() => setPage((prior) => prior + 1)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </Card>
  )
}
