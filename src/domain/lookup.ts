/**
 * Lookup and aggregation helpers.
 *
 * `noUncheckedIndexedAccess` is on, so every index into an array or record is
 * `T | undefined`. These helpers make that ergonomic without scattering
 * non-null assertions through the engine — `mustGet` fails loudly on a missing
 * key, which is what you want when master data and transactions disagree.
 */

export function mustGet<T>(map: ReadonlyMap<string, T>, key: string, what: string): T {
  const value = map.get(key)
  if (value === undefined) {
    throw new Error(`${what} not found: ${key}`)
  }
  return value
}

export function getOr<T>(map: ReadonlyMap<string, T>, key: string, fallback: T): T {
  const value = map.get(key)
  return value === undefined ? fallback : value
}

export function at<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index]
  if (value === undefined) {
    throw new Error(`${what} index out of range: ${index}`)
  }
  return value
}

export function indexBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) map.set(key(item), item)
  return map
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = map.get(k)
    if (bucket) bucket.push(item)
    else map.set(k, [item])
  }
  return map
}

export function sumBy<T>(items: readonly T[], value: (item: T) => number): number {
  let total = 0
  for (const item of items) total += value(item)
  return total
}

/** Accumulate into a numeric map without the `?? 0` dance at every call site. */
export function addTo(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount)
}

export function readNum(map: ReadonlyMap<string, number>, key: string): number {
  return map.get(key) ?? 0
}

/** Composite key helper. `|` is not legal in any id in this dataset. */
export function key(...parts: (string | number)[]): string {
  return parts.join('|')
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Guards the many `a / b` ratios in the KPI layer against a zero denominator. */
export function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  return denominator === 0 ? fallback : numerator / denominator
}

/** Round to `dp` decimals — keeps engine output stable for snapshot tests. */
export function round(value: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(value * f) / f
}
