/**
 * The densest thing in the cockpit: 150 work centers x 78 weeks.
 *
 * 11,700 cells will not stay interactive as SVG nodes, so the fills are painted
 * to a `<canvas>` and only the chrome that has to be crisp and addressable —
 * crosshair, focus ring, selected row — is an SVG layer over the top. Vertical
 * scrolling is virtualised; horizontal scrolling happens inside this component,
 * never on the page.
 *
 * Three rules this grid exists to demonstrate:
 *
 *   - Utilisation against a ceiling is *polarity*, not magnitude. Each cell is
 *     measured against its OWN ceiling before it gets here, so 1 means "at the
 *     ceiling" everywhere and the diverging scale can be centred on 1 globally:
 *     cool below, neutral grey at it, warm above.
 *   - Colour follows the value, never the row's rank. Sorting permutes which
 *     row is drawn where and nothing else — a cell keeps its colour when the
 *     sort changes, which is what makes re-sorting a safe thing to do.
 *   - Colour is never the only channel. A cell over its ceiling carries a
 *     chevron, and a cell with a dated downtime event carries a hatch so a
 *     blocked week can never be mistaken for an idle one.
 *
 * Canvas cannot resolve `var(--token)`, so the palette is read once from
 * computed style and re-read when the theme changes. The hexes still live only
 * in `tokens.css`; nothing here writes one down.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { at, clamp, key } from '@/domain/lookup'
import { hours as formatHours, pct } from '@/lib/format'
import { seriesColor } from '@/charts/palette'
import { ChartEmpty } from '@/charts/ChartCard'
import { DivergingLegend } from '@/charts/Legend'
import { Tooltip } from '@/charts/Tooltip'
import { useIsomorphicLayoutEffect } from '@/charts/primitives'
import type {
  TooltipRow,
  UtilisationCellRef,
  UtilisationGridLegendProps,
  UtilisationGridProps,
  UtilisationGridRow,
  UtilisationGridSort,
} from '@/charts/types'
import styles from '@/charts/UtilisationGrid.module.css'

const LABEL_WIDTH = 186
const HEADER_HEIGHT = 28
const DEFAULT_CELL_WIDTH = 16
const DEFAULT_ROW_HEIGHT = 20
const CELL_GAP = 2
const MAX_PIXEL_RATIO = 2

/**
 * The nine declared diverging steps, in bin order. Mirrors the binning in
 * `palette.divergingColor` exactly — canvas needs the resolved value, the SVG
 * charts keep using the `var()` form, and both must land on the same step.
 */
const DIVERGING_TOKENS = [
  '--div-neg-4',
  '--div-neg-3',
  '--div-neg-2',
  '--div-neg-1',
  '--div-mid',
  '--div-pos-1',
  '--div-pos-2',
  '--div-pos-3',
  '--div-pos-4',
] as const

const CHROME_TOKENS = ['--surface-1', '--surface-sunken', '--text-primary', '--border'] as const

const TOKENS: readonly string[] = [...DIVERGING_TOKENS, ...CHROME_TOKENS]

export function UtilisationGrid({
  rows,
  weeks,
  utilisation,
  machineUtilisation,
  labourUtilisation,
  availableHours,
  requiredHours,
  bindingPool,
  downtimeHours,
  eventLabels,
  domain = 0.5,
  sort,
  onSortChange,
  selectedRowId,
  onCellClick,
  onRowClick,
  height = 420,
  cellWidth = DEFAULT_CELL_WIDTH,
  rowHeight = DEFAULT_ROW_HEIGHT,
  weekLabel,
  emptyMessage,
}: UtilisationGridProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [viewport, setViewport] = useState({ width: 720, height })
  const [scroll, setScroll] = useState({ left: 0, top: 0 })
  const [hover, setHover] = useState<{ display: number; week: number } | null>(null)
  const [focus, setFocus] = useState<{ display: number; week: number } | null>(null)
  const [internalSort, setInternalSort] = useState<UtilisationGridSort>({
    by: 'peak',
    direction: 'desc',
  })

  const tokens = useResolvedTokens(TOKENS)
  const activeSort = sort ?? internalSort
  const weekCount = weeks.length

  /**
   * Display order -> data row index. This is the ONLY thing sorting changes:
   * every fill is looked up by the data index, so a cell's colour is a pure
   * function of its value and never of where the row currently sits.
   */
  const order = useMemo(() => sortRows(rows, activeSort), [rows, activeSort])

  const setSort = useCallback(
    (by: UtilisationGridSort['by']) => {
      const next: UtilisationGridSort =
        activeSort.by === by
          ? { by, direction: activeSort.direction === 'asc' ? 'desc' : 'asc' }
          : { by, direction: by === 'peak' ? 'desc' : 'asc' }
      if (onSortChange) onSortChange(next)
      else setInternalSort(next)
    },
    [activeSort, onSortChange],
  )

  // Measure the frame so the canvas matches its box exactly.
  useIsomorphicLayoutEffect(() => {
    const element = frameRef.current
    if (!element) return
    const measure = (): void => {
      const width = element.clientWidth
      const box = element.clientHeight
      setViewport((prior) =>
        prior.width === width && prior.height === box ? prior : { width, height: box },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fieldWidth = Math.max(0, viewport.width - LABEL_WIDTH)
  const fieldHeight = Math.max(0, viewport.height - HEADER_HEIGHT)
  const contentWidth = weekCount * cellWidth
  const contentHeight = rows.length * rowHeight

  const firstRow = Math.max(0, Math.floor(scroll.top / rowHeight))
  const lastRow = Math.min(rows.length - 1, Math.ceil((scroll.top + fieldHeight) / rowHeight))
  const firstWeek = Math.max(0, Math.floor(scroll.left / cellWidth))
  const lastWeek = Math.min(weekCount - 1, Math.ceil((scroll.left + fieldWidth) / cellWidth))

  // --- paint ---------------------------------------------------------------
  useIsomorphicLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const ratio = Math.min(MAX_PIXEL_RATIO, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
    const pixelWidth = Math.max(1, Math.floor(fieldWidth * ratio))
    const pixelHeight = Math.max(1, Math.floor(fieldHeight * ratio))
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, fieldWidth, fieldHeight)
    ctx.fillStyle = tokens['--surface-sunken'] ?? 'transparent'
    ctx.fillRect(0, 0, fieldWidth, fieldHeight)

    if (rows.length === 0 || weekCount === 0) return

    // No hex is ever written down here: the palette is whatever `tokens.css`
    // resolved to. Until it has resolved there is nothing correct to paint.
    const darkInk = tokens['--text-primary']
    const lightInk = tokens['--surface-1']
    if (darkInk === undefined || lightInk === undefined || darkInk === '' || lightInk === '') return

    const fills = DIVERGING_TOKENS.map((token) => tokens[token] ?? 'transparent')
    const inks = fills.map((fill) => pickInk(fill, darkInk, lightInk))
    const separator = tokens['--border'] ?? 'transparent'
    const drawGlyphs = cellWidth >= 9 && rowHeight >= 11
    const safeDomain = domain > 0 ? domain : 0.5

    for (let display = firstRow; display <= lastRow; display += 1) {
      const dataIndex = order[display]
      if (dataIndex === undefined) continue
      const rowTop = display * rowHeight - scroll.top
      const base = dataIndex * weekCount

      for (let week = firstWeek; week <= lastWeek; week += 1) {
        const value = utilisation[base + week]
        if (value === undefined || !Number.isFinite(value)) continue
        const bin = divergingBin((value - 1) / safeDomain)
        const x = week * cellWidth - scroll.left + CELL_GAP / 2
        const y = rowTop + CELL_GAP / 2
        const w = cellWidth - CELL_GAP
        const h = rowHeight - CELL_GAP
        ctx.fillStyle = fills[bin + 4] ?? 'transparent'
        ctx.fillRect(x, y, w, h)

        const ink = inks[bin + 4] ?? darkInk
        const blocked = (downtimeHours[base + week] ?? 0) > 0
        if (blocked) {
          // A hatch, not a lighter fill: a blocked week must never read as idle.
          ctx.save()
          ctx.beginPath()
          ctx.rect(x, y, w, h)
          ctx.clip()
          ctx.strokeStyle = ink
          ctx.globalAlpha = 0.55
          ctx.lineWidth = 1
          ctx.beginPath()
          for (let offset = -h; offset < w; offset += 4) {
            ctx.moveTo(x + offset, y + h)
            ctx.lineTo(x + offset + h, y)
          }
          ctx.stroke()
          ctx.restore()
        }

        if (value > 1 && drawGlyphs) {
          // Over the ceiling gets a mark of its own — colour is never alone.
          ctx.save()
          ctx.strokeStyle = ink
          ctx.lineWidth = 1.25
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          const cx = x + w / 2
          const cy = y + h / 2
          const arm = Math.min(w, h) * 0.26
          ctx.beginPath()
          ctx.moveTo(cx - arm, cy + arm * 0.6)
          ctx.lineTo(cx, cy - arm * 0.6)
          ctx.lineTo(cx + arm, cy + arm * 0.6)
          ctx.stroke()
          ctx.restore()
        }
      }

      // Hairline where the plant changes — the grouping a planner reads by.
      const previous = display > 0 ? order[display - 1] : undefined
      if (previous !== undefined) {
        const current = rows[dataIndex]
        const above = rows[previous]
        if (current && above && current.plantId !== above.plantId) {
          ctx.fillStyle = separator
          ctx.fillRect(0, Math.round(rowTop) - 0.5, fieldWidth, 1)
        }
      }
    }
  }, [
    tokens,
    rows,
    order,
    utilisation,
    downtimeHours,
    weekCount,
    cellWidth,
    rowHeight,
    domain,
    fieldWidth,
    fieldHeight,
    firstRow,
    lastRow,
    firstWeek,
    lastWeek,
    scroll.left,
    scroll.top,
  ])

  // --- interaction ---------------------------------------------------------

  const cellFromPointer = useCallback(
    (clientX: number, clientY: number, box: DOMRect): { display: number; week: number } | null => {
      const x = clientX - box.left - LABEL_WIDTH + scroll.left
      const y = clientY - box.top - HEADER_HEIGHT + scroll.top
      if (x < 0 || y < 0) return null
      const display = Math.floor(y / rowHeight)
      const week = Math.floor(x / cellWidth)
      if (display < 0 || display >= rows.length || week < 0 || week >= weekCount) return null
      return { display, week }
    },
    [scroll.left, scroll.top, rowHeight, cellWidth, rows.length, weekCount],
  )

  const revealCell = useCallback(
    (display: number, week: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const cellLeft = week * cellWidth
      const cellTop = display * rowHeight
      const nextLeft = clamp(scroller.scrollLeft, cellLeft + cellWidth - fieldWidth, cellLeft)
      const nextTop = clamp(scroller.scrollTop, cellTop + rowHeight - fieldHeight, cellTop)
      if (nextLeft !== scroller.scrollLeft) scroller.scrollLeft = Math.max(0, nextLeft)
      if (nextTop !== scroller.scrollTop) scroller.scrollTop = Math.max(0, nextTop)
    },
    [cellWidth, rowHeight, fieldWidth, fieldHeight],
  )

  const active = hover ?? focus
  const activeRow = active === null ? undefined : rowAt(rows, order, active.display)
  const activeDataIndex = active === null ? undefined : order[active.display]

  const emitCellClick = useCallback(
    (display: number, week: number) => {
      if (!onCellClick) return
      const dataIndex = order[display]
      const row = dataIndex === undefined ? undefined : rows[dataIndex]
      if (dataIndex === undefined || row === undefined) return
      const ref: UtilisationCellRef = { rowIndex: dataIndex, rowId: row.id, week }
      onCellClick(ref)
    },
    [onCellClick, order, rows],
  )

  if (rows.length === 0 || weekCount === 0) {
    return <ChartEmpty height={height} message={emptyMessage ?? 'No work centers in this slice'} />
  }

  const readout =
    active !== null && activeRow !== undefined && activeDataIndex !== undefined
      ? buildReadout(
          activeRow,
          at(weeks, active.week, 'week'),
          activeDataIndex * weekCount + active.week,
          {
            utilisation,
            machineUtilisation,
            labourUtilisation,
            availableHours,
            requiredHours,
            bindingPool,
            downtimeHours,
          },
          eventLabels?.get(key(activeRow.id, active.week)),
        )
      : null

  const headerStride = Math.max(1, Math.ceil(46 / cellWidth))

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <span className={styles.controlsLabel}>Sort rows</span>
        <div className={styles.sortGroup} role="group" aria-label="Sort work centers">
          {(['peak', 'plant', 'code'] as const).map((by) => (
            <button
              key={by}
              type="button"
              className={styles.sortButton}
              aria-pressed={activeSort.by === by}
              onClick={() => setSort(by)}
            >
              {by === 'peak' ? 'Peak utilisation' : by === 'plant' ? 'Plant' : 'Code'}
              {activeSort.by === by ? (
                <span className={styles.sortGlyph} aria-hidden="true">
                  {activeSort.direction === 'asc' ? '↑' : '↓'}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <span className={styles.controlsNote}>Sorting never repaints a cell</span>
      </div>

      <div className={styles.grid} style={{ height }} ref={frameRef}>
        <div className={styles.corner} style={{ width: LABEL_WIDTH, height: HEADER_HEIGHT }}>
          Work center
        </div>

        <div
          className={styles.header}
          style={{ left: LABEL_WIDTH, height: HEADER_HEIGHT, width: fieldWidth }}
        >
          {weeks.map((week, index) =>
            index >= firstWeek && index <= lastWeek && index % headerStride === 0 ? (
              <span
                key={week}
                className={styles.headerTick}
                style={{ left: index * cellWidth - scroll.left, width: cellWidth * headerStride }}
              >
                {weekLabel ? weekLabel(week, index) : shortWeek(week)}
              </span>
            ) : null,
          )}
        </div>

        <div
          className={styles.labels}
          style={{ top: HEADER_HEIGHT, width: LABEL_WIDTH, height: fieldHeight }}
        >
          {sliceRows(rows, order, firstRow, lastRow).map(({ row, display }) => (
            <div
              key={row.id}
              className={[
                styles.rowLabel,
                selectedRowId === row.id ? styles.rowSelected : '',
                active?.display === display ? styles.rowActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ top: display * rowHeight - scroll.top, height: rowHeight }}
            >
              <span
                className={styles.chip}
                style={{ background: seriesColor(row.plantSlot) }}
                aria-hidden="true"
              />
              <span className={styles.code}>{row.code}</span>
              <span className={styles.class}>{row.machineClass}</span>
            </div>
          ))}
        </div>

        <div
          className={styles.plot}
          style={{ left: LABEL_WIDTH, top: HEADER_HEIGHT, width: fieldWidth, height: fieldHeight }}
        >
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            style={{ width: fieldWidth, height: fieldHeight }}
            role="img"
            aria-label={`Utilisation for ${rows.length} work centers across ${weekCount} weeks`}
          />
          {active !== null ? (
            <svg
              className={styles.overlay}
              width={fieldWidth}
              height={fieldHeight}
              viewBox={`0 0 ${Math.max(fieldWidth, 1)} ${Math.max(fieldHeight, 1)}`}
              aria-hidden="true"
            >
              <rect
                className={styles.crossRow}
                x={0}
                y={active.display * rowHeight - scroll.top}
                width={fieldWidth}
                height={rowHeight}
              />
              <rect
                className={styles.crossColumn}
                x={active.week * cellWidth - scroll.left}
                y={0}
                width={cellWidth}
                height={fieldHeight}
              />
              <rect
                className={styles.focusRing}
                x={active.week * cellWidth - scroll.left + 0.5}
                y={active.display * rowHeight - scroll.top + 0.5}
                width={Math.max(0, cellWidth - 1)}
                height={Math.max(0, rowHeight - 1)}
              />
            </svg>
          ) : null}
        </div>

        {/*
          A transparent scroll surface over every layer. It owns both scrollbars
          and every pointer event, so the canvas, the sticky column and the week
          header move from one scroll offset and can never tear apart.
        */}
        <div
          className={styles.scroller}
          ref={scrollerRef}
          tabIndex={0}
          role="grid"
          aria-rowcount={rows.length}
          aria-colcount={weekCount}
          aria-label="Work center utilisation by week"
          onScroll={(event) => {
            const element = event.currentTarget
            setScroll({ left: element.scrollLeft, top: element.scrollTop })
          }}
          onPointerMove={(event) => {
            setHover(cellFromPointer(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()))
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setFocus((prior) => prior ?? { display: firstRow, week: firstWeek })}
          onBlur={() => setFocus(null)}
          onKeyDown={(event) => {
            const steps: Record<string, [number, number]> = {
              ArrowUp: [-1, 0],
              ArrowDown: [1, 0],
              ArrowLeft: [0, -1],
              ArrowRight: [0, 1],
              PageUp: [-10, 0],
              PageDown: [10, 0],
            }
            const step = steps[event.key]
            if (step) {
              event.preventDefault()
              const base = focus ?? { display: firstRow, week: firstWeek }
              const next = {
                display: clamp(base.display + step[0], 0, rows.length - 1),
                week: clamp(base.week + step[1], 0, weekCount - 1),
              }
              setFocus(next)
              revealCell(next.display, next.week)
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              if (focus === null) return
              event.preventDefault()
              emitCellClick(focus.display, focus.week)
              return
            }
            if (event.key === 'Home') {
              event.preventDefault()
              setFocus((prior) => ({ display: prior?.display ?? 0, week: 0 }))
              revealCell(focus?.display ?? 0, 0)
            } else if (event.key === 'End') {
              event.preventDefault()
              setFocus((prior) => ({ display: prior?.display ?? 0, week: weekCount - 1 }))
              revealCell(focus?.display ?? 0, weekCount - 1)
            }
          }}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const x = event.clientX - box.left
            if (x < LABEL_WIDTH) {
              const y = event.clientY - box.top - HEADER_HEIGHT + scroll.top
              if (y < 0) return
              const row = rowAt(rows, order, Math.floor(y / rowHeight))
              if (row && onRowClick) onRowClick(row.id)
              return
            }
            const cell = cellFromPointer(event.clientX, event.clientY, box)
            if (cell) emitCellClick(cell.display, cell.week)
          }}
        >
          <div
            className={styles.sizer}
            style={{ width: LABEL_WIDTH + contentWidth, height: HEADER_HEIGHT + contentHeight }}
          />
        </div>

        {readout !== null && active !== null ? (
          <Tooltip
            title={readout.title}
            subtitle={readout.subtitle}
            rows={readout.rows}
            x={clamp(LABEL_WIDTH + active.week * cellWidth - scroll.left + cellWidth / 2, 0, viewport.width)}
            y={clamp(
              HEADER_HEIGHT + active.display * rowHeight - scroll.top + rowHeight / 2,
              0,
              viewport.height,
            )}
            containerWidth={viewport.width}
            containerHeight={viewport.height}
            live={hover === null}
          />
        ) : null}
      </div>

      <div className={styles.footer}>
        <UtilisationGridLegend domain={domain} />
        <ul className={styles.keys}>
          <li className={styles.keyItem}>
            <span className={styles.glyphChevron} aria-hidden="true">
              ⌃
            </span>
            Over its ceiling
          </li>
          <li className={styles.keyItem}>
            <span className={styles.glyphHatch} aria-hidden="true" />
            Planned downtime
          </li>
        </ul>
      </div>
    </div>
  )
}

/** The diverging scale with its three labels, for use beside or above a grid. */
export function UtilisationGridLegend({ domain = 0.5, labels }: UtilisationGridLegendProps) {
  return (
    <DivergingLegend
      labels={labels ?? { negative: 'Headroom', neutral: 'At ceiling', positive: 'Over ceiling' }}
      bounds={{ negative: pct(1 - domain, 0), positive: pct(1 + domain, 0) }}
    />
  )
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * Display order. Plant grouping is the primary key for the `plant` sort and the
 * tie-break for `peak`, so the plant bands stay legible however it is ordered.
 */
function sortRows(rows: readonly UtilisationGridRow[], sort: UtilisationGridSort): number[] {
  const indices = rows.map((_, index) => index)
  const sign = sort.direction === 'asc' ? 1 : -1
  indices.sort((a, b) => {
    const left = rows[a]
    const right = rows[b]
    if (left === undefined || right === undefined) return 0
    if (sort.by === 'peak') {
      const delta = left.peakUtilisation - right.peakUtilisation
      if (delta !== 0) return sign * delta
      return left.code.localeCompare(right.code)
    }
    if (sort.by === 'plant') {
      const byPlant = left.plantLabel.localeCompare(right.plantLabel)
      if (byPlant !== 0) return sign * byPlant
      return left.code.localeCompare(right.code)
    }
    return sign * left.code.localeCompare(right.code)
  })
  return indices
}

function rowAt(
  rows: readonly UtilisationGridRow[],
  order: readonly number[],
  display: number,
): UtilisationGridRow | undefined {
  const dataIndex = order[display]
  return dataIndex === undefined ? undefined : rows[dataIndex]
}

function sliceRows(
  rows: readonly UtilisationGridRow[],
  order: readonly number[],
  from: number,
  to: number,
): Array<{ row: UtilisationGridRow; display: number }> {
  const out: Array<{ row: UtilisationGridRow; display: number }> = []
  for (let display = Math.max(0, from); display <= to; display += 1) {
    const row = rowAt(rows, order, display)
    if (row !== undefined) out.push({ row, display })
  }
  return out
}

interface Readout {
  title: string
  subtitle: string
  rows: TooltipRow[]
}

interface GridArrays {
  utilisation: Float64Array
  machineUtilisation: Float64Array
  labourUtilisation: Float64Array
  availableHours: Float64Array
  requiredHours: Float64Array
  bindingPool: Uint8Array
  downtimeHours: Float64Array
}

/**
 * The one readout. Hover and keyboard focus both land here, so focus can never
 * show less than the pointer does.
 */
function buildReadout(
  row: UtilisationGridRow,
  week: string,
  offset: number,
  arrays: GridArrays,
  event: string | undefined,
): Readout {
  const value = arrays.utilisation[offset] ?? 0
  const binding = (arrays.bindingPool[offset] ?? 0) === 1 ? 'Labour' : 'Machine'
  const available = arrays.availableHours[offset] ?? 0
  const required = arrays.requiredHours[offset] ?? 0
  const blocked = arrays.downtimeHours[offset] ?? 0

  const rows: TooltipRow[] = [
    {
      label: 'Against ceiling',
      value: pct(value),
      emphasis: true,
      status: value > 1 ? 'critical' : value > 0.9 ? 'warning' : undefined,
    },
    { label: 'Machine', value: pct(arrays.machineUtilisation[offset] ?? 0) },
    { label: 'Labour', value: pct(arrays.labourUtilisation[offset] ?? 0) },
    { label: 'Binding pool', value: binding },
    { label: 'Available', value: formatHours(available) },
    { label: 'Required', value: formatHours(required) },
  ]
  if (blocked > 0) {
    rows.push({ label: 'Downtime', value: formatHours(blocked), status: 'serious' })
  }
  if (event !== undefined) {
    rows.push({ label: 'Event', value: event, status: 'serious' })
  }
  return {
    title: `${row.code} · ${row.name}`,
    subtitle: `${row.plantLabel} · ${row.machineClass} · ${week}`,
    rows,
  }
}

/** "2026-W36" -> "W36". Weeks are dense; the year lives in the axis heading. */
function shortWeek(week: string): string {
  const dash = week.indexOf('-')
  return dash === -1 ? week : week.slice(dash + 1)
}

/** Same nine bins as `palette.divergingColor`, returned as an index -4..4. */
function divergingBin(t: number): number {
  const safe = Number.isFinite(t) ? clamp(t, -1, 1) : 0
  return clamp(Math.round(safe * 4), -4, 4)
}

// ---------------------------------------------------------------------------
// Token resolution — canvas cannot read var(), so read it once per theme
// ---------------------------------------------------------------------------

function useResolvedTokens(names: readonly string[]): Record<string, string> {
  // Read on the very first render so the grid never paints one empty frame
  // before the palette arrives.
  const [tokens, setTokens] = useState<Record<string, string>>(() => readTokens(names))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const read = (): void => {
      const next = readTokens(names)
      setTokens((prior) => (sameTokens(prior, next) ? prior : next))
    }
    read()
    const observer = new window.MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', read)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', read)
    }
  }, [names])

  return tokens
}

function readTokens(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof window === 'undefined' || typeof document === 'undefined') return out
  const style = window.getComputedStyle(document.documentElement)
  for (const name of names) out[name] = style.getPropertyValue(name).trim()
  return out
}

function sameTokens(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const name of keysA) {
    if (a[name] !== b[name]) return false
  }
  return true
}

/** Relative luminance of a `#rgb` / `#rrggbb` value, or null if unparseable. */
function luminance(color: string): number | null {
  const hex = color.trim()
  if (!hex.startsWith('#')) return null
  const body = hex.slice(1)
  const full =
    body.length === 3
      ? body
          .split('')
          .map((char) => char + char)
          .join('')
      : body
  if (full.length !== 6) return null
  const channel = (from: number): number | null => {
    const part = Number.parseInt(full.slice(from, from + 2), 16)
    if (Number.isNaN(part)) return null
    const srgb = part / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  const r = channel(0)
  const g = channel(2)
  const b = channel(4)
  if (r === null || g === null || b === null) return null
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Which of the two ink colours reads on this fill. The glyph must survive both
 * themes, and the diverging ends swap lightness between them, so this is
 * decided from the resolved value rather than assumed from the step index.
 */
function pickInk(fill: string, dark: string, light: string): string {
  const base = luminance(fill)
  if (base === null) return dark
  const contrast = (other: string): number => {
    const value = luminance(other)
    if (value === null) return 0
    const hi = Math.max(base, value) + 0.05
    const lo = Math.min(base, value) + 0.05
    return hi / lo
  }
  return contrast(dark) >= contrast(light) ? dark : light
}
