/**
 * The zoomable network canvas — globe -> plant -> work center.
 *
 * One continuous canvas that changes what it draws, not three screens. The
 * transform is shared across all three levels and animated between them under
 * 200ms, so a planner who drills into Wroclaw and comes back out lands where
 * they left rather than being teleported.
 *
 * What lives here: the data joins (catalog x model run x filter window), the
 * memoised layouts, hit testing, keyboard navigation, and the chrome. What does
 * NOT live here: any geometry (that is `layout.ts` and `projection.ts`, both
 * pure and tested) and any per-frame work (the transform never enters a
 * pointermove path, and layout is never recomputed inside one).
 *
 * Accessibility is not an afterthought on this screen. Every gesture has a key:
 * Tab walks the nodes, Enter drills in, Backspace goes up, arrows pan, +/- zoom,
 * and `M` starts a move that arrows steer and Enter commits. Every chart-like
 * mark has a table twin below the canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PlantId,
  Region,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import type { SeriesSlot } from '@/charts/types'
import { at, clamp } from '@/domain/lookup'
import { hours as fmtHours, pct } from '@/lib/format'
import { DivergingLegend } from '@/charts/Legend'
import { TableView } from '@/charts/TableView'
import { seriesColor } from '@/charts/palette'
import { useActiveScenario, useUiStore } from '@/state/store'
import { useModelResult, usePlantSlot, useRelief, useWorkCenterDetail } from '@/state/model'
import type {
  ArcInput,
  EdgeInput,
  GlobeMark,
  GlobeSite,
  PlacedNode,
  SatelliteInput,
  StageNodeInput,
} from '@/canvas/layout'
import {
  aggregatePlants,
  aggregateWorkCenters,
  bubbleRadius,
  buildCapabilityCatalog,
  cullEdges,
  layoutArcs,
  layoutGlobe,
  layoutSatellites,
  layoutStageColumns,
} from '@/canvas/layout'
import { WORLD, project } from '@/canvas/projection'
import type { Point } from '@/canvas/projection'
import { useCanvasTransform } from '@/canvas/useCanvasTransform'
import { useDragMove } from '@/canvas/useDragMove'
import type { DragPayload } from '@/canvas/useDragMove'
import { GlobeLayer } from '@/canvas/GlobeLayer'
import type { GlobeClusterMember, GlobeClusterNode, GlobePlantNode } from '@/canvas/GlobeLayer'
import { PlantLayer } from '@/canvas/PlantLayer'
import type { WorkCenterNodeView } from '@/canvas/PlantLayer'
import { WORK_CENTER_WORLD, WorkCenterLayer, workCenterGhostTargets } from '@/canvas/WorkCenterLayer'
import type { GroupChip } from '@/canvas/WorkCenterLayer'
import {
  CapabilityEdgeLegend,
  CapabilityEdgesCanvas,
  CapabilityEdgesSvg,
  EDGE_CANVAS_THRESHOLD,
} from '@/canvas/CapabilityEdges'
import { DragLayer } from '@/canvas/DragLayer'
import styles from '@/canvas/NetworkCanvas.module.css'

const SATELLITE_ORBIT = 180
const MAX_SLOTS_PER_SATELLITE = 8
const MAX_EDGES_PER_SLOT = 4
const MAX_EDGES = 200

/** Room around the plants' bounding box, world units. Covers bubble + label. */
const GLOBE_FRAME_MARGIN = 104
const GLOBE_FRAME_MIN_WIDTH = 520
const GLOBE_FRAME_MIN_HEIGHT = 300
/** Hairline of daylight between two bubbles, screen px. */
const BUBBLE_GAP_PX = 6
/** How far a bubble may be drawn from its true site before it clusters, px. */
const MAX_DISPLACEMENT_PX = 84
/**
 * The globe carries five marks in a band of latitude; a full-height stage
 * around it is mostly ocean. The deeper levels use every pixel they are given.
 */
const GLOBE_STAGE_RATIO = 0.62
const GLOBE_STAGE_MIN = 340
const GLOBE_STAGE_MAX = 470
/**
 * Fit padding. The globe's frame already carries a margin wide enough for the
 * bubbles and their labels, so a second generous inset on top of it would put
 * the composition back where it started: five marks adrift in ocean.
 */
const GLOBE_FIT_PADDING = 28
const FIT_PADDING = 56
/** Pointer travel past which a press was a drag and its click is not a click. */
const CLICK_SLOP_PX = 5
/** How long a press stays attached to the click that follows it. */
const PRESS_MEMORY_MS = 1500
/**
 * A single click drills, and the browser still delivers the dblclick behind a
 * double-click. Without a short window of memory a double-click would travel
 * two levels at once.
 */
const DRILL_GUARD_MS = 450

export interface NetworkCanvasProps {
  className?: string
  /** Stage height in px. The chrome and table sit outside it. */
  height?: number
}

export function NetworkCanvas({ className, height = 620 }: NetworkCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const status = useUiStore((state) => state.status)
  const error = useUiStore((state) => state.error)
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const selection = useUiStore((state) => state.selection)
  const zoom = useUiStore((state) => state.zoom)
  const theme = useUiStore((state) => state.theme)
  const runtimeMs = useUiStore((state) => state.runtimeMs)
  const setSelection = useUiStore((state) => state.setSelection)
  const setZoom = useUiStore((state) => state.setZoom)
  const scenario = useActiveScenario()

  const model = useModelResult()
  const plantSlot = usePlantSlot()
  const plantSlotRef = useRef(plantSlot)
  plantSlotRef.current = plantSlot
  const slotOfPlant = useCallback((id: PlantId): SeriesSlot => plantSlotRef.current(id), [])

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [tableOpen, setTableOpen] = useState(false)

  // -------------------------------------------------------------------------
  // Catalog joins
  // -------------------------------------------------------------------------

  const capabilityCatalog = useMemo(
    () =>
      catalog === null
        ? null
        : buildCapabilityCatalog(catalog.workCenters, catalog.machineClasses, catalog.standardOperations),
    [catalog],
  )

  const workCenterById = useMemo(() => {
    const map = new Map<WorkCenterId, WorkCenter>()
    for (const wc of catalog?.workCenters ?? []) map.set(wc.id, wc)
    return map
  }, [catalog])

  const plantById = useMemo(() => {
    const map = new Map<PlantId, { code: string; name: string; region: Region }>()
    for (const plant of catalog?.plants ?? []) {
      map.set(plant.id, { code: plant.code, name: plant.name, region: plant.region })
    }
    return map
  }, [catalog])

  const classNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const machineClass of catalog?.machineClasses ?? []) map.set(machineClass.id, machineClass.name)
    return map
  }, [catalog])

  const codeOf = useCallback(
    (id: WorkCenterId): string => workCenterById.get(id)?.code ?? id,
    [workCenterById],
  )
  const plantCodeOf = useCallback((id: PlantId): string => plantById.get(id)?.code ?? id, [plantById])
  const weekLabel = useCallback(
    (week: WeekIndex): string => catalog?.time.weeks[week] ?? `W${week}`,
    [catalog],
  )
  const weekCount = catalog?.time.weeks.length ?? 0

  // -------------------------------------------------------------------------
  // Model joins
  // -------------------------------------------------------------------------

  const aggregates = useMemo(
    () => aggregateWorkCenters(model.data, filters.fromWeek, filters.toWeek),
    [model.data, filters.fromWeek, filters.toWeek],
  )

  const plantAggregates = useMemo(
    () => aggregatePlants(aggregates, catalog?.workCenters ?? []),
    [aggregates, catalog],
  )

  /** Filters are inclusive by omission: an empty array always means "all". */
  const visibleWorkCenters = useMemo(() => {
    const plantSet = new Set(filters.plantIds)
    const regionSet = new Set<Region>(filters.regions)
    const classSet = new Set(filters.machineClassIds)
    const wcSet = new Set(filters.workCenterIds)
    return (catalog?.workCenters ?? []).filter((wc) => {
      if (plantSet.size > 0 && !plantSet.has(wc.plantId)) return false
      if (regionSet.size > 0) {
        const region = plantById.get(wc.plantId)?.region
        if (region === undefined || !regionSet.has(region)) return false
      }
      if (classSet.size > 0 && !classSet.has(wc.classId)) return false
      if (wcSet.size > 0 && !wcSet.has(wc.id)) return false
      return true
    })
  }, [catalog, filters.machineClassIds, filters.plantIds, filters.regions, filters.workCenterIds, plantById])

  const visiblePlantIds = useMemo(() => {
    const ids = new Set<PlantId>()
    for (const wc of visibleWorkCenters) ids.add(wc.plantId)
    return ids
  }, [visibleWorkCenters])

  // -------------------------------------------------------------------------
  // Globe
  // -------------------------------------------------------------------------

  /**
   * The plants as geography plus a size, before anything has been moved.
   *
   * Radii are in SCREEN pixels here. The canvas draws everything through one
   * transform, so a world-unit radius would grow with the zoom and two bubbles
   * that overlap at world scale would overlap identically at every scale — the
   * cluster could never come apart. Sizing the marks in pixels and dividing by
   * the live scale is what makes zooming in resolve a crowd, which is how every
   * map the reader has ever used behaves.
   */
  const globeSites = useMemo(() => {
    const plants = (catalog?.plants ?? []).filter((plant) => visiblePlantIds.size === 0 || visiblePlantIds.has(plant.id))
    let maxAvailable = 0
    for (const plant of plants) {
      maxAvailable = Math.max(maxAvailable, plantAggregates.get(plant.id)?.availableHours ?? 0)
    }
    return plants.map((plant) => ({
      plant,
      slot: plant.colorSlot,
      anchor: project(plant.lat, plant.lon),
      radiusPx: bubbleRadius(plantAggregates.get(plant.id)?.availableHours ?? 0, maxAvailable, 17, 46),
      aggregate: plantAggregates.get(plant.id),
    }))
  }, [catalog, plantAggregates, visiblePlantIds])

  /**
   * The frame the globe is fitted to: the plants' own bounding box with room
   * for their bubbles and labels, clamped to the drawn world.
   *
   * Drawing the whole equirectangular world to hold five northern-hemisphere
   * sites spends two thirds of the screen on ocean nobody is looking at. This
   * is deliberately computed from the ANCHORS and a constant margin, never from
   * the placed marks — the placement depends on the scale, the scale depends on
   * this rectangle, and closing that loop would make the view oscillate.
   */
  const globeFrame = useMemo(() => {
    if (globeSites.length === 0) return { x: 0, y: 0, width: WORLD.width, height: WORLD.height }
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const site of globeSites) {
      minX = Math.min(minX, site.anchor.x)
      minY = Math.min(minY, site.anchor.y)
      maxX = Math.max(maxX, site.anchor.x)
      maxY = Math.max(maxY, site.anchor.y)
    }
    const left = clamp(minX - GLOBE_FRAME_MARGIN, 0, WORLD.width)
    const top = clamp(minY - GLOBE_FRAME_MARGIN, 0, WORLD.height)
    const right = clamp(maxX + GLOBE_FRAME_MARGIN, 0, WORLD.width)
    const bottom = clamp(maxY + GLOBE_FRAME_MARGIN, 0, WORLD.height)
    // A single surviving plant would otherwise fit to a point and blow the map
    // up to street level, so the frame has a floor.
    const width = Math.max(right - left, GLOBE_FRAME_MIN_WIDTH)
    const height = Math.max(bottom - top, GLOBE_FRAME_MIN_HEIGHT)
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    return { x: cx - width / 2, y: cy - height / 2, width, height }
  }, [globeSites])

  // -------------------------------------------------------------------------
  // Plant level
  // -------------------------------------------------------------------------

  const activePlantId = selection.plantId ?? catalog?.plants[0]?.id ?? null

  const plantWorkCenters = useMemo(
    () => visibleWorkCenters.filter((wc) => wc.plantId === activePlantId),
    [activePlantId, visibleWorkCenters],
  )

  const plantLayout = useMemo(() => {
    if (capabilityCatalog === null) return layoutStageColumns([], new Map())
    const inputs: StageNodeInput[] = plantWorkCenters.map((wc) => ({
      id: wc.id,
      code: wc.code,
      classId: wc.classId,
      className: classNameById.get(wc.classId) ?? wc.classId,
      stage: capabilityCatalog.stageByWorkCenter.get(wc.id) ?? 0,
    }))
    return layoutStageColumns(inputs, capabilityCatalog.stageLabel)
  }, [capabilityCatalog, classNameById, plantWorkCenters])

  const plantNodeViews = useMemo((): WorkCenterNodeView[] => {
    return plantLayout.nodes.map((node) => {
      const aggregate = aggregates.get(node.id)
      return {
        node,
        aggregate,
        labourBound: aggregate?.bindingPool === 'labour',
        proposed: workCenterById.get(node.id)?.status === 'proposed',
      }
    })
  }, [aggregates, plantLayout.nodes, workCenterById])

  const satelliteBounds = useMemo(
    () => ({ x: 0, y: -56, width: Math.max(240, plantLayout.width), height: Math.max(200, plantLayout.height + 70) }),
    [plantLayout.height, plantLayout.width],
  )

  /**
   * The other plants, carrying only work centers that actually share a
   * capability with something in this plant — the whole point of the satellite
   * is to make "somewhere else could make this" visible, so a plant with no
   * overlap gets no satellite rather than an empty one.
   */
  const satellites = useMemo(() => {
    if (capabilityCatalog === null || activePlantId === null) return []
    const localOps = new Set<string>()
    for (const wc of plantWorkCenters) {
      for (const opId of capabilityCatalog.capableOpsByWorkCenter.get(wc.id) ?? []) localOps.add(opId)
    }
    const byPlant = new Map<PlantId, SatelliteInput>()
    for (const wc of visibleWorkCenters) {
      if (wc.plantId === activePlantId) continue
      let shared = 0
      for (const opId of capabilityCatalog.capableOpsByWorkCenter.get(wc.id) ?? []) {
        if (localOps.has(opId)) shared += 1
      }
      if (shared === 0) continue
      let entry = byPlant.get(wc.plantId)
      if (entry === undefined) {
        entry = { plantId: wc.plantId, label: plantCodeOf(wc.plantId), siblings: [] }
        byPlant.set(wc.plantId, entry)
      }
      entry.siblings.push({ workCenterId: wc.id, code: wc.code, weight: shared })
    }
    const inputs = Array.from(byPlant.values()).sort((a, b) => (a.plantId < b.plantId ? -1 : 1))
    return layoutSatellites(inputs, {
      bounds: satelliteBounds,
      orbit: SATELLITE_ORBIT,
      maxSlots: MAX_SLOTS_PER_SATELLITE,
    })
  }, [activePlantId, capabilityCatalog, plantCodeOf, plantWorkCenters, satelliteBounds, visibleWorkCenters])

  const satelliteSlotById = useMemo(() => {
    const map = new Map<WorkCenterId, { x: number; y: number; r: number; hub: Point }>()
    for (const satellite of satellites) {
      for (const slot of satellite.slots) {
        map.set(slot.workCenterId, { x: slot.x, y: slot.y, r: slot.r, hub: { x: satellite.x, y: satellite.y } })
      }
    }
    return map
  }, [satellites])

  /** Authoritative bases for the selected work center, straight from the worker. */
  const detail = useWorkCenterDetail(selection.workCenterId)
  const relief = useRelief(selection.workCenterId)

  const approvedBasis = useMemo(() => {
    const map = new Map<WorkCenterId, 'approved' | 'featureCapable' | 'retrofit'>()
    for (const sibling of detail.data?.siblings ?? []) map.set(sibling.workCenterId, sibling.basis)
    return map
  }, [detail.data])

  const edgeCull = useMemo(() => {
    if (capabilityCatalog === null) return { edges: [], hidden: 0, total: 0 }
    const inputs: EdgeInput[] = []
    for (const satellite of satellites) {
      for (const slot of satellite.slots) {
        const remoteOps = capabilityCatalog.capableOpsByWorkCenter.get(slot.workCenterId) ?? new Set<string>()
        const ranked: Array<{ node: PlacedNode; shared: number }> = []
        for (const node of plantLayout.nodes) {
          const localOps = capabilityCatalog.capableOpsByWorkCenter.get(node.id) ?? new Set<string>()
          let shared = 0
          for (const opId of localOps) if (remoteOps.has(opId)) shared += 1
          if (shared > 0) ranked.push({ node, shared })
        }
        ranked.sort((a, b) => b.shared - a.shared || (a.node.id < b.node.id ? -1 : 1))
        for (const { node, shared } of ranked.slice(0, MAX_EDGES_PER_SLOT)) {
          const basis = approvedBasis.get(slot.workCenterId) ?? 'featureCapable'
          inputs.push({
            id: `${node.id}>${slot.workCenterId}`,
            fromId: node.id,
            toId: slot.workCenterId,
            from: { x: node.x, y: node.y },
            to: { x: slot.x, y: slot.y },
            hub: { x: satellite.x, y: satellite.y },
            basis,
            weight: shared,
          })
        }
      }
    }
    // The cull's job here is the hard cap and the ranking, both of which have to
    // be stable across a pan. Off-screen FADING is decided per frame by the
    // canvas renderer, which already has the live transform in hand.
    const culled = cullEdges(inputs, { x: -1e7, y: -1e7, width: 2e7, height: 2e7 }, MAX_EDGES)
    return { edges: culled.edges, hidden: culled.hidden, total: inputs.length }
  }, [approvedBasis, capabilityCatalog, plantLayout.nodes, satellites])

  // -------------------------------------------------------------------------
  // Work-center level
  // -------------------------------------------------------------------------

  const activeWorkCenterId = selection.workCenterId ?? plantLayout.nodes[0]?.id ?? null
  const reliefCandidates = useMemo(() => (relief.data ?? []).slice(0, 7), [relief.data])
  const ghostTargets = useMemo(
    () => workCenterGhostTargets(reliefCandidates.map((candidate) => candidate.toWorkCenterId)),
    [reliefCandidates],
  )

  // -------------------------------------------------------------------------
  // Transform
  // -------------------------------------------------------------------------

  const worldRect = useMemo(() => {
    if (zoom === 'globe') return globeFrame
    if (zoom === 'plant') {
      const padX = SATELLITE_ORBIT + 110
      const padY = SATELLITE_ORBIT * 0.7 + 110
      return {
        x: satelliteBounds.x - padX,
        y: satelliteBounds.y - padY,
        width: satelliteBounds.width + padX * 2,
        height: satelliteBounds.height + padY * 2,
      }
    }
    return WORK_CENTER_WORLD
  }, [globeFrame, satelliteBounds, zoom])

  const drillOut = useCallback(() => {
    if (zoom === 'workCenter') setZoom('plant')
    else if (zoom === 'plant') setZoom('globe')
  }, [setZoom, zoom])

  const worldRef = useRef<SVGGElement | null>(null)
  // Double-click drills, and the handler it drills with is defined further down
  // this component. A ref keeps the transform hook out of that ordering problem
  // without making the whole canvas depend on declaration order.
  const drillInRef = useRef<(world: Point) => void>(() => {})
  const onDrillIn = useCallback((world: Point) => drillInRef.current(world), [])
  const transform = useCanvasTransform({
    containerRef,
    minScale: 0.12,
    maxScale: 14,
    onDrillIn,
    onDrillOut: drillOut,
  })

  // The transformed group is written imperatively so a pan costs no React work.
  const subscribe = transform.subscribe
  useEffect(
    () =>
      subscribe((next) => {
        const group = worldRef.current
        if (group) group.setAttribute('transform', `translate(${next.x},${next.y}) scale(${next.k})`)
      }),
    [subscribe],
  )

  const fitPadding = zoom === 'globe' ? GLOBE_FIT_PADDING : FIT_PADDING
  const fitTo = transform.fitTo
  useEffect(() => {
    fitTo(worldRect, fitPadding, true)
  }, [fitPadding, fitTo, worldRect, zoom, activePlantId, activeWorkCenterId])

  // -------------------------------------------------------------------------
  // Globe placement
  // -------------------------------------------------------------------------

  /**
   * Overlap resolution, leader lines and label slots — all of it pure, all of
   * it in `layout.ts`, none of it recomputed inside a pointer handler.
   *
   * The live scale converts every pixel threshold into the world units the
   * layout works in. `transform.transform` is the frame-coalesced mirror, so
   * this re-solves at most once per frame for five circles, which is nothing.
   */
  const globeScale = transform.transform.k > 0 ? transform.transform.k : 1
  const globePlacement = useMemo((): GlobeMark[] => {
    const toWorld = (px: number): number => px / globeScale
    const sites: GlobeSite[] = globeSites.map((site) => ({
      id: site.plant.id,
      anchor: site.anchor,
      r: toWorld(site.radiusPx),
      label: site.plant.code,
    }))
    return layoutGlobe(sites, {
      padding: toWorld(BUBBLE_GAP_PX),
      maxDisplacement: toWorld(MAX_DISPLACEMENT_PX),
      leaderThreshold: toWorld(2),
      labelHeight: toWorld(19),
      labelGap: toWorld(7),
      labelWidth: (label) => toWorld(14 + label.length * 7.2),
    })
  }, [globeScale, globeSites])

  const globePlants = useMemo((): GlobePlantNode[] => {
    const byId = new Map(globeSites.map((site) => [site.plant.id, site]))
    const out: GlobePlantNode[] = []
    for (const mark of globePlacement) {
      if (mark.members.length !== 1) continue
      const site = byId.get(at(mark.members, 0, 'globe mark member'))
      if (site === undefined) continue
      out.push({
        plant: site.plant,
        slot: site.slot,
        position: mark.position,
        anchor: mark.anchor,
        displaced: mark.displaced,
        radius: mark.r,
        label: mark.label,
        aggregate: site.aggregate,
      })
    }
    return out
  }, [globePlacement, globeSites])

  const globeClusters = useMemo((): GlobeClusterNode[] => {
    const byId = new Map(globeSites.map((site) => [site.plant.id, site]))
    const out: GlobeClusterNode[] = []
    for (const mark of globePlacement) {
      if (mark.members.length < 2) continue
      const members: GlobeClusterMember[] = []
      for (const id of mark.members) {
        const site = byId.get(id)
        if (site !== undefined) members.push({ id, code: site.plant.code, slot: site.slot })
      }
      out.push({
        id: mark.id,
        position: mark.position,
        anchor: mark.anchor,
        displaced: mark.displaced,
        radius: mark.r,
        label: mark.label,
        members,
      })
    }
    return out
  }, [globePlacement, globeSites])

  /** Arcs leave from where the bubble actually is, not from where it would be. */
  const plantPositions = useMemo(() => {
    const map = new Map<PlantId, Point>()
    for (const mark of globePlacement) {
      for (const id of mark.members) map.set(id, mark.position)
    }
    return map
  }, [globePlacement])

  /**
   * Arcs are the scenario's own cross-plant decisions, not invented traffic.
   * Width encodes the SHARE of source volume redirected — the one quantity all
   * three move kinds actually carry — and the legend says so.
   */
  const arcs = useMemo(() => {
    const inputs: ArcInput[] = []
    for (const entry of scenario.moves) {
      if (!entry.enabled) continue
      const move = entry.move
      if (move.kind === 'resourceMove') {
        const from = workCenterById.get(move.fromWorkCenterId)?.plantId
        const to = workCenterById.get(move.toWorkCenterId)?.plantId
        if (from === undefined || to === undefined || from === to) continue
        inputs.push({ id: entry.id, kind: 'load', fromPlantId: from, toPlantId: to, share: move.share, label: entry.label })
      } else if (move.kind === 'wipTransfer') {
        inputs.push({
          id: entry.id,
          kind: 'wip',
          fromPlantId: move.fromPlantId,
          toPlantId: move.toPlantId,
          share: move.share,
          label: entry.label,
        })
      } else if (move.kind === 'sourceSwitch') {
        inputs.push({
          id: entry.id,
          kind: 'sourceSwitch',
          fromPlantId: move.fromPlantId,
          toPlantId: move.toPlantId,
          share: 1,
          label: entry.label,
        })
      }
    }
    return layoutArcs(inputs, plantPositions)
  }, [plantPositions, scenario.moves, workCenterById])

  // -------------------------------------------------------------------------
  // Hit testing and drag
  // -------------------------------------------------------------------------

  const hitTest = useCallback(
    (world: Point): WorkCenterId | null => {
      if (zoom === 'plant') {
        for (const node of plantLayout.nodes) {
          if (Math.hypot(world.x - node.x, world.y - node.y) <= node.r + 6) return node.id
        }
        for (const [id, slot] of satelliteSlotById) {
          if (Math.hypot(world.x - slot.x, world.y - slot.y) <= slot.r + 8) return id
        }
        return null
      }
      if (zoom === 'workCenter') {
        for (const target of ghostTargets) {
          if (Math.hypot(world.x - target.x, world.y - target.y) <= target.r) return target.id
        }
        return null
      }
      return null
    },
    [ghostTargets, plantLayout.nodes, satelliteSlotById, zoom],
  )

  const positionOf = useCallback(
    (id: WorkCenterId): Point | null => {
      const node = plantLayout.byId.get(id)
      if (node !== undefined) return { x: node.x, y: node.y }
      const slot = satelliteSlotById.get(id)
      if (slot !== undefined) return { x: slot.x, y: slot.y }
      const ghost = ghostTargets.find((target) => target.id === id)
      return ghost === undefined ? null : { x: ghost.x, y: ghost.y }
    },
    [ghostTargets, plantLayout.byId, satelliteSlotById],
  )

  const targetIds = useMemo(() => {
    if (zoom === 'workCenter') return ghostTargets.map((target) => target.id)
    const ids = plantLayout.nodes.map((node) => node.id)
    for (const id of satelliteSlotById.keys()) ids.push(id)
    return ids
  }, [ghostTargets, plantLayout.nodes, satelliteSlotById, zoom])

  const labelFor = useCallback((id: WorkCenterId): string => codeOf(id), [codeOf])

  const drag = useDragMove({
    containerRef,
    catalog: capabilityCatalog,
    aggregates,
    targetIds,
    labelFor,
    hitTest,
    screenToWorld: transform.screenToWorld,
    positionOf,
    approvedBasis,
    fromWeek: filters.fromWeek,
    toWeek: filters.toWeek,
    weekLabel,
  })

  const payloadForWorkCenter = useCallback(
    (id: WorkCenterId): DragPayload => ({
      kind: 'workCenter',
      sourceWorkCenterId: id,
      label: `all load on ${codeOf(id)}`,
      sourceLabel: codeOf(id),
      hours: aggregates.get(id)?.requiredHours ?? 0,
    }),
    [aggregates, codeOf],
  )

  const onNodePointerDown = useCallback(
    (id: WorkCenterId, event: React.PointerEvent<Element>) => {
      // The press is cancelled before the browser can move focus, so the stage
      // takes it explicitly — otherwise clicking a node would silently disarm
      // every keyboard shortcut on the canvas.
      containerRef.current?.focus()
      drag.beginPointerDrag(payloadForWorkCenter(id), event)
    },
    [drag, payloadForWorkCenter],
  )

  // -------------------------------------------------------------------------
  // Click, drag and double-click, told apart
  // -------------------------------------------------------------------------

  /**
   * Where the pointer went down, so a click that arrives after a pan or a move
   * can be recognised as the tail of a gesture rather than a fresh intent.
   * Captured on the stage, so it sees node presses that stop propagating too.
   */
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const drilledAtRef = useRef(Number.NEGATIVE_INFINITY)

  const onStagePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pressRef.current = { x: event.clientX, y: event.clientY, at: performance.now() }
  }, [])

  const wasDrag = useCallback((event: { clientX: number; clientY: number }): boolean => {
    const press = pressRef.current
    pressRef.current = null
    // A press older than a gesture belongs to a different gesture, and a click
    // that arrives without one at all (assistive tech, a synthetic event) is a
    // click. Neither may be mistaken for the tail of a drag.
    if (press === null || performance.now() - press.at > PRESS_MEMORY_MS) return false
    return Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX
  }, [])

  const recentlyDrilled = useCallback(
    (): boolean => performance.now() - drilledAtRef.current < DRILL_GUARD_MS,
    [],
  )

  const onFocusPointerDown = useCallback(
    (event: React.PointerEvent<Element>) => {
      if (activeWorkCenterId === null) return
      onNodePointerDown(activeWorkCenterId, event)
    },
    [activeWorkCenterId, onNodePointerDown],
  )

  const onChipPointerDown = useCallback(
    (chip: GroupChip, event: React.PointerEvent<Element>) => {
      if (activeWorkCenterId === null) return
      drag.beginPointerDrag(
        {
          kind: 'group',
          sourceWorkCenterId: activeWorkCenterId,
          groupId: chip.groupId,
          label: chip.label,
          sourceLabel: codeOf(activeWorkCenterId),
          hours: chip.hours,
        },
        event,
      )
    },
    [activeWorkCenterId, codeOf, drag],
  )

  // -------------------------------------------------------------------------
  // Selection and keyboard
  // -------------------------------------------------------------------------

  const drillPlant = useCallback(
    (id: PlantId) => {
      setSelection({ plantId: id })
      setFocusedId(id)
      drilledAtRef.current = performance.now()
      setZoom('plant')
    },
    [setSelection, setZoom],
  )

  const selectWorkCenter = useCallback(
    (id: WorkCenterId) => {
      const plantId = workCenterById.get(id)?.plantId
      setSelection(plantId === undefined ? { workCenterId: id } : { workCenterId: id, plantId })
      setFocusedId(id)
    },
    [setSelection, workCenterById],
  )

  const drillWorkCenter = useCallback(
    (id: WorkCenterId) => {
      selectWorkCenter(id)
      drilledAtRef.current = performance.now()
      setZoom('workCenter')
    },
    [selectWorkCenter, setZoom],
  )

  /**
   * Enter, or a single click, on a globe mark. A plant opens; a cluster has no
   * single plant to open, so it zooms instead — the marks are sized in screen
   * pixels, so closing in is exactly what pulls its members apart.
   */
  const openGlobeMark = useCallback(
    (id: string) => {
      const mark = globePlacement.find((entry) => entry.id === id)
      if (mark === undefined) return
      if (mark.members.length === 1) {
        drillPlant(at(mark.members, 0, 'globe mark member'))
        return
      }
      setFocusedId(id)
      transform.zoomBy(2.2, transform.worldToScreen(mark.position))
    },
    [drillPlant, globePlacement, transform],
  )

  const activateGlobeMark = useCallback(
    (id: string, event: { clientX: number; clientY: number }) => {
      if (wasDrag(event)) return
      // A double-click delivers two clicks and a dblclick. The first one has
      // already travelled; the rest must not travel again.
      if (recentlyDrilled()) return
      openGlobeMark(id)
    },
    [openGlobeMark, recentlyDrilled, wasDrag],
  )

  const activateWorkCenter = useCallback(
    (id: WorkCenterId, event: { clientX: number; clientY: number }) => {
      // A press that turned into a move already did its work; the click that
      // trails it must not also change the level under the planner.
      if (wasDrag(event)) {
        selectWorkCenter(id)
        return
      }
      if (recentlyDrilled()) {
        selectWorkCenter(id)
        return
      }
      drillWorkCenter(id)
    },
    [drillWorkCenter, recentlyDrilled, selectWorkCenter, wasDrag],
  )

  /**
   * Double-click drills one level. On something, into that thing; on empty
   * canvas, one level down the current path. At the deepest level there is
   * nothing left to drill into, so it falls back to a plain zoom.
   */
  const handleDrillIn = useCallback(
    (world: Point) => {
      if (zoom === 'globe') {
        for (const mark of globePlacement) {
          if (Math.hypot(world.x - mark.position.x, world.y - mark.position.y) <= mark.r + 14) {
            openGlobeMark(mark.id)
            return
          }
        }
        if (activePlantId !== null) setZoom('plant')
        return
      }
      if (zoom === 'plant') {
        const hit = hitTest(world)
        if (hit !== null) drillWorkCenter(hit)
        else if (activeWorkCenterId !== null) setZoom('workCenter')
        return
      }
      const hit = hitTest(world)
      if (hit !== null) drillWorkCenter(hit)
      else transform.zoomBy(1.6)
    },
    [
      activePlantId,
      activeWorkCenterId,
      drillWorkCenter,
      globePlacement,
      hitTest,
      openGlobeMark,
      setZoom,
      transform,
      zoom,
    ],
  )
  drillInRef.current = handleDrillIn

  const focusOrder = useMemo(() => {
    if (zoom === 'globe') return globePlacement.map((mark) => mark.id)
    if (zoom === 'plant') return plantLayout.nodes.map((node) => node.id)
    return ghostTargets.map((target) => target.id)
  }, [ghostTargets, globePlacement, plantLayout.nodes, zoom])

  /**
   * Move the node focus by `delta`, returning false when the step would leave
   * the node list. The order deliberately does NOT wrap: Tab has to be able to
   * carry focus out of the stage again, and a cycle here would be a keyboard
   * trap on the one control that owns the whole screen.
   */
  const stepFocus = useCallback(
    (delta: number): boolean => {
      if (focusOrder.length === 0) return false
      const index = focusedId === null ? -1 : focusOrder.indexOf(focusedId)
      const next = index + delta
      if (next < 0 || next >= focusOrder.length) return false
      setFocusedId(at(focusOrder, next, 'focus target'))
      return true
    },
    [focusOrder, focusedId],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const active = drag.drag
      if (active !== null && active.mode === 'keyboard') {
        switch (event.key) {
          case 'ArrowLeft':
          case 'ArrowRight':
          case 'ArrowUp':
          case 'ArrowDown': {
            event.preventDefault()
            const direction =
              event.key === 'ArrowLeft'
                ? 'left'
                : event.key === 'ArrowRight'
                  ? 'right'
                  : event.key === 'ArrowUp'
                    ? 'up'
                    : 'down'
            drag.stepKeyboardTarget(direction)
            return
          }
          case 'Enter':
            event.preventDefault()
            drag.confirmKeyboardMove()
            return
          case 'Escape':
            event.preventDefault()
            drag.cancelDrag()
            return
          default:
            return
        }
      }

      if (event.key === 'Tab') {
        // Swallowed only while the focus stays on a node. At either end the
        // browser gets the key back, so the stage can always be tabbed out of.
        if (stepFocus(event.shiftKey ? -1 : 1)) event.preventDefault()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        if (focusedId === null) return
        if (zoom === 'globe') openGlobeMark(focusedId)
        else drillWorkCenter(focusedId)
        return
      }
      if ((event.key === 'm' || event.key === 'M') && zoom !== 'globe') {
        event.preventDefault()
        const sourceId = focusedId ?? activeWorkCenterId
        if (sourceId === null) return
        drag.beginKeyboardMove(payloadForWorkCenter(sourceId))
        return
      }
      transform.onKeyDown(event)
    },
    [
      activeWorkCenterId,
      drag,
      drillWorkCenter,
      focusedId,
      openGlobeMark,
      payloadForWorkCenter,
      stepFocus,
      transform,
      zoom,
    ],
  )

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // The first click of the pair already drilled. Honouring the dblclick on
      // top of it would skip a level, which is how a canvas loses its reader.
      if (recentlyDrilled()) return
      transform.onDoubleClick(event)
    },
    [recentlyDrilled, transform],
  )

  // -------------------------------------------------------------------------
  // Table twin
  // -------------------------------------------------------------------------

  const table = useMemo(() => {
    if (zoom === 'globe') {
      return {
        caption: 'Plants in the current filter window — available and required hours against the ceiling.',
        columns: [
          { key: 'plant', label: 'Plant' },
          { key: 'region', label: 'Region' },
          { key: 'workCenters', label: 'Work centers', align: 'right' as const },
          { key: 'available', label: 'Available', align: 'right' as const },
          { key: 'required', label: 'Required', align: 'right' as const },
          { key: 'utilisation', label: 'Utilisation', align: 'right' as const },
          { key: 'overloaded', label: 'Over ceiling', align: 'right' as const },
        ],
        rows: globePlants.map((node) => ({
          plant: `${node.plant.code} · ${node.plant.name}`,
          region: node.plant.region,
          workCenters: node.aggregate?.workCenterCount ?? 0,
          available: fmtHours(node.aggregate?.availableHours ?? 0, { compact: true }),
          required: fmtHours(node.aggregate?.requiredHours ?? 0, { compact: true }),
          utilisation: pct(node.aggregate?.utilisation ?? 0, 0),
          overloaded: node.aggregate?.overloadedWorkCenters ?? 0,
          _slot: node.plant.colorSlot,
        })),
        rowSlot: (row: Record<string, string | number>): SeriesSlot | undefined => {
          const slot = row._slot
          return typeof slot === 'number' && slot >= 1 && slot <= 5 ? (slot as SeriesSlot) : undefined
        },
      }
    }
    if (zoom === 'plant') {
      return {
        caption: `Work centers at ${plantCodeOf(activePlantId ?? '')} — utilisation against each cell's own ceiling.`,
        columns: [
          { key: 'code', label: 'Work center' },
          { key: 'stage', label: 'Stage' },
          { key: 'class', label: 'Machine class' },
          { key: 'utilisation', label: 'Utilisation', align: 'right' as const },
          { key: 'peak', label: 'Peak', align: 'right' as const },
          { key: 'required', label: 'Required', align: 'right' as const },
          { key: 'available', label: 'Available', align: 'right' as const },
          { key: 'binding', label: 'Binding pool' },
        ],
        rows: plantNodeViews.map((view) => ({
          code: view.node.code,
          stage: view.node.stage,
          class: view.node.className,
          utilisation: pct(view.aggregate?.utilisation ?? 0, 0),
          peak: pct(view.aggregate?.peakUtilisation ?? 0, 0),
          required: fmtHours(view.aggregate?.requiredHours ?? 0, { compact: true }),
          available: fmtHours(view.aggregate?.availableHours ?? 0, { compact: true }),
          binding: view.labourBound ? 'Labour' : 'Machine',
        })),
      }
    }
    const cells = (detail.data?.cells ?? []).filter(
      (cell) => cell.week >= filters.fromWeek && cell.week <= filters.toWeek,
    )
    return {
      caption: `${codeOf(activeWorkCenterId ?? '')} week by week — required hours, the ceiling that applied, and resolved OEE.`,
      columns: [
        { key: 'week', label: 'Week' },
        { key: 'required', label: 'Required', align: 'right' as const },
        { key: 'permitted', label: 'Permitted', align: 'right' as const },
        { key: 'utilisation', label: 'Utilisation', align: 'right' as const },
        { key: 'downtime', label: 'Downtime', align: 'right' as const },
        { key: 'binding', label: 'Binding pool' },
        { key: 'oee', label: 'OEE', align: 'right' as const },
      ],
      rows: cells.map((cell) => {
        const required = cell.bindingPool === 'labour' ? cell.labourRequired : cell.machineRequired
        const available = cell.bindingPool === 'labour' ? cell.labourAvailable : cell.machineAvailable
        return {
          week: weekLabel(cell.week),
          required: fmtHours(required, { compact: true }),
          permitted: fmtHours(available * cell.ceiling, { compact: true }),
          utilisation: pct(cell.utilisation, 0),
          downtime: fmtHours(cell.downtimeHours, { compact: true }),
          binding: cell.bindingPool === 'labour' ? 'Labour' : 'Machine',
          oee: pct(cell.oee, 1),
        }
      }),
    }
  }, [
    activePlantId,
    activeWorkCenterId,
    codeOf,
    detail.data,
    filters.fromWeek,
    filters.toWeek,
    globePlants,
    plantCodeOf,
    plantNodeViews,
    weekLabel,
    zoom,
  ])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const useEdgeCanvas = edgeCull.edges.length > EDGE_CANVAS_THRESHOLD
  const activeWorkCenter = activeWorkCenterId === null ? undefined : workCenterById.get(activeWorkCenterId)
  const busy = model.loading || detail.loading
  const levelLabel = zoom === 'globe' ? 'Network' : zoom === 'plant' ? plantCodeOf(activePlantId ?? '') : codeOf(activeWorkCenterId ?? '')
  // The globe holds five marks in one band of latitude. Giving it the same
  // stage as a 150-node plant grid buys nothing but ocean.
  const stageHeight =
    zoom === 'globe'
      ? Math.round(clamp(height * GLOBE_STAGE_RATIO, GLOBE_STAGE_MIN, Math.min(height, GLOBE_STAGE_MAX)))
      : height

  return (
    <section className={[styles.root, className ?? ''].filter(Boolean).join(' ')}>
      <header className={styles.chrome}>
        <nav className={styles.breadcrumb} aria-label="Canvas level">
          <button
            type="button"
            className={styles.crumb}
            aria-current={zoom === 'globe' ? 'page' : undefined}
            onClick={() => setZoom('globe')}
          >
            Network
          </button>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className={styles.crumb}
            aria-current={zoom === 'plant' ? 'page' : undefined}
            disabled={activePlantId === null}
            onClick={() => setZoom('plant')}
          >
            {activePlantId === null ? 'Plant' : plantCodeOf(activePlantId)}
          </button>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className={styles.crumb}
            aria-current={zoom === 'workCenter' ? 'page' : undefined}
            disabled={activeWorkCenterId === null}
            onClick={() => setZoom('workCenter')}
          >
            {activeWorkCenterId === null ? 'Work center' : codeOf(activeWorkCenterId)}
          </button>
        </nav>

        <div className={styles.scale}>
          <DivergingLegend
            labels={{ negative: 'Headroom', neutral: 'At ceiling', positive: 'Overload' }}
            bounds={{ negative: '−50%', positive: '+50%' }}
          />
        </div>

        <div className={styles.chromeRight}>
          {runtimeMs > 0 ? <span className={styles.runtime}>{Math.round(runtimeMs)} ms</span> : null}
          <div className={styles.zoomButtons}>
            <button type="button" onClick={() => transform.zoomBy(1 / 1.4)} aria-label="Zoom out">
              −
            </button>
            <button type="button" onClick={() => transform.fitTo(worldRect, fitPadding, true)} aria-label="Fit to view">
              ⤢
            </button>
            <button type="button" onClick={() => transform.zoomBy(1.4)} aria-label="Zoom in">
              +
            </button>
          </div>
        </div>
      </header>

      <div
        ref={containerRef}
        className={styles.stage}
        style={{ height: `${stageHeight}px` }}
        data-busy={busy ? 'yes' : undefined}
        data-panning={transform.panning ? 'yes' : undefined}
        role="application"
        aria-label={`Network canvas, ${levelLabel}. Tab moves between nodes, Enter or a click drills in, Backspace goes up, M starts a move.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDownCapture={onStagePointerDownCapture}
        onPointerDown={transform.onPointerDown}
        onDoubleClick={onDoubleClick}
      >
        {status === 'loading' ? (
          <CanvasStatus title="Building the network" body="Generating master data and running the first scenario." />
        ) : null}
        {status === 'error' ? (
          <CanvasStatus title="The model could not run" body={error ?? 'Unknown error.'} tone="error" />
        ) : null}

        {zoom === 'plant' && useEdgeCanvas ? (
          <CapabilityEdgesCanvas
            edges={edgeCull.edges}
            subscribe={subscribe}
            width={transform.size.width}
            height={transform.size.height}
            themeKey={theme}
            highlightNodeId={hoveredId ?? focusedId}
          />
        ) : null}

        <svg className={styles.svg} role="presentation">
          <g ref={worldRef}>
            {zoom === 'plant' && !useEdgeCanvas ? (
              <CapabilityEdgesSvg edges={edgeCull.edges} highlightNodeId={hoveredId ?? focusedId} />
            ) : null}

            {zoom === 'globe' ? (
              <GlobeLayer
                plants={globePlants}
                clusters={globeClusters}
                arcs={arcs}
                slotOfPlant={slotOfPlant}
                selectedPlantId={activePlantId ?? undefined}
                focusedId={focusedId}
                hoveredId={hoveredId}
                onHover={setHoveredId}
                onActivate={activateGlobeMark}
              />
            ) : null}

            {zoom === 'plant' ? (
              <PlantLayer
                layout={plantLayout}
                nodes={plantNodeViews}
                satellites={satellites}
                slotOfPlant={slotOfPlant}
                plantCodeOf={plantCodeOf}
                codeOf={codeOf}
                selectedId={selection.workCenterId}
                focusedId={focusedId}
                hoveredId={hoveredId}
                dropTargets={drag.drag === null ? null : drag.legalTargets}
                activeTargetId={drag.drag?.targetId ?? null}
                dragSourceId={drag.drag?.payload.sourceWorkCenterId ?? null}
                previewUtilisation={drag.previewUtilisation}
                onHover={setHoveredId}
                onActivate={activateWorkCenter}
                onNodePointerDown={onNodePointerDown}
              />
            ) : null}

            {zoom === 'workCenter' && activeWorkCenterId !== null ? (
              <WorkCenterLayer
                workCenterId={activeWorkCenterId}
                code={codeOf(activeWorkCenterId)}
                name={activeWorkCenter?.name ?? ''}
                className={classNameById.get(activeWorkCenter?.classId ?? '') ?? ''}
                plantLabel={plantCodeOf(activeWorkCenter?.plantId ?? '')}
                aggregate={aggregates.get(activeWorkCenterId)}
                detail={detail.data}
                relief={reliefCandidates}
                loading={detail.loading || relief.loading}
                fromWeek={filters.fromWeek}
                toWeek={filters.toWeek}
                weekLabel={weekLabel}
                codeOf={codeOf}
                dropTargets={drag.drag === null ? null : drag.legalTargets}
                activeTargetId={drag.drag?.targetId ?? null}
                previewUtilisation={drag.previewUtilisation}
                onFocusPointerDown={onFocusPointerDown}
                onChipPointerDown={onChipPointerDown}
                onCandidateActivate={activateWorkCenter}
                onHover={setHoveredId}
              />
            ) : null}
          </g>
        </svg>

        <DragLayer
          drag={drag.drag}
          ghostRef={drag.ghostRef}
          applied={drag.applied}
          describe={drag.describe}
          weekLabel={weekLabel}
          weekCount={weekCount}
          busy={model.loading}
          onUpdate={drag.updateApplied}
          onUndo={drag.undoApplied}
          onDismiss={drag.dismissApplied}
        />

        <div className={styles.hud} data-level={zoom}>
          {zoom === 'plant' ? (
            <CapabilityEdgeLegend hidden={edgeCull.hidden} total={edgeCull.total} />
          ) : null}
          {zoom === 'globe' ? <ArcLegend count={arcs.length} slotOfPlant={slotOfPlant} plants={globePlants} /> : null}
          <p className={styles.keys}>
            <kbd>Click</kbd> or <kbd>Enter</kbd> drill in · <kbd>Tab</kbd> node · <kbd>Backspace</kbd> up ·{' '}
            <kbd>M</kbd> move · <kbd>↑↓←→</kbd> pan · <kbd>+</kbd>/<kbd>−</kbd> zoom
          </p>
        </div>
      </div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.tableToggle}
          aria-expanded={tableOpen}
          onClick={() => setTableOpen((prior) => !prior)}
        >
          <span aria-hidden="true">{tableOpen ? '▾' : '▸'}</span>
          {tableOpen ? 'Hide table' : 'Table view'}
        </button>
        <span className={styles.footerNote}>
          {zoom === 'plant'
            ? `${plantNodeViews.length} work centers · ${edgeCull.edges.length} capability links drawn`
            : zoom === 'globe'
              ? `${globePlants.length} plants · ${arcs.length} cross-plant flows`
              : `${(detail.data?.cells ?? []).length} weeks of detail`}
        </span>
      </footer>

      {tableOpen ? (
        <div className={styles.tablePanel}>
          <TableView {...table} />
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Chrome pieces
// ---------------------------------------------------------------------------

function CanvasStatus({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  return (
    <div className={styles.status} data-tone={tone}>
      <div className={styles.statusInner}>
        <span className={styles.statusMark} aria-hidden="true">
          <svg viewBox="0 0 24 24" width={22} height={22}>
            <circle cx={12} cy={12} r={9} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.35} />
            <path
              d="M12 3a9 9 0 0 1 9 9"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              className={styles.statusSpin}
            />
          </svg>
        </span>
        <div>
          <p className={styles.statusTitle}>{title}</p>
          <p className={styles.statusBody}>{body}</p>
        </div>
      </div>
    </div>
  )
}

function ArcLegend({
  count,
  plants,
  slotOfPlant,
}: {
  count: number
  plants: readonly GlobePlantNode[]
  slotOfPlant: (id: PlantId) => SeriesSlot
}) {
  if (count === 0) {
    return (
      <div className={styles.arcLegend}>
        <span className={styles.legendTitle}>Cross-plant flow</span>
        <span className={styles.legendHint}>
          No transfers in this scenario yet. Drag load between plants and the arc appears here.
        </span>
      </div>
    )
  }
  const shown = plants.slice(0, 5)
  return (
    <div className={styles.arcLegend}>
      <span className={styles.legendTitle}>Cross-plant flow</span>
      <span className={styles.legendHint}>
        Arc width is the share of source volume redirected; the arc takes its origin plant&rsquo;s colour.
      </span>
      <span className={styles.legendChips}>
        {shown.map((node) => (
          <span key={node.plant.id} className={styles.legendChip}>
            <span
              className={styles.legendDot}
              style={{ background: seriesColor(slotOfPlant(node.plant.id)) }}
              aria-hidden="true"
            />
            {node.plant.code}
          </span>
        ))}
      </span>
    </div>
  )
}
