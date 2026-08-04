/**
 * Palette access for the chart kit.
 *
 * Every function returns a CSS custom-property *reference* (`var(--x)`) rather
 * than a hex. SVG accepts `var()` in `fill` and `stroke`, so a chart drawn with
 * these values re-paints itself when the light/dark scope changes without a
 * single line of JavaScript. It also means the validated palette in
 * `src/styles/tokens.css` stays the only place a colour is written down.
 *
 * Nothing here interpolates. Sequential and diverging ramps snap to the
 * discrete steps declared in the tokens file — a value between two steps picks
 * the nearer step, it never blends two hexes at runtime.
 */

import { at, clamp } from '@/domain/lookup'
import type { SeriesSlot } from '@/charts/types'

/** The card/plot surface. Used for the 2px gaps and rings that separate marks. */
export const SURFACE = 'var(--surface-1)'

/** The raised surface — tooltips and menus sit on this. */
export const SURFACE_RAISED = 'var(--surface-2)'

export const GRIDLINE = 'var(--gridline)'
export const AXIS = 'var(--axis)'
export const TEXT_MUTED = 'var(--text-muted)'

/** Status levels shared by StatTile, Meter and the bottleneck views. */
export type StatusLevel = 'good' | 'warning' | 'serious' | 'critical'

/**
 * Categorical colour for a series slot. Slot identity follows the entity (a
 * plant keeps its slot for the life of the app), so this is a pure lookup —
 * never "the nth series in the current sort order".
 */
export function seriesColor(slot: SeriesSlot): string {
  return slot === 'other' ? 'var(--series-other)' : `var(--series-${slot})`
}

/** The de-emphasis grey, for context series and sparklines. */
export const OTHER = 'var(--series-other)'

/** Sequential ramp steps, light -> dark, exactly as declared in tokens.css. */
const SEQ_STEPS: readonly number[] = [
  100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700,
]

/**
 * Magnitude ramp. `t` is 0..1 (values outside clamp), returning the nearest
 * declared `--seq-*` step. 0 -> the lightest step, 1 -> the darkest.
 */
export function sequentialColor(t: number): string {
  const safe = Number.isFinite(t) ? clamp(t, 0, 1) : 0
  const lastIndex = SEQ_STEPS.length - 1
  const index = clamp(Math.round(safe * lastIndex), 0, lastIndex)
  return `var(--seq-${at(SEQ_STEPS, index, 'sequential step')})`
}

/** The lighter step the meter track and heatmap "empty" state use. */
export const SEQ_TRACK = 'var(--seq-100)'

/**
 * Polarity ramp. `t` is -1..1 (values outside clamp to the end steps).
 * Negative reads cool (headroom), positive reads warm (overload), and a value
 * close enough to zero reads as the neutral grey midpoint — the whole point of
 * a diverging scale is that "balanced" has no hue.
 */
export function divergingColor(t: number): string {
  const safe = Number.isFinite(t) ? clamp(t, -1, 1) : 0
  // Nine bins: -4..-1, 0 (neutral), 1..4. Anything inside +/-1/8 is balanced.
  const bin = clamp(Math.round(safe * 4), -4, 4)
  if (bin === 0) return 'var(--div-mid)'
  return bin < 0 ? `var(--div-neg-${-bin})` : `var(--div-pos-${bin})`
}

/** The neutral midpoint, for legends and the "balanced" swatch. */
export const DIVERGING_MID = 'var(--div-mid)'

/**
 * Reserved status colour. Never used as a series colour, and never on its own:
 * every caller ships an icon glyph and a text label alongside it.
 */
export function statusColor(level: StatusLevel): string {
  return `var(--status-${level})`
}

/** Text colour for a signed delta. Direction x goodDirection, not raw sign. */
export function deltaTextColor(good: boolean | 'neutral'): string {
  if (good === 'neutral') return 'var(--text-secondary)'
  return good ? 'var(--delta-good-text)' : 'var(--delta-bad-text)'
}
