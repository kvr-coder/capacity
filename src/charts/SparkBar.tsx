/**
 * A sparkline made of bars rather than a line, because these sit next to a
 * number and a bar reads as "a quantity per bucket" at 24px tall where a 2px
 * line reads as noise.
 *
 * `accentLast` is the house pattern for a tile: the history sits in the
 * de-emphasis grey and only the current bucket takes the accent, so the eye
 * lands on now and the shape gives it context. The bars keep a surface gap
 * between them; they never touch.
 */

import { at } from '@/domain/lookup'
import { OTHER, seriesColor } from '@/charts/palette'
import { CHART, RoundedBar, verticalBarGeom } from '@/charts/primitives'
import type { SparkBarProps } from '@/charts/types'
import styles from '@/charts/SparkBar.module.css'

export function SparkBar({
  values,
  slot = 1,
  width = 76,
  height = 26,
  accentLast = true,
  signed = false,
  ariaLabel,
}: SparkBarProps) {
  const n = values.length
  if (n === 0) {
    return <span className={styles.empty} style={{ width, height }} aria-hidden="true" />
  }

  const gap = n > 1 ? CHART.GAP : 0
  const band = (width - gap * (n - 1)) / n
  const thickness = Math.max(2, band)

  let peak = 0
  for (const value of values) {
    if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value))
  }
  const span = peak === 0 ? 1 : peak

  const baselineY = signed ? height / 2 : height
  const reach = signed ? height / 2 : height
  const accent = seriesColor(slot)

  return (
    <svg
      className={styles.spark}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? `Trend over the last ${n} buckets`}
    >
      {signed ? (
        <line
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
          stroke="var(--gridline)"
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
      ) : null}
      {values.map((raw, index) => {
        const value = Number.isFinite(raw) ? raw : 0
        const centre = index * (band + gap) + band / 2
        const magnitude = (value / span) * reach
        const valueY = signed ? baselineY - magnitude : baselineY - Math.abs(magnitude)
        const geom = verticalBarGeom(centre, thickness, baselineY, valueY)
        const isLast = index === n - 1
        const fill = accentLast ? (isLast ? accent : OTHER) : accent
        return (
          <RoundedBar
            key={`${index}-${at(values, index, 'spark value')}`}
            {...geom}
            fill={fill}
            opacity={accentLast && !isLast ? 0.45 : 1}
          />
        )
      })}
    </svg>
  )
}
