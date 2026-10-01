/**
 * The SAP round trip.
 *
 * Build the demo profile, write it out as SAP-shaped CSVs, parse them back,
 * and prove the reconstruction is the same model — same counts, same pools,
 * same operation times, same plan matrices cell for cell, same downtime,
 * features, OEE overrides and glide paths.
 *
 * The second half proves the other half of the contract: a broken extract
 * reports *every* problem, each naming its table and row, and the good rows
 * still load.
 */

import { describe, expect, it } from 'vitest'

import type { PlanMatrix, Routing, Snapshot, WorkCenter } from '@/domain/types'
import { buildTimeGrid } from '@/domain/time'
import { buildSnapshot, PROFILES } from '@/data/factory'
import { loadSnapshot } from '@/data/sap-loader'
import { writeAll, writeTable } from '@/data/sap-writer'
import { parseCsv, toCsv } from '@/lib/csv'

type Files = Record<string, string>

function demoSnapshot(): Snapshot {
  const profile = PROFILES.find((p) => p.id === 'demo')
  if (profile === undefined) throw new Error('the factory has no `demo` profile')
  return buildSnapshot(profile)
}

const original: Snapshot = demoSnapshot()
const extract: Files = writeAll(original)
const loaded = loadSnapshot(extract, { profile: 'demo', seed: original.meta.seed })

/** Vitest prints the whole array on failure, which is exactly what you want here. */
function expectClean(errors: string[]): void {
  expect(errors.slice(0, 20)).toEqual([])
}

// ---------------------------------------------------------------------------
// Normalisers — the two places the SAP shape is not bit-exact
// ---------------------------------------------------------------------------

/**
 * KAPTA is a percentage in SAP, so the utilisation factor makes a x100 / ÷100
 * round trip through the extract and can land a float ulp away.
 */
function normaliseWorkCenter(wc: WorkCenter): WorkCenter {
  return {
    ...wc,
    pools: wc.pools.map((p) => ({ ...p, utilisationFactor: round(p.utilisationFactor, 9) })),
  }
}

/** AUSCH is a scrap percentage, so yield is reconstructed as its complement. */
function normaliseRouting(r: Routing): Routing {
  return {
    ...r,
    operations: r.operations.map((op) => ({
      ...op,
      setupHours: round(op.setupHours, 6),
      machineHoursPerBase: round(op.machineHoursPerBase, 6),
      labourHoursPerBase: round(op.labourHoursPerBase, 6),
      yield: round(op.yield, 9),
    })),
  }
}

function round(value: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(value * f) / f
}

/** First differing cell, as a readable location — or null when identical. */
function firstCellDifference(
  a: PlanMatrix,
  b: PlanMatrix,
): { row: number; week: number; expected: number; actual: number } | null {
  if (a.weekCount !== b.weekCount) return { row: -1, week: -1, expected: a.weekCount, actual: b.weekCount }
  for (let r = 0; r < a.rowKeys.length; r += 1) {
    for (let w = 0; w < a.weekCount; w += 1) {
      const expected = a.values[r * a.weekCount + w] ?? 0
      const actual = b.values[r * b.weekCount + w] ?? 0
      if (expected !== actual) return { row: r, week: w, expected, actual }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('SAP extract round trip', () => {
  it('loads a self-written extract without a single error', () => {
    expectClean(loaded.errors)
  })

  it('writes every table it claims to, each with a header', () => {
    for (const [name, text] of Object.entries(extract)) {
      expect(text.length, `${name} is empty`).toBeGreaterThan(0)
      const firstLine = text.slice(0, text.indexOf('\n'))
      expect(firstLine.length, `${name} has no header row`).toBeGreaterThan(0)
    }
    // The mandated SAP tables are all present.
    for (const table of [
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
    ]) {
      expect(Object.keys(extract)).toContain(table)
    }
    // ...as are the two documented extensions.
    expect(Object.keys(extract)).toContain('FEATURES')
    expect(Object.keys(extract)).toContain('OEE')
  })

  it('rebuilds the same horizon', () => {
    expect(loaded.snapshot.time).toEqual(original.time)
    expect(loaded.snapshot.meta.weekCount).toBe(original.time.weeks.length)
    expect(loaded.snapshot.meta.generatedBy).toBe('sap-extract')
  })

  it('keeps the same count for every collection', () => {
    const s = loaded.snapshot
    expect(s.plants.length).toBe(original.plants.length)
    expect(s.features.length).toBe(original.features.length)
    expect(s.machineClasses.length).toBe(original.machineClasses.length)
    expect(s.workCenters.length).toBe(original.workCenters.length)
    expect(s.standardOperations.length).toBe(original.standardOperations.length)
    expect(s.families.length).toBe(original.families.length)
    expect(s.groups.length).toBe(original.groups.length)
    expect(s.materials.length).toBe(original.materials.length)
    expect(s.routings.length).toBe(original.routings.length)
    expect(s.rateOverrides.length).toBe(original.rateOverrides.length)
    expect(s.oeeOverrides.length).toBe(original.oeeOverrides.length)
    expect(s.glidePaths.length).toBe(original.glidePaths.length)
    expect(s.downtime.length).toBe(original.downtime.length)
    expect(s.inventory.length).toBe(original.inventory.length)
    expect(s.supplyPlan.rowKeys.length).toBe(original.supplyPlan.rowKeys.length)
    expect(s.demandPlan.rowKeys.length).toBe(original.demandPlan.rowKeys.length)
  })

  it('reconstructs plants, hierarchy and the capability master exactly', () => {
    expect(loaded.snapshot.plants).toEqual(original.plants)
    expect(loaded.snapshot.families).toEqual(original.families)
    expect(loaded.snapshot.groups).toEqual(original.groups)
    expect(loaded.snapshot.features).toEqual(original.features)
    expect(loaded.snapshot.machineClasses).toEqual(original.machineClasses)
    expect(loaded.snapshot.standardOperations).toEqual(original.standardOperations)
  })

  it('reconstructs work centers, their capacity pools and their feature grants', () => {
    expect(loaded.snapshot.workCenters.map(normaliseWorkCenter)).toEqual(
      original.workCenters.map(normaliseWorkCenter),
    )
    // Spelled out, because the pools are the point of the capacity model.
    for (let i = 0; i < original.workCenters.length; i += 1) {
      const before = original.workCenters[i]
      const after = loaded.snapshot.workCenters[i]
      expect(before).toBeDefined()
      expect(after).toBeDefined()
      if (before === undefined || after === undefined) continue
      expect(after.pools.map((p) => p.pool)).toEqual(before.pools.map((p) => p.pool))
      for (let p = 0; p < before.pools.length; p += 1) {
        const a = before.pools[p]
        const b = after.pools[p]
        if (a === undefined || b === undefined) throw new Error('missing pool')
        expect(b.count).toBe(a.count)
        expect(b.shiftsPerDay).toBe(a.shiftsPerDay)
        expect(b.hoursPerShift).toBeCloseTo(a.hoursPerShift, 6)
        expect(b.daysPerWeek).toBe(a.daysPerWeek)
        expect(b.utilisationFactor).toBeCloseTo(a.utilisationFactor, 9)
      }
      expect(after.features).toEqual(before.features)
    }
  })

  it('reconstructs materials, including the declared component chain', () => {
    expect(loaded.snapshot.materials).toEqual(original.materials)
    const withComponent = original.materials.filter((m) => m.componentId !== undefined)
    const loadedWithComponent = loaded.snapshot.materials.filter((m) => m.componentId !== undefined)
    expect(loadedWithComponent.length).toBe(withComponent.length)
  })

  it('reconstructs every routing operation, with times to six decimals', () => {
    expect(loaded.snapshot.routings.map(normaliseRouting)).toEqual(
      original.routings.map(normaliseRouting),
    )
    let operations = 0
    for (let i = 0; i < original.routings.length; i += 1) {
      const before = original.routings[i]
      const after = loaded.snapshot.routings[i]
      if (before === undefined || after === undefined) throw new Error('missing routing')
      expect(after.id).toBe(before.id)
      expect(after.materialId).toBe(before.materialId)
      expect(after.plantId).toBe(before.plantId)
      expect(after.version).toBe(before.version)
      expect(after.primary).toBe(before.primary)
      expect(after.operations.length).toBe(before.operations.length)
      for (let o = 0; o < before.operations.length; o += 1) {
        const a = before.operations[o]
        const b = after.operations[o]
        if (a === undefined || b === undefined) throw new Error('missing operation')
        expect(b.seq).toBe(a.seq)
        expect(b.opId).toBe(a.opId)
        expect(b.workCenterId).toBe(a.workCenterId)
        expect(b.baseQty).toBeCloseTo(a.baseQty, 6)
        expect(b.setupHours).toBeCloseTo(a.setupHours, 6)
        expect(b.machineHoursPerBase).toBeCloseTo(a.machineHoursPerBase, 6)
        expect(b.labourHoursPerBase).toBeCloseTo(a.labourHoursPerBase, 6)
        expect(b.yield).toBeCloseTo(a.yield, 6)
        operations += 1
      }
    }
    expect(operations).toBeGreaterThan(0)
  })

  it('reconstructs the supply and demand matrices cell for cell', () => {
    expect(loaded.snapshot.supplyPlan.rowKeys).toEqual(original.supplyPlan.rowKeys)
    expect(loaded.snapshot.demandPlan.rowKeys).toEqual(original.demandPlan.rowKeys)
    expect(firstCellDifference(original.supplyPlan, loaded.snapshot.supplyPlan)).toBeNull()
    expect(firstCellDifference(original.demandPlan, loaded.snapshot.demandPlan)).toBeNull()
    // A plan of all zeroes would pass the comparison above vacuously.
    expect(original.supplyPlan.values.some((v) => v > 0)).toBe(true)
    expect(original.demandPlan.values.some((v) => v > 0)).toBe(true)
  })

  it('reconstructs planned downtime, dates and blocked pools included', () => {
    expect(loaded.snapshot.downtime).toEqual(original.downtime)
    // Unplanned loss must never have acquired a date on the way through.
    expect(original.downtime.length).toBeGreaterThan(0)
  })

  it('reconstructs both knobs: OEE overrides, glide paths and rate overrides', () => {
    expect(loaded.snapshot.oeeOverrides).toEqual(original.oeeOverrides)
    expect(loaded.snapshot.glidePaths).toEqual(original.glidePaths)
    expect(loaded.snapshot.rateOverrides).toEqual(original.rateOverrides)
  })

  it('reconstructs inventory', () => {
    expect(loaded.snapshot.inventory).toEqual(original.inventory)
  })

  it('writes one table on its own identically to writing them all', () => {
    expect(writeTable(original, 'CRHD')).toBe(extract.CRHD)
    expect(writeTable(original, 'KAPA')).toBe(extract.KAPA)
  })

  it('loads an extract whose columns have been reordered and padded', () => {
    const shuffled = shuffleColumns(mustFile(extract, 'CRHD'))
    const withExtras = addColumn(mustFile(extract, 'MARA'), 'ZZ_UNKNOWN', 'ignore me')
    const result = loadSnapshot({ ...extract, CRHD: shuffled, MARA: withExtras })
    expectClean(result.errors)
    expect(result.snapshot.workCenters.map(normaliseWorkCenter)).toEqual(
      original.workCenters.map(normaliseWorkCenter),
    )
    expect(result.snapshot.materials.length).toBe(original.materials.length)
  })
})

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

describe('SAP loader error reporting', () => {
  it('names the table and row for a missing column, and still loads everything else', () => {
    const result = loadSnapshot({ ...extract, INVENTORY: dropColumn(mustFile(extract, 'INVENTORY'), 'SAFETY') })
    expect(result.errors).toContain('INVENTORY row 1: missing required column(s) SAFETY')
    expect(result.errors.length).toBe(1)
    expect(result.snapshot.inventory).toEqual([])
    // The good rows still load.
    expect(result.snapshot.materials.length).toBe(original.materials.length)
    expect(result.snapshot.workCenters.length).toBe(original.workCenters.length)
    expect(firstCellDifference(original.supplyPlan, result.snapshot.supplyPlan)).toBeNull()
  })

  it('names the table and row for a dangling work-center reference', () => {
    const broken = setCell(mustFile(extract, 'PLPO'), 1, 'ARBPL', 'WC-DOES-NOT-EXIST')
    const result = loadSnapshot({ ...extract, PLPO: broken })
    expect(result.errors.some((e) => e.startsWith('PLPO row 2:'))).toBe(true)
    expect(result.errors.some((e) => e.includes('unknown work center') && e.includes('WC-DOES-NOT-EXIST'))).toBe(true)
    // One operation is lost; nothing else is.
    const opsBefore = countOperations(original)
    const opsAfter = countOperations(result.snapshot)
    expect(opsAfter).toBe(opsBefore - 1)
    expect(result.snapshot.workCenters.length).toBe(original.workCenters.length)
  })

  it('names the table and row for a week label outside the horizon', () => {
    const broken = setCell(mustFile(extract, 'SUPPLY'), 2, 'WEEK', '2026-W99')
    const result = loadSnapshot({ ...extract, SUPPLY: broken })
    expect(result.errors.some((e) => e.startsWith('SUPPLY row 3:') && e.includes('2026-W99'))).toBe(true)
    expect(result.errors.some((e) => e.includes('not a week in the horizon'))).toBe(true)
    // Every other cell is intact: only the one moved quantity is missing.
    expect(sum(result.snapshot.supplyPlan)).toBeCloseTo(
      sum(original.supplyPlan) - cellOf(mustFile(extract, 'SUPPLY'), 2),
      6,
    )
    expect(result.snapshot.supplyPlan.rowKeys).toEqual(original.supplyPlan.rowKeys)
  })

  it('names the table and row for a negative quantity', () => {
    const broken = setCell(mustFile(extract, 'SUPPLY'), 3, 'QTY', '-5')
    const result = loadSnapshot({ ...extract, SUPPLY: broken })
    expect(result.errors.some((e) => e.startsWith('SUPPLY row 4:') && e.includes('QTY'))).toBe(true)
    expect(result.errors.some((e) => e.includes('must be >= 0'))).toBe(true)
    expect(result.snapshot.supplyPlan.rowKeys).toEqual(original.supplyPlan.rowKeys)
  })

  it('reports all four problems at once rather than the first one', () => {
    const files: Files = {
      ...extract,
      INVENTORY: dropColumn(mustFile(extract, 'INVENTORY'), 'SAFETY'),
      PLPO: setCell(mustFile(extract, 'PLPO'), 1, 'ARBPL', 'WC-DOES-NOT-EXIST'),
      SUPPLY: setCell(
        setCell(mustFile(extract, 'SUPPLY'), 2, 'WEEK', '2026-W99'),
        3,
        'QTY',
        '-5',
      ),
    }
    const result = loadSnapshot(files)
    expect(result.errors.filter((e) => e.startsWith('INVENTORY row 1:')).length).toBe(1)
    expect(result.errors.filter((e) => e.startsWith('PLPO row 2:')).length).toBe(1)
    expect(result.errors.filter((e) => e.startsWith('SUPPLY row 3:')).length).toBe(1)
    expect(result.errors.filter((e) => e.startsWith('SUPPLY row 4:')).length).toBe(1)
    // ...and the rest of the model is still there.
    expect(result.snapshot.plants).toEqual(original.plants)
    expect(result.snapshot.materials.length).toBe(original.materials.length)
    expect(result.snapshot.downtime).toEqual(original.downtime)
  })

  it('reports a missing table instead of throwing', () => {
    const withoutCrhd: Files = { ...extract }
    delete withoutCrhd.CRHD
    const result = loadSnapshot(withoutCrhd)
    expect(result.errors).toContain('CRHD: table missing from the extract')
    expect(result.snapshot.workCenters).toEqual([])
    expect(result.snapshot.plants).toEqual(original.plants)
  })

  it('reports a material with no routing at its own MARA row', () => {
    const mapl = parseCsv(mustFile(extract, 'MAPL'))
    const header = mapl[0]
    const first = mapl[1]
    if (header === undefined || first === undefined) throw new Error('MAPL has no rows')
    const matnrCol = header.indexOf('MATNR')
    const orphan = first[matnrCol]
    if (orphan === undefined) throw new Error('MAPL has no MATNR column')
    // Strip every routing assignment for one material.
    const kept = mapl.filter((row, i) => i === 0 || row[matnrCol] !== orphan)
    const result = loadSnapshot({ ...extract, MAPL: toCsv(kept) })
    expect(result.errors.some((e) => e.startsWith('MARA row ') && e.includes(`${orphan} has no routing`))).toBe(true)
    expect(result.snapshot.materials.length).toBe(original.materials.length)
  })
})

// ---------------------------------------------------------------------------
// CSV surgery helpers
// ---------------------------------------------------------------------------

function mustFile(files: Files, table: string): string {
  const text = files[table]
  if (text === undefined) throw new Error(`the extract has no ${table}`)
  return text
}

function headerOf(rows: string[][]): string[] {
  const header = rows[0]
  if (header === undefined) throw new Error('table has no header')
  return header
}

function columnIndex(header: string[], column: string): number {
  const index = header.indexOf(column)
  if (index === -1) throw new Error(`no ${column} column`)
  return index
}

/** `dataRow` is 1-based among data rows, so it maps to file line `dataRow + 1`. */
function setCell(text: string, dataRow: number, column: string, value: string): string {
  const rows = parseCsv(text)
  const index = columnIndex(headerOf(rows), column)
  const target = rows[dataRow]
  if (target === undefined) throw new Error(`no data row ${dataRow}`)
  target[index] = value
  return toCsv(rows)
}

function cellOf(text: string, dataRow: number): number {
  const rows = parseCsv(text)
  const index = columnIndex(headerOf(rows), 'QTY')
  const target = rows[dataRow]
  if (target === undefined) throw new Error(`no data row ${dataRow}`)
  return Number(target[index] ?? '0')
}

function dropColumn(text: string, column: string): string {
  const rows = parseCsv(text)
  const index = columnIndex(headerOf(rows), column)
  return toCsv(rows.map((row) => row.filter((_cell, i) => i !== index)))
}

function addColumn(text: string, column: string, value: string): string {
  const rows = parseCsv(text)
  return toCsv(rows.map((row, i) => [...row, i === 0 ? column : value]))
}

/** Reverse the column order — a header-driven loader must not notice. */
function shuffleColumns(text: string): string {
  return toCsv(parseCsv(text).map((row) => [...row].reverse()))
}

function countOperations(snap: Snapshot): number {
  let total = 0
  for (const routing of snap.routings) total += routing.operations.length
  return total
}

function sum(plan: PlanMatrix): number {
  let total = 0
  for (let i = 0; i < plan.values.length; i += 1) total += plan.values[i] ?? 0
  return total
}

// ---------------------------------------------------------------------------
// A hand-built snapshot, exercising the optional corners
// ---------------------------------------------------------------------------

/**
 * The factory profile is realistic but not exhaustive: it will not necessarily
 * contain a proposed work center cloned from a sibling, a downtime event that
 * blocks the whole week rather than a fixed number of hours, a glide path with
 * no explicit start value, or a routing with a validity window. Those are
 * exactly the fields a round trip loses silently, so they get an explicit
 * fixture.
 */
function buildFixture(): Snapshot {
  const time = buildTimeGrid('2026-01-05', 6)
  const supplyRows = ['M-FERT|P1', 'M-FERT|P2', 'M-HALB|P1']
  const supply = new Float64Array(supplyRows.length * time.weeks.length)
  supply[0] = 120.5
  supply[3] = 0.25
  supply[time.weeks.length + 1] = 900
  // Row 2 (M-HALB|P1) stays all zero on purpose: its key must still survive.
  const demandRows = ['M-FERT|NAM', 'M-FERT|EUR']
  const demand = new Float64Array(demandRows.length * time.weeks.length)
  demand[2] = 1000
  demand[demandRows.length * time.weeks.length - 1] = 7.125

  return {
    meta: {
      profile: 'fixture',
      generatedBy: 'factory',
      seed: 7,
      skuCount: 3,
      workCenterCount: 3,
      weekCount: time.weeks.length,
    },
    time,
    plants: [
      {
        id: 'P1',
        code: 'US-TOL',
        name: 'Toledo',
        city: 'Toledo',
        country: 'United States',
        countryCode: 'US',
        region: 'NAM',
        currency: 'USD',
        fxPerUsd: 1,
        timezone: 'America/New_York',
        lat: 41.6528,
        lon: -83.5379,
        colorSlot: 1,
        labourCostPerHourLocal: 62.5,
        defaultOee: 0.82,
        gridIntensity: 0.38,
      },
      {
        id: 'P2',
        code: 'PL-WRO',
        name: 'Wrocław',
        city: 'Wrocław',
        country: 'Poland',
        countryCode: 'PL',
        region: 'EUR',
        currency: 'PLN',
        fxPerUsd: 3.98,
        timezone: 'Europe/Warsaw',
        lat: 51.1079,
        lon: 17.0385,
        colorSlot: 4,
        labourCostPerHourLocal: 91.25,
        defaultOee: 0.76,
        gridIntensity: 0.61,
      },
    ],
    features: [
      { id: 'F-5AX', name: '5-axis', group: 'process', description: 'Five-axis machining' },
      { id: 'F-CMM', name: 'In-line CMM', group: 'quality', description: 'Inline metrology' },
      { id: 'F-TI', name: 'Titanium', group: 'material', description: 'Titanium capable' },
    ],
    machineClasses: [
      {
        id: 'MC-A',
        name: 'Alpha 400',
        supplier: 'Alpha',
        generation: 3,
        baseFeatures: ['F-5AX', 'F-CMM'],
        retrofits: [
          {
            id: 'R-TI',
            name: 'Titanium package',
            addsFeatures: ['F-TI'],
            capexUsd: 480_000,
            leadTimeWeeks: 14,
            oeeDelta: 0.025,
            description: 'Spindle and coolant upgrade',
          },
        ],
      },
      {
        id: 'MC-B',
        name: 'Beta 200',
        supplier: 'Beta',
        generation: 1,
        baseFeatures: ['F-5AX'],
        retrofits: [],
      },
    ],
    workCenters: [
      {
        id: 'WC1',
        plantId: 'P1',
        code: 'MC-0100',
        name: 'Cell 100',
        classId: 'MC-A',
        vintage: 2019,
        pools: [
          { pool: 'machine', count: 4, shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 6, utilisationFactor: 0.92 },
          { pool: 'labour', count: 3, shiftsPerDay: 3, hoursPerShift: 7.5, daysPerWeek: 6, utilisationFactor: 0.85 },
        ],
        features: ['F-5AX', 'F-CMM'],
        baseOee: 0.84,
        status: 'active',
        costRateUsdPerHour: 128.75,
        co2PerMachineHourKg: 11.4,
      },
      {
        id: 'WC2',
        plantId: 'P2',
        code: 'MC-0200',
        name: 'Cell 200',
        classId: 'MC-B',
        vintage: 2007,
        pools: [
          { pool: 'machine', count: 2, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1.05 },
          { pool: 'labour', count: 2, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 0.9 },
        ],
        features: ['F-5AX'],
        baseOee: 0.71,
        status: 'active',
        costRateUsdPerHour: 64.2,
        co2PerMachineHourKg: 19.8,
      },
      {
        id: 'WC3',
        plantId: 'P2',
        code: 'MC-0201',
        name: 'Cell 201 (proposed)',
        classId: 'MC-B',
        vintage: 2027,
        pools: [
          { pool: 'machine', count: 1, shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 7, utilisationFactor: 1 },
          { pool: 'labour', count: 1, shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 7, utilisationFactor: 1 },
        ],
        features: ['F-5AX', 'F-TI'],
        baseOee: 0.8,
        status: 'proposed',
        clonedFromId: 'WC2',
        availableFromWeek: 3,
        costRateUsdPerHour: 70,
        co2PerMachineHourKg: 9.5,
      },
    ],
    standardOperations: [
      { id: 'OP-MILL', code: 'OP-MILL', name: 'Mill', requiredFeatures: ['F-5AX'], stage: 1 },
      { id: 'OP-INSP', code: 'OP-INSP', name: 'Inspect', requiredFeatures: ['F-CMM'], stage: 2 },
    ],
    families: [{ id: 'FAM1', code: 'A1', name: 'Actuators' }],
    groups: [
      { id: 'G1', familyId: 'FAM1', code: 'A100', name: 'Linear actuators' },
      { id: 'G2', familyId: 'FAM1', code: 'A200', name: 'Rotary actuators' },
    ],
    materials: [
      {
        id: 'M-FERT',
        code: 'FG-0001',
        description: 'Actuator, finished',
        type: 'FERT',
        groupId: 'G1',
        familyId: 'FAM1',
        baseUom: 'EA',
        plantIds: ['P1', 'P2'],
        pricePerUnitUsd: 412.75,
        materialCostPerUnitUsd: 208.4,
        componentId: 'M-HALB',
        abcClass: 'A',
        unitsPerHandlingUnit: 24,
        weightKgPerUnit: 3.75,
      },
      {
        id: 'M-HALB',
        code: 'SF-0001',
        description: 'Actuator body',
        type: 'HALB',
        groupId: 'G2',
        familyId: 'FAM1',
        baseUom: 'EA',
        plantIds: ['P1'],
        pricePerUnitUsd: 0,
        materialCostPerUnitUsd: 96.125,
        abcClass: 'B',
        unitsPerHandlingUnit: 48,
        weightKgPerUnit: 2.5,
      },
      {
        id: 'M-ROH',
        code: 'RM-0001',
        description: 'Billet',
        type: 'ROH',
        groupId: 'G2',
        familyId: 'FAM1',
        baseUom: 'KG',
        plantIds: ['P1'],
        pricePerUnitUsd: 0,
        materialCostPerUnitUsd: 4.2,
        abcClass: 'C',
        unitsPerHandlingUnit: 1000,
        weightKgPerUnit: 1,
      },
    ],
    routings: [
      {
        id: 'RT-0001',
        materialId: 'M-FERT',
        plantId: 'P1',
        version: '0001',
        primary: true,
        operations: [
          {
            seq: 10,
            opId: 'OP-MILL',
            workCenterId: 'WC1',
            baseQty: 100,
            setupHours: 1.25,
            machineHoursPerBase: 0.083333,
            labourHoursPerBase: 0.041667,
            yield: 0.985,
          },
          {
            seq: 20,
            opId: 'OP-INSP',
            workCenterId: 'WC1',
            baseQty: 100,
            setupHours: 0.5,
            machineHoursPerBase: 0.0125,
            labourHoursPerBase: 0.025,
            yield: 0.999,
          },
        ],
      },
      {
        id: 'RT-0002',
        materialId: 'M-FERT',
        plantId: 'P2',
        version: '0002',
        primary: false,
        operations: [
          {
            seq: 10,
            opId: 'OP-MILL',
            workCenterId: 'WC2',
            baseQty: 50,
            setupHours: 2,
            machineHoursPerBase: 0.2,
            labourHoursPerBase: 0.2,
            yield: 0.94,
          },
        ],
        validFromWeek: 2,
        validToWeek: 5,
      },
      {
        id: 'RT-0003',
        materialId: 'M-HALB',
        plantId: 'P1',
        version: '0001',
        primary: true,
        operations: [
          {
            seq: 10,
            opId: 'OP-MILL',
            workCenterId: 'WC1',
            baseQty: 1,
            setupHours: 0,
            machineHoursPerBase: 1.5,
            labourHoursPerBase: 0.75,
            yield: 1,
          },
        ],
      },
    ],
    rateOverrides: [
      { materialId: 'M-FERT', workCenterId: 'WC2', opId: 'OP-MILL', ratePerHour: 42.5, note: 'trial rate' },
      { materialId: 'M-HALB', workCenterId: 'WC1', opId: 'OP-MILL', ratePerHour: 8 },
    ],
    oeeOverrides: [
      { scope: 'plant', plantId: 'P2', value: 0.74, note: 'monsoon quarter' },
      { scope: 'workCenter', workCenterId: 'WC1', value: 0.88, fromWeek: 1, toWeek: 4 },
      { scope: 'materialWorkCenter', materialId: 'M-FERT', workCenterId: 'WC1', value: 0.79 },
    ],
    glidePaths: [
      {
        id: 'GP-1',
        scope: 'workCenter',
        workCenterId: 'WC2',
        fromWeek: 1,
        toWeek: 5,
        startValue: 0.71,
        endValue: 0.84,
        curve: 'sCurve',
        label: 'Beta overhaul',
      },
      {
        id: 'GP-2',
        scope: 'plant',
        plantId: 'P1',
        fromWeek: 0,
        toWeek: 4,
        endValue: 0.87,
        curve: 'linear',
        label: 'Toledo lean programme',
      },
    ],
    downtime: [
      {
        id: 'DT-1',
        workCenterId: 'WC1',
        kind: 'shutdown',
        status: 'confirmed',
        fromWeek: 2,
        toWeek: 3,
        pools: ['machine', 'labour'],
        label: 'Collective vacation',
      },
      {
        id: 'DT-2',
        workCenterId: 'WC2',
        kind: 'maintenance',
        status: 'planned',
        fromWeek: 4,
        toWeek: 4,
        pools: ['machine'],
        hoursPerWeek: 16.5,
        label: 'Spindle PM',
      },
      {
        id: 'DT-3',
        workCenterId: 'WC3',
        kind: 'installation',
        status: 'atRisk',
        fromWeek: 1,
        toWeek: 2,
        pools: ['machine', 'labour'],
        hoursPerWeek: 40,
        label: 'Commissioning',
        slipWeeks: 2,
      },
    ],
    supplyPlan: { rowKeys: supplyRows, weekCount: time.weeks.length, values: supply },
    demandPlan: { rowKeys: demandRows, weekCount: time.weeks.length, values: demand },
    inventory: [
      { materialId: 'M-FERT', plantId: 'P1', onHand: 1200.5, inTransit: 300, safetyStock: 800 },
      { materialId: 'M-HALB', plantId: 'P1', onHand: 0, inTransit: 0, safetyStock: 250.25 },
    ],
  }
}

describe('SAP extract round trip — hand-built fixture', () => {
  const fixture = buildFixture()
  const files: Files = writeAll(fixture)
  const result = loadSnapshot(files, { profile: 'fixture', seed: fixture.meta.seed })

  it('loads without errors', () => {
    expectClean(result.errors)
  })

  it('rebuilds the horizon from KAPA alone', () => {
    expect(result.snapshot.time).toEqual(fixture.time)
  })

  it('rebuilds every master collection exactly', () => {
    expect(result.snapshot.plants).toEqual(fixture.plants)
    expect(result.snapshot.features).toEqual(fixture.features)
    expect(result.snapshot.machineClasses).toEqual(fixture.machineClasses)
    expect(result.snapshot.standardOperations).toEqual(fixture.standardOperations)
    expect(result.snapshot.families).toEqual(fixture.families)
    expect(result.snapshot.groups).toEqual(fixture.groups)
    expect(result.snapshot.materials).toEqual(fixture.materials)
    expect(result.snapshot.inventory).toEqual(fixture.inventory)
  })

  it('keeps the proposed work center, its clone source and its availability week', () => {
    expect(result.snapshot.workCenters.map(normaliseWorkCenter)).toEqual(
      fixture.workCenters.map(normaliseWorkCenter),
    )
    const proposed = result.snapshot.workCenters.find((wc) => wc.status === 'proposed')
    expect(proposed?.clonedFromId).toBe('WC2')
    expect(proposed?.availableFromWeek).toBe(3)
  })

  it('keeps routing validity windows and operation times', () => {
    expect(result.snapshot.routings.map(normaliseRouting)).toEqual(
      fixture.routings.map(normaliseRouting),
    )
    const dated = result.snapshot.routings.find((r) => r.id === 'RT-0002')
    expect(dated?.validFromWeek).toBe(2)
    expect(dated?.validToWeek).toBe(5)
    expect(result.snapshot.routings.filter((r) => r.primary).length).toBe(2)
  })

  it('distinguishes a full-week block from a fixed hours-per-week loss', () => {
    expect(result.snapshot.downtime).toEqual(fixture.downtime)
    const shutdown = result.snapshot.downtime.find((d) => d.id === 'DT-1')
    expect(shutdown?.hoursPerWeek).toBeUndefined()
    expect(shutdown?.pools).toEqual(['machine', 'labour'])
    const pm = result.snapshot.downtime.find((d) => d.id === 'DT-2')
    expect(pm?.hoursPerWeek).toBe(16.5)
    expect(pm?.pools).toEqual(['machine'])
    expect(result.snapshot.downtime.find((d) => d.id === 'DT-3')?.slipWeeks).toBe(2)
  })

  it('keeps both knobs apart', () => {
    expect(result.snapshot.oeeOverrides).toEqual(fixture.oeeOverrides)
    expect(result.snapshot.glidePaths).toEqual(fixture.glidePaths)
    expect(result.snapshot.rateOverrides).toEqual(fixture.rateOverrides)
    const openEnded = result.snapshot.glidePaths.find((g) => g.id === 'GP-2')
    expect(openEnded?.startValue).toBeUndefined()
  })

  it('keeps an all-zero plan row rather than dropping its key', () => {
    expect(result.snapshot.supplyPlan.rowKeys).toEqual(fixture.supplyPlan.rowKeys)
    expect(result.snapshot.demandPlan.rowKeys).toEqual(fixture.demandPlan.rowKeys)
    expect(firstCellDifference(fixture.supplyPlan, result.snapshot.supplyPlan)).toBeNull()
    expect(firstCellDifference(fixture.demandPlan, result.snapshot.demandPlan)).toBeNull()
  })

  it('does not demand a routing for a purchased material', () => {
    expect(result.errors.some((e) => e.includes('RM-0001'))).toBe(false)
  })
})
