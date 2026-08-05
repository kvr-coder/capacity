/**
 * Calibration diagnostic.
 *
 * Runs the factory and the engine outside the browser and reports the actual
 * load distribution, so a claim like "the baseline is too hot" is measured
 * rather than eyeballed off a screenshot.
 *
 * Every band the dataset is contracted to hit is printed with a PASS/FAIL and
 * the process exits non-zero if any of them is missed — so this is a check, not
 * a report somebody has to read carefully.
 *
 *   npx vite-node scripts/diagnose.ts [profile]
 */

import { buildSnapshot, PROFILES, DEFAULT_PROFILE } from '@/data/factory'
import { runModel, baselineScenario } from '@/domain/engine'
import type { Filters } from '@/domain/types'

const profileId = process.argv[2] ?? DEFAULT_PROFILE
const profile = PROFILES.find((p) => p.id === profileId) ?? PROFILES[0]
if (!profile) throw new Error(`no profile ${profileId}`)

console.log(`profile=${profile.id} skus=${profile.skuCount} wc=${profile.workCenterCount} weeks=${profile.weekCount}`)

const t0 = Date.now()
const snap = buildSnapshot(profile)
console.log(`built snapshot in ${Date.now() - t0}ms`)

const filters: Filters = {
  plantIds: [],
  regions: [],
  familyIds: [],
  groupIds: [],
  workCenterIds: [],
  machineClassIds: [],
  fromWeek: 0,
  toWeek: snap.time.weeks.length - 1,
  bucket: 'week',
}

const t1 = Date.now()
const result = runModel(snap, baselineScenario(), filters)
console.log(`ran model in ${Date.now() - t1}ms (reported ${result.runtimeMs}ms)`)

const weeks = snap.time.weeks.length
const wcCount = snap.workCenters.length
const cells = wcCount * weeks

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

// Per-work-center peak and mean utilisation across the horizon.
const peak = new Map<string, number>()
const sumUtil = new Map<string, number>()
const overWeeks = new Map<string, number>()
const peakPool = new Map<string, 'machine' | 'labour'>()

for (const cell of result.cells) {
  const u = cell.utilisation
  if (u > (peak.get(cell.workCenterId) ?? -1)) {
    peak.set(cell.workCenterId, u)
    peakPool.set(cell.workCenterId, cell.bindingPool)
  }
  sumUtil.set(cell.workCenterId, (sumUtil.get(cell.workCenterId) ?? 0) + u)
  if (u > 1) overWeeks.set(cell.workCenterId, (overWeeks.get(cell.workCenterId) ?? 0) + 1)
}

const rows = snap.workCenters.map((wc) => ({
  id: wc.id,
  plant: wc.plantId,
  peak: peak.get(wc.id) ?? 0,
  pool: peakPool.get(wc.id) ?? 'machine',
  mean: (sumUtil.get(wc.id) ?? 0) / weeks,
  over: overWeeks.get(wc.id) ?? 0,
}))

const overCeiling = rows.filter((r) => r.peak > 1)
const overTwice = rows.filter((r) => r.peak > 2)
const under40 = rows.filter((r) => r.mean < 0.4).length
const dead = rows.filter((r) => r.mean === 0).length
const machineBound = overCeiling.filter((r) => r.pool === 'machine').length
const labourBound = overCeiling.filter((r) => r.pool === 'labour').length
const overloadedPlants = new Set(overCeiling.map((r) => r.plant)).size

let rawSupply = 0
for (let i = 0; i < snap.supplyPlan.values.length; i++) rawSupply += f64(snap.supplyPlan.values, i)
let rawDemand = 0
for (let i = 0; i < snap.demandPlan.values.length; i++) rawDemand += f64(snap.demandPlan.values, i)

// Network utilisation by third of the horizon — the shape has to tighten.
const third = Math.floor(weeks / 3)
const thirds = [0, 1, 2].map(() => ({ req: 0, avail: 0 }))
for (const cell of result.cells) {
  const bucket = cell.week < third ? 0 : cell.week < 2 * third ? 1 : 2
  const entry = thirds[bucket]
  if (entry === undefined) continue
  entry.req += cell.machineRequired
  entry.avail += cell.machineAvailable
}
const thirdUtil = thirds.map((t) => (t.avail > 0 ? t.req / t.avail : 0))

// When do the bottlenecks arrive?
const firstOverWeek = new Map<string, number>()
for (const cell of result.cells) {
  if (cell.utilisation <= 1) continue
  const seen = firstOverWeek.get(cell.workCenterId)
  if (seen === undefined || cell.week < seen) firstOverWeek.set(cell.workCenterId, cell.week)
}
const arrivals = [...firstOverWeek.values()].sort((a, b) => a - b)
const medianArrival = arrivals.length > 0 ? (arrivals[Math.floor(arrivals.length / 2)] ?? 0) : 0
const overloadedCellsFirstThird = result.cells.filter((c) => c.utilisation > 1 && c.week < third).length

rows.sort((a, b) => b.peak - a.peak)

console.log('\n--- headline ---')
console.log(`network utilisation      ${(result.kpis.utilisation * 100).toFixed(1)}%`)
console.log(`peak utilisation         ${(result.kpis.peakUtilisation * 100).toFixed(1)}%`)
console.log(
  `overloaded cells         ${result.kpis.overloadedCells} / ${cells}  (${((result.kpis.overloadedCells / cells) * 100).toFixed(1)}%)`,
)
console.log(
  `shortfall units          ${Math.round(result.kpis.shortfallUnits).toLocaleString()}  (${((result.kpis.shortfallUnits / result.kpis.supplyUnits) * 100).toFixed(2)}% of supply)`,
)
console.log(`supply units             ${Math.round(result.kpis.supplyUnits).toLocaleString()}`)
console.log(`demand units             ${Math.round(result.kpis.demandUnits).toLocaleString()}`)
console.log(`required hours           ${Math.round(result.kpis.requiredHours).toLocaleString()}`)
console.log(`available hours          ${Math.round(result.kpis.availableHours).toLocaleString()}`)
console.log(`setup share of hours     ${((result.kpis.setupHours / result.kpis.requiredHours) * 100).toFixed(1)}%`)
console.log(`plan demand / supply     ${(rawDemand / rawSupply).toFixed(3)}`)

console.log('\n--- horizon shape (machine utilisation by third) ---')
console.log(`  first ${thirdUtil[0]?.toFixed(3)}   middle ${thirdUtil[1]?.toFixed(3)}   last ${thirdUtil[2]?.toFixed(3)}`)
console.log(`  overloaded cells in the first third: ${overloadedCellsFirstThird}`)
console.log(`  median week a bottleneck first crosses its ceiling: ${medianArrival} of ${weeks}`)

console.log('\n--- distribution ---')
console.log(
  `work centers peak > 1.0   ${overCeiling.length} / ${wcCount}   (machine-bound ${machineBound}, labour-bound ${labourBound}, ${overloadedPlants} plants)`,
)
console.log(`work centers peak > 2.0   ${overTwice.length}`)
console.log(`work centers mean < 0.40  ${under40}`)
console.log(`work centers never used   ${dead}`)

console.log('\n--- hottest 12 ---')
for (const r of rows.slice(0, 12)) {
  console.log(
    `  ${r.id.padEnd(14)} ${r.plant.padEnd(8)} peak ${(r.peak * 100).toFixed(0).padStart(5)}%  mean ${(r.mean * 100).toFixed(0).padStart(4)}%  ${String(r.over).padStart(2)}w over  ${r.pool}`,
  )
}
console.log('\n--- coldest 8 ---')
for (const r of rows.slice(-8)) {
  console.log(`  ${r.id.padEnd(14)} ${r.plant.padEnd(8)} peak ${(r.peak * 100).toFixed(0).padStart(5)}%  mean ${(r.mean * 100).toFixed(0).padStart(4)}%`)
}

// Where does the load actually sit? Hours by plant.
const hoursByPlant = new Map<string, { req: number; avail: number }>()
const plantOf = new Map<string, string>()
for (const wc of snap.workCenters) plantOf.set(wc.id, wc.plantId)
for (const cell of result.cells) {
  const plantId = plantOf.get(cell.workCenterId)
  if (plantId === undefined) continue
  const e = hoursByPlant.get(plantId) ?? { req: 0, avail: 0 }
  e.req += cell.machineRequired
  e.avail += cell.machineAvailable
  hoursByPlant.set(plantId, e)
}
console.log('\n--- machine hours by plant ---')
for (const [plant, e] of hoursByPlant) {
  console.log(
    `  ${plant.padEnd(8)} required ${Math.round(e.req).toLocaleString().padStart(12)}  available ${Math.round(e.avail).toLocaleString().padStart(12)}  ${((e.req / e.avail) * 100).toFixed(0)}%`,
  )
}

// ---------------------------------------------------------------------------
// The bands, as a check rather than a report
// ---------------------------------------------------------------------------

interface Band {
  label: string
  value: string
  ok: boolean
}

/**
 * Three of the bands are COUNTS of work centers, and they were written for the
 * 150-work-center standard profile. "Twelve to thirty assets over their
 * ceiling" is 8-20% of that network; on the forty-work-center demo profile the
 * same absolute numbers would demand that a third of the network is in trouble
 * while ninety percent of the cells are not, which is arithmetically
 * impossible. Counts are therefore scaled by network size; every ratio band is
 * left exactly as written.
 */
const scale = wcCount / 150
const scaled = (value: number, floor: number): number => Math.max(floor, Math.round(value * scale))

const bands: Band[] = [
  {
    label: 'network utilisation 0.76 - 0.86',
    value: result.kpis.utilisation.toFixed(3),
    ok: result.kpis.utilisation >= 0.76 && result.kpis.utilisation <= 0.86,
  },
  {
    label: 'peak utilisation <= 1.60',
    value: result.kpis.peakUtilisation.toFixed(3),
    ok: result.kpis.peakUtilisation <= 1.6,
  },
  {
    label: `work centers peak > 1.0 in ${scaled(12, 3)} - ${scaled(30, 8)}`,
    value: `${overCeiling.length}`,
    ok: overCeiling.length >= scaled(12, 3) && overCeiling.length <= scaled(30, 8),
  },
  { label: 'work centers peak > 2.0 == 0', value: `${overTwice.length}`, ok: overTwice.length === 0 },
  {
    label: `work centers mean < 0.40 >= ${scaled(15, 4)}`,
    value: `${under40}`,
    ok: under40 >= scaled(15, 4),
  },
  {
    label: 'overloaded cells <= 8% of all cells',
    value: `${((result.kpis.overloadedCells / cells) * 100).toFixed(2)}%`,
    ok: result.kpis.overloadedCells <= cells * 0.08,
  },
  {
    label: 'shortfall <= 3% of supply units',
    value: `${((result.kpis.shortfallUnits / result.kpis.supplyUnits) * 100).toFixed(2)}%`,
    ok: result.kpis.shortfallUnits <= result.kpis.supplyUnits * 0.03,
  },
  {
    label: 'demand exceeds supply by 6 - 14%',
    value: `${((rawDemand / rawSupply - 1) * 100).toFixed(1)}%`,
    ok: rawDemand / rawSupply >= 1.06 && rawDemand / rawSupply <= 1.14,
  },
  { label: 'machine-bound bottlenecks >= 3', value: `${machineBound}`, ok: machineBound >= 3 },
  { label: 'labour-bound bottlenecks >= 3', value: `${labourBound}`, ok: labourBound >= 3 },
  {
    label: 'overloaded set spans >= 3 plants',
    value: `${overloadedPlants}`,
    ok: overloadedPlants >= 3,
  },
  {
    label: 'horizon tightens (last third over first third)',
    value: `${thirdUtil[0]?.toFixed(3)} -> ${thirdUtil[2]?.toFixed(3)}`,
    ok: (thirdUtil[2] ?? 0) > (thirdUtil[0] ?? 0),
  },
  {
    label: 'bottlenecks emerge, not present from week 1',
    value: `${overloadedCellsFirstThird} cells early, median arrival week ${medianArrival}`,
    ok: overloadedCellsFirstThird <= result.kpis.overloadedCells * 0.1 && medianArrival >= weeks / 3,
  },
]

console.log('\n--- bands ---')
let failed = 0
for (const band of bands) {
  if (!band.ok) failed++
  console.log(`  ${band.ok ? 'PASS' : 'FAIL'}  ${band.label.padEnd(48)} ${band.value}`)
}
console.log(`\n${bands.length - failed} of ${bands.length} bands met`)
if (failed > 0) process.exitCode = 1
