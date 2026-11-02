/**
 * UI state. **Never model data.**
 *
 * The line this file defends: the worker owns the `Snapshot`, every dense grid
 * and every derived number; this store owns what the planner has *asked for*.
 * Scenarios are lists of moves — a few hundred bytes each — filters, a
 * selection, a theme and an undo stack. Nothing here scales with SKUs or weeks,
 * which is why re-rendering on any of it is free.
 *
 * Two behaviours are product decisions rather than implementation details:
 *
 * 1. **Moves apply immediately.** There is no Apply button anywhere in this
 *    product, so `applyMove` mutates the active scenario and the worker-backed
 *    hooks re-run off the new fingerprint. Undo is the safety net.
 *
 * 2. **The baseline never refuses.** It is read-only, but dragging a node while
 *    it is active does not hit a wall: the store transparently forks a working
 *    scenario, applies there, and says so in a toast. A planner exploring an
 *    idea should never be told "no" by a modal.
 */

import { create } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import type {
  FamilyId,
  Filters,
  GroupId,
  Move,
  MoveId,
  PlantId,
  Scenario,
  ScenarioId,
  ScenarioMove,
  WeekIndex,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import type { CatalogPayload } from '@/worker/protocol'
import { BASELINE_SCENARIO_ID, baselineScenario } from '@/domain/engine'
import { describeMove } from '@/domain/moves'
import { UndoStack } from '@/state/undo'
import type { PersistedSession, ThemePreference } from '@/lib/storage'
import { loadSession, saveSession } from '@/lib/storage'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What the planner is pointing at. Drives the canvas, the drawers and the map. */
export interface Selection {
  plantId?: PlantId
  workCenterId?: WorkCenterId
  groupId?: GroupId
  familyId?: FamilyId
  week?: WeekIndex
}

export type ZoomLevel = 'globe' | 'plant' | 'workCenter'

export type NoticeTone = 'info' | 'good' | 'warning' | 'danger'

/**
 * A message queued for the toast layer. The store cannot render, so it queues;
 * `AppShell` drains this into the `ToastProvider` and dismisses each one.
 */
export interface Notice {
  id: string
  message: string
  tone: NoticeTone
}

export interface UiState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  catalog: CatalogPayload | null
  scenarios: Scenario[]
  activeScenarioId: ScenarioId
  compareScenarioId: ScenarioId | null
  filters: Filters
  theme: ThemePreference
  selection: Selection
  zoom: ZoomLevel
  canUndo: boolean
  canRedo: boolean
  runtimeMs: number

  // --- extras the shell needs; the six screens can ignore them -------------
  /** Label of the step undo would take back, for the button's tooltip. */
  undoLabel: string | null
  redoLabel: string | null
  /** Queued toasts. Drained by the shell. */
  notices: Notice[]
  /** True when the engine is running on the main thread. Surface it. */
  usingFallback: boolean
  /** Init timings from the worker's `ready`, for the Data screen. */
  timings: Record<string, number> | null

  setFilters(patch: Partial<Filters>): void
  resetFilters(): void
  setSelection(patch: Partial<Selection>): void
  setZoom(z: ZoomLevel): void
  setTheme(t: ThemePreference): void

  /** Applies immediately and is undoable. This is the core interaction. */
  applyMove(move: Move, label?: string): void
  toggleMove(moveId: MoveId): void
  removeMove(moveId: MoveId): void
  undo(): void
  redo(): void

  setActiveScenario(id: ScenarioId): void
  setCompareScenario(id: ScenarioId | null): void
  createScenario(name: string, description: string, cloneFrom?: ScenarioId): ScenarioId
  renameScenario(id: ScenarioId, name: string, description: string): void
  deleteScenario(id: ScenarioId): void

  // --- lifecycle, driven by the bootstrap in App.tsx ------------------------
  setReady(catalog: CatalogPayload, timings: Record<string, number>, usingFallback: boolean): void
  setError(message: string): void
  setRuntimeMs(ms: number): void
  notify(message: string, tone?: NoticeTone): void
  dismissNotice(id: string): void
}

// ---------------------------------------------------------------------------
// Ids — an incrementing counter, never Math.random
// ---------------------------------------------------------------------------

let idCounter = 0

/**
 * Monotonic, human-readable, and reproducible within a session. Random ids
 * would make two runs of the same interaction produce different scenarios,
 * which turns every diff and every screenshot comparison into noise.
 */
export function nextLocalId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

// ---------------------------------------------------------------------------
// Catalog-backed indexes, so moves can be described on the main thread
// ---------------------------------------------------------------------------

/**
 * A `SnapshotIndexes` built from what the main thread actually has.
 *
 * `describeMove` resolves ids to shop-floor names, and the catalog carries
 * plants, work centers, classes, features, operations, families and groups —
 * everything a move label mentions except the 15,000 materials, which stay in
 * the worker by design. The material maps are therefore empty and
 * `describeMove` falls back to the material *code* it was handed, which is what
 * a planner reads on the shop floor anyway.
 */
export function catalogIndexes(catalog: CatalogPayload | null): SnapshotIndexes {
  const workCenters = catalog?.workCenters ?? []
  const workCenterOrder = workCenters.map((wc) => wc.id)
  return {
    plantById: new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant])),
    plantOrder: (catalog?.plants ?? []).map((plant) => plant.id),
    workCenterById: new Map(workCenters.map((wc) => [wc.id, wc])),
    workCenterRow: new Map(workCenterOrder.map((id, index) => [id, index])),
    workCenterOrder,
    workCentersByPlant: groupWorkCenters(catalog, (wc) => wc.plantId),
    workCentersByClass: groupWorkCenters(catalog, (wc) => wc.classId),
    materialById: new Map(),
    materialsByGroup: new Map(),
    materialsByFamily: new Map(),
    groupById: new Map((catalog?.groups ?? []).map((group) => [group.id, group])),
    familyById: new Map((catalog?.families ?? []).map((family) => [family.id, family])),
    classById: new Map((catalog?.machineClasses ?? []).map((cls) => [cls.id, cls])),
    featureById: new Map((catalog?.features ?? []).map((feature) => [feature.id, feature])),
    stdOpById: new Map((catalog?.standardOperations ?? []).map((op) => [op.id, op])),
    routingsByMaterialPlant: new Map(),
    primaryRouting: new Map(),
    approvedWorkCentersByOp: new Map(),
    workCenterFeatures: new Map(workCenters.map((wc) => [wc.id, new Set(wc.features)])),
    rateOverrideByKey: new Map(),
    downtimeByWorkCenter: new Map(),
    supplyRow: new Map(),
    demandRow: new Map(),
    weekCount: catalog?.time.weeks.length ?? 0,
  }
}

function groupWorkCenters(
  catalog: CatalogPayload | null,
  key: (wc: CatalogPayload['workCenters'][number]) => string,
): Map<string, CatalogPayload['workCenters']> {
  const map = new Map<string, CatalogPayload['workCenters']>()
  for (const wc of catalog?.workCenters ?? []) {
    const k = key(wc)
    const bucket = map.get(k)
    if (bucket === undefined) map.set(k, [wc])
    else bucket.push(wc)
  }
  return map
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * The toggle wins over `prefers-color-scheme` in **both** directions, which is
 * why an explicit choice writes `data-theme` and `system` removes it entirely
 * rather than writing a third value the tokens file would have to know about.
 */
export function applyTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

// ---------------------------------------------------------------------------
// Defaults & hydration
// ---------------------------------------------------------------------------

/** 78 weeks is the contracted horizon; the catalog corrects this on `ready`. */
const FALLBACK_WEEK_COUNT = 78

function emptyFilters(weekCount = FALLBACK_WEEK_COUNT): Filters {
  return {
    plantIds: [],
    regions: [],
    familyIds: [],
    groupIds: [],
    workCenterIds: [],
    machineClassIds: [],
    fromWeek: 0,
    toWeek: Math.max(0, weekCount - 1),
    bucket: 'week',
  }
}

/** The baseline is always index 0, always frozen, never restored from storage. */
function withBaseline(scenarios: Scenario[]): Scenario[] {
  const baseline = baselineScenario()
  const rest = scenarios.filter((scenario) => scenario.id !== BASELINE_SCENARIO_ID)
  return [baseline, ...rest]
}

const undoStack = new UndoStack<ScenarioSnapshot>()

interface ScenarioSnapshot {
  scenarioId: ScenarioId
  moves: ScenarioMove[]
}

interface Hydrated {
  scenarios: Scenario[]
  activeScenarioId: ScenarioId
  filters: Filters
  theme: ThemePreference
  seq: number
}

function hydrate(): Hydrated {
  const fallback = emptyFilters()
  let session: PersistedSession | null = null
  try {
    session = loadSession(fallback)
  } catch {
    // `loadSession` is already defensive; this is the belt to its braces. A
    // corrupt workspace must cost the planner their filters, never their app.
    session = null
  }
  const scenarios = withBaseline(session?.scenarios ?? [])
  const requested = session?.activeScenarioId ?? BASELINE_SCENARIO_ID
  const active = scenarios.some((scenario) => scenario.id === requested)
    ? requested
    : BASELINE_SCENARIO_ID
  // Ids must not collide with anything restored from the last session.
  idCounter = Math.max(idCounter, session?.seq ?? 0)
  return {
    scenarios,
    activeScenarioId: active,
    filters: session?.filters ?? fallback,
    theme: session?.theme ?? 'system',
    seq: session?.seq ?? 0,
  }
}

const initial = hydrate()
let moveSeq = initial.seq

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export const useUiStore: UseBoundStore<StoreApi<UiState>> = create<UiState>((set, get) => {
  /** Persist the four durable slices. Never results, never the catalog. */
  const persist = (): void => {
    const state = get()
    saveSession({
      version: 2,
      scenarios: state.scenarios.filter((scenario) => scenario.id !== BASELINE_SCENARIO_ID),
      activeScenarioId: state.activeScenarioId,
      filters: state.filters,
      theme: state.theme,
      seq: moveSeq,
    })
  }

  const undoFlags = (): Pick<UiState, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> => ({
    canUndo: undoStack.canUndo,
    canRedo: undoStack.canRedo,
    undoLabel: undoStack.undoLabel,
    redoLabel: undoStack.redoLabel,
  })

  const scenarioById = (id: ScenarioId): Scenario | undefined =>
    get().scenarios.find((scenario) => scenario.id === id)

  /** Replace one scenario's move list. The only writer of `moves`. */
  const writeMoves = (scenarioId: ScenarioId, moves: ScenarioMove[]): void => {
    set((state) => ({
      scenarios: state.scenarios.map((scenario) =>
        scenario.id === scenarioId ? { ...scenario, moves } : scenario,
      ),
    }))
  }

  const pushNotice = (message: string, tone: NoticeTone): void => {
    set((state) => ({
      notices: [...state.notices, { id: nextLocalId('notice'), message, tone }],
    }))
  }

  /**
   * A working scenario to write into. The baseline is read-only, so it forks
   * rather than refusing — see the file header.
   */
  const writableScenario = (): Scenario => {
    const state = get()
    const active = state.scenarios.find((scenario) => scenario.id === state.activeScenarioId)
    if (active !== undefined && active.readonly !== true) return active

    const used = new Set(state.scenarios.map((scenario) => scenario.name))
    let n = 1
    while (used.has(`Scenario ${n}`)) n += 1
    const name = `Scenario ${n}`
    const id = state.createScenario(
      name,
      'Forked automatically from the baseline, which is read-only.',
      BASELINE_SCENARIO_ID,
    )
    pushNotice(`The baseline is read-only, so this change started “${name}”.`, 'info')
    const forked = get().scenarios.find((scenario) => scenario.id === id)
    // `createScenario` always appends, so this cannot miss; the fallback keeps
    // the type honest without an assertion.
    return forked ?? { id, name, description: '', moves: [], colorSlot: 2 }
  }

  return {
    status: 'loading',
    error: null,
    catalog: null,
    scenarios: initial.scenarios,
    activeScenarioId: initial.activeScenarioId,
    compareScenarioId: null,
    filters: initial.filters,
    theme: initial.theme,
    selection: {},
    zoom: 'globe',
    canUndo: false,
    canRedo: false,
    runtimeMs: 0,
    undoLabel: null,
    redoLabel: null,
    notices: [],
    usingFallback: false,
    timings: null,

    // --- filters & selection ------------------------------------------------

    setFilters: (patch) => {
      set((state) => {
        const next: Filters = { ...state.filters, ...patch }
        // A range that crosses itself is a dragging artefact, not an intent.
        if (next.toWeek < next.fromWeek) {
          const low = Math.min(next.fromWeek, next.toWeek)
          const high = Math.max(next.fromWeek, next.toWeek)
          next.fromWeek = low
          next.toWeek = high
        }
        const weeks = state.catalog?.time.weeks.length ?? FALLBACK_WEEK_COUNT
        next.fromWeek = Math.max(0, Math.min(next.fromWeek, weeks - 1))
        next.toWeek = Math.max(next.fromWeek, Math.min(next.toWeek, weeks - 1))
        return { filters: next }
      })
      persist()
    },

    resetFilters: () => {
      set((state) => ({
        filters: emptyFilters(state.catalog?.time.weeks.length ?? FALLBACK_WEEK_COUNT),
      }))
      persist()
    },

    setSelection: (patch) => {
      set((state) => ({ selection: { ...state.selection, ...patch } }))
    },

    setZoom: (zoom) => set({ zoom }),

    setTheme: (theme) => {
      applyTheme(theme)
      set({ theme })
      persist()
    },

    // --- moves --------------------------------------------------------------

    applyMove: (move, label) => {
      const scenario = writableScenario()
      moveSeq += 1
      const described = label ?? describeMove(move, catalogIndexes(get().catalog))
      const entry: ScenarioMove = {
        id: nextLocalId('mv'),
        label: described,
        enabled: true,
        seq: moveSeq,
        move,
      }
      const before = scenario.moves
      const after = [...before, entry]
      undoStack.push({
        label: described,
        before: { scenarioId: scenario.id, moves: before },
        after: { scenarioId: scenario.id, moves: after },
      })
      writeMoves(scenario.id, after)
      set(undoFlags())
      persist()
    },

    toggleMove: (moveId) => {
      const state = get()
      const scenario = state.scenarios.find((candidate) =>
        candidate.moves.some((entry) => entry.id === moveId),
      )
      if (scenario === undefined) return
      if (scenario.readonly === true) {
        pushNotice('The baseline has no moves to turn off.', 'info')
        return
      }
      const before = scenario.moves
      const after = before.map((entry) =>
        entry.id === moveId ? { ...entry, enabled: !entry.enabled } : entry,
      )
      const target = before.find((entry) => entry.id === moveId)
      const verb = target?.enabled === true ? 'Turn off' : 'Turn on'
      undoStack.push({
        label: `${verb} “${target?.label ?? 'move'}”`,
        before: { scenarioId: scenario.id, moves: before },
        after: { scenarioId: scenario.id, moves: after },
      })
      writeMoves(scenario.id, after)
      set(undoFlags())
      persist()
    },

    removeMove: (moveId) => {
      const state = get()
      const scenario = state.scenarios.find((candidate) =>
        candidate.moves.some((entry) => entry.id === moveId),
      )
      if (scenario === undefined) return
      if (scenario.readonly === true) return
      const before = scenario.moves
      const target = before.find((entry) => entry.id === moveId)
      const after = before.filter((entry) => entry.id !== moveId)
      undoStack.push({
        label: `Remove “${target?.label ?? 'move'}”`,
        before: { scenarioId: scenario.id, moves: before },
        after: { scenarioId: scenario.id, moves: after },
      })
      writeMoves(scenario.id, after)
      set(undoFlags())
      persist()
    },

    undo: () => {
      const entry = undoStack.undo()
      if (entry === null) return
      writeMoves(entry.before.scenarioId, entry.before.moves)
      // Undo must be *visible*. If the step happened in another scenario,
      // switching to it is the only way the planner sees what came back.
      set({ activeScenarioId: entry.before.scenarioId, ...undoFlags() })
      persist()
    },

    redo: () => {
      const entry = undoStack.redo()
      if (entry === null) return
      writeMoves(entry.after.scenarioId, entry.after.moves)
      set({ activeScenarioId: entry.after.scenarioId, ...undoFlags() })
      persist()
    },

    // --- scenarios ----------------------------------------------------------

    setActiveScenario: (id) => {
      if (scenarioById(id) === undefined) return
      set((state) => ({
        activeScenarioId: id,
        compareScenarioId: state.compareScenarioId === id ? null : state.compareScenarioId,
      }))
      persist()
    },

    setCompareScenario: (id) => {
      if (id !== null && scenarioById(id) === undefined) return
      set((state) => ({ compareScenarioId: id === state.activeScenarioId ? null : id }))
      persist()
    },

    createScenario: (name, description, cloneFrom) => {
      const state = get()
      const source = cloneFrom === undefined ? undefined : scenarioById(cloneFrom)
      const id = nextLocalId('sc')
      // Slot 1 belongs to the baseline for the life of the app; new scenarios
      // walk 2..5 so a comparison never reuses the baseline's colour.
      const slotIndex = state.scenarios.filter(
        (scenario) => scenario.id !== BASELINE_SCENARIO_ID,
      ).length
      const slots: Array<1 | 2 | 3 | 4 | 5> = [2, 3, 4, 5, 1]
      const colorSlot = slots[slotIndex % slots.length] ?? 2
      const moves: ScenarioMove[] = (source?.moves ?? []).map((entry) => {
        moveSeq += 1
        return { ...entry, id: nextLocalId('mv'), seq: moveSeq }
      })
      const created: Scenario = {
        id,
        name: name.trim() === '' ? `Scenario ${slotIndex + 1}` : name.trim(),
        description,
        moves,
        colorSlot,
      }
      set({ scenarios: [...state.scenarios, created], activeScenarioId: id })
      persist()
      return id
    },

    renameScenario: (id, name, description) => {
      if (id === BASELINE_SCENARIO_ID) return
      set((state) => ({
        scenarios: state.scenarios.map((scenario) =>
          scenario.id === id
            ? { ...scenario, name: name.trim() === '' ? scenario.name : name.trim(), description }
            : scenario,
        ),
      }))
      persist()
    },

    deleteScenario: (id) => {
      if (id === BASELINE_SCENARIO_ID) {
        pushNotice('The baseline cannot be deleted — it is what everything else is measured against.', 'warning')
        return
      }
      set((state) => {
        const scenarios = state.scenarios.filter((scenario) => scenario.id !== id)
        return {
          scenarios,
          activeScenarioId:
            state.activeScenarioId === id ? BASELINE_SCENARIO_ID : state.activeScenarioId,
          compareScenarioId: state.compareScenarioId === id ? null : state.compareScenarioId,
        }
      })
      persist()
    },

    // --- lifecycle ----------------------------------------------------------

    setReady: (catalog, timings, usingFallback) => {
      set((state) => {
        const weeks = catalog.time.weeks.length
        const filters: Filters = {
          ...state.filters,
          fromWeek: Math.max(0, Math.min(state.filters.fromWeek, weeks - 1)),
          toWeek: Math.max(0, Math.min(state.filters.toWeek, weeks - 1)),
        }
        // A restored range from a longer horizon would silently hide weeks.
        if (filters.toWeek <= filters.fromWeek) {
          filters.fromWeek = 0
          filters.toWeek = Math.max(0, weeks - 1)
        }
        return { status: 'ready', error: null, catalog, timings, usingFallback, filters }
      })
      if (usingFallback) {
        pushNotice(
          'The model is running on the main thread, so the interface may stutter while it works.',
          'warning',
        )
      }
    },

    setError: (message) => set({ status: 'error', error: message }),

    setRuntimeMs: (ms) => {
      if (get().runtimeMs === ms) return
      set({ runtimeMs: ms })
    },

    notify: (message, tone = 'info') => pushNotice(message, tone),

    dismissNotice: (id) =>
      set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
  }
})

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const BASELINE = baselineScenario()

/**
 * The scenario every screen reads. Falls back to the baseline rather than
 * returning `undefined`, because there is no sensible screen for "no scenario"
 * and every caller would otherwise repeat the same guard.
 */
export function useActiveScenario(): Scenario {
  return useUiStore(
    (state) => state.scenarios.find((scenario) => scenario.id === state.activeScenarioId) ?? BASELINE,
  )
}

/** The scenario being compared against, if any. */
export function useCompareScenario(): Scenario | null {
  return useUiStore((state) => {
    const id = state.compareScenarioId
    if (id === null) return null
    return state.scenarios.find((scenario) => scenario.id === id) ?? null
  })
}

/** Apply the persisted theme before the first paint. Called from `main.tsx`. */
export function initTheme(): void {
  applyTheme(useUiStore.getState().theme)
}
