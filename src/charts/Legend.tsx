/**
 * Series key.
 *
 * Rendered whenever a plot carries two or more series, and never for exactly
 * one — a legend for a single series is furniture that says nothing. The mark
 * mirrors what the plot draws (a rect for a bar, a rule for a line) so the eye
 * can match key to mark without a second look, and the label stays ink-coloured
 * with the colour carried by the swatch beside it.
 *
 * `onToggle` turns entries into buttons. Without it the legend is inert text,
 * which is the right default — a click target that does nothing is worse than
 * no click target.
 */

import { divergingColor, sequentialColor, seriesColor } from '@/charts/palette'
import type { LegendProps, SeriesMeta } from '@/charts/types'
import styles from '@/charts/Legend.module.css'

export function Legend({
  series,
  activeId,
  onHover,
  onToggle,
  hiddenIds,
  align = 'start',
  valueFor,
}: LegendProps) {
  if (series.length === 0) return null
  const hidden = new Set(hiddenIds ?? [])
  const interactive = onToggle !== undefined

  return (
    <ul
      className={`${styles.legend} ${align === 'end' ? styles.end : styles.start}`}
      onPointerLeave={onHover ? () => onHover(null) : undefined}
    >
      {series.map((entry) => {
        const isHidden = hidden.has(entry.id)
        const dimmed = isHidden || (activeId != null && activeId !== entry.id)
        const value = valueFor?.(entry)
        const body = (
          <>
            <LegendMark series={entry} muted={isHidden} />
            <span className={styles.label}>{entry.label}</span>
            {value === undefined ? null : <span className={styles.value}>{value}</span>}
          </>
        )
        return (
          <li key={entry.id} className={dimmed ? `${styles.item} ${styles.dimmed}` : styles.item}>
            {interactive ? (
              <button
                type="button"
                className={styles.button}
                aria-pressed={!isHidden}
                onClick={() => onToggle(entry.id)}
                onPointerEnter={onHover ? () => onHover(entry.id) : undefined}
                onFocus={onHover ? () => onHover(entry.id) : undefined}
                onBlur={onHover ? () => onHover(null) : undefined}
              >
                {body}
              </button>
            ) : (
              <span
                className={styles.static}
                onPointerEnter={onHover ? () => onHover(entry.id) : undefined}
              >
                {body}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The nine declared diverging bins, cool -> neutral -> warm. */
const DIVERGING_BINS: readonly number[] = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]

export interface DivergingLegendProps {
  labels: { negative: string; neutral: string; positive: string }
  /** Optional numeric caption under the ends, e.g. "-50%" / "+50%". */
  bounds?: { negative: string; positive: string }
}

/**
 * The polarity scale, shown as the discrete steps it actually is. A continuous
 * gradient would promise interpolation the palette does not do — every fill in
 * this app snaps to one of these nine declared steps.
 */
export function DivergingLegend({ labels, bounds }: DivergingLegendProps) {
  return (
    <div className={styles.scale}>
      <div className={styles.swatches} aria-hidden="true">
        {DIVERGING_BINS.map((bin) => (
          <span key={bin} className={styles.swatch} style={{ background: divergingColor(bin) }} />
        ))}
      </div>
      <div className={styles.scaleLabels}>
        <span className={styles.scaleEnd}>
          {labels.negative}
          {bounds ? <span className={styles.scaleBound}>{bounds.negative}</span> : null}
        </span>
        <span className={styles.scaleMid}>{labels.neutral}</span>
        <span className={`${styles.scaleEnd} ${styles.scaleRight}`}>
          {labels.positive}
          {bounds ? <span className={styles.scaleBound}>{bounds.positive}</span> : null}
        </span>
      </div>
    </div>
  )
}

/** Thirteen declared sequential steps, light -> dark. */
const SEQUENTIAL_BINS: readonly number[] = [0, 1 / 12, 2 / 12, 3 / 12, 4 / 12, 5 / 12, 6 / 12, 7 / 12, 8 / 12, 9 / 12, 10 / 12, 11 / 12, 1]

export interface SequentialLegendProps {
  label: string
  min: string
  max: string
}

/** The magnitude scale — one hue, light to dark, as discrete steps. */
export function SequentialLegend({ label, min, max }: SequentialLegendProps) {
  return (
    <div className={styles.scale}>
      <div className={styles.swatches} aria-hidden="true">
        {SEQUENTIAL_BINS.map((bin) => (
          <span key={bin} className={styles.swatch} style={{ background: sequentialColor(bin) }} />
        ))}
      </div>
      <div className={styles.scaleLabels}>
        <span className={styles.scaleEnd}>
          <span className={styles.scaleBound}>{min}</span>
        </span>
        <span className={styles.scaleMid}>{label}</span>
        <span className={`${styles.scaleEnd} ${styles.scaleRight}`}>
          <span className={styles.scaleBound}>{max}</span>
        </span>
      </div>
    </div>
  )
}

function LegendMark({ series, muted }: { series: SeriesMeta; muted: boolean }) {
  const fill = muted ? 'var(--series-other)' : seriesColor(series.slot)
  if (series.markShape === 'line') {
    return (
      <svg className={styles.mark} width={14} height={10} viewBox="0 0 14 10" aria-hidden="true">
        <line x1={0} y1={5} x2={14} y2={5} stroke={fill} strokeWidth={2} strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className={styles.mark} width={10} height={10} viewBox="0 0 10 10" aria-hidden="true">
      <rect x={0} y={0} width={10} height={10} rx={2} fill={fill} />
    </svg>
  )
}
