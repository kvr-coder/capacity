/**
 * Pan and zoom over one transform matrix.
 *
 * The whole canvas — landmasses, bubbles, 150 work-center nodes, the edge
 * canvas — shares a single `{ x, y, k }`. Two rules keep that at 60fps with
 * this much on screen:
 *
 *   1. **The transform is a ref, not React state.** A pointermove writes the
 *      ref and notifies subscribers synchronously, so the SVG root's
 *      `transform` attribute and the edge canvas both update inside the same
 *      frame with no reconciliation at all.
 *   2. **React sees at most one update per frame.** The mirrored state exists
 *      only for things that genuinely need to re-render on zoom (viewport
 *      culling, level-of-detail), and it is coalesced through
 *      `requestAnimationFrame`. Layers are memoised so that update re-renders
 *      the wrapper and nothing beneath it.
 *
 * Every gesture has a keyboard twin: arrows pan, `+`/`-` zoom, `Enter` drills
 * in, `Backspace` and `Escape` go up. This is not a mouse-only feature.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clamp } from '@/domain/lookup'
import type { Point } from '@/canvas/projection'
import type { Rect } from '@/canvas/layout'
import { gestureFor } from '@/canvas/gesture'

export interface Transform {
  x: number
  y: number
  k: number
}

export const IDENTITY: Transform = { x: 0, y: 0, k: 1 }

/** House transition length. The spec caps motion at 200ms; this sits under it. */
export const TRANSITION_MS = 180

export interface Size {
  width: number
  height: number
}

export interface CanvasTransformOptions {
  /** The element gestures are measured against. */
  containerRef: { readonly current: HTMLElement | null }
  minScale?: number
  maxScale?: number
  /** Double-click, or Enter on a focused node. */
  onDrillIn?: (worldPoint: Point) => void
  /** Escape or Backspace. */
  onDrillOut?: () => void
}

export interface CanvasTransformApi {
  /** Frame-coalesced mirror. Safe to read in render; never read it in a handler. */
  transform: Transform
  /** Authoritative value. Read this inside pointer handlers. */
  transformRef: { readonly current: Transform }
  size: Size
  panning: boolean
  animating: boolean
  reducedMotion: boolean
  subscribe: (listener: (transform: Transform) => void) => () => void
  screenToWorld: (point: Point) => Point
  worldToScreen: (point: Point) => Point
  /** The world-space rectangle currently visible. Drives edge culling. */
  viewportWorldRect: () => Rect
  zoomBy: (factor: number, screenCenter?: Point) => void
  panBy: (dx: number, dy: number) => void
  setTransform: (next: Transform, animate?: boolean) => void
  fitTo: (rect: Rect, padding?: number, animate?: boolean) => void
  onPointerDown: (event: React.PointerEvent<Element>) => void
  onDoubleClick: (event: React.MouseEvent<Element>) => void
  onKeyDown: (event: React.KeyboardEvent<Element>) => void
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Ease-out cubic: fast start, settled finish. Reads as "arriving", not "sliding". */
function easeOut(t: number): number {
  const u = 1 - t
  return 1 - u * u * u
}

export function useCanvasTransform(options: CanvasTransformOptions): CanvasTransformApi {
  const { containerRef, onDrillIn, onDrillOut } = options
  const minScale = options.minScale ?? 0.25
  const maxScale = options.maxScale ?? 12

  const transformRef = useRef<Transform>(IDENTITY)
  const [transform, setTransformState] = useState<Transform>(IDENTITY)
  const [size, setSize] = useState<Size>({ width: 960, height: 600 })
  const [panning, setPanning] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)

  const listenersRef = useRef(new Set<(transform: Transform) => void>())
  const flushRef = useRef<number | null>(null)
  const animationRef = useRef<number | null>(null)

  // --- reduced motion, live ------------------------------------------------
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // --- measurement ---------------------------------------------------------
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (width > 0 && height > 0) {
        setSize((prior) => (prior.width === width && prior.height === height ? prior : { width, height }))
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [containerRef])

  const commit = useCallback((next: Transform) => {
    transformRef.current = next
    for (const listener of listenersRef.current) listener(next)
    if (flushRef.current !== null) return
    flushRef.current = requestAnimationFrame(() => {
      flushRef.current = null
      setTransformState(transformRef.current)
    })
  }, [])

  const clampTransform = useCallback(
    (next: Transform): Transform => ({ ...next, k: clamp(next.k, minScale, maxScale) }),
    [minScale, maxScale],
  )

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
      setAnimating(false)
    }
  }, [])

  const animateTo = useCallback(
    (target: Transform) => {
      stopAnimation()
      const from = transformRef.current
      const to = clampTransform(target)
      if (reducedMotion) {
        commit(to)
        return
      }
      const start = performance.now()
      setAnimating(true)
      const step = (now: number): void => {
        const t = clamp((now - start) / TRANSITION_MS, 0, 1)
        const e = easeOut(t)
        commit({
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
          k: from.k + (to.k - from.k) * e,
        })
        if (t < 1) {
          animationRef.current = requestAnimationFrame(step)
        } else {
          animationRef.current = null
          setAnimating(false)
        }
      }
      animationRef.current = requestAnimationFrame(step)
    },
    [clampTransform, commit, reducedMotion, stopAnimation],
  )

  const setTransform = useCallback(
    (next: Transform, animate = false) => {
      if (animate) animateTo(next)
      else {
        stopAnimation()
        commit(clampTransform(next))
      }
    },
    [animateTo, clampTransform, commit, stopAnimation],
  )

  useEffect(() => {
    return () => {
      if (flushRef.current !== null) cancelAnimationFrame(flushRef.current)
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    }
  }, [])

  const subscribe = useCallback((listener: (transform: Transform) => void) => {
    listenersRef.current.add(listener)
    listener(transformRef.current)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  // --- coordinate conversion ----------------------------------------------
  const screenToWorld = useCallback((point: Point): Point => {
    const t = transformRef.current
    return { x: (point.x - t.x) / t.k, y: (point.y - t.y) / t.k }
  }, [])

  const worldToScreen = useCallback((point: Point): Point => {
    const t = transformRef.current
    return { x: point.x * t.k + t.x, y: point.y * t.k + t.y }
  }, [])

  const viewportWorldRect = useCallback((): Rect => {
    const t = transformRef.current
    return {
      x: -t.x / t.k,
      y: -t.y / t.k,
      width: size.width / t.k,
      height: size.height / t.k,
    }
  }, [size.height, size.width])

  // --- gestures ------------------------------------------------------------
  const zoomAbout = useCallback(
    (factor: number, center: Point, animate: boolean) => {
      const current = transformRef.current
      const k = clamp(current.k * factor, minScale, maxScale)
      if (k === current.k) return
      // Keep the world point under `center` pinned to `center`.
      const next = {
        k,
        x: center.x - ((center.x - current.x) / current.k) * k,
        y: center.y - ((center.y - current.y) / current.k) * k,
      }
      if (animate) animateTo(next)
      else commit(next)
    },
    [animateTo, commit, maxScale, minScale],
  )

  const zoomBy = useCallback(
    (factor: number, screenCenter?: Point) => {
      const center = screenCenter ?? { x: size.width / 2, y: size.height / 2 }
      zoomAbout(factor, center, true)
    },
    [size.height, size.width, zoomAbout],
  )

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const current = transformRef.current
      commit({ ...current, x: current.x + dx, y: current.y + dy })
    },
    [commit],
  )

  const fitTo = useCallback(
    (rect: Rect, padding = 48, animate = true) => {
      if (size.width <= 0 || size.height <= 0) return
      const width = Math.max(1, rect.width)
      const height = Math.max(1, rect.height)
      const k = clamp(
        Math.min((size.width - padding * 2) / width, (size.height - padding * 2) / height),
        minScale,
        maxScale,
      )
      const next = {
        k,
        x: size.width / 2 - (rect.x + width / 2) * k,
        y: size.height / 2 - (rect.y + height / 2) * k,
      }
      if (animate) animateTo(next)
      else setTransform(next)
    },
    [animateTo, maxScale, minScale, setTransform, size.height, size.width],
  )

  // Wheel has to be non-passive to cancel the page scroll, which React's
  // synthetic handler cannot do — hence the manual listener.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      const center = { x: event.clientX - box.left, y: event.clientY - box.top }
      // Trackpads report small deltas continuously; a mouse wheel reports ~100
      // at a time. Exponentiating the delta makes both feel the same.
      const factor = Math.exp(-event.deltaY * 0.0016)
      stopAnimation()
      zoomAbout(factor, center, false)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [containerRef, stopAnimation, zoomAbout])

  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<Element>) => {
      // Which gesture this is was decided the instant the pointer went down, by
      // what it landed on. A press on a drag handle belongs to the move
      // interaction and must not also pan — and asking the DOM directly is what
      // makes that true for every mark, not only the ones that remembered to
      // stop propagation on their way past.
      if (gestureFor(event) !== 'pan') return
      stopAnimation()
      dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
      setPanning(true)
      // Deliberately NO setPointerCapture. The pan already tracks the gesture on
      // window listeners, and capturing here retargets every subsequent pointer
      // event — and the `click` the browser synthesises from them — onto the
      // stage, which silently swallows every click on a node inside it. That is
      // exactly how a canvas ends up looking like nothing is clickable.
    },
    [stopAnimation],
  )

  useEffect(() => {
    if (!panning) return
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      const current = transformRef.current
      commit({ ...current, x: current.x + dx, y: current.y + dy })
    }
    const onUp = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag !== null && drag.pointerId !== event.pointerId) return
      dragRef.current = null
      setPanning(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [commit, panning])

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<Element>) => {
      const element = containerRef.current
      if (!element) return
      const box = element.getBoundingClientRect()
      const point = screenToWorld({ x: event.clientX - box.left, y: event.clientY - box.top })
      if (onDrillIn) onDrillIn(point)
      else zoomBy(1.8, { x: event.clientX - box.left, y: event.clientY - box.top })
    },
    [containerRef, onDrillIn, screenToWorld, zoomBy],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<Element>) => {
      const step = event.shiftKey ? 160 : 56
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          panBy(step, 0)
          return
        case 'ArrowRight':
          event.preventDefault()
          panBy(-step, 0)
          return
        case 'ArrowUp':
          event.preventDefault()
          panBy(0, step)
          return
        case 'ArrowDown':
          event.preventDefault()
          panBy(0, -step)
          return
        case '+':
        case '=':
          event.preventDefault()
          zoomBy(1.35)
          return
        case '-':
        case '_':
          event.preventDefault()
          zoomBy(1 / 1.35)
          return
        case 'Escape':
        case 'Backspace':
          event.preventDefault()
          onDrillOut?.()
          return
        default:
      }
    },
    [onDrillOut, panBy, zoomBy],
  )

  return useMemo(
    () => ({
      transform,
      transformRef,
      size,
      panning,
      animating,
      reducedMotion,
      subscribe,
      screenToWorld,
      worldToScreen,
      viewportWorldRect,
      zoomBy,
      panBy,
      setTransform,
      fitTo,
      onPointerDown,
      onDoubleClick,
      onKeyDown,
    }),
    [
      animating,
      fitTo,
      onDoubleClick,
      onKeyDown,
      onPointerDown,
      panBy,
      panning,
      reducedMotion,
      screenToWorld,
      setTransform,
      size,
      subscribe,
      transform,
      viewportWorldRect,
      worldToScreen,
      zoomBy,
    ],
  )
}
