import { describe, expect, it } from 'vitest'
import type { CapacityPool, PoolCapacity, WorkCenter } from '@/domain/types'
import { poolOf, shiftPoolNow } from '@/routes/moveEditorDefaults'

function pool(kind: CapacityPool, over: Partial<PoolCapacity>): PoolCapacity {
  return {
    pool: kind,
    count: 1,
    shiftsPerDay: 2,
    hoursPerShift: 8,
    daysPerWeek: 5,
    utilisationFactor: 0.9,
    ...over,
  }
}

function wc(id: string, pools: PoolCapacity[]): WorkCenter {
  return {
    id,
    plantId: 'P1',
    code: id,
    name: id,
    classId: 'C1',
    vintage: 2015,
    pools,
    features: [],
    baseOee: 0.8,
    status: 'active',
    costRateUsdPerHour: 90,
    co2PerMachineHourKg: 12,
  }
}

// Two plants that genuinely disagree: 8 h shifts at one, 7.5 h at the other.
const CENTERS: WorkCenter[] = [
  wc('WC-A', [
    pool('machine', { count: 4, shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 7 }),
    pool('labour', { count: 9, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5 }),
  ]),
  wc('WC-B', [
    pool('machine', { count: 1, shiftsPerDay: 2, hoursPerShift: 7.5, daysPerWeek: 5 }),
    pool('labour', { count: 3, shiftsPerDay: 1, hoursPerShift: 7.5, daysPerWeek: 6 }),
  ]),
]

describe('poolOf', () => {
  it('returns the work center’s own pool', () => {
    expect(poolOf(CENTERS[0], 'machine').count).toBe(4)
    expect(poolOf(CENTERS[0], 'labour').count).toBe(9)
  })

  it('falls back for a work center it has never heard of', () => {
    expect(poolOf(undefined, 'machine').count).toBe(1)
  })

  it('falls back when the work center has no such pool', () => {
    const machineOnly = wc('WC-C', [pool('machine', { count: 2 })])
    expect(poolOf(machineOnly, 'labour').pool).toBe('labour')
    expect(poolOf(machineOnly, 'machine').count).toBe(2)
  })
})

describe('shiftPoolNow', () => {
  it('follows the WORK CENTER selection rather than the first in the list', () => {
    const first = shiftPoolNow(CENTERS, 'WC-A', 'labour')
    const second = shiftPoolNow(CENTERS, 'WC-B', 'labour')
    expect(first.count).toBe(9)
    expect(first.hoursPerShift).toBe(8)
    // The bug: selecting WC-B kept showing WC-A's 8 h shifts and 9 operators.
    expect(second.count).toBe(3)
    expect(second.hoursPerShift).toBe(7.5)
    expect(second.daysPerWeek).toBe(6)
  })

  it('follows the POOL selection — machine and labour are not the same pattern', () => {
    const machine = shiftPoolNow(CENTERS, 'WC-A', 'machine')
    const labour = shiftPoolNow(CENTERS, 'WC-A', 'labour')
    expect(machine.count).toBe(4)
    expect(machine.shiftsPerDay).toBe(3)
    expect(machine.daysPerWeek).toBe(7)
    expect(labour.count).toBe(9)
    expect(labour.shiftsPerDay).toBe(2)
    expect(labour.daysPerWeek).toBe(5)
  })

  it('every one of the four fields is re-read together', () => {
    const now = shiftPoolNow(CENTERS, 'WC-B', 'machine')
    expect([now.count, now.shiftsPerDay, now.hoursPerShift, now.daysPerWeek]).toEqual([
      1, 2, 7.5, 5,
    ])
  })
})
