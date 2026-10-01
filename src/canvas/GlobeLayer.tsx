/**
 * The globe: five plants on an equirectangular world.
 *
 * Two channels, kept strictly apart, because conflating them is the single most
 * common way a map like this becomes unreadable:
 *
 *   - **Identity** is the ring. A plant owns its categorical slot for the life
 *     of the app, so the ring colour never changes — not when a filter drops it,
 *     not when it goes into overload.
 *   - **State** is the fill. Utilisation against the ceiling is polarity, so it
 *     takes the diverging ramp: cool for headroom, neutral grey at the ceiling,
 *     warm for overload. The bubble is sized by available hours, on area, so a
 *     plant twice the size draws twice the ink and not four times.
 *
 * A 2px surface ring separates the fill from the identity ring, which is the
 * same rule the chart kit uses for overlapping dots — never a border stroke,
 * which would read as a third colour.
 *
 * Position is not quite geography, and says so. Ingolstadt and Wroclaw are 500km
 * apart, which at world scale is less than one bubble: drawn honestly they are
 * one illegible blob with two labels fighting over the same pixels. The layout
 * pass in `layout.ts` pushes overlapping bubbles apart by the smallest amount
 * that separates them and hands back the true point as `anchor`; whenever a mark
 * moved, a hairline leader line runs from the bubble to a dot on the real site,
 * so the displacement is visible rather than silent. Labels are placed by the
 * same pass and never overlap each other or another plant's bubble.
 *
 * The map itself is background: sunken ocean, surface-coloured land, hairline
 * graticule. Nothing on it competes with the bubbles.
 */

import { memo } from 'react'
import type { Plant, PlantId } from '@/domain/types'
import type { SeriesSlot } from '@/charts/types'
import { hours as fmtHours, pct } from '@/lib/format'
import { divergingColor, seriesColor } from '@/charts/palette'
import type { ArcGeometry, LabelPlacement, PlantAggregate } from '@/canvas/layout'
import { utilisationSignal } from '@/canvas/layout'
import { LAND, WORLD, graticule, landPath } from '@/canvas/projection'
import type { Point } from '@/canvas/projection'
import styles from '@/canvas/GlobeLayer.module.css'

const GRATICULE = graticule(30, 30)
const LAND_PATHS = LAND.map((region) => ({ id: region.id, name: region.name, d: landPath(region) }))

export interface GlobePlantNode {
  plant: Plant
  slot: SeriesSlot
  /** Where the bubble is drawn — displaced from `anchor` when it had to be. */
  position: Point
  /** The plant's true projected position. The leader line's other end. */
  anchor: Point
  displaced: boolean
  radius: number
  label: LabelPlacement
  aggregate: PlantAggregate | undefined
}

export interface GlobeClusterMember {
  id: PlantId
  code: string
  slot: SeriesSlot
}

/**
 * Several plants too close to separate honestly at this zoom, folded into one
 * marker. It carries no series colour — a mark standing for four entities that
 * wore one of their four hues would be claiming to be one of them.
 */
export interface GlobeClusterNode {
  id: string
  position: Point
  anchor: Point
  displaced: boolean
  radius: number
  label: LabelPlacement
  members: readonly GlobeClusterMember[]
}

export interface GlobeLayerProps {
  plants: readonly GlobePlantNode[]
  clusters: readonly GlobeClusterNode[]
  arcs: readonly ArcGeometry[]
  /** Slot of the plant an arc originates from — arcs belong to their origin. */
  slotOfPlant: (id: PlantId) => SeriesSlot
  selectedPlantId?: PlantId | undefined
  /** Mark id carrying keyboard focus — a plant id, or a cluster id. */
  focusedId?: string | null
  hoveredId?: string | null
  onHover: (id: string | null) => void
  /**
   * A single click, or Enter on the focused mark. On a plant this selects it
   * *and* drills into it: the globe -> plant -> work center path is the product,
   * and asking for a second gesture to travel it made the map look broken.
   */
  onActivate: (id: string, event: { clientX: number; clientY: number }) => void
}

/** The label plate: a colour chip beside the text, never text in the colour. */
function LabelPlate({
  label,
  text,
  chip,
  strong,
}: {
  label: LabelPlacement
  text: string
  chip: string | null
  strong: boolean
}) {
  const left = -label.width / 2
  return (
    <g transform={`translate(${label.x},${label.y})`}>
      <rect
        x={left}
        y={-label.height / 2}
        width={label.width}
        height={label.height}
        rx={5}
        className={strong ? styles.labelPlateStrong : styles.labelPlate}
      />
      {chip === null ? null : <rect x={left + 6} y={-3.5} width={7} height={7} rx={1.5} fill={chip} />}
      <text className={styles.bubbleLabel} x={left + (chip === null ? 7 : 17)} y={3.5}>
        {text}
      </text>
    </g>
  )
}

/**
 * Hairline from the drawn bubble back to the site's real position.
 *
 * Two bubbles pushed apart each move by less than their own radius — that falls
 * straight out of splitting the shortfall between them — so the true point is
 * almost always *underneath* the mark that moved. A leader drawn behind the
 * bubbles would therefore be a leader nobody ever sees. It is drawn on top
 * instead, starting clear of the percentage in the middle, over a
 * surface-coloured halo so a hairline still reads against a saturated fill.
 */
function Leader({ from, to, radius }: { from: Point; to: Point; radius: number }) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return null
  const inset = Math.min(length * 0.55, radius * 0.56)
  const startX = from.x + (dx / length) * inset
  const startY = from.y + (dy / length) * inset
  return (
    <g className={styles.leaderGroup} aria-hidden="true">
      <line
        x1={startX}
        y1={startY}
        x2={to.x}
        y2={to.y}
        className={styles.leaderHalo}
        vectorEffect="non-scaling-stroke"
      />
      <line x1={startX} y1={startY} x2={to.x} y2={to.y} className={styles.leader} vectorEffect="non-scaling-stroke" />
      <circle cx={to.x} cy={to.y} r={radius * 0.12} className={styles.anchorRing} />
      <circle cx={to.x} cy={to.y} r={radius * 0.055} className={styles.anchorDot} />
    </g>
  )
}

export const GlobeLayer = memo(function GlobeLayer({
  plants,
  clusters,
  arcs,
  slotOfPlant,
  selectedPlantId,
  focusedId,
  hoveredId,
  onHover,
  onActivate,
}: GlobeLayerProps) {
  return (
    <g className={styles.layer}>
      <rect
        x={0}
        y={0}
        width={WORLD.width}
        height={WORLD.height}
        rx={10}
        className={styles.ocean}
      />

      <g aria-hidden="true">
        {GRATICULE.map((line) => (
          <line
            key={`${line.kind}-${line.degrees}`}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            className={line.major ? styles.graticuleMajor : styles.graticule}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>

      <g aria-hidden="true">
        {LAND_PATHS.map((region) => (
          <path key={region.id} d={region.d} className={styles.land} vectorEffect="non-scaling-stroke" />
        ))}
      </g>

      {arcs.length > 0 ? (
        <g className={styles.arcs}>
          {arcs.map((arc) => {
            const stroke = seriesColor(slotOfPlant(arc.fromPlantId))
            const angle = (Math.atan2(arc.to.y - arc.from.y, arc.to.x - arc.from.x) * 180) / Math.PI
            return (
              <g key={arc.id}>
                <title>{arc.label}</title>
                {/* Surface halo lifts the arc off the coastline beneath it. */}
                <path d={arc.path} className={styles.arcHalo} strokeWidth={arc.width + 3.5} fill="none" />
                <path
                  d={arc.path}
                  stroke={stroke}
                  strokeWidth={arc.width}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={arc.kind === 'load' ? undefined : '6 5'}
                  className={styles.arc}
                />
                <path
                  d="M-5,-4 L5,0 L-5,4 Z"
                  fill={stroke}
                  className={styles.arcHead}
                  transform={`translate(${arc.mid.x},${arc.mid.y}) rotate(${angle})`}
                />
              </g>
            )
          })}
        </g>
      ) : null}

      {/*
        * Four passes, not one group per plant: bubbles, then leaders, then
        * labels, then hit targets. Drawn plant by plant, the fifth bubble would
        * be free to print over the first one's label — which is the defect this
        * layer exists to fix, reintroduced by paint order.
        */}
      <g>
        {plants.map((node) => {
          const utilisation = node.aggregate?.utilisation ?? 0
          const active = node.plant.id === selectedPlantId
          const focused = node.plant.id === focusedId
          const hovered = node.plant.id === hoveredId
          const identity = seriesColor(node.slot)
          const r = node.radius
          return (
            <g
              key={node.plant.id}
              className={styles.bubble}
              data-state={active ? 'selected' : hovered ? 'hovered' : undefined}
              transform={`translate(${node.position.x},${node.position.y})`}
            >
              <circle r={r} fill={divergingColor(utilisationSignal(utilisation))} />
              <circle r={r + 2.5} className={styles.surfaceRing} fill="none" strokeWidth={2} />
              <circle r={r + 5} fill="none" stroke={identity} strokeWidth={3} />
              {active || focused ? (
                <circle
                  r={r + 11}
                  fill="none"
                  className={styles.focusRing}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <text className={styles.bubbleValue} y={4} textAnchor="middle">
                {pct(utilisation, 0)}
              </text>
            </g>
          )
        })}

        {clusters.map((cluster) => {
          const focused = cluster.id === focusedId
          const hovered = cluster.id === hoveredId
          return (
            <g
              key={cluster.id}
              className={styles.bubble}
              data-state={hovered ? 'hovered' : undefined}
              transform={`translate(${cluster.position.x},${cluster.position.y})`}
            >
              <circle r={cluster.radius} className={styles.clusterDisc} />
              <circle
                r={cluster.radius + 4}
                fill="none"
                className={styles.clusterRing}
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
              {focused ? (
                <circle
                  r={cluster.radius + 11}
                  fill="none"
                  className={styles.focusRing}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <text className={styles.bubbleValue} y={4} textAnchor="middle">
                {cluster.members.length}
              </text>
            </g>
          )
        })}
      </g>

      <g>
        {plants.map((node) =>
          node.displaced ? (
            <Leader key={`leader-${node.plant.id}`} from={node.position} to={node.anchor} radius={node.radius} />
          ) : null,
        )}
        {clusters.map((cluster) =>
          cluster.displaced ? (
            <Leader key={`leader-${cluster.id}`} from={cluster.position} to={cluster.anchor} radius={cluster.radius} />
          ) : null,
        )}
      </g>

      <g>
        {plants.map((node) => (
          <LabelPlate
            key={`label-${node.plant.id}`}
            label={node.label}
            text={node.plant.code}
            chip={seriesColor(node.slot)}
            strong={
              node.plant.id === selectedPlantId ||
              node.plant.id === hoveredId ||
              node.plant.id === focusedId
            }
          />
        ))}
        {clusters.map((cluster) => (
          <LabelPlate
            key={`label-${cluster.id}`}
            label={cluster.label}
            text={`${cluster.members.length} plants`}
            chip={null}
            strong={cluster.id === hoveredId || cluster.id === focusedId}
          />
        ))}
      </g>

      {/* One generous hit target per mark, rather than a ring you have to find. */}
      <g>
        {plants.map((node) => (
          <circle
            key={`hit-${node.plant.id}`}
            cx={node.position.x}
            cy={node.position.y}
            r={Math.max(node.radius + 14, 26)}
            className={styles.hit}
            onPointerEnter={() => onHover(node.plant.id)}
            onPointerLeave={() => onHover(null)}
            onClick={(event) => onActivate(node.plant.id, event)}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <title>
              {`${node.plant.name} (${node.plant.code}) — ${node.plant.city}, ${node.plant.country}. ` +
                `${pct(node.aggregate?.utilisation ?? 0, 0)} of ceiling, ` +
                `${fmtHours(node.aggregate?.availableHours ?? 0, { compact: true })} available, ` +
                `${node.aggregate?.workCenterCount ?? 0} work centers. ` +
                `${node.displaced ? 'Drawn clear of its neighbours; the leader line ends on the real site. ' : ''}` +
                'Click to open the plant.'}
            </title>
          </circle>
        ))}
        {clusters.map((cluster) => (
          <circle
            key={`hit-${cluster.id}`}
            cx={cluster.position.x}
            cy={cluster.position.y}
            r={Math.max(cluster.radius + 14, 26)}
            className={styles.hit}
            onPointerEnter={() => onHover(cluster.id)}
            onPointerLeave={() => onHover(null)}
            onClick={(event) => onActivate(cluster.id, event)}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <title>
              {`${cluster.members.length} plants too close to separate at this zoom: ` +
                `${cluster.members.map((member) => member.code).join(', ')}. ` +
                'Click to zoom in until they come apart.'}
            </title>
          </circle>
        ))}
      </g>
    </g>
  )
})
