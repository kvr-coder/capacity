/**
 * Equirectangular projection and the world outline the globe layer draws.
 *
 * Pure maths and pure data. No React, no DOM, no network — the continent
 * outlines are declared here as coarse lat/lon rings rather than fetched as
 * topojson, because a 40 kB download to draw a background is a poor trade and a
 * runtime fetch is a failure mode this screen does not need.
 *
 * The outlines are deliberately low-poly: forty-odd vertices per landmass, drawn
 * through a closed Catmull-Rom spline so the result reads as a considered
 * cartographic simplification rather than a jagged polygon. Nothing here is
 * survey-grade — it exists to give five plant bubbles a legible sense of place.
 *
 * Antarctica is absent on purpose: the viewport stops at 58S, no plant is south
 * of it, and a slab of ice along the bottom edge would be the loudest thing on a
 * screen whose data is supposed to be the loud thing.
 */

import { at, clamp } from '@/domain/lookup'

// ---------------------------------------------------------------------------
// Coordinate space
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number
  lon: number
}

export interface Point {
  x: number
  y: number
}

/**
 * The projection window, in world units. `width` and the latitude span are
 * chosen so a degree of longitude and a degree of latitude are the same number
 * of world units — an equirectangular map with a square graticule, which is the
 * only version of it that does not look accidentally stretched.
 */
export interface ProjectionBox {
  width: number
  height: number
  lonMin: number
  lonMax: number
  latMax: number
  latMin: number
}

const LON_SPAN = 360
const LAT_MAX = 80
const LAT_MIN = -58
const WORLD_WIDTH = 1440

export const WORLD: ProjectionBox = {
  width: WORLD_WIDTH,
  height: (WORLD_WIDTH * (LAT_MAX - LAT_MIN)) / LON_SPAN,
  lonMin: -180,
  lonMax: 180,
  latMax: LAT_MAX,
  latMin: LAT_MIN,
}

/** lat/lon -> world x/y. Latitude grows upward, y grows downward. */
export function project(lat: number, lon: number, box: ProjectionBox = WORLD): Point {
  const lonSpan = box.lonMax - box.lonMin
  const latSpan = box.latMax - box.latMin
  return {
    x: ((lon - box.lonMin) / lonSpan) * box.width,
    y: ((box.latMax - lat) / latSpan) * box.height,
  }
}

/**
 * The inverse, for hit testing: the pointer arrives in world coordinates and
 * the caller wants to know which piece of the planet it landed on. Values
 * outside the box are returned unclamped in longitude (so a drag past the
 * antimeridian still reads monotonically) and clamped in latitude, where there
 * is no wrap to speak of.
 */
export function unproject(x: number, y: number, box: ProjectionBox = WORLD): GeoPoint {
  const lonSpan = box.lonMax - box.lonMin
  const latSpan = box.latMax - box.latMin
  return {
    lon: box.lonMin + (x / box.width) * lonSpan,
    lat: clamp(box.latMax - (y / box.height) * latSpan, box.latMin, box.latMax),
  }
}

// ---------------------------------------------------------------------------
// Land
// ---------------------------------------------------------------------------

/** A closed ring of `[lon, lat]` vertices. */
export type Ring = ReadonlyArray<readonly [number, number]>

export interface LandRegion {
  id: string
  name: string
  /** Larger masses draw first and sit behind the small ones. */
  rings: readonly Ring[]
}

const NORTH_AMERICA: Ring = [
  [-168, 66], [-165, 60], [-158, 57], [-152, 58], [-147, 60], [-140, 60],
  [-134, 57], [-130, 53], [-125, 49], [-124, 43], [-121, 37], [-118, 33],
  [-114, 30], [-110, 24], [-105, 20], [-97, 16], [-94, 18], [-91, 19],
  [-87, 21], [-90, 25], [-93, 29], [-89, 29], [-85, 30], [-81, 25],
  [-80, 27], [-76, 35], [-70, 42], [-66, 45], [-60, 47], [-56, 51],
  [-64, 55], [-70, 58], [-78, 62], [-82, 70], [-95, 72], [-105, 70],
  [-115, 70], [-125, 70], [-135, 69], [-145, 70], [-157, 71], [-166, 68],
]

const GREENLAND: Ring = [
  [-45, 60], [-52, 64], [-55, 68], [-58, 72], [-55, 76], [-45, 80],
  [-30, 82], [-22, 79], [-20, 74], [-28, 68], [-38, 65],
]

const SOUTH_AMERICA: Ring = [
  [-81, -4], [-79, 0], [-77, 8], [-72, 11], [-64, 10], [-60, 8],
  [-52, 5], [-50, 0], [-44, -2], [-38, -5], [-35, -8], [-39, -13],
  [-40, -20], [-48, -25], [-53, -34], [-58, -38], [-62, -40], [-65, -45],
  [-68, -50], [-72, -54], [-75, -50], [-74, -44], [-73, -37], [-71, -30],
  [-70, -23], [-70, -18], [-75, -14], [-79, -8],
]

const AFRICA: Ring = [
  [-17, 15], [-16, 21], [-13, 28], [-9, 32], [-2, 36], [9, 37],
  [11, 34], [20, 32], [25, 32], [32, 31], [35, 28], [39, 22],
  [43, 12], [51, 12], [48, 5], [43, -1], [40, -8], [40, -16],
  [35, -22], [32, -28], [27, -34], [20, -34], [16, -28], [13, -22],
  [12, -16], [9, -1], [9, 4], [3, 6], [-4, 5], [-8, 4], [-13, 8],
]

const EURASIA: Ring = [
  [-9, 36], [-9, 43], [-2, 43], [-1, 46], [-4, 48], [0, 49],
  [4, 52], [7, 53], [8, 57], [11, 58], [13, 55], [19, 55],
  [21, 57], [24, 60], [21, 63], [17, 62], [19, 66], [23, 70],
  [28, 71], [33, 70], [41, 67], [45, 68], [55, 69], [62, 72],
  [70, 73], [76, 73], [80, 74], [90, 76], [100, 77], [110, 76],
  [115, 73], [125, 73], [140, 72], [150, 70], [160, 70], [170, 70],
  [179, 69], [175, 63], [165, 60], [162, 58], [155, 57], [156, 51],
  [150, 46], [143, 45], [140, 42], [135, 38], [130, 35], [126, 35],
  [122, 31], [121, 25], [115, 22], [110, 20], [108, 12], [105, 10],
  [100, 8], [98, 12], [94, 16], [92, 21], [89, 22], [87, 20],
  [84, 18], [81, 16], [80, 13], [78, 9], [76, 9], [74, 13],
  [73, 16], [72, 20], [70, 23], [66, 25], [60, 25], [57, 25],
  [52, 29], [48, 30], [44, 37], [36, 36], [31, 36], [27, 37],
  [23, 38], [20, 40], [17, 41], [16, 38], [18, 41], [13, 45],
  [12, 44], [9, 44], [6, 43], [3, 42], [0, 40], [-2, 38], [-6, 36],
]

const BRITAIN: Ring = [
  [-5, 50], [-6, 53], [-3, 55], [-5, 58], [-2, 58], [0, 53], [-1, 51],
]

const IRELAND: Ring = [
  [-10, 52], [-10, 55], [-6, 55], [-6, 52],
]

const JAPAN: Ring = [
  [130, 31], [132, 34], [136, 35], [139, 35], [141, 39], [141, 45],
  [145, 44], [142, 42], [140, 38], [137, 37], [133, 35], [131, 33],
]

const MADAGASCAR: Ring = [
  [44, -16], [50, -15], [50, -21], [47, -25], [44, -21],
]

const AUSTRALIA: Ring = [
  [114, -22], [113, -26], [115, -32], [118, -35], [124, -33], [129, -32],
  [134, -33], [138, -35], [141, -38], [146, -39], [150, -37], [153, -31],
  [153, -25], [146, -19], [142, -11], [137, -12], [132, -11], [127, -14],
  [122, -17],
]

const TASMANIA: Ring = [
  [145, -41], [148, -41], [148, -43], [145, -43],
]

const NEW_ZEALAND_N: Ring = [
  [173, -35], [178, -38], [177, -40], [174, -41], [172, -39],
]

const NEW_ZEALAND_S: Ring = [
  [173, -42], [171, -44], [167, -46], [166, -45], [170, -42],
]

const SUMATRA: Ring = [
  [95, 5], [99, 3], [104, -2], [106, -6], [103, -5], [98, 0],
]

const BORNEO: Ring = [
  [109, 2], [114, 4], [118, 5], [119, 1], [117, -3], [110, -3],
]

const JAVA: Ring = [
  [105, -6], [112, -7], [115, -8], [110, -8], [106, -7],
]

const NEW_GUINEA: Ring = [
  [131, -1], [140, -2], [147, -6], [150, -10], [143, -9], [137, -8], [132, -4],
]

const PHILIPPINES: Ring = [
  [121, 18], [124, 13], [126, 10], [122, 6], [120, 12],
]

const ICELAND: Ring = [
  [-24, 65], [-22, 66], [-16, 66], [-14, 65], [-19, 63],
]

const SRI_LANKA: Ring = [
  [80, 9], [82, 8], [81, 6], [80, 7],
]

/**
 * Draw order matters: the big masses lay down the continental fill, the small
 * ones sit on top. Ids are stable so a caller can key off them.
 */
export const LAND: readonly LandRegion[] = [
  { id: 'eurasia', name: 'Eurasia', rings: [EURASIA] },
  { id: 'africa', name: 'Africa', rings: [AFRICA] },
  { id: 'north-america', name: 'North America', rings: [NORTH_AMERICA] },
  { id: 'south-america', name: 'South America', rings: [SOUTH_AMERICA] },
  { id: 'australia', name: 'Australia', rings: [AUSTRALIA, TASMANIA] },
  { id: 'greenland', name: 'Greenland', rings: [GREENLAND] },
  { id: 'maritime-se-asia', name: 'Maritime Southeast Asia', rings: [SUMATRA, BORNEO, JAVA, NEW_GUINEA, PHILIPPINES] },
  { id: 'japan', name: 'Japan', rings: [JAPAN] },
  { id: 'british-isles', name: 'British Isles', rings: [BRITAIN, IRELAND] },
  { id: 'new-zealand', name: 'New Zealand', rings: [NEW_ZEALAND_N, NEW_ZEALAND_S] },
  { id: 'madagascar', name: 'Madagascar', rings: [MADAGASCAR] },
  { id: 'iceland', name: 'Iceland', rings: [ICELAND] },
  { id: 'sri-lanka', name: 'Sri Lanka', rings: [SRI_LANKA] },
]

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface PathOptions {
  box?: ProjectionBox
  /**
   * Catmull-Rom tension, 0..1. Zero emits straight segments; the default rounds
   * the corners enough that a 40-vertex coastline stops looking like a polygon
   * and starts looking like a coastline.
   */
  smooth?: number
  /** Decimal places kept in the emitted path. Two is sub-pixel at any zoom. */
  precision?: number
}

function fmt(value: number, precision: number): string {
  const rounded = Number(value.toFixed(precision))
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

/**
 * One closed `d` for a ring. With `smooth > 0` the ring is drawn as a closed
 * Catmull-Rom spline converted to cubic Beziers, which keeps every original
 * vertex on the curve — the outline is smoothed, never moved.
 */
export function ringPath(ring: Ring, options: PathOptions = {}): string {
  const box = options.box ?? WORLD
  const smooth = clamp(options.smooth ?? 0.34, 0, 1)
  const precision = options.precision ?? 2
  const n = ring.length
  if (n < 3) return ''

  const points: Point[] = ring.map((vertex) => project(vertex[1], vertex[0], box))
  const first = at(points, 0, 'ring vertex')
  let d = `M${fmt(first.x, precision)},${fmt(first.y, precision)}`

  if (smooth <= 0) {
    for (let i = 1; i < n; i += 1) {
      const p = at(points, i, 'ring vertex')
      d += `L${fmt(p.x, precision)},${fmt(p.y, precision)}`
    }
    return `${d}Z`
  }

  for (let i = 0; i < n; i += 1) {
    const p0 = at(points, (i - 1 + n) % n, 'ring vertex')
    const p1 = at(points, i, 'ring vertex')
    const p2 = at(points, (i + 1) % n, 'ring vertex')
    const p3 = at(points, (i + 2) % n, 'ring vertex')
    const c1x = p1.x + ((p2.x - p0.x) * smooth) / 3
    const c1y = p1.y + ((p2.y - p0.y) * smooth) / 3
    const c2x = p2.x - ((p3.x - p1.x) * smooth) / 3
    const c2y = p2.y - ((p3.y - p1.y) * smooth) / 3
    d +=
      `C${fmt(c1x, precision)},${fmt(c1y, precision)} ` +
      `${fmt(c2x, precision)},${fmt(c2y, precision)} ` +
      `${fmt(p2.x, precision)},${fmt(p2.y, precision)}`
  }
  return `${d}Z`
}

/** Every ring of a region as one path, so a single `<path>` carries a landmass. */
export function landPath(region: LandRegion, options: PathOptions = {}): string {
  return region.rings.map((ring) => ringPath(ring, options)).join('')
}

/** The whole world as one path string. Used for the muted loading skeleton. */
export function worldPath(options: PathOptions = {}): string {
  return LAND.map((region) => landPath(region, options)).join('')
}

// ---------------------------------------------------------------------------
// Graticule
// ---------------------------------------------------------------------------

export interface GraticuleLine {
  /** `parallel` runs east-west, `meridian` runs north-south. */
  kind: 'parallel' | 'meridian'
  /** The degree value the line sits at — used as a stable React key. */
  degrees: number
  x1: number
  y1: number
  x2: number
  y2: number
  /** The equator and the prime meridian read one step stronger. */
  major: boolean
}

/**
 * Latitude/longitude rules across the box. Hairlines, solid — the same rule the
 * chart gridlines follow, because this is a gridline and not a decoration.
 */
export function graticule(
  latStep = 30,
  lonStep = 30,
  box: ProjectionBox = WORLD,
): GraticuleLine[] {
  const lines: GraticuleLine[] = []
  const firstLat = Math.ceil(box.latMin / latStep) * latStep
  for (let lat = firstLat; lat <= box.latMax; lat += latStep) {
    const a = project(lat, box.lonMin, box)
    const b = project(lat, box.lonMax, box)
    lines.push({ kind: 'parallel', degrees: lat, x1: a.x, y1: a.y, x2: b.x, y2: b.y, major: lat === 0 })
  }
  const firstLon = Math.ceil(box.lonMin / lonStep) * lonStep
  for (let lon = firstLon; lon <= box.lonMax; lon += lonStep) {
    const a = project(box.latMax, lon, box)
    const b = project(box.latMin, lon, box)
    lines.push({ kind: 'meridian', degrees: lon, x1: a.x, y1: a.y, x2: b.x, y2: b.y, major: lon === 0 })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** Even-odd ray cast in lon/lat space. Used to answer "did the click hit land?". */
export function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = at(ring, i, 'ring vertex')
    const b = at(ring, j, 'ring vertex')
    const [ax, ay] = a
    const [bx, by] = b
    if (ay > lat !== by > lat && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) {
      inside = !inside
    }
  }
  return inside
}

/** The landmass under a world-space point, or null for open ocean. */
export function landAt(x: number, y: number, box: ProjectionBox = WORLD): LandRegion | null {
  const { lat, lon } = unproject(x, y, box)
  for (const region of LAND) {
    for (const ring of region.rings) {
      if (pointInRing(lon, lat, ring)) return region
    }
  }
  return null
}

/** Bounding box of a set of geo points, in world units, with a margin. */
export function geoBounds(
  points: readonly GeoPoint[],
  margin = 0,
  box: ProjectionBox = WORLD,
): { x: number; y: number; width: number; height: number } {
  if (points.length === 0) return { x: 0, y: 0, width: box.width, height: box.height }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const p = project(point.lat, point.lon, box)
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  }
}
