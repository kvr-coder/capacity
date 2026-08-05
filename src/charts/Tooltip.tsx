/**
 * Hover / focus readout.
 *
 * It enhances, it never gates: everything in here is also in the card's table
 * twin. It is transparent to the pointer so it can never eat the hit target it
 * is describing, and it measures itself so it flips rather than clipping at the
 * right or bottom edge of the plot.
 *
 * Keyboard focus renders exactly the same card as hover, with `live` set so a
 * screen reader hears the value when focus moves between marks.
 */

import { useRef, useState } from 'react'
import { clamp } from '@/domain/lookup'
import { useIsomorphicLayoutEffect } from '@/charts/primitives'
import { seriesColor, statusColor } from '@/charts/palette'
import type { ChartStatusLevel, TooltipProps } from '@/charts/types'
import styles from '@/charts/Tooltip.module.css'

const STATUS_GLYPH: Record<ChartStatusLevel, string> = {
  good: '✓',
  warning: '!',
  serious: '▲',
  critical: '✕',
}

/** Clearance between the anchor point and the card, both axes. */
const OFFSET = 14

export function Tooltip({
  title,
  subtitle,
  rows,
  x,
  y,
  containerWidth,
  containerHeight,
  children,
  live,
}: TooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 200, height: 96 })

  // Measured rather than estimated, so the card flips on its real box. The
  // observer keeps that true when the rows change under a moving pointer.
  useIsomorphicLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      const next = { width: element.offsetWidth, height: element.offsetHeight }
      setSize((prior) =>
        prior.width === next.width && prior.height === next.height ? prior : next,
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const flipX = x + OFFSET + size.width > containerWidth && x - OFFSET - size.width >= 0
  const left = clamp(
    flipX ? x - OFFSET - size.width : x + OFFSET,
    0,
    Math.max(0, containerWidth - size.width),
  )
  const rawTop = y - size.height / 2
  const top =
    containerHeight === undefined
      ? Math.max(0, rawTop)
      : clamp(rawTop, 0, Math.max(0, containerHeight - size.height))

  return (
    <div
      ref={ref}
      className={styles.tooltip}
      style={{ left, top }}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
    >
      <p className={styles.title}>{title}</p>
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      {rows.length > 0 ? (
        <dl className={styles.rows}>
          {rows.map((row, index) => (
            <div
              key={`${row.label}#${index}`}
              className={row.emphasis ? `${styles.row} ${styles.emphasis}` : styles.row}
            >
              <dt className={styles.label}>
                {row.slot === undefined ? null : (
                  <span
                    className={styles.mark}
                    style={{ background: seriesColor(row.slot) }}
                    aria-hidden="true"
                  />
                )}
                {row.status === undefined ? null : (
                  <span className={styles.statusGlyph} style={{ color: statusColor(row.status) }}>
                    {STATUS_GLYPH[row.status]}
                  </span>
                )}
                {row.label}
              </dt>
              <dd className={styles.value}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children ? <div className={styles.extra}>{children}</div> : null}
    </div>
  )
}
