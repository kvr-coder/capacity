/**
 * The chart kit's public surface.
 *
 * Screens import from `@/charts` and nothing else in this folder — the module
 * layout inside is free to move as long as this list holds.
 */

export { ChartCard, ChartEmpty } from '@/charts/ChartCard'
export type { ChartEmptyProps } from '@/charts/ChartCard'
export { TableView } from '@/charts/TableView'
export { Legend, DivergingLegend, SequentialLegend } from '@/charts/Legend'
export type { DivergingLegendProps, SequentialLegendProps } from '@/charts/Legend'
export { Tooltip } from '@/charts/Tooltip'

export { StatTile, STATUS_GLYPH, deltaIsGood } from '@/charts/StatTile'
export { HeroFigure } from '@/charts/HeroFigure'
export { Meter } from '@/charts/Meter'
export { SparkBar } from '@/charts/SparkBar'

export { LineChart } from '@/charts/LineChart'
export { StackedBarChart } from '@/charts/StackedBarChart'
export { Heatmap } from '@/charts/Heatmap'
export { UtilisationGrid, UtilisationGridLegend } from '@/charts/UtilisationGrid'
export { GlideCurve } from '@/charts/GlideCurve'
export { WaterfallChart } from '@/charts/WaterfallChart'
export { FlowMatrix } from '@/charts/FlowMatrix'

export {
  AXIS,
  DIVERGING_MID,
  GRIDLINE,
  OTHER,
  SEQ_TRACK,
  SURFACE,
  SURFACE_RAISED,
  TEXT_MUTED,
  deltaTextColor,
  divergingColor,
  sequentialColor,
  seriesColor,
  statusColor,
} from '@/charts/palette'
export type { StatusLevel } from '@/charts/palette'

export {
  Baseline,
  CHART,
  GridLines,
  PlotSurfaceRing,
  RoundedBar,
  XAxis,
  YAxis,
  clipId,
  horizontalBarGeom,
  nearestIndex,
  roundedBarPath,
  thinIndices,
  useChartSize,
  useIsomorphicLayoutEffect,
  useMounted,
  usePointerPosition,
  useUniqueId,
  verticalBarGeom,
} from '@/charts/primitives'
export type {
  BarEnd,
  BarGeometry,
  BaselineProps,
  ElementRefLike,
  GridLinesProps,
  PlotSurfaceRingProps,
  PointerPosition,
  RoundedBarProps,
  XAxisProps,
  YAxisProps,
} from '@/charts/primitives'

export type * from '@/charts/types'
