/**
 * Telling a move gesture from a pan, before either has travelled a pixel.
 *
 * One canvas, two gestures that start identically: a press on the stage pans
 * the whole world, a press on a work-center node picks its load up. The only
 * thing that separates them is WHAT WAS UNDER THE POINTER when it went down, so
 * that question is answered once, at `pointerdown`, and never revisited — a
 * gesture that changes its mind halfway is a gesture nobody can aim.
 *
 * Relying on event propagation alone to keep the two apart is what let a drag on
 * a node scroll the stage instead: the node handler stopped propagation, but a
 * node drawn without a handler, a label, a badge, or any mark added later fell
 * straight through to the pan. So the pan asks the question directly instead —
 * "did this press land on a drag handle?" — and the answer is carried in the DOM
 * by {@link DRAG_HANDLE_ATTRIBUTE}, which every draggable mark stamps on itself.
 *
 * Everything here is pure and DOM-agnostic (it needs only `closest`), so the
 * rules are unit-testable rather than only observable through a browser.
 */

import type { Point } from '@/canvas/projection'

/**
 * Pointer travel before a press becomes a drag rather than a click.
 *
 * Shared by both halves on purpose: the move gesture uses it to decide when to
 * raise a ghost, and the click path uses it to decide whether the `click` the
 * browser synthesises at the end was the tail of a drag. Two different numbers
 * would leave a band of travel that is neither a click nor a drag.
 */
export const DRAG_THRESHOLD_PX = 5

/**
 * Marks a mark as a drag handle. Its value names what is being picked up, which
 * is what makes a press on a product-group chip a different gesture from a press
 * on the work center that owns it.
 */
export const DRAG_HANDLE_ATTRIBUTE = 'data-canvas-drag'

export const DRAG_HANDLE_SELECTOR = `[${DRAG_HANDLE_ATTRIBUTE}]`

/** What a press on this mark starts. */
export type DragHandleKind = 'workCenter' | 'group'

/** The gesture a press begins. Decided once, at pointerdown. */
export type GestureKind = 'move' | 'pan'

/**
 * The slice of `Element` this module needs. Declared structurally so the rules
 * can be tested in a plain Node environment, where there is no DOM at all.
 */
export interface GestureTarget {
  closest(selector: string): { getAttribute(name: string): string | null } | null
}

function asTarget(value: unknown): GestureTarget | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { closest?: unknown }
  return typeof candidate.closest === 'function' ? (value as GestureTarget) : null
}

/**
 * The kind of thing this press landed on, or null when it landed on the stage.
 *
 * Walks ancestors, because the mark actually under the pointer is usually a
 * child of the handle — the hit circle sits inside the node group, the label
 * inside the chip.
 */
export function dragHandleKindAt(target: unknown): DragHandleKind | null {
  const element = asTarget(target)
  if (element === null) return null
  const handle = element.closest(DRAG_HANDLE_SELECTOR)
  if (handle === null) return null
  const value = handle.getAttribute(DRAG_HANDLE_ATTRIBUTE)
  return value === 'group' ? 'group' : value === 'workCenter' ? 'workCenter' : null
}

export interface GestureInput {
  /** The DOM element the pointer went down on. */
  target: unknown
  /** `PointerEvent.button`. Only the primary button drags or pans. */
  button?: number
  /** `PointerEvent.pointerType`. Touch and pen have no button to speak of. */
  pointerType?: string
}

/**
 * What this press starts: a move when it landed on a drag handle, a pan
 * otherwise.
 *
 * A non-primary mouse button starts neither — right-click belongs to the
 * browser, and a middle-click pan would fight the one the stage already has.
 * Touch and pen report button 0 or -1 depending on the browser, so the button is
 * only consulted for a mouse.
 */
export function gestureFor(input: GestureInput): GestureKind | 'none' {
  const pointerType = input.pointerType ?? 'mouse'
  const button = input.button ?? 0
  if (pointerType === 'mouse' && button !== 0) return 'none'
  return dragHandleKindAt(input.target) === null ? 'pan' : 'move'
}

/** True once the pointer has travelled far enough to mean it. */
export function passedThreshold(origin: Point, point: Point, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(point.x - origin.x, point.y - origin.y) >= threshold
}
