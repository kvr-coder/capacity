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
  ScenarioMove,
  Snapshot,
  StandardOperation,
  WorkCenter,
} from '@/domain/types'
import {
  BASELINE_SCENARIO_ID,
  baselineScenario,
  defaultFilters,
  runModel,
  runModelWithContext,
} from '@/domain/engine'
import { rankBottlenecks } from '@/domain/relief'
import { buildTimeGrid } from '@/domain/time'
import { at } from '@/domain/lookup'

const WEEKS = 4

function pools(hoursPerWeek: number): PoolCapacity[] {
  return [
    { pool: 'machine', count: 1, shiftsPerDay: 1, hoursPerShift: hoursPerWeek, daysPerWeek: 1, utilisationFactor: 1 },
    { pool: 'labour', count: 1, shiftsPerDay: 1, hoursPerShift: hoursPerWeek, daysPerWeek: 1, utilisationFactor: 1 },
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
    fxPerUsd: 4,
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
    fxPerUsd: 7,
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
  {
    id: 'CLASS-A',
    name: 'Alpha',
    supplier: 'Acme',
    generation: 3,
    baseFeatures: ['F-A'],
    retrofits: [
      {
        id: 'RET-A',
        name: 'Second head',
        addsFeatures: ['F-B'],
        capexUsd: 400_000,
        leadTimeWeeks: 5,
        oeeDelta: 0.1,
        description: '',
      },
    ],
  },
]

function wc(id: string, plantId: string, hoursPerWeek: number): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: `${id} line`,
    classId: 'CLASS-A',
    vintage: 2015,
    pools: pools(hoursPerWeek),
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

function material(id: string, groupId: string, type: Material['type'], plantIds: string[]): Material {
  return {
    id,
    code: `${id}-CODE`,
    description: id,
    type,
    groupId,
    familyId: 'FAM-1',
    baseUom: 'EA',
    plantIds,
    pricePerUnitUsd: 10,
    materialCostPerUnitUsd: 4,
    abcClass: 'A',
    unitsPerHandlingUnit: 100,
    weightKgPerUnit: 1,
  }
}

function matrix(rows: Array<[string, number]>): PlanMatrix {
  const rowKeys = rows.map(([k]) => k)
  const values = new Float64Array(rowKeys.length * WEEKS)
  rows.forEach(([, perWeek], r) => {
    for (let w = 0; w < WEEKS; w += 1) values[r * WEEKS + w] = perWeek
  })
  return { rowKeys, weekCount: WEEKS, values }
}

function snapshot(): Snapshot {
  const routings: Routing[] = [
    { id: 'R1', materialId: 'M1', plantId: 'P1', version: '0001', primary: true, operations: [op('WC1')] },
    { id: 'R1B', materialId: 'M1', plantId: 'P1', version: '0002', primary: false, operations: [op('WC2')] },
    { id: 'R2', materialId: 'M2', plantId: 'P1', version: '0001', primary: true, operations: [op('WC1')] },
    { id: 'R3', materialId: 'M3', plantId: 'P1', version: '0001', primary: true, operations: [op('WC2')] },
    { id: 'R4', materialId: 'M3', plantId: 'P2', version: '0001', primary: true, operations: [op('WC3')] },
  ]
  return {
    meta: { profile: 'test', generatedBy: 'factory', seed: 7, skuCount: 3, workCenterCount: 3, weekCount: WEEKS },
    time: buildTimeGrid('2026-01-05', WEEKS),
    plants: PLANTS,
    features: [
      { id: 'F-A', name: 'Forming', group: 'process', description: '' },
      { id: 'F-B', name: 'Second head', group: 'process', description: '' },
    ],
    machineClasses: CLASSES,
    workCenters: [wc('WC1', 'P1', 10), wc('WC2', 'P1', 20), wc('WC3', 'P2', 20)],
    standardOperations: STD_OPS,
    families: [{ id: 'FAM-1', code: 'F1', name: 'Enclosures' }],
    groups: [
      { id: 'G1', familyId: 'FAM-1', code: 'G1', name: 'Housings' },
      { id: 'G2', familyId: 'FAM-1', code: 'G2', name: 'Brackets' },
    ],
    materials: [
      material('M1', 'G1', 'FERT', ['P1']),
      material('M2', 'G2', 'FERT', ['P1']),
      material('M3', 'G1', 'HALB', ['P1', 'P2']),
    ],
    routings,
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [],
    supplyPlan: matrix([
      ['M1|P1', 2], // 4 machine hours a week at WC1
      ['M2|P1', 1], // 2 more
      ['M3|P1', 3], // 6 hours a week at WC2
      ['M3|P2', 1], // 2 hours a week at WC3
    ]),
    demandPlan: matrix([
      ['M1|EUR', 3],
      ['M2|EUR', 1],
      ['M3|APAC', 1],
    ]),
    inventory: [],
  }
}

function scenario(moves: ScenarioMove[]): Scenario {
  return { id: 'S1', name: 'What if', description: '', moves, colorSlot: 3 }
}

function entry(id: string, seq: number, move: ScenarioMove['move'], enabled = true): ScenarioMove {
  return { id, label: id, enabled, seq, move }
}

function allWeeks(over: Partial<Filters> = {}): Filters {
  return { ...defaultFilters(snapshot()), ...over }
}

// ---------------------------------------------------------------------------

describe('baselineScenario', () => {
  it('is the empty, readonly, frozen baseline', () => {
    const baseline = baselineScenario()
    expect(baseline.id).toBe(BASELINE_SCENARIO_ID)
    expect(baseline.moves).toEqual([])
    expect(baseline.readonly).toBe(true)
    expect(Object.isFrozen(baseline)).toBe(true)
    expect(Object.isFrozen(baseline.moves)).toBe(true)
    // Two calls are independent objects, so one screen cannot poison another.
    expect(baselineScenario()).not.toBe(baseline)
  })
})

describe('defaultFilters', () => {
  it('covers the whole horizon and every entity', () => {
    const filters = defaultFilters(snapshot())
    expect(filters.fromWeek).toBe(0)
    expect(filters.toWeek).toBe(WEEKS - 1)
    expect(filters.plantIds).toEqual([])
    expect(filters.bucket).toBe('week')
  })
})

describe('runModel — end to end', () => {
  it('produces totals that agree with the grids they came from', () => {
    const snap = snapshot()
    const result = runModel(snap, baselineScenario(), allWeeks())

    // WC1 carries 6 machine hours a week, WC2 6, WC3 2 -> 14 a week, 56 total.
    const machineRequired = result.grids.machine.requiredHours.reduce((a, b) => a + b, 0)
    expect(machineRequired).toBeCloseTo(56)
    expect(result.kpis.requiredHours).toBeCloseTo(56)
    // 10 + 20 + 20 hours a week, four weeks.
    expect(result.kpis.availableHours).toBeCloseTo(200)
    expect(result.kpis.utilisation).toBeCloseTo(56 / 200)
    expect(result.kpis.utilisation).toBeCloseTo(result.kpis.requiredHours / result.kpis.availableHours)

    expect(result.cells).toHaveLength(3 * WEEKS)
    expect(result.oeeByWorkCenterWeek).toHaveLength(3 * WEEKS)
    expect(result.time.weeks).toHaveLength(WEEKS)
    expect(result.scenarioId).toBe(BASELINE_SCENARIO_ID)
    expect(result.warnings).toEqual([])
  })

  it('agrees with the per-week series and with rankBottlenecks', () => {
    const snap = snapshot()
    const result = runModel(snap, baselineScenario(), allWeeks())
    const summed = result.kpisByWeek.reduce((acc, k) => acc + k.costUsd, 0)
    expect(summed).toBeCloseTo(result.kpis.costUsd)
    expect(result.kpisByWeek).toHaveLength(WEEKS)

    const context = runModelWithContext(snap, baselineScenario(), allWeeks())
    expect(result.bottlenecks).toEqual(
      rankBottlenecks(context.snapshot, context.indexes, context.load, allWeeks()),
    )
  })

  it('never touches the snapshot it was handed', () => {
    const snap = snapshot()
    const before = structuredClone(snap)
    runModel(
      snap,
      scenario([
        entry('a', 1, {
          kind: 'planScale',
          plan: 'supply',
          selector: { kind: 'all' },
          fromWeek: 0,
          toWeek: 3,
          factor: 2,
        }),
        entry('b', 2, { kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-A', availableFromWeek: 1 }),
      ]),
      allWeeks(),
    )
    expect(snap).toEqual(before)
  })

  it('is deterministic: the same inputs give the same result twice', () => {
    const snap = snapshot()
    const filters = allWeeks()
    expect(runModel(snap, baselineScenario(), filters)).toEqual(
      runModel(snap, baselineScenario(), filters),
    )
  })

  it('reports runtimeMs from the clock it is given, and 0 from the pure default', () => {
    const snap = snapshot()
    expect(runModel(snap, baselineScenario(), allWeeks()).runtimeMs).toBe(0)

    let tick = 100
    const result = runModel(snap, baselineScenario(), allWeeks(), {
      now: () => {
        tick += 7
        return tick
      },
    })
    expect(result.runtimeMs).toBe(7)
  })

  it('drops the judged cells when only aggregates are wanted', () => {
    const snap = snapshot()
    const result = runModel(snap, baselineScenario(), allWeeks(), { aggregatesOnly: true })
    expect(result.cells).toEqual([])
    // The grids the cells were derived from are still there.
    expect(result.grids.machine.requiredHours.reduce((a, b) => a + b, 0)).toBeCloseTo(56)
  })
})

describe('runModel — moves reach the numbers', () => {
  it('scales the plan', () => {
    const snap = snapshot()
    const doubled = runModel(
      snap,
      scenario([
        entry('a', 1, {
          kind: 'planScale',
          plan: 'supply',
          selector: { kind: 'all' },
          fromWeek: 0,
          toWeek: WEEKS - 1,
          factor: 2,
        }),
      ]),
      allWeeks(),
    )
    expect(doubled.kpis.requiredHours).toBeCloseTo(112)
    expect(doubled.kpis.supplyUnits).toBeCloseTo(56)
  })

  it('turns a ceiling into overload without changing a single available hour', () => {
    const snap = snapshot()
    const base = runModel(snap, baselineScenario(), allWeeks())
    const capped = runModel(
      snap,
      scenario([entry('c', 1, { kind: 'utilisationCeiling', scope: 'workCenter', workCenterId: 'WC1', ceiling: 0.5 })]),
      allWeeks(),
    )
    expect(base.kpis.overloadHours).toBe(0)
    // WC1: 6 hours required against 10 x 0.5 planable -> 1 hour over, four weeks.
    expect(capped.kpis.overloadedCells).toBe(WEEKS)
    expect(capped.bottlenecks.map((b) => b.workCenterId)).toEqual(['WC1'])
    expect(at(capped.bottlenecks, 0, 'bottleneck').severity).toBe('critical')
  })

  it('books capex from a retrofit and lifts the OEE from the week it lands', () => {
    const snap = snapshot()
    const result = runModel(
      snap,
      scenario([entry('r', 1, { kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-A', availableFromWeek: 2 })]),
      allWeeks(),
    )
    expect(result.capexUsd).toBe(400_000)
    expect(result.kpis.capexUsd).toBe(400_000)
    // Row 0 is WC1. Weeks 0 and 1 at 0.5, weeks 2 and 3 at 0.6.
    expect(result.oeeByWorkCenterWeek[0]).toBeCloseTo(0.5)
    expect(result.oeeByWorkCenterWeek[2]).toBeCloseTo(0.6)
    // A better machine needs fewer hours for the same units.
    expect(result.kpis.requiredHours).toBeLessThan(56)
  })

  it('lets a shift change in a window move capacity, and says so when it cannot', () => {
    const snap = snapshot()
    const cut = runModel(
      snap,
      scenario([
        entry('s', 1, {
          kind: 'shiftChange',
          workCenterId: 'WC1',
          pool: 'machine',
          fromWeek: 1,
          toWeek: 2,
          hoursPerShift: 4, // 10h/week -> 4h/week for two weeks
        }),
      ]),
      allWeeks(),
    )
    // 6 hours a week gone for two weeks: the machine pool drops from 200 to 188
    // and becomes the binding pool, while labour keeps all 200.
    expect(cut.kpis.availableHours).toBeCloseTo(188)
    expect(cut.kpis.downtimeHours).toBeCloseTo(12)
    expect(runModel(snap, baselineScenario(), allWeeks()).kpis.availableHours).toBeCloseTo(200)
  })

  it('collects warnings from moves, sourcing and the load explosion', () => {
    const snap = snapshot()
    const result = runModel(
      snap,
      scenario([
        entry('bad', 1, {
          kind: 'resourceMove',
          selector: { kind: 'all' },
          fromWorkCenterId: 'WC1',
          toWorkCenterId: 'WC404',
          fromWeek: 0,
          toWeek: 3,
          share: 1,
          allowDualSource: false,
        }),
        entry('wip', 2, {
          kind: 'wipTransfer',
          materialId: 'M3',
          fromPlantId: 'P1',
          toPlantId: 'P2',
          fromWeek: 1,
          toWeek: 3,
          share: 0.5,
          freightCostPerUnitUsd: 3,
          transitWeeks: 1,
        }),
      ]),
      allWeeks(),
    )
    const text = result.warnings.join('\n')
    expect(text).toContain('WC404')
    expect(text).toContain('freight')
    // The illegal move was switched off, so sourcing never acted on it.
    expect(text).not.toContain('rejected: target work center')
  })

  it('routes an approved resourceMove through sourcing and off the saturated asset', () => {
    const snap = snapshot()
    const base = runModel(snap, baselineScenario(), allWeeks())
    const moved = runModel(
      snap,
      scenario([
        entry('m', 1, {
          kind: 'resourceMove',
          selector: { kind: 'material', id: 'M1' },
          fromWorkCenterId: 'WC1',
          toWorkCenterId: 'WC2',
          fromWeek: 0,
          toWeek: WEEKS - 1,
          share: 1,
          allowDualSource: false,
        }),
      ]),
      allWeeks(),
    )
    const hoursAt = (result: typeof base, workCenterId: string): number => {
      const row = result.grids.machine.workCenterIds.indexOf(workCenterId)
      let total = 0
      for (let w = 0; w < WEEKS; w += 1) total += result.grids.machine.requiredHours[row * WEEKS + w] ?? 0
      return total
    }
    expect(hoursAt(base, 'WC1')).toBeCloseTo(24)
    expect(hoursAt(moved, 'WC1')).toBeCloseTo(8) // only M2 left
    expect(hoursAt(moved, 'WC2')).toBeCloseTo(40) // M3 plus the arriving M1
    // Nothing was created or destroyed: the network total is unchanged.
    expect(moved.kpis.requiredHours).toBeCloseTo(base.kpis.requiredHours)
  })
})

describe('runModelWithContext', () => {
  it('hands back the intermediates alongside the identical result', () => {
    const snap = snapshot()
    const filters = allWeeks()
    const context = runModelWithContext(snap, baselineScenario(), filters)
    expect(context.result).toEqual(runModel(snap, baselineScenario(), filters))
    expect(context.snapshot).toBe(snap) // no move touched anything
    expect(context.indexes.workCenterOrder).toEqual(['WC1', 'WC2', 'WC3'])
    expect(context.load.cells).toHaveLength(3 * WEEKS)
    expect(context.sourcing.dualSourced.size).toBe(0)
    expect(context.freightUsd).toBe(0)
  })
})
