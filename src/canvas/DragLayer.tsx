/**
 * The drag ghost and the applied-move affordance.
 *
 * The interaction model this file implements, stated plainly: **the move lands
 * first and is refined in place.** A drop calls `applyMove` immediately, the
 * worker re-runs, the canvas updates — and only then does a compact card appear
 * carrying the share, the dated window, the dual-source flag and Undo. Nothing
 * is collected behind a modal before the thing happens, because a planner
 * dragging load is thinking about the shape of the answer, not about week
 * numbers and share percentages.
 *
 * While the pointer is down, the ghost states what is being moved, how many
 * hours it carries, and what the drop would mean at the target. Every one of the
 * four verdicts ships a status colour, an icon and a written label — colour is
 * never the only channel — and an impossible target says so and refuses.
 */

import { useCallback, useEffect, useState } from 'react'
import type { WeekIndex } from '@/domain/types'
import { clamp } from '@/domain/lookup'
import { hours as fmtHours, pct, usd } from '@/lib/format'
import { statusColor } from '@/charts/palette'
import type { DropIcon, DropStatus } from '@/canvas/layout'
import type { AppliedMove, DragMeta } from '@/canvas/useDragMove'
import styles from '@/canvas/DragLayer.module.css'

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * Icon geometry in a -8..8 box. Drawn rather than typed, so the four verdicts
 * stay distinguishable at 14px where a glyph font would not be.
 */
function DropIconShapes({ icon, color }: { icon: DropIcon; color: string }) {
  switch (icon) {
    case 'check':
      return (
        <polyline
          points="-4.4,0.2 -1.4,3.4 4.4,-3.6"
          fill="none"
          stroke={color}
          strokeWidth={2.3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'wrench':
      return (
        <g transform="rotate(-45)" fill={color} stroke={color}>
          <path
            d="M-3.3,-1.4 A3.5,3.5 0 1 1 3.3,-1.4"
            fill="none"
            strokeWidth={2.3}
            strokeLinecap="round"
          />
          <rect x={-1.5} y={-1.4} width={3} height={8.4} rx={1.4} stroke="none" />
        </g>
      )
    case 'tool':
      // A cog rather than a second wrench: "needs qualification" and "needs
      // retrofit" sit next to each other constantly, and two angled hand tools
      // are indistinguishable at 15px. A toothed disc against a bar is not.
      return (
        <g>
          <g fill={color}>
            {[0, 45, 90, 135].map((angle) => (
              <rect key={angle} x={-1.7} y={-7.4} width={3.4} height={14.8} rx={1.2} transform={`rotate(${angle})`} />
            ))}
            <circle r={4.8} />
          </g>
          <circle r={2} fill="var(--surface-2)" />
        </g>
      )
    case 'blocked':
    default:
      return (
        <g fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round">
          <circle cx={0} cy={0} r={5.2} />
          <line x1={-3.7} y1={-3.7} x2={3.7} y2={3.7} />
        </g>
      )
  }
}

export interface DropIconMarkProps {
  icon: DropIcon
  status: DropStatus
  size?: number
}

/** For use inside the canvas SVG: a surface plate with the verdict icon on it. */
export function DropIconMark({ icon, status, size = 16 }: DropIconMarkProps) {
  const color = statusColor(status)
  const scale = size / 16
  return (
    <g transform={`scale(${scale})`} aria-hidden="true">
      <circle r={8.5} className={styles.iconPlate} />
      <DropIconShapes icon={icon} color={color} />
    </g>
  )
}

/** The same icon for HTML contexts — cards, chips, the legend. */
export function DropIconBadge({ icon, status, size = 16 }: DropIconMarkProps) {
  return (
    <svg viewBox="-9 -9 18 18" width={size} height={size} className={styles.iconSvg} aria-hidden="true">
      <DropIconShapes icon={icon} color={statusColor(status)} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Ghost
// ---------------------------------------------------------------------------

export interface DragGhostProps {
  drag: DragMeta
  ghostRef: (element: HTMLElement | null) => void
}

/**
 * Follows the pointer imperatively — the position is written onto the element by
 * `useDragMove` and never enters React state, so a drag across 150 nodes costs
 * one render per change of *target* rather than one per frame.
 */
export function DragGhost({ drag, ghostRef }: DragGhostProps) {
  const { payload, classification, preview } = drag
  return (
    <div className={styles.ghost} ref={ghostRef} role="status" aria-live="polite">
      <div className={styles.ghostHead}>
        <span className={styles.ghostKind}>{payload.kind === 'group' ? 'Product group' : 'Work center'}</span>
        <span className={styles.ghostLabel}>{payload.label}</span>
      </div>
      <div className={styles.ghostHours}>
        <span className={styles.ghostHoursValue}>{fmtHours(payload.hours, { compact: true })}</span>
        <span className={styles.ghostHoursNote}>on {payload.sourceLabel}, this window</span>
      </div>

      {classification === null ? (
        <div className={styles.ghostHint}>Drop on a work center to move this load</div>
      ) : (
        <div className={styles.verdict} data-allowed={classification.allowed ? 'yes' : 'no'}>
          <span className={styles.verdictHead}>
            <DropIconBadge icon={classification.icon} status={classification.status} size={15} />
            <span className={styles.verdictLabel}>{classification.label}</span>
          </span>
          <span className={styles.verdictDetail}>{classification.detail}</span>
          {classification.basis === 'retrofit' ? (
            <span className={styles.verdictCost}>
              {usd(classification.capexUsd, { compact: true })} capex · {classification.leadTimeWeeks} wk lead
            </span>
          ) : null}
          {!classification.allowed ? <span className={styles.verdictRefuse}>Drop refused</span> : null}
        </div>
      )}

      {preview !== null && classification?.allowed === true ? (
        <div className={styles.preview}>
          <span className={styles.previewRow}>
            <span className={styles.previewLabel}>Source</span>
            <span className={styles.previewValue}>
              {pct(preview.sourceBefore, 0)} <span className={styles.previewArrow}>→</span>{' '}
              {pct(preview.sourceUtilisation, 0)}
            </span>
          </span>
          <span className={styles.previewRow}>
            <span className={styles.previewLabel}>Target</span>
            <span className={styles.previewValue}>
              {pct(preview.targetBefore, 0)} <span className={styles.previewArrow}>→</span>{' '}
              {pct(preview.targetUtilisation, 0)}
            </span>
          </span>
          <span className={styles.previewNote}>
            {fmtHours(preview.landedHours, { compact: true })} land at the target after the OEE conversion
          </span>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Applied-move affordance
// ---------------------------------------------------------------------------

export interface AppliedMoveCardProps {
  applied: AppliedMove
  describe: (applied: AppliedMove) => string
  weekLabel: (week: WeekIndex) => string
  weekCount: number
  busy?: boolean
  onUpdate: (patch: Partial<Pick<AppliedMove, 'share' | 'fromWeek' | 'toWeek' | 'allowDualSource'>>) => void
  onUndo: () => void
  onDismiss: () => void
}

/**
 * The move has already happened. This card is where it gets argued with.
 *
 * The slider reports continuously but only commits on release, so dragging it
 * does not queue a dozen model runs — the number under the thumb is local until
 * the pointer comes up.
 */
export function AppliedMoveCard({
  applied,
  describe,
  weekLabel,
  weekCount,
  busy,
  onUpdate,
  onUndo,
  onDismiss,
}: AppliedMoveCardProps) {
  const [sharePercent, setSharePercent] = useState(Math.round(applied.share * 100))

  useEffect(() => {
    setSharePercent(Math.round(applied.share * 100))
  }, [applied.share, applied.moveId])

  const commitShare = useCallback(() => {
    const next = clamp(sharePercent / 100, 0, 1)
    if (Math.abs(next - applied.share) < 0.0005) return
    onUpdate({ share: next })
  }, [applied.share, onUpdate, sharePercent])

  const stepWeek = useCallback(
    (which: 'fromWeek' | 'toWeek', delta: number) => {
      const lastWeek = Math.max(0, weekCount - 1)
      if (which === 'fromWeek') {
        const value = clamp(applied.fromWeek + delta, 0, lastWeek)
        onUpdate({ fromWeek: value, toWeek: Math.max(value, applied.toWeek) })
      } else {
        const value = clamp(applied.toWeek + delta, 0, lastWeek)
        onUpdate({ toWeek: Math.max(applied.fromWeek, value) })
      }
    },
    [applied.fromWeek, applied.toWeek, onUpdate, weekCount],
  )

  const weekSpan = applied.toWeek - applied.fromWeek + 1

  return (
    <div className={styles.applied} role="region" aria-label="Move applied">
      <div className={styles.appliedHead}>
        <span className={styles.appliedBadge}>
          <DropIconBadge icon={applied.classification.icon} status={applied.classification.status} size={15} />
          <span>Move applied</span>
        </span>
        <span className={styles.appliedStatus} aria-live="polite">
          {busy === true ? 'Recomputing…' : `${weekSpan} week${weekSpan === 1 ? '' : 's'} affected`}
        </span>
        <button type="button" className={styles.iconButton} onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>

      <p className={styles.appliedText}>{describe(applied)}</p>

      {applied.retrofitId !== null ? (
        <p className={styles.appliedRetrofit}>
          Paired with a retrofit at {applied.targetLabel}: {usd(applied.classification.capexUsd, { compact: true })}{' '}
          capex, usable from {weekLabel(applied.retrofitAvailableFromWeek)}.
        </p>
      ) : null}

      <div className={styles.controls}>
        <label className={styles.control}>
          <span className={styles.controlLabel}>
            Share <span className={styles.controlValue}>{sharePercent}%</span>
          </span>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={100}
            step={1}
            value={sharePercent}
            onChange={(event) => setSharePercent(Number(event.target.value))}
            onPointerUp={commitShare}
            onKeyUp={commitShare}
            onBlur={commitShare}
            aria-label="Share of source volume moved"
          />
        </label>

        <div className={styles.control}>
          <span className={styles.controlLabel}>From week</span>
          <div className={styles.stepper}>
            <button type="button" onClick={() => stepWeek('fromWeek', -1)} aria-label="Move start one week earlier">
              −
            </button>
            <span className={styles.stepperValue}>{weekLabel(applied.fromWeek)}</span>
            <button type="button" onClick={() => stepWeek('fromWeek', 1)} aria-label="Move start one week later">
              +
            </button>
          </div>
        </div>

        <div className={styles.control}>
          <span className={styles.controlLabel}>To week</span>
          <div className={styles.stepper}>
            <button type="button" onClick={() => stepWeek('toWeek', -1)} aria-label="Move end one week earlier">
              −
            </button>
            <span className={styles.stepperValue}>{weekLabel(applied.toWeek)}</span>
            <button type="button" onClick={() => stepWeek('toWeek', 1)} aria-label="Move end one week later">
              +
            </button>
          </div>
        </div>

        <div className={styles.control}>
          <span className={styles.controlLabel}>Sourcing</span>
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={applied.allowDualSource}
            aria-label={
              applied.allowDualSource
                ? 'Dual sourcing allowed — two sources may serve the same bucket'
                : 'Single source per bucket — a bucket with two sources is rejected'
            }
            title={
              applied.allowDualSource
                ? 'Two sources may serve the same bucket.'
                : 'A bucket that would end up with two sources is rejected. A transfer between buckets is a different thing and stays allowed.'
            }
            onClick={() => onUpdate({ allowDualSource: !applied.allowDualSource })}
          >
            <span className={styles.toggleTrack} aria-hidden="true">
              <span className={styles.toggleThumb} />
            </span>
            {applied.allowDualSource ? 'Dual source' : 'Single source'}
          </button>
        </div>
      </div>

      <div className={styles.appliedFooter}>
        <span className={styles.appliedHours}>
          {fmtHours(applied.hours * applied.share, { compact: true })} of load redirected
        </span>
        <button type="button" className={styles.undo} onClick={onUndo}>
          Undo
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

export interface DragLayerProps extends Omit<AppliedMoveCardProps, 'applied'> {
  drag: DragMeta | null
  ghostRef: (element: HTMLElement | null) => void
  applied: AppliedMove | null
}

export function DragLayer({ drag, ghostRef, applied, ...rest }: DragLayerProps) {
  return (
    <div className={styles.layer}>
      {drag !== null ? <DragGhost drag={drag} ghostRef={ghostRef} /> : null}
      {applied !== null ? <AppliedMoveCard applied={applied} {...rest} /> : null}
    </div>
  )
}
