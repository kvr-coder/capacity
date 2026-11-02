/**
 * `runModel` — the whole engine, in one call.
 *
 * The pipeline, in the only order that is correct:
 *
 *   applyMoves      a NEW snapshot; the input is never touched
 *   buildIndexes    over the MOVED snapshot — a move can add a work center, and
 *                   `workCenterRow` is grid identity for everything after this
 *   buildOeeGrid    the cascade + glide paths, work center x week
 *   buildCapacity   raw shift hours minus DATED downtime. Never x OEE
 *   buildCeilings   planning policy, off the scenario, not the snapshot
 *   resolveSourcing which routing makes what, in which week
 *   buildLoad       the hot path: supply plan -> operation hours -> pool grids
 *   summarise       KPIs over the filtered slice
 *   rankBottlenecks the work centers in trouble, worst first
 *
 * ---------------------------------------------------------------------------
 * Why the clock is a parameter
 * ---------------------------------------------------------------------------
 * `ModelResult.runtimeMs` has to be real or it is worse than useless — a
 * performance number nobody trusts stops being read, and then the regression
 * that adds 300ms ships. But `src/domain` is pure and deterministic by contract
 * (lint forbids `Date.now`), because two runs of the same scenario must produce
 * byte-identical output forever.
 *
 * Both hold if the clock arrives from outside. `RunOptions.now` is a
 * `() => number` the caller supplies; the worker passes `performance.now`, and
 * the default is a monotonic counter that never advances, so tests see
 * `runtimeMs === 0` and can compare whole `ModelResult`s.
 */

import type {
  EngineOptions,
  Filters,
  ModelResult,
  Scenario,
  ScenarioMove,
  Snapshot,
} from '@/domain/types'
import { buildIndexes } from '@/domain/indexes'
import { buildOeeGrid } from '@/domain/oee'
import { buildCapacity, buildCeilings } from '@/domain/capacity'
import { resolveSourcing } from '@/domain/sourcing'
import { buildLoad } from '@/domain/load'
import { applyMoves } from '@/domain/moves'
import { summariseAll } from '@/domain/rollup'
import { rankBottlenecks } from '@/domain/relief'

export const BASELINE_SCENARIO_ID = 'baseline'

/**
 * The default utilisation ceiling is 1.0 — the plan may use every hour that
 * exists. Anything lower is a planning POLICY ("we never load past 92%"), and a
 * policy belongs in a scenario move where a planner can see it and argue with
 * it, not baked into the engine where it would quietly deflate every chart.
 */
export const DEFAULT_UTILISATION_CEILING = 1.0

/** The clock the domain uses when nobody supplies one: pure, and always zero. */
const STOPPED_CLOCK = (): number => 0

export interface RunOptions extends EngineOptions {
  /**
   * Monotonic milliseconds. The worker passes `() => performance.now()`.
   * Omitted, the run reports `runtimeMs: 0`, which keeps the domain pure and
   * makes `ModelResult` directly comparable between runs in tests.
   */
  now?: () => number
}

/**
 * The immutable, empty baseline.
 *
 * Frozen rather than merely `readonly`: the baseline is handed to every screen
 * and to every scenario-comparison call, and a single accidental `push` onto
 * its `moves` array would silently rewrite what "baseline" means for the rest
 * of the session.
 */
export function baselineScenario(): Scenario {
  const moves: ScenarioMove[] = []
  Object.freeze(moves)
  return Object.freeze({
    id: BASELINE_SCENARIO_ID,
    name: 'Baseline',
    description: 'Master data and the supply plan as they stand. No moves.',
    moves,
    colorSlot: 1 as const,
    readonly: true,
  })
}

/** The whole horizon, every plant, every product — what a fresh cockpit shows. */
export function defaultFilters(snap: Snapshot, bucket: Filters['bucket'] = 'week'): Filters {
  return {
    plantIds: [],
    regions: [],
    familyIds: [],
    groupIds: [],
    workCenterIds: [],
    machineClassIds: [],
    fromWeek: 0,
    toWeek: Math.max(0, snap.time.weeks.length - 1),
    bucket,
  }
}

/**
 * Run the model.
 *
 * Every stage that can disagree with master data pushes a warning rather than
 * throwing; they are concatenated in pipeline order, so the list reads as the
 * run happened. A warning is never a silent correction — if a move could not be
 * applied it is named, with the reason and what to do about it.
 */
export function runModel(
  snap: Snapshot,
  scenario: Scenario,
  filters: Filters,
  options: RunOptions = {},
): ModelResult {
  return runModelWithContext(snap, scenario, filters, options).result
}

/**
 * Everything a run produced, for callers that need to ask follow-up questions
 * (roll-ups at other levels, relief searches, SKU slices) without paying for a
 * second explosion. The worker holds one of these per in-flight scenario.
 */
export interface RunContext {
  snapshot: Snapshot
  indexes: ReturnType<typeof buildIndexes>
  load: ReturnType<typeof buildLoad>
  sourcing: ReturnType<typeof resolveSourcing>
  oeeGrid: Float64Array
  capexUsd: number
  freightUsd: number
  warnings: string[]
  result: ModelResult
}

/** `runModel`, keeping the intermediates. Same pipeline, same numbers. */
export function runModelWithContext(
  snap: Snapshot,
  scenario: Scenario,
  filters: Filters,
  options: RunOptions = {},
): RunContext {
  const now = options.now ?? STOPPED_CLOCK
  const startedAt = now()

  const applied = applyMoves(snap, scenario)
  const moved = applied.snapshot
  // Illegal moves were switched off during validation; sourcing and the ceiling
  // resolver must see the corrected log, not the one the planner typed.
  const effective = applied.effectiveScenario

  const idx = buildIndexes(moved)
  const oeeGrid = buildOeeGrid(moved, idx)
  const capacity = buildCapacity(moved, idx)
  const ceilings = buildCeilings(
    effective,
    options.utilisationCeiling ?? DEFAULT_UTILISATION_CEILING,
  )
  const sourcing = resolveSourcing(moved, idx, effective)
  const load = buildLoad(moved, idx, sourcing, capacity, oeeGrid, ceilings)

  // Totals and the weekly series come out of ONE walk over the plan.
  const { total: kpis, byWeek: kpisByWeek } = summariseAll(
    load,
    moved,
    idx,
    filters,
    applied.capexUsd,
  )
  const bottlenecks = rankBottlenecks(moved, idx, load, filters)

  const warnings = [...applied.warnings, ...sourcing.warnings, ...load.warnings]
  if (applied.freightUsd > 0) {
    // Freight is an operating consequence of a WIP transfer, not capex, and
    // `Kpis` has nowhere to carry it. Folding it into `costUsd` would break
    // `costUsd === sum(kpisByWeek.costUsd)`, so it is reported instead.
    warnings.push(
      `WIP transfers in this scenario imply $${Math.round(applied.freightUsd).toLocaleString('en-US')} of freight, which is not included in costUsd.`,
    )
  }

  const result: ModelResult = {
    scenarioId: scenario.id,
    time: moved.time,
    grids: load.grids,
    // `aggregatesOnly` drops the 11,700 judged cells from the payload. The
    // grids they were derived from are still there, so nothing is lost — it is
    // a transport optimisation for the screens that only draw aggregates.
    cells: options.aggregatesOnly === true ? [] : load.cells,
    kpis,
    kpisByWeek,
    bottlenecks,
    oeeByWorkCenterWeek: oeeGrid,
    runtimeMs: now() - startedAt,
    capexUsd: applied.capexUsd,
    warnings,
  }

  return {
    snapshot: moved,
    indexes: idx,
    load,
    sourcing,
    oeeGrid,
    capexUsd: applied.capexUsd,
    freightUsd: applied.freightUsd,
    warnings,
    result,
  }
}
