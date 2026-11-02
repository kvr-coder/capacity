/**
 * The scenario bridge: what turned the baseline number into this one.
 *
 * Anchors are absolute totals drawn from zero in the de-emphasis grey; the
 * steps between them are deltas drawn from the running total. Delta colour is
 * polarity read through intent — `higherIsBetter` decides which direction is
 * cool and which is warm — and every delta also carries a glyph and a signed
 * label, so the direction survives without colour.
 *
 * Connectors are hairlines at each running total, which is what makes a
 * waterfall readable: the eye follows the ledge, not the bars.
 */

import { useRef, useState } from 'react'
import { at, clamp } from '@/domain/lookup'
import { niceTicks } from '@/lib/format'
import { OTHER, divergingColor } from '@/charts/palette'
import { ChartEmpty } from '@/charts/ChartCard'
import { Tooltip } from '@/charts/Tooltip'
import { CHART, RoundedBar, XAxis, YAxis, nearestIndex, useChartSize, verticalBarGeom } from '@/charts/primitives'
import type { WaterfallChartProps, WaterfallStep } from '@/charts/types'
import styles from '@/charts/WaterfallChart.module.css'

const PAD = { top: 24, right: 18, bottom: 42, left: 64 }

interface Placed {
  step: WaterfallStep
  from: number
  to: number
  /** True when the bar improves the outcome, given `higherIsBetter`. */
  good: boolean
}

export function WaterfallChart({
  steps,
  format,
  height = 280,
  higherIsBetter = false,
}: WaterfallChartProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const width = useChartSize(frame, 640)
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)

  if (steps.length === 0) {
    return <ChartEmpty height={height} message="No steps in this bridge" />
  }

  const placed = place(steps, higherIsBetter)
  let low = 0
  let high = 0
  for (const bar of placed) {
    low = Math.min(low, bar.from, bar.to)
    high = Math.max(high, bar.from, bar.to)
  }
  const top = Math.max(at(niceTicks(Math.max(high, 0)), niceTicks(Math.max(high, 0)).length - 1, 'tick'), 0)
  const bottomTicks = niceTicks(Math.max(-low, 0))
  const bottom = low < 0 ? -at(bottomTicks, bottomTicks.length - 1, 'tick') : 0
  const span = Math.max(top - bottom, 1e-9)
  const ticks = [
    ...bottomTicks.filter((tick) => tick > 0).map((tick) => -tick).reverse(),
    ...niceTicks(Math.max(top, 0)),
  ]

  const plotLeft = PAD.left
  const plotRight = Math.max(plotLeft + 1, width - PAD.right)
  const plotWidth = plotRight - plotLeft
  const plotTop = PAD.top
  const plotBottom = height - PAD.bottom
  const plotHeight = Math.max(1, plotBottom - plotTop)
  const band = plotWidth / placed.length

  const scaleX = (index: number): number => plotLeft + (index + 0.5) * band
  const scaleY = (value: number): number =>
    plotBottom - ((clamp(value, bottom, top) - bottom) / span) * plotHeight
  const thickness = Math.min(CHART.BAR_MAX_THICKNESS, band * 0.6)

  const active = hover ?? focus
  const activeBar = active === null ? null : at(placed, active, 'waterfall step')

  return (
    <div className={styles.wrap}>
      <div className={styles.frame} ref={frame}>
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
          role="img"
          aria-label={`Bridge of ${placed.length} steps`}
          tabIndex={0}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setHover(nearestIndex(event.clientX - box.left, plotLeft, band, placed.length))
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setFocus((prior) => prior ?? 0)}
          onBlur={() => setFocus(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault()
              setFocus((prior) =>
                clamp((prior ?? 0) + (event.key === 'ArrowRight' ? 1 : -1), 0, placed.length - 1),
              )
            }
          }}
        >
          <YAxis ticks={ticks} scaleY={scaleY} x={plotLeft - 10} format={format} gridTo={plotRight} />

          <line
            x1={plotLeft}
            x2={plotRight}
            y1={scaleY(0)}
            y2={scaleY(0)}
            stroke="var(--axis)"
            strokeWidth={1}
            shapeRendering="crispEdges"
            aria-hidden="true"
          />

          <g aria-hidden="true">
            {placed.map((bar, index) => {
              if (index === placed.length - 1) return null
              const next = at(placed, index + 1, 'waterfall step')
              if (next.step.anchor) return null
              const ledge = scaleY(bar.to)
              return (
                <line
                  key={`connector-${bar.step.id}`}
                  x1={scaleX(index) + thickness / 2}
                  x2={scaleX(index + 1) - thickness / 2}
                  y1={ledge}
                  y2={ledge}
                  stroke="var(--gridline)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
              )
            })}
          </g>

          {placed.map((bar, index) => {
            const geom = verticalBarGeom(scaleX(index), thickness, scaleY(bar.from), scaleY(bar.to))
            const fill = bar.step.anchor ? OTHER : divergingColor(bar.good ? -0.75 : 0.75)
            const labelY = Math.min(scaleY(bar.from), scaleY(bar.to)) - 7
            const delta = bar.to - bar.from
            return (
              <g key={bar.step.id}>
                <RoundedBar {...geom} fill={fill} opacity={active === index ? 1 : 0.92} />
                <text className={styles.valueLabel} x={scaleX(index)} y={labelY} textAnchor="middle">
                  {bar.step.anchor ? format(bar.to) : `${signGlyph(delta)} ${format(Math.abs(delta))}`}
                </text>
              </g>
            )
          })}

          <XAxis
            categories={placed.map((bar) => bar.step.label)}
            scaleX={scaleX}
            y={plotBottom + 10}
            width={plotWidth}
            label={(category) => category}
          />
        </svg>

        {activeBar !== null && active !== null ? (
          <Tooltip
            title={activeBar.step.label}
            subtitle={activeBar.step.anchor ? 'Total' : 'Change'}
            x={scaleX(active)}
            y={plotTop + plotHeight / 2}
            containerWidth={width}
            containerHeight={height}
            live={hover === null}
            rows={
              activeBar.step.anchor
                ? [{ label: 'Total', value: format(activeBar.to), emphasis: true }]
                : [
                    { label: 'Change', value: format(activeBar.to - activeBar.from), emphasis: true },
                    { label: 'Running total', value: format(activeBar.to) },
                  ]
            }
          />
        ) : null}
      </div>
      <p className={styles.note}>
        {higherIsBetter ? 'Cool bars raise the outcome.' : 'Cool bars lower the outcome.'} Anchors are
        absolute totals.
      </p>
    </div>
  )
}

function signGlyph(delta: number): string {
  if (delta > 0) return '▲'
  if (delta < 0) return '▼'
  return '—'
}

/** Running-total placement: anchors reset the ledge, deltas ride it. */
function place(steps: readonly WaterfallStep[], higherIsBetter: boolean): Placed[] {
  const placed: Placed[] = []
  let running = 0
  for (const step of steps) {
    const value = Number.isFinite(step.value) ? step.value : 0
    if (step.anchor) {
      placed.push({ step, from: 0, to: value, good: true })
      running = value
      continue
    }
    const to = running + value
    placed.push({ step, from: running, to, good: higherIsBetter ? value >= 0 : value <= 0 })
    running = to
  }
  return placed
}
