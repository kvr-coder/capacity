/**
 * Shared SVG furniture.
 *
 * Every plot in the kit is hand-built, so the things that must look identical
 * across plots — gridlines, ticks, the bar shape, the axis rule, the ring that
 * lifts an overlapping dot off its neighbours — live here rather than being
 * re-typed per chart. Charts own their scales; this module owns the marks.
 *
 * All geometry is plain numbers in SVG user space. Nothing here reads the DOM
 * except `useChartSize`, which exists so charts are responsive without pulling
 * in a layout library.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { at, clamp } from '@/domain/lookup'
import { monthShort, niceTicks } from '@/lib/format'
import { AXIS, GRIDLINE, SURFACE } from '@/charts/palette'
import styles from '@/charts/primitives.module.css'

/** House mark constants. Changing one of these changes every chart at once. */
export const CHART = {
  /** Bars never get fatter than this, however few categories there are. */
  BAR_MAX_THICKNESS: 24,
  /** Rounding on the data end of a bar. The baseline end stays square. */
  BAR_RADIUS: 4,
  LINE_WIDTH: 2,
  MARKER_RADIUS: 4,
  /** Surface ring on overlapping dots, and the gap between touching fills. */
  RING_WIDTH: 2,
  GAP: 2,
  /** Minimum pointer/focus target for an interactive mark. */
  HIT_TARGET: 24,
} as const

/** Anything with a `.current` element: a plain ref or a callback-populated box. */
export interface ElementRefLike {
  readonly current: HTMLElement | null
}

/**
 * `useLayoutEffect` in the browser, `useEffect` everywhere else. Measurement
 * has to happen before paint or the first frame shows the fallback width, but
 * a layout effect on the server is a warning and does nothing useful.
 */
export const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Measured content width of `ref`, falling back to `fallback` before the first
 * observation (and in any environment without `ResizeObserver`). Charts read
 * this to lay themselves out, so they reflow with the card instead of needing a
 * fixed pixel width from the caller.
 */
export function useChartSize(ref: ElementRefLike, fallback = 640): number {
  const [width, setWidth] = useState(fallback)

  useIsomorphicLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      const next = element.clientWidth
      if (next > 0) setWidth(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}

/**
 * SSR-safe unique id for `<defs>` members. React's `useId` produces colons,
 * which are legal in an id but awkward inside `url(#...)`, so they are stripped.
 */
export function useUniqueId(prefix = 'chart'): string {
  const raw = useId()
  return `${prefix}-${raw.replace(/:/g, '')}`
}

/** Compose a defs id from a `useUniqueId` base and a local name. */
export function clipId(base: string, name: string): string {
  return `${base}-${name}`
}

// ---------------------------------------------------------------------------
// Gridlines, axes, baseline
// ---------------------------------------------------------------------------

export interface GridLinesProps {
  /** Tick values in data space; the scale turns them into y positions. */
  ticks: readonly number[]
  scaleY: (value: number) => number
  x1: number
  x2: number
  /** Skip the line that sits on the baseline — `<Baseline>` draws that one. */
  skipValue?: number
}

/** Horizontal hairlines. 1px, solid — never dashed. One step off the surface. */
export function GridLines({ ticks, scaleY, x1, x2, skipValue = 0 }: GridLinesProps) {
  return (
    <g aria-hidden="true">
      {ticks.map((tick) => {
        if (tick === skipValue) return null
        const y = scaleY(tick)
        return (
          <line
            key={tick}
            x1={x1}
            x2={x2}
            y1={y}
            y2={y}
            stroke={GRIDLINE}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        )
      })}
    </g>
  )
}

export interface BaselineProps {
  x1: number
  x2: number
  y: number
}

/** The axis rule the bars sit on. 1px solid, one step stronger than a gridline. */
export function Baseline({ x1, x2, y }: BaselineProps) {
  return (
    <line
      x1={x1}
      x2={x2}
      y1={y}
      y2={y}
      stroke={AXIS}
      strokeWidth={1}
      shapeRendering="crispEdges"
      aria-hidden="true"
    />
  )
}

export interface YAxisProps {
  /** Explicit ticks; omit and pass `max` to let `niceTicks` choose them. */
  ticks?: readonly number[]
  max?: number
  scaleY: (value: number) => number
  /** Right edge of the label column — labels are right-aligned to it. */
  x: number
  format?: (value: number) => string
  /** Draw the gridline set as well, spanning to this x. Omit to skip. */
  gridTo?: number
}

/**
 * Tick labels in muted text with tabular figures, because a column of numbers
 * that jitters as digits change is harder to scan than one that does not.
 */
export function YAxis({ ticks, max, scaleY, x, format, gridTo }: YAxisProps) {
  const values = ticks ?? niceTicks(max ?? 0)
  const fmt = format ?? ((value: number) => String(value))
  return (
    <g aria-hidden="true">
      {gridTo !== undefined ? (
        <GridLines ticks={values} scaleY={scaleY} x1={x + 8} x2={gridTo} />
      ) : null}
      {values.map((value) => (
        <text
          key={value}
          className={styles.tick}
          x={x}
          y={scaleY(value)}
          textAnchor="end"
          dominantBaseline="middle"
        >
          {fmt(value)}
        </text>
      ))}
    </g>
  )
}

export interface XAxisProps {
  /** Category keys — usually `Month` strings. */
  categories: readonly string[]
  /** Centre x for the category at `index`. */
  scaleX: (index: number) => number
  y: number
  /** Defaults to `monthShort`, which is what most of these axes carry. */
  label?: (category: string, index: number) => string
  /** Measured plot width, used to decide how many labels actually fit. */
  width: number
  /** Rough per-character advance at 11px. Tune only if the face changes. */
  charWidth?: number
}

/**
 * Category labels, thinned so they never collide. The number that fits is
 * derived from the measured width and the longest label, then every nth is
 * drawn — always including the first and the last, because those two are the
 * ones a reader looks for to anchor the range.
 */
export function XAxis({ categories, scaleX, y, label, width, charWidth = 6.2 }: XAxisProps) {
  const n = categories.length
  if (n === 0) return null
  const labelFor = label ?? ((category: string) => monthShort(category))
  const texts = categories.map((category, index) => labelFor(category, index))
  const longest = texts.reduce((acc, text) => Math.max(acc, text.length), 0)
  const slot = longest * charWidth + 14
  const fits = Math.max(2, Math.floor(width / Math.max(slot, 1)))
  const visible = thinIndices(n, fits)
  return (
    <g aria-hidden="true">
      {texts.map((text, index) =>
        visible.has(index) ? (
          <text
            key={at(categories, index, 'category')}
            className={styles.tick}
            x={scaleX(index)}
            y={y}
            textAnchor="middle"
            dominantBaseline="hanging"
          >
            {text}
          </text>
        ) : null,
      )}
    </g>
  )
}

/**
 * Indices to keep when only `fits` labels have room. Keeps a constant stride,
 * always keeps the first and last, and drops whatever the last would crowd.
 */
export function thinIndices(count: number, fits: number): Set<number> {
  const keep = new Set<number>()
  if (count <= 0) return keep
  if (count === 1 || fits >= count) {
    for (let i = 0; i < count; i += 1) keep.add(i)
    return keep
  }
  const stride = Math.max(1, Math.ceil(count / Math.max(1, fits)))
  for (let i = 0; i < count; i += stride) keep.add(i)
  const last = count - 1
  const guard = Math.max(1, Math.floor(stride / 2))
  for (const index of Array.from(keep)) {
    if (index !== 0 && last - index < guard) keep.delete(index)
  }
  keep.add(0)
  keep.add(last)
  return keep
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/** Which edge of the rect is the data end (the rounded one). */
export type BarEnd = 'top' | 'bottom' | 'left' | 'right'

export interface BarGeometry {
  x: number
  y: number
  width: number
  height: number
  dataEnd: BarEnd
}

/**
 * Rect + rounded end for a vertical bar, sign handled: a value below the
 * baseline grows downward and rounds its bottom edge instead.
 */
export function verticalBarGeom(
  xCenter: number,
  thickness: number,
  baselineY: number,
  valueY: number,
): BarGeometry {
  const w = Math.min(thickness, CHART.BAR_MAX_THICKNESS)
  const top = Math.min(baselineY, valueY)
  const height = Math.abs(baselineY - valueY)
  return {
    x: xCenter - w / 2,
    y: top,
    width: w,
    height,
    dataEnd: valueY <= baselineY ? 'top' : 'bottom',
  }
}

/** The horizontal twin: bars grow right for positive, left for negative. */
export function horizontalBarGeom(
  yCenter: number,
  thickness: number,
  baselineX: number,
  valueX: number,
): BarGeometry {
  const h = Math.min(thickness, CHART.BAR_MAX_THICKNESS)
  const left = Math.min(baselineX, valueX)
  const width = Math.abs(valueX - baselineX)
  return {
    x: left,
    y: yCenter - h / 2,
    width,
    height: h,
    dataEnd: valueX >= baselineX ? 'right' : 'left',
  }
}

/**
 * Path for a bar with one rounded end. A bar shorter than the radius degrades
 * to a plain rect rather than emitting a curve that doubles back on itself —
 * an invalid path renders as nothing, which silently loses a data point.
 */
export function roundedBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  dataEnd: BarEnd,
  radius: number = CHART.BAR_RADIUS,
): string {
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  if (w <= 0 || h <= 0) return ''
  const vertical = dataEnd === 'top' || dataEnd === 'bottom'
  const limit = vertical ? Math.min(w / 2, h) : Math.min(h / 2, w)
  const r = Math.min(Math.max(0, radius), limit)
  const rect = `M${x},${y}h${w}v${h}h${-w}Z`
  if (r < 0.5) return rect
  switch (dataEnd) {
    case 'top':
      return (
        `M${x},${y + h}` +
        `L${x},${y + r}` +
        `Q${x},${y} ${x + r},${y}` +
        `L${x + w - r},${y}` +
        `Q${x + w},${y} ${x + w},${y + r}` +
        `L${x + w},${y + h}Z`
      )
    case 'bottom':
      return (
        `M${x},${y}` +
        `L${x},${y + h - r}` +
        `Q${x},${y + h} ${x + r},${y + h}` +
        `L${x + w - r},${y + h}` +
        `Q${x + w},${y + h} ${x + w},${y + h - r}` +
        `L${x + w},${y}Z`
      )
    case 'right':
      return (
        `M${x},${y}` +
        `L${x + w - r},${y}` +
        `Q${x + w},${y} ${x + w},${y + r}` +
        `L${x + w},${y + h - r}` +
        `Q${x + w},${y + h} ${x + w - r},${y + h}` +
        `L${x},${y + h}Z`
      )
    case 'left':
      return (
        `M${x + w},${y}` +
        `L${x + r},${y}` +
        `Q${x},${y} ${x},${y + r}` +
        `L${x},${y + h - r}` +
        `Q${x},${y + h} ${x + r},${y + h}` +
        `L${x + w},${y + h}Z`
      )
    default:
      return rect
  }
}

export interface RoundedBarProps extends BarGeometry {
  fill: string
  radius?: number
  opacity?: number
  className?: string
  /** Set when the bar is the interactive target itself. */
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  onClick?: () => void
}

/** A single bar: rounded at the data end, square where it meets the baseline. */
export function RoundedBar({
  x,
  y,
  width,
  height,
  dataEnd,
  fill,
  radius,
  opacity,
  className,
  onPointerEnter,
  onPointerLeave,
  onClick,
}: RoundedBarProps) {
  const d = roundedBarPath(x, y, width, height, dataEnd, radius)
  if (d === '') return null
  return (
    <path
      d={d}
      fill={fill}
      opacity={opacity}
      className={className}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
    />
  )
}

// ---------------------------------------------------------------------------
// Dots
// ---------------------------------------------------------------------------

export interface PlotSurfaceRingProps {
  cx: number
  cy: number
  fill: string
  r?: number
  /** Ring width; the house value is 2px. */
  ringWidth?: number
}

/**
 * A marker with a surface-coloured ring, so two dots that overlap stay legible
 * without a border stroke that would read as a third colour.
 */
export function PlotSurfaceRing({
  cx,
  cy,
  fill,
  r = CHART.MARKER_RADIUS,
  ringWidth = CHART.RING_WIDTH,
}: PlotSurfaceRingProps) {
  return (
    <circle cx={cx} cy={cy} r={r} fill={fill} stroke={SURFACE} strokeWidth={ringWidth} />
  )
}

// ---------------------------------------------------------------------------
// Pointer plumbing
// ---------------------------------------------------------------------------

export interface PointerPosition {
  x: number
  y: number
}

/**
 * Pointer position in element-local coordinates, plus the handlers to wire onto
 * the plot surface. Charts pair this with a keyboard-driven index so focus
 * shows exactly what hover shows.
 */
export function usePointerPosition(): {
  position: PointerPosition | null
  onPointerMove: (event: { clientX: number; clientY: number; currentTarget: Element }) => void
  onPointerLeave: () => void
  clear: () => void
} {
  const [position, setPosition] = useState<PointerPosition | null>(null)
  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number; currentTarget: Element }) => {
      const box = event.currentTarget.getBoundingClientRect()
      setPosition({ x: event.clientX - box.left, y: event.clientY - box.top })
    },
    [],
  )
  const clear = useCallback(() => setPosition(null), [])
  return { position, onPointerMove, onPointerLeave: clear, clear }
}

/**
 * Nearest category index for an x position, given a band scale. Charts use it
 * so the whole column is the hit target rather than the mark itself, which is
 * how a 2px line gets a 24px target.
 */
export function nearestIndex(x: number, left: number, bandWidth: number, count: number): number {
  if (count <= 0 || bandWidth <= 0) return 0
  return clamp(Math.floor((x - left) / bandWidth), 0, count - 1)
}

/**
 * Debounced "is the layout settled" flag. Charts that animate on mount use it
 * to skip the transition on the very first paint.
 */
export function useMounted(): boolean {
  const mounted = useRef(false)
  const [, force] = useState(0)
  useEffect(() => {
    mounted.current = true
    force((n) => n + 1)
  }, [])
  return mounted.current
}
