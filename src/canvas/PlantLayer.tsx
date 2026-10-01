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
 * The other plants are DOCKED down the right edge rather than orbited around the
 * grid. A partner in another plant has no position here; giving it one far away
 * spends the frame on context and drags every capability edge across the
 * content. One card per plant — its permanent colour slot, its code, its count —
 * opens on demand into the individual partners.
 */

import { memo } from 'react'
import type { PlantId, WorkCenterId } from '@/domain/types'
import type { SeriesSlot } from '@/charts/types'
import { pct } from '@/lib/format'
import { divergingColor, seriesColor, statusColor } from '@/charts/palette'
import type {
  DockCard,
  DropClassification,
  PartnerDock,
  PlacedNode,
  PlantLayout,
  WorkCenterAggregate,
} from '@/canvas/layout'
import { utilisationSignal } from '@/canvas/layout'
import { DRAG_HANDLE_ATTRIBUTE } from '@/canvas/gesture'
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
  dock: PartnerDock
  slotOfPlant: (id: PlantId) => SeriesSlot
  plantCodeOf: (id: PlantId) => string
  codeOf: (id: WorkCenterId) => string
  selectedId?: WorkCenterId | undefined
  focusedId?: string | null
  hoveredId?: string | null
  /** Present only while a move is in flight. Every legal target lights up. */
  dropTargets?: ReadonlyMap<WorkCenterId, DropClassification> | null
  activeTargetId?: WorkCenterId | null
  dragSourceId?: WorkCenterId | null
  /** Projected utilisation during a drag, before the worker confirms. */
  previewUtilisation?: ReadonlyMap<WorkCenterId, number>
  onHover: (id: string | null) => void
  /**
   * A single click, or Enter on the focused node: selects the work center *and*
   * opens its layer. A press that turned into a drag is filtered out upstream,
   * so dropping load back where it started never counts as a drill.
   */
  onActivate: (id: WorkCenterId, event: { clientX: number; clientY: number }) => void
  onNodePointerDown: (id: WorkCenterId, event: React.PointerEvent<Element>) => void
  /** Opening a dock card is a disclosure, not a navigation. */
  onDockToggle: (plantId: PlantId) => void
  emptyMessage?: string
}

function ringGeometry(radius: number, utilisation: number): { r: number; circumference: number; offset: number } {
  const r = radius - 4
  const circumference = 2 * Math.PI * r
  const filled = Math.max(0, Math.min(utilisation, RING_FULL)) / RING_FULL
  return { r, circumference, offset: circumference * (1 - filled) }
}

export const PlantLayer = memo(function PlantLayer({
  layout,
  nodes,
  dock,
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
  onDockToggle,
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
              x={column.x}
              y={0}
              width={column.width}
              height={column.height}
              rx={10}
              className={styles.columnBand}
            />
            <text className={styles.columnIndex} x={column.x + 12} y={19}>
              {String(column.stage).padStart(2, '0')}
            </text>
            <text className={styles.columnLabel} x={column.x + 12} y={38}>
              {column.label}
            </text>
            <text className={styles.columnCount} x={column.x + column.width - 12} y={38} textAnchor="end">
              {column.nodeCount}
            </text>
            <text className={styles.columnCountNote} x={column.x + column.width - 12} y={19} textAnchor="end">
              {column.nodeCount === 1 ? 'work center' : 'work centers'}
            </text>
            <line
              x1={column.x + 12}
              x2={column.x + column.width - 12}
              y1={column.contentY - 8}
              y2={column.contentY - 8}
              className={styles.columnRule}
              vectorEffect="non-scaling-stroke"
            />
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
                rx={9}
                className={styles.groupBox}
              />
              <text className={styles.groupLabel} x={group.x + 11} y={group.y + 14}>
                {group.className}
              </text>
            </g>
          )),
        )}
      </g>

      {/* --- work centers -------------------------------------------------- */}
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
                  r={node.r + 5}
                  fill="none"
                  className={styles.proposedRing}
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}

              <circle r={ring.r} fill="none" className={styles.ringTrack} strokeWidth={6} />
              <circle
                r={ring.r}
                fill="none"
                className={styles.ringValue}
                stroke={divergingColor(utilisationSignal(utilisation))}
                strokeWidth={6}
                strokeLinecap="round"
                strokeDasharray={ring.circumference}
                strokeDashoffset={ring.offset}
                transform="rotate(-90)"
              />

              {/*
                One text element, two lines. The plant prefix is the same seven
                characters on every node in the view, so it is set quiet and the
                part that actually distinguishes one machine from another is set
                loud — but the code stays WHOLE, because a planner types it into
                SAP and reads it out in a meeting, and a code that is only
                complete inside a tooltip is a code they cannot use.

                Machine class is not repeated here: the labelled group box
                immediately above every node already names it in full, which is
                strictly more than a two-letter monogram was saying.
              */}
              <text className={styles.nodeCode} textAnchor="middle">
                <tspan className={styles.nodePrefix} x={0} y={-8}>
                  {prefixOf(codeOf(node.id), node.label)}
                </tspan>
                <tspan className={styles.nodeName} x={0} dy={15}>
                  {node.label}
                </tspan>
              </text>
              <text className={styles.nodeValue} y={22} textAnchor="middle">
                {pct(utilisation, 0)}
              </text>

              {view.labourBound ? (
                <g transform={`translate(${node.r - 9},${node.r - 9})`} className={styles.badge}>
                  <rect x={-9} y={-8} width={18} height={16} rx={5} className={styles.badgePlate} />
                  <text className={styles.badgeText} y={5} textAnchor="middle">
                    L
                  </text>
                  <title>Labour bound — the labour pool saturates before the machine pool.</title>
                </g>
              ) : null}

              {selected || focused ? (
                <circle
                  r={node.r + 9}
                  fill="none"
                  className={styles.focusRing}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}

              {isSource ? (
                <circle r={node.r + 9} fill="none" className={styles.sourceRing} vectorEffect="non-scaling-stroke" />
              ) : null}

              {classification !== undefined && classification.allowed && !isSource ? (
                <>
                  <circle
                    r={node.r + 8}
                    fill="none"
                    stroke={statusColor(classification.status)}
                    strokeWidth={isTarget ? 3 : 2}
                    opacity={isTarget ? 1 : 0.7}
                  />
                  <g transform={`translate(${node.r + 4},${-node.r - 4})`}>
                    <DropIconMark icon={classification.icon} status={classification.status} size={18} />
                  </g>
                </>
              ) : null}

              {isTarget && classification !== undefined ? (
                <g transform={`translate(0,${-node.r - 26})`} className={styles.targetChip}>
                  <rect
                    x={-classification.label.length * 3.7 - 11}
                    y={-12}
                    width={classification.label.length * 7.4 + 22}
                    height={22}
                    rx={11}
                    className={styles.targetChipPlate}
                  />
                  <text className={styles.targetChipText} y={4} textAnchor="middle">
                    {classification.label}
                  </text>
                </g>
              ) : null}

              {/*
                The drag handle. `data-canvas-drag` is what tells the pan, at
                pointerdown, that this press is not its gesture — the pan reads
                the DOM rather than trusting that every mark on the way past
                remembered to stop propagation.
              */}
              <circle
                r={node.r + 6}
                className={styles.hit}
                {...{ [DRAG_HANDLE_ATTRIBUTE]: 'workCenter' }}
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
                    '. Drag it onto another work center to move its load; click to open it.'}
                </title>
              </circle>
            </g>
          )
        })}

      {/* --- the partner dock ---------------------------------------------- */}
      {dock.cards.length > 0 ? (
        <g className={styles.dock}>
          <text className={styles.dockTitle} x={dock.gutter.x} y={19}>
            Shares capability
          </text>
          <text className={styles.dockNote} x={dock.gutter.x} y={38}>
            {dock.cards.length === 1 ? '1 other plant' : `${dock.cards.length} other plants`}
          </text>
          {dock.cards.map((card) => (
            <DockCardMark
              key={card.id}
              card={card}
              identity={seriesColor(slotOfPlant(card.plantId))}
              plantCode={plantCodeOf(card.plantId)}
              focusedId={focusedId}
              hoveredId={hoveredId}
              dragging={dragging}
              dropTargets={dropTargets}
              activeTargetId={activeTargetId}
              onHover={onHover}
              onToggle={onDockToggle}
              onActivate={onActivate}
            />
          ))}
        </g>
      ) : null}
    </g>
  )
})

// ---------------------------------------------------------------------------
// Dock card
// ---------------------------------------------------------------------------

interface DockCardMarkProps {
  card: DockCard
  /** The plant's permanent categorical slot. Never assigned by array position. */
  identity: string
  plantCode: string
  focusedId?: string | null
  hoveredId?: string | null
  dragging: boolean
  dropTargets?: ReadonlyMap<WorkCenterId, DropClassification> | null
  activeTargetId?: WorkCenterId | null
  onHover: (id: string | null) => void
  onToggle: (plantId: PlantId) => void
  onActivate: (id: WorkCenterId, event: { clientX: number; clientY: number }) => void
}

function DockCardMark({
  card,
  identity,
  plantCode,
  focusedId,
  hoveredId,
  dragging,
  dropTargets,
  activeTargetId,
  onHover,
  onToggle,
  onActivate,
}: DockCardMarkProps) {
  const focused = focusedId === card.id
  const hovered = hoveredId === card.id
  const label = `${plantCode}, ${card.count} work ${card.count === 1 ? 'center' : 'centers'} sharing capability. ${
    card.expanded ? 'Open — Enter closes it.' : 'Enter opens the list.'
  }`

  return (
    <g className={styles.dockCard} data-state={focused ? 'focused' : hovered ? 'hovered' : undefined}>
      <rect
        x={card.x}
        y={card.y}
        width={card.width}
        height={card.height}
        rx={10}
        className={styles.dockPlate}
      />
      {/* The colour sits BESIDE the text, never on it. */}
      <rect x={card.x + 12} y={card.y + 17} width={10} height={10} rx={2.5} fill={identity} />
      <text className={styles.dockCode} x={card.x + 29} y={card.y + 26}>
        {plantCode}
      </text>
      <text className={styles.dockCount} x={card.x + card.width - 26} y={card.y + 27} textAnchor="end">
        {card.count}
      </text>
      <text className={styles.dockChevron} x={card.x + card.width - 12} y={card.y + 27} textAnchor="end">
        {card.expanded ? '▾' : '▸'}
      </text>
      <text className={styles.dockCardNote} x={card.x + 29} y={card.y + 40}>
        {card.expanded ? 'linked work centers' : 'linked'}
      </text>

      {focused ? (
        <rect
          x={card.x - 4}
          y={card.y - 4}
          width={card.width + 8}
          height={card.headerHeight + 8}
          rx={12}
          fill="none"
          className={styles.dockFocusRing}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}

      <rect
        x={card.x}
        y={card.y}
        width={card.width}
        height={card.headerHeight}
        rx={10}
        className={styles.hit}
        onPointerEnter={() => onHover(card.id)}
        onPointerLeave={() => onHover(null)}
        onClick={() => onToggle(card.plantId)}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <title>{label}</title>
      </rect>

      {card.slots.map((slot) => {
        const classification = dropTargets?.get(slot.workCenterId)
        const isTarget = activeTargetId === slot.workCenterId
        const slotFocused = focusedId === slot.workCenterId
        return (
          <g
            key={slot.workCenterId}
            className={styles.dockSlot}
            data-legal={dragging ? (classification?.allowed === true ? 'yes' : 'no') : undefined}
          >
            {slotFocused || isTarget ? (
              <rect
                x={slot.rowX}
                y={slot.rowY + 1}
                width={slot.rowWidth}
                height={slot.rowHeight - 2}
                rx={7}
                className={styles.dockSlotActive}
              />
            ) : null}
            <circle
              cx={slot.x}
              cy={slot.y}
              r={slot.r}
              className={styles.dockDot}
              stroke={
                classification !== undefined && classification.allowed ? statusColor(classification.status) : undefined
              }
              strokeWidth={classification !== undefined && classification.allowed ? 2 : 1}
            />
            <text className={styles.dockSlotLabel} x={slot.x + 12} y={slot.y + 4}>
              {slot.code}
            </text>
            {isTarget && classification !== undefined ? (
              <g transform={`translate(${slot.rowX + slot.rowWidth - 12},${slot.y})`}>
                <DropIconMark icon={classification.icon} status={classification.status} size={16} />
              </g>
            ) : null}
            <rect
              x={slot.rowX}
              y={slot.rowY}
              width={slot.rowWidth}
              height={slot.rowHeight}
              rx={7}
              className={styles.hit}
              onPointerEnter={() => onHover(slot.workCenterId)}
              onPointerLeave={() => onHover(null)}
              onClick={(event) => onActivate(slot.workCenterId, event)}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <title>{`${slot.code} — ${plantCode}. Shares capability with this plant. Click to open it.`}</title>
            </rect>
          </g>
        )
      })}

      {card.overflow > 0 ? (
        <text
          className={styles.dockOverflow}
          x={card.x + 17}
          y={card.y + card.headerHeight + card.slots.length * 26 + 15}
        >
          {`+${card.overflow} more not shown`}
        </text>
      ) : null}
    </g>
  )
}

/** The part of the code the short label dropped — normally `US-TOL-`. */
function prefixOf(code: string, label: string): string {
  return code.endsWith(label) ? code.slice(0, code.length - label.length) : ''
}
