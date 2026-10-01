/**
 * Reproduces (and now guards) the headline interaction: drag load off a
 * saturated work center onto one that can take it.
 *
 * The bug this script exists to catch: `resourceMove` used to look for an
 * EXISTING routing version that already ran at the target work center. Routing
 * versions are per (material, plant), so for the overwhelming majority of
 * materials no such version existed, every material was skipped with a warning,
 * and the drag changed nothing at all.
 *
 * Exits non-zero if a representative drag-style move fails to shift machine
 * hours off the source work center and onto the target.
 *
 *   npx vite-node scripts/diag-move.ts
 */

import { buildSnapshot, PROFILES, DEFAULT_PROFILE } from '@/data/factory'
import { runModel, baselineScenario, defaultFilters } from '@/domain/engine'
import { buildIndexes } from '@/domain/indexes'
import type { ModelResult, Scenario, WorkCenterId } from '@/domain/types'

const profile = PROFILES.find((p) => p.id === DEFAULT_PROFILE) ?? PROFILES[0]
if (!profile) throw new Error('no profile')

const snap = buildSnapshot(profile)
const idx = buildIndexes(snap)
const weeks = snap.time.weeks.length
const filters = defaultFilters(snap)

const base = runModel(snap, baselineScenario(), filters)

/** Total machine hours required at one work center across the horizon. */
function machineHours(result: ModelResult, wcId: WorkCenterId): number {
  const grid = result.grids.machine
  const row = grid.workCenterIds.indexOf(wcId)
  if (row < 0) return 0
  let total = 0
  for (let w = 0; w < grid.weekCount; w += 1) total += grid.requiredHours[row * grid.weekCount + w] ?? 0
  return total
}

// --- pick a representative drag: the busiest work center, and a sibling ------
let source: WorkCenterId | null = null
let best = 0
for (const wcId of idx.workCenterOrder) {
  const hours = machineHours(base, wcId)
  if (hours > best) {
    best = hours
    source = wcId
  }
}
if (source === null) throw new Error('no loaded work center found')
const sourceWc = idx.workCenterById.get(source)
if (sourceWc === undefined) throw new Error('source work center vanished')

// A sibling at the same plant with the least load: exactly what the canvas
// offers as the most attractive drop target.
let target: WorkCenterId | null = null
let lowest = Number.POSITIVE_INFINITY
for (const wc of idx.workCentersByPlant.get(sourceWc.plantId) ?? []) {
  if (wc.id === source) continue
  const hours = machineHours(base, wc.id)
  if (hours < lowest) {
    lowest = hours
    target = wc.id
  }
}
if (target === null) throw new Error('no sibling work center to receive the load')

console.log(`profile ${profile.id}: ${snap.materials.length} materials, ${snap.workCenters.length} work centers`)
console.log(`source ${source} — ${machineHours(base, source).toFixed(0)} machine hours baseline`)
console.log(`target ${target} — ${machineHours(base, target).toFixed(0)} machine hours baseline`)

const scenario: Scenario = {
  id: 'drag',
  name: 'Drag',
  description: '',
  colorSlot: 2,
  moves: [
    {
      id: 'm-drag',
      label: `Move everything from ${source} to ${target}`,
      enabled: true,
      seq: 1,
      move: {
        kind: 'resourceMove',
        selector: { kind: 'all' },
        fromWorkCenterId: source,
        toWorkCenterId: target,
        share: 1,
        fromWeek: 0,
        toWeek: weeks - 1,
        allowDualSource: false,
      },
    },
  ],
}

const after = runModel(snap, scenario, filters)

const sourceBefore = machineHours(base, source)
const sourceAfter = machineHours(after, source)
const targetBefore = machineHours(base, target)
const targetAfter = machineHours(after, target)

console.log('\nwork center                 baseline        after move        delta')
for (const [id, b, a] of [
  [source, sourceBefore, sourceAfter],
  [target, targetBefore, targetAfter],
] as const) {
  console.log(
    `${id.padEnd(24)} ${b.toFixed(0).padStart(10)} ${a.toFixed(0).padStart(16)} ${(a - b).toFixed(0).padStart(12)}`,
  )
}
console.log(
  `\nutilisation ${(base.kpis.utilisation * 100).toFixed(1)}% -> ${(after.kpis.utilisation * 100).toFixed(1)}%   overloaded cells ${base.kpis.overloadedCells} -> ${after.kpis.overloadedCells}`,
)

const warnings = after.warnings.filter((w) => /resourceMove/i.test(w))
if (warnings.length > 0) {
  console.log('\nmove warnings:')
  for (const w of warnings) console.log(`  - ${w}`)
}

const offSource = sourceBefore - sourceAfter
const ontoTarget = targetAfter - targetBefore
const ok = offSource > 1 && ontoTarget > 1

console.log(
  `\n>>> ${offSource.toFixed(0)} machine hours left ${source}; ${ontoTarget.toFixed(0)} landed on ${target}.`,
)
if (!ok) {
  console.error('FAIL: the drag moved no hours. resourceMove is inert.')
  process.exit(1)
}
console.log('OK: the drag relocated load.')
