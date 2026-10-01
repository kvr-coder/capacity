/**
 * The move form — one dialog that can author every variant of `Move`.
 *
 * Three decisions here are product decisions rather than form plumbing:
 *
 * 1. **Human units in, model units out.** A planner types `95` into a field
 *    labelled "%", never `0.95`. Every percentage field carries its unit on its
 *    face and the conversion happens once, on submit, in {@link buildMove}. The
 *    one field that is genuinely a multiplier — the plan scale — is still
 *    entered as a percentage of the current plan, because "x1.1" and "110%" are
 *    the same instruction and only one of them is misread as "×110".
 *
 * 2. **Every windowed variant gets the same two week controls.** A move that
 *    covers a period is authored the same way whatever it changes, so the
 *    reader never has to work out which of thirteen shapes they are looking at.
 *    Weeks are chosen by grid position with the ISO label beside them, which is
 *    what the model stores and what the calendar shows, at once.
 *
 * 3. **"Add a work center" is seeded from a sibling.** A machine that does not
 *    exist yet has no class, no features and no pools, and asking a planner to
 *    invent them is asking for a fiction. Picking the machine it is modelled on
 *    copies the class, the feature grant, both capacity pools and the cost rates
 *    — and every copied value is then editable, so the sibling is a starting
 *    point rather than a constraint.
 *
 * Ids are validated against the catalog the main thread actually holds. Material
 * ids are the exception: the 15,000 materials live in the worker by design, so a
 * material is typed as a code and the form says out loud that it cannot check it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CapacityPool,
  DowntimeEvent,
  DowntimeKind,
  DowntimeStatus,
  MaterialSelector,
  Move,
  OeeGlidePath,
  Region,
  WorkCenter,
} from '@/domain/types'
import { REGIONS } from '@/domain/types'
import { clamp } from '@/domain/lookup'
import { buildCeilings, resolveCeiling } from '@/domain/capacity'
import { DEFAULT_UTILISATION_CEILING } from '@/domain/engine'
import { describeMove } from '@/domain/moves'
import { pct, units, usd } from '@/lib/format'
import { Badge, Button, Chip, NumberField, Select, TextField, Toggle } from '@/components'
import type { SelectOption } from '@/components'
import { catalogIndexes, nextLocalId, useActiveScenario, useUiStore } from '@/state/store'
import { useResolvedRate } from '@/state/model'
import { poolOf, shiftPoolNow } from '@/routes/moveEditorDefaults'
import styles from '@/routes/MoveEditor.module.css'

// ---------------------------------------------------------------------------
// The twelve things a planner can do
// ---------------------------------------------------------------------------

/**
 * Form kinds, not move kinds. `downtime` covers both `downtimeUpsert` and
 * `downtimeRemove` because "plan an outage" and "take that outage back out" are
 * one decision wearing two shapes, and splitting them in the menu would make
 * the second one unfindable.
 */
type FormKind =
  | 'resourceMove'
  | 'oeeSet'
  | 'oeeGlide'
  | 'rateSet'
  | 'shiftChange'
  | 'downtime'
  | 'utilisationCeiling'
  | 'retrofit'
  | 'addWorkCenter'
  | 'wipTransfer'
  | 'planScale'
  | 'sourceSwitch'

const KIND_OPTIONS: Array<{ value: FormKind; label: string; blurb: string }> = [
  {
    value: 'resourceMove',
    label: 'Move load',
    blurb: 'Take a share of what one work center makes and give it to another for a period.',
  },
  {
    value: 'oeeSet',
    label: 'Set OEE',
    blurb: 'Hold overall equipment effectiveness at a value. Rate is a separate knob.',
  },
  {
    value: 'oeeGlide',
    label: 'OEE ramp plan',
    blurb: 'Improve OEE along a dated path, because improvement programmes ramp.',
  },
  {
    value: 'rateSet',
    label: 'Set run rate',
    blurb: 'Override the routing rate for one SKU on one work center. OEE is untouched.',
  },
  {
    value: 'shiftChange',
    label: 'Change shifts',
    blurb: 'Change how a pool is manned or run — machines, shifts, hours, days.',
  },
  {
    value: 'downtime',
    label: 'Downtime event',
    blurb: 'A dated, planned loss. Unplanned loss lives inside OEE and has no date.',
  },
  {
    value: 'utilisationCeiling',
    label: 'Utilisation ceiling',
    blurb: 'The line above which load reads as overload even when the hours exist.',
  },
  {
    value: 'retrofit',
    label: 'Retrofit a machine',
    blurb: 'Buy a work center new features, for money and a lead time.',
  },
  {
    value: 'addWorkCenter',
    label: 'Add a work center',
    blurb: 'Stand up a machine that does not exist yet, modelled on one that does.',
  },
  {
    value: 'wipTransfer',
    label: 'WIP transfer',
    blurb: 'Ship a semi-finished material between plants, with freight and transit.',
  },
  {
    value: 'planScale',
    label: 'Scale a plan',
    blurb: 'Raise or cut the supply or demand plan for a slice of the catalogue.',
  },
  {
    value: 'sourceSwitch',
    label: 'Switch source',
    blurb: 'Stop making something at one plant and start at another, on a date.',
  },
]

const SELECTOR_KINDS: Array<{ value: MaterialSelector['kind']; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'family', label: 'A product family' },
  { value: 'group', label: 'A product group' },
  { value: 'material', label: 'One SKU' },
]

const DOWNTIME_KINDS: DowntimeKind[] = [
  'shutdown',
  'project',
  'qualification',
  'maintenance',
  'installation',
  'changeover',
]

const DOWNTIME_KIND_LABEL: Record<DowntimeKind, string> = {
  shutdown: 'Shutdown — collective vacation or seasonal close',
  project: 'Project — capex install, line move, IT cutover',
  qualification: 'Qualification — PPAP, customer validation, trials',
  maintenance: 'Maintenance — planned preventive',
  installation: 'Installation — commissioning a new or retrofitted asset',
  changeover: 'Changeover — a planned major reconfiguration',
}

const DOWNTIME_STATUSES: DowntimeStatus[] = ['planned', 'confirmed', 'atRisk']

const DOWNTIME_STATUS_LABEL: Record<DowntimeStatus, string> = {
  planned: 'Planned',
  confirmed: 'Confirmed',
  atRisk: 'At risk',
}

type PoolChoice = CapacityPool | 'both'

// ---------------------------------------------------------------------------
// Bounds — the contract the validator enforces
// ---------------------------------------------------------------------------

const SHARE_MIN_PCT = 0
const SHARE_MAX_PCT = 100
const OEE_MIN = 0.05
const OEE_MAX = 0.98
const CEILING_MIN = 0.5
const CEILING_MAX = 1.2

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * Every field of every variant, flat.
 *
 * One object rather than a union means switching the kind Select keeps whatever
 * the planner already typed — changing your mind about *which* move you are
 * making should not throw away the weeks you just chose.
 */
interface Draft {
  kind: FormKind

  // shared window
  fromWeek: number
  toWeek: number

  // material selector
  selectorKind: MaterialSelector['kind']
  selectorFamilyId: string
  selectorGroupId: string
  selectorMaterialId: string

  // resourceMove
  fromWorkCenterId: string
  toWorkCenterId: string
  sharePct: number
  allowDualSource: boolean

  // oeeSet
  oeeScope: 'plant' | 'workCenter' | 'materialWorkCenter'
  oeePlantId: string
  oeeWorkCenterId: string
  oeeMaterialId: string
  oeePct: number
  oeeWindowed: boolean

  // oeeGlide
  glideScope: 'plant' | 'workCenter'
  glidePlantId: string
  glideWorkCenterId: string
  glideUseStart: boolean
  glideStartPct: number
  glideEndPct: number
  glideCurve: OeeGlidePath['curve']
  glideLabel: string

  // rateSet
  rateMaterialId: string
  rateWorkCenterId: string
  rateOpId: string
  ratePerHour: number

  // shiftChange
  shiftWorkCenterId: string
  shiftPool: CapacityPool
  shiftSetCount: boolean
  shiftCount: number
  shiftSetShifts: boolean
  shiftsPerDay: number
  shiftSetHours: boolean
  hoursPerShift: number
  shiftSetDays: boolean
  daysPerWeek: number

  // downtime
  downtimeRemoveMode: boolean
  downtimeEventId: string
  downtimeWorkCenterId: string
  downtimeKind: DowntimeKind
  downtimeStatus: DowntimeStatus
  downtimePools: PoolChoice
  downtimeBlockEntirely: boolean
  downtimeHoursPerWeek: number
  downtimeLabel: string
  downtimeSlipWeeks: number

  // utilisationCeiling
  ceilingScope: 'global' | 'plant' | 'workCenter'
  ceilingPlantId: string
  ceilingWorkCenterId: string
  ceilingPct: number

  // retrofit
  retrofitWorkCenterId: string
  retrofitId: string
  retrofitFromWeek: number

  // addWorkCenter
  newCode: string
  newName: string
  newPlantId: string
  cloneFromId: string
  newVintage: number
  newBaseOeePct: number
  newCapexUsd: number
  newAvailableFromWeek: number
  newCostRateUsdPerHour: number
  newCo2PerMachineHourKg: number
  newMachineCount: number
  newLabourCount: number

  // wipTransfer
  wipMaterialId: string
  wipFromPlantId: string
  wipToPlantId: string
  wipSharePct: number
  wipFreightUsd: number
  wipTransitWeeks: number

  // planScale
  planTarget: 'supply' | 'demand'
  planPlantId: string
  planRegion: string
  planFactorPct: number

  // sourceSwitch
  switchFromPlantId: string
  switchToPlantId: string
  switchWeek: number
  overlapWeeks: number
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function firstId(list: ReadonlyArray<{ id: string }>): string {
  const head = list[0]
  return head === undefined ? '' : head.id
}

function secondId(list: ReadonlyArray<{ id: string }>): string {
  const second = list[1]
  if (second !== undefined) return second.id
  return firstId(list)
}

function poolsOf(choice: PoolChoice): CapacityPool[] {
  return choice === 'both' ? ['machine', 'labour'] : [choice]
}

function poolChoiceOf(pools: readonly CapacityPool[]): PoolChoice {
  const machine = pools.includes('machine')
  const labour = pools.includes('labour')
  if (machine && labour) return 'both'
  return labour ? 'labour' : 'machine'
}

// ---------------------------------------------------------------------------
// Draft <-> Move
// ---------------------------------------------------------------------------

interface CatalogShape {
  plants: Array<{ id: string; code: string; city: string; region: Region; defaultOee: number }>
  workCenters: WorkCenter[]
  families: Array<{ id: string; code: string; name: string }>
  groups: Array<{ id: string; code: string; name: string }>
  operations: Array<{ id: string; code: string; name: string }>
  weekCount: number
  /**
   * The ceilings the ACTIVE scenario resolves to, most specific winning.
   *
   * Unlike OEE this needs no worker round trip: `buildCeilings` reads the
   * scenario's own `utilisationCeiling` moves, and the main thread holds the
   * scenario. So there is no excuse for the form to show a policy number that
   * is not the line currently being drawn.
   */
  ceilings: ReturnType<typeof buildCeilings>
  /** Baseline resolved OEE, work center x week. See `CatalogPayload.baselineOee`. */
  resolvedOee: { rowOf: Map<string, number>; weekCount: number; values: Float64Array } | null
}

/**
 * What the scope a glide path covers runs at TODAY, as a percentage — the mean
 * of the work centers' own `baseOee` for a plant, or the one work center's.
 *
 * This is what the "start from a stated OEE" field must default to. It used to
 * default to a hardcoded 70, which at a plant running near 80 produced a path
 * captioned "from 70.0% to 98.0%" that LOWERED OEE for the first third of the
 * horizon while reading like an improvement.
 *
 * It is the BASE of the cascade, not the resolved value: the catalog the main
 * thread holds carries plants and work centers but no `oeeOverrides` and no
 * `glidePaths`, so the exact resolved OEE for a given week is not knowable
 * here. Good to a couple of points, which is enough to stop the trap. The
 * engine's own regression warning is the exact check.
 */
function plantDefaultOee(catalog: CatalogShape, plantId: string): number {
  return catalog.plants.find((plant) => plant.id === plantId)?.defaultOee ?? 0.75
}

/** The one work center's OEE in `week`, resolved if the worker sent the grid. */
function oeeOf(catalog: CatalogShape, workCenterId: string, week: number): number | undefined {
  const grid = catalog.resolvedOee
  if (grid !== null) {
    const row = grid.rowOf.get(workCenterId)
    if (row !== undefined && grid.weekCount > 0) {
      const w = Math.min(Math.max(Math.round(week), 0), grid.weekCount - 1)
      const value = grid.values[row * grid.weekCount + w]
      if (value !== undefined && value > 0) return value
    }
  }
  const wc = catalog.workCenters.find((entry) => entry.id === workCenterId)
  if (wc === undefined) return undefined
  return wc.baseOee > 0 ? wc.baseOee : plantDefaultOee(catalog, wc.plantId)
}

function plantMeanOee(catalog: CatalogShape, plantId: string, week: number): number {
  const centers = catalog.workCenters.filter((wc) => wc.plantId === plantId)
  if (centers.length === 0) return plantDefaultOee(catalog, plantId)
  let sum = 0
  let n = 0
  for (const wc of centers) {
    const value = oeeOf(catalog, wc.id, week)
    if (value === undefined) continue
    sum += value
    n += 1
  }
  return n === 0 ? plantDefaultOee(catalog, plantId) : sum / n
}

/**
 * What the scope a glide covers RESOLVES to today, in whole percent — the work
 * center's own value, or the mean across a plant, read at the ramp's first
 * week because that is the week the start value replaces.
 *
 * This is what the "start from a stated OEE" field auto-fetches. It used to be
 * a hardcoded 70, which at a plant running near 80 produced a path captioned
 * "from 70.0% to 98.0%" that LOWERED OEE for the first third of the horizon
 * while reading like an improvement. Overriding it downward is still allowed
 * and unclamped — an ageing asset or a learning curve is a real forecast — but
 * it can no longer happen by accident.
 */
function scopeOeePct(draft: Draft, catalog: CatalogShape): number {
  const week = draft.fromWeek
  const value =
    draft.glideScope === 'workCenter'
      ? (oeeOf(catalog, draft.glideWorkCenterId, week) ?? 0.75)
      : plantMeanOee(catalog, draft.glidePlantId, week)
  return Math.round(value * 100)
}

/**
 * What OEE the scope of an `oeeSet` move resolves to TODAY, in whole percent.
 *
 * `oeeSet` states a value; the value it replaces is this one. Defaulting the
 * field to the first work center in the catalog — which is what it did — meant
 * that pointing the form at any other machine, or at a plant, showed a number
 * belonging to a machine the planner had not selected.
 *
 * A material-scoped OEE is quoted at its work center: a per-SKU override lives
 * in the worker and cannot be read here, so this is the value that SKU
 * inherits unless one already exists. Close, and never from the wrong asset.
 */
function scopeSetOeePct(draft: Draft, catalog: CatalogShape): number {
  const week = draft.oeeWindowed ? draft.fromWeek : 0
  const value =
    draft.oeeScope === 'plant'
      ? plantMeanOee(catalog, draft.oeePlantId, week)
      : (oeeOf(catalog, draft.oeeWorkCenterId, week) ?? 0.75)
  return Math.round(value * 100)
}

/**
 * The utilisation ceiling the chosen scope resolves to TODAY, in whole percent.
 *
 * 95% was a policy target standing in for a current value. The two are not the
 * same: the engine's own default is 100%, and a scenario that has already
 * lowered the network to 92% would be handed 95% — a RISE — by a form whose
 * field reads as "the line that is drawn today".
 */
function scopeCeilingPct(draft: Draft, catalog: CatalogShape): number {
  const ceilings = catalog.ceilings
  if (draft.ceilingScope === 'workCenter') {
    const wc = catalog.workCenters.find((entry) => entry.id === draft.ceilingWorkCenterId)
    if (wc !== undefined) return Math.round(resolveCeiling(ceilings, wc) * 100)
  }
  if (draft.ceilingScope === 'plant') {
    return Math.round((ceilings.byPlant.get(draft.ceilingPlantId) ?? ceilings.global) * 100)
  }
  return Math.round(ceilings.global * 100)
}

function blankDraft(catalog: CatalogShape): Draft {
  const lastWeek = Math.max(0, catalog.weekCount - 1)
  const firstWc = catalog.workCenters[0]
  const secondWc = catalog.workCenters[1] ?? firstWc
  const plantId = firstId(catalog.plants)
  return {
    kind: 'resourceMove',
    fromWeek: 0,
    toWeek: lastWeek,

    selectorKind: 'group',
    selectorFamilyId: firstId(catalog.families),
    selectorGroupId: firstId(catalog.groups),
    selectorMaterialId: '',

    fromWorkCenterId: firstWc?.id ?? '',
    toWorkCenterId: secondWc?.id ?? '',
    sharePct: 100,
    allowDualSource: false,

    oeeScope: 'workCenter',
    oeePlantId: plantId,
    oeeWorkCenterId: firstWc?.id ?? '',
    oeeMaterialId: '',
    // Where the default scope (one work center) actually resolves today, not
    // that work center's `baseOee` and never another machine's.
    oeePct: Math.round((oeeOf(catalog, firstWc?.id ?? '', 0) ?? firstWc?.baseOee ?? 0.75) * 100),
    oeeWindowed: false,

    glideScope: 'plant',
    glidePlantId: plantId,
    glideWorkCenterId: firstWc?.id ?? '',
    glideUseStart: false,
    // Never a hardcoded number: a start below where the scope runs today is a
    // regression wearing an improvement's label. Recomputed whenever the toggle
    // is switched on, since the scope can change under it.
    glideStartPct: Math.round(plantMeanOee(catalog, plantId, 0) * 100),
    glideEndPct: 82,
    glideCurve: 'sCurve',
    glideLabel: 'OEE improvement programme',

    rateMaterialId: '',
    rateWorkCenterId: firstWc?.id ?? '',
    rateOpId: firstId(catalog.operations),
    // NOT a number. The rate for a (SKU, work center, operation) lives in the
    // worker — routings, production versions, overrides and OEE all do — so the
    // form cannot know it at construction time and must not pretend to. It used
    // to say 100 eaches/hour against real rates spanning 150–3000. Zero shows
    // as empty-of-meaning, fails validation, and is replaced the moment
    // `useResolvedRate` answers for the triple actually selected.
    ratePerHour: 0,

    shiftWorkCenterId: firstWc?.id ?? '',
    shiftPool: 'labour',
    shiftSetCount: false,
    shiftCount: poolOf(firstWc, 'labour').count,
    shiftSetShifts: true,
    shiftsPerDay: poolOf(firstWc, 'labour').shiftsPerDay,
    shiftSetHours: false,
    hoursPerShift: poolOf(firstWc, 'labour').hoursPerShift,
    shiftSetDays: false,
    daysPerWeek: poolOf(firstWc, 'labour').daysPerWeek,

    downtimeRemoveMode: false,
    downtimeEventId: '',
    downtimeWorkCenterId: firstWc?.id ?? '',
    downtimeKind: 'maintenance',
    downtimeStatus: 'planned',
    downtimePools: 'machine',
    downtimeBlockEntirely: false,
    downtimeHoursPerWeek: 24,
    downtimeLabel: 'Planned maintenance',
    downtimeSlipWeeks: 0,

    ceilingScope: 'global',
    ceilingPlantId: plantId,
    ceilingWorkCenterId: firstWc?.id ?? '',
    ceilingPct: Math.round(catalog.ceilings.global * 100),

    retrofitWorkCenterId: firstWc?.id ?? '',
    retrofitId: '',
    retrofitFromWeek: 0,

    newCode: '',
    newName: '',
    newPlantId: firstWc?.plantId ?? plantId,
    cloneFromId: firstWc?.id ?? '',
    newVintage: 2026,
    newBaseOeePct: Math.round((firstWc?.baseOee ?? 0.78) * 100),
    newCapexUsd: 2_500_000,
    newAvailableFromWeek: Math.min(26, lastWeek),
    newCostRateUsdPerHour: firstWc?.costRateUsdPerHour ?? 90,
    newCo2PerMachineHourKg: firstWc?.co2PerMachineHourKg ?? 12,
    newMachineCount: poolOf(firstWc, 'machine').count,
    newLabourCount: poolOf(firstWc, 'labour').count,

    wipMaterialId: '',
    wipFromPlantId: plantId,
    wipToPlantId: secondId(catalog.plants),
    wipSharePct: 50,
    wipFreightUsd: 1.4,
    wipTransitWeeks: 3,

    planTarget: 'supply',
    planPlantId: '',
    planRegion: '',
    planFactorPct: 110,

    switchFromPlantId: plantId,
    switchToPlantId: secondId(catalog.plants),
    switchWeek: Math.min(26, lastWeek),
    overlapWeeks: 4,
  }
}

/** Fold an existing move back into the flat draft, leaving every other field at its default. */
function draftFromMove(move: Move, catalog: CatalogShape): Draft {
  const draft = blankDraft(catalog)
  switch (move.kind) {
    case 'resourceMove':
      return {
        ...draft,
        kind: 'resourceMove',
        selectorKind: move.selector.kind,
        selectorFamilyId:
          move.selector.kind === 'family' ? (move.selector.id ?? '') : draft.selectorFamilyId,
        selectorGroupId:
          move.selector.kind === 'group' ? (move.selector.id ?? '') : draft.selectorGroupId,
        selectorMaterialId:
          move.selector.kind === 'material' ? (move.selector.id ?? '') : draft.selectorMaterialId,
        fromWorkCenterId: move.fromWorkCenterId,
        toWorkCenterId: move.toWorkCenterId,
        fromWeek: move.fromWeek,
        toWeek: move.toWeek,
        sharePct: move.share * 100,
        allowDualSource: move.allowDualSource,
      }
    case 'oeeSet':
      return {
        ...draft,
        kind: 'oeeSet',
        oeeScope: move.scope,
        oeePlantId: move.plantId ?? draft.oeePlantId,
        oeeWorkCenterId: move.workCenterId ?? draft.oeeWorkCenterId,
        oeeMaterialId: move.materialId ?? '',
        oeePct: move.value * 100,
        oeeWindowed: move.fromWeek !== undefined || move.toWeek !== undefined,
        fromWeek: move.fromWeek ?? draft.fromWeek,
        toWeek: move.toWeek ?? draft.toWeek,
      }
    case 'oeeGlide': {
      const glide: Draft = {
        ...draft,
        kind: 'oeeGlide',
        glideScope: move.path.scope,
        glidePlantId: move.path.plantId ?? draft.glidePlantId,
        glideWorkCenterId: move.path.workCenterId ?? draft.glideWorkCenterId,
        glideUseStart: move.path.startValue !== undefined,
        // No stated start on the move being edited: park the field on where the
        // scope runs today, never on a hardcoded number the planner would then
        // be one click away from committing.
        glideStartPct: (move.path.startValue ?? 0) * 100,
        glideEndPct: move.path.endValue * 100,
        glideCurve: move.path.curve,
        glideLabel: move.path.label,
        fromWeek: move.path.fromWeek,
        toWeek: move.path.toWeek,
      }
      if (move.path.startValue === undefined) glide.glideStartPct = scopeOeePct(glide, catalog)
      return glide
    }
    case 'rateSet':
      return {
        ...draft,
        kind: 'rateSet',
        rateMaterialId: move.materialId,
        rateWorkCenterId: move.workCenterId,
        rateOpId: move.opId,
        ratePerHour: move.ratePerHour,
      }
    case 'shiftChange': {
      // The fields this move does not set still have to READ as the pool it
      // targets, not as the first work center in the catalog — which is what
      // `draft` carries. A planner opening an existing shift move must see the
      // machine they are looking at.
      const now = shiftPoolNow(catalog.workCenters, move.workCenterId, move.pool)
      return {
        ...draft,
        kind: 'shiftChange',
        shiftWorkCenterId: move.workCenterId,
        shiftPool: move.pool,
        fromWeek: move.fromWeek,
        toWeek: move.toWeek,
        shiftSetCount: move.count !== undefined,
        shiftCount: move.count ?? now.count,
        shiftSetShifts: move.shiftsPerDay !== undefined,
        shiftsPerDay: move.shiftsPerDay ?? now.shiftsPerDay,
        shiftSetHours: move.hoursPerShift !== undefined,
        hoursPerShift: move.hoursPerShift ?? now.hoursPerShift,
        shiftSetDays: move.daysPerWeek !== undefined,
        daysPerWeek: move.daysPerWeek ?? now.daysPerWeek,
      }
    }
    case 'downtimeUpsert':
      return {
        ...draft,
        kind: 'downtime',
        downtimeRemoveMode: false,
        downtimeEventId: move.event.id,
        downtimeWorkCenterId: move.event.workCenterId,
        downtimeKind: move.event.kind,
        downtimeStatus: move.event.status,
        downtimePools: poolChoiceOf(move.event.pools),
        downtimeBlockEntirely: move.event.hoursPerWeek === undefined,
        downtimeHoursPerWeek: move.event.hoursPerWeek ?? draft.downtimeHoursPerWeek,
        downtimeLabel: move.event.label,
        downtimeSlipWeeks: move.event.slipWeeks ?? 0,
        fromWeek: move.event.fromWeek,
        toWeek: move.event.toWeek,
      }
    case 'downtimeRemove':
      return { ...draft, kind: 'downtime', downtimeRemoveMode: true, downtimeEventId: move.eventId }
    case 'utilisationCeiling':
      return {
        ...draft,
        kind: 'utilisationCeiling',
        ceilingScope: move.scope,
        ceilingPlantId: move.plantId ?? draft.ceilingPlantId,
        ceilingWorkCenterId: move.workCenterId ?? draft.ceilingWorkCenterId,
        ceilingPct: move.ceiling * 100,
      }
    case 'retrofit':
      return {
        ...draft,
        kind: 'retrofit',
        retrofitWorkCenterId: move.workCenterId,
        retrofitId: move.retrofitId,
        retrofitFromWeek: move.availableFromWeek,
      }
    case 'addWorkCenter': {
      const wc = move.workCenter
      return {
        ...draft,
        kind: 'addWorkCenter',
        newCode: wc.code,
        newName: wc.name,
        newPlantId: wc.plantId,
        cloneFromId: wc.clonedFromId ?? draft.cloneFromId,
        newVintage: wc.vintage,
        newBaseOeePct: wc.baseOee * 100,
        newCapexUsd: move.capexUsd,
        newAvailableFromWeek: wc.availableFromWeek ?? 0,
        newCostRateUsdPerHour: wc.costRateUsdPerHour,
        newCo2PerMachineHourKg: wc.co2PerMachineHourKg,
        newMachineCount: poolOf(wc, 'machine').count,
        newLabourCount: poolOf(wc, 'labour').count,
      }
    }
    case 'wipTransfer':
      return {
        ...draft,
        kind: 'wipTransfer',
        wipMaterialId: move.materialId,
        wipFromPlantId: move.fromPlantId,
        wipToPlantId: move.toPlantId,
        wipSharePct: move.share * 100,
        wipFreightUsd: move.freightCostPerUnitUsd,
        wipTransitWeeks: move.transitWeeks,
        fromWeek: move.fromWeek,
        toWeek: move.toWeek,
      }
    case 'planScale':
      return {
        ...draft,
        kind: 'planScale',
        planTarget: move.plan,
        planPlantId: move.plantId ?? '',
        planRegion: move.region ?? '',
        planFactorPct: move.factor * 100,
        selectorKind: move.selector.kind,
        selectorFamilyId:
          move.selector.kind === 'family' ? (move.selector.id ?? '') : draft.selectorFamilyId,
        selectorGroupId:
          move.selector.kind === 'group' ? (move.selector.id ?? '') : draft.selectorGroupId,
        selectorMaterialId:
          move.selector.kind === 'material' ? (move.selector.id ?? '') : draft.selectorMaterialId,
        fromWeek: move.fromWeek,
        toWeek: move.toWeek,
      }
    case 'sourceSwitch':
      return {
        ...draft,
        kind: 'sourceSwitch',
        switchFromPlantId: move.fromPlantId,
        switchToPlantId: move.toPlantId,
        switchWeek: move.switchWeek,
        overlapWeeks: move.overlapWeeks,
        selectorKind: move.selector.kind,
        selectorFamilyId:
          move.selector.kind === 'family' ? (move.selector.id ?? '') : draft.selectorFamilyId,
        selectorGroupId:
          move.selector.kind === 'group' ? (move.selector.id ?? '') : draft.selectorGroupId,
        selectorMaterialId:
          move.selector.kind === 'material' ? (move.selector.id ?? '') : draft.selectorMaterialId,
      }
  }
}

function selectorOf(draft: Draft): MaterialSelector {
  switch (draft.selectorKind) {
    case 'family':
      return { kind: 'family', id: draft.selectorFamilyId }
    case 'group':
      return { kind: 'group', id: draft.selectorGroupId }
    case 'material':
      return { kind: 'material', id: draft.selectorMaterialId.trim() }
    default:
      return { kind: 'all' }
  }
}

/** Field key -> message. An empty map is a valid draft. */
type Errors = Record<string, string>

interface Built {
  move: Move | null
  errors: Errors
}

/**
 * Turn the draft into a `Move`, or into the reasons it is not one yet.
 *
 * Percentages divide by 100 exactly here and nowhere else, so there is one place
 * to look when a number on screen and a number in the model disagree.
 */
function buildMove(
  draft: Draft,
  catalog: CatalogShape,
  existingId: string | null,
  /**
   * The canonical material id for the rate form's typed SKU, once the worker
   * has resolved it. A planner types a CODE, because a code is what is printed
   * on a router, but `rateSet` is keyed by material ID — an override stored
   * under a code matches nothing and silently does nothing. Empty until the
   * quote answers, in which case the typed text is stored as-is, exactly as
   * before.
   */
  resolvedRateMaterialId: string,
): Built {
  const errors: Errors = {}
  const lastWeek = Math.max(0, catalog.weekCount - 1)

  const plantIds = new Set(catalog.plants.map((plant) => plant.id))
  const wcById = new Map(catalog.workCenters.map((wc) => [wc.id, wc]))
  const familyIds = new Set(catalog.families.map((entry) => entry.id))
  const groupIds = new Set(catalog.groups.map((entry) => entry.id))
  const opIds = new Set(catalog.operations.map((entry) => entry.id))

  const week = (value: number): number => clamp(Math.round(value), 0, lastWeek)
  const requirePlant = (field: string, id: string): void => {
    if (!plantIds.has(id)) errors[field] = `No plant with id “${id}” is in this dataset.`
  }
  const requireWorkCenter = (field: string, id: string): void => {
    if (!wcById.has(id)) errors[field] = `No work center with id “${id}” is in this dataset.`
  }
  const requireWindow = (): void => {
    if (draft.fromWeek > draft.toWeek) {
      errors['toWeek'] = 'The last week cannot come before the first.'
    }
  }
  const requireSelector = (): MaterialSelector => {
    const selector = selectorOf(draft)
    if (selector.kind === 'family' && !familyIds.has(selector.id ?? '')) {
      errors['selector'] = 'Pick a product family that exists in this dataset.'
    }
    if (selector.kind === 'group' && !groupIds.has(selector.id ?? '')) {
      errors['selector'] = 'Pick a product group that exists in this dataset.'
    }
    if (selector.kind === 'material' && (selector.id ?? '') === '') {
      errors['selector'] = 'Type the SKU code this move targets.'
    }
    return selector
  }
  const requireShare = (field: string, value: number): number => {
    if (!Number.isFinite(value) || value < SHARE_MIN_PCT || value > SHARE_MAX_PCT) {
      errors[field] = `A share is between ${SHARE_MIN_PCT}% and ${SHARE_MAX_PCT}%.`
    }
    return clamp(value, SHARE_MIN_PCT, SHARE_MAX_PCT) / 100
  }
  const requireOee = (field: string, valuePct: number): number => {
    const value = valuePct / 100
    if (!Number.isFinite(value) || value < OEE_MIN || value > OEE_MAX) {
      errors[field] = `OEE runs from ${pct(OEE_MIN, 0)} to ${pct(OEE_MAX, 0)}.`
    }
    return clamp(value, OEE_MIN, OEE_MAX)
  }

  const fail = (): Built => ({ move: null, errors })

  switch (draft.kind) {
    case 'resourceMove': {
      const selector = requireSelector()
      requireWorkCenter('fromWorkCenterId', draft.fromWorkCenterId)
      requireWorkCenter('toWorkCenterId', draft.toWorkCenterId)
      if (draft.fromWorkCenterId === draft.toWorkCenterId) {
        errors['toWorkCenterId'] = 'Load cannot move to the work center it is already on.'
      }
      const share = requireShare('sharePct', draft.sharePct)
      requireWindow()
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'resourceMove',
          selector,
          fromWorkCenterId: draft.fromWorkCenterId,
          toWorkCenterId: draft.toWorkCenterId,
          fromWeek: week(draft.fromWeek),
          toWeek: week(draft.toWeek),
          share,
          allowDualSource: draft.allowDualSource,
        },
        errors,
      }
    }

    case 'oeeSet': {
      const value = requireOee('oeePct', draft.oeePct)
      if (draft.oeeScope === 'plant') requirePlant('oeePlantId', draft.oeePlantId)
      else requireWorkCenter('oeeWorkCenterId', draft.oeeWorkCenterId)
      if (draft.oeeScope === 'materialWorkCenter' && draft.oeeMaterialId.trim() === '') {
        errors['oeeMaterialId'] = 'A material-scoped OEE needs the SKU code it applies to.'
      }
      if (draft.oeeWindowed) requireWindow()
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'oeeSet',
          scope: draft.oeeScope,
          plantId: draft.oeeScope === 'plant' ? draft.oeePlantId : undefined,
          workCenterId: draft.oeeScope === 'plant' ? undefined : draft.oeeWorkCenterId,
          materialId:
            draft.oeeScope === 'materialWorkCenter' ? draft.oeeMaterialId.trim() : undefined,
          value,
          fromWeek: draft.oeeWindowed ? week(draft.fromWeek) : undefined,
          toWeek: draft.oeeWindowed ? week(draft.toWeek) : undefined,
        },
        errors,
      }
    }

    case 'oeeGlide': {
      const endValue = requireOee('glideEndPct', draft.glideEndPct)
      const startValue = draft.glideUseStart
        ? requireOee('glideStartPct', draft.glideStartPct)
        : undefined
      if (draft.glideScope === 'plant') requirePlant('glidePlantId', draft.glidePlantId)
      else requireWorkCenter('glideWorkCenterId', draft.glideWorkCenterId)
      if (draft.glideLabel.trim() === '') {
        errors['glideLabel'] = 'Name the programme — this label is what the ramp is called on screen.'
      }
      requireWindow()
      if (Object.keys(errors).length > 0) return fail()
      const path: OeeGlidePath = {
        id: existingId ?? nextLocalId('glide'),
        scope: draft.glideScope,
        plantId: draft.glideScope === 'plant' ? draft.glidePlantId : undefined,
        workCenterId: draft.glideScope === 'workCenter' ? draft.glideWorkCenterId : undefined,
        fromWeek: week(draft.fromWeek),
        toWeek: week(draft.toWeek),
        startValue,
        endValue,
        curve: draft.glideCurve,
        label: draft.glideLabel.trim(),
      }
      return { move: { kind: 'oeeGlide', path }, errors }
    }

    case 'rateSet': {
      if (draft.rateMaterialId.trim() === '') {
        errors['rateMaterialId'] = 'A rate override applies to one SKU — type its code.'
      }
      requireWorkCenter('rateWorkCenterId', draft.rateWorkCenterId)
      if (!opIds.has(draft.rateOpId)) {
        errors['rateOpId'] = 'Pick a standard operation that exists in this dataset.'
      }
      if (!Number.isFinite(draft.ratePerHour) || draft.ratePerHour <= 0) {
        errors['ratePerHour'] = 'A run rate is greater than zero units per hour.'
      }
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'rateSet',
          materialId:
            resolvedRateMaterialId !== '' ? resolvedRateMaterialId : draft.rateMaterialId.trim(),
          workCenterId: draft.rateWorkCenterId,
          opId: draft.rateOpId,
          ratePerHour: draft.ratePerHour,
        },
        errors,
      }
    }

    case 'shiftChange': {
      requireWorkCenter('shiftWorkCenterId', draft.shiftWorkCenterId)
      requireWindow()
      const nothing =
        !draft.shiftSetCount && !draft.shiftSetShifts && !draft.shiftSetHours && !draft.shiftSetDays
      if (nothing) {
        errors['shiftChange'] = 'Change at least one of the four — otherwise this move does nothing.'
      }
      if (draft.shiftSetCount && draft.shiftCount < 0) {
        errors['shiftCount'] = 'A count cannot be negative.'
      }
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'shiftChange',
          workCenterId: draft.shiftWorkCenterId,
          pool: draft.shiftPool,
          fromWeek: week(draft.fromWeek),
          toWeek: week(draft.toWeek),
          count: draft.shiftSetCount ? draft.shiftCount : undefined,
          shiftsPerDay: draft.shiftSetShifts ? draft.shiftsPerDay : undefined,
          hoursPerShift: draft.shiftSetHours ? draft.hoursPerShift : undefined,
          daysPerWeek: draft.shiftSetDays ? draft.daysPerWeek : undefined,
        },
        errors,
      }
    }

    case 'downtime': {
      if (draft.downtimeRemoveMode) {
        if (draft.downtimeEventId.trim() === '') {
          errors['downtimeEventId'] = 'Name the event id to take out of the plan.'
        }
        if (Object.keys(errors).length > 0) return fail()
        return { move: { kind: 'downtimeRemove', eventId: draft.downtimeEventId.trim() }, errors }
      }
      requireWorkCenter('downtimeWorkCenterId', draft.downtimeWorkCenterId)
      requireWindow()
      if (draft.downtimeLabel.trim() === '') {
        errors['downtimeLabel'] = 'Name the event — this is what shows on the week that is blocked.'
      }
      if (!draft.downtimeBlockEntirely && draft.downtimeHoursPerWeek <= 0) {
        errors['downtimeHoursPerWeek'] =
          'Remove more than zero hours a week, or block the pool entirely.'
      }
      if (Object.keys(errors).length > 0) return fail()
      const event: DowntimeEvent = {
        id: existingId ?? nextLocalId('dt'),
        workCenterId: draft.downtimeWorkCenterId,
        kind: draft.downtimeKind,
        status: draft.downtimeStatus,
        fromWeek: week(draft.fromWeek),
        toWeek: week(draft.toWeek),
        pools: poolsOf(draft.downtimePools),
        hoursPerWeek: draft.downtimeBlockEntirely ? undefined : draft.downtimeHoursPerWeek,
        label: draft.downtimeLabel.trim(),
        slipWeeks: draft.downtimeStatus === 'atRisk' ? draft.downtimeSlipWeeks : undefined,
      }
      return { move: { kind: 'downtimeUpsert', event }, errors }
    }

    case 'utilisationCeiling': {
      const ceiling = draft.ceilingPct / 100
      if (!Number.isFinite(ceiling) || ceiling < CEILING_MIN || ceiling > CEILING_MAX) {
        errors['ceilingPct'] = `A ceiling runs from ${pct(CEILING_MIN, 0)} to ${pct(CEILING_MAX, 0)}.`
      }
      if (draft.ceilingScope === 'plant') requirePlant('ceilingPlantId', draft.ceilingPlantId)
      if (draft.ceilingScope === 'workCenter') {
        requireWorkCenter('ceilingWorkCenterId', draft.ceilingWorkCenterId)
      }
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'utilisationCeiling',
          scope: draft.ceilingScope,
          plantId: draft.ceilingScope === 'plant' ? draft.ceilingPlantId : undefined,
          workCenterId:
            draft.ceilingScope === 'workCenter' ? draft.ceilingWorkCenterId : undefined,
          ceiling: clamp(ceiling, CEILING_MIN, CEILING_MAX),
        },
        errors,
      }
    }

    case 'retrofit': {
      requireWorkCenter('retrofitWorkCenterId', draft.retrofitWorkCenterId)
      if (draft.retrofitId === '') {
        errors['retrofitId'] = 'Pick a retrofit this machine’s class actually offers.'
      }
      if (draft.retrofitFromWeek < 0 || draft.retrofitFromWeek > lastWeek) {
        errors['retrofitFromWeek'] = 'The available-from week is outside the horizon.'
      }
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'retrofit',
          workCenterId: draft.retrofitWorkCenterId,
          retrofitId: draft.retrofitId,
          availableFromWeek: week(draft.retrofitFromWeek),
        },
        errors,
      }
    }

    case 'addWorkCenter': {
      const sibling = wcById.get(draft.cloneFromId)
      if (sibling === undefined) {
        errors['cloneFromId'] = 'Pick the machine this one is modelled on — it seeds class and pools.'
      }
      requirePlant('newPlantId', draft.newPlantId)
      if (draft.newCode.trim() === '') errors['newCode'] = 'Give the work center a code.'
      if (draft.newName.trim() === '') errors['newName'] = 'Give the work center a name.'
      const baseOee = requireOee('newBaseOeePct', draft.newBaseOeePct)
      if (draft.newCapexUsd < 0) errors['newCapexUsd'] = 'Capex cannot be negative.'
      if (draft.newMachineCount <= 0) errors['newMachineCount'] = 'A new asset needs at least one machine.'
      if (draft.newLabourCount <= 0) errors['newLabourCount'] = 'A new asset needs at least one operator.'
      if (Object.keys(errors).length > 0 || sibling === undefined) return fail()
      const machine = poolOf(sibling, 'machine')
      const labour = poolOf(sibling, 'labour')
      const workCenter: WorkCenter = {
        id: existingId ?? nextLocalId('wc'),
        plantId: draft.newPlantId,
        code: draft.newCode.trim(),
        name: draft.newName.trim(),
        classId: sibling.classId,
        vintage: Math.round(draft.newVintage),
        pools: [
          { ...machine, pool: 'machine', count: Math.round(draft.newMachineCount) },
          { ...labour, pool: 'labour', count: Math.round(draft.newLabourCount) },
        ],
        features: [...sibling.features],
        baseOee,
        status: 'proposed',
        clonedFromId: sibling.id,
        availableFromWeek: week(draft.newAvailableFromWeek),
        costRateUsdPerHour: draft.newCostRateUsdPerHour,
        co2PerMachineHourKg: draft.newCo2PerMachineHourKg,
      }
      return { move: { kind: 'addWorkCenter', workCenter, capexUsd: draft.newCapexUsd }, errors }
    }

    case 'wipTransfer': {
      if (draft.wipMaterialId.trim() === '') {
        errors['wipMaterialId'] = 'A WIP transfer moves one semi-finished material — type its code.'
      }
      requirePlant('wipFromPlantId', draft.wipFromPlantId)
      requirePlant('wipToPlantId', draft.wipToPlantId)
      if (draft.wipFromPlantId === draft.wipToPlantId) {
        errors['wipToPlantId'] = 'WIP has to arrive somewhere other than where it left.'
      }
      const share = requireShare('wipSharePct', draft.wipSharePct)
      if (draft.wipFreightUsd < 0) errors['wipFreightUsd'] = 'Freight cannot be negative.'
      if (draft.wipTransitWeeks < 0) errors['wipTransitWeeks'] = 'Transit cannot be negative.'
      requireWindow()
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'wipTransfer',
          materialId: draft.wipMaterialId.trim(),
          fromPlantId: draft.wipFromPlantId,
          toPlantId: draft.wipToPlantId,
          fromWeek: week(draft.fromWeek),
          toWeek: week(draft.toWeek),
          share,
          freightCostPerUnitUsd: draft.wipFreightUsd,
          transitWeeks: Math.round(draft.wipTransitWeeks),
        },
        errors,
      }
    }

    case 'planScale': {
      const selector = requireSelector()
      if (draft.planTarget === 'supply' && draft.planPlantId !== '') {
        requirePlant('planPlantId', draft.planPlantId)
      }
      const factor = draft.planFactorPct / 100
      if (!Number.isFinite(factor) || factor < 0) {
        errors['planFactorPct'] = 'Scale to zero or more percent of the current plan.'
      }
      requireWindow()
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'planScale',
          plan: draft.planTarget,
          selector,
          plantId: draft.planTarget === 'supply' && draft.planPlantId !== '' ? draft.planPlantId : undefined,
          region:
            draft.planTarget === 'demand' && draft.planRegion !== ''
              ? (draft.planRegion as Region)
              : undefined,
          fromWeek: week(draft.fromWeek),
          toWeek: week(draft.toWeek),
          factor,
        },
        errors,
      }
    }

    case 'sourceSwitch': {
      const selector = requireSelector()
      requirePlant('switchFromPlantId', draft.switchFromPlantId)
      requirePlant('switchToPlantId', draft.switchToPlantId)
      if (draft.switchFromPlantId === draft.switchToPlantId) {
        errors['switchToPlantId'] = 'A source switch has to land at a different plant.'
      }
      if (draft.switchWeek < 0 || draft.switchWeek > lastWeek) {
        errors['switchWeek'] = 'The switch week is outside the horizon.'
      }
      if (draft.overlapWeeks < 0) errors['overlapWeeks'] = 'Parallel run cannot be negative.'
      if (Object.keys(errors).length > 0) return fail()
      return {
        move: {
          kind: 'sourceSwitch',
          selector,
          fromPlantId: draft.switchFromPlantId,
          toPlantId: draft.switchToPlantId,
          switchWeek: week(draft.switchWeek),
          overlapWeeks: Math.round(draft.overlapWeeks),
        },
        errors,
      }
    }
  }
}

/** The id an edited move already owns, so re-saving does not orphan it. */
function idOf(move: Move | undefined): string | null {
  if (move === undefined) return null
  if (move.kind === 'oeeGlide') return move.path.id
  if (move.kind === 'downtimeUpsert') return move.event.id
  if (move.kind === 'addWorkCenter') return move.workCenter.id
  return null
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface MoveEditorProps {
  initial?: Move
  onSubmit(label: string, move: Move): void
  onCancel(): void
}

export function MoveEditor({ initial, onSubmit, onCancel }: MoveEditorProps) {
  const catalogPayload = useUiStore((state) => state.catalog)
  const scenario = useActiveScenario()

  const catalog = useMemo<CatalogShape>(
    () => ({
      plants: (catalogPayload?.plants ?? []).map((plant) => ({
        id: plant.id,
        code: plant.code,
        city: plant.city,
        region: plant.region,
        defaultOee: plant.defaultOee,
      })),
      workCenters: catalogPayload?.workCenters ?? [],
      families: catalogPayload?.families ?? [],
      groups: catalogPayload?.groups ?? [],
      operations: catalogPayload?.standardOperations ?? [],
      weekCount: catalogPayload?.time.weeks.length ?? 0,
      // Read off the scenario being edited, so the ceiling the form starts from
      // is the one the moves already in the log have left in place.
      ceilings: buildCeilings(scenario, DEFAULT_UTILISATION_CEILING),
      resolvedOee:
        catalogPayload?.baselineOee === undefined
          ? null
          : {
              rowOf: new Map(catalogPayload.baselineOee.workCenterIds.map((id, i) => [id, i])),
              weekCount: catalogPayload.baselineOee.weekCount,
              values: catalogPayload.baselineOee.values,
            },
    }),
    [catalogPayload, scenario],
  )

  const classById = useMemo(
    () => new Map((catalogPayload?.machineClasses ?? []).map((entry) => [entry.id, entry])),
    [catalogPayload],
  )
  const featureNameById = useMemo(
    () => new Map((catalogPayload?.features ?? []).map((entry) => [entry.id, entry.name])),
    [catalogPayload],
  )

  const existingId = useMemo(() => idOf(initial), [initial])
  const [draft, setDraft] = useState<Draft>(() =>
    initial === undefined ? blankDraft(catalog) : draftFromMove(initial, catalog),
  )
  const [labelDraft, setLabelDraft] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)

  const patch = useCallback((next: Partial<Draft>) => {
    setDraft((prior) => ({ ...prior, ...next }))
  }, [])

  /**
   * Change what an `oeeSet` move points at, and RE-FETCH the value it is
   * replacing. Same trap as the glide start value, one field along: the number
   * on screen must belong to the scope now selected.
   */
  const patchOeeScope = useCallback(
    (next: Partial<Draft>) => {
      setDraft((prior) => {
        const merged = { ...prior, ...next }
        return { ...merged, oeePct: scopeSetOeePct(merged, catalog) }
      })
    },
    [catalog],
  )

  /** Change what a ceiling move points at, and re-read the ceiling drawn there. */
  const patchCeilingScope = useCallback(
    (next: Partial<Draft>) => {
      setDraft((prior) => {
        const merged = { ...prior, ...next }
        return { ...merged, ceilingPct: scopeCeilingPct(merged, catalog) }
      })
    },
    [catalog],
  )

  /**
   * Change what a glide path points at, and RE-FETCH the start value for the
   * new scope. Retargeting a plant ramp at a different plant, or switching
   * plant/work-center scope, changes what "today's OEE" means — leaving the
   * previous site's number in the field is the same trap as the hardcoded 70,
   * just harder to spot. A start the planner typed themselves is left alone
   * only when the toggle is off, because then the field is not in play.
   */
  const patchGlideScope = useCallback(
    (next: Partial<Draft>) => {
      setDraft((prior) => {
        const merged = { ...prior, ...next }
        if (!merged.glideUseStart) return merged
        return { ...merged, glideStartPct: scopeOeePct(merged, catalog) }
      })
    },
    [catalog],
  )

  /**
   * Change which pool the shift form points at, and RE-READ all four numbers
   * from it.
   *
   * The four fields are current values, not new ones, so the only honest thing
   * to show after a selection change is what the newly selected pool runs at
   * now. Overwriting whatever was in them is deliberate: a number typed for the
   * previous work center describes the previous work center, and leaving it
   * behind is precisely how another machine's shift pattern gets applied to
   * this one. The four "change this" toggles are left alone — which of the four
   * knobs a planner intends to turn does not change when they change machine.
   */
  const patchShiftScope = useCallback(
    (next: Partial<Draft>) => {
      setDraft((prior) => {
        const merged = { ...prior, ...next }
        const now = shiftPoolNow(catalog.workCenters, merged.shiftWorkCenterId, merged.shiftPool)
        return {
          ...merged,
          shiftCount: now.count,
          shiftsPerDay: now.shiftsPerDay,
          hoursPerShift: now.hoursPerShift,
          daysPerWeek: now.daysPerWeek,
        }
      })
    },
    [catalog],
  )

  /** What the selected pool runs at today — the caption under the four fields. */
  const shiftNow = useMemo(
    () => shiftPoolNow(catalog.workCenters, draft.shiftWorkCenterId, draft.shiftPool),
    [catalog, draft.shiftWorkCenterId, draft.shiftPool],
  )

  // --- the current run rate, fetched from the worker ------------------------

  /**
   * The rate for a (SKU, work center, operation) cannot be resolved on this
   * thread — the routings, the production versions, the overrides and the OEE
   * cascade are all in the worker. So it is asked for, and re-asked whenever
   * any of the three selections changes.
   */
  const rateKey = `${draft.rateMaterialId.trim()}|${draft.rateWorkCenterId}|${draft.rateOpId}`
  const rateQuery = useResolvedRate(
    draft.kind === 'rateSet' ? draft.rateMaterialId : '',
    draft.rateWorkCenterId,
    draft.rateOpId,
    draft.fromWeek,
  )
  /**
   * The selection at which the planner last typed a rate themselves. Their
   * number survives everything except pointing the form at a different triple,
   * at which point it describes something they are no longer editing. An
   * existing move opens as "already typed": the saved rate is the planner's.
   */
  const [rateEditedKey, setRateEditedKey] = useState<string | null>(() =>
    initial?.kind === 'rateSet' ? rateKey : null,
  )
  const rateEdited = rateEditedKey === rateKey
  const rateQuote = rateQuery.data

  /**
   * The canonical id behind the code the planner typed, and only when the
   * answer demonstrably belongs to what is in the field right now — matching
   * the text against the quote is what makes a stale in-flight answer
   * unusable rather than merely unlikely.
   */
  const typedMaterial = draft.rateMaterialId.trim()
  const resolvedRateMaterialId =
    rateQuote !== null &&
    rateQuote.status === 'resolved' &&
    rateQuote.materialId !== null &&
    (rateQuote.materialId === typedMaterial || rateQuote.materialCode === typedMaterial)
      ? rateQuote.materialId
      : ''

  useEffect(() => {
    if (rateEdited) return
    // Unresolved is shown as unresolved. Holding the previous triple's rate, or
    // falling back to a constant, is the whole bug.
    const fetched =
      rateQuote !== null && rateQuote.status === 'resolved' && rateQuote.ratePerHour !== null
        ? rateQuote.ratePerHour
        : 0
    setDraft((prior) => (prior.ratePerHour === fetched ? prior : { ...prior, ratePerHour: fetched }))
  }, [rateQuote, rateEdited])

  /**
   * What the field says about where its number came from.
   *
   * Naming the resolved value, and naming it as NOMINAL, is half the fix: a
   * planner who can see 850 units/hour cannot be handed 100 without noticing.
   * When nothing resolves, this says so rather than letting a stale or invented
   * number stand in.
   */
  const rateHint = ((): string => {
    if (draft.rateMaterialId.trim() === '') {
      return 'Nominal eaches per hour, before OEE. Name the SKU and the rate it currently runs at here is fetched from master data.'
    }
    if (rateQuery.error !== null) {
      return `The current rate could not be fetched (${rateQuery.error}). Type the rate you intend; nothing has been guessed for you.`
    }
    if (rateQuote === null) return 'Fetching the rate this SKU currently runs at here…'
    switch (rateQuote.status) {
      case 'unknownMaterial':
        return 'No SKU with that code or id is in this dataset, so there is no current rate to start from. Check the code — an override on a SKU that does not exist changes nothing.'
      case 'noOperation':
        return 'This SKU has no routing operation at that work center for that operation, so it does not run there today and there is no current rate to change.'
      case 'noRate':
        return 'The routing carries no usable rate for this SKU here, so there is nothing to start from. Whatever you type is the whole of the rate.'
      case 'resolved': {
        const nominal = rateQuote.ratePerHour ?? 0
        const effective = rateQuote.effectiveRatePerHour ?? 0
        const oee = rateQuote.oee
        const source = rateQuote.fromOverride
          ? ' That current value is itself an existing rate override.'
          : ''
        const staleWarning = rateEdited
          ? ` It currently runs at ${units(nominal)} units/hour nominal.`
          : ` Auto-fetched: ${units(nominal)} units/hour.`
        return (
          `Nominal — before OEE.${staleWarning} After OEE${oee === null ? '' : ` of ${pct(oee, 0)}`}` +
          ` it produces ${units(effective)} units/hour, which is the number the shop floor observes.` +
          ` Set the nominal one here.${source}`
        )
      }
    }
  })()

  /** The machine the shift block is pointed at, for the caption above it. */
  const shiftLabel =
    catalog.workCenters.find((wc) => wc.id === draft.shiftWorkCenterId)?.code ??
    'This work center'

  const built = useMemo(
    () => buildMove(draft, catalog, existingId, resolvedRateMaterialId),
    [draft, catalog, existingId, resolvedRateMaterialId],
  )

  const indexes = useMemo(() => catalogIndexes(catalogPayload), [catalogPayload])
  const autoLabel = useMemo(
    () => (built.move === null ? '' : describeMove(built.move, indexes)),
    [built.move, indexes],
  )
  const label = labelDraft ?? autoLabel

  // --- option lists ---------------------------------------------------------

  const weekOptions = useMemo<SelectOption[]>(() => {
    const weeks = catalogPayload?.time.weeks ?? []
    return weeks.map((iso, index) => ({ value: String(index), label: `W${index} · ${iso}` }))
  }, [catalogPayload])

  const plantOptions = useMemo<SelectOption[]>(
    () =>
      catalog.plants.map((plant) => ({
        value: plant.id,
        label: `${plant.code} · ${plant.city} (${plant.region})`,
      })),
    [catalog.plants],
  )

  const workCenterOptions = useMemo<SelectOption[]>(
    () =>
      catalog.workCenters.map((wc) => ({
        value: wc.id,
        label: `${wc.code} · ${wc.name}${wc.status === 'proposed' ? ' (proposed)' : ''}`,
      })),
    [catalog.workCenters],
  )

  const familyOptions = useMemo<SelectOption[]>(
    () => catalog.families.map((f) => ({ value: f.id, label: `${f.code} — ${f.name}` })),
    [catalog.families],
  )

  const groupOptions = useMemo<SelectOption[]>(
    () => catalog.groups.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` })),
    [catalog.groups],
  )

  const operationOptions = useMemo<SelectOption[]>(
    () => catalog.operations.map((op) => ({ value: op.id, label: `${op.code} — ${op.name}` })),
    [catalog.operations],
  )

  const retrofitTarget = catalog.workCenters.find((wc) => wc.id === draft.retrofitWorkCenterId)
  const retrofitOptions = useMemo<SelectOption[]>(() => {
    const cls = retrofitTarget === undefined ? undefined : classById.get(retrofitTarget.classId)
    const list = cls?.retrofits ?? []
    if (list.length === 0) return [{ value: '', label: 'This machine class offers no retrofits' }]
    return [
      { value: '', label: 'Choose a retrofit…' },
      ...list.map((option) => ({
        value: option.id,
        label: `${option.name} — ${usd(option.capexUsd, { compact: true })}, ${option.leadTimeWeeks} week lead`,
      })),
    ]
  }, [retrofitTarget, classById])

  const sibling = catalog.workCenters.find((wc) => wc.id === draft.cloneFromId)
  const siblingClass = sibling === undefined ? undefined : classById.get(sibling.classId)

  const errors = showErrors ? built.errors : {}
  const errorList = Object.entries(built.errors)

  const kindMeta = KIND_OPTIONS.find((entry) => entry.value === draft.kind)

  // --- shared blocks --------------------------------------------------------

  const weekWindow = (
    <div className={styles.row}>
      <Select
        label="From week"
        value={String(draft.fromWeek)}
        options={weekOptions}
        onChange={(value) => patch({ fromWeek: Number(value) })}
      />
      <Select
        label="To week"
        value={String(draft.toWeek)}
        options={weekOptions}
        onChange={(value) => patch({ toWeek: Number(value) })}
      />
      {errors['toWeek'] === undefined ? null : (
        <p className={styles.rowError}>{errors['toWeek']}</p>
      )}
    </div>
  )

  const selectorBlock = (
    <div className={styles.row}>
      <Select
        label="What this applies to"
        value={draft.selectorKind}
        options={SELECTOR_KINDS}
        onChange={(value) => patch({ selectorKind: value as MaterialSelector['kind'] })}
      />
      {draft.selectorKind === 'family' ? (
        <Select
          label="Product family"
          value={draft.selectorFamilyId}
          options={familyOptions}
          onChange={(value) => patch({ selectorFamilyId: value })}
        />
      ) : null}
      {draft.selectorKind === 'group' ? (
        <Select
          label="Product group"
          value={draft.selectorGroupId}
          options={groupOptions}
          onChange={(value) => patch({ selectorGroupId: value })}
        />
      ) : null}
      {draft.selectorKind === 'material' ? (
        <TextField
          label="SKU code"
          value={draft.selectorMaterialId}
          onChange={(value) => patch({ selectorMaterialId: value })}
          placeholder="e.g. FG-1042-08"
          error={errors['selector']}
          hint="The 15,000 materials live in the worker, so this code is not checked here."
        />
      ) : null}
      {draft.selectorKind !== 'material' && errors['selector'] !== undefined ? (
        <p className={styles.rowError}>{errors['selector']}</p>
      ) : null}
    </div>
  )

  // --- submit ---------------------------------------------------------------

  const submit = (): void => {
    if (built.move === null) {
      setShowErrors(true)
      return
    }
    const finalLabel = label.trim() === '' ? autoLabel : label.trim()
    onSubmit(finalLabel, built.move)
  }

  if (catalogPayload === null) {
    return (
      <div className={styles.form}>
        <p className={styles.note}>
          Master data has not arrived yet, so there is nothing to author a move against.
        </p>
        <div className={styles.actions}>
          <Button onClick={onCancel}>Close</Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.form}>
      <Select
        label="What kind of change is this?"
        value={draft.kind}
        options={KIND_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => {
          patch({ kind: value as FormKind })
          setShowErrors(false)
        }}
        hint={kindMeta?.blurb}
      />

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'resourceMove' ? (
        <>
          {selectorBlock}
          <div className={styles.row}>
            <Select
              label="Off this work center"
              value={draft.fromWorkCenterId}
              options={workCenterOptions}
              onChange={(value) => patch({ fromWorkCenterId: value })}
            />
            <Select
              label="On to this one"
              value={draft.toWorkCenterId}
              options={workCenterOptions}
              onChange={(value) => patch({ toWorkCenterId: value })}
            />
            {errors['fromWorkCenterId'] ?? errors['toWorkCenterId'] ? (
              <p className={styles.rowError}>
                {errors['fromWorkCenterId'] ?? errors['toWorkCenterId']}
              </p>
            ) : null}
          </div>
          {weekWindow}
          <div className={styles.row}>
            <NumberField
              label="Share of the source volume"
              suffix="%"
              value={draft.sharePct}
              min={SHARE_MIN_PCT}
              max={SHARE_MAX_PCT}
              step={5}
              onChange={(value) => patch({ sharePct: value })}
              error={errors['sharePct']}
              hint="100% moves everything the source makes in these weeks."
            />
          </div>
          <Toggle
            label="Allow dual sourcing in a bucket"
            checked={draft.allowDualSource}
            onChange={(checked) => patch({ allowDualSource: checked })}
            hint="Off rejects any week that would end up with two sources. Dual sourcing is not a transfer — different approvals, different risk."
          />
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'oeeSet' ? (
        <>
          <div className={styles.row}>
            <Select
              label="Scope"
              value={draft.oeeScope}
              options={[
                { value: 'plant', label: 'Every work center at a plant' },
                { value: 'workCenter', label: 'One work center' },
                { value: 'materialWorkCenter', label: 'One SKU on one work center' },
              ]}
              onChange={(value) => patchOeeScope({ oeeScope: value as Draft['oeeScope'] })}
              hint="OEE resolves plant → work center → SKU × work center, most specific winning."
            />
            {draft.oeeScope === 'plant' ? (
              <Select
                label="Plant"
                value={draft.oeePlantId}
                options={plantOptions}
                onChange={(value) => patchOeeScope({ oeePlantId: value })}
              />
            ) : (
              <Select
                label="Work center"
                value={draft.oeeWorkCenterId}
                options={workCenterOptions}
                onChange={(value) => patchOeeScope({ oeeWorkCenterId: value })}
              />
            )}
          </div>
          {draft.oeeScope === 'materialWorkCenter' ? (
            <TextField
              label="SKU code"
              value={draft.oeeMaterialId}
              onChange={(value) => patch({ oeeMaterialId: value })}
              error={errors['oeeMaterialId']}
              hint="Not checked here — the material master lives in the worker."
            />
          ) : null}
          <div className={styles.row}>
            <NumberField
              label="OEE"
              suffix="%"
              value={draft.oeePct}
              min={OEE_MIN * 100}
              max={OEE_MAX * 100}
              step={1}
              onChange={(value) => patch({ oeePct: value })}
              error={errors['oeePct']}
              hint={`Auto-fetched from what this scope resolves to today (${scopeSetOeePct(draft, catalog)}%), and re-read whenever you change the scope. Between ${pct(OEE_MIN, 0)} and ${pct(OEE_MAX, 0)}. Rate is a separate knob — this does not touch it.`}
            />
          </div>
          <Toggle
            label="Only for a window of weeks"
            checked={draft.oeeWindowed}
            onChange={(checked) => patch({ oeeWindowed: checked })}
            hint="Off applies the value across the whole horizon."
          />
          {draft.oeeWindowed ? weekWindow : null}
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'oeeGlide' ? (
        <>
          <div className={styles.row}>
            <Select
              label="Scope"
              value={draft.glideScope}
              options={[
                { value: 'plant', label: 'Every work center at a plant' },
                { value: 'workCenter', label: 'One work center' },
              ]}
              onChange={(value) => patchGlideScope({ glideScope: value as Draft['glideScope'] })}
            />
            {draft.glideScope === 'plant' ? (
              <Select
                label="Plant"
                value={draft.glidePlantId}
                options={plantOptions}
                onChange={(value) => patchGlideScope({ glidePlantId: value })}
              />
            ) : (
              <Select
                label="Work center"
                value={draft.glideWorkCenterId}
                options={workCenterOptions}
                onChange={(value) => patchGlideScope({ glideWorkCenterId: value })}
              />
            )}
          </div>
          {weekWindow}
          <Toggle
            label="Start from a stated OEE"
            checked={draft.glideUseStart}
            onChange={(checked) =>
              patch(
                // Switching it ON parks the field on where this scope runs
                // TODAY. Anything else — a hardcoded 70, say — hands the planner
                // a ramp that lowers the early weeks while its label reads as an
                // improvement.
                checked
                  ? { glideUseStart: true, glideStartPct: scopeOeePct(draft, catalog) }
                  : { glideUseStart: false },
              )
            }
            hint="Off starts the ramp from whatever OEE resolves in the first week."
          />
          <div className={styles.row}>
            {draft.glideUseStart ? (
              <NumberField
                label="OEE at the first week"
                suffix="%"
                value={draft.glideStartPct}
                min={OEE_MIN * 100}
                max={OEE_MAX * 100}
                step={1}
                onChange={(value) => patch({ glideStartPct: value })}
                error={errors['glideStartPct']}
                hint={
                  // Non-blocking on purpose. Forecasting a DECLINE — an ageing
                  // asset, a learning curve, known tooling degradation — is a
                  // real planning case and must stay available. What must not
                  // happen is a planner modelling one by accident.
                  draft.glideStartPct < scopeOeePct(draft, catalog) - 0.5
                    ? `Auto-fetched ${scopeOeePct(draft, catalog)}% — this scope’s currently resolved OEE. You have set ${draft.glideStartPct}%, a STEP DOWN from it: the ramp will lower OEE before it raises it. That is allowed; it is called out so it is never a surprise.`
                    : `Auto-fetched from this scope’s currently resolved OEE (${scopeOeePct(draft, catalog)}%). Change it freely — including downward, to model a decline.`
                }
              />
            ) : null}
            <NumberField
              label="OEE reached and held"
              suffix="%"
              value={draft.glideEndPct}
              min={OEE_MIN * 100}
              max={OEE_MAX * 100}
              step={1}
              onChange={(value) => patch({ glideEndPct: value })}
              error={errors['glideEndPct']}
            />
            <Select
              label="Shape"
              value={draft.glideCurve}
              options={[
                { value: 'sCurve', label: 'S-curve — slow, fast, slow' },
                { value: 'linear', label: 'Linear — even every week' },
                { value: 'step', label: 'Step — jumps at the last week' },
              ]}
              onChange={(value) => patch({ glideCurve: value as OeeGlidePath['curve'] })}
            />
          </div>
          <TextField
            label="Programme name"
            value={draft.glideLabel}
            onChange={(value) => patch({ glideLabel: value })}
            error={errors['glideLabel']}
            hint="This is what the ramp is called wherever it appears."
          />
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'rateSet' ? (
        <>
          <TextField
            label="SKU code"
            value={draft.rateMaterialId}
            onChange={(value) => patch({ rateMaterialId: value })}
            error={errors['rateMaterialId']}
            hint="A rate override is the most specific step of rate resolution — it beats the routing."
          />
          <div className={styles.row}>
            <Select
              label="Work center"
              value={draft.rateWorkCenterId}
              options={workCenterOptions}
              onChange={(value) => patch({ rateWorkCenterId: value })}
            />
            <Select
              label="Operation"
              value={draft.rateOpId}
              options={operationOptions}
              onChange={(value) => patch({ rateOpId: value })}
            />
          </div>
          <div className={styles.row}>
            <NumberField
              label="Run rate — NOMINAL, before OEE"
              suffix="units / hour"
              value={draft.ratePerHour}
              min={0}
              step={5}
              onChange={(value) => {
                setRateEditedKey(rateKey)
                patch({ ratePerHour: value })
              }}
              error={errors['ratePerHour']}
              hint={rateHint}
            />
          </div>
          <p className={styles.note}>
            This move sets the NOMINAL rate. What the machine is observed to
            produce is the EFFECTIVE rate — nominal × OEE — so the two differ by
            a fifth or so and typing an observed number here raises the rate
            twice over. OEE is a separate knob and this move does not touch it.
          </p>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'shiftChange' ? (
        <>
          <div className={styles.row}>
            <Select
              label="Work center"
              value={draft.shiftWorkCenterId}
              options={workCenterOptions}
              onChange={(value) => patchShiftScope({ shiftWorkCenterId: value })}
              hint="Changing this re-reads all four numbers below from the machine you pick."
            />
            <Select
              label="Which pool"
              value={draft.shiftPool}
              options={[
                { value: 'machine', label: 'Machine — the capex question' },
                { value: 'labour', label: 'Labour — the hiring question' },
              ]}
              onChange={(value) => patchShiftScope({ shiftPool: value as CapacityPool })}
            />
          </div>
          {weekWindow}
          {errors['shiftChange'] === undefined ? null : (
            <p className={styles.rowError}>{errors['shiftChange']}</p>
          )}
          <p className={styles.note}>
            {shiftLabel} runs {shiftNow.count}{' '}
            {draft.shiftPool === 'machine' ? 'machines' : 'operators'} ×{' '}
            {shiftNow.shiftsPerDay} shifts × {shiftNow.hoursPerShift} h ×{' '}
            {shiftNow.daysPerWeek} days today. The four fields below start from
            exactly that and are re-read whenever you change the machine or the
            pool.
          </p>
          <div className={styles.grid2}>
            <div className={styles.switchField}>
              <Toggle
                label={draft.shiftPool === 'machine' ? 'Change the machine count' : 'Change the operator count'}
                checked={draft.shiftSetCount}
                onChange={(checked) => patch({ shiftSetCount: checked })}
              />
              <NumberField
                label={draft.shiftPool === 'machine' ? 'Machines' : 'Operators'}
                suffix="count"
                value={draft.shiftCount}
                min={0}
                step={1}
                disabled={!draft.shiftSetCount}
                onChange={(value) => patch({ shiftCount: value })}
                error={errors['shiftCount']}
              />
            </div>
            <div className={styles.switchField}>
              <Toggle
                label="Change shifts per day"
                checked={draft.shiftSetShifts}
                onChange={(checked) => patch({ shiftSetShifts: checked })}
              />
              <NumberField
                label="Shifts per day"
                suffix="shifts"
                value={draft.shiftsPerDay}
                min={0}
                max={4}
                step={1}
                disabled={!draft.shiftSetShifts}
                onChange={(value) => patch({ shiftsPerDay: value })}
              />
            </div>
            <div className={styles.switchField}>
              <Toggle
                label="Change hours per shift"
                checked={draft.shiftSetHours}
                onChange={(checked) => patch({ shiftSetHours: checked })}
              />
              <NumberField
                label="Hours per shift"
                suffix="h"
                value={draft.hoursPerShift}
                min={0}
                max={24}
                step={0.5}
                disabled={!draft.shiftSetHours}
                onChange={(value) => patch({ hoursPerShift: value })}
              />
            </div>
            <div className={styles.switchField}>
              <Toggle
                label="Change days per week"
                checked={draft.shiftSetDays}
                onChange={(checked) => patch({ shiftSetDays: checked })}
              />
              <NumberField
                label="Days per week"
                suffix="days"
                value={draft.daysPerWeek}
                min={0}
                max={7}
                step={1}
                disabled={!draft.shiftSetDays}
                onChange={(value) => patch({ daysPerWeek: value })}
              />
            </div>
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'downtime' ? (
        <>
          <Toggle
            label="Take an existing event out of the plan instead"
            checked={draft.downtimeRemoveMode}
            onChange={(checked) => patch({ downtimeRemoveMode: checked })}
            hint="Removing needs only the event id — the Data screen’s Downtime tab lists them."
          />
          {draft.downtimeRemoveMode ? (
            <TextField
              label="Event id"
              value={draft.downtimeEventId}
              onChange={(value) => patch({ downtimeEventId: value })}
              error={errors['downtimeEventId']}
            />
          ) : (
            <>
              <div className={styles.row}>
                <Select
                  label="Work center"
                  value={draft.downtimeWorkCenterId}
                  options={workCenterOptions}
                  onChange={(value) => patch({ downtimeWorkCenterId: value })}
                  hint="Events are always work-center scoped, so there is one place to look when a week is blocked."
                />
                <Select
                  label="Kind"
                  value={draft.downtimeKind}
                  options={DOWNTIME_KINDS.map((kind) => ({
                    value: kind,
                    label: DOWNTIME_KIND_LABEL[kind],
                  }))}
                  onChange={(value) => patch({ downtimeKind: value as DowntimeKind })}
                />
              </div>
              {weekWindow}
              <div className={styles.row}>
                <Select
                  label="Status"
                  value={draft.downtimeStatus}
                  options={DOWNTIME_STATUSES.map((status) => ({
                    value: status,
                    label: DOWNTIME_STATUS_LABEL[status],
                  }))}
                  onChange={(value) => patch({ downtimeStatus: value as DowntimeStatus })}
                />
                <Select
                  label="Pools blocked"
                  value={draft.downtimePools}
                  options={[
                    { value: 'machine', label: 'Machine only' },
                    { value: 'labour', label: 'Labour only' },
                    { value: 'both', label: 'Both pools' },
                  ]}
                  onChange={(value) => patch({ downtimePools: value as PoolChoice })}
                  hint="Vacation hits labour; maintenance hits machine."
                />
                {draft.downtimeStatus === 'atRisk' ? (
                  <NumberField
                    label="Slip modelled"
                    suffix="weeks"
                    value={draft.downtimeSlipWeeks}
                    min={0}
                    step={1}
                    onChange={(value) => patch({ downtimeSlipWeeks: value })}
                  />
                ) : null}
              </div>
              <Toggle
                label="Block the pool entirely for these weeks"
                checked={draft.downtimeBlockEntirely}
                onChange={(checked) => patch({ downtimeBlockEntirely: checked })}
                hint="That is what a shutdown means. Otherwise state the hours removed each week."
              />
              {draft.downtimeBlockEntirely ? null : (
                <div className={styles.row}>
                  <NumberField
                    label="Hours removed each week"
                    suffix="h / week"
                    value={draft.downtimeHoursPerWeek}
                    min={0}
                    step={4}
                    onChange={(value) => patch({ downtimeHoursPerWeek: value })}
                    error={errors['downtimeHoursPerWeek']}
                  />
                </div>
              )}
              <TextField
                label="Event name"
                value={draft.downtimeLabel}
                onChange={(value) => patch({ downtimeLabel: value })}
                error={errors['downtimeLabel']}
              />
              <p className={styles.note}>
                Planned loss only. Unplanned loss lives inside OEE and has no date — giving it one
                would be a precise-looking lie.
              </p>
            </>
          )}
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'utilisationCeiling' ? (
        <>
          <div className={styles.row}>
            <Select
              label="Scope"
              value={draft.ceilingScope}
              options={[
                { value: 'global', label: 'The whole network' },
                { value: 'plant', label: 'One plant' },
                { value: 'workCenter', label: 'One work center' },
              ]}
              onChange={(value) =>
                patchCeilingScope({ ceilingScope: value as Draft['ceilingScope'] })
              }
            />
            {draft.ceilingScope === 'plant' ? (
              <Select
                label="Plant"
                value={draft.ceilingPlantId}
                options={plantOptions}
                onChange={(value) => patchCeilingScope({ ceilingPlantId: value })}
              />
            ) : null}
            {draft.ceilingScope === 'workCenter' ? (
              <Select
                label="Work center"
                value={draft.ceilingWorkCenterId}
                options={workCenterOptions}
                onChange={(value) => patchCeilingScope({ ceilingWorkCenterId: value })}
              />
            ) : null}
            <NumberField
              label="Ceiling"
              suffix="%"
              value={draft.ceilingPct}
              min={CEILING_MIN * 100}
              max={CEILING_MAX * 100}
              step={1}
              onChange={(value) => patch({ ceilingPct: value })}
              error={errors['ceilingPct']}
              hint={`This scope is at ${scopeCeilingPct(draft, catalog)}% today, which is where the field starts. Between ${pct(CEILING_MIN, 0)} and ${pct(CEILING_MAX, 0)}. Load above the ceiling reads as overload even when the hours exist.`}
            />
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'retrofit' ? (
        <>
          <div className={styles.row}>
            <Select
              label="Work center"
              value={draft.retrofitWorkCenterId}
              options={workCenterOptions}
              onChange={(value) => patch({ retrofitWorkCenterId: value, retrofitId: '' })}
            />
            <Select
              label="Retrofit"
              value={draft.retrofitId}
              options={retrofitOptions}
              onChange={(value) => patch({ retrofitId: value })}
            />
            <Select
              label="Features usable from week"
              value={String(draft.retrofitFromWeek)}
              options={weekOptions}
              onChange={(value) => patch({ retrofitFromWeek: Number(value) })}
            />
          </div>
          {errors['retrofitId'] === undefined ? null : (
            <p className={styles.rowError}>{errors['retrofitId']}</p>
          )}
          {retrofitTarget === undefined ? null : (
            <p className={styles.note}>
              {retrofitTarget.code} is a{' '}
              {classById.get(retrofitTarget.classId)?.name ?? retrofitTarget.classId}, generation{' '}
              {classById.get(retrofitTarget.classId)?.generation ?? '—'}. A retrofit grants features
              it was never told about — which is the whole point of holding the feature model
              alongside the allow-list.
            </p>
          )}
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'addWorkCenter' ? (
        <>
          <Select
            label="Copy features from"
            value={draft.cloneFromId}
            options={workCenterOptions}
            onChange={(value) => {
              const source = catalog.workCenters.find((wc) => wc.id === value)
              if (source === undefined) {
                patch({ cloneFromId: value })
                return
              }
              patch({
                cloneFromId: value,
                newPlantId: source.plantId,
                newBaseOeePct: Math.round(source.baseOee * 100),
                newCostRateUsdPerHour: source.costRateUsdPerHour,
                newCo2PerMachineHourKg: source.co2PerMachineHourKg,
                newMachineCount: poolOf(source, 'machine').count,
                newLabourCount: poolOf(source, 'labour').count,
              })
            }}
            hint="A machine that does not exist yet is seeded from one that does — its class, its feature grant and both capacity pools."
          />
          {sibling === undefined ? (
            <p className={styles.rowError}>{errors['cloneFromId'] ?? 'Pick a sibling machine.'}</p>
          ) : (
            <div className={styles.inherited}>
              <p className={styles.inheritedTitle}>
                Inherited from {sibling.code} · {sibling.name}
              </p>
              <p className={styles.inheritedLine}>
                <Badge tone="neutral" size="sm">
                  {siblingClass?.name ?? sibling.classId}
                </Badge>{' '}
                generation {siblingClass?.generation ?? '—'} · machine pool{' '}
                {poolOf(sibling, 'machine').shiftsPerDay} shifts ×{' '}
                {poolOf(sibling, 'machine').hoursPerShift} h ×{' '}
                {poolOf(sibling, 'machine').daysPerWeek} days · labour pool{' '}
                {poolOf(sibling, 'labour').shiftsPerDay} shifts ×{' '}
                {poolOf(sibling, 'labour').hoursPerShift} h ×{' '}
                {poolOf(sibling, 'labour').daysPerWeek} days
              </p>
              <div className={styles.chips}>
                {sibling.features.length === 0 ? (
                  <span className={styles.note}>This machine grants no features.</span>
                ) : (
                  sibling.features.map((featureId) => (
                    <Chip key={featureId} slot="other">
                      {featureNameById.get(featureId) ?? featureId}
                    </Chip>
                  ))
                )}
              </div>
            </div>
          )}

          <div className={styles.row}>
            <TextField
              label="Code"
              value={draft.newCode}
              onChange={(value) => patch({ newCode: value })}
              error={errors['newCode']}
              placeholder="e.g. WC-ING-902"
            />
            <TextField
              label="Name"
              value={draft.newName}
              onChange={(value) => patch({ newName: value })}
              error={errors['newName']}
              placeholder="e.g. Press line 902"
            />
            <Select
              label="Plant"
              value={draft.newPlantId}
              options={plantOptions}
              onChange={(value) => patch({ newPlantId: value })}
            />
          </div>

          <div className={styles.row}>
            <NumberField
              label="Machines in the group"
              suffix="count"
              value={draft.newMachineCount}
              min={1}
              step={1}
              onChange={(value) => patch({ newMachineCount: value })}
              error={errors['newMachineCount']}
            />
            <NumberField
              label="Operators on shift"
              suffix="count"
              value={draft.newLabourCount}
              min={1}
              step={1}
              onChange={(value) => patch({ newLabourCount: value })}
              error={errors['newLabourCount']}
            />
            <NumberField
              label="Base OEE"
              suffix="%"
              value={draft.newBaseOeePct}
              min={OEE_MIN * 100}
              max={OEE_MAX * 100}
              step={1}
              onChange={(value) => patch({ newBaseOeePct: value })}
              error={errors['newBaseOeePct']}
            />
          </div>

          <div className={styles.row}>
            <NumberField
              label="Commissioning year"
              suffix="vintage"
              value={draft.newVintage}
              min={1980}
              max={2060}
              step={1}
              onChange={(value) => patch({ newVintage: value })}
            />
            <Select
              label="Runs from week"
              value={String(draft.newAvailableFromWeek)}
              options={weekOptions}
              onChange={(value) => patch({ newAvailableFromWeek: Number(value) })}
            />
            <NumberField
              label="Capex to stand it up"
              suffix="USD"
              value={draft.newCapexUsd}
              min={0}
              step={100000}
              onChange={(value) => patch({ newCapexUsd: value })}
              error={errors['newCapexUsd']}
            />
          </div>

          <div className={styles.row}>
            <NumberField
              label="Machine cost rate"
              suffix="USD / h"
              value={draft.newCostRateUsdPerHour}
              min={0}
              step={5}
              onChange={(value) => patch({ newCostRateUsdPerHour: value })}
            />
            <NumberField
              label="Footprint"
              suffix="kg CO₂e / machine h"
              value={draft.newCo2PerMachineHourKg}
              min={0}
              step={1}
              onChange={(value) => patch({ newCo2PerMachineHourKg: value })}
            />
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'wipTransfer' ? (
        <>
          <TextField
            label="Semi-finished SKU code"
            value={draft.wipMaterialId}
            onChange={(value) => patch({ wipMaterialId: value })}
            error={errors['wipMaterialId']}
            hint="In plan mode this must be a HALB — a declared transfer point is the only place WIP may cross a plant boundary."
          />
          <div className={styles.row}>
            <Select
              label="Leaves"
              value={draft.wipFromPlantId}
              options={plantOptions}
              onChange={(value) => patch({ wipFromPlantId: value })}
            />
            <Select
              label="Arrives"
              value={draft.wipToPlantId}
              options={plantOptions}
              onChange={(value) => patch({ wipToPlantId: value })}
            />
            {errors['wipToPlantId'] === undefined ? null : (
              <p className={styles.rowError}>{errors['wipToPlantId']}</p>
            )}
          </div>
          {weekWindow}
          <div className={styles.row}>
            <NumberField
              label="Share shipped"
              suffix="%"
              value={draft.wipSharePct}
              min={SHARE_MIN_PCT}
              max={SHARE_MAX_PCT}
              step={5}
              onChange={(value) => patch({ wipSharePct: value })}
              error={errors['wipSharePct']}
            />
            <NumberField
              label="Freight"
              suffix="USD / unit"
              value={draft.wipFreightUsd}
              min={0}
              step={0.1}
              onChange={(value) => patch({ wipFreightUsd: value })}
              error={errors['wipFreightUsd']}
            />
            <NumberField
              label="In transit"
              suffix="weeks"
              value={draft.wipTransitWeeks}
              min={0}
              step={1}
              onChange={(value) => patch({ wipTransitWeeks: value })}
              error={errors['wipTransitWeeks']}
            />
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'planScale' ? (
        <>
          <div className={styles.row}>
            <Select
              label="Which plan"
              value={draft.planTarget}
              options={[
                { value: 'supply', label: 'Supply — the plan that loads capacity' },
                { value: 'demand', label: 'Demand — reference only, never loads capacity' },
              ]}
              onChange={(value) => patch({ planTarget: value as Draft['planTarget'] })}
            />
            {draft.planTarget === 'supply' ? (
              <Select
                label="At which plant"
                value={draft.planPlantId}
                options={[{ value: '', label: 'Every plant' }, ...plantOptions]}
                onChange={(value) => patch({ planPlantId: value })}
              />
            ) : (
              <Select
                label="In which region"
                value={draft.planRegion}
                options={[
                  { value: '', label: 'Every region' },
                  ...REGIONS.map((region) => ({ value: region, label: region })),
                ]}
                onChange={(value) => patch({ planRegion: value })}
              />
            )}
          </div>
          {selectorBlock}
          {weekWindow}
          <div className={styles.row}>
            <NumberField
              label="Scale to"
              suffix="% of the current plan"
              value={draft.planFactorPct}
              min={0}
              max={500}
              step={5}
              onChange={(value) => patch({ planFactorPct: value })}
              error={errors['planFactorPct']}
              hint="100% leaves the plan alone. 110% raises it by a tenth; 90% cuts it by a tenth."
            />
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {draft.kind === 'sourceSwitch' ? (
        <>
          {selectorBlock}
          <div className={styles.row}>
            <Select
              label="Stops here"
              value={draft.switchFromPlantId}
              options={plantOptions}
              onChange={(value) => patch({ switchFromPlantId: value })}
            />
            <Select
              label="Starts here"
              value={draft.switchToPlantId}
              options={plantOptions}
              onChange={(value) => patch({ switchToPlantId: value })}
            />
            {errors['switchToPlantId'] === undefined ? null : (
              <p className={styles.rowError}>{errors['switchToPlantId']}</p>
            )}
          </div>
          <div className={styles.row}>
            <Select
              label="Switch week"
              value={String(draft.switchWeek)}
              options={weekOptions}
              onChange={(value) => patch({ switchWeek: Number(value) })}
            />
            <NumberField
              label="Parallel run for qualification"
              suffix="weeks"
              value={draft.overlapWeeks}
              min={0}
              step={1}
              onChange={(value) => patch({ overlapWeeks: value })}
              error={errors['overlapWeeks']}
              hint="Zero is a clean cut. Anything above zero is dual sourcing during the overlap — a different approval from a transfer."
            />
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}

      <TextField
        label="Label on the decision log"
        value={label}
        onChange={(value) => setLabelDraft(value)}
        hint={
          labelDraft === null
            ? 'Written for you from the move itself. Type over it if a colleague needs more context.'
            : 'Your wording. Clear the field to go back to the generated one.'
        }
        placeholder={autoLabel}
      />

      {showErrors && errorList.length > 0 ? (
        <div className={styles.errorBox} role="alert">
          <p className={styles.errorTitle}>
            {errorList.length === 1
              ? 'One thing needs fixing before this move can be saved'
              : `${errorList.length} things need fixing before this move can be saved`}
          </p>
          <ul className={styles.errorList}>
            {errorList.map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" icon="check" onClick={submit}>
          {initial === undefined ? 'Add to the scenario' : 'Save the change'}
        </Button>
      </div>
    </div>
  )
}

export default MoveEditor
