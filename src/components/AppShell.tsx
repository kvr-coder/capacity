/**
 * The frame every screen sits in.
 *
 * A left rail for the six destinations, a header that carries the three things
 * a planner needs visible at all times — which scenario they are in, whether
 * they can take the last thing back, and what the model costs — and a main
 * region that is the only thing that scrolls.
 *
 * Two details that look decorative and are not:
 *
 * - **The runtime readout.** `ModelResult.runtimeMs` sits in the header because
 *   a performance regression that is merely felt gets argued about; one that is
 *   displayed gets fixed.
 * - **The plant clocks.** Five sites on four continents means "can we call
 *   Suzhou about this?" is a real question, and answering it should not require
 *   arithmetic. `Intl.DateTimeFormat` over the five IANA zones, ticking once a
 *   minute.
 *
 * The page body never scrolls horizontally. Wide content scrolls inside its own
 * container; the shell is a grid whose columns cannot be pushed apart.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import type { Plant } from '@/domain/types'
import { BASELINE_SCENARIO_ID } from '@/domain/engine'
import { useUiStore } from '@/state/store'
import { Badge, Icon, IconButton, Select, ToastProvider, Tooltip, useToast } from '@/components/ui'
import type { IconName } from '@/components/ui'
import { CommandBar, commandShortcutLabel, openCommandBar } from '@/components/CommandBar'
import { HelpMenu, openHelpMenu } from '@/components/HelpMenu'
import { ThemeToggle } from '@/components/ThemeToggle'
import styles from '@/components/AppShell.module.css'

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

interface Destination {
  to: string
  label: string
  icon: IconName
  /** One line of what the screen answers. Shown as the rail tooltip. */
  answers: string
}

const DESTINATIONS: Destination[] = [
  { to: '/', label: 'Cockpit', icon: 'cockpit', answers: 'Where does the network run out, and what is the plan gap?' },
  { to: '/network', label: 'Network map', icon: 'globe', answers: 'Globe to plant to work center, with capability links' },
  { to: '/workcenters', label: 'Work centers', icon: 'machine', answers: 'The register, and the build-up for one machine' },
  { to: '/products', label: 'Products', icon: 'product', answers: 'What the network is making, by family, group and SKU' },
  { to: '/scenarios', label: 'Scenarios', icon: 'scenario', answers: 'The decision log, and this plan against another' },
  { to: '/data', label: 'Data', icon: 'data', answers: 'Master data, and SAP import and export' },
]

// ---------------------------------------------------------------------------
// Plant clocks
// ---------------------------------------------------------------------------

function formatLocalTime(timezone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now)
  } catch {
    // An unknown IANA zone must not take the header down with it.
    return '--:--'
  }
}

/** True when the local hour is inside a plausible first/second shift window. */
function isWorkingHour(timezone: string, now: Date): boolean {
  const text = formatLocalTime(timezone, now)
  const hour = Number(text.slice(0, 2))
  return Number.isFinite(hour) && hour >= 6 && hour < 22
}

function PlantClocks({ plants }: { plants: Plant[] }) {
  const [now, setNow] = useState<Date>(() => new Date())

  useEffect(() => {
    // Align to the next minute boundary, then tick once a minute. A clock that
    // updates 40 seconds late is worse than one that updates on the minute.
    let interval: ReturnType<typeof setInterval> | null = null
    const align = setTimeout(
      () => {
        setNow(new Date())
        interval = setInterval(() => setNow(new Date()), 60_000)
      },
      (60 - new Date().getSeconds()) * 1000,
    )
    return () => {
      clearTimeout(align)
      if (interval !== null) clearInterval(interval)
    }
  }, [])

  if (plants.length === 0) return null

  return (
    <div className={styles.clocks} aria-label="Local time at each plant">
      {plants.map((plant) => (
        <Tooltip
          key={plant.id}
          placement="bottom"
          content={
            <>
              {plant.name} — {plant.city}, {plant.country}
              <br />
              {plant.timezone}
            </>
          }
        >
          <span className={styles.clock}>
            <span
              className={[styles.clockDot, styles[`slot${plant.colorSlot}`]]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            />
            <span className={styles.clockCode}>{plant.code}</span>
            <span
              className={[
                styles.clockTime,
                isWorkingHour(plant.timezone, now) ? '' : styles.clockOff,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {formatLocalTime(plant.timezone, now)}
            </span>
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toast bridge
// ---------------------------------------------------------------------------

/**
 * The store cannot render, so it queues notices; this drains the queue into the
 * toast layer. It renders nothing.
 */
function NoticeBridge() {
  const notices = useUiStore((state) => state.notices)
  const dismissNotice = useUiStore((state) => state.dismissNotice)
  const { toast } = useToast()
  const seen = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const notice of notices) {
      if (seen.current.has(notice.id)) continue
      seen.current.add(notice.id)
      toast(notice.message, { tone: notice.tone === 'info' ? 'info' : notice.tone })
      dismissNotice(notice.id)
    }
  }, [notices, toast, dismissNotice])

  return null
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ShellHeader() {
  const catalog = useUiStore((state) => state.catalog)
  const scenarios = useUiStore((state) => state.scenarios)
  const activeScenarioId = useUiStore((state) => state.activeScenarioId)
  const setActiveScenario = useUiStore((state) => state.setActiveScenario)
  const createScenario = useUiStore((state) => state.createScenario)
  const canUndo = useUiStore((state) => state.canUndo)
  const canRedo = useUiStore((state) => state.canRedo)
  const undoLabel = useUiStore((state) => state.undoLabel)
  const redoLabel = useUiStore((state) => state.redoLabel)
  const undo = useUiStore((state) => state.undo)
  const redo = useUiStore((state) => state.redo)
  const runtimeMs = useUiStore((state) => state.runtimeMs)

  const shortcut = useMemo(() => commandShortcutLabel(), [])
  const modifier = shortcut.startsWith('⌘') ? '⌘' : 'Ctrl '
  const active = scenarios.find((scenario) => scenario.id === activeScenarioId)
  const moveCount = active?.moves.filter((entry) => entry.enabled).length ?? 0

  return (
    <header className={styles.header} role="banner">
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.brandName}>Capacity Cockpit</span>
      </div>

      <div className={styles.scenarioCluster}>
        <span
          className={[
            styles.scenarioDot,
            styles[`slot${active?.colorSlot ?? 1}`] ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        />
        <Select
          label="Active scenario"
          hideLabel
          size="sm"
          value={activeScenarioId}
          className={styles.scenarioSelect}
          options={scenarios.map((scenario) => ({
            value: scenario.id,
            label:
              scenario.moves.length === 0
                ? scenario.name
                : `${scenario.name} · ${scenario.moves.length}`,
          }))}
          onChange={setActiveScenario}
        />
        <IconButton
          icon="plus"
          size="sm"
          label="New scenario from this one"
          hint="Clone the active scenario"
          onClick={() => createScenario('', 'Cloned from the header.', activeScenarioId)}
        />
        {activeScenarioId === BASELINE_SCENARIO_ID ? (
          <Badge tone="neutral" size="sm">
            Read-only
          </Badge>
        ) : (
          <Badge tone={moveCount === 0 ? 'neutral' : 'good'} size="sm">
            {moveCount} move{moveCount === 1 ? '' : 's'} on
          </Badge>
        )}
      </div>

      <div className={styles.historyCluster}>
        <IconButton
          icon="undo"
          size="sm"
          label="Undo"
          hint={canUndo ? `Undo ${undoLabel ?? ''} (${modifier}Z)` : `Nothing to undo (${modifier}Z)`}
          disabled={!canUndo}
          onClick={undo}
        />
        <IconButton
          icon="redo"
          size="sm"
          label="Redo"
          hint={canRedo ? `Redo ${redoLabel ?? ''} (${modifier}⇧Z)` : `Nothing to redo (${modifier}⇧Z)`}
          disabled={!canRedo}
          onClick={redo}
        />
      </div>

      <Tooltip
        placement="bottom"
        content="How long the last model run took, end to end in the worker. Kept on screen so a regression is visible rather than merely felt."
      >
        <span className={styles.runtime}>
          <Icon name="clock" size={13} />
          <span className={styles.runtimeValue}>
            {runtimeMs > 0 ? `${Math.round(runtimeMs)} ms` : '—'}
          </span>
        </span>
      </Tooltip>

      <PlantClocks plants={catalog?.plants ?? []} />

      <button type="button" className={styles.commandButton} onClick={openCommandBar}>
        <Icon name="search" size={13} />
        <span className={styles.commandText}>Search or jump</span>
        <kbd className={styles.kbd}>{shortcut}</kbd>
      </button>

      <Tooltip placement="bottom" content="Help & guide — what this tool is for, and how to use it">
        <IconButton icon="help" size="sm" label="Help & guide" onClick={() => openHelpMenu()} />
      </Tooltip>

      <ThemeToggle />
    </header>
  )
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

function ShellBody() {
  const undo = useUiStore((state) => state.undo)
  const redo = useUiStore((state) => state.redo)
  const error = useUiStore((state) => state.error)

  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key === 'y') {
        event.preventDefault()
        redo()
      }
    },
    [undo, redo],
  )

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main-content">
        Skip to the content
      </a>

      <ShellHeader />

      <div className={styles.body}>
        <nav className={styles.rail} aria-label="Screens">
          <ul>
            {DESTINATIONS.map((destination) => (
              <li key={destination.to}>
                <NavLink
                  to={destination.to}
                  end={destination.to === '/'}
                  title={`${destination.label} — ${destination.answers}`}
                  className={({ isActive }) =>
                    [styles.railLink, isActive ? styles.railLinkOn : ''].filter(Boolean).join(' ')
                  }
                >
                  <Icon name={destination.icon} size={17} />
                  <span className={styles.railLabel}>{destination.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className={styles.main} id="main-content" tabIndex={-1}>
          {error !== null ? (
            <div className={styles.banner} role="alert">
              <Icon name="critical" size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          <Suspense fallback={<ScreenFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <CommandBar />
      <HelpMenu />
      <NoticeBridge />
    </div>
  )
}

/**
 * Shown while a screen's chunk arrives. Deliberately quiet and deliberately
 * not a skeleton: the screens below are dense, and a fake outline of one is
 * more disorienting than a small honest label.
 */
function ScreenFallback() {
  return (
    <div className={styles.fallback} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <span>Opening the screen…</span>
    </div>
  )
}

export function AppShell() {
  return (
    <ToastProvider>
      <ShellBody />
    </ToastProvider>
  )
}
