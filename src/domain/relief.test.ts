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
import { findRelief, rankBottlenecks } from '@/domain/relief'
import { buildTimeGrid } from '@/domain/time'
import { at } from '@/domain/lookup'

const WEEKS = 4

/** OEE 0.5 and a nominal rate of 1 each/hour, so hours per unit are exactly 2. */
function pools(hoursPerWeek: number): PoolCapacity[] {
  return [
    { pool: 'machine', count: 1, shiftsPerDay: 1, hoursPerShift: hoursPerWeek, daysPerWeek: 1, utilisationFactor: 1 },
    { pool: 'labour', count: 1, shiftsPerDay: 1, hoursPerShift: hoursPerWeek, daysPerWeek: 1, utilisationFactor: 1 },
  ]
}

function plant(id: string, city: string, region: Plant['region'], slot: Plant['colorSlot']): Plant {
  return {
    id,
    code: id,
    name: `${city} Plant`,
    city,
    country: city,
    countryCode: 'XX',
    region,
    currency: 'USD',
    fxPerUsd: 1,
    timezone: 'UTC',
    lat: 0,
    lon: 0,
    colorSlot: slot,
    labourCostPerHourLocal: 40,
    defaultOee: 0.5,
    gridIntensity: 0.5,
  }
}

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
        name: 'Forming head',
        addsFeatures: ['F-A'],
        capexUsd: 100_000,
        leadTimeWeeks: 4,
        oeeDelta: 0,
        description: '',
      },
    ],
  },
]

function wc(id: string, plantId: string, hoursPerWeek: number, features: string[]): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: `${id} line`,
    classId: 'CLASS-A',
    vintage: 2015,
    pools: pools(hoursPerWeek),
    features,
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

function material(id: string, groupId: string, plantIds: string[]): Material {
  return {
    id,
    code: `${id}-CODE`,
    description: id,
    type: 'FERT',
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

function emptyScenario(): Scenario {
  return { id: 'baseline', name: 'Baseline', description: '', moves: [], colorSlot: 1 }
}

function model(snap: Snapshot): { idx: SnapshotIndexes; load: LoadOutput } {
  const idx = buildIndexes(snap)
  const oee = buildOeeGrid(snap, idx)
  const capacity = buildCapacity(snap, idx)
  const ceilings = buildCeilings(emptyScenario(), 1)
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

function shell(over: Partial<Snapshot>): Snapshot {
  return {
    meta: { profile: 'test', generatedBy: 'factory', seed: 1, skuCount: 0, workCenterCount: 0, weekCount: WEEKS },
    time: buildTimeGrid('2026-01-05', WEEKS),
    plants: [],
    features: [{ id: 'F-A', name: 'Forming', group: 'process', description: '' }],
    machineClasses: CLASSES,
    workCenters: [],
    standardOperations: STD_OPS,
    families: [{ id: 'FAM-1', code: 'F1', name: 'Enclosures' }],
    groups: [],
    materials: [],
    routings: [],
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [],
    supplyPlan: matrix([]),
    demandPlan: matrix([]),
    inventory: [],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Severity fixture: four work centers, each at an exact utilisation.
// ---------------------------------------------------------------------------

function severitySnapshot(): Snapshot {
  const spec: Array<[string, number]> = [
    ['LOW', 4.2], // 8.4h of 10h  -> 0.84, below the watch line
    ['WATCH', 4.25], // 8.5h        -> 0.85 exactly
    ['TIGHT', 4.75], // 9.5h        -> 0.95 exactly
    ['CRIT', 5], // 10h             -> 1.00 exactly
  ]
  return shell({
    plants: [plant('P1', 'Wroclaw', 'EUR', 1)],
    workCenters: spec.map(([id]) => wc(id, 'P1', 10, ['F-A'])),
    groups: spec.map(([id]) => ({ id: `G-${id}`, familyId: 'FAM-1', code: id, name: id })),
    materials: spec.map(([id]) => material(`M-${id}`, `G-${id}`, ['P1'])),
    routings: spec.map(
      ([id]): Routing => ({
        id: `R-${id}`,
        materialId: `M-${id}`,
        plantId: 'P1',
        version: '0001',
        primary: true,
        operations: [op(id)],
      }),
    ),
    supplyPlan: matrix(spec.map(([id, units]): [string, number] => [`M-${id}|P1`, units])),
  })
}

describe('rankBottlenecks', () => {
  it('applies the severity thresholds at their exact boundaries', () => {
    const snap = severitySnapshot()
    const { idx, load } = model(snap)
    const ranked = rankBottlenecks(snap, idx, load, filters())

    expect(ranked.map((b) => b.workCenterId)).toEqual(['CRIT', 'TIGHT', 'WATCH'])
    expect(ranked.map((b) => b.severity)).toEqual(['critical', 'tight', 'watch'])
    // 0.84 is not a bottleneck, and the tool does not pretend it is.
    expect(ranked.some((b) => b.workCenterId === 'LOW')).toBe(false)
  })

  it('reports the peak week, the binding pool and the groups carrying the load', () => {
    const snap = severitySnapshot()
    const { idx, load } = model(snap)
    const worst = at(rankBottlenecks(snap, idx, load, filters()), 0, 'bottleneck')
    expect(worst.workCenterId).toBe('CRIT')
    expect(worst.plantId).toBe('P1')
    expect(worst.peakUtilisation).toBeCloseTo(1)
    expect(worst.bindingPool).toBe('machine')
    expect(worst.topGroups).toEqual([{ groupId: 'G-CRIT', hours: 40 }])
  })

  it('counts weeks over the ceiling and rises to critical on a shortfall', () => {
    const snap = severitySnapshot()
    const idx = buildIndexes(snap)
    const oee = buildOeeGrid(snap, idx)
    const capacity = buildCapacity(snap, idx)
    // A 90% ceiling pushes everything but LOW past the wall.
    const ceilings = buildCeilings(emptyScenario(), 0.9)
    const sourcing = resolveSourcing(snap, idx, emptyScenario())
    const load = buildLoad(snap, idx, sourcing, capacity, oee, ceilings)

    const ranked = rankBottlenecks(snap, idx, load, filters())
    const crit = ranked.find((b) => b.workCenterId === 'CRIT')
    expect(crit?.severity).toBe('critical')
    expect(crit?.weeksOverCeiling).toBe(WEEKS)
    expect(crit?.overloadHours).toBeCloseTo(4) // (10 - 9) x 4 weeks
    expect(crit?.shortfallUnits).toBeGreaterThan(0)
  })

  it('respects the week window', () => {
    const snap = severitySnapshot()
    const { idx, load } = model(snap)
    const ranked = rankBottlenecks(snap, idx, load, filters({ fromWeek: 1, toWeek: 2 }))
    const crit = ranked.find((b) => b.workCenterId === 'CRIT')
    expect(crit?.topGroups).toEqual([{ groupId: 'G-CRIT', hours: 20 }])
  })
})

// ---------------------------------------------------------------------------
// Relief fixture: one saturated work center and six possible homes for its load.
// ---------------------------------------------------------------------------

function reliefSnapshot(): Snapshot {
  const routings: Routing[] = [
    { id: 'R1', materialId: 'M1', plantId: 'P1', version: '0001', primary: true, operations: [op('HOT')] },
    { id: 'R1-NEAR', materialId: 'M1', plantId: 'P1', version: '0002', primary: false, operations: [op('NEAR')] },
    { id: 'R1-TIGHT', materialId: 'M1', plantId: 'P1', version: '0003', primary: false, operations: [op('TIGHT')] },
    { id: 'R1-TINY', materialId: 'M1', plantId: 'P1', version: '0004', primary: false, operations: [op('TINY')] },
    { id: 'R1-FAR', materialId: 'M1', plantId: 'P2', version: '0001', primary: true, operations: [op('FAR')] },
    { id: 'R2', materialId: 'M2', plantId: 'P1', version: '0001', primary: true, operations: [op('HOT')] },
  ]
  return shell({
    plants: [plant('P1', 'Wroclaw', 'EUR', 1), plant('P2', 'Suzhou', 'APAC', 2)],
    workCenters: [
      wc('HOT', 'P1', 10, ['F-A']), // 15h/week of load against 10h
      wc('NEAR', 'P1', 30, ['F-A']), // approved, same plant, plenty of room
      wc('FAR', 'P2', 30, ['F-A']), // approved, other continent
      wc('TIGHT', 'P1', 13.75, ['F-A']), // approved, but would end above its line
      wc('TINY', 'P1', 5, ['F-A']), // approved, and would be far worse than HOT
      wc('CAP', 'P1', 30, ['F-A']), // feature-capable, never approved
      wc('RETRO', 'P1', 30, []), // needs the class retrofit first
    ],
    groups: [
      { id: 'G1', familyId: 'FAM-1', code: 'G1', name: 'Housings' },
      { id: 'G2', familyId: 'FAM-1', code: 'G2', name: 'Brackets' },
    ],
    materials: [material('M1', 'G1', ['P1', 'P2']), material('M2', 'G2', ['P1'])],
    routings,
    supplyPlan: matrix([
      ['M1|P1', 6.5], // 13 machine hours a week at HOT
      ['M2|P1', 1], // 2 more
      ['M1|P2', 1], // 2 hours a week at FAR
    ]),
  })
}

describe('findRelief', () => {
  it('ranks approved before proposals, and same plant before cross plant', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)
    const candidates = findRelief(snap, idx, load, filters(), 'HOT', 10)

    expect(candidates.map((c) => c.toWorkCenterId)).toEqual(['NEAR', 'TIGHT', 'FAR', 'CAP', 'RETRO'])
    expect(candidates.map((c) => c.basis)).toEqual([
      'approved',
      'approved',
      'approved',
      'featureCapable',
      'retrofit',
    ])
    // TINY would be at 300% — that is not relief, and it is not offered.
    expect(candidates.some((c) => c.toWorkCenterId === 'TINY')).toBe(false)
  })

  it('prices each basis honestly', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)
    const byId = new Map(findRelief(snap, idx, load, filters(), 'HOT', 10).map((c) => [c.toWorkCenterId, c]))

    const near = byId.get('NEAR')
    expect(near?.capexUsd).toBe(0)
    expect(near?.leadTimeWeeks).toBe(0)
    expect(near?.sameePlant).toBe(true)

    const far = byId.get('FAR')
    expect(far?.sameePlant).toBe(false)
    expect(far?.note).toContain('freight')

    const cap = byId.get('CAP')
    expect(cap?.capexUsd).toBe(0)
    // Free in capex, expensive in calendar.
    expect(cap?.leadTimeWeeks).toBe(8)
    expect(cap?.note).toContain('qualification')

    const retro = byId.get('RETRO')
    expect(retro?.capexUsd).toBe(100_000)
    expect(retro?.leadTimeWeeks).toBe(12) // 4 week build + 8 week qualification
    expect(retro?.retrofit?.id).toBe('RET-A')
  })

  it('lists the groups that could actually move, biggest first', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)
    const near = findRelief(snap, idx, load, filters(), 'HOT', 10).find((c) => c.toWorkCenterId === 'NEAR')
    expect(near?.movableGroups).toEqual([
      { groupId: 'G1', hours: 52, materials: 1 },
      { groupId: 'G2', hours: 8, materials: 1 },
    ])
    expect(near?.spareHours).toBeCloseTo(120)
    // 60 hours arriving on 120 hours of capacity.
    expect(near?.resultingUtilisation).toBeCloseTo(0.5)
    expect(near?.reliefHours).toBeCloseTo(60)
    expect(near?.movesBottleneck).toBe(false)
  })

  it('flags a candidate that would merely move the bottleneck rather than hiding it', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)
    const tight = findRelief(snap, idx, load, filters(), 'HOT', 10).find((c) => c.toWorkCenterId === 'TIGHT')
    expect(tight).toBeDefined()
    expect(tight?.movesBottleneck).toBe(true)
    // Above its own comfort line, but still below the 150% at HOT, so the
    // network really is better off and the planner gets to decide.
    expect(tight?.resultingUtilisation).toBeGreaterThan(0.95)
    expect(tight?.resultingUtilisation).toBeLessThan(1.5)
    expect(tight?.note).toContain('network is better off')
    expect(tight?.note).toContain('Move part of it')
  })

  it('honours the product filter and the week window', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)

    const brackets = findRelief(snap, idx, load, filters({ groupIds: ['G2'] }), 'HOT', 10)
    const near = brackets.find((c) => c.toWorkCenterId === 'NEAR')
    expect(near?.movableGroups).toEqual([{ groupId: 'G2', hours: 8, materials: 1 }])

    const half = findRelief(snap, idx, load, filters({ fromWeek: 0, toWeek: 1 }), 'HOT', 10)
    const nearHalf = half.find((c) => c.toWorkCenterId === 'NEAR')
    expect(nearHalf?.movableGroups.reduce((sum, g) => sum + g.hours, 0)).toBeCloseTo(30)
  })

  it('caps the list and returns nothing for an unknown work center', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)
    expect(findRelief(snap, idx, load, filters(), 'HOT', 2)).toHaveLength(2)
    expect(findRelief(snap, idx, load, filters(), 'NOPE', 10)).toEqual([])
  })

  it('searches the whole network even when the view is filtered to one plant', () => {
    const snap = reliefSnapshot()
    const { idx, load } = model(snap)
    const candidates = findRelief(snap, idx, load, filters({ plantIds: ['P1'] }), 'HOT', 10)
    // Hiding Suzhou because the planner is looking at Wroclaw would hide the answer.
    expect(candidates.some((c) => c.toWorkCenterId === 'FAR')).toBe(true)
  })
})
