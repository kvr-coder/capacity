/**
 * Available capacity — hours a work center can offer, per pool, per week.
 *
 * The arithmetic is deliberately boring, because it is the number every other
 * number in the cockpit is divided by:
 *
 *     weeklyHours = count x shiftsPerDay x hoursPerShift x daysPerWeek
 *                   x utilisationFactor
 *
 * From that we subtract **dated** downtime only. Unplanned loss is inside OEE
 * and is applied on the demand side (hours per unit), never here — subtracting
 * it twice is the single easiest way to build a capacity model that lies.
 *
 * A `DowntimeEvent` with a NEGATIVE `hoursPerWeek` adds hours instead of
 * removing them. That is not a curiosity: it is the only way `moves.ts` can
 * express "three extra shifts in weeks 20..26", because `PoolCapacity` carries
 * no dates. See the `shiftChange` section of that file's header.
 *
 * Two grids per pool: the hours that survive (`machine` / `labour`) and the
 * hours that were taken away (`machineDowntime` / `labourDowntime`). Both are
 * `Float64Array` indexed `workCenterRow * weekCount + week`, matching
 * `SnapshotIndexes.workCenterRow`.
 */

import type {
  DowntimeEvent,
  PlantId,
  PoolCapacity,
  Scenario,
  Snapshot,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'

/**
 * Available and lost hours, per pool, sized `workCenterCount x weekCount`.
 *
 * `machine[row * weekCount + week]` is what the pool can offer **after**
 * downtime and **before** the utilisation ceiling. The ceiling is a planning
 * policy, not a physical fact, so it is applied where load is judged
 * (`buildLoad`), not where hours are counted.
 */
export interface CapacityGrids {
  machine: Float64Array
  labour: Float64Array
  machineDowntime: Float64Array
  labourDowntime: Float64Array
}

/** Ceilings resolved most-specific-first: work center, then plant, then global. */
export interface CeilingSet {
  global: number
  byPlant: Map<PlantId, number>
  byWorkCenter: Map<WorkCenterId, number>
}

/** Typed-array read under `noUncheckedIndexedAccess`. In-bounds reads are numbers. */
function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

/**
 * Nominal weekly hours for one pool. `utilisationFactor` is the SAP-style
 * factor on the capacity itself (planned efficiency of the *calendar*, e.g.
 * 0.95 for planned breaks) — it is not OEE and it is not a ceiling.
 */
function weeklyHoursOf(pool: PoolCapacity): number {
  const h =
    pool.count * pool.shiftsPerDay * pool.hoursPerShift * pool.daysPerWeek * pool.utilisationFactor
  return Number.isFinite(h) && h > 0 ? h : 0
}

/**
 * First week a work center may contribute.
 *
 * A `proposed` work center does not exist yet, and an `availableFromWeek`
 * dates when any work center (proposed or a relocated active one) comes on
 * line — before that week it contributes zero hours to both pools. A proposed
 * work center with no date is treated as available from week 0: the
 * `addWorkCenter` move is expected to carry the date, and inventing one here
 * would be a precise-looking lie of exactly the kind the model refuses.
 */
function firstAvailableWeek(wc: WorkCenter): WeekIndex {
  const from = wc.availableFromWeek ?? 0
  return from > 0 ? Math.floor(from) : 0
}

/**
 * The week window a downtime event actually occupies.
 *
 * An `atRisk` event with `slipWeeks` is modelled in its **slipped** position,
 * not its planned one. That is a deliberate choice: an at-risk event is a
 * question ("what happens if this install runs three weeks late?"), and
 * showing the planned window would answer a question nobody asked. Planned and
 * confirmed events never slip, even if `slipWeeks` is set on them.
 */
export function slippedWindow(ev: DowntimeEvent): { from: WeekIndex; to: WeekIndex } {
  const slip = ev.status === 'atRisk' ? (ev.slipWeeks ?? 0) : 0
  return { from: ev.fromWeek + slip, to: ev.toWeek + slip }
}

/**
 * Build the available-hours and downtime grids for every work center.
 *
 * Cost is O(workCenters x weeks + downtimeEvents x weeks), which at
 * 150 x 78 is nothing. Nothing here scales with SKUs.
 */
export function buildCapacity(snap: Snapshot, idx: SnapshotIndexes): CapacityGrids {
  const weeks = idx.weekCount
  const wcCount = idx.workCenterOrder.length
  const size = wcCount * weeks

  const machine = new Float64Array(size)
  const labour = new Float64Array(size)
  const machineDowntime = new Float64Array(size)
  const labourDowntime = new Float64Array(size)

  for (const wc of snap.workCenters) {
    const row = idx.workCenterRow.get(wc.id)
    if (row === undefined) continue

    let machHours = 0
    let labHours = 0
    for (const pool of wc.pools) {
      const h = weeklyHoursOf(pool)
      if (pool.pool === 'machine') machHours += h
      else labHours += h
    }

    const from = firstAvailableWeek(wc)
    if (from >= weeks) continue
    const base = row * weeks
    if (machHours > 0) machine.fill(machHours, base + from, base + weeks)
    if (labHours > 0) labour.fill(labHours, base + from, base + weeks)
  }

  for (const ev of snap.downtime) {
    const row = idx.workCenterRow.get(ev.workCenterId)
    if (row === undefined) continue
    const window = slippedWindow(ev)
    const from = window.from > 0 ? window.from : 0
    const to = window.to < weeks - 1 ? window.to : weeks - 1
    if (to < from) continue

    const base = row * weeks
    for (const pool of ev.pools) {
      const avail = pool === 'machine' ? machine : labour
      const lost = pool === 'machine' ? machineDowntime : labourDowntime
      for (let w = from; w <= to; w++) {
        const i = base + w
        const have = f64(avail, i)
        // Nothing to add to and nothing to take from: a work center that is
        // dark this week (before `availableFromWeek`, or already blocked
        // outright) neither loses hours nor gains them.
        if (have <= 0) continue
        // `hoursPerWeek` undefined means the pool is blocked outright — that is
        // what a shutdown means. A number removes that many hours, floored at
        // zero, and overlapping events can never remove more than exists.
        const requested = ev.hoursPerWeek === undefined ? have : ev.hoursPerWeek
        if (requested === 0 || !Number.isFinite(requested)) continue
        if (requested < 0) {
          // A NEGATIVE `hoursPerWeek` ADDS capacity. That is the contract
          // `moves.ts` depends on: `PoolCapacity` carries no dates, so a
          // week-windowed `shiftChange` is expressed as a `changeover` event
          // carrying `oldWeeklyHours - newWeeklyHours`, and an INCREASE is
          // therefore negative. Dropping it here silently deleted every
          // windowed shift increase a planner made. The hours are recorded in
          // the downtime grid as a negative loss so that
          // `nominal - downtime === available` stays true everywhere.
          avail[i] = have - requested
          lost[i] = f64(lost, i) + requested
          continue
        }
        const removed = requested < have ? requested : have
        avail[i] = have - removed
        lost[i] = f64(lost, i) + removed
      }
    }
  }

  return { machine, labour, machineDowntime, labourDowntime }
}

/**
 * Most specific ceiling wins: work center beats plant beats global.
 *
 * A ceiling above 1 is legal (SAP allows over-100% capacity utilisation); the
 * value is used as a multiplier on available hours, so 1.05 means "we accept
 * planning this asset 5% past nominal".
 */
export function resolveCeiling(ceilings: CeilingSet, wc: WorkCenter): number {
  const byWc = ceilings.byWorkCenter.get(wc.id)
  if (byWc !== undefined) return byWc
  const byPlant = ceilings.byPlant.get(wc.plantId)
  if (byPlant !== undefined) return byPlant
  return ceilings.global
}

/**
 * Collect `utilisationCeiling` moves out of a scenario into a resolved set.
 *
 * Moves are read in `seq` order so the scenario reads as a decision log: the
 * last enabled move for a given scope wins. Disabled moves are ignored, never
 * partially applied.
 */
export function buildCeilings(scenario: Scenario, fallback: number): CeilingSet {
  const set: CeilingSet = {
    global: fallback,
    byPlant: new Map<PlantId, number>(),
    byWorkCenter: new Map<WorkCenterId, number>(),
  }

  const ordered = [...scenario.moves].sort((a, b) => a.seq - b.seq)
  for (const entry of ordered) {
    if (!entry.enabled) continue
    const move = entry.move
    if (move.kind !== 'utilisationCeiling') continue
    if (!Number.isFinite(move.ceiling) || move.ceiling < 0) continue

    if (move.scope === 'global') {
      set.global = move.ceiling
    } else if (move.scope === 'plant') {
      if (move.plantId !== undefined) set.byPlant.set(move.plantId, move.ceiling)
    } else if (move.workCenterId !== undefined) {
      set.byWorkCenter.set(move.workCenterId, move.ceiling)
    }
  }

  return set
}
