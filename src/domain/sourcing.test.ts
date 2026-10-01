import { describe, expect, it } from 'vitest'
import { SOURCING_PLANES, resolveSourcing, sourcingIndex } from '@/domain/sourcing'
import { buildIndexes } from '@/domain/indexes'
import { applyMoves } from '@/domain/moves'
import { buildOeeGrid } from '@/domain/oee'
import { buildCapacity, buildCeilings } from '@/domain/capacity'
import { buildLoad } from '@/domain/load'
import { at } from '@/domain/lookup'
import type {
  Material,
  Plant,
  Routing,
  RoutingOperation,
  Scenario,
  ScenarioMove,
  Snapshot,
  TimeGrid,
  WorkCenter,
} from '@/domain/types'

// Fixture: 2 plants, 3 work centers, 2 materials, 4 weeks.
//
//   M1 is made at P1 (routing 0, on WC-1) and at P2 (routing 1, on WC-3).
//   M2 is made at P1 only, with two production versions:
//     routing 2 (primary) on WC-1, routing 3 (alternate) on WC-2.
//
// Supply rows, in order: M1|P1 (0), M1|P2 (1), M2|P1 (2). 100 units every week.

const WEEKS = 4
const ROWS = 3
const PLANE = ROWS * WEEKS

const R_M1_P1 = 0
const R_M1_P2 = 1
const R_M2_P1_PRIMARY = 2
const R_M2_P1_ALT = 3

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

function plant(id: string): Plant {
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
    defaultOee: 1,
    gridIntensity: 0.3,
  }
}

function workCenter(id: string, plantId: string): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: id,
    classId: 'C1',
    vintage: 2015,
    pools: [
      { pool: 'machine', count: 1, shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
      { pool: 'labour', count: 1, shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
    ],
    features: [],
    baseOee: 1,
    status: 'active',
    costRateUsdPerHour: 80,
    co2PerMachineHourKg: 5,
  }
}

function material(id: string, plantIds: string[]): Material {
  return {
    id,
    code: id,
    description: id,
    type: 'FERT',
    groupId: 'G1',
    familyId: 'F1',
    baseUom: 'EA',
    plantIds,
    pricePerUnitUsd: 10,
    materialCostPerUnitUsd: 4,
    abcClass: 'A',
    unitsPerHandlingUnit: 100,
    weightKgPerUnit: 1,
  }
}

function op(workCenterId: string): RoutingOperation {
  return {
    seq: 10,
    opId: 'OP-A',
    workCenterId,
    baseQty: 1,
    setupHours: 0,
    machineHoursPerBase: 0.5,
    labourHoursPerBase: 0.5,
    yield: 1,
  }
}

function routing(
  id: string,
  materialId: string,
  plantId: string,
  workCenterId: string,
  primary: boolean,
  extra?: Partial<Routing>,
): Routing {
  return {
    id,
    materialId,
    plantId,
    version: primary ? '0001' : '0002',
    primary,
    operations: [op(workCenterId)],
    ...extra,
  }
}

function snapshot(routings?: Routing[]): Snapshot {
  const values = new Float64Array(ROWS * WEEKS).fill(100)
  return {
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 2,
      workCenterCount: 3,
      weekCount: WEEKS,
    },
    time: timeGrid(WEEKS),
    plants: [plant('P1'), plant('P2')],
    features: [],
    machineClasses: [],
    workCenters: [workCenter('WC-1', 'P1'), workCenter('WC-2', 'P1'), workCenter('WC-3', 'P2')],
    standardOperations: [],
    families: [{ id: 'F1', code: 'F1', name: 'Family 1' }],
    groups: [{ id: 'G1', familyId: 'F1', code: 'G1', name: 'Group 1' }],
    materials: [material('M1', ['P1', 'P2']), material('M2', ['P1'])],
    routings: routings ?? [
      routing('R-M1-P1', 'M1', 'P1', 'WC-1', true),
      routing('R-M1-P2', 'M1', 'P2', 'WC-3', true),
      routing('R-M2-P1-a', 'M2', 'P1', 'WC-1', true),
      routing('R-M2-P1-b', 'M2', 'P1', 'WC-2', false),
    ],
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [],
    supplyPlan: { rowKeys: ['M1|P1', 'M1|P2', 'M2|P1'], weekCount: WEEKS, values },
    demandPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    inventory: [],
  }
}

function scenario(moves: ScenarioMove[]): Scenario {
  return { id: 's', name: 's', description: '', moves, colorSlot: 1 }
}
function move(seq: number, m: ScenarioMove['move'], enabled = true): ScenarioMove {
  return { id: `m${seq}`, label: `move-${seq}`, enabled, seq, move: m }
}

function run(moves: ScenarioMove[] = [], routings?: Routing[]) {
  const snap = snapshot(routings)
  const idx = buildIndexes(snap)
  const plan = resolveSourcing(snap, idx, scenario(moves))
  const source = (plane: number, row: number, week: number): number =>
    plan.routingOfRow[sourcingIndex(ROWS, WEEKS, plane, row, week)] ?? -99
  const share = (plane: number, row: number, week: number): number =>
    plan.shareOfRow[sourcingIndex(ROWS, WEEKS, plane, row, week)] ?? Number.NaN
  return { snap, idx, plan, source, share }
}

/** Every bucket must hold exactly one source unless the pair was explicitly allowed. */
function bucketsWithTwoSources(routingOfRow: Int32Array): number {
  let n = 0
  for (let i = 0; i < PLANE; i++) if ((routingOfRow[PLANE + i] ?? -1) >= 0) n++
  return n
}

describe('resolveSourcing — baseline', () => {
  it('uses the primary production version for every week of every supply row', () => {
    const { source, share, plan } = run()
    for (let w = 0; w < WEEKS; w++) {
      expect(source(0, 0, w)).toBe(R_M1_P1)
      expect(source(0, 1, w)).toBe(R_M1_P2)
      expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
      expect(share(0, 0, w)).toBe(1)
    }
    expect(bucketsWithTwoSources(plan.routingOfRow)).toBe(0)
    expect(plan.dualSourced.size).toBe(0)
    expect(plan.warnings).toEqual([])
  })

  it('allocates exactly two planes', () => {
    const { plan } = run()
    expect(SOURCING_PLANES).toBe(2)
    expect(plan.routingOfRow.length).toBe(PLANE * 2)
    expect(plan.shareOfRow.length).toBe(PLANE * 2)
  })

  it('falls back to an alternate version outside the primary validity window', () => {
    const routings: Routing[] = [
      routing('R-M1-P1', 'M1', 'P1', 'WC-1', true, { validToWeek: 1 }),
      routing('R-M1-P2', 'M1', 'P2', 'WC-3', true),
      routing('R-M2-P1-a', 'M2', 'P1', 'WC-1', true),
      routing('R-M2-P1-b', 'M2', 'P1', 'WC-2', false),
    ]
    // Give M1|P1 an alternate that is valid later.
    routings.push(routing('R-M1-P1-alt', 'M1', 'P1', 'WC-2', false, { validFromWeek: 2 }))
    const { source } = run([], routings)
    expect(source(0, 0, 0)).toBe(0)
    expect(source(0, 0, 1)).toBe(0)
    expect(source(0, 0, 2)).toBe(4)
    expect(source(0, 0, 3)).toBe(4)
  })

  it('leaves a row with no routing at all as -1', () => {
    const routings: Routing[] = [
      routing('R-M1-P1', 'M1', 'P1', 'WC-1', true),
      routing('R-M1-P2', 'M1', 'P2', 'WC-3', true),
    ]
    const { source } = run([], routings)
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(-1)
  })
})

describe('resolveSourcing — sourceSwitch is a transfer, not dual sourcing', () => {
  it('changes the source between weeks with a clean cut and stays single-source', () => {
    const { source, share, plan } = run([
      move(1, {
        kind: 'sourceSwitch',
        selector: { kind: 'material', id: 'M1' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 2,
        overlapWeeks: 0,
      }),
    ])
    expect(source(0, 0, 0)).toBe(R_M1_P1)
    expect(source(0, 0, 1)).toBe(R_M1_P1)
    expect(source(0, 0, 2)).toBe(R_M1_P2)
    expect(source(0, 0, 3)).toBe(R_M1_P2)
    for (let w = 0; w < WEEKS; w++) expect(share(0, 0, w)).toBe(1)
    expect(bucketsWithTwoSources(plan.routingOfRow)).toBe(0)
    expect(plan.dualSourced.size).toBe(0)
  })

  it('overlapWeeks permits a parallel run, and only inside the overlap', () => {
    const { source, share, plan } = run([
      move(1, {
        kind: 'sourceSwitch',
        selector: { kind: 'material', id: 'M1' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 2,
        overlapWeeks: 1,
      }),
    ])
    // Week 2 runs both sources; week 3 is the target alone.
    expect(source(0, 0, 2)).toBe(R_M1_P2)
    expect(source(1, 0, 2)).toBe(R_M1_P1)
    expect(share(0, 0, 2) + share(1, 0, 2)).toBe(1)
    expect(source(1, 0, 3)).toBe(-1)
    expect(source(0, 0, 3)).toBe(R_M1_P2)
    expect(plan.dualSourced.has('M1|P1')).toBe(true)
    expect(bucketsWithTwoSources(plan.routingOfRow)).toBe(1)
  })

  it('never touches a material outside the selector', () => {
    const { source } = run([
      move(1, {
        kind: 'sourceSwitch',
        selector: { kind: 'material', id: 'M1' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 0,
        overlapWeeks: 0,
      }),
    ])
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
  })

  it('warns rather than silently doing nothing when the target plant has no routing', () => {
    const { plan, source } = run([
      move(1, {
        kind: 'sourceSwitch',
        selector: { kind: 'material', id: 'M2' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 1,
        overlapWeeks: 0,
      }),
    ])
    expect(plan.warnings.join(' ')).toContain('no routing at target plant P2')
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
  })

  it('is driven by a group selector as well as a single material', () => {
    const { source } = run([
      move(1, {
        kind: 'sourceSwitch',
        selector: { kind: 'group', id: 'G1' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 1,
        overlapWeeks: 0,
      }),
    ])
    expect(source(0, 0, 1)).toBe(R_M1_P2)
  })
})

describe('resolveSourcing — the single-source rule', () => {
  const partial = {
    kind: 'resourceMove' as const,
    selector: { kind: 'material' as const, id: 'M2' },
    fromWorkCenterId: 'WC-1',
    toWorkCenterId: 'WC-2',
    fromWeek: 1,
    toWeek: 2,
    share: 0.4,
  }

  it('rejects a partial move when allowDualSource is off, and says why', () => {
    const { plan, source } = run([move(1, { ...partial, allowDualSource: false })])
    expect(bucketsWithTwoSources(plan.routingOfRow)).toBe(0)
    expect(plan.dualSourced.size).toBe(0)
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
    const text = plan.warnings.join(' ')
    expect(text).toContain('rejected')
    expect(text).toContain('dual sourcing')
    expect(text).toContain('allowDualSource')
  })

  it('accepts the same move when allowDualSource is on, splitting the shares', () => {
    const { plan, source, share } = run([move(1, { ...partial, allowDualSource: true })])
    expect(source(0, 2, 0)).toBe(R_M2_P1_PRIMARY)
    expect(source(1, 2, 0)).toBe(-1)
    for (const w of [1, 2]) {
      expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
      expect(source(1, 2, w)).toBe(R_M2_P1_ALT)
      expect(share(0, 2, w)).toBeCloseTo(0.6, 12)
      expect(share(1, 2, w)).toBeCloseTo(0.4, 12)
      expect(share(0, 2, w) + share(1, 2, w)).toBeCloseTo(1, 12)
    }
    expect(source(1, 2, 3)).toBe(-1)
    expect(plan.dualSourced.has('M2|P1')).toBe(true)
  })

  it('a whole-volume move is a transfer: single source, legal with the flag off', () => {
    const { plan, source, share } = run([
      move(1, { ...partial, share: 1, allowDualSource: false }),
    ])
    expect(source(0, 2, 0)).toBe(R_M2_P1_PRIMARY)
    expect(source(0, 2, 1)).toBe(R_M2_P1_ALT)
    expect(source(0, 2, 2)).toBe(R_M2_P1_ALT)
    expect(source(0, 2, 3)).toBe(R_M2_P1_PRIMARY)
    expect(share(0, 2, 1)).toBe(1)
    expect(bucketsWithTwoSources(plan.routingOfRow)).toBe(0)
    expect(plan.dualSourced.size).toBe(0)
    expect(plan.warnings).toEqual([])
  })

  it('warns when no routing version runs on the target work center', () => {
    const { plan, source } = run([
      move(1, { ...partial, toWorkCenterId: 'WC-3', share: 1, allowDualSource: false }),
    ])
    expect(plan.warnings.join(' ')).toContain('no routing version that runs on WC-3')
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
  })

  it('warns when the move matches nothing rather than passing silently', () => {
    const { plan } = run([
      move(1, { ...partial, fromWorkCenterId: 'WC-2', share: 1, allowDualSource: false }),
    ])
    expect(plan.warnings.join(' ')).toContain('changed nothing')
  })

  it('ignores disabled moves', () => {
    const { plan, source } = run([move(1, { ...partial, share: 1, allowDualSource: false }, false)])
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
    expect(plan.warnings).toEqual([])
  })

  it('rejects a non-positive share', () => {
    const { plan } = run([move(1, { ...partial, share: 0, allowDualSource: true })])
    expect(plan.warnings.join(' ')).toContain('not a positive fraction')
  })

  it('applies moves in seq order so the last decision wins', () => {
    const { source } = run([
      move(2, { ...partial, share: 1, allowDualSource: false, fromWorkCenterId: 'WC-2', toWorkCenterId: 'WC-1' }),
      move(1, { ...partial, share: 1, allowDualSource: false }),
    ])
    // seq 1 moves M2 onto WC-2 for weeks 1..2; seq 2 moves it straight back.
    for (let w = 0; w < WEEKS; w++) expect(source(0, 2, w)).toBe(R_M2_P1_PRIMARY)
  })

  it('a later switch collapsing a dual bucket clears the stale dualSourced flag', () => {
    const { plan } = run([
      move(1, {
        kind: 'sourceSwitch',
        selector: { kind: 'material', id: 'M1' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 2,
        overlapWeeks: 2,
      }),
      move(2, {
        kind: 'sourceSwitch',
        selector: { kind: 'material', id: 'M1' },
        fromPlantId: 'P1',
        toPlantId: 'P2',
        switchWeek: 0,
        overlapWeeks: 0,
      }),
    ])
    expect(bucketsWithTwoSources(plan.routingOfRow)).toBe(0)
    expect(plan.dualSourced.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The seam between moves.ts and sourcing.ts
// ---------------------------------------------------------------------------

/**
 * The whole pipeline a drag actually goes through, so the assertion is on
 * HOURS and not on an index. `resolveSourcing` can only point a supply row at a
 * routing that exists; `applyMoves` is what has to mint one.
 */
function machineHoursByWorkCenter(moves: ScenarioMove[]): Map<string, number> {
  const snap = snapshot()
  const applied = applyMoves(snap, scenario(moves))
  const moved = applied.snapshot
  const idx = buildIndexes(moved)
  const oee = buildOeeGrid(moved, idx)
  const capacity = buildCapacity(moved, idx)
  const ceilings = buildCeilings(applied.effectiveScenario, 1)
  const plan = resolveSourcing(moved, idx, applied.effectiveScenario)
  const load = buildLoad(moved, idx, plan, capacity, oee, ceilings)
  const grid = load.grids.machine
  const out = new Map<string, number>()
  for (let row = 0; row < grid.workCenterIds.length; row++) {
    const id = grid.workCenterIds[row]
    if (id === undefined) continue
    let total = 0
    for (let w = 0; w < grid.weekCount; w++) total += grid.requiredHours[row * grid.weekCount + w] ?? 0
    out.set(id, total)
  }
  return out
}

describe('resourceMove onto a work center with no pre-existing routing version', () => {
  // M1 at P1 runs only on WC-1, and master data carries NO version of it that
  // runs on WC-2. This is the common case, and it used to be skipped with a
  // warning, which made the product's headline interaction inert.
  const drag: ScenarioMove['move'] = {
    kind: 'resourceMove',
    selector: { kind: 'material', id: 'M1' },
    fromWorkCenterId: 'WC-1',
    toWorkCenterId: 'WC-2',
    fromWeek: 0,
    toWeek: WEEKS - 1,
    share: 1,
    allowDualSource: false,
  }

  it('relocates the volume instead of warning about it', () => {
    const before = machineHoursByWorkCenter([])
    const after = machineHoursByWorkCenter([move(1, drag)])

    const sourceBefore = before.get('WC-1') ?? 0
    const sourceAfter = after.get('WC-1') ?? 0
    const targetBefore = before.get('WC-2') ?? 0
    const targetAfter = after.get('WC-2') ?? 0

    expect(sourceBefore).toBeGreaterThan(0)
    expect(sourceAfter).toBeLessThan(sourceBefore)
    expect(targetAfter).toBeGreaterThan(targetBefore)
    // The two work centers are identical here, so nothing may appear or vanish
    // in the move: what left one arrives at the other.
    expect(sourceBefore - sourceAfter).toBeCloseTo(targetAfter - targetBefore, 9)
  })

  it('synthesises exactly one scenario-sourced version, deterministically', () => {
    const snap = snapshot()
    const first = applyMoves(snap, scenario([move(1, drag)])).snapshot
    const second = applyMoves(snap, scenario([move(1, drag)])).snapshot
    const synthesised = first.routings.filter((r) => r.source === 'scenario')
    expect(synthesised).toHaveLength(1)
    expect(second.routings.map((r) => r.id)).toEqual(first.routings.map((r) => r.id))

    const version = at(synthesised, 0, 'synthesised routing')
    expect(version.primary).toBe(false)
    expect(version.materialId).toBe('M1')
    expect(version.plantId).toBe('P1')
    expect(version.operations.map((o) => o.workCenterId)).toEqual(['WC-2'])
    // Master data is never rewritten, only appended to.
    expect(snap.routings.some((r) => r.source === 'scenario')).toBe(false)
    expect(first.routings.slice(0, snap.routings.length)).toEqual(snap.routings)
  })

  it('still refuses a target that cannot run the operation at all', () => {
    // WC-3 appears in no routing at all here: it is approved for nothing, and
    // with no standard operation on file its feature requirements are unknown
    // — "we do not know what this needs" is not "it needs nothing".
    const snap = snapshot([
      routing('R-M1-P1', 'M1', 'P1', 'WC-1', true),
      routing('R-M2-P1-a', 'M2', 'P1', 'WC-1', true),
      routing('R-M2-P1-b', 'M2', 'P1', 'WC-2', false),
    ])
    const applied = applyMoves(
      snap,
      scenario([move(1, { ...drag, toWorkCenterId: 'WC-3' })]),
    )
    expect(applied.snapshot.routings.some((r) => r.source === 'scenario')).toBe(false)
    expect(applied.warnings.join(' ')).toContain('not approved')
    expect(at(applied.effectiveScenario.moves, 0, 'move').enabled).toBe(false)
  })
})
