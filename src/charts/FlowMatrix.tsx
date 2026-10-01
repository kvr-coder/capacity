/**
 * Where each plant's output goes.
 *
 * Origins are rows and keep their permanent plant colour on the chip beside the
 * label; destinations are columns. The field itself is a magnitude — units
 * shipped, no polarity — so it takes the sequential ramp, one hue light to
 * dark, and never the diverging one.
 *
 * No number is printed on a coloured fill. Ink on a ramp step is a contrast
 * accident waiting to happen in one of the two themes, so the totals sit in the
 * margins where they are always legible, and every cell value is in the
 * tooltip and in the card's table twin.
 */

import { useMemo, useRef, useState } from 'react'
import { at, clamp, key } from '@/domain/lookup'
import { sequentialColor, seriesColor } from '@/charts/palette'
import { ChartEmpty } from '@/charts/ChartCard'
import { SequentialLegend } from '@/charts/Legend'
import { Tooltip } from '@/charts/Tooltip'
import { CHART, useChartSize } from '@/charts/primitives'
import type { FlowMatrixProps, TooltipRow } from '@/charts/types'
import styles from '@/charts/FlowMatrix.module.css'

const HEADER_HEIGHT = 26
const ROW_HEIGHT = 30
const TOTAL_WIDTH = 78
const MIN_CELL = 56
const LABEL_CHAR = 6.1

interface Flow {
  units: number
  costPerUnit: number
}

export function FlowMatrix({ origins, destinations, flows, format, onFlowClick, emptyMessage }: FlowMatrixProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const available = useChartSize(frame, 720)
  const [hover, setHover] = useState<{ row: number; column: number } | null>(null)
  const [focus, setFocus] = useState<{ row: number; column: number } | null>(null)
  // The field scrolls sideways inside its own container; the tooltip sits
  // outside it, so it has to be told how far the field has moved.
  const [scrollLeft, setScrollLeft] = useState(0)

  const model = useMemo(() => {
    const byKey = new Map<string, Flow>()
    for (const flow of flows) {
      const existing = byKey.get(key(flow.originId, flow.destinationId))
      const units = Number.isFinite(flow.units) ? flow.units : 0
      if (existing) {
        // Two rows for the same pair means dual sourcing was split upstream;
        // sum the units and keep a units-weighted cost.
        const total = existing.units + units
        existing.costPerUnit =
          total === 0 ? existing.costPerUnit : (existing.costPerUnit * existing.units + flow.costPerUnit * units) / total
        existing.units = total
      } else {
        byKey.set(key(flow.originId, flow.destinationId), { units, costPerUnit: flow.costPerUnit })
      }
    }
    let peak = 0
    for (const flow of byKey.values()) peak = Math.max(peak, flow.units)
    const rowTotals = origins.map((origin) =>
      destinations.reduce((sum, destination) => sum + (byKey.get(key(origin.id, destination.id))?.units ?? 0), 0),
    )
    const columnTotals = destinations.map((destination) =>
      origins.reduce((sum, origin) => sum + (byKey.get(key(origin.id, destination.id))?.units ?? 0), 0),
    )
    return { byKey, peak, rowTotals, columnTotals }
  }, [flows, origins, destinations])

  const gutter = useMemo(() => {
    let longest = 0
    for (const origin of origins) longest = Math.max(longest, origin.label.length)
    return clamp(longest * LABEL_CHAR + 26, 96, 200)
  }, [origins])

  if (origins.length === 0 || destinations.length === 0 || flows.length === 0) {
    return <ChartEmpty message={emptyMessage ?? 'No flows in this slice'} />
  }

  const field = Math.max(MIN_CELL * destinations.length, available - gutter - TOTAL_WIDTH)
  const cellWidth = field / destinations.length
  const width = gutter + field + TOTAL_WIDTH
  const height = HEADER_HEIGHT + ROW_HEIGHT * origins.length + 24

  const active = hover ?? focus
  const activeOrigin = active === null ? null : at(origins, active.row, 'origin')
  const activeDestination = active === null ? null : at(destinations, active.column, 'destination')
  const activeFlow =
    activeOrigin && activeDestination ? model.byKey.get(key(activeOrigin.id, activeDestination.id)) : undefined

  return (
    <div className={styles.wrap}>
      <div className={styles.frame} ref={frame}>
        <div
          className={styles.scroller}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          <svg
            className={styles.svg}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Flows from ${origins.length} plants to ${destinations.length} regions`}
            tabIndex={0}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              const x = event.clientX - box.left
              const y = event.clientY - box.top
              if (x < gutter || x > gutter + field || y < HEADER_HEIGHT) {
                setHover(null)
                return
              }
              const row = Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT)
              if (row < 0 || row >= origins.length) {
                setHover(null)
                return
              }
              setHover({ row, column: clamp(Math.floor((x - gutter) / cellWidth), 0, destinations.length - 1) })
            }}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setFocus((prior) => prior ?? { row: 0, column: 0 })}
            onBlur={() => setFocus(null)}
            onKeyDown={(event) => {
              const steps: Record<string, [number, number]> = {
                ArrowUp: [-1, 0],
                ArrowDown: [1, 0],
                ArrowLeft: [0, -1],
                ArrowRight: [0, 1],
              }
              const step = steps[event.key]
              if (step) {
                event.preventDefault()
                setFocus((prior) => {
                  const base = prior ?? { row: 0, column: 0 }
                  return {
                    row: clamp(base.row + step[0], 0, origins.length - 1),
                    column: clamp(base.column + step[1], 0, destinations.length - 1),
                  }
                })
                return
              }
              if ((event.key === 'Enter' || event.key === ' ') && onFlowClick && activeOrigin && activeDestination) {
                event.preventDefault()
                onFlowClick({ originId: activeOrigin.id, destinationId: activeDestination.id })
              }
            }}
            onClick={() => {
              if (onFlowClick && activeOrigin && activeDestination) {
                onFlowClick({ originId: activeOrigin.id, destinationId: activeDestination.id })
              }
            }}
          >
            <g aria-hidden="true">
              {destinations.map((destination, index) => (
                <text
                  key={destination.id}
                  className={styles.header}
                  x={gutter + index * cellWidth + cellWidth / 2}
                  y={HEADER_HEIGHT - 9}
                  textAnchor="middle"
                >
                  {destination.label}
                </text>
              ))}
              <text
                className={styles.header}
                x={gutter + field + TOTAL_WIDTH - 4}
                y={HEADER_HEIGHT - 9}
                textAnchor="end"
              >
                Total
              </text>
            </g>

            {origins.map((origin, rowIndex) => {
              const y = HEADER_HEIGHT + rowIndex * ROW_HEIGHT
              return (
                <g key={origin.id}>
                  <rect
                    x={0}
                    y={y + ROW_HEIGHT / 2 - 4}
                    width={8}
                    height={8}
                    rx={2}
                    fill={seriesColor(origin.slot)}
                    aria-hidden="true"
                  />
                  <text className={styles.rowLabel} x={14} y={y + ROW_HEIGHT / 2} dominantBaseline="middle">
                    {origin.label}
                  </text>
                  {destinations.map((destination, columnIndex) => {
                    const flow = model.byKey.get(key(origin.id, destination.id))
                    const x = gutter + columnIndex * cellWidth
                    const w = Math.max(0, cellWidth - CHART.GAP)
                    const h = Math.max(0, ROW_HEIGHT - CHART.GAP)
                    if (flow === undefined || flow.units <= 0) {
                      return (
                        <rect
                          key={destination.id}
                          className={styles.missing}
                          x={x + CHART.GAP / 2}
                          y={y + CHART.GAP / 2}
                          width={w}
                          height={h}
                          rx={2}
                        />
                      )
                    }
                    return (
                      <rect
                        key={destination.id}
                        x={x + CHART.GAP / 2}
                        y={y + CHART.GAP / 2}
                        width={w}
                        height={h}
                        rx={2}
                        fill={sequentialColor(model.peak === 0 ? 0 : flow.units / model.peak)}
                      />
                    )
                  })}
                  <text
                    className={styles.total}
                    x={gutter + field + TOTAL_WIDTH - 4}
                    y={y + ROW_HEIGHT / 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {format(at(model.rowTotals, rowIndex, 'row total'))}
                  </text>
                </g>
              )
            })}

            <g aria-hidden="true">
              {destinations.map((destination, index) => (
                <text
                  key={destination.id}
                  className={styles.columnTotal}
                  x={gutter + index * cellWidth + cellWidth / 2}
                  y={HEADER_HEIGHT + ROW_HEIGHT * origins.length + 14}
                  textAnchor="middle"
                >
                  {format(at(model.columnTotals, index, 'column total'))}
                </text>
              ))}
            </g>

            {active === null ? null : (
              <rect
                className={styles.focusRing}
                x={gutter + active.column * cellWidth}
                y={HEADER_HEIGHT + active.row * ROW_HEIGHT}
                width={cellWidth}
                height={ROW_HEIGHT}
                rx={2}
                aria-hidden="true"
              />
            )}
          </svg>
        </div>

        {active !== null && activeOrigin && activeDestination ? (
          <Tooltip
            title={activeOrigin.label}
            subtitle={`to ${activeDestination.label}`}
            x={clamp(gutter + active.column * cellWidth + cellWidth / 2 - scrollLeft, 0, available)}
            y={HEADER_HEIGHT + active.row * ROW_HEIGHT + ROW_HEIGHT / 2}
            containerWidth={available}
            containerHeight={height}
            live={hover === null}
            rows={flowRows(activeFlow, format, activeOrigin.slot)}
          />
        ) : null}
      </div>

      <SequentialLegend label="Units shipped" min={format(0)} max={format(model.peak)} />
    </div>
  )
}

function flowRows(
  flow: Flow | undefined,
  format: (value: number) => string,
  slot: FlowMatrixProps['origins'][number]['slot'],
): TooltipRow[] {
  if (flow === undefined || flow.units <= 0) {
    return [{ label: 'Units', value: '—', slot }]
  }
  return [
    { label: 'Units', value: format(flow.units), slot, emphasis: true },
    { label: 'Cost per unit', value: format(flow.costPerUnit) },
    { label: 'Total cost', value: format(flow.units * flow.costPerUnit) },
  ]
}
