/**
 * The weekly time grid, in ISO-8601 weeks.
 *
 * Weekly is the planning bucket. Month and quarter are roll-up *views* over the
 * same weeks — never a second model, never a re-bucketing of the plan.
 *
 * Two rules this file exists to enforce:
 *
 *   1. A week belongs to the month (and quarter, and ISO year) containing its
 *      **Thursday**. Using the Monday is the classic bug: the week of
 *      2026-12-28 would land in December 2026 when ISO says it is week 1 of
 *      2027, and every December/January roll-up would be quietly wrong.
 *   2. Everything here is pure. The horizon start arrives as a string argument;
 *      nothing calls `new Date()`, so two runs of the same scenario produce the
 *      same grid forever. Calendar arithmetic is integer day-number maths
 *      (Howard Hinnant's civil-from-days algorithms), which also keeps the
 *      whole file free of timezone behaviour.
 *
 * On the hot path time is a `WeekIndex` — a plain integer offset into the grid.
 * ISO labels are for display and for CSV round-trips only.
 */

import type { TimeGrid, WeekIndex } from '@/domain/types'
import { at } from '@/domain/lookup'

export type Bucket = 'week' | 'month' | 'quarter'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// ---------------------------------------------------------------------------
// Civil date <-> day number. Integer maths only.
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for a proleptic Gregorian y/m/d (m is 1..12). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400 // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1 // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy // [0, 146096]
  return era * 146097 + doe - 719468
}

interface Civil {
  year: number
  month: number
  day: number
}

/** Inverse of {@link daysFromCivil}. */
function civilFromDays(days: number): Civil {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097 // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  ) // [0, 399]
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)) // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153) // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1 // [1, 31]
  const month = mp < 10 ? mp + 3 : mp - 9 // [1, 12]
  return { year: month <= 2 ? y + 1 : y, month, day }
}

/** 0 = Monday .. 6 = Sunday. 1970-01-01 (day 0) was a Thursday. */
function weekdayIndex(days: number): number {
  return (((days + 3) % 7) + 7) % 7
}

/** The day number of the Thursday of the ISO week containing `days`. */
function thursdayOf(days: number): number {
  return days + (3 - weekdayIndex(days))
}

/** The day number of the Monday of the ISO week containing `days`. */
function mondayOf(days: number): number {
  return days - weekdayIndex(days)
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function formatDate(days: number): string {
  const c = civilFromDays(days)
  return `${String(c.year).padStart(4, '0')}-${pad2(c.month)}-${pad2(c.day)}`
}

function parseDate(text: string): number {
  const match = ISO_DATE.exec(text)
  if (!match) {
    throw new Error(`not an ISO date (YYYY-MM-DD): ${text}`)
  }
  const year = Number(at(match, 1, 'date year'))
  const month = Number(at(match, 2, 'date month'))
  const day = Number(at(match, 3, 'date day'))
  const days = daysFromCivil(year, month, day)
  // Round-trip rejects 2026-02-30 and friends, which the regex happily accepts.
  const back = civilFromDays(days)
  if (back.year !== year || back.month !== month || back.day !== day) {
    throw new Error(`not a real calendar date: ${text}`)
  }
  return days
}

// ---------------------------------------------------------------------------
// ISO week identity
// ---------------------------------------------------------------------------

export interface IsoWeek {
  /** ISO week-numbering year — not always the calendar year of the date. */
  isoYear: number
  /** 1..52 or 1..53. */
  isoWeek: number
}

function isoWeekOfDays(days: number): IsoWeek {
  // The ISO year is the calendar year of the week's Thursday, and week 1 is the
  // week whose Thursday falls in January. Once the Thursday is known, the week
  // number is just its ordinal day divided by seven — no special cases.
  const thu = thursdayOf(days)
  const { year } = civilFromDays(thu)
  const jan1 = daysFromCivil(year, 1, 1)
  return { isoYear: year, isoWeek: Math.floor((thu - jan1) / 7) + 1 }
}

/**
 * ISO week identity of a calendar date. Supplementary to the grid API, but the
 * mock-data factory and the SAP loader both need it to align dated events
 * (shutdowns, downtime windows) onto week indexes.
 */
export function isoWeekOfDate(date: string): IsoWeek {
  return isoWeekOfDays(parseDate(date))
}

/** `2026-W03`. Week is zero-padded to two digits; the year is never abbreviated. */
export function isoWeekLabel(y: number, w: number): string {
  return `${String(y).padStart(4, '0')}-W${pad2(w)}`
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * `weekCount` consecutive ISO weeks starting at the week containing
 * `startMonday`.
 *
 * A date that is not a Monday is snapped back to the Monday of its own ISO
 * week rather than rejected: the grid must stay aligned to real weeks, and a
 * caller handing over "the week of the 9th" is expressing exactly that.
 */
export function buildTimeGrid(startMonday: string, weekCount: number): TimeGrid {
  if (!Number.isSafeInteger(weekCount) || weekCount < 0) {
    throw new Error(`weekCount must be a non-negative integer: ${weekCount}`)
  }
  const start = mondayOf(parseDate(startMonday))

  const weeks: string[] = new Array<string>(weekCount)
  const weekStart: string[] = new Array<string>(weekCount)
  const monthOfWeek: string[] = new Array<string>(weekCount)
  const quarterOfWeek: string[] = new Array<string>(weekCount)
  const months: string[] = []
  const quarters: string[] = []

  for (let w = 0; w < weekCount; w += 1) {
    const monday = start + w * 7
    const iso = isoWeekOfDays(monday)
    weeks[w] = isoWeekLabel(iso.isoYear, iso.isoWeek)
    weekStart[w] = formatDate(monday)

    // Month and quarter attribution follow the Thursday, per ISO-8601.
    const thu = civilFromDays(thursdayOf(monday))
    const month = `${String(thu.year).padStart(4, '0')}-${pad2(thu.month)}`
    const quarter = `${String(thu.year).padStart(4, '0')}-Q${Math.floor((thu.month - 1) / 3) + 1}`
    monthOfWeek[w] = month
    quarterOfWeek[w] = quarter

    if (months[months.length - 1] !== month) months.push(month)
    if (quarters[quarters.length - 1] !== quarter) quarters.push(quarter)
  }

  return { weeks, weekStart, monthOfWeek, quarterOfWeek, months, quarters }
}

/**
 * Label -> index. Cached per grid, because the CSV loader resolves tens of
 * thousands of labels and a linear scan of 78 strings each time is 78x too much
 * work for something this boring.
 */
const labelIndexCache = new WeakMap<TimeGrid, Map<string, number>>()

function labelIndex(grid: TimeGrid): Map<string, number> {
  const cached = labelIndexCache.get(grid)
  if (cached) return cached
  const map = new Map<string, number>()
  for (let w = 0; w < grid.weeks.length; w += 1) {
    const label = grid.weeks[w]
    // First occurrence wins; a well-formed grid has no repeats anyway.
    if (label !== undefined && !map.has(label)) map.set(label, w)
  }
  labelIndexCache.set(grid, map)
  return map
}

/** Throws when the label is outside the horizon — a silent -1 would poison a grid write. */
export function weekIndexOfLabel(grid: TimeGrid, label: string): WeekIndex {
  const index = labelIndex(grid).get(label)
  if (index === undefined) {
    throw new Error(`week label outside the horizon: ${label}`)
  }
  return index
}

/** Supplementary: the week index containing a calendar date, or -1 if outside. */
export function weekIndexOfDate(grid: TimeGrid, date: string): WeekIndex {
  const iso = isoWeekOfDate(date)
  return labelIndex(grid).get(isoWeekLabel(iso.isoYear, iso.isoWeek)) ?? -1
}

/** The bucket key a week rolls into: its own label, its month, or its quarter. */
export function bucketKeyOf(grid: TimeGrid, w: WeekIndex, b: Bucket): string {
  switch (b) {
    case 'week':
      return at(grid.weeks, w, 'week')
    case 'month':
      return at(grid.monthOfWeek, w, 'month of week')
    case 'quarter':
      return at(grid.quarterOfWeek, w, 'quarter of week')
  }
}

/** The roll-up axis for a bucket, in chronological order. */
export function bucketKeys(grid: TimeGrid, b: Bucket): string[] {
  switch (b) {
    case 'week':
      return grid.weeks
    case 'month':
      return grid.months
    case 'quarter':
      return grid.quarters
  }
}

/**
 * Weeks belonging to each bucket, parallel to {@link bucketKeys}. Charts and
 * the roll-up walk these rather than re-deriving membership per cell.
 */
export function weeksInBucket(grid: TimeGrid, b: Bucket): WeekIndex[][] {
  const keys = bucketKeys(grid, b)
  const buckets: WeekIndex[][] = keys.map(() => [])
  if (b === 'week') {
    for (let w = 0; w < keys.length; w += 1) at(buckets, w, 'bucket').push(w)
    return buckets
  }
  const position = new Map<string, number>()
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]
    if (k !== undefined) position.set(k, i)
  }
  const source = b === 'month' ? grid.monthOfWeek : grid.quarterOfWeek
  for (let w = 0; w < source.length; w += 1) {
    const k = source[w]
    if (k === undefined) continue
    const i = position.get(k)
    if (i === undefined) continue
    at(buckets, i, 'bucket').push(w)
  }
  return buckets
}
