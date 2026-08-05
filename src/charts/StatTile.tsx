/**
 * One number, its movement, and its shape.
 *
 * The figure uses the face's proportional digits rather than tabular ones — a
 * standalone number is read as a word, not scanned as a column, and tabular
 * figures make a large number look loose. The delta's colour comes from
 * direction x goodDirection, never from the raw sign: falling overload is good
 * news and must not be painted red.
 *
 * Status never travels alone. It ships a glyph and a word next to the swatch.
 */

import { deltaTextColor, statusColor } from '@/charts/palette'
import { SparkBar } from '@/charts/SparkBar'
import type { ChartStatusLevel, StatTileProps } from '@/charts/types'
import styles from '@/charts/StatTile.module.css'

const DELTA_GLYPH = { up: '↑', down: '↓', flat: '→' } as const

export const STATUS_GLYPH: Record<ChartStatusLevel, string> = {
  good: '✓',
  warning: '!',
  serious: '▲',
  critical: '✕',
}

/** Direction against intent — not the raw sign of the number. */
export function deltaIsGood(
  direction: 'up' | 'down' | 'flat',
  goodDirection: 'up' | 'down',
): boolean | 'neutral' {
  if (direction === 'flat') return 'neutral'
  return direction === goodDirection
}

export function StatTile({
  label,
  value,
  delta,
  deltaContext,
  spark,
  sparkSlot = 1,
  status,
  hint,
}: StatTileProps) {
  return (
    <article className={styles.tile}>
      <p className={styles.label}>{label}</p>
      <p className={styles.value}>{value}</p>

      <div className={styles.meta}>
        {delta ? (
          <span
            className={styles.delta}
            style={{ color: deltaTextColor(deltaIsGood(delta.direction, delta.goodDirection)) }}
          >
            <span className={styles.deltaGlyph} aria-hidden="true">
              {DELTA_GLYPH[delta.direction]}
            </span>
            {delta.value}
          </span>
        ) : null}
        {deltaContext ? <span className={styles.context}>{deltaContext}</span> : null}
      </div>

      {status ? (
        <p className={styles.status}>
          <span className={styles.statusGlyph} style={{ color: statusColor(status.level) }} aria-hidden="true">
            {STATUS_GLYPH[status.level]}
          </span>
          <span className={styles.statusLabel}>{status.label}</span>
        </p>
      ) : null}

      {spark && spark.length > 0 ? (
        <div className={styles.spark}>
          <SparkBar values={spark} slot={sparkSlot} ariaLabel={`${label} trend`} />
        </div>
      ) : null}

      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </article>
  )
}
