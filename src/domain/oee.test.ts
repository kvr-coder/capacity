import { describe, expect, it } from 'vitest'
import type {
  OeeGlidePath,
  OeeOverride,
  Plant,
  PoolCapacity,
  Scenario,
  Snapshot,
  WorkCenter,
} from '@/domain/types'
import { buildIndexes } from '@/domain/indexes'
import { OEE_MAX, OEE_MIN, buildOeeGrid, evaluateGlide, resolveOee } from '@/domain/oee'
import { applyMoves, describeMove } from '@/domain/moves'
import { buildTimeGrid } from '@/domain/time'

const WEEKS = 12

const POOLS: PoolCapacity[] = [
  { pool: 'machine', count: 2, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
  { pool: 'labour', count: 4, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
]

function plant(id: string, defaultOee: number): Plant {
  return {
    id,
    code: id,
    name: id,
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

function workCenter(id: string, plantId: string, baseOee: number): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: id,
    classId: 'CLASS-1',
    vintage: 2015,
    pools: POOLS,
    features: [],
    baseOee,
    status: 'active',
    costRateUsdPerHour: 90,
    co2PerMachineHourKg: 4,
  }
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 0,
      workCenterCount: 1,
      weekCount: WEEKS,
    },
    time: buildTimeGrid('2026-09-07', WEEKS),
    plants: [plant('P1', 0.7)],
    features: [],
    machineClasses: [],
    workCenters: [workCenter('WC1', 'P1', 0.8)],
    standardOperations: [],
    families: [],
    groups: [],
    materials: [],
    routings: [],
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [],
    supplyPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    demandPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    inventory: [],
    ...over,
  }
}

function oeeAt(snap: Snapshot, week: number, materialId?: string, wcId = 'WC1'): number {
  const idx = buildIndexes(snap)
  const grid = buildOeeGrid(snap, idx)
  return resolveOee(snap, idx, grid, wcId, materialId, week)
}

const path = (over: Partial<OeeGlidePath> = {}): OeeGlidePath => ({
  id: 'G1',
  scope: 'workCenter',
  workCenterId: 'WC1',
  fromWeek: 2,
  toWeek: 10,
  endValue: 0.9,
  curve: 'linear',
  label: 'ramp',
  ...over,
})

describe('evaluateGlide', () => {
  it('has no effect before fromWeek', () => {
    expect(evaluateGlide(path({ startValue: 0.5 }), 0, 0.62)).toBeCloseTo(0.62, 10)
    expect(evaluateGlide(path({ startValue: 0.5 }), 1, 0.62)).toBeCloseTo(0.62, 10)
  })

  it('interpolates linearly at t = 0, 0.5 and 1', () => {
    const p = path({ startValue: 0.5, endValue: 0.9, curve: 'linear' })
    expect(evaluateGlide(p, 2, 0)).toBeCloseTo(0.5, 10)
    expect(evaluateGlide(p, 6, 0)).toBeCloseTo(0.7, 10)
    expect(evaluateGlide(p, 10, 0)).toBeCloseTo(0.9, 10)
  })

  it('uses smoothstep for sCurve — slow, fast, slow', () => {
    const p = path({ startValue: 0.5, endValue: 0.9, curve: 'sCurve' })
    expect(evaluateGlide(p, 2, 0)).toBeCloseTo(0.5, 10)
    // t = 0.25 -> 0.25^2 * (3 - 0.5) = 0.15625, so well behind the linear ramp.
    expect(evaluateGlide(p, 4, 0)).toBeCloseTo(0.5 + 0.4 * 0.15625, 10)
    expect(evaluateGlide(p, 6, 0)).toBeCloseTo(0.7, 10)
    // Symmetric: t = 0.75 is as far ahead of linear as t = 0.25 was behind.
    expect(evaluateGlide(p, 8, 0)).toBeCloseTo(0.5 + 0.4 * 0.84375, 10)
    expect(evaluateGlide(p, 10, 0)).toBeCloseTo(0.9, 10)
  })

  it('holds the start value until toWeek for a step curve', () => {
    const p = path({ startValue: 0.5, endValue: 0.9, curve: 'step' })
    expect(evaluateGlide(p, 2, 0)).toBeCloseTo(0.5, 10)
    expect(evaluateGlide(p, 9, 0)).toBeCloseTo(0.5, 10)
    expect(evaluateGlide(p, 10, 0)).toBeCloseTo(0.9, 10)
  })

  it('holds endValue after toWeek for every curve', () => {
    for (const curve of ['linear', 'sCurve', 'step'] as const) {
      const p = path({ startValue: 0.5, endValue: 0.9, curve })
      expect(evaluateGlide(p, 11, 0)).toBeCloseTo(0.9, 10)
      expect(evaluateGlide(p, 500, 0)).toBeCloseTo(0.9, 10)
    }
  })

  it('falls back to the passed start value when the path declares none', () => {
    const p = path({ endValue: 0.9, curve: 'linear' })
    expect(evaluateGlide(p, 2, 0.6)).toBeCloseTo(0.6, 10)
    expect(evaluateGlide(p, 6, 0.6)).toBeCloseTo(0.75, 10)
  })

  it('treats a zero-length window as an immediate jump', () => {
    const p = path({ fromWeek: 4, toWeek: 4, endValue: 0.9 })
    expect(evaluateGlide(p, 3, 0.6)).toBeCloseTo(0.6, 10)
    expect(evaluateGlide(p, 4, 0.6)).toBeCloseTo(0.9, 10)
  })
})

describe('OEE cascade precedence', () => {
  it('falls back to the plant default when the work center has no usable base', () => {
    expect(oeeAt(snapshot({ workCenters: [workCenter('WC1', 'P1', 0)] }), 0)).toBeCloseTo(0.7, 10)
  })

  it('prefers the work center base over the plant default', () => {
    expect(oeeAt(snapshot(), 0)).toBeCloseTo(0.8, 10)
  })

  it('prefers a plant override over the work center base', () => {
    const snap = snapshot({ oeeOverrides: [{ scope: 'plant', plantId: 'P1', value: 0.6 }] })
    expect(oeeAt(snap, 0)).toBeCloseTo(0.6, 10)
  })

  it('prefers a work center override over a plant override', () => {
    const overrides: OeeOverride[] = [
      { scope: 'workCenter', workCenterId: 'WC1', value: 0.55 },
      { scope: 'plant', plantId: 'P1', value: 0.6 },
    ]
    // Declaration order must not matter across scopes — specificity decides.
    expect(oeeAt(snapshot({ oeeOverrides: overrides }), 0)).toBeCloseTo(0.55, 10)
    expect(oeeAt(snapshot({ oeeOverrides: [...overrides].reverse() }), 0)).toBeCloseTo(0.55, 10)
  })

  it('applies a windowed override only inside its window', () => {
    const snap = snapshot({
      oeeOverrides: [{ scope: 'workCenter', workCenterId: 'WC1', value: 0.5, fromWeek: 3, toWeek: 5 }],
    })
    expect(oeeAt(snap, 2)).toBeCloseTo(0.8, 10)
    expect(oeeAt(snap, 3)).toBeCloseTo(0.5, 10)
    expect(oeeAt(snap, 5)).toBeCloseTo(0.5, 10)
    expect(oeeAt(snap, 6)).toBeCloseTo(0.8, 10)
  })

  it('lets the later entry win between two overrides of the same scope', () => {
    const snap = snapshot({
      oeeOverrides: [
        { scope: 'workCenter', workCenterId: 'WC1', value: 0.5 },
        { scope: 'workCenter', workCenterId: 'WC1', value: 0.65 },
      ],
    })
    expect(oeeAt(snap, 0)).toBeCloseTo(0.65, 10)
  })

  it('prefers a glide path over a work center override', () => {
    const snap = snapshot({
      oeeOverrides: [{ scope: 'workCenter', workCenterId: 'WC1', value: 0.5 }],
      glidePaths: [path({ startValue: 0.5, endValue: 0.9, fromWeek: 2, toWeek: 10 })],
    })
    expect(oeeAt(snap, 1)).toBeCloseTo(0.5, 10)
    expect(oeeAt(snap, 6)).toBeCloseTo(0.7, 10)
    expect(oeeAt(snap, 11)).toBeCloseTo(0.9, 10)
  })

  it('starts a glide path from whatever resolved at fromWeek', () => {
    const snap = snapshot({
      oeeOverrides: [{ scope: 'workCenter', workCenterId: 'WC1', value: 0.6, fromWeek: 2 }],
      glidePaths: [path({ endValue: 0.8, fromWeek: 2, toWeek: 6 })],
    })
    expect(oeeAt(snap, 1)).toBeCloseTo(0.8, 10) // work center base, before the window
    expect(oeeAt(snap, 2)).toBeCloseTo(0.6, 10) // the override is the start value
    expect(oeeAt(snap, 4)).toBeCloseTo(0.7, 10)
    expect(oeeAt(snap, 6)).toBeCloseTo(0.8, 10)
  })

  it('expands a plant-scope glide path to every work center in the plant', () => {
    const snap = snapshot({
      workCenters: [workCenter('WC1', 'P1', 0.8), workCenter('WC2', 'P1', 0.5)],
      glidePaths: [path({ scope: 'plant', plantId: 'P1', workCenterId: undefined, startValue: 0.5, endValue: 0.9, fromWeek: 0, toWeek: 10 })],
    })
    expect(oeeAt(snap, 5, undefined, 'WC1')).toBeCloseTo(0.7, 10)
    expect(oeeAt(snap, 5, undefined, 'WC2')).toBeCloseTo(0.7, 10)
  })

  it('gives the later fromWeek the win where two glide paths overlap', () => {
    const snap = snapshot({
      glidePaths: [
        path({ id: 'G1', startValue: 0.5, endValue: 0.9, fromWeek: 0, toWeek: 10 }),
        path({ id: 'G2', startValue: 0.4, endValue: 0.6, fromWeek: 4, toWeek: 8 }),
      ],
    })
    expect(oeeAt(snap, 2)).toBeCloseTo(0.58, 10) // G1 alone
    expect(oeeAt(snap, 4)).toBeCloseTo(0.4, 10) // G2 takes over at its fromWeek
    expect(oeeAt(snap, 6)).toBeCloseTo(0.5, 10)
    expect(oeeAt(snap, 9)).toBeCloseTo(0.6, 10) // and holds after its toWeek
  })

  it('prefers a material x work center override over everything', () => {
    const snap = snapshot({
      oeeOverrides: [
        { scope: 'workCenter', workCenterId: 'WC1', value: 0.5 },
        { scope: 'materialWorkCenter', materialId: 'M1', workCenterId: 'WC1', value: 0.42 },
      ],
      glidePaths: [path({ startValue: 0.5, endValue: 0.9, fromWeek: 0, toWeek: 10 })],
    })
    expect(oeeAt(snap, 5, 'M1')).toBeCloseTo(0.42, 10)
    // Another material, and the work center itself, are untouched by it.
    expect(oeeAt(snap, 5, 'M2')).toBeCloseTo(0.7, 10)
    expect(oeeAt(snap, 5)).toBeCloseTo(0.7, 10)
  })

  it('respects the window on a material x work center override', () => {
    const snap = snapshot({
      oeeOverrides: [
        { scope: 'materialWorkCenter', materialId: 'M1', workCenterId: 'WC1', value: 0.42, fromWeek: 4, toWeek: 6 },
      ],
    })
    expect(oeeAt(snap, 3, 'M1')).toBeCloseTo(0.8, 10)
    expect(oeeAt(snap, 4, 'M1')).toBeCloseTo(0.42, 10)
    expect(oeeAt(snap, 7, 'M1')).toBeCloseTo(0.8, 10)
  })
})

describe('clamping and bounds', () => {
  it('clamps every resolved value into the 0.05..0.98 band', () => {
    expect(oeeAt(snapshot({ oeeOverrides: [{ scope: 'workCenter', workCenterId: 'WC1', value: 1.4 }] }), 0)).toBe(OEE_MAX)
    expect(oeeAt(snapshot({ oeeOverrides: [{ scope: 'workCenter', workCenterId: 'WC1', value: 0 }] }), 0)).toBe(OEE_MIN)
    expect(
      oeeAt(
        snapshot({
          oeeOverrides: [
            { scope: 'materialWorkCenter', materialId: 'M1', workCenterId: 'WC1', value: -2 },
          ],
        }),
        0,
        'M1',
      ),
    ).toBe(OEE_MIN)
  })

  it('sizes the grid work centers x weeks and rejects out-of-range reads', () => {
    const snap = snapshot({ workCenters: [workCenter('WC1', 'P1', 0.8), workCenter('WC2', 'P1', 0.6)] })
    const idx = buildIndexes(snap)
    const grid = buildOeeGrid(snap, idx)
    expect(grid).toHaveLength(2 * WEEKS)
    const row2 = idx.workCenterRow.get('WC2') ?? -1
    expect(row2).toBe(1)
    expect(grid[row2 * WEEKS]).toBeCloseTo(0.6, 10)
    expect(() => resolveOee(snap, idx, grid, 'WC1', undefined, WEEKS)).toThrow(/outside the horizon/)
    expect(() => resolveOee(snap, idx, grid, 'NOPE', undefined, 0)).toThrow(/not in the grid/)
  })
})

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('provenance beats the fromWeek rule', () => {
  it('lets a scenario glide beat a seeded glide with a LATER fromWeek', () => {
    // Exactly the shipped shape of the bug: master data ramps the plant from
    // W4, the planner ramps the same plant from W0, and the planner's path was
    // silently overridden for every week from W4 on.
    const snap = snapshot({
      workCenters: [workCenter('WC1', 'P1', 0.8)],
      glidePaths: [
        path({
          id: 'SEEDED',
          scope: 'plant',
          plantId: 'P1',
          workCenterId: undefined,
          startValue: 0.5,
          endValue: 0.6,
          fromWeek: 4,
          toWeek: 8,
          source: 'master',
        }),
        path({
          id: 'USER',
          scope: 'plant',
          plantId: 'P1',
          workCenterId: undefined,
          startValue: 0.7,
          endValue: 0.9,
          fromWeek: 0,
          toWeek: 10,
          source: 'scenario',
        }),
      ],
    })
    expect(oeeAt(snap, 0)).toBeCloseTo(0.7, 10)
    // W4 is where the seeded path used to take over. It no longer does.
    expect(oeeAt(snap, 4)).toBeCloseTo(0.78, 10)
    expect(oeeAt(snap, 10)).toBeCloseTo(0.9, 10)
    expect(oeeAt(snap, 11)).toBeCloseTo(0.9, 10)
  })

  it('keeps the greatest-fromWeek rule inside one provenance tier', () => {
    const snap = snapshot({
      glidePaths: [
        path({ id: 'S1', startValue: 0.5, endValue: 0.9, fromWeek: 0, toWeek: 10, source: 'scenario' }),
        path({ id: 'S2', startValue: 0.4, endValue: 0.6, fromWeek: 4, toWeek: 8, source: 'scenario' }),
      ],
    })
    expect(oeeAt(snap, 2)).toBeCloseTo(0.58, 10)
    expect(oeeAt(snap, 4)).toBeCloseTo(0.4, 10)
    expect(oeeAt(snap, 9)).toBeCloseTo(0.6, 10)
  })

  it('treats an unstamped path as master data, so old snapshots behave as before', () => {
    const snap = snapshot({
      glidePaths: [
        path({ id: 'A', startValue: 0.5, endValue: 0.9, fromWeek: 0, toWeek: 10 }),
        path({ id: 'B', startValue: 0.4, endValue: 0.6, fromWeek: 4, toWeek: 8 }),
      ],
    })
    expect(oeeAt(snap, 4)).toBeCloseTo(0.4, 10)
  })

  it('lets a scenario PLANT override beat a seeded WORK CENTER override', () => {
    // The same defeat in the override cascade: specificity used to be applied
    // before provenance, so a seeded work-center row beat the planner's own
    // plant-wide oeeSet.
    const snap = snapshot({
      oeeOverrides: [
        { scope: 'workCenter', workCenterId: 'WC1', value: 0.5 },
        { scope: 'plant', plantId: 'P1', value: 0.85, source: 'scenario' },
      ],
    })
    expect(oeeAt(snap, 0)).toBeCloseTo(0.85, 10)
  })

  it('still prefers the more specific override when both are master data', () => {
    const snap = snapshot({
      oeeOverrides: [
        { scope: 'plant', plantId: 'P1', value: 0.85 },
        { scope: 'workCenter', workCenterId: 'WC1', value: 0.5 },
      ],
    })
    expect(oeeAt(snap, 0)).toBeCloseTo(0.5, 10)
  })
})

// ---------------------------------------------------------------------------
// A glide may model a decline — but never silently
// ---------------------------------------------------------------------------

function glideScenario(p: OeeGlidePath): Scenario {
  return {
    id: 'S',
    name: 'S',
    description: '',
    colorSlot: 2,
    moves: [{ id: 'm1', label: 'the ramp', enabled: true, seq: 1, move: { kind: 'oeeGlide', path: p } }],
  }
}

describe('a scenario glide against the OEE it starts from', () => {
  const base = (): Snapshot =>
    snapshot({
      workCenters: [workCenter('WC1', 'P1', 0.8), workCenter('WC2', 'P1', 0.75)],
      glidePaths: [
        path({
          id: 'SEEDED',
          scope: 'plant',
          plantId: 'P1',
          workCenterId: undefined,
          startValue: 0.6,
          endValue: 0.65,
          fromWeek: 6,
          toWeek: 9,
        }),
      ],
    })

  it('never lowers OEE when the path states no start value', () => {
    const snap = base()
    const applied = applyMoves(
      snap,
      glideScenario(
        path({
          id: 'USER',
          scope: 'plant',
          plantId: 'P1',
          workCenterId: undefined,
          startValue: undefined,
          endValue: 0.95,
          fromWeek: 0,
          toWeek: 11,
        }),
      ),
    )
    const idx = buildIndexes(applied.snapshot)
    const grid = buildOeeGrid(applied.snapshot, idx)
    // The seeded W6 path used to drag both work centers down to 0.6. It no
    // longer wins, and the ramp starts from where each one already sits.
    for (const [wcId, start] of [['WC1', 0.8], ['WC2', 0.75]] as const) {
      for (let w = 0; w < WEEKS; w += 1) {
        expect(resolveOee(applied.snapshot, idx, grid, wcId, undefined, w)).toBeGreaterThanOrEqual(
          start - 1e-9,
        )
      }
    }
    expect(applied.warnings.filter((m) => m.includes('LOWERS OEE'))).toHaveLength(0)
  })

  it('ACCEPTS a deliberate decline, applies it unclamped, and warns', () => {
    // Forecasting a drop — an ageing asset, a learning curve — is legitimate
    // planning. It must not be rejected or clamped back up to today's value.
    const snap = base()
    const decline = path({
      id: 'USER',
      scope: 'plant',
      plantId: 'P1',
      workCenterId: undefined,
      startValue: 0.7,
      endValue: 0.95,
      fromWeek: 0,
      toWeek: 11,
      label: 'learning curve on the new tool',
    })
    const applied = applyMoves(snap, glideScenario(decline))
    const idx = buildIndexes(applied.snapshot)
    const grid = buildOeeGrid(applied.snapshot, idx)

    // Applied, not rejected: week 0 really is the 70% the planner typed, which
    // is BELOW the 80% WC1 otherwise resolves to.
    expect(resolveOee(applied.snapshot, idx, grid, 'WC1', undefined, 0)).toBeCloseTo(0.7, 10)
    expect(resolveOee(applied.snapshot, idx, grid, 'WC1', undefined, 11)).toBeCloseTo(0.95, 10)

    // And announced.
    const warned = applied.warnings.filter((m) => m.includes('LOWERS OEE'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('learning curve on the new tool')
    expect(warned[0]).toMatch(/\d+ of \d+ work-center weeks/)

    // The auto-generated label must not read as an unqualified improvement.
    const label = describeMove({ kind: 'oeeGlide', path: decline }, buildIndexes(snap))
    expect(label).toContain('below the current')
    expect(label).not.toMatch(/^Ramp OEE at [^—]*from 70\.0% to/)
  })

  it('calls a path that ends below today a decline, not a ramp', () => {
    const snap = base()
    const label = describeMove(
      {
        kind: 'oeeGlide',
        path: path({
          scope: 'plant',
          plantId: 'P1',
          workCenterId: undefined,
          startValue: undefined,
          endValue: 0.6,
          fromWeek: 0,
          toWeek: 11,
        }),
      },
      buildIndexes(snap),
    )
    expect(label.startsWith('Decline OEE at')).toBe(true)
  })
})
