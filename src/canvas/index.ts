/**
 * The zoomable network canvas, as one import.
 *
 * `NetworkCanvas` is the whole feature: it reads the catalog, the active
 * scenario and the current filter window from the store, joins them against the
 * worker's model run, and draws globe -> plant -> work center on one continuous
 * transform. A route renders `<NetworkCanvas />` and nothing else.
 *
 * The layers, hooks and pure geometry are exported too, because the relief and
 * scenario screens reuse the node marks and the classification rules, and
 * because `projection` and `layout` are pure enough to be worth testing and
 * reusing without a React tree anywhere near them.
 */

export { NetworkCanvas } from '@/canvas/NetworkCanvas'
export type { NetworkCanvasProps } from '@/canvas/NetworkCanvas'

export { GlobeLayer } from '@/canvas/GlobeLayer'
export type {
  GlobeClusterMember,
  GlobeClusterNode,
  GlobeLayerProps,
  GlobePlantNode,
} from '@/canvas/GlobeLayer'

export { PlantLayer } from '@/canvas/PlantLayer'
export type { PlantLayerProps, WorkCenterNodeView } from '@/canvas/PlantLayer'

export {
  WORK_CENTER_FOCUS,
  WORK_CENTER_MAX_RELIEF,
  WORK_CENTER_WORLD,
  WorkCenterLayer,
  collapseDowntime,
  workCenterGhostTargets,
} from '@/canvas/WorkCenterLayer'
export type { GroupChip, WorkCenterLayerProps } from '@/canvas/WorkCenterLayer'

export {
  CapabilityEdgeLegend,
  CapabilityEdgesCanvas,
  CapabilityEdgesSvg,
  EDGE_CANVAS_THRESHOLD,
} from '@/canvas/CapabilityEdges'
export type { EdgeCanvasProps, EdgeLayerProps, EdgeLegendProps, EdgeMode } from '@/canvas/CapabilityEdges'

export { AppliedMoveCard, DragGhost, DragLayer, DropIconBadge, DropIconMark } from '@/canvas/DragLayer'
export type { AppliedMoveCardProps, DragGhostProps, DragLayerProps, DropIconMarkProps } from '@/canvas/DragLayer'

export { IDENTITY, TRANSITION_MS, useCanvasTransform } from '@/canvas/useCanvasTransform'
export type { CanvasTransformApi, CanvasTransformOptions, Transform } from '@/canvas/useCanvasTransform'

export {
  DRAG_HANDLE_ATTRIBUTE,
  DRAG_HANDLE_SELECTOR,
  DRAG_THRESHOLD_PX,
  dragHandleKindAt,
  gestureFor,
  passedThreshold,
} from '@/canvas/gesture'
export type { DragHandleKind, GestureInput, GestureKind, GestureTarget } from '@/canvas/gesture'

export { useDragMove } from '@/canvas/useDragMove'
export type { AppliedMove, DragMeta, DragMoveApi, DragMoveOptions, DragPayload } from '@/canvas/useDragMove'

export {
  LAND,
  WORLD,
  geoBounds,
  graticule,
  landAt,
  landPath,
  pointInRing,
  project,
  ringPath,
  unproject,
  worldPath,
} from '@/canvas/projection'
export type { GeoPoint, GraticuleLine, LandRegion, PathOptions, Point, ProjectionBox, Ring } from '@/canvas/projection'

export {
  DOCK_RESERVED_WIDTH,
  EDGE_BUNDLE_STRENGTH,
  aggregatePlants,
  aggregateWorkCenters,
  arcPath,
  bubbleRadius,
  buildCapabilityCatalog,
  bundleControls,
  classifyDrop,
  clusterGlobeSites,
  cullEdges,
  edgePath,
  findClosingRetrofit,
  layoutArcs,
  layoutGhostFan,
  layoutGlobe,
  layoutPartnerDock,
  layoutPlantGridFitted,
  layoutStageColumns,
  layoutStrip,
  pickDockCardTarget,
  placeGlobeLabels,
  previewImpact,
  resolveDropTarget,
  utilisationSignal,
} from '@/canvas/layout'
export type {
  ArcGeometry,
  ArcInput,
  ArcKind,
  ArcLayoutOptions,
  CapabilityCatalog,
  ClassifyDropArgs,
  ClassGroup,
  CullResult,
  DockCard,
  DockInput,
  DockOptions,
  DockSlot,
  DropBasis,
  DropClassification,
  DropIcon,
  DropStatus,
  EdgeGeometry,
  EdgeInput,
  GhostSlot,
  GlobeLayoutOptions,
  GlobeMark,
  GlobeSite,
  ImpactPreview,
  LabelPlacement,
  LabelSide,
  LabelTarget,
  PartnerDock,
  PlacedNode,
  PlantGridFitOptions,
  PlantAggregate,
  PlantLayout,
  Rect,
  StageColumn,
  StageLayoutOptions,
  StageNodeInput,
  StripInput,
  StripBar,
  StripLayout,
  WorkCenterAggregate,
} from '@/canvas/layout'
