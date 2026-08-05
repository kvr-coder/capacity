import { describe, expect, it } from 'vitest'
import { buildLoad } from '@/domain/load'
import { buildCapacity, buildCeilings } from '@/domain/capacity'
import { resolveSourcing } from '@/domain/sourcing'
import type { SourcingPlan } from '@/domain/sourcing'
import { buildIndexes } from '@/domain/indexes'
import { buildOeeGrid } from '@/domain/oee'
import { key } from '@/domain/lookup'
import type {
  DowntimeEvent,
  Material,
  OeeOverride,
  Plant,
  PoolCapacity,
  Routing,
  RoutingOperation,
  Scenario,
  Snapshot,
  TimeGrid,
  WorkCenter,
} from '@/domain/types'

// Small explicit fixtures — at most 2 work centers, 2 materials, 4 weeks — so
// every expected number below is derived in the test, never inherited from the
// data generator.

const WEEKS = 4

function timeGrid(n: number): TimeGrid {
  const weeks: string[] = []
  const weekStart: string[] = []
  const monthOfWeek: string[] = []
  const quarterOfWeek: string[] = []
  for (let i = 0; i < n; i++) {
    weeks.push(`2026-W${String(i + 1).padStart(2, '0')}`)
    weekStart.push(`2026-01-${String(5 + i * 7).padStart(2, '0')}`)
    monthOfWeek.push('2026-01')
    quarterOfWeek.push('2026-Q1')
  }
  return { weeks, weekStart, monthOfWeek, quarterOfWeek, months: ['2026-01'], quarters: ['2026-Q1'] }
}

/**
 * The OEE every fixture runs at. Deliberately not 1.0: the OEE cascade clamps
 * to OEE_MIN..OEE_MAX (0.98), so a fixture at 1.0 would silently resolve to
 * 0.98 and every expected number below would be wrong by 1/0.98.
 */
const OEE = 0.8

function plant(defaultOee = OEE): Plant {
  return {
    id: 'P1',
    code: 'P1',
    name: 'Plant 1',
    city: 'City',
    country: 'Country',
    countryCode: 'XX',
    region: 'EUR',
    currency: 'EUR',
    fxPerUsd: 1,
    timezone: 'UTC',
    lat: 0,
    lon: 0,
    colorSlot: 1,
    labourCostPerHourLocal: 40,
    defaultOee,
    gridIntensity: 0.3,
  }
}

function pools(machineHours: number, labourHours: number): PoolCapacity[] {
  // count x 1 shift x hoursPerShift x 1 day x 1.0 — the arithmetic is tested in
  // capacity.test.ts, so here the pools are simply dialled to a round total.
  return [
    { pool: 'machine', count: 1, shiftsPerDay: 1, hoursPerShift: machineHours, daysPerWeek: 1, utilisationFactor: 1 },
    { pool: 'labour', count: 1, shiftsPerDay: 1, hoursPerShift: labourHours, daysPerWeek: 1, utilisationFactor: 1 },
  ]
}

function workCenter(id: string, machineHours: number, labourHours: number, baseOee = OEE): WorkCenter {
  return {
    id,
    plantId: 'P1',
    code: id,
    name: id,
    classId: 'C1',
    vintage: 2015,
    pools: pools(machineHours, labourHours),
    features: [],
    baseOee,
    status: 'active',
    costRateUsdPerHour: 80,
    co2PerMachineHourKg: 5,
  }
}

function material(id: string): Material {
  return {
    id,
    code: id,
    description: id,
    type: 'FERT',
    groupId: 'G1',
    familyId: 'F1',
    baseUom: 'EA',
    plantIds: ['P1'],
    pricePerUnitUsd: 10,
    materialCostPerUnitUsd: 4,
    abcClass: 'A',
    unitsPerHandlingUnit: 100,
    weightKgPerUnit: 1,
  }
}

function op(
  seq: number,
  opId: string,
  workCenterId: string,
  machineHoursPerBase: number,
  labourHoursPerBase: number,
  yieldValue: number,
  setupHours: number,
): RoutingOperation {
  return {
    seq,
    opId,
    workCenterId,
    baseQty: 1,
    setupHours,
    machineHoursPerBase,
    labourHoursPerBase,
    yield: yieldValue,
  }
}

function routing(id: string, materialId: string, operations: RoutingOperation[]): Routing {
  return { id, materialId, plantId: 'P1', version: '0001', primary: true, operations }
}

interface Spec {
  workCenters: WorkCenter[]
  materials: Material[]
  routings: Routing[]
  rowKeys: string[]
  supply: number[][]
  oeeOverrides?: OeeOverride[]
  defaultOee?: number
  downtime?: DowntimeEvent[]
}

function snapshot(spec: Spec): Snapshot {
  const values = new Float64Array(spec.rowKeys.length * WEEKS)
  for (let r = 0; r < spec.supply.length; r++) {
    const row = spec.supply[r] ?? []
    for (let w = 0; w < WEEKS; w++) values[r * WEEKS + w] = row[w] ?? 0
  }
  return {
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: spec.materials.length,
      workCenterCount: spec.workCenters.length,
      weekCount: WEEKS,
    },
    time: timeGrid(WEEKS),
    plants: [plant(spec.defaultOee ?? OEE)],
    features: [],
    machineClasses: [],
    workCenters: spec.workCenters,
    standardOperations: [],
    families: [{ id: 'F1', code: 'F1', name: 'Family 1' }],
    groups: [{ id: 'G1', familyId: 'F1', code: 'G1', name: 'Group 1' }],
    materials: spec.materials,
    routings: spec.routings,
    rateOverrides: [],
    oeeOverrides: spec.oeeOverrides ?? [],
    glidePaths: [],
    downtime: spec.downtime ?? [],
    supplyPlan: { rowKeys: spec.rowKeys, weekCount: WEEKS, values },
    demandPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    inventory: [],
  }
}

const EMPTY_SCENARIO: Scenario = { id: 'baseline', name: 'Baseline', description: '', moves: [], colorSlot: 1 }

function runLoad(spec: Spec, options?: { ceiling?: number; sourcing?: (snap: Snapshot) => SourcingPlan }) {
  const snap = snapshot(spec)
  const idx = buildIndexes(snap)
  const capacity = buildCapacity(snap, idx)
  const oeeGrid = buildOeeGrid(snap, idx)
  const sourcing = options?.sourcing ? options.sourcing(snap) : resolveSourcing(snap, idx, EMPTY_SCENARIO)
  const ceilings = buildCeilings(EMPTY_SCENARIO, options?.ceiling ?? 1)
  const load = buildLoad(snap, idx, sourcing, capacity, oeeGrid, ceilings)

  const rowOf = (wcId: string): number => idx.workCenterRow.get(wcId) ?? -1
  const machine = (wcId: string, week: number): number =>
    load.grids.machine.requiredHours[rowOf(wcId) * WEEKS + week] ?? Number.NaN
  const labour = (wcId: string, week: number): number =>
    load.grids.labour.requiredHours[rowOf(wcId) * WEEKS + week] ?? Number.NaN
  const setup = (wcId: string, week: number): number =>
    load.grids.machine.setupHours[rowOf(wcId) * WEEKS + week] ?? Number.NaN
  const cell = (wcId: string, week: number) =>
    load.cells.find((c) => c.workCenterId === wcId && c.week === week)
  return { snap, idx, load, machine, labour, setup, cell }
}

// ---------------------------------------------------------------------------
// Fixture A — yield compounds upstream through a three-operation routing.
//
// Times below are NOMINAL (per base quantity of 1). OEE is applied to the
// rate, so effective hours per unit are nominal / OEE. The nominal figures are
// chosen so that at OEE 0.8 the effective hours land on round numbers:
//
//   op10 WC-1  0.40 -> 0.50 machine h,  0.20 -> 0.25 labour h  yield 0.90 setup 2
//   op20 WC-2  0.20 -> 0.25            ,  0.80 -> 1.00         yield 0.80 setup 1
//   op30 WC-1  0.08 -> 0.10            ,  0.04 -> 0.05         yield 0.50 setup 3
//
// 100 good units out of op30 means:
//   op30 must start 100 / 0.5              = 200
//   op20 must start 200 / 0.8              = 250
//   op10 must start 250 / 0.9              = 277.7…  (= 100 / 0.36)
// ---------------------------------------------------------------------------

const FIXTURE_A: Spec = {
  workCenters: [workCenter('WC-1', 40, 40), workCenter('WC-2', 200, 100)],
  materials: [material('M1')],
  routings: [
    routing('R1', 'M1', [
      op(10, 'OP-A', 'WC-1', 0.5 * OEE, 0.25 * OEE, 0.9, 2),
      op(20, 'OP-B', 'WC-2', 0.25 * OEE, 1.0 * OEE, 0.8, 1),
      op(30, 'OP-C', 'WC-1', 0.1 * OEE, 0.05 * OEE, 0.5, 3),
    ]),
  ],
  rowKeys: ['M1|P1'],
  supply: [[100, 0, 0, 0]],
}

const GROSS_OP30 = 100 / 0.5
const GROSS_OP20 = 100 / (0.8 * 0.5)
const GROSS_OP10 = 100 / (0.9 * 0.8 * 0.5)

describe('buildLoad — yield compounds upstream', () => {
  it('inflates each operation by the product of the yields downstream of it', () => {
    const { machine, labour } = runLoad(FIXTURE_A)
    expect(GROSS_OP30).toBe(200)
    expect(GROSS_OP20).toBe(250)
    expect(GROSS_OP10).toBeCloseTo(277.77777777777777, 10)

    // WC-1 carries op10 and op30, plus one setup charge.
    expect(machine('WC-1', 0)).toBeCloseTo(GROSS_OP10 * 0.5 + GROSS_OP30 * 0.1 + 2, 10)
    expect(labour('WC-1', 0)).toBeCloseTo(GROSS_OP10 * 0.25 + GROSS_OP30 * 0.05 + 2, 10)
    // WC-2 carries op20 alone.
    expect(machine('WC-2', 0)).toBeCloseTo(GROSS_OP20 * 0.25 + 1, 10)
    expect(labour('WC-2', 0)).toBeCloseTo(GROSS_OP20 * 1.0 + 1, 10)
  })

  it('loads nothing in weeks with no supply', () => {
    const { machine } = runLoad(FIXTURE_A)
    for (let w = 1; w < WEEKS; w++) {
      expect(machine('WC-1', w)).toBe(0)
      expect(machine('WC-2', w)).toBe(0)
    }
  })

  it('a yield of 1 throughout leaves the gross quantity equal to the plan', () => {
    const { machine } = runLoad({
      ...FIXTURE_A,
      routings: [
        routing('R1', 'M1', [
          op(10, 'OP-A', 'WC-1', 0.5 * OEE, 0, 1, 0),
          op(20, 'OP-B', 'WC-2', 0.25 * OEE, 0, 1, 0),
        ]),
      ],
    })
    expect(machine('WC-1', 0)).toBeCloseTo(50, 10)
    expect(machine('WC-2', 0)).toBeCloseTo(25, 10)
  })
})

describe('buildLoad — setup is a lot cost', () => {
  it('charges setup once per work center, material and week, not per operation visit', () => {
    const { setup, load, idx } = runLoad(FIXTURE_A)
    // WC-1 is visited by op10 (setup 2) and op30 (setup 3). Only the first is charged.
    expect(setup('WC-1', 0)).toBe(2)
    expect(setup('WC-2', 0)).toBe(1)
    const row = idx.workCenterRow.get('WC-1') ?? -1
    expect(load.grids.labour.setupHours[row * WEEKS] ?? -1).toBe(2)
  })

  it('charges setup per material, so two materials on one work center pay twice', () => {
    const { machine, setup } = runLoad({
      workCenters: [workCenter('WC-1', 40, 40)],
      materials: [material('M1'), material('M2')],
      routings: [
        routing('R1', 'M1', [op(10, 'OP-A', 'WC-1', 0.5 * OEE, 0, 1, 2)]),
        routing('R2', 'M2', [op(10, 'OP-A', 'WC-1', 0.5 * OEE, 0, 1, 2)]),
      ],
      rowKeys: ['M1|P1', 'M2|P1'],
      supply: [
        [100, 0, 0, 0],
        [100, 0, 0, 0],
      ],
    })
    expect(setup('WC-1', 0)).toBe(4)
    expect(machine('WC-1', 0)).toBeCloseTo(50 + 2 + 50 + 2, 10)
  })

  it('charges setup once across both sources of a dual-sourced bucket', () => {
    // Both production versions run on WC-1 in week 0, at 50% each. One lot,
    // one changeover.
    const spec: Spec = {
      workCenters: [workCenter('WC-1', 400, 400)],
      materials: [material('M1')],
      routings: [
        routing('R1', 'M1', [op(10, 'OP-A', 'WC-1', 0.5 * OEE, 0, 1, 3)]),
        {
          // A DIFFERENT opId: two versions carrying the same opId at the same
          // work center are an alternate-version substitution in rates.ts, not
          // two sources, and that is a different thing under test.
          ...routing('R2', 'M1', [op(10, 'OP-B', 'WC-1', 0.25 * OEE, 0, 1, 3)]),
          primary: false,
          version: '0002',
        },
      ],
      rowKeys: ['M1|P1'],
      supply: [[100, 0, 0, 0]],
    }
    const { machine, setup, load } = runLoad(spec, {
      sourcing: (): SourcingPlan => {
        const routingOfRow = new Int32Array(WEEKS * 2).fill(-1)
        const shareOfRow = new Float64Array(WEEKS * 2)
        routingOfRow[0] = 0
        shareOfRow[0] = 0.5
        routingOfRow[WEEKS] = 1
        shareOfRow[WEEKS] = 0.5
        return { routingOfRow, shareOfRow, dualSourced: new Set(['M1|P1']), warnings: [] }
      },
    })
    expect(setup('WC-1', 0)).toBe(3)
    // 50 units at 0.5 h + 50 units at 0.25 h + one setup.
    expect(machine('WC-1', 0)).toBeCloseTo(25 + 12.5 + 3, 10)
    expect(load.unitsByRow[0] ?? -1).toBeCloseTo(100, 10)
  })
})

describe('buildLoad — the binding pool is the capex-or-hiring answer', () => {
  it('picks labour where labour saturates first and machine where machine does', () => {
    const { cell } = runLoad(FIXTURE_A)
    const wc1 = cell('WC-1', 0)
    const wc2 = cell('WC-2', 0)
    expect(wc1).toBeDefined()
    expect(wc2).toBeDefined()
    if (!wc1 || !wc2) return

    // WC-1: 160.9 machine hours against 40, versus 81.4 labour hours against 40.
    expect(wc1.bindingPool).toBe('machine')
    expect(wc1.utilisation).toBeCloseTo(wc1.machineRequired / 40, 10)

    // WC-2: 63.5 machine hours against 200, versus 251 labour hours against 100.
    expect(wc2.bindingPool).toBe('labour')
    expect(wc2.machineRequired / 200).toBeLessThan(1)
    expect(wc2.utilisation).toBeCloseTo(251 / 100, 10)
    expect(wc2.overloadHours).toBeCloseTo(251 - 100, 10)
  })

  it('reports both pools on the cell so the UI can show the one that did not bind', () => {
    const { cell } = runLoad(FIXTURE_A)
    const wc2 = cell('WC-2', 0)
    expect(wc2?.machineAvailable).toBe(200)
    expect(wc2?.labourAvailable).toBe(100)
    expect(wc2?.labourRequired).toBeCloseTo(251, 10)
  })

  /**
   * REGRESSION. A pool with work to do and NO hours at all is the hardest
   * constraint there is. `safeDiv` reports a zero denominator as 0, so ranking
   * the two pools by their ratios alone put such a pool BELOW every pool that
   * had hours — and the cell then reported the other pool as binding, with its
   * overload (usually zero) and its shortfall (usually zero). Blocking a pool
   * outright made a work center look emptier, not fuller.
   */
  describe('a pool with hours required and none available', () => {
    // 100 units, 1 nominal labour hour each at OEE 0.8 -> 125 labour hours.
    // Machine has plenty. Labour is switched off in week 0 by a vacation.
    const SPEC: Spec = {
      workCenters: [workCenter('WC-V', 1000, 100)],
      materials: [material('M1')],
      routings: [routing('R1', 'M1', [op(10, 'OP-A', 'WC-V', 0.1 * OEE, 1 * OEE, 1, 0)])],
      rowKeys: ['M1|P1'],
      supply: [[100, 100, 0, 0]],
      downtime: [
        {
          id: 'VAC',
          workCenterId: 'WC-V',
          kind: 'shutdown',
          status: 'confirmed',
          fromWeek: 0,
          toWeek: 0,
          pools: ['labour'],
          label: 'Collective vacation',
        },
      ],
    }

    it('binds on the empty pool rather than on the one that still has hours', () => {
      const { cell } = runLoad(SPEC)
      const blocked = cell('WC-V', 0)
      const normal = cell('WC-V', 1)
      expect(blocked?.labourAvailable).toBe(0)
      expect(blocked?.labourRequired).toBeCloseTo(100, 10)
      expect(blocked?.bindingPool).toBe('labour')
      // Week 1 has the same volume and a working labour pool, so the two cells
      // differ only in whether the hours exist.
      expect(normal?.bindingPool).toBe('labour')
      expect(normal?.overloadHours).toBe(0)
    })

    it('reports the whole requirement as overload and the whole volume as shortfall', () => {
      const { cell } = runLoad(SPEC)
      const blocked = cell('WC-V', 0)
      expect(blocked?.overloadHours).toBeCloseTo(100, 10)
      // Every unit the plan wanted that week is unmakeable.
      expect(blocked?.shortfallUnits).toBeCloseTo(100, 10)
    })

    it('names it in the warnings rather than passing it off as an ordinary week', () => {
      const { load } = runLoad(SPEC)
      expect(load.warnings.join(' ')).toContain('offers no hours at all that week')
    })

    it('still ranks by hours when BOTH pools are empty and both carry load', () => {
      const { cell } = runLoad({
        ...SPEC,
        downtime: [
          {
            id: 'INST',
            workCenterId: 'WC-V',
            kind: 'installation',
            status: 'confirmed',
            fromWeek: 0,
            toWeek: 0,
            pools: ['machine', 'labour'],
            label: 'Commissioning',
          },
        ],
      })
      const blocked = cell('WC-V', 0)
      // 100 labour hours against 10 machine hours: labour is the bigger loss.
      expect(blocked?.bindingPool).toBe('labour')
      expect(blocked?.overloadHours).toBeCloseTo(100, 10)
    })
  })
})

// ---------------------------------------------------------------------------
// Fixture B — one work center, one operation, no yield loss and no setup, so
// the rate is exactly 1 / 0.5 = 2 eaches per hour.
// ---------------------------------------------------------------------------

const FIXTURE_B: Spec = {
  workCenters: [workCenter('WC-A', 40, 0)],
  materials: [material('M1')],
  routings: [routing('R1', 'M1', [op(10, 'OP-A', 'WC-A', 0.5 * OEE, 0, 1, 0)])],
  rowKeys: ['M1|P1'],
  supply: [[100, 0, 0, 0]],
}

describe('buildLoad — shortfall converts overload hours back to eaches', () => {
  it('uses the rate the work center actually achieves that week', () => {
    const { cell, machine } = runLoad(FIXTURE_B)
    expect(machine('WC-A', 0)).toBeCloseTo(50, 10)
    const c = cell('WC-A', 0)
    expect(c?.bindingPool).toBe('machine')
    expect(c?.overloadHours).toBeCloseTo(10, 10) // 50 required, 40 available
    // 100 units placed over 50 hours = 2 eaches/hour; 10 overloaded hours = 20 eaches.
    expect(c?.shortfallUnits).toBeCloseTo(20, 10)
  })

  it('applies the ceiling before judging overload', () => {
    const { cell } = runLoad(FIXTURE_B, { ceiling: 0.8 })
    const c = cell('WC-A', 0)
    expect(c?.ceiling).toBe(0.8)
    expect(c?.utilisation).toBeCloseTo(50 / 32, 10)
    expect(c?.overloadHours).toBeCloseTo(18, 10) // 50 against 40 x 0.8
    expect(c?.shortfallUnits).toBeCloseTo(36, 10)
  })

  it('halves the rate when OEE halves, doubling the hours and the shortfall', () => {
    const { machine, cell } = runLoad({
      ...FIXTURE_B,
      workCenters: [workCenter('WC-A', 40, 0, OEE / 2)],
    })
    // 0.4 nominal h / 0.4 OEE = 1 h per unit, against 0.5 h at the base OEE.
    expect(machine('WC-A', 0)).toBeCloseTo(100, 10)
    const c = cell('WC-A', 0)
    expect(c?.oee).toBe(OEE / 2)
    expect(c?.overloadHours).toBeCloseTo(60, 10)
    // 100 units over 100 hours = 1 each/hour.
    expect(c?.shortfallUnits).toBeCloseTo(60, 10)
  })

  it('honours a material-specific OEE override on top of the work-center grid', () => {
    const { machine } = runLoad({
      ...FIXTURE_B,
      oeeOverrides: [
        { scope: 'materialWorkCenter', materialId: 'M1', workCenterId: 'WC-A', value: 0.2 },
      ],
    })
    // 0.4 nominal h / 0.2 = 2 h per unit.
    expect(machine('WC-A', 0)).toBeCloseTo(200, 10)
  })

  it('reports no overload and no shortfall when the plan fits', () => {
    const { cell } = runLoad({ ...FIXTURE_B, supply: [[40, 0, 0, 0]] })
    const c = cell('WC-A', 0)
    expect(c?.utilisation).toBeCloseTo(0.5, 10)
    expect(c?.overloadHours).toBe(0)
    expect(c?.shortfallUnits).toBe(0)
  })
})

describe('buildLoad — outputs', () => {
  it('emits one cell per work center per week', () => {
    const { load } = runLoad(FIXTURE_A)
    expect(load.cells.length).toBe(2 * WEEKS)
  })

  it('exposes available and downtime hours straight from the capacity grids', () => {
    const { load, idx } = runLoad(FIXTURE_A)
    const row = idx.workCenterRow.get('WC-2') ?? -1
    expect(load.grids.machine.availableHours[row * WEEKS] ?? -1).toBe(200)
    expect(load.grids.labour.availableHours[row * WEEKS] ?? -1).toBe(100)
    expect(load.grids.machine.weekCount).toBe(WEEKS)
    expect(load.grids.machine.workCenterIds).toEqual(['WC-1', 'WC-2'])
  })

  it('accumulates hours by work center and product group for the composition charts', () => {
    const { load, machine } = runLoad(FIXTURE_A)
    const wc1 = load.hoursByGroup.get(key('WC-1', 'G1'))
    const wc2 = load.hoursByGroup.get(key('WC-2', 'G1'))
    expect(wc1?.length).toBe(WEEKS)
    expect(wc1?.[0] ?? -1).toBeCloseTo(machine('WC-1', 0), 10)
    expect(wc2?.[0] ?? -1).toBeCloseTo(machine('WC-2', 0), 10)
  })

  it('records the units actually placed per supply row and week', () => {
    const { load } = runLoad({ ...FIXTURE_B, supply: [[100, 0, 25, 0]] })
    expect(load.unitsByRow[0] ?? -1).toBe(100)
    expect(load.unitsByRow[1] ?? -1).toBe(0)
    expect(load.unitsByRow[2] ?? -1).toBe(25)
  })

  it('reports the overloaded pool grid separately from the binding-pool cell', () => {
    const { load, idx } = runLoad(FIXTURE_A)
    const row = idx.workCenterRow.get('WC-2') ?? -1
    expect(load.grids.machine.overloadHours[row * WEEKS] ?? -1).toBe(0)
    expect(load.grids.labour.overloadHours[row * WEEKS] ?? -1).toBeCloseTo(151, 10)
  })
})

describe('buildLoad — warnings', () => {
  it('warns when a material has supply but no valid routing', () => {
    const { load, machine } = runLoad({
      workCenters: [workCenter('WC-A', 40, 40)],
      materials: [material('M1')],
      routings: [],
      rowKeys: ['M1|P1'],
      supply: [[100, 0, 0, 0]],
    })
    expect(load.warnings.join(' ')).toContain('no valid routing')
    expect(machine('WC-A', 0)).toBe(0)
  })

  it('warns when a routing operation points at a work center with no capacity', () => {
    const { load } = runLoad({
      workCenters: [workCenter('WC-A', 40, 40), workCenter('WC-DEAD', 0, 0)],
      materials: [material('M1')],
      routings: [routing('R1', 'M1', [op(10, 'OP-A', 'WC-DEAD', 0.5 * OEE, 0, 1, 0)])],
      rowKeys: ['M1|P1'],
      supply: [[100, 0, 0, 0]],
    })
    expect(load.warnings.join(' ')).toContain('zero hours across the horizon')
  })

  it('warns when required hours exceed available by more than 3x', () => {
    const { load } = runLoad(FIXTURE_A)
    // WC-1 needs ~161 machine hours against 40 available.
    expect(load.warnings.join(' ')).toContain('data error, not a bottleneck')
  })

  it('says nothing when the plan is ordinary', () => {
    const { load } = runLoad({ ...FIXTURE_B, supply: [[40, 0, 0, 0]] })
    expect(load.warnings).toEqual([])
  })

  it('treats an impossible yield as 1.0 and says so', () => {
    const { load, machine } = runLoad({
      ...FIXTURE_B,
      routings: [routing('R1', 'M1', [op(10, 'OP-A', 'WC-A', 0.5 * OEE, 0, 0, 0)])],
    })
    expect(load.warnings.join(' ')).toContain('treated as 1.0')
    expect(machine('WC-A', 0)).toBeCloseTo(50, 10)
  })
})
