/**
 * Products — what the network is being asked to make, and what that costs in
 * hours.
 *
 * The screen reads downward from the whole catalogue to one SKU: totals, then
 * volume by family, then every product group with the gap between what demand
 * asked for and what the plan committed to, then the SKUs themselves, then —
 * only once one is chosen — its routing, its alternates and its plan.
 *
 * Three things are structural rather than stylistic.
 *
 * 1. **The SKU list is a page, never a table of 15,000.** `useMaterialSlice`
 *    sorts and slices inside the worker; a page is a hundred rows and the pager
 *    counts against a `total` the worker computed. Nothing here ever holds the
 *    material master for the whole network.
 *
 * 2. **Master data is fetched as master data, on demand.** ABC class and
 *    material type are not in the worker's slice answer, and a routing is not in
 *    it at all. Both are, however, exactly what the SAP extract carries, so this
 *    screen reads MARA/MARC once for the list and MAPL/PLKO/PLPO/INVENTORY once
 *    for the drawer, against the **baseline** scenario — a routing is master
 *    data, and what a scenario does to load is what the roll-ups already show.
 *    Everything is cached at module scope, so the cost is paid once per session.
 *
 * 3. **Hours per SKU are allocated, not measured.** The engine never
 *    materialises per-SKU-per-week hours — that is what keeps the load explosion
 *    inside its budget — so a SKU's hours are its group's measured hours split
 *    by its share of the group's units. The drawer says so rather than implying
 *    a precision the model does not have.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Filters, MaterialType, WorkCenter } from '@/domain/types'
import type { MaterialSliceRow } from '@/worker/protocol'
import { clamp, safeDiv } from '@/domain/lookup'
import { baselineScenario } from '@/domain/engine'
import { parseCsvRows } from '@/lib/csv'
import {
  compact,
  hours as formatHours,
  monthLong,
  monthShort,
  pct,
  units as formatUnits,
  usd,
} from '@/lib/format'
import { ChartCard, LineChart, StackedBarChart, StatTile } from '@/charts'
import type {
  SeriesSlot,
  StackedBarSeries,
  TableViewProps,
  TimeSeries,
} from '@/charts/types'
import {
  Badge,
  Button,
  Card,
  Chip,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  InfoTip,
  Pill,
  SectionHeading,
  Select,
  TextField,
} from '@/components'
import type { DataTableColumn } from '@/components'
import { FilterBar } from '@/components/FilterBar'
import { useMaterialSlice, usePlantSlot, useRollup } from '@/state/model'
import { useUiStore } from '@/state/store'
import { getEngineClient } from '@/worker/client'
import styles from '@/routes/Products.module.css'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** One page of SKUs. Never larger — the worker caps its own answer at 500. */
const PAGE_SIZE = 100

/**
 * How many SKUs a search scans. The worker protocol carries no query parameter,
 * so a search narrows the largest page the worker will answer rather than the
 * whole catalogue — and the field says so on its face.
 */
const SEARCH_FETCH = 500

/** SKUs the footprint and dual-source figures are derived from. */
const FOOTPRINT_FETCH = 500

/** Families before the tail folds into "Other". Never a ninth hue. */
const MAX_FAMILY_SERIES = 7

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function numberAt(list: readonly number[], index: number): number {
  const value = list[index]
  return value === undefined ? 0 : value
}

function i32(array: Int32Array, index: number): number {
  const value = array[index]
  return value === undefined ? -1 : value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Header-mapped CSV walk. One pass, no intermediate table. */
function forEachRow(text: string, onRow: (cell: (column: string) => string) => void): void {
  let cols: Map<string, number> | null = null
  parseCsvRows(text, (cells) => {
    if (cols === null) {
      const map = new Map<string, number>()
      for (let i = 0; i < cells.length; i += 1) {
        const name = (cells[i] ?? '').trim().toUpperCase()
        if (name !== '' && !map.has(name)) map.set(name, i)
      }
      cols = map
      return
    }
    const map = cols
    onRow((column) => cells[map.get(column) ?? -1] ?? '')
  })
}

function toNumber(raw: string): number {
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

// ---------------------------------------------------------------------------
// Master data, read from the extract and cached for the session
// ---------------------------------------------------------------------------

interface MaterialFact {
  code: string
  type: MaterialType
  abcClass: string
  baseUom: string
  pricePerUnitUsd: number
  materialCostPerUnitUsd: number
  unitsPerHandlingUnit: number
  weightKgPerUnit: number
}

let factsPromise: Promise<Map<string, MaterialFact>> | null = null

/**
 * MARA plus MARC, keyed by the material **id**.
 *
 * MARA carries the id in `BISMT` — SAP's "old material number" — which is the
 * only field in the standard extract that can join the worker's slice rows to
 * the material master without guessing that codes are unique.
 */
function loadMaterialFacts(): Promise<Map<string, MaterialFact>> {
  const existing = factsPromise
  if (existing !== null) return existing
  const promise = (async () => {
    const client = getEngineClient()
    const scenario = baselineScenario()
    const [mara, marc] = await Promise.all([
      client.exportCsv(scenario, 'MARA'),
      client.exportCsv(scenario, 'MARC'),
    ])
    const abcByCode = new Map<string, string>()
    forEachRow(marc, (cell) => {
      const code = cell('MATNR')
      if (code !== '' && !abcByCode.has(code)) abcByCode.set(code, cell('MAABC'))
    })
    const byId = new Map<string, MaterialFact>()
    forEachRow(mara, (cell) => {
      const code = cell('MATNR')
      const id = cell('BISMT') === '' ? code : cell('BISMT')
      const rawType = cell('MTART')
      const type: MaterialType = rawType === 'HALB' ? 'HALB' : rawType === 'ROH' ? 'ROH' : 'FERT'
      byId.set(id, {
        code,
        type,
        abcClass: abcByCode.get(code) ?? '',
        baseUom: cell('MEINS'),
        pricePerUnitUsd: toNumber(cell('ZPRICEUSD')),
        materialCostPerUnitUsd: toNumber(cell('ZCOSTUSD')),
        unitsPerHandlingUnit: toNumber(cell('ZUNITSPERHU')),
        weightKgPerUnit: toNumber(cell('NTGEW')),
      })
    })
    return byId
  })().catch((error: unknown) => {
    factsPromise = null
    throw error
  })
  factsPromise = promise
  return promise
}

interface RoutingOperationRow {
  seq: number
  opId: string
  workCenterCode: string
  plantCode: string
  baseQty: number
  setupHours: number
  machineHoursPerBase: number
  labourHoursPerBase: number
  scrapPct: number
}

interface RoutingHeaderRow {
  routingId: string
  version: string
  plantCode: string
  primary: boolean
  validFrom: string
  validTo: string
}

interface InventoryRowCsv {
  plantCode: string
  onHand: number
  inTransit: number
  safetyStock: number
}

interface RoutingMaster {
  headerByKey: Map<string, RoutingHeaderRow>
  opsByKey: Map<string, RoutingOperationRow[]>
  keysByMaterialCode: Map<string, string[]>
  inventoryByCode: Map<string, InventoryRowCsv[]>
}

let routingPromise: Promise<RoutingMaster> | null = null

/** MAPL, PLKO, PLPO and INVENTORY — the routing half of the drawer. */
function loadRoutingMaster(): Promise<RoutingMaster> {
  const existing = routingPromise
  if (existing !== null) return existing
  const promise = (async () => {
    const client = getEngineClient()
    const scenario = baselineScenario()
    const [mapl, plko, plpo, inventory] = await Promise.all([
      client.exportCsv(scenario, 'MAPL'),
      client.exportCsv(scenario, 'PLKO'),
      client.exportCsv(scenario, 'PLPO'),
      client.exportCsv(scenario, 'INVENTORY'),
    ])

    const keysByMaterialCode = new Map<string, string[]>()
    forEachRow(mapl, (cell) => {
      const code = cell('MATNR')
      const routingKey = `${cell('PLNNR')}|${cell('PLNAL')}`
      const list = keysByMaterialCode.get(code)
      if (list === undefined) keysByMaterialCode.set(code, [routingKey])
      else if (!list.includes(routingKey)) list.push(routingKey)
    })

    const headerByKey = new Map<string, RoutingHeaderRow>()
    forEachRow(plko, (cell) => {
      const routingId = cell('PLNNR')
      const version = cell('PLNAL')
      headerByKey.set(`${routingId}|${version}`, {
        routingId,
        version,
        plantCode: cell('WERKS'),
        primary: cell('ZPRIMARY') === 'X' || cell('ZPRIMARY') === 'true',
        validFrom: cell('ZVALIDFROM'),
        validTo: cell('ZVALIDTO'),
      })
    })

    const opsByKey = new Map<string, RoutingOperationRow[]>()
    forEachRow(plpo, (cell) => {
      const routingKey = `${cell('PLNNR')}|${cell('PLNAL')}`
      const row: RoutingOperationRow = {
        seq: toNumber(cell('VORNR')),
        opId: cell('ZOPID'),
        workCenterCode: cell('ARBPL'),
        plantCode: cell('WERKS'),
        baseQty: toNumber(cell('BMSCH')),
        setupHours: toNumber(cell('VGW01')),
        machineHoursPerBase: toNumber(cell('VGW02')),
        labourHoursPerBase: toNumber(cell('VGW03')),
        scrapPct: toNumber(cell('AUSCH')),
      }
      const list = opsByKey.get(routingKey)
      if (list === undefined) opsByKey.set(routingKey, [row])
      else list.push(row)
    })
    for (const list of opsByKey.values()) list.sort((a, b) => a.seq - b.seq)

    const inventoryByCode = new Map<string, InventoryRowCsv[]>()
    forEachRow(inventory, (cell) => {
      const code = cell('MATNR')
      const row: InventoryRowCsv = {
        plantCode: cell('WERKS'),
        onHand: toNumber(cell('LABST')),
        inTransit: toNumber(cell('TRANS')),
        safetyStock: toNumber(cell('SAFETY')),
      }
      const list = inventoryByCode.get(code)
      if (list === undefined) inventoryByCode.set(code, [row])
      else list.push(row)
    })

    return { headerByKey, opsByKey, keysByMaterialCode, inventoryByCode }
  })().catch((error: unknown) => {
    routingPromise = null
    throw error
  })
  routingPromise = promise
  return promise
}

/**
 * Drop everything read from the extract.
 *
 * Called by the Data screen when the dataset underneath is replaced — a new
 * profile or an imported extract makes every cached material fact and every
 * cached routing a statement about a world that no longer exists.
 */
export function resetProductMasterCache(): void {
  factsPromise = null
  routingPromise = null
}

interface Loaded<T> {
  data: T | null
  loading: boolean
  error: string | null
}

function useLazy<T>(load: () => Promise<T>, enabled: boolean): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, loading: false, error: null })
  useEffect(() => {
    if (!enabled) return
    let listening = true
    setState((prior) => ({ data: prior.data, loading: true, error: null }))
    load().then(
      (data) => {
        if (listening) setState({ data, loading: false, error: null })
      },
      (error: unknown) => {
        if (listening) setState({ data: null, loading: false, error: messageOf(error) })
      },
    )
    return () => {
      listening = false
    }
    // `load` is a module-level function with a module-level cache, so it is
    // stable by construction; re-running on its identity would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
  return state
}

// ---------------------------------------------------------------------------
// Bucket axis
// ---------------------------------------------------------------------------

interface Bucket {
  key: string
  label: string
  longLabel: string
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

interface Axis {
  buckets: Bucket[]
  /** Week -> bucket index, or -1 when the week is outside the window. */
  bucketOfWeek: Int32Array
}

function useAxis(weekCount: number, filters: Filters, time: {
  weeks: string[]
  monthOfWeek: string[]
  quarterOfWeek: string[]
} | null): Axis {
  return useMemo(() => {
    const bucketOfWeek = new Int32Array(Math.max(weekCount, 1)).fill(-1)
    const buckets: Bucket[] = []
    if (time === null || weekCount === 0) return { buckets, bucketOfWeek }
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
        })
      }
      bucketOfWeek[week] = index
    }
    return { buckets, bucketOfWeek }
  }, [weekCount, filters.bucket, filters.fromWeek, filters.toWeek, time])
}

/** Debounce a string. The search box types faster than the worker answers. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === settled) return
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

interface GroupRow {
  groupId: string
  code: string
  name: string
  familyName: string
  skuCount: number
  supplyUnits: number
  demandUnits: number
  gapUnits: number
  requiredHours: number
  plantIds: string[]
  workCenterCount: number
}

export function Products() {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const plantSlot = usePlantSlot()

  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState<'hours' | 'units' | 'code'>('hours')
  const [groupFocus, setGroupFocus] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<MaterialSliceRow | null>(null)

  const debouncedSearch = useDebounced(search, 250)
  const searching = debouncedSearch.trim() !== ''

  const weekCount = catalog?.time.weeks.length ?? 0
  const time = useMemo(
    () =>
      catalog === null
        ? null
        : {
            weeks: catalog.time.weeks,
            monthOfWeek: catalog.time.monthOfWeek,
            quarterOfWeek: catalog.time.quarterOfWeek,
          },
    [catalog],
  )
  const axis = useAxis(weekCount, filters, time)
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

  const familyRollup = useRollup('family')
  const groupRollup = useRollup('group')

  const slice = useMaterialSlice({
    groupId: groupFocus === '' ? undefined : groupFocus,
    offset: searching ? 0 : page * PAGE_SIZE,
    limit: searching ? SEARCH_FETCH : PAGE_SIZE,
    sortBy,
  })

  /** One extra page, biggest volume first, for the footprint and dual-source figures. */
  const footprint = useMaterialSlice({ offset: 0, limit: FOOTPRINT_FETCH, sortBy: 'units' })

  const facts = useLazy(loadMaterialFacts, catalog !== null)

  useEffect(() => {
    setPage(0)
  }, [debouncedSearch, groupFocus, sortBy])

  // --- catalog lookups ------------------------------------------------------

  const groupById = useMemo(
    () => new Map((catalog?.groups ?? []).map((group) => [group.id, group])),
    [catalog],
  )
  const familyById = useMemo(
    () => new Map((catalog?.families ?? []).map((family) => [family.id, family])),
    [catalog],
  )
  const plantById = useMemo(
    () => new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant])),
    [catalog],
  )
  const workCenterById = useMemo(
    () => new Map(((catalog?.workCenters ?? []) as WorkCenter[]).map((wc) => [wc.id, wc])),
    [catalog],
  )

  /** Family -> permanent slot, taken from catalog order so filtering never repaints. */
  const familySlot = useCallback(
    (familyId: string): SeriesSlot => {
      const index = (catalog?.families ?? []).findIndex((family) => family.id === familyId)
      if (index < 0 || index >= MAX_FAMILY_SERIES) return 'other'
      return (index + 1) as SeriesSlot
    },
    [catalog],
  )

  // --- volume by family -----------------------------------------------------

  const familyBars = useMemo(() => {
    const cells = familyRollup.data?.cells ?? []
    const byFamily = new Map<string, number[]>()
    for (const cell of cells) {
      const bucket = i32(axis.bucketOfWeek, cell.week)
      if (bucket < 0 || bucket >= bucketCount) continue
      let row = byFamily.get(cell.key)
      if (row === undefined) {
        row = new Array<number>(bucketCount).fill(0)
        byFamily.set(cell.key, row)
      }
      row[bucket] = numberAt(row, bucket) + cell.supplyUnits
    }

    const series: StackedBarSeries[] = []
    const other = new Array<number>(bucketCount).fill(0)
    let foldedCount = 0
    for (const family of catalog?.families ?? []) {
      const values = byFamily.get(family.id)
      if (values === undefined) continue
      const slot = familySlot(family.id)
      if (slot === 'other') {
        foldedCount += 1
        for (let i = 0; i < bucketCount; i += 1) other[i] = numberAt(other, i) + numberAt(values, i)
        continue
      }
      series.push({
        id: family.id,
        label: `${family.code} — ${family.name}`,
        slot,
        markShape: 'rect',
        values,
      })
    }
    // Anything not in the catalog's family list still has to land somewhere.
    for (const [familyId, values] of byFamily) {
      if (familyById.has(familyId)) continue
      foldedCount += 1
      for (let i = 0; i < bucketCount; i += 1) other[i] = numberAt(other, i) + numberAt(values, i)
    }
    if (foldedCount > 0) {
      series.push({
        id: '__other__',
        label: `Other (${foldedCount} famil${foldedCount === 1 ? 'y' : 'ies'})`,
        slot: 'other',
        markShape: 'rect',
        values: other,
      })
    }
    return series
  }, [familyRollup.data, axis.bucketOfWeek, bucketCount, catalog, familySlot, familyById])

  const familyTable = useMemo<TableViewProps>(
    () => ({
      caption:
        'Supply-plan units by product family and time bucket, with the families beyond the seventh folded into Other.',
      columns: [
        { key: 'bucket', label: 'Bucket' },
        ...familyBars.map((entry) => ({
          key: entry.id,
          label: entry.label,
          align: 'right' as const,
        })),
        { key: 'total', label: 'Total', align: 'right' as const },
      ],
      rows: buckets.map((bucket, index) => {
        const row: Record<string, string | number> = { bucket: bucket.longLabel }
        let total = 0
        for (const entry of familyBars) {
          const value = numberAt(entry.values, index)
          total += value
          row[entry.id] = formatUnits(value, { compact: true })
        }
        row['total'] = formatUnits(total, { compact: true })
        return row
      }),
      rowSlot: () => undefined,
    }),
    [familyBars, buckets],
  )

  // --- the group table ------------------------------------------------------

  /**
   * Which plants and work centers each group actually ran on.
   *
   * The roll-up carries no asset footprint for a product, so this is derived
   * from the highest-volume SKUs the worker will answer with in one page. It is
   * a floor, not a census, and the column header says so.
   */
  const footprintByGroup = useMemo(() => {
    const map = new Map<string, { plants: Set<string>; workCenters: Set<string> }>()
    for (const row of footprint.data?.rows ?? []) {
      let entry = map.get(row.groupId)
      if (entry === undefined) {
        entry = { plants: new Set<string>(), workCenters: new Set<string>() }
        map.set(row.groupId, entry)
      }
      for (const plantId of row.plantIds) entry.plants.add(plantId)
      for (const wcId of row.workCenterIds) entry.workCenters.add(wcId)
    }
    return map
  }, [footprint.data])

  const groupRows = useMemo<GroupRow[]>(() => {
    const totals = new Map<
      string,
      { supplyUnits: number; demandUnits: number; requiredHours: number }
    >()
    for (const cell of groupRollup.data?.cells ?? []) {
      const bucket = i32(axis.bucketOfWeek, cell.week)
      if (bucket < 0) continue
      const prior = totals.get(cell.key) ?? {
        supplyUnits: 0,
        demandUnits: 0,
        requiredHours: 0,
      }
      prior.supplyUnits += cell.supplyUnits
      prior.demandUnits += cell.demandUnits
      prior.requiredHours += cell.requiredHours
      totals.set(cell.key, prior)
    }
    const rows: GroupRow[] = []
    for (const [groupId, total] of totals) {
      const group = groupById.get(groupId)
      const family = group === undefined ? undefined : familyById.get(group.familyId)
      const shape = footprintByGroup.get(groupId)
      rows.push({
        groupId,
        code: group?.code ?? groupId,
        name: group?.name ?? groupId,
        familyName: family === undefined ? '—' : `${family.code} — ${family.name}`,
        skuCount: catalog?.materialCountByGroup[groupId] ?? 0,
        supplyUnits: total.supplyUnits,
        demandUnits: total.demandUnits,
        gapUnits: total.demandUnits - total.supplyUnits,
        requiredHours: total.requiredHours,
        plantIds: [...(shape?.plants ?? [])].sort(),
        workCenterCount: shape?.workCenters.size ?? 0,
      })
    }
    return rows
  }, [groupRollup.data, axis.bucketOfWeek, groupById, familyById, catalog, footprintByGroup])

  const groupColumns = useMemo<Array<DataTableColumn<GroupRow>>>(
    () => [
      {
        key: 'group',
        header: 'Product group',
        sortValue: (row) => row.name,
        render: (row) => (
          <span className={styles.twoLine}>
            <span className={styles.code}>{row.code}</span>
            <span className={styles.sub}>{row.name}</span>
          </span>
        ),
      },
      {
        key: 'family',
        header: 'Family',
        sortValue: (row) => row.familyName,
        render: (row) => row.familyName,
      },
      {
        key: 'skus',
        header: 'SKUs',
        align: 'right',
        sortValue: (row) => row.skuCount,
        render: (row) => formatUnits(row.skuCount),
      },
      {
        key: 'supply',
        header: 'Supply units',
        align: 'right',
        sortValue: (row) => row.supplyUnits,
        render: (row) => formatUnits(row.supplyUnits, { compact: true }),
      },
      {
        key: 'demand',
        header: 'Demand units',
        align: 'right',
        sortValue: (row) => row.demandUnits,
        render: (row) => formatUnits(row.demandUnits, { compact: true }),
      },
      {
        key: 'gap',
        header: 'Plan gap',
        align: 'right',
        sortValue: (row) => row.gapUnits,
        render: (row) => (
          <span className={row.gapUnits > 0 ? styles.gapOpen : styles.gapClosed}>
            {formatUnits(row.gapUnits, { compact: true })}
          </span>
        ),
      },
      {
        key: 'hours',
        header: 'Hours consumed',
        align: 'right',
        sortValue: (row) => row.requiredHours,
        render: (row) => formatHours(row.requiredHours, { compact: true }),
      },
      {
        key: 'plants',
        header: 'Plants making it',
        sortValue: (row) => row.plantIds.length,
        render: (row) => (
          <span className={styles.chipRow}>
            {row.plantIds.length === 0 ? (
              <span className={styles.sub}>—</span>
            ) : (
              row.plantIds.map((plantId) => (
                <Chip key={plantId} slot={plantSlot(plantId)}>
                  {plantById.get(plantId)?.code ?? plantId}
                </Chip>
              ))
            )}
          </span>
        ),
      },
      {
        key: 'workCenters',
        header: 'Work centers',
        align: 'right',
        sortValue: (row) => row.workCenterCount,
        render: (row) => (row.workCenterCount === 0 ? '—' : formatUnits(row.workCenterCount)),
      },
    ],
    [plantById, plantSlot],
  )

  // --- the SKU page ---------------------------------------------------------

  const sliceRows = useMemo(() => slice.data?.rows ?? [], [slice.data])

  const matchedRows = useMemo(() => {
    if (!searching) return sliceRows
    const needle = debouncedSearch.trim().toLowerCase()
    return sliceRows.filter(
      (row) =>
        row.code.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle),
    )
  }, [sliceRows, searching, debouncedSearch])

  const totalRows = searching ? matchedRows.length : (slice.data?.total ?? 0)
  const pageRows = useMemo(
    () => (searching ? matchedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : matchedRows),
    [searching, matchedRows, page],
  )
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))

  const skuColumns = useMemo<Array<DataTableColumn<MaterialSliceRow>>>(
    () => [
      {
        key: 'code',
        header: 'SKU',
        sortValue: (row) => row.code,
        render: (row) => (
          <span className={styles.twoLine}>
            <span className={styles.code}>{row.code}</span>
            <span className={styles.sub}>{row.description}</span>
          </span>
        ),
      },
      {
        key: 'group',
        header: 'Group',
        sortValue: (row) => groupById.get(row.groupId)?.name ?? row.groupId,
        render: (row) => groupById.get(row.groupId)?.name ?? row.groupId,
      },
      {
        key: 'family',
        header: 'Family',
        sortValue: (row) => familyById.get(row.familyId)?.name ?? row.familyId,
        render: (row) => familyById.get(row.familyId)?.name ?? row.familyId,
      },
      {
        key: 'abc',
        header: 'ABC',
        sortValue: (row) => facts.data?.get(row.materialId)?.abcClass ?? 'Z',
        render: (row) => {
          const abc = facts.data?.get(row.materialId)?.abcClass ?? ''
          if (abc === '') return <span className={styles.sub}>{facts.loading ? '…' : '—'}</span>
          return <Pill>{abc}</Pill>
        },
      },
      {
        key: 'type',
        header: 'Type',
        sortValue: (row) => facts.data?.get(row.materialId)?.type ?? 'ZZZ',
        render: (row) => {
          const type = facts.data?.get(row.materialId)?.type
          if (type === undefined) return <span className={styles.sub}>{facts.loading ? '…' : '—'}</span>
          return (
            <Badge tone={type === 'FERT' ? 'good' : 'neutral'} size="sm">
              {type}
            </Badge>
          )
        },
      },
      {
        key: 'units',
        header: 'Units',
        align: 'right',
        sortValue: (row) => row.units,
        render: (row) => formatUnits(row.units, { compact: true }),
      },
      {
        key: 'hours',
        header: 'Hours',
        align: 'right',
        sortValue: (row) => row.hours,
        render: (row) => formatHours(row.hours, { compact: true }),
      },
      {
        key: 'workCenters',
        header: 'Runs on',
        sortValue: (row) => row.workCenterIds.length,
        render: (row) => (
          <span className={styles.chipRow}>
            {row.workCenterIds.slice(0, 2).map((wcId) => (
              <Pill key={wcId}>{workCenterById.get(wcId)?.code ?? wcId}</Pill>
            ))}
            {row.workCenterIds.length > 2 ? (
              <span className={styles.sub}>+{row.workCenterIds.length - 2}</span>
            ) : null}
            {row.workCenterIds.length === 0 ? <span className={styles.sub}>—</span> : null}
          </span>
        ),
      },
      {
        key: 'plants',
        header: 'At',
        sortValue: (row) => row.plantIds.length,
        render: (row) => (
          <span className={styles.chipRow}>
            {row.plantIds.map((plantId) => (
              <Chip key={plantId} slot={plantSlot(plantId)}>
                {plantById.get(plantId)?.code ?? plantId}
              </Chip>
            ))}
            {row.plantIds.length === 0 ? <span className={styles.sub}>—</span> : null}
          </span>
        ),
      },
      {
        key: 'dual',
        header: 'Sourcing',
        sortValue: (row) => (row.dualSourced ? 1 : 0),
        render: (row) =>
          row.dualSourced ? (
            <Badge tone="warning" size="sm">
              Dual sourced
            </Badge>
          ) : (
            <Badge tone="neutral" size="sm">
              Single source
            </Badge>
          ),
      },
    ],
    [groupById, familyById, workCenterById, plantById, plantSlot, facts.data, facts.loading],
  )

  // --- headline figures -----------------------------------------------------

  const kpis = groupRollup.data?.kpis
  const dualShare = useMemo(() => {
    let dual = 0
    let total = 0
    for (const row of footprint.data?.rows ?? []) {
      total += row.units
      if (row.dualSourced) dual += row.units
    }
    return { ratio: safeDiv(dual, total), sampled: footprint.data?.rows.length ?? 0 }
  }, [footprint.data])

  // --- states ---------------------------------------------------------------

  if (catalog === null) {
    return (
      <div className={styles.page}>
        <EmptyState
          title="The product catalogue has not arrived yet"
          description="Families, groups and SKU counts land with the master data; the screen fills in as soon as the engine answers."
        />
      </div>
    )
  }

  const groupOptions = [
    { value: '', label: 'Every group in the filter' },
    ...(catalog.groups ?? []).map((group) => ({
      value: group.id,
      label: `${group.code} — ${group.name}`,
    })),
  ]

  return (
    <div className={styles.page}>
      <SectionHeading
        level={1}
        description="What the network is being asked to make, from eight families down to one SKU’s routing."
      >
        Products
      </SectionHeading>

      <FilterBar />

      {/* ------------------------------------------------------------------ */}
      <div className={styles.tiles}>
        <StatTile
          label="SKUs in view"
          value={formatUnits(slice.data?.total ?? 0)}
          deltaContext={`of ${formatUnits(catalog.meta.skuCount)} in the dataset`}
          hint="Materials with volume or hours after the filter row and the group focus."
        />
        <StatTile
          label="Product groups"
          value={formatUnits(groupRows.length)}
          deltaContext={`across ${formatUnits(catalog.families.length)} families`}
        />
        <StatTile
          label="Supply plan units"
          value={formatUnits(kpis?.supplyUnits ?? 0, { compact: true })}
          hint="The plan that loads capacity."
        />
        <StatTile
          label="Demand units"
          value={formatUnits(kpis?.demandUnits ?? 0, { compact: true })}
          hint="Reference only — demand never loads capacity."
        />
        <StatTile
          label="Plan gap"
          value={formatUnits(kpis?.planGapUnits ?? 0, { compact: true })}
          status={
            (kpis?.planGapUnits ?? 0) > 0
              ? { level: 'warning', label: 'Demand the plan does not serve' }
              : { level: 'good', label: 'The plan covers demand' }
          }
          hint="Demand minus supply plan."
        />
        <StatTile
          label="Dual-sourced volume"
          value={pct(dualShare.ratio)}
          deltaContext={`of the ${formatUnits(dualShare.sampled)} highest-volume SKUs in view`}
          hint="Two sources inside one bucket. Not the same object as a transfer, which changes source between buckets."
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      <ChartCard
        title="Volume by family"
        subtitle={`Supply-plan units per ${filters.bucket}, stacked by product family. Families beyond the seventh fold into Other rather than inventing an eighth hue.`}
        stale={familyRollup.loading && familyRollup.data !== null}
        table={familyTable}
      >
        {familyRollup.error !== null && familyRollup.data === null ? (
          <ErrorState title="The family roll-up failed" message={familyRollup.error} />
        ) : familyBars.length === 0 ? (
          <EmptyState
            title="No volume in this slice"
            description="Every family is filtered out, or the plan is empty across these weeks."
          />
        ) : (
          <StackedBarChart
            categories={bucketKeys}
            categoryLabel={bucketLabel}
            series={familyBars}
            format={(value) => compact(value)}
            yLabel="Units"
            height={300}
          />
        )}
      </ChartCard>

      {/* ------------------------------------------------------------------ */}
      <Card
        title="Supply against demand, by product group"
        subtitle="Sorted by the gap between what demand asked for and what the plan committed to. Click a group to narrow the SKU list below it."
        aside={
          <InfoTip label="Where the plant and work-center columns come from">
            The roll-up carries no asset footprint for a product, so those two columns are read
            from the {FOOTPRINT_FETCH} highest-volume SKUs the worker will answer with in one page.
            They are a floor on the real footprint, not a census.
          </InfoTip>
        }
        flush
        stale={groupRollup.loading && groupRollup.data !== null}
      >
        {groupRollup.error !== null && groupRollup.data === null ? (
          <ErrorState title="The group roll-up failed" message={groupRollup.error} />
        ) : (
          <DataTable<GroupRow>
            caption="Every product group in view with its supply, demand, gap, hours and asset footprint."
            columns={groupColumns}
            rows={groupRows}
            rowKey={(row) => row.groupId}
            initialSort={{ key: 'gap', dir: 'desc' }}
            selectedKey={groupFocus}
            onRowClick={(row) => setGroupFocus(groupFocus === row.groupId ? '' : row.groupId)}
            maxHeight={420}
            empty={
              <EmptyState
                title="No product group survives these filters"
                description="Widen the family or plant filter, or reset the week window."
              />
            }
          />
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card
        title="SKUs"
        subtitle={`Page ${page + 1} of ${pageCount} — ${formatUnits(totalRows)} SKU${totalRows === 1 ? '' : 's'} match. A hundred rows are fetched at a time; the material master never crosses out of the worker.`}
        aside={
          <div className={styles.skuControls}>
            <Select
              label="Narrow to one group"
              size="sm"
              value={groupFocus}
              options={groupOptions}
              onChange={setGroupFocus}
            />
            <Select
              label="Order by"
              size="sm"
              value={sortBy}
              options={[
                { value: 'hours', label: 'Hours consumed' },
                { value: 'units', label: 'Units planned' },
                { value: 'code', label: 'SKU code' },
              ]}
              onChange={(value) => setSortBy(value as 'hours' | 'units' | 'code')}
            />
          </div>
        }
        flush
        stale={slice.loading && slice.data !== null}
      >
        <div className={styles.searchRow}>
          <TextField
            label="Find a SKU by code or description"
            value={search}
            onChange={setSearch}
            placeholder="e.g. HOUSING or FG-10"
            hint={
              searching
                ? `Matching inside the ${SEARCH_FETCH} SKUs the worker returns for this sort and filter — narrow by group above to search a smaller set exactly.`
                : 'Type to search. The worker protocol carries no query parameter, so a search scans the largest page it will answer rather than all 15,000.'
            }
          />
          {searching ? (
            <Button icon="close" onClick={() => setSearch('')}>
              Clear the search
            </Button>
          ) : null}
        </div>

        {slice.error !== null && slice.data === null ? (
          <ErrorState title="The SKU page could not be fetched" message={slice.error} />
        ) : (
          <DataTable<MaterialSliceRow>
            caption="One page of SKUs with their volume, hours, asset footprint and sourcing."
            columns={skuColumns}
            rows={pageRows}
            rowKey={(row) => row.materialId}
            onRowClick={(row) => setSelected(row)}
            selectedKey={selected?.materialId}
            maxHeight={520}
            empty={
              <EmptyState
                title={searching ? `Nothing matches “${debouncedSearch}”` : 'No SKUs in this slice'}
                description={
                  searching
                    ? 'The search looks inside the page the worker returned. Narrow to a single group to search that group exactly.'
                    : 'Widen the family, group or plant filter, or reset the week window.'
                }
              />
            }
          />
        )}

        <div className={styles.pager}>
          <Button
            icon="chevronLeft"
            disabled={page === 0}
            onClick={() => setPage((prior) => Math.max(0, prior - 1))}
          >
            Previous
          </Button>
          <span className={styles.pagerLabel}>
            {totalRows === 0
              ? 'Nothing to page through'
              : `Showing ${formatUnits(page * PAGE_SIZE + 1)}–${formatUnits(Math.min((page + 1) * PAGE_SIZE, totalRows))} of ${formatUnits(totalRows)}`}
          </span>
          <Button
            iconRight="chevronRight"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((prior) => Math.min(pageCount - 1, prior + 1))}
          >
            Next
          </Button>
        </div>

        {facts.error === null ? null : (
          <p className={styles.footNote}>
            <Icon name="warning" size={12} /> ABC class and material type could not be read from the
            extract: {facts.error}
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.code ?? ''}
        description={selected?.description ?? ''}
        width={620}
      >
        {selected === null ? null : (
          <SkuDetail
            row={selected}
            fact={facts.data?.get(selected.materialId)}
            factsLoading={facts.loading}
            buckets={buckets}
            bucketOfWeek={axis.bucketOfWeek}
            bucketCount={bucketCount}
            groupName={groupById.get(selected.groupId)?.name ?? selected.groupId}
            familyName={familyById.get(selected.familyId)?.name ?? selected.familyId}
            workCentersById={workCenterById}
            plantSlotOf={plantSlot}
          />
        )}
      </Drawer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The SKU drawer
// ---------------------------------------------------------------------------

interface SkuDetailProps {
  row: MaterialSliceRow
  fact: MaterialFact | undefined
  factsLoading: boolean
  buckets: Bucket[]
  bucketOfWeek: Int32Array
  bucketCount: number
  groupName: string
  familyName: string
  workCentersById: ReadonlyMap<string, WorkCenter>
  plantSlotOf: (plantId: string) => 1 | 2 | 3 | 4 | 5
}

/**
 * Everything about one SKU.
 *
 * Mounted only while the drawer is open, which is what makes the roll-up here
 * affordable: `useRollup('material', groupId)` is answered for one product
 * group's materials, never for all fifteen thousand.
 */
function SkuDetail({
  row,
  fact,
  factsLoading,
  buckets,
  bucketOfWeek,
  bucketCount,
  groupName,
  familyName,
  workCentersById,
  plantSlotOf,
}: SkuDetailProps) {
  const catalog = useUiStore((state) => state.catalog)
  const materialRollup = useRollup('material', row.groupId)
  const routing = useLazy(loadRoutingMaster, true)

  const plantByCode = useMemo(
    () => new Map((catalog?.plants ?? []).map((plant) => [plant.code, plant])),
    [catalog],
  )
  const wcByPlantAndCode = useMemo(() => {
    const map = new Map<string, WorkCenter>()
    for (const wc of workCentersById.values()) {
      const plant = (catalog?.plants ?? []).find((entry) => entry.id === wc.plantId)
      map.set(`${plant?.code ?? ''}|${wc.code}`, wc)
    }
    return map
  }, [workCentersById, catalog])
  const opNameById = useMemo(
    () => new Map((catalog?.standardOperations ?? []).map((op) => [op.id, op])),
    [catalog],
  )

  // --- the plan for this SKU ------------------------------------------------

  const planSeries = useMemo<TimeSeries[]>(() => {
    const supply = new Array<number>(bucketCount).fill(0)
    const demand = new Array<number>(bucketCount).fill(0)
    for (const cell of materialRollup.data?.cells ?? []) {
      if (cell.key !== row.materialId) continue
      const bucket = i32(bucketOfWeek, cell.week)
      if (bucket < 0 || bucket >= bucketCount) continue
      supply[bucket] = numberAt(supply, bucket) + cell.supplyUnits
      demand[bucket] = numberAt(demand, bucket) + cell.demandUnits
    }
    const points = (values: number[]): TimeSeries['points'] =>
      buckets.map((bucket, index) => ({ month: bucket.key, value: numberAt(values, index) }))
    return [
      { id: 'supply', label: 'Supply plan', slot: 1, markShape: 'line', points: points(supply) },
      { id: 'demand', label: 'Demand', slot: 2, markShape: 'line', points: points(demand) },
    ]
  }, [materialRollup.data, row.materialId, bucketOfWeek, bucketCount, buckets])

  const planTable = useMemo<TableViewProps>(
    () => ({
      caption: `Supply plan and demand for ${row.code} per bucket.`,
      columns: [
        { key: 'bucket', label: 'Bucket' },
        { key: 'supply', label: 'Supply', align: 'right' },
        { key: 'demand', label: 'Demand', align: 'right' },
        { key: 'gap', label: 'Gap', align: 'right' },
      ],
      rows: buckets.map((bucket, index) => {
        const supply = planSeries[0]?.points[index]?.value ?? 0
        const demand = planSeries[1]?.points[index]?.value ?? 0
        return {
          bucket: bucket.longLabel,
          supply: formatUnits(supply),
          demand: formatUnits(demand),
          gap: formatUnits(demand - supply),
        }
      }),
      rowSlot: () => undefined,
    }),
    [buckets, planSeries, row.code],
  )

  // --- routings -------------------------------------------------------------

  interface ShownRouting {
    key: string
    header: RoutingHeaderRow
    operations: RoutingOperationRow[]
  }

  const routings = useMemo<ShownRouting[]>(() => {
    const master = routing.data
    if (master === null) return []
    const keys = master.keysByMaterialCode.get(row.code) ?? []
    const list: ShownRouting[] = []
    for (const key of keys) {
      const header = master.headerByKey.get(key)
      if (header === undefined) continue
      list.push({ key, header, operations: master.opsByKey.get(key) ?? [] })
    }
    list.sort((a, b) => {
      if (a.header.primary !== b.header.primary) return a.header.primary ? -1 : 1
      return a.header.plantCode.localeCompare(b.header.plantCode)
    })
    return list
  }, [routing.data, row.code])

  const primary = routings.find((entry) => entry.header.primary) ?? routings[0]
  const alternates = routings.filter((entry) => entry !== primary)

  const inventory = routing.data?.inventoryByCode.get(row.code) ?? []

  return (
    <div className={styles.detail}>
      <div className={styles.detailBadges}>
        {fact === undefined ? (
          <Badge tone="neutral" size="sm">
            {factsLoading ? 'Reading the material master…' : 'Material master unavailable'}
          </Badge>
        ) : (
          <>
            <Badge tone={fact.type === 'FERT' ? 'good' : 'neutral'} size="sm">
              {fact.type === 'FERT'
                ? 'FERT — finished'
                : fact.type === 'HALB'
                  ? 'HALB — semi-finished'
                  : 'ROH — raw'}
            </Badge>
            <Badge tone="neutral" size="sm">
              ABC {fact.abcClass === '' ? '—' : fact.abcClass}
            </Badge>
          </>
        )}
        {row.dualSourced ? (
          <Badge tone="warning" size="sm">
            Dual sourced in at least one bucket
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            Single source every bucket
          </Badge>
        )}
      </div>

      <dl className={styles.detailStats}>
        <div>
          <dt>Product group</dt>
          <dd>{groupName}</dd>
        </div>
        <div>
          <dt>Family</dt>
          <dd>{familyName}</dd>
        </div>
        <div>
          <dt>Units in the window</dt>
          <dd>{formatUnits(row.units)}</dd>
        </div>
        <div>
          <dt>Hours in the window</dt>
          <dd>{formatHours(row.hours)}</dd>
        </div>
        {fact === undefined ? null : (
          <>
            <div>
              <dt>Price</dt>
              <dd>{usd(fact.pricePerUnitUsd, { dp: 2 })}</dd>
            </div>
            <div>
              <dt>Material cost</dt>
              <dd>{usd(fact.materialCostPerUnitUsd, { dp: 2 })}</dd>
            </div>
            <div>
              <dt>Handling unit</dt>
              <dd>
                {formatUnits(fact.unitsPerHandlingUnit)} {fact.baseUom}
              </dd>
            </div>
            <div>
              <dt>Weight</dt>
              <dd>{fact.weightKgPerUnit.toFixed(2)} kg / unit</dd>
            </div>
          </>
        )}
      </dl>

      <p className={styles.detailNote}>
        Hours are allocated, not measured: the engine never materialises per-SKU-per-week hours, so
        this SKU carries its product group’s measured hours in proportion to its share of the
        group’s units in each bucket.
      </p>

      {/* --- routing ---------------------------------------------------- */}
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>Routing</h3>
        {routing.loading && routing.data === null ? (
          <EmptyState
            icon="clock"
            title="Reading the routing master"
            description="PLKO, PLPO, MAPL and INVENTORY are read once per session and then cached."
          />
        ) : routing.error !== null ? (
          <ErrorState title="The routing master could not be read" message={routing.error} />
        ) : primary === undefined ? (
          <EmptyState
            title="No routing is assigned to this SKU"
            description="Nothing in MAPL points at a production version for this material."
          />
        ) : (
          <>
            <p className={styles.detailNote}>
              Production version {primary.header.version} at{' '}
              {plantByCode.get(primary.header.plantCode)?.name ?? primary.header.plantCode}
              {primary.header.validFrom === '' && primary.header.validTo === ''
                ? ', approved for the whole horizon'
                : `, valid ${primary.header.validFrom === '' ? 'from the start' : primary.header.validFrom} to ${primary.header.validTo === '' ? 'the end' : primary.header.validTo}`}
              . Rates are master data — what a scenario does to load is what the plan numbers above
              show.
            </p>
            <ol className={styles.opList}>
              {primary.operations.map((op) => {
                const wc = wcByPlantAndCode.get(`${op.plantCode}|${op.workCenterCode}`)
                const rate = safeDiv(op.baseQty, op.machineHoursPerBase)
                const oee = wc?.baseOee ?? 0
                return (
                  <li key={`${op.seq}-${op.opId}`} className={styles.opRow}>
                    <span className={styles.opSeq}>{String(op.seq).padStart(4, '0')}</span>
                    <div className={styles.opBody}>
                      <p className={styles.opTitle}>
                        {opNameById.get(op.opId)?.name ?? op.opId}
                        <span className={styles.sub}> · {opNameById.get(op.opId)?.code ?? ''}</span>
                      </p>
                      <p className={styles.opWhere}>
                        <Chip slot={plantSlotOf(wc?.plantId ?? '')}>
                          {plantByCode.get(op.plantCode)?.code ?? op.plantCode}
                        </Chip>
                        <span className={styles.code}>{op.workCenterCode}</span>
                        <span className={styles.sub}>{wc?.name ?? ''}</span>
                      </p>
                      <dl className={styles.opStats}>
                        <div>
                          <dt>Rate</dt>
                          <dd>{formatUnits(rate)} / machine h</dd>
                        </div>
                        <div>
                          <dt>After OEE {pct(oee, 0)}</dt>
                          <dd>{formatUnits(rate * oee)} / h</dd>
                        </div>
                        <div>
                          <dt>Setup</dt>
                          <dd>{op.setupHours.toFixed(2)} h / lot</dd>
                        </div>
                        <div>
                          <dt>Yield</dt>
                          <dd>{pct(1 - op.scrapPct / 100)}</dd>
                        </div>
                        <div>
                          <dt>Labour</dt>
                          <dd>
                            {op.labourHoursPerBase.toFixed(3)} h / {formatUnits(op.baseQty)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </section>

      {/* --- alternates ------------------------------------------------- */}
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>Alternates</h3>
        {alternates.length === 0 ? (
          <p className={styles.detailNote}>
            {routing.data === null
              ? 'Read once the routing master lands.'
              : 'This SKU has exactly one production version. There is nowhere else it is approved to be made.'}
          </p>
        ) : (
          <ul className={styles.altList}>
            {alternates.map((entry) => (
              <li key={entry.key} className={styles.altRow}>
                <Chip slot={plantSlotOf(plantByCode.get(entry.header.plantCode)?.id ?? '')}>
                  {plantByCode.get(entry.header.plantCode)?.code ?? entry.header.plantCode}
                </Chip>
                <span className={styles.code}>Version {entry.header.version}</span>
                <span className={styles.sub}>
                  {entry.operations.length} operation{entry.operations.length === 1 ? '' : 's'} ·{' '}
                  {entry.operations.map((op) => op.workCenterCode).join(' → ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- plan -------------------------------------------------------- */}
      <ChartCard
        title="Supply and demand, week by week"
        subtitle="Supply is what the plan committed to build; demand is what was asked for. The distance between them is this SKU’s share of the plan gap."
        stale={materialRollup.loading && materialRollup.data !== null}
        table={planTable}
      >
        {materialRollup.error !== null && materialRollup.data === null ? (
          <ErrorState title="The plan for this SKU could not be fetched" message={materialRollup.error} />
        ) : materialRollup.data === null ? (
          <EmptyState
            icon="clock"
            title="Fetching this SKU’s plan"
            description="The roll-up is answered for one product group’s materials, never for the whole catalogue."
          />
        ) : (
          <LineChart
            series={planSeries}
            format={(value) => compact(value)}
            yLabel="Units"
            height={220}
          />
        )}
      </ChartCard>

      {/* --- inventory --------------------------------------------------- */}
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>Inventory position</h3>
        {routing.data === null ? (
          <p className={styles.detailNote}>Read once the inventory extract lands.</p>
        ) : inventory.length === 0 ? (
          <p className={styles.detailNote}>
            No stock is recorded for this SKU at any plant — it is built to the plan.
          </p>
        ) : (
          <table className={styles.invTable}>
            <caption className={styles.invCaption}>
              On hand, in transit and safety stock for {row.code}, by plant.
            </caption>
            <thead>
              <tr>
                <th scope="col">Plant</th>
                <th scope="col">On hand</th>
                <th scope="col">In transit</th>
                <th scope="col">Safety stock</th>
                <th scope="col">Cover vs safety</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((entry) => (
                <tr key={entry.plantCode}>
                  <th scope="row">
                    {plantByCode.get(entry.plantCode)?.name ?? entry.plantCode}
                  </th>
                  <td>{formatUnits(entry.onHand)}</td>
                  <td>{formatUnits(entry.inTransit)}</td>
                  <td>{formatUnits(entry.safetyStock)}</td>
                  <td>
                    {entry.safetyStock <= 0
                      ? '—'
                      : pct(safeDiv(entry.onHand + entry.inTransit, entry.safetyStock))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

export default Products
