import { describe, expect, it } from 'vitest'
import type {
  MachineClass,
  Plant,
  PoolCapacity,
  Routing,
  Snapshot,
  StandardOperation,
  WorkCenter,
} from '@/domain/types'
import { buildIndexes } from '@/domain/indexes'
import {
  capabilityBasis,
  findRetrofit,
  missingFeatures,
  sharedCapacityLinks,
} from '@/domain/capability'
import { buildTimeGrid } from '@/domain/time'

const WEEKS = 4

const POOLS: PoolCapacity[] = [
  { pool: 'machine', count: 1, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
  { pool: 'labour', count: 2, shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, utilisationFactor: 1 },
]

const PLANT: Plant = {
  id: 'P1',
  code: 'P1',
  name: 'Plant 1',
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
  defaultOee: 0.8,
  gridIntensity: 0.3,
}

function wc(id: string, classId: string, features: string[]): WorkCenter {
  return {
    id,
    plantId: 'P1',
    code: id,
    name: id,
    classId,
    vintage: 2015,
    pools: POOLS,
    features,
    baseOee: 0.8,
    status: 'active',
    costRateUsdPerHour: 90,
    co2PerMachineHourKg: 4,
  }
}

function stdOp(id: string, requiredFeatures: string[], stage = 1): StandardOperation {
  return { id, code: id, name: id, requiredFeatures, stage }
}

function routing(id: string, materialId: string, ops: Array<{ opId: string; workCenterId: string }>): Routing {
  return {
    id,
    materialId,
    plantId: 'P1',
    version: '0001',
    primary: true,
    operations: ops.map((o, i) => ({
      seq: (i + 1) * 10,
      opId: o.opId,
      workCenterId: o.workCenterId,
      baseQty: 100,
      setupHours: 1,
      machineHoursPerBase: 2,
      labourHoursPerBase: 2,
      yield: 1,
    })),
  }
}

/**
 * WC-APPROVED   approved for OP-A by a routing, but owns none of its features.
 * WC-CAPABLE    has every feature OP-A needs, and no approval at all.
 * WC-RETRO      one feature short, and its class sells two options that close it.
 * WC-IMPOSSIBLE one feature short with no option that adds it.
 */
function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const classes: MachineClass[] = [
    {
      id: 'CLASS-PLAIN',
      name: 'Plain',
      supplier: 'ACME',
      generation: 1,
      baseFeatures: [],
      retrofits: [],
    },
    {
      id: 'CLASS-RETRO',
      name: 'Retrofittable',
      supplier: 'ACME',
      generation: 2,
      baseFeatures: ['F-HEAT'],
      retrofits: [
        {
          id: 'RET-PREMIUM',
          name: 'Premium head',
          addsFeatures: ['F-VISION', 'F-LASER'],
          capexUsd: 400_000,
          leadTimeWeeks: 20,
          oeeDelta: 0.04,
          description: 'Adds vision and laser',
        },
        {
          id: 'RET-BASIC',
          name: 'Vision kit',
          addsFeatures: ['F-VISION'],
          capexUsd: 120_000,
          leadTimeWeeks: 12,
          oeeDelta: 0.01,
          description: 'Adds vision only',
        },
        {
          id: 'RET-IRRELEVANT',
          name: 'Chip conveyor',
          addsFeatures: ['F-CHIP'],
          capexUsd: 20_000,
          leadTimeWeeks: 4,
          oeeDelta: 0.02,
          description: 'Closes nothing OP-A needs',
        },
      ],
    },
    {
      id: 'CLASS-DEAD-END',
      name: 'Dead end',
      supplier: 'OTHER',
      generation: 1,
      baseFeatures: ['F-HEAT'],
      retrofits: [
        {
          id: 'RET-NOTHING',
          name: 'Chip conveyor',
          addsFeatures: ['F-CHIP'],
          capexUsd: 15_000,
          leadTimeWeeks: 3,
          oeeDelta: 0,
          description: 'Closes nothing OP-A needs',
        },
      ],
    },
  ]
  return {
    meta: {
      profile: 'test',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 1,
      workCenterCount: 4,
      weekCount: WEEKS,
    },
    time: buildTimeGrid('2026-09-07', WEEKS),
    plants: [PLANT],
    features: [],
    machineClasses: classes,
    workCenters: [
      wc('WC-APPROVED', 'CLASS-PLAIN', []),
      wc('WC-CAPABLE', 'CLASS-PLAIN', ['F-HEAT', 'F-VISION', 'F-EXTRA']),
      wc('WC-RETRO', 'CLASS-RETRO', ['F-HEAT']),
      wc('WC-IMPOSSIBLE', 'CLASS-DEAD-END', ['F-HEAT']),
    ],
    standardOperations: [stdOp('OP-A', ['F-HEAT', 'F-VISION']), stdOp('OP-B', ['F-HEAT'], 2)],
    families: [],
    groups: [],
    materials: [],
    routings: [routing('R1', 'M1', [{ opId: 'OP-A', workCenterId: 'WC-APPROVED' }])],
    rateOverrides: [],
    oeeOverrides: [],
    glidePaths: [],
    downtime: [],
    supplyPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    demandPlan: { rowKeys: [], weekCount: WEEKS, values: new Float64Array(0) },
    inventory: [],
    ...over,
  }
}

const indexes = (over: Partial<Snapshot> = {}) => buildIndexes(snapshot(over))

describe('capabilityBasis', () => {
  it('reports approved from the allow-list alone, features or not', () => {
    const idx = indexes()
    // WC-APPROVED has none of OP-A's features, but master data says it runs the
    // operation. The allow-list is truth; the feature model is only a proposal.
    expect(capabilityBasis(idx, 'WC-APPROVED', 'OP-A')).toBe('approved')
    expect(missingFeatures(idx, 'WC-APPROVED', 'OP-A')).toEqual(['F-HEAT', 'F-VISION'])
  })

  it('NEVER reports an unapproved but feature-capable work center as approved', () => {
    const idx = indexes()
    expect(capabilityBasis(idx, 'WC-CAPABLE', 'OP-A')).toBe('featureCapable')
    expect(missingFeatures(idx, 'WC-CAPABLE', 'OP-A')).toEqual([])
    expect(idx.approvedWorkCentersByOp.get('OP-A')).toEqual(['WC-APPROVED'])
  })

  it('reports retrofit when the class can close the gap', () => {
    const idx = indexes()
    expect(capabilityBasis(idx, 'WC-RETRO', 'OP-A')).toBe('retrofit')
    expect(missingFeatures(idx, 'WC-RETRO', 'OP-A')).toEqual(['F-VISION'])
  })

  it('reports none when no retrofit on the class closes the gap', () => {
    const idx = indexes()
    expect(capabilityBasis(idx, 'WC-IMPOSSIBLE', 'OP-A')).toBe('none')
    expect(missingFeatures(idx, 'WC-IMPOSSIBLE', 'OP-A')).toEqual(['F-VISION'])
  })

  it('refuses to claim capability for an operation with no standard record', () => {
    const idx = indexes()
    expect(capabilityBasis(idx, 'WC-CAPABLE', 'OP-UNKNOWN')).toBe('none')
    expect(missingFeatures(idx, 'WC-CAPABLE', 'OP-UNKNOWN')).toEqual([])
  })

  it('still reports approved for an operation with no standard record', () => {
    const idx = indexes({
      routings: [routing('R1', 'M1', [{ opId: 'OP-GHOST', workCenterId: 'WC-APPROVED' }])],
    })
    expect(capabilityBasis(idx, 'WC-APPROVED', 'OP-GHOST')).toBe('approved')
  })

  it('reports none for a work center that is not in the snapshot', () => {
    expect(capabilityBasis(indexes(), 'WC-GHOST', 'OP-A')).toBe('none')
  })

  it('resolves a second operation independently of the first', () => {
    const idx = indexes()
    // OP-B needs only F-HEAT: capable where OP-A was capable, and impossible on
    // the featureless machine whose class sells no retrofits at all.
    expect(capabilityBasis(idx, 'WC-CAPABLE', 'OP-B')).toBe('featureCapable')
    expect(capabilityBasis(idx, 'WC-RETRO', 'OP-B')).toBe('featureCapable')
    expect(capabilityBasis(idx, 'WC-APPROVED', 'OP-B')).toBe('none')
  })
})

describe('findRetrofit', () => {
  it('returns the cheapest option that closes the whole gap', () => {
    const idx = indexes()
    const option = findRetrofit(idx, 'WC-RETRO', 'OP-A')
    expect(option?.id).toBe('RET-BASIC')
    expect(option?.capexUsd).toBe(120_000)
  })

  it('returns null when there is nothing to close', () => {
    const idx = indexes()
    expect(findRetrofit(idx, 'WC-CAPABLE', 'OP-A')).toBeNull()
    expect(findRetrofit(idx, 'WC-RETRO', 'OP-B')).toBeNull()
  })

  it('returns null when no single option covers every missing feature', () => {
    const idx = indexes({
      standardOperations: [stdOp('OP-A', ['F-HEAT', 'F-VISION', 'F-CHIP'])],
    })
    // RET-BASIC covers vision, RET-IRRELEVANT covers the chip conveyor; neither
    // covers both, and a retrofit proposal is one purchase order.
    expect(findRetrofit(idx, 'WC-RETRO', 'OP-A')).toBeNull()
    expect(capabilityBasis(idx, 'WC-RETRO', 'OP-A')).toBe('none')
    // The premium option covers both, so it wins despite costing more.
    const wider = indexes({
      standardOperations: [stdOp('OP-A', ['F-HEAT', 'F-VISION', 'F-LASER'])],
    })
    expect(findRetrofit(wider, 'WC-RETRO', 'OP-A')?.id).toBe('RET-PREMIUM')
  })

  it('returns null when the work center or its class is unknown', () => {
    expect(findRetrofit(indexes(), 'WC-GHOST', 'OP-A')).toBeNull()
  })
})

describe('sharedCapacityLinks', () => {
  it('finds every other work center that could run the operations this one runs', () => {
    const links = sharedCapacityLinks(indexes(), 'WC-APPROVED')
    expect(links.map((l) => l.workCenterId)).toEqual(['WC-CAPABLE', 'WC-RETRO'])
    expect(links[0]).toEqual({
      workCenterId: 'WC-CAPABLE',
      basis: 'featureCapable',
      sharedOperations: 1,
    })
    expect(links[1]).toEqual({
      workCenterId: 'WC-RETRO',
      basis: 'retrofit',
      sharedOperations: 1,
    })
  })

  it('never links a work center to itself', () => {
    for (const id of ['WC-APPROVED', 'WC-CAPABLE', 'WC-RETRO', 'WC-IMPOSSIBLE']) {
      expect(sharedCapacityLinks(indexes(), id).some((l) => l.workCenterId === id)).toBe(false)
    }
  })

  it('returns nothing for a work center that runs nothing', () => {
    expect(sharedCapacityLinks(indexes(), 'WC-CAPABLE')).toEqual([])
  })

  it('counts shared operations and keeps the strongest basis, approved first', () => {
    const idx = indexes({
      routings: [
        routing('R1', 'M1', [
          { opId: 'OP-A', workCenterId: 'WC-APPROVED' },
          { opId: 'OP-B', workCenterId: 'WC-APPROVED' },
        ]),
        // WC-RETRO is approved for OP-B, and only retrofittable for OP-A.
        routing('R2', 'M2', [{ opId: 'OP-B', workCenterId: 'WC-RETRO' }]),
      ],
    })
    const links = sharedCapacityLinks(idx, 'WC-APPROVED')
    const byId = new Map(links.map((l) => [l.workCenterId, l]))
    expect(byId.get('WC-RETRO')).toEqual({
      workCenterId: 'WC-RETRO',
      basis: 'approved',
      sharedOperations: 2,
    })
    expect(byId.get('WC-CAPABLE')?.basis).toBe('featureCapable')
    expect(byId.get('WC-CAPABLE')?.sharedOperations).toBe(2)
    expect(byId.get('WC-IMPOSSIBLE')?.basis).toBe('featureCapable')
    expect(byId.get('WC-IMPOSSIBLE')?.sharedOperations).toBe(1)
    // Approved edges sort first, then breadth of overlap.
    expect(links.map((l) => l.workCenterId)).toEqual(['WC-RETRO', 'WC-CAPABLE', 'WC-IMPOSSIBLE'])
  })
})
