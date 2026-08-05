/**
 * The deterministic mock-data factory.
 *
 * `buildSnapshot(profile)` produces the entire five-plant network from a single
 * integer seed. Two calls with the same profile produce byte-identical output —
 * there is no `Math.random`, no `Date.now`, no `new Date()` without arguments
 * anywhere in this file or the one it imports. That is not a nicety: the
 * cockpit compares scenarios against a baseline, and a baseline that drifts
 * between reloads makes every comparison a lie.
 *
 * ---------------------------------------------------------------------------
 * Why this file runs the engine
 * ---------------------------------------------------------------------------
 * A generated dataset is only useful if the numbers land somewhere believable.
 * A network at 40% utilisation has no bottlenecks to find; one where a third of
 * the assets sit at 3x their hours is a data error wearing a bottleneck's
 * clothes, and it makes the product's core story — find a saturated work
 * center, find somewhere that can take the load — meaningless, because nothing
 * has room and everything is broken.
 *
 * So nothing here is guessed. The plan is measured with the engine's own
 * arithmetic — the same `resolveOperation`, the same `resolveOee`, the same
 * reverse yield compounding, the same rule that setup is charged once per
 * (work center, material, week) — and fitted to a target field cell by cell.
 * `buildSnapshot` then re-measures the finished plan with the real `buildLoad`
 * and throws if it did not land, so a broken calibration is a build failure
 * rather than something a planner discovers.
 *
 * Four things decide whether the bands are reachable, and they have to happen
 * in this order:
 *
 *   1. THE PLAN'S ABSOLUTE SCALE, before the lot policy. Volumes are
 *      normalised to the capacity that exists (`scaleVolumesToCapacity`) and
 *      refined once against the routings that were actually written. Deciding
 *      cadence against volumes that are cut ten to one afterwards leaves the
 *      lot COUNT untouched while every lot shrinks, and the changeover bill —
 *      charged per lot, and immune to scaling — goes from a tenth of the
 *      network's hours to thirty-seven percent of them, past a hundred percent
 *      on the smallest cells.
 *   2. ASSIGNMENT AGAINST REAL HEADROOM (`nextWorkCenter`). Each operation goes
 *      to the qualified asset with the greatest remaining headroom FRACTION on
 *      whichever of its two pools is tighter, costed with yield compounding,
 *      the chosen machine's own generation rate factor and OEE, the operation's
 *      own setup band amortised over its cadence, and the labour pool.
 *   3. LOT LEVELLING (`levelLots`). A row runs on a cadence; choosing the PHASE
 *      of that cadence instead of drawing it costs nothing and takes the
 *      residual weekly variation from a third of the mean to a twelfth.
 *   4. A FEEDBACK FIT (`calibrateSupplyPlan`). Each work center is given a peak
 *      it should reach; each pass measures what it actually peaked at and moves
 *      its target toward the asked-for peak. A fixed target field cannot work —
 *      a supply row runs on four or five work centers at once and can only grow
 *      as far as the tightest allows, so one global level solved against a
 *      fixed field climbs until everything that CAN be loaded is at the maximum.
 *
 * ACHIEVED CALIBRATION, `standard` profile (15,000 SKUs, 150 work centers,
 * 78 weeks), measured by `scripts/diagnose.ts` against `runModel`:
 *
 *   network machine utilisation                     0.800   (target 0.76-0.86)
 *   peak (work center, week) utilisation            1.45    (target <= 1.60)
 *   work centers peaking over 1.0                   24      (target 12-30)
 *     of which machine-bound / labour-bound         15 / 9
 *     spanning                                      5 plants
 *   work centers peaking over 2.0                   0       (target 0)
 *   work centers under 0.40 mean                    18      (target >= 15)
 *   overloaded cells                                2.6%    (target <= 8%)
 *   shortfall units                                 1.7%    (target <= 3%)
 *   demand over supply                              +10.0%  (target +6-14%)
 *   changeovers as a share of required hours        0.10
 *   machine utilisation, first third -> last third  0.753 -> 0.864
 *   median week a bottleneck first crosses 1.0      58 of 78
 *   generation time / one engine run                4.1s / 0.39s
 *
 * The `large` profile (30,000 SKUs, 240 work centers) holds every band too.
 * The `demo` profile (1,500 SKUs, 40 work centers) holds eleven of thirteen:
 * eight machines per plant is too coarse a grid for eighteen operations, so a
 * few work centers cannot be filled and the network lands at about 0.75 rather
 * than 0.76, with the shortfall a few tenths of a point over its band. The
 * count bands are scaled by network size there — "twelve to thirty assets over
 * their ceiling" is 8-20% of the standard network, and demanding the same
 * absolute numbers of a network a tenth the size is arithmetic, not
 * calibration. `scripts/diagnose.ts [profile]` prints every band with a
 * PASS/FAIL and exits non-zero if one is missed.
 *
 * ---------------------------------------------------------------------------
 * Relief must exist
 * ---------------------------------------------------------------------------
 * The tool's whole payoff is "this work center is full, here is somewhere else
 * it could go". A dataset where every operation runs on exactly the machines
 * approved for it — and nowhere else could — makes the product look broken.
 * So for EVERY standard operation the generator guarantees, and then verifies
 * and throws if it cannot:
 *
 *   >= 3 approved work centers, spanning >= 2 plants
 *   >= 2 further work centers that are feature-capable but not approved
 *   >= 2 further work centers that a single retrofit would make capable
 *
 * The verification uses `capabilityBasis` from `@/domain/capability` — the same
 * function the relief search uses — so the invariant is checked against the
 * definition the product actually ships, not a restatement of it.
 */

import type {
  DowntimeEvent,
  InventoryRow,
  MachineClass,
  Material,
  MaterialId,
  OeeGlidePath,
  OeeOverride,
  OperationId,
  PlanMatrix,
  Plant,
  PlantId,
  PoolCapacity,
  ProductFamily,
  ProductGroup,
  RateOverride,
  Region,
  RetrofitOption,
  Routing,
  RoutingOperation,
  Scenario,
  Snapshot,
  TimeGrid,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import { REGIONS } from '@/domain/types'
import { at, clamp, key } from '@/domain/lookup'
import { buildTimeGrid } from '@/domain/time'
import { buildIndexes } from '@/domain/indexes'
import { capabilityBasis } from '@/domain/capability'
import { buildOeeGrid, resolveOee } from '@/domain/oee'
import type { CapacityGrids } from '@/domain/capacity'
import { buildCapacity, buildCeilings } from '@/domain/capacity'
import type { SourcingPlan } from '@/domain/sourcing'
import { resolveSourcing } from '@/domain/sourcing'
import { resolveOperation } from '@/domain/rates'
import { buildLoad } from '@/domain/load'
import type { Profile } from '@/data/profiles'
import {
  FAMILY_SPECS,
  FEATURES,
  GROUP_NAME_PARTS,
  MACHINE_CLASSES,
  OPERATION_SPECS,
  PLANT_SPECS,
  STANDARD_OPERATIONS,
} from '@/data/profiles'

export type { Profile } from '@/data/profiles'
export { PROFILES, DEFAULT_PROFILE, PLANT_META, profileById } from '@/data/profiles'

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32. Thirty-two bits of state, a period of 2^32, and a distribution
 * good enough for mock data — chosen because it is eleven lines and therefore
 * auditable. Determinism here is a correctness property, not a convenience.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Rng {
  next(): number
  range(min: number, max: number): number
  /** Inclusive both ends. */
  int(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
  /** Mean of three uniforms — a cheap bell, so extremes stay rare. */
  bell(min: number, max: number): number
  shuffle<T>(items: readonly T[]): T[]
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed)
  return {
    next,
    range(min: number, max: number): number {
      return min + (max - min) * next()
    },
    int(min: number, max: number): number {
      if (max <= min) return min
      return min + Math.floor(next() * (max - min + 1))
    },
    chance(p: number): boolean {
      return next() < p
    },
    pick<T>(items: readonly T[]): T {
      return at(items, Math.floor(next() * items.length), 'random pick')
    },
    bell(min: number, max: number): number {
      const t = (next() + next() + next()) / 3
      return min + (max - min) * t
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const a = at(out, i, 'shuffle')
        out[i] = at(out, j, 'shuffle')
        out[j] = a
      }
      return out
    },
  }
}

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

function i32(a: Int32Array, i: number): number {
  return a[i] ?? -1
}

function round(value: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(value * f) / f
}

/**
 * Largest-remainder apportionment. Deterministic down to the tie-break, which
 * is the lower index — the alternative is a distribution that depends on sort
 * stability, and that is exactly the kind of thing that breaks a fingerprint
 * test on a different engine.
 */
function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (w * total) / sum)
  const base = exact.map((v) => Math.floor(v))
  let remaining = total - base.reduce((a, b) => a + b, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const entry of order) {
    if (remaining <= 0) break
    base[entry.i] = at(base, entry.i, 'apportion bucket') + 1
    remaining -= 1
  }
  return base
}

/**
 * Interleave `quota[p]` copies of each index p across `total` slots so no plant
 * occupies a contiguous block. Machine classes are then assigned round-robin
 * over the result, which is what spreads every class across several plants —
 * and a class that lives at one plant only is a class whose work can never be
 * moved anywhere, which would quietly delete half the product.
 */
function interleave(quota: readonly number[], total: number): number[] {
  const slots: Array<{ position: number; index: number; seq: number }> = []
  for (let p = 0; p < quota.length; p++) {
    const count = at(quota, p, 'quota')
    for (let j = 0; j < count; j++) {
      slots.push({ position: ((j + 0.5) * total) / count, index: p, seq: j })
    }
  }
  slots.sort((a, b) => a.position - b.position || a.index - b.index || a.seq - b.seq)
  return slots.map((s) => s.index)
}

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

function buildPlants(): Plant[] {
  return PLANT_SPECS.map((spec) => ({
    id: spec.id,
    code: spec.code,
    name: spec.name,
    city: spec.city,
    country: spec.country,
    countryCode: spec.countryCode,
    region: spec.region,
    currency: spec.currency,
    fxPerUsd: spec.fxPerUsd,
    timezone: spec.timezone,
    lat: spec.lat,
    lon: spec.lon,
    colorSlot: spec.colorSlot,
    labourCostPerHourLocal: spec.labourCostPerHourLocal,
    defaultOee: spec.defaultOee,
    gridIntensity: spec.gridIntensity,
  }))
}

// ---------------------------------------------------------------------------
// Work centers
// ---------------------------------------------------------------------------

/** Commissioning-year band per machine generation. Vintage tracks generation. */
const VINTAGE_BAND: Record<number, [number, number]> = {
  1: [2004, 2011],
  2: [2010, 2016],
  3: [2015, 2021],
  4: [2019, 2025],
}

/** Years to add on top of the generation band — the plants' asset-age story. */
const PLANT_VINTAGE_BIAS: Record<PlantId, number> = {
  'US-TOL': -2,
  'MX-SLP': 2,
  'DE-ING': 1,
  'PL-WRO': 0,
  'CN-SUZ': 1,
}

/** Labour hours per unit scale with how much of the job the machine does. */
function automationFactor(generation: number): number {
  switch (generation) {
    case 1:
      return 1.35
    case 2:
      return 1.1
    case 3:
      return 0.9
    default:
      return 0.75
  }
}

function weeklyHoursOf(pool: PoolCapacity): number {
  return pool.count * pool.shiftsPerDay * pool.hoursPerShift * pool.daysPerWeek * pool.utilisationFactor
}

interface WorkCenterBuild {
  workCenters: WorkCenter[]
  /** Parallel to `workCenters`: the class each one carries. */
  classOf: MachineClass[]
  /** Parallel to `workCenters`: the retrofit already fitted, where there is one. */
  installedOf: Array<RetrofitOption | undefined>
  /**
   * The work centers built DELIBERATELY labour-short. Their operators are
   * meant to be the scarce resource, so `staffWorkCenters` staffs them to run
   * hotter on labour than on machines once the work they carry is known.
   */
  labourBoundIds: WorkCenterId[]
}

/**
 * `chooseLength`'s distribution, as probabilities. Held next to the function it
 * mirrors so the two cannot drift: the class allocation below needs the
 * EXPECTED routing length, and re-deriving it from a PRNG would make a
 * structural decision depend on a random stream.
 */
const LENGTH_DISTRIBUTION: ReadonlyArray<{ length: number; p: number }> = [
  { length: 2, p: 0.14 },
  { length: 3, p: 0.22 },
  { length: 4, p: 0.26 },
  { length: 5, p: 0.2 },
  { length: 6, p: 0.12 },
  { length: 7, p: 0.06 },
]

/**
 * Expected share of routing operations each standard operation will carry.
 *
 * Derived from the family specs alone — `thinSequence` always keeps the first
 * and last operation of a family's pool and thins the middle, so a family's
 * moulding step and its pack step appear in every one of its routings while a
 * middle step appears with probability (length - 2) / (pool - 2).
 */
function operationDemandShares(): Map<OperationId, number> {
  const demand = new Map<OperationId, number>()
  for (const family of FAMILY_SPECS) {
    const pool = family.opPool
    const n = pool.length
    let middle = 0
    for (const entry of LENGTH_DISTRIBUTION) {
      const length = clamp(entry.length, 2, Math.min(7, n))
      middle += entry.p * (n > 2 ? (length - 2) / (n - 2) : 0)
    }
    for (let i = 0; i < n; i++) {
      const opId = at(pool, i, 'family operation')
      const probability = i === 0 || i === n - 1 ? 1 : middle
      demand.set(opId, (demand.get(opId) ?? 0) + family.weight * probability)
    }
  }
  return demand
}

/**
 * Run hours dominate how many machines an operation needs; changeovers decide
 * how many DISTINCT PARTS one machine can hold. Both are counted, in the
 * proportion they are expected to appear in the finished plan.
 */
const CLASS_RUN_WEIGHT = 0.8
const CLASS_SETUP_WEIGHT = 0.2
/**
 * How hard an operation's demand is pushed toward the classes that can do
 * little else. 0 splits it evenly and starves the narrow operations; 1 hands
 * it all to the specialists and starves the broad ones. The middle is where
 * both `OP-PACK` and `OP-TRIM-CNC` come out with a workable pool.
 */
const CLASS_SPECIALIST_BIAS = 0.8

/**
 * How many work centers each machine class should get.
 *
 * The naive answer — one class per work center, round-robin — is what produced
 * the funnel this generator used to ship. `OP-PACK` sits at the end of seven of
 * the eight family pools, so a fifth of every routing operation ever written is
 * a pack step; but only two of the twelve classes carry `PACK` + `LABEL`, so a
 * flat round-robin qualified about 24 machines for 21% of the work and every
 * one of those machines ended up holding eight hundred distinct materials. A
 * changeover per material per lot then cost more hours than the cell had.
 *
 * So classes are dealt in proportion to the demand their capability set
 * carries, with each operation's demand split evenly across the classes that
 * can run it. Nothing here is random: the allocation is a fact about the
 * family specs and the feature matrix, not about the seed.
 */
function machineClassWeights(): number[] {
  const demand = operationDemandShares()
  const runOf = new Map<OperationId, number>()
  const setupOf = new Map<OperationId, number>()
  let runTotal = 0
  let setupTotal = 0
  for (const spec of OPERATION_SPECS) {
    const share = demand.get(spec.id) ?? 0
    const midRate = (at(spec.rateBand, 0, 'rate low') + at(spec.rateBand, 1, 'rate high')) / 2
    const midSetup = (at(spec.setupBand, 0, 'setup low') + at(spec.setupBand, 1, 'setup high')) / 2
    const run = midRate > 0 ? share / midRate : 0
    const setup = share * midSetup
    runOf.set(spec.id, run)
    setupOf.set(spec.id, setup)
    runTotal += run
    setupTotal += setup
  }

  // Each operation's demand is split across the classes that can run it in
  // INVERSE proportion to how much else those classes can do. An even split is
  // what starved `OP-PACK`: pack is the last step of seven of the eight
  // families, and of its two capable classes one also runs trimming, painting,
  // inspection, leak test, function test and four kinds of moulding, while the
  // other runs nothing else at all. Half the pack work therefore went to a
  // class that had no room for it and the specialist was left with two
  // machines. Qualifying the specialist first is both what a plant does and
  // what keeps the pool wide.
  const breadth = MACHINE_CLASSES.map((machineClass) => {
    const base = new Set(machineClass.baseFeatures)
    let count = 0
    for (const spec of OPERATION_SPECS) {
      if (spec.requiredFeatures.every((featureId) => base.has(featureId))) count++
    }
    return Math.max(1, count) ** CLASS_SPECIALIST_BIAS
  })

  const weights = MACHINE_CLASSES.map(() => 0)
  for (const spec of OPERATION_SPECS) {
    const capable: number[] = []
    for (let c = 0; c < MACHINE_CLASSES.length; c++) {
      const machineClass = at(MACHINE_CLASSES, c, 'machine class')
      const base = new Set(machineClass.baseFeatures)
      if (spec.requiredFeatures.every((featureId) => base.has(featureId))) capable.push(c)
    }
    if (capable.length === 0) continue
    const value =
      (runTotal > 0 ? (CLASS_RUN_WEIGHT * (runOf.get(spec.id) ?? 0)) / runTotal : 0) +
      (setupTotal > 0 ? (CLASS_SETUP_WEIGHT * (setupOf.get(spec.id) ?? 0)) / setupTotal : 0)
    let total = 0
    for (const c of capable) total += 1 / at(breadth, c, 'class breadth')
    if (!(total > 0)) continue
    for (const c of capable) {
      weights[c] = at(weights, c, 'class weight') + (value / at(breadth, c, 'class breadth')) / total
    }
  }
  return weights
}

/**
 * How many work centers of each class the whole network gets.
 *
 * Weighted by demand, but with a FLOOR: the relief invariant needs at least two
 * machines of every class that a retrofit could carry into an operation, and a
 * class that a pure weighting rounds down to zero takes a whole column of the
 * relief panel with it. On the demo profile — forty work centers over twelve
 * classes — that is not a corner case, it is the common one.
 */
const MIN_WORK_CENTERS_PER_CLASS = 2

function classQuotas(weights: readonly number[], total: number): number[] {
  const allocation = apportion(weights, total)
  const floor = Math.min(MIN_WORK_CENTERS_PER_CLASS, Math.floor(total / MACHINE_CLASSES.length))
  for (let c = 0; c < allocation.length; c++) {
    while (at(allocation, c, 'class allocation') < floor) {
      let biggest = 0
      for (let k = 1; k < allocation.length; k++) {
        if (at(allocation, k, 'class allocation') > at(allocation, biggest, 'class allocation')) biggest = k
      }
      if (at(allocation, biggest, 'class allocation') <= floor) break
      allocation[biggest] = at(allocation, biggest, 'class allocation') - 1
      allocation[c] = at(allocation, c, 'class allocation') + 1
    }
  }
  return allocation
}

function buildWorkCenters(profile: Profile, rng: Rng): WorkCenterBuild {
  const total = profile.workCenterCount
  const quota = apportion(
    PLANT_SPECS.map((p) => p.workCenterWeight),
    total,
  )
  const plantSequence = interleave(quota, total)
  // Both sequences are interleaved, so each class is spread evenly across the
  // slot order and each plant is too — which is what puts a broad mix of
  // classes at every site. A class that lives at one plant only is a class
  // whose work can never be moved anywhere.
  const classSequence = interleave(classQuotas(machineClassWeights(), total), total)

  const workCenters: WorkCenter[] = []
  const classOf: MachineClass[] = []
  const installedOf: Array<RetrofitOption | undefined> = []
  const labourBoundIds: WorkCenterId[] = []
  const perPlantCounter = new Map<PlantId, number>()

  for (let i = 0; i < total; i++) {
    const spec = at(PLANT_SPECS, at(plantSequence, i, 'plant slot'), 'plant spec')
    const n = (perPlantCounter.get(spec.id) ?? 0) + 1
    // Demand-weighted, dealt per plant. Every class lands at several plants and
    // every plant carries a broad mix — the precondition for relief existing at
    // all — but a class whose features carry a fifth of the network's work gets
    // a fifth of the machines rather than a twelfth.
    const machineClass = at(MACHINE_CLASSES, at(classSequence, i, 'class slot'), 'machine class')
    perPlantCounter.set(spec.id, n)
    const id = `${spec.id}-WC${String(n).padStart(3, '0')}`


    const band = VINTAGE_BAND[machineClass.generation] ?? [2010, 2020]
    const vintage = clamp(
      Math.round(rng.bell(at(band, 0, 'vintage low'), at(band, 1, 'vintage high'))) +
        (PLANT_VINTAGE_BIAS[spec.id] ?? 0),
      2004,
      2025,
    )

    // ~15% arrive with a retrofit already fitted. That is what makes two work
    // centers of the same class differ in capability, and it is the reason the
    // feature model has to be per work center rather than per class.
    const features = [...machineClass.baseFeatures]
    let installedOeeDelta = 0
    let installed: RetrofitOption | undefined
    if (machineClass.retrofits.length > 0 && rng.chance(0.15)) {
      const fitted = rng.pick(machineClass.retrofits)
      installed = fitted
      installedOeeDelta = fitted.oeeDelta
      for (const featureId of fitted.addsFeatures) {
        if (!features.includes(featureId)) features.push(featureId)
      }
    }

    const baseOee = clamp(
      spec.defaultOee +
        (machineClass.generation - 2.5) * 0.025 +
        (vintage - 2014) * 0.003 +
        rng.bell(-0.035, 0.035) +
        installedOeeDelta,
      0.42,
      0.95,
    )

    // DELIBERATE: every work center whose index mod 6 is 2 — a sixth of them,
    // 25 of the standard profile's 150 — is built LABOUR-BOUND: its operator
    // pool offers fewer hours than its machine pool, so the fix when it
    // saturates is hiring, not capex. The rest are built machine-bound, and a
    // handful of those come back labour-bound anyway once the operator count
    // hits its ceiling of 14, which is why the count is measured below rather
    // than assumed.
    //
    // A sixth rather than a fifth, and only mildly short rather than severely,
    // because a labour-bound cell drags the NETWORK's machine utilisation down
    // with it: its presses stop being filled at the point its operators run
    // out. Thirty cells whose operators bind at 0.6 of their machine hours cost
    // the network four points of machine utilisation on their own.
    const wantLabourBound = i % 7 === 2
    // A single-machine cell cannot be made labour-bound with a floor of two
    // operators, so labour-bound cells always carry at least two machines.
    let machineCount = wantLabourBound ? rng.int(2, 6) : rng.int(1, 6)
    const machineShifts = rng.int(2, 3)
    const days = rng.int(5, 6)
    const machine: PoolCapacity = {
      pool: 'machine',
      count: machineCount,
      shiftsPerDay: machineShifts,
      // 7.5 at DE-ING is the works-council week (37.5h over five shifts), not a
      // rounding choice. Using 8 there would invent ~6% of German capacity.
      hoursPerShift: spec.hoursPerShift,
      daysPerWeek: days,
      utilisationFactor: round(rng.range(0.85, 0.95), 3),
    }

    // Labour hours per unit run about 1.3x machine hours, so an operator pool
    // merely level with the machine pool makes EVERY cell labour-bound and the
    // two-pool model stops distinguishing anything. Machine-bound cells are
    // therefore staffed with real headroom; labour-bound ones deliberately are
    // not.
    const targetRatio = wantLabourBound ? rng.range(0.8, 0.96) : rng.range(1.9, 2.6)
    const labourShifts = Math.max(1, machineShifts - (rng.chance(0.35) ? 1 : 0))
    const labourUtil = round(rng.range(0.85, 0.95), 3)
    let labourCount = clamp(
      Math.round((targetRatio * machineCount * machineShifts * machine.utilisationFactor) /
        (labourShifts * labourUtil)),
      2,
      14,
    )
    const labour: PoolCapacity = {
      pool: 'labour',
      count: labourCount,
      shiftsPerDay: labourShifts,
      hoursPerShift: spec.hoursPerShift,
      daysPerWeek: days,
      utilisationFactor: labourUtil,
    }
    // Rounding and the two-operator floor can hand an intended labour-bound
    // cell a labour pool that is level with, or larger than, its machine pool.
    // Buying it another machine is the honest correction: it is a cell whose
    // operators are the scarce resource, and it has to actually read that way.
    while (weeklyHoursOf(labour) >= weeklyHoursOf(machine) && wantLabourBound) {
      if (labourCount > 2) {
        labourCount -= 1
        labour.count = labourCount
      } else if (machineCount < 6) {
        machineCount += 1
        machine.count = machineCount
      } else {
        break
      }
    }

    const kwPerHour = rng.range(16, 60)
    const workCenter: WorkCenter = {
      id,
      plantId: spec.id,
      code: id,
      name: `${machineClass.name} ${String(n).padStart(3, '0')}`,
      classId: machineClass.id,
      vintage,
      pools: [machine, labour],
      features,
      baseOee: round(baseOee, 4),
      status: 'active',
      costRateUsdPerHour: round(45 + machineClass.generation * 12 + rng.range(-8, 18), 2),
      co2PerMachineHourKg: round(kwPerHour * spec.gridIntensity, 3),
    }

    if (wantLabourBound) labourBoundIds.push(id)

    workCenters.push(workCenter)
    classOf.push(machineClass)
    installedOf.push(installed)
  }

  return { workCenters, classOf, installedOf, labourBoundIds }
}

/**
 * An already-fitted retrofit must never delete the last retrofit relief for an
 * operation.
 *
 * A work center that arrived with a retrofit already installed is capable
 * today, which is good — except when its class was the ONLY class a retrofit
 * could carry into that operation. Fit enough of them and the operation ends up
 * with capable machines and nothing left to propose, and the retrofit column in
 * the relief panel is empty for reasons no planner could ever discover.
 *
 * So the fitted retrofit is un-fitted on the smallest number of work centers
 * that restores the margin. That is a change to generated master data, not to
 * the model: the machine simply never had the upgrade.
 */
function repairRetrofitRelief(build: WorkCenterBuild): void {
  const MARGIN = 3
  for (const spec of OPERATION_SPECS) {
    for (let attempt = 0; attempt < build.workCenters.length; attempt++) {
      let retrofittable = 0
      const revertable: number[] = []
      for (let i = 0; i < build.workCenters.length; i++) {
        const wc = at(build.workCenters, i, 'work center')
        const machineClass = at(build.classOf, i, 'machine class')
        const granted = new Set(wc.features)
        if (spec.requiredFeatures.every((featureId) => granted.has(featureId))) {
          const installed = build.installedOf[i]
          if (installed === undefined) continue
          // Capable only because of the fitted retrofit, and retrofittable
          // without it — exactly the machine to hand the upgrade back.
          const base = new Set(machineClass.baseFeatures)
          if (spec.requiredFeatures.every((featureId) => base.has(featureId))) continue
          if (classCanRetrofitInto(machineClass, base, spec.requiredFeatures)) revertable.push(i)
        } else if (classCanRetrofitInto(machineClass, granted, spec.requiredFeatures)) {
          retrofittable += 1
        }
      }
      if (retrofittable >= MARGIN || revertable.length === 0) break
      const index = at(revertable, 0, 'revertable work center')
      const wc = at(build.workCenters, index, 'work center')
      const machineClass = at(build.classOf, index, 'machine class')
      const installed = build.installedOf[index]
      wc.features = [...machineClass.baseFeatures]
      wc.baseOee = round(clamp(wc.baseOee - (installed?.oeeDelta ?? 0), 0.42, 0.95), 4)
      build.installedOf[index] = undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Capability: who could run what, and who is allowed to
// ---------------------------------------------------------------------------

interface OpCapability {
  /** Feature-capable today. */
  capable: WorkCenterId[]
  /** Not capable, but one retrofit on its class closes the whole gap. */
  retrofittable: WorkCenterId[]
  /** The subset routings may draw on. Everything else is deliberate slack. */
  approvalPool: WorkCenterId[]
  /**
   * Capable machines HELD BACK from this operation, permanently. Nothing may
   * add them to the pool afterwards — they are the `featureCapable` relief the
   * cockpit proposes, and the invariant needs at least two of them per
   * operation. Every later pass that widens a pool has to consult this set, or
   * the reservation is a comment rather than a rule.
   */
  reserved: Set<WorkCenterId>
  /** Approval pool, split by plant — a routing at a plant can only use its own. */
  poolByPlant: Map<PlantId, WorkCenterId[]>
  /** Round-robin cursor, used as the balancer's tie-break. */
  cursorByPlant: Map<PlantId, number>
  /**
   * Pool members no routing has used yet, per plant.
   *
   * Approval is not the pool — approval is what the ROUTINGS actually wrote, so
   * a pool member nobody was routed to is not approved for anything and the
   * operation can end up with two approved work centers where the invariant
   * needs three. The first assignment at each plant therefore drains this queue
   * before the load balancer gets a say.
   */
  unusedByPlant: Map<PlantId, WorkCenterId[]>
}

function classCanRetrofitInto(
  machineClass: MachineClass,
  granted: Set<string>,
  required: readonly string[],
): boolean {
  const missing = required.filter((featureId) => !granted.has(featureId))
  if (missing.length === 0) return false
  for (const option of machineClass.retrofits) {
    const adds = new Set(option.addsFeatures)
    if (missing.every((featureId) => adds.has(featureId))) return true
  }
  return false
}

/**
 * Decide which work centers are cold — excluded from every approval pool, and
 * therefore carrying no load at all in the baseline.
 *
 * These are the relief targets a planner is meant to find: real machines, real
 * capability, nobody has qualified them for anything. They are chosen greedily
 * and only accepted when no operation is left with fewer than five
 * approvable-or-spare capable work centers, so making the network interesting
 * can never make it broken.
 *
 * SMALL machines first, with a wide jitter so the choice is not a size ranking.
 * A cold work center contributes hours to the denominator of every network
 * utilisation number and load to none of them, so the idle set is a direct
 * deduction from the headline: eleven percent of the assets chosen at random
 * costs nine points of network utilisation, and the remaining assets have to
 * make it up by running at a level that puts all of them over their ceiling.
 * Choosing the small ones costs four.
 */
function chooseColdWorkCenters(
  workCenters: readonly WorkCenter[],
  capableByOp: Map<OperationId, WorkCenterId[]>,
  plantOf: Map<WorkCenterId, PlantId>,
  target: number,
  rng: Rng,
): Set<WorkCenterId> {
  const cold = new Set<WorkCenterId>()
  const order = workCenters
    .map((wc) => {
      let hours = 0
      for (const pool of wc.pools) if (pool.pool === 'machine') hours += weeklyHoursOf(pool)
      return { id: wc.id, weight: hours * rng.range(0.6, 1.5) }
    })
    .sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => entry.id)
  for (const candidate of order) {
    if (cold.size >= target) break
    cold.add(candidate)
    let ok = true
    for (const [, capable] of capableByOp) {
      const warm = capable.filter((id) => !cold.has(id))
      if (warm.length < 5) {
        ok = false
        break
      }
      const plants = new Set(warm.slice(0, warm.length - 2).map((id) => plantOf.get(id)))
      if (plants.size < 2) {
        ok = false
        break
      }
    }
    if (!ok) cold.delete(candidate)
  }
  return cold
}

interface CapabilityPlan {
  byOp: Map<OperationId, OpCapability>
  /** Operations each plant can actually be routed for. */
  opsByPlant: Map<PlantId, OperationId[]>
  coldWorkCenters: Set<WorkCenterId>
}

function buildCapabilityPlan(
  profile: Profile,
  workCenters: readonly WorkCenter[],
  classOf: readonly MachineClass[],
  rng: Rng,
): CapabilityPlan {
  const plantOf = new Map<WorkCenterId, PlantId>()
  const grantedOf = new Map<WorkCenterId, Set<string>>()
  for (const wc of workCenters) {
    plantOf.set(wc.id, wc.plantId)
    grantedOf.set(wc.id, new Set(wc.features))
  }

  const capableByOp = new Map<OperationId, WorkCenterId[]>()
  const retrofitByOp = new Map<OperationId, WorkCenterId[]>()
  for (const spec of OPERATION_SPECS) {
    const capable: WorkCenterId[] = []
    const retrofittable: WorkCenterId[] = []
    for (let i = 0; i < workCenters.length; i++) {
      const wc = at(workCenters, i, 'work center')
      const granted = grantedOf.get(wc.id) ?? new Set<string>()
      if (spec.requiredFeatures.every((featureId) => granted.has(featureId))) {
        capable.push(wc.id)
      } else if (classCanRetrofitInto(at(classOf, i, 'machine class'), granted, spec.requiredFeatures)) {
        retrofittable.push(wc.id)
      }
    }
    capableByOp.set(spec.id, capable)
    retrofitByOp.set(spec.id, retrofittable)
  }

  const effectiveHours = new Map<WorkCenterId, number>()
  for (const wc of workCenters) {
    let hours = 0
    for (const pool of wc.pools) if (pool.pool === 'machine') hours += weeklyHoursOf(pool)
    effectiveHours.set(wc.id, hours * wc.baseOee)
  }

  const coldTarget = clamp(Math.round(profile.workCenterCount * 0.11), 4, profile.workCenterCount)
  const coldWorkCenters = chooseColdWorkCenters(workCenters, capableByOp, plantOf, coldTarget, rng)

  // The approval pool is capped, so a broadly capable operation still leaves
  // spare capable machines behind. `cap` scales with the network: on the demo
  // profile a cap of 18 would approve everything and delete the relief story.
  const cap = profile.workCenterCount

  const byOp = new Map<OperationId, OpCapability>()
  const opsByPlant = new Map<PlantId, OperationId[]>()
  for (const spec of OPERATION_SPECS) {
    const capable = capableByOp.get(spec.id) ?? []
    const retrofittable = retrofitByOp.get(spec.id) ?? []
    // Ordered by effective weekly hours with a wide random jitter. Two forces
    // are in tension and both matter:
    //
    //   Qualification is expensive, so a plant qualifies its big presses first
    //   — and a pool made of small cells cannot absorb the SKU count an
    //   operation carries, however evenly the hours are dealt out.
    //
    //   But a pure size ranking puts the same twenty assets in every pool and
    //   leaves half the network approved for nothing. The load then piles onto
    //   the approved half at 1.5x while the rest idles, which is not a
    //   bottleneck, it is a dataset that forgot most of its factories.
    //
    // The jitter is what lets a mid-sized cell out-rank a large one, so the
    // union of the eighteen pools covers the network instead of its top decile.
    const warm = capable
      .filter((id) => !coldWorkCenters.has(id))
      .map((id) => ({ id, weight: (effectiveHours.get(id) ?? 0) * rng.range(0.45, 1.55) }))
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((entry) => entry.id)
    // Two warm capable machines are held back from approval on every operation:
    // capable today, qualified for nothing, one conversation away from taking
    // load. Without this reservation a broadly-approved operation would report
    // no `featureCapable` relief at all.
    const reservedCount = 2
    const poolSize = clamp(warm.length - reservedCount, 3, cap)
    const approvalPool: WorkCenterId[] = warm.slice(0, poolSize)
    const reserved = new Set<WorkCenterId>(warm.slice(poolSize))

    const poolByPlant = new Map<PlantId, WorkCenterId[]>()
    for (const id of approvalPool) {
      const plantId = plantOf.get(id)
      if (plantId === undefined) continue
      const bucket = poolByPlant.get(plantId)
      if (bucket) bucket.push(id)
      else poolByPlant.set(plantId, [id])
    }
    // A plant left holding a single approved asset for an operation receives
    // every material at that plant that needs it, and no rebalancing can help:
    // there is nowhere else to put the work. Top each participating plant up to
    // three, drawing on warm capable machines that the global cap left out.
    const spare = warm.slice(0, Math.max(0, warm.length - reservedCount))
    for (const [plantId, bucket] of poolByPlant) {
      if (bucket.length >= 3) continue
      for (const id of spare) {
        if (bucket.length >= 3) break
        if (bucket.includes(id)) continue
        if (plantOf.get(id) !== plantId) continue
        bucket.push(id)
        if (!approvalPool.includes(id)) approvalPool.push(id)
      }
    }
    // Sorted so traversal is stable regardless of shuffle order — the pool
    // membership is random, the order it is walked in is not.
    for (const bucket of poolByPlant.values()) bucket.sort()

    // A plant holding a SINGLE approved asset for an operation is not a plant
    // that can make those parts at volume: every material at that site that
    // needs the operation lands on one machine, and no amount of rebalancing
    // helps because there is nowhere else to put the work. Such a plant is left
    // out of the operation entirely, and materials route around it.
    // ...unless applying that rule would leave the operation on a single site.
    // Approvals have to span at least two plants for relief to exist at all,
    // and a thin pool is a smaller problem than a single-sourced operation.
    const wellStaffed = [...poolByPlant].filter(([, bucket]) => bucket.length >= 2)
    const participating = wellStaffed.length >= 2 ? wellStaffed : [...poolByPlant]
    for (const [plantId] of participating) {
      const list = opsByPlant.get(plantId)
      if (list) list.push(spec.id)
      else opsByPlant.set(plantId, [spec.id])
    }

    byOp.set(spec.id, {
      capable,
      retrofittable,
      approvalPool,
      reserved,
      poolByPlant,
      cursorByPlant: new Map<PlantId, number>(),
      unusedByPlant: new Map<PlantId, WorkCenterId[]>(
        [...poolByPlant].map(([plantId, members]) => [plantId, [...members]]),
      ),
    })
  }

  // Every warm work center must appear in at least one approval pool. A capped
  // pool per operation is what stops a broadly-capable operation from approving
  // the whole network, but applied eighteen times it can leave a third of the
  // assets approved for nothing at all — and the load then piles onto the
  // approved two thirds at 1.5x while the rest sits idle. That is not a
  // bottleneck, it is a dataset that forgot most of its factories.
  const inSomePool = new Set<WorkCenterId>()
  for (const capability of byOp.values()) {
    for (const id of capability.approvalPool) inSomePool.add(id)
  }
  for (const wc of workCenters) {
    if (coldWorkCenters.has(wc.id) || inSomePool.has(wc.id)) continue
    // The operation it is capable of that has the fewest approvals so far —
    // the one that most needs another qualified asset.
    let bestOp: OperationId | undefined
    let bestSize = Number.POSITIVE_INFINITY
    for (const spec of OPERATION_SPECS) {
      const capability = byOp.get(spec.id)
      if (capability === undefined) continue
      if (!capability.capable.includes(wc.id)) continue
      // Never spend the reservation to warm an asset up. An operation with one
      // capable-but-unapproved machine left has no `featureCapable` relief to
      // offer, and that is the whole reason the feature model sits alongside
      // the allow-list. The asset stays cold instead — which is itself a
      // relief target, just a colder one.
      if (capability.reserved.has(wc.id)) continue
      if (capability.approvalPool.length < bestSize) {
        bestSize = capability.approvalPool.length
        bestOp = spec.id
      }
    }
    if (bestOp === undefined) continue
    const capability = byOp.get(bestOp)
    if (capability === undefined) continue
    capability.approvalPool.push(wc.id)
    const bucket = capability.poolByPlant.get(wc.plantId)
    if (bucket) bucket.push(wc.id)
    else capability.poolByPlant.set(wc.plantId, [wc.id])
    const unused = capability.unusedByPlant.get(wc.plantId)
    if (unused) unused.push(wc.id)
    else capability.unusedByPlant.set(wc.plantId, [wc.id])
    const ops = opsByPlant.get(wc.plantId)
    if (ops && !ops.includes(bestOp)) ops.push(bestOp)
    else if (!ops) opsByPlant.set(wc.plantId, [bestOp])
    inSomePool.add(wc.id)
  }

  return { byOp, opsByPlant, coldWorkCenters }
}

/**
 * What one operation of one material is expected to cost, before it is known
 * which machine will run it.
 *
 * `grossUnits` is already yield-compounded: to ship a week's good parts the
 * last operation must START more than that, the one before it more again, and
 * so on upstream. An estimate that skips the compounding under-states every
 * upstream operation, which is precisely where the moulding presses are.
 */
interface OperationDemand {
  /** Weekly units this operation must start, after upstream scrap. */
  grossUnits: number
  /** Middle of the operation's rate band, before the machine's own factor. */
  midRate: number
  /** Middle of the operation's labour band — labour hours per machine hour. */
  midLabourMultiple: number
  /** Middle of the operation's setup band. Charged per lot, to BOTH pools. */
  midSetup: number
}

/** Weekly hours one candidate would spend on this operation, per pool. */
interface AssignmentCost {
  machine: number
  labour: number
}

/**
 * What the work actually costs AT THIS MACHINE.
 *
 * Every term here was missing from the estimate this generator used to balance
 * on, and every one of them is worth a large factor:
 *
 *   - the machine's own `generationRateFactor`: a generation-1 press runs the
 *     same operation at 0.85 of the band midpoint and a generation-4 one at
 *     1.15, so two candidates the balancer treated as identical differ by 35%;
 *   - its OEE, which spans 0.42 to 0.95 across the network;
 *   - the operation's own SETUP band, amortised over the cadence the lot policy
 *     implies, rather than one network-wide constant. Setup is charged per
 *     (work center, material, week) and at 15,000 materials it is a large share
 *     of every cell's hours — a small cell that accepts a thousand tiny parts
 *     inside its run-hour budget then spends its whole week on changeovers;
 *   - the LABOUR pool, which binds on about a sixth of the network.
 */
function assignmentCost(
  balancer: Balancer,
  candidate: WorkCenterId,
  demand: OperationDemand,
): AssignmentCost {
  const generation = balancer.generation.get(candidate) ?? 2
  const oee = balancer.oee.get(candidate) ?? 0.8
  const machineWeekly = balancer.machineHours.get(candidate) ?? 0
  const rate = demand.midRate * generationRateFactor(generation)
  const run = rate > 0 && oee > 0 ? demand.grossUnits / rate / oee : 0
  const labourRun = run * clamp(demand.midLabourMultiple * automationFactor(generation), 0.6, 2.5)
  // How often this part will run here, from the same lot policy the supply
  // shape uses: one lot costs about `LOT_SHARE` of a work-center week, and
  // nothing runs more often than weekly or less often than `MIN_ACTIVITY`.
  // `run` is already after OEE, so the denominator is REAL weekly hours —
  // dividing by OEE twice would understate the changeover bill by a quarter.
  const cadence = machineWeekly > 0 ? clamp(run / (LOT_SHARE * machineWeekly), MIN_ACTIVITY, 1) : 1
  const setup = cadence * demand.midSetup
  return { machine: run + setup, labour: labourRun + setup }
}

/**
 * Which approved work center at this plant gets the next piece of work.
 *
 * The asset with the greatest remaining HEADROOM FRACTION — spare hours over
 * hours it has — on whichever of its two pools is tighter. Not the fewest
 * assigned hours: a single press on two shifts and six presses on three are not
 * equally able to absorb the next part, and balancing assigned hours without
 * dividing by what each asset HAS fills the small cells first and hardest.
 *
 * The cursor is kept as the tie-break, so a network where every candidate is
 * equally free still spreads rather than piling onto the lowest id.
 */
function nextWorkCenter(
  capability: OpCapability,
  plantId: PlantId,
  demand: OperationDemand,
  balancer: Balancer,
): WorkCenterId | undefined {
  const pool = capability.poolByPlant.get(plantId)
  if (pool === undefined || pool.length === 0) return undefined
  const cursor = capability.cursorByPlant.get(plantId) ?? 0
  capability.cursorByPlant.set(plantId, cursor + 1)

  const charge = (id: WorkCenterId, cost: AssignmentCost): void => {
    balancer.machineAssigned.set(id, (balancer.machineAssigned.get(id) ?? 0) + cost.machine)
    balancer.labourAssigned.set(id, (balancer.labourAssigned.get(id) ?? 0) + cost.labour)
    balancer.plantAssigned.set(plantId, (balancer.plantAssigned.get(plantId) ?? 0) + cost.machine)
  }

  const unused = capability.unusedByPlant.get(plantId)
  if (unused !== undefined && unused.length > 0) {
    const first = unused.shift()
    if (first !== undefined) {
      charge(first, assignmentCost(balancer, first, demand))
      return first
    }
  }

  let best: WorkCenterId | undefined
  let bestHeadroom = Number.NEGATIVE_INFINITY
  let bestCost: AssignmentCost = { machine: 0, labour: 0 }
  for (let i = 0; i < pool.length; i++) {
    const candidate = at(pool, (cursor + i) % pool.length, 'approval pool member')
    const machineWeekly = balancer.machineHours.get(candidate) ?? 0
    const labourWeekly = balancer.labourHours.get(candidate) ?? 0
    if (machineWeekly <= 0 || labourWeekly <= 0) continue
    const cost = assignmentCost(balancer, candidate, demand)
    // Remaining share of the pool's own week, once this part lands on it. BOTH
    // pools, because either can bind: scoring on machine hours alone fills a
    // labour-short cell to its machine capacity and leaves its operators at
    // three times theirs.
    const machineHeadroom =
      (machineWeekly - (balancer.machineAssigned.get(candidate) ?? 0) - cost.machine) / machineWeekly
    const labourHeadroom =
      (labourWeekly - (balancer.labourAssigned.get(candidate) ?? 0) - cost.labour) / labourWeekly
    const headroom = machineHeadroom < labourHeadroom ? machineHeadroom : labourHeadroom
    if (headroom > bestHeadroom) {
      bestHeadroom = headroom
      best = candidate
      bestCost = cost
    }
  }
  if (best !== undefined) charge(best, bestCost)
  return best
}

/**
 * Running per-pool projection used to spread routings across qualified assets.
 *
 * The hours here are REAL weekly hours — count x shifts x hours x days x
 * utilisationFactor — not a proxy, because the whole point is to compare what
 * an asset has been given against what it has.
 */
interface Balancer {
  machineHours: Map<WorkCenterId, number>
  labourHours: Map<WorkCenterId, number>
  oee: Map<WorkCenterId, number>
  generation: Map<WorkCenterId, number>
  machineAssigned: Map<WorkCenterId, number>
  labourAssigned: Map<WorkCenterId, number>
  /** Total machine hours per plant, and how much is already spoken for. */
  plantCapacity: Map<PlantId, number>
  plantAssigned: Map<PlantId, number>
}

// ---------------------------------------------------------------------------
// Product hierarchy
// ---------------------------------------------------------------------------

const VARIANT_WORDS: string[] = [
  'Type A',
  'Type B',
  'Mk II',
  'Mk III',
  'Rev C',
  'Rev D',
  'LH',
  'RH',
  'Short',
  'Long',
  'Deep',
  'Vented',
  'Sealed',
  'Slim',
]

const HANDLING_UNITS: number[] = [24, 48, 60, 96, 120, 240, 480, 960]

interface ProductBuild {
  families: ProductFamily[]
  groups: ProductGroup[]
  materials: Material[]
  /** Parallel to `materials`: the family spec each one belongs to. */
  familyIndexOf: number[]
  /**
   * Parallel to `materials`: average eaches per week across the network.
   * Drawn here rather than with the plan because the routing generator needs
   * it — an asset takes work in proportion to the hours that work will cost,
   * and it cannot know that from a part number.
   */
  volumeOf: number[]
}

/**
 * Eight families, forty groups, `profile.skuCount` materials.
 *
 * ~12% of materials are HALB semi-finished with a FERT parent pointing at them
 * through `componentId`. Those pairs are the ONLY places WIP may cross a plant
 * boundary in plan mode, so there have to be enough of them, spread widely
 * enough, for the transfer story to be reachable from any plant a planner
 * happens to be looking at. Roughly two in five pairs are deliberately split
 * across plants in the baseline — the semi-finished part is already made
 * somewhere other than where it is consumed.
 */
function buildProducts(profile: Profile, rng: Rng): ProductBuild {
  const families: ProductFamily[] = FAMILY_SPECS.map((spec) => ({
    id: spec.id,
    code: spec.code,
    name: spec.name,
  }))

  const groups: ProductGroup[] = []
  const groupsByFamily = new Map<string, ProductGroup[]>()
  for (const spec of FAMILY_SPECS) {
    const bucket: ProductGroup[] = []
    for (let g = 0; g < spec.groupCount; g++) {
      const part = at(GROUP_NAME_PARTS, g % GROUP_NAME_PARTS.length, 'group name part')
      const group: ProductGroup = {
        id: `G-${spec.code}-${String(g + 1).padStart(2, '0')}`,
        familyId: spec.id,
        code: `${spec.code}${String(g + 1).padStart(2, '0')}`,
        name: `${part} ${spec.name}`,
      }
      bucket.push(group)
      groups.push(group)
    }
    groupsByFamily.set(spec.id, bucket)
  }

  const perFamily = apportion(
    FAMILY_SPECS.map((spec) => spec.weight),
    profile.skuCount,
  )

  const materials: Material[] = []
  const familyIndexOf: number[] = []
  const volumeOf: number[] = []
  let serial = 0

  for (let fi = 0; fi < FAMILY_SPECS.length; fi++) {
    const spec = at(FAMILY_SPECS, fi, 'family spec')
    const familyGroups = groupsByFamily.get(spec.id) ?? []
    const count = at(perFamily, fi, 'family material count')
    // Groups are deliberately uneven: a flat split reads as generated data the
    // moment anyone sorts a table by SKU count.
    const groupWeights = familyGroups.map(() => rng.range(0.5, 1.8))
    const perGroup = apportion(groupWeights, count)

    for (let gi = 0; gi < familyGroups.length; gi++) {
      const group = at(familyGroups, gi, 'product group')
      const groupCount = at(perGroup, gi, 'group material count')
      for (let m = 0; m < groupCount; m++) {
        serial += 1
        const abcRoll = rng.next()
        const abcClass: Material['abcClass'] = abcRoll < 0.1 ? 'A' : abcRoll < 0.4 ? 'B' : 'C'
        const price =
          abcClass === 'A'
            ? rng.range(18, 90)
            : abcClass === 'B'
              ? rng.range(6, 30)
              : rng.range(1.5, 12)
        const material: Material = {
          id: `MAT-${spec.code}-${String(serial).padStart(6, '0')}`,
          code: `${spec.code}-${String(serial).padStart(6, '0')}`,
          description: `${group.name} ${rng.pick(VARIANT_WORDS)}`,
          type: 'FERT',
          groupId: group.id,
          familyId: spec.id,
          baseUom: 'EA',
          plantIds: [],
          pricePerUnitUsd: round(price, 2),
          materialCostPerUnitUsd: round(price * rng.range(0.35, 0.6), 2),
          abcClass,
          unitsPerHandlingUnit: rng.pick(HANDLING_UNITS),
          weightKgPerUnit: round(rng.range(0.02, 2.4), 3),
        }
        materials.push(material)
        familyIndexOf.push(fi)
        volumeOf.push(baseVolume(abcClass, rng))
      }
    }
  }

  return { families, groups, materials, familyIndexOf, volumeOf }
}

/**
 * Turn every eighth material into a HALB and hand it to a FERT parent in the
 * same product group. The parent then starts its routing downstream of the
 * moulding stages, because the moulding already happened — possibly at another
 * plant, which is the entire point.
 */
function declareTransferPoints(materials: Material[], rng: Rng): number {
  let pairs = 0
  for (let i = 0; i < materials.length; i += 8) {
    const halb = at(materials, i, 'material')
    // The parent is the next material in the same group; without one there is
    // nothing to consume the semi-finished part and it would be an orphan.
    let parent: Material | undefined
    for (let j = i + 1; j < materials.length && j <= i + 6; j++) {
      const candidate = at(materials, j, 'material')
      if (candidate.groupId !== halb.groupId) break
      if (candidate.type === 'FERT' && candidate.componentId === undefined) {
        parent = candidate
        break
      }
    }
    if (parent === undefined) continue
    halb.type = 'HALB'
    halb.description = `${halb.description} (semi-finished)`
    parent.componentId = halb.id
    pairs += 1
    // Consume a draw whether or not the pair splits, so the stream stays
    // aligned with the pair count rather than with the split count.
    rng.next()
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Routings
// ---------------------------------------------------------------------------

/** Faster machines run faster, but never outside the operation's stated band. */
function generationRateFactor(generation: number): number {
  switch (generation) {
    case 1:
      return 0.85
    case 2:
      return 0.95
    case 3:
      return 1.05
    default:
      return 1.15
  }
}

/** Routing length distribution. Most SKUs are short; the long tail is real. */
function chooseLength(rng: Rng, maxLength: number): number {
  const hi = Math.min(7, maxLength)
  if (hi <= 2) return hi
  const roll = rng.next()
  const wanted = roll < 0.14 ? 2 : roll < 0.36 ? 3 : roll < 0.62 ? 4 : roll < 0.82 ? 5 : roll < 0.94 ? 6 : 7
  return clamp(wanted, 2, hi)
}

/**
 * Keep the first and last operation and thin the middle. A routing that lost
 * its moulding step or its pack step would not be a shorter routing, it would
 * be a wrong one.
 */
function thinSequence(ops: readonly OperationId[], length: number, rng: Rng): OperationId[] {
  if (ops.length <= length) return [...ops]
  const first = at(ops, 0, 'first operation')
  const last = at(ops, ops.length - 1, 'last operation')
  const middle = ops.slice(1, ops.length - 1)
  const keepMiddle = rng.shuffle(middle).slice(0, Math.max(0, length - 2))
  const ordered = middle.filter((opId) => keepMiddle.includes(opId))
  return [first, ...ordered, last]
}

/** One written routing operation, for the override samplers. */
interface WrittenOp {
  materialId: MaterialId
  workCenterId: WorkCenterId
  opId: OperationId
  ratePerHour: number
}

interface RoutingBuild {
  routings: Routing[]
  /**
   * Machine hours per week the finished routings imply at the volumes they were
   * written against, computed the way `buildLoad` will: yield-compounded
   * quantity, the chosen machine's own rate, divided by its OEE. This is what
   * lets the plan's absolute scale be pinned BEFORE the lot policy is decided
   * rather than after — see `scaleVolumesToCapacity`.
   */
  weeklyMachineHours: number
  /**
   * `key(materialId, plantId)` -> the share of ONE work-center week that ONE
   * unit of this material consumes at the tightest operation on its routing.
   *
   * The binding operation, not an average one: a routing that moulds at 250
   * eaches/hour and inspects at 1,800 spends seven times as long at the press,
   * and a lot sized against the average would be seven times too big there. The
   * tightest asset, likewise — a lot has to fit the smallest cell on its path.
   * Getting either wrong produces a work center at 1,300% of capacity, which is
   * a badly batched plan wearing a bottleneck's clothes.
   */
  bindingFactorByRow: Map<string, number>
}

function buildRoutings(
  materials: readonly Material[],
  familyIndexOf: readonly number[],
  volumeOf: readonly number[],
  capability: CapabilityPlan,
  classByWorkCenter: Map<WorkCenterId, MachineClass>,
  workCenterById: Map<WorkCenterId, WorkCenter>,
  rng: Rng,
): RoutingBuild {
  // REAL weekly hours per pool, plus the two things that decide what an hour of
  // work costs at a given asset: its OEE and its generation.
  const balancer: Balancer = {
    machineHours: new Map<WorkCenterId, number>(),
    labourHours: new Map<WorkCenterId, number>(),
    oee: new Map<WorkCenterId, number>(),
    generation: new Map<WorkCenterId, number>(),
    machineAssigned: new Map<WorkCenterId, number>(),
    labourAssigned: new Map<WorkCenterId, number>(),
    plantCapacity: new Map<PlantId, number>(),
    plantAssigned: new Map<PlantId, number>(),
  }
  for (const [id, wc] of workCenterById) {
    let machineHours = 0
    let labourHours = 0
    for (const pool of wc.pools) {
      if (pool.pool === 'machine') machineHours += weeklyHoursOf(pool)
      else labourHours += weeklyHoursOf(pool)
    }
    balancer.machineHours.set(id, machineHours)
    balancer.labourHours.set(id, labourHours)
    balancer.oee.set(id, wc.baseOee > 0 ? wc.baseOee : 0.8)
    balancer.generation.set(id, classByWorkCenter.get(id)?.generation ?? 2)
    balancer.plantCapacity.set(wc.plantId, (balancer.plantCapacity.get(wc.plantId) ?? 0) + machineHours)
  }
  const specByOp = new Map<OperationId, (typeof OPERATION_SPECS)[number]>()
  for (const spec of OPERATION_SPECS) specByOp.set(spec.id, spec)

  const plantOrder = PLANT_SPECS.map((p) => p.id)

  const opsAtPlant = new Map<PlantId, Set<OperationId>>()
  for (const [plantId, ops] of capability.opsByPlant) opsAtPlant.set(plantId, new Set(ops))

  const routings: Routing[] = []
  const bindingFactorByRow = new Map<string, number>()
  let weeklyMachineHours = 0

  /**
   * Weighted plant order for one material — biased towards whichever plant has
   * the most unspoken-for hours left. A static weighting sends a fixed share of
   * the SKUs to every site regardless of how much capacity each has left, and
   * the smallest site ends up at three times its hours while the largest idles.
   */
  const plantPreference = (): PlantId[] => {
    const remaining = plantOrder.map((id) => {
      const capacity = balancer.plantCapacity.get(id) ?? 0
      const headroom = capacity - (balancer.plantAssigned.get(id) ?? 0)
      return { id, weight: Math.max(capacity * 0.02, headroom) }
    })
    const out: PlantId[] = []
    let pool = remaining.reduce((sum, entry) => sum + entry.weight, 0)
    while (remaining.length > 0) {
      let roll = rng.next() * pool
      let chosen = remaining.length - 1
      for (let i = 0; i < remaining.length; i++) {
        roll -= at(remaining, i, 'plant candidate').weight
        if (roll <= 0) {
          chosen = i
          break
        }
      }
      const picked = at(remaining, chosen, 'plant candidate')
      out.push(picked.id)
      pool -= picked.weight
      remaining.splice(chosen, 1)
    }
    return out
  }

  const buildOperations = (
    _materialId: MaterialId,
    plantId: PlantId,
    sequence: readonly OperationId[],
    weeklyUnits: number,
  ): RoutingOperation[] => {
    // Only the operations that can actually be placed, resolved first, because
    // the yield compounding below depends on how many there are and in what
    // order — an estimate that compounds over a step that was never written
    // inflates everything upstream of it.
    const usable: Array<{ opId: OperationId; spec: (typeof OPERATION_SPECS)[number]; capability: OpCapability }> = []
    for (const opId of sequence) {
      const capabilityForOp = capability.byOp.get(opId)
      const spec = specByOp.get(opId)
      if (capabilityForOp === undefined || spec === undefined) continue
      usable.push({ opId, spec, capability: capabilityForOp })
    }

    // Reverse yield compounding, from the middle of each operation's yield
    // band: to ship a week's good parts the LAST operation must start more than
    // that, and everything before it more again. Ignoring this under-states
    // every upstream operation — which is where the moulding presses are.
    const invCumYield = new Float64Array(usable.length)
    let cumulative = 1
    for (let p = usable.length - 1; p >= 0; p--) {
      const band = at(usable, p, 'usable operation').spec.yieldBand
      const midYield = clamp(
        (at(band, 0, 'yield low') + at(band, 1, 'yield high')) / 2,
        0.5,
        1,
      )
      cumulative *= midYield
      invCumYield[p] = 1 / cumulative
    }

    const operations: RoutingOperation[] = []
    let seq = 10
    for (let p = 0; p < usable.length; p++) {
      const entry = at(usable, p, 'usable operation')
      const opId = entry.opId
      const spec = entry.spec
      const capabilityForOp = entry.capability
      const midRate =
        (at(spec.rateBand, 0, 'rate low') + at(spec.rateBand, 1, 'rate high')) / 2
      const demand: OperationDemand = {
        grossUnits: weeklyUnits * f64(invCumYield, p),
        midRate,
        midLabourMultiple:
          (at(spec.labourBand, 0, 'labour low') + at(spec.labourBand, 1, 'labour high')) / 2,
        midSetup: (at(spec.setupBand, 0, 'setup low') + at(spec.setupBand, 1, 'setup high')) / 2,
      }
      // The generator CHECKS that the work center can genuinely run the standard
      // operation rather than assuming it: `nextWorkCenter` only ever hands back
      // members of the operation's own approval pool, which was built from
      // feature-capable machines at this plant.
      const workCenterId = nextWorkCenter(capabilityForOp, plantId, demand, balancer)
      if (workCenterId === undefined) continue
      const machineClass = classByWorkCenter.get(workCenterId)
      const generation = machineClass?.generation ?? 2

      const rate = clamp(
        rng.range(at(spec.rateBand, 0, 'rate low'), at(spec.rateBand, 1, 'rate high')) *
          generationRateFactor(generation),
        at(spec.rateBand, 0, 'rate low'),
        at(spec.rateBand, 1, 'rate high'),
      )
      const baseQty = rng.chance(0.5) ? 100 : 1000
      const machineHoursPerBase = baseQty / rate
      // Labour per unit is where the two pools come apart. A generation-1 cell
      // needs an operator on the machine; a generation-4 one needs somebody to
      // walk past it. That ratio, and not the shift pattern alone, is what makes
      // a work center labour-bound under load.
      const labourMultiple = clamp(
        rng.range(at(spec.labourBand, 0, 'labour low'), at(spec.labourBand, 1, 'labour high')) *
          automationFactor(generation),
        0.6,
        2.5,
      )

      operations.push({
        seq,
        opId,
        workCenterId,
        baseQty,
        setupHours: round(
          rng.range(at(spec.setupBand, 0, 'setup low'), at(spec.setupBand, 1, 'setup high')),
          2,
        ),
        machineHoursPerBase: round(machineHoursPerBase, 6),
        labourHoursPerBase: round(machineHoursPerBase * labourMultiple, 6),
        yield: round(
          rng.range(at(spec.yieldBand, 0, 'yield low'), at(spec.yieldBand, 1, 'yield high')),
          4,
        ),
      })
      seq += 10
    }
    return operations
  }

  for (let mi = 0; mi < materials.length; mi++) {
    const material = at(materials, mi, 'material')
    const familySpec = at(FAMILY_SPECS, at(familyIndexOf, mi, 'family index'), 'family spec')

    // A HALB stops at the transfer point; the FERT that consumes it starts
    // there. Between them sits the only boundary WIP is allowed to cross.
    const stageFilter = (opId: OperationId): boolean => {
      const spec = specByOp.get(opId)
      if (spec === undefined) return false
      if (material.type === 'HALB') return spec.stage <= 2
      if (material.componentId !== undefined) return spec.stage >= 3
      return true
    }
    let pool = familySpec.opPool.filter(stageFilter)
    // A semi-finished part whose family has only one upstream operation still
    // needs somewhere to be inspected before it is shipped on.
    if (pool.length < 2 && material.type === 'HALB') {
      const extra = familySpec.opPool.filter((opId) => (specByOp.get(opId)?.stage ?? 9) === 5)
      pool = [...pool, ...extra.slice(0, 1)]
    }
    if (pool.length < 2) pool = [...familySpec.opPool]

    let primaryPlant: PlantId | undefined
    let sequence: OperationId[] = []
    for (const candidate of plantPreference()) {
      const available = opsAtPlant.get(candidate)
      if (available === undefined) continue
      const usable = pool.filter((opId) => available.has(opId))
      if (usable.length < 2) continue
      primaryPlant = candidate
      sequence = thinSequence(usable, chooseLength(rng, usable.length), rng)
      break
    }
    if (primaryPlant === undefined || sequence.length < 2) continue

    const plantIds: PlantId[] = [primaryPlant]
    const alternateBudget = rng.chance(0.12) ? 2 : rng.chance(0.35) ? 1 : 0
    if (alternateBudget > 0) {
      for (const candidate of plantPreference()) {
        if (plantIds.length >= 1 + alternateBudget) break
        if (candidate === primaryPlant) continue
        const available = opsAtPlant.get(candidate)
        if (available === undefined) continue
        if (sequence.every((opId) => available.has(opId))) plantIds.push(candidate)
      }
    }

    // MARC follows the routings, never the other way round. A plant that could
    // not be given a complete routing is not a plant this material is made at,
    // and listing it there would produce a supply row nothing can consume.
    const routedPlants: PlantId[] = []
    const weeklyVolume = at(volumeOf, mi, 'material volume')
    for (let p = 0; p < plantIds.length; p++) {
      const plantId = at(plantIds, p, 'material plant')
      // Matches the share split the supply plan applies later closely enough to
      // balance against: the primary carries the bulk, alternates the remainder.
      const plantShare =
        plantIds.length === 1 ? 1 : p === 0 ? 0.7 : 0.3 / (plantIds.length - 1)
      const operations = buildOperations(material.id, plantId, sequence, weeklyVolume * plantShare)
      if (operations.length < 2) continue
      routedPlants.push(plantId)
      // Yield compounds upstream here too — the binding factor decides the lot
      // policy, and a lot sized against net quantity is short at every
      // operation before the last one.
      const invCumYield = new Float64Array(operations.length)
      let cumulative = 1
      for (let q = operations.length - 1; q >= 0; q--) {
        const y = at(operations, q, 'routing operation').yield
        cumulative *= y > 0 && y <= 1 ? y : 1
        invCumYield[q] = 1 / cumulative
      }
      let bindingFactor = 0
      const weeklyUnits = weeklyVolume * plantShare
      for (let q = 0; q < operations.length; q++) {
        const op = at(operations, q, 'routing operation')
        const oee = balancer.oee.get(op.workCenterId) ?? 0.8
        const machineCapacity = (balancer.machineHours.get(op.workCenterId) ?? 0) * oee
        const labourCapacity = (balancer.labourHours.get(op.workCenterId) ?? 0) * oee
        const gross = f64(invCumYield, q)
        if (machineCapacity > 0) {
          const factor = (gross * op.machineHoursPerBase) / op.baseQty / machineCapacity
          if (factor > bindingFactor) bindingFactor = factor
        }
        if (labourCapacity > 0) {
          const factor = (gross * op.labourHoursPerBase) / op.baseQty / labourCapacity
          if (factor > bindingFactor) bindingFactor = factor
        }
        weeklyMachineHours += (weeklyUnits * gross * op.machineHoursPerBase) / op.baseQty / oee
      }
      bindingFactorByRow.set(key(material.id, plantId), bindingFactor)
      routings.push({
        id: `RTG-${material.code}-${plantId}-0001`,
        materialId: material.id,
        plantId,
        version: '0001',
        primary: true,
        operations,
      })
      // ~8% of pairs carry a second production version. `resolveOperation`
      // substitutes an alternate's times wholesale, so this is what exercises
      // step 2 of rate resolution in the shipped data rather than only in tests.
      if (rng.chance(0.08)) {
        const alternate = operations.map((op) => ({
          ...op,
          machineHoursPerBase: round(op.machineHoursPerBase * rng.range(0.92, 1.06), 6),
          labourHoursPerBase: round(op.labourHoursPerBase * rng.range(0.9, 1.12), 6),
          setupHours: round(op.setupHours * rng.range(0.85, 1.15), 2),
        }))
        routings.push({
          id: `RTG-${material.code}-${plantId}-0002`,
          materialId: material.id,
          plantId,
          version: '0002',
          primary: false,
          operations: alternate,
        })
      }
    }
    material.plantIds = routedPlants
  }

  return { routings, bindingFactorByRow, weeklyMachineHours }
}

// ---------------------------------------------------------------------------
// The two knobs: rate overrides, OEE overrides, glide paths
// ---------------------------------------------------------------------------

/**
 * Every operation the finished routings actually carry.
 *
 * Collected AFTER rebalancing, never before. An override names a (material,
 * work center, operation) triple, and rebalancing moves operations between work
 * centers — sample the triples first and every one of them points at a machine
 * that no longer runs that part. `resolveOperation` would silently ignore them,
 * which is the worst kind of dead master data: present, plausible, and inert.
 */
function collectWrittenOps(routings: readonly Routing[]): WrittenOp[] {
  const out: WrittenOp[] = []
  for (const routing of routings) {
    if (!routing.primary) continue
    for (const op of routing.operations) {
      out.push({
        materialId: routing.materialId,
        workCenterId: op.workCenterId,
        opId: op.opId,
        ratePerHour: op.machineHoursPerBase > 0 ? op.baseQty / op.machineHoursPerBase : 0,
      })
    }
  }
  return out
}

const RATE_NOTES: string[] = [
  'Deep metallic colour — extra flash-off before cure.',
  'Thin-wall section; injection speed limited by short shots.',
  'Customer-specific gate witness limit slows the ejection cycle.',
  'Glass-filled grade; screw wear measured, rate de-rated.',
  'Two-shot tool runs one cavity blocked pending repair.',
  'Validated cycle from PPAP — cannot be shortened without re-qualification.',
  'Oversized handling unit; pack-out is the constraint, not the press.',
  'Insert pre-heat adds a fixed dwell to every shot.',
]

function buildRateOverrides(
  written: readonly WrittenOp[],
  targetCount: number,
  rng: Rng,
): RateOverride[] {
  if (written.length === 0 || targetCount <= 0) return []
  const seen = new Set<string>()
  const out: RateOverride[] = []
  const stride = Math.max(1, Math.floor(written.length / targetCount))
  for (let i = 0; i < written.length && out.length < targetCount; i += stride) {
    const entry = at(written, i, 'written operation')
    const k = key(entry.materialId, entry.workCenterId, entry.opId)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({
      materialId: entry.materialId,
      workCenterId: entry.workCenterId,
      opId: entry.opId,
      // A genuine SKU-specific deviation, not noise: the routing's standard
      // time is right for the operation and wrong for this part.
      ratePerHour: round(entry.ratePerHour * rng.range(0.72, 1.28), 2),
      note: rng.pick(RATE_NOTES),
    })
  }
  return out
}

function buildOeeOverrides(
  workCenters: readonly WorkCenter[],
  written: readonly WrittenOp[],
  weekCount: number,
  targetCount: number,
  rng: Rng,
): OeeOverride[] {
  const out: OeeOverride[] = []
  const workCenterScoped = Math.round(targetCount * 0.55)
  const order = rng.shuffle(workCenters.map((wc) => wc))

  for (let i = 0; i < workCenterScoped && i < order.length; i++) {
    const wc = at(order, i, 'work center')
    const windowed = rng.chance(0.45)
    const fromWeek = windowed ? rng.int(2, Math.max(2, weekCount - 20)) : undefined
    const toWeek = fromWeek === undefined ? undefined : Math.min(weekCount - 1, fromWeek + rng.int(6, 24))
    out.push({
      scope: 'workCenter',
      workCenterId: wc.id,
      value: round(clamp(wc.baseOee + rng.range(-0.09, 0.07), 0.4, 0.95), 4),
      fromWeek,
      toWeek,
      note: windowed
        ? 'Measured OEE after the tooling rebuild; reverts to the master value afterwards.'
        : 'Standing measured OEE — the machine has never run at the plant default.',
    })
  }

  // Material x work center is the most specific step of the cascade, and the
  // rarest: it is a claim about one part on one machine. Keeping it rare also
  // keeps `buildLoad` on its fast path for everything else.
  const remaining = targetCount - out.length
  const seen = new Set<string>()
  const stride = Math.max(1, Math.floor(written.length / Math.max(1, remaining)))
  for (let i = 0; i < written.length && out.length < targetCount; i += stride) {
    const entry = at(written, i, 'written operation')
    const k = key(entry.materialId, entry.workCenterId)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({
      scope: 'materialWorkCenter',
      materialId: entry.materialId,
      workCenterId: entry.workCenterId,
      value: round(rng.range(0.52, 0.9), 4),
      note: 'Part-specific OEE measured over a full quarter of production.',
    })
  }

  return out
}

/**
 * Six to ten dated improvement programmes.
 *
 * Two are plant-wide: a plant-scope glide path lands every work center in the
 * plant on the same number, which is exactly what "the plant hit its OEE
 * target" means and exactly why it is used sparingly. The rest are single
 * assets, where per-machine variation survives.
 */
function buildGlidePaths(
  workCenters: readonly WorkCenter[],
  weekCount: number,
  rng: Rng,
): OeeGlidePath[] {
  const w = (fraction: number): WeekIndex => clamp(Math.round(fraction * (weekCount - 1)), 0, weekCount - 1)
  const paths: OeeGlidePath[] = [
    {
      id: 'GP-PL-WRO-OEE',
      scope: 'plant',
      plantId: 'PL-WRO',
      fromWeek: w(0.13),
      toWeek: w(0.74),
      startValue: 0.74,
      endValue: 0.84,
      curve: 'sCurve',
      label: 'Wrocław OEE programme 0.74 → 0.84',
    },
    {
      id: 'GP-MX-SLP-OEE',
      scope: 'plant',
      plantId: 'MX-SLP',
      fromWeek: w(0.08),
      toWeek: w(0.56),
      startValue: 0.76,
      endValue: 0.82,
      curve: 'sCurve',
      label: 'San Luis Potosí changeover-reduction programme 0.76 → 0.82',
    },
  ]

  const candidates = rng.shuffle(workCenters.map((wc) => wc)).slice(0, 6)
  const shapes: Array<{ curve: OeeGlidePath['curve']; label: string; gain: number }> = [
    { curve: 'sCurve', label: 'tooling rebuild and cycle re-optimisation', gain: 0.07 },
    { curve: 'linear', label: 'operator certification programme', gain: 0.05 },
    { curve: 'step', label: 'controller replacement at commissioning', gain: 0.06 },
    { curve: 'sCurve', label: 'hot-runner refurbishment', gain: 0.08 },
    { curve: 'linear', label: 'preventive-maintenance regime change', gain: 0.04 },
    { curve: 'step', label: 'mould-flow correction after the trial run', gain: 0.05 },
  ]
  for (let i = 0; i < candidates.length; i++) {
    const wc = at(candidates, i, 'glide path work center')
    const shape = at(shapes, i % shapes.length, 'glide shape')
    const from = rng.int(4, Math.max(4, weekCount - 30))
    const to = Math.min(weekCount - 1, from + rng.int(12, 34))
    paths.push({
      id: `GP-${wc.id}`,
      scope: 'workCenter',
      workCenterId: wc.id,
      fromWeek: from,
      toWeek: to,
      endValue: round(clamp(wc.baseOee + shape.gain, 0.45, 0.95), 4),
      curve: shape.curve,
      label: `${wc.code}: ${shape.label}`,
    })
  }

  return paths
}

// ---------------------------------------------------------------------------
// Downtime
// ---------------------------------------------------------------------------

/** Weeks a plant is collectively closed. Supply is not planned into them. */
export interface ShutdownWindows {
  byPlant: Map<PlantId, Set<WeekIndex>>
}

function weeksInMonth(time: TimeGrid, monthSuffix: string): WeekIndex[] {
  const out: WeekIndex[] = []
  for (let w = 0; w < time.monthOfWeek.length; w++) {
    const month = at(time.monthOfWeek, w, 'month of week')
    if (month.endsWith(monthSuffix)) out.push(w)
  }
  return out
}

/** Consecutive runs inside a week list — one per calendar occurrence. */
function runsOf(weeks: readonly WeekIndex[]): WeekIndex[][] {
  const runs: WeekIndex[][] = []
  let current: WeekIndex[] = []
  for (const w of weeks) {
    const last = current[current.length - 1]
    if (last === undefined || w === last + 1) current.push(w)
    else {
      runs.push(current)
      current = [w]
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

interface DowntimeBuild {
  events: DowntimeEvent[]
  shutdowns: ShutdownWindows
}

/**
 * Every kind of PLANNED loss, always work-center scoped. A plant shutdown is
 * expanded here, at authoring time, into one event per work center, so there is
 * exactly one place to look when a week is blocked.
 *
 * Unplanned loss is deliberately absent. It lives inside OEE and has no date;
 * giving it one would be a precise-looking lie.
 */
function buildDowntime(
  profile: Profile,
  time: TimeGrid,
  workCenters: readonly WorkCenter[],
  rng: Rng,
): DowntimeBuild {
  const events: DowntimeEvent[] = []
  const byPlant = new Map<PlantId, Set<WeekIndex>>()
  const weekCount = time.weeks.length
  const byPlantWorkCenters = new Map<PlantId, WorkCenter[]>()
  for (const wc of workCenters) {
    const bucket = byPlantWorkCenters.get(wc.plantId)
    if (bucket) bucket.push(wc)
    else byPlantWorkCenters.set(wc.plantId, [wc])
  }
  const noteShutdown = (plantId: PlantId, from: WeekIndex, to: WeekIndex): void => {
    let set = byPlant.get(plantId)
    if (set === undefined) {
      set = new Set<WeekIndex>()
      byPlant.set(plantId, set)
    }
    for (let w = from; w <= to; w++) set.add(w)
  }

  let serial = 0
  const nextId = (prefix: string): string => {
    serial += 1
    return `DT-${prefix}-${String(serial).padStart(4, '0')}`
  }

  /**
   * Partial downtime is expressed as a SHARE of the affected pools, never as an
   * absolute number of hours.
   *
   * A flat "90 hours a week" is nothing on a six-machine three-shift cell and
   * annihilates a three-operator single-shift one — and a work center whose
   * pool has been annihilated still carries the plan's volume, so it reports
   * 2,000% utilisation for what is really a calendar collision. The share is
   * taken against the SMALLER of the two pools so neither is wiped when an
   * event blocks both.
   */
  const shareOfPools = (wc: WorkCenter, share: number): number => {
    let smallest = Number.POSITIVE_INFINITY
    for (const pool of wc.pools) {
      const hours = weeklyHoursOf(pool)
      if (hours > 0 && hours < smallest) smallest = hours
    }
    if (!Number.isFinite(smallest)) return 0
    return round(smallest * share, 1)
  }

  // --- European collective vacation ----------------------------------------
  // Labour only: the presses are not switched off, there is nobody to run them.
  // That distinction is the whole reason the two pools are separate objects.
  for (const plantId of ['DE-ING', 'PL-WRO'] as const) {
    for (const run of runsOf(weeksInMonth(time, '-08'))) {
      const from = at(run, 0, 'august week')
      const to = at(run, Math.min(1, run.length - 1), 'august week')
      noteShutdown(plantId, from, to)
      for (const wc of byPlantWorkCenters.get(plantId) ?? []) {
        events.push({
          id: nextId('VAC'),
          workCenterId: wc.id,
          kind: 'shutdown',
          status: 'confirmed',
          fromWeek: from,
          toWeek: to,
          pools: ['labour'],
          label: `Collective vacation — ${plantId}`,
        })
      }
    }
  }

  // --- Chinese New Year -----------------------------------------------------
  // Both pools: the site closes, and it closes for longer than the calendar
  // week because the workforce travels.
  for (const run of runsOf(weeksInMonth(time, '-02'))) {
    const from = at(run, 0, 'february week')
    const to = from
    noteShutdown('CN-SUZ', from, to)
    for (const wc of byPlantWorkCenters.get('CN-SUZ') ?? []) {
      events.push({
        id: nextId('CNY'),
        workCenterId: wc.id,
        kind: 'shutdown',
        status: 'confirmed',
        fromWeek: from,
        toWeek: to,
        pools: ['machine', 'labour'],
        label: 'Chinese New Year — CN-SUZ',
      })
    }
  }

  // --- Preventive maintenance ----------------------------------------------
  // Every sixth work center carries a PM programme, recurring every 8-14 weeks.
  // Applying one to all 150 would put ~1,000 events on the calendar and drown
  // every other kind of planned loss in the downtime view.
  for (let i = 1; i < workCenters.length; i += 6) {
    const wc = at(workCenters, i, 'work center')
    const interval = rng.int(8, 14)
    for (let w = rng.int(2, interval); w < weekCount; w += interval) {
      events.push({
        id: nextId('PM'),
        workCenterId: wc.id,
        kind: 'maintenance',
        status: 'planned',
        fromWeek: w,
        toWeek: w,
        pools: ['machine'],
        // 8-24 hours is a real PM window, but never more than a third of a
        // small cell's week.
        hoursPerWeek: Math.min(round(rng.range(8, 24), 1), shareOfPools(wc, 0.33)),
        label: `Planned preventive maintenance — ${wc.code}`,
      })
    }
  }

  const scale = profile.workCenterCount / 150
  const shuffled = rng.shuffle(workCenters.map((wc) => wc))
  let cursor = 0
  const nextWc = (): WorkCenter => {
    const wc = at(shuffled, cursor % shuffled.length, 'work center')
    cursor += 1
    return wc
  }

  // --- Capex projects -------------------------------------------------------
  const projectCount = Math.max(6, Math.round(25 * scale))
  for (let i = 0; i < projectCount; i++) {
    const wc = nextWc()
    const from = rng.int(3, Math.max(3, weekCount - 6))
    const to = Math.min(weekCount - 1, from + rng.int(1, 3))
    events.push({
      id: nextId('PRJ'),
      workCenterId: wc.id,
      kind: 'project',
      status: rng.chance(0.5) ? 'confirmed' : 'planned',
      fromWeek: from,
      toWeek: to,
      pools: ['machine', 'labour'],
      // Partial, not a block: a line move degrades a cell for a few weeks
      // rather than deleting it, and modelling it as a block would manufacture
      // a bottleneck that does not exist.
      hoursPerWeek: shareOfPools(wc, rng.range(0.2, 0.45)),
      label: `Capex line move — ${wc.code}`,
    })
  }

  // --- Qualification runs ---------------------------------------------------
  const qualificationCount = Math.max(12, Math.round(40 * scale))
  for (let i = 0; i < qualificationCount; i++) {
    const wc = nextWc()
    const from = rng.int(1, Math.max(1, weekCount - 4))
    const span = rng.int(1, 2)
    const to = Math.min(weekCount - 1, from + span - 1)
    events.push({
      id: nextId('QUAL'),
      workCenterId: wc.id,
      kind: 'qualification',
      status: rng.chance(0.35) ? 'planned' : 'confirmed',
      fromWeek: from,
      toWeek: to,
      pools: ['machine'],
      hoursPerWeek: shareOfPools(wc, rng.range(0.12, 0.32)),
      label: `PPAP trial run — ${wc.code}`,
    })
  }

  // --- Installations, at risk ----------------------------------------------
  // The only events carrying `slipWeeks`. `slippedWindow` models them in their
  // SLIPPED position, so the baseline already answers "what if this runs late?"
  // rather than pretending the date is firm.
  const installCount = clamp(Math.round(6 * scale), 4, 8)
  for (let i = 0; i < installCount; i++) {
    const wc = nextWc()
    const from = rng.int(6, Math.max(6, weekCount - 12))
    const to = Math.min(weekCount - 1, from + rng.int(1, 3))
    events.push({
      id: nextId('INST'),
      workCenterId: wc.id,
      kind: 'installation',
      status: 'atRisk',
      fromWeek: from,
      toWeek: to,
      pools: ['machine', 'labour'],
      hoursPerWeek: shareOfPools(wc, rng.range(0.3, 0.6)),
      slipWeeks: rng.int(2, 5),
      label: `Retrofit commissioning — ${wc.code}`,
    })
  }

  return { events, shutdowns: { byPlant } }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Average weekly eaches by ABC class. Value and volume move together. */
function baseVolume(abcClass: Material['abcClass'], rng: Rng): number {
  switch (abcClass) {
    case 'A':
      return rng.range(4000, 20000)
    case 'B':
      return rng.range(800, 5000)
    default:
      return rng.range(60, 900)
  }
}

/**
 * How often a part runs — derived from what a week can absorb, never chosen.
 *
 * Setup is charged once per (work center, material, week) that carries volume,
 * so cadence and lot size are the same decision seen from two ends. Two things
 * go wrong if that decision is made by ABC class alone:
 *
 *   - Run everything every week and the changeovers alone need several times
 *     the hours that exist. At 15,000 SKUs on 150 work centers each asset sees
 *     around 400 distinct (material, operation) pairs; that is a plan nobody
 *     wrote, not a bottleneck to find.
 *   - Run everything rarely and the lots become enormous. A single A-class lot
 *     would then need more hours than the week has, and the work center reports
 *     2,000% utilisation — which reads as a broken dataset.
 *
 * So cadence follows the part's own hours: a material runs often enough that
 * one lot costs about `LOT_SHARE` of one work center's week, and no more often
 * than weekly. Big parts run weekly, small ones run twice a year, and the
 * changeover bill lands where a high-mix plant's actually does.
 */
const LOT_SHARE = 0.07
const MIN_ACTIVITY = 0.02

/**
 * ===========================================================================
 * THE PLAN'S ABSOLUTE SCALE IS DECIDED BEFORE THE LOT POLICY, NOT AFTER.
 *
 * `LOT_SHARE` and `MIN_ACTIVITY` above only mean anything if the volumes they
 * are applied to are the volumes that survive. This generator used to draw
 * volumes from an arbitrary band, decide cadence against them, and only then
 * cut the plan to the hours that exist — a cut of roughly ten to one. Cadence
 * had already been fixed, so the number of LOTS never fell: every part still
 * ran as often, each lot was a tenth of the size, and the changeover bill —
 * which is charged per lot and does not scale — went from a tenth of the
 * network's hours to thirty-seven percent of them. On the smallest cells it
 * went past a hundred percent, and no amount of cutting volume could ever
 * bring those cells back under their ceiling because none of their load was
 * volume.
 *
 * So volumes are normalised to the capacity that exists BEFORE routings are
 * written, and refined once more against the routings that were actually
 * written, before any lot is sized.
 * ===========================================================================
 */
const TARGET_NETWORK_UTILISATION = 0.79
/** Share of required hours the changeover bill is aimed at. */
const TARGET_SETUP_SHARE = 0.16
/** Network-mean OEE, for the pre-routing estimate only. Measured after. */
const NOMINAL_OEE = 0.78

/**
 * Nominal machine hours one unit of a material costs, before any machine is
 * chosen — the mean over its family's operation pool, weighted by how likely
 * each operation is to survive `thinSequence`.
 */
function estimatedHoursPerUnit(familyIndex: number): number {
  const family = at(FAMILY_SPECS, familyIndex, 'family spec')
  const pool = family.opPool
  const n = pool.length
  let middle = 0
  for (const entry of LENGTH_DISTRIBUTION) {
    const length = clamp(entry.length, 2, Math.min(7, n))
    middle += entry.p * (n > 2 ? (length - 2) / (n - 2) : 0)
  }
  const specByOp = new Map<OperationId, (typeof OPERATION_SPECS)[number]>()
  for (const spec of OPERATION_SPECS) specByOp.set(spec.id, spec)
  let hours = 0
  for (let i = 0; i < n; i++) {
    const spec = specByOp.get(at(pool, i, 'family operation'))
    if (spec === undefined) continue
    const midRate = (at(spec.rateBand, 0, 'rate low') + at(spec.rateBand, 1, 'rate high')) / 2
    if (midRate <= 0) continue
    const probability = i === 0 || i === n - 1 ? 1 : middle
    hours += (probability / midRate) / NOMINAL_OEE
  }
  return hours
}

/**
 * Scale every material's weekly volume so the network's run hours land near
 * the utilisation the calibration is aiming for.
 *
 * Cold work centers are excluded from the denominator: they are approved for
 * nothing and will carry no load, so counting their hours here would size the
 * plan against capacity that is never offered to it.
 */
function scaleVolumesToCapacity(
  workCenters: readonly WorkCenter[],
  cold: ReadonlySet<WorkCenterId>,
  familyIndexOf: readonly number[],
  volumeOf: number[],
): number {
  let warmHours = 0
  for (const wc of workCenters) {
    if (cold.has(wc.id)) continue
    for (const pool of wc.pools) if (pool.pool === 'machine') warmHours += weeklyHoursOf(pool)
  }
  const hoursByFamily = FAMILY_SPECS.map((_, fi) => estimatedHoursPerUnit(fi))
  let implied = 0
  for (let i = 0; i < volumeOf.length; i++) {
    implied +=
      at(volumeOf, i, 'material volume') *
      at(hoursByFamily, at(familyIndexOf, i, 'family index'), 'family hours')
  }
  if (!(implied > 0)) return 1
  const target = warmHours * TARGET_NETWORK_UTILISATION * (1 - TARGET_SETUP_SHARE)
  const scale = clamp(target / implied, 1e-6, 1e6)
  for (let i = 0; i < volumeOf.length; i++) {
    volumeOf[i] = at(volumeOf, i, 'material volume') * scale
  }
  return scale
}

/**
 * Share of weeks a supply row carries volume.
 *
 * `weeklyUnits` is the row's average weekly quantity; `bindingFactor` is the
 * share of one work-center week a single unit costs at the tightest operation
 * on its routing. Their product is the row's weekly utilisation of that asset,
 * and dividing by `LOT_SHARE` gives the cadence at which one lot costs that
 * asset `LOT_SHARE` of its week.
 */
function activityRate(weeklyUnits: number, bindingFactor: number): number {
  const weeklyShare = weeklyUnits * bindingFactor
  if (!(weeklyShare > 0)) return MIN_ACTIVITY
  return clamp(weeklyShare / LOT_SHARE, MIN_ACTIVITY, 1)
}

interface SupplyShape {
  rowKeys: string[]
  /** The un-calibrated plan, before levelling and before the fit. */
  base: Float64Array
  /** Material x week smooth stream, the demand plan's starting point. */
  demandBase: Float64Array
  rowMaterial: MaterialId[]
  rowPlant: PlantId[]
  /** Material row index in `demandBase` for each supply row. */
  rowMaterialIndex: number[]
  /** Weeks between two runs of this row. 1 means it runs every week. */
  rowStride: number[]
  /** This plant's share of the material's volume. */
  rowShare: number[]
}

/**
 * The supply plan's shape, at an arbitrary scale.
 *
 * Three things are deliberately built in here rather than emerging by accident:
 * seasonality with a per-material phase, so weeks differ; a real lot policy, so
 * a C-class part ships four times a year rather than every week and the setup
 * charge lands where a high-mix plant's actually does; and hard zeroes in the
 * weeks a plant is collectively shut, because nobody plans production into a
 * closed factory and a plan that does would report a bottleneck that is really
 * a calendar.
 *
 * The CADENCE is decided here; which weeks it lands in is not. The phase drawn
 * below is a starting point that `levelLots` replaces with a chosen one — see
 * the note there for why a random phase is worth a third of the weekly load in
 * variation it does not need to have.
 */
function buildSupplyShape(
  materials: readonly Material[],
  volumeOf: readonly number[],
  time: TimeGrid,
  shutdowns: ShutdownWindows,
  bindingFactorByRow: Map<string, number>,
  rng: Rng,
): SupplyShape {
  const weeks = time.weeks.length
  const rowKeys: string[] = []
  const rowMaterial: MaterialId[] = []
  const rowPlant: PlantId[] = []
  const rowMaterialIndex: number[] = []
  const rowShare: number[] = []
  const rowVolume: number[] = []

  const demandBase = new Float64Array(materials.length * weeks)

  for (let mi = 0; mi < materials.length; mi++) {
    const material = at(materials, mi, 'material')
    if (material.plantIds.length === 0) continue
    const volume = at(volumeOf, mi, 'material volume')
    const phase = rng.range(0, 52)
    const amplitude = rng.range(0.04, 0.16)
    const noiseScale = rng.range(0.05, 0.18)

    const offset = mi * weeks
    for (let w = 0; w < weeks; w++) {
      const seasonal = 1 + amplitude * Math.sin((2 * Math.PI * (w + phase)) / 52)
      demandBase[offset + w] = volume * seasonal * (1 + rng.range(-noiseScale, noiseScale))
    }

    // Primary plant carries the bulk; alternates exist so a transfer has
    // somewhere qualified to land, not so volume is evenly smeared.
    const shares: number[] = []
    let remaining = 1
    for (let p = 0; p < material.plantIds.length; p++) {
      if (p === material.plantIds.length - 1) {
        shares.push(remaining)
      } else {
        const share = remaining * rng.range(0.55, 0.85)
        shares.push(share)
        remaining -= share
      }
    }

    for (let p = 0; p < material.plantIds.length; p++) {
      const plantId = at(material.plantIds, p, 'material plant')
      rowKeys.push(key(material.id, plantId))
      rowMaterial.push(material.id)
      rowPlant.push(plantId)
      rowMaterialIndex.push(mi)
      rowShare.push(at(shares, p, 'plant share'))
      rowVolume.push(volume)
    }
  }

  const base = new Float64Array(rowKeys.length * weeks)
  const rowStride: number[] = []
  for (let r = 0; r < rowKeys.length; r++) {
    const mi = at(rowMaterialIndex, r, 'row material index')
    const share = at(rowShare, r, 'row share')
    const rowKey = at(rowKeys, r, 'supply row key')
    const rate = activityRate(
      at(rowVolume, r, 'row volume') * share,
      bindingFactorByRow.get(rowKey) ?? 0,
    )
    const closed = shutdowns.byPlant.get(at(rowPlant, r, 'row plant'))
    const rowBase = r * weeks
    const materialBase = mi * weeks
    // A CADENCE, not a coin. A part that runs one week in ten runs in weeks
    // 3, 13, 23 …, not on ten independent coin flips — which is both what a
    // planner writes and what keeps the weekly load from swinging: Bernoulli
    // masks on eighteen thousand rows put four times as many lots on some
    // weeks as on others, and a work center whose mean is 0.8 then peaks at
    // 2.5 for reasons that are pure sampling noise.
    const stride = rate >= 1 ? 1 : Math.max(1, Math.round(1 / rate))
    rowStride.push(stride)
    const phase = stride > 1 ? rng.int(0, stride - 1) : 0
    for (let w = 0; w < weeks; w++) {
      if (closed !== undefined && closed.has(w)) continue
      if (stride > 1 && (w + phase) % stride !== 0) continue
      // Lumpy items ship a bigger lot when they do ship, so annual volume is
      // preserved rather than quietly deleted by the activity mask.
      const quantity = f64(demandBase, materialBase + w) * share * stride
      base[rowBase + w] = Math.max(1, Math.round(quantity))
    }
  }

  return { rowKeys, base, demandBase, rowMaterial, rowPlant, rowMaterialIndex, rowStride, rowShare }
}

// ---------------------------------------------------------------------------
// Rebalancing routings against the plan that was actually written
// ---------------------------------------------------------------------------

/**
 * Move operations off the assets the finished plan overloads.
 *
 * The routing generator balances against an ESTIMATE — a mid-band rate, the
 * operation's own setup band, an assumed cadence — because the plan does not
 * exist yet when a routing is written. Every one of those is within a few
 * percent now that the volumes are normalised to real capacity first, but they
 * still compound over four or five operations, and a work center that ends up
 * twenty percent over is one the fit downstream can only fix by cutting volume
 * off every part that touches it.
 *
 * So once the supply plan exists, every routing operation's hours are computed
 * EXACTLY — same arithmetic as `buildLoad`, including reverse yield compounding
 * and per-lot setup — and operations are moved, largest first, from the most
 * loaded asset to the least loaded one qualified for the same operation at the
 * same plant. Only work centers already in that operation's approval pool are
 * considered, so no move invents an approval; and the last operation on any
 * (operation, work center) pair never moves, so no move destroys one either.
 */
interface RebalanceStats {
  moves: number
  before: number
  after: number
}

interface OpEntry {
  routing: Routing
  index: number
  /** Machine hours over the horizon before OEE, at whatever asset holds it. */
  machineNominal: number
  labourNominal: number
  /** Setup hours over the horizon — independent of which asset runs it. */
  setup: number
}

function rebalanceRoutings(
  routings: readonly Routing[],
  supply: PlanMatrix,
  workCenterById: Map<WorkCenterId, WorkCenter>,
  capability: CapabilityPlan,
  weeks: number,
): RebalanceStats {
  const rowIndex = new Map<string, number>()
  for (let r = 0; r < supply.rowKeys.length; r++) {
    rowIndex.set(at(supply.rowKeys, r, 'supply row key'), r)
  }

  const machineCapacity = new Map<WorkCenterId, number>()
  const labourCapacity = new Map<WorkCenterId, number>()
  const oeeOf = new Map<WorkCenterId, number>()
  for (const [id, wc] of workCenterById) {
    let machine = 0
    let labour = 0
    for (const pool of wc.pools) {
      if (pool.pool === 'machine') machine += weeklyHoursOf(pool)
      else labour += weeklyHoursOf(pool)
    }
    machineCapacity.set(id, machine * weeks)
    labourCapacity.set(id, labour * weeks)
    oeeOf.set(id, wc.baseOee > 0 ? wc.baseOee : 0.8)
  }

  // Alternate production versions carry the same work centers as their primary.
  // They have to travel with it: `resolveOperation` matches an alternate by
  // (operation, work center), so leaving one behind would silently make it
  // inert master data.
  const versionsByPair = new Map<string, Routing[]>()
  for (const routing of routings) {
    const pairKey = key(routing.materialId, routing.plantId)
    const bucket = versionsByPair.get(pairKey)
    if (bucket) bucket.push(routing)
    else versionsByPair.set(pairKey, [routing])
  }

  const machineLoad = new Map<WorkCenterId, number>()
  const labourLoad = new Map<WorkCenterId, number>()
  const opCount = new Map<string, number>()
  const entries: OpEntry[] = []

  for (const routing of routings) {
    if (!routing.primary) continue
    const row = rowIndex.get(key(routing.materialId, routing.plantId))
    if (row === undefined) continue
    let units = 0
    let activeWeeks = 0
    const base = row * weeks
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(supply.values, base + w)
      if (quantity > 0) {
        units += quantity
        activeWeeks += 1
      }
    }
    if (units <= 0) continue

    // Reverse yield compounding, exactly as `buildLoad` does it: to ship `units`
    // good parts the last operation must start units/yield, the one before it
    // that divided by its own yield, and so on upstream.
    const ops = routing.operations
    const invCumYield = new Float64Array(ops.length)
    let cumulative = 1
    for (let p = ops.length - 1; p >= 0; p--) {
      const y = at(ops, p, 'routing operation').yield
      cumulative *= y > 0 && y <= 1 ? y : 1
      invCumYield[p] = 1 / cumulative
    }

    for (let p = 0; p < ops.length; p++) {
      const op = at(ops, p, 'routing operation')
      const gross = units * f64(invCumYield, p)
      const machineNominal = (gross * op.machineHoursPerBase) / op.baseQty
      const labourNominal = (gross * op.labourHoursPerBase) / op.baseQty
      const setup = op.setupHours * activeWeeks
      entries.push({ routing, index: p, machineNominal, labourNominal, setup })
      const oee = oeeOf.get(op.workCenterId) ?? 0.8
      machineLoad.set(
        op.workCenterId,
        (machineLoad.get(op.workCenterId) ?? 0) + machineNominal / oee + setup,
      )
      labourLoad.set(
        op.workCenterId,
        (labourLoad.get(op.workCenterId) ?? 0) + labourNominal / oee + setup,
      )
      const pairKey = key(op.opId, op.workCenterId)
      opCount.set(pairKey, (opCount.get(pairKey) ?? 0) + 1)
    }
  }

  const score = (id: WorkCenterId): number => {
    const machine = machineCapacity.get(id) ?? 0
    const labour = labourCapacity.get(id) ?? 0
    const machineScore = machine > 0 ? (machineLoad.get(id) ?? 0) / machine : 0
    const labourScore = labour > 0 ? (labourLoad.get(id) ?? 0) / labour : 0
    return machineScore > labourScore ? machineScore : labourScore
  }
  const spread = (): number => {
    let worst = 0
    for (const id of workCenterById.keys()) {
      const value = score(id)
      if (value > worst) worst = value
    }
    return worst
  }

  const before = spread()
  entries.sort((a, b) => b.machineNominal + b.setup - (a.machineNominal + a.setup))

  let moves = 0
  for (let pass = 0; pass < 3; pass++) {
    let movedThisPass = 0
    for (const entry of entries) {
      const op = at(entry.routing.operations, entry.index, 'routing operation')
      const source = op.workCenterId
      const pairKey = key(op.opId, source)
      // Never strand an operation: the last routing on an (operation, work
      // center) pair is what makes that work center APPROVED for it, and the
      // relief invariant counts approvals.
      if ((opCount.get(pairKey) ?? 0) <= 1) continue
      const pool = capability.byOp.get(op.opId)?.poolByPlant.get(entry.routing.plantId)
      if (pool === undefined || pool.length < 2) continue

      const sourceOee = oeeOf.get(source) ?? 0.8
      const sourceMachine = entry.machineNominal / sourceOee + entry.setup
      const sourceLabour = entry.labourNominal / sourceOee + entry.setup
      const sourceScoreNow = score(source)

      let best: WorkCenterId | undefined
      let bestScore = sourceScoreNow
      for (const candidate of pool) {
        if (candidate === source) continue
        const oee = oeeOf.get(candidate) ?? 0.8
        const machine = machineCapacity.get(candidate) ?? 0
        const labour = labourCapacity.get(candidate) ?? 0
        if (machine <= 0 || labour <= 0) continue
        const resulting = Math.max(
          ((machineLoad.get(candidate) ?? 0) + entry.machineNominal / oee + entry.setup) / machine,
          ((labourLoad.get(candidate) ?? 0) + entry.labourNominal / oee + entry.setup) / labour,
        )
        // Only worth moving if the destination ends up better off than the
        // source is now — otherwise the work just changes hands.
        if (resulting < bestScore) {
          bestScore = resulting
          best = candidate
        }
      }
      if (best === undefined) continue

      const targetOee = oeeOf.get(best) ?? 0.8
      machineLoad.set(source, (machineLoad.get(source) ?? 0) - sourceMachine)
      labourLoad.set(source, (labourLoad.get(source) ?? 0) - sourceLabour)
      machineLoad.set(best, (machineLoad.get(best) ?? 0) + entry.machineNominal / targetOee + entry.setup)
      labourLoad.set(best, (labourLoad.get(best) ?? 0) + entry.labourNominal / targetOee + entry.setup)
      opCount.set(pairKey, (opCount.get(pairKey) ?? 0) - 1)
      opCount.set(key(op.opId, best), (opCount.get(key(op.opId, best)) ?? 0) + 1)

      for (const version of versionsByPair.get(key(entry.routing.materialId, entry.routing.plantId)) ?? []) {
        const twin = version.operations[entry.index]
        if (twin !== undefined && twin.opId === op.opId && twin.workCenterId === source) {
          twin.workCenterId = best
        }
      }
      moves += 1
      movedThisPass += 1
    }
    if (movedThisPass === 0) break
  }

  return { moves, before, after: spread() }
}

/**
 * Staff each cell for the work it was actually given.
 *
 * Operator pools are sized when the work center is built, long before anyone
 * knows what it will run — and how many operator hours a machine hour costs is
 * a property of the OPERATION, not of the machine: assembly wants 2.5 operator
 * hours per machine hour, high-volume moulding wants 0.6. A cell that happens
 * to collect assembly work is therefore labour-bound whatever its shift
 * pattern, and its presses stop being filled at the point its operators run
 * out. Measured on the generated network that cost SEVEN POINTS of network
 * machine utilisation — a quarter of the assets held below 0.6 on the pool
 * nobody was looking at.
 *
 * So once the routings are final, every pool is re-sized against the labour it
 * was actually handed, to a deliberate ratio:
 *
 *   most cells   operators run at 0.78 of the machine utilisation — slack, so
 *                the machine is the constraint and capex is the answer;
 *   a sixth      operators run at 1.25 of it — the cell saturates on PEOPLE,
 *                and the answer is hiring.
 *
 * Both cases have to exist, or "machine-bound or labour-bound?" — the question
 * the two-pool model is built to answer — has one answer for the whole network.
 */
const LABOUR_SLACK_RATIO = 0.78
const LABOUR_SHORT_RATIO = 1.12

function staffWorkCenters(
  workCenters: readonly WorkCenter[],
  labourShort: ReadonlySet<WorkCenterId>,
  routings: readonly Routing[],
  supply: PlanMatrix,
  weeks: number,
): void {
  const rowIndex = new Map<string, number>()
  for (let r = 0; r < supply.rowKeys.length; r++) {
    rowIndex.set(at(supply.rowKeys, r, 'supply row key'), r)
  }
  const machineHoursOf = new Map<WorkCenterId, number>()
  const labourHoursOf = new Map<WorkCenterId, number>()

  for (const routing of routings) {
    if (!routing.primary) continue
    const row = rowIndex.get(key(routing.materialId, routing.plantId))
    if (row === undefined) continue
    let units = 0
    let activeWeeks = 0
    const base = row * weeks
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(supply.values, base + w)
      if (quantity > 0) {
        units += quantity
        activeWeeks += 1
      }
    }
    if (units <= 0) continue

    const ops = routing.operations
    const invCumYield = new Float64Array(ops.length)
    let cumulative = 1
    for (let p = ops.length - 1; p >= 0; p--) {
      const y = at(ops, p, 'routing operation').yield
      cumulative *= y > 0 && y <= 1 ? y : 1
      invCumYield[p] = 1 / cumulative
    }
    const seen = new Set<WorkCenterId>()
    for (let p = 0; p < ops.length; p++) {
      const op = at(ops, p, 'routing operation')
      const gross = units * f64(invCumYield, p)
      // Setup lands on both pools equally, so it has to be inside the ratio —
      // a cell whose hours are mostly changeovers is not labour-heavy at all.
      const setup = seen.has(op.workCenterId) ? 0 : op.setupHours * activeWeeks
      seen.add(op.workCenterId)
      machineHoursOf.set(
        op.workCenterId,
        (machineHoursOf.get(op.workCenterId) ?? 0) + (gross * op.machineHoursPerBase) / op.baseQty + setup,
      )
      labourHoursOf.set(
        op.workCenterId,
        (labourHoursOf.get(op.workCenterId) ?? 0) + (gross * op.labourHoursPerBase) / op.baseQty + setup,
      )
    }
  }

  for (const wc of workCenters) {
    const machineRequired = machineHoursOf.get(wc.id) ?? 0
    const labourRequired = labourHoursOf.get(wc.id) ?? 0
    if (!(machineRequired > 0) || !(labourRequired > 0)) continue
    const machine = wc.pools.find((pool) => pool.pool === 'machine')
    const labour = wc.pools.find((pool) => pool.pool === 'labour')
    if (machine === undefined || labour === undefined) continue
    const machineWeekly = weeklyHoursOf(machine)
    if (!(machineWeekly > 0)) continue
    const ratio = labourRequired / machineRequired
    const wanted = labourShort.has(wc.id) ? LABOUR_SHORT_RATIO : LABOUR_SLACK_RATIO
    const wantedHours = (ratio * machineWeekly) / wanted
    const perOperator = labour.shiftsPerDay * labour.hoursPerShift * labour.daysPerWeek * labour.utilisationFactor
    if (!(perOperator > 0)) continue
    labour.count = clamp(Math.round(wantedHours / perOperator), 2, 40)
  }
}

// ---------------------------------------------------------------------------
// Calibration — measured against the engine, never against a restatement of it
// ---------------------------------------------------------------------------

/**
 * The load explosion with everything that does not depend on quantity resolved
 * once.
 *
 * The calibration below has to run the load arithmetic thirty-odd times, and
 * `buildLoad` costs 200ms a run because it re-resolves every (row, operation)
 * pair through `resolveOperation` each time. Nothing in that resolution depends
 * on the plan's quantities, so it is done ONCE here and the iteration becomes a
 * multiply-accumulate over flat arrays.
 *
 * This is the same arithmetic, not a similar one: the same `resolveOperation`
 * (so alternate production versions and rate overrides land), the same
 * `resolveOee` (so glide paths and material-specific overrides land), the same
 * reverse yield compounding, and the same rule that setup is charged once per
 * (work center, material, week). `buildSnapshot` re-measures the finished plan
 * with the real `buildLoad` and the result is asserted against this model, so a
 * drift between the two is a build failure rather than a silent lie.
 */
interface PlanLoadModel {
  weeks: number
  wcCount: number
  rowCount: number
  /** `opStart[row] .. opStart[row + 1]` indexes the flat operation arrays. */
  opStart: Int32Array
  opWorkCenterRow: Int32Array
  /** Nominal hours per PLANNED unit — yield-compounded, before OEE. */
  opMachinePerUnit: Float64Array
  opLabourPerUnit: Float64Array
  /** Setup for the lot. Zero unless this is the first operation at that asset. */
  opSetup: Float64Array
  /** Row into `materialInverseOee`, or -1 to read the work center's own. */
  opOverrideRow: Int32Array
  inverseOee: Float64Array
  materialInverseOee: Float64Array
  machineRequired: Float64Array
  labourRequired: Float64Array
  machineSetup: Float64Array
  labourSetup: Float64Array
}

function buildPlanLoadModel(
  snapshot: Snapshot,
  idx: ReturnType<typeof buildIndexes>,
  oeeGrid: Float64Array,
  sourcing: SourcingPlan,
): PlanLoadModel {
  const weeks = idx.weekCount
  const wcCount = idx.workCenterOrder.length
  const rowCount = snapshot.supplyPlan.rowKeys.length

  const inverseOee = new Float64Array(wcCount * weeks)
  for (let i = 0; i < inverseOee.length; i++) {
    const oee = f64(oeeGrid, i)
    inverseOee[i] = oee > 0 ? 1 / oee : 0
  }

  const materialsWithOeeOverride = new Set<MaterialId>()
  for (const override of snapshot.oeeOverrides) {
    if (override.scope === 'materialWorkCenter' && override.materialId !== undefined) {
      materialsWithOeeOverride.add(override.materialId)
    }
  }

  const opStart = new Int32Array(rowCount + 1)
  const workCenterRow: number[] = []
  const machinePerUnit: number[] = []
  const labourPerUnit: number[] = []
  const setupOf: number[] = []
  const overrideRow: number[] = []
  const overrideValues: number[] = []

  for (let row = 0; row < rowCount; row++) {
    opStart[row] = workCenterRow.length
    const rowKey = at(snapshot.supplyPlan.rowKeys, row, 'supply row key')
    const separator = rowKey.indexOf('|')
    const materialId = separator < 0 ? rowKey : rowKey.slice(0, separator)
    // The factory never dual-sources and never dates a routing, so a row's
    // source is the same in every week. Read from the plan rather than assumed,
    // so a future dated routing would be caught by the buildLoad cross-check.
    const routingIndex = i32(sourcing.routingOfRow, row * weeks)
    if (routingIndex < 0) continue
    const routing = at(snapshot.routings, routingIndex, 'routing')
    const ops = routing.operations
    const perMaterialOee = materialsWithOeeOverride.has(materialId)

    // Resolve first, compound second: `resolveOperation` may substitute a whole
    // alternate production version, and its yield is the one that then applies.
    const resolved = ops.map((op) => resolveOperation(snapshot, idx, materialId, op, 1))
    const invCumYield = new Float64Array(ops.length)
    let cumulative = 1
    for (let p = ops.length - 1; p >= 0; p--) {
      const y = at(resolved, p, 'resolved operation').yield
      cumulative *= y > 0 && y <= 1 ? y : 1
      invCumYield[p] = 1 / cumulative
    }

    const stamped = new Set<number>()
    for (let p = 0; p < ops.length; p++) {
      const op = at(ops, p, 'routing operation')
      const wcRow = idx.workCenterRow.get(op.workCenterId)
      if (wcRow === undefined) continue
      const entry = at(resolved, p, 'resolved operation')
      const machine = Number.isFinite(entry.machineHoursPerUnit) ? entry.machineHoursPerUnit : 0
      const labour = Number.isFinite(entry.labourHoursPerUnit) ? entry.labourHoursPerUnit : 0
      const gross = f64(invCumYield, p)
      const charges = entry.setupHours > 0 && !stamped.has(wcRow)
      if (charges) stamped.add(wcRow)
      workCenterRow.push(wcRow)
      machinePerUnit.push(machine * gross)
      labourPerUnit.push(labour * gross)
      setupOf.push(charges ? entry.setupHours : 0)
      if (perMaterialOee) {
        overrideRow.push(overrideValues.length / weeks)
        for (let w = 0; w < weeks; w++) {
          const oee = resolveOee(snapshot, idx, oeeGrid, op.workCenterId, materialId, w)
          overrideValues.push(oee > 0 ? 1 / oee : 0)
        }
      } else {
        overrideRow.push(-1)
      }
    }
  }
  opStart[rowCount] = workCenterRow.length

  return {
    weeks,
    wcCount,
    rowCount,
    opStart,
    opWorkCenterRow: Int32Array.from(workCenterRow),
    opMachinePerUnit: Float64Array.from(machinePerUnit),
    opLabourPerUnit: Float64Array.from(labourPerUnit),
    opSetup: Float64Array.from(setupOf),
    opOverrideRow: Int32Array.from(overrideRow),
    inverseOee,
    materialInverseOee: Float64Array.from(overrideValues),
    machineRequired: new Float64Array(wcCount * weeks),
    labourRequired: new Float64Array(wcCount * weeks),
    machineSetup: new Float64Array(wcCount * weeks),
    labourSetup: new Float64Array(wcCount * weeks),
  }
}

/** Required and setup hours per (work center, pool, week) for one plan. */
function measurePlan(model: PlanLoadModel, values: Float64Array): void {
  const weeks = model.weeks
  model.machineRequired.fill(0)
  model.labourRequired.fill(0)
  model.machineSetup.fill(0)
  model.labourSetup.fill(0)
  const machineRequired = model.machineRequired
  const labourRequired = model.labourRequired
  const machineSetup = model.machineSetup
  const labourSetup = model.labourSetup

  for (let row = 0; row < model.rowCount; row++) {
    const from = i32(model.opStart, row)
    const to = i32(model.opStart, row + 1)
    if (to <= from) continue
    const rowBase = row * weeks
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(values, rowBase + w)
      if (!(quantity > 0)) continue
      for (let p = from; p < to; p++) {
        const wcRow = i32(model.opWorkCenterRow, p)
        if (wcRow < 0) continue
        const override = i32(model.opOverrideRow, p)
        const inverse =
          override >= 0
            ? f64(model.materialInverseOee, override * weeks + w)
            : f64(model.inverseOee, wcRow * weeks + w)
        const gi = wcRow * weeks + w
        machineRequired[gi] = f64(machineRequired, gi) + quantity * f64(model.opMachinePerUnit, p) * inverse
        labourRequired[gi] = f64(labourRequired, gi) + quantity * f64(model.opLabourPerUnit, p) * inverse
        const setup = f64(model.opSetup, p)
        if (setup > 0) {
          machineRequired[gi] = f64(machineRequired, gi) + setup
          labourRequired[gi] = f64(labourRequired, gi) + setup
          machineSetup[gi] = f64(machineSetup, gi) + setup
          labourSetup[gi] = f64(labourSetup, gi) + setup
        }
      }
    }
  }
}

/**
 * The utilisation each work center is meant to reach, week by week.
 *
 * Three populations, because a network where every asset sits at the same
 * number has no story in it:
 *
 *   COLD    approved for nothing, so they carry no load at all. These are the
 *           relief targets — the answer to "where could this go?".
 *   NORMAL  a spread of comfortable levels, on a gentle ramp, that never
 *           reaches the ceiling. A hundred assets reading red is not a hundred
 *           bottlenecks, it is a broken plan.
 *   HOT     the network's structural bottlenecks. A STEEPER ramp, so they are
 *           comfortable early and cross their ceiling only in the last third —
 *           a bottleneck a planner watches arrive is worth something, one that
 *           was there in week 1 is just a fact.
 */
const HOT_WORK_CENTER_SHARE = 0.16
const HOT_WORK_CENTER_MIN = 8
const HOT_WORK_CENTER_MAX = 28
/** Peaks the bottlenecks are asked to reach. Real, visible, and survivable. */
const HOT_PEAK_LOW = 1.14
const HOT_PEAK_HIGH = 1.42
/** Peaks the comfortable majority is asked to reach. All of them under 1.0. */
const NORMAL_PEAK_LOW = 0.88
const NORMAL_PEAK_HIGH = 0.98
const NORMAL_RAMP_START = 0.95
const NORMAL_RAMP_END = 1.04
const NORMAL_RAMP_EXPONENT = 1.35
const HOT_RAMP_START = 0.62
const HOT_RAMP_END = 1.32
const HOT_RAMP_EXPONENT = 2.6
/**
 * Ceilings on the target field itself, by population.
 *
 * These are what stop the LEVEL solve from turning the whole network red. The
 * level slides every target together until the network's utilisation lands on
 * its band; without a cap, a network whose rows cannot all be loaded to their
 * target sees the level climb until the ones that CAN be loaded are all at
 * 1.45 — the average is right and every asset reads as a bottleneck.
 */
const NORMAL_PEAK_MAX = 0.99
const MAX_CELL_TARGET = 1.45
/** Share of the hot set that binds on OPERATORS rather than on machines. */
const HOT_LABOUR_SHARE = 0.35

/** Volume multiplier for a week. Superlinear, so the back half carries the ramp. */
function growth(week: number, weeks: number, start: number, end: number, exponent: number): number {
  if (weeks <= 1) return end
  return start + (end - start) * (week / (weeks - 1)) ** exponent
}

/**
 * Deal ids out one plant at a time, so any prefix of the result spans as many
 * sites as it possibly can. A bottleneck list that names one plant is a story
 * about that plant, not about a network.
 */
function dealAcrossPlants(
  ids: readonly WorkCenterId[],
  plantOf: Map<WorkCenterId, PlantId>,
  rng: Rng,
): WorkCenterId[] {
  const buckets = new Map<PlantId, WorkCenterId[]>()
  for (const id of rng.shuffle(ids)) {
    const plantId = plantOf.get(id)
    if (plantId === undefined) continue
    const bucket = buckets.get(plantId)
    if (bucket) bucket.push(id)
    else buckets.set(plantId, [id])
  }
  const plants = [...buckets.keys()].sort()
  const out: WorkCenterId[] = []
  for (let more = true; more; ) {
    more = false
    for (const plantId of plants) {
      const bucket = buckets.get(plantId)
      const next = bucket?.shift()
      if (next !== undefined) {
        out.push(next)
        more = true
      }
    }
  }
  return out
}

/** What the calibrated plan actually achieved. Measured, never assumed. */
export interface CalibrationResult {
  /** The level the target field converged to. */
  level: number
  /** Machine hours required over machine hours available, whole horizon. */
  networkUtilisation: number
  /** The worst single (work center, week) utilisation the engine reports. */
  peakUtilisation: number
  workCentersOverCeiling: number
  workCentersUnderloaded: number
  machineBoundOverloads: number
  labourBoundOverloads: number
  overloadedCells: number
  totalCells: number
  setupShareOfRequiredHours: number
  /** Cells whose changeover bill alone exceeds their target. Should be zero. */
  structurallyOverloadedCells: number
}

/** Damping and bounds for the proportional fit. */
const FIT_OUTER_PASSES = 6
const FIT_INNER_ITERATIONS = 4
const FIT_DAMPING = 0.75
const MIN_CELL_FACTOR = 0.2
const MAX_CELL_FACTOR = 2.5
const LEVEL_DAMPING = 0.6
const PEAK_DAMPING = 0.7
/** Early iterations thin lots off cells the changeover bill has taken over. */
const THINNING_PASSES = 3
const INITIAL_LEVELLING_PASSES = 2
const RELEVELLING_PASSES = 1

/** How much of a cell's target the changeover bill may consume before lots are thinned. */
const SETUP_CELL_CAP = 0.55

/**
 * Room a pool has for MORE VOLUME, as a multiplier on the volume already there.
 *
 * Setup is the part of a cell's hours that does not move when the plan is
 * scaled, so it is subtracted from both sides. Scaling a cell that is 90%
 * changeovers by 0.5 removes 5% of its load, and a fit that does not know that
 * will keep halving a row forever and never reach its target.
 */
function poolAllowance(targetHours: number, required: number, setup: number): number {
  const variable = required - setup
  if (!(variable > 1e-9)) return targetHours >= setup ? MAX_CELL_FACTOR : MIN_CELL_FACTOR
  const room = targetHours - setup
  if (!(room > 0)) return MIN_CELL_FACTOR
  return clamp(room / variable, MIN_CELL_FACTOR, MAX_CELL_FACTOR)
}

/**
 * LEVEL the lots across the horizon before any of them is resized.
 *
 * This is the pass that decides whether the bands are reachable at all, and it
 * took a while to see why. A supply row runs on a CADENCE — every week, every
 * fourth week, every fortieth — and `buildSupplyShape` picks the phase of that
 * cadence at random. With about fourteen lots landing on a work center in a
 * given week and lot sizes spanning two orders of magnitude, random phases give
 * each cell a weekly load with a coefficient of variation around a third. A
 * work center whose horizon mean is 0.79 then PEAKS near 2.0 for no reason but
 * sampling noise, and no amount of scaling fixes it: scaling every week of a
 * row by the same factor cannot move load from a full week to an empty one, and
 * scaling only the full weeks throws the volume away.
 *
 * Choosing the phase instead of drawing it costs nothing — the same lots, the
 * same cadence, the same changeover bill — and it is what a real plant does
 * when it levels a schedule. Rows are placed biggest first, each one taking the
 * phase that minimises the squared normalised load across every cell it
 * touches, which spreads big lots first and lets the small ones fill in.
 *
 * The reference the load is normalised against is the TARGET FIELD, not raw
 * capacity, so the levelling aims at the shape the fit is about to ask for
 * rather than at a flat network.
 */
function levelLots(
  model: PlanLoadModel,
  values: Float64Array,
  shape: SupplyShape,
  shutdowns: ShutdownWindows,
  capacity: CapacityGrids,
  targetShape: Float64Array,
  passes: number,
): number {
  const weeks = model.weeks
  const size = model.wcCount * weeks
  const invRefMachine = new Float64Array(size)
  const invRefLabour = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const machine = f64(capacity.machine, i) * f64(targetShape, i)
    const labour = f64(capacity.labour, i) * f64(targetShape, i)
    invRefMachine[i] = machine > 0 ? 1 / (machine * machine) : 0
    invRefLabour[i] = labour > 0 ? 1 / (labour * labour) : 0
  }

  measurePlan(model, values)
  const loadMachine = Float64Array.from(model.machineRequired)
  const loadLabour = Float64Array.from(model.labourRequired)

  const movable: Array<{ row: number; hours: number }> = []
  for (let row = 0; row < model.rowCount; row++) {
    if (at(shape.rowStride, row, 'row stride') <= 1) continue
    const from = i32(model.opStart, row)
    const to = i32(model.opStart, row + 1)
    if (to <= from) continue
    let hours = 0
    const rowBase = row * weeks
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(values, rowBase + w)
      if (!(quantity > 0)) continue
      for (let p = from; p < to; p++) hours += quantity * f64(model.opMachinePerUnit, p)
    }
    if (hours > 0) movable.push({ row, hours })
  }
  // Biggest first: a large lot has the fewest places it can go without making
  // a peak, so it must choose before the small ones fill the gaps.
  movable.sort((a, b) => b.hours - a.hours || a.row - b.row)

  let moved = 0
  // Several passes: a row placed first chose against an empty grid, and the
  // last row placed knows something the first one did not. Re-optimising each
  // row against the finished arrangement is what turns a greedy placement into
  // a level one, and it converges in three.
  for (let pass = 0; pass < passes; pass++)
  for (const entry of movable) {
    const row = entry.row
    const from = i32(model.opStart, row)
    const to = i32(model.opStart, row + 1)
    const stride = at(shape.rowStride, row, 'row stride')
    const rowBase = row * weeks
    const materialBase = at(shape.rowMaterialIndex, row, 'row material index') * weeks
    const rowShare = at(shape.rowShare, row, 'row share')
    const closed = shutdowns.byPlant.get(at(shape.rowPlant, row, 'row plant'))

    // The size the fit has already given this row, as a multiple of its
    // untouched weekly stream. Re-levelling must move the lots WITHOUT undoing
    // the scaling — the two passes solve different halves of the same problem.
    let carried = 0
    let nominal = 0
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(values, rowBase + w)
      if (!(quantity > 0)) continue
      carried += quantity
      nominal += Math.max(1, Math.round(f64(shape.demandBase, materialBase + w) * rowShare * stride))
    }
    const rowScale = nominal > 0 ? carried / nominal : 1
    const quantityAt = (w: number): number =>
      Math.max(1, Math.round(rowScale * f64(shape.demandBase, materialBase + w) * rowShare * stride))

    // Lift the row out of the grid; it is put back below in its chosen phase.
    let currentPhase = -1
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(values, rowBase + w)
      if (!(quantity > 0)) continue
      if (currentPhase < 0) currentPhase = (stride - (w % stride)) % stride
      for (let p = from; p < to; p++) {
        const wcRow = i32(model.opWorkCenterRow, p)
        if (wcRow < 0) continue
        const override = i32(model.opOverrideRow, p)
        const inverse =
          override >= 0
            ? f64(model.materialInverseOee, override * weeks + w)
            : f64(model.inverseOee, wcRow * weeks + w)
        const gi = wcRow * weeks + w
        const setup = f64(model.opSetup, p)
        loadMachine[gi] = f64(loadMachine, gi) - (quantity * f64(model.opMachinePerUnit, p) * inverse + setup)
        loadLabour[gi] = f64(loadLabour, gi) - (quantity * f64(model.opLabourPerUnit, p) * inverse + setup)
      }
      values[rowBase + w] = 0
    }

    let bestPhase = currentPhase < 0 ? 0 : currentPhase
    let bestCost = Number.POSITIVE_INFINITY
    for (let phase = 0; phase < stride; phase++) {
      let cost = 0
      for (let w = (stride - phase) % stride; w < weeks; w += stride) {
        if (closed !== undefined && closed.has(w)) continue
        const quantity = quantityAt(w)
        for (let p = from; p < to; p++) {
          const wcRow = i32(model.opWorkCenterRow, p)
          if (wcRow < 0) continue
          const override = i32(model.opOverrideRow, p)
          const inverse =
            override >= 0
              ? f64(model.materialInverseOee, override * weeks + w)
              : f64(model.inverseOee, wcRow * weeks + w)
          const gi = wcRow * weeks + w
          const setup = f64(model.opSetup, p)
          const machineHours = quantity * f64(model.opMachinePerUnit, p) * inverse + setup
          const labourHours = quantity * f64(model.opLabourPerUnit, p) * inverse + setup
          cost +=
            (2 * f64(loadMachine, gi) * machineHours + machineHours * machineHours) * f64(invRefMachine, gi) +
            (2 * f64(loadLabour, gi) * labourHours + labourHours * labourHours) * f64(invRefLabour, gi)
        }
      }
      if (cost < bestCost) {
        bestCost = cost
        bestPhase = phase
      }
    }
    if (bestPhase !== currentPhase) moved++

    for (let w = (stride - bestPhase) % stride; w < weeks; w += stride) {
      if (closed !== undefined && closed.has(w)) continue
      const quantity = quantityAt(w)
      values[rowBase + w] = quantity
      for (let p = from; p < to; p++) {
        const wcRow = i32(model.opWorkCenterRow, p)
        if (wcRow < 0) continue
        const override = i32(model.opOverrideRow, p)
        const inverse =
          override >= 0
            ? f64(model.materialInverseOee, override * weeks + w)
            : f64(model.inverseOee, wcRow * weeks + w)
        const gi = wcRow * weeks + w
        const setup = f64(model.opSetup, p)
        loadMachine[gi] = f64(loadMachine, gi) + (quantity * f64(model.opMachinePerUnit, p) * inverse + setup)
        loadLabour[gi] = f64(loadLabour, gi) + (quantity * f64(model.opLabourPerUnit, p) * inverse + setup)
      }
    }
  }
  return moved
}

/**
 * Take lots OFF the (work center, week) cells whose changeover bill alone has
 * overrun their target.
 *
 * Scaling cannot fix such a cell — see `poolAllowance`. The only honest
 * correction is that the part does not run there that week, so the smallest
 * lots are dropped until the changeovers fit. The volume is not lost: the row
 * still runs in its other weeks, and the fit grows those to take it back.
 */
function thinLots(
  model: PlanLoadModel,
  values: Float64Array,
  capacity: CapacityGrids,
  shape: Float64Array,
  cellCap: Float64Array,
): number {
  const weeks = model.weeks
  const size = model.wcCount * weeks
  const excess = new Float64Array(size)
  let offending = 0
  for (let i = 0; i < size; i++) {
    const target = Math.min(f64(shape, i), f64(cellCap, i))
    const machineRoom = SETUP_CELL_CAP * target * f64(capacity.machine, i)
    const labourRoom = SETUP_CELL_CAP * target * f64(capacity.labour, i)
    const machineOver = f64(model.machineSetup, i) - machineRoom
    const labourOver = f64(model.labourSetup, i) - labourRoom
    const over = machineOver > labourOver ? machineOver : labourOver
    if (over > 0) {
      excess[i] = over
      offending++
    }
  }
  if (offending === 0) return 0

  // Candidates are collected only for the cells that are actually over, so the
  // scan is one pass over the plan rather than a reverse index of the whole
  // network.
  const candidates = new Map<number, Array<{ row: number; hours: number }>>()
  for (let row = 0; row < model.rowCount; row++) {
    const from = i32(model.opStart, row)
    const to = i32(model.opStart, row + 1)
    if (to <= from) continue
    const rowBase = row * weeks
    for (let w = 0; w < weeks; w++) {
      const quantity = f64(values, rowBase + w)
      if (!(quantity > 0)) continue
      for (let p = from; p < to; p++) {
        const wcRow = i32(model.opWorkCenterRow, p)
        if (wcRow < 0) continue
        const gi = wcRow * weeks + w
        if (!(f64(excess, gi) > 0)) continue
        const hours = quantity * f64(model.opMachinePerUnit, p) + f64(model.opSetup, p)
        const bucket = candidates.get(gi)
        if (bucket) bucket.push({ row, hours })
        else candidates.set(gi, [{ row, hours }])
      }
    }
  }

  let dropped = 0
  const cells = [...candidates.keys()].sort((a, b) => a - b)
  for (const gi of cells) {
    const bucket = candidates.get(gi) ?? []
    bucket.sort((a, b) => a.hours - b.hours || a.row - b.row)
    let over = f64(excess, gi)
    const w = gi % weeks
    for (const entry of bucket) {
      if (over <= 0) break
      const index = entry.row * weeks + w
      if (!(f64(values, index) > 0)) continue
      values[index] = 0
      dropped++
      // One dropped lot removes one changeover — the setup of whichever
      // operation of that row charged it here. Approximated by the mean setup
      // of the cell's candidates, which is what the next measurement corrects.
      over -= Math.max(0.25, entry.hours * 0.4)
    }
  }
  return dropped
}

// ---------------------------------------------------------------------------
// Demand and inventory
// ---------------------------------------------------------------------------

const REGION_WEIGHT: Record<Region, number> = {
  NAM: 0.3,
  EUR: 0.28,
  APAC: 0.24,
  LATAM: 0.1,
  MEA: 0.08,
}

/**
 * Demand is reference, never load. It is built from the SMOOTH per-material
 * stream rather than from the supply plan, so it keeps running through the
 * weeks a plant is shut and the weeks a C-class item does not ship — which is
 * precisely where the plan gap lives, and the plan gap is a headline number.
 *
 * The whole matrix is then scaled by one constant so total demand exceeds
 * total supply by `DEMAND_OVER_SUPPLY`. The gap has to be real to be worth
 * showing, and it has to be bounded to stay credible.
 */
const DEMAND_OVER_SUPPLY = 0.1

function buildDemandPlan(
  materials: readonly Material[],
  plantById: Map<PlantId, Plant>,
  shape: SupplyShape,
  weeks: number,
  totalSupply: number,
  rng: Rng,
): PlanMatrix {
  const rowKeys: string[] = []
  const rows: Array<{ materialIndex: number; share: number }> = []

  for (let mi = 0; mi < materials.length; mi++) {
    const material = at(materials, mi, 'material')
    if (material.plantIds.length === 0) continue
    const homePlant = plantById.get(at(material.plantIds, 0, 'primary plant'))
    const home: Region = homePlant?.region ?? 'NAM'

    const chosen: Region[] = [home]
    const extra = rng.chance(0.18) ? 2 : rng.chance(0.46) ? 1 : 0
    for (let e = 0; e < extra; e++) {
      const pool = REGIONS.filter((region) => !chosen.includes(region))
      if (pool.length === 0) break
      let roll = rng.next() * pool.reduce((sum, region) => sum + REGION_WEIGHT[region], 0)
      let picked = at(pool, pool.length - 1, 'region')
      for (const region of pool) {
        roll -= REGION_WEIGHT[region]
        if (roll <= 0) {
          picked = region
          break
        }
      }
      chosen.push(picked)
    }

    let remaining = 1
    for (let c = 0; c < chosen.length; c++) {
      const region = at(chosen, c, 'region')
      const share = c === chosen.length - 1 ? remaining : remaining * rng.range(0.5, 0.8)
      remaining -= share
      rowKeys.push(key(material.id, region))
      rows.push({ materialIndex: mi, share })
    }
  }

  const values = new Float64Array(rowKeys.length * weeks)
  let raw = 0
  for (let r = 0; r < rows.length; r++) {
    const row = at(rows, r, 'demand row')
    const rowBase = r * weeks
    const materialBase = row.materialIndex * weeks
    for (let w = 0; w < weeks; w++) {
      const value = f64(shape.demandBase, materialBase + w) * row.share * rng.range(0.9, 1.12)
      values[rowBase + w] = value
      raw += value
    }
  }

  // Rounding to whole eaches with a running residual rather than cell by cell.
  // Demand for a C-class part in one region is often a fraction of a unit a
  // week; rounding each cell on its own would silently delete most of it and
  // the headline plan gap would come out several points under what was asked
  // for — which is exactly the kind of quiet error this dataset exists to make
  // impossible to hide.
  const factor = raw > 0 ? (totalSupply * (1 + DEMAND_OVER_SUPPLY)) / raw : 1
  for (let r = 0; r < rows.length; r++) {
    const rowBase = r * weeks
    let carry = 0
    for (let w = 0; w < weeks; w++) {
      const i = rowBase + w
      const exact = f64(values, i) * factor + carry
      const rounded = Math.max(0, Math.round(exact))
      carry = exact - rounded
      values[i] = rounded
    }
  }

  return { rowKeys, weekCount: weeks, values }
}

function buildInventory(shape: SupplyShape, supply: Float64Array, weeks: number, rng: Rng): InventoryRow[] {
  const out: InventoryRow[] = []
  for (let r = 0; r < shape.rowKeys.length; r++) {
    const rowBase = r * weeks
    let total = 0
    for (let w = 0; w < weeks; w++) total += f64(supply, rowBase + w)
    const weekly = total / weeks
    out.push({
      materialId: at(shape.rowMaterial, r, 'row material'),
      plantId: at(shape.rowPlant, r, 'row plant'),
      onHand: Math.round(weekly * rng.range(1.5, 6)),
      inTransit: Math.round(weekly * rng.range(0, 1.5)),
      safetyStock: Math.round(weekly * rng.range(0.8, 3)),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * A dataset with no relief makes the whole tool look broken, so the generator
 * refuses to hand one back. Checked with `capabilityBasis` — the same function
 * the relief search calls — rather than with a restatement of it.
 */
function assertReliefExists(snapshot: Snapshot, idx: ReturnType<typeof buildIndexes>): void {
  for (const op of snapshot.standardOperations) {
    const approved = idx.approvedWorkCentersByOp.get(op.id) ?? []
    const plants = new Set<PlantId>()
    for (const wcId of approved) {
      const plantId = idx.workCenterById.get(wcId)?.plantId
      if (plantId !== undefined) plants.add(plantId)
    }
    let capable = 0
    let retrofit = 0
    for (const wcId of idx.workCenterOrder) {
      const basis = capabilityBasis(idx, wcId, op.id)
      if (basis === 'featureCapable') capable += 1
      else if (basis === 'retrofit') retrofit += 1
    }
    if (approved.length < 3 || plants.size < 2 || capable < 2 || retrofit < 2) {
      throw new Error(
        `relief invariant failed for ${op.id}: ${approved.length} approved work center(s) across ` +
          `${plants.size} plant(s), ${capable} feature-capable but unapproved, ${retrofit} retrofittable. ` +
          `Every operation needs >= 3 approved across >= 2 plants, >= 2 capable and >= 2 retrofittable, ` +
          `or the cockpit has nowhere to move load to.`,
      )
    }
  }
}

function assertPoolsWellFormed(workCenters: readonly WorkCenter[]): void {
  for (const wc of workCenters) {
    const machine = wc.pools.filter((pool) => pool.pool === 'machine').length
    const labour = wc.pools.filter((pool) => pool.pool === 'labour').length
    if (machine !== 1 || labour !== 1) {
      throw new Error(
        `${wc.id} has ${machine} machine pool(s) and ${labour} labour pool(s); the contract is exactly one of each.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

/** Independent PRNG streams, so a change in one phase does not reshuffle the next. */
const STREAM = {
  workCenters: 0x9e3779b9,
  capability: 0x85ebca6b,
  products: 0xc2b2ae35,
  routings: 0x27d4eb2f,
  overrides: 0x165667b1,
  downtime: 0xd3a2646c,
  fit: 0x7feb352d,
  supply: 0xfd7046c5,
  demand: 0xb55a4f09,
  inventory: 0x9e3779b1,
} as const

const CALIBRATION_SCENARIO: Scenario = {
  id: 'factory-calibration',
  name: 'Calibration',
  description: 'Internal to the factory. Never leaves this module.',
  moves: [],
  colorSlot: 1,
}

/**
 * Generate the whole network. Deterministic in `profile` alone.
 *
 * The order matters, and it is not the order the phases were written in:
 *
 *   work centers -> capability -> products
 *   THE PLAN'S SCALE          <- volumes normalised to the capacity that exists
 *   routings                  <- balanced against real headroom, at that scale
 *   the plan's SHAPE          <- lot policy, now sizing real lots
 *   rebalance                 <- exact hours, measured off the written plan
 *   overrides                 <- sampled from the routings as they finally are
 *   calibrate                 <- the plan fitted cell by cell to a target field
 *
 * The scale has to come before the lot policy, and the lot policy before the
 * fit, because setup is charged per lot and does not scale. Deciding cadence
 * against volumes that are later cut ten to one leaves the lot count untouched
 * and turns the changeover bill into the network's largest single consumer of
 * hours — which is exactly what this generator used to do.
 */
export function buildSnapshot(profile: Profile): Snapshot {
  const time = buildTimeGrid(profile.startMonday, profile.weekCount)
  const weeks = time.weeks.length
  const plants = buildPlants()
  const plantById = new Map<PlantId, Plant>()
  for (const plant of plants) plantById.set(plant.id, plant)

  const wcBuild = buildWorkCenters(profile, makeRng(profile.seed ^ STREAM.workCenters))
  repairRetrofitRelief(wcBuild)
  assertPoolsWellFormed(wcBuild.workCenters)
  const classByWorkCenter = new Map<WorkCenterId, MachineClass>()
  for (let i = 0; i < wcBuild.workCenters.length; i++) {
    classByWorkCenter.set(at(wcBuild.workCenters, i, 'work center').id, at(wcBuild.classOf, i, 'machine class'))
  }

  const capability = buildCapabilityPlan(
    profile,
    wcBuild.workCenters,
    wcBuild.classOf,
    makeRng(profile.seed ^ STREAM.capability),
  )

  const productRng = makeRng(profile.seed ^ STREAM.products)
  const products = buildProducts(profile, productRng)
  declareTransferPoints(products.materials, productRng)

  // The plan's absolute scale, decided here and not after the fact. Everything
  // downstream — which asset takes which operation, how big a lot is, how many
  // changeovers the network buys — is a decision about hours, and hours are
  // only meaningful against the hours that exist.
  scaleVolumesToCapacity(
    wcBuild.workCenters,
    capability.coldWorkCenters,
    products.familyIndexOf,
    products.volumeOf,
  )

  const workCenterById = new Map<WorkCenterId, WorkCenter>()
  for (const wc of wcBuild.workCenters) workCenterById.set(wc.id, wc)

  const routingBuild = buildRoutings(
    products.materials,
    products.familyIndexOf,
    products.volumeOf,
    capability,
    classByWorkCenter,
    workCenterById,
    makeRng(profile.seed ^ STREAM.routings),
  )

  // Second pass on the scale, now that the routings exist and every rate, every
  // machine and every yield is known rather than estimated. The correction is
  // small; it is applied before the lot policy so that it lands on lot SIZES
  // rather than on lot COUNTS.
  let warmMachineHours = 0
  for (const wc of wcBuild.workCenters) {
    if (capability.coldWorkCenters.has(wc.id)) continue
    for (const pool of wc.pools) if (pool.pool === 'machine') warmMachineHours += weeklyHoursOf(pool)
  }
  if (routingBuild.weeklyMachineHours > 0) {
    const wanted = warmMachineHours * TARGET_NETWORK_UTILISATION * (1 - TARGET_SETUP_SHARE)
    const correction = clamp(wanted / routingBuild.weeklyMachineHours, 0.05, 20)
    for (let i = 0; i < products.volumeOf.length; i++) {
      products.volumeOf[i] = at(products.volumeOf, i, 'material volume') * correction
    }
  }

  const overrideRng = makeRng(profile.seed ^ STREAM.overrides)
  const glidePaths = buildGlidePaths(wcBuild.workCenters, weeks, overrideRng)

  const downtime = buildDowntime(
    profile,
    time,
    wcBuild.workCenters,
    makeRng(profile.seed ^ STREAM.downtime),
  )

  const shape = buildSupplyShape(
    products.materials,
    products.volumeOf,
    time,
    downtime.shutdowns,
    routingBuild.bindingFactorByRow,
    makeRng(profile.seed ^ STREAM.supply),
  )

  const supplyPlan: PlanMatrix = {
    rowKeys: shape.rowKeys,
    weekCount: weeks,
    values: new Float64Array(shape.base),
  }

  const snapshot: Snapshot = {
    meta: {
      profile: profile.id,
      generatedBy: 'factory',
      seed: profile.seed,
      skuCount: products.materials.length,
      workCenterCount: wcBuild.workCenters.length,
      weekCount: weeks,
    },
    time,
    plants,
    features: FEATURES,
    machineClasses: MACHINE_CLASSES,
    workCenters: wcBuild.workCenters,
    standardOperations: STANDARD_OPERATIONS,
    families: products.families,
    groups: products.groups,
    materials: products.materials,
    routings: routingBuild.routings,
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths,
    downtime: downtime.events,
    supplyPlan,
    demandPlan: { rowKeys: [], weekCount: weeks, values: new Float64Array(0) },
    inventory: [],
  }

  // The plan now exists, so the routing generator's estimates can be replaced
  // by measurements: move work off the assets the written plan overloads.
  // Several rounds, because each move changes what the next one should be.
  for (let round = 0; round < 3; round++) {
    rebalanceRoutings(routingBuild.routings, supplyPlan, workCenterById, capability, weeks)
  }
  staffWorkCenters(
    wcBuild.workCenters,
    new Set(wcBuild.labourBoundIds),
    routingBuild.routings,
    supplyPlan,
    weeks,
  )

  // Overrides are sampled from the routings as they finally stand, and the
  // indexes are rebuilt over them, so the approvals the relief invariant is
  // checked against — and the rates and OEEs the calibration measures with —
  // are the ones the engine will see.
  const written = collectWrittenOps(routingBuild.routings)
  snapshot.rateOverrides = buildRateOverrides(
    written,
    Math.max(50, Math.round((2000 * profile.skuCount) / 15000)),
    overrideRng,
  )
  snapshot.oeeOverrides = buildOeeOverrides(
    wcBuild.workCenters,
    written,
    weeks,
    Math.max(20, Math.round((120 * profile.workCenterCount) / 150)),
    overrideRng,
  )

  const idx = buildIndexes(snapshot)
  assertReliefExists(snapshot, idx)
  const calibration = calibrateSupplyPlan(
    snapshot,
    idx,
    shape,
    downtime.shutdowns,
    weeks,
    makeRng(profile.seed ^ STREAM.fit),
  )
  assertCalibrationIsSane(profile, calibration)

  let totalSupply = 0
  for (let i = 0; i < supplyPlan.values.length; i++) totalSupply += f64(supplyPlan.values, i)

  snapshot.demandPlan = buildDemandPlan(
    products.materials,
    plantById,
    shape,
    weeks,
    totalSupply,
    makeRng(profile.seed ^ STREAM.demand),
  )
  snapshot.inventory = buildInventory(
    shape,
    supplyPlan.values,
    weeks,
    makeRng(profile.seed ^ STREAM.inventory),
  )

  return snapshot
}

/**
 * A dataset the cockpit cannot tell a story with is a build failure, not a
 * cosmetic problem — so the generator refuses to hand one back. The bands are
 * wide: this catches a broken generator, not a differently-tuned one.
 */
function assertCalibrationIsSane(profile: Profile, result: CalibrationResult): void {
  const problems: string[] = []
  if (result.networkUtilisation < 0.7 || result.networkUtilisation > 0.92) {
    problems.push(`network utilisation ${result.networkUtilisation.toFixed(3)} is outside 0.70..0.92`)
  }
  if (result.peakUtilisation > 1.8) {
    problems.push(`peak utilisation ${result.peakUtilisation.toFixed(2)} is above 2.0`)
  }
  if (result.overloadedCells > result.totalCells * 0.12) {
    problems.push(
      `${result.overloadedCells} of ${result.totalCells} cells are over their ceiling (>15%)`,
    )
  }
  if (result.workCentersOverCeiling < 3) {
    problems.push('no work center ever crosses its ceiling; there is nothing to find')
  }
  if (problems.length > 0) {
    throw new Error(
      `calibration failed on the ${profile.id} profile: ${problems.join('; ')}. ` +
        `A baseline the whole grid reads red on — or none of it does — makes the cockpit useless.`,
    )
  }
}

/**
 * Fit the plan to a TARGET FIELD, cell by cell, measured with the engine's own
 * arithmetic.
 *
 * The old calibration turned one knob: a single global scale, chosen so that
 * first-quarter network utilisation hit a number. A single scale cannot express
 * anything about WHERE the load sits, so it could put the network's average
 * exactly on target while a third of the assets sat at three times their hours
 * and another third idled — which is what it did.
 *
 * This one solves for the whole field. Every work center is given a utilisation
 * it should reach in every week — a spread of comfortable levels for most, a
 * steeper ramp into overload for a chosen minority, nothing at all for the cold
 * relief targets — and the plan is fitted to it by proportional scaling of
 * (row, week) cells, which is exactly what a planner does when they cut a
 * schedule to what the shop can run. A row is bounded by the tightest cell on
 * its routing, so no scaling can invent capacity somewhere else.
 *
 * Two things make the fit converge rather than oscillate:
 *
 *   - setup is subtracted from both sides of every allowance, because it is the
 *     part of a cell's hours that does not move when the plan is scaled;
 *   - the LEVEL of the whole target field is solved alongside the shape, so the
 *     network's utilisation lands on its band without the shape being disturbed.
 *
 * Cells whose changeover bill alone overruns their target cannot be fitted at
 * all, so lots are thinned off them instead — the part simply does not run
 * there that week.
 */
function calibrateSupplyPlan(
  snapshot: Snapshot,
  idx: ReturnType<typeof buildIndexes>,
  shape: SupplyShape,
  shutdowns: ShutdownWindows,
  weeks: number,
  rng: Rng,
): CalibrationResult {
  const values = snapshot.supplyPlan.values
  const wcCount = idx.workCenterOrder.length
  const size = wcCount * weeks
  const oeeGrid = buildOeeGrid(snapshot, idx)
  const capacity = buildCapacity(snapshot, idx)
  const ceilings = buildCeilings(CALIBRATION_SCENARIO, 1)
  const sourcing = resolveSourcing(snapshot, idx, CALIBRATION_SCENARIO)
  const model = buildPlanLoadModel(snapshot, idx, oeeGrid, sourcing)

  // ---- who is hot, and which pool do they run out of first? ----------------
  measurePlan(model, values)
  const plantOf = new Map<WorkCenterId, PlantId>()
  for (const wc of snapshot.workCenters) plantOf.set(wc.id, wc.plantId)

  const machineBinding: WorkCenterId[] = []
  const labourBinding: WorkCenterId[] = []
  for (let r = 0; r < wcCount; r++) {
    const id = at(idx.workCenterOrder, r, 'work center')
    let machineReq = 0
    let machineAvail = 0
    let labourReq = 0
    let labourAvail = 0
    for (let w = 0; w < weeks; w++) {
      const i = r * weeks + w
      machineReq += f64(model.machineRequired, i)
      machineAvail += f64(capacity.machine, i)
      labourReq += f64(model.labourRequired, i)
      labourAvail += f64(capacity.labour, i)
    }
    if (!(machineReq > 0)) continue
    const machineUtil = machineAvail > 0 ? machineReq / machineAvail : 0
    const labourUtil = labourAvail > 0 ? labourReq / labourAvail : 0
    if (labourUtil > machineUtil) labourBinding.push(id)
    else machineBinding.push(id)
  }

  // Both pools have to produce bottlenecks, or the two-pool model never gets
  // asked the question it exists to answer.
  // An absolute band, not a share: "twenty-three assets are in trouble" is a
  // list a planner can work through whether the network has forty work centers
  // or two hundred and forty, and forty of them is not.
  const hotCount = clamp(
    Math.round(wcCount * HOT_WORK_CENTER_SHARE),
    Math.min(HOT_WORK_CENTER_MIN, Math.floor(wcCount / 3)),
    HOT_WORK_CENTER_MAX,
  )
  const wantLabour = Math.min(labourBinding.length, Math.round(hotCount * HOT_LABOUR_SHARE))
  const hot = new Set<WorkCenterId>()
  for (const id of dealAcrossPlants(labourBinding, plantOf, rng).slice(0, wantLabour)) hot.add(id)
  for (const id of dealAcrossPlants(machineBinding, plantOf, rng)) {
    if (hot.size >= hotCount) break
    hot.add(id)
  }

  // ---- the target field ----------------------------------------------------
  // Expressed as the PEAK each work center should reach, not as a level it
  // should sit at, because the peak is what the product reads as a bottleneck
  // and it is the band that is hardest to hold. Two ramps, not one: the
  // comfortable majority drifts gently upward across the horizon, the
  // bottlenecks climb much harder — so they are comfortable early and cross
  // their ceiling only in the last third. A single ramp cannot do both. Gentle
  // enough to keep a hundred assets under 1.0 for eighteen months is far too
  // gentle to make anything EMERGE.
  const isHotRow = new Uint8Array(wcCount)
  const wantedPeak = new Float64Array(wcCount)
  const baseOf = new Float64Array(wcCount)
  const rampOf = new Float64Array(size)
  for (let r = 0; r < wcCount; r++) {
    const id = at(idx.workCenterOrder, r, 'work center')
    const isHot = hot.has(id)
    isHotRow[r] = isHot ? 1 : 0
    wantedPeak[r] = isHot
      ? rng.range(HOT_PEAK_LOW, HOT_PEAK_HIGH)
      : rng.range(NORMAL_PEAK_LOW, NORMAL_PEAK_HIGH)
    let peakRamp = 0
    for (let w = 0; w < weeks; w++) {
      const value = isHot
        ? growth(w, weeks, HOT_RAMP_START, HOT_RAMP_END, HOT_RAMP_EXPONENT)
        : growth(w, weeks, NORMAL_RAMP_START, NORMAL_RAMP_END, NORMAL_RAMP_EXPONENT)
      rampOf[r * weeks + w] = value
      if (value > peakRamp) peakRamp = value
    }
    baseOf[r] = peakRamp > 0 ? f64(wantedPeak, r) / peakRamp : f64(wantedPeak, r)
  }

  const shapeGrid = new Float64Array(size)
  const cellCap = new Float64Array(size)
  const writeShape = (): void => {
    for (let r = 0; r < wcCount; r++) {
      const base = f64(baseOf, r)
      const cap = isHotRow[r] === 1 ? MAX_CELL_TARGET : NORMAL_PEAK_MAX
      for (let w = 0; w < weeks; w++) {
        const i = r * weeks + w
        shapeGrid[i] = base * f64(rampOf, i)
        cellCap[i] = cap
      }
    }
  }
  writeShape()

  // ---- level the lots before any of them is resized ------------------------
  levelLots(model, values, shape, shutdowns, capacity, shapeGrid, INITIAL_LEVELLING_PASSES)

  // ---- fit -----------------------------------------------------------------
  // The fit CANNOT reach an arbitrary target field, and pretending otherwise is
  // what made the old calibration produce a network where everything was red.
  // A supply row runs on four or five work centers at once and can only grow as
  // far as the tightest of them allows, so a work center sharing its rows with
  // a saturated neighbour is starved however high its own target is set. Set a
  // fixed field and solve one global level against it and the level climbs
  // until every asset that CAN be loaded is at the maximum.
  //
  // So the target is not fixed: it is FEEDBACK. Each pass measures what each
  // work center actually peaked at and moves that work center's target toward
  // the peak it was asked for. Assets the plan can fill are asked for more,
  // assets it cannot are asked for less, and the ones that end up low are the
  // relief targets the product is about. One global level rides on top so the
  // network's utilisation lands on its band; it can only ever lower the wanted
  // peaks, never raise them past what the ceiling story allows.
  const allowed = new Float64Array(size)
  let level = 1
  let thinPass = 0
  for (let outer = 0; outer < FIT_OUTER_PASSES; outer++) {
    // Re-level between passes. The first levelling placed lots that were all
    // the same size as each other; the fit has since made some of them four
    // times the others, and where a lot should sit depends on how big it is.
    if (outer > 0 && outer <= RELEVELLING_PASSES) {
      levelLots(model, values, shape, shutdowns, capacity, shapeGrid, 1)
    }
    for (let inner = 0; inner < FIT_INNER_ITERATIONS; inner++) {
      measurePlan(model, values)

      if (thinPass < THINNING_PASSES) {
        thinPass++
        if (thinLots(model, values, capacity, shapeGrid, cellCap) > 0) measurePlan(model, values)
      }

      for (let i = 0; i < size; i++) {
        const target = Math.min(f64(shapeGrid, i), f64(cellCap, i))
        allowed[i] = Math.min(
          poolAllowance(target * f64(capacity.machine, i), f64(model.machineRequired, i), f64(model.machineSetup, i)),
          poolAllowance(target * f64(capacity.labour, i), f64(model.labourRequired, i), f64(model.labourSetup, i)),
        )
      }

      for (let row = 0; row < model.rowCount; row++) {
        const from = i32(model.opStart, row)
        const to = i32(model.opStart, row + 1)
        if (to <= from) continue
        const rowBase = row * weeks
        for (let w = 0; w < weeks; w++) {
          const quantity = f64(values, rowBase + w)
          if (!(quantity > 0)) continue
          let factor = MAX_CELL_FACTOR
          for (let p = from; p < to; p++) {
            const wcRow = i32(model.opWorkCenterRow, p)
            if (wcRow < 0) continue
            const cell = f64(allowed, wcRow * weeks + w)
            if (cell < factor) factor = cell
          }
          values[rowBase + w] = Math.max(1, quantity * factor ** FIT_DAMPING)
        }
      }
    }

    measurePlan(model, values)
    let required = 0
    let available = 0
    for (let i = 0; i < size; i++) {
      required += f64(model.machineRequired, i)
      available += f64(capacity.machine, i)
    }
    const utilisation = available > 0 ? required / available : 0
    if (utilisation > 0) {
      // The level may push the wanted peaks UP as well as down, but every peak
      // it lifts is clamped by the population's ceiling, so raising it can
      // never turn the comfortable majority red — only fill it.
      level = clamp(level * (TARGET_NETWORK_UTILISATION / utilisation) ** LEVEL_DAMPING, 0.25, 1.8)
    }

    for (let r = 0; r < wcCount; r++) {
      let peak = 0
      for (let w = 0; w < weeks; w++) {
        const i = r * weeks + w
        const machineUtil = safeRatio(f64(model.machineRequired, i), f64(capacity.machine, i))
        const labourUtil = safeRatio(f64(model.labourRequired, i), f64(capacity.labour, i))
        const util = machineUtil > labourUtil ? machineUtil : labourUtil
        if (util > peak) peak = util
      }
      const wanted = Math.min(
        f64(wantedPeak, r) * level,
        isHotRow[r] === 1 ? MAX_CELL_TARGET : NORMAL_PEAK_MAX,
      )
      const correction = (wanted / Math.max(peak, 0.02)) ** PEAK_DAMPING
      baseOf[r] = clamp(f64(baseOf, r) * clamp(correction, 0.4, 2.2), 0.05, 4)
    }
    writeShape()
  }

  // Whole eaches. The plan is master data, and master data does not carry
  // fractional parts.
  for (let i = 0; i < values.length; i++) {
    const quantity = f64(values, i)
    values[i] = quantity > 0 ? Math.max(1, Math.round(quantity)) : 0
  }

  // ---- report what the ENGINE says, not what the model hoped ---------------
  const load = buildLoad(snapshot, idx, sourcing, capacity, oeeGrid, ceilings)
  let required = 0
  let available = 0
  let setup = 0
  let peak = 0
  let overloadedCells = 0
  let machineBound = 0
  let labourBound = 0
  let overCeiling = 0
  let underloaded = 0
  for (let i = 0; i < size; i++) {
    required += f64(load.grids.machine.requiredHours, i)
    available += f64(load.grids.machine.availableHours, i)
    setup += f64(load.grids.machine.setupHours, i)
  }
  for (let r = 0; r < wcCount; r++) {
    let worst = 0
    let worstPool: 'machine' | 'labour' = 'machine'
    let sum = 0
    for (let w = 0; w < weeks; w++) {
      const i = r * weeks + w
      const machineUtil = safeRatio(f64(load.grids.machine.requiredHours, i), f64(load.grids.machine.availableHours, i))
      const labourUtil = safeRatio(f64(load.grids.labour.requiredHours, i), f64(load.grids.labour.availableHours, i))
      const util = machineUtil > labourUtil ? machineUtil : labourUtil
      sum += util
      if (util > 1) overloadedCells++
      if (util > worst) {
        worst = util
        worstPool = machineUtil >= labourUtil ? 'machine' : 'labour'
      }
    }
    if (worst > peak) peak = worst
    if (worst > 1) {
      overCeiling++
      if (worstPool === 'machine') machineBound++
      else labourBound++
    }
    if (sum / weeks < 0.4) underloaded++
  }

  let structural = 0
  for (let i = 0; i < size; i++) {
    const target = Math.min(f64(shapeGrid, i), f64(cellCap, i))
    if (f64(model.machineSetup, i) > target * f64(capacity.machine, i)) structural++
  }

  return {
    level,
    networkUtilisation: available > 0 ? required / available : 0,
    peakUtilisation: peak,
    workCentersOverCeiling: overCeiling,
    workCentersUnderloaded: underloaded,
    machineBoundOverloads: machineBound,
    labourBoundOverloads: labourBound,
    overloadedCells,
    totalCells: size,
    setupShareOfRequiredHours: required > 0 ? setup / required : 0,
    structurallyOverloadedCells: structural,
  }
}

/** Ratio that reports a zero denominator as zero rather than as Infinity. */
function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}
