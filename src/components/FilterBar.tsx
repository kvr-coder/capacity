/**
 * The filter row.
 *
 * **One row, above the content it scopes, never inside a card.** A filter that
 * lives inside one of the six cards it changes teaches the reader that it only
 * changes that card, and then every number on the screen is a small lie.
 *
 * Order is deliberate: time first, because "which weeks" is the question a
 * capacity planner asks before any other; then the bucket the time axis rolls
 * up to; then the hierarchy, wide to narrow — plant, region, family, group,
 * machine class.
 *
 * An empty multi-select means **all**, never none, and every one of them says
 * so on its face ("All plants") rather than leaving the reader to infer it from
 * an empty popup.
 */

import { useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import type { Filters, Region } from '@/domain/types'
import { clamp } from '@/domain/lookup'
import { monthShort } from '@/lib/format'
import { useChartSize } from '@/charts/primitives'
import { Button, MultiSelect, SegmentedControl, Select } from '@/components/ui'
import type { MultiSelectOption } from '@/components/ui'
import { useUiStore } from '@/state/store'
import styles from '@/components/FilterBar.module.css'

// ---------------------------------------------------------------------------
// Week-range presets
// ---------------------------------------------------------------------------

type PresetId = 'full' | 'next13' | 'next26' | 'h1' | 'h2' | 'custom'

interface Preset {
  id: PresetId
  label: string
  range: (weeks: number) => [number, number]
}

const PRESETS: Preset[] = [
  { id: 'full', label: 'Full horizon', range: (weeks) => [0, Math.max(0, weeks - 1)] },
  { id: 'next13', label: 'Next 13 weeks', range: (weeks) => [0, Math.min(12, weeks - 1)] },
  { id: 'next26', label: 'Next 26 weeks', range: (weeks) => [0, Math.min(25, weeks - 1)] },
  { id: 'h1', label: 'First half', range: (weeks) => [0, Math.max(0, Math.ceil(weeks / 2) - 1)] },
  { id: 'h2', label: 'Second half', range: (weeks) => [Math.ceil(weeks / 2), Math.max(0, weeks - 1)] },
]

function presetFor(filters: Filters, weeks: number): PresetId {
  for (const preset of PRESETS) {
    const [from, to] = preset.range(weeks)
    if (from === filters.fromWeek && to === filters.toWeek) return preset.id
  }
  return 'custom'
}

// ---------------------------------------------------------------------------
// The brushable mini-timeline
// ---------------------------------------------------------------------------

const BRUSH_HEIGHT = 34
const HANDLE_HIT = 24

interface BrushProps {
  weeks: string[]
  monthOfWeek: string[]
  fromWeek: number
  toWeek: number
  onChange: (fromWeek: number, toWeek: number) => void
}

/**
 * A strip of the whole horizon with the selected window lit.
 *
 * The point of the brush is context: dragging a range on a control that also
 * shows where that range sits in the eighteen months is a different act from
 * typing two week numbers into two boxes. Both handles are real sliders — arrow
 * keys step a week, PageUp/PageDown step a quarter — because a range control
 * that only responds to a mouse excludes people for no reason.
 */
function WeekBrush({ weeks, monthOfWeek, fromWeek, toWeek, onChange }: BrushProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const width = useChartSize(hostRef, 420)
  const [dragging, setDragging] = useState<'from' | 'to' | null>(null)

  const count = weeks.length
  const padX = 8
  const innerW = Math.max(40, width - padX * 2)
  const trackY = 20
  const x = (index: number): number =>
    padX + (count <= 1 ? 0 : (index / (count - 1)) * innerW)
  const weekAt = (px: number): number =>
    count <= 1 ? 0 : clamp(Math.round(((px - padX) / innerW) * (count - 1)), 0, count - 1)

  // One tick per month boundary — enough to orient without becoming a ruler.
  const monthTicks = useMemo(() => {
    const ticks: Array<{ index: number; label: string }> = []
    let previous = ''
    for (let i = 0; i < monthOfWeek.length; i += 1) {
      const month = monthOfWeek[i] ?? ''
      if (month !== previous) {
        ticks.push({ index: i, label: monthShort(month) })
        previous = month
      }
    }
    return ticks
  }, [monthOfWeek])

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (dragging === null) return
    const box = event.currentTarget.getBoundingClientRect()
    const week = weekAt(event.clientX - box.left)
    if (dragging === 'from') onChange(Math.min(week, toWeek), toWeek)
    else onChange(fromWeek, Math.max(week, fromWeek))
  }

  const startDrag = (which: 'from' | 'to') => (event: ReactPointerEvent<SVGGElement>) => {
    event.preventDefault()
    setDragging(which)
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
  }

  const stepKey = (which: 'from' | 'to') => (event: ReactKeyboardEvent<SVGGElement>) => {
    const step =
      event.key === 'PageUp' || event.key === 'PageDown'
        ? 13
        : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          ? 1
          : 0
    let delta = 0
    if (event.key === 'ArrowLeft' || event.key === 'PageDown') delta = -step
    if (event.key === 'ArrowRight' || event.key === 'PageUp') delta = step
    if (event.key === 'Home') delta = -count
    if (event.key === 'End') delta = count
    if (delta === 0) return
    event.preventDefault()
    if (which === 'from') {
      onChange(clamp(fromWeek + delta, 0, toWeek), toWeek)
    } else {
      onChange(fromWeek, clamp(toWeek + delta, fromWeek, count - 1))
    }
  }

  const handle = (which: 'from' | 'to') => {
    const index = which === 'from' ? fromWeek : toWeek
    const cx = x(index)
    return (
      <g
        role="slider"
        tabIndex={0}
        aria-label={which === 'from' ? 'First week in range' : 'Last week in range'}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={weeks[index] ?? `week ${index}`}
        className={styles.handle}
        onPointerDown={startDrag(which)}
        onKeyDown={stepKey(which)}
      >
        <rect
          x={cx - HANDLE_HIT / 2}
          y={0}
          width={HANDLE_HIT}
          height={BRUSH_HEIGHT}
          fill="transparent"
        />
        <rect x={cx - 2} y={trackY - 9} width={4} height={18} rx={2} className={styles.handleGrip} />
      </g>
    )
  }

  return (
    <div className={styles.brushHost} ref={hostRef}>
      <svg
        width="100%"
        height={BRUSH_HEIGHT}
        viewBox={`0 0 ${Math.max(width, 80)} ${BRUSH_HEIGHT}`}
        className={styles.brush}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        <g aria-hidden="true">
          {monthTicks.map((tick, i) =>
            i % 3 === 0 ? (
              <text key={tick.index} x={x(tick.index)} y={9} className={styles.brushTick}>
                {tick.label}
              </text>
            ) : null,
          )}
          <line
            x1={padX}
            x2={padX + innerW}
            y1={trackY}
            y2={trackY}
            className={styles.brushTrack}
            shapeRendering="crispEdges"
          />
          <rect
            x={x(fromWeek)}
            y={trackY - 5}
            width={Math.max(2, x(toWeek) - x(fromWeek))}
            height={10}
            rx={2}
            className={styles.brushBand}
          />
        </g>
        {handle('from')}
        {handle('to')}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

export type FilterControl = 'range' | 'bucket' | 'plant' | 'region' | 'family' | 'group' | 'machineClass'

const ALL_CONTROLS: FilterControl[] = [
  'range',
  'bucket',
  'plant',
  'region',
  'family',
  'group',
  'machineClass',
]

export interface FilterBarProps {
  /** Which controls this screen scopes by. Defaults to all seven. */
  show?: FilterControl[]
  /** Rendered at the far right, before the reset — a screen-specific action. */
  aside?: ReactNode
  className?: string
}

export function FilterBar({ show = ALL_CONTROLS, aside, className }: FilterBarProps) {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const setFilters = useUiStore((state) => state.setFilters)
  const resetFilters = useUiStore((state) => state.resetFilters)

  const weeks = catalog?.time.weeks ?? []
  const weekCount = weeks.length
  const visible = useMemo(() => new Set(show), [show])

  const plantOptions = useMemo<MultiSelectOption[]>(
    () =>
      (catalog?.plants ?? []).map((plant) => ({
        value: plant.id,
        label: `${plant.code} · ${plant.city}`,
        slot: plant.colorSlot,
        hint: plant.region,
      })),
    [catalog],
  )

  const regionOptions = useMemo<MultiSelectOption[]>(() => {
    const seen: Region[] = []
    for (const plant of catalog?.plants ?? []) {
      if (!seen.includes(plant.region)) seen.push(plant.region)
    }
    return seen.map((region) => ({ value: region, label: region }))
  }, [catalog])

  const familyOptions = useMemo<MultiSelectOption[]>(
    () =>
      (catalog?.families ?? []).map((family) => ({
        value: family.id,
        label: `${family.code} — ${family.name}`,
      })),
    [catalog],
  )

  const groupOptions = useMemo<MultiSelectOption[]>(
    () =>
      (catalog?.groups ?? []).map((group) => ({
        value: group.id,
        label: `${group.code} — ${group.name}`,
        hint:
          catalog === null
            ? undefined
            : `${catalog.materialCountByGroup[group.id] ?? 0} SKUs`,
      })),
    [catalog],
  )

  const classOptions = useMemo<MultiSelectOption[]>(
    () =>
      (catalog?.machineClasses ?? []).map((cls) => ({
        value: cls.id,
        label: cls.name,
        hint: `gen ${cls.generation}`,
      })),
    [catalog],
  )

  const preset = presetFor(filters, weekCount)
  const rangeIsFull = filters.fromWeek === 0 && filters.toWeek === Math.max(0, weekCount - 1)

  const activeCount =
    (filters.plantIds.length > 0 ? 1 : 0) +
    (filters.regions.length > 0 ? 1 : 0) +
    (filters.familyIds.length > 0 ? 1 : 0) +
    (filters.groupIds.length > 0 ? 1 : 0) +
    (filters.machineClassIds.length > 0 ? 1 : 0) +
    (filters.workCenterIds.length > 0 ? 1 : 0) +
    (rangeIsFull ? 0 : 1)

  const fromLabel = weeks[filters.fromWeek] ?? '—'
  const toLabel = weeks[filters.toWeek] ?? '—'
  const spanWeeks = Math.max(0, filters.toWeek - filters.fromWeek + 1)

  return (
    <div
      className={[styles.bar, className ?? ''].filter(Boolean).join(' ')}
      role="search"
      aria-label="Scope the model"
      data-print="hide"
    >
      {visible.has('range') ? (
        <div className={styles.rangeGroup}>
          <Select
            label="Weeks"
            hideLabel
            size="sm"
            value={preset}
            className={styles.presetSelect}
            options={[
              ...PRESETS.map((entry) => ({ value: entry.id, label: entry.label })),
              ...(preset === 'custom'
                ? [{ value: 'custom', label: `Custom · ${spanWeeks} weeks` }]
                : []),
            ]}
            onChange={(value) => {
              const found = PRESETS.find((entry) => entry.id === value)
              if (found === undefined) return
              const [from, to] = found.range(weekCount)
              setFilters({ fromWeek: from, toWeek: to })
            }}
          />
          <WeekBrush
            weeks={weeks}
            monthOfWeek={catalog?.time.monthOfWeek ?? []}
            fromWeek={filters.fromWeek}
            toWeek={filters.toWeek}
            onChange={(from, to) => setFilters({ fromWeek: from, toWeek: to })}
          />
          <span className={styles.rangeReadout} aria-live="off">
            {fromLabel} – {toLabel}
            <span className={styles.rangeCount}>{spanWeeks}w</span>
          </span>
        </div>
      ) : null}

      {visible.has('bucket') ? (
        <SegmentedControl<Filters['bucket']>
          label="Time bucket"
          size="sm"
          value={filters.bucket}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
            { value: 'quarter', label: 'Quarter' },
          ]}
          onChange={(bucket) => setFilters({ bucket })}
        />
      ) : null}

      <div className={styles.selects}>
        {visible.has('plant') ? (
          <MultiSelect
            label="Plants"
            hideLabel
            size="sm"
            noun="plants"
            options={plantOptions}
            value={filters.plantIds}
            onChange={(plantIds) => setFilters({ plantIds })}
            className={styles.select}
          />
        ) : null}

        {visible.has('region') ? (
          <MultiSelect
            label="Regions"
            hideLabel
            size="sm"
            noun="regions"
            options={regionOptions}
            value={filters.regions}
            onChange={(regions) => setFilters({ regions: regions as Region[] })}
            className={styles.selectNarrow}
          />
        ) : null}

        {visible.has('family') ? (
          <MultiSelect
            label="Families"
            hideLabel
            size="sm"
            noun="families"
            options={familyOptions}
            value={filters.familyIds}
            onChange={(familyIds) => setFilters({ familyIds })}
            className={styles.select}
          />
        ) : null}

        {visible.has('group') ? (
          <MultiSelect
            label="Product groups"
            hideLabel
            size="sm"
            noun="groups"
            options={groupOptions}
            value={filters.groupIds}
            onChange={(groupIds) => setFilters({ groupIds })}
            className={styles.select}
          />
        ) : null}

        {visible.has('machineClass') ? (
          <MultiSelect
            label="Machine classes"
            hideLabel
            size="sm"
            noun="classes"
            options={classOptions}
            value={filters.machineClassIds}
            onChange={(machineClassIds) => setFilters({ machineClassIds })}
            className={styles.select}
          />
        ) : null}
      </div>

      <div className={styles.tail}>
        {aside}
        <span className={styles.count}>
          {activeCount === 0 ? 'No filters — the whole network' : `${activeCount} active`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="reset"
          onClick={resetFilters}
          disabled={activeCount === 0}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}
