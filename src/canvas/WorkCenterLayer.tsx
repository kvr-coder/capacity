/**
 * One work center, opened up — still on the same canvas, not a separate screen.
 *
 * Everything a planner needs to argue with a bottleneck, laid out around the
 * node they drilled into:
 *
 *   - the **weekly load strip** against that week's own ceiling, because
 *     downtime moves the ceiling and a single flat capacity line across a
 *     horizon containing a shutdown would be a comfortable lie;
 *   - the **product groups** on it, as draggable chips — this is where a move
 *     starts, and each chip states the hours it carries before it is picked up;
 *   - the **planned downtime** as dated bands under the strip. Planned loss is
 *     dated and arguable; unplanned loss lives inside OEE and is never given a
 *     date here, because giving it one would be a precise-looking lie;
 *   - the **OEE curve** on its own panel with its own axis — never a second
 *     y-axis bolted onto the load chart;
 *   - the **relief candidates** as ghost nodes, fanned below the focused node
 *     and droppable, each carrying its basis, its spare hours and its price.
 */

import { memo } from 'react'
import type { CapacityPool, ReliefCandidate, WeekIndex, WorkCenterId } from '@/domain/types'
import type { WorkCenterDetail } from '@/worker/protocol'
import { at, clamp } from '@/domain/lookup'
import { hours as fmtHours, pct, usd } from '@/lib/format'
import { divergingColor, statusColor } from '@/charts/palette'
import type { DropClassification, WorkCenterAggregate } from '@/canvas/layout'
import { layoutGhostFan, layoutStrip, utilisationSignal } from '@/canvas/layout'
import { DropIconMark } from '@/canvas/DragLayer'
import styles from '@/canvas/WorkCenterLayer.module.css'

const FOCUS = { x: 170, y: 150, r: 56 }
const GHOST = { radius: 250, r: 34, span: Math.PI * 0.62, centerAngle: Math.PI / 2 }
const CHIPS = { x: -20, y: 470, width: 320, rowHeight: 30, gap: 7 }
const PANEL = { x: 470, width: 780 }
const STRIP = { y: 66, height: 168 }
const DOWNTIME = { y: 288, height: 26 }
const OEE = { y: 372, height: 118 }

const BASIS_STATUS: Record<ReliefCandidate['basis'], { status: DropClassification['status']; icon: DropClassification['icon']; label: string }> = {
  approved: { status: 'good', icon: 'check', label: 'Approved' },
  featureCapable: { status: 'warning', icon: 'wrench', label: 'Needs qualification' },
  retrofit: { status: 'serious', icon: 'tool', label: 'Needs retrofit' },
}

/** World rectangle this layer occupies. The transform fits to it on entry. */
export const WORK_CENTER_WORLD = { x: -160, y: -40, width: 1450, height: 740 }

/** The focused node, for hit testing and keyboard navigation. */
export const WORK_CENTER_FOCUS = { x: FOCUS.x, y: FOCUS.y, r: FOCUS.r }

/**
 * Where the relief ghosts land, given the candidates in rank order.
 *
 * Exported so the canvas can hit-test and keyboard-navigate the same circles the
 * layer draws — two copies of this geometry would drift apart within a week.
 */
export function workCenterGhostTargets(
  candidateIds: readonly WorkCenterId[],
): Array<{ id: WorkCenterId; x: number; y: number; r: number }> {
  const slots = layoutGhostFan(
    candidateIds.length,
    { x: FOCUS.x, y: FOCUS.y },
    GHOST.radius,
    GHOST.r,
    GHOST.span,
    GHOST.centerAngle,
  )
  return candidateIds.map((id, index) => {
    const slot = at(slots, index, 'ghost slot')
    return { id, x: slot.x, y: slot.y, r: slot.r + 8 }
  })
}

export interface GroupChip {
  groupId: string
  label: string
  hours: number
}

export interface WorkCenterLayerProps {
  workCenterId: WorkCenterId
  code: string
  name: string
  className: string
  plantLabel: string
  aggregate: WorkCenterAggregate | undefined
  detail: WorkCenterDetail | null
  relief: readonly ReliefCandidate[] | null
  loading: boolean
  fromWeek: WeekIndex
  toWeek: WeekIndex
  weekLabel: (week: WeekIndex) => string
  codeOf: (id: WorkCenterId) => string
  /** Live drag state, so ghost nodes light up exactly like real ones. */
  dropTargets?: ReadonlyMap<WorkCenterId, DropClassification> | null
  activeTargetId?: WorkCenterId | null
  previewUtilisation?: ReadonlyMap<WorkCenterId, number>
  onFocusPointerDown: (event: React.PointerEvent<Element>) => void
  onChipPointerDown: (chip: GroupChip, event: React.PointerEvent<Element>) => void
  /**
   * A single click on a relief candidate, or Enter on it: selects that work
   * center and opens its layer, same as everywhere else on the canvas.
   */
  onCandidateActivate: (id: WorkCenterId, event: { clientX: number; clientY: number }) => void
  onHover: (id: WorkCenterId | null) => void
}

interface DowntimeBand {
  fromWeek: WeekIndex
  toWeek: WeekIndex
  hours: number
  kind: string
  label: string
}

/** Contiguous weeks of the same event collapse into one dated band. */
export function collapseDowntime(
  entries: ReadonlyArray<{ week: WeekIndex; hours: number; kind: string; label: string }>,
): DowntimeBand[] {
  const sorted = [...entries].sort((a, b) => a.week - b.week)
  const bands: DowntimeBand[] = []
  for (const entry of sorted) {
    const last = bands.length > 0 ? at(bands, bands.length - 1, 'downtime band') : null
    if (last !== null && last.label === entry.label && entry.week <= last.toWeek + 1) {
      last.toWeek = Math.max(last.toWeek, entry.week)
      last.hours += entry.hours
      continue
    }
    bands.push({ fromWeek: entry.week, toWeek: entry.week, hours: entry.hours, kind: entry.kind, label: entry.label })
  }
  return bands
}

export const WorkCenterLayer = memo(function WorkCenterLayer({
  workCenterId,
  code,
  name,
  className,
  plantLabel,
  aggregate,
  detail,
  relief,
  loading,
  fromWeek,
  toWeek,
  weekLabel,
  codeOf,
  dropTargets,
  activeTargetId,
  previewUtilisation,
  onFocusPointerDown,
  onChipPointerDown,
  onCandidateActivate,
  onHover,
}: WorkCenterLayerProps) {
  const cells = (detail?.cells ?? []).filter((cell) => cell.week >= fromWeek && cell.week <= toWeek)
  const strip = layoutStrip(
    cells.map((cell) => ({
      week: cell.week,
      requiredHours: cell.bindingPool === 'labour' ? cell.labourRequired : cell.machineRequired,
      availableHours: cell.bindingPool === 'labour' ? cell.labourAvailable : cell.machineAvailable,
      ceiling: cell.ceiling,
    })),
    PANEL.width,
    STRIP.height,
  )

  const chips: GroupChip[] = (detail?.groupHours ?? [])
    .map((group) => ({
      groupId: group.groupId,
      label: group.label,
      hours: group.hours.reduce((total, value, week) => (week >= fromWeek && week <= toWeek ? total + value : total), 0),
    }))
    .filter((chip) => chip.hours > 0)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 8)

  const bands = collapseDowntime(detail?.downtimeByWeek ?? [])
  const oee = (detail?.oeeByWeek ?? []).slice(fromWeek, toWeek + 1)
  const candidates = (relief ?? []).slice(0, 7)
  const ghosts = layoutGhostFan(
    candidates.length,
    { x: FOCUS.x, y: FOCUS.y },
    GHOST.radius,
    GHOST.r,
    GHOST.span,
    GHOST.centerAngle,
  )

  const focusUtilisation = previewUtilisation?.get(workCenterId) ?? aggregate?.utilisation ?? 0
  const bindingPool: CapacityPool = aggregate?.bindingPool ?? 'machine'

  return (
    <g className={styles.layer}>
      {/* --- the focused node --------------------------------------------- */}
      <g transform={`translate(${FOCUS.x},${FOCUS.y})`}>
        <circle r={FOCUS.r} className={styles.focusDisc} />
        <circle r={FOCUS.r - 6} fill="none" className={styles.focusTrack} strokeWidth={9} />
        <circle
          r={FOCUS.r - 6}
          fill="none"
          stroke={divergingColor(utilisationSignal(focusUtilisation))}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * (FOCUS.r - 6)}
          strokeDashoffset={2 * Math.PI * (FOCUS.r - 6) * (1 - clamp(focusUtilisation / 1.25, 0, 1))}
          transform="rotate(-90)"
          className={styles.focusRing}
        />
        <text className={styles.focusValue} y={4} textAnchor="middle">
          {pct(focusUtilisation, 0)}
        </text>
        <text className={styles.focusValueNote} y={20} textAnchor="middle">
          of ceiling
        </text>
        <circle
          r={FOCUS.r + 6}
          className={styles.grab}
          onPointerDown={onFocusPointerDown}
          onPointerEnter={() => onHover(workCenterId)}
          onPointerLeave={() => onHover(null)}
        >
          <title>{`Drag ${code} to move all of its load to another work center.`}</title>
        </circle>
      </g>

      <g transform={`translate(${FOCUS.x + FOCUS.r + 26},${FOCUS.y - 30})`}>
        <text className={styles.title}>{code}</text>
        <text className={styles.subtitle} y={20}>
          {name}
        </text>
        <text className={styles.meta} y={40}>
          {`${plantLabel} · ${className}`}
        </text>
        <g transform="translate(0,54)">
          <rect x={0} y={-11} width={bindingPool === 'labour' ? 92 : 100} height={18} rx={9} className={styles.metaChip} />
          <text className={styles.metaChipText} x={9} y={2}>
            {bindingPool === 'labour' ? 'Labour bound' : 'Machine bound'}
          </text>
        </g>
      </g>

      {/* --- product group chips ------------------------------------------- */}
      <g transform={`translate(${CHIPS.x},${CHIPS.y})`}>
        <text className={styles.sectionLabel} y={-14}>
          Product groups — drag one to move its load
        </text>
        {chips.length === 0 ? (
          <g>
            <rect x={0} y={0} width={CHIPS.width} height={44} rx={8} className={styles.emptyPlate} />
            <text className={styles.emptyBody} x={14} y={27}>
              {loading ? 'Loading composition…' : 'No load in this window.'}
            </text>
          </g>
        ) : (
          chips.map((chip, index) => {
            const y = index * (CHIPS.rowHeight + CHIPS.gap)
            return (
              <g key={chip.groupId} className={styles.chip} transform={`translate(0,${y})`}>
                <rect width={CHIPS.width} height={CHIPS.rowHeight} rx={8} className={styles.chipPlate} />
                <rect x={9} y={CHIPS.rowHeight / 2 - 6} width={4} height={12} rx={2} className={styles.chipGrip} />
                <text className={styles.chipLabel} x={21} y={CHIPS.rowHeight / 2 + 4}>
                  {chip.label}
                </text>
                <text
                  className={styles.chipHours}
                  x={CHIPS.width - 12}
                  y={CHIPS.rowHeight / 2 + 4}
                  textAnchor="end"
                >
                  {fmtHours(chip.hours, { compact: true })}
                </text>
                <rect
                  width={CHIPS.width}
                  height={CHIPS.rowHeight}
                  rx={8}
                  className={styles.grab}
                  onPointerDown={(event) => onChipPointerDown(chip, event)}
                >
                  <title>{`${chip.label} — ${fmtHours(chip.hours)} on ${code} in this window. Drag to move it.`}</title>
                </rect>
              </g>
            )
          })
        )}
      </g>

      {/* --- relief candidates as ghost nodes ------------------------------ */}
      <g>
        <text className={styles.sectionLabel} x={FOCUS.x - 130} y={FOCUS.y + 128}>
          Relief candidates
        </text>
        {candidates.length === 0 ? (
          <g transform={`translate(${FOCUS.x - 130},${FOCUS.y + 142})`}>
            <rect width={300} height={46} rx={10} className={styles.emptyPlate} />
            <text className={styles.emptyBody} x={14} y={28}>
              {loading ? 'Searching the network…' : 'Nothing else in the network can take this load.'}
            </text>
          </g>
        ) : (
          candidates.map((candidate, index) => {
            const slot = at(ghosts, index, 'ghost slot')
            const presentation = BASIS_STATUS[candidate.basis]
            const classification = dropTargets?.get(candidate.toWorkCenterId)
            const active = activeTargetId === candidate.toWorkCenterId
            return (
              <g key={candidate.toWorkCenterId} transform={`translate(${slot.x},${slot.y})`} className={styles.ghost}>
                <circle r={slot.r} className={styles.ghostDisc} />
                <circle
                  r={slot.r + 4}
                  fill="none"
                  stroke={statusColor(classification?.status ?? presentation.status)}
                  strokeWidth={active ? 3 : 1.6}
                  opacity={active ? 1 : 0.72}
                  strokeDasharray={active ? undefined : '4 4'}
                />
                <text className={styles.ghostCode} y={-2} textAnchor="middle">
                  {codeOf(candidate.toWorkCenterId)}
                </text>
                <text className={styles.ghostValue} y={11} textAnchor="middle">
                  {pct(candidate.resultingUtilisation, 0)}
                </text>
                <g transform={`translate(${slot.r - 2},${-slot.r + 2})`}>
                  <DropIconMark
                    icon={classification?.icon ?? presentation.icon}
                    status={classification?.status ?? presentation.status}
                    size={15}
                  />
                </g>
                <text className={styles.ghostNote} y={slot.r + 15} textAnchor="middle">
                  {presentation.label}
                </text>
                <text className={styles.ghostNote} y={slot.r + 27} textAnchor="middle">
                  {candidate.basis === 'retrofit'
                    ? `${usd(candidate.capexUsd, { compact: true })} · ${candidate.leadTimeWeeks} wk`
                    : `${fmtHours(candidate.spareHours, { compact: true })} spare`}
                </text>
                <circle
                  r={slot.r + 8}
                  className={styles.grab}
                  onPointerEnter={() => onHover(candidate.toWorkCenterId)}
                  onPointerLeave={() => onHover(null)}
                  onClick={(event) => onCandidateActivate(candidate.toWorkCenterId, event)}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <title>
                    {`${codeOf(candidate.toWorkCenterId)} — ${presentation.label}. ` +
                      `${fmtHours(candidate.spareHours)} spare, would land at ${pct(candidate.resultingUtilisation, 0)}` +
                      `${candidate.sameePlant ? ', same plant' : ', another plant'}. Click to open it.`}
                  </title>
                </circle>
              </g>
            )
          })
        )}
      </g>

      {/* --- weekly load strip --------------------------------------------- */}
      <g transform={`translate(${PANEL.x},0)`}>
        <text className={styles.panelTitle} y={26}>
          Weekly load against the ceiling
        </text>
        <text className={styles.panelNote} y={44}>
          {`${weekLabel(fromWeek)} to ${weekLabel(toWeek)} · bars are required hours on the binding pool`}
        </text>

        <g transform={`translate(0,${STRIP.y})`}>
          <line
            x1={0}
            y1={STRIP.height}
            x2={PANEL.width}
            y2={STRIP.height}
            className={styles.baseline}
            vectorEffect="non-scaling-stroke"
          />
          {strip.bars.length === 0 ? (
            <g>
              <rect width={PANEL.width} height={STRIP.height} rx={10} className={styles.emptyPlate} />
              <text className={styles.emptyBody} x={20} y={STRIP.height / 2 + 5}>
                {loading ? 'Loading the weekly load…' : 'No weekly detail for this work center in the current window.'}
              </text>
            </g>
          ) : (
            <>
              {strip.bars.map((bar) => (
                <g key={bar.week}>
                  <rect
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={Math.max(0, bar.height)}
                    rx={Math.min(4, bar.width / 2)}
                    fill={divergingColor(utilisationSignal(bar.utilisation))}
                  />
                  {/* Square off the baseline end — only the data end is rounded. */}
                  <rect
                    x={bar.x}
                    y={Math.max(bar.y, STRIP.height - 4)}
                    width={bar.width}
                    height={Math.min(4, Math.max(0, bar.height))}
                    fill={divergingColor(utilisationSignal(bar.utilisation))}
                  />
                  <line
                    x1={bar.x - 1.5}
                    x2={bar.x + bar.width + 1.5}
                    y1={bar.ceilingY}
                    y2={bar.ceilingY}
                    className={styles.ceilingRule}
                    vectorEffect="non-scaling-stroke"
                  />
                  <rect
                    x={bar.x - strip.bandWidth / 2 + bar.width / 2}
                    y={0}
                    width={strip.bandWidth}
                    height={STRIP.height}
                    className={styles.grabQuiet}
                  >
                    <title>
                      {`${weekLabel(bar.week)} — ${fmtHours(bar.requiredHours)} required against ` +
                        `${fmtHours(bar.permittedHours)} permitted (${pct(bar.utilisation, 0)}).`}
                    </title>
                  </rect>
                </g>
              ))}
              <text className={styles.axisLabel} x={0} y={STRIP.height + 16}>
                {weekLabel(fromWeek)}
              </text>
              <text className={styles.axisLabel} x={PANEL.width} y={STRIP.height + 16} textAnchor="end">
                {weekLabel(toWeek)}
              </text>
              <text className={styles.axisLabel} x={0} y={-8}>
                {fmtHours(strip.maxHours, { compact: true })}
              </text>
            </>
          )}
        </g>

        {/* --- planned downtime ------------------------------------------- */}
        <g transform={`translate(0,${DOWNTIME.y})`}>
          <text className={styles.sectionLabel} y={-8}>
            Planned downtime
          </text>
          <rect width={PANEL.width} height={DOWNTIME.height} rx={6} className={styles.downtimeTrack} />
          {bands.length === 0 ? (
            <text className={styles.emptyBodySmall} x={10} y={DOWNTIME.height / 2 + 4}>
              No dated downtime in this window. Unplanned loss sits inside OEE and has no date.
            </text>
          ) : (
            bands.map((band) => {
              const span = Math.max(1, toWeek - fromWeek + 1)
              const x = ((band.fromWeek - fromWeek) / span) * PANEL.width
              const width = Math.max(4, ((band.toWeek - band.fromWeek + 1) / span) * PANEL.width)
              return (
                <g key={`${band.label}-${band.fromWeek}`}>
                  <rect x={x} y={0} width={width} height={DOWNTIME.height} rx={5} className={styles.downtimeBand} />
                  <text className={styles.downtimeLabel} x={x + 7} y={DOWNTIME.height / 2 + 4}>
                    {band.kind}
                  </text>
                  <title>{`${band.label} (${band.kind}) — ${weekLabel(band.fromWeek)} to ${weekLabel(band.toWeek)}, ${fmtHours(band.hours)} removed.`}</title>
                </g>
              )
            })
          )}
        </g>

        {/* --- OEE curve, its own panel, its own axis ---------------------- */}
        <g transform={`translate(0,${OEE.y})`}>
          <text className={styles.sectionLabel} y={-8}>
            Resolved OEE
          </text>
          <rect width={PANEL.width} height={OEE.height} rx={10} className={styles.panelPlate} />
          {oee.length < 2 ? (
            <text className={styles.emptyBodySmall} x={14} y={OEE.height / 2 + 4}>
              {loading ? 'Loading the OEE cascade…' : 'No resolved OEE for this window.'}
            </text>
          ) : (
            <OeeCurve values={oee} width={PANEL.width} height={OEE.height} />
          )}
        </g>
      </g>
    </g>
  )
})

/**
 * OEE over the window. One 2px line, its own y-axis banded to the values it
 * actually takes, so a 3-point improvement is visible rather than lost inside a
 * 0-to-1 axis nobody asked for.
 */
function OeeCurve({ values, width, height }: { values: readonly number[]; width: number; height: number }) {
  const padding = 16
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const lo = Math.max(0, Math.floor((min - 0.04) * 20) / 20)
  const hi = Math.min(1, Math.ceil((max + 0.04) * 20) / 20)
  const span = Math.max(0.01, hi - lo)
  const stepX = (width - padding * 2) / Math.max(1, values.length - 1)
  const scaleY = (value: number): number => height - padding - ((value - lo) / span) * (height - padding * 2)

  let d = ''
  values.forEach((value, index) => {
    const x = padding + index * stepX
    d += `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${scaleY(value).toFixed(2)}`
  })

  const first = at(values, 0, 'oee value')
  const last = at(values, values.length - 1, 'oee value')

  return (
    <g>
      <line
        x1={padding}
        x2={width - padding}
        y1={scaleY(hi)}
        y2={scaleY(hi)}
        className={styles.gridline}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={padding}
        x2={width - padding}
        y1={scaleY(lo)}
        y2={scaleY(lo)}
        className={styles.gridline}
        vectorEffect="non-scaling-stroke"
      />
      <text className={styles.axisLabel} x={padding} y={scaleY(hi) - 5}>
        {pct(hi, 0)}
      </text>
      <text className={styles.axisLabel} x={padding} y={scaleY(lo) + 13}>
        {pct(lo, 0)}
      </text>
      <path d={d} fill="none" className={styles.oeeLine} vectorEffect="non-scaling-stroke" />
      <circle cx={padding} cy={scaleY(first)} r={4} className={styles.oeeDot} />
      <circle cx={padding + (values.length - 1) * stepX} cy={scaleY(last)} r={4} className={styles.oeeDot} />
      <text
        className={styles.oeeValue}
        x={padding + (values.length - 1) * stepX - 8}
        y={scaleY(last) - 10}
        textAnchor="end"
      >
        {pct(last, 1)}
      </text>
    </g>
  )
}
