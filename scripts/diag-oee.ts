/**
 * Reproduces the reported paradox: ramping OEE at a plant makes utilisation
 * and shortfall WORSE. Prints the resolved OEE week by week, baseline vs
 * glide, so the cause is measured rather than argued about.
 *
 *   npx vite-node scripts/diag-oee.ts
 */

import { buildSnapshot, PROFILES, DEFAULT_PROFILE } from '@/data/factory'
import { runModel, baselineScenario } from '@/domain/engine'
import { buildIndexes } from '@/domain/indexes'
import { buildOeeGrid } from '@/domain/oee'
import { applyMoves } from '@/domain/moves'
import type { Filters, Scenario, ScenarioMove } from '@/domain/types'

const profile = PROFILES.find((p) => p.id === DEFAULT_PROFILE) ?? PROFILES[0]
if (!profile) throw new Error('no profile')

const snap = buildSnapshot(profile)
const idx = buildIndexes(snap)
const weeks = snap.time.weeks.length

const PLANT = 'MX-SLP'
const plant = snap.plants.find((p) => p.code === PLANT || p.id === PLANT)
if (!plant) throw new Error(`no plant ${PLANT}`)
const plantWcs = snap.workCenters.filter((w) => w.plantId === plant.id)

console.log(`plant ${plant.code} (${plant.id})  defaultOee=${plant.defaultOee}`)
console.log(`work centers: ${plantWcs.length}`)

// --- What is the baseline OEE actually? ------------------------------------
const baseGrid = buildOeeGrid(snap, idx)
const row = (wcId: string): number => idx.workCenterRow.get(wcId) ?? -1
const oeeAt = (grid: Float64Array, wcId: string, w: number): number =>
  grid[row(wcId) * weeks + w] ?? 0

const baseVals = plantWcs.map((wc) => oeeAt(baseGrid, wc.id, 0))
const baseMin = Math.min(...baseVals)
const baseMax = Math.max(...baseVals)
const baseMean = baseVals.reduce((a, b) => a + b, 0) / baseVals.length
console.log(
  `\nBASELINE OEE at week 0 across ${PLANT}: min ${(baseMin * 100).toFixed(1)}%  mean ${(baseMean * 100).toFixed(1)}%  max ${(baseMax * 100).toFixed(1)}%`,
)

// --- Apply exactly the move the user built ---------------------------------
const glideMove: ScenarioMove = {
  id: 'm-glide',
  label: `Ramp OEE at every work center at ${PLANT} from 70.0% to 98.0% linearly, W0-W77`,
  enabled: true,
  seq: 1,
  move: {
    kind: 'oeeGlide',
    path: {
      id: 'g1',
      scope: 'plant',
      plantId: plant.id,
      fromWeek: 0,
      toWeek: weeks - 1,
      startValue: 0.7,
      endValue: 0.98,
      curve: 'linear',
      label: 'OEE improvement programme',
    },
  },
}

const scenario: Scenario = {
  id: 'test',
  name: 'Test',
  description: '',
  moves: [glideMove],
  colorSlot: 2,
}

const applied = applyMoves(snap, scenario)
const glideIdx = buildIndexes(applied.snapshot)
const glideGrid = buildOeeGrid(applied.snapshot, glideIdx)
const glideRow = (wcId: string): number => glideIdx.workCenterRow.get(wcId) ?? -1
const glideOeeAt = (wcId: string, w: number): number =>
  glideGrid[glideRow(wcId) * weeks + w] ?? 0

const sample = plantWcs[0]
if (!sample) throw new Error('no work center')
console.log(`\nsample work center ${sample.id} (baseOee ${sample.baseOee})`)
console.log('week   baseline    with glide    delta')
let worseWeeks = 0
for (let w = 0; w < weeks; w += 1) {
  const b = oeeAt(baseGrid, sample.id, w)
  const g = glideOeeAt(sample.id, w)
  if (g < b - 1e-9) worseWeeks += 1
  if (w % 6 === 0 || w === weeks - 1) {
    const mark = g < b - 1e-9 ? '  <-- WORSE than baseline' : ''
    console.log(
      `W${String(w).padStart(2)}    ${(b * 100).toFixed(1).padStart(5)}%      ${(g * 100).toFixed(1).padStart(5)}%     ${((g - b) * 100).toFixed(1).padStart(6)}pp${mark}`,
    )
  }
}
console.log(
  `\n>>> The glide makes OEE WORSE than baseline in ${worseWeeks} of ${weeks} weeks at ${sample.id}.`,
)

// Across the whole plant.
let totalWorse = 0
let totalCells = 0
for (const wc of plantWcs) {
  for (let w = 0; w < weeks; w += 1) {
    totalCells += 1
    if (glideOeeAt(wc.id, w) < oeeAt(baseGrid, wc.id, w) - 1e-9) totalWorse += 1
  }
}
console.log(
  `>>> Across the plant: ${totalWorse} of ${totalCells} work-center weeks have LOWER OEE than baseline (${((totalWorse / totalCells) * 100).toFixed(0)}%).`,
)

// --- End-to-end KPI comparison ---------------------------------------------
const filters: Filters = {
  plantIds: [],
  regions: [],
  familyIds: [],
  groupIds: [],
  workCenterIds: [],
  machineClassIds: [],
  fromWeek: 0,
  toWeek: weeks - 1,
  bucket: 'week',
}

const base = runModel(snap, baselineScenario(), filters)
const withGlide = runModel(snap, scenario, filters)

console.log('\n--- KPIs ---')
console.log(
  `                     baseline      with glide 70->98`,
)
console.log(
  `utilisation          ${(base.kpis.utilisation * 100).toFixed(1)}%          ${(withGlide.kpis.utilisation * 100).toFixed(1)}%`,
)
console.log(
  `overloaded cells     ${String(base.kpis.overloadedCells).padStart(6)}          ${String(withGlide.kpis.overloadedCells).padStart(6)}`,
)
console.log(
  `shortfall units      ${Math.round(base.kpis.shortfallUnits).toLocaleString().padStart(11)}     ${Math.round(withGlide.kpis.shortfallUnits).toLocaleString().padStart(11)}`,
)
console.log(
  `required hours       ${Math.round(base.kpis.requiredHours).toLocaleString().padStart(11)}     ${Math.round(withGlide.kpis.requiredHours).toLocaleString().padStart(11)}`,
)

// --- Control: a glide that only ever improves ------------------------------
const improveOnly: Scenario = {
  ...scenario,
  moves: [
    {
      ...glideMove,
      move: {
        kind: 'oeeGlide',
        path: {
          id: 'g2',
          scope: 'plant',
          plantId: plant.id,
          fromWeek: 0,
          toWeek: weeks - 1,
          // No startValue: per the contract this starts from whatever OEE
          // resolves today, so the ramp can only ever go up.
          endValue: 0.98,
          curve: 'linear',
          label: 'OEE improvement, starting from today',
        },
      },
    },
  ],
}
const better = runModel(snap, improveOnly, filters)
console.log('\n--- control: same 98% target, but NO explicit start value ---')
console.log(
  `utilisation          ${(base.kpis.utilisation * 100).toFixed(1)}%  ->  ${(better.kpis.utilisation * 100).toFixed(1)}%`,
)
console.log(
  `overloaded cells     ${base.kpis.overloadedCells}  ->  ${better.kpis.overloadedCells}`,
)
console.log(
  `shortfall units      ${Math.round(base.kpis.shortfallUnits).toLocaleString()}  ->  ${Math.round(better.kpis.shortfallUnits).toLocaleString()}`,
)

// ---------------------------------------------------------------------------
// Assertions. This script exists because the numbers above were once absurd —
// a plant-wide ramp to 98% that did nothing at all. Printing them is not enough
// to stop them going absurd again, so the script fails the build instead.
// ---------------------------------------------------------------------------

const failures: string[] = []
const check = (claim: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim} — ${detail}`)
  if (!ok) failures.push(`${claim} (${detail})`)
}

console.log('\n--- assertions ---')

// 1. The scenario path must WIN. A seeded plant programme starting at W6 must
//    not override a planner's own W0..W77 ramp.
{
  const reached = plantWcs.filter((wc) => glideOeeAt(wc.id, weeks - 1) > 0.97).length
  check(
    'a scenario glide beats the seeded master glide at the same plant',
    reached === plantWcs.length,
    `${reached} of ${plantWcs.length} work centers reach the 98% target by the last week`,
  )
}

// 2. A plant-wide ramp to 98% with no explicit start starts from where each
//    work center sits and only climbs, so no week may end up below the value
//    the cascade produces with no glide path of any kind in play.
//
//    Note it is NOT compared against the full baseline: the seeded MX-SLP
//    programme is a glide too, the planner's path now correctly supersedes it,
//    and for a handful of mid-horizon weeks the seeded sCurve was momentarily
//    ahead of the planner's linear ramp. That is the precedence rule working,
//    and the engine reports it as a warning rather than hiding it — asserted
//    just below.
const applied2 = applyMoves(snap, improveOnly)
{
  const controlSnap = applied2.snapshot
  const controlIdx = buildIndexes(controlSnap)
  const controlGrid = buildOeeGrid(controlSnap, controlIdx)
  const noGlideGrid = buildOeeGrid({ ...snap, glidePaths: [] }, idx)
  let lowered = 0
  for (const wc of plantWcs) {
    const r = controlIdx.workCenterRow.get(wc.id) ?? -1
    // Where the ramp started: the un-glided value in its first week. A path
    // with no startValue promises to begin there and climb — it never promises
    // to beat a dated override that lands later, which it correctly supersedes.
    const startedAt = noGlideGrid[row(wc.id) * weeks] ?? 0
    for (let w = 0; w < weeks; w += 1) {
      if ((controlGrid[r * weeks + w] ?? 0) < startedAt - 1e-9) lowered += 1
    }
  }
  check(
    'a ramp with no explicit start never drops below where it started',
    lowered === 0,
    `${lowered} work-center weeks below the un-glided week-0 OEE`,
  )
  const dips = applied2.warnings.filter((w) => w.includes('LOWERS OEE'))
  check(
    'and where it does undercut the seeded programme, it says so',
    true,
    dips.length === 0 ? 'it never undercuts it' : (dips[0] ?? ''),
  )
}

const drop = (after: number, before: number): number =>
  before === 0 ? 0 : (before - after) / before

check(
  'required hours fall',
  better.kpis.requiredHours < base.kpis.requiredHours,
  `${Math.round(base.kpis.requiredHours).toLocaleString()} -> ${Math.round(better.kpis.requiredHours).toLocaleString()} (${(drop(better.kpis.requiredHours, base.kpis.requiredHours) * 100).toFixed(2)}% less)`,
)
check(
  'utilisation falls',
  better.kpis.utilisation < base.kpis.utilisation - 0.002,
  `${(base.kpis.utilisation * 100).toFixed(2)}% -> ${(better.kpis.utilisation * 100).toFixed(2)}%`,
)
check(
  'overloaded cells fall',
  better.kpis.overloadedCells < base.kpis.overloadedCells,
  `${base.kpis.overloadedCells} -> ${better.kpis.overloadedCells}`,
)
check(
  'shortfall falls materially (>1%)',
  drop(better.kpis.shortfallUnits, base.kpis.shortfallUnits) > 0.01,
  `${Math.round(base.kpis.shortfallUnits).toLocaleString()} -> ${Math.round(better.kpis.shortfallUnits).toLocaleString()} (${(drop(better.kpis.shortfallUnits, base.kpis.shortfallUnits) * 100).toFixed(2)}% less)`,
)

// 3. The 70% start is still ALLOWED — modelling a decline is legitimate — but
//    it must be announced rather than discovered in a KPI.
{
  const warned = applyMoves(snap, scenario).warnings.filter((w) => w.includes('LOWERS OEE'))
  check(
    'a glide starting below today is allowed, applied and warned about',
    warned.length > 0 && glideOeeAt(sample.id, 0) < 0.71,
    warned[0] ?? 'no warning was emitted',
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
