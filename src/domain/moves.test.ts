import { describe, expect, it } from 'vitest'
import type {
  DowntimeEvent,
  Feature,
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
import { buildIndexes } from '@/domain/indexes'
import { buildCeilings } from '@/domain/capacity'
import { applyMoves, describeMove, describeScenario, scenarioCapex } from '@/domain/moves'
import { buildTimeGrid } from '@/domain/time'
import { at } from '@/domain/lookup'

const WEEKS = 4

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

const FEATURES: Feature[] = [
  { id: 'F-PAINT', name: 'Paint booth', group: 'process', description: '' },
  { id: 'F-HEAT', name: 'Heat treat', group: 'process', description: '' },
]

const CLASSES: MachineClass[] = [
  {
    id: 'CLASS-A',
    name: 'Alpha coater',
    supplier: 'Acme',
    generation: 3,
    baseFeatures: ['F-PAINT'],
    retrofits: [
      {
        id: 'RET-HEAT',
        name: 'Heat treat module',
        addsFeatures: ['F-HEAT'],
        capexUsd: 250_000,
        leadTimeWeeks: 6,
        oeeDelta: 0.03,
        description: '',
      },
    ],
  },
]

function wc(id: string, plantId: string, features: string[]): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: `${id} coater`,
    classId: 'CLASS-A',
    vintage: 2015,
    pools: pools(),
    features,
    baseOee: 0.5,
    status: 'active',
    costRateUsdPerHour: 100,
    co2PerMachineHourKg: 5,
  }
}

const STD_OPS: StandardOperation[] = [
  { id: 'OP-PAINT', code: 'PAINT-STD', name: 'Paint', requiredFeatures: ['F-PAINT'], stage: 10 },
  { id: 'OP-HEAT', code: 'HEAT-STD', name: 'Heat treat', requiredFeatures: ['F-HEAT'], stage: 20 },
]

function op(workCenterId: string, opId = 'OP-PAINT'): RoutingOperation {
  return {
    seq: 10,
    opId,
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
    description: `${id} description`,
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

const SUPPLY_ROWS = ['M1|P1', 'M2|P1', 'M3|P1', 'M3|P2']
const DEMAND_ROWS = ['M1|EUR', 'M2|EUR', 'M3|EUR']

function plan(rowKeys: string[], fill: number): PlanMatrix {
  return { rowKeys, weekCount: WEEKS, values: new Float64Array(rowKeys.length * WEEKS).fill(fill) }
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
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 3,
      workCenterCount: 4,
      weekCount: WEEKS,
    },
    time: buildTimeGrid('2026-01-05', WEEKS),
    plants: PLANTS,
    features: FEATURES,
    machineClasses: CLASSES,
    workCenters: [
      wc('WC1', 'P1', ['F-PAINT']),
      wc('WC2', 'P1', ['F-PAINT']),
      wc('WC3', 'P2', ['F-PAINT']),
      // Not approved for anything and missing the paint feature: the work
      // center a resourceMove must refuse to target.
      wc('WC4', 'P1', []),
    ],
    standardOperations: STD_OPS,
    families: [{ id: 'FAM-1', code: 'FAM1', name: 'Enclosures' }],
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
    downtime: [
      {
        id: 'DT-1',
        workCenterId: 'WC1',
        kind: 'maintenance',
        status: 'planned',
        fromWeek: 2,
        toWeek: 2,
        pools: ['machine'],
        hoursPerWeek: 4,
        label: 'PM',
      },
    ],
    supplyPlan: plan(SUPPLY_ROWS, 3),
    demandPlan: plan(DEMAND_ROWS, 4),
    inventory: [],
  }
}

function scenario(moves: ScenarioMove[]): Scenario {
  return { id: 'S1', name: 'Test', description: '', moves, colorSlot: 2 }
}

function entry(id: string, seq: number, move: ScenarioMove['move'], enabled = true): ScenarioMove {
  return { id, label: id, enabled, seq, move }
}

// ---------------------------------------------------------------------------

describe('applyMoves — purity', () => {
  it('never mutates the snapshot it was given', () => {
    const snap = snapshot()
    const before = structuredClone(snap)
    const result = applyMoves(
      snap,
      scenario([
        entry('m1', 1, { kind: 'oeeSet', scope: 'workCenter', workCenterId: 'WC1', value: 0.7 }),
        entry('m2', 2, {
          kind: 'rateSet',
          materialId: 'M1',
          workCenterId: 'WC1',
          opId: 'OP-PAINT',
          ratePerHour: 12,
        }),
        entry('m3', 3, { kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-HEAT', availableFromWeek: 2 }),
        entry('m4', 4, {
          kind: 'planScale',
          plan: 'supply',
          selector: { kind: 'all' },
          fromWeek: 0,
          toWeek: 3,
          factor: 2,
        }),
        entry('m5', 5, {
          kind: 'shiftChange',
          workCenterId: 'WC2',
          pool: 'machine',
          fromWeek: 1,
          toWeek: 2,
          shiftsPerDay: 2,
        }),
      ]),
    )

    expect(snap).toEqual(before)
    expect(result.snapshot).not.toBe(snap)
  })

  it('shares every collection no move touched', () => {
    const snap = snapshot()
    const { snapshot: next } = applyMoves(
      snap,
      scenario([entry('m1', 1, { kind: 'oeeSet', scope: 'plant', plantId: 'P1', value: 0.6 })]),
    )
    // Only oeeOverrides was written to; the 15,000-row collections are shared.
    expect(next.oeeOverrides).not.toBe(snap.oeeOverrides)
    expect(next.materials).toBe(snap.materials)
    expect(next.routings).toBe(snap.routings)
    expect(next.supplyPlan).toBe(snap.supplyPlan)
    expect(next.workCenters).toBe(snap.workCenters)
  })

  it('returns the same snapshot object when no enabled move changes anything', () => {
    const snap = snapshot()
    const { snapshot: next } = applyMoves(snap, scenario([]))
    expect(next).toBe(snap)
  })
})

describe('applyMoves — the log', () => {
  it('ignores disabled moves', () => {
    const snap = snapshot()
    const { snapshot: next } = applyMoves(
      snap,
      scenario([
        entry('on', 1, { kind: 'oeeSet', scope: 'workCenter', workCenterId: 'WC1', value: 0.7 }),
        entry('off', 2, { kind: 'oeeSet', scope: 'workCenter', workCenterId: 'WC2', value: 0.9 }, false),
      ]),
    )
    expect(next.oeeOverrides).toHaveLength(1)
    expect(at(next.oeeOverrides, 0, 'override').workCenterId).toBe('WC1')
  })

  it('applies moves in seq order, not array order', () => {
    const snap = snapshot()
    const { snapshot: next } = applyMoves(
      snap,
      scenario([
        entry('later', 20, { kind: 'oeeSet', scope: 'workCenter', workCenterId: 'WC1', value: 0.9 }),
        entry('earlier', 10, { kind: 'oeeSet', scope: 'workCenter', workCenterId: 'WC1', value: 0.6 }),
      ]),
    )
    // The cascade takes the LAST matching entry, so seq order must survive.
    expect(next.oeeOverrides.map((o) => o.value)).toEqual([0.6, 0.9])
  })
})

describe('applyMoves — every variant', () => {
  it('records a legal resourceMove and disables an illegal one', () => {
    const snap = snapshot()
    const legal = applyMoves(
      snap,
      scenario([
        entry('mv', 1, {
          kind: 'resourceMove',
          selector: { kind: 'group', id: 'G1' },
          fromWorkCenterId: 'WC1',
          toWorkCenterId: 'WC2',
          fromWeek: 0,
          toWeek: 3,
          share: 1,
          allowDualSource: false,
        }),
      ]),
    )
    expect(legal.warnings).toEqual([])
    expect(at(legal.effectiveScenario.moves, 0, 'move').enabled).toBe(true)

    const illegal = applyMoves(
      snap,
      scenario([
        entry('mv', 1, {
          kind: 'resourceMove',
          selector: { kind: 'group', id: 'G1' },
          fromWorkCenterId: 'WC1',
          toWorkCenterId: 'WC4',
          fromWeek: 0,
          toWeek: 3,
          share: 1,
          allowDualSource: false,
        }),
      ]),
    )
    expect(illegal.warnings.join(' ')).toContain('not approved')
    expect(at(illegal.effectiveScenario.moves, 0, 'move').enabled).toBe(false)
    // The original scenario object is untouched.
    expect(illegal.effectiveScenario).not.toBe(snap)
  })

  it('allows a resourceMove onto an unapproved work center the scenario retrofits', () => {
    const snap = snapshot()
    const result = applyMoves(
      snap,
      scenario([
        entry('ret', 1, { kind: 'retrofit', workCenterId: 'WC4', retrofitId: 'RET-HEAT', availableFromWeek: 0 }),
        entry('mv', 2, {
          kind: 'resourceMove',
          selector: { kind: 'group', id: 'G1' },
          fromWorkCenterId: 'WC1',
          toWorkCenterId: 'WC4',
          fromWeek: 0,
          toWeek: 3,
          share: 1,
          allowDualSource: false,
        }),
      ]),
    )
    const moveEntry = result.effectiveScenario.moves.find((m) => m.id === 'mv')
    expect(moveEntry?.enabled).toBe(true)
  })

  it('oeeSet pushes an override at the requested scope and window', () => {
    const { snapshot: next } = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'oeeSet',
          scope: 'materialWorkCenter',
          materialId: 'M1',
          workCenterId: 'WC1',
          value: 0.71,
          fromWeek: 1,
          toWeek: 2,
        }),
      ]),
    )
    const override = at(next.oeeOverrides, 0, 'override')
    expect(override).toMatchObject({
      scope: 'materialWorkCenter',
      materialId: 'M1',
      workCenterId: 'WC1',
      value: 0.71,
      fromWeek: 1,
      toWeek: 2,
    })
  })

  it('oeeGlide pushes the path', () => {
    const { snapshot: next } = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'oeeGlide',
          path: {
            id: 'GP-1',
            scope: 'workCenter',
            workCenterId: 'WC1',
            fromWeek: 0,
            toWeek: 3,
            endValue: 0.8,
            curve: 'sCurve',
            label: 'Coater uplift',
          },
        }),
      ]),
    )
    expect(next.glidePaths).toHaveLength(1)
    expect(at(next.glidePaths, 0, 'path').endValue).toBe(0.8)
  })

  it('rateSet pushes a rate override and refuses a nonsense rate', () => {
    const good = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, { kind: 'rateSet', materialId: 'M1', workCenterId: 'WC1', opId: 'OP-PAINT', ratePerHour: 42 }),
      ]),
    )
    expect(at(good.snapshot.rateOverrides, 0, 'override').ratePerHour).toBe(42)

    const bad = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, { kind: 'rateSet', materialId: 'M1', workCenterId: 'WC1', opId: 'OP-PAINT', ratePerHour: 0 }),
      ]),
    )
    expect(bad.snapshot.rateOverrides).toHaveLength(0)
    expect(bad.warnings.join(' ')).toContain('not a usable rate')
  })

  it('shiftChange over the whole horizon patches the PoolCapacity itself', () => {
    const { snapshot: next } = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'shiftChange',
          workCenterId: 'WC1',
          pool: 'machine',
          fromWeek: 0,
          toWeek: WEEKS - 1,
          shiftsPerDay: 3,
        }),
      ]),
    )
    const changed = next.workCenters.find((c) => c.id === 'WC1')
    const pool = changed?.pools.find((p) => p.pool === 'machine')
    expect(pool?.shiftsPerDay).toBe(3)
    expect(next.downtime).toHaveLength(1) // only the fixture's own PM event
  })

  it('shiftChange in a window becomes a changeover event: positive hours for a cut', () => {
    const { snapshot: next } = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'shiftChange',
          workCenterId: 'WC1',
          pool: 'machine',
          fromWeek: 1,
          toWeek: 2,
          hoursPerShift: 6, // 10h/week -> 6h/week
        }),
      ]),
    )
    const event = next.downtime.find((e) => e.id === 'shift:m')
    expect(event).toBeDefined()
    expect(event?.kind).toBe('changeover')
    expect(event?.pools).toEqual(['machine'])
    expect(event?.fromWeek).toBe(1)
    expect(event?.toWeek).toBe(2)
    expect(event?.hoursPerWeek).toBeCloseTo(4)
  })

  it('shiftChange in a window becomes a NEGATIVE-hours event for an increase', () => {
    const { snapshot: next } = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'shiftChange',
          workCenterId: 'WC1',
          pool: 'labour',
          fromWeek: 1,
          toWeek: 2,
          count: 3, // 10h/week -> 30h/week
        }),
      ]),
    )
    const event = next.downtime.find((e) => e.id === 'shift:m')
    // Negative hoursPerWeek ADDS capacity. See the file header in moves.ts.
    expect(event?.hoursPerWeek).toBeCloseTo(-20)
    expect(event?.label).toContain('more labour')
  })

  it('downtimeUpsert inserts then replaces by id, and downtimeRemove deletes by id', () => {
    const snap = snapshot()
    const event: DowntimeEvent = {
      id: 'DT-NEW',
      workCenterId: 'WC2',
      kind: 'shutdown',
      status: 'confirmed',
      fromWeek: 1,
      toWeek: 1,
      pools: ['machine', 'labour'],
      label: 'Collective vacation',
    }
    const inserted = applyMoves(snap, scenario([entry('a', 1, { kind: 'downtimeUpsert', event })]))
    expect(inserted.snapshot.downtime).toHaveLength(2)

    const replaced = applyMoves(
      snap,
      scenario([
        entry('a', 1, { kind: 'downtimeUpsert', event }),
        entry('b', 2, { kind: 'downtimeUpsert', event: { ...event, toWeek: 3 } }),
      ]),
    )
    expect(replaced.snapshot.downtime).toHaveLength(2)
    expect(replaced.snapshot.downtime.find((e) => e.id === 'DT-NEW')?.toWeek).toBe(3)

    const removed = applyMoves(snap, scenario([entry('c', 1, { kind: 'downtimeRemove', eventId: 'DT-1' })]))
    expect(removed.snapshot.downtime).toHaveLength(0)

    const missing = applyMoves(snap, scenario([entry('c', 1, { kind: 'downtimeRemove', eventId: 'nope' })]))
    expect(missing.warnings.join(' ')).toContain('no downtime event nope')
  })

  it('utilisationCeiling leaves the snapshot alone and reaches buildCeilings', () => {
    const snap = snapshot()
    const moves = scenario([
      entry('g', 1, { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.92 }),
      entry('w', 2, { kind: 'utilisationCeiling', scope: 'workCenter', workCenterId: 'WC1', ceiling: 1.05 }),
    ])
    const result = applyMoves(snap, moves)
    expect(result.snapshot).toBe(snap)
    const ceilings = buildCeilings(result.effectiveScenario, 1)
    expect(ceilings.global).toBe(0.92)
    expect(ceilings.byWorkCenter.get('WC1')).toBe(1.05)
  })

  it('retrofit grants features, dates the OEE effect and books the capex', () => {
    const result = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, { kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-HEAT', availableFromWeek: 2 }),
      ]),
    )
    const changed = result.snapshot.workCenters.find((c) => c.id === 'WC1')
    expect(changed?.features).toEqual(['F-PAINT', 'F-HEAT'])
    expect(result.capexUsd).toBe(250_000)
    const override = result.snapshot.oeeOverrides.find((o) => o.workCenterId === 'WC1')
    expect(override?.value).toBeCloseTo(0.53)
    expect(override?.fromWeek).toBe(2)
    // Feature grants carry no date in this model, and the code says so out loud.
    expect(result.warnings.join(' ')).toContain('carry no date')
  })

  it('retrofit refuses an option the machine class does not sell', () => {
    const result = applyMoves(
      snapshot(),
      scenario([entry('m', 1, { kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-NOPE', availableFromWeek: 0 })]),
    )
    expect(result.capexUsd).toBe(0)
    expect(result.warnings.join(' ')).toContain('sells no retrofit')
  })

  it('addWorkCenter appends and rejects an id collision', () => {
    const added = applyMoves(
      snapshot(),
      scenario([entry('m', 1, { kind: 'addWorkCenter', workCenter: wc('WC9', 'P1', ['F-PAINT']), capexUsd: 1_000_000 })]),
    )
    expect(added.snapshot.workCenters).toHaveLength(5)
    expect(added.snapshot.meta.workCenterCount).toBe(5)
    expect(added.capexUsd).toBe(1_000_000)

    const collided = applyMoves(
      snapshot(),
      scenario([entry('m', 1, { kind: 'addWorkCenter', workCenter: wc('WC1', 'P1', []), capexUsd: 500 })]),
    )
    expect(collided.snapshot.workCenters).toHaveLength(4)
    expect(collided.capexUsd).toBe(0)
    expect(collided.warnings.join(' ')).toContain('already exists')
  })

  it('wipTransfer moves plan volume, offsets for transit and charges freight', () => {
    const result = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'wipTransfer',
          materialId: 'M3',
          fromPlantId: 'P1',
          toPlantId: 'P2',
          fromWeek: 2,
          toWeek: 3,
          share: 0.5,
          freightCostPerUnitUsd: 2,
          transitWeeks: 1,
        }),
      ]),
    )
    const rows = result.snapshot.supplyPlan.rowKeys
    const origin = rows.indexOf('M3|P1') * WEEKS
    const target = rows.indexOf('M3|P2') * WEEKS
    const values = result.snapshot.supplyPlan.values
    expect(values[origin + 2]).toBeCloseTo(1.5)
    expect(values[origin + 3]).toBeCloseTo(1.5)
    // Produced a week earlier at the receiving plant so it arrives on time.
    expect(values[target + 1]).toBeCloseTo(4.5)
    expect(values[target + 2]).toBeCloseTo(4.5)
    expect(result.freightUsd).toBeCloseTo(6)
    expect(result.warnings).toEqual([])
  })

  it('wipTransfer of a non-HALB still applies but names the qualification it implies', () => {
    const result = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'wipTransfer',
          materialId: 'M1',
          fromPlantId: 'P1',
          toPlantId: 'P2',
          fromWeek: 0,
          toWeek: 3,
          share: 0.5,
          freightCostPerUnitUsd: 1,
          transitWeeks: 0,
        }),
      ]),
    )
    const text = result.warnings.join(' ')
    expect(text).toContain('WHAT-IF')
    expect(text).toContain('M1-CODE')
    expect(text).toContain('no semi-finished component is declared')
    expect(text).toContain('qualification')
  })

  it('planScale multiplies only the matching rows inside the window', () => {
    const snap = snapshot()
    const result = applyMoves(
      snap,
      scenario([
        entry('m', 1, {
          kind: 'planScale',
          plan: 'supply',
          selector: { kind: 'group', id: 'G1' },
          plantId: 'P1',
          fromWeek: 1,
          toWeek: 2,
          factor: 2,
        }),
      ]),
    )
    const rows = result.snapshot.supplyPlan.rowKeys
    const values = result.snapshot.supplyPlan.values
    const m1 = rows.indexOf('M1|P1') * WEEKS
    const m2 = rows.indexOf('M2|P1') * WEEKS
    const m3p2 = rows.indexOf('M3|P2') * WEEKS
    expect(Array.from(values.slice(m1, m1 + WEEKS))).toEqual([3, 6, 6, 3])
    expect(Array.from(values.slice(m2, m2 + WEEKS))).toEqual([3, 3, 3, 3]) // wrong group
    expect(Array.from(values.slice(m3p2, m3p2 + WEEKS))).toEqual([3, 3, 3, 3]) // wrong plant
    // The demand plan was never touched, so it is still the same object.
    expect(result.snapshot.demandPlan).toBe(snap.demandPlan)
  })

  it('planScale on the demand plan respects the region qualifier', () => {
    const result = applyMoves(
      snapshot(),
      scenario([
        entry('m', 1, {
          kind: 'planScale',
          plan: 'demand',
          selector: { kind: 'all' },
          region: 'NAM',
          fromWeek: 0,
          toWeek: 3,
          factor: 0,
        }),
      ]),
    )
    // Every demand row in this fixture is EUR, so a NAM scale matches nothing.
    expect(result.warnings.join(' ')).toContain('changed nothing')
    expect(Array.from(result.snapshot.demandPlan.values)).toEqual(
      Array.from(snapshot().demandPlan.values),
    )
  })

  it('sourceSwitch changes nothing in the snapshot but validates its plants', () => {
    const snap = snapshot()
    const ok = applyMoves(
      snap,
      scenario([
        entry('m', 1, {
          kind: 'sourceSwitch',
          selector: { kind: 'material', id: 'M3' },
          fromPlantId: 'P1',
          toPlantId: 'P2',
          switchWeek: 2,
          overlapWeeks: 1,
        }),
      ]),
    )
    expect(ok.snapshot).toBe(snap)
    expect(ok.warnings).toEqual([])

    const bad = applyMoves(
      snap,
      scenario([
        entry('m', 1, {
          kind: 'sourceSwitch',
          selector: { kind: 'material', id: 'M3' },
          fromPlantId: 'P1',
          toPlantId: 'P404',
          switchWeek: 2,
          overlapWeeks: 0,
        }),
      ]),
    )
    expect(at(bad.effectiveScenario.moves, 0, 'move').enabled).toBe(false)
    expect(bad.warnings.join(' ')).toContain('P404')
  })
})

describe('describeMove', () => {
  const idx = buildIndexes(snapshot())

  it('reads like the sentence a planner would say', () => {
    const text = describeMove(
      {
        kind: 'resourceMove',
        selector: { kind: 'group', id: 'G1' },
        fromWorkCenterId: 'WC1',
        toWorkCenterId: 'WC3',
        fromWeek: 14,
        toWeek: 26,
        share: 0.4,
        allowDualSource: true,
      },
      idx,
    )
    expect(text).toBe('Move 40% of Housings from WC1 (Wroclaw) to WC3 (Suzhou), W14-W26, dual source on')
  })

  it('resolves ids to names for every variant', () => {
    expect(describeMove({ kind: 'oeeSet', scope: 'plant', plantId: 'P1', value: 0.82 }, idx)).toContain(
      'every work center at Wroclaw',
    )
    expect(
      describeMove(
        {
          kind: 'oeeGlide',
          path: {
            id: 'g',
            scope: 'workCenter',
            workCenterId: 'WC1',
            fromWeek: 4,
            toWeek: 30,
            endValue: 0.85,
            curve: 'sCurve',
            label: 'Coater programme',
          },
        },
        idx,
      ),
    ).toContain('on an S-curve')
    expect(
      describeMove({ kind: 'rateSet', materialId: 'M1', workCenterId: 'WC1', opId: 'OP-PAINT', ratePerHour: 120 }, idx),
    ).toContain('PAINT-STD')
    expect(
      describeMove(
        { kind: 'shiftChange', workCenterId: 'WC1', pool: 'labour', fromWeek: 1, toWeek: 2, count: 4 },
        idx,
      ),
    ).toContain('4 operators')
    expect(
      describeMove({ kind: 'utilisationCeiling', scope: 'global', ceiling: 0.95 }, idx),
    ).toBe('Cap planned utilisation at 95% across the network')
    expect(
      describeMove({ kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-HEAT', availableFromWeek: 30 }, idx),
    ).toContain('Heat treat module ($250K, 6 week lead time, OEE +3.0pp)')
    expect(
      describeMove({ kind: 'addWorkCenter', workCenter: wc('WC9', 'P2', []), capexUsd: 1_200_000 }, idx),
    ).toContain('at Suzhou for $1.2M')
    expect(
      describeMove(
        {
          kind: 'wipTransfer',
          materialId: 'M3',
          fromPlantId: 'P1',
          toPlantId: 'P2',
          fromWeek: 14,
          toWeek: 26,
          share: 0.3,
          freightCostPerUnitUsd: 1.2,
          transitWeeks: 2,
        },
        idx,
      ),
    ).toContain('Wroclaw to Suzhou')
    expect(
      describeMove(
        {
          kind: 'planScale',
          plan: 'supply',
          selector: { kind: 'family', id: 'FAM-1' },
          fromWeek: 0,
          toWeek: 3,
          factor: 1.15,
        },
        idx,
      ),
    ).toContain('Enclosures')
    expect(
      describeMove(
        {
          kind: 'sourceSwitch',
          selector: { kind: 'material', id: 'M1' },
          fromPlantId: 'P1',
          toPlantId: 'P2',
          switchWeek: 26,
          overlapWeeks: 0,
        },
        idx,
      ),
    ).toContain('a clean cut')
    expect(describeMove({ kind: 'downtimeRemove', eventId: 'DT-1' }, idx)).toContain('DT-1')
    expect(
      describeMove(
        {
          kind: 'downtimeUpsert',
          event: {
            id: 'x',
            workCenterId: 'WC1',
            kind: 'maintenance',
            status: 'atRisk',
            fromWeek: 2,
            toWeek: 4,
            pools: ['machine'],
            hoursPerWeek: 12,
            label: 'Gearbox',
            slipWeeks: 3,
          },
        },
        idx,
      ),
    ).toContain('modelled 3 week(s) late')
  })

  it('describes a whole scenario in seq order, skipping disabled moves', () => {
    const lines = describeScenario(
      scenario([
        entry('b', 2, { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.9 }),
        entry('a', 1, { kind: 'oeeSet', scope: 'plant', plantId: 'P2', value: 0.6 }),
        entry('off', 3, { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.1 }, false),
      ]),
      idx,
    )
    expect(lines).toHaveLength(2)
    expect(at(lines, 0, 'line')).toContain('Suzhou')
    expect(at(lines, 1, 'line')).toContain('90%')
  })
})

describe('scenarioCapex', () => {
  it('totals retrofit and new-asset capex without applying anything', () => {
    const snap = snapshot()
    const total = scenarioCapex(
      snap,
      scenario([
        entry('a', 1, { kind: 'retrofit', workCenterId: 'WC1', retrofitId: 'RET-HEAT', availableFromWeek: 0 }),
        entry('b', 2, { kind: 'addWorkCenter', workCenter: wc('WC9', 'P1', []), capexUsd: 750_000 }),
        entry('c', 3, { kind: 'addWorkCenter', workCenter: wc('WC8', 'P1', []), capexUsd: 10 }, false),
      ]),
    )
    expect(total).toBe(1_000_000)
  })
})
