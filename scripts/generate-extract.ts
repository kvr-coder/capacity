/**
 * Write a full SAP-shaped extract to disk.
 *
 *   npx vite-node scripts/generate-extract.ts
 *   npx vite-node scripts/generate-extract.ts -- --profile=demo
 *   npx vite-node scripts/generate-extract.ts -- --profile=large --out=/tmp/extract
 *
 * (or `npm run generate:extract -- --profile=demo`)
 *
 * Run through vite-node so the `@/` alias and TypeScript both work without a
 * build step and without depending on a particular Node type-stripping flag.
 *
 * The output lands in `mock/extract/`, which is git-ignored — the standard
 * profile is a few hundred megabytes of CSV and has no business in a repo.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildSnapshot, DEFAULT_PROFILE, PROFILES } from '@/data/factory'
import { EXTRACT_TABLES, TABLE_DESCRIPTIONS, writeAll } from '@/data/sap-writer'

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  for (const value of process.argv.slice(2)) {
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }
  return undefined
}

/** `DEFAULT_PROFILE` is a profile id; anything else is a contract change. */
function defaultProfileName(): string {
  return typeof DEFAULT_PROFILE === 'string' ? DEFAULT_PROFILE : 'standard'
}

function bytes(count: number): string {
  if (count >= 1024 ** 3) return `${(count / 1024 ** 3).toFixed(2)} GB`
  if (count >= 1024 ** 2) return `${(count / 1024 ** 2).toFixed(1)} MB`
  if (count >= 1024) return `${(count / 1024).toFixed(1)} KB`
  return `${count} B`
}

/**
 * Data rows = newlines minus the header. Every record this writer emits is
 * newline-terminated, so this is exact without re-parsing 40 MB of CSV.
 */
function dataRows(text: string): number {
  let newlines = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1
  }
  return Math.max(0, newlines - 1)
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function main(): void {
  const profileName = arg('profile') ?? defaultProfileName()
  const profile = PROFILES.find((p) => p.id === profileName)
  if (profile === undefined) {
    console.error(
      `unknown profile "${profileName}" — expected one of ${PROFILES.map((p) => p.id).join(', ')}`,
    )
    process.exitCode = 1
    return
  }

  const outDir = resolve(process.cwd(), arg('out') ?? 'mock/extract')
  mkdirSync(outDir, { recursive: true })
  // Belt and braces: the generated tree must never reach git.
  mkdirSync(resolve(outDir, '..'), { recursive: true })
  writeFileSync(resolve(outDir, '..', '.gitignore'), 'extract/\ncompiled/\n', 'utf8')

  const buildStart = Date.now()
  const snapshot = buildSnapshot(profile)
  const buildMs = Date.now() - buildStart

  console.log(
    `profile ${profileName}: ${snapshot.materials.length.toLocaleString('en-US')} materials, ` +
      `${snapshot.workCenters.length} work centers, ${snapshot.time.weeks.length} weeks ` +
      `(${snapshot.time.weeks[0] ?? '?'} .. ${snapshot.time.weeks[snapshot.time.weeks.length - 1] ?? '?'}) ` +
      `— built in ${buildMs} ms`,
  )
  console.log(`writing to ${outDir}`)
  console.log('')

  const writeStart = Date.now()
  const files = writeAll(snapshot)
  const writeMs = Date.now() - writeStart

  let totalBytes = 0
  let totalRows = 0
  console.log(`${pad('TABLE', 12)}${padLeft('ROWS', 12)}${padLeft('SIZE', 12)}  DESCRIPTION`)
  for (const table of EXTRACT_TABLES) {
    const text = files[table]
    const size = Buffer.byteLength(text, 'utf8')
    const rows = dataRows(text)
    totalBytes += size
    totalRows += rows
    writeFileSync(resolve(outDir, `${table}.csv`), text, 'utf8')
    console.log(
      `${pad(table, 12)}${padLeft(rows.toLocaleString('en-US'), 12)}${padLeft(bytes(size), 12)}  ${TABLE_DESCRIPTIONS[table]}`,
    )
  }
  console.log('')
  console.log(
    `${pad('TOTAL', 12)}${padLeft(totalRows.toLocaleString('en-US'), 12)}${padLeft(bytes(totalBytes), 12)}  ` +
      `${EXTRACT_TABLES.length} files, serialised in ${writeMs} ms`,
  )
}

main()
