/**
 * Worker-backed model hooks.
 *
 * Every screen in this app asks the same question in a different shape: given
 * the active scenario and the current filters, what does the model say? These
 * hooks are the only place that question is asked, and they exist to make four
 * behaviours automatic rather than remembered:
 *
 * 1. **A superseded answer is dropped silently.** A planner dragging a slider
 *    outruns a 300ms model run every time. The answer nobody is waiting for any
 *    more is not an error, is never rendered, and never reaches a toast.
 *
 * 2. **The previous answer stays on screen while a new one is computed.** Charts
 *    dim to `stale` rather than collapsing to a skeleton — a layout that jumps
 *    while someone is reading it is worse than a number that is 200ms old.
 *
 * 3. **Requests are debounced on the scenario fingerprint.** Dragging a slider
 *    through forty values queues one run, not forty.
 *
 * 4. **An unmounted hook never calls `setState`.** Nothing is cancelled — the
 *    worker finishes what it started and the caches keep the answer — the hook
 *    simply stops listening.
 *
 * Nothing sized SKU x week passes through here. The worker returns aggregates:
 * a few thousand numbers, sized for a screen.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  Filters,
  Kpis,
  ModelResult,
  PlantId,
  ReliefCandidate,
  RollupCell,
  RollupLevel,
  Scenario,
  WorkCenterId,
} from '@/domain/types'
import type { MaterialSliceRow, RateQuote, WorkCenterDetail } from '@/worker/protocol'
import { at } from '@/domain/lookup'
import { getEngineClient, isSuperseded } from '@/worker/client'
import { useActiveScenario, useUiStore } from '@/state/store'

/** Every hook in this file returns this shape. */
export interface Query<T> {
  data: T | null
  loading: boolean
  error: string | null
}

/** Long enough to swallow a drag, short enough to feel immediate. */
const DEBOUNCE_MS = 120

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * What the worker would actually see. Disabled moves are included because
 * toggling one changes the answer, and `label` is excluded because renaming a
 * move does not.
 */
export function scenarioFingerprint(scenario: Scenario): string {
  const moves = scenario.moves
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => `${entry.id}:${entry.enabled ? 1 : 0}:${JSON.stringify(entry.move)}`)
    .join(';')
  return `${scenario.id}#${moves}`
}

export function filterFingerprint(filters: Filters): string {
  const list = (values: readonly string[]): string => values.slice().sort().join(',')
  return [
    list(filters.plantIds),
    list(filters.regions),
    list(filters.familyIds),
    list(filters.groupIds),
    list(filters.workCenterIds),
    list(filters.machineClassIds),
    filters.fromWeek,
    filters.toWeek,
    filters.bucket,
  ].join('|')
}

// ---------------------------------------------------------------------------
// Request scheduling
// ---------------------------------------------------------------------------

/**
 * A queued request that a newer request from the same hook replaced. Never
 * shown, never logged — the same contract as the client's own sentinel.
 */
class QueuedSupersededError extends Error {
  readonly superseded = true

  constructor() {
    super('A queued request was replaced by a newer one from the same hook.')
    this.name = 'SupersededError'
  }
}

function wasSuperseded(error: unknown): boolean {
  return isSuperseded(error) || error instanceof QueuedSupersededError
}

interface Job {
  slot: string
  run: () => Promise<unknown>
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void
}

const queues = new Map<string, Job[]>()
const running = new Set<string>()

function pump(type: string): void {
  if (running.has(type)) return
  const queue = queues.get(type)
  if (queue === undefined || queue.length === 0) return
  const job = queue.shift()
  if (job === undefined) return
  running.add(type)
  const done = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void => {
    running.delete(type)
    job.settle(outcome)
    pump(type)
  }
  job.run().then(
    (value) => done({ ok: true, value }),
    (error: unknown) => done({ ok: false, error }),
  )
}

/**
 * Serialise requests by worker request TYPE.
 *
 * The client supersedes by type, which is exactly right for one hook firing
 * repeatedly and exactly wrong for two hooks on the same screen asking for two
 * different roll-up levels at once — the second would cancel the first and one
 * chart would never render. Holding one request of each type in flight removes
 * that collision, and `slot` keeps latest-wins *within* a hook: a queued
 * request the same hook has already replaced is dropped before it is ever sent.
 */
function enqueue<T>(type: string, slot: string, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = queues.get(type) ?? []
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (at(queue, i, 'queued job').slot !== slot) continue
      const [dropped] = queue.splice(i, 1)
      dropped?.settle({ ok: false, error: new QueuedSupersededError() })
    }
    queue.push({
      slot,
      run: run as () => Promise<unknown>,
      settle: (outcome) => {
        if (outcome.ok) resolve(outcome.value as T)
        else reject(outcome.error)
      },
    })
    queues.set(type, queue)
    pump(type)
  })
}

// ---------------------------------------------------------------------------
// The generic hook
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Debounce a cache key. The first value passes through immediately — a screen
 * that has just mounted should start its run now, not in 120ms — and every
 * subsequent change waits for the interaction to settle.
 */
function useDebounced(value: string, ms = DEBOUNCE_MS): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === settled) return
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

/**
 * The engine of every hook below. `key` is the whole identity of the request:
 * an empty key means "nothing to ask yet" and parks the hook without an error.
 */
function useWorkerQuery<T>(type: string, key: string, run: () => Promise<T>): Query<T> {
  const slot = useId()
  const runRef = useRef(run)
  runRef.current = run

  const settledKey = useDebounced(key)
  const [state, setState] = useState<Query<T>>({
    data: null,
    loading: key !== '',
    error: null,
  })

  useEffect(() => {
    if (settledKey === '') {
      setState({ data: null, loading: false, error: null })
      return
    }
    let listening = true
    // Hold the previous data. Charts dim; they do not blank.
    setState((prior) => ({ data: prior.data, loading: true, error: null }))
    enqueue(type, slot, () => runRef.current()).then(
      (data) => {
        if (!listening) return
        setState({ data, loading: false, error: null })
      },
      (error: unknown) => {
        if (!listening) return
        // A superseded request is not a failure. Leave `loading` set: the
        // request that replaced it is already on its way.
        if (wasSuperseded(error)) return
        setState((prior) => ({ data: prior.data, loading: false, error: messageOf(error) }))
      },
    )
    return () => {
      listening = false
    }
  }, [type, slot, settledKey])

  return state
}

/** True once the worker has answered `init`. Nothing may be asked before then. */
function useEngineReady(): boolean {
  return useUiStore((state) => state.status === 'ready')
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

/**
 * The authoritative run for the active scenario. Also the source of the header's
 * runtime readout — keeping the model's cost on screen is what stops a
 * regression from being felt long before it is measured.
 */
export function useModelResult(): Query<ModelResult> {
  const scenario = useActiveScenario()
  const filters = useUiStore((state) => state.filters)
  const ready = useEngineReady()
  const key = ready ? `run|${scenarioFingerprint(scenario)}|${filterFingerprint(filters)}` : ''

  const query = useWorkerQuery('run', key, () => getEngineClient().run(scenario, filters))

  const runtime = query.data?.runtimeMs
  useEffect(() => {
    if (runtime !== undefined) useUiStore.getState().setRuntimeMs(runtime)
  }, [runtime])

  return query
}

/**
 * Aggregates at one level of the hierarchy, optionally under one parent — the
 * work centers of a plant, the groups of a family.
 */
export function useRollup(
  level: RollupLevel,
  parentKey?: string,
): Query<{ cells: RollupCell[]; kpis: Kpis }> {
  const scenario = useActiveScenario()
  const filters = useUiStore((state) => state.filters)
  const ready = useEngineReady()
  const key = ready
    ? `rollup|${level}|${parentKey ?? ''}|${scenarioFingerprint(scenario)}|${filterFingerprint(filters)}`
    : ''

  return useWorkerQuery('rollup', key, async () => {
    const response = await getEngineClient().rollup(scenario, filters, level, parentKey)
    return { cells: response.cells, kpis: response.kpis }
  })
}

/** Everything about one work center: the build-up, its siblings, its downtime. */
export function useWorkCenterDetail(id: WorkCenterId | undefined): Query<WorkCenterDetail> {
  const scenario = useActiveScenario()
  const filters = useUiStore((state) => state.filters)
  const ready = useEngineReady()
  const key =
    ready && id !== undefined && id !== ''
      ? `wc|${id}|${scenarioFingerprint(scenario)}|${filterFingerprint(filters)}`
      : ''

  return useWorkerQuery('workCenterDetail', key, () =>
    getEngineClient().workCenterDetail(scenario, filters, id ?? ''),
  )
}

/** Where else the load could go, ranked, with the price of each option. */
export function useRelief(id: WorkCenterId | undefined): Query<ReliefCandidate[]> {
  const scenario = useActiveScenario()
  const filters = useUiStore((state) => state.filters)
  const ready = useEngineReady()
  const key =
    ready && id !== undefined && id !== ''
      ? `relief|${id}|${scenarioFingerprint(scenario)}|${filterFingerprint(filters)}`
      : ''

  return useWorkerQuery('relief', key, () =>
    getEngineClient().relief(scenario, filters, id ?? ''),
  )
}

export interface MaterialSliceArgs {
  groupId?: string
  workCenterId?: string
  offset: number
  limit: number
  sortBy: 'hours' | 'units' | 'code'
}

/**
 * One page of materials. The UI never asks for all 15,000 — the page is the
 * unit of work, and `total` is what the pager counts against.
 */
export function useMaterialSlice(
  args: MaterialSliceArgs,
): Query<{ rows: MaterialSliceRow[]; total: number }> {
  const scenario = useActiveScenario()
  const filters = useUiStore((state) => state.filters)
  const ready = useEngineReady()
  const { groupId, workCenterId, offset, limit, sortBy } = args
  const key = ready
    ? [
        'slice',
        groupId ?? '',
        workCenterId ?? '',
        offset,
        limit,
        sortBy,
        scenarioFingerprint(scenario),
        filterFingerprint(filters),
      ].join('|')
    : ''

  return useWorkerQuery('materialSlice', key, async () => {
    const response = await getEngineClient().materialSlice({
      scenario,
      filters,
      groupId,
      workCenterId,
      offset,
      limit,
      sortBy,
    })
    return { rows: response.rows, total: response.total }
  })
}

/**
 * What one (material, work center, operation) runs at TODAY — the number a
 * `rateSet` move is authored AGAINST.
 *
 * Routings, production versions, rate overrides and the OEE cascade all live in
 * the worker, so the main thread cannot resolve a rate itself. It used to not
 * try: the form defaulted the field to a hardcoded 100 eaches/hour against real
 * rates spanning 150–3000. This hook is that default's replacement, and it
 * re-asks whenever any of the three selections changes — a value fetched for a
 * different SKU is the same lie as a constant, only better disguised.
 *
 * An empty material parks the hook: there is nothing to resolve yet.
 */
export function useResolvedRate(
  material: string,
  workCenterId: WorkCenterId,
  opId: string,
  week: number,
): Query<RateQuote> {
  const scenario = useActiveScenario()
  const filters = useUiStore((state) => state.filters)
  const ready = useEngineReady()
  const trimmed = material.trim()
  const key =
    ready && trimmed !== '' && workCenterId !== '' && opId !== ''
      ? ['rate', trimmed, workCenterId, opId, week, scenarioFingerprint(scenario)].join('|')
      : ''

  return useWorkerQuery('resolveRate', key, () =>
    getEngineClient().resolveRate({
      scenario,
      filters,
      material: trimmed,
      workCenterId,
      opId,
      week,
    }),
  )
}

// ---------------------------------------------------------------------------
// Colour identity
// ---------------------------------------------------------------------------

type Slot = 1 | 2 | 3 | 4 | 5

/**
 * A plant's permanent categorical slot.
 *
 * Colour follows the entity for the life of the app, so this is a lookup and
 * never "the nth series in the current sort order" — filtering to three plants
 * must not repaint the survivors.
 */
export function usePlantSlot(): (plantId: PlantId) => Slot {
  const plants = useUiStore((state) => state.catalog?.plants)
  const byId = useMemo(() => {
    const map = new Map<PlantId, Slot>()
    for (const plant of plants ?? []) map.set(plant.id, plant.colorSlot)
    return map
  }, [plants])
  return useCallback((plantId: PlantId) => byId.get(plantId) ?? 1, [byId])
}

/** A work center wears its **plant's** slot — the site is the identity, not the machine. */
export function useWorkCenterSlot(): (wcId: WorkCenterId) => Slot {
  const workCenters = useUiStore((state) => state.catalog?.workCenters)
  const plantSlot = usePlantSlot()
  const plantOf = useMemo(() => {
    const map = new Map<WorkCenterId, PlantId>()
    for (const wc of workCenters ?? []) map.set(wc.id, wc.plantId)
    return map
  }, [workCenters])
  return useCallback(
    (wcId: WorkCenterId) => {
      const plantId = plantOf.get(wcId)
      return plantId === undefined ? 1 : plantSlot(plantId)
    },
    [plantOf, plantSlot],
  )
}
