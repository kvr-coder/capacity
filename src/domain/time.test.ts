import { describe, expect, it } from 'vitest'
import {
  bucketKeyOf,
  bucketKeys,
  buildTimeGrid,
  isoWeekLabel,
  isoWeekOfDate,
  weekIndexOfDate,
  weekIndexOfLabel,
  weeksInBucket,
} from '@/domain/time'

describe('isoWeekLabel', () => {
  it('zero-pads the week and never abbreviates the year', () => {
    expect(isoWeekLabel(2026, 1)).toBe('2026-W01')
    expect(isoWeekLabel(2026, 9)).toBe('2026-W09')
    expect(isoWeekLabel(2026, 53)).toBe('2026-W53')
  })
})

describe('isoWeekOfDate', () => {
  it('numbers weeks by the year of their Thursday', () => {
    // 2026-01-01 is a Thursday, so it is week 1 of 2026 and the Monday before
    // it — still December 2025 on the calendar — belongs to 2026-W01.
    expect(isoWeekOfDate('2026-01-01')).toEqual({ isoYear: 2026, isoWeek: 1 })
    expect(isoWeekOfDate('2025-12-29')).toEqual({ isoYear: 2026, isoWeek: 1 })
    expect(isoWeekOfDate('2025-12-28')).toEqual({ isoYear: 2025, isoWeek: 52 })
  })

  it('gives 2026 a week 53', () => {
    // A year whose 1 January is a Thursday has 53 ISO weeks. 2026 is one.
    expect(isoWeekOfDate('2026-12-28')).toEqual({ isoYear: 2026, isoWeek: 53 })
    expect(isoWeekOfDate('2026-12-31')).toEqual({ isoYear: 2026, isoWeek: 53 })
    // The first days of January 2027 are still in 2026-W53.
    expect(isoWeekOfDate('2027-01-01')).toEqual({ isoYear: 2026, isoWeek: 53 })
    expect(isoWeekOfDate('2027-01-03')).toEqual({ isoYear: 2026, isoWeek: 53 })
    expect(isoWeekOfDate('2027-01-04')).toEqual({ isoYear: 2027, isoWeek: 1 })
  })

  it('handles the other year boundaries the same way', () => {
    expect(isoWeekOfDate('2020-12-28')).toEqual({ isoYear: 2020, isoWeek: 53 })
    expect(isoWeekOfDate('2021-01-01')).toEqual({ isoYear: 2020, isoWeek: 53 })
    expect(isoWeekOfDate('2021-01-04')).toEqual({ isoYear: 2021, isoWeek: 1 })
    expect(isoWeekOfDate('2024-12-30')).toEqual({ isoYear: 2025, isoWeek: 1 })
    expect(isoWeekOfDate('1970-01-01')).toEqual({ isoYear: 1970, isoWeek: 1 })
  })

  it('rejects anything that is not a real ISO date', () => {
    expect(() => isoWeekOfDate('2026-02-30')).toThrow(/not a real calendar date/)
    expect(() => isoWeekOfDate('2026-9-7')).toThrow(/not an ISO date/)
    expect(() => isoWeekOfDate('')).toThrow(/not an ISO date/)
  })
})

describe('buildTimeGrid', () => {
  const grid = buildTimeGrid('2026-09-07', 78)

  it('produces exactly weekCount consecutive weeks', () => {
    expect(grid.weeks).toHaveLength(78)
    expect(grid.weekStart).toHaveLength(78)
    expect(grid.weeks[0]).toBe('2026-W37')
    expect(grid.weekStart[0]).toBe('2026-09-07')
    expect(grid.weekStart[1]).toBe('2026-09-14')
    // 17 weeks of 2026 (W37..W53), 52 of 2027, then 9 of 2028.
    expect(grid.weeks[16]).toBe('2026-W53')
    expect(grid.weeks[17]).toBe('2027-W01')
    expect(grid.weeks[69]).toBe('2028-W01')
    expect(grid.weeks[77]).toBe('2028-W09')
    expect(grid.weekStart[77]).toBe('2028-02-28')
  })

  it('attributes a week to the month containing its Thursday', () => {
    // Monday 2026-09-28 falls in September, but its Thursday is 1 October.
    expect(grid.weekStart[3]).toBe('2026-09-28')
    expect(grid.monthOfWeek[3]).toBe('2026-10')
    expect(grid.monthOfWeek[2]).toBe('2026-09')
    expect(grid.quarterOfWeek[2]).toBe('2026-Q3')
    expect(grid.quarterOfWeek[3]).toBe('2026-Q4')
  })

  it('keeps a December week that belongs to the next ISO year in December', () => {
    // The label is 2026-W53 but the Thursday (31 Dec) is still December 2026,
    // so the month roll-up must not follow the ISO year into 2027.
    const boundary = buildTimeGrid('2026-12-28', 3)
    expect(boundary.weeks).toEqual(['2026-W53', '2027-W01', '2027-W02'])
    expect(boundary.monthOfWeek).toEqual(['2026-12', '2027-01', '2027-01'])
    expect(boundary.quarterOfWeek).toEqual(['2026-Q4', '2027-Q1', '2027-Q1'])
  })

  it('follows the Thursday across a year boundary in the other direction', () => {
    // Monday 2024-12-30 is a 2024 date whose Thursday is 2 January 2025.
    const crossing = buildTimeGrid('2024-12-30', 1)
    expect(crossing.weeks).toEqual(['2025-W01'])
    expect(crossing.monthOfWeek).toEqual(['2025-01'])
    expect(crossing.quarterOfWeek).toEqual(['2025-Q1'])
  })

  it('lists distinct months and quarters in order, with no gaps', () => {
    expect(grid.months[0]).toBe('2026-09')
    expect(grid.months[grid.months.length - 1]).toBe('2028-03')
    expect(grid.months).toHaveLength(19)
    expect(new Set(grid.months).size).toBe(19)
    expect(grid.quarters).toEqual([
      '2026-Q3',
      '2026-Q4',
      '2027-Q1',
      '2027-Q2',
      '2027-Q3',
      '2027-Q4',
      '2028-Q1',
    ])
  })

  it('snaps a start date that is not a Monday back to its own week', () => {
    const snapped = buildTimeGrid('2026-09-09', 2)
    expect(snapped.weekStart[0]).toBe('2026-09-07')
    expect(snapped.weeks[0]).toBe('2026-W37')
  })

  it('rejects a nonsense horizon', () => {
    expect(() => buildTimeGrid('2026-09-07', -1)).toThrow(/non-negative/)
    expect(() => buildTimeGrid('2026-09-07', 1.5)).toThrow(/non-negative/)
    expect(buildTimeGrid('2026-09-07', 0).weeks).toEqual([])
  })
})

describe('week lookup', () => {
  const grid = buildTimeGrid('2026-09-07', 78)

  it('resolves a label to its index', () => {
    expect(weekIndexOfLabel(grid, '2026-W37')).toBe(0)
    expect(weekIndexOfLabel(grid, '2026-W53')).toBe(16)
    expect(weekIndexOfLabel(grid, '2028-W09')).toBe(77)
  })

  it('throws rather than returning -1 for a label outside the horizon', () => {
    expect(() => weekIndexOfLabel(grid, '2026-W36')).toThrow(/outside the horizon/)
  })

  it('resolves a calendar date to the week containing it', () => {
    expect(weekIndexOfDate(grid, '2026-09-13')).toBe(0)
    expect(weekIndexOfDate(grid, '2026-09-14')).toBe(1)
    expect(weekIndexOfDate(grid, '2026-01-01')).toBe(-1)
  })
})

describe('bucketing', () => {
  const grid = buildTimeGrid('2026-09-07', 78)

  it('maps a week to its own bucket key', () => {
    expect(bucketKeyOf(grid, 0, 'week')).toBe('2026-W37')
    expect(bucketKeyOf(grid, 0, 'month')).toBe('2026-09')
    expect(bucketKeyOf(grid, 0, 'quarter')).toBe('2026-Q3')
    expect(() => bucketKeyOf(grid, 78, 'week')).toThrow(/out of range/)
  })

  it('returns the roll-up axis for each bucket', () => {
    expect(bucketKeys(grid, 'week')).toHaveLength(78)
    expect(bucketKeys(grid, 'month')).toHaveLength(19)
    expect(bucketKeys(grid, 'quarter')).toHaveLength(7)
  })

  it('partitions every week into exactly one bucket', () => {
    for (const bucket of ['week', 'month', 'quarter'] as const) {
      const groups = weeksInBucket(grid, bucket)
      expect(groups).toHaveLength(bucketKeys(grid, bucket).length)
      const flat = groups.flat()
      expect(flat).toHaveLength(78)
      expect(flat).toEqual([...flat].sort((a, b) => a - b))
      expect(new Set(flat).size).toBe(78)
      // Every week in a group agrees with the group's key.
      groups.forEach((weeks, index) => {
        const label = bucketKeys(grid, bucket)[index]
        for (const w of weeks) expect(bucketKeyOf(grid, w, bucket)).toBe(label)
      })
    }
  })

  it('puts the September/October straddling week in October', () => {
    const months = weeksInBucket(grid, 'month')
    expect(months[0]).toEqual([0, 1, 2])
    expect(months[1]?.[0]).toBe(3)
  })
})
