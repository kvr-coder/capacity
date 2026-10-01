/**
 * Dragging load from one work center to another — the core interaction.
 *
 * The rules this hook exists to hold:
 *
 *   - **The move lands first.** A drop calls `applyMove` immediately, the model
 *     re-runs, and the canvas updates. The dated window, the share and the
 *     dual-source flag are refined afterwards, in place, on the applied move.
 *     Nothing here opens a modal to collect parameters before doing the thing.
 *   - **Every legal target lights up the moment a drag starts**, so the planner
 *     reads the option set instead of hunting for it. That set is classified
 *     once, at drag start, never per pointermove.
 *   - **Colour is never the only channel.** Each target carries a status, an
 *     icon and a text label, and an impossible target refuses the drop.
 *   - **Pointer events only**, so touch and pen work, with a full keyboard twin:
 *     focus a node, press `M`, arrow to a target, `Enter` to confirm.
 *
 * Performance: the pointer position is written straight onto the ghost element
 * and never enters React state. Only a change of *target* re-renders, so a drag
 * across 150 nodes costs a handful of renders rather than one per frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GroupId,
  MaterialSelector,
  Move,
  MoveId,
  ScenarioMove,
  WeekIndex,
  WorkCenterId,
} from '@/domain/types'
import { clamp } from '@/domain/lookup'
import { useActiveScenario, useUiStore } from '@/state/store'
import type { Point } from '@/canvas/projection'
import type {
  CapabilityCatalog,
  DropClassification,
  ImpactPreview,
  WorkCenterAggregate,
} from '@/canvas/layout'
import { classifyDrop, previewImpact } from '@/canvas/layout'
import { DRAG_THRESHOLD_PX, passedThreshold } from '@/canvas/gesture'

export interface DragPayload {
  kind: 'group' | 'workCenter'
  sourceWorkCenterId: WorkCenterId
  /** Present when a product-group chip is being dragged. */
  groupId?: GroupId
  /** What the ghost says it is moving. */
  label: string
  sourceLabel: string
  /** Hours the move would carry at share 1, over the current filter window. */
  hours: number
}

export interface DragMeta {
  payload: DragPayload
  targetId: WorkCenterId | null
  classification: DropClassification | null
  preview: ImpactPreview | null
  mode: 'pointer' | 'keyboard'
}

export interface AppliedMove {
  /** Set once the move has been located in the scenario's decision log. */
  moveId: MoveId | null
  /** The paired retrofit, when the target needed one. */
  retrofitMoveId: MoveId | null
  sourceWorkCenterId: WorkCenterId
  targetWorkCenterId: WorkCenterId
  sourceLabel: string
  targetLabel: string
  selector: MaterialSelector
  selectorLabel: string
  share: number
  fromWeek: WeekIndex
  toWeek: WeekIndex
  allowDualSource: boolean
  hours: number
  classification: DropClassification
  retrofitId: string | null
  retrofitAvailableFromWeek: WeekIndex
}

export interface DragMoveOptions {
  containerRef: { readonly current: HTMLElement | null }
  catalog: CapabilityCatalog | null
  aggregates: ReadonlyMap<WorkCenterId, WorkCenterAggregate>
  /** Every work center that could receive a drop, in reading order. */
  targetIds: readonly WorkCenterId[]
  /** Display label per work center, for the ghost and the applied-move text. */
  labelFor: (id: WorkCenterId) => string
  /**
   * World-space hit test, backed by the memoised layout. Takes the source so a
   * surface that stands for several work centers — a docked plant's card —
   * can resolve to the one that can actually take this load.
   */
  hitTest: (world: Point, sourceId: WorkCenterId) => WorkCenterId | null
  screenToWorld: (point: Point) => Point
  /** Screen position of a target, for keyboard navigation order. */
  positionOf: (id: WorkCenterId) => Point | null
  /** Authoritative bases from the worker, as seen FROM {@link approvedBasisFor}. */
  approvedBasis?: ReadonlyMap<WorkCenterId, 'approved' | 'featureCapable' | 'retrofit'>
  /**
   * The work center `approvedBasis` was computed for. The allow-list is
   * directional — "approved for the operations THIS work center runs" — so the
   * bases the worker returned for the selected node say nothing about a drag
   * that started somewhere else, and applying them anyway would let a drop
   * claim approval it does not have. When they do not match, the drag falls
   * back to the feature-only reading, which can never claim `approved`.
   */
  approvedBasisFor?: WorkCenterId | null
  fromWeek: WeekIndex
  toWeek: WeekIndex
  weekLabel: (week: WeekIndex) => string
}

export interface DragMoveApi {
  drag: DragMeta | null
  /** Classification for every target, published the instant a drag begins. */
  legalTargets: ReadonlyMap<WorkCenterId, DropClassification>
  /** Projected utilisation per work center while a drag is live. */
  previewUtilisation: ReadonlyMap<WorkCenterId, number>
  applied: AppliedMove | null
  ghostRef: (element: HTMLElement | null) => void
  beginPointerDrag: (payload: DragPayload, event: React.PointerEvent<Element>) => void
  beginKeyboardMove: (payload: DragPayload) => void
  /** Arrow keys while a keyboard move is armed. */
  stepKeyboardTarget: (direction: 'left' | 'right' | 'up' | 'down') => void
  confirmKeyboardMove: () => void
  cancelDrag: () => void
  updateApplied: (patch: Partial<Pick<AppliedMove, 'share' | 'fromWeek' | 'toWeek' | 'allowDualSource'>>) => void
  dismissApplied: () => void
  undoApplied: () => void
  describe: (applied: AppliedMove) => string
}

function selectorFor(payload: DragPayload): MaterialSelector {
  if (payload.kind === 'group' && payload.groupId !== undefined) {
    return { kind: 'group', id: payload.groupId }
  }
  return { kind: 'all' }
}

export function useDragMove(options: DragMoveOptions): DragMoveApi {
  const {
    containerRef,
    catalog,
    aggregates,
    targetIds,
    labelFor,
    hitTest,
    screenToWorld,
    positionOf,
    approvedBasis,
    approvedBasisFor,
    fromWeek,
    toWeek,
    weekLabel,
  } = options

  const applyMove = useUiStore((state) => state.applyMove)
  const removeMove = useUiStore((state) => state.removeMove)
  const undo = useUiStore((state) => state.undo)
  const scenario = useActiveScenario()

  const [drag, setDrag] = useState<DragMeta | null>(null)
  const [applied, setApplied] = useState<AppliedMove | null>(null)
  const appliedRef = useRef<AppliedMove | null>(null)
  appliedRef.current = applied

  const ghostElRef = useRef<HTMLElement | null>(null)
  const pointerRef = useRef<Point>({ x: 0, y: 0 })
  const frameRef = useRef<number | null>(null)
  const dragRef = useRef<DragMeta | null>(null)
  dragRef.current = drag

  /**
   * The authoritative bases, but only when they describe the work center the
   * load is leaving. See {@link DragMoveOptions.approvedBasisFor}.
   */
  const basisFor = useCallback(
    (
      sourceId: WorkCenterId,
    ): ReadonlyMap<WorkCenterId, 'approved' | 'featureCapable' | 'retrofit'> | undefined =>
      approvedBasisFor != null && approvedBasisFor === sourceId ? approvedBasis : undefined,
    [approvedBasis, approvedBasisFor],
  )

  // Handlers live for the length of a gesture; reading the latest callbacks
  // through refs keeps the window listeners from being re-bound mid-drag.
  const latest = useRef({ hitTest, screenToWorld, positionOf, labelFor, aggregates, catalog, basisFor })
  latest.current = { hitTest, screenToWorld, positionOf, labelFor, aggregates, catalog, basisFor }

  const ghostRef = useCallback((element: HTMLElement | null) => {
    ghostElRef.current = element
    if (element) {
      const { x, y } = pointerRef.current
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
  }, [])

  // --- the option set, classified once per drag ----------------------------
  const legalTargets = useMemo((): ReadonlyMap<WorkCenterId, DropClassification> => {
    const map = new Map<WorkCenterId, DropClassification>()
    if (drag === null || catalog === null) return map
    for (const targetId of targetIds) {
      map.set(
        targetId,
        classifyDrop({
          sourceId: drag.payload.sourceWorkCenterId,
          targetId,
          catalog,
          approvedBasis: basisFor(drag.payload.sourceWorkCenterId),
        }),
      )
    }
    return map
    // Only the source identity matters — moving the pointer must not reclassify.
  }, [basisFor, catalog, drag?.payload.sourceWorkCenterId, targetIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const previewUtilisation = useMemo((): ReadonlyMap<WorkCenterId, number> => {
    const map = new Map<WorkCenterId, number>()
    if (drag === null || drag.preview === null || drag.targetId === null) return map
    map.set(drag.payload.sourceWorkCenterId, drag.preview.sourceUtilisation)
    map.set(drag.targetId, drag.preview.targetUtilisation)
    return map
  }, [drag])

  const setTarget = useCallback((payload: DragPayload, targetId: WorkCenterId | null, mode: 'pointer' | 'keyboard') => {
    const store = latest.current
    const classification =
      targetId === null || store.catalog === null
        ? null
        : classifyDrop({
            sourceId: payload.sourceWorkCenterId,
            targetId,
            catalog: store.catalog,
            approvedBasis: store.basisFor(payload.sourceWorkCenterId),
          })
    const preview =
      targetId === null
        ? null
        : previewImpact(
            store.aggregates.get(payload.sourceWorkCenterId),
            store.aggregates.get(targetId),
            payload.hours,
            1,
          )
    setDrag((prior) => {
      if (prior !== null && prior.targetId === targetId && prior.mode === mode) return prior
      return { payload, targetId, classification, preview, mode }
    })
  }, [])

  const moveGhost = useCallback((x: number, y: number) => {
    pointerRef.current = { x, y }
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const element = ghostElRef.current
      if (element) {
        const { x: gx, y: gy } = pointerRef.current
        element.style.transform = `translate3d(${gx}px, ${gy}px, 0)`
      }
    })
  }, [])

  const cancelDrag = useCallback(() => {
    setDrag(null)
    dragRef.current = null
  }, [])

  // --- committing ----------------------------------------------------------
  const commitDrop = useCallback(
    (payload: DragPayload, targetId: WorkCenterId, classification: DropClassification) => {
      if (!classification.allowed) {
        // A refused drop still ends the gesture. Returning without clearing it
        // left the ghost pinned to the screen and every node dimmed behind it,
        // with no way back except a reload.
        cancelDrag()
        return
      }
      const selector = selectorFor(payload)
      const sourceLabel = latest.current.labelFor(payload.sourceWorkCenterId)
      const targetLabel = latest.current.labelFor(targetId)
      const retrofit = classification.retrofit ?? null
      const retrofitAvailableFromWeek = fromWeek + (retrofit?.leadTimeWeeks ?? 0)

      if (retrofit !== null) {
        const retrofitMove: Move = {
          kind: 'retrofit',
          workCenterId: targetId,
          retrofitId: retrofit.id,
          availableFromWeek: retrofitAvailableFromWeek,
        }
        applyMove(retrofitMove, `Retrofit ${targetLabel} — ${retrofit.name}`)
      }

      const move: Move = {
        kind: 'resourceMove',
        selector,
        fromWorkCenterId: payload.sourceWorkCenterId,
        toWorkCenterId: targetId,
        fromWeek,
        toWeek,
        share: 1,
        allowDualSource: false,
      }
      applyMove(move, `Move ${payload.label} from ${sourceLabel} to ${targetLabel}`)

      setApplied({
        moveId: null,
        retrofitMoveId: null,
        sourceWorkCenterId: payload.sourceWorkCenterId,
        targetWorkCenterId: targetId,
        sourceLabel,
        targetLabel,
        selector,
        selectorLabel: payload.label,
        share: 1,
        fromWeek,
        toWeek,
        allowDualSource: false,
        hours: payload.hours,
        classification,
        retrofitId: retrofit?.id ?? null,
        retrofitAvailableFromWeek,
      })
      cancelDrag()
    },
    [applyMove, cancelDrag, fromWeek, toWeek],
  )

  // --- pointer gesture -----------------------------------------------------
  const beginPointerDrag = useCallback(
    (payload: DragPayload, event: React.PointerEvent<Element>) => {
      event.stopPropagation()
      event.preventDefault()
      const box = containerRef.current?.getBoundingClientRect()
      const localX = event.clientX - (box?.left ?? 0)
      const localY = event.clientY - (box?.top ?? 0)
      pointerRef.current = { x: localX, y: localY }

      // A drag only becomes a drag past a few pixels. Without this every click
      // on a node would flash a ghost, and selecting a work center would feel
      // like a failed move.
      const origin = { x: localX, y: localY }
      let started = false
      const pointerId = event.pointerId
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey, true)
      }
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return
        // Touch and pen: without this the browser would treat the same travel as
        // a page scroll and steal the gesture halfway through. `touch-action:
        // none` on the handle covers the compliant path; this covers the rest.
        if (moveEvent.cancelable) moveEvent.preventDefault()
        const rect = containerRef.current?.getBoundingClientRect()
        const x = moveEvent.clientX - (rect?.left ?? 0)
        const y = moveEvent.clientY - (rect?.top ?? 0)
        if (!started) {
          if (!passedThreshold(origin, { x, y }, DRAG_THRESHOLD_PX)) return
          started = true
          const initial: DragMeta = { payload, targetId: null, classification: null, preview: null, mode: 'pointer' }
          dragRef.current = initial
          setDrag(initial)
        }
        moveGhost(x, y)
        const world = latest.current.screenToWorld({ x, y })
        setTarget(payload, latest.current.hitTest(world, payload.sourceWorkCenterId), 'pointer')
      }
      const onUp = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== pointerId) return
        detach()
        if (!started) return
        const current = dragRef.current
        if (current?.targetId != null && current.classification !== null) {
          commitDrop(payload, current.targetId, current.classification)
        } else {
          // Released over nothing. Same exit as a refusal: the gesture ends and
          // takes its ghost and its dimming with it.
          cancelDrag()
        }
      }
      const onCancel = (): void => {
        detach()
        cancelDrag()
      }
      // Escape abandons a pointer drag exactly as it abandons a keyboard one.
      const onKey = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== 'Escape') return
        keyEvent.preventDefault()
        detach()
        cancelDrag()
      }
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKey, true)
    },
    [cancelDrag, commitDrop, containerRef, moveGhost, setTarget],
  )

  // --- keyboard twin -------------------------------------------------------
  const beginKeyboardMove = useCallback(
    (payload: DragPayload) => {
      const store = latest.current
      const first =
        targetIds.find(
          (id) =>
            id !== payload.sourceWorkCenterId &&
            store.catalog !== null &&
            classifyDrop({
              sourceId: payload.sourceWorkCenterId,
              targetId: id,
              catalog: store.catalog,
              approvedBasis: store.basisFor(payload.sourceWorkCenterId),
            }).allowed,
        ) ?? null
      setTarget(payload, first, 'keyboard')
    },
    [setTarget, targetIds],
  )

  const stepKeyboardTarget = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      const current = dragRef.current
      if (current === null) return
      const store = latest.current
      const origin = current.targetId === null ? store.positionOf(current.payload.sourceWorkCenterId) : store.positionOf(current.targetId)
      if (origin === null) return
      const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
      const sign = direction === 'right' || direction === 'down' ? 1 : -1

      let best: { id: WorkCenterId; cost: number } | null = null
      for (const id of targetIds) {
        if (id === current.targetId || id === current.payload.sourceWorkCenterId) continue
        const classification = store.catalog === null
          ? null
          : classifyDrop({
              sourceId: current.payload.sourceWorkCenterId,
              targetId: id,
              catalog: store.catalog,
              approvedBasis: store.basisFor(current.payload.sourceWorkCenterId),
            })
        if (classification === null || !classification.allowed) continue
        const position = store.positionOf(id)
        if (position === null) continue
        const along = (axis === 'x' ? position.x - origin.x : position.y - origin.y) * sign
        if (along <= 0) continue
        const across = axis === 'x' ? Math.abs(position.y - origin.y) : Math.abs(position.x - origin.x)
        // Prefer the nearest candidate in the requested direction, penalising
        // sideways drift so arrowing right does not jump a row.
        const cost = along + across * 2
        if (best === null || cost < best.cost) best = { id, cost }
      }
      if (best !== null) setTarget(current.payload, best.id, 'keyboard')
    },
    [setTarget, targetIds],
  )

  const confirmKeyboardMove = useCallback(() => {
    const current = dragRef.current
    if (current === null || current.targetId === null || current.classification === null) return
    commitDrop(current.payload, current.targetId, current.classification)
  }, [commitDrop])

  // --- locating the applied move in the decision log -----------------------
  useEffect(() => {
    if (applied === null) return
    if (applied.moveId !== null && (applied.retrofitId === null || applied.retrofitMoveId !== null)) return
    let move: ScenarioMove | null = null
    let retrofit: ScenarioMove | null = null
    for (const entry of scenario.moves) {
      if (
        entry.move.kind === 'resourceMove' &&
        entry.move.fromWorkCenterId === applied.sourceWorkCenterId &&
        entry.move.toWorkCenterId === applied.targetWorkCenterId &&
        (move === null || entry.seq > move.seq)
      ) {
        move = entry
      }
      if (
        applied.retrofitId !== null &&
        entry.move.kind === 'retrofit' &&
        entry.move.workCenterId === applied.targetWorkCenterId &&
        entry.move.retrofitId === applied.retrofitId &&
        (retrofit === null || entry.seq > retrofit.seq)
      ) {
        retrofit = entry
      }
    }
    if (move === null && retrofit === null) return
    setApplied((prior) => {
      if (prior === null) return prior
      const nextMoveId = move?.id ?? prior.moveId
      const nextRetrofitId = retrofit?.id ?? prior.retrofitMoveId
      if (nextMoveId === prior.moveId && nextRetrofitId === prior.retrofitMoveId) return prior
      return { ...prior, moveId: nextMoveId, retrofitMoveId: nextRetrofitId }
    })
  }, [applied, scenario.moves])

  /**
   * Refine the move that has already landed: drop the old `resourceMove` and
   * apply the replacement. The side effects deliberately sit OUTSIDE the state
   * updater — an updater must stay pure, and React calls it twice in
   * development, which would remove and re-apply the move two times over.
   */
  const updateApplied = useCallback(
    (patch: Partial<Pick<AppliedMove, 'share' | 'fromWeek' | 'toWeek' | 'allowDualSource'>>) => {
      const prior = appliedRef.current
      if (prior === null) return
      const next: AppliedMove = { ...prior, ...patch, share: clamp(patch.share ?? prior.share, 0, 1) }
      if (next.fromWeek > next.toWeek) next.toWeek = next.fromWeek
      if (prior.moveId !== null) removeMove(prior.moveId)
      applyMove(
        {
          kind: 'resourceMove',
          selector: next.selector,
          fromWorkCenterId: next.sourceWorkCenterId,
          toWorkCenterId: next.targetWorkCenterId,
          fromWeek: next.fromWeek,
          toWeek: next.toWeek,
          share: next.share,
          allowDualSource: next.allowDualSource,
        },
        `Move ${next.selectorLabel} from ${next.sourceLabel} to ${next.targetLabel}`,
      )
      // Cleared so the locator effect re-attaches to the replacement move.
      const committed = { ...next, moveId: null }
      appliedRef.current = committed
      setApplied(committed)
    },
    [applyMove, removeMove],
  )

  const dismissApplied = useCallback(() => setApplied(null), [])

  const undoApplied = useCallback(() => {
    undo()
    setApplied(null)
  }, [undo])

  const describe = useCallback(
    (item: AppliedMove): string => {
      const portion = item.share >= 0.999 ? 'all' : `${Math.round(item.share * 100)}% of`
      const window = `${weekLabel(item.fromWeek)} to ${weekLabel(item.toWeek)}`
      const dual = item.allowDualSource ? ', dual sourcing allowed' : ''
      return `Moved ${portion} ${item.selectorLabel} load from ${item.sourceLabel} to ${item.targetLabel}, ${window}${dual}.`
    },
    [weekLabel],
  )

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  return {
    drag,
    legalTargets,
    previewUtilisation,
    applied,
    ghostRef,
    beginPointerDrag,
    beginKeyboardMove,
    stepKeyboardTarget,
    confirmKeyboardMove,
    cancelDrag,
    updateApplied,
    dismissApplied,
    undoApplied,
    describe,
  }
}
