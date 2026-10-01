/**
 * A limit rail.
 *
 * The track always spans 0..1.25 with the limit tick fixed at 1, so two meters
 * side by side are directly comparable — a rail that rescales to its own value
 * makes 140% and 105% look identical, which is the opposite of the point.
 *
 * Everything past the limit is drawn as a separate segment with the house 2px
 * surface gap in front of it rather than a border stroke, and escalation always
 * arrives as a glyph plus a word, never as colour alone.
 */

import { useRef } from 'react'
import { clamp } from '@/domain/lookup'
import { SEQ_TRACK, seriesColor, statusColor } from '@/charts/palette'
import { CHART, roundedBarPath, useChartSize } from '@/charts/primitives'
import { STATUS_GLYPH } from '@/charts/StatTile'
import type { ChartStatusLevel, MeterProps } from '@/charts/types'
import styles from '@/charts/Meter.module.css'

/** The rail runs to 1.25 so an overload has somewhere to go. */
const RAIL_MAX = 1.25
const RAIL_HEIGHT = 8

export function Meter({ label, ratio, valueLabel, limitLabel, thresholds, slot = 1 }: MeterProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const width = useChartSize(frame, 240)
  const safe = Number.isFinite(ratio) ? Math.max(0, ratio) : 0

  const level = escalation(safe, thresholds)
  const fill = level === null ? seriesColor(slot) : statusColor(level)

  const scale = (value: number): number => (clamp(value, 0, RAIL_MAX) / RAIL_MAX) * width
  const limitX = scale(1)
  const underEnd = scale(Math.min(safe, 1))
  const overStart = limitX + CHART.GAP
  const overEnd = scale(safe)
  const showOver = safe > 1 && overEnd > overStart
  const clipped = safe > RAIL_MAX

  return (
    <div className={styles.meter}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{valueLabel}</span>
      </div>

      <div className={styles.frame} ref={frame}>
        <svg
          className={styles.rail}
          width={width}
          height={RAIL_HEIGHT}
          viewBox={`0 0 ${Math.max(width, 1)} ${RAIL_HEIGHT}`}
          role="img"
          aria-label={`${label}: ${valueLabel}${limitLabel ? ` of ${limitLabel}` : ''}`}
        >
          <rect x={0} y={0} width={width} height={RAIL_HEIGHT} rx={2} fill={SEQ_TRACK} opacity={0.5} />
          {underEnd > 0 ? (
            <path
              d={roundedBarPath(0, 0, underEnd, RAIL_HEIGHT, 'right', safe >= 1 ? 0 : CHART.BAR_RADIUS)}
              fill={fill}
            />
          ) : null}
          {showOver ? (
            <path
              d={roundedBarPath(
                overStart,
                0,
                overEnd - overStart,
                RAIL_HEIGHT,
                'right',
                clipped ? 0 : CHART.BAR_RADIUS,
              )}
              fill={statusColor('critical')}
            />
          ) : null}
          {/* The limit tick is chrome, not a mark: a hairline, full height. */}
          <line
            x1={limitX}
            x2={limitX}
            y1={-2}
            y2={RAIL_HEIGHT + 2}
            stroke="var(--axis)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        </svg>
      </div>

      <div className={styles.foot}>
        {limitLabel ? <span className={styles.limit}>{limitLabel}</span> : <span />}
        {level === null ? null : (
          <span className={styles.status}>
            <span className={styles.statusGlyph} style={{ color: statusColor(level) }} aria-hidden="true">
              {STATUS_GLYPH[level]}
            </span>
            {level === 'critical' ? 'Over limit' : 'Near limit'}
          </span>
        )}
      </div>
    </div>
  )
}

function escalation(
  ratio: number,
  thresholds: MeterProps['thresholds'],
): ChartStatusLevel | null {
  const limits = thresholds ?? { warning: 0.9, critical: 1 }
  if (ratio >= limits.critical) return 'critical'
  if (ratio >= limits.warning) return 'warning'
  return null
}
