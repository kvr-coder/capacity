/**
 * The table twin.
 *
 * Every chart ships one. It is the accessible, copyable, sortable-by-eye
 * version of the same numbers, and it is why a tooltip in this app can be an
 * enhancement rather than the only way to read a value.
 *
 * Numbers take tabular figures and right alignment so a column of hours reads
 * as a column. The optional colour key sits *beside* the first cell — identity
 * is never carried by the text colour.
 */

import { seriesColor } from '@/charts/palette'
import type { TableViewProps } from '@/charts/types'
import styles from '@/charts/TableView.module.css'

export function TableView({ caption, columns, rows, rowSlot }: TableViewProps) {
  const hasKeys = rowSlot !== undefined
  return (
    <div className={styles.scroller}>
      <table className={styles.table}>
        <caption className={styles.caption}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={column.align === 'right' ? styles.right : styles.left}
              >
                {hasKeys && index === 0 ? <span className={styles.keySpacer} aria-hidden="true" /> : null}
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={styles.empty} colSpan={Math.max(1, columns.length)}>
                No rows in this slice
              </td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => {
              const slot = rowSlot?.(row)
              return (
                <tr key={rowKey(row, columns, rowIndex)}>
                  {columns.map((column, columnIndex) => {
                    const value = row[column.key]
                    const text = value === undefined ? '—' : String(value)
                    const align = column.align === 'right' ? styles.right : styles.left
                    if (columnIndex === 0) {
                      return (
                        <th key={column.key} scope="row" className={`${styles.rowHead} ${align}`}>
                          {hasKeys ? (
                            <span
                              className={styles.key}
                              style={slot === undefined ? undefined : { background: seriesColor(slot) }}
                              aria-hidden="true"
                            />
                          ) : null}
                          {text}
                        </th>
                      )
                    }
                    return (
                      <td key={column.key} className={align}>
                        {text}
                      </td>
                    )
                  })}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Prefers the first column's value as the key, falling back to the position. */
function rowKey(
  row: Record<string, string | number>,
  columns: TableViewProps['columns'],
  index: number,
): string {
  const first = columns[0]
  if (first === undefined) return String(index)
  const value = row[first.key]
  return value === undefined ? String(index) : `${String(value)}#${index}`
}
