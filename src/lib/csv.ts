/**
 * RFC 4180 CSV, dependency-free.
 *
 * These files reach a million rows — the SUPPLY extract for the standard
 * profile is 15,000 materials x 78 weeks — so the parser is an index walk over
 * the source string rather than `split('\n').map(l => l.split(','))`. The naive
 * version is wrong (it breaks on a quoted newline) *and* slow (it allocates a
 * throwaway string per line, then per field, then garbage-collects the lot).
 * Here the only allocations are the field slices that actually survive.
 *
 * What is supported, deliberately:
 *
 *   - quoted fields containing commas, CR, LF and doubled `""` escapes
 *   - CRLF, LF and CR line endings, mixed within one file
 *   - a trailing newline, which does **not** produce a phantom final row
 *   - a leading UTF-8 BOM, which Excel adds and everyone forgets about
 *   - unterminated quotes at EOF, taken as "the rest of the file", because a
 *     truncated download should still surface its good rows to the loader
 *
 * `parseCsvRows` is the streaming entry point: it hands each record to a
 * callback without ever materialising the whole table. `parseCsv` is the
 * convenience wrapper over it, for tests and small files.
 */

const CH_QUOTE = 34 // "
const CH_COMMA = 44 // ,
const CH_CR = 13
const CH_LF = 10
const CH_BOM = 0xfeff

/**
 * Walk `text` once, invoking `onRow` per record.
 *
 * `rowNumber` is 1-based and counts physical records including the header, so
 * an error message can name a line a human can find in the file.
 *
 * The array handed to the callback is freshly allocated per row and may be
 * retained by the caller.
 */
export function parseCsvRows(
  text: string,
  onRow: (cells: string[], rowNumber: number) => void,
): void {
  const n = text.length
  let i = text.charCodeAt(0) === CH_BOM ? 1 : 0
  if (i >= n) return

  let row: string[] = []
  let rowNumber = 1

  while (i < n) {
    // --- one field -------------------------------------------------------
    let value: string
    if (text.charCodeAt(i) === CH_QUOTE) {
      i += 1
      let start = i
      let parts: string[] | null = null
      for (;;) {
        const q = text.indexOf('"', i)
        if (q === -1) {
          // Unterminated quote: swallow the remainder rather than throwing.
          const tail = text.slice(start)
          value = parts === null ? tail : parts.join('') + tail
          i = n
          break
        }
        if (text.charCodeAt(q + 1) === CH_QUOTE) {
          // `""` -> a single literal quote. Keep the first of the pair.
          if (parts === null) parts = []
          parts.push(text.slice(start, q + 1))
          i = q + 2
          start = i
          continue
        }
        const chunk = text.slice(start, q)
        value = parts === null ? chunk : parts.join('') + chunk
        i = q + 1
        break
      }
      // Junk after the closing quote (`"a"b`) is not legal RFC 4180, but real
      // extracts contain it. Absorb it instead of losing the row.
      if (i < n) {
        const c = text.charCodeAt(i)
        if (c !== CH_COMMA && c !== CH_CR && c !== CH_LF) {
          let j = i
          while (j < n) {
            const d = text.charCodeAt(j)
            if (d === CH_COMMA || d === CH_CR || d === CH_LF) break
            j += 1
          }
          value += text.slice(i, j)
          i = j
        }
      }
    } else {
      let j = i
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === CH_COMMA || c === CH_CR || c === CH_LF) break
        j += 1
      }
      value = text.slice(i, j)
      i = j
    }
    row.push(value)

    // --- delimiter -------------------------------------------------------
    if (i >= n) break
    const c = text.charCodeAt(i)
    if (c === CH_COMMA) {
      i += 1
      // A trailing comma at end of input means one more empty field.
      if (i >= n) {
        row.push('')
        break
      }
      continue
    }
    i += 1
    if (c === CH_CR && text.charCodeAt(i) === CH_LF) i += 1
    onRow(row, rowNumber)
    rowNumber += 1
    row = []
  }

  if (row.length > 0) onRow(row, rowNumber)
}

/** Whole-file parse. Prefer {@link parseCsvRows} for anything large. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  parseCsvRows(text, (cells) => {
    rows.push(cells)
  })
  return rows
}

/**
 * Quote a single field only when it needs it — a comma, a quote, or a line
 * break inside the value. Leading/trailing spaces are preserved as-is; SAP
 * pads plenty of fields and trimming them here would be a silent data change.
 */
export function csvField(value: string | number): string {
  const s = typeof value === 'number' ? String(value) : value
  const n = s.length
  for (let i = 0; i < n; i += 1) {
    const c = s.charCodeAt(i)
    if (c === CH_COMMA || c === CH_QUOTE || c === CH_CR || c === CH_LF) {
      return `"${s.replace(/"/g, '""')}"`
    }
  }
  return s
}

/** Rows -> RFC 4180 text, LF-terminated including the final row. */
export function toCsv(rows: (string | number)[][]): string {
  const out: string[] = []
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      if (i > 0) out.push(',')
      const cell = row[i]
      out.push(cell === undefined ? '' : csvField(cell))
    }
    out.push('\n')
  }
  return out.join('')
}

/**
 * Browser-only: hand a generated file to the user.
 *
 * The object URL is revoked on the next task rather than immediately —
 * Safari cancels the download if the URL dies inside the click handler.
 */
export function download(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  if (typeof document === 'undefined') {
    throw new Error('download() needs a DOM — call it from the main thread only')
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}
