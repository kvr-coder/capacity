/**
 * Snapshot -> SAP-shaped CSV extracts.
 *
 * The point of this layer is that the cockpit's integration path is real from
 * day one: what the factory generates can be written out in the shape a PP
 * extract actually arrives in, and `sap-loader.ts` parses it straight back.
 *
 * ## The seam, stated honestly
 *
 * Three groups of tables come out of here:
 *
 * 1. **Standard PP/MM objects** — MARA, MARC, MAST, STPO, PLKO, PLPO, MAPL,
 *    CRHD, CRCA, KAKO, KAPA, plus the three plant/hierarchy master tables
 *    T001W, T023 and T179. Real tables, real key fields.
 * 2. **Planning files** — DEMAND, SUPPLY, INVENTORY. These are flat extracts of
 *    whatever planning system feeds the plan (PP/DS, IBP, APO); their column
 *    names are conventional rather than dictated by a DDIC table.
 * 3. **Extensions** — `FEATURES` and `OEE`. Two things the standard objects
 *    cannot express and that this model depends on:
 *      - **FEATURES**: the capability model — the feature catalogue, machine
 *        classes and their base features, per-work-center feature grants,
 *        retrofit options, and the standard operations with the features they
 *        require. In a real system this lives in classification (KLAH/KSSK/
 *        AUSP characteristics on the work center) plus a custom retrofit table.
 *        Flattening classification into CRHD columns would be a lie, so it gets
 *        its own file with an explicit `KIND` discriminator.
 *      - **OEE**: the two independent knobs — OEE overrides at plant, work
 *        center and material x work center scope, dated OEE glide paths, and
 *        SKU-level rate overrides. SAP has no home for a dated improvement
 *        ramp; pretending CRHD or KAKO carries one would invent precision that
 *        does not exist.
 *
 * Where a standard table needs a field the DDIC structure does not have, the
 * column is `Z`-prefixed — exactly the convention a real append structure
 * uses, and a visible marker of every place the model exceeds standard SAP.
 * Everything unprefixed is a genuine field name.
 *
 * Two conventions worth knowing when reading the output:
 *
 *   - `KAPID` is `<WERKS>-<ARBPL>-M|L`, and `KAPART`/`KAPAR` follows SAP's
 *     capacity categories: `001` machine, `002` person (labour).
 *   - KAPA carries both halves of the capacity offer: `KIND=AVAIL` rows are the
 *     resolved weekly offer per capacity (and, incidentally, the only place the
 *     week grid itself is written down), and one row per *dated planned
 *     downtime event per blocked pool*. Unplanned loss is never here — it has
 *     no date, it lives in OEE.
 */

import type {
  CapacityPool,
  DowntimeEvent,
  MachineClass,
  Material,
  PlanMatrix,
  Plant,
  Snapshot,
  WorkCenter,
} from '@/domain/types'
import type { SapTable } from '@/worker/protocol'
import { at, indexBy, mustGet } from '@/domain/lookup'
import { csvField, toCsv } from '@/lib/csv'

// ---------------------------------------------------------------------------
// Table catalogue
// ---------------------------------------------------------------------------

/** Standard SAP objects the mandated `SapTable` union does not enumerate. */
export type SapMasterTable = 'T001W' | 'T023' | 'T179'

/** The two tables no standard object can express. See the file header. */
export type SapExtensionTable = 'FEATURES' | 'OEE'

export type ExtractTable = SapTable | SapMasterTable | SapExtensionTable

export const SAP_TABLES: readonly SapTable[] = [
  'MARA',
  'MARC',
  'MAST',
  'STPO',
  'PLKO',
  'PLPO',
  'MAPL',
  'CRHD',
  'CRCA',
  'KAKO',
  'KAPA',
  'DEMAND',
  'SUPPLY',
  'INVENTORY',
] as const

export const MASTER_TABLES: readonly SapMasterTable[] = ['T001W', 'T023', 'T179'] as const
export const EXTENSION_TABLES: readonly SapExtensionTable[] = ['FEATURES', 'OEE'] as const

/** Emission order: master before transactional, so a partial extract still reads. */
export const EXTRACT_TABLES: readonly ExtractTable[] = [
  'T001W',
  'T179',
  'T023',
  'FEATURES',
  'MARA',
  'MARC',
  'MAST',
  'STPO',
  'CRHD',
  'CRCA',
  'KAKO',
  'KAPA',
  'PLKO',
  'PLPO',
  'MAPL',
  'OEE',
  'SUPPLY',
  'DEMAND',
  'INVENTORY',
] as const

/** One-line description per table, for the generator's console output and the Data screen. */
export const TABLE_DESCRIPTIONS: Record<ExtractTable, string> = {
  T001W: 'plant master (standard)',
  T179: 'product hierarchy / families (standard)',
  T023: 'material groups / product groups (standard)',
  FEATURES: 'EXTENSION — capability model: features, classes, grants, retrofits, standard ops',
  MARA: 'material master (standard)',
  MARC: 'material x plant (standard)',
  MAST: 'BOM header (standard)',
  STPO: 'BOM items (standard)',
  CRHD: 'work centers (standard)',
  CRCA: 'work center -> capacity (standard)',
  KAKO: 'capacity header (standard)',
  KAPA: 'available capacity intervals + planned downtime (standard)',
  PLKO: 'routing header (standard)',
  PLPO: 'routing operations (standard)',
  MAPL: 'material -> routing assignment (standard)',
  OEE: 'EXTENSION — OEE overrides, glide paths and rate overrides',
  SUPPLY: 'supply plan (planning extract)',
  DEMAND: 'demand plan (planning extract)',
  INVENTORY: 'stock and safety stock (planning extract)',
}

export const TABLE_COLUMNS: Record<ExtractTable, readonly string[]> = {
  T001W: [
    'WERKS',
    'NAME1',
    'ORT01',
    'LAND1',
    'LANDX',
    'REGIO',
    'WAERS',
    'ZPLANTID',
    'ZFXPERUSD',
    'ZTIMEZONE',
    'ZLAT',
    'ZLON',
    'ZCOLORSLOT',
    'ZLABOURCOSTLOCAL',
    'ZDEFAULTOEE',
    'ZGRIDINTENSITY',
  ],
  T179: ['PRDHA', 'VTEXT', 'ZFAMILYID'],
  T023: ['MATKL', 'WGBEZ', 'PRDHA', 'ZGROUPID'],
  FEATURES: [
    'KIND',
    'FEATID',
    'FEATNAME',
    'FEATGROUP',
    'CLASSID',
    'CLASSNAME',
    'SUPPLIER',
    'GENERATION',
    'ARBPL',
    'WERKS',
    'RETROID',
    'RETRONAME',
    'CAPEXUSD',
    'LEADTIMEWEEKS',
    'OEEDELTA',
    'OPID',
    'OPCODE',
    'OPNAME',
    'STAGE',
    'DESCR',
  ],
  MARA: [
    'MATNR',
    'MTART',
    'MEINS',
    'MATKL',
    'BISMT',
    'NTGEW',
    'MAKTX',
    'PRDHA',
    'ZPRICEUSD',
    'ZCOSTUSD',
    'ZUNITSPERHU',
  ],
  MARC: ['MATNR', 'WERKS', 'BESKZ', 'SOBSL', 'DISLS', 'MAABC'],
  MAST: ['MATNR', 'WERKS', 'STLAN', 'STLNR'],
  STPO: ['STLNR', 'POSNR', 'IDNRK', 'MENGE', 'MEINS'],
  CRHD: [
    'ARBPL',
    'WERKS',
    'VERAN',
    'KOSTL',
    'ARBET',
    'KLASSE',
    'BAUJR',
    'ZWCID',
    'ZBASEOEE',
    'ZSTATUS',
    'ZCLONEDFROM',
    'ZAVAILFROMWEEK',
    'ZCOSTRATEUSD',
    'ZCO2KGPERH',
  ],
  CRCA: ['ARBPL', 'WERKS', 'KAPID', 'KAPART'],
  KAKO: ['KAPID', 'KAPAR', 'BEGZT', 'ENDZT', 'AZNOR', 'KAPTA', 'NOSCH', 'ANZKA', 'ZDAYSPERWEEK'],
  KAPA: [
    'KAPID',
    'WEEK',
    'KIND',
    'STATUS',
    'HOURS',
    'POOLS',
    'LABEL',
    'ZEVENTID',
    'ZENDWEEK',
    'ZSLIPWEEKS',
  ],
  PLKO: ['PLNTY', 'PLNNR', 'PLNAL', 'WERKS', 'VERWE', 'STATU', 'ZPRIMARY', 'ZVALIDFROM', 'ZVALIDTO'],
  PLPO: [
    'PLNNR',
    'PLNAL',
    'VORNR',
    'ARBPL',
    'WERKS',
    'BMSCH',
    'VGW01',
    'VGW02',
    'VGW03',
    'BASME',
    'AUSCH',
    'ZOPID',
  ],
  MAPL: ['MATNR', 'WERKS', 'PLNTY', 'PLNNR', 'PLNAL'],
  OEE: [
    'KIND',
    'SCOPE',
    'WERKS',
    'ARBPL',
    'MATNR',
    'OPID',
    'VALUE',
    'FROMWEEK',
    'TOWEEK',
    'STARTVALUE',
    'ENDVALUE',
    'CURVE',
    'ZGLIDEID',
    'LABEL',
    'NOTE',
  ],
  SUPPLY: ['MATNR', 'WERKS', 'WEEK', 'QTY'],
  DEMAND: ['MATNR', 'REGION', 'WEEK', 'QTY'],
  INVENTORY: ['MATNR', 'WERKS', 'LABST', 'TRANS', 'SAFETY'],
}

/** SAP capacity categories: 001 = machine, 002 = person. */
export const KAPART_BY_POOL: Record<CapacityPool, string> = { machine: '001', labour: '002' }
export const POOL_BY_KAPART: Record<string, CapacityPool> = { '001': 'machine', '002': 'labour' }

/** `KIND` values in KAPA. Downtime kinds are the `DowntimeKind` union, upper-cased. */
export const KAPA_AVAILABLE = 'AVAIL'

// ---------------------------------------------------------------------------
// Writer index — id -> code resolution, built once per extract
// ---------------------------------------------------------------------------

interface WriterIndex {
  plantById: Map<string, Plant>
  materialById: Map<string, Material>
  workCenterById: Map<string, WorkCenter>
  classById: Map<string, MachineClass>
  groupCodeById: Map<string, string>
  familyCodeById: Map<string, string>
  /** `${workCenterId}|${pool}` -> KAPID. */
  kapIdByWcPool: Map<string, string>
}

function buildIndex(snap: Snapshot): WriterIndex {
  const plantById = indexBy(snap.plants, (p) => p.id)
  const workCenterById = indexBy(snap.workCenters, (w) => w.id)
  const kapIdByWcPool = new Map<string, string>()
  for (const wc of snap.workCenters) {
    const plant = mustGet(plantById, wc.plantId, 'plant')
    for (const pool of wc.pools) {
      kapIdByWcPool.set(`${wc.id}|${pool.pool}`, kapId(plant.code, wc.code, pool.pool))
    }
  }
  return {
    plantById,
    materialById: indexBy(snap.materials, (m) => m.id),
    workCenterById,
    classById: indexBy(snap.machineClasses, (c) => c.id),
    groupCodeById: new Map(snap.groups.map((g) => [g.id, g.code])),
    familyCodeById: new Map(snap.families.map((f) => [f.id, f.code])),
    kapIdByWcPool,
  }
}

export function kapId(plantCode: string, wcCode: string, pool: CapacityPool): string {
  return `${plantCode}-${wcCode}-${pool === 'machine' ? 'M' : 'L'}`
}

// ---------------------------------------------------------------------------
// Cell formatting
// ---------------------------------------------------------------------------

/**
 * Numbers go out through `String`, which is round-trip exact for every finite
 * double — `Number(String(x)) === x`. Fixed-decimal formatting would quietly
 * lose the sixth decimal of a machine time, and this file exists to prove
 * nothing is lost.
 */
function num(value: number): string {
  return Number.isFinite(value) ? String(value) : ''
}

/**
 * Values the extract *derives* (a scrap percentage from a yield, a utilisation
 * percentage from a factor, weekly hours from a shift pattern) pick up float
 * noise on the way — `(1 - 0.985) * 100` is `1.5000000000000013`. Round the
 * noise off so the file reads like an extract instead of a float dump. Never
 * applied to a value that passes through unchanged: those stay bit-exact.
 */
function derived(value: number, dp = 9): number {
  const f = 10 ** dp
  return Math.round(value * f) / f
}

function optNum(value: number | undefined): string {
  return value === undefined ? '' : num(value)
}

function flag(value: boolean): string {
  return value ? 'X' : ''
}

function weekLabel(snap: Snapshot, week: number): string {
  return snap.time.weeks[week] ?? ''
}

function optWeekLabel(snap: Snapshot, week: number | undefined): string {
  return week === undefined ? '' : weekLabel(snap, week)
}

function plantCodeOf(idx: WriterIndex, plantId: string): string {
  return mustGet(idx.plantById, plantId, 'plant').code
}

function materialCodeOf(idx: WriterIndex, materialId: string): string {
  return mustGet(idx.materialById, materialId, 'material').code
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One table as CSV text, header row first. */
export function writeTable(snap: Snapshot, table: ExtractTable): string {
  return emit(snap, buildIndex(snap), table)
}

/**
 * Every table in the extract.
 *
 * The return type is a superset of `Record<SapTable, string>`: every mandated
 * SAP table is present, plus the standard master tables and the two documented
 * extensions.
 */
export function writeAll(snap: Snapshot): Record<ExtractTable, string> {
  const idx = buildIndex(snap)
  const out: Partial<Record<ExtractTable, string>> = {}
  for (const table of EXTRACT_TABLES) out[table] = emit(snap, idx, table)
  return out as Record<ExtractTable, string>
}

// ---------------------------------------------------------------------------
// Per-table emission
// ---------------------------------------------------------------------------

function emit(snap: Snapshot, idx: WriterIndex, table: ExtractTable): string {
  switch (table) {
    case 'T001W':
      return writeT001W(snap)
    case 'T179':
      return writeT179(snap)
    case 'T023':
      return writeT023(snap, idx)
    case 'FEATURES':
      return writeFeatures(snap, idx)
    case 'MARA':
      return writeMara(snap, idx)
    case 'MARC':
      return writeMarc(snap, idx)
    case 'MAST':
      return writeMast(snap, idx)
    case 'STPO':
      return writeStpo(snap, idx)
    case 'CRHD':
      return writeCrhd(snap, idx)
    case 'CRCA':
      return writeCrca(snap, idx)
    case 'KAKO':
      return writeKako(snap, idx)
    case 'KAPA':
      return writeKapa(snap, idx)
    case 'PLKO':
      return writePlko(snap, idx)
    case 'PLPO':
      return writePlpo(snap, idx)
    case 'MAPL':
      return writeMapl(snap, idx)
    case 'OEE':
      return writeOee(snap, idx)
    case 'SUPPLY':
      return writePlan(snap, idx, 'SUPPLY')
    case 'DEMAND':
      return writePlan(snap, idx, 'DEMAND')
    case 'INVENTORY':
      return writeInventory(snap, idx)
  }
}

function header(table: ExtractTable): string[] {
  return [...TABLE_COLUMNS[table]]
}

function table(name: ExtractTable, rows: (string | number)[][]): string {
  return toCsv([header(name), ...rows])
}

function writeT001W(snap: Snapshot): string {
  return table(
    'T001W',
    snap.plants.map((p) => [
      p.code,
      p.name,
      p.city,
      p.countryCode,
      p.country,
      p.region,
      p.currency,
      p.id,
      num(p.fxPerUsd),
      p.timezone,
      num(p.lat),
      num(p.lon),
      num(p.colorSlot),
      num(p.labourCostPerHourLocal),
      num(p.defaultOee),
      num(p.gridIntensity),
    ]),
  )
}

function writeT179(snap: Snapshot): string {
  return table(
    'T179',
    snap.families.map((f) => [f.code, f.name, f.id]),
  )
}

function writeT023(snap: Snapshot, idx: WriterIndex): string {
  return table(
    'T023',
    snap.groups.map((g) => [
      g.code,
      g.name,
      idx.familyCodeById.get(g.familyId) ?? g.familyId,
      g.id,
    ]),
  )
}

/**
 * The capability model. `KIND` discriminates:
 *
 *   FEATURE    the catalogue                     FEATID FEATNAME FEATGROUP DESCR
 *   CLASS      a machine class                   CLASSID CLASSNAME SUPPLIER GENERATION
 *   CLASSFEAT  a class base feature              CLASSID FEATID
 *   RETROFIT   a retrofit option on a class      CLASSID RETROID ... CAPEXUSD LEADTIMEWEEKS OEEDELTA
 *   RETROFEAT  a feature a retrofit adds         CLASSID RETROID FEATID
 *   WCFEAT     a granted work-center feature     ARBPL WERKS FEATID
 *   STDOP      a standard operation              OPID OPCODE OPNAME STAGE
 *   STDOPFEAT  a feature that operation needs    OPID FEATID
 *
 * Row order within a kind is the snapshot's order, so lists round-trip
 * position for position.
 */
function writeFeatures(snap: Snapshot, idx: WriterIndex): string {
  const cols = TABLE_COLUMNS.FEATURES
  const rows: (string | number)[][] = []
  const push = (values: Record<string, string | number>): void => {
    rows.push(cols.map((c) => values[c] ?? ''))
  }

  for (const f of snap.features) {
    push({ KIND: 'FEATURE', FEATID: f.id, FEATNAME: f.name, FEATGROUP: f.group, DESCR: f.description })
  }
  for (const c of snap.machineClasses) {
    push({
      KIND: 'CLASS',
      CLASSID: c.id,
      CLASSNAME: c.name,
      SUPPLIER: c.supplier,
      GENERATION: num(c.generation),
    })
    for (const featureId of c.baseFeatures) {
      push({ KIND: 'CLASSFEAT', CLASSID: c.id, FEATID: featureId })
    }
    for (const r of c.retrofits) {
      push({
        KIND: 'RETROFIT',
        CLASSID: c.id,
        RETROID: r.id,
        RETRONAME: r.name,
        CAPEXUSD: num(r.capexUsd),
        LEADTIMEWEEKS: num(r.leadTimeWeeks),
        OEEDELTA: num(r.oeeDelta),
        DESCR: r.description,
      })
      for (const featureId of r.addsFeatures) {
        push({ KIND: 'RETROFEAT', CLASSID: c.id, RETROID: r.id, FEATID: featureId })
      }
    }
  }
  for (const op of snap.standardOperations) {
    push({ KIND: 'STDOP', OPID: op.id, OPCODE: op.code, OPNAME: op.name, STAGE: num(op.stage) })
    for (const featureId of op.requiredFeatures) {
      push({ KIND: 'STDOPFEAT', OPID: op.id, FEATID: featureId })
    }
  }
  for (const wc of snap.workCenters) {
    const werks = plantCodeOf(idx, wc.plantId)
    for (const featureId of wc.features) {
      push({ KIND: 'WCFEAT', ARBPL: wc.code, WERKS: werks, FEATID: featureId })
    }
  }
  return toCsv([[...cols], ...rows])
}

function writeMara(snap: Snapshot, idx: WriterIndex): string {
  return table(
    'MARA',
    snap.materials.map((m) => [
      m.code,
      m.type,
      m.baseUom,
      idx.groupCodeById.get(m.groupId) ?? m.groupId,
      m.id,
      num(m.weightKgPerUnit),
      m.description,
      idx.familyCodeById.get(m.familyId) ?? m.familyId,
      num(m.pricePerUnitUsd),
      num(m.materialCostPerUnitUsd),
      num(m.unitsPerHandlingUnit),
    ]),
  )
}

function writeMarc(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  for (const m of snap.materials) {
    // BESKZ: E = in-house production, F = external procurement.
    const beskz = m.type === 'ROH' ? 'F' : 'E'
    for (const plantId of m.plantIds) {
      rows.push([m.code, plantCodeOf(idx, plantId), beskz, '', 'EX', m.abcClass])
    }
  }
  return table('MARC', rows)
}

/** BOM numbers are positional and stable: the writer is deterministic. */
function bomNumber(sequence: number): string {
  return String(sequence).padStart(8, '0')
}

function writeMast(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  let seq = 1
  for (const m of snap.materials) {
    if (m.componentId === undefined) continue
    for (const plantId of m.plantIds) {
      rows.push([m.code, plantCodeOf(idx, plantId), '1', bomNumber(seq)])
      seq += 1
    }
  }
  return table('MAST', rows)
}

function writeStpo(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  let seq = 1
  for (const m of snap.materials) {
    if (m.componentId === undefined) continue
    const component = mustGet(idx.materialById, m.componentId, 'component material')
    for (let i = 0; i < m.plantIds.length; i += 1) {
      rows.push([bomNumber(seq), '0010', component.code, '1', component.baseUom])
      seq += 1
    }
  }
  return table('STPO', rows)
}

function writeCrhd(snap: Snapshot, idx: WriterIndex): string {
  return table(
    'CRHD',
    snap.workCenters.map((wc) => {
      const plant = mustGet(idx.plantById, wc.plantId, 'plant')
      return [
        wc.code,
        plant.code,
        plant.code,
        `CC-${plant.code}-${wc.classId}`,
        wc.name,
        wc.classId,
        num(wc.vintage),
        wc.id,
        num(wc.baseOee),
        wc.status,
        wc.clonedFromId ?? '',
        optWeekLabel(snap, wc.availableFromWeek),
        num(wc.costRateUsdPerHour),
        num(wc.co2PerMachineHourKg),
      ]
    }),
  )
}

function writeCrca(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  for (const wc of snap.workCenters) {
    const werks = plantCodeOf(idx, wc.plantId)
    for (const pool of wc.pools) {
      rows.push([
        wc.code,
        werks,
        mustGet(idx.kapIdByWcPool, `${wc.id}|${pool.pool}`, 'capacity id'),
        KAPART_BY_POOL[pool.pool],
      ])
    }
  }
  return table('CRCA', rows)
}

function clockTime(hourOfDay: number): string {
  const h = ((Math.floor(hourOfDay) % 24) + 24) % 24
  const m = Math.round((hourOfDay - Math.floor(hourOfDay)) * 60) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

function writeKako(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  for (const wc of snap.workCenters) {
    for (const pool of wc.pools) {
      // BEGZT/ENDZT are informational: the shift window the hours describe.
      const start = 6
      rows.push([
        mustGet(idx.kapIdByWcPool, `${wc.id}|${pool.pool}`, 'capacity id'),
        KAPART_BY_POOL[pool.pool],
        clockTime(start),
        clockTime(start + pool.hoursPerShift),
        num(pool.hoursPerShift),
        // KAPTA is a percentage in SAP, not a fraction.
        num(derived(pool.utilisationFactor * 100)),
        num(pool.shiftsPerDay),
        num(pool.count),
        num(pool.daysPerWeek),
      ])
    }
  }
  return table('KAKO', rows)
}

export function weeklyPoolHours(count: number, shifts: number, hours: number, days: number, util: number): number {
  return count * shifts * hours * days * util
}

function writeKapa(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  const weekCount = snap.time.weeks.length

  // The resolved weekly offer, per capacity. This is also where the week grid
  // is written down — the loader rebuilds the horizon from these labels.
  for (const wc of snap.workCenters) {
    for (const pool of wc.pools) {
      const id = mustGet(idx.kapIdByWcPool, `${wc.id}|${pool.pool}`, 'capacity id')
      const hours = num(
        derived(
          weeklyPoolHours(
            pool.count,
            pool.shiftsPerDay,
            pool.hoursPerShift,
            pool.daysPerWeek,
            pool.utilisationFactor,
          ),
          6,
        ),
      )
      for (let w = 0; w < weekCount; w += 1) {
        rows.push([id, weekLabel(snap, w), KAPA_AVAILABLE, '', hours, pool.pool, '', '', '', ''])
      }
    }
  }

  for (const event of snap.downtime) {
    rows.push(...downtimeRows(snap, idx, event))
  }
  return table('KAPA', rows)
}

function downtimeRows(snap: Snapshot, idx: WriterIndex, event: DowntimeEvent): (string | number)[][] {
  const wc = mustGet(idx.workCenterById, event.workCenterId, 'work center')
  const base = [
    weekLabel(snap, event.fromWeek),
    event.kind.toUpperCase(),
    event.status.toUpperCase(),
    optNum(event.hoursPerWeek),
  ]
  const tail = [event.label, event.id, weekLabel(snap, event.toWeek), optNum(event.slipWeeks)]
  const pools = event.pools
  if (pools.length === 0) {
    // Degenerate but representable: an event that blocks no pool still has to
    // survive the round trip, so it is anchored to the work center's first
    // capacity with an empty POOLS list.
    const firstPool = at(wc.pools, 0, 'pool').pool
    const id = mustGet(idx.kapIdByWcPool, `${wc.id}|${firstPool}`, 'capacity id')
    return [[id, ...base, '', ...tail]]
  }
  return pools.map((pool) => {
    const id = mustGet(idx.kapIdByWcPool, `${wc.id}|${pool}`, 'capacity id')
    return [id, ...base, pool, ...tail]
  })
}

function writePlko(snap: Snapshot, idx: WriterIndex): string {
  return table(
    'PLKO',
    snap.routings.map((r) => [
      'N',
      r.id,
      r.version,
      plantCodeOf(idx, r.plantId),
      '1',
      '4',
      flag(r.primary),
      optWeekLabel(snap, r.validFromWeek),
      optWeekLabel(snap, r.validToWeek),
    ]),
  )
}

function writePlpo(snap: Snapshot, idx: WriterIndex): string {
  const rows: (string | number)[][] = []
  for (const r of snap.routings) {
    const material = mustGet(idx.materialById, r.materialId, 'material')
    for (const op of r.operations) {
      const wc = mustGet(idx.workCenterById, op.workCenterId, 'work center')
      rows.push([
        r.id,
        r.version,
        String(op.seq).padStart(4, '0'),
        wc.code,
        plantCodeOf(idx, wc.plantId),
        num(op.baseQty),
        num(op.setupHours),
        num(op.machineHoursPerBase),
        num(op.labourHoursPerBase),
        material.baseUom,
        // AUSCH is the operation scrap percentage — the complement of yield.
        num(derived((1 - op.yield) * 100)),
        op.opId,
      ])
    }
  }
  return table('PLPO', rows)
}

function writeMapl(snap: Snapshot, idx: WriterIndex): string {
  return table(
    'MAPL',
    snap.routings.map((r) => [
      materialCodeOf(idx, r.materialId),
      plantCodeOf(idx, r.plantId),
      'N',
      r.id,
      r.version,
    ]),
  )
}

function writeOee(snap: Snapshot, idx: WriterIndex): string {
  const cols = TABLE_COLUMNS.OEE
  const rows: (string | number)[][] = []
  const push = (values: Record<string, string | number>): void => {
    rows.push(cols.map((c) => values[c] ?? ''))
  }
  const werksOf = (plantId: string | undefined): string =>
    plantId === undefined ? '' : plantCodeOf(idx, plantId)
  const wcOf = (
    workCenterId: string | undefined,
  ): { arbpl: string; werks: string } => {
    if (workCenterId === undefined) return { arbpl: '', werks: '' }
    const wc = mustGet(idx.workCenterById, workCenterId, 'work center')
    return { arbpl: wc.code, werks: plantCodeOf(idx, wc.plantId) }
  }

  for (const o of snap.oeeOverrides) {
    const wc = wcOf(o.workCenterId)
    push({
      KIND: 'OVERRIDE',
      SCOPE: o.scope,
      WERKS: o.plantId !== undefined ? werksOf(o.plantId) : wc.werks,
      ARBPL: wc.arbpl,
      MATNR: o.materialId === undefined ? '' : materialCodeOf(idx, o.materialId),
      VALUE: num(o.value),
      FROMWEEK: optWeekLabel(snap, o.fromWeek),
      TOWEEK: optWeekLabel(snap, o.toWeek),
      NOTE: o.note ?? '',
    })
  }
  for (const g of snap.glidePaths) {
    const wc = wcOf(g.workCenterId)
    push({
      KIND: 'GLIDE',
      SCOPE: g.scope,
      WERKS: g.plantId !== undefined ? werksOf(g.plantId) : wc.werks,
      ARBPL: wc.arbpl,
      FROMWEEK: weekLabel(snap, g.fromWeek),
      TOWEEK: weekLabel(snap, g.toWeek),
      STARTVALUE: optNum(g.startValue),
      ENDVALUE: num(g.endValue),
      CURVE: g.curve,
      ZGLIDEID: g.id,
      LABEL: g.label,
    })
  }
  for (const r of snap.rateOverrides) {
    const wc = wcOf(r.workCenterId)
    push({
      KIND: 'RATE',
      MATNR: materialCodeOf(idx, r.materialId),
      ARBPL: wc.arbpl,
      WERKS: wc.werks,
      OPID: r.opId,
      VALUE: num(r.ratePerHour),
      NOTE: r.note ?? '',
    })
  }
  return toCsv([[...cols], ...rows])
}

/**
 * SUPPLY and DEMAND are the only tables big enough to matter. They bypass
 * `toCsv` and stream straight into a parts array: at 15,000 materials x 78
 * weeks the intermediate `(string | number)[][]` would be a million throwaway
 * arrays for no gain.
 *
 * Zero cells are skipped — a plan file lists what is planned. A row whose
 * cells are *all* zero still emits one explicit zero so its key survives the
 * round trip, and rows are emitted in `rowKeys` order so the reconstructed
 * matrix has the same row order as the original.
 */
function writePlan(snap: Snapshot, idx: WriterIndex, which: 'SUPPLY' | 'DEMAND'): string {
  const plan: PlanMatrix = which === 'SUPPLY' ? snap.supplyPlan : snap.demandPlan
  const out: string[] = [header(which).join(','), '\n']
  const { weekCount, values, rowKeys } = plan
  const weeks = snap.time.weeks

  for (let row = 0; row < rowKeys.length; row += 1) {
    const rowKey = at(rowKeys, row, 'plan row key')
    const split = rowKey.indexOf('|')
    const materialId = split === -1 ? rowKey : rowKey.slice(0, split)
    const second = split === -1 ? '' : rowKey.slice(split + 1)
    const left = csvField(materialCodeOf(idx, materialId))
    // SUPPLY rows are material|plant; DEMAND rows are material|region.
    const right = csvField(which === 'SUPPLY' ? plantCodeOf(idx, second) : second)
    const base = row * weekCount
    let wrote = false
    for (let w = 0; w < weekCount; w += 1) {
      const qty = values[base + w] ?? 0
      if (qty === 0) continue
      out.push(left, ',', right, ',', weeks[w] ?? '', ',', num(qty), '\n')
      wrote = true
    }
    if (!wrote) out.push(left, ',', right, ',', weeks[0] ?? '', ',', '0', '\n')
  }
  return out.join('')
}

function writeInventory(snap: Snapshot, idx: WriterIndex): string {
  return table(
    'INVENTORY',
    snap.inventory.map((row) => [
      materialCodeOf(idx, row.materialId),
      plantCodeOf(idx, row.plantId),
      num(row.onHand),
      num(row.inTransit),
      num(row.safetyStock),
    ]),
  )
}
