/**
 * Diverging heatmap for a modest grid — plants x months, groups x quarters.
 *
 * Signed values, so the scale is diverging with a neutral grey midpoint: cool
 * is spare capacity, warm is overload, and "balanced" deliberately has no hue.
 * Magnitude alone would be a sequential job; polarity is not.
 *
 * The dense work-center x week case is not this component — 11,700 SVG rects
 * would not stay interactive. That is `UtilisationGrid`, which draws to canvas.
 */

import { useMemo, useRef, useState } from 'react'
import { at, clamp, key } from '@/domain/lookup'
import { divergingColor, seriesColor } from '@/charts/palette'
import { ChartEmpty } from '@/charts/ChartCard'
import { DivergingLegend } from '@/charts/Legend'
import { Tooltip } from '@/charts/Tooltip'
import { CHART, thinIndices, useChartSize } from '@/charts/primitives'
import type { HeatCell, HeatmapProps, TooltipRow } from '@/charts/types'
import styles from '@/charts/Heatmap.module.css'

const HEADER_HEIGHT = 24
const MIN_CELL_WIDTH = 26
const LABEL_CHAR = 6.1

export function Heatmap({
  rows,
  columns,
  cells,
  domain,
  format,
  legendLabels,
  onCellClick,
  cellHeight = 24,
}: HeatmapProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const available = useChartSize(frame, 720)
  const [hover, setHover] = useState<{ row: number; column: number } | null>(null)
  const [focus, setFocus] = useState<{ row: number; column: number } | null>(null)
  // The field scrolls sideways inside its own container; the tooltip sits
  // outside it, so it has to be told how far the field has moved.
  const [scrollLeft, setScrollLeft] = useState(0)

  const byKey = useMemo(() => {
    const map = new Map<string, HeatCell>()
    for (const cell of cells) map.set(key(cell.row, cell.column), cell)
    return map
  }, [cells])

  const gutter = useMemo(() => {
    let longest = 0
    for (const row of rows) longest = Math.max(longest, row.label.length)
    return clamp(longest * LABEL_CHAR + 22, 64, 190)
  }, [rows])

  if (rows.length === 0 || columns.length === 0) {
    return <ChartEmpty message="No cells in this slice" />
  }

  const cellWidth = Math.max(MIN_CELL_WIDTH, (available - gutter) / columns.length)
  const width = gutter + cellWidth * columns.length
  const height = HEADER_HEIGHT + cellHeight * rows.length
  const safeDomain = domain > 0 ? domain : 1

  const active = hover ?? focus
  const activeCell =
    active === null
      ? null
      : (byKey.get(key(at(rows, active.row, 'row').id, at(columns, active.column, 'column').id)) ??
        null)

  const move = (deltaRow: number, deltaColumn: number): void => {
    setFocus((prior) => {
      const base = prior ?? { row: 0, column: 0 }
      return {
        row: clamp(base.row + deltaRow, 0, rows.length - 1),
        column: clamp(base.column + deltaColumn, 0, columns.length - 1),
      }
    })
  }

  const visibleHeaders = thinIndices(
    columns.length,
    Math.max(2, Math.floor((width - gutter) / 44)),
  )

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
            aria-label={`Heatmap, ${rows.length} rows by ${columns.length} columns`}
            tabIndex={0}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              const x = event.clientX - box.left
              const y = event.clientY - box.top
              if (x < gutter || y < HEADER_HEIGHT) {
                setHover(null)
                return
              }
              setHover({
                row: clamp(Math.floor((y - HEADER_HEIGHT) / cellHeight), 0, rows.length - 1),
                column: clamp(Math.floor((x - gutter) / cellWidth), 0, columns.length - 1),
              })
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
                move(step[0], step[1])
                return
              }
              if ((event.key === 'Enter' || event.key === ' ') && onCellClick && activeCell) {
                event.preventDefault()
                onCellClick(activeCell)
              }
            }}
            onClick={() => {
              if (onCellClick && activeCell) onCellClick(activeCell)
            }}
          >
            <g aria-hidden="true">
              {columns.map((column, index) =>
                visibleHeaders.has(index) ? (
                  <text
                    key={column.id}
                    className={styles.header}
                    x={gutter + index * cellWidth + cellWidth / 2}
                    y={HEADER_HEIGHT - 8}
                    textAnchor="middle"
                  >
                    {column.label}
                  </text>
                ) : null,
              )}
            </g>

            {rows.map((row, rowIndex) => {
              const y = HEADER_HEIGHT + rowIndex * cellHeight
              return (
                <g key={row.id}>
                  {row.slot === undefined ? null : (
                    <rect
                      x={0}
                      y={y + cellHeight / 2 - 4}
                      width={8}
                      height={8}
                      rx={2}
                      fill={seriesColor(row.slot)}
                      aria-hidden="true"
                    />
                  )}
                  <text
                    className={styles.rowLabel}
                    x={row.slot === undefined ? 0 : 14}
                    y={y + cellHeight / 2}
                    dominantBaseline="middle"
                  >
                    {row.label}
                  </text>
                  {columns.map((column, columnIndex) => {
                    const cell = byKey.get(key(row.id, column.id))
                    const x = gutter + columnIndex * cellWidth
                    if (cell === undefined) {
                      return (
                        <rect
                          key={column.id}
                          className={styles.missing}
                          x={x + CHART.GAP / 2}
                          y={y + CHART.GAP / 2}
                          width={Math.max(0, cellWidth - CHART.GAP)}
                          height={Math.max(0, cellHeight - CHART.GAP)}
                          rx={2}
                        />
                      )
                    }
                    return (
                      <rect
                        key={column.id}
                        x={x + CHART.GAP / 2}
                        y={y + CHART.GAP / 2}
                        width={Math.max(0, cellWidth - CHART.GAP)}
                        height={Math.max(0, cellHeight - CHART.GAP)}
                        rx={2}
                        fill={divergingColor(cell.value / safeDomain)}
                      />
                    )
                  })}
                </g>
              )
            })}

            {active === null ? null : (
              <rect
                className={styles.focusRing}
                x={gutter + active.column * cellWidth}
                y={HEADER_HEIGHT + active.row * cellHeight}
                width={cellWidth}
                height={cellHeight}
                rx={2}
                aria-hidden="true"
              />
            )}
          </svg>
        </div>

        {active !== null ? (
          <Tooltip
            title={at(rows, active.row, 'row').label}
            subtitle={at(columns, active.column, 'column').label}
            x={clamp(gutter + active.column * cellWidth + cellWidth / 2 - scrollLeft, 0, available)}
            y={HEADER_HEIGHT + active.row * cellHeight + cellHeight / 2}
            containerWidth={available}
            containerHeight={height}
            live={hover === null}
            rows={tooltipRows(activeCell, format)}
          />
        ) : null}
      </div>

      <DivergingLegend
        labels={
          legendLabels ?? { negative: 'Spare', neutral: 'Balanced', positive: 'Over ceiling' }
        }
        bounds={{ negative: format(-safeDomain), positive: format(safeDomain) }}
      />
    </div>
  )
}

function tooltipRows(cell: HeatCell | null, format: (value: number) => string): TooltipRow[] {
  if (cell === null) return [{ label: 'Value', value: '—' }]
  const rows: TooltipRow[] = [{ label: 'Value', value: format(cell.value), emphasis: true }]
  for (const detail of cell.detail ?? []) rows.push({ label: detail.label, value: detail.value })
  return rows
}
