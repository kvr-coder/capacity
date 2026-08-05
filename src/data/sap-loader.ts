/**
 * SAP-shaped CSV extracts -> Snapshot.
 *
 * Three properties this loader is built around, because they are what makes
 * the difference between a demo and an integration path:
 *
 * 1. **Header-driven, order-independent.** Columns are located by name, once
 *    per table. A real extract arrives with columns in a different order, with
 *    thirty fields nobody asked for, and with a BOM on the front. All three
 *    load.
 * 2. **Every problem is collected, never thrown.** A bad extract surfaces all
 *    of its errors at once, each naming its table and its 1-based row number
 *    (the header is row 1, so the number matches what an editor shows). One
 *    bad row does not cost you the other 999,999 — the good rows still load.
 * 3. **No object-per-cell.** The plan tables are read in two passes: one to
 *    discover row keys in order, one to fill the `Float64Array` directly. At a
 *    million rows the intermediate array of objects is the whole cost.
 *
 * What is validated, per the contract: referenced work centers, materials and
 * routings exist; week labels resolve to real indexes inside the horizon;
 * quantities are finite and non-negative; and every producible material has at
 * least one routing.
 *
 * The horizon itself is rebuilt from the `KIND=AVAIL` rows of KAPA — the only
 * place the week grid is written down — and then every other week label in the
 * extract is resolved against it.
 */

import type {
  CapacityPool,
  Currency,
  DowntimeEvent,
  DowntimeKind,
  DowntimeStatus,
  Feature,
  FeatureGroup,
  InventoryRow,
  MachineClass,
  Material,
  MaterialType,
  OeeGlidePath,
  OeeOverride,
  PlanMatrix,
  Plant,
  PoolCapacity,
  ProductFamily,
  ProductGroup,
  RateOverride,
  Region,
  RetrofitOption,
  Routing,
  RoutingOperation,
  Snapshot,
  SnapshotMeta,
  StandardOperation,
  TimeGrid,
  WorkCenter,
} from '@/domain/types'
import { CAPACITY_POOLS, REGIONS } from '@/domain/types'
import { buildTimeGrid } from '@/domain/time'
import { parseCsvRows } from '@/lib/csv'
import { KAPA_AVAILABLE, POOL_BY_KAPART } from '@/data/sap-writer'
import type { ExtractTable } from '@/data/sap-writer'

export interface LoadResult {
  snapshot: Snapshot
  errors: string[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

class Ctx {
  readonly errors: string[] = []
  readonly warnings: string[] = []

  error(table: string, line: number, message: string): void {
    this.errors.push(`${table} row ${line}: ${message}`)
  }

  warn(table: string, line: number, message: string): void {
    this.warnings.push(`${table} row ${line}: ${message}`)
  }

  tableError(table: string, message: string): void {
    this.errors.push(`${table}: ${message}`)
  }

  tableWarn(table: string, message: string): void {
    this.warnings.push(`${table}: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------

class Row {
  /** Cleared by any failed accessor, so a caller can skip a bad row wholesale. */
  ok = true

  constructor(
    private readonly ctx: Ctx,
    readonly table: string,
    readonly line: number,
    private readonly cells: readonly string[],
    private readonly cols: ReadonlyMap<string, number>,
  ) {}

  fail(message: string): void {
    this.ok = false
    this.ctx.error(this.table, this.line, message)
  }

  note(message: string): void {
    this.ctx.warn(this.table, this.line, message)
  }

  /** Free text, exactly as extracted — descriptions and labels keep their padding. */
  text(col: string): string {
    const index = this.cols.get(col)
    if (index === undefined) return ''
    return this.cells[index] ?? ''
  }

  /** Keys, codes and numbers: trimmed, because SAP pads its character fields. */
  str(col: string): string {
    return this.text(col).trim()
  }

  req(col: string): string {
    const value = this.str(col)
    if (value === '') this.fail(`${col} is required but empty`)
    return value
  }

  num(col: string, opts: { required?: boolean; min?: number; fallback?: number } = {}): number {
    const raw = this.str(col)
    const fallback = opts.fallback ?? 0
    if (raw === '') {
      if (opts.required === true) this.fail(`${col} is required but empty`)
      return fallback
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      this.fail(`${col} is not a finite number: "${raw}"`)
      return fallback
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(`${col} must be >= ${opts.min}, got ${raw}`)
      return fallback
    }
    return value
  }

  optNum(col: string, opts: { min?: number } = {}): number | undefined {
    if (this.str(col) === '') return undefined
    return this.num(col, opts)
  }

  flag(col: string): boolean {
    const raw = this.str(col).toUpperCase()
    return raw === 'X' || raw === 'TRUE' || raw === '1' || raw === 'Y'
  }

  /**
   * Case-insensitive membership test against a closed union. An empty cell
   * takes the fallback silently unless the column is required; anything else
   * that is not in the union is an error.
   */
  oneOf<T extends string>(
    col: string,
    allowed: readonly T[],
    fallback: T,
    opts: { required?: boolean } = {},
  ): T {
    const raw = this.str(col)
    if (raw === '') {
      if (opts.required === true) this.fail(`${col} is required but empty`)
      return fallback
    }
    const hit = allowed.find((a) => a.toLowerCase() === raw.toLowerCase())
    if (hit !== undefined) return hit
    this.fail(`${col} must be one of ${allowed.join('|')}, got "${raw}"`)
    return fallback
  }

  /** Resolve a reference through a lookup map, reporting a dangling one. */
  ref<T>(col: string, map: ReadonlyMap<string, T>, what: string, lookupKey?: string): T | undefined {
    const raw = lookupKey ?? this.str(col)
    if (raw === '') {
      this.fail(`${col} is required but empty`)
      return undefined
    }
    const hit = map.get(raw)
    if (hit === undefined) {
      this.fail(`unknown ${what}: "${raw}"`)
      return undefined
    }
    return hit
  }
}

// ---------------------------------------------------------------------------
// Table iteration
// ---------------------------------------------------------------------------

/**
 * Callers pass `Record<string, string>` keyed however their file picker
 * happened to name things. Normalise to the bare upper-case table name so
 * `MARA`, `mara.csv` and `extract/MARA.CSV` all resolve.
 */
function normaliseFiles(files: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, text] of Object.entries(files)) {
    const bare = name.split(/[\\/]/).pop() ?? name
    const key = bare.replace(/\.csv$/i, '').trim().toUpperCase()
    if (!out.has(key)) out.set(key, text)
  }
  return out
}

interface TableOpts {
  /** A missing optional table is a warning; a missing required one is an error. */
  optional?: boolean
}

/**
 * Stream a table's data rows through `onRow`.
 *
 * Returns false when the table could not be read at all — missing file, or a
 * header that lacks a required column. Both cases are reported once, against
 * the table (row 1 is the header), rather than once per row.
 */
function readTable(
  ctx: Ctx,
  files: ReadonlyMap<string, string>,
  table: ExtractTable,
  required: readonly string[],
  onRow: (row: Row) => void,
  opts: TableOpts = {},
): boolean {
  const text = files.get(table)
  if (text === undefined) {
    if (opts.optional === true) ctx.tableWarn(table, 'not present in the extract — skipped')
    else ctx.tableError(table, 'table missing from the extract')
    return false
  }

  let cols: Map<string, number> | null = null
  let usable = true

  parseCsvRows(text, (cells, rowNumber) => {
    if (cols === null) {
      const map = new Map<string, number>()
      for (let i = 0; i < cells.length; i += 1) {
        const name = (cells[i] ?? '').trim().toUpperCase()
        if (name !== '' && !map.has(name)) map.set(name, i)
      }
      const missing = required.filter((c) => !map.has(c))
      if (missing.length > 0) {
        ctx.error(table, rowNumber, `missing required column(s) ${missing.join(', ')}`)
        usable = false
      }
      cols = map
      return
    }
    if (!usable) return
    if (isBlank(cells)) return
    onRow(new Row(ctx, table, rowNumber, cells, cols))
  })

  if (cols === null) {
    ctx.tableError(table, 'file is empty — no header row')
    return false
  }
  return usable
}

function isBlank(cells: readonly string[]): boolean {
  for (const cell of cells) {
    if (cell.trim() !== '') return false
  }
  return true
}

// ---------------------------------------------------------------------------
// ISO week arithmetic (label -> Monday), for rebuilding the horizon
// ---------------------------------------------------------------------------

const WEEK_LABEL = /^(\d{4})-W(\d{1,2})$/
const DAY_MS = 86_400_000

/** UTC ms of the Monday of an ISO week, or null when the week does not exist. */
function mondayOfIsoWeek(isoYear: number, isoWeek: number): number | null {
  if (!Number.isInteger(isoYear) || isoYear < 1000 || isoYear > 9999) return null
  if (!Number.isInteger(isoWeek) || isoWeek < 1 || isoWeek > 53) return null
  // 4 January is always in ISO week 1, in every year, by definition.
  const jan4 = Date.UTC(isoYear, 0, 4)
  const weekdayOfJan4 = (new Date(jan4).getUTCDay() + 6) % 7 // 0 = Monday
  const monday = jan4 - weekdayOfJan4 * DAY_MS + (isoWeek - 1) * 7 * DAY_MS
  // Week 53 exists only when the week's Thursday is still in the same ISO year.
  if (new Date(monday + 3 * DAY_MS).getUTCFullYear() !== isoYear) return null
  return monday
}

function parseWeekLabel(label: string): number | null {
  const match = WEEK_LABEL.exec(label)
  if (!match) return null
  const year = Number(match[1])
  const week = Number(match[2])
  return mondayOfIsoWeek(year, week)
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Rebuild the horizon from KAPA's availability rows.
 *
 * The extract has no calendar table; the week grid is implicit in the capacity
 * intervals, which is exactly where a real capacity extract carries it too.
 */
function deriveTimeGrid(ctx: Ctx, files: ReadonlyMap<string, string>): TimeGrid {
  // Row-level problems are reported by the main KAPA pass; this pass only
  // needs the labels, so it reads through a throwaway diagnostic sink.
  const silent = new Ctx()
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let seen = 0

  const consider = (label: string): void => {
    if (label === '') return
    const monday = parseWeekLabel(label)
    if (monday === null) return
    if (monday < min) min = monday
    if (monday > max) max = monday
    seen += 1
  }

  readTable(silent, files, 'KAPA', ['KAPID', 'WEEK', 'KIND'], (row) => {
    consider(row.str('WEEK'))
    consider(row.str('ZENDWEEK'))
  })

  if (seen === 0 || !Number.isFinite(min) || !Number.isFinite(max)) {
    ctx.tableError('KAPA', 'no usable week labels — the planning horizon cannot be rebuilt')
    return buildTimeGrid('1970-01-05', 0)
  }
  const weekCount = Math.round((max - min) / (7 * DAY_MS)) + 1
  if (weekCount > 5_000) {
    ctx.tableError('KAPA', `implausible horizon of ${weekCount} weeks — refusing to build the grid`)
    return buildTimeGrid('1970-01-05', 0)
  }
  return buildTimeGrid(isoDate(min), weekCount)
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

const MATERIAL_TYPES: readonly MaterialType[] = ['FERT', 'HALB', 'ROH']
const ABC_CLASSES: ReadonlyArray<'A' | 'B' | 'C'> = ['A', 'B', 'C']
const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'MXN', 'PLN', 'CNY']
const FEATURE_GROUPS: readonly FeatureGroup[] = [
  'process',
  'quality',
  'material',
  'handling',
  'compliance',
]
const DOWNTIME_KINDS: readonly DowntimeKind[] = [
  'shutdown',
  'project',
  'qualification',
  'maintenance',
  'installation',
  'changeover',
]
const DOWNTIME_STATUSES: readonly DowntimeStatus[] = ['planned', 'confirmed', 'atRisk']
const WC_STATUSES: ReadonlyArray<'active' | 'proposed'> = ['active', 'proposed']
const OEE_SCOPES: ReadonlyArray<'plant' | 'workCenter' | 'materialWorkCenter'> = [
  'plant',
  'workCenter',
  'materialWorkCenter',
]
const GLIDE_SCOPES: ReadonlyArray<'plant' | 'workCenter'> = ['plant', 'workCenter']
const CURVES: ReadonlyArray<'linear' | 'sCurve' | 'step'> = ['linear', 'sCurve', 'step']

/** The permanent categorical slot. Narrowed by hand — colour follows the entity. */
function colorSlotOf(raw: string): 1 | 2 | 3 | 4 | 5 | undefined {
  switch (raw) {
    case '1':
      return 1
    case '2':
      return 2
    case '3':
      return 3
    case '4':
      return 4
    case '5':
      return 5
    default:
      return undefined
  }
}

export function loadSnapshot(
  files: Record<string, string>,
  meta: Partial<SnapshotMeta> = {},
): LoadResult {
  const ctx = new Ctx()
  const src = normaliseFiles(files)

  // --- plants and product hierarchy ----------------------------------------
  const plants: Plant[] = []
  readTable(ctx, src, 'T001W', ['WERKS'], (row) => {
    const code = row.req('WERKS')
    const slot = colorSlotOf(row.str('ZCOLORSLOT'))
    if (slot === undefined) row.fail('ZCOLORSLOT must be a categorical slot 1..5')
    if (!row.ok || slot === undefined) return
    plants.push({
      id: row.str('ZPLANTID') === '' ? code : row.str('ZPLANTID'),
      code,
      name: row.text('NAME1'),
      city: row.text('ORT01'),
      country: row.text('LANDX'),
      countryCode: row.str('LAND1'),
      region: row.oneOf('REGIO', REGIONS, 'NAM'),
      currency: row.oneOf('WAERS', CURRENCIES, 'USD'),
      fxPerUsd: row.num('ZFXPERUSD', { fallback: 1 }),
      timezone: row.str('ZTIMEZONE'),
      lat: row.num('ZLAT'),
      lon: row.num('ZLON'),
      colorSlot: slot,
      labourCostPerHourLocal: row.num('ZLABOURCOSTLOCAL', { min: 0 }),
      defaultOee: row.num('ZDEFAULTOEE', { min: 0 }),
      gridIntensity: row.num('ZGRIDINTENSITY', { min: 0 }),
    })
  })
  const plantByCode = byKey(plants, (p) => p.code)

  const families: ProductFamily[] = []
  readTable(
    ctx,
    src,
    'T179',
    ['PRDHA'],
    (row) => {
      const code = row.req('PRDHA')
      if (!row.ok) return
      families.push({ id: orElse(row.str('ZFAMILYID'), code), code, name: row.text('VTEXT') })
    },
    { optional: true },
  )
  const familyByCode = byKey(families, (f) => f.code)

  const groups: ProductGroup[] = []
  readTable(
    ctx,
    src,
    'T023',
    ['MATKL'],
    (row) => {
      const code = row.req('MATKL')
      if (!row.ok) return
      const familyCode = row.str('PRDHA')
      groups.push({
        id: orElse(row.str('ZGROUPID'), code),
        familyId: familyByCode.get(familyCode)?.id ?? familyCode,
        code,
        name: row.text('WGBEZ'),
      })
    },
    { optional: true },
  )
  const groupByCode = byKey(groups, (g) => g.code)

  // --- the capability extension: features, classes, retrofits, standard ops -
  const features: Feature[] = []
  const machineClasses: MachineClass[] = []
  const standardOperations: StandardOperation[] = []
  const classById = new Map<string, MachineClass>()
  const retrofitById = new Map<string, RetrofitOption>()
  const stdOpById = new Map<string, StandardOperation>()
  const featureById = new Map<string, Feature>()

  const hasFeatures = readTable(
    ctx,
    src,
    'FEATURES',
    ['KIND'],
    (row) => {
      const kind = row.str('KIND').toUpperCase()
      switch (kind) {
        case 'FEATURE': {
          const id = row.req('FEATID')
          if (!row.ok) return
          const feature: Feature = {
            id,
            name: row.text('FEATNAME'),
            group: row.oneOf('FEATGROUP', FEATURE_GROUPS, 'process'),
            description: row.text('DESCR'),
          }
          features.push(feature)
          featureById.set(id, feature)
          return
        }
        case 'CLASS': {
          const id = row.req('CLASSID')
          if (!row.ok) return
          const cls: MachineClass = {
            id,
            name: row.text('CLASSNAME'),
            supplier: row.text('SUPPLIER'),
            generation: row.num('GENERATION', { fallback: 1 }),
            baseFeatures: [],
            retrofits: [],
          }
          machineClasses.push(cls)
          classById.set(id, cls)
          return
        }
        case 'CLASSFEAT': {
          const cls = row.ref('CLASSID', classById, 'machine class')
          const featureId = row.req('FEATID')
          if (cls === undefined || !row.ok) return
          cls.baseFeatures.push(featureId)
          return
        }
        case 'RETROFIT': {
          const cls = row.ref('CLASSID', classById, 'machine class')
          const id = row.req('RETROID')
          if (cls === undefined || !row.ok) return
          const retrofit: RetrofitOption = {
            id,
            name: row.text('RETRONAME'),
            addsFeatures: [],
            capexUsd: row.num('CAPEXUSD', { min: 0 }),
            leadTimeWeeks: row.num('LEADTIMEWEEKS', { min: 0 }),
            oeeDelta: row.num('OEEDELTA'),
            description: row.text('DESCR'),
          }
          cls.retrofits.push(retrofit)
          retrofitById.set(`${cls.id}|${id}`, retrofit)
          return
        }
        case 'RETROFEAT': {
          const classId = row.req('CLASSID')
          const retroId = row.req('RETROID')
          const featureId = row.req('FEATID')
          if (!row.ok) return
          const retrofit = retrofitById.get(`${classId}|${retroId}`)
          if (retrofit === undefined) {
            row.fail(`unknown retrofit: "${classId}/${retroId}"`)
            return
          }
          retrofit.addsFeatures.push(featureId)
          return
        }
        case 'STDOP': {
          const id = row.req('OPID')
          if (!row.ok) return
          const op: StandardOperation = {
            id,
            code: row.str('OPCODE'),
            name: row.text('OPNAME'),
            requiredFeatures: [],
            stage: row.num('STAGE'),
          }
          standardOperations.push(op)
          stdOpById.set(id, op)
          return
        }
        case 'STDOPFEAT': {
          const op = row.ref('OPID', stdOpById, 'standard operation')
          const featureId = row.req('FEATID')
          if (op === undefined || !row.ok) return
          op.requiredFeatures.push(featureId)
          return
        }
        case 'WCFEAT':
          return // second pass, once work centers exist
        default:
          row.fail(`unknown KIND "${row.str('KIND')}"`)
      }
    },
    { optional: true },
  )

  // --- materials -----------------------------------------------------------
  const materials: Material[] = []
  const materialByCode = new Map<string, Material>()
  const materialLine = new Map<string, number>()
  const plantIdsSeen = new Map<string, Set<string>>()

  readTable(ctx, src, 'MARA', ['MATNR', 'MTART', 'MEINS', 'MATKL', 'BISMT', 'NTGEW'], (row) => {
    const code = row.req('MATNR')
    const type = row.oneOf('MTART', MATERIAL_TYPES, 'FERT', { required: true })
    if (!row.ok) return
    if (materialByCode.has(code)) {
      row.fail(`duplicate MATNR "${code}"`)
      return
    }
    const groupCode = row.str('MATKL')
    const familyCode = row.str('PRDHA')
    const material: Material = {
      id: orElse(row.str('BISMT'), code),
      code,
      description: row.text('MAKTX'),
      type,
      groupId: groupByCode.get(groupCode)?.id ?? groupCode,
      familyId:
        familyByCode.get(familyCode)?.id ??
        groupByCode.get(groupCode)?.familyId ??
        familyCode,
      baseUom: row.str('MEINS'),
      plantIds: [],
      pricePerUnitUsd: row.num('ZPRICEUSD', { min: 0 }),
      materialCostPerUnitUsd: row.num('ZCOSTUSD', { min: 0 }),
      abcClass: 'C',
      unitsPerHandlingUnit: row.num('ZUNITSPERHU', { min: 0, fallback: 1 }),
      weightKgPerUnit: row.num('NTGEW', { min: 0 }),
    }
    materials.push(material)
    materialByCode.set(code, material)
    materialLine.set(code, row.line)
    plantIdsSeen.set(code, new Set<string>())
  })

  // MARC gives the plant assignment (which plants may produce it) and ABC.
  const abcSeen = new Set<string>()
  readTable(ctx, src, 'MARC', ['MATNR', 'WERKS'], (row) => {
    const material = row.ref('MATNR', materialByCode, 'material')
    const plant = row.ref('WERKS', plantByCode, 'plant')
    if (material === undefined || plant === undefined || !row.ok) return
    const seen = plantIdsSeen.get(material.code)
    if (seen !== undefined && seen.has(plant.id)) return
    seen?.add(plant.id)
    material.plantIds.push(plant.id)
    if (!abcSeen.has(material.code) && row.str('MAABC') !== '') {
      material.abcClass = row.oneOf('MAABC', ABC_CLASSES, 'C')
      abcSeen.add(material.code)
    }
  })

  // MAST + STPO carry the declared component — the only place WIP may cross a
  // plant boundary. The BOM number is the join.
  const bomMaterial = new Map<string, Material>()
  readTable(
    ctx,
    src,
    'MAST',
    ['MATNR', 'WERKS', 'STLNR'],
    (row) => {
      const material = row.ref('MATNR', materialByCode, 'material')
      row.ref('WERKS', plantByCode, 'plant')
      const bom = row.req('STLNR')
      if (material === undefined || !row.ok) return
      bomMaterial.set(bom, material)
    },
    { optional: true },
  )
  readTable(
    ctx,
    src,
    'STPO',
    ['STLNR', 'IDNRK'],
    (row) => {
      const parent = row.ref('STLNR', bomMaterial, 'BOM header (STLNR)')
      const component = row.ref('IDNRK', materialByCode, 'component material')
      if (parent === undefined || component === undefined || !row.ok) return
      if (parent.componentId === undefined) parent.componentId = component.id
    },
    { optional: true },
  )

  // --- work centers, capacities, pools -------------------------------------
  const workCenters: WorkCenter[] = []
  const wcByPlantAndCode = new Map<string, WorkCenter>()
  const wcById = new Map<string, WorkCenter>()
  const clonedFrom: Array<{ wc: WorkCenter; row: Row }> = []
  const availableFrom: Array<{ wc: WorkCenter; row: Row }> = []

  readTable(ctx, src, 'CRHD', ['ARBPL', 'WERKS', 'KLASSE'], (row) => {
    const code = row.req('ARBPL')
    const plant = row.ref('WERKS', plantByCode, 'plant')
    const classId = row.req('KLASSE')
    const status = row.oneOf('ZSTATUS', WC_STATUSES, 'active')
    if (plant === undefined || !row.ok) return
    if (hasFeatures && classById.size > 0 && !classById.has(classId)) {
      row.fail(`unknown machine class: "${classId}"`)
      return
    }
    const wc: WorkCenter = {
      id: orElse(row.str('ZWCID'), `${plant.code}-${code}`),
      plantId: plant.id,
      code,
      name: row.text('ARBET'),
      classId,
      vintage: row.num('BAUJR'),
      pools: [],
      features: [],
      baseOee: row.num('ZBASEOEE', { min: 0 }),
      status,
      costRateUsdPerHour: row.num('ZCOSTRATEUSD', { min: 0 }),
      co2PerMachineHourKg: row.num('ZCO2KGPERH', { min: 0 }),
    }
    workCenters.push(wc)
    wcById.set(wc.id, wc)
    wcByPlantAndCode.set(`${plant.code}|${code}`, wc)
    if (row.str('ZCLONEDFROM') !== '') clonedFrom.push({ wc, row })
    // Resolvable only once the horizon exists — held until the grid is built.
    if (row.str('ZAVAILFROMWEEK') !== '') availableFrom.push({ wc, row })
  })
  for (const { wc, row } of clonedFrom) {
    const source = row.str('ZCLONEDFROM')
    if (wcById.has(source)) wc.clonedFromId = source
    else row.fail(`unknown work center in ZCLONEDFROM: "${source}"`)
  }

  // Feature grants, now that the work centers exist.
  if (hasFeatures) {
    readTable(
      ctx,
      src,
      'FEATURES',
      ['KIND'],
      (row) => {
        if (row.str('KIND').toUpperCase() !== 'WCFEAT') return
        const wc = wcByPlantAndCode.get(`${row.str('WERKS')}|${row.str('ARBPL')}`)
        if (wc === undefined) {
          row.fail(`unknown work center: "${row.str('WERKS')}/${row.str('ARBPL')}"`)
          return
        }
        const featureId = row.req('FEATID')
        if (!row.ok) return
        if (featureById.size > 0 && !featureById.has(featureId)) {
          row.fail(`unknown feature: "${featureId}"`)
          return
        }
        wc.features.push(featureId)
      },
      { optional: true },
    )
  }

  interface CapacityLink {
    workCenter: WorkCenter
    pool: CapacityPool
  }
  const capacityById = new Map<string, CapacityLink>()
  readTable(ctx, src, 'CRCA', ['ARBPL', 'WERKS', 'KAPID', 'KAPART'], (row) => {
    const wc = wcByPlantAndCode.get(`${row.str('WERKS')}|${row.str('ARBPL')}`)
    if (wc === undefined) {
      row.fail(`unknown work center: "${row.str('WERKS')}/${row.str('ARBPL')}"`)
      return
    }
    const kapid = row.req('KAPID')
    const kapart = row.req('KAPART')
    if (!row.ok) return
    const pool = POOL_BY_KAPART[kapart]
    if (pool === undefined) {
      row.fail(`unknown capacity category KAPART "${kapart}" (001 machine, 002 person)`)
      return
    }
    capacityById.set(kapid, { workCenter: wc, pool })
  })

  const poolSeen = new Set<string>()
  readTable(ctx, src, 'KAKO', ['KAPID', 'AZNOR'], (row) => {
    const link = row.ref('KAPID', capacityById, 'capacity (KAPID, from CRCA)')
    if (link === undefined || !row.ok) return
    const marker = `${link.workCenter.id}|${link.pool}`
    if (poolSeen.has(marker)) {
      row.fail(`duplicate capacity header for ${link.workCenter.code} ${link.pool}`)
      return
    }
    const capacity: PoolCapacity = {
      pool: link.pool,
      count: row.num('ANZKA', { min: 0, fallback: 1 }),
      shiftsPerDay: row.num('NOSCH', { min: 0, fallback: 1 }),
      hoursPerShift: row.num('AZNOR', { min: 0, required: true }),
      daysPerWeek: row.num('ZDAYSPERWEEK', { min: 0, fallback: 5 }),
      // KAPTA is a percentage in SAP; the model wants the fraction.
      utilisationFactor: row.num('KAPTA', { min: 0, fallback: 100 }) / 100,
    }
    if (!row.ok) return
    poolSeen.add(marker)
    link.workCenter.pools.push(capacity)
  })
  for (const wc of workCenters) {
    const missing = CAPACITY_POOLS.filter((p) => !wc.pools.some((c) => c.pool === p))
    if (missing.length > 0) {
      ctx.tableError('KAKO', `work center ${wc.code} has no ${missing.join(' or ')} capacity`)
    }
  }

  // --- the horizon, then everything dated ----------------------------------
  const time = deriveTimeGrid(ctx, src)
  const weekOfLabel = new Map<string, number>()
  for (let w = 0; w < time.weeks.length; w += 1) {
    const label = time.weeks[w]
    if (label !== undefined) weekOfLabel.set(label, w)
  }
  const week = (row: Row, col: string, required: boolean): number | undefined => {
    const label = row.str(col)
    if (label === '') {
      if (required) row.fail(`${col} is required but empty`)
      return undefined
    }
    const index = weekOfLabel.get(label)
    if (index === undefined) {
      row.fail(`${col} "${label}" is not a week in the horizon (${horizonText(time)})`)
      return undefined
    }
    return index
  }

  for (const pending of availableFrom) {
    const index = week(pending.row, 'ZAVAILFROMWEEK', false)
    if (index !== undefined) pending.wc.availableFromWeek = index
  }

  // --- planned downtime ----------------------------------------------------
  const downtime: DowntimeEvent[] = []
  const downtimeById = new Map<string, DowntimeEvent>()
  let anonymousEvents = 0
  readTable(ctx, src, 'KAPA', ['KAPID', 'WEEK', 'KIND'], (row) => {
    const rawKind = row.str('KIND').toUpperCase()
    if (rawKind === KAPA_AVAILABLE) {
      // The weekly offer. Validated, then discarded: KAKO is the authority on
      // standing capacity, and re-deriving it here would give two answers.
      row.ref('KAPID', capacityById, 'capacity (KAPID, from CRCA)')
      week(row, 'WEEK', true)
      row.num('HOURS', { min: 0 })
      return
    }
    const link = row.ref('KAPID', capacityById, 'capacity (KAPID, from CRCA)')
    const kind = row.oneOf('KIND', DOWNTIME_KINDS, 'shutdown', { required: true })
    const status = row.oneOf('STATUS', DOWNTIME_STATUSES, 'planned')
    const fromWeek = week(row, 'WEEK', true)
    const toWeekRaw = row.str('ZENDWEEK') === '' ? fromWeek : week(row, 'ZENDWEEK', false)
    if (link === undefined || fromWeek === undefined || !row.ok) return
    const toWeek = toWeekRaw ?? fromWeek
    if (toWeek < fromWeek) {
      row.fail(`ZENDWEEK is before WEEK`)
      return
    }
    const id = orElse(row.str('ZEVENTID'), `DT-${row.line}-${(anonymousEvents += 1)}`)
    const poolText = row.str('POOLS')
    const pools: CapacityPool[] = []
    for (const part of poolText.split('+')) {
      const name = part.trim()
      if (name === '') continue
      const pool = CAPACITY_POOLS.find((p) => p === name)
      if (pool === undefined) {
        row.fail(`POOLS contains an unknown pool "${name}"`)
        return
      }
      pools.push(pool)
    }

    const existing = downtimeById.get(id)
    if (existing !== undefined) {
      // One row per blocked pool: fold the sibling rows back into one event.
      if (existing.workCenterId !== link.workCenter.id) {
        row.fail(`downtime ${id} spans two work centers`)
        return
      }
      for (const pool of pools) if (!existing.pools.includes(pool)) existing.pools.push(pool)
      return
    }
    const event: DowntimeEvent = {
      id,
      workCenterId: link.workCenter.id,
      kind,
      status,
      fromWeek,
      toWeek,
      pools,
      label: row.text('LABEL'),
    }
    const hours = row.optNum('HOURS', { min: 0 })
    if (hours !== undefined) event.hoursPerWeek = hours
    const slip = row.optNum('ZSLIPWEEKS', { min: 0 })
    if (slip !== undefined) event.slipWeeks = slip
    if (!row.ok) return
    downtime.push(event)
    downtimeById.set(id, event)
  })

  // --- routings ------------------------------------------------------------
  const routings: Routing[] = []
  const routingByNumber = new Map<string, Routing>()
  readTable(ctx, src, 'PLKO', ['PLNNR', 'PLNAL', 'WERKS'], (row) => {
    const plnnr = row.req('PLNNR')
    const plant = row.ref('WERKS', plantByCode, 'plant')
    if (plant === undefined || !row.ok) return
    if (routingByNumber.has(plnnr)) {
      row.fail(`duplicate routing number PLNNR "${plnnr}"`)
      return
    }
    const routing: Routing = {
      id: plnnr,
      materialId: '',
      plantId: plant.id,
      version: row.str('PLNAL'),
      primary: row.flag('ZPRIMARY'),
      operations: [],
    }
    const from = week(row, 'ZVALIDFROM', false)
    if (from !== undefined) routing.validFromWeek = from
    const to = week(row, 'ZVALIDTO', false)
    if (to !== undefined) routing.validToWeek = to
    if (!row.ok) return
    routings.push(routing)
    routingByNumber.set(plnnr, routing)
  })

  readTable(ctx, src, 'MAPL', ['MATNR', 'WERKS', 'PLNNR', 'PLNAL'], (row) => {
    const material = row.ref('MATNR', materialByCode, 'material')
    const routing = row.ref('PLNNR', routingByNumber, 'routing (PLNNR, from PLKO)')
    if (material === undefined || routing === undefined || !row.ok) return
    if (routing.materialId !== '' && routing.materialId !== material.id) {
      row.fail(`routing ${routing.id} is already assigned to another material`)
      return
    }
    routing.materialId = material.id
  })

  readTable(ctx, src, 'PLPO', ['PLNNR', 'PLNAL', 'VORNR', 'ARBPL', 'WERKS'], (row) => {
    const routing = row.ref('PLNNR', routingByNumber, 'routing (PLNNR, from PLKO)')
    const wc = wcByPlantAndCode.get(`${row.str('WERKS')}|${row.str('ARBPL')}`)
    if (wc === undefined) {
      row.fail(`unknown work center: "${row.str('WERKS')}/${row.str('ARBPL')}"`)
      return
    }
    const opId = row.str('ZOPID')
    if (opId !== '' && stdOpById.size > 0 && !stdOpById.has(opId)) {
      row.fail(`unknown standard operation: "${opId}"`)
      return
    }
    const scrapPct = row.num('AUSCH', { min: 0 })
    const operation: RoutingOperation = {
      seq: row.num('VORNR', { required: true, min: 0 }),
      opId,
      workCenterId: wc.id,
      baseQty: row.num('BMSCH', { min: 0, fallback: 1 }),
      setupHours: row.num('VGW01', { min: 0 }),
      machineHoursPerBase: row.num('VGW02', { min: 0 }),
      labourHoursPerBase: row.num('VGW03', { min: 0 }),
      yield: 1 - scrapPct / 100,
    }
    if (routing === undefined || !row.ok) return
    routing.operations.push(operation)
  })

  for (const routing of routings) {
    if (routing.materialId === '') {
      ctx.tableError('MAPL', `routing ${routing.id} has no material assignment`)
    }
    if (routing.operations.length === 0) {
      ctx.tableError('PLPO', `routing ${routing.id} has no operations`)
    }
  }
  const routedMaterials = new Set(routings.map((r) => r.materialId))
  for (const material of materials) {
    // A ROH is bought, not made — no routing is the correct state for one.
    if (material.type === 'ROH' || routedMaterials.has(material.id)) continue
    ctx.error(
      'MARA',
      materialLine.get(material.code) ?? 1,
      `material ${material.code} has no routing (no MAPL/PLKO entry)`,
    )
  }

  // --- the two knobs -------------------------------------------------------
  const oeeOverrides: OeeOverride[] = []
  const glidePaths: OeeGlidePath[] = []
  const rateOverrides: RateOverride[] = []
  const resolveWc = (row: Row): WorkCenter | undefined => {
    const wc = wcByPlantAndCode.get(`${row.str('WERKS')}|${row.str('ARBPL')}`)
    if (wc === undefined) row.fail(`unknown work center: "${row.str('WERKS')}/${row.str('ARBPL')}"`)
    return wc
  }
  readTable(
    ctx,
    src,
    'OEE',
    ['KIND'],
    (row) => {
      const kind = row.str('KIND').toUpperCase()
      if (kind === 'OVERRIDE') {
        const scope = row.oneOf('SCOPE', OEE_SCOPES, 'plant', { required: true })
        if (!row.ok) return
        const override: OeeOverride = { scope, value: row.num('VALUE', { min: 0 }) }
        if (scope === 'plant') {
          const plant = row.ref('WERKS', plantByCode, 'plant')
          if (plant === undefined) return
          override.plantId = plant.id
        } else {
          const wc = resolveWc(row)
          if (wc === undefined) return
          override.workCenterId = wc.id
          if (scope === 'materialWorkCenter') {
            const material = row.ref('MATNR', materialByCode, 'material')
            if (material === undefined) return
            override.materialId = material.id
          }
        }
        const from = week(row, 'FROMWEEK', false)
        if (from !== undefined) override.fromWeek = from
        const to = week(row, 'TOWEEK', false)
        if (to !== undefined) override.toWeek = to
        const note = row.text('NOTE')
        if (note !== '') override.note = note
        if (!row.ok) return
        oeeOverrides.push(override)
        return
      }
      if (kind === 'GLIDE') {
        const scope = row.oneOf('SCOPE', GLIDE_SCOPES, 'plant', { required: true })
        const fromWeek = week(row, 'FROMWEEK', true)
        const toWeek = week(row, 'TOWEEK', true)
        if (fromWeek === undefined || toWeek === undefined || !row.ok) return
        const path: OeeGlidePath = {
          id: orElse(row.str('ZGLIDEID'), `GLIDE-${row.line}`),
          scope,
          fromWeek,
          toWeek,
          endValue: row.num('ENDVALUE', { min: 0 }),
          curve: row.oneOf('CURVE', CURVES, 'linear'),
          label: row.text('LABEL'),
        }
        if (scope === 'plant') {
          const plant = row.ref('WERKS', plantByCode, 'plant')
          if (plant === undefined) return
          path.plantId = plant.id
        } else {
          const wc = resolveWc(row)
          if (wc === undefined) return
          path.workCenterId = wc.id
        }
        const start = row.optNum('STARTVALUE', { min: 0 })
        if (start !== undefined) path.startValue = start
        if (!row.ok) return
        glidePaths.push(path)
        return
      }
      if (kind === 'RATE') {
        const material = row.ref('MATNR', materialByCode, 'material')
        const wc = resolveWc(row)
        const opId = row.str('OPID')
        if (material === undefined || wc === undefined || !row.ok) return
        const override: RateOverride = {
          materialId: material.id,
          workCenterId: wc.id,
          opId,
          ratePerHour: row.num('VALUE', { min: 0 }),
        }
        const note = row.text('NOTE')
        if (note !== '') override.note = note
        if (!row.ok) return
        rateOverrides.push(override)
        return
      }
      row.fail(`unknown KIND "${row.str('KIND')}"`)
    },
    { optional: true },
  )

  // --- plans and inventory -------------------------------------------------
  const supplyPlan = readPlan(ctx, src, 'SUPPLY', time, weekOfLabel, materialByCode, (row) => {
    const plant = row.ref('WERKS', plantByCode, 'plant')
    return plant?.id
  })
  const demandPlan = readPlan(ctx, src, 'DEMAND', time, weekOfLabel, materialByCode, (row) => {
    const raw = row.str('REGION')
    const region: Region | undefined = REGIONS.find((r) => r === raw)
    if (region === undefined) {
      row.fail(`REGION must be one of ${REGIONS.join('|')}, got "${raw}"`)
      return undefined
    }
    return region
  })

  const inventory: InventoryRow[] = []
  readTable(ctx, src, 'INVENTORY', ['MATNR', 'WERKS', 'LABST', 'TRANS', 'SAFETY'], (row) => {
    const material = row.ref('MATNR', materialByCode, 'material')
    const plant = row.ref('WERKS', plantByCode, 'plant')
    const onHand = row.num('LABST', { min: 0 })
    const inTransit = row.num('TRANS', { min: 0 })
    const safetyStock = row.num('SAFETY', { min: 0 })
    if (material === undefined || plant === undefined || !row.ok) return
    inventory.push({ materialId: material.id, plantId: plant.id, onHand, inTransit, safetyStock })
  })

  const snapshot: Snapshot = {
    meta: {
      profile: meta.profile ?? 'sap-extract',
      generatedBy: 'sap-extract',
      seed: meta.seed ?? 0,
      skuCount: meta.skuCount ?? materials.length,
      workCenterCount: meta.workCenterCount ?? workCenters.length,
      weekCount: time.weeks.length,
      sourceLabel: meta.sourceLabel ?? 'SAP extract',
    },
    time,
    plants,
    features,
    machineClasses,
    workCenters,
    standardOperations,
    families,
    groups,
    materials,
    routings,
    rateOverrides,
    oeeOverrides,
    glidePaths,
    downtime,
    supplyPlan,
    demandPlan,
    inventory,
  }
  return { snapshot, errors: ctx.errors, warnings: ctx.warnings }
}

// ---------------------------------------------------------------------------
// Plan matrices
// ---------------------------------------------------------------------------

/**
 * Two passes: the first discovers row keys in file order (so the reconstructed
 * matrix has the same row order as the one that was written), the second fills
 * the `Float64Array` in place. Nothing per-cell is ever allocated.
 */
function readPlan(
  ctx: Ctx,
  files: ReadonlyMap<string, string>,
  table: 'SUPPLY' | 'DEMAND',
  time: TimeGrid,
  weekOfLabel: ReadonlyMap<string, number>,
  materialByCode: ReadonlyMap<string, Material>,
  secondKey: (row: Row) => string | undefined,
): PlanMatrix {
  const weekCount = time.weeks.length
  const columns = table === 'SUPPLY' ? ['MATNR', 'WERKS', 'WEEK', 'QTY'] : ['MATNR', 'REGION', 'WEEK', 'QTY']

  const rowIndex = new Map<string, number>()
  const rowKeys: string[] = []
  const silent = new Ctx() // pass one reports nothing; pass two reports everything

  readTable(silent, files, table, columns, (row) => {
    const material = materialByCode.get(row.str('MATNR'))
    if (material === undefined) return
    const second = secondKey(row)
    if (second === undefined) return
    const key = `${material.id}|${second}`
    if (!rowIndex.has(key)) {
      rowIndex.set(key, rowKeys.length)
      rowKeys.push(key)
    }
  })

  const values = new Float64Array(rowKeys.length * weekCount)
  readTable(ctx, files, table, columns, (row) => {
    const material = row.ref('MATNR', materialByCode, 'material')
    const second = secondKey(row)
    const label = row.str('WEEK')
    const w = weekOfLabel.get(label)
    if (w === undefined) {
      row.fail(`WEEK "${label}" is not a week in the horizon (${horizonText(time)})`)
      return
    }
    const qty = row.num('QTY', { min: 0, required: true })
    if (material === undefined || second === undefined || !row.ok) return
    const r = rowIndex.get(`${material.id}|${second}`)
    if (r === undefined) return
    values[r * weekCount + w] = qty
  })

  return { rowKeys, weekCount, values }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function byKey<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    const k = key(item)
    if (!map.has(k)) map.set(k, item)
  }
  return map
}

function orElse(value: string, fallback: string): string {
  return value === '' ? fallback : value
}

function horizonText(time: TimeGrid): string {
  const first = time.weeks[0]
  const last = time.weeks[time.weeks.length - 1]
  if (first === undefined || last === undefined) return 'empty horizon'
  return `${first}..${last}`
}
