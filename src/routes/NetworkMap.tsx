/**
 * The network map screen.
 *
 * The canvas owns pan, zoom, drag and the three levels it draws between. This
 * screen owns everything around it: where you are (a breadcrumb you can climb),
 * what the marks mean (a legend that names every encoding on the stage), what
 * you have selected (a drawer), what could legally move onto it, and which keys
 * do what.
 *
 * Two decisions worth stating out loud:
 *
 * - **The drawer opens on demand, not on selection.** It is a modal surface with
 *   a focus trap; opening it every time a planner clicks a node would put a wall
 *   in front of the map they are trying to read. The chrome says what is
 *   selected at all times, and the drawer is one click away.
 *
 * - **"What can move here" is a list, not a repaint.** The canvas does not take
 *   a highlight set from outside, so rather than fake one, the toggle opens the
 *   authoritative answer — the shared-capacity links for the selection, with the
 *   basis each one rests on and a button that actually applies the move.
 *
 * Nothing sized SKU x week reaches this file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { CapacityPool, Move, ReliefCandidate, WeekIndex } from '@/domain/types'
import type { WorkCenterDetail } from '@/worker/protocol'
import type { TableViewProps } from '@/charts/types'
import { clamp, safeDiv } from '@/domain/lookup'
import { hours as fmtHours, units as fmtUnits, pct, usd } from '@/lib/format'
import { ChartCard, DivergingLegend, GlideCurve, StackedBarChart } from '@/charts'
import {
  Badge,
  Button,
  Card,
  Chip,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  InfoTip,
  Modal,
  SectionHeading,
} from '@/components'
import type { BadgeTone, DataTableColumn } from '@/components'
import { NetworkCanvas } from '@/canvas'
import { useUiStore } from '@/state/store'
import { useRelief, useRollup, useWorkCenterDetail, usePlantSlot } from '@/state/model'
import styles from '@/routes/NetworkMap.module.css'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

type Basis = 'approved' | 'featureCapable' | 'retrofit'

const BASIS_TONE: Record<Basis, BadgeTone> = {
  approved: 'good',
  featureCapable: 'warning',
  retrofit: 'serious',
}

const BASIS_LABEL: Record<Basis, string> = {
  approved: 'Approved',
  featureCapable: 'Capable',
  retrofit: 'Retrofit',
}

const BASIS_HINT: Record<Basis, string> = {
  approved: 'master data permits it today',
  featureCapable: 'physically able, needs qualification',
  retrofit: 'needs a priced change first',
}

/** Same dash patterns the canvas draws its capability edges with. */
const BASIS_DASH: Record<Basis, string | undefined> = {
  approved: undefined,
  featureCapable: '7 5',
  retrofit: '2 5',
}

const BASIS_ORDER: Record<Basis, number> = { approved: 0, featureCapable: 1, retrofit: 2 }

const SHORTCUTS: Array<{ keys: string[]; what: string }> = [
  { keys: ['Tab'], what: 'Move between the nodes at this level' },
  { keys: ['Enter'], what: 'Drill into the focused node' },
  { keys: ['Backspace'], what: 'Go up one level' },
  { keys: ['M'], what: 'Start a move from the focused work center' },
  { keys: ['↑', '↓', '←', '→'], what: 'Pan the stage — or steer a move once one has started' },
  { keys: ['+', '−'], what: 'Zoom in and out' },
  { keys: ['Esc'], what: 'Cancel the move in progress' },
  { keys: ['Double-click'], what: 'Drill in on whatever is under the pointer' },
  { keys: ['?'], what: 'Open this list' },
]

/** The stage fills what the bands above and below it do not use. */
/**
 * Sizes the canvas stage to the space actually left below it.
 *
 * A fixed offset cannot work here: the chrome above the stage is the app
 * header, the filter row, the page title and the breadcrumb, and each of those
 * reflows at a different width. Subtracting a constant left the bottom of the
 * stage below the fold at 1050px, clipping the last row of work centers.
 * Measuring the stage's own top against the viewport is the only version that
 * stays correct when the filter row wraps.
 */
function useStageHeight(ref: RefObject<HTMLDivElement>): number {
  const [height, setHeight] = useState(560)
  useEffect(() => {
    const measure = (): void => {
      const top = ref.current?.getBoundingClientRect().top ?? 370
      // The trailing gap keeps the stage clear of the viewport edge, so the
      // canvas reads as ending rather than as cropped.
      setHeight(clamp(Math.round(window.innerHeight - top - 24), 380, 900))
    }
    measure()
    window.addEventListener('resize', measure)
    // The filter row can change height without the window resizing at all.
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [ref])
  return height
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function NetworkMap() {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const selection = useUiStore((state) => state.selection)
  const zoom = useUiStore((state) => state.zoom)
  const setZoom = useUiStore((state) => state.setZoom)
  const setSelection = useUiStore((state) => state.setSelection)
  const applyMove = useUiStore((state) => state.applyMove)
  const runtimeMs = useUiStore((state) => state.runtimeMs)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [movePanelOpen, setMovePanelOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const stageHeight = useStageHeight(stageRef)

  const plant = useMemo(
    () => (catalog?.plants ?? []).find((entry) => entry.id === selection.plantId),
    [catalog, selection.plantId],
  )
  const workCenter = useMemo(
    () => (catalog?.workCenters ?? []).find((entry) => entry.id === selection.workCenterId),
    [catalog, selection.workCenterId],
  )

  const weeks = useMemo(() => catalog?.time.weeks ?? [], [catalog])
  const lastWeek = Math.max(0, weeks.length - 1)
  const fromWeek = clamp(Math.min(filters.fromWeek, filters.toWeek), 0, lastWeek)
  const toWeek = clamp(Math.max(filters.fromWeek, filters.toWeek), 0, lastWeek)
  const weekLabel = useCallback((week: WeekIndex): string => weeks[week] ?? `W${week}`, [weeks])

  const detail = useWorkCenterDetail(selection.workCenterId)
  const relief = useRelief(selection.workCenterId)

  // `?` opens the key list from anywhere on the screen that is not a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '?') return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }
      event.preventDefault()
      setShortcutsOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const selectionLabel =
    workCenter !== undefined
      ? `${workCenter.code} · ${workCenter.name}`
      : plant !== undefined
        ? `${plant.code} · ${plant.city}`
        : 'the whole network'

  return (
    <div className={styles.page}>
      <div className={styles.band}>
        <FilterBar />
      </div>

      <div className={styles.bandTight}>
        <SectionHeading
          level={1}
          description="Globe to plant to work center on one continuous canvas. Drag load from a saturated asset onto one that can take it; the move applies immediately and can be taken back."
        >
          Network map
        </SectionHeading>
      </div>

      <div className={styles.bandTight}>
        <nav className={styles.chrome} aria-label="Zoom level">
          <div className={styles.crumbs}>
            <button
              type="button"
              className={`${styles.crumb} ${zoom === 'globe' ? styles.crumbOn : ''}`}
              aria-current={zoom === 'globe' ? 'page' : undefined}
              onClick={() => setZoom('globe')}
            >
              Global
            </button>
            <span className={styles.crumbSep} aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className={`${styles.crumb} ${zoom === 'plant' ? styles.crumbOn : ''}`}
              aria-current={zoom === 'plant' ? 'page' : undefined}
              disabled={plant === undefined}
              onClick={() => setZoom('plant')}
            >
              {plant === undefined ? 'No plant selected' : plant.city}
            </button>
            <span className={styles.crumbSep} aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className={`${styles.crumb} ${zoom === 'workCenter' ? styles.crumbOn : ''}`}
              aria-current={zoom === 'workCenter' ? 'page' : undefined}
              disabled={workCenter === undefined}
              onClick={() => setZoom('workCenter')}
            >
              {workCenter === undefined ? 'No work center selected' : workCenter.code}
            </button>
          </div>

          <div className={styles.chromeTail}>
            {runtimeMs > 0 ? (
              <span className={styles.runtime}>model run {Math.round(runtimeMs)} ms</span>
            ) : null}
            <Button
              size="sm"
              variant={movePanelOpen ? 'primary' : 'subtle'}
              icon="drag"
              pressed={movePanelOpen}
              onClick={() => setMovePanelOpen((prior) => !prior)}
            >
              What can move here
            </Button>
            <Button size="sm" variant="subtle" icon="table" onClick={() => setDrawerOpen(true)}>
              Selection details
            </Button>
            <Button size="sm" variant="ghost" icon="info" onClick={() => setShortcutsOpen(true)}>
              ? for shortcuts
            </Button>
          </div>
        </nav>
      </div>

      <div className={styles.stage} ref={stageRef}>
        <NetworkCanvas height={stageHeight} />
      </div>

      <div className={styles.band}>
        <Card title="What the marks mean" subtitle={`Selected: ${selectionLabel}`}>
          <div className={styles.legendRow}>
            <div className={styles.legendBlock}>
              <p className={styles.legendTitle}>
                Utilisation against the ceiling
                <InfoTip>
                  Load against a ceiling is polarity, not magnitude, so the scale is diverging and
                  centred on the ceiling itself. Every cell is measured against its own ceiling, so
                  the midpoint means the same thing everywhere on the map.
                </InfoTip>
              </p>
              <DivergingLegend
                labels={{ negative: 'Headroom', neutral: 'At the ceiling', positive: 'Overload' }}
                bounds={{ negative: '−50%', positive: '+50%' }}
              />
              <p className={styles.legendNote}>
                Node size is the hours the asset can offer; the fill is how much of its ceiling the
                plan uses.
              </p>
            </div>

            <div className={styles.legendBlock}>
              <p className={styles.legendTitle}>Capability links</p>
              <ul className={styles.edgeList}>
                {(['approved', 'featureCapable', 'retrofit'] as Basis[]).map((basis) => (
                  <li key={basis} className={styles.edgeItem}>
                    <svg
                      className={styles.edgeMark}
                      viewBox="0 0 30 8"
                      width={30}
                      height={8}
                      aria-hidden="true"
                    >
                      <line
                        x1={1}
                        y1={4}
                        x2={29}
                        y2={4}
                        className={styles.edgeStroke}
                        strokeDasharray={BASIS_DASH[basis]}
                      />
                    </svg>
                    <span className={styles.edgeLabel}>{BASIS_LABEL[basis]}</span>
                    <span className={styles.edgeHint}>{BASIS_HINT[basis]}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.legendNote}>
                Solid is master-data truth. The other two are proposals the feature model found,
                and they carry a price.
              </p>
            </div>

            <div className={styles.legendBlock}>
              <p className={styles.legendTitle}>Labour-bound badge</p>
              <p className={styles.badgeRow}>
                <svg viewBox="0 0 20 18" width={22} height={20} aria-hidden="true">
                  <rect x={2} y={2} width={16} height={14} rx={4} className={styles.badgePlate} />
                  <text x={10} y={12} textAnchor="middle" className={styles.badgeText}>
                    L
                  </text>
                </svg>
                <span>The labour pool saturates before the machine pool</span>
              </p>
              <p className={styles.legendNote}>
                A machine constraint wants capex or a move. A labour constraint wants operators —
                adding a shift to an asset nobody can staff changes nothing.
              </p>
              <p className={styles.legendNote}>
                Arc width on the globe is the share of source volume a scenario move redirects; the
                arc takes its origin plant&rsquo;s colour.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {movePanelOpen ? (
        <div className={styles.band}>
          <WhatCanMoveHere
            detail={detail.data}
            loading={detail.loading}
            error={detail.error}
            hasWorkCenter={workCenter !== undefined}
            targetLabel={workCenter?.code ?? ''}
            targetId={selection.workCenterId ?? ''}
            fromWeek={fromWeek}
            toWeek={toWeek}
            onSelect={(id) => setSelection({ workCenterId: id })}
            applyMove={applyMove}
          />
        </div>
      ) : null}

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={workCenter !== undefined ? workCenter.code : (plant?.city ?? 'Nothing selected')}
        description={
          workCenter !== undefined
            ? `${workCenter.name} · ${weekLabel(fromWeek)} – ${weekLabel(toWeek)}`
            : plant !== undefined
              ? `${plant.name} · work centers ranked by utilisation`
              : 'Select a plant or a work center on the map.'
        }
        width={520}
      >
        {workCenter !== undefined ? (
          <WorkCenterDrawer
            code={workCenter.code}
            detail={detail.data}
            loading={detail.loading}
            error={detail.error}
            relief={relief.data}
            reliefLoading={relief.loading}
            reliefError={relief.error}
            fromWeek={fromWeek}
            toWeek={toWeek}
            weekLabel={weekLabel}
            sourceId={workCenter.id}
            applyMove={applyMove}
            onSelect={(id) => setSelection({ workCenterId: id })}
          />
        ) : plant !== undefined ? (
          <PlantDrawer plantId={plant.id} onSelect={(id) => setSelection({ workCenterId: id })} />
        ) : (
          <EmptyState
            icon="globe"
            title="Nothing selected"
            description="Click a plant on the globe, or drill in and click a work center."
          />
        )}
      </Drawer>

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Canvas keys"
        description="Every gesture on the map has a key. The stage must have focus — click it once, or Tab to it."
        width={520}
      >
        <dl className={styles.keyTable}>
          {SHORTCUTS.map((entry) => (
            <div key={entry.what} style={{ display: 'contents' }}>
              <dt>
                {entry.keys.map((glyph) => (
                  <kbd key={glyph} className={styles.kbd}>
                    {glyph}
                  </kbd>
                ))}
              </dt>
              <dd>{entry.what}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  )
}

export default NetworkMap

// ---------------------------------------------------------------------------
// "What can move here"
// ---------------------------------------------------------------------------

interface WhatCanMoveHereProps {
  detail: WorkCenterDetail | null
  loading: boolean
  error: string | null
  hasWorkCenter: boolean
  targetId: string
  targetLabel: string
  fromWeek: WeekIndex
  toWeek: WeekIndex
  onSelect: (id: string) => void
  applyMove: (move: Move, label?: string) => void
}

function WhatCanMoveHere({
  detail,
  loading,
  error,
  hasWorkCenter,
  targetId,
  targetLabel,
  fromWeek,
  toWeek,
  onSelect,
  applyMove,
}: WhatCanMoveHereProps) {
  const catalog = useUiStore((state) => state.catalog)
  const plantSlot = usePlantSlot()

  const sources = useMemo(() => {
    const byId = new Map((catalog?.workCenters ?? []).map((wc) => [wc.id, wc]))
    const plantById = new Map((catalog?.plants ?? []).map((entry) => [entry.id, entry]))
    return (detail?.siblings ?? [])
      .map((sibling) => {
        const wc = byId.get(sibling.workCenterId)
        const plant = wc === undefined ? undefined : plantById.get(wc.plantId)
        return {
          id: sibling.workCenterId,
          code: wc?.code ?? sibling.workCenterId,
          plantCode: plant?.code ?? '—',
          slot: wc === undefined ? (1 as const) : plantSlot(wc.plantId),
          basis: sibling.basis,
          sharedOperations: sibling.sharedOperations,
          utilisation: sibling.utilisation,
        }
      })
      .sort(
        (a, b) =>
          BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis] ||
          b.utilisation - a.utilisation ||
          (a.code < b.code ? -1 : 1),
      )
  }, [catalog, detail, plantSlot])

  const approved = sources.filter((source) => source.basis === 'approved').length

  if (!hasWorkCenter) {
    return (
      <Card title="What can move here">
        <EmptyState
          icon="machine"
          title="Select a work center first"
          description="Legality is a property of an operation on a machine, so this answer needs a work center rather than a whole plant. Drill into a plant and click one."
        />
      </Card>
    )
  }

  if (error !== null) {
    return (
      <Card title="What can move here">
        <ErrorState message={error} detail="The shared-capacity links could not be computed." />
      </Card>
    )
  }

  return (
    <Card
      title={`What can move onto ${targetLabel}`}
      subtitle={`${approved} approved today · ${sources.length - approved} would need a decision`}
      stale={loading && detail !== null}
    >
      {sources.length === 0 ? (
        <EmptyState
          icon="machine"
          title="Nothing shares an operation with this asset"
          description="No other work center in the snapshot can run what this one runs — not approved, not feature-capable, not with a retrofit."
        />
      ) : (
        <ul className={styles.moveList}>
          {sources.map((source) => (
            <li key={source.id} className={styles.moveItem}>
              <Chip slot={source.slot}>{source.plantCode}</Chip>
              <span className={styles.moveCode}>{source.code}</span>
              <Badge size="sm" tone={BASIS_TONE[source.basis]}>
                {BASIS_LABEL[source.basis]}
              </Badge>
              <span className={styles.moveFact}>
                {source.sharedOperations} shared operations · running at {pct(source.utilisation, 0)}
              </span>
              <span className={styles.moveActions}>
                <Button size="sm" variant="ghost" icon="search" onClick={() => onSelect(source.id)}>
                  Show on map
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon="drag"
                  disabled={targetId === ''}
                  onClick={() =>
                    applyMove({
                      kind: 'resourceMove',
                      selector: { kind: 'all' },
                      fromWorkCenterId: source.id,
                      toWorkCenterId: targetId,
                      fromWeek,
                      toWeek,
                      share: 0.5,
                      allowDualSource: false,
                    })
                  }
                >
                  Move half here
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Drawer — a plant
// ---------------------------------------------------------------------------

interface PlantRow {
  id: string
  label: string
  utilisation: number
  peak: number
  requiredHours: number
  availableHours: number
  overloadHours: number
}

function PlantDrawer({ plantId, onSelect }: { plantId: string; onSelect: (id: string) => void }) {
  const rollup = useRollup('workCenter', plantId)

  const rows = useMemo((): PlantRow[] => {
    const byKey = new Map<string, PlantRow>()
    for (const cell of rollup.data?.cells ?? []) {
      const entry = byKey.get(cell.key)
      if (entry === undefined) {
        byKey.set(cell.key, {
          id: cell.key,
          label: cell.label,
          utilisation: 0,
          peak: cell.utilisation,
          requiredHours: cell.requiredHours,
          availableHours: cell.availableHours,
          overloadHours: cell.overloadHours,
        })
        continue
      }
      entry.requiredHours += cell.requiredHours
      entry.availableHours += cell.availableHours
      entry.overloadHours += cell.overloadHours
      entry.peak = Math.max(entry.peak, cell.utilisation)
    }
    const out = Array.from(byKey.values())
    for (const entry of out) {
      entry.utilisation = safeDiv(entry.requiredHours, entry.availableHours)
    }
    out.sort((a, b) => b.peak - a.peak || (a.label < b.label ? -1 : 1))
    return out
  }, [rollup.data])

  const columns = useMemo((): Array<DataTableColumn<PlantRow>> => {
    return [
      {
        key: 'label',
        header: 'Work center',
        sortValue: (row) => row.label,
        render: (row) => <span className={styles.moveCode}>{row.label}</span>,
      },
      {
        key: 'peak',
        header: 'Peak',
        align: 'right',
        width: 84,
        sortValue: (row) => row.peak,
        render: (row) => <span className={styles.numeric}>{pct(row.peak, 0)}</span>,
      },
      {
        key: 'utilisation',
        header: 'Mean',
        align: 'right',
        width: 84,
        sortValue: (row) => row.utilisation,
        render: (row) => <span className={styles.numeric}>{pct(row.utilisation, 0)}</span>,
      },
      {
        key: 'required',
        header: 'Required',
        align: 'right',
        width: 100,
        sortValue: (row) => row.requiredHours,
        render: (row) => (
          <span className={styles.numeric}>{fmtHours(row.requiredHours, { compact: true })}</span>
        ),
      },
      {
        key: 'overload',
        header: 'Over',
        align: 'right',
        width: 92,
        sortValue: (row) => row.overloadHours,
        render: (row) => (
          <span className={styles.numeric}>{fmtHours(row.overloadHours, { compact: true })}</span>
        ),
      },
    ]
  }, [])

  if (rollup.error !== null) {
    return <ErrorState message={rollup.error} detail="This plant's work centers could not be rolled up." />
  }

  return (
    <div className={styles.drawerStack}>
      <DataTable<PlantRow>
        caption="Work centers at this plant, ranked by their peak utilisation against their own ceiling."
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        initialSort={{ key: 'peak', dir: 'desc' }}
        maxHeight={520}
        stale={rollup.loading && rollup.data !== null}
        onRowClick={(row) => onSelect(row.id)}
        empty={
          <EmptyState
            icon="machine"
            title="No work center in this filter"
            description="Every filter is an intersection — clear a machine class or widen the weeks."
          />
        }
      />
      <p className={styles.legendNote}>
        Select a row to move the map onto that work center.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drawer — a work center
// ---------------------------------------------------------------------------

interface WorkCenterDrawerProps {
  code: string
  sourceId: string
  detail: WorkCenterDetail | null
  loading: boolean
  error: string | null
  relief: ReliefCandidate[] | null
  reliefLoading: boolean
  reliefError: string | null
  fromWeek: WeekIndex
  toWeek: WeekIndex
  weekLabel: (week: WeekIndex) => string
  applyMove: (move: Move, label?: string) => void
  onSelect: (id: string) => void
}

function WorkCenterDrawer({
  code,
  sourceId,
  detail,
  loading,
  error,
  relief,
  reliefLoading,
  reliefError,
  fromWeek,
  toWeek,
  weekLabel,
  applyMove,
  onSelect,
}: WorkCenterDrawerProps) {
  const strip = useMemo(() => {
    const cells = detail?.cells ?? []
    const categories = cells.map((cell) => weekLabel(cell.week))
    const required = cells.map((cell) =>
      cell.bindingPool === 'labour' ? cell.labourRequired : cell.machineRequired,
    )
    const limits = cells.map((cell) => {
      const available = cell.bindingPool === 'labour' ? cell.labourAvailable : cell.machineAvailable
      return available * cell.ceiling
    })
    const table: TableViewProps = {
      caption: `Required hours at ${code} on the binding pool each week, against the hours its ceiling permits.`,
      columns: [
        { key: 'week', label: 'Week' },
        { key: 'binding', label: 'Binding pool' },
        { key: 'required', label: 'Required', align: 'right' as const },
        { key: 'permitted', label: 'Permitted', align: 'right' as const },
        { key: 'utilisation', label: 'Utilisation', align: 'right' as const },
      ],
      rows: cells.map((cell, index) => ({
        week: weekLabel(cell.week),
        binding: cell.bindingPool === 'labour' ? 'Labour' : 'Machine',
        required: fmtHours(required[index] ?? 0),
        permitted: fmtHours(limits[index] ?? 0),
        utilisation: pct(cell.utilisation, 0),
      })),
    }
    return { categories, required, limits, table }
  }, [code, detail, weekLabel])

  const oee = useMemo(() => detail?.oeeByWeek ?? [], [detail])
  const oeeTable: TableViewProps = useMemo(
    () => ({
      caption: `Resolved OEE at ${code} by week, after every override and glide path in this scenario.`,
      columns: [
        { key: 'week', label: 'Week' },
        { key: 'oee', label: 'Resolved OEE', align: 'right' as const },
      ],
      rows: strip.categories.map((label, index) => ({
        week: label,
        oee: pct(oee[index] ?? 0, 1),
      })),
    }),
    [code, oee, strip.categories],
  )

  const bindingSummary = useMemo(() => {
    const cells = detail?.cells ?? []
    let labour = 0
    for (const cell of cells) if (cell.bindingPool === 'labour') labour += 1
    const pool: CapacityPool = labour * 2 > cells.length ? 'labour' : 'machine'
    return { pool, labour, weeks: cells.length }
  }, [detail])

  if (error !== null) {
    return <ErrorState message={error} detail="This work center's detail could not be computed." />
  }

  return (
    <div className={styles.drawerStack}>
      <div className={styles.drawerFacts}>
        <div>
          <p className={styles.factLabel}>Binding pool</p>
          <p className={styles.factValue}>
            {bindingSummary.pool === 'labour' ? 'Labour' : 'Machine'} in {bindingSummary.labour} of{' '}
            {bindingSummary.weeks} weeks
          </p>
        </div>
        <div>
          <p className={styles.factLabel}>Window</p>
          <p className={styles.factValue}>
            {weekLabel(fromWeek)} – {weekLabel(toWeek)}
          </p>
        </div>
      </div>

      <ChartCard
        title="Load strip"
        subtitle="Required hours on the binding pool; the rule is what the ceiling permits"
        table={strip.table}
        stale={loading && detail !== null}
      >
        {strip.categories.length === 0 ? (
          <EmptyState
            icon="machine"
            title="No load in this window"
            description="The supply plan places nothing here under the current filter."
          />
        ) : (
          <StackedBarChart
            categories={strip.categories}
            categoryLabel={(category) => category}
            series={[
              {
                id: 'required',
                label: 'Required hours',
                slot: 1,
                values: strip.required,
              },
            ]}
            limits={strip.limits}
            limitLabel="Permitted by the ceiling"
            height={200}
            yLabel="Hours"
            format={(value) => fmtHours(value, { compact: true })}
          />
        )}
      </ChartCard>

      <ChartCard
        title="OEE"
        subtitle="Resolved per week. The knobs that change it live on the Work centers screen."
        table={oeeTable}
        stale={loading && detail !== null}
      >
        {oee.length === 0 ? (
          <EmptyState icon="zap" title="No OEE resolved" description="Nothing to draw for this window yet." />
        ) : (
          <GlideCurve
            weeks={strip.categories}
            series={[{ id: sourceId, label: `${code} OEE`, slot: 1, values: oee }]}
            weekLabel={(week) => week}
            height={190}
          />
        )}
      </ChartCard>

      <section aria-label="Relief candidates">
        <p className={styles.legendTitle}>
          Relief candidates
          <InfoTip>
            Somewhere else that could take this load, ranked. Approved candidates need no
            permission; the others are proposals with a price and a lead time.
          </InfoTip>
        </p>
        {reliefError !== null ? (
          <ErrorState message={reliefError} detail="The relief search failed for this work center." />
        ) : (relief ?? []).length === 0 ? (
          <EmptyState
            icon="machine"
            title={reliefLoading ? 'Searching for relief' : 'Nowhere for this load to go'}
            description="No other asset can take these operations inside this window — not approved, not capable, not with a retrofit."
          />
        ) : (
          <ul className={styles.moveList}>
            {(relief ?? []).map((candidate) => (
              <ReliefRow
                key={`${candidate.toWorkCenterId}-${candidate.basis}`}
                candidate={candidate}
                sourceId={sourceId}
                fromWeek={fromWeek}
                toWeek={toWeek}
                applyMove={applyMove}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

interface ReliefRowProps {
  candidate: ReliefCandidate
  sourceId: string
  fromWeek: WeekIndex
  toWeek: WeekIndex
  applyMove: (move: Move, label?: string) => void
  onSelect: (id: string) => void
}

function ReliefRow({ candidate, sourceId, fromWeek, toWeek, applyMove, onSelect }: ReliefRowProps) {
  const catalog = useUiStore((state) => state.catalog)
  const plantSlot = usePlantSlot()

  const target = useMemo(
    () => (catalog?.workCenters ?? []).find((wc) => wc.id === candidate.toWorkCenterId),
    [catalog, candidate.toWorkCenterId],
  )
  const plantCode = useMemo(() => {
    const plantId = target?.plantId
    if (plantId === undefined) return '—'
    return (catalog?.plants ?? []).find((plant) => plant.id === plantId)?.code ?? plantId
  }, [catalog, target])

  const groupName = useCallback(
    (groupId: string): string =>
      (catalog?.groups ?? []).find((group) => group.id === groupId)?.name ?? groupId,
    [catalog],
  )

  const moveGroup = (groupId: string): void => {
    applyMove({
      kind: 'resourceMove',
      selector: { kind: 'group', id: groupId },
      fromWorkCenterId: sourceId,
      toWorkCenterId: candidate.toWorkCenterId,
      fromWeek,
      toWeek,
      share: 1,
      allowDualSource: false,
    })
  }

  return (
    <li className={styles.candidate}>
      <div className={styles.candidateHead}>
        <Chip slot={target === undefined ? 1 : plantSlot(target.plantId)}>{plantCode}</Chip>
        <span className={styles.candidateName}>{target?.code ?? candidate.toWorkCenterId}</span>
        <Badge size="sm" tone={BASIS_TONE[candidate.basis]}>
          {BASIS_LABEL[candidate.basis]}
        </Badge>
        {candidate.sameePlant ? (
          <Badge size="sm" tone="neutral">
            Same plant
          </Badge>
        ) : null}
      </div>
      <p className={styles.candidateNote}>
        {fmtHours(candidate.spareHours, { compact: true })} spare · would land at{' '}
        {pct(candidate.resultingUtilisation, 0)}
        {candidate.capexUsd > 0 ? ` · ${usd(candidate.capexUsd, { compact: true })} capex` : ''}
        {candidate.leadTimeWeeks > 0 ? ` · ${candidate.leadTimeWeeks} weeks lead time` : ''}
        {candidate.retrofit === undefined ? '' : ` · ${candidate.retrofit.name}`}
      </p>
      <div className={styles.groupRow}>
        {candidate.movableGroups.slice(0, 4).map((group) => (
          <Button
            key={group.groupId}
            size="sm"
            variant="subtle"
            icon="drag"
            onClick={() => moveGroup(group.groupId)}
          >
            {`Move ${groupName(group.groupId)} · ${fmtHours(group.hours, { compact: true })} · ${fmtUnits(group.materials)} SKUs`}
          </Button>
        ))}
        <span className={styles.moveActions}>
          {candidate.basis === 'retrofit' && candidate.retrofit !== undefined ? (
            <Button
              size="sm"
              variant="subtle"
              icon="zap"
              onClick={() =>
                applyMove({
                  kind: 'retrofit',
                  workCenterId: candidate.toWorkCenterId,
                  retrofitId: candidate.retrofit?.id ?? '',
                  availableFromWeek: Math.min(fromWeek + candidate.leadTimeWeeks, toWeek),
                })
              }
            >
              Fit the retrofit
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="search" onClick={() => onSelect(candidate.toWorkCenterId)}>
            Show on map
          </Button>
        </span>
      </div>
    </li>
  )
}
