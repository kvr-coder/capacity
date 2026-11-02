/**
 * The frame every plot sits in.
 *
 * Two things are structural rather than decorative. First, `table` is required:
 * a chart in this app always ships its table twin, so no number is reachable
 * only by hovering. Second, `stale` dims the card during a recompute instead of
 * swapping in a skeleton — the layout must not jump while a planner is reading
 * it, and a 160ms opacity change says "recomputing" without moving anything.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChartCardProps } from '@/charts/types'
import { TableView } from '@/charts/TableView'
import styles from '@/charts/ChartCard.module.css'

export function ChartCard({
  title,
  subtitle,
  aside,
  table,
  children,
  stale,
  className,
}: ChartCardProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headingId = useId()

  return (
    <section
      className={[styles.card, stale ? styles.stale : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-labelledby={headingId}
      aria-busy={stale ? true : undefined}
    >
      <header className={styles.header}>
        <div className={styles.titles}>
          <h3 className={styles.title} id={headingId}>
            {title}
          </h3>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        {aside ? <div className={styles.aside}>{aside}</div> : null}
      </header>

      <div className={styles.plot}>{children}</div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((prior) => !prior)}
        >
          <span className={styles.toggleGlyph} aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {open ? 'Hide table' : 'Table view'}
        </button>
      </footer>

      <div className={styles.panel} id={panelId} hidden={!open}>
        {open ? <TableView {...table} /> : null}
      </div>
    </section>
  )
}

export interface ChartEmptyProps {
  /** What is missing, in the planner's words — never "no data". */
  message?: string
  /** How to get data back: a filter to widen, a scenario to run. */
  hint?: ReactNode
  /** Matches the height the plot would have had, so cards keep their rhythm. */
  height?: number
}

/**
 * The explicit empty state. Every chart renders this rather than an empty SVG,
 * because a blank plot area reads as a broken chart, not as an empty result.
 */
export function ChartEmpty({ message = 'Nothing in this slice', hint, height = 180 }: ChartEmptyProps) {
  return (
    <div className={styles.empty} style={{ minHeight: height }} role="status">
      <span className={styles.emptyGlyph} aria-hidden="true">
        ▤
      </span>
      <p className={styles.emptyMessage}>{message}</p>
      {hint ? <p className={styles.emptyHint}>{hint}</p> : null}
    </div>
  )
}
