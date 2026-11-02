/**
 * Data — the master data behind every other screen, and the door it came in
 * through.
 *
 * Everything here is deliberately literal. A planner who does not believe a
 * number on the cockpit should be able to come to this screen, find the row it
 * came from, and either believe it or file a master-data ticket. So the tables
 * show what the extract actually says — pool counts, shift patterns, scrap
 * percentages, capacity ids — rather than a friendlier summary of it.
 *
 * Three notes on how it is built.
 *
 * 1. **The catalog covers three of the six tabs; the extract covers the rest.**
 *    Plants, work centers and machine classes are resident on the main thread.
 *    Routings, downtime and inventory are not — they are tens of thousands of
 *    rows that the worker holds by design — so those tabs read the SAP extract
 *    the worker can already write, once per session, and cache it at module
 *    scope. That is the same data, through the same door the import panel uses.
 *
 * 2. **The plan tables are never browsed.** SUPPLY is 15,000 materials x 78
 *    weeks. It is exported, not rendered, and the Plans tab says so out loud
 *    and shows the roll-up instead, which is the same plan at a readable size.
 *
 * 3. **An import never drops a row silently.** Validation runs the real loader
 *    and every error it reports is listed with its table and its 1-based
 *    physical row number. Importing anyway is a separate, explicitly labelled
 *    button that removes exactly the flagged rows and re-validates, so what was
 *    lost is on screen before anything is committed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CapacityPool, Scenario } from '@/domain/types'
import { safeDiv } from '@/domain/lookup'
import { baselineScenario } from '@/domain/engine'
import { PROFILES } from '@/data/profiles'
import { EXTRACT_TABLES, SAP_TABLES, TABLE_DESCRIPTIONS, weeklyPoolHours } from '@/data/sap-writer'
import type { SapTable } from '@/worker/protocol'
import { loadSnapshot } from '@/data/sap-loader'
import { download, parseCsvRows, toCsv } from '@/lib/csv'
import { compact, hours as formatHours, pct, units as formatUnits, usd } from '@/lib/format'
import { StatTile } from '@/charts'
import {
  Badge,
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  InfoTip,
  Modal,
  Pill,
  SectionHeading,
  Select,
  TabPanel,
  Tabs,
  TextField,
} from '@/components'
import type { DataTableColumn } from '@/components'
import { useRollup } from '@/state/model'
import { useUiStore } from '@/state/store'
import { getEngineClient, initWorker, resetEngineClient } from '@/worker/client'
import { resetProductMasterCache } from '@/routes/Products'
import styles from '@/routes/DataAdmin.module.css'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rows materialised for display. Beyond this the count is reported, not the rows. */
const MAX_DISPLAY_ROWS = 4000

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function forEachRow(text: string, onRow: (cell: (column: string) => string) => void): number {
  let cols: Map<string, number> | null = null
  let count = 0
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
    count += 1
    const map = cols
    onRow((column) => cells[map.get(column) ?? -1] ?? '')
  })
  return count
}

function countRows(text: string): number {
  let count = 0
  parseCsvRows(text, () => {
    count += 1
  })
  return Math.max(0, count - 1)
}

function toNumber(raw: string): number {
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

/** File name -> extract table key, the same way the loader normalises it. */
function tableKeyOf(fileName: string): string {
  const bare = fileName.split(/[\\/]/).pop() ?? fileName
  return bare.replace(/\.csv$/i, '').trim().toUpperCase()
}

// ---------------------------------------------------------------------------
// The extract-backed master data
// ---------------------------------------------------------------------------

interface RoutingHeaderRow {
  key: string
  routingId: string
  version: string
  plantCode: string
  primary: boolean
  validFrom: string
  validTo: string
}

interface DowntimeRow {
  eventId: string
  capacityId: string
  workCenterCode: string
  plantCode: string
  kind: string
  status: string
  fromWeek: string
  toWeek: string
  hoursPerWeek: string
  pool: string
  label: string
  slipWeeks: string
}

interface AdminMaster {
  routings: RoutingHeaderRow[]
  routingTotal: number
  downtime: DowntimeRow[]
  downtimeTotal: number
  capacityCount: number
}

interface RoutingOperationRow {
  routingKey: string
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

interface RoutingOps {
  opsByKey: Map<string, RoutingOperationRow[]>
  materialsByKey: Map<string, string[]>
  operationTotal: number
  assignmentTotal: number
}

interface InventoryRow {
  code: string
  plantCode: string
  onHand: number
  inTransit: number
  safetyStock: number
}

let masterPromise: Promise<AdminMaster> | null = null
let opsPromise: Promise<RoutingOps> | null = null
let inventoryPromise: Promise<{ rows: InventoryRow[]; total: number }> | null = null

/** Drop everything read from the extract. Called when the dataset is replaced. */
export function resetAdminCaches(): void {
  masterPromise = null
  opsPromise = null
  inventoryPromise = null
}

function loadAdminMaster(): Promise<AdminMaster> {
  const existing = masterPromise
  if (existing !== null) return existing
  const promise = (async () => {
    const client = getEngineClient()
    const scenario = baselineScenario()
    const [plko, kapa, crca] = await Promise.all([
      client.exportCsv(scenario, 'PLKO'),
      client.exportCsv(scenario, 'KAPA'),
      client.exportCsv(scenario, 'CRCA'),
    ])

    const capacity = new Map<string, { workCenterCode: string; plantCode: string }>()
    forEachRow(crca, (cell) => {
      capacity.set(cell('KAPID'), { workCenterCode: cell('ARBPL'), plantCode: cell('WERKS') })
    })

    const routings: RoutingHeaderRow[] = []
    const routingTotal = forEachRow(plko, (cell) => {
      if (routings.length >= MAX_DISPLAY_ROWS) return
      const routingId = cell('PLNNR')
      const version = cell('PLNAL')
      routings.push({
        key: `${routingId}|${version}`,
        routingId,
        version,
        plantCode: cell('WERKS'),
        primary: cell('ZPRIMARY') === 'X' || cell('ZPRIMARY') === 'true',
        validFrom: cell('ZVALIDFROM'),
        validTo: cell('ZVALIDTO'),
      })
    })

    const downtime: DowntimeRow[] = []
    let downtimeTotal = 0
    let capacityCount = 0
    forEachRow(kapa, (cell) => {
      const kind = cell('KIND')
      // KAPA carries both the weekly capacity offer and the dated interruptions
      // to it. Only the second kind is a downtime event.
      if (kind === 'AVAIL') {
        capacityCount += 1
        return
      }
      downtimeTotal += 1
      if (downtime.length >= MAX_DISPLAY_ROWS) return
      const capacityId = cell('KAPID')
      const where = capacity.get(capacityId)
      downtime.push({
        eventId: cell('ZEVENTID'),
        capacityId,
        workCenterCode: where?.workCenterCode ?? '—',
        plantCode: where?.plantCode ?? '—',
        kind,
        status: cell('STATUS'),
        fromWeek: cell('WEEK'),
        toWeek: cell('ZENDWEEK'),
        hoursPerWeek: cell('HOURS'),
        pool: cell('POOLS'),
        label: cell('LABEL'),
        slipWeeks: cell('ZSLIPWEEKS'),
      })
    })

    return { routings, routingTotal, downtime, downtimeTotal, capacityCount }
  })().catch((error: unknown) => {
    masterPromise = null
    throw error
  })
  masterPromise = promise
  return promise
}

function loadRoutingOps(): Promise<RoutingOps> {
  const existing = opsPromise
  if (existing !== null) return existing
  const promise = (async () => {
    const client = getEngineClient()
    const scenario = baselineScenario()
    const [plpo, mapl] = await Promise.all([
      client.exportCsv(scenario, 'PLPO'),
      client.exportCsv(scenario, 'MAPL'),
    ])
    const opsByKey = new Map<string, RoutingOperationRow[]>()
    const operationTotal = forEachRow(plpo, (cell) => {
      const routingKey = `${cell('PLNNR')}|${cell('PLNAL')}`
      const row: RoutingOperationRow = {
        routingKey,
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

    const materialsByKey = new Map<string, string[]>()
    const assignmentTotal = forEachRow(mapl, (cell) => {
      const routingKey = `${cell('PLNNR')}|${cell('PLNAL')}`
      const list = materialsByKey.get(routingKey)
      if (list === undefined) materialsByKey.set(routingKey, [cell('MATNR')])
      else list.push(cell('MATNR'))
    })
    return { opsByKey, materialsByKey, operationTotal, assignmentTotal }
  })().catch((error: unknown) => {
    opsPromise = null
    throw error
  })
  opsPromise = promise
  return promise
}

function loadInventory(): Promise<{ rows: InventoryRow[]; total: number }> {
  const existing = inventoryPromise
  if (existing !== null) return existing
  const promise = (async () => {
    const text = await getEngineClient().exportCsv(baselineScenario(), 'INVENTORY')
    const rows: InventoryRow[] = []
    const total = forEachRow(text, (cell) => {
      if (rows.length >= MAX_DISPLAY_ROWS) return
      rows.push({
        code: cell('MATNR'),
        plantCode: cell('WERKS'),
        onHand: toNumber(cell('LABST')),
        inTransit: toNumber(cell('TRANS')),
        safetyStock: toNumber(cell('SAFETY')),
      })
    })
    return { rows, total }
  })().catch((error: unknown) => {
    inventoryPromise = null
    throw error
  })
  inventoryPromise = promise
  return promise
}

interface Loaded<T> {
  data: T | null
  loading: boolean
  error: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useLazy<T>(load: () => Promise<T>, enabled: boolean, generation: number): Loaded<T> {
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
    // `load` is a module-level function guarding a module-level cache, so it is
    // stable by construction. `generation` is what invalidates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, generation])
  return state
}

// ---------------------------------------------------------------------------
// Import validation
// ---------------------------------------------------------------------------

interface ParsedError {
  table: string
  /** 1-based physical record number, header included. Undefined for table-wide errors. */
  line?: number
  message: string
  raw: string
}

const ROW_ERROR = /^([A-Z0-9_]+) row (\d+): (.*)$/
const TABLE_ERROR = /^([A-Z0-9_]+): (.*)$/

function parseDiagnostic(raw: string): ParsedError {
  const row = ROW_ERROR.exec(raw)
  if (row !== null) {
    return {
      table: row[1] ?? '',
      line: Number(row[2] ?? '0'),
      message: row[3] ?? raw,
      raw,
    }
  }
  const table = TABLE_ERROR.exec(raw)
  if (table !== null) return { table: table[1] ?? '', message: table[2] ?? raw, raw }
  return { table: '—', message: raw, raw }
}

interface DetectedFile {
  fileName: string
  table: string
  known: boolean
  rows: number
}

interface ImportState {
  files: Record<string, string>
  detected: DetectedFile[]
  errors: ParsedError[]
  warnings: ParsedError[]
  checking: boolean
  /** Set once rows have been stripped, so the panel can say what was lost. */
  strippedRows: number
  strippedTables: string[]
  unsalvageable: string[]
}

const EMPTY_IMPORT: ImportState = {
  files: {},
  detected: [],
  errors: [],
  warnings: [],
  checking: false,
  strippedRows: 0,
  strippedTables: [],
  unsalvageable: [],
}

/**
 * Rebuild each flagged file without its bad rows.
 *
 * Row numbers come straight from the loader and count physical records
 * including the header, which is why row 1 is treated as unsalvageable: a header
 * missing a required column cannot be fixed by deleting a line.
 */
function stripBadRows(
  files: Record<string, string>,
  errors: ParsedError[],
): { files: Record<string, string>; dropped: number; tables: string[]; unsalvageable: string[] } {
  const byTable = new Map<string, Set<number>>()
  const unsalvageable: string[] = []
  for (const error of errors) {
    if (error.line === undefined) {
      if (!unsalvageable.includes(error.table)) unsalvageable.push(error.table)
      continue
    }
    if (error.line <= 1) {
      if (!unsalvageable.includes(error.table)) unsalvageable.push(error.table)
      continue
    }
    const set = byTable.get(error.table)
    if (set === undefined) byTable.set(error.table, new Set([error.line]))
    else set.add(error.line)
  }

  const next: Record<string, string> = {}
  const tables: string[] = []
  let dropped = 0
  for (const [fileName, text] of Object.entries(files)) {
    const table = tableKeyOf(fileName)
    const bad = byTable.get(table)
    if (bad === undefined || bad.size === 0) {
      next[fileName] = text
      continue
    }
    const kept: string[][] = []
    parseCsvRows(text, (cells, rowNumber) => {
      if (bad.has(rowNumber)) {
        dropped += 1
        return
      }
      kept.push(cells)
    })
    next[fileName] = toCsv(kept)
    tables.push(table)
  }
  return { files: next, dropped, tables, unsalvageable }
}

// ---------------------------------------------------------------------------
// Scenario JSON
// ---------------------------------------------------------------------------

function exportScenarioJson(scenario: Scenario): void {
  const payload = {
    format: 'capacity-cockpit-scenario',
    version: 1,
    name: scenario.name,
    description: scenario.description,
    moves: scenario.moves
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => ({
        label: entry.label,
        enabled: entry.enabled,
        seq: entry.seq,
        move: entry.move,
      })),
  }
  const safe = scenario.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  download(
    `scenario-${safe === '' ? 'export' : safe}.json`,
    JSON.stringify(payload, null, 2),
    'application/json;charset=utf-8',
  )
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

type TabId = 'plants' | 'workCenters' | 'classes' | 'routings' | 'downtime' | 'plans'

export function DataAdmin() {
  const catalog = useUiStore((state) => state.catalog)
  const timings = useUiStore((state) => state.timings)
  const runtimeMs = useUiStore((state) => state.runtimeMs)
  const usingFallback = useUiStore((state) => state.usingFallback)
  const scenarios = useUiStore((state) => state.scenarios)
  const activeScenarioId = useUiStore((state) => state.activeScenarioId)
  const notify = useUiStore((state) => state.notify)

  const [tab, setTab] = useState<TabId>('plants')
  const [search, setSearch] = useState('')
  const [selectedRouting, setSelectedRouting] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [importState, setImportState] = useState<ImportState>(EMPTY_IMPORT)
  const [profileTarget, setProfileTarget] = useState<string | null>(null)
  const [switching, setSwitching] = useState<{ phase: string; pct: number } | null>(null)

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0],
    [scenarios, activeScenarioId],
  )

  const master = useLazy(loadAdminMaster, catalog !== null, generation)
  const ops = useLazy(loadRoutingOps, tab === 'routings', generation)
  const inventory = useLazy(loadInventory, tab === 'plans', generation)

  useEffect(() => {
    setSearch('')
  }, [tab])

  const needle = search.trim().toLowerCase()
  const matches = useCallback(
    (...fields: Array<string | number | undefined>): boolean => {
      if (needle === '') return true
      for (const field of fields) {
        if (field === undefined) continue
        if (String(field).toLowerCase().includes(needle)) return true
      }
      return false
    },
    [needle],
  )

  // --- lookups --------------------------------------------------------------

  const plantById = useMemo(
    () => new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant])),
    [catalog],
  )
  const classById = useMemo(
    () => new Map((catalog?.machineClasses ?? []).map((entry) => [entry.id, entry])),
    [catalog],
  )
  const featureById = useMemo(
    () => new Map((catalog?.features ?? []).map((entry) => [entry.id, entry])),
    [catalog],
  )

  // --- export ---------------------------------------------------------------

  const exportTable = useCallback(
    async (table: SapTable): Promise<void> => {
      setExporting(table)
      setExportError(null)
      try {
        const scenario = activeScenario ?? baselineScenario()
        const content = await getEngineClient().exportCsv(scenario, table)
        download(`${table}.csv`, content)
        notify(`${table}.csv written from “${scenario.name}”.`, 'good')
      } catch (error: unknown) {
        setExportError(`${table} could not be written: ${messageOf(error)}`)
      } finally {
        setExporting(null)
      }
    },
    [activeScenario, notify],
  )

  // --- import ---------------------------------------------------------------

  const runValidation = useCallback((files: Record<string, string>, stripped: {
    dropped: number
    tables: string[]
    unsalvageable: string[]
  } | null) => {
    const detected: DetectedFile[] = Object.entries(files).map(([fileName, text]) => {
      const table = tableKeyOf(fileName)
      return {
        fileName,
        table,
        known: (EXTRACT_TABLES as readonly string[]).includes(table),
        rows: countRows(text),
      }
    })
    setImportState({
      files,
      detected,
      errors: [],
      warnings: [],
      checking: true,
      strippedRows: stripped?.dropped ?? 0,
      strippedTables: stripped?.tables ?? [],
      unsalvageable: stripped?.unsalvageable ?? [],
    })
    // One turn of the loop so the "checking" state paints before the loader
    // blocks the thread on a million plan rows.
    setTimeout(() => {
      let errors: ParsedError[] = []
      let warnings: ParsedError[] = []
      try {
        const result = loadSnapshot(files, { generatedBy: 'sap-extract', sourceLabel: 'Imported extract' })
        errors = result.errors.map(parseDiagnostic)
        warnings = result.warnings.map(parseDiagnostic)
      } catch (error: unknown) {
        errors = [{ table: '—', message: messageOf(error), raw: messageOf(error) }]
      }
      setImportState((prior) => ({ ...prior, errors, warnings, checking: false }))
    }, 0)
  }, [])

  const onFilesChosen = useCallback(
    async (fileList: FileList | null): Promise<void> => {
      if (fileList === null || fileList.length === 0) return
      const files: Record<string, string> = {}
      for (let i = 0; i < fileList.length; i += 1) {
        const file = fileList.item(i)
        if (file === null) continue
        files[file.name] = await file.text()
      }
      runValidation(files, null)
    },
    [runValidation],
  )

  const commitImport = useCallback(
    async (files: Record<string, string>): Promise<void> => {
      setSwitching({ phase: 'Loading the extract', pct: 0.02 })
      try {
        resetEngineClient()
        resetAdminCaches()
        resetProductMasterCache()
        const result = await initWorker({ kind: 'csv', files }, (phase, pct) =>
          setSwitching({ phase, pct }),
        )
        useUiStore.getState().setReady(result.catalog, result.timings, result.usingFallback)
        for (const scenario of useUiStore.getState().scenarios) {
          if (scenario.readonly !== true) useUiStore.getState().deleteScenario(scenario.id)
        }
        setGeneration((prior) => prior + 1)
        setImportState(EMPTY_IMPORT)
        notify('The imported extract is now the dataset. Unsaved scenarios were discarded.', 'good')
      } catch (error: unknown) {
        setImportState((prior) => ({
          ...prior,
          errors: [
            ...prior.errors,
            { table: '—', message: messageOf(error), raw: messageOf(error) },
          ],
        }))
      } finally {
        setSwitching(null)
      }
    },
    [notify],
  )

  const importAnyway = useCallback(() => {
    const stripped = stripBadRows(importState.files, importState.errors)
    runValidation(stripped.files, stripped)
  }, [importState.files, importState.errors, runValidation])

  // --- profile switch -------------------------------------------------------

  const switchProfile = useCallback(
    async (profileId: string): Promise<void> => {
      const profile = PROFILES.find((entry) => entry.id === profileId)
      if (profile === undefined) return
      setProfileTarget(null)
      setSwitching({ phase: `Generating ${profile.label}`, pct: 0.02 })
      try {
        resetEngineClient()
        resetAdminCaches()
        resetProductMasterCache()
        const result = await initWorker(
          { kind: 'factory', profile: profile.id, seed: profile.seed },
          (phase, pct) => setSwitching({ phase, pct }),
        )
        useUiStore.getState().setReady(result.catalog, result.timings, result.usingFallback)
        for (const scenario of useUiStore.getState().scenarios) {
          if (scenario.readonly !== true) useUiStore.getState().deleteScenario(scenario.id)
        }
        setGeneration((prior) => prior + 1)
        notify(`Switched to ${profile.label}. Unsaved scenarios were discarded.`, 'good')
      } catch (error: unknown) {
        useUiStore.getState().setError(messageOf(error))
      } finally {
        setSwitching(null)
      }
    },
    [notify],
  )

  // --- table rows -----------------------------------------------------------

  const plantRows = useMemo(
    () =>
      (catalog?.plants ?? []).filter((plant) =>
        matches(plant.code, plant.name, plant.city, plant.country, plant.region, plant.currency),
      ),
    [catalog, matches],
  )

  const workCenterRows = useMemo(
    () =>
      (catalog?.workCenters ?? []).filter((wc) =>
        matches(
          wc.code,
          wc.name,
          plantById.get(wc.plantId)?.code,
          plantById.get(wc.plantId)?.city,
          classById.get(wc.classId)?.name,
          wc.status,
          wc.vintage,
        ),
      ),
    [catalog, matches, plantById, classById],
  )

  const classRows = useMemo(
    () =>
      (catalog?.machineClasses ?? []).filter((entry) =>
        matches(entry.id, entry.name, entry.supplier, entry.generation),
      ),
    [catalog, matches],
  )

  const retrofitRows = useMemo(() => {
    const rows: Array<{
      id: string
      className: string
      name: string
      capexUsd: number
      leadTimeWeeks: number
      oeeDelta: number
      addsFeatures: string[]
      description: string
    }> = []
    for (const cls of catalog?.machineClasses ?? []) {
      for (const option of cls.retrofits) {
        rows.push({
          id: `${cls.id}|${option.id}`,
          className: cls.name,
          name: option.name,
          capexUsd: option.capexUsd,
          leadTimeWeeks: option.leadTimeWeeks,
          oeeDelta: option.oeeDelta,
          addsFeatures: option.addsFeatures,
          description: option.description,
        })
      }
    }
    return rows.filter((row) => matches(row.className, row.name, row.description))
  }, [catalog, matches])

  const featureRows = useMemo(
    () =>
      (catalog?.features ?? []).filter((feature) =>
        matches(feature.id, feature.name, feature.group, feature.description),
      ),
    [catalog, matches],
  )

  const routingRows = useMemo(
    () =>
      (master.data?.routings ?? []).filter((row) =>
        matches(row.routingId, row.version, row.plantCode),
      ),
    [master.data, matches],
  )

  const downtimeRows = useMemo(
    () =>
      (master.data?.downtime ?? []).filter((row) =>
        matches(row.eventId, row.workCenterCode, row.plantCode, row.kind, row.status, row.label),
      ),
    [master.data, matches],
  )

  const inventoryRows = useMemo(
    () => (inventory.data?.rows ?? []).filter((row) => matches(row.code, row.plantCode)),
    [inventory.data, matches],
  )

  const selectedOps = useMemo(
    () => (selectedRouting === null ? [] : (ops.data?.opsByKey.get(selectedRouting) ?? [])),
    [selectedRouting, ops.data],
  )

  // --- column definitions ---------------------------------------------------

  type PlantRow = NonNullable<typeof catalog>['plants'][number]
  const plantColumns = useMemo<Array<DataTableColumn<PlantRow>>>(
    () => [
      {
        key: 'code',
        header: 'Plant',
        sortValue: (row) => row.code,
        render: (row) => (
          <span className={styles.chipRow}>
            <Chip slot={row.colorSlot}>{row.code}</Chip>
            <span className={styles.sub}>{row.name}</span>
          </span>
        ),
      },
      { key: 'city', header: 'City', sortValue: (row) => row.city, render: (row) => row.city },
      {
        key: 'country',
        header: 'Country',
        sortValue: (row) => row.country,
        render: (row) => `${row.country} (${row.countryCode})`,
      },
      { key: 'region', header: 'Region', sortValue: (row) => row.region, render: (row) => row.region },
      {
        key: 'timezone',
        header: 'Timezone',
        sortValue: (row) => row.timezone,
        render: (row) => row.timezone,
      },
      {
        key: 'coords',
        header: 'Lat / lon',
        align: 'right',
        sortValue: (row) => row.lat,
        render: (row) => `${row.lat.toFixed(2)}, ${row.lon.toFixed(2)}`,
      },
      {
        key: 'currency',
        header: 'Currency',
        sortValue: (row) => row.currency,
        render: (row) => `${row.currency} · ${row.fxPerUsd.toFixed(3)} / USD`,
      },
      {
        key: 'labour',
        header: 'Labour cost',
        align: 'right',
        sortValue: (row) => row.labourCostPerHourLocal / row.fxPerUsd,
        render: (row) => (
          <span className={styles.twoLine}>
            <span>
              {row.labourCostPerHourLocal.toFixed(2)} {row.currency} / h
            </span>
            <span className={styles.sub}>
              {usd(row.labourCostPerHourLocal / row.fxPerUsd, { dp: 2 })} / h
            </span>
          </span>
        ),
      },
      {
        key: 'oee',
        header: 'Default OEE',
        align: 'right',
        sortValue: (row) => row.defaultOee,
        render: (row) => pct(row.defaultOee),
      },
      {
        key: 'grid',
        header: 'Grid intensity',
        align: 'right',
        sortValue: (row) => row.gridIntensity,
        render: (row) => `${row.gridIntensity.toFixed(3)} kg/kWh`,
      },
    ],
    [],
  )

  type WorkCenterRow = NonNullable<typeof catalog>['workCenters'][number]
  const workCenterColumns = useMemo<Array<DataTableColumn<WorkCenterRow>>>(
    () => [
      {
        key: 'code',
        header: 'Work center',
        sortValue: (row) => row.code,
        render: (row) => (
          <span className={styles.twoLine}>
            <span className={styles.code}>{row.code}</span>
            <span className={styles.sub}>{row.name}</span>
          </span>
        ),
      },
      {
        key: 'plant',
        header: 'Plant',
        sortValue: (row) => plantById.get(row.plantId)?.code ?? row.plantId,
        render: (row) => {
          const plant = plantById.get(row.plantId)
          return (
            <Chip slot={plant?.colorSlot ?? 1}>{plant?.code ?? row.plantId}</Chip>
          )
        },
      },
      {
        key: 'class',
        header: 'Machine class',
        sortValue: (row) => classById.get(row.classId)?.name ?? row.classId,
        render: (row) => (
          <span className={styles.twoLine}>
            <span>{classById.get(row.classId)?.name ?? row.classId}</span>
            <span className={styles.sub}>gen {classById.get(row.classId)?.generation ?? '—'}</span>
          </span>
        ),
      },
      {
        key: 'vintage',
        header: 'Vintage',
        align: 'right',
        sortValue: (row) => row.vintage,
        render: (row) => String(row.vintage),
      },
      {
        key: 'status',
        header: 'Status',
        sortValue: (row) => row.status,
        render: (row) =>
          row.status === 'proposed' ? (
            <Badge tone="warning" size="sm">
              Proposed
            </Badge>
          ) : (
            <Badge tone="good" size="sm">
              Active
            </Badge>
          ),
      },
      {
        key: 'machine',
        header: 'Machine pool',
        sortValue: (row) => {
          const pool = row.pools.find((entry) => entry.pool === 'machine')
          return pool === undefined
            ? 0
            : weeklyPoolHours(
                pool.count,
                pool.shiftsPerDay,
                pool.hoursPerShift,
                pool.daysPerWeek,
                pool.utilisationFactor,
              )
        },
        render: (row) => <PoolCell row={row} pool="machine" />,
      },
      {
        key: 'labour',
        header: 'Labour pool',
        sortValue: (row) => {
          const pool = row.pools.find((entry) => entry.pool === 'labour')
          return pool === undefined
            ? 0
            : weeklyPoolHours(
                pool.count,
                pool.shiftsPerDay,
                pool.hoursPerShift,
                pool.daysPerWeek,
                pool.utilisationFactor,
              )
        },
        render: (row) => <PoolCell row={row} pool="labour" />,
      },
      {
        key: 'oee',
        header: 'Base OEE',
        align: 'right',
        sortValue: (row) => row.baseOee,
        render: (row) => pct(row.baseOee),
      },
      {
        key: 'features',
        header: 'Features',
        align: 'right',
        sortValue: (row) => row.features.length,
        render: (row) => formatUnits(row.features.length),
      },
      {
        key: 'cost',
        header: 'Machine rate',
        align: 'right',
        sortValue: (row) => row.costRateUsdPerHour,
        render: (row) => `${usd(row.costRateUsdPerHour, { dp: 2 })} / h`,
      },
      {
        key: 'co2',
        header: 'kg CO₂e / h',
        align: 'right',
        sortValue: (row) => row.co2PerMachineHourKg,
        render: (row) => row.co2PerMachineHourKg.toFixed(2),
      },
      {
        key: 'from',
        header: 'Runs from',
        align: 'right',
        sortValue: (row) => row.availableFromWeek ?? 0,
        render: (row) =>
          row.availableFromWeek === undefined
            ? 'week 0'
            : (catalog?.time.weeks[row.availableFromWeek] ?? `W${row.availableFromWeek}`),
      },
    ],
    [plantById, classById, catalog],
  )

  type ClassRow = NonNullable<typeof catalog>['machineClasses'][number]
  const classColumns = useMemo<Array<DataTableColumn<ClassRow>>>(
    () => [
      {
        key: 'name',
        header: 'Machine class',
        sortValue: (row) => row.name,
        render: (row) => (
          <span className={styles.twoLine}>
            <span className={styles.code}>{row.name}</span>
            <span className={styles.sub}>{row.id}</span>
          </span>
        ),
      },
      {
        key: 'supplier',
        header: 'Supplier',
        sortValue: (row) => row.supplier,
        render: (row) => row.supplier,
      },
      {
        key: 'generation',
        header: 'Generation',
        align: 'right',
        sortValue: (row) => row.generation,
        render: (row) => String(row.generation),
      },
      {
        key: 'baseFeatures',
        header: 'Base features',
        sortValue: (row) => row.baseFeatures.length,
        render: (row) => (
          <span className={styles.chipRow}>
            {row.baseFeatures.slice(0, 4).map((featureId) => (
              <Chip key={featureId} slot="other" title={featureById.get(featureId)?.description}>
                {featureById.get(featureId)?.name ?? featureId}
              </Chip>
            ))}
            {row.baseFeatures.length > 4 ? (
              <span className={styles.sub}>+{row.baseFeatures.length - 4} more</span>
            ) : null}
            {row.baseFeatures.length === 0 ? <span className={styles.sub}>none</span> : null}
          </span>
        ),
      },
      {
        key: 'retrofits',
        header: 'Retrofits',
        align: 'right',
        sortValue: (row) => row.retrofits.length,
        render: (row) => formatUnits(row.retrofits.length),
      },
      {
        key: 'capex',
        header: 'Cheapest retrofit',
        align: 'right',
        sortValue: (row) =>
          row.retrofits.length === 0
            ? Number.POSITIVE_INFINITY
            : Math.min(...row.retrofits.map((option) => option.capexUsd)),
        render: (row) =>
          row.retrofits.length === 0
            ? '—'
            : usd(Math.min(...row.retrofits.map((option) => option.capexUsd)), { compact: true }),
      },
    ],
    [featureById],
  )

  const shape = catalog?.meta

  // --- states ---------------------------------------------------------------

  if (catalog === null) {
    return (
      <div className={styles.page}>
        <EmptyState
          title="No dataset is loaded"
          description="The engine builds or parses the dataset before anything can be inspected."
        />
      </div>
    )
  }

  const tabItems = [
    { id: 'plants', label: 'Plants', badge: formatUnits(catalog.plants.length) },
    { id: 'workCenters', label: 'Work centers', badge: formatUnits(catalog.workCenters.length) },
    { id: 'classes', label: 'Machine classes & features', badge: formatUnits(catalog.machineClasses.length) },
    {
      id: 'routings',
      label: 'Routings',
      badge: master.data === null ? '…' : formatUnits(master.data.routingTotal),
    },
    {
      id: 'downtime',
      label: 'Downtime',
      badge: master.data === null ? '…' : formatUnits(master.data.downtimeTotal),
    },
    { id: 'plans', label: 'Plans', badge: formatUnits(catalog.time.weeks.length) },
  ]

  return (
    <div className={styles.page}>
      <SectionHeading
        level={1}
        description="The master data every other screen is computed from, and the door it came in through."
      >
        Data
      </SectionHeading>

      {/* ------------------------------------------------------------------ */}
      {/* Dataset shape                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div className={styles.tiles}>
        <StatTile
          label="SKUs"
          value={formatUnits(shape?.skuCount ?? 0)}
          deltaContext={`${shape?.generatedBy === 'sap-extract' ? 'from an extract' : 'generated'} · profile ${shape?.profile ?? '—'}`}
        />
        <StatTile
          label="Work centers"
          value={formatUnits(catalog.workCenters.length)}
          deltaContext={`${formatUnits(catalog.plants.length)} plants · ${formatUnits(master.data?.capacityCount ?? 0)} capacity rows`}
        />
        <StatTile
          label="Routings"
          value={master.data === null ? '—' : formatUnits(master.data.routingTotal)}
          deltaContext={
            ops.data === null
              ? 'operations read when the Routings tab opens'
              : `${formatUnits(ops.data.operationTotal)} operations`
          }
        />
        <StatTile
          label="Features"
          value={formatUnits(catalog.features.length)}
          deltaContext={`${formatUnits(catalog.machineClasses.length)} machine classes`}
        />
        <StatTile
          label="Downtime events"
          value={master.data === null ? '—' : formatUnits(master.data.downtimeTotal)}
          hint="Planned loss only. Unplanned loss lives inside OEE and has no date."
        />
        <StatTile
          label="Weeks"
          value={formatUnits(catalog.time.weeks.length)}
          deltaContext={`${catalog.time.weeks[0] ?? '—'} → ${catalog.time.weeks[catalog.time.weeks.length - 1] ?? '—'}`}
        />
        <StatTile
          label="Model runtime"
          value={runtimeMs > 0 ? `${Math.round(runtimeMs)} ms` : '—'}
          status={
            runtimeMs === 0
              ? undefined
              : runtimeMs < 400
                ? { level: 'good', label: 'Inside the budget' }
                : { level: 'warning', label: 'Over the 400 ms budget' }
          }
          deltaContext={usingFallback ? 'running on the main thread' : 'running in a worker'}
          hint="The last full run. Surfaced here so a regression is seen rather than felt."
        />
        <StatTile
          label="Dataset built in"
          value={
            timings === null
              ? '—'
              : `${Math.round(Object.values(timings).reduce((total, value) => total + value, 0))} ms`
          }
          deltaContext={
            timings === null
              ? 'no timings reported'
              : Object.entries(timings)
                  .map(([phase, value]) => `${phase} ${Math.round(value)}ms`)
                  .join(' · ')
          }
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Tabs                                                                */}
      {/* ------------------------------------------------------------------ */}
      <Card flush>
        <div className={styles.tabHead}>
          <Tabs
            label="Master data"
            items={tabItems}
            value={tab}
            onChange={(id) => setTab(id as TabId)}
          />
          <TextField
            label="Search this table"
            hideLabel
            size="sm"
            value={search}
            onChange={setSearch}
            placeholder="Search"
            className={styles.tabSearch}
          />
        </div>

        {tab === 'plants' ? (
          <TabPanel id="plants">
            <DataTable<PlantRow>
              caption="Every plant, with its currency, labour cost, default OEE and grid intensity."
              columns={plantColumns}
              rows={plantRows}
              rowKey={(row) => row.id}
              initialSort={{ key: 'code', dir: 'asc' }}
              maxHeight={520}
              empty={<EmptyState title={`No plant matches “${search}”`} />}
            />
          </TabPanel>
        ) : null}

        {tab === 'workCenters' ? (
          <TabPanel id="workCenters">
            <DataTable<WorkCenterRow>
              caption="Every work center, with both capacity pools written out in full."
              columns={workCenterColumns}
              rows={workCenterRows}
              rowKey={(row) => row.id}
              rowHeight={44}
              initialSort={{ key: 'code', dir: 'asc' }}
              maxHeight={560}
              empty={<EmptyState title={`No work center matches “${search}”`} />}
            />
          </TabPanel>
        ) : null}

        {tab === 'classes' ? (
          <TabPanel id="classes">
            <div className={styles.stack}>
              <div className={styles.subCard}>
                <h3 className={styles.subHeading}>Machine classes</h3>
                <DataTable<ClassRow>
                  caption="Machine classes with their base feature grant and retrofit options."
                  columns={classColumns}
                  rows={classRows}
                  rowKey={(row) => row.id}
                  rowHeight={52}
                  initialSort={{ key: 'name', dir: 'asc' }}
                  maxHeight={340}
                  empty={<EmptyState title={`No machine class matches “${search}”`} />}
                />
              </div>

              <div className={styles.subCard}>
                <h3 className={styles.subHeading}>
                  Retrofit options
                  <InfoTip label="What a retrofit is">
                    A retrofit turns a machine into a more capable one for money and time. It is
                    what makes “which machine could we repurpose?” answerable for machines nobody
                    ever told the allow-list about.
                  </InfoTip>
                </h3>
                <DataTable<(typeof retrofitRows)[number]>
                  caption="Every retrofit option offered by a machine class, with its capex, lead time and OEE effect."
                  columns={[
                    {
                      key: 'class',
                      header: 'Machine class',
                      sortValue: (row) => row.className,
                      render: (row) => row.className,
                    },
                    {
                      key: 'name',
                      header: 'Retrofit',
                      sortValue: (row) => row.name,
                      render: (row) => (
                        <span className={styles.twoLine}>
                          <span className={styles.code}>{row.name}</span>
                          <span className={styles.sub}>{row.description}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'adds',
                      header: 'Adds features',
                      sortValue: (row) => row.addsFeatures.length,
                      render: (row) => (
                        <span className={styles.chipRow}>
                          {row.addsFeatures.map((featureId) => (
                            <Chip key={featureId} slot="other">
                              {featureById.get(featureId)?.name ?? featureId}
                            </Chip>
                          ))}
                        </span>
                      ),
                    },
                    {
                      key: 'capex',
                      header: 'Capex',
                      align: 'right',
                      sortValue: (row) => row.capexUsd,
                      render: (row) => usd(row.capexUsd),
                    },
                    {
                      key: 'lead',
                      header: 'Lead time',
                      align: 'right',
                      sortValue: (row) => row.leadTimeWeeks,
                      render: (row) => `${row.leadTimeWeeks} weeks`,
                    },
                    {
                      key: 'oee',
                      header: 'OEE effect',
                      align: 'right',
                      sortValue: (row) => row.oeeDelta,
                      render: (row) =>
                        row.oeeDelta === 0
                          ? '—'
                          : `${row.oeeDelta > 0 ? '+' : ''}${(row.oeeDelta * 100).toFixed(1)} pp`,
                    },
                  ]}
                  rows={retrofitRows}
                  rowKey={(row) => row.id}
                  rowHeight={44}
                  initialSort={{ key: 'capex', dir: 'asc' }}
                  maxHeight={340}
                  empty={<EmptyState title={`No retrofit matches “${search}”`} />}
                />
              </div>

              <div className={styles.subCard}>
                <h3 className={styles.subHeading}>Features</h3>
                <DataTable<(typeof featureRows)[number]>
                  caption="Every capability feature a machine can hold, and what it means."
                  columns={[
                    {
                      key: 'name',
                      header: 'Feature',
                      sortValue: (row) => row.name,
                      render: (row) => (
                        <span className={styles.chipRow}>
                          <Chip slot="other">{row.name}</Chip>
                        </span>
                      ),
                    },
                    { key: 'id', header: 'Id', sortValue: (row) => row.id, render: (row) => row.id },
                    {
                      key: 'group',
                      header: 'Group',
                      sortValue: (row) => row.group,
                      render: (row) => <Pill>{row.group}</Pill>,
                    },
                    {
                      key: 'description',
                      header: 'What it means',
                      sortValue: (row) => row.description,
                      render: (row) => row.description,
                    },
                  ]}
                  rows={featureRows}
                  rowKey={(row) => row.id}
                  initialSort={{ key: 'group', dir: 'asc' }}
                  maxHeight={340}
                  empty={<EmptyState title={`No feature matches “${search}”`} />}
                />
              </div>
            </div>
          </TabPanel>
        ) : null}

        {tab === 'routings' ? (
          <TabPanel id="routings">
            {master.error !== null ? (
              <ErrorState title="The routing headers could not be read" message={master.error} />
            ) : master.data === null ? (
              <EmptyState icon="clock" title="Reading PLKO" description="Routing headers, once per session." />
            ) : (
              <div className={styles.stack}>
                <p className={styles.tabNote}>
                  {formatUnits(master.data.routingTotal)} routing headers in the extract
                  {master.data.routingTotal > master.data.routings.length
                    ? `; the ${formatUnits(master.data.routings.length)} first are shown. Export PLKO for all of them.`
                    : '.'}{' '}
                  Select a routing to see its operations.
                </p>
                <DataTable<RoutingHeaderRow>
                  caption="Routing headers — one per production version of a material at a plant."
                  columns={[
                    {
                      key: 'routing',
                      header: 'Routing',
                      sortValue: (row) => row.routingId,
                      render: (row) => <span className={styles.code}>{row.routingId}</span>,
                    },
                    {
                      key: 'version',
                      header: 'Version',
                      sortValue: (row) => row.version,
                      render: (row) => row.version,
                    },
                    {
                      key: 'plant',
                      header: 'Plant',
                      sortValue: (row) => row.plantCode,
                      render: (row) => row.plantCode,
                    },
                    {
                      key: 'primary',
                      header: 'Planning default',
                      sortValue: (row) => (row.primary ? 1 : 0),
                      render: (row) =>
                        row.primary ? (
                          <Badge tone="good" size="sm">
                            Primary
                          </Badge>
                        ) : (
                          <Badge tone="neutral" size="sm">
                            Alternate
                          </Badge>
                        ),
                    },
                    {
                      key: 'valid',
                      header: 'Valid',
                      sortValue: (row) => row.validFrom,
                      render: (row) =>
                        row.validFrom === '' && row.validTo === ''
                          ? 'whole horizon'
                          : `${row.validFrom === '' ? 'start' : row.validFrom} → ${row.validTo === '' ? 'end' : row.validTo}`,
                    },
                    {
                      key: 'ops',
                      header: 'Operations',
                      align: 'right',
                      sortValue: (row) => ops.data?.opsByKey.get(row.key)?.length ?? 0,
                      render: (row) => {
                        const count = ops.data?.opsByKey.get(row.key)?.length
                        return count === undefined ? (ops.loading ? '…' : '—') : formatUnits(count)
                      },
                    },
                    {
                      key: 'materials',
                      header: 'Materials assigned',
                      align: 'right',
                      sortValue: (row) => ops.data?.materialsByKey.get(row.key)?.length ?? 0,
                      render: (row) => {
                        const count = ops.data?.materialsByKey.get(row.key)?.length
                        return count === undefined ? (ops.loading ? '…' : '—') : formatUnits(count)
                      },
                    },
                  ]}
                  rows={routingRows}
                  rowKey={(row) => row.key}
                  onRowClick={(row) => setSelectedRouting(selectedRouting === row.key ? null : row.key)}
                  selectedKey={selectedRouting ?? undefined}
                  initialSort={{ key: 'routing', dir: 'asc' }}
                  maxHeight={380}
                  empty={<EmptyState title={`No routing matches “${search}”`} />}
                />

                <div className={styles.subCard}>
                  <h3 className={styles.subHeading}>
                    {selectedRouting === null
                      ? 'Operations'
                      : `Operations of ${selectedRouting.replace('|', ' version ')}`}
                  </h3>
                  {selectedRouting === null ? (
                    <EmptyState
                      title="Select a routing above"
                      description="Its operations, with base quantity, setup, machine and labour times and scrap, appear here."
                    />
                  ) : ops.loading && ops.data === null ? (
                    <EmptyState icon="clock" title="Reading PLPO and MAPL" />
                  ) : ops.error !== null ? (
                    <ErrorState title="The routing operations could not be read" message={ops.error} />
                  ) : (
                    <DataTable<RoutingOperationRow>
                      caption="The ordered operations of the selected routing."
                      columns={[
                        {
                          key: 'seq',
                          header: 'Seq',
                          align: 'right',
                          sortValue: (row) => row.seq,
                          render: (row) => String(row.seq).padStart(4, '0'),
                        },
                        {
                          key: 'op',
                          header: 'Operation',
                          sortValue: (row) => row.opId,
                          render: (row) => row.opId,
                        },
                        {
                          key: 'wc',
                          header: 'Work center',
                          sortValue: (row) => row.workCenterCode,
                          render: (row) => (
                            <span className={styles.chipRow}>
                              <span className={styles.code}>{row.workCenterCode}</span>
                              <span className={styles.sub}>{row.plantCode}</span>
                            </span>
                          ),
                        },
                        {
                          key: 'base',
                          header: 'Base qty',
                          align: 'right',
                          sortValue: (row) => row.baseQty,
                          render: (row) => formatUnits(row.baseQty),
                        },
                        {
                          key: 'setup',
                          header: 'Setup h / lot',
                          align: 'right',
                          sortValue: (row) => row.setupHours,
                          render: (row) => row.setupHours.toFixed(3),
                        },
                        {
                          key: 'machine',
                          header: 'Machine h / base',
                          align: 'right',
                          sortValue: (row) => row.machineHoursPerBase,
                          render: (row) => row.machineHoursPerBase.toFixed(4),
                        },
                        {
                          key: 'labour',
                          header: 'Labour h / base',
                          align: 'right',
                          sortValue: (row) => row.labourHoursPerBase,
                          render: (row) => row.labourHoursPerBase.toFixed(4),
                        },
                        {
                          key: 'rate',
                          header: 'Units / machine h',
                          align: 'right',
                          sortValue: (row) => safeDiv(row.baseQty, row.machineHoursPerBase),
                          render: (row) =>
                            formatUnits(safeDiv(row.baseQty, row.machineHoursPerBase)),
                        },
                        {
                          key: 'yield',
                          header: 'Yield',
                          align: 'right',
                          sortValue: (row) => 1 - row.scrapPct / 100,
                          render: (row) => pct(1 - row.scrapPct / 100),
                        },
                      ]}
                      rows={selectedOps}
                      rowKey={(row) => `${row.routingKey}-${row.seq}`}
                      initialSort={{ key: 'seq', dir: 'asc' }}
                      maxHeight={300}
                      empty={<EmptyState title="This routing has no operations" />}
                    />
                  )}
                </div>
              </div>
            )}
          </TabPanel>
        ) : null}

        {tab === 'downtime' ? (
          <TabPanel id="downtime">
            {master.error !== null ? (
              <ErrorState title="The downtime plan could not be read" message={master.error} />
            ) : master.data === null ? (
              <EmptyState icon="clock" title="Reading KAPA" description="Capacity intervals and planned downtime." />
            ) : (
              <div className={styles.stack}>
                <p className={styles.tabNote}>
                  Planned loss only, one row per pool the event blocks. Unplanned loss lives inside
                  OEE and has no date — giving it one would be a precise-looking lie. Event ids can
                  be copied into a “Downtime event → remove” move on the Scenarios screen.
                </p>
                <DataTable<DowntimeRow>
                  caption="Every dated, planned capacity loss, with the pool it blocks and the hours it removes."
                  columns={[
                    {
                      key: 'event',
                      header: 'Event id',
                      sortValue: (row) => row.eventId,
                      render: (row) => <span className={styles.code}>{row.eventId}</span>,
                    },
                    {
                      key: 'wc',
                      header: 'Work center',
                      sortValue: (row) => row.workCenterCode,
                      render: (row) => (
                        <span className={styles.chipRow}>
                          <span className={styles.code}>{row.workCenterCode}</span>
                          <span className={styles.sub}>{row.plantCode}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'kind',
                      header: 'Kind',
                      sortValue: (row) => row.kind,
                      render: (row) => <Pill>{row.kind.toLowerCase()}</Pill>,
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      sortValue: (row) => row.status,
                      render: (row) => (
                        <Badge
                          tone={
                            row.status === 'CONFIRMED'
                              ? 'good'
                              : row.status === 'ATRISK'
                                ? 'warning'
                                : 'neutral'
                          }
                          size="sm"
                        >
                          {row.status.toLowerCase()}
                        </Badge>
                      ),
                    },
                    {
                      key: 'from',
                      header: 'From',
                      sortValue: (row) => row.fromWeek,
                      render: (row) => row.fromWeek,
                    },
                    {
                      key: 'to',
                      header: 'To',
                      sortValue: (row) => row.toWeek,
                      render: (row) => (row.toWeek === '' ? row.fromWeek : row.toWeek),
                    },
                    {
                      key: 'pool',
                      header: 'Pool blocked',
                      sortValue: (row) => row.pool,
                      render: (row) => (row.pool === '' ? '—' : row.pool),
                    },
                    {
                      key: 'hours',
                      header: 'Hours / week',
                      align: 'right',
                      sortValue: (row) => toNumber(row.hoursPerWeek),
                      render: (row) =>
                        row.hoursPerWeek === '' ? 'blocked entirely' : formatHours(toNumber(row.hoursPerWeek)),
                    },
                    {
                      key: 'slip',
                      header: 'Slip',
                      align: 'right',
                      sortValue: (row) => toNumber(row.slipWeeks),
                      render: (row) => (row.slipWeeks === '' ? '—' : `${row.slipWeeks} weeks`),
                    },
                    {
                      key: 'label',
                      header: 'Label',
                      sortValue: (row) => row.label,
                      render: (row) => row.label,
                    },
                  ]}
                  rows={downtimeRows}
                  rowKey={(row) => `${row.eventId}-${row.capacityId}`}
                  rowHeight={40}
                  initialSort={{ key: 'from', dir: 'asc' }}
                  maxHeight={520}
                  empty={<EmptyState title={`No downtime event matches “${search}”`} />}
                />
              </div>
            )}
          </TabPanel>
        ) : null}

        {tab === 'plans' ? (
          <TabPanel id="plans">
            <div className={styles.stack}>
              <p className={styles.tabNote}>
                SUPPLY is {formatUnits(catalog.meta.skuCount)} materials ×{' '}
                {formatUnits(catalog.time.weeks.length)} weeks — roughly{' '}
                {compact(catalog.meta.skuCount * catalog.time.weeks.length)} rows — and DEMAND is
                larger again. Neither is browsed here: they are exported. What is shown instead is
                the same plan rolled up to the network, which is the readable size of the same
                truth.
              </p>

              {/* Keyed on the dataset generation: replacing the dataset resets the
                  engine client, and a query whose request that reset rejected has
                  to be re-mounted before it will ask again. */}
              <PlanRollupTable
                key={generation}
                search={search}
                weekLabels={catalog.time.weeks}
              />

              <div className={styles.subCard}>
                <h3 className={styles.subHeading}>Inventory</h3>
                {inventory.error !== null ? (
                  <ErrorState title="The inventory extract could not be read" message={inventory.error} />
                ) : inventory.data === null ? (
                  <EmptyState icon="clock" title="Reading INVENTORY" />
                ) : (
                  <>
                    <p className={styles.tabNote}>
                      {formatUnits(inventory.data.total)} stock positions
                      {inventory.data.total > inventory.data.rows.length
                        ? `; the ${formatUnits(inventory.data.rows.length)} first are shown. Export INVENTORY for all of them.`
                        : '.'}
                    </p>
                    <DataTable<InventoryRow>
                      caption="On hand, in transit and safety stock per material and plant."
                      columns={[
                        {
                          key: 'code',
                          header: 'Material',
                          sortValue: (row) => row.code,
                          render: (row) => <span className={styles.code}>{row.code}</span>,
                        },
                        {
                          key: 'plant',
                          header: 'Plant',
                          sortValue: (row) => row.plantCode,
                          render: (row) => row.plantCode,
                        },
                        {
                          key: 'onHand',
                          header: 'On hand',
                          align: 'right',
                          sortValue: (row) => row.onHand,
                          render: (row) => formatUnits(row.onHand),
                        },
                        {
                          key: 'transit',
                          header: 'In transit',
                          align: 'right',
                          sortValue: (row) => row.inTransit,
                          render: (row) => formatUnits(row.inTransit),
                        },
                        {
                          key: 'safety',
                          header: 'Safety stock',
                          align: 'right',
                          sortValue: (row) => row.safetyStock,
                          render: (row) => formatUnits(row.safetyStock),
                        },
                        {
                          key: 'cover',
                          header: 'Cover vs safety',
                          align: 'right',
                          sortValue: (row) => safeDiv(row.onHand + row.inTransit, row.safetyStock),
                          render: (row) =>
                            row.safetyStock <= 0
                              ? '—'
                              : pct(safeDiv(row.onHand + row.inTransit, row.safetyStock)),
                        },
                      ]}
                      rows={inventoryRows}
                      rowKey={(row) => `${row.code}|${row.plantCode}`}
                      initialSort={{ key: 'code', dir: 'asc' }}
                      maxHeight={340}
                      empty={<EmptyState title={`No stock position matches “${search}”`} />}
                    />
                  </>
                )}
              </div>
            </div>
          </TabPanel>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Export                                                              */}
      {/* ------------------------------------------------------------------ */}
      <Card
        title="Export"
        subtitle={`Written from “${activeScenario?.name ?? 'the baseline'}” — the tables reflect the moves in force, so an exported extract round-trips back into the same model.`}
      >
        <div className={styles.exportStrip}>
          {SAP_TABLES.map((table) => (
            <button
              key={table}
              type="button"
              className={styles.exportChip}
              disabled={exporting !== null}
              onClick={() => {
                void exportTable(table)
              }}
            >
              <span className={styles.exportName}>
                <Icon name="download" size={12} />
                {table}
              </span>
              <span className={styles.exportDescription}>{TABLE_DESCRIPTIONS[table]}</span>
              {exporting === table ? <span className={styles.exportBusy}>writing…</span> : null}
            </button>
          ))}
          <button
            type="button"
            className={styles.exportChip}
            onClick={() => {
              if (activeScenario !== undefined) exportScenarioJson(activeScenario)
            }}
          >
            <span className={styles.exportName}>
              <Icon name="download" size={12} />
              Scenario JSON
            </span>
            <span className={styles.exportDescription}>
              the decision log of “{activeScenario?.name ?? 'the baseline'}”, as moves
            </span>
          </button>
        </div>
        {exportError === null ? null : (
          <p className={styles.errorLine}>
            <Icon name="critical" size={12} /> {exportError}
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Import                                                              */}
      {/* ------------------------------------------------------------------ */}
      <Card
        title="Import"
        subtitle="Choose a set of SAP-shaped CSVs. Nothing is committed until the validation below has been read."
      >
        <label className={styles.fileField}>
          <span className={styles.fileLabel}>Choose CSV files</span>
          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            className={styles.fileInput}
            onChange={(event) => {
              void onFilesChosen(event.target.files)
            }}
          />
        </label>

        {importState.detected.length === 0 ? (
          <EmptyState
            icon="upload"
            title="No files chosen yet"
            description={`Recognised table names are ${EXTRACT_TABLES.join(', ')}. The file name, minus its .csv, is the table name.`}
          />
        ) : (
          <div className={styles.importBody}>
            <table className={styles.detectTable}>
              <caption className={styles.detectCaption}>
                Files detected, the table each was read as, and how many data rows it holds.
              </caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Read as</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Recognised</th>
                </tr>
              </thead>
              <tbody>
                {importState.detected.map((file) => (
                  <tr key={file.fileName}>
                    <th scope="row">{file.fileName}</th>
                    <td>{file.table}</td>
                    <td className={styles.numeric}>{formatUnits(file.rows)}</td>
                    <td>
                      {file.known ? (
                        <Badge tone="good" size="sm">
                          Known table
                        </Badge>
                      ) : (
                        <Badge tone="warning" size="sm">
                          Ignored — no such table
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {importState.strippedRows > 0 ? (
              <p className={styles.strippedNote}>
                <Icon name="warning" size={12} /> {formatUnits(importState.strippedRows)} row
                {importState.strippedRows === 1 ? '' : 's'} removed from{' '}
                {importState.strippedTables.join(', ')} before this check.
                {importState.unsalvageable.length > 0
                  ? ` ${importState.unsalvageable.join(', ')} could not be salvaged row by row — the problem is with the table or its header, not with one line.`
                  : ''}
              </p>
            ) : null}

            {importState.checking ? (
              <EmptyState
                icon="clock"
                title="Checking the extract"
                description="Every row is parsed and every reference resolved before anything is committed."
              />
            ) : (
              <>
                <p className={styles.importSummary}>
                  {importState.errors.length === 0 ? (
                    <>
                      <Icon name="good" size={13} /> Nothing was rejected.
                      {importState.warnings.length > 0
                        ? ` ${formatUnits(importState.warnings.length)} warning${importState.warnings.length === 1 ? '' : 's'} below.`
                        : ''}
                    </>
                  ) : (
                    <>
                      <Icon name="critical" size={13} />{' '}
                      {formatUnits(importState.errors.length)} row
                      {importState.errors.length === 1 ? '' : 's'} would be rejected. Every one is
                      listed below with its table and its 1-based row number in the file.
                    </>
                  )}
                </p>

                {importState.errors.length > 0 ? (
                  <ol className={styles.diagnostics} aria-label="Validation errors">
                    {importState.errors.map((error, index) => (
                      <li key={`${error.raw}-${index}`}>
                        <span className={styles.diagTable}>{error.table}</span>
                        <span className={styles.diagRow}>
                          {error.line === undefined ? 'whole table' : `row ${error.line}`}
                        </span>
                        <span className={styles.diagMessage}>{error.message}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}

                {importState.warnings.length > 0 ? (
                  <ol className={styles.diagnosticsWarn} aria-label="Validation warnings">
                    {importState.warnings.map((warning, index) => (
                      <li key={`${warning.raw}-${index}`}>
                        <span className={styles.diagTable}>{warning.table}</span>
                        <span className={styles.diagRow}>
                          {warning.line === undefined ? 'whole table' : `row ${warning.line}`}
                        </span>
                        <span className={styles.diagMessage}>{warning.message}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}

                <div className={styles.importActions}>
                  <Button
                    variant="primary"
                    icon="upload"
                    disabled={importState.errors.length > 0 || switching !== null}
                    onClick={() => {
                      void commitImport(importState.files)
                    }}
                  >
                    Import this extract
                  </Button>
                  <Button
                    icon="warning"
                    disabled={
                      importState.errors.length === 0 ||
                      switching !== null ||
                      importState.errors.every((error) => error.line === undefined || error.line <= 1)
                    }
                    onClick={importAnyway}
                  >
                    Import anyway, valid rows only
                  </Button>
                  <Button
                    icon="close"
                    onClick={() => setImportState(EMPTY_IMPORT)}
                    disabled={switching !== null}
                  >
                    Discard these files
                  </Button>
                </div>
                <p className={styles.importFoot}>
                  “Import anyway” removes exactly the rows listed above and checks the result again,
                  so you see what removing them cost before anything is committed. It never commits
                  in one step.
                </p>
              </>
            )}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Profile                                                             */}
      {/* ------------------------------------------------------------------ */}
      <Card
        title="Dataset profile"
        subtitle="Three sizes of the same world — the same five plants, the same machine classes, the same operations, with more of everything."
      >
        <div className={styles.profileRow}>
          <Select
            label="Profile"
            value={shape?.profile ?? ''}
            options={PROFILES.map((profile) => ({ value: profile.id, label: profile.label }))}
            onChange={(value) => {
              if (value !== shape?.profile) setProfileTarget(value)
            }}
            disabled={switching !== null}
            hint="Switching rebuilds the dataset from scratch in the worker."
          />
          <p className={styles.profileWarning}>
            <Icon name="warning" size={13} /> Changing the profile discards every scenario that is
            not the baseline. Work-center and material ids differ between profiles, so a move
            authored against one dataset has no meaning in another. Export anything worth keeping
            first.
          </p>
        </div>
        <p className={styles.tabNote}>
          Currently {shape?.profile ?? '—'} · seed {shape?.seed ?? '—'} ·{' '}
          {shape?.generatedBy === 'sap-extract'
            ? `loaded from ${shape.sourceLabel ?? 'an extract'}`
            : 'generated by the data factory'}
        </p>
      </Card>

      <Modal
        open={profileTarget !== null}
        onClose={() => setProfileTarget(null)}
        title="Rebuild the dataset?"
        description="This discards every scenario except the baseline and re-runs the model from scratch."
        footer={
          <>
            <Button onClick={() => setProfileTarget(null)}>Keep the current dataset</Button>
            <Button
              variant="danger"
              icon="reset"
              onClick={() => {
                if (profileTarget !== null) void switchProfile(profileTarget)
              }}
            >
              Rebuild
            </Button>
          </>
        }
      >
        <p className={styles.modalNote}>
          {scenarios.filter((s) => s.readonly !== true).length === 0
            ? 'There are no user scenarios to lose.'
            : `${scenarios.filter((s) => s.readonly !== true).length} scenario(s) will be discarded. Export them first if they matter.`}
        </p>
        <div className={styles.modalActions}>
          {scenarios
            .filter((s) => s.readonly !== true)
            .map((scenario) => (
              <Button
                key={scenario.id}
                size="sm"
                icon="download"
                onClick={() => exportScenarioJson(scenario)}
              >
                Export “{scenario.name}”
              </Button>
            ))}
        </div>
      </Modal>

      <Modal
        open={switching !== null}
        onClose={() => undefined}
        title="Rebuilding the dataset"
        description="The worker is generating or parsing the whole network. This takes a moment."
      >
        <p className={styles.modalNote}>{switching?.phase ?? ''}</p>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((switching?.pct ?? 0) * 100)}
        >
          <div
            className={styles.progressFill}
            style={{ width: `${Math.round((switching?.pct ?? 0) * 100)}%` }}
          />
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The plan, rolled up to the network
// ---------------------------------------------------------------------------

interface PlanRollupRow {
  id: string
  label: string
  supplyUnits: number
  demandUnits: number
  requiredHours: number
  availableHours: number
}

/**
 * The supply plan at a readable size.
 *
 * Split into its own component so the Data screen can remount it — and with it
 * the worker query behind it — when the dataset underneath is replaced. A hook
 * whose request was rejected by an engine reset has no reason to fire again on
 * its own, because nothing it keys on has changed.
 */
function PlanRollupTable({ search, weekLabels }: { search: string; weekLabels: string[] }) {
  const rollup = useRollup('global')
  const needle = search.trim().toLowerCase()

  const rows = useMemo<PlanRollupRow[]>(() => {
    const byWeek = new Map<string, PlanRollupRow>()
    for (const cell of rollup.data?.cells ?? []) {
      const bucketKey = String(cell.week)
      const prior = byWeek.get(bucketKey) ?? {
        id: bucketKey,
        label: weekLabels[cell.week] ?? `W${cell.week}`,
        supplyUnits: 0,
        demandUnits: 0,
        requiredHours: 0,
        availableHours: 0,
      }
      prior.supplyUnits += cell.supplyUnits
      prior.demandUnits += cell.demandUnits
      prior.requiredHours += cell.requiredHours
      prior.availableHours += cell.availableHours
      byWeek.set(bucketKey, prior)
    }
    const all = [...byWeek.values()]
    if (needle === '') return all
    return all.filter((row) => row.label.toLowerCase().includes(needle))
  }, [rollup.data, weekLabels, needle])

  return (
    <div className={styles.subCard}>
      <h3 className={styles.subHeading}>The plan, rolled up to the network</h3>
      {rollup.error !== null && rollup.data === null ? (
        <ErrorState title="The plan roll-up could not be fetched" message={rollup.error} />
      ) : (
        <DataTable<PlanRollupRow>
          caption="Supply plan, demand and hours for the whole network, by week."
          columns={[
            { key: 'week', header: 'Week', sortValue: (row) => row.label, render: (row) => row.label },
            {
              key: 'supply',
              header: 'Supply units',
              align: 'right',
              sortValue: (row) => row.supplyUnits,
              render: (row) => formatUnits(row.supplyUnits),
            },
            {
              key: 'demand',
              header: 'Demand units',
              align: 'right',
              sortValue: (row) => row.demandUnits,
              render: (row) => formatUnits(row.demandUnits),
            },
            {
              key: 'gap',
              header: 'Plan gap',
              align: 'right',
              sortValue: (row) => row.demandUnits - row.supplyUnits,
              render: (row) => formatUnits(row.demandUnits - row.supplyUnits),
            },
            {
              key: 'required',
              header: 'Required hours',
              align: 'right',
              sortValue: (row) => row.requiredHours,
              render: (row) => formatHours(row.requiredHours, { compact: true }),
            },
            {
              key: 'available',
              header: 'Available hours',
              align: 'right',
              sortValue: (row) => row.availableHours,
              render: (row) => formatHours(row.availableHours, { compact: true }),
            },
            {
              key: 'util',
              header: 'Utilisation',
              align: 'right',
              sortValue: (row) => safeDiv(row.requiredHours, row.availableHours),
              render: (row) => pct(safeDiv(row.requiredHours, row.availableHours)),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.id}
          maxHeight={340}
          stale={rollup.loading && rollup.data !== null}
          empty={<EmptyState title="No plan rows in this window" />}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One capacity pool, written out the way the extract states it
// ---------------------------------------------------------------------------

function PoolCell({
  row,
  pool,
}: {
  row: NonNullable<ReturnType<typeof useUiStore.getState>['catalog']>['workCenters'][number]
  pool: CapacityPool
}) {
  const entry = row.pools.find((candidate) => candidate.pool === pool)
  if (entry === undefined) return <span className={styles.sub}>none</span>
  const weekly = weeklyPoolHours(
    entry.count,
    entry.shiftsPerDay,
    entry.hoursPerShift,
    entry.daysPerWeek,
    entry.utilisationFactor,
  )
  return (
    <span className={styles.twoLine}>
      <span>{formatHours(weekly)} / week</span>
      <span className={styles.sub}>
        {entry.count} × {entry.shiftsPerDay} shifts × {entry.hoursPerShift} h ×{' '}
        {entry.daysPerWeek} d @ {pct(entry.utilisationFactor, 0)}
      </span>
    </span>
  )
}

export default DataAdmin
