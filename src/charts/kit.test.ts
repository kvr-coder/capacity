/**
 * Smoke coverage for the chart kit.
 *
 * The suite runs in the `node` environment, so this renders to static markup
 * rather than to a DOM: enough to prove every chart mounts, honours the
 * structural rules (legend at two series and not at one, an explicit empty
 * state rather than an empty SVG, a table twin on every card) and never throws
 * on a first paint before `useChartSize` has measured anything.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { hours, pct, units, usd } from '@/lib/format'
import { ChartCard } from '@/charts/ChartCard'
import { FlowMatrix } from '@/charts/FlowMatrix'
import { GlideCurve } from '@/charts/GlideCurve'
import { Heatmap } from '@/charts/Heatmap'
import { HeroFigure } from '@/charts/HeroFigure'
import { LineChart } from '@/charts/LineChart'
import { Meter } from '@/charts/Meter'
import { StackedBarChart } from '@/charts/StackedBarChart'
import { StatTile } from '@/charts/StatTile'
import { UtilisationGrid } from '@/charts/UtilisationGrid'
import { WaterfallChart } from '@/charts/WaterfallChart'
import type { TableViewProps, TimeSeries, UtilisationGridProps } from '@/charts/types'

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04']

function seriesOf(id: string, slot: 1 | 2, base: number): TimeSeries {
  return {
    id,
    label: `Series ${id}`,
    slot,
    points: MONTHS.map((month, index) => ({ month, value: base + index * 10 })),
  }
}

const TABLE: TableViewProps = {
  caption: 'Required hours by month',
  columns: [
    { key: 'month', label: 'Month' },
    { key: 'hours', label: 'Hours', align: 'right' },
  ],
  rows: MONTHS.map((month) => ({ month, hours: 1200 })),
}

describe('ChartCard', () => {
  it('renders the title and offers the table twin', () => {
    const html = renderToStaticMarkup(
      createElement(ChartCard, { title: 'Network load', table: TABLE, children: 'plot' }),
    )
    expect(html).toContain('Network load')
    expect(html).toContain('Table view')
  })
})

describe('LineChart', () => {
  it('draws a legend at two series', () => {
    const html = renderToStaticMarkup(
      createElement(LineChart, { series: [seriesOf('a', 1, 100), seriesOf('b', 2, 60)] }),
    )
    expect(html).toContain('Series a')
    expect(html).toContain('Series b')
  })

  it('draws no legend at exactly one series', () => {
    const one = renderToStaticMarkup(createElement(LineChart, { series: [seriesOf('a', 1, 100)] }))
    const two = renderToStaticMarkup(
      createElement(LineChart, { series: [seriesOf('a', 1, 100), seriesOf('b', 2, 60)] }),
    )
    expect(countOf(one, 'Series a')).toBe(0)
    expect(countOf(two, 'Series a')).toBe(1)
  })

  it('renders an explicit empty state rather than an empty svg', () => {
    const html = renderToStaticMarkup(createElement(LineChart, { series: [] }))
    expect(html).toContain('No series in this slice')
    expect(html).not.toContain('<svg')
  })
})

describe('StackedBarChart', () => {
  it('stacks series and shows the limit note', () => {
    const html = renderToStaticMarkup(
      createElement(StackedBarChart, {
        categories: MONTHS,
        series: [
          { id: 'mold', label: 'Moulding', slot: 1, values: [100, 120, 140, 90] },
          { id: 'paint', label: 'Paint', slot: 2, values: [40, 50, 30, 60] },
        ],
        limits: [200, 200, 200, 200],
        limitLabel: 'Capacity',
        format: hours,
      }),
    )
    expect(html).toContain('Capacity')
    expect(html).toContain('Moulding')
  })
})

describe('Meter', () => {
  it('names the escalation instead of relying on colour', () => {
    const html = renderToStaticMarkup(
      createElement(Meter, { label: 'Machine pool', ratio: 1.12, valueLabel: '112%' }),
    )
    expect(html).toContain('Over limit')
  })
})

describe('StatTile and HeroFigure', () => {
  it('renders a status word beside the status colour', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, {
        label: 'Overload hours',
        value: hours(1820),
        delta: { value: '12%', direction: 'down', goodDirection: 'down' },
        status: { level: 'warning', label: 'Three plants tight' },
        spark: [3, 5, 4, 8, 6, 9, 7, 11, 9, 12, 10, 14],
      }),
    )
    expect(html).toContain('Three plants tight')
  })

  it('renders the hero figure with its secondary numbers', () => {
    const html = renderToStaticMarkup(
      createElement(HeroFigure, {
        label: 'Network utilisation',
        value: pct(0.87),
        caption: 'Weighted across the filtered slice.',
        meter: { ratio: 0.87, valueLabel: pct(0.87), limitLabel: 'Ceiling 95%' },
        secondary: [{ label: 'Peak week', value: pct(1.21) }],
      }),
    )
    expect(html).toContain('Peak week')
    expect(html).toContain('Ceiling 95%')
  })
})

describe('Heatmap', () => {
  it('labels the three ends of the diverging scale', () => {
    const html = renderToStaticMarkup(
      createElement(Heatmap, {
        rows: [
          { id: 'p1', label: 'Monterrey', slot: 1 },
          { id: 'p2', label: 'Poznan', slot: 2 },
        ],
        columns: MONTHS.map((month) => ({ id: month, label: month })),
        cells: [
          { row: 'p1', column: '2026-01', value: 0.2 },
          { row: 'p2', column: '2026-02', value: -0.3 },
        ],
        domain: 0.5,
        format: (value) => pct(value),
      }),
    )
    expect(html).toContain('Balanced')
    expect(html).toContain('Over ceiling')
  })

  it('renders an empty state with no rows', () => {
    const html = renderToStaticMarkup(
      createElement(Heatmap, {
        rows: [],
        columns: [],
        cells: [],
        domain: 1,
        format: (value) => String(value),
      }),
    )
    expect(html).toContain('No cells in this slice')
  })
})

describe('WaterfallChart', () => {
  it('carries a glyph and a signed value on every delta', () => {
    const html = renderToStaticMarkup(
      createElement(WaterfallChart, {
        steps: [
          { id: 'base', label: 'Baseline', value: 1_000_000, anchor: true },
          { id: 'move', label: 'Move MOLD-3', value: -120_000 },
          { id: 'capex', label: 'Retrofit', value: 60_000 },
          { id: 'end', label: 'Scenario', value: 940_000, anchor: true },
        ],
        format: (value) => usd(value, { compact: true }),
      }),
    )
    expect(html).toContain('▼')
    expect(html).toContain('▲')
  })
})

describe('FlowMatrix', () => {
  it('keeps totals in the margin and shows the magnitude scale', () => {
    const html = renderToStaticMarkup(
      createElement(FlowMatrix, {
        origins: [
          { id: 'p1', label: 'Monterrey', slot: 1 },
          { id: 'p2', label: 'Poznan', slot: 2 },
        ],
        destinations: [
          { id: 'NAM', label: 'NAM' },
          { id: 'EUR', label: 'EUR' },
        ],
        flows: [
          { originId: 'p1', destinationId: 'NAM', units: 82_000, costPerUnit: 3.1 },
          { originId: 'p2', destinationId: 'EUR', units: 46_000, costPerUnit: 2.4 },
        ],
        format: (value) => units(value, { compact: true }),
      }),
    )
    expect(html).toContain('Units shipped')
    expect(html).toContain('Total')
  })
})

describe('GlideCurve', () => {
  const weeks = Array.from({ length: 12 }, (_, index) => `2026-W${String(index + 1).padStart(2, '0')}`)
  const ramp = { fromWeek: 2, toWeek: 9, label: 'Improvement programme' }

  it('exposes the end handle as a slider when it is editable', () => {
    const html = renderToStaticMarkup(
      createElement(GlideCurve, {
        weeks,
        ramp,
        series: [
          {
            id: 'after',
            label: 'Proposed',
            slot: 2,
            values: weeks.map((_, index) => 0.62 + index * 0.01),
          },
        ],
        endValue: 0.73,
        onEndValueChange: () => undefined,
      }),
    )
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-valuenow="0.73"')
    expect(html).toContain('Improvement programme')
  })

  it('requires a legend for a before/after pair', () => {
    const html = renderToStaticMarkup(
      createElement(GlideCurve, {
        weeks,
        ramp,
        series: [
          { id: 'before', label: 'Today', slot: 1, values: weeks.map(() => 0.62) },
          {
            id: 'after',
            label: 'Proposed',
            slot: 2,
            values: weeks.map((_, index) => 0.62 + index * 0.012),
          },
        ],
      }),
    )
    expect(html).toContain('Today')
    expect(html).toContain('Proposed')
  })

  it('renders an empty state with no series', () => {
    const html = renderToStaticMarkup(createElement(GlideCurve, { weeks, series: [] }))
    expect(html).toContain('No OEE history in this slice')
  })
})

describe('UtilisationGrid', () => {
  const WEEK_COUNT = 20
  const ROW_COUNT = 12

  function gridProps(overrides: Partial<UtilisationGridProps> = {}): UtilisationGridProps {
    const cells = ROW_COUNT * WEEK_COUNT
    const utilisation = new Float64Array(cells)
    const machine = new Float64Array(cells)
    const labour = new Float64Array(cells)
    const available = new Float64Array(cells)
    const required = new Float64Array(cells)
    const binding = new Uint8Array(cells)
    const downtime = new Float64Array(cells)
    for (let row = 0; row < ROW_COUNT; row += 1) {
      for (let week = 0; week < WEEK_COUNT; week += 1) {
        const offset = row * WEEK_COUNT + week
        const value = 0.5 + ((row * 7 + week * 3) % 90) / 100
        utilisation[offset] = value
        machine[offset] = value
        labour[offset] = value * 0.8
        available[offset] = 120
        required[offset] = 120 * value
        binding[offset] = week % 3 === 0 ? 1 : 0
        downtime[offset] = week === 5 ? 40 : 0
      }
    }
    return {
      rows: Array.from({ length: ROW_COUNT }, (_, index) => ({
        id: `wc-${index}`,
        code: `WC-${String(index).padStart(3, '0')}`,
        name: `Work center ${index}`,
        plantId: `plant-${index % 3}`,
        plantLabel: `Plant ${index % 3}`,
        plantSlot: ((index % 3) + 1) as 1 | 2 | 3,
        machineClass: 'Injection G4',
        peakUtilisation: 0.8 + (index % 5) / 10,
      })),
      weeks: Array.from({ length: WEEK_COUNT }, (_, index) => `2026-W${String(index + 1).padStart(2, '0')}`),
      utilisation,
      machineUtilisation: machine,
      labourUtilisation: labour,
      availableHours: available,
      requiredHours: required,
      bindingPool: binding,
      downtimeHours: downtime,
      ...overrides,
    }
  }

  it('renders the sticky column, the sort control and both glyph keys', () => {
    const html = renderToStaticMarkup(createElement(UtilisationGrid, gridProps()))
    expect(html).toContain('WC-000')
    expect(html).toContain('Injection G4')
    expect(html).toContain('Peak utilisation')
    expect(html).toContain('Over its ceiling')
    expect(html).toContain('Planned downtime')
    expect(html).toContain('<canvas')
  })

  it('labels the diverging scale against the ceiling', () => {
    const html = renderToStaticMarkup(createElement(UtilisationGrid, gridProps({ domain: 0.5 })))
    expect(html).toContain('At ceiling')
    expect(html).toContain('Headroom')
  })

  it('renders an empty state with no work centers', () => {
    const html = renderToStaticMarkup(
      createElement(UtilisationGrid, gridProps({ rows: [], weeks: [] })),
    )
    expect(html).toContain('No work centers in this slice')
  })
})

function countOf(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
