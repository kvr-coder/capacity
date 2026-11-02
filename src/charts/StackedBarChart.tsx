/**
 * Composition over a categorical axis — hours by product group per month,
 * required hours by plant, the usual shape of "what is filling this up".
 *
 * Stacked segments never touch: each one gives back 2px to the surface at its
 * top edge, which separates fills without a border stroke that would read as a
 * third colour. Only the topmost segment gets the 4px data-end radius; every
 * segment below it is square at both ends, and the bar is square where it meets
 * the baseline.
 *
 * `limits` overlays a per-category ceiling as a hairline rule. It is chrome
 * rather than a series, so it never claims a legend slot or a second y-axis.
 */

import { useMemo, useRef, useState } from 'react'
import { at, clamp } from '@/domain/lookup'
import { compact, monthShort, niceMax, niceTicks } from '@/lib/format'
import { seriesColor } from '@/charts/palette'
import { ChartEmpty } from '@/charts/ChartCard'
import { Legend } from '@/charts/Legend'
import { Tooltip } from '@/charts/Tooltip'
import { CHART, RoundedBar, XAxis, YAxis, nearestIndex, useChartSize } from '@/charts/primitives'
import type { SeriesMeta, StackedBarChartProps, TooltipRow } from '@/charts/types'
import styles from '@/charts/StackedBarChart.module.css'

const PAD = { top: 16, right: 18, bottom: 30, left: 56 }

export function StackedBarChart({
  categories,
  categoryLabel,
  series,
  height = 260,
  format = compact,
  yLabel,
  limits,
  limitLabel = 'Limit',
  mode = 'stacked',
  onCategoryClick,
}: StackedBarChartProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const width = useChartSize(frame, 640)
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  const totals = useMemo(() => {
    return categories.map((_, index) => {
      let stacked = 0
      let tallest = 0
      for (const entry of series) {
        const raw = entry.values[index]
        const value = raw === undefined || !Number.isFinite(raw) ? 0 : Math.max(0, raw)
        stacked += value
        tallest = Math.max(tallest, value)
      }
      return { stacked, tallest }
    })
  }, [categories, series])

  const yTop = useMemo(() => {
    let peak = 0
    for (const total of totals) peak = Math.max(peak, mode === 'stacked' ? total.stacked : total.tallest)
    for (const limit of limits ?? []) {
      if (Number.isFinite(limit)) peak = Math.max(peak, limit)
    }
    return Math.max(niceMax(peak), 1e-9)
  }, [totals, limits, mode])

  if (categories.length === 0 || series.length === 0) {
    return <ChartEmpty height={height} message="No categories in this slice" />
  }

  const plotLeft = PAD.left
  const plotRight = Math.max(plotLeft + 1, width - PAD.right)
  const plotWidth = plotRight - plotLeft
  const plotTop = PAD.top
  const plotBottom = height - PAD.bottom
  const plotHeight = Math.max(1, plotBottom - plotTop)
  const band = plotWidth / categories.length

  const scaleX = (index: number): number => plotLeft + (index + 0.5) * band
  const scaleY = (value: number): number => plotBottom - (clamp(value, 0, yTop) / yTop) * plotHeight

  const groupCount = mode === 'grouped' ? series.length : 1
  const clusterWidth = Math.min(band * 0.72, CHART.BAR_MAX_THICKNESS * groupCount + CHART.GAP * (groupCount - 1))
  const barThickness = Math.min(
    CHART.BAR_MAX_THICKNESS,
    Math.max(2, (clusterWidth - CHART.GAP * (groupCount - 1)) / groupCount),
  )

  const active = hover ?? focus
  const legendSeries: SeriesMeta[] = series.map((entry) => ({
    id: entry.id,
    label: entry.label,
    slot: entry.slot,
    markShape: 'rect',
  }))
  const labelFor = (category: string): string => (categoryLabel ? categoryLabel(category) : monthShort(category))

  return (
    <div className={styles.wrap}>
      <div className={styles.frame} ref={frame}>
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
          role="img"
          aria-label={`${yLabel ?? 'Value'} by category, ${series.length} series, ${mode}`}
          tabIndex={0}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setHover(nearestIndex(event.clientX - box.left, plotLeft, band, categories.length))
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setFocus((prior) => prior ?? 0)}
          onBlur={() => setFocus(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault()
              setFocus((prior) =>
                clamp((prior ?? 0) + (event.key === 'ArrowRight' ? 1 : -1), 0, categories.length - 1),
              )
            } else if ((event.key === 'Enter' || event.key === ' ') && onCategoryClick && focus !== null) {
              event.preventDefault()
              onCategoryClick(at(categories, focus, 'category'))
            }
          }}
          onClick={() => {
            if (onCategoryClick && hover !== null) onCategoryClick(at(categories, hover, 'category'))
          }}
        >
          <YAxis ticks={niceTicks(yTop)} scaleY={scaleY} x={plotLeft - 10} format={format} gridTo={plotRight} />

          {active !== null ? (
            <rect
              x={scaleX(active) - band / 2}
              y={plotTop}
              width={band}
              height={plotHeight}
              fill="var(--surface-sunken)"
              aria-hidden="true"
            />
          ) : null}

          {categories.map((category, index) => {
            const centre = scaleX(index)
            let cursor = plotBottom
            return (
              <g key={category}>
                {series.map((entry, seriesIndex) => {
                  const raw = entry.values[index]
                  const value = raw === undefined || !Number.isFinite(raw) ? 0 : Math.max(0, raw)
                  const dimmed = activeId !== null && activeId !== entry.id

                  if (mode === 'grouped') {
                    const offset =
                      centre -
                      clusterWidth / 2 +
                      seriesIndex * (barThickness + CHART.GAP) +
                      barThickness / 2
                    const top = scaleY(value)
                    return (
                      <RoundedBar
                        key={entry.id}
                        x={offset - barThickness / 2}
                        y={top}
                        width={barThickness}
                        height={plotBottom - top}
                        dataEnd="top"
                        fill={seriesColor(entry.slot)}
                        opacity={dimmed ? 0.28 : 1}
                      />
                    )
                  }

                  const heightPx = (value / yTop) * plotHeight
                  if (heightPx <= 0) return null
                  const top = cursor - heightPx
                  cursor = top
                  const isTop = seriesIndex === lastPositiveIndex(series, index)
                  const isBottom = seriesIndex === firstPositiveIndex(series, index)
                  // Every segment above the baseline gives 2px back to the
                  // surface at its lower edge — that is the gap between
                  // touching fills, with no border stroke anywhere.
                  const drawnHeight = Math.max(0, heightPx - (isBottom ? 0 : CHART.GAP))
                  return (
                    <RoundedBar
                      key={entry.id}
                      x={centre - barThickness / 2}
                      y={top}
                      width={barThickness}
                      height={drawnHeight}
                      dataEnd="top"
                      fill={seriesColor(entry.slot)}
                      opacity={dimmed ? 0.28 : 1}
                      radius={isTop ? CHART.BAR_RADIUS : 0}
                    />
                  )
                })}
                {limits && limits[index] !== undefined && Number.isFinite(limits[index] ?? NaN) ? (
                  <line
                    x1={centre - band * 0.42}
                    x2={centre + band * 0.42}
                    y1={scaleY(limits[index] ?? 0)}
                    y2={scaleY(limits[index] ?? 0)}
                    stroke="var(--text-secondary)"
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                ) : null}
              </g>
            )
          })}

          <line
            x1={plotLeft}
            x2={plotRight}
            y1={plotBottom}
            y2={plotBottom}
            stroke="var(--axis)"
            strokeWidth={1}
            shapeRendering="crispEdges"
            aria-hidden="true"
          />

          <XAxis
            categories={categories}
            scaleX={scaleX}
            y={plotBottom + 10}
            width={plotWidth}
            label={(category) => labelFor(category)}
          />

          {yLabel ? (
            <text className={styles.axisLabel} x={0} y={plotTop - 4}>
              {yLabel}
            </text>
          ) : null}
        </svg>

        {active !== null ? (
          <Tooltip
            title={labelFor(at(categories, active, 'category'))}
            x={scaleX(active)}
            y={plotTop + plotHeight / 2}
            containerWidth={width}
            containerHeight={height}
            live={hover === null}
            rows={buildRows(series, limits, limitLabel, active, format, mode)}
          />
        ) : null}
      </div>

      {series.length >= 2 ? (
        <div className={styles.legend}>
          <Legend series={legendSeries} activeId={activeId} onHover={setActiveId} />
        </div>
      ) : null}
      {limits && limits.length > 0 ? (
        <p className={styles.limitNote}>
          <span className={styles.limitMark} aria-hidden="true" />
          {limitLabel}
        </p>
      ) : null}
    </div>
  )
}

/** Index of the lowest series that draws ink — the one sitting on the baseline. */
function firstPositiveIndex(
  series: StackedBarChartProps['series'],
  categoryIndex: number,
): number {
  for (let index = 0; index < series.length; index += 1) {
    const entry = series[index]
    if (entry === undefined) continue
    const raw = entry.values[categoryIndex]
    if (raw !== undefined && Number.isFinite(raw) && raw > 0) return index
  }
  return -1
}

/** Index of the topmost series that actually draws ink in this category. */
function lastPositiveIndex(
  series: StackedBarChartProps['series'],
  categoryIndex: number,
): number {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const entry = series[index]
    if (entry === undefined) continue
    const raw = entry.values[categoryIndex]
    if (raw !== undefined && Number.isFinite(raw) && raw > 0) return index
  }
  return -1
}

function buildRows(
  series: StackedBarChartProps['series'],
  limits: number[] | undefined,
  limitLabel: string,
  index: number,
  format: (value: number) => string,
  mode: 'stacked' | 'grouped',
): TooltipRow[] {
  const rows: TooltipRow[] = series.map((entry) => {
    const raw = entry.values[index]
    const value = raw === undefined || !Number.isFinite(raw) ? 0 : raw
    return { label: entry.label, value: format(value), slot: entry.slot }
  })
  if (mode === 'stacked' && series.length >= 2) {
    let total = 0
    for (const entry of series) {
      const raw = entry.values[index]
      if (raw !== undefined && Number.isFinite(raw)) total += Math.max(0, raw)
    }
    rows.push({ label: 'Total', value: format(total), emphasis: true })
  }
  const limit = limits?.[index]
  if (limit !== undefined && Number.isFinite(limit)) {
    rows.push({ label: limitLabel, value: format(limit) })
  }
  return rows
}
