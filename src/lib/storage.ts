/**
 * Session persistence.
 *
 * Three things survive a reload: the scenarios a planner has built (which are
 * only lists of moves — small, and the only thing they cannot regenerate), the
 * filters they were looking through, and their theme. **Model results are never
 * persisted.** They are derived, they are large, and a stale one restored under
 * a changed dataset would be a lie told confidently.
 *
 * Everything here is defensive to the point of paranoia. A corrupt or
 * half-written entry in `localStorage` — a quota failure mid-write, a private
 * window, an older build's shape, a user who pasted something into devtools —
 * must degrade to "start fresh", never to a white screen. Every read is
 * validated field by field rather than trusted because it parsed.
 */

import type { Filters, MoveId, Scenario, ScenarioId, ScenarioMove } from '@/domain/types'

/** Bumping this discards older sessions rather than trying to migrate them. */
export const STORAGE_VERSION = 2
export const STORAGE_KEY = 'capacity-cockpit/v2'

export type ThemePreference = 'light' | 'dark' | 'system'

export interface PersistedSession {
  version: number
  scenarios: Scenario[]
  activeScenarioId: ScenarioId
  filters: Filters
  theme: ThemePreference
  /** Highest move sequence issued, so ids stay monotonic across reloads. */
  seq: number
}

// ---------------------------------------------------------------------------
// Storage access
// ---------------------------------------------------------------------------

/**
 * `localStorage` throws on *access* — not merely on write — in a few real
 * browser configurations (Safari private mode historically, and any page with
 * third-party storage blocked). The probe is cached because that throw is not
 * cheap and the answer never changes within a session.
 */
let storageProbe: Storage | null | undefined

function storage(): Storage | null {
  if (storageProbe !== undefined) return storageProbe
  let resolved: Storage | null = null
  try {
    if (typeof localStorage !== 'undefined') {
      const probeKey = `${STORAGE_KEY}/probe`
      localStorage.setItem(probeKey, '1')
      localStorage.removeItem(probeKey)
      resolved = localStorage
    }
  } catch {
    resolved = null
  }
  storageProbe = resolved
  return resolved
}

/** True when the session will actually outlive the tab. The UI may say so. */
export function isStorageAvailable(): boolean {
  return storage() !== null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) if (typeof item === 'string') out.push(item)
  return out
}

function colorSlot(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = num(value, 1)
  return n === 2 || n === 3 || n === 4 || n === 5 ? n : 1
}

/**
 * A `Move` is a discriminated union with a dozen shapes. Re-validating every
 * field of every variant here would duplicate the domain contract in a second
 * place that could drift from it; instead the only structural requirement is a
 * string `kind`, and the engine — which already rejects moves it cannot apply
 * with a named warning rather than an exception — is left to judge the rest.
 */
function readMove(value: unknown): ScenarioMove | null {
  if (!isRecord(value)) return null
  const move = value['move']
  if (!isRecord(move) || typeof move['kind'] !== 'string') return null
  const id = value['id']
  if (typeof id !== 'string' || id.length === 0) return null
  return {
    id: id as MoveId,
    label: str(value['label'], 'Move'),
    enabled: bool(value['enabled'], true),
    seq: num(value['seq'], 0),
    // Checked as far as a serialised union usefully can be; see above.
    move: move as unknown as ScenarioMove['move'],
  }
}

function readScenario(value: unknown): Scenario | null {
  if (!isRecord(value)) return null
  const id = value['id']
  if (typeof id !== 'string' || id.length === 0) return null
  const rawMoves = value['moves']
  const moves: ScenarioMove[] = []
  if (Array.isArray(rawMoves)) {
    for (const raw of rawMoves) {
      const move = readMove(raw)
      if (move !== null) moves.push(move)
    }
  }
  return {
    id,
    name: str(value['name'], 'Scenario'),
    description: str(value['description'], ''),
    moves,
    colorSlot: colorSlot(value['colorSlot']),
    readonly: bool(value['readonly'], false),
  }
}

function readBucket(value: unknown): Filters['bucket'] {
  return value === 'month' || value === 'quarter' ? value : 'week'
}

function readRegions(value: unknown): Filters['regions'] {
  const allowed = new Set(['NAM', 'EUR', 'APAC', 'LATAM', 'MEA'])
  const out: Filters['regions'] = []
  for (const item of stringList(value)) {
    if (allowed.has(item)) out.push(item as Filters['regions'][number])
  }
  return out
}

function readFilters(value: unknown, fallback: Filters): Filters {
  if (!isRecord(value)) return fallback
  const from = Math.max(0, Math.round(num(value['fromWeek'], fallback.fromWeek)))
  const to = Math.max(from, Math.round(num(value['toWeek'], fallback.toWeek)))
  return {
    plantIds: stringList(value['plantIds']),
    regions: readRegions(value['regions']),
    familyIds: stringList(value['familyIds']),
    groupIds: stringList(value['groupIds']),
    workCenterIds: stringList(value['workCenterIds']),
    machineClassIds: stringList(value['machineClassIds']),
    fromWeek: from,
    toWeek: to,
    bucket: readBucket(value['bucket']),
  }
}

function readTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * The persisted session, or `null` when there is nothing usable to restore.
 * A version mismatch, a parse failure and a structurally wrong payload are all
 * the same answer: start fresh.
 */
export function loadSession(fallbackFilters: Filters): PersistedSession | null {
  const store = storage()
  if (store === null) return null
  let raw: string | null = null
  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null || raw === '') return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (num(parsed['version'], -1) !== STORAGE_VERSION) return null

    const rawScenarios = parsed['scenarios']
    const scenarios: Scenario[] = []
    if (Array.isArray(rawScenarios)) {
      for (const item of rawScenarios) {
        const scenario = readScenario(item)
        if (scenario !== null) scenarios.push(scenario)
      }
    }

    const filters = readFilters(parsed['filters'], fallbackFilters)
    const activeScenarioId = str(parsed['activeScenarioId'], '')

    let seq = num(parsed['seq'], 0)
    for (const scenario of scenarios) {
      for (const move of scenario.moves) seq = Math.max(seq, move.seq)
    }

    return {
      version: STORAGE_VERSION,
      scenarios,
      activeScenarioId,
      filters,
      theme: readTheme(parsed['theme']),
      seq,
    }
  } catch {
    // Corrupt entry. Drop it so the next write starts from something valid,
    // and never let a bad string take the app down with it.
    try {
      store.removeItem(STORAGE_KEY)
    } catch {
      /* nothing else to try */
    }
    return null
  }
}

/**
 * Write the session. Silently gives up on quota errors: losing the ability to
 * restore a session is an inconvenience, and throwing out of a state mutation
 * to announce it would be a crash.
 */
export function saveSession(session: PersistedSession): void {
  const store = storage()
  if (store === null) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ ...session, version: STORAGE_VERSION }))
  } catch {
    /* quota, private mode, or a disabled store — nothing worth interrupting for */
  }
}

/** Forget the session. The Data screen offers this as "reset this workspace". */
export function clearSession(): void {
  const store = storage()
  if (store === null) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    /* see saveSession */
  }
}
