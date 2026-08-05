/**
 * Capability edges — "somewhere else could make this", drawn.
 *
 * These are the links that make the feature model worth holding: a dashed line
 * from a saturated work center to a sibling in another plant that shares a
 * capability is the whole argument for the screen. They are chrome, not data:
 * quiet greys with the *basis* carried by the dash pattern rather than by a
 * reserved status colour, so the loud thing on the canvas stays the load.
 *
 *   solid    approved       master data already permits it
 *   dashed   capable        physically able, not on the allow-list
 *   dotted   retrofit       able after a priced, dated change
 *
 * Two renderers, one geometry. Under ~120 edges SVG wins: crisper hairlines,
 * real hover targets, CSS-driven theming. Past that the per-node cost of an SVG
 * path stops being free during a pan, so the same paths are rasterised to a
 * canvas underneath the node layer and redrawn imperatively from the transform
 * subscription — no React render in the pan loop at all.
 *
 * Canvas cannot resolve `var(--token)`, so the tokens are read once from the
 * document and cached per theme. The stylesheet is still the only place a colour
 * is written down.
 */

import { memo, useEffect, useMemo, useRef } from 'react'
import type { EdgeGeometry } from '@/canvas/layout'
import type { CanvasTransformApi } from '@/canvas/useCanvasTransform'
import { EDGE_BUNDLE_STRENGTH, bundleControls } from '@/canvas/layout'
import styles from '@/canvas/NetworkCanvas.module.css'

/** Past this many edges the SVG renderer hands over to the canvas one. */
export const EDGE_CANVAS_THRESHOLD = 120

export type EdgeBasis = EdgeGeometry['basis']

const DASH: Record<EdgeBasis, string> = {
  approved: '',
  featureCapable: '7 5',
  retrofit: '2 5',
}

const DASH_CANVAS: Record<EdgeBasis, number[]> = {
  approved: [],
  featureCapable: [7, 5],
  retrofit: [2, 5],
}

const BASE_OPACITY: Record<EdgeBasis, number> = {
  approved: 0.5,
  featureCapable: 0.45,
  retrofit: 0.36,
}

export interface EdgeLayerProps {
  edges: readonly EdgeGeometry[]
  /** Work center under the pointer or keyboard focus; its edges come forward. */
  highlightNodeId?: string | null
  /** Work centers the live drag considers legal; their edges come forward too. */
  emphasisIds?: ReadonlySet<string>
}

function emphasisOf(
  edge: EdgeGeometry,
  highlightNodeId: string | null | undefined,
  emphasisIds: ReadonlySet<string> | undefined,
): boolean {
  if (highlightNodeId != null && (edge.fromId === highlightNodeId || edge.toId === highlightNodeId)) return true
  if (emphasisIds && (emphasisIds.has(edge.fromId) || emphasisIds.has(edge.toId))) return true
  return false
}

// ---------------------------------------------------------------------------
// SVG renderer
// ---------------------------------------------------------------------------

/**
 * Renders inside the transformed `<g>`. Stroke widths are given in world units
 * scaled by `vectorEffect`, so a hairline stays a hairline at every zoom.
 */
export const CapabilityEdgesSvg = memo(function CapabilityEdgesSvg({
  edges,
  highlightNodeId,
  emphasisIds,
}: EdgeLayerProps) {
  return (
    <g aria-hidden="true" className={styles.edgeGroup}>
      {edges.map((edge) => {
        const hot = emphasisOf(edge, highlightNodeId, emphasisIds)
        return (
          <path
            key={edge.id}
            d={edge.path}
            fill="none"
            className={hot ? styles.edgeHot : styles.edge}
            strokeDasharray={DASH[edge.basis] === '' ? undefined : DASH[edge.basis]}
            strokeWidth={hot ? 2 : 1}
            vectorEffect="non-scaling-stroke"
            opacity={edge.visibility === 'faded' ? 0.16 : hot ? 0.95 : BASE_OPACITY[edge.basis]}
          />
        )
      })}
    </g>
  )
})

// ---------------------------------------------------------------------------
// Canvas renderer
// ---------------------------------------------------------------------------

interface ResolvedTokens {
  base: string
  hot: string
}

function readTokens(): ResolvedTokens {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { base: '#888888', hot: '#000000' }
  }
  const style = window.getComputedStyle(document.documentElement)
  const base = style.getPropertyValue('--text-muted').trim()
  const hot = style.getPropertyValue('--text-primary').trim()
  return { base: base === '' ? '#888888' : base, hot: hot === '' ? '#000000' : hot }
}

export interface EdgeCanvasProps extends EdgeLayerProps {
  /**
   * `CanvasTransformApi.subscribe`, passed on its own rather than the whole API
   * object: the API's identity changes once per frame while panning, and
   * re-subscribing every frame is exactly the cost this renderer exists to
   * avoid. `subscribe` itself is stable for the life of the hook.
   */
  subscribe: CanvasTransformApi['subscribe']
  width: number
  height: number
  /** Changing this re-reads the palette from the document. */
  themeKey: string
}

/**
 * The same edges, rasterised beneath the node layer.
 *
 * Redraws are driven by the transform subscription rather than by React, so a
 * pan costs one `clearRect` plus N `bezierCurveTo` calls per frame and zero
 * reconciliation.
 */
export const CapabilityEdgesCanvas = memo(function CapabilityEdgesCanvas({
  edges,
  subscribe,
  width,
  height,
  themeKey,
  highlightNodeId,
  emphasisIds,
}: EdgeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const tokensRef = useRef<ResolvedTokens>({ base: '#888888', hot: '#000000' })

  useEffect(() => {
    tokensRef.current = readTokens()
  }, [themeKey])

  // Precompute control points once per edge set — a pan must not re-derive them.
  const prepared = useMemo(
    () =>
      edges.map((edge) => {
        const { c1, c2 } = bundleControls(edge.from, edge.to, edge.hub, EDGE_BUNDLE_STRENGTH)
        return { edge, c1, c2 }
      }),
    [edges],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))

    const draw = (t: { x: number; y: number; k: number }): void => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      const tokens = tokensRef.current
      for (const { edge, c1, c2 } of prepared) {
        const hot = emphasisOf(edge, highlightNodeId, emphasisIds)
        const fromX = edge.from.x * t.k + t.x
        const fromY = edge.from.y * t.k + t.y
        const toX = edge.to.x * t.k + t.x
        const toY = edge.to.y * t.k + t.y
        // Off-screen fading is decided here rather than in the memo: it depends
        // on the transform, which changes every frame, and two float comparisons
        // per edge is cheaper than re-deriving the edge set.
        const onScreen =
          (fromX >= 0 && fromX <= width && fromY >= 0 && fromY <= height) ||
          (toX >= 0 && toX <= width && toY >= 0 && toY <= height)
        context.beginPath()
        context.setLineDash(DASH_CANVAS[edge.basis])
        context.strokeStyle = hot ? tokens.hot : tokens.base
        context.lineWidth = hot ? 2 : 1
        context.globalAlpha = !onScreen ? 0.14 : hot ? 0.9 : BASE_OPACITY[edge.basis]
        context.moveTo(fromX, fromY)
        context.bezierCurveTo(c1.x * t.k + t.x, c1.y * t.k + t.y, c2.x * t.k + t.x, c2.y * t.k + t.y, toX, toY)
        context.stroke()
      }
      context.globalAlpha = 1
      context.setLineDash([])
    }

    return subscribe(draw)
  }, [emphasisIds, height, highlightNodeId, prepared, subscribe, themeKey, width])

  return (
    <canvas
      ref={canvasRef}
      className={styles.edgeCanvas}
      style={{ width: `${width}px`, height: `${height}px` }}
      aria-hidden="true"
    />
  )
})

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const LEGEND: Array<{ basis: EdgeBasis; label: string; hint: string }> = [
  { basis: 'approved', label: 'Approved', hint: 'master data permits it today' },
  { basis: 'featureCapable', label: 'Capable', hint: 'needs qualification' },
  { basis: 'retrofit', label: 'Retrofit', hint: 'needs a priced change' },
]

export interface EdgeLegendProps {
  /** Edges the cull refused to draw. Named rather than silently dropped. */
  hidden?: number
  total?: number
}

/** Names every dash pattern, so the encoding is never left to be guessed. */
export function CapabilityEdgeLegend({ hidden = 0, total = 0 }: EdgeLegendProps) {
  return (
    <div className={styles.edgeLegend}>
      <span className={styles.legendTitle}>Shared capability</span>
      {LEGEND.map((entry) => (
        <span key={entry.basis} className={styles.legendItem}>
          <svg
            className={styles.legendMark}
            viewBox="0 0 26 8"
            width={26}
            height={8}
            aria-hidden="true"
          >
            <line
              x1={1}
              y1={4}
              x2={25}
              y2={4}
              className={styles.edge}
              strokeWidth={1.5}
              strokeDasharray={DASH[entry.basis] === '' ? undefined : DASH[entry.basis]}
              opacity={0.8}
            />
          </svg>
          <span className={styles.legendLabel}>{entry.label}</span>
          <span className={styles.legendHint}>{entry.hint}</span>
        </span>
      ))}
      {hidden > 0 ? (
        <span className={styles.legendHidden}>
          {hidden.toLocaleString('en-US')} of {total.toLocaleString('en-US')} links not drawn
        </span>
      ) : null}
    </div>
  )
}
