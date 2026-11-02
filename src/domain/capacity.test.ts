import { describe, expect, it } from 'vitest'
import { buildCapacity, buildCeilings, resolveCeiling } from '@/domain/capacity'
import { buildIndexes } from '@/domain/indexes'
import { applyMoves } from '@/domain/moves'
import type {
  CapacityPool,
  DowntimeEvent,
  Plant,
  PoolCapacity,
  Scenario,
  ScenarioMove,
  Snapshot,
  TimeGrid,
  WorkCenter,
} from '@/domain/types'

// Small explicit fixtures: 3 work centers, 4 weeks. Every number below is
// stated here so the arithmetic is checkable by eye.

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

function pool(
  which: CapacityPool,
  count: number,
  shiftsPerDay: number,
  hoursPerShift: number,
  daysPerWeek: number,
  utilisationFactor: number,
): PoolCapacity {
  return { pool: which, count, shiftsPerDay, hoursPerShift, daysPerWeek, utilisationFactor }
}

function workCenter(id: string, plantId: string, pools: PoolCapacity[], extra?: Partial<WorkCenter>): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: id,
    classId: 'C1',
    vintage: 2015,
    pools,
    features: [],
    baseOee: 1,
    status: 'active',
    costRateUsdPerHour: 80,
    co2PerMachineHourKg: 5,
    ...extra,
  }
}

function snapshot(workCenters: WorkCenter[], downtime: DowntimeEvent[]): Snapshot {
  return {
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 0,
      workCenterCount: workCenters.length,
      weekCount: WEEKS,
    },
    time: timeGrid(WEEKS),
    plants: [plant('P1'), plant('P2')],
    features: [],
    machineClasses: [],
    workCenters,
    standardOperations: [],
    families: [],
    groups: [],
    materials: [],
    routings: [],
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime,
    supplyPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    demandPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    inventory: [],
  }
}

/** WC-1: machine 2 x 2 x 8 x 5 x 0.9 = 144 h; labour 3 x 2 x 8 x 5 x 1.0 = 240 h. */
const WC1 = workCenter('WC-1', 'P1', [pool('machine', 2, 2, 8, 5, 0.9), pool('labour', 3, 2, 8, 5, 1)])
/** WC-2: machine and labour both 1 x 1 x 8 x 5 x 1.0 = 40 h. */
const WC2 = workCenter('WC-2', 'P1', [pool('machine', 1, 1, 8, 5, 1), pool('labour', 1, 1, 8, 5, 1)])
/** WC-3: proposed, live from week 2. Both pools 1 x 1 x 10 x 5 x 1.0 = 50 h. */
const WC3 = workCenter('WC-3', 'P2', [pool('machine', 1, 1, 10, 5, 1), pool('labour', 1, 1, 10, 5, 1)], {
  status: 'proposed',
  availableFromWeek: 2,
})

function build(workCenters: WorkCenter[], downtime: DowntimeEvent[] = []) {
  const snap = snapshot(workCenters, downtime)
  const idx = buildIndexes(snap)
  const grids = buildCapacity(snap, idx)
  const rowOf = (wcId: string): number => idx.workCenterRow.get(wcId) ?? -1
  const read = (a: Float64Array, wcId: string, week: number): number =>
    a[rowOf(wcId) * WEEKS + week] ?? Number.NaN
  return { snap, idx, grids, read }
}

describe('buildCapacity — weekly hours arithmetic', () => {
  it('multiplies count x shifts x hours x days x utilisationFactor', () => {
    const { grids, read } = build([WC1, WC2])
    for (let w = 0; w < WEEKS; w++) {
      expect(read(grids.machine, 'WC-1', w)).toBe(144)
      expect(read(grids.labour, 'WC-1', w)).toBe(240)
      expect(read(grids.machine, 'WC-2', w)).toBe(40)
      expect(read(grids.labour, 'WC-2', w)).toBe(40)
    }
    expect(grids.machineDowntime.every((v) => v === 0)).toBe(true)
    expect(grids.labourDowntime.every((v) => v === 0)).toBe(true)
  })

  it('sums multiple pool entries of the same kind', () => {
    const twoMachineGroups = workCenter('WC-X', 'P1', [
      pool('machine', 1, 1, 8, 5, 1),
      pool('machine', 2, 1, 8, 5, 0.5),
      pool('labour', 1, 1, 8, 5, 1),
    ])
    const { grids, read } = build([twoMachineGroups])
    expect(read(grids.machine, 'WC-X', 0)).toBe(40 + 40)
  })
})

describe('buildCapacity — dated downtime', () => {
  const shutdown: DowntimeEvent = {
    id: 'D1',
    workCenterId: 'WC-1',
    kind: 'shutdown',
    status: 'confirmed',
    fromWeek: 1,
    toWeek: 2,
    pools: ['labour'],
    label: 'Collective vacation',
  }

  it('an undefined hoursPerWeek blocks the listed pools entirely, and only those pools', () => {
    const { grids, read } = build([WC1, WC2], [shutdown])
    expect(read(grids.labour, 'WC-1', 0)).toBe(240)
    expect(read(grids.labour, 'WC-1', 1)).toBe(0)
    expect(read(grids.labour, 'WC-1', 2)).toBe(0)
    expect(read(grids.labour, 'WC-1', 3)).toBe(240)
    // Machine is untouched: vacation drains labour, nothing else.
    for (let w = 0; w < WEEKS; w++) expect(read(grids.machine, 'WC-1', w)).toBe(144)
    expect(read(grids.labourDowntime, 'WC-1', 1)).toBe(240)
    expect(read(grids.machineDowntime, 'WC-1', 1)).toBe(0)
    // A different work center is unaffected.
    expect(read(grids.labour, 'WC-2', 1)).toBe(40)
  })

  it('an installation drains both pools', () => {
    const install: DowntimeEvent = {
      id: 'D2',
      workCenterId: 'WC-2',
      kind: 'installation',
      status: 'confirmed',
      fromWeek: 0,
      toWeek: 0,
      pools: ['machine', 'labour'],
      label: 'Commission the cell',
    }
    const { grids, read } = build([WC1, WC2], [install])
    expect(read(grids.machine, 'WC-2', 0)).toBe(0)
    expect(read(grids.labour, 'WC-2', 0)).toBe(0)
    expect(read(grids.machine, 'WC-2', 1)).toBe(40)
  })

  it('hoursPerWeek removes exactly that many hours', () => {
    const partial: DowntimeEvent = {
      id: 'D3',
      workCenterId: 'WC-2',
      kind: 'maintenance',
      status: 'planned',
      fromWeek: 0,
      toWeek: 0,
      pools: ['machine'],
      hoursPerWeek: 10,
      label: 'PM',
    }
    const { grids, read } = build([WC2], [partial])
    expect(read(grids.machine, 'WC-2', 0)).toBe(30)
    expect(read(grids.machineDowntime, 'WC-2', 0)).toBe(10)
    expect(read(grids.labour, 'WC-2', 0)).toBe(40)
  })

  it('floors at zero and never reports removing more hours than existed', () => {
    const oversized: DowntimeEvent = {
      id: 'D4',
      workCenterId: 'WC-2',
      kind: 'project',
      status: 'planned',
      fromWeek: 0,
      toWeek: 0,
      pools: ['machine'],
      hoursPerWeek: 300,
      label: 'Line move',
    }
    const { grids, read } = build([WC2], [oversized])
    expect(read(grids.machine, 'WC-2', 0)).toBe(0)
    expect(read(grids.machineDowntime, 'WC-2', 0)).toBe(40)
  })

  it('overlapping partial events cannot remove more than exists', () => {
    const a: DowntimeEvent = {
      id: 'D5',
      workCenterId: 'WC-2',
      kind: 'maintenance',
      status: 'planned',
      fromWeek: 0,
      toWeek: 0,
      pools: ['machine'],
      hoursPerWeek: 30,
      label: 'PM A',
    }
    const b: DowntimeEvent = { ...a, id: 'D6', hoursPerWeek: 30, label: 'PM B' }
    const { grids, read } = build([WC2], [a, b])
    expect(read(grids.machine, 'WC-2', 0)).toBe(0)
    expect(read(grids.machineDowntime, 'WC-2', 0)).toBe(40)
  })
})

/**
 * REGRESSION. `moves.ts` cannot put "three extra shifts in weeks 20..26" onto
 * `PoolCapacity` — that record carries no dates — so a week-windowed
 * `shiftChange` becomes a `changeover` event holding
 * `oldWeeklyHours - newWeeklyHours`, and an INCREASE is therefore negative.
 * `buildCapacity` used to compute `removed = min(requested, have)` and then
 * `if (removed <= 0) continue`, which silently discarded every one of them: a
 * planner could add shifts over a window and watch nothing happen at all.
 */
describe('buildCapacity — a negative hoursPerWeek ADDS capacity', () => {
  const extraShifts: DowntimeEvent = {
    id: 'D9',
    workCenterId: 'WC-2',
    kind: 'changeover',
    status: 'planned',
    fromWeek: 1,
    toWeek: 2,
    pools: ['machine'],
    hoursPerWeek: -20,
    label: 'Weekend shift: 20h/week more machine',
  }

  it('adds the hours inside the window and only inside it', () => {
    const { grids, read } = build([WC2], [extraShifts])
    expect(read(grids.machine, 'WC-2', 0)).toBe(40)
    expect(read(grids.machine, 'WC-2', 1)).toBe(60)
    expect(read(grids.machine, 'WC-2', 2)).toBe(60)
    expect(read(grids.machine, 'WC-2', 3)).toBe(40)
    // Only the listed pool moves.
    for (let w = 0; w < WEEKS; w++) expect(read(grids.labour, 'WC-2', w)).toBe(40)
  })

  it('records the gain as a negative loss, so nominal - downtime === available', () => {
    const { grids, read } = build([WC2], [extraShifts])
    expect(read(grids.machineDowntime, 'WC-2', 1)).toBe(-20)
    expect(40 - read(grids.machineDowntime, 'WC-2', 1)).toBe(read(grids.machine, 'WC-2', 1))
  })

  it('nets against a removal in the same week', () => {
    const pm: DowntimeEvent = {
      id: 'D10',
      workCenterId: 'WC-2',
      kind: 'maintenance',
      status: 'planned',
      fromWeek: 1,
      toWeek: 1,
      pools: ['machine'],
      hoursPerWeek: 10,
      label: 'PM',
    }
    const { grids, read } = build([WC2], [pm, extraShifts])
    expect(read(grids.machine, 'WC-2', 1)).toBe(40 - 10 + 20)
    expect(read(grids.machineDowntime, 'WC-2', 1)).toBe(10 - 20)
  })

  it('cannot switch on a work center that is dark that week', () => {
    // WC-3 is live from week 2. Adding shifts to a machine that does not exist
    // yet would manufacture capacity out of a date.
    const early: DowntimeEvent = {
      ...extraShifts,
      id: 'D11',
      workCenterId: 'WC-3',
      fromWeek: 0,
      toWeek: 1,
    }
    const { grids, read } = build([WC3], [early])
    expect(read(grids.machine, 'WC-3', 0)).toBe(0)
    expect(read(grids.machine, 'WC-3', 1)).toBe(0)
    expect(read(grids.machineDowntime, 'WC-3', 0)).toBe(0)
    expect(read(grids.machine, 'WC-3', 2)).toBe(50)
  })
})

describe('buildCapacity — a windowed shiftChange survives the round trip', () => {
  it('an increase authored as a move actually reaches the grid', () => {
    // The seam this whole describe block exists for: `applyMoves` writes the
    // event, `buildCapacity` reads it, and nothing tested the two together.
    const snap = snapshot([WC2], [])
    const scenario: Scenario = {
      id: 's',
      name: 's',
      description: '',
      colorSlot: 1,
      moves: [
        {
          id: 'shift-up',
          label: 'Weekend shift',
          enabled: true,
          seq: 1,
          move: {
            kind: 'shiftChange',
            workCenterId: 'WC-2',
            pool: 'machine',
            fromWeek: 1,
            toWeek: 2,
            // 1 x 1 x 8 x 5 x 1 = 40h -> 3 x 1 x 8 x 5 x 1 = 120h.
            count: 3,
          },
        },
      ],
    }
    const moved = applyMoves(snap, scenario).snapshot
    const idx = buildIndexes(moved)
    const grids = buildCapacity(moved, idx)
    const row = idx.workCenterRow.get('WC-2') ?? -1
    expect(grids.machine[row * WEEKS + 0]).toBe(40)
    expect(grids.machine[row * WEEKS + 1]).toBe(120)
    expect(grids.machine[row * WEEKS + 2]).toBe(120)
    expect(grids.machine[row * WEEKS + 3]).toBe(40)
  })
})

describe('buildCapacity — atRisk slip', () => {
  const base: DowntimeEvent = {
    id: 'D7',
    workCenterId: 'WC-2',
    kind: 'qualification',
    status: 'atRisk',
    fromWeek: 0,
    toWeek: 0,
    pools: ['machine'],
    slipWeeks: 2,
    label: 'PPAP may slip',
  }

  it('models the slipped position of an atRisk event, not the planned one', () => {
    const { grids, read } = build([WC2], [base])
    expect(read(grids.machine, 'WC-2', 0)).toBe(40)
    expect(read(grids.machine, 'WC-2', 2)).toBe(0)
    expect(read(grids.machineDowntime, 'WC-2', 2)).toBe(40)
  })

  it('does not slip planned or confirmed events even when slipWeeks is set', () => {
    const { grids, read } = build([WC2], [{ ...base, status: 'planned' }])
    expect(read(grids.machine, 'WC-2', 0)).toBe(0)
    expect(read(grids.machine, 'WC-2', 2)).toBe(40)
  })

  it('clips a slip that runs off the end of the horizon', () => {
    const { grids, read } = build([WC2], [{ ...base, fromWeek: 3, toWeek: 3, slipWeeks: 5 }])
    for (let w = 0; w < WEEKS; w++) expect(read(grids.machine, 'WC-2', w)).toBe(40)
  })
})

describe('buildCapacity — availability windows', () => {
  it('a proposed work center contributes zero before availableFromWeek', () => {
    const { grids, read } = build([WC1, WC3])
    expect(read(grids.machine, 'WC-3', 0)).toBe(0)
    expect(read(grids.machine, 'WC-3', 1)).toBe(0)
    expect(read(grids.machine, 'WC-3', 2)).toBe(50)
    expect(read(grids.machine, 'WC-3', 3)).toBe(50)
    expect(read(grids.labour, 'WC-3', 1)).toBe(0)
    expect(read(grids.labour, 'WC-3', 2)).toBe(50)
  })

  it('downtime inside the dark period removes nothing, because nothing was there', () => {
    const before: DowntimeEvent = {
      id: 'D8',
      workCenterId: 'WC-3',
      kind: 'installation',
      status: 'planned',
      fromWeek: 0,
      toWeek: 1,
      pools: ['machine', 'labour'],
      label: 'Install',
    }
    const { grids, read } = build([WC3], [before])
    expect(read(grids.machineDowntime, 'WC-3', 0)).toBe(0)
    expect(read(grids.machine, 'WC-3', 2)).toBe(50)
  })

  it('an active work center with availableFromWeek is dark before it too', () => {
    const relocated = workCenter('WC-4', 'P1', [pool('machine', 1, 1, 8, 5, 1)], {
      availableFromWeek: 3,
    })
    const { grids, read } = build([relocated])
    expect(read(grids.machine, 'WC-4', 2)).toBe(0)
    expect(read(grids.machine, 'WC-4', 3)).toBe(40)
  })
})

describe('ceilings', () => {
  function move(seq: number, m: ScenarioMove['move'], enabled = true): ScenarioMove {
    return { id: `m${seq}`, label: `move ${seq}`, enabled, seq, move: m }
  }
  function scenario(moves: ScenarioMove[]): Scenario {
    return { id: 's', name: 's', description: '', moves, colorSlot: 1 }
  }

  it('resolves work center over plant over global', () => {
    const ceilings = buildCeilings(
      scenario([
        move(1, { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.9 }),
        move(2, { kind: 'utilisationCeiling', scope: 'plant', plantId: 'P1', ceiling: 0.85 }),
        move(3, { kind: 'utilisationCeiling', scope: 'workCenter', workCenterId: 'WC-1', ceiling: 0.7 }),
      ]),
      0.95,
    )
    expect(resolveCeiling(ceilings, WC1)).toBe(0.7)
    expect(resolveCeiling(ceilings, WC2)).toBe(0.85)
    expect(resolveCeiling(ceilings, WC3)).toBe(0.9)
  })

  it('falls back to the supplied default when the scenario says nothing', () => {
    const ceilings = buildCeilings(scenario([]), 0.92)
    expect(resolveCeiling(ceilings, WC1)).toBe(0.92)
  })

  it('applies moves in seq order regardless of array order, and skips disabled ones', () => {
    const ceilings = buildCeilings(
      scenario([
        move(5, { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.92 }),
        move(1, { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.5 }),
        move(4, { kind: 'utilisationCeiling', scope: 'workCenter', workCenterId: 'WC-2', ceiling: 0.1 }, false),
      ]),
      0.95,
    )
    expect(ceilings.global).toBe(0.92)
    expect(resolveCeiling(ceilings, WC2)).toBe(0.92)
  })

  it('accepts a ceiling above 1, which SAP allows and planners use', () => {
    const ceilings = buildCeilings(
      scenario([move(1, { kind: 'utilisationCeiling', scope: 'plant', plantId: 'P1', ceiling: 1.1 })]),
      0.95,
    )
    expect(resolveCeiling(ceilings, WC1)).toBe(1.1)
  })
})
