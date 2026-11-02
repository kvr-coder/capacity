/**
 * Multi-series line chart on a single y-axis.
 *
 * One scale, always — a second axis lets any two shapes be made to agree, which
 * is exactly what a planner must not be able to do by accident. Lines are 2px,
 * markers appear only at the hovered or focused bucket (a dot on every point in
 * an 18-month series is noise), and every dot carries a 2px surface ring so two
 * series crossing stay separable without a border stroke.
 *
 * A month missing from a series breaks the line rather than interpolating
 * across it: a gap in a plan is information.
 */

import { useMemo, useRef, useState } from 'react'
import { at, clamp } from '@/domain/lookup'
import { compact, monthLong, niceTicks } from '@/lib/format'
import { OTHER, seriesColor } from '@/charts/palette'
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
import type { LineChartProps, SeriesMeta, TimeSeries, TooltipRow } from '@/charts/types'
import styles from '@/charts/LineChart.module.css'

const PAD = { top: 12, right: 18, bottom: 30, left: 56 }
const DIRECT_LABEL_ROOM = 62

export function LineChart({
  series,
  height = 240,
  format = compact,
  yLabel,
  yMax,
  directLabels = false,
  highlightMonths,
  onMonthClick,
}: LineChartProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const width = useChartSize(frame, 640)
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  const months = useMemo(() => collectMonths(series), [series])
  const lookup = useMemo(() => buildLookup(series), [series])

  const domain = useMemo(() => {
    let min = 0
    let max = 0
    for (const row of lookup) {
      for (const value of row) {
        if (value === null) continue
        min = Math.min(min, value)
        max = Math.max(max, value)
      }
    }
    return resolveDomain(min, max, yMax)
  }, [lookup, yMax])

  if (months.length === 0 || series.length === 0) {
    return <ChartEmpty height={height} message="No series in this slice" />
  }

  const right = PAD.right + (directLabels ? DIRECT_LABEL_ROOM : 0)
  const plotLeft = PAD.left
  const plotRight = Math.max(plotLeft + 1, width - right)
  const plotWidth = plotRight - plotLeft
  const plotTop = PAD.top
  const plotBottom = height - PAD.bottom
  const plotHeight = Math.max(1, plotBottom - plotTop)
  const band = plotWidth / months.length

  const scaleX = (index: number): number => plotLeft + (index + 0.5) * band
  const scaleY = (value: number): number =>
    plotBottom - ((clamp(value, domain.min, domain.max) - domain.min) / domain.span) * plotHeight

  const active = hover ?? focus
  const legendSeries: SeriesMeta[] = series.map((entry) => ({
    id: entry.id,
    label: entry.label,
    slot: entry.reference ? 'other' : entry.slot,
    markShape: 'line',
  }))

  const activeMonth = active === null ? null : at(months, active, 'month')

  return (
    <div className={styles.wrap}>
      <div className={styles.frame} ref={frame}>
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
          role="img"
          aria-label={`${yLabel ?? 'Value'} over ${months.length} buckets, ${series.length} series`}
          tabIndex={0}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setHover(nearestIndex(event.clientX - box.left, plotLeft, band, months.length))
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setFocus((prior) => prior ?? 0)}
          onBlur={() => setFocus(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault()
              setFocus((prior) =>
                clamp((prior ?? 0) + (event.key === 'ArrowRight' ? 1 : -1), 0, months.length - 1),
              )
            } else if (event.key === 'Home') {
              event.preventDefault()
              setFocus(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              setFocus(months.length - 1)
            } else if ((event.key === 'Enter' || event.key === ' ') && onMonthClick && focus !== null) {
              event.preventDefault()
              onMonthClick(at(months, focus, 'month'))
            }
          }}
          onClick={() => {
            if (onMonthClick && hover !== null) onMonthClick(at(months, hover, 'month'))
          }}
        >
          {highlightMonths && highlightMonths.length > 0 ? (
            <g aria-hidden="true">
              {highlightBands(months, highlightMonths).map((run) => (
                <rect
                  key={`${run.from}-${run.to}`}
                  x={scaleX(run.from) - band / 2}
                  y={plotTop}
                  width={band * (run.to - run.from + 1)}
                  height={plotHeight}
                  fill="var(--surface-sunken)"
                />
              ))}
            </g>
          ) : null}

          <YAxis
            ticks={domain.ticks}
            scaleY={scaleY}
            x={plotLeft - 10}
            format={format}
            gridTo={plotRight}
          />

          {domain.min < 0 ? (
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={scaleY(0)}
              y2={scaleY(0)}
              stroke="var(--axis)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ) : null}

          {series.map((entry, seriesIndex) => {
            const values = at(lookup, seriesIndex, 'series values')
            const stroke = entry.reference ? OTHER : seriesColor(entry.slot)
            const dimmed = activeId !== null && activeId !== entry.id
            const showArea = entry.area === true && series.length === 1
            return (
              <g key={entry.id} opacity={dimmed ? 0.28 : 1}>
                {showArea
                  ? areaPaths(values, scaleX, scaleY, plotBottom).map((d, index) => (
                      <path key={index} d={d} fill={stroke} opacity={0.1} />
                    ))
                  : null}
                {linePaths(values, scaleX, scaleY).map((d, index) => (
                  <path
                    key={index}
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={entry.reference ? 1 : CHART.LINE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            )
          })}

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
              {series.map((entry, seriesIndex) => {
                const value = at(lookup, seriesIndex, 'series values')[active]
                if (value === undefined || value === null) return null
                return (
                  <PlotSurfaceRing
                    key={entry.id}
                    cx={scaleX(active)}
                    cy={scaleY(value)}
                    fill={entry.reference ? OTHER : seriesColor(entry.slot)}
                  />
                )
              })}
            </g>
          ) : null}

          {directLabels
            ? series.map((entry, seriesIndex) => {
                const values = at(lookup, seriesIndex, 'series values')
                const last = lastDefined(values)
                if (last === null) return null
                return (
                  <text
                    key={entry.id}
                    className={styles.directLabel}
                    x={scaleX(last.index) + 10}
                    y={scaleY(last.value)}
                    dominantBaseline="middle"
                  >
                    {format(last.value)}
                  </text>
                )
              })
            : null}

          <XAxis categories={months} scaleX={scaleX} y={plotBottom + 10} width={plotWidth} />

          {yLabel ? (
            <text className={styles.axisLabel} x={0} y={plotTop - 2}>
              {yLabel}
            </text>
          ) : null}
        </svg>

        {activeMonth !== null && active !== null ? (
          <Tooltip
            title={monthLong(activeMonth)}
            x={scaleX(active)}
            y={plotTop + plotHeight / 2}
            containerWidth={width}
            containerHeight={height}
            live={hover === null}
            rows={series.map<TooltipRow>((entry, seriesIndex) => {
              const value = at(lookup, seriesIndex, 'series values')[active]
              return {
                label: entry.label,
                value: value === undefined || value === null ? '—' : format(value),
                slot: entry.reference ? 'other' : entry.slot,
              }
            })}
          />
        ) : null}
      </div>

      {series.length >= 2 ? (
        <div className={styles.legend}>
          <Legend series={legendSeries} activeId={activeId} onHover={setActiveId} />
        </div>
      ) : null}
    </div>
  )
}

// --- shaping ---------------------------------------------------------------

function collectMonths(series: readonly TimeSeries[]): string[] {
  const seen = new Set<string>()
  for (const entry of series) {
    for (const point of entry.points) seen.add(point.month)
  }
  return Array.from(seen).sort()
}

/** One row per series, aligned to the shared month axis; `null` is a gap. */
function buildLookup(series: readonly TimeSeries[]): Array<Array<number | null>> {
  const months = collectMonths(series)
  return series.map((entry) => {
    const byMonth = new Map<string, number>()
    for (const point of entry.points) {
      if (Number.isFinite(point.value)) byMonth.set(point.month, point.value)
    }
    return months.map((month) => byMonth.get(month) ?? null)
  })
}

interface Domain {
  min: number
  max: number
  span: number
  ticks: number[]
}

function resolveDomain(dataMin: number, dataMax: number, forcedMax?: number): Domain {
  const positive = niceTicks(Math.max(dataMax, 0))
  const top = forcedMax ?? Math.max(at(positive, positive.length - 1, 'tick'), 0)
  if (dataMin >= 0) {
    const ticks = forcedMax === undefined ? positive : niceTicks(top)
    return { min: 0, max: Math.max(top, 1e-9), span: Math.max(top, 1e-9), ticks }
  }
  const negative = niceTicks(-dataMin)
  const bottom = -at(negative, negative.length - 1, 'tick')
  const ticks = [
    ...negative
      .filter((tick) => tick > 0)
      .map((tick) => -tick)
      .reverse(),
    ...positive,
  ]
  const span = Math.max(top - bottom, 1e-9)
  return { min: bottom, max: top, span, ticks }
}

function linePaths(
  values: ReadonlyArray<number | null>,
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string[] {
  const paths: string[] = []
  let current: string[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 1) paths.push(current.join(''))
      current = []
      return
    }
    const command = current.length === 0 ? 'M' : 'L'
    current.push(`${command}${scaleX(index)},${scaleY(value)}`)
  })
  if (current.length > 1) paths.push(current.join(''))
  else if (current.length === 1) {
    // A lone point still deserves ink: a 0-length line with a round cap.
    paths.push(`${current[0] ?? ''}${current[0]?.replace('M', 'L') ?? ''}`)
  }
  return paths
}

function areaPaths(
  values: ReadonlyArray<number | null>,
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
  baselineY: number,
): string[] {
  const paths: string[] = []
  let run: number[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const first = at(run, 0, 'run start')
    const last = at(run, run.length - 1, 'run end')
    const top = run
      .map((index) => {
        const value = values[index]
        return value === undefined || value === null ? '' : `L${scaleX(index)},${scaleY(value)}`
      })
      .join('')
    paths.push(`M${scaleX(first)},${baselineY}${top}L${scaleX(last)},${baselineY}Z`)
    run = []
  }
  values.forEach((value, index) => {
    if (value === null) flush()
    else run.push(index)
  })
  flush()
  return paths
}

function lastDefined(
  values: ReadonlyArray<number | null>,
): { index: number; value: number } | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== undefined && value !== null) return { index, value }
  }
  return null
}

/** Contiguous runs of highlighted months, so shading is one rect per run. */
function highlightBands(
  months: readonly string[],
  highlight: readonly string[],
): Array<{ from: number; to: number }> {
  const set = new Set(highlight)
  const runs: Array<{ from: number; to: number }> = []
  let start: number | null = null
  months.forEach((month, index) => {
    const on = set.has(month)
    if (on && start === null) start = index
    if (!on && start !== null) {
      runs.push({ from: start, to: index - 1 })
      start = null
    }
  })
  if (start !== null) runs.push({ from: start, to: months.length - 1 })
  return runs
}
