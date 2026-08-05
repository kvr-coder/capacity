/**
 * The plant: work centers laid out as the process, not as a list.
 *
 * Columns are `StandardOperation.stage`, so moulding sits on the left and
 * packing on the right because the data says so — there is no hard-coded
 * ordering anywhere. Inside a column, work centers are grouped and boxed by
 * machine class, which is the first place a planner looks when asking "what else
 * could run this?".
 *
 * Encoding, deliberately split across independent channels:
 *
 *   - **utilisation** is the ring, on the diverging ramp centred on the ceiling,
 *     drawn as a dash-offset arc so a live drag can animate it to the projected
 *     value without recomputing a path;
 *   - **machine class** is the labelled group box plus a monogram in the node,
 *     NOT a hue. There are far more classes than the five validated categorical
 *     slots, those slots belong to plants for the life of the app, and inventing
 *     a ninth colour is exactly what the palette rules forbid. Class is a
 *     grouping, so it is drawn as a grouping;
 *   - **binding pool** is a badge with a letter, because "capex or hiring?" is a
 *     different question from "how full is it?" and must not share a channel;
 *   - **drop legality**, during a drag, is a status ring *and* an icon *and* a
 *     label on the active target.
 *
 * The four other plants ring the grid as satellites. A sibling in another plant
 * has no position in a plant view, so it is given one — which also gives every
 * capability edge a real destination and a natural bundle hub.
 */

import { memo } from 'react'
import type { PlantId, WorkCenterId } from '@/domain/types'
import type { SeriesSlot } from '@/charts/types'
import { pct } from '@/lib/format'
import { divergingColor, seriesColor, statusColor } from '@/charts/palette'
import type { DropClassification, PlacedNode, PlantLayout, Satellite, WorkCenterAggregate } from '@/canvas/layout'
import { utilisationSignal } from '@/canvas/layout'
import { DropIconMark } from '@/canvas/DragLayer'
import styles from '@/canvas/PlantLayer.module.css'

/** Utilisation at which the ring arc is full. Above it the fill keeps escalating. */
const RING_FULL = 1.25

export interface WorkCenterNodeView {
  node: PlacedNode
  aggregate: WorkCenterAggregate | undefined
  labourBound: boolean
  proposed: boolean
}

export interface PlantLayerProps {
  layout: PlantLayout
  nodes: readonly WorkCenterNodeView[]
  satellites: readonly Satellite[]
  slotOfPlant: (id: PlantId) => SeriesSlot
  plantCodeOf: (id: PlantId) => string
  codeOf: (id: WorkCenterId) => string
  selectedId?: WorkCenterId | undefined
  focusedId?: WorkCenterId | null
  hoveredId?: WorkCenterId | null
  /** Present only while a move is in flight. Every legal target lights up. */
  dropTargets?: ReadonlyMap<WorkCenterId, DropClassification> | null
  activeTargetId?: WorkCenterId | null
  dragSourceId?: WorkCenterId | null
  /** Projected utilisation during a drag, before the worker confirms. */
  previewUtilisation?: ReadonlyMap<WorkCenterId, number>
  onHover: (id: WorkCenterId | null) => void
  /**
   * A single click, or Enter on the focused node: selects the work center *and*
   * opens its layer. A press that turned into a drag is filtered out upstream,
   * so dropping load back where it started never counts as a drill.
   */
  onActivate: (id: WorkCenterId, event: { clientX: number; clientY: number }) => void
  onNodePointerDown: (id: WorkCenterId, event: React.PointerEvent<Element>) => void
  emptyMessage?: string
}

function ringGeometry(radius: number, utilisation: number): { r: number; circumference: number; offset: number } {
  const r = radius - 3
  const circumference = 2 * Math.PI * r
  const filled = Math.max(0, Math.min(utilisation, RING_FULL)) / RING_FULL
  return { r, circumference, offset: circumference * (1 - filled) }
}

export const PlantLayer = memo(function PlantLayer({
  layout,
  nodes,
  satellites,
  slotOfPlant,
  plantCodeOf,
  codeOf,
  selectedId,
  focusedId,
  hoveredId,
  dropTargets,
  activeTargetId,
  dragSourceId,
  previewUtilisation,
  onHover,
  onActivate,
  onNodePointerDown,
  emptyMessage = 'No work centers match the current filter.',
}: PlantLayerProps) {
  if (layout.nodes.length === 0) {
    return (
      <g className={styles.layer}>
        <rect x={0} y={0} width={520} height={180} rx={14} className={styles.emptyPlate} />
        <text className={styles.emptyTitle} x={28} y={72}>
          Nothing to draw here
        </text>
        <text className={styles.emptyBody} x={28} y={98}>
          {emptyMessage}
        </text>
      </g>
    )
  }

  const dragging = dropTargets != null

  return (
    <g className={styles.layer}>
      {/* --- stage columns ------------------------------------------------ */}
      <g aria-hidden="true">
        {layout.columns.map((column) => (
          <g key={column.stage}>
            <rect
              x={column.x - 10}
              y={-52}
              width={column.width + 20}
              height={column.height + 68}
              rx={14}
              className={styles.columnBand}
            />
            <text className={styles.columnStage} x={column.x} y={-32}>
              {String(column.stage).padStart(2, '0')}
            </text>
            <text className={styles.columnLabel} x={column.x} y={-14}>
              {column.label}
            </text>
            <text className={styles.columnCount} x={column.x + column.width} y={-14} textAnchor="end">
              {column.nodeCount}
            </text>
          </g>
        ))}
      </g>

      {/* --- machine-class groups ----------------------------------------- */}
      <g aria-hidden="true">
        {layout.columns.map((column) =>
          column.groups.map((group) => (
            <g key={`${column.stage}-${group.classId}`}>
              <rect
                x={group.x}
                y={group.y}
                width={group.width}
                height={group.height}
                rx={10}
                className={styles.groupBox}
              />
              <text className={styles.groupLabel} x={group.x + 11} y={group.y + 15}>
                {group.className}
              </text>
            </g>
          )),
        )}
      </g>

      {/* --- satellites: the other plants ---------------------------------- */}
      <g>
        {satellites.map((satellite) => {
          const identity = seriesColor(slotOfPlant(satellite.plantId))
          const code = plantCodeOf(satellite.plantId)
          return (
            <g key={satellite.plantId} className={styles.satellite}>
              <rect
                x={satellite.x - 30}
                y={satellite.y - 13}
                width={60}
                height={26}
                rx={13}
                className={styles.satellitePlate}
              />
              <rect x={satellite.x - 21} y={satellite.y - 4} width={8} height={8} rx={2} fill={identity} />
              <text className={styles.satelliteLabel} x={satellite.x - 8} y={satellite.y + 4}>
                {code}
              </text>
              {satellite.slots.map((slot) => {
                const classification = dropTargets?.get(slot.workCenterId)
                const isTarget = activeTargetId === slot.workCenterId
                return (
                  <g
                    key={slot.workCenterId}
                    className={styles.satelliteSlot}
                    data-legal={dragging ? (classification?.allowed === true ? 'yes' : 'no') : undefined}
                  >
                    <circle
                      cx={slot.x}
                      cy={slot.y}
                      r={slot.r}
                      className={styles.satelliteDot}
                      stroke={
                        classification !== undefined && classification.allowed
                          ? statusColor(classification.status)
                          : undefined
                      }
                      strokeWidth={classification !== undefined && classification.allowed ? 2 : 1}
                    />
                    <text className={styles.satelliteSlotLabel} x={slot.x} y={slot.y + 3} textAnchor="middle">
                      {slot.code.slice(-3)}
                    </text>
                    {isTarget && classification !== undefined ? (
                      <g transform={`translate(${slot.x + slot.r + 4},${slot.y - slot.r - 4})`}>
                        <DropIconMark icon={classification.icon} status={classification.status} size={16} />
                      </g>
                    ) : null}
                    <circle
                      cx={slot.x}
                      cy={slot.y}
                      r={slot.r + 8}
                      className={styles.hit}
                      onPointerEnter={() => onHover(slot.workCenterId)}
                      onPointerLeave={() => onHover(null)}
                      onClick={(event) => onActivate(slot.workCenterId, event)}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <title>{`${slot.code} — ${code}. Shares capability with this plant. Click to open it.`}</title>
                    </circle>
                  </g>
                )
              })}
              {satellite.overflow > 0 ? (
                <text className={styles.satelliteOverflow} x={satellite.x} y={satellite.y + 30} textAnchor="middle">
                  {`+${satellite.overflow} more`}
                </text>
              ) : null}
            </g>
          )
        })}
      </g>

      {/* --- work centers -------------------------------------------------- */}
      <g>
        {nodes.map((view) => {
          const { node, aggregate } = view
          const classification = dropTargets?.get(node.id)
          const isSource = dragSourceId === node.id
          const isTarget = activeTargetId === node.id
          const dimmed = dragging && !isSource && classification?.allowed !== true
          const utilisation = previewUtilisation?.get(node.id) ?? aggregate?.utilisation ?? 0
          const ring = ringGeometry(node.r, utilisation)
          const selected = selectedId === node.id
          const focused = focusedId === node.id
          const hovered = hoveredId === node.id

          return (
            <g
              key={node.id}
              transform={`translate(${node.x},${node.y})`}
              className={styles.node}
              data-dimmed={dimmed ? 'yes' : undefined}
              data-state={selected ? 'selected' : hovered ? 'hovered' : undefined}
            >
              <circle r={node.r} className={styles.disc} />
              {view.proposed ? (
                <circle
                  r={node.r + 4}
                  fill="none"
                  className={styles.proposedRing}
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}

              <circle r={ring.r} fill="none" className={styles.ringTrack} strokeWidth={5} />
              <circle
                r={ring.r}
                fill="none"
                className={styles.ringValue}
                stroke={divergingColor(utilisationSignal(utilisation))}
                strokeWidth={5}
                strokeLinecap="round"
                strokeDasharray={ring.circumference}
                strokeDashoffset={ring.offset}
                transform="rotate(-90)"
              />

              <text className={styles.classMonogram} y={-11} textAnchor="middle">
                {monogram(node.className)}
              </text>
              <text className={styles.nodeCode} y={1} textAnchor="middle">
                {node.code}
              </text>
              <text className={styles.nodeValue} y={12} textAnchor="middle">
                {pct(utilisation, 0)}
              </text>

              {view.labourBound ? (
                <g transform={`translate(${node.r - 6},${node.r - 6})`} className={styles.badge}>
                  <rect x={-8} y={-7} width={16} height={14} rx={4} className={styles.badgePlate} />
                  <text className={styles.badgeText} y={4} textAnchor="middle">
                    L
                  </text>
                  <title>Labour bound — the labour pool saturates before the machine pool.</title>
                </g>
              ) : null}

              {selected || focused ? (
                <circle
                  r={node.r + 8}
                  fill="none"
                  className={styles.focusRing}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}

              {isSource ? (
                <circle r={node.r + 8} fill="none" className={styles.sourceRing} vectorEffect="non-scaling-stroke" />
              ) : null}

              {classification !== undefined && classification.allowed && !isSource ? (
                <>
                  <circle
                    r={node.r + 7}
                    fill="none"
                    stroke={statusColor(classification.status)}
                    strokeWidth={isTarget ? 3 : 2}
                    opacity={isTarget ? 1 : 0.7}
                  />
                  <g transform={`translate(${node.r + 3},${-node.r - 3})`}>
                    <DropIconMark icon={classification.icon} status={classification.status} size={16} />
                  </g>
                </>
              ) : null}

              {isTarget && classification !== undefined ? (
                <g transform={`translate(0,${-node.r - 22})`} className={styles.targetChip}>
                  <rect
                    x={-classification.label.length * 3.4 - 10}
                    y={-11}
                    width={classification.label.length * 6.8 + 20}
                    height={20}
                    rx={10}
                    className={styles.targetChipPlate}
                  />
                  <text className={styles.targetChipText} y={3} textAnchor="middle">
                    {classification.label}
                  </text>
                </g>
              ) : null}

              <circle
                r={node.r + 6}
                className={styles.hit}
                onPointerEnter={() => onHover(node.id)}
                onPointerLeave={() => onHover(null)}
                onPointerDown={(event) => onNodePointerDown(node.id, event)}
                onClick={(event) => onActivate(node.id, event)}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <title>
                  {`${codeOf(node.id)} — ${node.className}. ${pct(aggregate?.utilisation ?? 0, 0)} of ceiling` +
                    `${view.labourBound ? ', labour bound' : ', machine bound'}` +
                    `${classification !== undefined ? `. ${classification.label}: ${classification.detail}` : ''}` +
                    '. Click to open it.'}
                </title>
              </circle>
            </g>
          )
        })}
      </g>
    </g>
  )
})

/** Two letters standing in for a machine class, so the node carries its family. */
function monogram(className: string): string {
  const words = className.trim().split(/[\s-]+/).filter(Boolean)
  if (words.length === 0) return '··'
  if (words.length === 1) return words[0]?.slice(0, 2).toUpperCase() ?? '··'
  return `${words[0]?.charAt(0) ?? ''}${words[1]?.charAt(0) ?? ''}`.toUpperCase()
}
