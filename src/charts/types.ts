/**
 * Chart-kit contract.
 *
 * Every chart in this app is hand-built SVG rather than a charting library, so
 * the marks can meet the house spec exactly: bars capped at 24px with a 4px
 * rounded data-end, 2px lines, >=8px markers, a 2px surface gap between
 * touching fills, a 2px surface ring on overlapping dots, hairline solid
 * gridlines, and text that never wears the series colour.
 *
 * Two rules are structural rather than cosmetic and are enforced by these
 * types: a chart with two or more series always renders a legend
 * (`series.length >= 2` => legend), and every chart ships a table-view twin so
 * no value is reachable only by hovering.
 */

import type { ReactNode } from 'react'

/** 1..8 map to `--series-N`; `other` is the de-emphasis grey. */
export type SeriesSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'other'

export interface SeriesMeta {
  /** Stable identity. Colour follows this, never the row's current rank. */
  id: string
  label: string
  slot: SeriesSlot
  /** Legend key shape — mirrors the mark the series draws. */
  markShape?: 'rect' | 'line'
}

export interface ChartCardProps {
  title: string
  subtitle?: string
  /** Rendered to the right of the title — usually a unit or a toggle. */
  aside?: ReactNode
  /** Table-view twin. Required: tooltips enhance, they never gate. */
  table: TableViewProps
  children: ReactNode
  /** Held at reduced opacity during recompute — no skeleton, no layout jump. */
  stale?: boolean
  className?: string
}

export interface TableViewProps {
  caption: string
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>
  rows: Array<Record<string, string | number>>
  /** Colour key beside the first cell, so identity is never colour-alone. */
  rowSlot?: (row: Record<string, string | number>) => SeriesSlot | undefined
}

// --- time series -----------------------------------------------------------

export interface TimePoint {
  month: string
  value: number
}

export interface TimeSeries extends SeriesMeta {
  points: TimePoint[]
  /** Draw as a filled wash under the line (single-series emphasis only). */
  area?: boolean
  /** Render as a hairline reference rather than a data series. */
  reference?: boolean
}

export interface LineChartProps {
  series: TimeSeries[]
  height?: number
  /** Formats the y-axis ticks and tooltip values. */
  format?: (value: number) => string
  yLabel?: string
  /** Force the y-axis top; otherwise the next nice tick above the max. */
  yMax?: number
  /** Label the last point of each series. Off past ~4 converging series. */
  directLabels?: boolean
  /** Months to shade as "actuals" behind the plot. */
  highlightMonths?: string[]
  onMonthClick?: (month: string) => void
}

// --- categorical bars ------------------------------------------------------

export interface StackedBarSeries extends SeriesMeta {
  values: number[]
}

export interface StackedBarChartProps {
  /** X categories — months, plants, or families. */
  categories: string[]
  categoryLabel?: (category: string) => string
  series: StackedBarSeries[]
  height?: number
  format?: (value: number) => string
  yLabel?: string
  /** Overlay a per-category limit as a hairline rule (e.g. capacity). */
  limits?: number[]
  limitLabel?: string
  /** 'stacked' sums the series; 'grouped' sets them side by side. */
  mode?: 'stacked' | 'grouped'
  onCategoryClick?: (category: string) => void
}

// --- diverging heatmap -----------------------------------------------------

export interface HeatCell {
  row: string
  column: string
  /**
   * Signed magnitude. Negative reads as spare capacity (cool), positive as
   * overload (warm), zero as balanced (neutral grey) — the diverging job.
   */
  value: number
  /** Extra lines for the tooltip and table view. */
  detail?: Array<{ label: string; value: string }>
}

export interface HeatmapProps {
  rows: Array<{ id: string; label: string; slot?: SeriesSlot }>
  columns: Array<{ id: string; label: string }>
  cells: HeatCell[]
  /** Symmetric domain bound; values beyond it clamp to the end steps. */
  domain: number
  format: (value: number) => string
  legendLabels?: { negative: string; neutral: string; positive: string }
  onCellClick?: (cell: HeatCell) => void
  cellHeight?: number
}

// --- figures ---------------------------------------------------------------

export interface StatTileProps {
  label: string
  value: string
  /** Signed change against a named period. */
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; goodDirection: 'up' | 'down' }
  deltaContext?: string
  /** 12-point sparkline; the last point takes the accent. */
  spark?: number[]
  sparkSlot?: SeriesSlot
  /** Status ships with an icon and a label, never colour alone. */
  status?: { level: 'good' | 'warning' | 'serious' | 'critical'; label: string }
  hint?: string
}

export interface MeterProps {
  label: string
  /** 0..1+, where 1 is the limit. Over 1 renders past the track end. */
  ratio: number
  valueLabel: string
  limitLabel?: string
  /** Thresholds at which the fill escalates. */
  thresholds?: { warning: number; critical: number }
  slot?: SeriesSlot
}

// --- waterfall (scenario cost bridge) --------------------------------------

export interface WaterfallStep {
  id: string
  label: string
  /** Signed contribution; the running total carries across steps. */
  value: number
  /** Anchors render as absolute totals rather than deltas. */
  anchor?: boolean
}

export interface WaterfallChartProps {
  steps: WaterfallStep[]
  format: (value: number) => string
  height?: number
  /** Whether a rise is a good outcome — drives the status colour of deltas. */
  higherIsBetter?: boolean
}

// --- sourcing flow matrix --------------------------------------------------

export interface FlowMatrixProps {
  /** Supply side — plants. Colour follows the plant's fixed slot. */
  origins: Array<{ id: string; label: string; slot: SeriesSlot }>
  /** Demand side — regions. */
  destinations: Array<{ id: string; label: string }>
  flows: Array<{ originId: string; destinationId: string; units: number; costPerUnit: number }>
  format: (value: number) => string
}
