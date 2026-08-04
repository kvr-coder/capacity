/**
 * Display formatting.
 *
 * Two rules from the dataviz spec live here: large standalone figures use the
 * font's proportional digits (never `tabular-nums`), and axis ticks round to
 * clean numbers. Callers get compact forms for tiles and axes, and full forms
 * for tables and tooltips.
 */

const COMPACT_UNITS: Array<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 1e12, divisor: 1e12, suffix: 'T' },
  { limit: 1e9, divisor: 1e9, suffix: 'B' },
  { limit: 1e6, divisor: 1e6, suffix: 'M' },
  { limit: 1e3, divisor: 1e3, suffix: 'K' },
]

/** 1284 -> "1.3K", 4_200_000 -> "4.2M". Sign preserved. */
export function compact(value: number, dp = 1): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  for (const unit of COMPACT_UNITS) {
    if (abs >= unit.limit) {
      const scaled = value / unit.divisor
      // Drop the decimal once the mantissa is big enough to not need it.
      const digits = Math.abs(scaled) >= 100 ? 0 : dp
      return `${trimZero(scaled.toFixed(digits))}${unit.suffix}`
    }
  }
  return abs >= 10 ? Math.round(value).toLocaleString('en-US') : trimZero(value.toFixed(dp))
}

function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

export function usd(value: number, opts: { compact?: boolean; dp?: number } = {}): string {
  if (!Number.isFinite(value)) return '—'
  if (opts.compact) {
    const sign = value < 0 ? '-' : ''
    return `${sign}$${compact(Math.abs(value))}`
  }
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.dp ?? 0,
    minimumFractionDigits: opts.dp ?? 0,
  })
}

export function units(value: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '—'
  return opts.compact ? compact(value) : Math.round(value).toLocaleString('en-US')
}

export function hours(value: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '—'
  return opts.compact ? `${compact(value)} h` : `${Math.round(value).toLocaleString('en-US')} h`
}

/** 0.847 -> "84.7%". */
export function pct(value: number, dp = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(dp)}%`
}

/** Signed percentage-point delta, for scenario comparisons. */
export function signedPct(value: number, dp = 1): string {
  if (!Number.isFinite(value)) return '—'
  const s = (value * 100).toFixed(dp)
  return value > 0 ? `+${s}%` : `${s}%`
}

export function signed(value: number, fmt: (n: number) => string): string {
  if (!Number.isFinite(value)) return '—'
  return value > 0 ? `+${fmt(value)}` : fmt(value)
}

export function co2(value: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1000) return `${compact(value / 1000)} t`
  return opts.compact ? `${compact(value)} kg` : `${Math.round(value).toLocaleString('en-US')} kg`
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** "2027-03" -> "Mar 27". Short form for dense axes. */
export function monthShort(month: string): string {
  const [y, m] = month.split('-')
  const idx = Number(m) - 1
  const name = MONTH_NAMES[idx]
  if (!y || name === undefined) return month
  return `${name} ${y.slice(2)}`
}

/** "2027-03" -> "March 2027". Full form for tooltips and headings. */
export function monthLong(month: string): string {
  const [y, m] = month.split('-')
  const idx = Number(m) - 1
  const name = MONTH_NAMES[idx]
  if (!y || name === undefined) return month
  const full = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ][idx]
  return `${full} ${y}`
}

/** "2027-03" -> "Q1 27". Used by the quarter roll-up toggle. */
export function quarterLabel(month: string): string {
  const [y, m] = month.split('-')
  if (!y || !m) return month
  return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y.slice(2)}`
}

/**
 * Clean axis ticks: pick a 1/2/5 x 10^n step so labels land on round numbers.
 * Returns ascending tick values covering [0, max].
 */
export function niceTicks(max: number, target = 5): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const rawStep = max / target
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalised = rawStep / magnitude
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude
  const ticks: number[] = []
  for (let t = 0; t <= max + step * 0.5; t += step) ticks.push(Number(t.toPrecision(12)))
  return ticks
}

/** Ceiling of `max` onto the next nice tick, so the top gridline is round. */
export function niceMax(max: number, target = 5): number {
  const ticks = niceTicks(max, target)
  return ticks.length > 0 ? (ticks[ticks.length - 1] ?? max) : max
}
