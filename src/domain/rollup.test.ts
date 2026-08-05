import { describe, expect, it } from 'vitest'
import type {
  Filters,
  MachineClass,
  Material,
  Plant,
  PlanMatrix,
  PoolCapacity,
  Routing,
  RoutingOperation,
  Scenario,
  Snapshot,
  StandardOperation,
  WorkCenter,
} from '@/domain/types'
import { buildIndexes } from '@/domain/indexes'
import type { SnapshotIndexes } from '@/domain/indexes'
import { buildOeeGrid } from '@/domain/oee'
import { buildCapacity, buildCeilings } from '@/domain/capacity'
import { resolveSourcing } from '@/domain/sourcing'
import { buildLoad } from '@/domain/load'
import type { LoadOutput } from '@/domain/load'
import { buildFilterContext, rollup, summarise, summariseByWeek } from '@/domain/rollup'
import { buildTimeGrid } from '@/domain/time'
import { at } from '@/domain/lookup'

const WEEKS = 4

/**
 * Every number below is chosen so the expected results are exact.
 *
 *   nominal rate  = baseQty / machineHoursPerBase = 1 each/hour
 *   OEE           = 0.5 everywhere
 *   -> machine and labour hours per unit = 2
 *   pools         = 10 machine hours and 10 labour hours per week
 */
function pools(): PoolCapacity[] {
  return [
    { pool: 'machine', count: 1, shiftsPerDay: 1, hoursPerShift: 10, daysPerWeek: 1, utilisationFactor: 1 },
    { pool: 'labour', count: 1, shiftsPerDay: 1, hoursPerShift: 10, daysPerWeek: 1, utilisationFactor: 1 },
  ]
}

const PLANTS: Plant[] = [
  {
    id: 'P1',
    code: 'WRO',
    name: 'Wroclaw Plant',
    city: 'Wroclaw',
    country: 'Poland',
    countryCode: 'PL',
    region: 'EUR',
    currency: 'PLN',
    fxPerUsd: 4, // 100 PLN/h -> 25 USD/h
    timezone: 'Europe/Warsaw',
    lat: 51,
    lon: 17,
    colorSlot: 1,
    labourCostPerHourLocal: 100,
    defaultOee: 0.5,
    gridIntensity: 0.6,
  },
  {
    id: 'P2',
    code: 'SUZ',
    name: 'Suzhou Plant',
    city: 'Suzhou',
    country: 'China',
    countryCode: 'CN',
    region: 'APAC',
    currency: 'CNY',
    fxPerUsd: 7, // 70 CNY/h -> 10 USD/h
    timezone: 'Asia/Shanghai',
    lat: 31,
    lon: 120,
    colorSlot: 2,
    labourCostPerHourLocal: 70,
    defaultOee: 0.5,
    gridIntensity: 0.55,
  },
]

const CLASSES: MachineClass[] = [
  { id: 'CLASS-A', name: 'Alpha', supplier: 'Acme', generation: 3, baseFeatures: ['F-A'], retrofits: [] },
  { id: 'CLASS-B', name: 'Beta', supplier: 'Acme', generation: 4, baseFeatures: ['F-A'], retrofits: [] },
]

function wc(id: string, plantId: string, classId: string): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: `${id} line`,
    classId,
    vintage: 2015,
    pools: pools(),
    features: ['F-A'],
    baseOee: 0.5,
    status: 'active',
    costRateUsdPerHour: 100,
    co2PerMachineHourKg: 5,
  }
}

const STD_OPS: StandardOperation[] = [
  { id: 'OP-A', code: 'OP-A', name: 'Form', requiredFeatures: ['F-A'], stage: 10 },
]

function op(workCenterId: string): RoutingOperation {
  return {
    seq: 10,
    opId: 'OP-A',
    workCenterId,
    baseQty: 1,
    setupHours: 0,
    machineHoursPerBase: 1,
    labourHoursPerBase: 1,
    yield: 1,
  }
}

function material(id: string, groupId: string, familyId: string, plantIds: string[]): Material {
  return {
    id,
    code: `${id}-CODE`,
    description: id,
    type: 'FERT',
    groupId,
    familyId,
    baseUom: 'EA',
    plantIds,
    pricePerUnitUsd: 10,
    materialCostPerUnitUsd: 4,
    abcClass: 'A',
    unitsPerHandlingUnit: 100,
    weightKgPerUnit: 1,
  }
}

function matrix(rowKeys: string[], rows: number[][]): PlanMatrix {
  const values = new Float64Array(rowKeys.length * WEEKS)
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]
    if (row === undefined) continue
    for (let w = 0; w < WEEKS; w += 1) values[r * WEEKS + w] = row[w] ?? 0
  }
  return { rowKeys, weekCount: WEEKS, values }
}

function snapshot(): Snapshot {
  const routings: Routing[] = [
    { id: 'R1', materialId: 'M1', plantId: 'P1', version: '0001', primary: true, operations: [op('WC1')] },
    { id: 'R2', materialId: 'M2', plantId: 'P2', version: '0001', primary: true, operations: [op('WC2')] },
  ]
  return {
    meta: { profile: 'test', generatedBy: 'factory', seed: 1, skuCount: 2, workCenterCount: 2, weekCount: WEEKS },
    time: buildTimeGrid('2026-01-05', WEEKS),
    plants: PLANTS,
    features: [{ id: 'F-A', name: 'Forming', group: 'process', description: '' }],
    machineClasses: CLASSES,
    workCenters: [wc('WC1', 'P1', 'CLASS-A'), wc('WC2', 'P2', 'CLASS-B')],
    standardOperations: STD_OPS,
    families: [
      { id: 'FAM-1', code: 'F1', name: 'Enclosures' },
      { id: 'FAM-2', code: 'F2', name: 'Frames' },
    ],
    groups: [
      { id: 'G1', familyId: 'FAM-1', code: 'G1', name: 'Housings' },
      { id: 'G2', familyId: 'FAM-2', code: 'G2', name: 'Brackets' },
    ],
    materials: [material('M1', 'G1', 'FAM-1', ['P1']), material('M2', 'G2', 'FAM-2', ['P2'])],
    routings,
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [
      {
        // Week 1 leaves WC1 with a single machine hour. That is what makes the
        // averaging bug visible.
        id: 'DT-1',
        workCenterId: 'WC1',
        kind: 'maintenance',
        status: 'planned',
        fromWeek: 1,
        toWeek: 1,
        pools: ['machine'],
        hoursPerWeek: 9,
        label: 'Gearbox',
      },
    ],
    // M1: 1 machine hour in week 0, 0.9 in week 1. M2: 2 hours every week.
    supplyPlan: matrix(
      ['M1|P1', 'M2|P2'],
      [
        [0.5, 0.45, 0, 0],
        [1, 1, 1, 1],
      ],
    ),
    demandPlan: matrix(
      ['M1|EUR', 'M2|APAC'],
      [
        [1, 1, 1, 1],
        [1, 1, 1, 1],
      ],
    ),
    inventory: [],
  }
}

function emptyScenario(): Scenario {
  return { id: 'baseline', name: 'Baseline', description: '', moves: [], colorSlot: 1 }
}

function model(snap: Snapshot, ceiling = 1): { idx: SnapshotIndexes; load: LoadOutput } {
  const idx = buildIndexes(snap)
  const oee = buildOeeGrid(snap, idx)
  const capacity = buildCapacity(snap, idx)
  const ceilings = buildCeilings(emptyScenario(), ceiling)
  const sourcing = resolveSourcing(snap, idx, emptyScenario())
  return { idx, load: buildLoad(snap, idx, sourcing, capacity, oee, ceilings) }
}

function filters(over: Partial<Filters> = {}): Filters {
  return {
    plantIds: [],
    regions: [],
    familyIds: [],
    groupIds: [],
    workCenterIds: [],
    machineClassIds: [],
    fromWeek: 0,
    toWeek: WEEKS - 1,
    bucket: 'week',
    ...over,
  }
}

// ---------------------------------------------------------------------------

describe('rollup — utilisation is recomputed, never averaged', () => {
  it('divides summed hours, and the answer differs from the mean of the ratios', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)

    // Week 0: 1h required of 10h available -> 10%.
    // Week 1: 0.9h required of 1h available -> 90%.
    const week0 = load.cells.find((c) => c.workCenterId === 'WC1' && c.week === 0)
    const week1 = load.cells.find((c) => c.workCenterId === 'WC1' && c.week === 1)
    expect(week0?.utilisation).toBeCloseTo(0.1)
    expect(week1?.utilisation).toBeCloseTo(0.9)

    const { cells } = rollup({
      snap,
      idx,
      load,
      filters: filters({ workCenterIds: ['WC1'], fromWeek: 0, toWeek: 1, bucket: 'month' }),
      level: 'workCenter',
    })
    expect(cells).toHaveLength(1)
    const cell = at(cells, 0, 'cell')
    expect(cell.requiredHours).toBeCloseTo(1.9)
    expect(cell.availableHours).toBeCloseTo(11)
    // 1.9 / 11, not (0.10 + 0.90) / 2.
    expect(cell.utilisation).toBeCloseTo(1.9 / 11)
    expect(cell.utilisation).not.toBeCloseTo(0.5)
    // And the identity the whole file rests on.
    expect(cell.utilisation).toBeCloseTo(cell.requiredHours / cell.availableHours)
  })

  it('keeps that identity at every level', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    for (const level of ['global', 'region', 'plant', 'workCenter', 'machineClass', 'family', 'group'] as const) {
      const { cells } = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level })
      expect(cells.length).toBeGreaterThan(0)
      for (const cell of cells) {
        if (cell.availableHours === 0) continue
        expect(cell.utilisation).toBeCloseTo(cell.requiredHours / cell.availableHours)
      }
    }
  })
})

describe('rollup — filters', () => {
  it('treats an empty filter array as ALL, never none', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const { cells } = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'plant' })
    expect(cells.map((c) => c.key).sort()).toEqual(['P1', 'P2'])
  })

  it('narrows by plant', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const { cells } = rollup({
      snap,
      idx,
      load,
      filters: filters({ plantIds: ['P1'], bucket: 'month' }),
      level: 'plant',
    })
    expect(cells.map((c) => c.key)).toEqual(['P1'])
    // 1 + 0.9 machine hours, nothing from Suzhou.
    expect(at(cells, 0, 'cell').requiredHours).toBeCloseTo(1.9)
  })

  it('narrows by region, and a region filter implies its plants', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const { cells } = rollup({
      snap,
      idx,
      load,
      filters: filters({ regions: ['APAC'], bucket: 'month' }),
      level: 'workCenter',
    })
    expect(cells.map((c) => c.key)).toEqual(['WC2'])
  })

  it('narrows by machine class and by work center', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    expect(
      rollup({ snap, idx, load, filters: filters({ machineClassIds: ['CLASS-B'], bucket: 'month' }), level: 'workCenter' })
        .cells.map((c) => c.key),
    ).toEqual(['WC2'])
    expect(
      rollup({ snap, idx, load, filters: filters({ workCenterIds: ['WC1'], bucket: 'month' }), level: 'workCenter' })
        .cells.map((c) => c.key),
    ).toEqual(['WC1'])
  })

  it('narrows the hours by product group without shrinking the factory', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const { cells } = rollup({
      snap,
      idx,
      load,
      filters: filters({ groupIds: ['G2'], bucket: 'month' }),
      level: 'global',
    })
    const cell = at(cells, 0, 'cell')
    // Only Brackets: 2 hours a week at WC2 for four weeks.
    expect(cell.requiredHours).toBeCloseTo(8)
    // Both work centers still have all their hours: 31 at WC1 (week 1 is down
    // to one hour) plus 40 at WC2.
    expect(cell.availableHours).toBeCloseTo(71)
  })

  it('narrows by family, which resolves to its groups', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const { cells } = rollup({
      snap,
      idx,
      load,
      filters: filters({ familyIds: ['FAM-1'], bucket: 'month' }),
      level: 'global',
    })
    expect(at(cells, 0, 'cell').requiredHours).toBeCloseTo(1.9)
  })

  it('clamps the week window to the horizon', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const ctx = buildFilterContext(snap, idx, load, filters({ fromWeek: -5, toWeek: 900 }))
    expect(ctx.fromWeek).toBe(0)
    expect(ctx.toWeek).toBe(WEEKS - 1)
  })
})

describe('rollup — buckets and levels', () => {
  it('emits one cell per week, per month and per quarter', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    expect(rollup({ snap, idx, load, filters: filters({ bucket: 'week' }), level: 'global' }).cells).toHaveLength(4)
    expect(rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'global' }).cells).toHaveLength(1)
    expect(rollup({ snap, idx, load, filters: filters({ bucket: 'quarter' }), level: 'global' }).cells).toHaveLength(1)
  })

  it('names each bucket by its first week in the window', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const { cells } = rollup({
      snap,
      idx,
      load,
      filters: filters({ fromWeek: 1, toWeek: 3, bucket: 'month' }),
      level: 'global',
    })
    expect(at(cells, 0, 'cell').week).toBe(1)
  })

  it('rolls up to groups, families and materials with labels a planner reads', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const groups = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'group' }).cells
    expect(groups.map((c) => c.label).sort()).toEqual(['Brackets', 'Housings'])
    const families = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'family' }).cells
    expect(families.map((c) => c.label).sort()).toEqual(['Enclosures', 'Frames'])
    const materials = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'material' }).cells
    expect(materials.map((c) => c.label).sort()).toEqual(['M1-CODE', 'M2-CODE'])
  })

  it('allocates capacity to products so the groups add back up to the network', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const network = at(
      rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'global' }).cells,
      0,
      'cell',
    )
    const groups = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'group' }).cells
    const required = groups.reduce((sum, c) => sum + c.requiredHours, 0)
    expect(required).toBeCloseTo(network.requiredHours)
    // Allocated available hours never exceed the network's — that is the whole
    // point of allocating rather than summing.
    const available = groups.reduce((sum, c) => sum + c.availableHours, 0)
    expect(available).toBeLessThanOrEqual(network.availableHours + 1e-9)
  })

  it('restricts to a parent when asked', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const cells = rollup({
      snap,
      idx,
      load,
      filters: filters({ bucket: 'month' }),
      level: 'workCenter',
      parentKey: 'P2',
    }).cells
    expect(cells.map((c) => c.key)).toEqual(['WC2'])
  })

  it('does not claim units at work-center level, where the same unit is counted twice', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const cells = rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'workCenter' }).cells
    for (const cell of cells) expect(cell.supplyUnits).toBe(0)
  })
})

describe('rollup — money, carbon and the plan gap', () => {
  it('prices machine hours at the asset and labour at the plant, in USD', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const cell = at(
      rollup({
        snap,
        idx,
        load,
        filters: filters({ plantIds: ['P1'], bucket: 'month' }),
        level: 'plant',
      }).cells,
      0,
      'cell',
    )
    // 1.9 machine hours x $100 + 1.9 labour hours x (100 PLN / 4) = $237.50
    expect(cell.costUsd).toBeCloseTo(1.9 * 100 + 1.9 * 25)
    expect(cell.co2Kg).toBeCloseTo(1.9 * 5)
  })

  it('reports demand against supply as a signed gap', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const cell = at(
      rollup({ snap, idx, load, filters: filters({ bucket: 'month' }), level: 'global' }).cells,
      0,
      'cell',
    )
    // Supply placed: 0.95 of M1 plus 4 of M2. Demand: 4 + 4.
    expect(cell.supplyUnits).toBeCloseTo(4.95)
    expect(cell.demandUnits).toBeCloseTo(8)
    expect(cell.gapUnits).toBeCloseTo(8 - 4.95)
  })
})

describe('summarise', () => {
  it('counts overloaded, underloaded and binding cells over the slice', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const kpis = summarise(load, snap, idx, filters(), 1_234)

    expect(kpis.overloadedCells).toBe(0)
    // WC1 weeks 0, 2, 3 and all four WC2 weeks sit below 40%.
    expect(kpis.underloadedCells).toBe(7)
    expect(kpis.machineBoundCells).toBe(6)
    expect(kpis.labourBoundCells).toBe(0)
    expect(kpis.peakUtilisation).toBeCloseTo(0.9)
    expect(kpis.capexUsd).toBe(1_234)
    expect(kpis.downtimeHours).toBeCloseTo(9)
  })

  it('weights the mean utilisation by hours, not by cell', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const kpis = summarise(load, snap, idx, filters({ workCenterIds: ['WC1'], fromWeek: 0, toWeek: 1 }), 0)
    expect(kpis.utilisation).toBeCloseTo(1.9 / 11)
    expect(kpis.utilisation).toBeCloseTo(kpis.requiredHours / kpis.availableHours)
  })

  it('reports overload once the ceiling bites', () => {
    const snap = snapshot()
    const { idx, load } = model(snap, 0.05) // 10h available -> 0.5h planable
    const kpis = summarise(load, snap, idx, filters(), 0)
    expect(kpis.overloadedCells).toBeGreaterThan(0)
    expect(kpis.overloadHours).toBeGreaterThan(0)
    expect(kpis.shortfallUnits).toBeGreaterThan(0)
  })

  it('produces a per-week series that sums back to the totals', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const total = summarise(load, snap, idx, filters(), 0)
    const byWeek = summariseByWeek(load, snap, idx, filters())
    expect(byWeek.map((k) => k.week)).toEqual([0, 1, 2, 3])
    const sum = (pick: (k: (typeof byWeek)[number]) => number): number =>
      byWeek.reduce((acc, k) => acc + pick(k), 0)
    expect(sum((k) => k.costUsd)).toBeCloseTo(total.costUsd)
    expect(sum((k) => k.co2Kg)).toBeCloseTo(total.co2Kg)
    expect(sum((k) => k.supplyUnits)).toBeCloseTo(total.supplyUnits)
    expect(sum((k) => k.demandUnits)).toBeCloseTo(total.demandUnits)
    expect(sum((k) => k.overloadedCells)).toBe(total.overloadedCells)
    expect(sum((k) => k.underloadedCells)).toBe(total.underloadedCells)
  })

  it('carries capex on the aggregate only, so a weekly chart cannot multiply it', () => {
    const snap = snapshot()
    const { idx, load } = model(snap)
    const byWeek = summariseByWeek(load, snap, idx, filters())
    for (const week of byWeek) expect(week.capexUsd).toBe(0)
  })
})
