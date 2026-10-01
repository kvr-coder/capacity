/**
 * The factory's contract, as tests.
 *
 * Two of these are load-bearing for the whole product rather than for this
 * module: determinism, because a baseline that drifts between reloads makes
 * every scenario comparison a lie; and the relief invariant, because a dataset
 * where a saturated work center has nowhere to send its load makes the cockpit
 * look broken when it is working perfectly.
 *
 * The cheap `demo` profile carries the structural assertions. The calibration
 * bands are asserted on `standard`, because they are claims about the 15,000
 * SKU / 150 work center network specifically and asserting them on a tenth of
 * it would prove nothing.
 */

import { describe, expect, it } from 'vitest'

import type { CapacityPool, Material, ModelResult, Snapshot } from '@/domain/types'
import { at, key } from '@/domain/lookup'
import { buildIndexes } from '@/domain/indexes'
import { capabilityBasis } from '@/domain/capability'
import { baselineScenario, defaultFilters, runModel } from '@/domain/engine'
import { buildSnapshot, DEFAULT_PROFILE, PLANT_META, PROFILES, profileById } from '@/data/factory'
import { OPERATION_SPECS, PLANT_SPECS } from '@/data/profiles'

const DEMO = profileById('demo')
const STANDARD = profileById('standard')

/** Built once — `buildSnapshot` on the standard profile is a second of work. */
let standardSnapshot: Snapshot | undefined
function standard(): Snapshot {
  if (standardSnapshot === undefined) standardSnapshot = buildSnapshot(STANDARD)
  return standardSnapshot
}

let demoSnapshot: Snapshot | undefined
function demo(): Snapshot {
  if (demoSnapshot === undefined) demoSnapshot = buildSnapshot(DEMO)
  return demoSnapshot
}

function f64(a: Float64Array, i: number): number {
  return a[i] ?? 0
}

/**
 * A reduced fingerprint of a whole snapshot.
 *
 * Position-weighted rather than a plain sum: two matrices holding the same
 * numbers in a different order have the same total, and "the plan is the same
 * but the weeks moved" is exactly the regression a determinism test exists to
 * catch.
 */
function checksum(values: Float64Array): number {
  let total = 0
  for (let i = 0; i < values.length; i++) total += f64(values, i) * (1 + (i % 97))
  return Math.round(total)
}

function fingerprint(snap: Snapshot): string {
  return JSON.stringify({
    meta: snap.meta,
    weeks: [snap.time.weeks[0], snap.time.weeks[snap.time.weeks.length - 1], snap.time.weeks.length],
    plants: snap.plants.map((p) => `${p.id}:${p.colorSlot}:${p.defaultOee}`),
    workCenters: snap.workCenters.map(
      (wc) =>
        `${wc.id}|${wc.classId}|${wc.vintage}|${wc.baseOee}|${wc.features.join('+')}|` +
        wc.pools.map((pool) => `${pool.pool}:${pool.count}:${pool.shiftsPerDay}:${pool.hoursPerShift}:${pool.daysPerWeek}:${pool.utilisationFactor}`).join(','),
    ),
    materials: snap.materials.length,
    materialSample: snap.materials.slice(0, 40).map((m) => `${m.id}|${m.type}|${m.abcClass}|${m.plantIds.join('+')}|${m.componentId ?? ''}`),
    routings: snap.routings.length,
    routingSample: snap.routings.slice(0, 40).map(
      (r) =>
        `${r.id}|${r.version}|${r.primary}|` +
        r.operations.map((op) => `${op.seq}:${op.opId}:${op.workCenterId}:${op.baseQty}:${op.machineHoursPerBase}:${op.labourHoursPerBase}:${op.setupHours}:${op.yield}`).join(','),
    ),
    rateOverrides: snap.rateOverrides.length,
    oeeOverrides: snap.oeeOverrides.length,
    glidePaths: snap.glidePaths.map((g) => `${g.id}|${g.fromWeek}|${g.toWeek}|${g.endValue}|${g.curve}`),
    downtime: snap.downtime.map((d) => `${d.id}|${d.workCenterId}|${d.kind}|${d.status}|${d.fromWeek}|${d.toWeek}|${d.pools.join('+')}|${d.hoursPerWeek ?? ''}|${d.slipWeeks ?? ''}`),
    supply: [snap.supplyPlan.rowKeys.length, snap.supplyPlan.weekCount, checksum(snap.supplyPlan.values)],
    demand: [snap.demandPlan.rowKeys.length, snap.demandPlan.weekCount, checksum(snap.demandPlan.values)],
    inventory: snap.inventory.length,
    inventorySample: snap.inventory.slice(0, 40).map((row) => `${row.materialId}|${row.plantId}|${row.onHand}|${row.inTransit}|${row.safetyStock}`),
  })
}

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces byte-identical output for the same profile, twice', () => {
    const first = fingerprint(buildSnapshot(DEMO))
    const second = fingerprint(buildSnapshot(DEMO))
    expect(second).toBe(first)
  })

  it('produces a different world for a different profile', () => {
    expect(fingerprint(buildSnapshot(DEMO))).not.toBe(fingerprint(standard()))
  })

  it('declares the three profiles and a default that exists', () => {
    expect(PROFILES.map((p) => p.id)).toEqual(['demo', 'standard', 'large'])
    expect(PROFILES.some((p) => p.id === DEFAULT_PROFILE)).toBe(true)
    expect(profileById('nonsense').id).toBe(DEFAULT_PROFILE)
    const standardProfile = profileById('standard')
    expect(standardProfile.skuCount).toBe(15000)
    expect(standardProfile.workCenterCount).toBe(150)
  })
})

describe('the network', () => {
  it('has five plants, permanent colour slots and a strategic blurb each', () => {
    const snap = demo()
    expect(snap.plants).toHaveLength(5)
    const slots = snap.plants.map((p) => p.colorSlot).sort()
    expect(slots).toEqual([1, 2, 3, 4, 5])
    for (const plant of snap.plants) {
      const meta = PLANT_META[plant.id]
      expect(meta, `no PLANT_META for ${plant.id}`).toBeDefined()
      expect(meta?.role.length ?? 0).toBeGreaterThan(3)
      expect(meta?.blurb.length ?? 0).toBeGreaterThan(40)
      expect(meta?.flag.length ?? 0).toBeGreaterThan(0)
    }
    // Works-council hours at Ingolstadt are a fact about the plant, not a
    // rounding choice, and every pool there has to reflect them.
    const ingolstadt = snap.workCenters.filter((wc) => wc.plantId === 'DE-ING')
    expect(ingolstadt.length).toBeGreaterThan(0)
    for (const wc of ingolstadt) {
      for (const pool of wc.pools) expect(pool.hoursPerShift).toBe(7.5)
    }
  })

  it('gives every work center exactly one machine pool and one labour pool', () => {
    for (const snap of [demo(), standard()]) {
      for (const wc of snap.workCenters) {
        expect(wc.pools.filter((p) => p.pool === 'machine'), wc.id).toHaveLength(1)
        expect(wc.pools.filter((p) => p.pool === 'labour'), wc.id).toHaveLength(1)
      }
    }
  })

  it('distributes work centers across the five plants in the intended proportions', () => {
    const snap = standard()
    expect(snap.workCenters).toHaveLength(150)
    for (const spec of PLANT_SPECS) {
      const count = snap.workCenters.filter((wc) => wc.plantId === spec.id).length
      expect(Math.abs(count - spec.workCenterWeight), spec.id).toBeLessThanOrEqual(2)
    }
  })

  it('correlates vintage with machine generation', () => {
    const snap = standard()
    const byGeneration = new Map<number, number[]>()
    for (const wc of snap.workCenters) {
      const machineClass = snap.machineClasses.find((c) => c.id === wc.classId)
      if (machineClass === undefined) continue
      const bucket = byGeneration.get(machineClass.generation)
      if (bucket) bucket.push(wc.vintage)
      else byGeneration.set(machineClass.generation, [wc.vintage])
      expect(wc.vintage).toBeGreaterThanOrEqual(2004)
      expect(wc.vintage).toBeLessThanOrEqual(2025)
    }
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length
    const gen1 = byGeneration.get(1) ?? []
    const gen4 = byGeneration.get(4) ?? []
    expect(gen1.length).toBeGreaterThan(0)
    expect(gen4.length).toBeGreaterThan(0)
    expect(mean(gen4)).toBeGreaterThan(mean(gen1) + 6)
  })

  it('sells retrofits that add real capability for real money', () => {
    const snap = demo()
    let options = 0
    for (const machineClass of snap.machineClasses) {
      expect(machineClass.retrofits.length).toBeGreaterThanOrEqual(1)
      expect(machineClass.retrofits.length).toBeLessThanOrEqual(3)
      for (const option of machineClass.retrofits) {
        options += 1
        expect(option.addsFeatures.length).toBeGreaterThan(0)
        expect(option.capexUsd).toBeGreaterThanOrEqual(120_000)
        expect(option.capexUsd).toBeLessThanOrEqual(900_000)
        expect(option.leadTimeWeeks).toBeGreaterThanOrEqual(8)
        expect(option.leadTimeWeeks).toBeLessThanOrEqual(26)
        expect(Math.abs(option.oeeDelta)).toBeLessThanOrEqual(0.06)
        // The point of a retrofit is that the class cannot already do it.
        for (const featureId of option.addsFeatures) {
          expect(machineClass.baseFeatures, `${machineClass.id} already has ${featureId}`).not.toContain(featureId)
        }
      }
    }
    expect(options).toBeGreaterThanOrEqual(12)
    // The generation-1 "moulds but cannot paint" story has to be in the data.
    const generationOne = snap.machineClasses.filter((c) => c.generation === 1)
    expect(generationOne.length).toBeGreaterThanOrEqual(2)
    for (const machineClass of generationOne) {
      expect(machineClass.baseFeatures.length).toBeLessThanOrEqual(5)
      expect(machineClass.baseFeatures).not.toContain('PAINT')
    }
    const generationFour = snap.machineClasses.filter((c) => c.generation === 4)
    expect(generationFour.length).toBeGreaterThanOrEqual(2)
    for (const machineClass of generationFour) {
      expect(machineClass.baseFeatures.length).toBeGreaterThanOrEqual(10)
    }
  })
})

describe('capability and relief', () => {
  it('routes every operation to a work center that is genuinely feature-capable', () => {
    for (const snap of [demo(), standard()]) {
      const featuresOf = new Map<string, Set<string>>()
      for (const wc of snap.workCenters) featuresOf.set(wc.id, new Set(wc.features))
      const requiredOf = new Map<string, string[]>()
      for (const op of snap.standardOperations) requiredOf.set(op.id, op.requiredFeatures)

      for (const routing of snap.routings) {
        for (const op of routing.operations) {
          const granted = featuresOf.get(op.workCenterId)
          expect(granted, `${routing.id} names unknown work center ${op.workCenterId}`).toBeDefined()
          const required = requiredOf.get(op.opId) ?? []
          for (const featureId of required) {
            expect(
              granted?.has(featureId),
              `${routing.id} runs ${op.opId} on ${op.workCenterId}, which lacks ${featureId}`,
            ).toBe(true)
          }
          const wc = snap.workCenters.find((candidate) => candidate.id === op.workCenterId)
          expect(wc?.plantId, `${routing.id} is at ${routing.plantId} but runs on ${op.workCenterId}`).toBe(routing.plantId)
        }
      }
    }
  })

  it('leaves somewhere for the load to go, for every operation', () => {
    for (const snap of [demo(), standard()]) {
      const idx = buildIndexes(snap)
      for (const op of snap.standardOperations) {
        const approved = idx.approvedWorkCentersByOp.get(op.id) ?? []
        const plants = new Set(approved.map((id) => idx.workCenterById.get(id)?.plantId))
        let capable = 0
        let retrofit = 0
        for (const wcId of idx.workCenterOrder) {
          const basis = capabilityBasis(idx, wcId, op.id)
          if (basis === 'featureCapable') capable += 1
          else if (basis === 'retrofit') retrofit += 1
        }
        expect(approved.length, `${op.id} approved`).toBeGreaterThanOrEqual(3)
        expect(plants.size, `${op.id} approved plants`).toBeGreaterThanOrEqual(2)
        expect(capable, `${op.id} feature-capable but unapproved`).toBeGreaterThanOrEqual(2)
        expect(retrofit, `${op.id} retrofittable`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('keeps implied rates inside the band each operation declares', () => {
    const snap = standard()
    const specById = new Map(OPERATION_SPECS.map((spec) => [spec.id, spec]))
    for (const routing of snap.routings) {
      if (!routing.primary) continue
      for (const op of routing.operations) {
        const spec = specById.get(op.opId)
        if (spec === undefined) continue
        const rate = op.baseQty / op.machineHoursPerBase
        expect(rate, `${routing.id} ${op.opId}`).toBeGreaterThanOrEqual(at(spec.rateBand, 0, 'low') * 0.98)
        expect(rate, `${routing.id} ${op.opId}`).toBeLessThanOrEqual(at(spec.rateBand, 1, 'high') * 1.02)
        expect(op.baseQty === 100 || op.baseQty === 1000).toBe(true)
        expect(op.setupHours).toBeGreaterThanOrEqual(0.5)
        expect(op.setupHours).toBeLessThanOrEqual(6)
        expect(op.yield).toBeGreaterThanOrEqual(0.96)
        expect(op.yield).toBeLessThanOrEqual(0.999)
        // Labour is 0.6x to 2.5x machine time, by how much of the job the
        // machine does. That ratio is what makes a work center labour-bound.
        const ratio = op.labourHoursPerBase / op.machineHoursPerBase
        expect(ratio, `${routing.id} ${op.opId}`).toBeGreaterThanOrEqual(0.55)
        expect(ratio, `${routing.id} ${op.opId}`).toBeLessThanOrEqual(2.55)
      }
    }
  })

  it('varies routing length from short to long', () => {
    const snap = standard()
    const lengths = new Set<number>()
    for (const routing of snap.routings) lengths.add(routing.operations.length)
    expect(Math.min(...lengths)).toBeLessThanOrEqual(2)
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(6)
  })
})

describe('the product hierarchy', () => {
  it('points every declared transfer point at a real semi-finished material', () => {
    for (const snap of [demo(), standard()]) {
      const byId = new Map<string, Material>()
      for (const material of snap.materials) byId.set(material.id, material)
      let pairs = 0
      let crossPlant = 0
      for (const material of snap.materials) {
        if (material.componentId === undefined) continue
        pairs += 1
        expect(material.type, `${material.id} consumes a component`).toBe('FERT')
        const component = byId.get(material.componentId)
        expect(component, `${material.id} points at missing ${material.componentId}`).toBeDefined()
        expect(component?.type, `${material.componentId}`).toBe('HALB')
        expect(component?.id).not.toBe(material.id)
        const parentPlants = new Set(material.plantIds)
        if ((component?.plantIds ?? []).some((plantId) => !parentPlants.has(plantId))) crossPlant += 1
      }
      // Enough of them, and spread widely enough, for the transfer story to be
      // reachable from wherever a planner happens to be looking.
      expect(pairs / snap.materials.length).toBeGreaterThan(0.08)
      expect(pairs / snap.materials.length).toBeLessThan(0.16)
      expect(crossPlant).toBeGreaterThan(0)
      const halbPlants = new Set<string>()
      for (const material of snap.materials) {
        if (material.type === 'HALB') for (const plantId of material.plantIds) halbPlants.add(plantId)
      }
      expect(halbPlants.size).toBeGreaterThanOrEqual(4)
    }
  })

  it('has eight families, about forty groups and an ABC split by value', () => {
    const snap = standard()
    expect(snap.families).toHaveLength(8)
    expect(snap.groups.length).toBeGreaterThanOrEqual(38)
    expect(snap.groups.length).toBeLessThanOrEqual(42)
    const counts = { A: 0, B: 0, C: 0 }
    for (const material of snap.materials) counts[material.abcClass] += 1
    const total = snap.materials.length
    expect(counts.A / total).toBeGreaterThan(0.07)
    expect(counts.A / total).toBeLessThan(0.13)
    expect(counts.B / total).toBeGreaterThan(0.26)
    expect(counts.B / total).toBeLessThan(0.34)
    expect(counts.C / total).toBeGreaterThan(0.55)
    expect(counts.C / total).toBeLessThan(0.65)
    // A parts are the valuable ones. If that is not true the class is a label.
    const meanPrice = (abcClass: Material['abcClass']): number => {
      const values = snap.materials.filter((m) => m.abcClass === abcClass).map((m) => m.pricePerUnitUsd)
      return values.reduce((a, b) => a + b, 0) / values.length
    }
    expect(meanPrice('A')).toBeGreaterThan(meanPrice('B'))
    expect(meanPrice('B')).toBeGreaterThan(meanPrice('C'))
  })
})

describe('downtime', () => {
  it('is always work-center scoped, and carries every kind the model declares', () => {
    const snap = standard()
    const ids = new Set(snap.workCenters.map((wc) => wc.id))
    const kinds = new Set<string>()
    for (const event of snap.downtime) {
      expect(ids.has(event.workCenterId), event.id).toBe(true)
      expect(event.fromWeek).toBeGreaterThanOrEqual(0)
      expect(event.toWeek).toBeLessThan(snap.time.weeks.length)
      expect(event.toWeek).toBeGreaterThanOrEqual(event.fromWeek)
      expect(event.pools.length).toBeGreaterThan(0)
      kinds.add(event.kind)
    }
    expect(snap.downtime.length).toBeGreaterThanOrEqual(250)
    expect(snap.downtime.length).toBeLessThanOrEqual(420)
    for (const kind of ['shutdown', 'project', 'qualification', 'maintenance', 'installation']) {
      expect(kinds.has(kind), `no ${kind} events`).toBe(true)
    }
  })

  it('puts European vacation on labour only and Chinese New Year on both pools', () => {
    const snap = standard()
    const vacation = snap.downtime.filter((e) => e.kind === 'shutdown' && e.label.startsWith('Collective'))
    expect(vacation.length).toBeGreaterThan(0)
    for (const event of vacation) {
      // The presses are not switched off; there is nobody to run them.
      expect(event.pools).toEqual(['labour'])
      expect(event.hoursPerWeek).toBeUndefined()
      const month = snap.time.monthOfWeek[event.fromWeek] ?? ''
      expect(month.endsWith('-08')).toBe(true)
    }
    const newYear = snap.downtime.filter((e) => e.label.includes('Chinese New Year'))
    expect(newYear.length).toBeGreaterThan(0)
    for (const event of newYear) {
      expect(event.workCenterId.startsWith('CN-SUZ')).toBe(true)
      expect([...event.pools].sort()).toEqual(['labour', 'machine'])
    }
  })

  it('carries at-risk installations with a modelled slip', () => {
    const snap = standard()
    const atRisk = snap.downtime.filter((e) => e.status === 'atRisk')
    expect(atRisk.length).toBeGreaterThanOrEqual(4)
    expect(atRisk.length).toBeLessThanOrEqual(8)
    for (const event of atRisk) {
      expect(event.kind).toBe('installation')
      expect(event.slipWeeks ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('the knobs', () => {
  it('carries SKU-specific rate overrides against operations that exist', () => {
    const snap = standard()
    expect(snap.rateOverrides.length).toBeGreaterThanOrEqual(1800)
    expect(snap.rateOverrides.length).toBeLessThanOrEqual(2200)
    const written = new Set<string>()
    for (const routing of snap.routings) {
      for (const op of routing.operations) written.add(key(routing.materialId, op.workCenterId, op.opId))
    }
    for (const override of snap.rateOverrides) {
      expect(
        written.has(key(override.materialId, override.workCenterId, override.opId)),
        `${override.materialId} has no ${override.opId} on ${override.workCenterId}`,
      ).toBe(true)
      expect(override.ratePerHour).toBeGreaterThan(0)
      expect(override.note?.length ?? 0).toBeGreaterThan(10)
    }
  })

  it('carries OEE overrides at both scopes and realistic glide paths', () => {
    const snap = standard()
    expect(snap.oeeOverrides.length).toBeGreaterThanOrEqual(100)
    expect(snap.oeeOverrides.length).toBeLessThanOrEqual(140)
    const scopes = new Set(snap.oeeOverrides.map((o) => o.scope))
    expect(scopes.has('workCenter')).toBe(true)
    expect(scopes.has('materialWorkCenter')).toBe(true)
    for (const override of snap.oeeOverrides) {
      expect(override.value).toBeGreaterThan(0.3)
      expect(override.value).toBeLessThan(0.98)
    }

    expect(snap.glidePaths.length).toBeGreaterThanOrEqual(6)
    expect(snap.glidePaths.length).toBeLessThanOrEqual(10)
    const curves = new Set(snap.glidePaths.map((p) => p.curve))
    expect(curves.has('sCurve')).toBe(true)
    for (const path of snap.glidePaths) {
      expect(path.toWeek).toBeGreaterThan(path.fromWeek)
      expect(path.toWeek).toBeLessThan(snap.time.weeks.length)
      expect(path.endValue).toBeGreaterThan(0.4)
      expect(path.endValue).toBeLessThan(0.98)
      expect(path.label.length).toBeGreaterThan(8)
    }
    const wroclaw = snap.glidePaths.find((p) => p.id === 'GP-PL-WRO-OEE')
    expect(wroclaw?.scope).toBe('plant')
    expect(wroclaw?.startValue).toBe(0.74)
    expect(wroclaw?.endValue).toBe(0.84)
    expect(wroclaw?.curve).toBe('sCurve')
  })
})

describe('the plans', () => {
  it('are correctly dimensioned, finite and keyed as the contract says', () => {
    for (const snap of [demo(), standard()]) {
      const weeks = snap.time.weeks.length
      expect(snap.meta.weekCount).toBe(weeks)
      expect(snap.supplyPlan.weekCount).toBe(weeks)
      expect(snap.demandPlan.weekCount).toBe(weeks)
      expect(snap.supplyPlan.values.length).toBe(snap.supplyPlan.rowKeys.length * weeks)
      expect(snap.demandPlan.values.length).toBe(snap.demandPlan.rowKeys.length * weeks)

      const materialIds = new Set(snap.materials.map((m) => m.id))
      const plantIds = new Set(snap.plants.map((p) => p.id))
      const regions = new Set(snap.plants.map((p) => p.region))
      for (const rowKey of snap.supplyPlan.rowKeys) {
        const [materialId, plantId] = rowKey.split('|')
        expect(materialIds.has(materialId ?? '')).toBe(true)
        expect(plantIds.has(plantId ?? '')).toBe(true)
      }
      for (const rowKey of snap.demandPlan.rowKeys.slice(0, 500)) {
        const [materialId, region] = rowKey.split('|')
        expect(materialIds.has(materialId ?? '')).toBe(true)
        expect((region ?? '').length).toBeGreaterThan(2)
      }
      expect(regions.size).toBeGreaterThan(1)

      // Scanned once and asserted once. Three million `expect` calls take
      // eighty seconds and tell you nothing a single count does not.
      for (const values of [snap.supplyPlan.values, snap.demandPlan.values]) {
        let bad = 0
        for (let i = 0; i < values.length; i++) {
          const value = f64(values, i)
          if (!Number.isFinite(value) || value < 0) bad += 1
        }
        expect(bad, 'non-finite or negative plan quantities').toBe(0)
      }
      expect(new Set(snap.supplyPlan.rowKeys).size).toBe(snap.supplyPlan.rowKeys.length)
      expect(new Set(snap.demandPlan.rowKeys).size).toBe(snap.demandPlan.rowKeys.length)
    }
  })

  it('plans no production into a collectively shut plant', () => {
    const snap = standard()
    const weeks = snap.time.weeks.length
    const shut = new Map<string, Set<number>>()
    for (const event of snap.downtime) {
      if (event.kind !== 'shutdown') continue
      const plantId = snap.workCenters.find((wc) => wc.id === event.workCenterId)?.plantId
      if (plantId === undefined) continue
      let set = shut.get(plantId)
      if (set === undefined) {
        set = new Set<number>()
        shut.set(plantId, set)
      }
      for (let w = event.fromWeek; w <= event.toWeek; w++) set.add(w)
    }
    expect(shut.size).toBeGreaterThanOrEqual(3)
    for (let r = 0; r < snap.supplyPlan.rowKeys.length; r++) {
      const plantId = at(snap.supplyPlan.rowKeys, r, 'row key').split('|')[1] ?? ''
      const closed = shut.get(plantId)
      if (closed === undefined) continue
      for (const w of closed) expect(f64(snap.supplyPlan.values, r * weeks + w)).toBe(0)
    }
  })

  it('leaves a real, bounded gap between demand and supply', () => {
    for (const snap of [demo(), standard()]) {
      let supply = 0
      for (let i = 0; i < snap.supplyPlan.values.length; i++) supply += f64(snap.supplyPlan.values, i)
      let demandUnits = 0
      for (let i = 0; i < snap.demandPlan.values.length; i++) demandUnits += f64(snap.demandPlan.values, i)
      expect(supply).toBeGreaterThan(0)
      const ratio = demandUnits / supply
      expect(ratio).toBeGreaterThan(1.06)
      expect(ratio).toBeLessThan(1.14)
    }
  })

  it('holds inventory for every supply row', () => {
    const snap = standard()
    expect(snap.inventory).toHaveLength(snap.supplyPlan.rowKeys.length)
    const seen = new Set<string>()
    for (const row of snap.inventory) {
      const rowKey = key(row.materialId, row.plantId)
      expect(seen.has(rowKey)).toBe(false)
      seen.add(rowKey)
      for (const value of [row.onHand, row.inTransit, row.safetyStock]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

/**
 * The calibration bands, measured with `runModel` on the standard profile.
 *
 * These replace an earlier test that asserted first-quarter network
 * utilisation and a count of SUSTAINED overloads — and passed while the
 * dataset was plainly broken. Both numbers can be exactly right while the load
 * sits on a fifth of the network: an average says nothing about a
 * distribution, and "mean utilisation across the last third above 1.0" quietly
 * excuses a work center that spends thirty weeks at 3x its hours. What the
 * product actually shows is a GRID of (work center, week) cells, so that is
 * what is asserted here — every cell, on whichever pool binds it.
 *
 * The counts are claims about the 150-work-center network specifically.
 * Asserting them on a tenth of it would prove nothing, which is why they live
 * on `standard` rather than on `demo`.
 */
let baselineResult: ModelResult | undefined
function baseline(): ModelResult {
  if (baselineResult === undefined) {
    baselineResult = runModel(standard(), baselineScenario(), defaultFilters(standard()))
  }
  return baselineResult
}

interface WorkCenterProfile {
  id: string
  plantId: string
  peak: number
  peakPool: CapacityPool
  mean: number
  firstOverWeek: number
}

let profilesCache: WorkCenterProfile[] | undefined
function workCenterProfiles(): WorkCenterProfile[] {
  if (profilesCache !== undefined) return profilesCache
  const snap = standard()
  const weeks = snap.time.weeks.length
  const byId = new Map<string, WorkCenterProfile>()
  for (const wc of snap.workCenters) {
    byId.set(wc.id, {
      id: wc.id,
      plantId: wc.plantId,
      peak: 0,
      peakPool: 'machine',
      mean: 0,
      firstOverWeek: Number.POSITIVE_INFINITY,
    })
  }
  for (const cell of baseline().cells) {
    const entry = byId.get(cell.workCenterId)
    if (entry === undefined) continue
    entry.mean += cell.utilisation / weeks
    if (cell.utilisation > entry.peak) {
      entry.peak = cell.utilisation
      entry.peakPool = cell.bindingPool
    }
    if (cell.utilisation > 1 && cell.week < entry.firstOverWeek) entry.firstOverWeek = cell.week
  }
  profilesCache = [...byId.values()]
  return profilesCache
}

describe('calibration', () => {
  it('lands network machine utilisation in the target band', () => {
    const kpis = baseline().kpis
    const utilisation = kpis.requiredHours / kpis.availableHours
    expect(utilisation).toBeGreaterThanOrEqual(0.76)
    expect(utilisation).toBeLessThanOrEqual(0.86)
    // The KPI the cockpit prints has to agree with the hours it is derived
    // from, or the headline and the grid tell different stories.
    expect(Math.abs(kpis.utilisation - utilisation)).toBeLessThan(0.005)
  })

  it('produces a handful of real bottlenecks, not a network of them', () => {
    const profiles = workCenterProfiles()
    const over = profiles.filter((p) => p.peak > 1)
    // A grid where everything is red makes the product's core story — find a
    // saturated work center, find somewhere that can take the load —
    // meaningless, because nothing has room and everything is broken.
    expect(over.length).toBeGreaterThanOrEqual(12)
    expect(over.length).toBeLessThanOrEqual(30)
    // Nothing is at twice its hours. That is a data error, not a bottleneck.
    expect(profiles.filter((p) => p.peak > 2)).toHaveLength(0)
    expect(baseline().kpis.peakUtilisation).toBeLessThanOrEqual(1.6)
    // …and a real one exists. A network at a flat 0.8 has nothing to find.
    expect(baseline().kpis.peakUtilisation).toBeGreaterThan(1.1)
  })

  it('keeps the overloaded set small, spread and answerable in both pools', () => {
    const profiles = workCenterProfiles()
    const over = profiles.filter((p) => p.peak > 1)
    const cells = profiles.length * standard().time.weeks.length
    expect(baseline().kpis.overloadedCells).toBeLessThanOrEqual(cells * 0.08)
    // A bottleneck list that names one site is a story about that site.
    expect(new Set(over.map((p) => p.plantId)).size).toBeGreaterThanOrEqual(3)
    // Both pools, or "capex or hiring?" — the question the two-pool model
    // exists to answer — has one answer for the whole network.
    expect(over.filter((p) => p.peakPool === 'machine').length).toBeGreaterThanOrEqual(3)
    expect(over.filter((p) => p.peakPool === 'labour').length).toBeGreaterThanOrEqual(3)
  })

  it('leaves relief targets the load can actually be moved to', () => {
    const profiles = workCenterProfiles()
    expect(profiles.filter((p) => p.mean < 0.4).length).toBeGreaterThanOrEqual(15)
  })

  it('keeps the plan makeable — the shortfall is an exception, not the rule', () => {
    const kpis = baseline().kpis
    expect(kpis.supplyUnits).toBeGreaterThan(0)
    expect(kpis.shortfallUnits).toBeLessThanOrEqual(kpis.supplyUnits * 0.03)
    // But not zero: a plan the network can make in full has no tension in it.
    expect(kpis.shortfallUnits).toBeGreaterThan(0)
  })

  it('lets the bottlenecks EMERGE rather than being there from week 1', () => {
    const snap = standard()
    const weeks = snap.time.weeks.length
    const third = Math.floor(weeks / 3)

    let earlyRequired = 0
    let earlyAvailable = 0
    let lateRequired = 0
    let lateAvailable = 0
    let earlyOverloaded = 0
    for (const cell of baseline().cells) {
      if (cell.week < third) {
        earlyRequired += cell.machineRequired
        earlyAvailable += cell.machineAvailable
        if (cell.utilisation > 1) earlyOverloaded += 1
      } else if (cell.week >= 2 * third) {
        lateRequired += cell.machineRequired
        lateAvailable += cell.machineAvailable
      }
    }
    const early = earlyRequired / earlyAvailable
    const late = lateRequired / lateAvailable
    expect(late).toBeGreaterThan(early + 0.04)
    // Almost nothing is over its ceiling in the first six months.
    expect(earlyOverloaded).toBeLessThanOrEqual(baseline().kpis.overloadedCells * 0.1)

    const arrivals = workCenterProfiles()
      .map((p) => p.firstOverWeek)
      .filter((w) => Number.isFinite(w))
      .sort((a, b) => a - b)
    expect(arrivals.length).toBeGreaterThan(0)
    const median = at(arrivals, Math.floor(arrivals.length / 2), 'median arrival')
    expect(median).toBeGreaterThanOrEqual(third)
  })

  it('builds enough labour-bound work centers for the hiring case to be visible', () => {
    // Measured on which pool ACTUALLY binds, not on which pool has fewer hours.
    // How many operator hours a machine hour costs is a property of the
    // OPERATION — assembly wants 2.5, high-volume moulding 0.6 — so a cell can
    // be short of operators with a larger labour pool than machine pool, and
    // comfortable with a smaller one. Counting pool sizes measured the shift
    // pattern and called it a constraint.
    const snap = standard()
    const weeks = snap.time.weeks.length
    const machineHours = new Map<string, { required: number; available: number }>()
    const labourHours = new Map<string, { required: number; available: number }>()
    for (const cell of baseline().cells) {
      const machine = machineHours.get(cell.workCenterId) ?? { required: 0, available: 0 }
      machine.required += cell.machineRequired
      machine.available += cell.machineAvailable
      machineHours.set(cell.workCenterId, machine)
      const labour = labourHours.get(cell.workCenterId) ?? { required: 0, available: 0 }
      labour.required += cell.labourRequired
      labour.available += cell.labourAvailable
      labourHours.set(cell.workCenterId, labour)
    }

    let labourBound = 0
    let loaded = 0
    for (const wc of snap.workCenters) {
      const machine = machineHours.get(wc.id)
      const labour = labourHours.get(wc.id)
      if (machine === undefined || labour === undefined) continue
      if (!(machine.required > 0)) continue
      loaded += 1
      const machineUtil = machine.available > 0 ? machine.required / machine.available : 0
      const labourUtil = labour.available > 0 ? labour.required / labour.available : 0
      if (labourUtil > machineUtil) labourBound += 1
    }
    expect(weeks).toBeGreaterThan(0)
    expect(labourBound).toBeGreaterThanOrEqual(15)
    expect(labourBound).toBeLessThan(loaded * 0.5)
  })
})
