/**
 * The cockpit — where is the network in trouble, and what is it costing us?
 *
 * The screen answers that question in one downward read: the network's
 * utilisation and its consequences at the top, the ceiling that judges every
 * cell directly above the grid that shows it, then the grid itself, then the two
 * charts that explain the grid (hours against capacity, and the plan against
 * demand), then the ranked list of work centers in trouble, and finally — only
 * once one is selected — somewhere else the load could go.
 *
 * Three things worth knowing before changing anything here:
 *
 * 1. **The grid is asset-level and the roll-ups are product-sliced.** A product
 *    filter narrows the hours attributed to a slice, but a machine is not less
 *    full because you are looking at one group. The utilisation grid, the peak
 *    and the cell counts therefore all use the engine's judged cell exactly as
 *    `kpiPass` does, so the number in the tile and the colour in the grid can
 *    never disagree.
 *
 * 2. **Nothing SKU-sized crosses into React.** The one dense structure this
 *    screen builds is work-center x bucket — 150 x 78 at worst — and it is built
 *    as `Float64Array`s indexed `row * bucketCount + bucket`, never as an array
 *    of objects, and never held in state.
 *
 * 3. **The ceiling slider is a move.** It applies immediately and it is
 *    undoable, like every other change in this product. The readout tracks the
 *    handle at pointer speed while the move is committed once the drag settles,
 *    so a drag across forty values leaves one step on the undo stack rather than
 *    forty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Bottleneck,
  CapacityPool,
  GroupId,
  ReliefCandidate,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import { clamp, key as compositeKey, safeDiv } from '@/domain/lookup'
import { DEFAULT_UTILISATION_CEILING } from '@/domain/engine'
import {
  compact,
  hours as formatHours,
  monthLong,
  monthShort,
  pct,
  signed,
  units as formatUnits,
} from '@/lib/format'
import {
  ChartCard,
  HeroFigure,
  LineChart,
  Meter,
  StackedBarChart,
  StatTile,
  UtilisationGrid,
} from '@/charts'
import type {
  ChartStatusLevel,
  StackedBarSeries,
  StatTileProps,
  TableViewProps,
  TimeSeries,
  UtilisationGridRow,
  UtilisationGridSort,
} from '@/charts/types'
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  InfoTip,
  Pill,
  SegmentedControl,
  Slider,
} from '@/components'
import type { BadgeTone } from '@/components'
import { FilterBar } from '@/components/FilterBar'
import { useModelResult, usePlantSlot, useRelief, useRollup } from '@/state/model'
import { useActiveScenario, useUiStore } from '@/state/store'
import styles from '@/routes/Cockpit.module.css'

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** `noUncheckedIndexedAccess` covers typed arrays too. Read through this. */
function f64(array: Float64Array, index: number): number {
  const value = array[index]
  return value === undefined ? 0 : value
}

function i32(array: Int32Array, index: number): number {
  const value = array[index]
  return value === undefined ? -1 : value
}

function numberAt(list: readonly number[], index: number): number {
  const value = list[index]
  return value === undefined ? 0 : value
}

/**
 * Squash a per-bucket series down to something a 76px sparkline can draw.
 *
 * A spark with 78 bars in 76 pixels is a smear, so long series are folded into
 * equal chunks. Counts and hours fold by `sum`, ratios by `mean`, and a peak by
 * `max` — folding a peak by averaging would quietly hide the week that matters.
 */
function condense(values: number[], target: number, how: 'sum' | 'mean' | 'max'): number[] {
  if (values.length <= target || target <= 0) return values
  const out: number[] = []
  const size = values.length / target
  for (let chunk = 0; chunk < target; chunk += 1) {
    const from = Math.floor(chunk * size)
    const to = Math.min(values.length, Math.max(from + 1, Math.floor((chunk + 1) * size)))
    let total = 0
    let peak = 0
    let count = 0
    for (let i = from; i < to; i += 1) {
      const value = numberAt(values, i)
      total += value
      count += 1
      if (value > peak) peak = value
    }
    out.push(how === 'sum' ? total : how === 'max' ? peak : count === 0 ? 0 : total / count)
  }
  return out
}

type Delta = NonNullable<StatTileProps['delta']>

/**
 * The delta every tile shows: the last bucket in view against the first.
 *
 * Colour comes from direction against intent, never from the raw sign, and the
 * glyph plus the signed text mean the direction survives without colour.
 */
function deltaOf(
  first: number,
  last: number,
  format: (value: number) => string,
  goodDirection: 'up' | 'down',
  epsilon = 0,
): Delta | undefined {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined
  const diff = last - first
  const direction: Delta['direction'] =
    Math.abs(diff) <= epsilon ? 'flat' : diff > 0 ? 'up' : 'down'
  return { value: signed(diff, format), direction, goodDirection }
}

function utilisationStatus(value: number): { level: ChartStatusLevel; label: string } {
  if (value > 1) return { level: 'critical', label: 'Over the ceiling' }
  if (value > 0.95) return { level: 'serious', label: 'At the ceiling' }
  if (value > 0.85) return { level: 'warning', label: 'Tight' }
  return { level: 'good', label: 'Within the ceiling' }
}

const SEVERITY_TONE: Record<Bottleneck['severity'], BadgeTone> = {
  critical: 'critical',
  tight: 'serious',
  watch: 'warning',
}

const SEVERITY_LABEL: Record<Bottleneck['severity'], string> = {
  critical: 'Critical',
  tight: 'Tight',
  watch: 'Watch',
}

const BASIS_TONE: Record<ReliefCandidate['basis'], BadgeTone> = {
  approved: 'good',
  featureCapable: 'warning',
  retrofit: 'serious',
}

const BASIS_LABEL: Record<ReliefCandidate['basis'], string> = {
  approved: 'Approved',
  featureCapable: 'Needs qualification',
  retrofit: 'Needs retrofit',
}

const BASIS_RANK: Record<ReliefCandidate['basis'], number> = {
  approved: 0,
  featureCapable: 1,
  retrofit: 2,
}

const POOL_LABEL: Record<CapacityPool, string> = {
  machine: 'Machine bound',
  labour: 'Labour bound',
}

type PoolView = 'both' | 'machine' | 'labour'

/** Rows the table twin of the grid will emit before it stops. */
const MAX_GRID_TABLE_ROWS = 900
const MAX_BOTTLENECK_ROWS = 10
const CEILING_MIN = 0.6
const CEILING_MAX = 1.1
/** Long enough to swallow a drag, short enough that the model follows it. */
const CEILING_COMMIT_MS = 180

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

interface Bucket {
  /** Stable identity — also the chart category and the React key. */
  key: string
  label: string
  longLabel: string
  /** First week of the bucket inside the window. Selection points here. */
  firstWeek: number
}

function shortWeekLabel(iso: string): string {
  const dash = iso.indexOf('-')
  return dash === -1 ? iso : iso.slice(dash + 1)
}

function quarterShort(quarter: string): string {
  const dash = quarter.indexOf('-')
  if (dash === -1) return quarter
  return `${quarter.slice(dash + 1)} ${quarter.slice(2, dash)}`
}

function quarterLong(quarter: string): string {
  const dash = quarter.indexOf('-')
  if (dash === -1) return quarter
  return `${quarter.slice(dash + 1)} ${quarter.slice(0, dash)}`
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function Cockpit() {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const selection = useUiStore((state) => state.selection)
  const setSelection = useUiStore((state) => state.setSelection)
  const applyMove = useUiStore((state) => state.applyMove)
  const scenario = useActiveScenario()
  const plantSlot = usePlantSlot()

  const result = useModelResult()
  const plantRollup = useRollup('plant')
  const relief = useRelief(selection.workCenterId)

  const [poolView, setPoolView] = useState<PoolView>('both')
  const [sort, setSort] = useState<UtilisationGridSort>({ by: 'peak', direction: 'desc' })
  const [ceilingDraft, setCeilingDraft] = useState<number | null>(null)
  const [revealSeq, setRevealSeq] = useState(0)
  const reliefRef = useRef<HTMLDivElement | null>(null)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- catalog lookups ------------------------------------------------------

  const plantById = useMemo(
    () => new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant])),
    [catalog],
  )
  const classById = useMemo(
    () => new Map((catalog?.machineClasses ?? []).map((entry) => [entry.id, entry])),
    [catalog],
  )
  const groupById = useMemo(
    () => new Map((catalog?.groups ?? []).map((group) => [group.id, group])),
    [catalog],
  )
  const workCenterById = useMemo(
    () => new Map((catalog?.workCenters ?? []).map((wc) => [wc.id, wc])),
    [catalog],
  )

  const groupName = useCallback(
    (groupId: GroupId): string => {
      const group = groupById.get(groupId)
      return group === undefined ? groupId : group.name
    },
    [groupById],
  )

  const plantLabelOf = useCallback(
    (plantId: string): string => {
      const plant = plantById.get(plantId)
      return plant === undefined ? plantId : `${plant.code} · ${plant.city}`
    },
    [plantById],
  )

  // --- the bucket axis ------------------------------------------------------

  const axis = useMemo(() => {
    const time = catalog?.time
    const weekCount = time?.weeks.length ?? 0
    const bucketOfWeek = new Int32Array(Math.max(weekCount, 1)).fill(-1)
    const buckets: Bucket[] = []
    if (time === undefined || weekCount === 0) return { buckets, bucketOfWeek }

    const lastWeek = weekCount - 1
    const from = clamp(Math.floor(filters.fromWeek), 0, lastWeek)
    const to = clamp(Math.floor(filters.toWeek), from, lastWeek)
    const seen = new Map<string, number>()

    for (let week = from; week <= to; week += 1) {
      const iso = time.weeks[week] ?? `week-${week}`
      const month = time.monthOfWeek[week] ?? iso
      const quarter = time.quarterOfWeek[week] ?? iso
      const bucketKey =
        filters.bucket === 'week' ? iso : filters.bucket === 'month' ? month : quarter
      let index = seen.get(bucketKey)
      if (index === undefined) {
        index = buckets.length
        seen.set(bucketKey, index)
        buckets.push({
          key: bucketKey,
          label:
            filters.bucket === 'week'
              ? shortWeekLabel(iso)
              : filters.bucket === 'month'
                ? monthShort(month)
                : quarterShort(quarter),
          longLabel:
            filters.bucket === 'week'
              ? iso
              : filters.bucket === 'month'
                ? monthLong(month)
                : quarterLong(quarter),
          firstWeek: week,
        })
      }
      bucketOfWeek[week] = index
    }
    return { buckets, bucketOfWeek }
  }, [catalog, filters.bucket, filters.fromWeek, filters.toWeek])

  const buckets = axis.buckets
  const bucketCount = buckets.length
  const bucketKeys = useMemo(() => buckets.map((bucket) => bucket.key), [buckets])
  const labelByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const bucket of buckets) map.set(bucket.key, bucket.label)
    return map
  }, [buckets])
  const bucketLabel = useCallback(
    (bucketKey: string): string => labelByKey.get(bucketKey) ?? bucketKey,
    [labelByKey],
  )

  // --- the ceiling in force -------------------------------------------------

  const scenarioCeiling = useMemo(() => {
    let ceiling = DEFAULT_UTILISATION_CEILING
    const ordered = scenario.moves.slice().sort((a, b) => a.seq - b.seq)
    for (const entry of ordered) {
      if (!entry.enabled) continue
      if (entry.move.kind === 'utilisationCeiling' && entry.move.scope === 'global') {
        ceiling = entry.move.ceiling
      }
    }
    // Deliberately NOT clamped to the slider's range: a ceiling set elsewhere
    // (a plant-scope policy, a scenario built on another screen) must read
    // truthfully here even when the handle can only pin to the end of its track.
    return ceiling
  }, [scenario])

  const shownCeiling = ceilingDraft ?? scenarioCeiling

  useEffect(() => {
    return () => {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current)
    }
  }, [])

  const onCeilingChange = useCallback(
    (next: number) => {
      setCeilingDraft(next)
      if (commitTimer.current !== null) clearTimeout(commitTimer.current)
      commitTimer.current = setTimeout(() => {
        commitTimer.current = null
        applyMove(
          { kind: 'utilisationCeiling', scope: 'global', ceiling: next },
          `Utilisation ceiling ${pct(next, 0)} across the network`,
        )
        setCeilingDraft(null)
      }, CEILING_COMMIT_MS)
    },
    [applyMove],
  )

  // --- work-center x bucket, as typed arrays --------------------------------

  const grid = useMemo(() => {
    const rows: UtilisationGridRow[] = []
    const source: WorkCenter[] = catalog?.workCenters ?? []
    const wantedWorkCenters =
      filters.workCenterIds.length > 0 ? new Set(filters.workCenterIds) : null
    const wantedClasses =
      filters.machineClassIds.length > 0 ? new Set(filters.machineClassIds) : null
    const wantedRegions = filters.regions.length > 0 ? new Set<string>(filters.regions) : null
    const wantedPlants = filters.plantIds.length > 0 ? new Set(filters.plantIds) : null

    const rowIndexById = new Map<WorkCenterId, number>()
    for (const wc of source) {
      if (wantedWorkCenters !== null && !wantedWorkCenters.has(wc.id)) continue
      if (wantedClasses !== null && !wantedClasses.has(wc.classId)) continue
      if (wantedPlants !== null && !wantedPlants.has(wc.plantId)) continue
      const plant = plantById.get(wc.plantId)
      if (wantedRegions !== null && (plant === undefined || !wantedRegions.has(plant.region))) {
        continue
      }
      rowIndexById.set(wc.id, rows.length)
      rows.push({
        id: wc.id,
        code: wc.code,
        name: wc.name,
        plantId: wc.plantId,
        plantLabel: plant?.name ?? wc.plantId,
        plantSlot: plant?.colorSlot ?? 1,
        machineClass: classById.get(wc.classId)?.name ?? wc.classId,
        peakUtilisation: 0,
      })
    }

    const cellCount = Math.max(1, rows.length * bucketCount)
    const machineRequired = new Float64Array(cellCount)
    const machineCapacity = new Float64Array(cellCount)
    const labourRequired = new Float64Array(cellCount)
    const labourCapacity = new Float64Array(cellCount)
    const downtimeHours = new Float64Array(cellCount)
    const eventLabels = new Map<string, string>()

    for (const cell of result.data?.cells ?? []) {
      const row = rowIndexById.get(cell.workCenterId)
      if (row === undefined) continue
      const bucket = i32(axis.bucketOfWeek, cell.week)
      if (bucket < 0) continue
      const index = row * bucketCount + bucket
      machineRequired[index] = f64(machineRequired, index) + cell.machineRequired
      machineCapacity[index] = f64(machineCapacity, index) + cell.machineAvailable * cell.ceiling
      labourRequired[index] = f64(labourRequired, index) + cell.labourRequired
      labourCapacity[index] = f64(labourCapacity, index) + cell.labourAvailable * cell.ceiling
      downtimeHours[index] = f64(downtimeHours, index) + cell.downtimeHours
      const firstEvent = cell.events[0]
      if (firstEvent !== undefined) {
        const mapKey = compositeKey(cell.workCenterId, bucket)
        if (!eventLabels.has(mapKey)) eventLabels.set(mapKey, firstEvent)
      }
    }

    const utilisation = new Float64Array(cellCount)
    const machineUtilisation = new Float64Array(cellCount)
    const labourUtilisation = new Float64Array(cellCount)
    const availableHours = new Float64Array(cellCount)
    const requiredHours = new Float64Array(cellCount)
    const bindingPool = new Uint8Array(cellCount)

    for (let row = 0; row < rows.length; row += 1) {
      let peak = 0
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const index = row * bucketCount + bucket
        const machineUtil = safeDiv(f64(machineRequired, index), f64(machineCapacity, index))
        const labourUtil = safeDiv(f64(labourRequired, index), f64(labourCapacity, index))
        machineUtilisation[index] = machineUtil
        labourUtilisation[index] = labourUtil
        const labourBinds = labourUtil > machineUtil
        bindingPool[index] = labourBinds ? 1 : 0
        const shown =
          poolView === 'machine'
            ? machineUtil
            : poolView === 'labour'
              ? labourUtil
              : Math.max(machineUtil, labourUtil)
        utilisation[index] = shown
        const useLabour = poolView === 'labour' || (poolView === 'both' && labourBinds)
        availableHours[index] = useLabour
          ? f64(labourCapacity, index)
          : f64(machineCapacity, index)
        requiredHours[index] = useLabour
          ? f64(labourRequired, index)
          : f64(machineRequired, index)
        if (shown > peak) peak = shown
      }
      const entry = rows[row]
      if (entry !== undefined) entry.peakUtilisation = peak
    }

    return {
      rows,
      utilisation,
      machineUtilisation,
      labourUtilisation,
      availableHours,
      requiredHours,
      bindingPool,
      downtimeHours,
      eventLabels,
    }
  }, [axis.bucketOfWeek, bucketCount, catalog, classById, filters, plantById, poolView, result.data])

  // --- the table twin for the grid -----------------------------------------

  const gridTable = useMemo<TableViewProps>(() => {
    const order = grid.rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => b.row.peakUtilisation - a.row.peakUtilisation)
    const rows: Array<Record<string, string | number>> = []
    let shownWorkCenters = 0
    for (const { row, index } of order) {
      if (rows.length + bucketCount > MAX_GRID_TABLE_ROWS && rows.length > 0) break
      shownWorkCenters += 1
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const cell = index * bucketCount + bucket
        const entry = buckets[bucket]
        rows.push({
          workCenter: `${row.code} · ${row.name}`,
          plant: row.plantLabel,
          bucket: entry?.longLabel ?? String(bucket),
          utilisation: pct(f64(grid.utilisation, cell)),
          required: formatHours(f64(grid.requiredHours, cell), { compact: true }),
          available: formatHours(f64(grid.availableHours, cell), { compact: true }),
          binding: grid.bindingPool[cell] === 1 ? 'Labour' : 'Machine',
          downtime: formatHours(f64(grid.downtimeHours, cell), { compact: true }),
        })
      }
    }
    const capped = shownWorkCenters < grid.rows.length
    return {
      caption: capped
        ? `Utilisation against the ceiling for the ${shownWorkCenters} most loaded of ${grid.rows.length} work centers, by ${filters.bucket}.`
        : `Utilisation against the ceiling for ${grid.rows.length} work centers, by ${filters.bucket}.`,
      columns: [
        { key: 'workCenter', label: 'Work center' },
        { key: 'plant', label: 'Plant' },
        { key: 'bucket', label: 'Bucket' },
        { key: 'utilisation', label: 'Against ceiling', align: 'right' },
        { key: 'required', label: 'Required', align: 'right' },
        { key: 'available', label: 'Available', align: 'right' },
        { key: 'binding', label: 'Binding pool' },
        { key: 'downtime', label: 'Downtime', align: 'right' },
      ],
      rows,
    }
  }, [buckets, bucketCount, filters.bucket, grid])

  // --- per-bucket KPI series ------------------------------------------------

  const series = useMemo(() => {
    const empty = (): number[] => new Array<number>(bucketCount).fill(0)
    const requiredHours = empty()
    const availableHours = empty()
    const supplyUnits = empty()
    const demandUnits = empty()
    const shortfallUnits = empty()
    const planGapUnits = empty()
    const overloadedCells = empty()
    const machineBoundCells = empty()
    const labourBoundCells = empty()
    const downtimeHours = empty()
    const peakUtilisation = empty()

    for (const week of result.data?.kpisByWeek ?? []) {
      const bucket = i32(axis.bucketOfWeek, week.week)
      if (bucket < 0 || bucket >= bucketCount) continue
      requiredHours[bucket] = numberAt(requiredHours, bucket) + week.requiredHours
      availableHours[bucket] = numberAt(availableHours, bucket) + week.availableHours
      supplyUnits[bucket] = numberAt(supplyUnits, bucket) + week.supplyUnits
      demandUnits[bucket] = numberAt(demandUnits, bucket) + week.demandUnits
      shortfallUnits[bucket] = numberAt(shortfallUnits, bucket) + week.shortfallUnits
      planGapUnits[bucket] = numberAt(planGapUnits, bucket) + week.planGapUnits
      overloadedCells[bucket] = numberAt(overloadedCells, bucket) + week.overloadedCells
      machineBoundCells[bucket] = numberAt(machineBoundCells, bucket) + week.machineBoundCells
      labourBoundCells[bucket] = numberAt(labourBoundCells, bucket) + week.labourBoundCells
      downtimeHours[bucket] = numberAt(downtimeHours, bucket) + week.downtimeHours
      peakUtilisation[bucket] = Math.max(numberAt(peakUtilisation, bucket), week.peakUtilisation)
    }

    const utilisation = requiredHours.map((required, index) =>
      safeDiv(required, numberAt(availableHours, index)),
    )
    const producedUnits = supplyUnits.map((supply, index) =>
      Math.max(0, supply - numberAt(shortfallUnits, index)),
    )
    const machineShare = machineBoundCells.map((machine, index) =>
      safeDiv(machine, machine + numberAt(labourBoundCells, index)),
    )

    return {
      requiredHours,
      availableHours,
      supplyUnits,
      demandUnits,
      shortfallUnits,
      planGapUnits,
      overloadedCells,
      machineBoundCells,
      labourBoundCells,
      downtimeHours,
      peakUtilisation,
      utilisation,
      producedUnits,
      machineShare,
    }
  }, [axis.bucketOfWeek, bucketCount, result.data])

  const first = 0
  const last = Math.max(0, bucketCount - 1)
  const firstBucket = buckets[first]
  const lastBucket = buckets[last]
  const deltaContext =
    firstBucket === undefined || lastBucket === undefined || firstBucket === lastBucket
      ? 'across the window'
      : `${firstBucket.label} → ${lastBucket.label}`

  // --- load against capacity, by plant --------------------------------------

  const plantBars = useMemo(() => {
    const cells = plantRollup.data?.cells ?? []
    const requiredByPlant = new Map<string, number[]>()
    const capacity = new Array<number>(bucketCount).fill(0)
    for (const cell of cells) {
      const bucket = i32(axis.bucketOfWeek, cell.week)
      if (bucket < 0 || bucket >= bucketCount) continue
      let row = requiredByPlant.get(cell.key)
      if (row === undefined) {
        row = new Array<number>(bucketCount).fill(0)
        requiredByPlant.set(cell.key, row)
      }
      row[bucket] = numberAt(row, bucket) + cell.requiredHours
      capacity[bucket] = numberAt(capacity, bucket) + cell.availableHours
    }

    const barSeries: StackedBarSeries[] = []
    for (const plant of catalog?.plants ?? []) {
      const values = requiredByPlant.get(plant.id)
      if (values === undefined) continue
      barSeries.push({
        id: plant.id,
        label: `${plant.code} · ${plant.city}`,
        slot: plant.colorSlot,
        markShape: 'rect',
        values,
      })
    }
    return { series: barSeries, capacity }
  }, [axis.bucketOfWeek, bucketCount, catalog, plantRollup.data])

  const plantTable = useMemo<TableViewProps>(() => {
    const rows = buckets.map((bucket, index) => {
      const row: Record<string, string | number> = { bucket: bucket.longLabel }
      let total = 0
      for (const entry of plantBars.series) {
        const value = numberAt(entry.values, index)
        total += value
        row[entry.id] = formatHours(value, { compact: true })
      }
      row['total'] = formatHours(total, { compact: true })
      row['capacity'] = formatHours(numberAt(plantBars.capacity, index), { compact: true })
      return row
    })
    return {
      caption: 'Required hours by plant against the capacity the ceiling allows, per bucket.',
      columns: [
        { key: 'bucket', label: 'Bucket' },
        ...plantBars.series.map((entry) => ({
          key: entry.id,
          label: entry.label,
          align: 'right' as const,
        })),
        { key: 'total', label: 'Total required', align: 'right' as const },
        { key: 'capacity', label: 'Capacity at ceiling', align: 'right' as const },
      ],
      rows,
    }
  }, [buckets, plantBars])

  // --- supply plan against demand -------------------------------------------

  const planSeries = useMemo<TimeSeries[]>(() => {
    const points = (values: number[]): TimeSeries['points'] =>
      buckets.map((bucket, index) => ({ month: bucket.key, value: numberAt(values, index) }))
    return [
      { id: 'supply', label: 'Supply plan units', slot: 1, markShape: 'line', points: points(series.supplyUnits) },
      { id: 'demand', label: 'Demand units', slot: 2, markShape: 'line', points: points(series.demandUnits) },
      { id: 'produced', label: 'Produced units', slot: 3, markShape: 'line', points: points(series.producedUnits) },
    ]
  }, [buckets, series])

  const planTable = useMemo<TableViewProps>(
    () => ({
      caption:
        'The supply plan, the demand it is measured against, and what the network can actually produce, per bucket.',
      columns: [
        { key: 'bucket', label: 'Bucket' },
        { key: 'supply', label: 'Supply plan', align: 'right' },
        { key: 'demand', label: 'Demand', align: 'right' },
        { key: 'produced', label: 'Produced', align: 'right' },
        { key: 'gap', label: 'Plan gap', align: 'right' },
      ],
      rows: buckets.map((bucket, index) => ({
        bucket: bucket.longLabel,
        supply: formatUnits(numberAt(series.supplyUnits, index), { compact: true }),
        demand: formatUnits(numberAt(series.demandUnits, index), { compact: true }),
        produced: formatUnits(numberAt(series.producedUnits, index), { compact: true }),
        gap: formatUnits(numberAt(series.planGapUnits, index), { compact: true }),
      })),
    }),
    [buckets, series],
  )

  // --- selection & the relief reveal ---------------------------------------

  const selectWorkCenter = useCallback(
    (workCenterId: WorkCenterId, week?: number) => {
      const wc = workCenterById.get(workCenterId)
      setSelection({ workCenterId, plantId: wc?.plantId, week })
      setRevealSeq((prior) => prior + 1)
    },
    [setSelection, workCenterById],
  )

  useEffect(() => {
    if (revealSeq === 0) return
    const node = reliefRef.current
    if (node === null) return
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }, [revealSeq])

  const selectedWorkCenter =
    selection.workCenterId === undefined ? undefined : workCenterById.get(selection.workCenterId)

  const reliefCandidates = useMemo(() => {
    const candidates = (relief.data ?? []).slice()
    candidates.sort((a, b) => {
      const byBasis = BASIS_RANK[a.basis] - BASIS_RANK[b.basis]
      if (byBasis !== 0) return byBasis
      if (a.sameePlant !== b.sameePlant) return a.sameePlant ? -1 : 1
      return b.spareHours - a.spareHours
    })
    return candidates
  }, [relief.data])

  const applyRelief = useCallback(
    (candidate: ReliefCandidate) => {
      const movable = candidate.movableGroups
        .slice()
        .sort((a, b) => b.hours - a.hours)
      const top = movable[0]
      if (top === undefined) return
      const weekCount = catalog?.time.weeks.length ?? 0
      const lastWeek = Math.max(0, weekCount - 1)
      const target = workCenterById.get(candidate.toWorkCenterId)
      const origin = workCenterById.get(candidate.fromWorkCenterId)
      const targetCode = target?.code ?? candidate.toWorkCenterId
      const originCode = origin?.code ?? candidate.fromWorkCenterId

      const startWeek = clamp(
        filters.fromWeek + (candidate.basis === 'retrofit' ? candidate.leadTimeWeeks : 0),
        0,
        lastWeek,
      )
      const endWeek = clamp(filters.toWeek, startWeek, lastWeek)

      if (candidate.basis === 'retrofit' && candidate.retrofit !== undefined) {
        applyMove(
          {
            kind: 'retrofit',
            workCenterId: candidate.toWorkCenterId,
            retrofitId: candidate.retrofit.id,
            availableFromWeek: startWeek,
          },
          `Retrofit ${targetCode} with ${candidate.retrofit.name}`,
        )
      }

      applyMove(
        {
          kind: 'resourceMove',
          selector: { kind: 'group', id: top.groupId },
          fromWorkCenterId: candidate.fromWorkCenterId,
          toWorkCenterId: candidate.toWorkCenterId,
          fromWeek: startWeek,
          toWeek: endWeek,
          share: 1,
          allowDualSource: false,
        },
        `Move ${groupName(top.groupId)} from ${originCode} to ${targetCode}`,
      )
    },
    [applyMove, catalog, filters.fromWeek, filters.toWeek, groupName, workCenterById],
  )

  // --- states ---------------------------------------------------------------

  const kpis = result.data?.kpis
  const bottlenecks = result.data?.bottlenecks ?? []
  const shownBottlenecks = bottlenecks.slice(0, MAX_BOTTLENECK_ROWS)
  const overloadedWorkCenters = bottlenecks.filter(
    (entry) => entry.weeksOverCeiling > 0,
  ).length

  const resultStale = result.loading && result.data !== null
  const plantStale = plantRollup.loading && plantRollup.data !== null

  if (catalog === null) {
    return (
      <div className={styles.page}>
        <EmptyState
          title="The catalog has not arrived yet"
          description="Master data is still loading; the cockpit will fill in as soon as the engine answers."
        />
      </div>
    )
  }

  if (result.error !== null && result.data === null) {
    return (
      <div className={styles.page}>
        <FilterBar />
        <ErrorState
          title="The model could not answer"
          message={result.error}
          detail="Narrow the window or the plant filter and try again — the engine keeps the last answer it produced."
        />
      </div>
    )
  }

  if (kpis === undefined || result.data === null) {
    return (
      <div className={styles.page}>
        <FilterBar />
        <Card>
          <EmptyState
            icon="clock"
            title="Running the model over the network"
            description="Fifteen thousand SKUs across a hundred and fifty work centers. This takes a moment the first time."
          />
        </Card>
      </div>
    )
  }

  const heroStatus = utilisationStatus(kpis.utilisation)
  const peakStatus = utilisationStatus(kpis.peakUtilisation)

  return (
    <div className={styles.page}>
      <FilterBar />

      {/* ---------------------------------------------------------------- */}
      {/* Headline band                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className={styles.band} aria-label="Network headline">
        <Card stale={resultStale}>
          <HeroFigure
            label="Network utilisation"
            value={pct(kpis.utilisation)}
            caption={`${formatUnits(overloadedWorkCenters)} work ${overloadedWorkCenters === 1 ? 'center runs' : 'centers run'} over the ceiling in this window, and the plan gap is ${formatUnits(kpis.planGapUnits, { compact: true })} units — demand the supply plan chose not to serve.`}
            delta={deltaOf(
              numberAt(series.utilisation, first),
              numberAt(series.utilisation, last),
              (value) => pct(value),
              'down',
              0.0005,
            )}
            deltaContext={deltaContext}
            status={heroStatus}
            spark={condense(series.utilisation, 20, 'mean')}
            sparkSlot={1}
            meter={{
              ratio: kpis.utilisation,
              valueLabel: pct(kpis.utilisation),
              limitLabel: `Ceiling ${pct(shownCeiling, 0)}`,
            }}
            secondary={[
              { label: 'Work centers over ceiling', value: formatUnits(overloadedWorkCenters) },
              {
                label: 'Plan gap',
                value: `${formatUnits(kpis.planGapUnits, { compact: true })} units`,
              },
              { label: 'Required hours', value: formatHours(kpis.requiredHours, { compact: true }) },
            ]}
          />
        </Card>

        <div className={styles.kpis}>
          <StatTile
            label="Peak utilisation"
            value={pct(kpis.peakUtilisation)}
            status={peakStatus}
            delta={deltaOf(
              numberAt(series.peakUtilisation, first),
              numberAt(series.peakUtilisation, last),
              (value) => pct(value),
              'down',
              0.0005,
            )}
            deltaContext={deltaContext}
            spark={condense(series.peakUtilisation, 14, 'max')}
            sparkSlot={2}
            hint="The fullest work-center week anywhere in the slice."
          />

          <StatTile
            label="Overloaded work-center weeks"
            value={formatUnits(kpis.overloadedCells)}
            delta={deltaOf(
              numberAt(series.overloadedCells, first),
              numberAt(series.overloadedCells, last),
              (value) => formatUnits(value),
              'down',
            )}
            deltaContext={deltaContext}
            spark={condense(series.overloadedCells, 14, 'sum')}
            sparkSlot={1}
            status={
              kpis.overloadedCells > 0
                ? { level: 'serious', label: 'Hours the plan cannot place' }
                : { level: 'good', label: 'Every week fits' }
            }
          />

          <div className={styles.tileHost}>
            <div className={styles.tileTip}>
              <InfoTip label="What the plan gap means">
                The supply plan is what loads capacity; demand is reference. The gap is demand
                minus supply — what the plan chose not to serve, before the network was asked
                whether it could make it.
              </InfoTip>
            </div>
            <StatTile
              label="Plan gap"
              value={`${formatUnits(kpis.planGapUnits, { compact: true })} units`}
              delta={deltaOf(
                numberAt(series.planGapUnits, first),
                numberAt(series.planGapUnits, last),
                (value) => formatUnits(value, { compact: true }),
                'down',
              )}
              deltaContext={deltaContext}
              spark={condense(series.planGapUnits, 14, 'sum')}
              sparkSlot={2}
              hint="Demand minus supply plan. Negative means the plan builds more than demand asked for."
            />
          </div>

          <StatTile
            label="Shortfall units"
            value={`${formatUnits(kpis.shortfallUnits, { compact: true })} units`}
            delta={deltaOf(
              numberAt(series.shortfallUnits, first),
              numberAt(series.shortfallUnits, last),
              (value) => formatUnits(value, { compact: true }),
              'down',
            )}
            deltaContext={deltaContext}
            spark={condense(series.shortfallUnits, 14, 'sum')}
            sparkSlot={2}
            status={
              kpis.shortfallUnits > 0
                ? { level: 'critical', label: 'The network cannot make these' }
                : { level: 'good', label: 'Nothing physically refused' }
            }
            hint="Eaches the plan wanted but the ceiling refused."
          />

          <StatTile
            label="Machine-bound vs labour-bound cells"
            value={`${formatUnits(kpis.machineBoundCells)} / ${formatUnits(kpis.labourBoundCells)}`}
            deltaContext={`${pct(safeDiv(kpis.machineBoundCells, kpis.machineBoundCells + kpis.labourBoundCells), 0)} machine-bound`}
            spark={condense(series.machineShare, 14, 'mean')}
            sparkSlot={3}
            hint="Machine-bound weeks want capex; labour-bound weeks want hiring. The split is which cheque to write."
          />

          <StatTile
            label="Downtime hours"
            value={formatHours(kpis.downtimeHours, { compact: true })}
            delta={deltaOf(
              numberAt(series.downtimeHours, first),
              numberAt(series.downtimeHours, last),
              (value) => formatHours(value, { compact: true }),
              'down',
            )}
            deltaContext={deltaContext}
            spark={condense(series.downtimeHours, 14, 'sum')}
            sparkSlot={1}
            hint="Planned downtime only. Unplanned loss lives inside OEE and has no date."
          />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Ceiling + binding pool                                            */}
      {/* ---------------------------------------------------------------- */}
      <div className={styles.controls}>
        <Slider
          className={styles.ceiling}
          label="Utilisation ceiling"
          value={shownCeiling}
          min={CEILING_MIN}
          max={CEILING_MAX}
          step={0.01}
          onChange={onCeilingChange}
          format={(value) => pct(value, 0)}
          hint="Applies immediately as an undoable move at global scope. Load above this reads as overload even when the hours exist."
        />

        <div className={styles.poolPicker}>
          <span className={styles.poolLabel} id="binding-pool-label">
            Binding pool
          </span>
          <SegmentedControl<PoolView>
            label="Binding pool shown in the grid"
            size="sm"
            value={poolView}
            options={[
              { value: 'both', label: 'Both', hint: 'Whichever pool binds each cell' },
              { value: 'machine', label: 'Machine', hint: 'Machine hours only — the capex question' },
              { value: 'labour', label: 'Labour', hint: 'Labour hours only — the hiring question' },
            ]}
            onChange={setPoolView}
          />
        </div>

        <p className={styles.controlNote}>
          A work center owns two independent pools. Either can bind, and the fix differs: a
          machine constraint wants capex, a labour constraint wants hiring.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The grid                                                          */}
      {/* ---------------------------------------------------------------- */}
      <ChartCard
        title="Where the network runs out"
        subtitle={`${formatUnits(grid.rows.length)} work centers by ${bucketCount} ${filters.bucket === 'week' ? 'weeks' : filters.bucket === 'month' ? 'months' : 'quarters'}, each cell measured against its own ceiling. Click a cell to look for relief.`}
        aside={
          <span className={styles.aside}>
            Ceiling {pct(shownCeiling, 0)} · {result.data.runtimeMs.toFixed(0)}ms run
          </span>
        }
        stale={resultStale}
        table={gridTable}
      >
        <UtilisationGrid
          rows={grid.rows}
          weeks={bucketKeys}
          utilisation={grid.utilisation}
          machineUtilisation={grid.machineUtilisation}
          labourUtilisation={grid.labourUtilisation}
          availableHours={grid.availableHours}
          requiredHours={grid.requiredHours}
          bindingPool={grid.bindingPool}
          downtimeHours={grid.downtimeHours}
          eventLabels={grid.eventLabels}
          sort={sort}
          onSortChange={setSort}
          selectedRowId={selection.workCenterId}
          onCellClick={(cell) => {
            selectWorkCenter(cell.rowId, buckets[cell.week]?.firstWeek)
          }}
          onRowClick={(rowId) => {
            selectWorkCenter(rowId)
          }}
          height={460}
          weekLabel={(bucketKey) => bucketLabel(bucketKey)}
          emptyMessage="No work centers survive these filters"
        />
      </ChartCard>

      {/* ---------------------------------------------------------------- */}
      {/* Load vs capacity, plan vs demand                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className={styles.pair}>
        <ChartCard
          title="Load against capacity"
          subtitle="Required hours stacked by plant. The hairline is the hours the ceiling allows."
          stale={plantStale}
          table={plantTable}
        >
          <StackedBarChart
            categories={bucketKeys}
            categoryLabel={bucketLabel}
            series={plantBars.series}
            limits={plantBars.capacity}
            limitLabel="Capacity at ceiling"
            format={(value) => formatHours(value, { compact: true })}
            yLabel="Hours"
            height={280}
          />
        </ChartCard>

        <ChartCard
          title="Supply plan vs demand"
          subtitle="The distance between demand and the supply plan is the plan gap — what the plan chose not to serve. Produced is what the network can actually make once the ceiling has had its say."
          stale={resultStale}
          table={planTable}
        >
          <LineChart
            series={planSeries}
            format={(value) => compact(value)}
            yLabel="Units"
            directLabels
            height={280}
          />
        </ChartCard>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Bottlenecks                                                       */}
      {/* ---------------------------------------------------------------- */}
      <Card
        title="Bottlenecks"
        subtitle="Work centers in trouble, worst first. Severity is the engine's, not a threshold applied here."
        aside={
          bottlenecks.length > 0 ? (
            <span className={styles.aside}>
              Showing {shownBottlenecks.length} of {bottlenecks.length}
            </span>
          ) : undefined
        }
        stale={resultStale}
      >
        {bottlenecks.length === 0 ? (
          <EmptyState
            icon="good"
            title="Nothing is over its ceiling in this window"
            description="Every work center in the slice fits inside the hours it has. Widen the window or lower the ceiling to find where it stops being true."
          />
        ) : (
          <ul className={styles.list}>
            {shownBottlenecks.map((entry) => (
              <BottleneckRow
                key={entry.workCenterId}
                bottleneck={entry}
                workCenter={workCenterById.get(entry.workCenterId)}
                className={classById.get(workCenterById.get(entry.workCenterId)?.classId ?? '')?.name}
                plantLabel={plantLabelOf(entry.plantId)}
                plantSlot={plantSlot(entry.plantId)}
                peakWeekLabel={catalog.time.weeks[entry.peakWeek] ?? `week ${entry.peakWeek}`}
                selected={selection.workCenterId === entry.workCenterId}
                groupName={groupName}
                onFindRelief={() => selectWorkCenter(entry.workCenterId, entry.peakWeek)}
              />
            ))}
          </ul>
        )}
        {bottlenecks.length > shownBottlenecks.length ? (
          <p className={styles.footNote}>
            {bottlenecks.length - shownBottlenecks.length} more work centers are in trouble below
            these. The grid above shows all of them.
          </p>
        ) : null}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Relief                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div ref={reliefRef}>
        {selection.workCenterId === undefined ? null : (
          <Card
            title="Relief options"
            subtitle={
              selectedWorkCenter === undefined
                ? 'Somewhere else the load could go.'
                : `Somewhere else the load on ${selectedWorkCenter.code} · ${selectedWorkCenter.name} could go. Approved first, same plant first.`
            }
            aside={
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                onClick={() => setSelection({ workCenterId: undefined, week: undefined })}
              >
                Clear selection
              </Button>
            }
            stale={relief.loading && relief.data !== null}
          >
            {relief.error !== null && relief.data === null ? (
              <ErrorState
                title="The relief search could not finish"
                message={relief.error}
              />
            ) : relief.data === null ? (
              <EmptyState
                icon="clock"
                title="Looking for somewhere to put the load"
                description="Matching the operations at this work center against every other machine's allow-list and feature set."
              />
            ) : reliefCandidates.length === 0 ? (
              <EmptyState
                title="Nowhere else can take this load"
                description="No other work center is approved, feature-capable, or retrofittable for the operations running here. A new asset or a plan change is the remaining lever."
              />
            ) : (
              <ul className={styles.list}>
                {reliefCandidates.map((candidate) => (
                  <ReliefRow
                    key={`${candidate.toWorkCenterId}|${candidate.basis}`}
                    candidate={candidate}
                    target={workCenterById.get(candidate.toWorkCenterId)}
                    plantLabel={plantLabelOf(
                      workCenterById.get(candidate.toWorkCenterId)?.plantId ?? '',
                    )}
                    plantSlot={plantSlot(
                      workCenterById.get(candidate.toWorkCenterId)?.plantId ?? '',
                    )}
                    groupName={groupName}
                    onApply={() => applyRelief(candidate)}
                  />
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface BottleneckRowProps {
  bottleneck: Bottleneck
  workCenter: WorkCenter | undefined
  className: string | undefined
  plantLabel: string
  plantSlot: 1 | 2 | 3 | 4 | 5
  peakWeekLabel: string
  selected: boolean
  groupName: (groupId: GroupId) => string
  onFindRelief: () => void
}

function BottleneckRow({
  bottleneck,
  workCenter,
  className,
  plantLabel,
  plantSlot,
  peakWeekLabel,
  selected,
  groupName,
  onFindRelief,
}: BottleneckRowProps) {
  return (
    <li className={[styles.row, selected ? styles.rowSelected : ''].filter(Boolean).join(' ')}>
      <div className={styles.identity}>
        <Chip slot={plantSlot} title={plantLabel}>
          {plantLabel}
        </Chip>
        <span className={styles.code}>{workCenter?.code ?? bottleneck.workCenterId}</span>
        <span className={styles.name}>{workCenter?.name ?? ''}</span>
        {className === undefined ? null : <span className={styles.class}>{className}</span>}
        <span className={styles.marks}>
          <Badge tone={SEVERITY_TONE[bottleneck.severity]} size="sm">
            {SEVERITY_LABEL[bottleneck.severity]}
          </Badge>
          <Badge tone="neutral" size="sm">
            {POOL_LABEL[bottleneck.bindingPool]}
          </Badge>
        </span>
      </div>

      <div className={styles.meterCell}>
        <Meter
          label={`Peak utilisation · ${peakWeekLabel}`}
          ratio={bottleneck.peakUtilisation}
          valueLabel={pct(bottleneck.peakUtilisation)}
          limitLabel="Ceiling"
          thresholds={{ warning: 0.9, critical: 1 }}
          slot={plantSlot}
        />
      </div>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Weeks over ceiling</dt>
          <dd className={styles.statValue}>{formatUnits(bottleneck.weeksOverCeiling)}</dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Overload hours</dt>
          <dd className={styles.statValue}>
            {formatHours(bottleneck.overloadHours, { compact: true })}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Shortfall units</dt>
          <dd className={styles.statValue}>
            {formatUnits(bottleneck.shortfallUnits, { compact: true })}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Carrying the load</dt>
          <dd className={styles.statValue}>
            <span className={styles.pills}>
              {bottleneck.topGroups.length === 0 ? (
                <span className={styles.detail}>No group hours in this slice</span>
              ) : (
                bottleneck.topGroups.slice(0, 3).map((group) => (
                  <Pill key={group.groupId}>
                    {groupName(group.groupId)} · {formatHours(group.hours, { compact: true })}
                  </Pill>
                ))
              )}
            </span>
          </dd>
        </div>
      </dl>

      <div className={styles.actions}>
        <Button variant="primary" size="sm" icon="zap" onClick={onFindRelief}>
          Find relief
        </Button>
      </div>
    </li>
  )
}

interface ReliefRowProps {
  candidate: ReliefCandidate
  target: WorkCenter | undefined
  plantLabel: string
  plantSlot: 1 | 2 | 3 | 4 | 5
  groupName: (groupId: GroupId) => string
  onApply: () => void
}

function ReliefRow({
  candidate,
  target,
  plantLabel,
  plantSlot,
  groupName,
  onApply,
}: ReliefRowProps) {
  const movable = candidate.movableGroups.slice().sort((a, b) => b.hours - a.hours)
  const top = movable[0]
  const wouldMoveTheBottleneck = candidate.resultingUtilisation > 1

  return (
    <li className={styles.reliefRow}>
      <div className={styles.identity}>
        <Chip slot={plantSlot} title={plantLabel}>
          {plantLabel}
        </Chip>
        <span className={styles.code}>{target?.code ?? candidate.toWorkCenterId}</span>
        <span className={styles.name}>{target?.name ?? ''}</span>
        <span className={styles.marks}>
          <Badge tone={BASIS_TONE[candidate.basis]} size="sm">
            {BASIS_LABEL[candidate.basis]}
          </Badge>
          {candidate.sameePlant ? (
            <Badge tone="neutral" size="sm">
              Same plant
            </Badge>
          ) : null}
        </span>
      </div>

      <div className={styles.meterCell}>
        <Meter
          label="Utilisation once the load lands"
          ratio={candidate.resultingUtilisation}
          valueLabel={pct(candidate.resultingUtilisation)}
          limitLabel="Ceiling"
          thresholds={{ warning: 0.9, critical: 1 }}
          slot={plantSlot}
        />
      </div>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Spare hours</dt>
          <dd className={styles.statValue}>
            {formatHours(candidate.spareHours, { compact: true })}
          </dd>
        </div>
        {candidate.capexUsd > 0 ? (
          <div className={styles.stat}>
            <dt className={styles.statLabel}>Capex</dt>
            <dd className={styles.statValue}>
              ${compact(candidate.capexUsd)}
            </dd>
          </div>
        ) : null}
        {candidate.leadTimeWeeks > 0 ? (
          <div className={styles.stat}>
            <dt className={styles.statLabel}>Lead time</dt>
            <dd className={styles.statValue}>{candidate.leadTimeWeeks} weeks</dd>
          </div>
        ) : null}
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Could move</dt>
          <dd className={styles.statValue}>
            <span className={styles.pills}>
              {movable.length === 0 ? (
                <span className={styles.detail}>Nothing movable in this window</span>
              ) : (
                movable.slice(0, 3).map((group) => (
                  <Pill key={group.groupId}>
                    {groupName(group.groupId)} · {formatHours(group.hours, { compact: true })}
                  </Pill>
                ))
              )}
            </span>
          </dd>
        </div>
      </dl>

      <div className={styles.actions}>
        <Button variant="primary" size="sm" icon="drag" onClick={onApply} disabled={top === undefined}>
          Apply move
        </Button>
      </div>

      <p className={styles.verdict}>
        {wouldMoveTheBottleneck
          ? `Taking this load would put ${target?.code ?? candidate.toWorkCenterId} at ${pct(candidate.resultingUtilisation)} — that moves the bottleneck rather than removing it.`
          : top === undefined
            ? 'This work center could take the operations, but no product group has hours to move in this window.'
            : `Applying moves ${groupName(top.groupId)} — the largest movable group, ${formatHours(top.hours, { compact: true })} across ${formatUnits(top.materials)} materials — and leaves ${target?.code ?? candidate.toWorkCenterId} at ${pct(candidate.resultingUtilisation)}.`}
        {candidate.basis === 'retrofit' && candidate.retrofit !== undefined
          ? ` The retrofit “${candidate.retrofit.name}” is applied first and the move starts after its ${candidate.leadTimeWeeks}-week lead time.`
          : candidate.basis === 'featureCapable'
            ? ' The machine is physically capable but not on the allow-list — this needs qualification before it is real.'
            : ''}
      </p>
    </li>
  )
}

export default Cockpit
