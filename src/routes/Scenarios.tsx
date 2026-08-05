/**
 * Scenarios — the decision log, and the comparison it exists to justify.
 *
 * A scenario in this product is not a saved copy of the world. It is an ordered
 * list of named moves, and this screen is built around that fact: the middle of
 * the page is the list itself, written in plain English, in a form you could
 * print and hand to a colleague. Everything else on the screen exists to answer
 * "and what did that do?".
 *
 * Three things are worth knowing before changing anything here.
 *
 * 1. **This screen runs the model itself.** Every other screen asks about the
 *    active scenario through `useModelResult`, which supersedes by request type
 *    — exactly right for one hook firing repeatedly, and exactly wrong for a
 *    screen that needs *two* answers about *two* scenarios at once. So the runs
 *    here go through `EngineClient.request`, which never rejects a superseded
 *    answer, and they are issued strictly one at a time from a single sequence:
 *    active, then compare, then the other scenarios' KPIs for the rail, then
 *    the bridge. One request in flight, in a known order, is what keeps two
 *    scenarios' numbers from ever being one scenario's numbers twice.
 *
 * 2. **The bridge is computed, not estimated.** Attributing a change in
 *    required hours to a cause by inspecting two results is guesswork the
 *    moment two causes interact. Instead the bridge walks from the compare
 *    scenario's move list to the active one, one cause at a time, and asks the
 *    model what the total is after each step. The steps therefore tie out by
 *    construction — and because move *order* can matter, the difference between
 *    the last constructed step and the real active run is shown as an explicit
 *    residual rather than being quietly absorbed.
 *
 * 3. **Nothing SKU-sized reaches React.** The only dense structures built here
 *    are work-center x week — 150 x 78 at worst — as `Float64Array`s indexed
 *    `row * weekCount + week`, handed straight to the grid and never held in
 *    state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Filters,
  Kpis,
  ModelResult,
  Move,
  MoveId,
  Scenario,
  ScenarioId,
  ScenarioMove,
  WorkCenter,
} from '@/domain/types'
import { clamp, key as compositeKey, safeDiv } from '@/domain/lookup'
import { BASELINE_SCENARIO_ID } from '@/domain/engine'
import { describeMove } from '@/domain/moves'
import { co2, hours as formatHours, pct, signed, units as formatUnits, usd } from '@/lib/format'
import { download } from '@/lib/csv'
import { ChartCard, LineChart, StatTile, UtilisationGrid, WaterfallChart } from '@/charts'
import type {
  StatTileProps,
  TableViewProps,
  TimeSeries,
  UtilisationGridRow,
  UtilisationGridSort,
  WaterfallStep,
} from '@/charts/types'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  InfoTip,
  Modal,
  Pill,
  SectionHeading,
  Select,
  TextField,
  Toggle,
} from '@/components'
import type { DataTableColumn } from '@/components'
import { FilterBar } from '@/components/FilterBar'
import { filterFingerprint, scenarioFingerprint } from '@/state/model'
import { catalogIndexes, useUiStore } from '@/state/store'
import { getEngineClient } from '@/worker/client'
import { MoveEditor } from '@/routes/MoveEditor'
import styles from '@/routes/Scenarios.module.css'

// ---------------------------------------------------------------------------
// Typed-array reads under `noUncheckedIndexedAccess`
// ---------------------------------------------------------------------------

function f64(array: Float64Array, index: number): number {
  const value = array[index]
  return value === undefined ? 0 : value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Causes — the bridge's steps
// ---------------------------------------------------------------------------

type Cause = 'ceiling' | 'shift' | 'downtime' | 'oee' | 'rate' | 'load' | 'plan' | 'asset'

/**
 * The order the bridge walks. Capacity-side causes first, then the two knobs,
 * then what the plan asks for — reading left to right, the bridge tells the
 * story in the order a planner would tell it.
 */
const CAUSE_ORDER: readonly Cause[] = [
  'ceiling',
  'shift',
  'downtime',
  'oee',
  'rate',
  'load',
  'plan',
  'asset',
]

const CAUSE_LABEL: Record<Cause, string> = {
  ceiling: 'Ceiling change',
  shift: 'Shift change',
  downtime: 'Downtime change',
  oee: 'OEE change',
  rate: 'Rate change',
  load: 'Load moved',
  plan: 'Plan rescaled',
  asset: 'Assets added',
}

function causeOf(move: Move): Cause {
  switch (move.kind) {
    case 'utilisationCeiling':
      return 'ceiling'
    case 'shiftChange':
      return 'shift'
    case 'downtimeUpsert':
    case 'downtimeRemove':
      return 'downtime'
    case 'oeeSet':
    case 'oeeGlide':
      return 'oee'
    case 'rateSet':
      return 'rate'
    case 'resourceMove':
    case 'wipTransfer':
    case 'sourceSwitch':
      return 'load'
    case 'planScale':
      return 'plan'
    case 'retrofit':
    case 'addWorkCenter':
      return 'asset'
  }
}

/** Structural identity of a move — two moves that say the same thing are the same step. */
function moveKey(entry: ScenarioMove): string {
  return JSON.stringify(entry.move)
}

interface BridgeStage {
  cause: Cause
  scenario: Scenario
}

/**
 * The cumulative move lists that walk `base` to `target`, one cause at a time.
 *
 * After the last stage the move set is exactly `target`'s enabled set, so the
 * steps sum to the true difference. What can still differ is *order*: moves are
 * applied in `seq` order and a later move of the same kind overwrites an earlier
 * one, so a reconstructed list is not always byte-identical in effect to the
 * real scenario. That gap is the residual step, and it is shown rather than
 * hidden.
 */
function bridgeStages(base: Scenario, target: Scenario): BridgeStage[] {
  const baseMoves = base.moves.filter((entry) => entry.enabled)
  const targetMoves = target.moves.filter((entry) => entry.enabled)
  const baseKeys = new Set(baseMoves.map(moveKey))
  const targetKeys = new Set(targetMoves.map(moveKey))

  const removalsByCause = new Map<Cause, Set<string>>()
  const additionsByCause = new Map<Cause, ScenarioMove[]>()

  for (const entry of baseMoves) {
    const k = moveKey(entry)
    if (targetKeys.has(k)) continue
    const cause = causeOf(entry.move)
    const bucket = removalsByCause.get(cause)
    if (bucket === undefined) removalsByCause.set(cause, new Set([k]))
    else bucket.add(k)
  }
  for (const entry of targetMoves) {
    if (baseKeys.has(moveKey(entry))) continue
    const cause = causeOf(entry.move)
    const bucket = additionsByCause.get(cause)
    if (bucket === undefined) additionsByCause.set(cause, [entry])
    else bucket.push(entry)
  }

  const stages: BridgeStage[] = []
  let current = baseMoves
  let index = 0
  for (const cause of CAUSE_ORDER) {
    const removals = removalsByCause.get(cause)
    const additions = additionsByCause.get(cause) ?? []
    if (removals === undefined && additions.length === 0) continue
    const kept = removals === undefined ? current : current.filter((e) => !removals.has(moveKey(e)))
    current = [...kept, ...additions].sort((a, b) => a.seq - b.seq)
    index += 1
    stages.push({
      cause,
      scenario: {
        id: `bridge-${target.id}-${index}`,
        name: `Bridge stage ${index}`,
        description: '',
        moves: current,
        colorSlot: target.colorSlot,
      },
    })
  }
  return stages
}

// ---------------------------------------------------------------------------
// KPI cache — Kpis are a few dozen numbers, so these are free to keep
// ---------------------------------------------------------------------------

const kpisCache = new Map<string, Kpis>()
const KPIS_CACHE_LIMIT = 96

function rememberKpis(cacheKey: string, kpis: Kpis): void {
  kpisCache.set(cacheKey, kpis)
  while (kpisCache.size > KPIS_CACHE_LIMIT) {
    const oldest = kpisCache.keys().next()
    if (oldest.done === true) break
    kpisCache.delete(oldest.value)
  }
}

// ---------------------------------------------------------------------------
// The lab — one sequence, one request in flight
// ---------------------------------------------------------------------------

interface LabState {
  active: ModelResult | null
  compare: ModelResult | null
  /** Scenario id -> KPIs, for the rail. Filled progressively. */
  railKpis: Record<ScenarioId, Kpis>
  bridge: WaterfallStep[] | null
  /** What the sequence is doing right now, for the "still working" line. */
  phase: string | null
  error: string | null
}

const EMPTY_LAB: LabState = {
  active: null,
  compare: null,
  railKpis: {},
  bridge: null,
  phase: 'Running the active scenario',
  error: null,
}

/** Long enough to swallow a burst of toggles, short enough to feel immediate. */
const SEQUENCE_DEBOUNCE_MS = 160

/**
 * Runs everything this screen needs, in order, holding the previous answers on
 * screen throughout. The sequence is deliberately serial: two scenarios' worth
 * of numbers rendered side by side must never be two renders of the same run.
 */
function useScenarioLab(
  active: Scenario,
  compare: Scenario | null,
  others: Scenario[],
  filters: Filters,
): LabState & { loading: boolean } {
  const ready = useUiStore((state) => state.status === 'ready')
  const [state, setState] = useState<LabState>(EMPTY_LAB)
  const [loading, setLoading] = useState(true)

  const filterKey = filterFingerprint(filters)
  const key = ready
    ? [
        scenarioFingerprint(active),
        compare === null ? '' : scenarioFingerprint(compare),
        others.map((s) => scenarioFingerprint(s)).join('~'),
        filterKey,
      ].join('||')
    : ''

  // Debounced so a run of Toggle clicks queues one sequence, not eight.
  const [settledKey, setSettledKey] = useState(key)
  useEffect(() => {
    if (key === settledKey) return
    const timer = setTimeout(() => setSettledKey(key), SEQUENCE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key, settledKey])

  // The inputs the effect reads. Held in a ref so the sequence re-runs on the
  // fingerprint rather than on object identity.
  const inputs = useRef({ active, compare, others, filters, filterKey })
  inputs.current = { active, compare, others, filters, filterKey }

  useEffect(() => {
    if (settledKey === '') return
    let listening = true
    const { active: a, compare: c, others: rest, filters: f, filterKey: fk } = inputs.current
    const client = getEngineClient()

    const runFull = async (scenario: Scenario): Promise<ModelResult> => {
      const envelope = await client.request({ type: 'run', scenario, filters: f })
      return envelope.response.result
    }
    const runKpis = async (scenario: Scenario): Promise<Kpis> => {
      const cacheKey = `${scenarioFingerprint(scenario)}|${fk}`
      const cached = kpisCache.get(cacheKey)
      if (cached !== undefined) return cached
      const envelope = await client.request({
        type: 'run',
        scenario,
        filters: f,
        options: { aggregatesOnly: true },
      })
      rememberKpis(cacheKey, envelope.response.result.kpis)
      return envelope.response.result.kpis
    }

    setLoading(true)
    setState((prior) => ({ ...prior, phase: 'Running the active scenario', error: null }))

    void (async () => {
      try {
        const activeResult = await runFull(a)
        if (!listening) return
        rememberKpis(`${scenarioFingerprint(a)}|${fk}`, activeResult.kpis)
        useUiStore.getState().setRuntimeMs(activeResult.runtimeMs)
        setState((prior) => ({
          ...prior,
          active: activeResult,
          railKpis: { ...prior.railKpis, [a.id]: activeResult.kpis },
          phase: c === null ? null : 'Running the comparison',
        }))

        let compareResult: ModelResult | null = null
        if (c !== null) {
          compareResult = await runFull(c)
          if (!listening) return
          rememberKpis(`${scenarioFingerprint(c)}|${fk}`, compareResult.kpis)
          setState((prior) => ({
            ...prior,
            compare: compareResult,
            railKpis: {
              ...prior.railKpis,
              ...(compareResult === null ? {} : { [c.id]: compareResult.kpis }),
            },
            phase: 'Costing the other scenarios',
          }))
        } else {
          setState((prior) => ({ ...prior, compare: null, bridge: null }))
        }

        // The rail's headline deltas. Small scenarios, aggregates only.
        for (const scenario of rest) {
          const kpis = await runKpis(scenario)
          if (!listening) return
          setState((prior) => ({
            ...prior,
            railKpis: { ...prior.railKpis, [scenario.id]: kpis },
          }))
        }

        if (c === null || compareResult === null) {
          if (listening) {
            setState((prior) => ({ ...prior, phase: null }))
            setLoading(false)
          }
          return
        }

        // The bridge.
        setState((prior) => ({ ...prior, phase: 'Bridging the two scenarios' }))
        const stages = bridgeStages(c, a)
        const steps: WaterfallStep[] = [
          {
            id: 'anchor-from',
            label: c.name,
            value: compareResult.kpis.requiredHours,
            anchor: true,
          },
        ]
        let running = compareResult.kpis.requiredHours
        for (const stage of stages) {
          const kpis = await runKpis(stage.scenario)
          if (!listening) return
          steps.push({
            id: `cause-${stage.cause}`,
            label: CAUSE_LABEL[stage.cause],
            value: kpis.requiredHours - running,
          })
          running = kpis.requiredHours
        }
        steps.push({
          id: 'residual',
          label: 'Residual — move order',
          value: activeResult.kpis.requiredHours - running,
        })
        steps.push({
          id: 'anchor-to',
          label: a.name,
          value: activeResult.kpis.requiredHours,
          anchor: true,
        })
        if (!listening) return
        setState((prior) => ({ ...prior, bridge: steps, phase: null }))
        setLoading(false)
      } catch (error: unknown) {
        if (!listening) return
        setState((prior) => ({ ...prior, phase: null, error: messageOf(error) }))
        setLoading(false)
      }
    })()

    return () => {
      listening = false
    }
  }, [settledKey])

  return { ...state, loading }
}

// ---------------------------------------------------------------------------
// Work-center x week arrays for the three grids
// ---------------------------------------------------------------------------

interface GridArrays {
  utilisation: Float64Array
  machineUtilisation: Float64Array
  labourUtilisation: Float64Array
  availableHours: Float64Array
  requiredHours: Float64Array
  bindingPool: Uint8Array
  downtimeHours: Float64Array
  eventLabels: Map<string, string>
  peakByRow: Float64Array
  weeksOverByRow: Float64Array
  peakWeekByRow: Int32Array
}

function emptyArrays(cells: number, rows: number): GridArrays {
  return {
    utilisation: new Float64Array(cells),
    machineUtilisation: new Float64Array(cells),
    labourUtilisation: new Float64Array(cells),
    availableHours: new Float64Array(cells),
    requiredHours: new Float64Array(cells),
    bindingPool: new Uint8Array(cells),
    downtimeHours: new Float64Array(cells),
    eventLabels: new Map<string, string>(),
    peakByRow: new Float64Array(rows),
    weeksOverByRow: new Float64Array(rows),
    peakWeekByRow: new Int32Array(rows),
  }
}

/**
 * Fold a run's judged cells into the grid's typed arrays.
 *
 * `WorkCenterWeekLoad.utilisation` is already measured against that cell's own
 * ceiling, so 1 means "at the ceiling" everywhere and the diverging scale can be
 * centred on 1 for every plant at once.
 */
function buildArrays(
  result: ModelResult | null,
  rowIndexById: ReadonlyMap<string, number>,
  rowCount: number,
  fromWeek: number,
  weekCount: number,
): GridArrays {
  const arrays = emptyArrays(Math.max(1, rowCount * weekCount), Math.max(1, rowCount))
  if (result === null) return arrays
  for (const cell of result.cells) {
    const row = rowIndexById.get(cell.workCenterId)
    if (row === undefined) continue
    const week = cell.week - fromWeek
    if (week < 0 || week >= weekCount) continue
    const index = row * weekCount + week
    arrays.utilisation[index] = cell.utilisation
    arrays.machineUtilisation[index] = safeDiv(
      cell.machineRequired,
      cell.machineAvailable * cell.ceiling,
    )
    arrays.labourUtilisation[index] = safeDiv(
      cell.labourRequired,
      cell.labourAvailable * cell.ceiling,
    )
    const labourBinds = cell.bindingPool === 'labour'
    arrays.bindingPool[index] = labourBinds ? 1 : 0
    arrays.availableHours[index] =
      (labourBinds ? cell.labourAvailable : cell.machineAvailable) * cell.ceiling
    arrays.requiredHours[index] = labourBinds ? cell.labourRequired : cell.machineRequired
    arrays.downtimeHours[index] = cell.downtimeHours
    const firstEvent = cell.events[0]
    if (firstEvent !== undefined) {
      arrays.eventLabels.set(compositeKey(cell.workCenterId, week), firstEvent)
    }
  }
  for (let row = 0; row < rowCount; row += 1) {
    let peak = 0
    let peakWeek = 0
    let over = 0
    for (let week = 0; week < weekCount; week += 1) {
      const value = f64(arrays.utilisation, row * weekCount + week)
      if (value > peak) {
        peak = value
        peakWeek = week
      }
      if (value > 1) over += 1
    }
    arrays.peakByRow[row] = peak
    arrays.peakWeekByRow[row] = peakWeek
    arrays.weeksOverByRow[row] = over
  }
  return arrays
}

/** Active minus compare, re-centred on 1 so "no change" lands on the neutral step. */
function diffArrays(a: GridArrays, b: GridArrays, rowCount: number, weekCount: number): GridArrays {
  const cells = Math.max(1, rowCount * weekCount)
  const arrays = emptyArrays(cells, Math.max(1, rowCount))
  for (let i = 0; i < cells; i += 1) {
    arrays.utilisation[i] = 1 + (f64(a.utilisation, i) - f64(b.utilisation, i))
    arrays.machineUtilisation[i] =
      1 + (f64(a.machineUtilisation, i) - f64(b.machineUtilisation, i))
    arrays.labourUtilisation[i] = 1 + (f64(a.labourUtilisation, i) - f64(b.labourUtilisation, i))
    arrays.availableHours[i] = f64(a.availableHours, i) - f64(b.availableHours, i)
    arrays.requiredHours[i] = f64(a.requiredHours, i) - f64(b.requiredHours, i)
    arrays.bindingPool[i] = a.bindingPool[i] ?? 0
    arrays.downtimeHours[i] = f64(a.downtimeHours, i) - f64(b.downtimeHours, i)
  }
  for (let row = 0; row < rowCount; row += 1) {
    let peak = 0
    let peakWeek = 0
    for (let week = 0; week < weekCount; week += 1) {
      const value = f64(arrays.utilisation, row * weekCount + week) - 1
      if (Math.abs(value) > Math.abs(peak)) {
        peak = value
        peakWeek = week
      }
    }
    arrays.peakByRow[row] = peak
    arrays.peakWeekByRow[row] = peakWeek
  }
  return arrays
}

// ---------------------------------------------------------------------------
// KPI descriptors — one list, used by the tiles and the by-week table
// ---------------------------------------------------------------------------

interface KpiSpec {
  id: string
  label: string
  read: (kpis: Kpis) => number
  format: (value: number) => string
  /**
   * How a *difference* in this metric is written, when that is not simply the
   * metric's own format. A ratio moving from 79.2% to 83.4% has moved 4.2
   * percentage points, not 4.2 percent, and writing "%" on both is the oldest
   * way to make a comparison lie.
   */
  deltaFormat?: (value: number) => string
  goodDirection: 'up' | 'down'
  hint?: string
  /** Shown as a tile in the Impact band. */
  headline?: boolean
}

/** 0.042 -> "4.2 pp". Signing is applied by `signed`. */
function points(value: number): string {
  return `${(value * 100).toFixed(1)} pp`
}

const KPI_SPECS: KpiSpec[] = [
  {
    id: 'utilisation',
    label: 'Weighted utilisation',
    read: (k) => k.utilisation,
    format: (v) => pct(v),
    deltaFormat: points,
    goodDirection: 'down',
    headline: true,
    hint: 'Required over available across the slice. Lower is more headroom, not less work.',
  },
  {
    id: 'overloadedCells',
    label: 'Overloaded work-center weeks',
    read: (k) => k.overloadedCells,
    format: (v) => formatUnits(v),
    goodDirection: 'down',
    headline: true,
    hint: 'Weeks where the plan needs more hours than the ceiling allows.',
  },
  {
    id: 'shortfallUnits',
    label: 'Shortfall units',
    read: (k) => k.shortfallUnits,
    format: (v) => formatUnits(v, { compact: true }),
    goodDirection: 'down',
    headline: true,
    hint: 'Eaches the plan wanted but the network physically refused.',
  },
  {
    id: 'planGapUnits',
    label: 'Plan gap',
    read: (k) => k.planGapUnits,
    format: (v) => formatUnits(v, { compact: true }),
    goodDirection: 'down',
    headline: true,
    hint: 'Demand minus supply plan — what the plan chose not to serve.',
  },
  {
    id: 'costUsd',
    label: 'Operating cost',
    read: (k) => k.costUsd,
    format: (v) => usd(v, { compact: true }),
    goodDirection: 'down',
    headline: true,
  },
  {
    id: 'co2Kg',
    label: 'Footprint',
    read: (k) => k.co2Kg,
    format: (v) => co2(v, { compact: true }),
    goodDirection: 'down',
    headline: true,
  },
  {
    id: 'capexUsd',
    label: 'Capex committed',
    read: (k) => k.capexUsd,
    format: (v) => usd(v, { compact: true }),
    goodDirection: 'down',
    headline: true,
    hint: 'Retrofits and new assets this scenario buys.',
  },
  {
    id: 'peakUtilisation',
    label: 'Peak utilisation',
    read: (k) => k.peakUtilisation,
    format: (v) => pct(v),
    deltaFormat: points,
    goodDirection: 'down',
  },
  {
    id: 'requiredHours',
    label: 'Required hours',
    read: (k) => k.requiredHours,
    format: (v) => formatHours(v, { compact: true }),
    goodDirection: 'down',
  },
  {
    id: 'availableHours',
    label: 'Available hours',
    read: (k) => k.availableHours,
    format: (v) => formatHours(v, { compact: true }),
    goodDirection: 'up',
  },
  {
    id: 'overloadHours',
    label: 'Overload hours',
    read: (k) => k.overloadHours,
    format: (v) => formatHours(v, { compact: true }),
    goodDirection: 'down',
  },
  {
    id: 'setupHours',
    label: 'Setup hours',
    read: (k) => k.setupHours,
    format: (v) => formatHours(v, { compact: true }),
    goodDirection: 'down',
  },
  {
    id: 'downtimeHours',
    label: 'Planned downtime hours',
    read: (k) => k.downtimeHours,
    format: (v) => formatHours(v, { compact: true }),
    goodDirection: 'down',
  },
  {
    id: 'supplyUnits',
    label: 'Supply plan units',
    read: (k) => k.supplyUnits,
    format: (v) => formatUnits(v, { compact: true }),
    goodDirection: 'up',
  },
  {
    id: 'demandUnits',
    label: 'Demand units',
    read: (k) => k.demandUnits,
    format: (v) => formatUnits(v, { compact: true }),
    goodDirection: 'up',
  },
  {
    id: 'underloadedCells',
    label: 'Under-40% work-center weeks',
    read: (k) => k.underloadedCells,
    format: (v) => formatUnits(v),
    goodDirection: 'down',
  },
  {
    id: 'machineBoundCells',
    label: 'Machine-bound weeks',
    read: (k) => k.machineBoundCells,
    format: (v) => formatUnits(v),
    goodDirection: 'down',
  },
  {
    id: 'labourBoundCells',
    label: 'Labour-bound weeks',
    read: (k) => k.labourBoundCells,
    format: (v) => formatUnits(v),
    goodDirection: 'down',
  },
]

type Delta = NonNullable<StatTileProps['delta']>

function deltaOf(
  current: number,
  base: number,
  format: (value: number) => string,
  goodDirection: 'up' | 'down',
  epsilon = 0,
): Delta {
  const diff = current - base
  const direction: Delta['direction'] =
    Math.abs(diff) <= epsilon ? 'flat' : diff > 0 ? 'up' : 'down'
  return { value: signed(diff, format), direction, goodDirection }
}

function relative(current: number, base: number): string {
  if (base === 0) return current === 0 ? 'no change' : 'from zero';
  const ratio = (current - base) / Math.abs(base)
  const shown = (ratio * 100).toFixed(1)
  return `${ratio > 0 ? '+' : ''}${shown}% relative`
}

// ---------------------------------------------------------------------------
// Scenario JSON portability
// ---------------------------------------------------------------------------

interface ExportedScenario {
  format: 'capacity-cockpit-scenario'
  version: 1
  name: string
  description: string
  moves: Array<{ label: string; enabled: boolean; seq: number; move: Move }>
}

const MOVE_KINDS: ReadonlySet<string> = new Set<Move['kind']>([
  'resourceMove',
  'oeeSet',
  'oeeGlide',
  'rateSet',
  'shiftChange',
  'downtimeUpsert',
  'downtimeRemove',
  'utilisationCeiling',
  'retrofit',
  'addWorkCenter',
  'wipTransfer',
  'planScale',
  'sourceSwitch',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Required-field check per move kind.
 *
 * Deliberately structural rather than exhaustive: it rejects anything the
 * engine would trip over, names the field that is wrong, and leaves value
 * ranges to the model, which already clamps them.
 */
const REQUIRED_FIELDS: Record<string, ReadonlyArray<[string, 'string' | 'number' | 'boolean' | 'object']>> = {
  resourceMove: [
    ['selector', 'object'],
    ['fromWorkCenterId', 'string'],
    ['toWorkCenterId', 'string'],
    ['fromWeek', 'number'],
    ['toWeek', 'number'],
    ['share', 'number'],
    ['allowDualSource', 'boolean'],
  ],
  oeeSet: [
    ['scope', 'string'],
    ['value', 'number'],
  ],
  oeeGlide: [['path', 'object']],
  rateSet: [
    ['materialId', 'string'],
    ['workCenterId', 'string'],
    ['opId', 'string'],
    ['ratePerHour', 'number'],
  ],
  shiftChange: [
    ['workCenterId', 'string'],
    ['pool', 'string'],
    ['fromWeek', 'number'],
    ['toWeek', 'number'],
  ],
  downtimeUpsert: [['event', 'object']],
  downtimeRemove: [['eventId', 'string']],
  utilisationCeiling: [
    ['scope', 'string'],
    ['ceiling', 'number'],
  ],
  retrofit: [
    ['workCenterId', 'string'],
    ['retrofitId', 'string'],
    ['availableFromWeek', 'number'],
  ],
  addWorkCenter: [
    ['workCenter', 'object'],
    ['capexUsd', 'number'],
  ],
  wipTransfer: [
    ['materialId', 'string'],
    ['fromPlantId', 'string'],
    ['toPlantId', 'string'],
    ['fromWeek', 'number'],
    ['toWeek', 'number'],
    ['share', 'number'],
    ['freightCostPerUnitUsd', 'number'],
    ['transitWeeks', 'number'],
  ],
  planScale: [
    ['plan', 'string'],
    ['selector', 'object'],
    ['fromWeek', 'number'],
    ['toWeek', 'number'],
    ['factor', 'number'],
  ],
  sourceSwitch: [
    ['selector', 'object'],
    ['fromPlantId', 'string'],
    ['toPlantId', 'string'],
    ['switchWeek', 'number'],
    ['overlapWeeks', 'number'],
  ],
}

const NESTED_REQUIRED: Record<string, ReadonlyArray<[string, 'string' | 'number']>> = {
  'oeeGlide.path': [
    ['scope', 'string'],
    ['fromWeek', 'number'],
    ['toWeek', 'number'],
    ['endValue', 'number'],
    ['curve', 'string'],
    ['label', 'string'],
    ['id', 'string'],
  ],
  'downtimeUpsert.event': [
    ['id', 'string'],
    ['workCenterId', 'string'],
    ['kind', 'string'],
    ['status', 'string'],
    ['fromWeek', 'number'],
    ['toWeek', 'number'],
    ['label', 'string'],
  ],
  'addWorkCenter.workCenter': [
    ['id', 'string'],
    ['plantId', 'string'],
    ['code', 'string'],
    ['name', 'string'],
    ['classId', 'string'],
    ['vintage', 'number'],
    ['baseOee', 'number'],
    ['status', 'string'],
    ['costRateUsdPerHour', 'number'],
    ['co2PerMachineHourKg', 'number'],
  ],
}

function checkMove(value: unknown, where: string, errors: string[]): Move | null {
  if (!isRecord(value)) {
    errors.push(`${where}: the move is not an object.`)
    return null
  }
  const kind = value['kind']
  if (typeof kind !== 'string' || !MOVE_KINDS.has(kind)) {
    errors.push(`${where}: “${String(kind)}” is not a move this model knows.`)
    return null
  }
  const spec = REQUIRED_FIELDS[kind] ?? []
  let ok = true
  for (const [field, type] of spec) {
    const held = value[field]
    const matches =
      type === 'object' ? isRecord(held) || Array.isArray(held) : typeof held === type
    if (!matches) {
      errors.push(`${where}: “${kind}” needs ${field} as a ${type}.`)
      ok = false
    }
  }
  const nested = NESTED_REQUIRED[`${kind}.${kind === 'oeeGlide' ? 'path' : kind === 'downtimeUpsert' ? 'event' : 'workCenter'}`]
  if (nested !== undefined) {
    const container = value[kind === 'oeeGlide' ? 'path' : kind === 'downtimeUpsert' ? 'event' : 'workCenter']
    if (isRecord(container)) {
      for (const [field, type] of nested) {
        if (typeof container[field] !== type) {
          errors.push(`${where}: “${kind}” needs its nested ${field} as a ${type}.`)
          ok = false
        }
      }
    }
  }
  if (kind === 'addWorkCenter') {
    const wc = value['workCenter']
    if (isRecord(wc) && !Array.isArray(wc['pools'])) {
      errors.push(`${where}: “addWorkCenter” needs workCenter.pools as an array.`)
      ok = false
    }
    if (isRecord(wc) && !Array.isArray(wc['features'])) {
      errors.push(`${where}: “addWorkCenter” needs workCenter.features as an array.`)
      ok = false
    }
  }
  if (!ok) return null
  return value as unknown as Move
}

interface ParsedImport {
  name: string
  description: string
  moves: Array<{ label: string; enabled: boolean; move: Move }>
  errors: string[]
}

function parseScenarioJson(text: string): ParsedImport {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    return { name: '', description: '', moves: [], errors: [`The file is not valid JSON: ${messageOf(error)}`] }
  }
  if (!isRecord(parsed)) {
    return { name: '', description: '', moves: [], errors: ['The file does not contain a scenario object.'] }
  }
  // Accept either the wrapper this screen writes or a bare `Scenario`.
  const body = isRecord(parsed['scenario']) ? parsed['scenario'] : parsed
  const name = typeof body['name'] === 'string' && body['name'].trim() !== '' ? body['name'] : 'Imported scenario'
  if (typeof body['name'] !== 'string') errors.push('No scenario name — it will be called “Imported scenario”.')
  const description = typeof body['description'] === 'string' ? body['description'] : ''
  const rawMoves = body['moves']
  if (!Array.isArray(rawMoves)) {
    errors.push('The scenario has no `moves` array — there is nothing to import.')
    return { name, description, moves: [], errors }
  }
  const moves: ParsedImport['moves'] = []
  for (let i = 0; i < rawMoves.length; i += 1) {
    const entry: unknown = rawMoves[i]
    const where = `Move ${i + 1}`
    if (!isRecord(entry)) {
      errors.push(`${where}: not an object.`)
      continue
    }
    const move = checkMove(entry['move'] ?? entry, where, errors)
    if (move === null) continue
    moves.push({
      label: typeof entry['label'] === 'string' ? entry['label'] : '',
      enabled: entry['enabled'] === undefined ? true : entry['enabled'] === true,
      move,
    })
  }
  if (moves.length === 0 && errors.length === 0) errors.push('The scenario contains no moves.')
  return { name, description, moves, errors }
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

const MAX_GRID_ROWS_IN_TABLE = 200

export function Scenarios() {
  const catalog = useUiStore((state) => state.catalog)
  const filters = useUiStore((state) => state.filters)
  const scenarios = useUiStore((state) => state.scenarios)
  const activeScenarioId = useUiStore((state) => state.activeScenarioId)
  const compareScenarioId = useUiStore((state) => state.compareScenarioId)
  const setActiveScenario = useUiStore((state) => state.setActiveScenario)
  const setCompareScenario = useUiStore((state) => state.setCompareScenario)
  const createScenario = useUiStore((state) => state.createScenario)
  const renameScenario = useUiStore((state) => state.renameScenario)
  const deleteScenario = useUiStore((state) => state.deleteScenario)
  const applyMove = useUiStore((state) => state.applyMove)
  const toggleMove = useUiStore((state) => state.toggleMove)
  const removeMove = useUiStore((state) => state.removeMove)
  const undo = useUiStore((state) => state.undo)
  const redo = useUiStore((state) => state.redo)
  const canUndo = useUiStore((state) => state.canUndo)
  const canRedo = useUiStore((state) => state.canRedo)
  const notify = useUiStore((state) => state.notify)

  const active = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0],
    [scenarios, activeScenarioId],
  )
  const compare = useMemo(
    () => (compareScenarioId === null ? null : (scenarios.find((s) => s.id === compareScenarioId) ?? null)),
    [scenarios, compareScenarioId],
  )
  const others = useMemo(
    () => scenarios.filter((s) => s.id !== activeScenarioId && s.id !== compareScenarioId),
    [scenarios, activeScenarioId, compareScenarioId],
  )

  const activeScenario = useMemo<Scenario>(
    () =>
      active ?? {
        id: BASELINE_SCENARIO_ID,
        name: 'Baseline',
        description: '',
        moves: [],
        colorSlot: 1,
        readonly: true,
      },
    [active],
  )

  const lab = useScenarioLab(activeScenario, compare, others, filters)

  const [editing, setEditing] = useState<{ id: MoveId | null; move?: Move } | null>(null)
  const [renaming, setRenaming] = useState<Scenario | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
  const [deleting, setDeleting] = useState<Scenario | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReport, setImportReport] = useState<ParsedImport | null>(null)
  const [gridSort, setGridSort] = useState<UtilisationGridSort>({ by: 'peak', direction: 'desc' })

  const indexes = useMemo(() => catalogIndexes(catalog), [catalog])

  // --- the grid rows --------------------------------------------------------

  const weeks = useMemo(() => catalog?.time.weeks ?? [], [catalog])
  const fromWeek = clamp(filters.fromWeek, 0, Math.max(0, weeks.length - 1))
  const toWeek = clamp(filters.toWeek, fromWeek, Math.max(0, weeks.length - 1))
  const weekCount = Math.max(1, toWeek - fromWeek + 1)
  const weekLabels = useMemo(() => weeks.slice(fromWeek, toWeek + 1), [weeks, fromWeek, toWeek])

  const gridRows = useMemo<UtilisationGridRow[]>(() => {
    const plantById = new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant]))
    const classById = new Map((catalog?.machineClasses ?? []).map((entry) => [entry.id, entry]))
    const wantedPlants = filters.plantIds.length > 0 ? new Set(filters.plantIds) : null
    const wantedRegions = filters.regions.length > 0 ? new Set<string>(filters.regions) : null
    const wantedClasses =
      filters.machineClassIds.length > 0 ? new Set(filters.machineClassIds) : null
    const wantedWorkCenters =
      filters.workCenterIds.length > 0 ? new Set(filters.workCenterIds) : null

    const rows: UtilisationGridRow[] = []
    for (const wc of (catalog?.workCenters ?? []) as WorkCenter[]) {
      if (wantedWorkCenters !== null && !wantedWorkCenters.has(wc.id)) continue
      if (wantedClasses !== null && !wantedClasses.has(wc.classId)) continue
      if (wantedPlants !== null && !wantedPlants.has(wc.plantId)) continue
      const plant = plantById.get(wc.plantId)
      if (wantedRegions !== null && (plant === undefined || !wantedRegions.has(plant.region))) {
        continue
      }
      rows.push({
        id: wc.id,
        code: wc.code,
        name: wc.name,
        plantId: wc.plantId,
        plantLabel: plant?.name ?? wc.plantId,
        plantSlot: plant?.colorSlot ?? 1,
        machineClass: classById.get(wc.classId)?.name ?? wc.classId,
        peakUtilisation: 0,
      })
    }
    return rows
  }, [catalog, filters])

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    gridRows.forEach((row, index) => map.set(row.id, index))
    return map
  }, [gridRows])

  const activeArrays = useMemo(
    () => buildArrays(lab.active, rowIndexById, gridRows.length, fromWeek, weekCount),
    [lab.active, rowIndexById, gridRows.length, fromWeek, weekCount],
  )
  const compareArrays = useMemo(
    () => buildArrays(lab.compare, rowIndexById, gridRows.length, fromWeek, weekCount),
    [lab.compare, rowIndexById, gridRows.length, fromWeek, weekCount],
  )
  const deltaArrays = useMemo(
    () => diffArrays(activeArrays, compareArrays, gridRows.length, weekCount),
    [activeArrays, compareArrays, gridRows.length, weekCount],
  )

  /**
   * One domain for all three grids.
   *
   * Comparing two heatmaps drawn on two scales is worse than not drawing the
   * second one, so a single domain covers all three — and because one runaway
   * work-center week would otherwise flatten every other cell to the same pale
   * step, the domain is the 95th percentile of the deviation rather than its
   * maximum. Anything past it clamps to the end step, which is what the end
   * step is for.
   */
  const sharedDomain = useMemo(() => {
    const BINS = 128
    const BIN_WIDTH = 0.02
    const histogram = new Uint32Array(BINS)
    let counted = 0
    const scan = (arrays: GridArrays): void => {
      const total = gridRows.length * weekCount
      for (let i = 0; i < total; i += 1) {
        const deviation = Math.abs(f64(arrays.utilisation, i) - 1)
        const bin = Math.min(BINS - 1, Math.floor(deviation / BIN_WIDTH))
        histogram[bin] = (histogram[bin] ?? 0) + 1
        counted += 1
      }
    }
    scan(activeArrays)
    if (lab.compare !== null) {
      scan(compareArrays)
      scan(deltaArrays)
    }
    if (counted === 0) return 0.5
    const target = counted * 0.95
    let running = 0
    let bin = 0
    for (; bin < BINS; bin += 1) {
      running += histogram[bin] ?? 0
      if (running >= target) break
    }
    const percentile = (Math.min(bin, BINS - 1) + 1) * BIN_WIDTH
    return clamp(Math.ceil(percentile * 20) / 20, 0.2, 1)
  }, [activeArrays, compareArrays, deltaArrays, gridRows.length, weekCount, lab.compare])

  /** What the bridge's steps add up to, stated rather than implied. */
  const bridgeReconciliation = useMemo(() => {
    const steps = lab.bridge
    if (steps === null || steps.length === 0) return null
    const from = steps[0]?.value ?? 0
    const to = steps[steps.length - 1]?.value ?? 0
    const contributions = steps.filter((step) => step.anchor !== true)
    const explained = contributions
      .filter((step) => step.id !== 'residual')
      .reduce((total, step) => total + step.value, 0)
    const residual = contributions.find((step) => step.id === 'residual')?.value ?? 0
    const moved = contributions.filter((step) => Math.abs(step.value) > 1e-6).length
    return { from, to, explained, residual, causes: contributions.length - 1, moved }
  }, [lab.bridge])

  const gridTable = useCallback(
    (arrays: GridArrays, caption: string, centred: boolean): TableViewProps => {
      const order = gridRows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => Math.abs(f64(arrays.peakByRow, b.index)) - Math.abs(f64(arrays.peakByRow, a.index)))
        .slice(0, MAX_GRID_ROWS_IN_TABLE)
      return {
        caption,
        columns: [
          { key: 'workCenter', label: 'Work center' },
          { key: 'plant', label: 'Plant' },
          { key: 'class', label: 'Machine class' },
          { key: 'peak', label: centred ? 'Largest change' : 'Peak vs ceiling', align: 'right' },
          { key: 'week', label: 'Week it happens' },
          { key: 'over', label: 'Weeks over ceiling', align: 'right' },
        ],
        rows: order.map(({ row, index }) => ({
          workCenter: `${row.code} · ${row.name}`,
          plant: row.plantLabel,
          class: row.machineClass,
          peak: centred
            ? signed(f64(arrays.peakByRow, index), (v) => pct(v))
            : pct(f64(arrays.peakByRow, index)),
          week: weekLabels[arrays.peakWeekByRow[index] ?? 0] ?? '—',
          over: centred ? '—' : formatUnits(f64(arrays.weeksOverByRow, index)),
        })),
        rowSlot: () => undefined,
      }
    },
    [gridRows, weekLabels],
  )

  // --- by-week series -------------------------------------------------------

  const weekSeries = useMemo<TimeSeries[]>(() => {
    const series: TimeSeries[] = []
    const pointsOf = (result: ModelResult | null): TimeSeries['points'] =>
      (result?.kpisByWeek ?? [])
        .filter((entry) => entry.week >= fromWeek && entry.week <= toWeek)
        .map((entry) => ({ month: weeks[entry.week] ?? `W${entry.week}`, value: entry.utilisation }))
    if (lab.active !== null) {
      series.push({
        id: activeScenario.id,
        label: `${activeScenario.name} (active)`,
        slot: activeScenario.colorSlot,
        markShape: 'line',
        points: pointsOf(lab.active),
      })
    }
    if (lab.compare !== null && compare !== null) {
      series.push({
        id: compare.id,
        label: compare.name,
        slot: compare.colorSlot,
        markShape: 'line',
        points: pointsOf(lab.compare),
      })
    }
    return series
  }, [lab.active, lab.compare, activeScenario, compare, weeks, fromWeek, toWeek])

  const weekTable = useMemo<TableViewProps>(() => {
    const activeByWeek = new Map((lab.active?.kpisByWeek ?? []).map((entry) => [entry.week, entry]))
    const compareByWeek = new Map(
      (lab.compare?.kpisByWeek ?? []).map((entry) => [entry.week, entry]),
    )
    const rows: Array<Record<string, string | number>> = []
    for (let week = fromWeek; week <= toWeek; week += 1) {
      const a = activeByWeek.get(week)
      const c = compareByWeek.get(week)
      rows.push({
        week: weeks[week] ?? `W${week}`,
        activeUtil: a === undefined ? '—' : pct(a.utilisation),
        compareUtil: c === undefined ? '—' : pct(c.utilisation),
        delta:
          a === undefined || c === undefined ? '—' : signed(a.utilisation - c.utilisation, (v) => pct(v)),
        activeRequired: a === undefined ? '—' : formatHours(a.requiredHours, { compact: true }),
        compareRequired: c === undefined ? '—' : formatHours(c.requiredHours, { compact: true }),
      })
    }
    return {
      caption:
        'Weighted utilisation each week for the active scenario and the one it is compared against.',
      columns: [
        { key: 'week', label: 'Week' },
        { key: 'activeUtil', label: 'Active', align: 'right' },
        { key: 'compareUtil', label: 'Compare', align: 'right' },
        { key: 'delta', label: 'Difference', align: 'right' },
        { key: 'activeRequired', label: 'Active required', align: 'right' },
        { key: 'compareRequired', label: 'Compare required', align: 'right' },
      ],
      rows,
    }
  }, [lab.active, lab.compare, weeks, fromWeek, toWeek])

  const bridgeTable = useMemo<TableViewProps>(() => {
    const steps = lab.bridge ?? []
    let running = 0
    const rows: Array<Record<string, string | number>> = []
    for (const step of steps) {
      if (step.anchor === true) running = step.value
      else running += step.value
      rows.push({
        step: step.label,
        kind: step.anchor === true ? 'Anchor' : 'Contribution',
        value: step.anchor === true ? formatHours(step.value) : signed(step.value, (v) => formatHours(v)),
        running: formatHours(running),
      })
    }
    return {
      caption:
        'Every step between the compared scenario’s required hours and the active scenario’s, in the order the bridge applies them.',
      columns: [
        { key: 'step', label: 'Step' },
        { key: 'kind', label: 'Kind' },
        { key: 'value', label: 'Hours', align: 'right' },
        { key: 'running', label: 'Running total', align: 'right' },
      ],
      rows,
    }
  }, [lab.bridge])

  // --- KPI comparison table -------------------------------------------------

  interface KpiRow {
    id: string
    label: string
    activeValue: string
    compareValue: string
    deltaValue: string
    deltaGood: 'good' | 'bad' | 'flat'
    sortKey: number
  }

  const kpiRows = useMemo<KpiRow[]>(() => {
    const a = lab.active?.kpis
    const c = lab.compare?.kpis
    if (a === undefined) return []
    return KPI_SPECS.map((spec) => {
      const activeValue = spec.read(a)
      const compareValue = c === undefined ? Number.NaN : spec.read(c)
      const diff = c === undefined ? Number.NaN : activeValue - compareValue
      const good: KpiRow['deltaGood'] = !Number.isFinite(diff)
        ? 'flat'
        : diff === 0
          ? 'flat'
          : (diff > 0 ? 'up' : 'down') === spec.goodDirection
            ? 'good'
            : 'bad'
      return {
        id: spec.id,
        label: spec.label,
        activeValue: spec.format(activeValue),
        compareValue: Number.isFinite(compareValue) ? spec.format(compareValue) : '—',
        deltaValue: Number.isFinite(diff) ? signed(diff, spec.deltaFormat ?? spec.format) : '—',
        deltaGood: good,
        sortKey: Number.isFinite(diff) ? Math.abs(diff) : 0,
      }
    })
  }, [lab.active, lab.compare])

  const kpiColumns = useMemo<Array<DataTableColumn<KpiRow>>>(
    () => [
      {
        key: 'label',
        header: 'Metric',
        sortValue: (row) => row.label,
        render: (row) => <span className={styles.metricName}>{row.label}</span>,
      },
      {
        key: 'active',
        header: 'Active',
        align: 'right',
        sortValue: (row) => row.activeValue,
        render: (row) => row.activeValue,
      },
      {
        key: 'compare',
        header: 'Compare',
        align: 'right',
        sortValue: (row) => row.compareValue,
        render: (row) => row.compareValue,
      },
      {
        key: 'delta',
        header: 'Difference',
        align: 'right',
        sortValue: (row) => row.sortKey,
        render: (row) => (
          <span
            className={
              row.deltaGood === 'good'
                ? styles.deltaGood
                : row.deltaGood === 'bad'
                  ? styles.deltaBad
                  : styles.deltaFlat
            }
          >
            <span aria-hidden="true">
              {row.deltaGood === 'flat' ? '→' : row.deltaValue.startsWith('+') ? '↑' : '↓'}
            </span>{' '}
            {row.deltaValue}
          </span>
        ),
      },
    ],
    [],
  )

  // --- starter moves --------------------------------------------------------

  const starters = useMemo(() => {
    const result = lab.active
    const worst = result?.bottlenecks[0]
    const workCenters = catalog?.workCenters ?? []
    const worstWorkCenter = workCenters.find((wc) => wc.id === worst?.workCenterId)

    // Somewhere in the same class with the most room. Same class means the
    // allow-list is the most likely to already say yes.
    let target: WorkCenter | undefined
    if (worstWorkCenter !== undefined) {
      const peakById = new Map<string, number>()
      for (const cell of result?.cells ?? []) {
        const prior = peakById.get(cell.workCenterId) ?? 0
        if (cell.utilisation > prior) peakById.set(cell.workCenterId, cell.utilisation)
      }
      const siblings = workCenters.filter(
        (wc) => wc.classId === worstWorkCenter.classId && wc.id !== worstWorkCenter.id,
      )
      siblings.sort((x, y) => (peakById.get(x.id) ?? 0) - (peakById.get(y.id) ?? 0))
      target = siblings[0]
    }

    const groups = catalog?.groups ?? []
    const housings =
      groups.find((group) => /hous/i.test(group.name) || /hous/i.test(group.code)) ??
      groups.find((group) => group.id === worst?.topGroups[0]?.groupId) ??
      groups[0]

    const plants = catalog?.plants ?? []
    const worstPlant = plants.find((plant) => plant.id === worst?.plantId) ?? plants[0]
    const rampTo = clamp((worstPlant?.defaultOee ?? 0.7) + 0.06, 0.05, 0.98)
    const rampEnd = clamp(fromWeek + 11, fromWeek, Math.max(fromWeek, weeks.length - 1))

    const list: Array<{ id: string; label: string; description: string; move: Move | null }> = [
      {
        id: 'ceiling',
        label: 'Raise the ceiling to 95%',
        description:
          'Plan to 95% of the hours that exist across the whole network instead of 100%, and see which weeks stop fitting.',
        move: { kind: 'utilisationCeiling', scope: 'global', ceiling: 0.95 },
      },
      {
        id: 'housings',
        label: `Move ${housings?.name ?? 'the biggest group'} off the tightest work center`,
        description:
          worstWorkCenter === undefined || target === undefined || housings === undefined
            ? 'Needs a first model run to know which work center is tightest and which sibling has room.'
            : `Everything ${housings.name} runs on ${worstWorkCenter.code} moves to ${target.code}, the least loaded machine of the same class, for the whole window.`,
        move:
          worstWorkCenter === undefined || target === undefined || housings === undefined
            ? null
            : {
                kind: 'resourceMove',
                selector: { kind: 'group', id: housings.id },
                fromWorkCenterId: worstWorkCenter.id,
                toWorkCenterId: target.id,
                fromWeek,
                toWeek,
                share: 1,
                allowDualSource: false,
              },
      },
      {
        id: 'ramp',
        label: 'Start a 12-week OEE ramp at the worst plant',
        description:
          worstPlant === undefined
            ? 'Needs a first model run to know which plant is worst.'
            : `Every work center at ${worstPlant.name} ramps to ${pct(rampTo, 0)} OEE on an S-curve over twelve weeks.`,
        move:
          worstPlant === undefined
            ? null
            : {
                kind: 'oeeGlide',
                path: {
                  id: `glide-starter-${worstPlant.id}`,
                  scope: 'plant',
                  plantId: worstPlant.id,
                  fromWeek,
                  toWeek: rampEnd,
                  endValue: rampTo,
                  curve: 'sCurve',
                  label: `${worstPlant.city} OEE improvement programme`,
                },
              },
      },
    ]
    return list
  }, [lab.active, catalog, fromWeek, toWeek, weeks.length])

  // --- scenario actions -----------------------------------------------------

  const openRename = (scenario: Scenario): void => {
    setRenaming(scenario)
    setRenameName(scenario.name)
    setRenameDescription(scenario.description)
  }

  const duplicate = (scenario: Scenario): void => {
    const name = `${scenario.name} copy`
    createScenario(name, scenario.description, scenario.id)
    notify(`“${name}” started from ${scenario.name}.`, 'good')
  }

  const exportScenario = (scenario: Scenario): void => {
    const payload: ExportedScenario = {
      format: 'capacity-cockpit-scenario',
      version: 1,
      name: scenario.name,
      description: scenario.description,
      moves: scenario.moves
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((entry) => ({
          label: entry.label,
          enabled: entry.enabled,
          seq: entry.seq,
          move: entry.move,
        })),
    }
    const safe = scenario.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
    download(
      `scenario-${safe === '' ? 'export' : safe}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    )
    notify(`Exported “${scenario.name}” with ${payload.moves.length} moves.`, 'good')
  }

  const commitImport = (report: ParsedImport): void => {
    const createdId = createScenario(report.name, report.description)
    const disabled: string[] = []
    for (const entry of report.moves) {
      const label = entry.label === '' ? describeMove(entry.move, indexes) : entry.label
      applyMove(entry.move, label)
      if (!entry.enabled) disabled.push(label)
    }
    // Moves arrive enabled, so anything that was off is switched off afterwards.
    if (disabled.length > 0) {
      const created = useUiStore.getState().scenarios.find((s) => s.id === createdId)
      for (const entry of created?.moves ?? []) {
        if (disabled.includes(entry.label)) toggleMove(entry.id)
      }
    }
    setImportOpen(false)
    setImportText('')
    setImportReport(null)
    notify(
      `Imported “${report.name}” — ${report.moves.length} move${report.moves.length === 1 ? '' : 's'}.`,
      'good',
    )
  }

  // --- states ---------------------------------------------------------------

  if (catalog === null) {
    return (
      <div className={styles.page}>
        <EmptyState
          title="Master data has not arrived yet"
          description="Scenarios are lists of moves against work centers and products, so there is nothing to author until the catalog lands."
        />
      </div>
    )
  }

  const compareName = compare?.name ?? 'nothing'
  const activeKpis = lab.active?.kpis
  const compareKpis = lab.compare?.kpis
  const orderedMoves = activeScenario.moves.slice().sort((a, b) => a.seq - b.seq)
  const enabledCount = orderedMoves.filter((entry) => entry.enabled).length
  /** Deduplicated: the same note can arrive from the KPI run and the full run. */
  const engineWarnings = [...new Set(lab.active?.warnings ?? [])]

  return (
    <div className={styles.page}>
      <SectionHeading
        level={1}
        description="A scenario is a list of decisions, in the order they were taken. Everything below is what those decisions did."
        aside={
          <div className={styles.headActions}>
            <Button icon="download" onClick={() => exportScenario(activeScenario)}>
              Export JSON
            </Button>
            <Button icon="upload" onClick={() => setImportOpen(true)}>
              Import JSON
            </Button>
          </div>
        }
      >
        Scenarios
      </SectionHeading>

      <FilterBar />

      <div className={styles.split}>
        {/* ---------------------------------------------------------------- */}
        {/* The rail                                                          */}
        {/* ---------------------------------------------------------------- */}
        <Card
          className={styles.rail}
          title="Scenarios"
          subtitle={
            compare === null
              ? 'Pick one to compare against and every scenario shows what it changes.'
              : `Headline deltas are against ${compareName}.`
          }
          aside={
            <Button
              size="sm"
              variant="primary"
              icon="plus"
              onClick={() => {
                const used = new Set(scenarios.map((s) => s.name))
                let n = 1
                while (used.has(`Scenario ${n}`)) n += 1
                createScenario(`Scenario ${n}`, 'Started empty.')
              }}
            >
              New
            </Button>
          }
        >
          <Select
            label="Compare against"
            value={compareScenarioId ?? ''}
            options={[
              { value: '', label: 'Nothing — show the active scenario alone' },
              ...scenarios
                .filter((s) => s.id !== activeScenarioId)
                .map((s) => ({ value: s.id, label: s.name })),
            ]}
            onChange={(value) => setCompareScenario(value === '' ? null : value)}
          />

          <ul className={styles.railList}>
            {scenarios.map((scenario) => {
              const isActive = scenario.id === activeScenarioId
              const isCompare = scenario.id === compareScenarioId
              const kpis = lab.railKpis[scenario.id]
              const baseKpis = compare === null ? undefined : lab.railKpis[compare.id]
              return (
                <li
                  key={scenario.id}
                  className={[
                    styles.railItem,
                    isActive ? styles.railItemActive : '',
                    isCompare ? styles.railItemCompare : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    type="button"
                    className={styles.railSelect}
                    aria-pressed={isActive}
                    onClick={() => setActiveScenario(scenario.id)}
                  >
                    <span
                      className={`${styles.slotDot} ${styles[`slot${scenario.colorSlot}`] ?? ''}`}
                      aria-hidden="true"
                    />
                    <span className={styles.railName}>{scenario.name}</span>
                    <span className={styles.railMeta}>
                      {scenario.moves.length === 0
                        ? 'no moves'
                        : `${scenario.moves.length} move${scenario.moves.length === 1 ? '' : 's'}`}
                    </span>
                  </button>

                  <div className={styles.railBadges}>
                    {scenario.readonly === true ? (
                      <Badge tone="neutral" size="sm">
                        Read-only baseline
                      </Badge>
                    ) : null}
                    {isActive ? (
                      <Badge tone="good" size="sm">
                        Active
                      </Badge>
                    ) : null}
                    {isCompare ? (
                      <Badge tone="neutral" size="sm">
                        Compared against
                      </Badge>
                    ) : null}
                  </div>

                  {scenario.description === '' ? null : (
                    <p className={styles.railDescription}>{scenario.description}</p>
                  )}

                  {kpis === undefined ? (
                    <p className={styles.railPending}>
                      <Icon name="clock" size={12} /> Costing this scenario…
                    </p>
                  ) : baseKpis === undefined || scenario.id === compareScenarioId ? (
                    <dl className={styles.railStats}>
                      <div>
                        <dt>Utilisation</dt>
                        <dd>{pct(kpis.utilisation)}</dd>
                      </div>
                      <div>
                        <dt>Overloaded weeks</dt>
                        <dd>{formatUnits(kpis.overloadedCells)}</dd>
                      </div>
                      <div>
                        <dt>Capex</dt>
                        <dd>{usd(kpis.capexUsd, { compact: true })}</dd>
                      </div>
                    </dl>
                  ) : (
                    <dl className={styles.railStats}>
                      <div>
                        <dt>Utilisation</dt>
                        <dd>
                          {pct(kpis.utilisation)}{' '}
                          <span className={styles.railDelta}>
                            {signed(kpis.utilisation - baseKpis.utilisation, (v) => pct(v))}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Overloaded weeks</dt>
                        <dd>
                          {formatUnits(kpis.overloadedCells)}{' '}
                          <span className={styles.railDelta}>
                            {signed(kpis.overloadedCells - baseKpis.overloadedCells, (v) =>
                              formatUnits(v),
                            )}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Capex</dt>
                        <dd>
                          {usd(kpis.capexUsd, { compact: true })}{' '}
                          <span className={styles.railDelta}>
                            {signed(kpis.capexUsd - baseKpis.capexUsd, (v) =>
                              usd(v, { compact: true }),
                            )}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  )}

                  {scenario.readonly === true ? (
                    <p className={styles.railNote}>
                      The baseline is what every other scenario is measured against, so it cannot be
                      renamed, edited or deleted. Duplicate it to start from where it is.
                    </p>
                  ) : null}

                  <div className={styles.railActions}>
                    <Button size="sm" icon="copy" onClick={() => duplicate(scenario)}>
                      Duplicate
                    </Button>
                    {scenario.readonly === true ? null : (
                      <>
                        <Button size="sm" icon="sliders" onClick={() => openRename(scenario)}>
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon="trash"
                          onClick={() => setDeleting(scenario)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                    <Button size="sm" icon="download" onClick={() => exportScenario(scenario)}>
                      Export
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* The decision log                                                  */}
        {/* ---------------------------------------------------------------- */}
        <Card
          title={`Decision log — ${activeScenario.name}`}
          subtitle={
            orderedMoves.length === 0
              ? 'Nothing has been decided yet.'
              : `${orderedMoves.length} decision${orderedMoves.length === 1 ? '' : 's'}, ${enabledCount} in force. Turning one off writes through immediately.`
          }
          aside={
            <div className={styles.logActions}>
              <IconButton
                icon="undo"
                label="Undo"
                hint="Undo — Ctrl+Z / ⌘Z"
                disabled={!canUndo}
                onClick={undo}
              />
              <IconButton
                icon="redo"
                label="Redo"
                hint="Redo — Ctrl+Shift+Z / ⇧⌘Z"
                disabled={!canRedo}
                onClick={redo}
              />
              <Button
                size="sm"
                variant="primary"
                icon="plus"
                onClick={() => setEditing({ id: null })}
              >
                Add a move
              </Button>
            </div>
          }
        >
          {orderedMoves.length === 0 ? (
            <EmptyState
              icon="scenario"
              title="This scenario has decided nothing yet"
              description={
                activeScenario.readonly === true
                  ? 'The baseline is the network as master data describes it. Starting any of these will fork a working scenario automatically — the baseline itself never changes.'
                  : 'Start from one of these, or author any of the thirteen kinds of change from scratch.'
              }
              action={
                <div className={styles.starters}>
                  {starters.map((starter) => (
                    <div key={starter.id} className={styles.starter}>
                      <Button
                        variant="primary"
                        icon="zap"
                        disabled={starter.move === null}
                        onClick={() => {
                          if (starter.move === null) return
                          applyMove(starter.move)
                        }}
                      >
                        {starter.label}
                      </Button>
                      <p className={styles.starterNote}>{starter.description}</p>
                    </div>
                  ))}
                  <Button icon="plus" onClick={() => setEditing({ id: null })}>
                    Author a move from scratch
                  </Button>
                </div>
              }
            />
          ) : (
            <ol className={styles.log}>
              {orderedMoves.map((entry, index) => (
                <li
                  key={entry.id}
                  className={[styles.logRow, entry.enabled ? '' : styles.logRowOff]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={styles.logIndex} aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className={styles.logBody}>
                    <p className={styles.logLabel}>{entry.label}</p>
                    <p className={styles.logDetail}>{describeMove(entry.move, indexes)}</p>
                    <div className={styles.logPills}>
                      <Pill>{CAUSE_LABEL[causeOf(entry.move)]}</Pill>
                      <Pill>{entry.move.kind}</Pill>
                    </div>
                  </div>
                  <div className={styles.logControls}>
                    <Toggle
                      label={entry.enabled ? 'In force' : 'Turned off'}
                      checked={entry.enabled}
                      onChange={() => toggleMove(entry.id)}
                    />
                    <Button
                      size="sm"
                      icon="sliders"
                      onClick={() => setEditing({ id: entry.id, move: entry.move })}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="trash"
                      onClick={() => removeMove(entry.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {activeScenario.readonly === true && orderedMoves.length === 0 ? null : (
            <p className={styles.logFoot}>
              Moves are applied in the order shown and a later one wins where two touch the same
              thing. Undo takes back one step at a time — Ctrl+Z on Windows and Linux, ⌘Z on a Mac.
            </p>
          )}
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* What the engine had to say about those decisions.                 */}
        {/*                                                                   */}
        {/* `ModelResult.warnings` had no home in the UI at all, so a move     */}
        {/* quietly switched off — or a glide path that LOWERS OEE while its   */}
        {/* label reads like an improvement — reached the planner only as a    */}
        {/* KPI that moved the wrong way. It belongs beside the log it is      */}
        {/* about.                                                            */}
        {/* ---------------------------------------------------------------- */}
        {engineWarnings.length === 0 ? null : (
          <Card
            title="What the engine flagged"
            subtitle={`${engineWarnings.length} note${engineWarnings.length === 1 ? '' : 's'} about the decisions above. None of them stops the run — they are what a planner would want to have been told.`}
          >
            <ul className={styles.warnList} aria-label="Engine warnings">
              {engineWarnings.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Impact                                                              */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeading
        description={
          compare === null
            ? 'Nothing is selected to compare against, so these are the active scenario’s own numbers.'
            : `${activeScenario.name} against ${compareName}, over the weeks and slice the filter row selects.`
        }
        aside={
          lab.phase === null ? null : (
            <span className={styles.working}>
              <Icon name="clock" size={12} /> {lab.phase}…
            </span>
          )
        }
      >
        Impact
      </SectionHeading>

      {lab.error !== null && lab.active === null ? (
        <ErrorState
          title="The model could not answer for these scenarios"
          message={lab.error}
          detail="The previous answer is kept where there was one. Narrowing the window or the plant filter is the cheapest way back."
        />
      ) : activeKpis === undefined ? (
        <Card>
          <EmptyState
            icon="clock"
            title="Running the model over the network"
            description="Fifteen thousand SKUs across a hundred and fifty work centers, twice — once for each scenario."
          />
        </Card>
      ) : (
        <>
          <div className={styles.tiles}>
            {KPI_SPECS.filter((spec) => spec.headline === true).map((spec) => {
              const value = spec.read(activeKpis)
              const base = compareKpis === undefined ? undefined : spec.read(compareKpis)
              return (
                <StatTile
                  key={spec.id}
                  label={spec.label}
                  value={spec.format(value)}
                  delta={
                    base === undefined
                      ? undefined
                      : deltaOf(
                          value,
                          base,
                          spec.deltaFormat ?? spec.format,
                          spec.goodDirection,
                          1e-9,
                        )
                  }
                  deltaContext={
                    base === undefined
                      ? `no comparison selected`
                      : `${relative(value, base)} vs ${compareName}`
                  }
                  hint={spec.hint}
                />
              )
            })}
          </div>

          <ChartCard
            title="What turned one required-hours total into the other"
            subtitle={
              compare === null
                ? 'Pick a scenario to compare against and this bridge fills in, one step per cause.'
                : `From ${compareName} to ${activeScenario.name}, one step per cause, in the order the model applies them. The residual is what move ordering accounts for — it is shown rather than absorbed.`
            }
            aside={
              <span className={styles.aside}>
                {lab.bridge === null ? 'not built yet' : `${lab.bridge.length - 2} causes`}
              </span>
            }
            stale={lab.loading && lab.bridge !== null}
            table={bridgeTable}
          >
            {lab.bridge === null ? (
              <EmptyState
                icon="scenario"
                title={compare === null ? 'Nothing to bridge from' : 'Building the bridge'}
                description={
                  compare === null
                    ? 'A bridge needs two scenarios. Choose one in the rail above.'
                    : 'Each step is a separate model run, so the totals tie out by construction rather than by estimate.'
                }
              />
            ) : (
              <>
                <WaterfallChart
                  steps={lab.bridge}
                  format={(value) => formatHours(value, { compact: true })}
                  height={300}
                />
                {bridgeReconciliation === null ? null : (
                  <p className={styles.chartNote}>
                    {formatHours(bridgeReconciliation.from)} → {formatHours(bridgeReconciliation.to)}
                    . {bridgeReconciliation.causes} cause
                    {bridgeReconciliation.causes === 1 ? ' differs' : 's differ'} between the two
                    scenarios and{' '}
                    {bridgeReconciliation.causes === 1 ? 'accounts' : 'account'} for{' '}
                    {signed(bridgeReconciliation.explained, (v) => formatHours(v))}; the residual is{' '}
                    {signed(bridgeReconciliation.residual, (v) => formatHours(v))}.
                    {bridgeReconciliation.moved === 0 ? (
                      <>
                        {' '}
                        Every step is zero, which is the honest answer: these scenarios differ only
                        in causes that change what capacity is <em>available</em> or what counts as
                        overload, never in what the plan <em>requires</em>. The three grids below
                        are where that difference shows.
                      </>
                    ) : null}
                  </p>
                )}
              </>
            )}
          </ChartCard>

          <div className={styles.grids}>
            <ChartCard
              title={`${activeScenario.name} — utilisation`}
              subtitle={`Every cell against its own ceiling. Shared scale: ±${pct(sharedDomain, 0)} around the ceiling.`}
              stale={lab.loading && lab.active !== null}
              table={gridTable(
                activeArrays,
                `Peak utilisation against the ceiling per work center for ${activeScenario.name}, worst first.`,
                false,
              )}
            >
              <UtilisationGrid
                rows={gridRows}
                weeks={weekLabels}
                utilisation={activeArrays.utilisation}
                machineUtilisation={activeArrays.machineUtilisation}
                labourUtilisation={activeArrays.labourUtilisation}
                availableHours={activeArrays.availableHours}
                requiredHours={activeArrays.requiredHours}
                bindingPool={activeArrays.bindingPool}
                downtimeHours={activeArrays.downtimeHours}
                eventLabels={activeArrays.eventLabels}
                domain={sharedDomain}
                sort={gridSort}
                onSortChange={setGridSort}
                height={300}
                emptyMessage="No work centers survive these filters"
              />
            </ChartCard>

            <ChartCard
              title={compare === null ? 'Nothing to compare' : `${compareName} — utilisation`}
              subtitle={
                compare === null
                  ? 'Choose a scenario in the rail and it is drawn here on the same scale.'
                  : `Same weeks, same work centers, same scale: ±${pct(sharedDomain, 0)} around the ceiling.`
              }
              stale={lab.loading && lab.compare !== null}
              table={gridTable(
                compareArrays,
                `Peak utilisation against the ceiling per work center for ${compareName}, worst first.`,
                false,
              )}
            >
              {compare === null ? (
                <EmptyState
                  icon="scenario"
                  title="No comparison selected"
                  description="The rail above chooses what this half of the screen shows."
                />
              ) : (
                <UtilisationGrid
                  rows={gridRows}
                  weeks={weekLabels}
                  utilisation={compareArrays.utilisation}
                  machineUtilisation={compareArrays.machineUtilisation}
                  labourUtilisation={compareArrays.labourUtilisation}
                  availableHours={compareArrays.availableHours}
                  requiredHours={compareArrays.requiredHours}
                  bindingPool={compareArrays.bindingPool}
                  downtimeHours={compareArrays.downtimeHours}
                  eventLabels={compareArrays.eventLabels}
                  domain={sharedDomain}
                  sort={gridSort}
                  onSortChange={setGridSort}
                  height={300}
                  emptyMessage="No work centers survive these filters"
                />
              )}
            </ChartCard>

            <ChartCard
              title="The difference"
              subtitle={`Active minus compare, centred so “no change” is the neutral step. Same ±${pct(sharedDomain, 0)} scale as the two grids beside it.`}
              stale={lab.loading && lab.compare !== null}
              table={gridTable(
                deltaArrays,
                'The largest change in utilisation per work center between the two scenarios, biggest first.',
                true,
              )}
            >
              {compare === null ? (
                <EmptyState
                  icon="scenario"
                  title="A difference needs two scenarios"
                  description="Choose one to compare against and the change appears here, cell by cell."
                />
              ) : (
                <>
                <UtilisationGrid
                  rows={gridRows}
                  weeks={weekLabels}
                  utilisation={deltaArrays.utilisation}
                  machineUtilisation={deltaArrays.machineUtilisation}
                  labourUtilisation={deltaArrays.labourUtilisation}
                  availableHours={deltaArrays.availableHours}
                  requiredHours={deltaArrays.requiredHours}
                  bindingPool={deltaArrays.bindingPool}
                  downtimeHours={deltaArrays.downtimeHours}
                  domain={sharedDomain}
                  sort={gridSort}
                  onSortChange={setGridSort}
                  height={300}
                  emptyMessage="No work centers survive these filters"
                />
                <p className={styles.chartNote}>
                  Read this panel as change, not level: the scale is centred on “no change”, a
                  warm cell means utilisation <strong>rose</strong> in that week and a cool cell
                  means it <strong>fell</strong>. The legend and the caret glyph are the shared
                  ones from the two grids beside it — here “over ceiling” means “rose” and the
                  caret marks a cell that did.
                </p>
                </>
              )}
            </ChartCard>
          </div>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* By week                                                             */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeading description="The same two scenarios, week by week rather than in total.">
        By week
      </SectionHeading>

      <ChartCard
        title="Weighted utilisation, week by week"
        subtitle={
          compare === null
            ? 'One series until a comparison is chosen.'
            : `${activeScenario.name} against ${compareName} across ${weekCount} weeks.`
        }
        stale={lab.loading && lab.active !== null}
        table={weekTable}
      >
        {weekSeries.length === 0 ? (
          <EmptyState
            icon="clock"
            title="No weekly answer yet"
            description="The first run fills this in."
          />
        ) : (
          <LineChart
            series={weekSeries}
            format={(value) => pct(value, 0)}
            yLabel="Utilisation against ceiling"
            height={280}
          />
        )}
      </ChartCard>

      <Card
        title="Every KPI, both scenarios"
        subtitle={
          compare === null
            ? 'Choose a comparison in the rail and the difference column fills in.'
            : `Active is ${activeScenario.name}; compare is ${compareName}. A difference is coloured by whether it went the way you want, not by its sign.`
        }
        aside={
          <InfoTip label="How the difference is read">
            Each metric declares its own good direction. Falling overload and rising available hours
            are both good news, so both are painted the same way.
          </InfoTip>
        }
        flush
        stale={lab.loading && lab.active !== null}
      >
        <DataTable<KpiRow>
          caption="Every model KPI for the active scenario and the one it is compared against, with the difference."
          columns={kpiColumns}
          rows={kpiRows}
          rowKey={(row) => row.id}
          maxHeight={520}
          empty={
            <EmptyState
              icon="clock"
              title="No KPIs yet"
              description="They appear as soon as the first run lands."
            />
          }
        />
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Overlays                                                            */}
      {/* ------------------------------------------------------------------ */}
      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id === null || editing === null ? 'Add a move' : 'Edit this move'}
        description={
          editing?.id === null || editing === null
            ? 'It applies the moment you save it, and it is undoable.'
            : 'Saving replaces the move in place, keeping its position in the log.'
        }
        width={560}
      >
        {editing === null ? null : (
          <MoveEditor
            initial={editing.move}
            onCancel={() => setEditing(null)}
            onSubmit={(label, move) => {
              if (editing.id !== null) removeMove(editing.id)
              applyMove(move, label)
              setEditing(null)
            }}
          />
        )}
      </Drawer>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename this scenario"
        description="The name is what the rail, the comparison and every export call it."
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="check"
              onClick={() => {
                if (renaming !== null) renameScenario(renaming.id, renameName, renameDescription)
                setRenaming(null)
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <TextField label="Name" value={renameName} onChange={setRenameName} autoFocus />
          <TextField
            label="What this scenario is for"
            value={renameDescription}
            onChange={setRenameDescription}
            hint="One line a colleague opening this in six weeks would thank you for."
          />
        </div>
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="The moves in it go with it. Export it first if it is worth keeping."
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Keep it</Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                if (deleting !== null) {
                  deleteScenario(deleting.id)
                  notify(`Deleted “${deleting.name}”.`, 'warning')
                }
                setDeleting(null)
              }}
            >
              Delete it
            </Button>
          </>
        }
      >
        <p className={styles.modalNote}>
          {deleting === null
            ? null
            : `${deleting.moves.length} move${deleting.moves.length === 1 ? '' : 's'} will be discarded. Deleting a scenario is not undoable.`}
        </p>
        {deleting === null ? null : (
          <Button icon="download" onClick={() => exportScenario(deleting)}>
            Export it first
          </Button>
        )}
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false)
          setImportReport(null)
        }}
        title="Import a scenario"
        description="Paste the JSON, or choose a file exported from this tool."
        width={640}
        footer={
          <>
            <Button
              onClick={() => {
                setImportOpen(false)
                setImportReport(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={importReport === null || importReport.moves.length === 0}
              onClick={() => {
                if (importReport !== null && importReport.moves.length > 0) {
                  commitImport(importReport)
                }
              }}
            >
              {importReport === null
                ? 'Check it first'
                : `Import ${importReport.moves.length} move${importReport.moves.length === 1 ? '' : 's'}`}
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <label className={styles.fileField}>
            <span className={styles.fileLabel}>Choose a file</span>
            <input
              type="file"
              accept="application/json,.json"
              className={styles.fileInput}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file === undefined) return
                const reader = new FileReader()
                reader.onload = () => {
                  const text = typeof reader.result === 'string' ? reader.result : ''
                  setImportText(text)
                  setImportReport(parseScenarioJson(text))
                }
                reader.readAsText(file)
              }}
            />
          </label>

          <TextField
            label="…or paste the JSON"
            value={importText}
            onChange={(value) => {
              setImportText(value)
              setImportReport(value.trim() === '' ? null : parseScenarioJson(value))
            }}
            placeholder='{"format":"capacity-cockpit-scenario", …}'
          />

          {importReport === null ? null : (
            <div className={styles.importReport}>
              <p className={styles.importSummary}>
                <strong>{importReport.name}</strong> — {importReport.moves.length} valid move
                {importReport.moves.length === 1 ? '' : 's'}
                {importReport.errors.length === 0
                  ? ', nothing rejected.'
                  : `, ${importReport.errors.length} problem${importReport.errors.length === 1 ? '' : 's'} found.`}
              </p>
              {importReport.errors.length === 0 ? null : (
                <ul className={styles.importErrors}>
                  {importReport.errors.map((message, index) => (
                    <li key={`${index}-${message}`}>{message}</li>
                  ))}
                </ul>
              )}
              {importReport.moves.length === 0 ? null : (
                <ul className={styles.importMoves}>
                  {importReport.moves.map((entry, index) => (
                    <li key={index}>
                      {entry.enabled ? '' : '(off) '}
                      {entry.label === '' ? describeMove(entry.move, indexes) : entry.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default Scenarios
