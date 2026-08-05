/**
 * OEE over time — and, when `onEndValueChange` is supplied, an input rather
 * than only a readout.
 *
 * A glide path is a proposal: "this line reaches 78% by week 40". The planner
 * arguing with that number should be able to grab the end of the curve and move
 * it, which is why the handle is a real control — pointer drag, arrow keys at
 * 0.01, PageUp/PageDown at 0.05, and a 28px hit circle around a 6px mark so the
 * target is never smaller than a fingertip.
 *
 * The before/after pair is the other half of the idea: two series, so a planner
 * sees what the proposal changes rather than only where it lands. Two series
 * means the legend is mandatory.
 *
 * One y-axis, always: OEE 0..1 shown as a percentage.
 */

import { useMemo, useRef, useState } from 'react'
import { at, clamp } from '@/domain/lookup'
import { pct } from '@/lib/format'
import { seriesColor } from '@/charts/palette'
import { ChartEmpty } from '@/charts/ChartCard'
import { Legend } from '@/charts/Legend'
import { Tooltip } from '@/charts/Tooltip'
import {
  CHART,
  PlotSurfaceRing,
  XAxis,
  YAxis,
  nearestIndex,
  useChartSize,
} from '@/charts/primitives'
import type { GlideCurveProps, GlideRamp, SeriesMeta, TooltipRow } from '@/charts/types'
import styles from '@/charts/GlideCurve.module.css'

const PAD = { top: 22, right: 22, bottom: 32, left: 56 }
const KEY_STEP = 0.01
const PAGE_STEP = 0.05
const HANDLE_RADIUS = 6

export function GlideCurve({
  weeks,
  series,
  ramp,
  height = 260,
  yMin,
  yMax,
  endValue,
  endValueBounds,
  onEndValueChange,
  onWeekClick,
  weekLabel,
  emptyMessage,
}: GlideCurveProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const width = useChartSize(frame, 640)
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const resolvedRamp: GlideRamp | undefined = useMemo(() => {
    if (ramp) return ramp
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const candidate = series[index]?.ramp
      if (candidate) return candidate
    }
    return undefined
  }, [ramp, series])

  const domain = useMemo(() => {
    let low = 1
    let high = 0
    for (const entry of series) {
      for (const value of entry.values) {
        if (!Number.isFinite(value)) continue
        low = Math.min(low, value)
        high = Math.max(high, value)
      }
    }
    if (endValue !== undefined && Number.isFinite(endValue)) {
      low = Math.min(low, endValue)
      high = Math.max(high, endValue)
    }
    if (low > high) {
      low = 0
      high = 1
    }
    const min = yMin ?? clamp(Math.floor((low - 0.06) * 20) / 20, 0, 1)
    const max = yMax ?? clamp(Math.ceil((high + 0.06) * 20) / 20, 0, 1)
    const span = Math.max(max - min, 0.05)
    return { min, max: min + span, span }
  }, [series, endValue, yMin, yMax])

  if (weeks.length === 0 || series.length === 0) {
    return <ChartEmpty height={height} message={emptyMessage ?? 'No OEE history in this slice'} />
  }

  const plotLeft = PAD.left
  const plotRight = Math.max(plotLeft + 1, width - PAD.right)
  const plotWidth = plotRight - plotLeft
  const plotTop = PAD.top
  const plotBottom = height - PAD.bottom
  const plotHeight = Math.max(1, plotBottom - plotTop)
  const band = plotWidth / weeks.length

  const scaleX = (index: number): number => plotLeft + (index + 0.5) * band
  const scaleY = (value: number): number =>
    plotBottom - ((clamp(value, domain.min, domain.max) - domain.min) / domain.span) * plotHeight
  const valueAtY = (y: number): number =>
    domain.min + ((plotBottom - y) / plotHeight) * domain.span

  const bounds = endValueBounds ?? { min: 0, max: 1 }
  const draggable = onEndValueChange !== undefined && endValue !== undefined && resolvedRamp !== undefined

  const commit = (raw: number): void => {
    if (!onEndValueChange) return
    onEndValueChange(clamp(Math.round(raw * 200) / 200, bounds.min, bounds.max))
  }
  const nudge = (delta: number): void => {
    if (!onEndValueChange || endValue === undefined) return
    onEndValueChange(clamp(Math.round((endValue + delta) * 1000) / 1000, bounds.min, bounds.max))
  }

  const active = hover ?? focus
  const legendSeries: SeriesMeta[] = series.map((entry) => ({
    id: entry.id,
    label: entry.label,
    slot: entry.slot,
    markShape: 'line',
  }))

  const handleWeek = resolvedRamp === undefined ? null : clamp(resolvedRamp.toWeek, 0, weeks.length - 1)
  const handleX = handleWeek === null ? 0 : scaleX(handleWeek)
  const handleY = endValue === undefined ? 0 : scaleY(endValue)

  return (
    <div className={styles.wrap}>
      <div className={styles.frame} ref={frame}>
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
          role="img"
          aria-label={`OEE over ${weeks.length} weeks, ${series.length} series`}
          tabIndex={0}
          onPointerMove={(event) => {
            if (dragging) return
            const box = event.currentTarget.getBoundingClientRect()
            setHover(nearestIndex(event.clientX - box.left, plotLeft, band, weeks.length))
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setFocus((prior) => prior ?? 0)}
          onBlur={() => setFocus(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault()
              setFocus((prior) =>
                clamp((prior ?? 0) + (event.key === 'ArrowRight' ? 1 : -1), 0, weeks.length - 1),
              )
            } else if ((event.key === 'Enter' || event.key === ' ') && onWeekClick && focus !== null) {
              event.preventDefault()
              onWeekClick(focus)
            }
          }}
          onClick={() => {
            if (onWeekClick && hover !== null) onWeekClick(hover)
          }}
        >
          {resolvedRamp ? (
            <g aria-hidden="true">
              <rect
                className={styles.rampBand}
                x={scaleX(clamp(resolvedRamp.fromWeek, 0, weeks.length - 1)) - band / 2}
                y={plotTop}
                width={Math.max(
                  band,
                  (clamp(resolvedRamp.toWeek, 0, weeks.length - 1) -
                    clamp(resolvedRamp.fromWeek, 0, weeks.length - 1) +
                    1) *
                    band,
                )}
                height={plotHeight}
              />
              <text
                className={styles.rampLabel}
                x={scaleX(clamp(resolvedRamp.fromWeek, 0, weeks.length - 1)) - band / 2 + 6}
                y={plotTop - 7}
              >
                {resolvedRamp.label ?? 'Ramp window'}
              </text>
            </g>
          ) : null}

          <YAxis
            ticks={ticksFor(domain.min, domain.max)}
            scaleY={scaleY}
            x={plotLeft - 10}
            format={(value) => pct(value, 0)}
            gridTo={plotRight}
          />

          {endValue !== undefined && resolvedRamp ? (
            <line
              className={styles.targetRule}
              x1={scaleX(clamp(resolvedRamp.fromWeek, 0, weeks.length - 1))}
              x2={handleX}
              y1={handleY}
              y2={handleY}
              shapeRendering="crispEdges"
              aria-hidden="true"
            />
          ) : null}

          {series.map((entry) => (
            <g key={entry.id}>
              <path
                d={linePath(entry.values, scaleX, scaleY)}
                fill="none"
                stroke={seriesColor(entry.slot)}
                strokeWidth={CHART.LINE_WIDTH}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {markerPoints(entry.ramp ?? resolvedRamp, entry.values, weeks.length).map((point) => (
                <PlotSurfaceRing
                  key={`${entry.id}-${point.index}`}
                  cx={scaleX(point.index)}
                  cy={scaleY(point.value)}
                  fill={seriesColor(entry.slot)}
                />
              ))}
            </g>
          ))}

          {active !== null ? (
            <g aria-hidden="true">
              <line
                x1={scaleX(active)}
                x2={scaleX(active)}
                y1={plotTop}
                y2={plotBottom}
                stroke="var(--axis)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {series.map((entry) => {
                const value = entry.values[active]
                if (value === undefined || !Number.isFinite(value)) return null
                return (
                  <PlotSurfaceRing
                    key={entry.id}
                    cx={scaleX(active)}
                    cy={scaleY(value)}
                    fill={seriesColor(entry.slot)}
                  />
                )
              })}
            </g>
          ) : null}

          <XAxis
            categories={weeks}
            scaleX={scaleX}
            y={plotBottom + 10}
            width={plotWidth}
            label={(week, index) => (weekLabel ? weekLabel(week, index) : shortWeek(week))}
          />

          {draggable && endValue !== undefined ? (
            <g
              className={styles.handle}
              role="slider"
              tabIndex={0}
              aria-label="Glide path end value"
              aria-valuemin={bounds.min}
              aria-valuemax={bounds.max}
              aria-valuenow={endValue}
              aria-valuetext={pct(endValue)}
              onKeyDown={(event) => {
                const key = event.key
                if (key === 'ArrowUp' || key === 'ArrowRight') {
                  event.preventDefault()
                  event.stopPropagation()
                  nudge(KEY_STEP)
                } else if (key === 'ArrowDown' || key === 'ArrowLeft') {
                  event.preventDefault()
                  event.stopPropagation()
                  nudge(-KEY_STEP)
                } else if (key === 'PageUp') {
                  event.preventDefault()
                  nudge(PAGE_STEP)
                } else if (key === 'PageDown') {
                  event.preventDefault()
                  nudge(-PAGE_STEP)
                } else if (key === 'Home') {
                  event.preventDefault()
                  commit(bounds.min)
                } else if (key === 'End') {
                  event.preventDefault()
                  commit(bounds.max)
                }
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
                event.currentTarget.setPointerCapture(event.pointerId)
                setDragging(true)
              }}
              onPointerMove={(event) => {
                if (!dragging) return
                event.stopPropagation()
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                if (!box) return
                commit(valueAtY(event.clientY - box.top))
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId)
                setDragging(false)
              }}
              onPointerCancel={() => setDragging(false)}
            >
              {/* 28px transparent target around a 12px mark. */}
              <circle className={styles.hit} cx={handleX} cy={handleY} r={CHART.HIT_TARGET / 2 + 2} />
              <circle
                className={styles.handleMark}
                cx={handleX}
                cy={handleY}
                r={HANDLE_RADIUS}
                fill={seriesColor(at(series, series.length - 1, 'series').slot)}
              />
              <text className={styles.handleLabel} x={handleX} y={handleY - 14} textAnchor="middle">
                {pct(endValue)}
              </text>
            </g>
          ) : null}
        </svg>

        {active !== null ? (
          <Tooltip
            title={at(weeks, active, 'week')}
            subtitle="Resolved OEE"
            x={scaleX(active)}
            y={plotTop + plotHeight / 2}
            containerWidth={width}
            containerHeight={height}
            live={hover === null}
            rows={series.map<TooltipRow>((entry) => {
              const value = entry.values[active]
              return {
                label: entry.label,
                value: value === undefined || !Number.isFinite(value) ? '—' : pct(value),
                slot: entry.slot,
              }
            })}
          />
        ) : null}
      </div>

      {series.length >= 2 ? (
        <div className={styles.legend}>
          <Legend series={legendSeries} />
        </div>
      ) : null}
      {draggable ? (
        <p className={styles.hint}>
          Drag the end handle, or focus it and use the arrow keys, to change the target OEE.
        </p>
      ) : null}
    </div>
  )
}

function shortWeek(week: string): string {
  const dash = week.indexOf('-')
  return dash === -1 ? week : week.slice(dash + 1)
}

function linePath(
  values: readonly number[],
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string {
  const parts: string[] = []
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${scaleX(index)},${scaleY(value)}`)
  })
  return parts.join('')
}

/** The two marked points: where the ramp starts and where it lands. */
function markerPoints(
  ramp: GlideRamp | undefined,
  values: readonly number[],
  weekCount: number,
): Array<{ index: number; value: number }> {
  if (ramp === undefined || weekCount === 0) return []
  const out: Array<{ index: number; value: number }> = []
  for (const week of [ramp.fromWeek, ramp.toWeek]) {
    const index = clamp(week, 0, weekCount - 1)
    const value = values[index]
    if (value !== undefined && Number.isFinite(value)) out.push({ index, value })
  }
  return out
}

/** Percentage ticks on a round step, sized to the visible span. */
function ticksFor(min: number, max: number): number[] {
  const span = max - min
  const step = span > 0.5 ? 0.1 : span > 0.24 ? 0.05 : 0.02
  const ticks: number[] = []
  const start = Math.ceil(min / step - 1e-9) * step
  for (let value = start; value <= max + step * 1e-3; value += step) {
    ticks.push(Number(value.toFixed(4)))
  }
  return ticks
}
