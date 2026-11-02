/**
 * Layout maths for the network canvas.
 *
 * Pure and unit tested: no React, no DOM, no clock. Everything the canvas draws
 * is positioned here, so a regression in the picture is reproducible in a test
 * rather than only visible on a screen.
 *
 * Four jobs live in this file.
 *
 *   1. **Aggregation.** The engine returns per-(work center, pool, week)
 *      numbers. The canvas draws one mark per work center and one per plant, so
 *      the window has to be collapsed exactly once, in a memo, and never inside
 *      a pointermove. `aggregateWorkCenters` is that collapse.
 *   2. **Placement.** Stage columns with class grouping for the plant view,
 *      satellites for the other four plants, and collision-free packing inside
 *      both. Collision freedom is structural — nodes are laid on a grid whose
 *      pitch is bigger than a node — not something a solver iterates towards.
 *   3. **Edges.** Bundled control points, arc geometry for the globe, and the
 *      cull that keeps the drawn edge count bounded no matter how dense the
 *      capability graph gets.
 *   4. **Drop classification.** What happens if this load lands there, decided
 *      from the catalog the main thread already holds, so the drag can answer
 *      in the same frame as the pointer moves.
 */

import type {
  CapacityPool,
  FeatureId,
  MachineClass,
  MachineClassId,
  ModelResult,
  OperationId,
  PlantId,
  RetrofitOption,
  StandardOperation,
  WeekIndex,
  WorkCenter,
  WorkCenterId,
} from '@/domain/types'
import { at, clamp, safeDiv } from '@/domain/lookup'
import type { Point } from '@/canvas/projection'

// ---------------------------------------------------------------------------
// Scales shared by every layer
// ---------------------------------------------------------------------------

/**
 * Utilisation -> the -1..1 input of the diverging ramp, centred on the ceiling.
 *
 * Utilisation against a ceiling is polarity, not magnitude: 1.0 is "exactly at
 * the limit" and must read as the neutral midpoint, below it as headroom, above
 * it as overload. `domain` is the half-width in utilisation points that reaches
 * the end of the ramp — 0.5 means 50% over saturates the warm end.
 */
export function utilisationSignal(utilisation: number, domain = 0.5): number {
  if (!Number.isFinite(utilisation)) return 0
  return clamp((utilisation - 1) / (domain <= 0 ? 0.5 : domain), -1, 1)
}

/**
 * Area-proportional radius. Encoding a quantity on a circle means encoding it on
 * the area — radius-proportional bubbles exaggerate the big ones by the square.
 */
export function bubbleRadius(value: number, maxValue: number, min = 14, max = 46): number {
  if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) return min
  const t = Math.sqrt(clamp(value / maxValue, 0, 1))
  return min + (max - min) * t
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface WorkCenterAggregate {
  workCenterId: WorkCenterId
  requiredHours: number
  availableHours: number
  /** Hours the ceiling actually permits — `availableHours * ceiling`. */
  permittedHours: number
  ceiling: number
  /** Window mean of required / permitted on the binding pool. */
  utilisation: number
  peakUtilisation: number
  overloadHours: number
  downtimeHours: number
  bindingPool: CapacityPool
  /** Window mean resolved OEE. Moved hours convert through the ratio of two. */
  oee: number
  /** Weeks in the window that sat above their own ceiling. */
  weeksOverCeiling: number
}

function emptyAggregate(workCenterId: WorkCenterId): WorkCenterAggregate {
  return {
    workCenterId,
    requiredHours: 0,
    availableHours: 0,
    permittedHours: 0,
    ceiling: 1,
    utilisation: 0,
    peakUtilisation: 0,
    overloadHours: 0,
    downtimeHours: 0,
    bindingPool: 'machine',
    oee: 0,
    weeksOverCeiling: 0,
  }
}

/**
 * Collapse a model run onto one row per work center across `[fromWeek, toWeek]`.
 *
 * `cells` is preferred when the run produced it, because it carries the ceiling
 * that actually applied and which pool bound. When the run was aggregates-only
 * the dense pool grids are used instead and the ceiling falls back to 1 — the
 * shape of the answer is the same either way, so no caller has to branch.
 */
export function aggregateWorkCenters(
  result: ModelResult | null,
  fromWeek: WeekIndex,
  toWeek: WeekIndex,
): Map<WorkCenterId, WorkCenterAggregate> {
  const out = new Map<WorkCenterId, WorkCenterAggregate>()
  if (result === null) return out

  const machineGrid = result.grids.machine
  const ids = machineGrid.workCenterIds
  const weekCount = machineGrid.weekCount
  const lo = clamp(Math.min(fromWeek, toWeek), 0, Math.max(0, weekCount - 1))
  const hi = clamp(Math.max(fromWeek, toWeek), 0, Math.max(0, weekCount - 1))
  const span = Math.max(1, hi - lo + 1)

  for (const id of ids) out.set(id, emptyAggregate(id))

  // OEE always comes from the dense grid — `cells` carries it too, but only for
  // the cells the run chose to materialise.
  const oeeSum = new Map<WorkCenterId, number>()
  for (let row = 0; row < ids.length; row += 1) {
    const id = at(ids, row, 'work center id')
    let total = 0
    for (let week = lo; week <= hi; week += 1) {
      total += result.oeeByWorkCenterWeek[row * weekCount + week] ?? 0
    }
    oeeSum.set(id, total / span)
  }

  if (result.cells.length > 0) {
    const utilSum = new Map<WorkCenterId, number>()
    const machineBound = new Map<WorkCenterId, number>()
    for (const cell of result.cells) {
      if (cell.week < lo || cell.week > hi) continue
      const agg = out.get(cell.workCenterId)
      if (agg === undefined) continue
      const available = cell.bindingPool === 'labour' ? cell.labourAvailable : cell.machineAvailable
      agg.requiredHours += cell.bindingPool === 'labour' ? cell.labourRequired : cell.machineRequired
      agg.availableHours += available
      agg.permittedHours += available * cell.ceiling
      agg.ceiling = cell.ceiling
      agg.overloadHours += cell.overloadHours
      agg.downtimeHours += cell.downtimeHours
      agg.peakUtilisation = Math.max(agg.peakUtilisation, cell.utilisation)
      if (cell.utilisation > 1) agg.weeksOverCeiling += 1
      utilSum.set(cell.workCenterId, (utilSum.get(cell.workCenterId) ?? 0) + cell.utilisation)
      machineBound.set(
        cell.workCenterId,
        (machineBound.get(cell.workCenterId) ?? 0) + (cell.bindingPool === 'machine' ? 1 : -1),
      )
    }
    for (const agg of out.values()) {
      agg.utilisation = (utilSum.get(agg.workCenterId) ?? 0) / span
      agg.bindingPool = (machineBound.get(agg.workCenterId) ?? 0) >= 0 ? 'machine' : 'labour'
      agg.oee = oeeSum.get(agg.workCenterId) ?? 0
    }
    return out
  }

  const labourGrid = result.grids.labour
  for (let row = 0; row < ids.length; row += 1) {
    const id = at(ids, row, 'work center id')
    const agg = out.get(id) ?? emptyAggregate(id)
    let machineRequired = 0
    let machineAvailable = 0
    let labourRequired = 0
    let labourAvailable = 0
    let utilSum = 0
    for (let week = lo; week <= hi; week += 1) {
      const i = row * weekCount + week
      const mr = machineGrid.requiredHours[i] ?? 0
      const ma = machineGrid.availableHours[i] ?? 0
      const lr = labourGrid.requiredHours[i] ?? 0
      const la = labourGrid.availableHours[i] ?? 0
      machineRequired += mr
      machineAvailable += ma
      labourRequired += lr
      labourAvailable += la
      agg.overloadHours += (machineGrid.overloadHours[i] ?? 0) + (labourGrid.overloadHours[i] ?? 0)
      agg.downtimeHours += (machineGrid.downtimeHours[i] ?? 0) + (labourGrid.downtimeHours[i] ?? 0)
      const weekUtil = Math.max(safeDiv(mr, ma), safeDiv(lr, la))
      utilSum += weekUtil
      agg.peakUtilisation = Math.max(agg.peakUtilisation, weekUtil)
      if (weekUtil > 1) agg.weeksOverCeiling += 1
    }
    const machineRatio = safeDiv(machineRequired, machineAvailable)
    const labourRatio = safeDiv(labourRequired, labourAvailable)
    agg.bindingPool = labourRatio > machineRatio ? 'labour' : 'machine'
    agg.requiredHours = agg.bindingPool === 'labour' ? labourRequired : machineRequired
    agg.availableHours = agg.bindingPool === 'labour' ? labourAvailable : machineAvailable
    agg.permittedHours = agg.availableHours
    agg.ceiling = 1
    agg.utilisation = utilSum / span
    agg.oee = oeeSum.get(id) ?? 0
    out.set(id, agg)
  }
  return out
}

export interface PlantAggregate {
  plantId: PlantId
  workCenterCount: number
  requiredHours: number
  availableHours: number
  permittedHours: number
  utilisation: number
  peakUtilisation: number
  overloadHours: number
  overloadedWorkCenters: number
  labourBoundWorkCenters: number
}

/** Roll work-center aggregates up to their plants. Hours-weighted, not a mean of means. */
export function aggregatePlants(
  aggregates: ReadonlyMap<WorkCenterId, WorkCenterAggregate>,
  workCenters: readonly WorkCenter[],
): Map<PlantId, PlantAggregate> {
  const out = new Map<PlantId, PlantAggregate>()
  for (const wc of workCenters) {
    const agg = aggregates.get(wc.id)
    let plant = out.get(wc.plantId)
    if (plant === undefined) {
      plant = {
        plantId: wc.plantId,
        workCenterCount: 0,
        requiredHours: 0,
        availableHours: 0,
        permittedHours: 0,
        utilisation: 0,
        peakUtilisation: 0,
        overloadHours: 0,
        overloadedWorkCenters: 0,
        labourBoundWorkCenters: 0,
      }
      out.set(wc.plantId, plant)
    }
    plant.workCenterCount += 1
    if (agg === undefined) continue
    plant.requiredHours += agg.requiredHours
    plant.availableHours += agg.availableHours
    plant.permittedHours += agg.permittedHours
    plant.overloadHours += agg.overloadHours
    plant.peakUtilisation = Math.max(plant.peakUtilisation, agg.peakUtilisation)
    if (agg.utilisation > 1) plant.overloadedWorkCenters += 1
    if (agg.bindingPool === 'labour') plant.labourBoundWorkCenters += 1
  }
  for (const plant of out.values()) {
    plant.utilisation = safeDiv(plant.requiredHours, plant.permittedHours)
  }
  return out
}

// ---------------------------------------------------------------------------
// Globe arcs
// ---------------------------------------------------------------------------

export type ArcKind = 'load' | 'wip' | 'sourceSwitch'

export interface ArcInput {
  id: string
  kind: ArcKind
  fromPlantId: PlantId
  toPlantId: PlantId
  /** 0..1 share of the source volume redirected. Drives arc width. */
  share: number
  label: string
}

export interface ArcGeometry extends ArcInput {
  from: Point
  to: Point
  /** Quadratic control point — the arc bows away from the straight line. */
  control: Point
  /** Point at t=0.5, where the label and the hit target sit. */
  mid: Point
  path: string
  width: number
}

/**
 * Quadratic through `a` and `b`, bowed `bow` world units along the left normal.
 * A negative bow bends the other way, which is the whole mechanism that keeps
 * A->B and B->A from being drawn on top of each other.
 */
export function arcPath(a: Point, b: Point, bow: number): { path: string; control: Point; mid: Point } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) {
    const control = { x: a.x, y: a.y - Math.abs(bow) }
    return { path: `M${a.x},${a.y}Q${control.x},${control.y} ${b.x},${b.y}`, control, mid: control }
  }
  const nx = -dy / length
  const ny = dx / length
  const control = { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow }
  // Quadratic at t = 0.5 is the average of the endpoints and the control, twice.
  const mid = { x: (a.x + 2 * control.x + b.x) / 4, y: (a.y + 2 * control.y + b.y) / 4 }
  return { path: `M${a.x},${a.y}Q${control.x},${control.y} ${b.x},${b.y}`, control, mid }
}

export interface ArcLayoutOptions {
  /** Bow as a fraction of the chord. 0.18 reads as an arc without looping. */
  bowRatio?: number
  minWidth?: number
  maxWidth?: number
}

/**
 * Arc geometry for a set of plant-to-plant flows.
 *
 * Every arc bows along the LEFT normal of its own direction of travel. Reversing
 * the endpoints reverses that normal, so A->B and B->A automatically take
 * opposite sides of the chord and two opposing flows can never be drawn on top
 * of each other. Several flows in the same direction stack outwards instead,
 * each one bowing a little further than the last.
 *
 * These arcs are schematic rather than great-circle: a Monterrey->Suzhou flow is
 * drawn across the map rather than across the Pacific, because splitting a path
 * at the antimeridian buys geographic honesty at the cost of a broken-looking
 * line, and the arc is a relationship marker, not a shipping route.
 */
export function layoutArcs(
  flows: readonly ArcInput[],
  positions: ReadonlyMap<PlantId, Point>,
  options: ArcLayoutOptions = {},
): ArcGeometry[] {
  const bowRatio = options.bowRatio ?? 0.18
  const minWidth = options.minWidth ?? 1.5
  const maxWidth = options.maxWidth ?? 11
  const out: ArcGeometry[] = []
  const seen = new Map<string, number>()
  for (const flow of flows) {
    const from = positions.get(flow.fromPlantId)
    const to = positions.get(flow.toPlantId)
    if (from === undefined || to === undefined) continue
    if (flow.fromPlantId === flow.toPlantId) continue
    const pairKey = `${flow.fromPlantId}>${flow.toPlantId}`
    const occurrence = seen.get(pairKey) ?? 0
    seen.set(pairKey, occurrence + 1)
    const chord = Math.hypot(to.x - from.x, to.y - from.y)
    const { path, control, mid } = arcPath(from, to, chord * bowRatio * (1 + occurrence * 0.55))
    const share = clamp(Number.isFinite(flow.share) ? flow.share : 0, 0, 1)
    out.push({
      ...flow,
      from,
      to,
      control,
      mid,
      path,
      width: flow.kind === 'load' ? minWidth + (maxWidth - minWidth) * share : minWidth,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Globe placement: separation, leader lines and label slots
// ---------------------------------------------------------------------------

/**
 * A site as the globe wants to draw it.
 *
 * Everything here is in **world units**. The caller owns the pixel -> world
 * conversion, which is what lets the same pure function serve a map whose marks
 * hold a constant size on screen: at scale `k` a 30px bubble is simply a
 * `30 / k` world-unit circle, and every threshold below converts the same way.
 */
export interface GlobeSite {
  id: string
  /** The true projected position. Never moved — only drawn away from. */
  anchor: Point
  r: number
  /** Label text. Only its length is read here, so wording stays the caller's. */
  label: string
}

export type LabelSide = 'below' | 'above' | 'right' | 'left'

export interface LabelPlacement {
  side: LabelSide
  /** Centre of the label plate. */
  x: number
  y: number
  width: number
  height: number
  /**
   * True when every candidate slot was taken and the plate had to be pushed
   * clear anyway. Surfaced rather than hidden so a caller can choose to drop
   * the label instead of printing it over something.
   */
  deflected: boolean
}

export interface LabelTarget {
  id: string
  position: Point
  r: number
  label: string
}

export interface GlobeMark {
  /** The site id, or `cluster:<lowest member id>` when it stands for several. */
  id: string
  /** Member site ids, ascending. Exactly one for an ordinary site. */
  members: readonly string[]
  /** Where the mark is drawn. */
  position: Point
  /** The true point the mark stands for — the centroid when it is a cluster. */
  anchor: Point
  r: number
  /** How far the mark sits from its anchor, world units. */
  displacement: number
  /** True when the mark moved far enough that a leader line has to be drawn. */
  displaced: boolean
  label: LabelPlacement
}

export interface GlobeLayoutOptions {
  /** Free space required between two bubble edges. */
  padding?: number
  /** Hard cap on relaxation passes. The solver normally converges in two. */
  iterations?: number
  /**
   * How far a mark may be drawn from its true point. A pair that cannot be
   * separated inside this budget is folded into one cluster marker instead of
   * being flung across the ocean.
   */
  maxDisplacement?: number
  /** Displacement below this is not worth a leader line. */
  leaderThreshold?: number
  labelHeight?: number
  /** Free space between a bubble edge (or another plate) and a plate. */
  labelGap?: number
  labelWidth?: (label: string) => number
  clusterLabel?: (count: number) => string
}

const GLOBE_DEFAULTS: Required<GlobeLayoutOptions> = {
  padding: 6,
  iterations: 64,
  maxDisplacement: 96,
  leaderThreshold: 1.5,
  labelHeight: 19,
  labelGap: 7,
  labelWidth: (label: string) => 14 + label.length * 7.2,
  clusterLabel: (count: number) => `${count} plants`,
}

/** Distances below this are floating-point noise, not an overlap. */
const SEPARATION_EPSILON = 1e-6

/**
 * Sites that cannot be pulled apart inside the displacement budget, grouped.
 *
 * Single-linkage union over the "this pair would have to be lied about" test:
 * separating a pair costs each of them half the shortfall, so a pair whose half
 * exceeds `maxDisplacement` has no honest arrangement at this zoom and belongs
 * in one marker. Zooming in shrinks every world-unit radius, so the same pair
 * stops qualifying and the cluster comes apart on its own.
 *
 * Groups come back in the order their first member appears, members ascending —
 * the whole pass is order-insensitive and has no state to carry between calls.
 */
export function clusterGlobeSites(
  sites: readonly GlobeSite[],
  options: GlobeLayoutOptions = {},
): string[][] {
  const o = { ...GLOBE_DEFAULTS, ...options }
  const count = sites.length
  const parent: number[] = sites.map((_, index) => index)

  const find = (index: number): number => {
    let root = index
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root
    let walk = index
    while ((parent[walk] ?? walk) !== walk) {
      const next = parent[walk] ?? walk
      parent[walk] = root
      walk = next
    }
    return root
  }

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const a = at(sites, i, 'globe site')
      const b = at(sites, j, 'globe site')
      const distance = Math.hypot(b.anchor.x - a.anchor.x, b.anchor.y - a.anchor.y)
      const push = (a.r + b.r + o.padding - distance) / 2
      if (push <= o.maxDisplacement) continue
      const rootA = find(i)
      const rootB = find(j)
      if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
    }
  }

  const groups = new Map<number, string[]>()
  for (let i = 0; i < count; i += 1) {
    const root = find(i)
    const id = at(sites, i, 'globe site').id
    const bucket = groups.get(root)
    if (bucket === undefined) groups.set(root, [id])
    else bucket.push(id)
  }
  return Array.from(groups.values()).map((ids) => [...ids].sort())
}

function readAt(values: readonly number[], index: number): number {
  return values[index] ?? 0
}

/**
 * A few passes of circle separation, seeded at the true positions.
 *
 * Each overlapping pair is pushed apart by exactly half the shortfall each,
 * along the line between them, so the arrangement stays as close to the truth
 * as a non-overlapping one can be. `order` is an id-sorted permutation, which
 * makes the result independent of the order the caller happened to hand the
 * sites over in — the same five plants always land in the same five places.
 */
function separateCircles(
  anchors: readonly Point[],
  radii: readonly number[],
  order: readonly number[],
  padding: number,
  iterations: number,
  maxDisplacement: number,
): Point[] {
  const count = anchors.length
  const xs = anchors.map((point) => point.x)
  const ys = anchors.map((point) => point.y)

  for (let pass = 0; pass < iterations; pass += 1) {
    let moved = false
    for (let a = 0; a < count; a += 1) {
      const i = readAt(order, a)
      for (let b = a + 1; b < count; b += 1) {
        const j = readAt(order, b)
        const need = readAt(radii, i) + readAt(radii, j) + padding
        const dx = readAt(xs, j) - readAt(xs, i)
        const dy = readAt(ys, j) - readAt(ys, i)
        const distance = Math.hypot(dx, dy)
        if (distance >= need - SEPARATION_EPSILON) continue
        // Two sites on the same point offer no direction to be pushed along, so
        // one is taken from the pair's rank instead: deterministic, and it fans
        // a pile-up evenly rather than shooting all of it the same way.
        const angle = (2 * Math.PI * b) / Math.max(1, count)
        const ux = distance > SEPARATION_EPSILON ? dx / distance : Math.cos(angle)
        const uy = distance > SEPARATION_EPSILON ? dy / distance : Math.sin(angle)
        const push = (need - distance) / 2
        xs[i] = readAt(xs, i) - ux * push
        ys[i] = readAt(ys, i) - uy * push
        xs[j] = readAt(xs, j) + ux * push
        ys[j] = readAt(ys, j) + uy * push
        moved = true
      }
    }
    if (!moved) break
  }

  // The honesty clamp runs once, at the end, so it can never fight the solver
  // into an oscillation. Clustering has already folded away anything that
  // needed more room than this, so in practice nothing here moves.
  return anchors.map((anchor, index) => {
    const dx = readAt(xs, index) - anchor.x
    const dy = readAt(ys, index) - anchor.y
    const distance = Math.hypot(dx, dy)
    if (distance <= maxDisplacement || distance < SEPARATION_EPSILON) {
      return { x: readAt(xs, index), y: readAt(ys, index) }
    }
    const scale = maxDisplacement / distance
    return { x: anchor.x + dx * scale, y: anchor.y + dy * scale }
  })
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

function rectHitsCircle(rect: Rect, centre: Point, radius: number): boolean {
  const nearestX = clamp(centre.x, rect.x, rect.x + rect.width)
  const nearestY = clamp(centre.y, rect.y, rect.y + rect.height)
  return Math.hypot(centre.x - nearestX, centre.y - nearestY) < radius
}

/**
 * One label plate per mark, placed so that no two of them touch.
 *
 * The preference order is below, above, right, left — below first because a
 * label under a bubble reads as belonging to it without the eye having to
 * decide, and the map's own labels are absent so there is nothing to compete
 * with. A candidate is rejected if it would sit on another plate or on any
 * bubble; when all four are taken the plate steps further down until it is
 * clear. Marks are placed in reading order, so the answer is the same every
 * time regardless of how the caller sorted them.
 */
export function placeGlobeLabels(
  targets: readonly LabelTarget[],
  options: GlobeLayoutOptions = {},
): Map<string, LabelPlacement> {
  const o = { ...GLOBE_DEFAULTS, ...options }
  const out = new Map<string, LabelPlacement>()
  const taken: Rect[] = []

  const ordered = [...targets].sort(
    (a, b) =>
      a.position.y - b.position.y ||
      a.position.x - b.position.x ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  for (const target of ordered) {
    const width = Math.max(1, o.labelWidth(target.label))
    const height = Math.max(1, o.labelHeight)
    const step = height + o.labelGap
    const candidates: Array<{ side: LabelSide; x: number; y: number }> = [
      { side: 'below', x: target.position.x, y: target.position.y + target.r + o.labelGap + height / 2 },
      { side: 'above', x: target.position.x, y: target.position.y - target.r - o.labelGap - height / 2 },
      { side: 'right', x: target.position.x + target.r + o.labelGap + width / 2, y: target.position.y },
      { side: 'left', x: target.position.x - target.r - o.labelGap - width / 2, y: target.position.y },
    ]
    for (let extra = 1; extra <= 3; extra += 1) {
      candidates.push({
        side: 'below',
        x: target.position.x,
        y: target.position.y + target.r + o.labelGap + height / 2 + extra * step,
      })
    }

    let chosen: LabelPlacement | null = null
    for (const candidate of candidates) {
      const rect: Rect = { x: candidate.x - width / 2, y: candidate.y - height / 2, width, height }
      if (taken.some((other) => rectsOverlap(other, rect))) continue
      if (
        targets.some(
          (other) => other.id !== target.id && rectHitsCircle(rect, other.position, other.r),
        )
      ) {
        continue
      }
      taken.push(rect)
      chosen = { side: candidate.side, x: candidate.x, y: candidate.y, width, height, deflected: false }
      break
    }

    if (chosen === null) {
      const fallback = at(candidates, 0, 'label candidate')
      taken.push({ x: fallback.x - width / 2, y: fallback.y - height / 2, width, height })
      chosen = { side: fallback.side, x: fallback.x, y: fallback.y, width, height, deflected: true }
    }
    out.set(target.id, chosen)
  }
  return out
}

/**
 * The whole globe placement: cluster what cannot be separated, separate the
 * rest, then place the labels.
 *
 * Pure and deterministic — the same sites always produce the same marks, which
 * is what stops the map from re-shuffling itself every time the model re-runs.
 * A mark that ended up off its true point carries `displaced`, and the layer
 * draws a leader line back to `anchor` so the picture never quietly claims a
 * plant is somewhere it is not.
 */
export function layoutGlobe(
  sites: readonly GlobeSite[],
  options: GlobeLayoutOptions = {},
): GlobeMark[] {
  const o = { ...GLOBE_DEFAULTS, ...options }
  const usable = sites.filter(
    (site) =>
      Number.isFinite(site.anchor.x) && Number.isFinite(site.anchor.y) && Number.isFinite(site.r),
  )
  if (usable.length === 0) return []

  const byId = new Map<string, GlobeSite>()
  for (const site of usable) byId.set(site.id, site)

  const seeds = clusterGlobeSites(usable, o).map((members) => {
    const group = members
      .map((id) => byId.get(id))
      .filter((site): site is GlobeSite => site !== undefined)
    const first = at(group, 0, 'cluster member')
    if (group.length === 1) {
      return { id: first.id, members, anchor: first.anchor, r: first.r, label: first.label }
    }
    let sumX = 0
    let sumY = 0
    let sumSquares = 0
    for (const site of group) {
      sumX += site.anchor.x
      sumY += site.anchor.y
      sumSquares += site.r * site.r
    }
    return {
      id: `cluster:${first.id}`,
      members,
      // Area-additive: a marker standing for two plants draws the ink of two.
      anchor: { x: sumX / group.length, y: sumY / group.length },
      r: Math.sqrt(sumSquares),
      label: o.clusterLabel(group.length),
    }
  })

  const order = seeds
    .map((_, index) => index)
    .sort((a, b) => {
      const idA = at(seeds, a, 'globe mark').id
      const idB = at(seeds, b, 'globe mark').id
      return idA < idB ? -1 : idA > idB ? 1 : 0
    })

  const positions = separateCircles(
    seeds.map((seed) => seed.anchor),
    seeds.map((seed) => seed.r),
    order,
    o.padding,
    o.iterations,
    o.maxDisplacement,
  )

  const labels = placeGlobeLabels(
    seeds.map((seed, index) => ({
      id: seed.id,
      position: at(positions, index, 'globe position'),
      r: seed.r,
      label: seed.label,
    })),
    o,
  )

  return seeds.map((seed, index) => {
    const position = at(positions, index, 'globe position')
    const displacement = Math.hypot(position.x - seed.anchor.x, position.y - seed.anchor.y)
    return {
      id: seed.id,
      members: seed.members,
      position,
      anchor: seed.anchor,
      r: seed.r,
      displacement,
      displaced: displacement > o.leaderThreshold,
      label: labels.get(seed.id) ?? {
        side: 'below',
        x: position.x,
        y: position.y + seed.r + o.labelGap + o.labelHeight / 2,
        width: o.labelWidth(seed.label),
        height: o.labelHeight,
        deflected: true,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Capability catalog — the main-thread half of "could it run there?"
// ---------------------------------------------------------------------------

export interface CapabilityCatalog {
  featuresByWorkCenter: ReadonlyMap<WorkCenterId, ReadonlySet<FeatureId>>
  /** Standard operations whose required features this work center already has. */
  capableOpsByWorkCenter: ReadonlyMap<WorkCenterId, ReadonlySet<OperationId>>
  /** Process stage the work center predominantly sits at. */
  stageByWorkCenter: ReadonlyMap<WorkCenterId, number>
  classByWorkCenter: ReadonlyMap<WorkCenterId, MachineClass>
  opById: ReadonlyMap<OperationId, StandardOperation>
  stages: readonly number[]
  stageLabel: ReadonlyMap<number, string>
}

/**
 * Everything the drag needs, derived once from the catalog.
 *
 * This is the *feature* half of the model only. The main thread has no routings,
 * so it can never claim `approved` on its own — that claim comes from the worker
 * (`WorkCenterDetail.siblings`) and is layered on top in {@link classifyDrop}.
 * The split is deliberate: an unapproved-but-capable work center must never be
 * mistaken for an approved one just because the canvas was in a hurry.
 */
export function buildCapabilityCatalog(
  workCenters: readonly WorkCenter[],
  machineClasses: readonly MachineClass[],
  standardOperations: readonly StandardOperation[],
): CapabilityCatalog {
  const classById = new Map<MachineClassId, MachineClass>()
  for (const machineClass of machineClasses) classById.set(machineClass.id, machineClass)

  const opById = new Map<OperationId, StandardOperation>()
  for (const op of standardOperations) opById.set(op.id, op)

  const featuresByWorkCenter = new Map<WorkCenterId, ReadonlySet<FeatureId>>()
  const capableOpsByWorkCenter = new Map<WorkCenterId, ReadonlySet<OperationId>>()
  const stageByWorkCenter = new Map<WorkCenterId, number>()
  const classByWorkCenter = new Map<WorkCenterId, MachineClass>()

  for (const wc of workCenters) {
    const granted = new Set<FeatureId>(wc.features)
    featuresByWorkCenter.set(wc.id, granted)
    const machineClass = classById.get(wc.classId)
    if (machineClass !== undefined) classByWorkCenter.set(wc.id, machineClass)

    const capable = new Set<OperationId>()
    const stagesHit: number[] = []
    let nearestStage = 0
    let nearestMissing = Number.POSITIVE_INFINITY
    for (const op of standardOperations) {
      let missing = 0
      for (const featureId of op.requiredFeatures) if (!granted.has(featureId)) missing += 1
      if (missing === 0) {
        capable.add(op.id)
        stagesHit.push(op.stage)
      } else if (missing < nearestMissing) {
        nearestMissing = missing
        nearestStage = op.stage
      }
    }
    capableOpsByWorkCenter.set(wc.id, capable)
    stageByWorkCenter.set(wc.id, stagesHit.length > 0 ? median(stagesHit) : nearestStage)
  }

  const stageSet = new Set<number>()
  const stageLabel = new Map<number, string>()
  for (const op of standardOperations) {
    stageSet.add(op.stage)
    if (!stageLabel.has(op.stage)) stageLabel.set(op.stage, stageWordFor(op))
  }
  for (const stage of stageByWorkCenter.values()) stageSet.add(stage)
  const stages = Array.from(stageSet).sort((a, b) => a - b)
  for (const stage of stages) if (!stageLabel.has(stage)) stageLabel.set(stage, `Stage ${stage}`)

  return {
    featuresByWorkCenter,
    capableOpsByWorkCenter,
    stageByWorkCenter,
    classByWorkCenter,
    opById,
    stages,
    stageLabel,
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return at(sorted, middle, 'median sample')
}

/**
 * A short process word for a stage column header, taken from the operation's own
 * name — "Mould A" becomes "Mould". Falls back to the code when the name is a
 * single token that is already short enough.
 */
function stageWordFor(op: StandardOperation): string {
  const first = op.name.trim().split(/[\s-]+/)[0]
  if (first !== undefined && first.length >= 3) return first
  return op.code
}

// ---------------------------------------------------------------------------
// Drop classification
// ---------------------------------------------------------------------------

export type DropBasis = 'approved' | 'featureCapable' | 'retrofit' | 'impossible'
export type DropIcon = 'check' | 'wrench' | 'tool' | 'blocked'
export type DropStatus = 'good' | 'warning' | 'serious' | 'critical'

export interface DropClassification {
  basis: DropBasis
  status: DropStatus
  icon: DropIcon
  /** Short label — always rendered, so colour is never the only channel. */
  label: string
  /** One plain-English sentence naming the consequence. */
  detail: string
  allowed: boolean
  retrofit?: RetrofitOption
  capexUsd: number
  leadTimeWeeks: number
  /** Standard operations the two work centers both cover, feature-wise. */
  sharedOperations: number
}

const BASIS_PRESENTATION: Record<DropBasis, { status: DropStatus; icon: DropIcon; label: string }> = {
  approved: { status: 'good', icon: 'check', label: 'Approved' },
  featureCapable: { status: 'warning', icon: 'wrench', label: 'Needs qualification' },
  retrofit: { status: 'serious', icon: 'tool', label: 'Needs retrofit' },
  impossible: { status: 'critical', icon: 'blocked', label: 'Not possible' },
}

export interface ClassifyDropArgs {
  sourceId: WorkCenterId
  targetId: WorkCenterId
  catalog: CapabilityCatalog
  /**
   * Authoritative bases from the worker for the source work center, when the
   * detail request has landed. The allow-list only exists in the worker, so
   * `approved` can only ever come from here.
   */
  approvedBasis?: ReadonlyMap<WorkCenterId, 'approved' | 'featureCapable' | 'retrofit'>
}

/**
 * What a drop on `targetId` would mean. Never colour alone: every branch returns
 * an icon and a label alongside the status.
 */
export function classifyDrop(args: ClassifyDropArgs): DropClassification {
  const { sourceId, targetId, catalog, approvedBasis } = args
  const sourceOps = catalog.capableOpsByWorkCenter.get(sourceId) ?? new Set<OperationId>()
  const targetOps = catalog.capableOpsByWorkCenter.get(targetId) ?? new Set<OperationId>()
  let shared = 0
  for (const opId of sourceOps) if (targetOps.has(opId)) shared += 1

  if (sourceId === targetId) {
    return {
      ...BASIS_PRESENTATION.impossible,
      basis: 'impossible',
      label: 'Same work center',
      detail: 'Load is already here — pick a different target.',
      allowed: false,
      capexUsd: 0,
      leadTimeWeeks: 0,
      sharedOperations: shared,
    }
  }

  const authoritative = approvedBasis?.get(targetId)
  if (authoritative === 'approved') {
    return {
      ...BASIS_PRESENTATION.approved,
      basis: 'approved',
      detail: `Master data already permits this work — ${shared} shared operations, no qualification needed.`,
      allowed: true,
      capexUsd: 0,
      leadTimeWeeks: 0,
      sharedOperations: shared,
    }
  }

  if (authoritative === 'featureCapable' || (authoritative === undefined && shared > 0)) {
    return {
      ...BASIS_PRESENTATION.featureCapable,
      basis: 'featureCapable',
      detail: `Physically capable of ${shared} shared operations, but not on the allow-list — qualification required before planning.`,
      allowed: true,
      capexUsd: 0,
      leadTimeWeeks: 0,
      sharedOperations: shared,
    }
  }

  const retrofit = findClosingRetrofit(catalog, sourceId, targetId)
  if (retrofit !== null) {
    return {
      ...BASIS_PRESENTATION.retrofit,
      basis: 'retrofit',
      detail: `${retrofit.name} closes the feature gap — capex and a ${retrofit.leadTimeWeeks}-week lead time before the first good part.`,
      allowed: true,
      retrofit,
      capexUsd: retrofit.capexUsd,
      leadTimeWeeks: retrofit.leadTimeWeeks,
      sharedOperations: shared,
    }
  }

  return {
    ...BASIS_PRESENTATION.impossible,
    basis: 'impossible',
    detail: 'No feature overlap and no retrofit on this machine class closes the gap.',
    allowed: false,
    capexUsd: 0,
    leadTimeWeeks: 0,
    sharedOperations: shared,
  }
}

/**
 * The cheapest retrofit on the target's class that makes it capable of at least
 * one operation the source runs. Ties break on lead time then id, so the same
 * drag always proposes the same option.
 */
export function findClosingRetrofit(
  catalog: CapabilityCatalog,
  sourceId: WorkCenterId,
  targetId: WorkCenterId,
): RetrofitOption | null {
  const machineClass = catalog.classByWorkCenter.get(targetId)
  if (machineClass === undefined) return null
  const granted = catalog.featuresByWorkCenter.get(targetId) ?? new Set<FeatureId>()
  const sourceOps = catalog.capableOpsByWorkCenter.get(sourceId) ?? new Set<OperationId>()
  if (sourceOps.size === 0) return null

  let best: RetrofitOption | null = null
  for (const option of machineClass.retrofits) {
    const after = new Set<FeatureId>(granted)
    for (const featureId of option.addsFeatures) after.add(featureId)
    let closesSomething = false
    for (const opId of sourceOps) {
      const op = catalog.opById.get(opId)
      if (op === undefined) continue
      let covered = true
      for (const featureId of op.requiredFeatures) {
        if (!after.has(featureId)) {
          covered = false
          break
        }
      }
      if (covered) {
        closesSomething = true
        break
      }
    }
    if (!closesSomething) continue
    if (best === null) best = option
    else if (option.capexUsd < best.capexUsd) best = option
    else if (option.capexUsd === best.capexUsd && option.leadTimeWeeks < best.leadTimeWeeks) best = option
    else if (
      option.capexUsd === best.capexUsd &&
      option.leadTimeWeeks === best.leadTimeWeeks &&
      option.id < best.id
    ) {
      best = option
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Live impact preview
// ---------------------------------------------------------------------------

export interface ImpactPreview {
  movedHours: number
  /** Hours as they land at the target, converted through the OEE ratio. */
  landedHours: number
  sourceUtilisation: number
  targetUtilisation: number
  sourceBefore: number
  targetBefore: number
}

/**
 * Where the two rings would sit if this drop happened.
 *
 * Hours do not transfer one for one: an hour at a work center running 0.90 OEE
 * is not an hour at one running 0.60, so moved hours are scaled by
 * `oeeSource / oeeTarget` — the same conversion the relief search applies in the
 * worker, arriving from the other direction. This is a catalog-side estimate
 * shown while the pointer is down; the worker's run replaces it on drop.
 */
export function previewImpact(
  source: WorkCenterAggregate | undefined,
  target: WorkCenterAggregate | undefined,
  hours: number,
  share = 1,
): ImpactPreview {
  const movedHours = Math.max(0, hours * clamp(share, 0, 1))
  const sourceBefore = source?.utilisation ?? 0
  const targetBefore = target?.utilisation ?? 0
  if (source === undefined || target === undefined) {
    return { movedHours, landedHours: movedHours, sourceUtilisation: sourceBefore, targetUtilisation: targetBefore, sourceBefore, targetBefore }
  }
  const ratio = target.oee > 0 && source.oee > 0 ? source.oee / target.oee : 1
  const landedHours = movedHours * ratio
  return {
    movedHours,
    landedHours,
    sourceBefore,
    targetBefore,
    sourceUtilisation: safeDiv(Math.max(0, source.requiredHours - movedHours), source.permittedHours),
    targetUtilisation: safeDiv(target.requiredHours + landedHours, target.permittedHours),
  }
}

// ---------------------------------------------------------------------------
// Plant layer: stage columns, class groups, collision-free packing
// ---------------------------------------------------------------------------

export interface StageNodeInput {
  id: WorkCenterId
  code: string
  /**
   * What the node face shows. Inside a plant view the plant prefix on every
   * code is the same three characters repeated 150 times, so the caller strips
   * it and the disc carries the part that differs. Defaults to `code`.
   */
  label?: string
  classId: MachineClassId
  className: string
  stage: number
}

export interface PlacedNode extends StageNodeInput {
  label: string
  x: number
  y: number
  r: number
}

export interface ClassGroup {
  classId: MachineClassId
  className: string
  x: number
  y: number
  width: number
  height: number
  nodes: PlacedNode[]
}

export interface StageColumn {
  stage: number
  label: string
  x: number
  width: number
  /** Header band plus content. */
  height: number
  /** Top of the first class group — everything above it is the column header. */
  contentY: number
  contentHeight: number
  groups: ClassGroup[]
  nodeCount: number
}

export interface PlantLayout {
  columns: StageColumn[]
  nodes: PlacedNode[]
  byId: Map<WorkCenterId, PlacedNode>
  width: number
  height: number
  /** Height of the column header band. 0 when there is nothing to draw. */
  headerHeight: number
}

export interface StageLayoutOptions {
  nodeRadius?: number
  /** Free space between two node bounding boxes, both axes. */
  gap?: number
  columnGap?: number
  groupGap?: number
  groupHeaderHeight?: number
  groupPadding?: number
  /** Hard cap on nodes per row inside a class group. */
  maxPerRow?: number
  /** Band above the first class group carrying the stage name and count. */
  headerHeight?: number
}

/**
 * Sized for a grid that is FITTED TO ITSELF rather than to a ring of context.
 *
 * A work center has to carry four things on its face — code, utilisation ring,
 * utilisation value, binding-pool badge — and a 26px disc fitted alongside
 * off-plant satellites left them at three or four screen pixels, which is a
 * decoration rather than a label. These numbers are chosen so that a typical
 * plant (five stages, ~30 work centers) lands near scale 0.75, where the disc is
 * ~28 screen px and the code sits at ~11px: readable without touching the zoom.
 */
const STAGE_DEFAULTS: Required<StageLayoutOptions> = {
  nodeRadius: 38,
  gap: 14,
  columnGap: 34,
  groupGap: 14,
  groupHeaderHeight: 17,
  groupPadding: 9,
  maxPerRow: 3,
  headerHeight: 46,
}

/**
 * Work centers into process-stage columns, class-grouped inside each column.
 *
 * Reading left to right is reading the process: the lowest stage sits at x=0 and
 * the highest at the right edge, so "moulding on the left, packing on the right"
 * falls out of `StandardOperation.stage` rather than being hard-coded anywhere.
 *
 * Placement is collision-free by construction. Nodes sit on a lattice whose
 * pitch is `2r + gap` in both axes, groups stack with `groupGap` between their
 * boxes, and columns are laid end to end — there is no overlap to resolve, so
 * there is no solver and no frame-to-frame jitter.
 */
export function layoutStageColumns(
  inputs: readonly StageNodeInput[],
  stageLabel: ReadonlyMap<number, string>,
  options: StageLayoutOptions = {},
): PlantLayout {
  const o = { ...STAGE_DEFAULTS, ...options }
  const pitch = o.nodeRadius * 2 + o.gap

  const byStage = new Map<number, StageNodeInput[]>()
  for (const input of inputs) {
    const bucket = byStage.get(input.stage)
    if (bucket) bucket.push(input)
    else byStage.set(input.stage, [input])
  }
  const stages = Array.from(byStage.keys()).sort((a, b) => a - b)

  const columns: StageColumn[] = []
  const nodes: PlacedNode[] = []
  const byId = new Map<WorkCenterId, PlacedNode>()
  let cursorX = 0
  let maxHeight = 0

  for (const stage of stages) {
    const members = byStage.get(stage) ?? []
    const byClass = new Map<MachineClassId, StageNodeInput[]>()
    for (const member of members) {
      const bucket = byClass.get(member.classId)
      if (bucket) bucket.push(member)
      else byClass.set(member.classId, [member])
    }
    // Groups stack down the column BIGGEST FLEET FIRST. Ranking by magnitude is
    // the same rule every other ranked list in this app follows, and it puts the
    // machines that carry most of the stage where the eye lands first; the
    // one-offs settle at the bottom where they belong. Ties break on the class
    // NAME — the string the reader can actually see — with the id only as a last
    // resort, because ordering visible boxes by an invisible key is arbitrary
    // dressed up as deterministic.
    const classIds = Array.from(byClass.keys()).sort((a, b) => {
      const left = byClass.get(a) ?? []
      const right = byClass.get(b) ?? []
      if (left.length !== right.length) return right.length - left.length
      const leftName = left[0]?.className ?? a
      const rightName = right[0]?.className ?? b
      if (leftName !== rightName) return leftName < rightName ? -1 : 1
      return a < b ? -1 : a > b ? 1 : 0
    })

    // Column width is set by the widest class group, so every group in a column
    // shares one left edge and the column reads as a single band.
    //
    // The row width is the biggest class the column holds, capped. Sizing each
    // group to be individually SQUARE — the obvious first instinct — is what
    // makes a column of five three-machine classes eleven rows tall: every one
    // of them wraps at two, and it is the COLUMN, not the group, that has to
    // fit the frame. `layoutPlantGridFitted` chooses the cap.
    let perRow = 1
    for (const classId of classIds) {
      const count = (byClass.get(classId) ?? []).length
      perRow = Math.max(perRow, Math.min(o.maxPerRow, count))
    }
    const innerWidth = perRow * pitch - o.gap
    const columnWidth = innerWidth + o.groupPadding * 2

    const groups: ClassGroup[] = []
    let cursorY = o.headerHeight
    let nodeCount = 0
    for (const classId of classIds) {
      const members2 = (byClass.get(classId) ?? []).slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      const rows = Math.max(1, Math.ceil(members2.length / perRow))
      const groupHeight = o.groupHeaderHeight + rows * pitch - o.gap + o.groupPadding * 2
      const group: ClassGroup = {
        classId,
        className: members2[0]?.className ?? classId,
        x: cursorX,
        y: cursorY,
        width: columnWidth,
        height: groupHeight,
        nodes: [],
      }
      members2.forEach((member, index) => {
        const row = Math.floor(index / perRow)
        const column = index % perRow
        // Centre a short final row rather than leaving it hanging left.
        const inRow = Math.min(perRow, members2.length - row * perRow)
        const rowWidth = inRow * pitch - o.gap
        const rowLeft = cursorX + o.groupPadding + (innerWidth - rowWidth) / 2
        const placed: PlacedNode = {
          ...member,
          label: member.label ?? member.code,
          r: o.nodeRadius,
          x: rowLeft + column * pitch + o.nodeRadius,
          y: cursorY + o.groupPadding + o.groupHeaderHeight + row * pitch + o.nodeRadius,
        }
        group.nodes.push(placed)
        nodes.push(placed)
        byId.set(placed.id, placed)
        nodeCount += 1
      })
      groups.push(group)
      cursorY += groupHeight + o.groupGap
    }

    const columnHeight = Math.max(o.headerHeight, cursorY - o.groupGap)
    columns.push({
      stage,
      label: stageLabel.get(stage) ?? `Stage ${stage}`,
      x: cursorX,
      width: columnWidth,
      height: columnHeight,
      contentY: o.headerHeight,
      contentHeight: Math.max(0, columnHeight - o.headerHeight),
      groups,
      nodeCount,
    })
    maxHeight = Math.max(maxHeight, columnHeight)
    cursorX += columnWidth + o.columnGap
  }

  return {
    columns,
    nodes,
    byId,
    width: Math.max(0, cursorX - o.columnGap),
    height: maxHeight,
    headerHeight: columns.length === 0 ? 0 : o.headerHeight,
  }
}

export interface PlantGridFitOptions extends StageLayoutOptions {
  /** Stage the grid will be fitted into, in pixels, after the fit padding. */
  available: { width: number; height: number }
  /** World units the frame carries besides the grid — the dock and the margins. */
  reservedWidth?: number
  reservedHeight?: number
  /** Packings to try. More per row is wider and shorter. */
  candidates?: readonly number[]
}

/**
 * The same packing, chosen for the frame it has to live in.
 *
 * Three nodes per row is a good default and a bad rule: a plant whose stages are
 * deep packs into a tall, narrow grid, and fitting a tall grid into a wide stage
 * wastes the width and shrinks every mark to make the height agree. The stage's
 * aspect is known at layout time, so the packing is simply chosen to be the one
 * that comes out BIGGEST — which is the only thing the reader actually cares
 * about — with the narrower packing winning ties so the choice is stable.
 */
export function layoutPlantGridFitted(
  inputs: readonly StageNodeInput[],
  stageLabel: ReadonlyMap<number, string>,
  options: PlantGridFitOptions,
): PlantLayout {
  const { available, reservedWidth = 0, reservedHeight = 0, candidates = [2, 3, 4, 5], ...base } = options
  let best: PlantLayout | null = null
  let bestScale = Number.NEGATIVE_INFINITY
  for (const maxPerRow of candidates) {
    const layout = layoutStageColumns(inputs, stageLabel, { ...base, maxPerRow })
    const width = Math.max(1, layout.width + reservedWidth)
    const height = Math.max(1, layout.height + reservedHeight)
    const scale = Math.min(available.width / width, available.height / height)
    if (scale > bestScale + 1e-9) {
      bestScale = scale
      best = layout
    }
  }
  return best ?? layoutStageColumns(inputs, stageLabel, base)
}

// ---------------------------------------------------------------------------
// Partner dock: the other plants, docked at the frame edge
// ---------------------------------------------------------------------------

export interface DockSlot {
  workCenterId: WorkCenterId
  code: string
  /** Centre of the slot's dot. */
  x: number
  y: number
  r: number
  /** The row plate — the hit target and the focus ring both use it. */
  rowX: number
  rowY: number
  rowWidth: number
  rowHeight: number
}

export interface DockCard {
  /** Stable focus id. Namespaced so it can never collide with a work-center id. */
  id: string
  plantId: PlantId
  label: string
  x: number
  y: number
  width: number
  height: number
  /** Header band of the card — the part that is always drawn. */
  headerHeight: number
  /** Every partner in this plant, drawn or not. This is the count badge. */
  count: number
  expanded: boolean
  slots: DockSlot[]
  /**
   * Every partner in this plant, strongest overlap first — including the ones
   * the card had no room to draw. A drop on the card header lands on one of
   * these, so the list cannot be narrowed to whatever happens to be visible.
   */
  partners: WorkCenterId[]
  /** Partners the card had no room for. Named, never silently dropped. */
  overflow: number
  /** Where every edge into this plant lands. */
  anchor: Point
  /** Bundle hub — inboard of the anchor, so strands converge before arriving. */
  hub: Point
}

export interface PartnerDock {
  cards: DockCard[]
  byPlant: Map<PlantId, DockCard>
  /**
   * The gutter the cards live in. Depends only on the grid and the card width,
   * NEVER on what is expanded — the view is fitted to this, and a frame that
   * changed when a card opened would re-fit the canvas under the reader.
   */
  gutter: Rect
}

export interface DockInput {
  plantId: PlantId
  label: string
  partners: Array<{ workCenterId: WorkCenterId; code: string; weight: number }>
}

export interface DockOptions {
  /** Bounding box of the focused plant's grid, in world units. */
  gridBounds: Rect
  /** Daylight between the grid's right edge and the gutter. */
  gutterGap?: number
  width?: number
  /** The always-drawn part of a card. */
  cardHeight?: number
  rowHeight?: number
  cardGap?: number
  maxSlots?: number
  /** Plants whose cards are open. Everything else shows a count badge only. */
  expanded?: ReadonlySet<PlantId>
  slotRadius?: number
  padding?: number
  /** Room reserved at the top of the gutter for the dock's own heading. */
  headerInset?: number
  /**
   * Shrink `maxSlots` until every open card fits inside the gutter. Used while a
   * move is in flight, when every card opens at once: a drop target below the
   * bottom of the frame is a drop target nobody can reach, and growing the frame
   * to hold them would rescale the canvas mid-drag.
   */
  fitExpandedToGutter?: boolean
}

const DOCK_DEFAULTS = {
  gutterGap: 46,
  width: 190,
  cardHeight: 50,
  rowHeight: 26,
  cardGap: 14,
  maxSlots: 6,
  slotRadius: 5,
  padding: 10,
  headerInset: 58,
} as const

/**
 * World the dock claims to the right of the grid: the gutter gap plus the card
 * width. The grid's packing is chosen against the space that is LEFT, so this
 * has to be knowable before either exists.
 */
export const DOCK_RESERVED_WIDTH = DOCK_DEFAULTS.gutterGap + DOCK_DEFAULTS.width

/**
 * The other plants, docked as a gutter down the right edge of the grid.
 *
 * A partner in another plant has no position in a plant view, and inventing one
 * far out to the left and right — which is what an orbit does — spends most of
 * the frame on context and drags every capability edge across the content to
 * reach it. Docking instead gives each remote plant one card at the edge: the
 * plant's permanent colour slot, its code, and a COUNT. Twenty individual dots
 * carry no more information than the number twenty, and they cost twenty edges.
 *
 * A card opens on demand into its individual partners, so the detail is one
 * keystroke away rather than always on. The gutter rectangle is deliberately
 * independent of that state: the frame the canvas fits to must not move when a
 * card is opened.
 */
export function layoutPartnerDock(inputs: readonly DockInput[], options: DockOptions): PartnerDock {
  const o = { ...DOCK_DEFAULTS, ...options }
  const expanded = options.expanded ?? new Set<PlantId>()
  const x = o.gridBounds.x + o.gridBounds.width + o.gutterGap
  const gutter: Rect = {
    x,
    y: o.gridBounds.y,
    width: o.width,
    height: Math.max(o.gridBounds.height, 1),
  }
  if (inputs.length === 0) return { cards: [], byPlant: new Map(), gutter }

  // Hung from the top of the gutter, under the dock's heading, so the heading
  // and the cards read as one block. Opening a card grows the stack downwards
  // rather than sliding every other card up the screen.
  let cursorY = o.gridBounds.y + o.headerInset

  let maxSlots = o.maxSlots
  if (o.fitExpandedToGutter === true) {
    const open = inputs.filter((input) => expanded.has(input.plantId)).length
    if (open > 0) {
      const fixed =
        o.headerInset + inputs.length * o.cardHeight + (inputs.length - 1) * o.cardGap + open * o.padding
      // One row is held back for the "+N more" line, which always has to fit:
      // a cap the reader cannot see is the same as a silent truncation.
      const rows = Math.floor((gutter.height - fixed) / (open * o.rowHeight)) - 1
      maxSlots = clamp(rows, 1, o.maxSlots)
    }
  }

  const cards: DockCard[] = []
  const byPlant = new Map<PlantId, DockCard>()
  for (const input of inputs) {
    const isOpen = expanded.has(input.plantId)
    const ranked = [...input.partners].sort(
      (a, b) => b.weight - a.weight || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    )
    const shown = isOpen ? ranked.slice(0, maxSlots) : []
    const overflow = isOpen ? Math.max(0, ranked.length - shown.length) : 0
    const rows = shown.length + (overflow > 0 ? 1 : 0)
    const height = o.cardHeight + (rows > 0 ? rows * o.rowHeight + o.padding : 0)
    const slots: DockSlot[] = shown.map((partner, index) => {
      const rowY = cursorY + o.cardHeight + index * o.rowHeight
      return {
        workCenterId: partner.workCenterId,
        code: partner.code,
        r: o.slotRadius,
        x: x + o.padding + o.slotRadius + 2,
        y: rowY + o.rowHeight / 2,
        rowX: x + 4,
        rowY,
        rowWidth: o.width - 8,
        rowHeight: o.rowHeight,
      }
    })
    const anchor: Point = { x, y: cursorY + o.cardHeight / 2 }
    const card: DockCard = {
      id: `dock:${input.plantId}`,
      plantId: input.plantId,
      label: input.label,
      x,
      y: cursorY,
      width: o.width,
      height,
      headerHeight: o.cardHeight,
      count: ranked.length,
      expanded: isOpen,
      slots,
      partners: ranked.map((partner) => partner.workCenterId),
      overflow,
      anchor,
      // Far enough inboard that strands into one plant read as a single rope,
      // close enough that the rope still points at its card.
      hub: { x: x - o.gutterGap * 1.4, y: anchor.y },
    }
    cards.push(card)
    byPlant.set(card.plantId, card)
    cursorY += height + o.cardGap
  }

  return { cards, byPlant, gutter }
}

// ---------------------------------------------------------------------------
// Drop surfaces
// ---------------------------------------------------------------------------

/**
 * The work center a drop at `world` lands on, or null for a drop on nothing.
 *
 * Three surfaces, in the order a reader would expect them to win: a node in the
 * grid, a row inside an opened dock card, and finally the card itself. The card
 * is a surface in its own right because a docked plant is drawn as ONE mark
 * carrying a count — refusing a drop on it because the planner did not first
 * open it and aim at a row would make the dock decorative.
 *
 * `isLegal` is what a card resolves through: a plant may have thirty partners
 * and only four that can take this load, so the card lands on the strongest
 * legal one rather than on whichever happens to sort first. When none is legal
 * the card still resolves — to its best partner — so the ghost can say *why*
 * the drop is refused instead of going quiet.
 */
export function resolveDropTarget(
  world: Point,
  surfaces: { nodes: readonly PlacedNode[]; dock: PartnerDock },
  isLegal: (id: WorkCenterId) => boolean,
  hitPadding = 6,
): WorkCenterId | null {
  for (const node of surfaces.nodes) {
    if (Math.hypot(world.x - node.x, world.y - node.y) <= node.r + hitPadding) return node.id
  }
  for (const card of surfaces.dock.cards) {
    for (const slot of card.slots) {
      if (
        world.x >= slot.rowX &&
        world.x <= slot.rowX + slot.rowWidth &&
        world.y >= slot.rowY &&
        world.y <= slot.rowY + slot.rowHeight
      ) {
        return slot.workCenterId
      }
    }
  }
  for (const card of surfaces.dock.cards) {
    if (
      world.x >= card.x &&
      world.x <= card.x + card.width &&
      world.y >= card.y &&
      world.y <= card.y + card.height
    ) {
      return pickDockCardTarget(card, isLegal)
    }
  }
  return null
}

/**
 * Which partner a drop on a docked plant's card means. Strongest legal partner
 * first; failing that the strongest partner at all, so the refusal is explained
 * rather than silent. Null only when the plant has no partners to speak of.
 */
export function pickDockCardTarget(
  card: DockCard,
  isLegal: (id: WorkCenterId) => boolean,
): WorkCenterId | null {
  for (const id of card.partners) if (isLegal(id)) return id
  return card.partners[0] ?? null
}

// ---------------------------------------------------------------------------
// Edges: bundling and culling
// ---------------------------------------------------------------------------

export interface EdgeInput {
  id: string
  fromId: string
  toId: string
  from: Point
  to: Point
  /** Bundle hub the edge is pulled through. */
  hub: Point
  basis: 'approved' | 'featureCapable' | 'retrofit'
  /** Bigger is more important — drives both draw order and the cull. */
  weight: number
}

export interface EdgeGeometry extends EdgeInput {
  path: string
  /** `full` when an endpoint is on screen, `faded` when both are outside it. */
  visibility: 'full' | 'faded'
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Cubic control points that pull an edge towards its hub.
 *
 * `strength` is how far along the way to the hub each control point travels.
 * At 0 the edge is a straight line; at 1 both controls sit on the hub and every
 * edge sharing that hub becomes one rope. 0.6 keeps the individual strands
 * distinguishable while still reading as a bundle.
 */
export function bundleControls(
  from: Point,
  to: Point,
  hub: Point,
  strength = EDGE_BUNDLE_STRENGTH,
): { c1: Point; c2: Point } {
  const s = clamp(strength, 0, 1)
  const a = { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 }
  const b = { x: from.x + ((to.x - from.x) * 2) / 3, y: from.y + ((to.y - from.y) * 2) / 3 }
  return {
    c1: { x: a.x + (hub.x - a.x) * s, y: a.y + (hub.y - a.y) * s },
    c2: { x: b.x + (hub.x - b.x) * s, y: b.y + (hub.y - b.y) * s },
  }
}

export function edgePath(from: Point, to: Point, hub: Point, strength = EDGE_BUNDLE_STRENGTH): string {
  const { c1, c2 } = bundleControls(from, to, hub, strength)
  return `M${from.x},${from.y}C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`
}

function insideRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/**
 * How hard edges are pulled towards their hub. High enough that four
 * satellites read as four ropes rather than a hairball, low enough that an
 * individual strand can still be followed with a finger.
 */
export const EDGE_BUNDLE_STRENGTH = 0.78

export interface CullResult {
  edges: EdgeGeometry[]
  /** Edges the cap refused. Surfaced in the UI so the picture never lies. */
  hidden: number
}

/**
 * Bundle and cull. Two rules, both non-negotiable at this scale:
 *
 *   - never draw more than `max` edges, however many exist;
 *   - an edge with both endpoints off screen is drawn faded, not solid, because
 *     it is context rather than content.
 *
 * Edges are ranked by weight, then on-screen ones first, so the cap always keeps
 * the ones the reader is actually looking at.
 */
export function cullEdges(
  inputs: readonly EdgeInput[],
  viewport: Rect,
  max = 200,
  strength = EDGE_BUNDLE_STRENGTH,
): CullResult {
  const scored = inputs.map((edge) => {
    const onScreen = insideRect(edge.from, viewport) || insideRect(edge.to, viewport)
    return { edge, onScreen }
  })
  scored.sort((a, b) => {
    if (a.onScreen !== b.onScreen) return a.onScreen ? -1 : 1
    return b.edge.weight - a.edge.weight || (a.edge.id < b.edge.id ? -1 : 1)
  })
  const kept = scored.slice(0, Math.max(0, max))
  return {
    edges: kept.map(({ edge, onScreen }) => ({
      ...edge,
      path: edgePath(edge.from, edge.to, edge.hub, strength),
      visibility: onScreen ? 'full' : 'faded',
    })),
    hidden: Math.max(0, scored.length - kept.length),
  }
}

// ---------------------------------------------------------------------------
// Work-center layer geometry
// ---------------------------------------------------------------------------

export interface StripBar {
  week: WeekIndex
  x: number
  /** Top of the required-hours bar. */
  y: number
  height: number
  width: number
  /** y of the ceiling rule for this week. */
  ceilingY: number
  utilisation: number
  requiredHours: number
  permittedHours: number
}

export interface StripLayout {
  bars: StripBar[]
  width: number
  height: number
  baselineY: number
  /** Hours value the top of the plot represents. */
  maxHours: number
  bandWidth: number
}

export interface StripInput {
  week: WeekIndex
  requiredHours: number
  availableHours: number
  ceiling: number
}

/**
 * The weekly load strip: one bar per week against that week's own ceiling.
 *
 * The ceiling rule moves week to week because downtime moves it — drawing a
 * single flat capacity line across a horizon that contains a shutdown would be
 * the chart telling a comfortable lie.
 */
export function layoutStrip(
  weeks: readonly StripInput[],
  width: number,
  height: number,
  barMaxThickness = 24,
): StripLayout {
  const n = weeks.length
  const bandWidth = n > 0 ? width / n : width
  let maxHours = 0
  for (const week of weeks) {
    maxHours = Math.max(maxHours, week.requiredHours, week.availableHours * week.ceiling)
  }
  if (maxHours <= 0) maxHours = 1
  const scale = (value: number): number => height - (clamp(value, 0, maxHours) / maxHours) * height
  const thickness = Math.min(barMaxThickness, Math.max(2, bandWidth - 2))
  const bars: StripBar[] = weeks.map((week, index) => {
    const permitted = week.availableHours * week.ceiling
    const y = scale(week.requiredHours)
    return {
      week: week.week,
      x: index * bandWidth + (bandWidth - thickness) / 2,
      y,
      height: height - y,
      width: thickness,
      ceilingY: scale(permitted),
      utilisation: safeDiv(week.requiredHours, permitted),
      requiredHours: week.requiredHours,
      permittedHours: permitted,
    }
  })
  return { bars, width, height, baselineY: height, maxHours, bandWidth }
}

export interface GhostSlot {
  index: number
  x: number
  y: number
  r: number
}

/**
 * Relief candidates fanned around the focused node, best first and closest. An
 * arc rather than a list, because they are drop targets before they are rows and
 * the pointer has to be able to reach all of them from one place. `centerAngle`
 * points the fan: 0 is to the right, `PI/2` is straight down.
 */
export function layoutGhostFan(
  count: number,
  origin: Point,
  radius = 220,
  nodeRadius = 30,
  span = Math.PI * 0.72,
  centerAngle = 0,
): GhostSlot[] {
  const slots: GhostSlot[] = []
  for (let index = 0; index < count; index += 1) {
    const t = count === 1 ? 0 : index / (count - 1) - 0.5
    const angle = centerAngle + t * span
    slots.push({
      index,
      r: nodeRadius,
      x: origin.x + Math.cos(angle) * radius,
      y: origin.y + Math.sin(angle) * radius,
    })
  }
  return slots
}
