import { describe, expect, it } from 'vitest'
import type {
  MachineClass,
  ModelResult,
  StandardOperation,
  WorkCenter,
  WorkCenterWeekLoad,
} from '@/domain/types'
import { at } from '@/domain/lookup'
import {
  aggregatePlants,
  aggregateWorkCenters,
  arcPath,
  bubbleRadius,
  buildCapabilityCatalog,
  bundleControls,
  classifyDrop,
  clusterGlobeSites,
  cullEdges,
  edgePath,
  findClosingRetrofit,
  layoutArcs,
  layoutGhostFan,
  layoutGlobe,
  layoutSatellites,
  layoutStageColumns,
  layoutStrip,
  placeGlobeLabels,
  previewImpact,
  utilisationSignal,
} from '@/canvas/layout'
import type {
  EdgeInput,
  GlobeMark,
  GlobeSite,
  StageNodeInput,
  WorkCenterAggregate,
} from '@/canvas/layout'
import { project } from '@/canvas/projection'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WEEKS = 4

function grid(rows: number, fill: (row: number, week: number) => number): Float64Array {
  const out = new Float64Array(rows * WEEKS)
  for (let row = 0; row < rows; row += 1) {
    for (let week = 0; week < WEEKS; week += 1) out[row * WEEKS + week] = fill(row, week)
  }
  return out
}

function makeResult(cells: WorkCenterWeekLoad[] = []): ModelResult {
  const ids = ['WC-1', 'WC-2']
  const zero = (): Float64Array => new Float64Array(ids.length * WEEKS)
  return {
    scenarioId: 'S',
    time: {
      weeks: ['w0', 'w1', 'w2', 'w3'],
      weekStart: [],
      monthOfWeek: [],
      quarterOfWeek: [],
      months: [],
      quarters: [],
    },
    grids: {
      machine: {
        workCenterIds: ids,
        weekCount: WEEKS,
        availableHours: grid(ids.length, () => 100),
        requiredHours: grid(ids.length, (row) => (row === 0 ? 120 : 40)),
        downtimeHours: zero(),
        overloadHours: grid(ids.length, (row) => (row === 0 ? 20 : 0)),
        setupHours: zero(),
      },
      labour: {
        workCenterIds: ids,
        weekCount: WEEKS,
        availableHours: grid(ids.length, () => 200),
        requiredHours: grid(ids.length, () => 50),
        downtimeHours: zero(),
        overloadHours: zero(),
        setupHours: zero(),
      },
    },
    cells,
    kpis: {} as ModelResult['kpis'],
    kpisByWeek: [],
    bottlenecks: [],
    oeeByWorkCenterWeek: grid(ids.length, (row) => (row === 0 ? 0.9 : 0.6)),
    runtimeMs: 1,
    capexUsd: 0,
    warnings: [],
  }
}

function cell(id: string, week: number, over: boolean): WorkCenterWeekLoad {
  return {
    workCenterId: id,
    week,
    machineRequired: over ? 120 : 40,
    machineAvailable: 100,
    labourRequired: 50,
    labourAvailable: 200,
    ceiling: 1,
    utilisation: over ? 1.2 : 0.4,
    bindingPool: 'machine',
    overloadHours: over ? 20 : 0,
    shortfallUnits: 0,
    oee: 0.9,
    downtimeHours: 0,
    events: [],
  }
}

const FEATURES = { mould: 'F-MOULD', paint: 'F-PAINT', pack: 'F-PACK', clean: 'F-CLEAN' }

const OPS: StandardOperation[] = [
  { id: 'OP-MOULD', code: 'OP-MOULD', name: 'Mould shot', requiredFeatures: [FEATURES.mould], stage: 10 },
  { id: 'OP-PAINT', code: 'OP-PAINT', name: 'Paint line', requiredFeatures: [FEATURES.paint], stage: 20 },
  { id: 'OP-PACK', code: 'OP-PACK', name: 'Packing cell', requiredFeatures: [FEATURES.pack], stage: 30 },
]

const CLASSES: MachineClass[] = [
  {
    id: 'C-MOULD',
    name: 'Moulder G3',
    supplier: 'Arburg',
    generation: 3,
    baseFeatures: [FEATURES.mould],
    retrofits: [
      {
        id: 'R-PAINT-CHEAP',
        name: 'Paint head',
        addsFeatures: [FEATURES.paint],
        capexUsd: 200_000,
        leadTimeWeeks: 12,
        oeeDelta: 0.01,
        description: '',
      },
      {
        id: 'R-PAINT-FAST',
        name: 'Paint head, express',
        addsFeatures: [FEATURES.paint],
        capexUsd: 200_000,
        leadTimeWeeks: 6,
        oeeDelta: 0.01,
        description: '',
      },
    ],
  },
  {
    id: 'C-PACK',
    name: 'Packer G1',
    supplier: 'Bosch',
    generation: 1,
    baseFeatures: [FEATURES.pack],
    retrofits: [],
  },
]

function wc(id: string, plantId: string, classId: string, features: string[]): WorkCenter {
  return {
    id,
    plantId,
    code: id,
    name: id,
    classId,
    vintage: 2015,
    pools: [],
    features,
    baseOee: 0.8,
    status: 'active',
    costRateUsdPerHour: 90,
    co2PerMachineHourKg: 4,
  }
}

const WORK_CENTERS: WorkCenter[] = [
  wc('WC-1', 'P1', 'C-MOULD', [FEATURES.mould]),
  wc('WC-2', 'P1', 'C-MOULD', [FEATURES.mould, FEATURES.clean]),
  wc('WC-3', 'P2', 'C-PACK', [FEATURES.pack]),
]

// ---------------------------------------------------------------------------

describe('utilisationSignal', () => {
  it('reads the ceiling as neutral and clamps both ends', () => {
    expect(utilisationSignal(1)).toBe(0)
    expect(utilisationSignal(0.75)).toBeCloseTo(-0.5, 9)
    expect(utilisationSignal(1.25)).toBeCloseTo(0.5, 9)
    expect(utilisationSignal(9)).toBe(1)
    expect(utilisationSignal(0)).toBe(-1)
  })

  it('survives a non-finite utilisation rather than painting garbage', () => {
    expect(utilisationSignal(Number.NaN)).toBe(0)
  })
})

describe('bubbleRadius', () => {
  it('encodes on area, not radius', () => {
    const quarter = bubbleRadius(25, 100, 0, 40)
    const full = bubbleRadius(100, 100, 0, 40)
    expect(quarter).toBeCloseTo(full / 2, 9)
  })

  it('floors at the minimum for zero and nonsense', () => {
    expect(bubbleRadius(0, 100, 12, 40)).toBe(12)
    expect(bubbleRadius(10, 0, 12, 40)).toBe(12)
    expect(bubbleRadius(Number.NaN, 100, 12, 40)).toBe(12)
  })
})

describe('aggregateWorkCenters', () => {
  it('returns nothing for a run that has not landed', () => {
    expect(aggregateWorkCenters(null, 0, 3).size).toBe(0)
  })

  it('uses cells when the run materialised them, keeping the applied ceiling', () => {
    const cells = [cell('WC-1', 0, true), cell('WC-1', 1, true), cell('WC-2', 0, false), cell('WC-2', 1, false)]
    const map = aggregateWorkCenters(makeResult(cells), 0, 1)
    const one = map.get('WC-1')
    expect(one?.utilisation).toBeCloseTo(1.2, 9)
    expect(one?.weeksOverCeiling).toBe(2)
    expect(one?.requiredHours).toBe(240)
    expect(one?.overloadHours).toBe(40)
    expect(map.get('WC-2')?.utilisation).toBeCloseTo(0.4, 9)
  })

  it('falls back to the dense grids when the run was aggregates-only', () => {
    const map = aggregateWorkCenters(makeResult(), 0, 3)
    const one = map.get('WC-1')
    expect(one?.bindingPool).toBe('machine')
    expect(one?.requiredHours).toBe(480)
    expect(one?.availableHours).toBe(400)
    expect(one?.utilisation).toBeCloseTo(1.2, 9)
    expect(one?.peakUtilisation).toBeCloseTo(1.2, 9)
    expect(one?.oee).toBeCloseTo(0.9, 9)
    expect(map.get('WC-2')?.oee).toBeCloseTo(0.6, 9)
  })

  it('honours the week window', () => {
    const full = aggregateWorkCenters(makeResult(), 0, 3).get('WC-1')
    const half = aggregateWorkCenters(makeResult(), 0, 1).get('WC-1')
    expect(half?.requiredHours).toBe((full?.requiredHours ?? 0) / 2)
    expect(half?.utilisation).toBeCloseTo(full?.utilisation ?? 0, 9)
  })

  it('clamps a window that runs off the end of the horizon', () => {
    const map = aggregateWorkCenters(makeResult(), -5, 500)
    expect(map.get('WC-1')?.requiredHours).toBe(480)
  })
})

describe('aggregatePlants', () => {
  it('weights by hours rather than averaging averages', () => {
    const aggregates = aggregateWorkCenters(makeResult(), 0, 3)
    const plants = aggregatePlants(aggregates, [
      wc('WC-1', 'P1', 'C-MOULD', []),
      wc('WC-2', 'P1', 'C-MOULD', []),
    ])
    const p1 = plants.get('P1')
    expect(p1?.workCenterCount).toBe(2)
    expect(p1?.requiredHours).toBe(640)
    expect(p1?.utilisation).toBeCloseTo(640 / 800, 9)
    expect(p1?.overloadedWorkCenters).toBe(1)
  })

  it('counts a plant with no model rows without crashing', () => {
    const plants = aggregatePlants(new Map(), [wc('WC-9', 'P9', 'C', [])])
    expect(plants.get('P9')?.workCenterCount).toBe(1)
    expect(plants.get('P9')?.utilisation).toBe(0)
  })
})

describe('arcPath / layoutArcs', () => {
  it('bows off the straight line and puts mid on the curve', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 100, y: 0 }
    const { path, control, mid } = arcPath(a, b, 40)
    expect(path).toBe('M0,0Q50,40 100,0')
    expect(control).toEqual({ x: 50, y: 40 })
    expect(mid).toEqual({ x: 50, y: 20 })
  })

  it('gives opposing flows opposite bows so they never overlap', () => {
    const positions = new Map([
      ['A', { x: 0, y: 0 }],
      ['B', { x: 200, y: 0 }],
    ])
    const arcs = layoutArcs(
      [
        { id: '1', kind: 'load', fromPlantId: 'A', toPlantId: 'B', share: 0.5, label: 'A to B' },
        { id: '2', kind: 'load', fromPlantId: 'B', toPlantId: 'A', share: 0.5, label: 'B to A' },
      ],
      positions,
    )
    expect(arcs).toHaveLength(2)
    const first = at(arcs, 0, 'arc')
    const second = at(arcs, 1, 'arc')
    expect(Math.sign(first.control.y - 0)).toBe(-Math.sign(second.control.y - 0))
  })

  it('stacks several flows on the same pair outwards instead of on top', () => {
    const positions = new Map([
      ['A', { x: 0, y: 0 }],
      ['B', { x: 200, y: 0 }],
    ])
    const arcs = layoutArcs(
      [
        { id: '1', kind: 'load', fromPlantId: 'A', toPlantId: 'B', share: 0.2, label: '' },
        { id: '2', kind: 'wip', fromPlantId: 'A', toPlantId: 'B', share: 0.2, label: '' },
        { id: '3', kind: 'sourceSwitch', fromPlantId: 'A', toPlantId: 'B', share: 0.2, label: '' },
      ],
      positions,
    )
    const bows = arcs.map((arc) => Math.abs(arc.control.y))
    expect(bows[1]).toBeGreaterThan(bows[0] ?? 0)
    expect(bows[2]).toBeGreaterThan(bows[1] ?? 0)
  })

  it('widths load arcs by share and leaves the other kinds hairline', () => {
    const positions = new Map([
      ['A', { x: 0, y: 0 }],
      ['B', { x: 200, y: 0 }],
    ])
    const arcs = layoutArcs(
      [
        { id: '1', kind: 'load', fromPlantId: 'A', toPlantId: 'B', share: 1, label: '' },
        { id: '2', kind: 'wip', fromPlantId: 'A', toPlantId: 'B', share: 1, label: '' },
      ],
      positions,
      { minWidth: 2, maxWidth: 10 },
    )
    expect(at(arcs, 0, 'arc').width).toBe(10)
    expect(at(arcs, 1, 'arc').width).toBe(2)
  })

  it('drops flows whose endpoints are unknown or identical', () => {
    const positions = new Map([['A', { x: 0, y: 0 }]])
    const arcs = layoutArcs(
      [
        { id: '1', kind: 'load', fromPlantId: 'A', toPlantId: 'ZZ', share: 1, label: '' },
        { id: '2', kind: 'load', fromPlantId: 'A', toPlantId: 'A', share: 1, label: '' },
      ],
      positions,
    )
    expect(arcs).toHaveLength(0)
  })
})

describe('buildCapabilityCatalog', () => {
  const catalog = buildCapabilityCatalog(WORK_CENTERS, CLASSES, OPS)

  it('marks a work center capable only of the operations its features cover', () => {
    expect(Array.from(catalog.capableOpsByWorkCenter.get('WC-1') ?? [])).toEqual(['OP-MOULD'])
    expect(Array.from(catalog.capableOpsByWorkCenter.get('WC-3') ?? [])).toEqual(['OP-PACK'])
  })

  it('derives a process stage per work center from the operations it can run', () => {
    expect(catalog.stageByWorkCenter.get('WC-1')).toBe(10)
    expect(catalog.stageByWorkCenter.get('WC-3')).toBe(30)
  })

  it('names stage columns from the operation, not a hard-coded list', () => {
    expect(catalog.stageLabel.get(10)).toBe('Mould')
    expect(catalog.stageLabel.get(30)).toBe('Packing')
    expect(catalog.stages).toEqual([10, 20, 30])
  })
})

describe('classifyDrop', () => {
  const catalog = buildCapabilityCatalog(WORK_CENTERS, CLASSES, OPS)

  it('refuses a drop onto the source itself', () => {
    const result = classifyDrop({ sourceId: 'WC-1', targetId: 'WC-1', catalog })
    expect(result.allowed).toBe(false)
    expect(result.icon).toBe('blocked')
    expect(result.label).toBe('Same work center')
  })

  it('only ever claims approved on the worker-supplied allow-list', () => {
    const guess = classifyDrop({ sourceId: 'WC-1', targetId: 'WC-2', catalog })
    expect(guess.basis).toBe('featureCapable')
    expect(guess.status).toBe('warning')
    expect(guess.icon).toBe('wrench')

    const known = classifyDrop({
      sourceId: 'WC-1',
      targetId: 'WC-2',
      catalog,
      approvedBasis: new Map([['WC-2', 'approved' as const]]),
    })
    expect(known.basis).toBe('approved')
    expect(known.status).toBe('good')
    expect(known.icon).toBe('check')
    expect(known.allowed).toBe(true)
  })

  it('proposes the cheapest, then fastest, retrofit when features do not overlap', () => {
    const painters = [
      wc('WC-P', 'P1', 'C-MOULD', [FEATURES.paint]),
      wc('WC-M', 'P1', 'C-MOULD', [FEATURES.mould]),
    ]
    const catalog2 = buildCapabilityCatalog(painters, CLASSES, OPS)
    const result = classifyDrop({ sourceId: 'WC-P', targetId: 'WC-M', catalog: catalog2 })
    expect(result.basis).toBe('retrofit')
    expect(result.status).toBe('serious')
    expect(result.icon).toBe('tool')
    expect(result.retrofit?.id).toBe('R-PAINT-FAST')
    expect(result.leadTimeWeeks).toBe(6)
    expect(result.capexUsd).toBe(200_000)
    expect(result.allowed).toBe(true)
  })

  it('blocks a drop no retrofit on the class can rescue', () => {
    const result = classifyDrop({ sourceId: 'WC-1', targetId: 'WC-3', catalog })
    expect(result.basis).toBe('impossible')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe('critical')
    expect(result.detail.length).toBeGreaterThan(10)
  })

  it('always ships an icon and a label beside the status', () => {
    for (const targetId of ['WC-1', 'WC-2', 'WC-3']) {
      const result = classifyDrop({ sourceId: 'WC-1', targetId, catalog })
      expect(result.icon).toBeTruthy()
      expect(result.label).toBeTruthy()
      expect(result.detail).toBeTruthy()
    }
  })
})

describe('findClosingRetrofit', () => {
  it('returns null when the class sells nothing that helps', () => {
    const catalog = buildCapabilityCatalog(WORK_CENTERS, CLASSES, OPS)
    expect(findClosingRetrofit(catalog, 'WC-1', 'WC-3')).toBeNull()
  })
})

describe('previewImpact', () => {
  const source: WorkCenterAggregate = {
    workCenterId: 'S',
    requiredHours: 1000,
    availableHours: 800,
    permittedHours: 800,
    ceiling: 1,
    utilisation: 1.25,
    peakUtilisation: 1.4,
    overloadHours: 200,
    downtimeHours: 0,
    bindingPool: 'machine',
    oee: 0.9,
    weeksOverCeiling: 4,
  }
  const target: WorkCenterAggregate = { ...source, workCenterId: 'T', requiredHours: 200, utilisation: 0.25, oee: 0.6, overloadHours: 0 }

  it('converts moved hours through the OEE ratio, as the relief search does', () => {
    const preview = previewImpact(source, target, 300, 1)
    expect(preview.movedHours).toBe(300)
    expect(preview.landedHours).toBeCloseTo(300 * (0.9 / 0.6), 9)
    expect(preview.sourceUtilisation).toBeCloseTo(700 / 800, 9)
    expect(preview.targetUtilisation).toBeCloseTo((200 + 450) / 800, 9)
  })

  it('scales by share and never moves a negative number of hours', () => {
    expect(previewImpact(source, target, 300, 0.5).movedHours).toBe(150)
    expect(previewImpact(source, target, -50, 1).movedHours).toBe(0)
  })

  it('degrades to the current values when an aggregate is missing', () => {
    const preview = previewImpact(undefined, target, 300, 1)
    expect(preview.sourceUtilisation).toBe(0)
    expect(preview.targetUtilisation).toBe(0.25)
  })
})

describe('layoutStageColumns', () => {
  const labels = new Map([
    [10, 'Mould'],
    [20, 'Paint'],
    [30, 'Pack'],
  ])

  function inputs(counts: Record<number, number>): StageNodeInput[] {
    const out: StageNodeInput[] = []
    for (const [stage, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i += 1) {
        const classId = i % 2 === 0 ? 'C-A' : 'C-B'
        out.push({
          id: `WC-${stage}-${i}`,
          code: `WC-${stage}-${String(i).padStart(2, '0')}`,
          classId,
          className: classId === 'C-A' ? 'Class A' : 'Class B',
          stage: Number(stage),
        })
      }
    }
    return out
  }

  it('orders columns by stage so the process reads left to right', () => {
    const layout = layoutStageColumns(inputs({ 30: 3, 10: 4, 20: 2 }), labels)
    expect(layout.columns.map((column) => column.stage)).toEqual([10, 20, 30])
    expect(layout.columns.map((column) => column.label)).toEqual(['Mould', 'Paint', 'Pack'])
    for (let i = 1; i < layout.columns.length; i += 1) {
      const previous = at(layout.columns, i - 1, 'column')
      const current = at(layout.columns, i, 'column')
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width)
    }
  })

  it('groups by machine class inside a column, sorted and non-overlapping', () => {
    const layout = layoutStageColumns(inputs({ 10: 7 }), labels)
    const column = at(layout.columns, 0, 'column')
    expect(column.groups.map((group) => group.classId)).toEqual(['C-A', 'C-B'])
    for (let i = 1; i < column.groups.length; i += 1) {
      const previous = at(column.groups, i - 1, 'group')
      const current = at(column.groups, i, 'group')
      expect(current.y).toBeGreaterThanOrEqual(previous.y + previous.height)
    }
  })

  it('never places two nodes closer than their diameter', () => {
    const layout = layoutStageColumns(inputs({ 10: 12, 20: 9, 30: 15 }), labels)
    expect(layout.nodes).toHaveLength(36)
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const a = at(layout.nodes, i, 'node')
        const b = at(layout.nodes, j, 'node')
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r)
      }
    }
  })

  it('keeps every node inside its own class group box', () => {
    const layout = layoutStageColumns(inputs({ 10: 11 }), labels)
    for (const column of layout.columns) {
      for (const group of column.groups) {
        for (const node of group.nodes) {
          expect(node.x - node.r).toBeGreaterThanOrEqual(group.x - 0.001)
          expect(node.x + node.r).toBeLessThanOrEqual(group.x + group.width + 0.001)
          expect(node.y - node.r).toBeGreaterThanOrEqual(group.y - 0.001)
          expect(node.y + node.r).toBeLessThanOrEqual(group.y + group.height + 0.001)
        }
      }
    }
  })

  it('indexes every node by id and reports the overall extent', () => {
    const layout = layoutStageColumns(inputs({ 10: 5, 20: 5 }), labels)
    expect(layout.byId.size).toBe(10)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
    for (const node of layout.nodes) expect(layout.byId.get(node.id)).toBe(node)
  })

  it('is deterministic and independent of input order', () => {
    const a = layoutStageColumns(inputs({ 10: 6, 20: 6 }), labels)
    const b = layoutStageColumns([...inputs({ 10: 6, 20: 6 })].reverse(), labels)
    expect(a.nodes.map((node) => `${node.id}@${node.x},${node.y}`).sort()).toEqual(
      b.nodes.map((node) => `${node.id}@${node.x},${node.y}`).sort(),
    )
  })

  it('handles an empty plant without producing NaN geometry', () => {
    const layout = layoutStageColumns([], labels)
    expect(layout.columns).toHaveLength(0)
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
  })
})

describe('layoutSatellites', () => {
  const bounds = { x: 0, y: 0, width: 600, height: 400 }

  it('rings the grid, first satellite above it, deterministically', () => {
    const satellites = layoutSatellites(
      [
        { plantId: 'P2', label: 'Wroclaw', siblings: [] },
        { plantId: 'P3', label: 'Suzhou', siblings: [] },
      ],
      { bounds, orbit: 100 },
    )
    expect(satellites).toHaveLength(2)
    const first = at(satellites, 0, 'satellite')
    expect(first.x).toBeCloseTo(300, 6)
    expect(first.y).toBeLessThan(bounds.y)
    expect(layoutSatellites([{ plantId: 'P2', label: 'x', siblings: [] }], { bounds })).toEqual(
      layoutSatellites([{ plantId: 'P2', label: 'x', siblings: [] }], { bounds }),
    )
  })

  it('keeps the heaviest siblings and reports the overflow honestly', () => {
    const siblings = Array.from({ length: 14 }, (_, i) => ({
      workCenterId: `WC-${i}`,
      code: `WC-${i}`,
      weight: i,
    }))
    const satellites = layoutSatellites([{ plantId: 'P2', label: 'x', siblings }], {
      bounds,
      maxSlots: 5,
    })
    const satellite = at(satellites, 0, 'satellite')
    expect(satellite.slots).toHaveLength(5)
    expect(satellite.slots.map((slot) => slot.workCenterId)).toEqual([
      'WC-13',
      'WC-12',
      'WC-11',
      'WC-10',
      'WC-9',
    ])
    expect(satellite.overflow).toBe(9)
  })

  it('lays slots in a collision-free row beyond the hub', () => {
    const siblings = Array.from({ length: 8 }, (_, i) => ({
      workCenterId: `WC-${i}`,
      code: `WC-${i}`,
      weight: 8 - i,
    }))
    const satellites = layoutSatellites(
      [
        { plantId: 'P2', label: 'a', siblings },
        { plantId: 'P3', label: 'b', siblings },
        { plantId: 'P4', label: 'c', siblings },
        { plantId: 'P5', label: 'd', siblings },
      ],
      { bounds, orbit: 160 },
    )
    const cx = bounds.x + bounds.width / 2
    const cy = bounds.y + bounds.height / 2
    for (const satellite of satellites) {
      for (let i = 0; i < satellite.slots.length; i += 1) {
        const a = at(satellite.slots, i, 'slot')
        // Every slot sits further from the grid centre than the hub plate does.
        expect(Math.hypot(a.x - cx, a.y - cy)).toBeGreaterThan(Math.hypot(satellite.x - cx, satellite.y - cy))
        for (let j = i + 1; j < satellite.slots.length; j += 1) {
          const b = at(satellite.slots, j, 'slot')
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r)
        }
      }
    }
  })

  it('flattens the orbit vertically so a wide grid does not strand two satellites', () => {
    const tall = layoutSatellites([{ plantId: 'P2', label: 'a', siblings: [] }], {
      bounds,
      orbit: 200,
      orbitY: 200,
    })
    const flat = layoutSatellites([{ plantId: 'P2', label: 'a', siblings: [] }], { bounds, orbit: 200 })
    expect(at(flat, 0, 'satellite').y).toBeGreaterThan(at(tall, 0, 'satellite').y)
  })
})

describe('edge bundling', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 300, y: 0 }
  const hub = { x: 150, y: 200 }

  it('collapses to a straight line at zero strength', () => {
    const { c1, c2 } = bundleControls(from, to, hub, 0)
    expect(c1).toEqual({ x: 100, y: 0 })
    expect(c2).toEqual({ x: 200, y: 0 })
  })

  it('pulls both controls onto the hub at full strength', () => {
    const { c1, c2 } = bundleControls(from, to, hub, 1)
    expect(c1).toEqual(hub)
    expect(c2).toEqual(hub)
  })

  it('emits a cubic through the controls', () => {
    expect(edgePath(from, to, hub, 0)).toBe('M0,0C100,0 200,0 300,0')
  })
})

describe('cullEdges', () => {
  const viewport = { x: 0, y: 0, width: 100, height: 100 }

  function edge(id: string, x: number, weight: number): EdgeInput {
    return {
      id,
      fromId: `f${id}`,
      toId: `t${id}`,
      from: { x, y: 50 },
      to: { x: x + 10, y: 60 },
      hub: { x: 50, y: 50 },
      basis: 'approved',
      weight,
    }
  }

  it('never draws more than the cap and says how many it dropped', () => {
    const inputs = Array.from({ length: 500 }, (_, i) => edge(String(i), 10, i))
    const result = cullEdges(inputs, viewport, 200)
    expect(result.edges).toHaveLength(200)
    expect(result.hidden).toBe(300)
  })

  it('keeps the heaviest edges when it has to choose', () => {
    const inputs = [edge('light', 10, 1), edge('heavy', 10, 99)]
    const result = cullEdges(inputs, viewport, 1)
    expect(at(result.edges, 0, 'edge').id).toBe('heavy')
  })

  it('prefers on-screen edges over heavier off-screen ones', () => {
    const result = cullEdges([edge('off', 9000, 99), edge('on', 10, 1)], viewport, 1)
    expect(at(result.edges, 0, 'edge').id).toBe('on')
  })

  it('fades an edge with both endpoints outside the viewport', () => {
    const result = cullEdges([edge('off', 9000, 1), edge('on', 10, 1)], viewport, 10)
    const byId = new Map(result.edges.map((item) => [item.id, item.visibility]))
    expect(byId.get('on')).toBe('full')
    expect(byId.get('off')).toBe('faded')
  })

  it('gives every kept edge a drawable path', () => {
    const result = cullEdges([edge('a', 10, 1)], viewport, 10)
    expect(at(result.edges, 0, 'edge').path.startsWith('M0')).toBe(false)
    expect(at(result.edges, 0, 'edge').path).toContain('C')
  })
})

describe('layoutStrip', () => {
  const weeks = [
    { week: 0, requiredHours: 50, availableHours: 100, ceiling: 1 },
    { week: 1, requiredHours: 120, availableHours: 100, ceiling: 1 },
    { week: 2, requiredHours: 0, availableHours: 0, ceiling: 1 },
  ]

  it('sits bars on the baseline and scales to the tallest of load or ceiling', () => {
    const strip = layoutStrip(weeks, 300, 100)
    expect(strip.maxHours).toBe(120)
    expect(strip.baselineY).toBe(100)
    const first = at(strip.bars, 0, 'bar')
    expect(first.y + first.height).toBeCloseTo(100, 9)
    expect(first.height).toBeCloseTo((50 / 120) * 100, 9)
  })

  it('moves the ceiling rule week by week, because downtime moves it', () => {
    const strip = layoutStrip(
      [
        { week: 0, requiredHours: 50, availableHours: 100, ceiling: 1 },
        { week: 1, requiredHours: 50, availableHours: 0, ceiling: 1 },
      ],
      200,
      100,
    )
    expect(at(strip.bars, 0, 'bar').ceilingY).toBeLessThan(at(strip.bars, 1, 'bar').ceilingY)
    expect(at(strip.bars, 1, 'bar').utilisation).toBe(0)
  })

  it('caps bar thickness at the house maximum', () => {
    const strip = layoutStrip(weeks, 3000, 100)
    for (const bar of strip.bars) expect(bar.width).toBeLessThanOrEqual(24)
  })

  it('survives an empty horizon', () => {
    const strip = layoutStrip([], 300, 100)
    expect(strip.bars).toHaveLength(0)
    expect(strip.maxHours).toBe(1)
  })
})

describe('layoutGhostFan', () => {
  it('fans candidates around the origin at a constant radius', () => {
    const slots = layoutGhostFan(5, { x: 0, y: 0 }, 200, 30)
    expect(slots).toHaveLength(5)
    for (const slot of slots) expect(Math.hypot(slot.x, slot.y)).toBeCloseTo(200, 6)
    expect(at(slots, 2, 'slot').y).toBeCloseTo(0, 6)
  })

  it('puts a lone candidate straight ahead', () => {
    const slots = layoutGhostFan(1, { x: 10, y: 10 }, 100, 20)
    expect(at(slots, 0, 'slot')).toMatchObject({ x: 110, y: 10 })
  })

  it('points the fan wherever the caller asks', () => {
    const slots = layoutGhostFan(3, { x: 0, y: 0 }, 100, 20, Math.PI * 0.5, Math.PI / 2)
    const middle = at(slots, 1, 'slot')
    expect(middle.x).toBeCloseTo(0, 6)
    expect(middle.y).toBeCloseTo(100, 6)
    for (const slot of slots) expect(slot.y).toBeGreaterThan(0)
  })

  it('returns nothing for nothing', () => {
    expect(layoutGhostFan(0, { x: 0, y: 0 })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Globe placement
// ---------------------------------------------------------------------------

/**
 * The real network. DE-ING and PL-WRO are ~500km apart, which at world scale is
 * less than one bubble — this is the fixture the whole pass exists for.
 */
const PLANT_COORDS: ReadonlyArray<{ id: string; lat: number; lon: number; r: number }> = [
  { id: 'US-TOL', lat: 41.65, lon: -83.54, r: 30 },
  { id: 'MX-SLP', lat: 22.16, lon: -100.98, r: 28 },
  { id: 'DE-ING', lat: 48.76, lon: 11.42, r: 26 },
  { id: 'PL-WRO', lat: 51.11, lon: 17.04, r: 31 },
  { id: 'CN-SUZ', lat: 31.3, lon: 120.58, r: 35 },
]

function realSites(): GlobeSite[] {
  return PLANT_COORDS.map((plant) => ({
    id: plant.id,
    anchor: project(plant.lat, plant.lon),
    r: plant.r,
    label: plant.id,
  }))
}

function markById(marks: readonly GlobeMark[], id: string): GlobeMark {
  const found = marks.find((mark) => mark.id === id)
  if (found === undefined) throw new Error(`no mark for ${id}`)
  return found
}

/** Every pair that still overlaps by more than a hairline. */
function overlappingPairs(marks: readonly GlobeMark[], tolerance = 0.5): string[] {
  const bad: string[] = []
  for (let i = 0; i < marks.length; i += 1) {
    for (let j = i + 1; j < marks.length; j += 1) {
      const a = at(marks, i, 'mark')
      const b = at(marks, j, 'mark')
      const distance = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y)
      if (distance < a.r + b.r - tolerance) bad.push(`${a.id}/${b.id}`)
    }
  }
  return bad
}

function labelRect(mark: GlobeMark): { x: number; y: number; width: number; height: number } {
  return {
    x: mark.label.x - mark.label.width / 2,
    y: mark.label.y - mark.label.height / 2,
    width: mark.label.width,
    height: mark.label.height,
  }
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('layoutGlobe — separation', () => {
  it('separates two sites closer together than their own radii', () => {
    const sites: GlobeSite[] = [
      { id: 'A', anchor: { x: 500, y: 300 }, r: 30, label: 'A' },
      { id: 'B', anchor: { x: 512, y: 306 }, r: 30, label: 'B' },
    ]
    const marks = layoutGlobe(sites, { padding: 6 })
    expect(marks).toHaveLength(2)
    const a = markById(marks, 'A')
    const b = markById(marks, 'B')
    const distance = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y)
    expect(distance).toBeGreaterThanOrEqual(a.r + b.r + 6 - 1e-6)
    // Both moved, both by the same amount, both away from the other.
    expect(a.displaced).toBe(true)
    expect(b.displaced).toBe(true)
    expect(a.displacement).toBeCloseTo(b.displacement, 6)
    // The true point is kept, untouched, for the leader line.
    expect(a.anchor).toEqual({ x: 500, y: 300 })
    expect(b.anchor).toEqual({ x: 512, y: 306 })
  })

  it('leaves sites that already clear each other exactly where they are', () => {
    const sites: GlobeSite[] = [
      { id: 'A', anchor: { x: 100, y: 100 }, r: 20, label: 'A' },
      { id: 'B', anchor: { x: 400, y: 100 }, r: 20, label: 'B' },
    ]
    const marks = layoutGlobe(sites)
    for (const mark of marks) {
      expect(mark.position).toEqual(mark.anchor)
      expect(mark.displacement).toBeCloseTo(0, 9)
      expect(mark.displaced).toBe(false)
    }
  })

  it('produces no overlapping pair for the five real plants', () => {
    const marks = layoutGlobe(realSites())
    expect(marks).toHaveLength(5)
    expect(overlappingPairs(marks)).toEqual([])
    // Both of the crowded European sites survive as their own mark.
    expect(markById(marks, 'DE-ING').members).toEqual(['DE-ING'])
    expect(markById(marks, 'PL-WRO').members).toEqual(['PL-WRO'])
    // ...and both admit they were moved, so the layer draws a leader line.
    expect(markById(marks, 'DE-ING').displaced).toBe(true)
    expect(markById(marks, 'PL-WRO').displaced).toBe(true)
    // The three that never collided are drawn on their true positions.
    for (const id of ['US-TOL', 'MX-SLP', 'CN-SUZ']) {
      expect(markById(marks, id).displaced).toBe(false)
    }
  })

  it('never draws a mark further from its anchor than the budget allows', () => {
    const marks = layoutGlobe(realSites(), { maxDisplacement: 96 })
    for (const mark of marks) expect(mark.displacement).toBeLessThanOrEqual(96 + 1e-6)
  })

  it('is stable: the same input gives the same output', () => {
    const first = layoutGlobe(realSites())
    const second = layoutGlobe(realSites())
    expect(second).toEqual(first)
    // And a third time, from the same array instance, to prove nothing is
    // mutated in place between calls.
    const sites = realSites()
    expect(layoutGlobe(sites)).toEqual(layoutGlobe(sites))
    expect(sites.map((site) => site.anchor)).toEqual(realSites().map((site) => site.anchor))
  })

  it('does not depend on the order the sites arrive in', () => {
    const forward = layoutGlobe(realSites())
    const reversed = layoutGlobe([...realSites()].reverse())
    for (const mark of forward) {
      const twin = markById(reversed, mark.id)
      expect(twin.position.x).toBeCloseTo(mark.position.x, 9)
      expect(twin.position.y).toBeCloseTo(mark.position.y, 9)
    }
  })

  it('fans a pile-up on one identical point apart deterministically', () => {
    const sites: GlobeSite[] = ['A', 'B', 'C'].map((id) => ({
      id,
      anchor: { x: 200, y: 200 },
      r: 18,
      label: id,
    }))
    const marks = layoutGlobe(sites, { maxDisplacement: 400 })
    expect(overlappingPairs(marks)).toEqual([])
    expect(layoutGlobe(sites, { maxDisplacement: 400 })).toEqual(marks)
  })

  it('ignores sites whose geometry is not a number', () => {
    const marks = layoutGlobe([
      { id: 'A', anchor: { x: 10, y: 10 }, r: 5, label: 'A' },
      { id: 'B', anchor: { x: Number.NaN, y: 10 }, r: 5, label: 'B' },
    ])
    expect(marks.map((mark) => mark.id)).toEqual(['A'])
  })

  it('returns nothing for nothing', () => {
    expect(layoutGlobe([])).toEqual([])
  })
})

describe('clusterGlobeSites', () => {
  it('leaves the real network as five separate marks', () => {
    expect(clusterGlobeSites(realSites())).toEqual([
      ['US-TOL'],
      ['MX-SLP'],
      ['DE-ING'],
      ['PL-WRO'],
      ['CN-SUZ'],
    ])
  })

  it('folds a pair that cannot be separated inside the budget', () => {
    const sites: GlobeSite[] = [
      { id: 'A', anchor: { x: 300, y: 300 }, r: 60, label: 'A' },
      { id: 'B', anchor: { x: 302, y: 300 }, r: 60, label: 'B' },
    ]
    expect(clusterGlobeSites(sites, { maxDisplacement: 10 })).toEqual([['A', 'B']])

    const marks = layoutGlobe(sites, { maxDisplacement: 10 })
    expect(marks).toHaveLength(1)
    const cluster = at(marks, 0, 'cluster')
    expect(cluster.members).toEqual(['A', 'B'])
    expect(cluster.anchor.x).toBeCloseTo(301, 6)
    // Area-additive: one marker carrying the ink of the two it stands for.
    expect(cluster.r).toBeCloseTo(Math.hypot(60, 60), 6)
  })

  it('comes apart again once the marks are small enough — i.e. zoomed in', () => {
    // The canvas sizes globe marks in screen pixels, so a world-unit radius is
    // `px / scale`: zooming in shrinks every radius and the same pair resolves.
    const near = (r: number): GlobeSite[] => [
      { id: 'A', anchor: { x: 300, y: 300 }, r, label: 'A' },
      { id: 'B', anchor: { x: 318, y: 300 }, r, label: 'B' },
    ]
    expect(clusterGlobeSites(near(40), { maxDisplacement: 12 })).toEqual([['A', 'B']])
    expect(clusterGlobeSites(near(10), { maxDisplacement: 12 })).toEqual([['A'], ['B']])
  })

  it('links a chain transitively', () => {
    const sites: GlobeSite[] = [
      { id: 'A', anchor: { x: 0, y: 0 }, r: 40, label: 'A' },
      { id: 'B', anchor: { x: 10, y: 0 }, r: 40, label: 'B' },
      { id: 'C', anchor: { x: 20, y: 0 }, r: 40, label: 'C' },
    ]
    expect(clusterGlobeSites(sites, { maxDisplacement: 5 })).toEqual([['A', 'B', 'C']])
  })
})

describe('placeGlobeLabels', () => {
  it('prefers below when nothing is in the way', () => {
    const placement = placeGlobeLabels(
      [{ id: 'A', position: { x: 100, y: 100 }, r: 20, label: 'US-TOL' }],
      { labelHeight: 19, labelGap: 7 },
    )
    const label = placement.get('A')
    expect(label?.side).toBe('below')
    expect(label?.x).toBeCloseTo(100, 6)
    expect(label?.y).toBeCloseTo(100 + 20 + 7 + 9.5, 6)
    expect(label?.deflected).toBe(false)
  })

  it('steps to another side rather than printing over a taken slot', () => {
    // Two marks stacked vertically: the lower one's "below" is free, the upper
    // one's "below" would land on top of the lower bubble.
    const placement = placeGlobeLabels([
      { id: 'A', position: { x: 100, y: 100 }, r: 20, label: 'AAAA' },
      { id: 'B', position: { x: 100, y: 150 }, r: 20, label: 'BBBB' },
    ])
    expect(placement.get('A')?.side).not.toBe('below')
    expect(placement.size).toBe(2)
  })

  it('never lets two plates overlap on the real network', () => {
    const marks = layoutGlobe(realSites())
    for (let i = 0; i < marks.length; i += 1) {
      for (let j = i + 1; j < marks.length; j += 1) {
        const a = at(marks, i, 'mark')
        const b = at(marks, j, 'mark')
        expect(boxesOverlap(labelRect(a), labelRect(b))).toBe(false)
      }
    }
    for (const mark of marks) expect(mark.label.deflected).toBe(false)
  })

  it('keeps a plate off every other bubble on the real network', () => {
    const marks = layoutGlobe(realSites())
    for (const mark of marks) {
      const rect = labelRect(mark)
      for (const other of marks) {
        if (other.id === mark.id) continue
        const nearestX = Math.min(Math.max(other.position.x, rect.x), rect.x + rect.width)
        const nearestY = Math.min(Math.max(other.position.y, rect.y), rect.y + rect.height)
        expect(Math.hypot(other.position.x - nearestX, other.position.y - nearestY)).toBeGreaterThanOrEqual(
          other.r,
        )
      }
    }
  })

  it('is deterministic regardless of the order it is handed', () => {
    const targets = [
      { id: 'A', position: { x: 100, y: 100 }, r: 20, label: 'AAAA' },
      { id: 'B', position: { x: 100, y: 150 }, r: 20, label: 'BBBB' },
      { id: 'C', position: { x: 160, y: 120 }, r: 20, label: 'CCCC' },
    ]
    const forward = placeGlobeLabels(targets)
    const reversed = placeGlobeLabels([...targets].reverse())
    for (const target of targets) {
      expect(reversed.get(target.id)).toEqual(forward.get(target.id))
    }
  })
})
