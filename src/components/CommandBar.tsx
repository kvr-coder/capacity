/**
 * The command palette.
 *
 * A tool this dense is used by the same six people every day, and after a week
 * those people know exactly where they want to be. Cmd/Ctrl-K is how they get
 * there without traversing a rail, a tab strip and a table: type three letters
 * of a work center's code and press Enter.
 *
 * It is not only navigation. The four moves a planner reaches for most — add a
 * shift, cap utilisation, start an OEE glide, switch scenario — are here too,
 * because the fastest way to test an idea should not require finding the screen
 * that owns it first. Moves applied from here apply immediately, like every
 * other move in this product, and undo takes them back.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { Move, WorkCenter } from '@/domain/types'
import { clamp } from '@/domain/lookup'
import { pct } from '@/lib/format'
import { Icon } from '@/components/ui'
import type { IconName } from '@/components/ui'
import { nextLocalId, useUiStore } from '@/state/store'
import styles from '@/components/CommandBar.module.css'

// ---------------------------------------------------------------------------
// Opening it from elsewhere
// ---------------------------------------------------------------------------

type Listener = () => void
const openListeners = new Set<Listener>()

/** Called by the header's search affordance. The shortcut is wired internally. */
export function openCommandBar(): void {
  for (const listener of openListeners) listener()
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

/**
 * Subsequence match with a score, not a substring test.
 *
 * "pw2" should find `PAINT-WRO-2`, which no `includes` will do. Consecutive
 * characters and word starts are worth more, and an earlier first match wins
 * ties — the same ranking every editor's file finder uses, because it is the
 * one people have already learned.
 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  if (needle === '') return 0
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  let score = 0
  let hIndex = 0
  let previousMatch = -2
  for (let i = 0; i < n.length; i += 1) {
    const char = n[i]
    if (char === undefined) continue
    if (char === ' ') continue
    const found = h.indexOf(char, hIndex)
    if (found === -1) return null
    score += 10
    if (found === previousMatch + 1) score += 8
    const before = found === 0 ? ' ' : (h[found - 1] ?? ' ')
    if (before === ' ' || before === '-' || before === '·' || before === '/') score += 6
    score -= Math.min(found - hIndex, 6)
    previousMatch = found
    hIndex = found + 1
  }
  return score
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Command {
  id: string
  title: string
  subtitle?: string
  group: string
  icon: IconName
  /** Extra text the fuzzy matcher sees but the row does not show. */
  keywords?: string
  slot?: 1 | 2 | 3 | 4 | 5
  run: () => void
}

const SCREENS: Array<{ path: string; title: string; icon: IconName; keywords: string }> = [
  { path: '/', title: 'Cockpit', icon: 'cockpit', keywords: 'home overview kpi gap utilisation' },
  { path: '/network', title: 'Network map', icon: 'globe', keywords: 'globe plants drag flow' },
  { path: '/workcenters', title: 'Work centers', icon: 'machine', keywords: 'register machines detail' },
  { path: '/products', title: 'Products', icon: 'product', keywords: 'sku material family group' },
  { path: '/scenarios', title: 'Scenarios', icon: 'scenario', keywords: 'moves compare decision log' },
  { path: '/data', title: 'Data', icon: 'data', keywords: 'master data sap import export csv' },
]

export function CommandBar() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const navigate = useNavigate()

  const catalog = useUiStore((state) => state.catalog)
  const scenarios = useUiStore((state) => state.scenarios)
  const activeScenarioId = useUiStore((state) => state.activeScenarioId)
  const filters = useUiStore((state) => state.filters)
  const theme = useUiStore((state) => state.theme)
  const undoLabel = useUiStore((state) => state.undoLabel)
  const redoLabel = useUiStore((state) => state.redoLabel)

  // --- opening ------------------------------------------------------------

  useEffect(() => {
    const listener: Listener = () => setOpen(true)
    openListeners.add(listener)
    return () => {
      openListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((prior) => !prior)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActive(0)
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      if (opener !== null && document.contains(opener)) opener.focus()
    }
  }, [open])

  // --- the catalogue of things you can do ---------------------------------

  const commands = useMemo<Command[]>(() => {
    const store = useUiStore.getState()
    const list: Command[] = []

    for (const screen of SCREENS) {
      list.push({
        id: `go:${screen.path}`,
        title: screen.title,
        group: 'Go to',
        icon: screen.icon,
        keywords: screen.keywords,
        run: () => navigate(screen.path),
      })
    }

    for (const plant of catalog?.plants ?? []) {
      list.push({
        id: `plant:${plant.id}`,
        title: `${plant.code} · ${plant.city}`,
        subtitle: `${plant.country} · ${plant.region}`,
        group: 'Plants',
        icon: 'globe',
        slot: plant.colorSlot,
        keywords: `${plant.name} ${plant.country} ${plant.region}`,
        run: () => {
          store.setSelection({ plantId: plant.id, workCenterId: undefined })
          store.setZoom('plant')
          navigate('/network')
        },
      })
    }

    const plantOf = new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant]))
    const shiftsOf = (wc: WorkCenter): number =>
      wc.pools.find((pool) => pool.pool === 'machine')?.shiftsPerDay ?? 2

    for (const wc of catalog?.workCenters ?? []) {
      const plant = plantOf.get(wc.plantId)
      const where = plant === undefined ? wc.plantId : plant.city
      list.push({
        id: `wc:${wc.id}`,
        title: `${wc.code} — ${wc.name}`,
        subtitle: where,
        group: 'Work centers',
        icon: 'machine',
        slot: plant?.colorSlot,
        keywords: `${wc.id} ${where}`,
        run: () => {
          store.setSelection({ workCenterId: wc.id, plantId: wc.plantId })
          store.setZoom('workCenter')
          navigate('/workcenters')
        },
      })

      const apply = (move: Move): void => {
        store.applyMove(move)
      }

      list.push({
        id: `shift:${wc.id}`,
        title: `Add a shift at ${wc.code}`,
        subtitle: `${where} · machine pool, ${shiftsOf(wc)} → ${shiftsOf(wc) + 1} shifts/day`,
        group: 'Quick moves',
        icon: 'plus',
        keywords: `shift capacity hours ${wc.name} ${where}`,
        run: () =>
          apply({
            kind: 'shiftChange',
            workCenterId: wc.id,
            pool: 'machine',
            fromWeek: filters.fromWeek,
            toWeek: filters.toWeek,
            shiftsPerDay: shiftsOf(wc) + 1,
          }),
      })

      list.push({
        id: `ceiling:${wc.id}`,
        title: `Cap ${wc.code} at ${pct(0.9, 0)} utilisation`,
        subtitle: `${where} · load above the ceiling reads as overload`,
        group: 'Quick moves',
        icon: 'sliders',
        keywords: `ceiling policy utilisation limit ${wc.name}`,
        run: () =>
          apply({
            kind: 'utilisationCeiling',
            scope: 'workCenter',
            workCenterId: wc.id,
            ceiling: 0.9,
          }),
      })

      list.push({
        id: `glide:${wc.id}`,
        title: `Start an OEE glide at ${wc.code}`,
        subtitle: `${where} · ${pct(wc.baseOee)} → ${pct(Math.min(0.95, wc.baseOee + 0.05))} on an S-curve`,
        group: 'Quick moves',
        icon: 'zap',
        keywords: `oee ramp improvement glide ${wc.name}`,
        run: () =>
          apply({
            kind: 'oeeGlide',
            path: {
              id: nextLocalId('glide'),
              scope: 'workCenter',
              workCenterId: wc.id,
              fromWeek: filters.fromWeek,
              toWeek: filters.toWeek,
              endValue: Math.min(0.95, wc.baseOee + 0.05),
              curve: 'sCurve',
              label: `${wc.code} improvement programme`,
            },
          }),
      })
    }

    for (const scenario of scenarios) {
      if (scenario.id === activeScenarioId) continue
      list.push({
        id: `scenario:${scenario.id}`,
        title: `Switch to ${scenario.name}`,
        subtitle:
          scenario.moves.length === 0
            ? 'No moves'
            : `${scenario.moves.length} move${scenario.moves.length === 1 ? '' : 's'}`,
        group: 'Scenarios',
        icon: 'scenario',
        slot: scenario.colorSlot,
        run: () => store.setActiveScenario(scenario.id),
      })
    }

    list.push(
      {
        id: 'action:undo',
        title: 'Undo',
        subtitle: undoLabel ?? 'Nothing to undo',
        group: 'Actions',
        icon: 'undo',
        run: () => store.undo(),
      },
      {
        id: 'action:redo',
        title: 'Redo',
        subtitle: redoLabel ?? 'Nothing to redo',
        group: 'Actions',
        icon: 'redo',
        run: () => store.redo(),
      },
      {
        id: 'action:theme',
        title: `Switch theme (now: ${theme})`,
        group: 'Actions',
        icon: theme === 'dark' ? 'sun' : 'moon',
        keywords: 'dark light system colour color',
        run: () => store.setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'),
      },
      {
        id: 'action:resetFilters',
        title: 'Reset every filter',
        subtitle: 'Back to the whole network over the whole horizon',
        group: 'Actions',
        icon: 'reset',
        run: () => store.resetFilters(),
      },
      {
        id: 'action:newScenario',
        title: 'New scenario from the current one',
        group: 'Actions',
        icon: 'copy',
        keywords: 'clone fork branch',
        run: () => {
          store.createScenario('', 'Cloned from the command palette.', activeScenarioId)
          navigate('/scenarios')
        },
      },
    )

    return list
  }, [catalog, scenarios, activeScenarioId, filters, theme, undoLabel, redoLabel, navigate])

  const results = useMemo(() => {
    const needle = query.trim()
    if (needle === '') {
      // With no query, show the destinations and the actions — never 600 rows.
      return commands.filter(
        (command) =>
          command.group === 'Go to' || command.group === 'Actions' || command.group === 'Scenarios',
      )
    }
    const scored: Array<{ command: Command; score: number }> = []
    for (const command of commands) {
      const hay = `${command.title} ${command.subtitle ?? ''} ${command.keywords ?? ''}`
      const score = fuzzyScore(needle, hay)
      if (score === null) continue
      const titleScore = fuzzyScore(needle, command.title)
      scored.push({ command, score: score + (titleScore ?? 0) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 40).map((entry) => entry.command)
  }, [commands, query])

  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>()
    for (const command of results) {
      const bucket = map.get(command.group)
      if (bucket === undefined) map.set(command.group, [command])
      else bucket.push(command)
    }
    return [...map.entries()]
  }, [results])

  const clampedActive = clamp(active, 0, Math.max(0, results.length - 1))

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [clampedActive, results.length])

  if (!open || typeof document === 'undefined') return null

  const runAt = (index: number): void => {
    const command = results[index]
    if (command === undefined) return
    setOpen(false)
    command.run()
  }

  return createPortal(
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={styles.palette}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((prior) => (results.length === 0 ? 0 : (prior + 1) % results.length))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((prior) =>
              results.length === 0 ? 0 : (prior - 1 + results.length) % results.length,
            )
          } else if (event.key === 'Enter') {
            event.preventDefault()
            runAt(clampedActive)
          }
        }}
      >
        <div className={styles.head}>
          <Icon name="search" size={16} className={styles.headIcon} />
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder="Jump to a screen, a plant, a work center — or apply a move"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={
              results.length === 0 ? undefined : `command-${clampedActive}`
            }
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>

        <ul className={styles.results} id="command-results" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <li className={styles.empty}>Nothing matches “{query}”</li>
          ) : null}
          {grouped.map(([group, items]) => (
            <li key={group}>
              <p className={styles.groupLabel}>{group}</p>
              <ul>
                {items.map((command) => {
                  const index = results.indexOf(command)
                  const isActive = index === clampedActive
                  return (
                    <li key={command.id}>
                      <button
                        type="button"
                        id={`command-${index}`}
                        role="option"
                        aria-selected={isActive}
                        data-active={isActive ? 'true' : 'false'}
                        className={[styles.row, isActive ? styles.rowActive : '']
                          .filter(Boolean)
                          .join(' ')}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => runAt(index)}
                      >
                        <Icon name={command.icon} size={15} className={styles.rowIcon} />
                        {command.slot !== undefined ? (
                          <span
                            className={[styles.dot, styles[`slot${command.slot}`]]
                              .filter(Boolean)
                              .join(' ')}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span className={styles.rowText}>
                          <span className={styles.rowTitle}>{command.title}</span>
                          {command.subtitle !== undefined ? (
                            <span className={styles.rowSubtitle}>{command.subtitle}</span>
                          ) : null}
                        </span>
                        <span className={styles.rowGroup}>{command.group}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>

        <div className={styles.foot}>
          <span>
            <kbd className={styles.kbd}>↑</kbd>
            <kbd className={styles.kbd}>↓</kbd> to move
          </span>
          <span>
            <kbd className={styles.kbd}>↵</kbd> to run
          </span>
          <span className={styles.footNote}>
            {results.length === 0
              ? 'No matches'
              : `${results.length} of ${commands.length} commands`}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Exported for the header hint, so the shortcut is written once. */
export function commandShortcutLabel(): string {
  const mac =
    typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent)
  return mac ? '⌘K' : 'Ctrl K'
}

/** Kept so a screen can render the same keyboard chip the palette footer uses. */
export function Kbd({ children }: { children: string }) {
  return <kbd className={styles.kbd}>{children}</kbd>
}
