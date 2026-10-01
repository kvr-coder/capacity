import { describe, expect, it } from 'vitest'
import type {
  Material,
  PoolCapacity,
  Plant,
  Routing,
  RoutingOperation,
  Snapshot,
  WorkCenter,
} from '@/domain/types'
import { buildIndexes } from '@/domain/indexes'
import { findMaterial, findRoutingOperation, quoteRate, resolveOperation } from '@/domain/rates'
import { buildTimeGrid } from '@/domain/time'
import { at } from '@/domain/lookup'

const WEEKS = 4

const POOLS: PoolCapacity[] = [
  { pool: 'machine', count: 1, shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
  { pool: 'labour', count: 2, shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
]

const PLANT: Plant = {
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
  defaultOee: 0.8,
  gridIntensity: 0.3,
}

const WC: WorkCenter = {
  id: 'WC1',
  plantId: 'P1',
  code: 'WC1',
  name: 'Press 1',
  classId: 'CLASS-1',
  vintage: 2015,
  pools: POOLS,
  features: [],
  baseOee: 0.8,
  status: 'active',
  costRateUsdPerHour: 90,
  co2PerMachineHourKg: 4,
}

const MATERIAL: Material = {
  id: 'M1',
  code: 'M-0001',
  description: 'Widget',
  type: 'FERT',
  groupId: 'G1',
  familyId: 'F1',
  baseUom: 'EA',
  plantIds: ['P1'],
  pricePerUnitUsd: 10,
  materialCostPerUnitUsd: 4,
  abcClass: 'A',
  unitsPerHandlingUnit: 100,
  weightKgPerUnit: 0.5,
}

function op(over: Partial<RoutingOperation> = {}): RoutingOperation {
  return {
    seq: 10,
    opId: 'OP-A',
    workCenterId: 'WC1',
    baseQty: 100,
    setupHours: 1.5,
    machineHoursPerBase: 2, // 100 units in 2 hours -> 50/hour nominal
    labourHoursPerBase: 4, // 0.04 labour hours per unit before OEE
    yield: 0.98,
    ...over,
  }
}

function routing(over: Partial<Routing> = {}): Routing {
  return {
    id: 'R1',
    materialId: 'M1',
    plantId: 'P1',
    version: '0001',
    primary: true,
    operations: [op()],
    ...over,
  }
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 1,
      workCenterCount: 1,
      weekCount: WEEKS,
    },
    time: buildTimeGrid('2026-09-07', WEEKS),
    plants: [PLANT],
    features: [],
    machineClasses: [],
    workCenters: [WC],
    standardOperations: [],
    families: [],
    groups: [],
    materials: [MATERIAL],
    routings: [routing()],
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [],
    supplyPlan: { rowKeys: ['M1|P1'], weekCount: WEEKS, values: new Float64Array(WEEKS) },
    demandPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    inventory: [],
    ...over,
  }
}

function firstOp(snap: Snapshot, routingId = 'R1'): RoutingOperation {
  const found = snap.routings.find((r) => r.id === routingId)
  if (!found) throw new Error(`no routing ${routingId}`)
  return at(found.operations, 0, 'operation')
}

describe('rate resolution order', () => {
  it('step 1: derives the nominal rate from the routing operation', () => {
    const snap = snapshot()
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 1)
    expect(resolved.ratePerHour).toBeCloseTo(50, 10)
    expect(resolved.setupHours).toBeCloseTo(1.5, 10)
    expect(resolved.yield).toBeCloseTo(0.98, 10)
  })

  it('step 2: an alternate production version beats the primary routing', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      // Same operation at the same work center, faster line: 100 in 1.25 hours.
      operations: [op({ machineHoursPerBase: 1.25, labourHoursPerBase: 2, setupHours: 0.5, yield: 0.99 })],
    })
    const snap = snapshot({ routings: [routing(), alternate] })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 1)
    expect(resolved.ratePerHour).toBeCloseTo(80, 10)
    // The alternate version's times are taken as a set — half of one process
    // and half of another describes no real process.
    expect(resolved.setupHours).toBeCloseTo(0.5, 10)
    expect(resolved.yield).toBeCloseTo(0.99, 10)
    expect(resolved.labourHoursPerUnit).toBeCloseTo(0.02, 10)
  })

  it('step 2 does not fire for an operation that already came from a version', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      operations: [op({ machineHoursPerBase: 1.25 })],
    })
    const snap = snapshot({ routings: [routing(), alternate] })
    // The caller (sourcing) already chose R2; resolving R2's own operation must
    // not bounce back through the alternate lookup.
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap, 'R2'), 1)
    expect(resolved.ratePerHour).toBeCloseTo(80, 10)
  })

  it('step 2 ignores a version that runs the operation somewhere else', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      operations: [op({ workCenterId: 'WC-OTHER', machineHoursPerBase: 0.5 })],
    })
    const snap = snapshot({ routings: [routing(), alternate] })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 1)
    expect(resolved.ratePerHour).toBeCloseTo(50, 10)
  })

  it('step 3: a SKU rate override beats both, and touches only the rate', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      operations: [op({ machineHoursPerBase: 1.25, setupHours: 0.5 })],
    })
    const snap = snapshot({
      routings: [routing(), alternate],
      rateOverrides: [{ materialId: 'M1', workCenterId: 'WC1', opId: 'OP-A', ratePerHour: 120 }],
    })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 1)
    expect(resolved.ratePerHour).toBeCloseTo(120, 10)
    expect(resolved.setupHours).toBeCloseTo(0.5, 10)
  })

  it('scopes the override to its own material, work center and operation', () => {
    const snap = snapshot({
      rateOverrides: [{ materialId: 'M2', workCenterId: 'WC1', opId: 'OP-A', ratePerHour: 120 }],
    })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 1)
    expect(resolved.ratePerHour).toBeCloseTo(50, 10)
  })
})

describe('OEE is applied exactly once, to the rate', () => {
  it('multiplies the rate and divides the hours', () => {
    const snap = snapshot()
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 0.8)
    expect(resolved.ratePerHour).toBeCloseTo(50, 10)
    expect(resolved.effectiveRatePerHour).toBeCloseTo(40, 10)
    expect(resolved.machineHoursPerUnit).toBeCloseTo(1 / 40, 10)
    expect(resolved.labourHoursPerUnit).toBeCloseTo(0.04 / 0.8, 10)
    // The identity that makes "rate x OEE" the whole story.
    expect(resolved.machineHoursPerUnit * resolved.effectiveRatePerHour).toBeCloseTo(1, 10)
  })

  it('scales hours by exactly 1/oee against the oee = 1 baseline', () => {
    const snap = snapshot()
    const idx = buildIndexes(snap)
    const base = resolveOperation(snap, idx, 'M1', firstOp(snap), 1)
    const damped = resolveOperation(snap, idx, 'M1', firstOp(snap), 0.5)
    // Applied twice this ratio would be 4, which is the mistake this test exists for.
    expect(damped.machineHoursPerUnit / base.machineHoursPerUnit).toBeCloseTo(2, 10)
    expect(damped.labourHoursPerUnit / base.labourHoursPerUnit).toBeCloseTo(2, 10)
  })

  it('leaves setup hours alone — a lot charge is not a rate', () => {
    const snap = snapshot()
    const idx = buildIndexes(snap)
    expect(resolveOperation(snap, idx, 'M1', firstOp(snap), 1).setupHours).toBeCloseTo(1.5, 10)
    expect(resolveOperation(snap, idx, 'M1', firstOp(snap), 0.4).setupHours).toBeCloseTo(1.5, 10)
  })
})

describe('guards', () => {
  it('yields Infinity hours, never NaN, for a dead rate', () => {
    const snap = snapshot({ routings: [routing({ operations: [op({ machineHoursPerBase: 0 })] })] })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 0.8)
    expect(resolved.ratePerHour).toBe(0)
    expect(resolved.effectiveRatePerHour).toBe(0)
    expect(resolved.machineHoursPerUnit).toBe(Infinity)
    expect(resolved.labourHoursPerUnit).toBe(Infinity)
    expect(Number.isNaN(resolved.machineHoursPerUnit)).toBe(false)
  })

  it('yields Infinity hours for a dead OEE', () => {
    const snap = snapshot()
    const idx = buildIndexes(snap)
    for (const oee of [0, -0.5, Number.NaN]) {
      const resolved = resolveOperation(snap, idx, 'M1', firstOp(snap), oee)
      expect(resolved.machineHoursPerUnit).toBe(Infinity)
      expect(resolved.labourHoursPerUnit).toBe(Infinity)
    }
  })

  it('handles a negative or zero base quantity without dividing by zero', () => {
    const snap = snapshot({ routings: [routing({ operations: [op({ baseQty: 0 })] })] })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 0.8)
    expect(resolved.machineHoursPerUnit).toBe(Infinity)
    expect(resolved.labourHoursPerUnit).toBe(Infinity)
  })

  it('reports zero labour hours for an unattended operation', () => {
    const snap = snapshot({ routings: [routing({ operations: [op({ labourHoursPerBase: 0 })] })] })
    const resolved = resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 0.8)
    expect(resolved.labourHoursPerUnit).toBe(0)
    expect(resolved.machineHoursPerUnit).toBeCloseTo(1 / 40, 10)
  })

  it('clamps a nonsense yield into 0..1', () => {
    const snap = snapshot({ routings: [routing({ operations: [op({ yield: 1.4 })] })] })
    expect(resolveOperation(snap, buildIndexes(snap), 'M1', firstOp(snap), 0.8).yield).toBe(1)
  })
})

/**
 * REGRESSION for the material-level guard in `memoFor`.
 *
 * `resolveOperation` runs once per (supply row, operation) — ~80,000 times per
 * run on the standard profile — and both the alternate-version lookup and the
 * rate-override lookup cost a composite key built from a rest array and a join.
 * Only a small minority of materials carry either, so both lookups are now
 * skipped for materials that appear in neither set. The guard is only sound if
 * it is EXACT: it must never drop a hit, and it must never manufacture one.
 */
describe('the material guard on the alternate and override lookups is exact', () => {
  const M2: Material = { ...MATERIAL, id: 'M2', code: 'M-0002' }

  /** Only M2 has a second production version and a rate override. */
  function twoMaterials(): Snapshot {
    const m2Primary = routing({ id: 'R-M2-1', materialId: 'M2', operations: [op()] })
    const m2Alternate = routing({
      id: 'R-M2-2',
      materialId: 'M2',
      version: '0002',
      primary: false,
      operations: [op({ machineHoursPerBase: 1.25, setupHours: 0.5, yield: 0.99 })],
    })
    return snapshot({
      materials: [MATERIAL, M2],
      routings: [routing(), m2Primary, m2Alternate],
      rateOverrides: [{ materialId: 'M2', workCenterId: 'WC1', opId: 'OP-A', ratePerHour: 120 }],
    })
  }

  it('still finds the alternate and the override for the material that has them', () => {
    const snap = twoMaterials()
    const idx = buildIndexes(snap)
    const resolved = resolveOperation(snap, idx, 'M2', firstOp(snap, 'R-M2-1'), 1)
    // Override wins the rate; the alternate version still supplies the times.
    expect(resolved.ratePerHour).toBeCloseTo(120, 10)
    expect(resolved.setupHours).toBeCloseTo(0.5, 10)
    expect(resolved.yield).toBeCloseTo(0.99, 10)
  })

  it('leaves a material that has neither on its own routing times', () => {
    const snap = twoMaterials()
    const idx = buildIndexes(snap)
    const resolved = resolveOperation(snap, idx, 'M1', firstOp(snap), 1)
    expect(resolved.ratePerHour).toBeCloseTo(50, 10)
    expect(resolved.setupHours).toBeCloseTo(1.5, 10)
    expect(resolved.yield).toBeCloseTo(0.98, 10)
  })

  it('does not let one material borrow another material\'s override', () => {
    const snap = snapshot({
      materials: [MATERIAL, M2],
      rateOverrides: [{ materialId: 'M2', workCenterId: 'WC1', opId: 'OP-A', ratePerHour: 120 }],
    })
    const idx = buildIndexes(snap)
    expect(resolveOperation(snap, idx, 'M1', firstOp(snap), 1).ratePerHour).toBeCloseTo(50, 10)
  })
})

// ---------------------------------------------------------------------------
// Quoting the current rate — what a `rateSet` move is authored against
// ---------------------------------------------------------------------------

describe('quoteRate', () => {
  it('quotes the NOMINAL rate, and the effective rate beside it', () => {
    const snap = snapshot()
    const quote = quoteRate(snap, buildIndexes(snap), 'M1', 'WC1', 'OP-A', 0.8)
    expect(quote.status).toBe('resolved')
    // 100 units in 2 hours, before OEE. A `rateSet` move sets THIS number.
    expect(quote.ratePerHour).toBeCloseTo(50, 10)
    expect(quote.effectiveRatePerHour).toBeCloseTo(40, 10)
    expect(quote.oee).toBeCloseTo(0.8, 10)
    expect(quote.fromOverride).toBe(false)
    expect(quote.materialId).toBe('M1')
    expect(quote.materialCode).toBe('M-0001')
  })

  it('accepts the SKU CODE a planner types, not only the id', () => {
    const snap = snapshot()
    const byCode = quoteRate(snap, buildIndexes(snap), ' M-0001 ', 'WC1', 'OP-A', 1)
    expect(byCode.status).toBe('resolved')
    expect(byCode.materialId).toBe('M1')
    expect(byCode.ratePerHour).toBeCloseTo(50, 10)
  })

  it('walks the same resolution order as the engine', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      operations: [op({ machineHoursPerBase: 1.25 })],
    })
    const withAlternate = snapshot({ routings: [routing(), alternate] })
    expect(
      quoteRate(withAlternate, buildIndexes(withAlternate), 'M1', 'WC1', 'OP-A', 1).ratePerHour,
    ).toBeCloseTo(80, 10)

    const withOverride = snapshot({
      routings: [routing(), alternate],
      rateOverrides: [{ materialId: 'M1', workCenterId: 'WC1', opId: 'OP-A', ratePerHour: 120 }],
    })
    const quote = quoteRate(withOverride, buildIndexes(withOverride), 'M1', 'WC1', 'OP-A', 1)
    expect(quote.ratePerHour).toBeCloseTo(120, 10)
    // Worth saying out loud in the form: this SKU is already overridden here.
    expect(quote.fromOverride).toBe(true)
  })

  it('finds an operation that only an alternate version carries', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      operations: [op({ opId: 'OP-B', machineHoursPerBase: 4 })],
    })
    const snap = snapshot({ routings: [routing(), alternate] })
    const quote = quoteRate(snap, buildIndexes(snap), 'M1', 'WC1', 'OP-B', 1)
    expect(quote.status).toBe('resolved')
    expect(quote.ratePerHour).toBeCloseTo(25, 10)
  })

  it('says so rather than inventing a number when nothing resolves', () => {
    const snap = snapshot()
    const idx = buildIndexes(snap)

    const unknownSku = quoteRate(snap, idx, 'NOT-A-SKU', 'WC1', 'OP-A', 1)
    expect(unknownSku.status).toBe('unknownMaterial')
    expect(unknownSku.ratePerHour).toBeNull()

    const empty = quoteRate(snap, idx, '   ', 'WC1', 'OP-A', 1)
    expect(empty.status).toBe('unknownMaterial')

    const wrongOp = quoteRate(snap, idx, 'M1', 'WC1', 'OP-Z', 1)
    expect(wrongOp.status).toBe('noOperation')
    expect(wrongOp.ratePerHour).toBeNull()

    const wrongWc = quoteRate(snap, idx, 'M1', 'WC-NOWHERE', 'OP-A', 1)
    expect(wrongWc.status).toBe('noOperation')
    expect(wrongWc.ratePerHour).toBeNull()

    const dead = snapshot({ routings: [routing({ operations: [op({ machineHoursPerBase: 0 })] })] })
    const noRate = quoteRate(dead, buildIndexes(dead), 'M1', 'WC1', 'OP-A', 1)
    expect(noRate.status).toBe('noRate')
    expect(noRate.ratePerHour).toBeNull()
  })

  it('a dead OEE still quotes the nominal rate — the two knobs are independent', () => {
    const snap = snapshot()
    const quote = quoteRate(snap, buildIndexes(snap), 'M1', 'WC1', 'OP-A', 0)
    expect(quote.status).toBe('resolved')
    expect(quote.ratePerHour).toBeCloseTo(50, 10)
    expect(quote.effectiveRatePerHour).toBe(0)
    expect(quote.oee).toBeNull()
  })

  it('the quoted rate is the one the engine would use for the same triple', () => {
    const snap = snapshot({
      rateOverrides: [{ materialId: 'M1', workCenterId: 'WC1', opId: 'OP-A', ratePerHour: 137 }],
    })
    const idx = buildIndexes(snap)
    const engine = resolveOperation(snap, idx, 'M1', firstOp(snap), 0.75)
    const quote = quoteRate(snap, idx, 'M1', 'WC1', 'OP-A', 0.75)
    expect(quote.ratePerHour).toBeCloseTo(engine.ratePerHour, 10)
    expect(quote.effectiveRatePerHour).toBeCloseTo(engine.effectiveRatePerHour, 10)
  })
})

describe('findMaterial / findRoutingOperation', () => {
  it('resolves by id first, then by code', () => {
    const snap = snapshot()
    const idx = buildIndexes(snap)
    expect(findMaterial(snap, idx, 'M1')).toBe('M1')
    expect(findMaterial(snap, idx, 'M-0001')).toBe('M1')
    expect(findMaterial(snap, idx, 'nope')).toBeUndefined()
    expect(findMaterial(snap, idx, '')).toBeUndefined()
  })

  it('prefers the primary version’s operation', () => {
    const alternate = routing({
      id: 'R2',
      version: '0002',
      primary: false,
      operations: [op({ machineHoursPerBase: 1.25 })],
    })
    const snap = snapshot({ routings: [routing(), alternate] })
    const found = findRoutingOperation(buildIndexes(snap), 'M1', 'WC1', 'OP-A')
    expect(found).toBe(firstOp(snap))
  })
})
