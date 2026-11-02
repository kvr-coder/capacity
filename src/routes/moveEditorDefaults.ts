/**
 * The values the move form STARTS FROM, resolved out of master data.
 *
 * A move-editor field is one of two things: a new value being created, or a
 * CURRENT value being changed. The second kind has to be fetched, and fetched
 * again whenever the entity it describes changes, or the planner authors a move
 * believing they are adjusting from where things are when they are in fact
 * overwriting with something unrelated.
 *
 * These live outside the component so the resolution can be tested without a
 * DOM — the form's job is to call them on every selection change, and that is
 * all it should be able to get wrong.
 */

import type { CapacityPool, PoolCapacity, WorkCenter } from '@/domain/types'

/**
 * The capacity pool of a work center, or a plausible blank when it has none.
 *
 * The blank is a last resort for a work center that is not in the catalog at
 * all (a proposed asset the form is mid-way through inventing). It is not a
 * default anything real should ever land on.
 */
export function poolOf(wc: WorkCenter | undefined, pool: CapacityPool): PoolCapacity {
  const found = wc?.pools.find((entry) => entry.pool === pool)
  if (found !== undefined) return found
  return {
    pool,
    count: 1,
    shiftsPerDay: 2,
    hoursPerShift: 8,
    daysPerWeek: 5,
    utilisationFactor: 0.9,
  }
}

/**
 * The pool a `shiftChange` form is pointed at, as master data has it TODAY.
 *
 * Every number in that block — count, shifts per day, hours per shift, days per
 * week — is a current value being changed. The form used to read them once,
 * from the first work center in the catalog, and never again: pick another
 * machine or the other pool and you were shown, and would apply, the first
 * one's shift pattern. Plants do not agree on this (7.5 h shifts at one site,
 * 8 h at another) and neither do the machine and labour pools of a single work
 * center, so the stale reading silently rewrote real values rather than merely
 * looking wrong.
 */
export function shiftPoolNow(
  workCenters: readonly WorkCenter[],
  workCenterId: string,
  pool: CapacityPool,
): PoolCapacity {
  return poolOf(
    workCenters.find((wc) => wc.id === workCenterId),
    pool,
  )
}
