/**
 * Sourcing resolution — which routing makes a material, in which week.
 *
 * The rule this file exists to enforce is a product requirement, not an
 * optimisation:
 *
 *   **In any one week a material has exactly one source**, unless dual
 *   sourcing was explicitly switched on for that move.
 *
 * The source is allowed to *change* between weeks — that is a **transfer**,
 * and it is legal by default. Two sources inside the *same* week is **dual
 * sourcing**, a different object with different approvals and different risk,
 * and it only happens when a planner asks for it. Blurring the two is the
 * mistake this module is built to make impossible.
 *
 * Storage is columnar and fixed-size. Because a bucket may hold at most two
 * sources, the result is two planes rather than a growable structure:
 *
 *     routingOfRow[plane * (rows * weeks) + row * weeks + week]
 *
 * Plane 0 is the primary source, plane 1 the secondary. `-1` means "nothing
 * produced here". Rows are `SnapshotIndexes.supplyRow`, i.e. the row order of
 * `Snapshot.supplyPlan`.
 *
 * Invariant the rest of the engine relies on: **for any (row, week) that has a
 * source at all, the shares across the two planes sum to exactly 1.** Sourcing
 * decides *where* volume is made, never *how much* — the supply plan owns the
 * quantity.
 */

import type {
  MaterialId,
  MaterialSelector,
  PlantId,
  Routing,
  RoutingId,
  Scenario,
  Snapshot,
  WeekIndex,
  WorkCenterId,
} from '@/domain/types'
import type { SnapshotIndexes } from '@/domain/indexes'
import { at, key } from '@/domain/lookup'

/** Sources permitted in one bucket. Two: one source, or one dual-sourced pair. */
export const SOURCING_PLANES = 2

export interface SourcingPlan {
  /**
   * `plane * (rowCount * weekCount) + row * weekCount + week` -> index into
   * `Snapshot.routings`. `-1` means no production in that cell.
   */
  routingOfRow: Int32Array
  /** Same layout as `routingOfRow`. Shares over both planes sum to 1 or 0. */
  shareOfRow: Float64Array
  /** Supply row keys (`materialId|plantId`) that are dual sourced in some week. */
  dualSourced: Set<string>
  warnings: string[]
}

/** Flat index into `routingOfRow` / `shareOfRow`. */
export function sourcingIndex(
  rowCount: number,
  weekCount: number,
  plane: number,
  row: number,
  week: WeekIndex,
): number {
  return plane * rowCount * weekCount + row * weekCount + week
}

function i32(a: Int32Array, i: number): number {
  return a[i] ?? -1
}

function validAt(routing: Routing, week: WeekIndex): boolean {
  if (routing.validFromWeek !== undefined && week < routing.validFromWeek) return false
  if (routing.validToWeek !== undefined && week > routing.validToWeek) return false
  return true
}

/** Expand a selector without ever enumerating 15,000 ids by hand at a call site. */
function selectMaterials(
  snap: Snapshot,
  idx: SnapshotIndexes,
  selector: MaterialSelector,
): MaterialId[] {
  switch (selector.kind) {
    case 'all': {
      const ids: MaterialId[] = []
      for (const m of snap.materials) ids.push(m.id)
      return ids
    }
    case 'material':
      return selector.id === undefined ? [] : [selector.id]
    case 'group':
      return selector.id === undefined ? [] : (idx.materialsByGroup.get(selector.id) ?? [])
    case 'family':
      return selector.id === undefined ? [] : (idx.materialsByFamily.get(selector.id) ?? [])
  }
}

function selectorLabel(selector: MaterialSelector): string {
  return selector.kind === 'all' ? 'all materials' : `${selector.kind} ${selector.id ?? '?'}`
}

/**
 * Resolve the source of every (material, plant) supply row for every week.
 *
 * Baseline is the primary production version for the pair, falling back to any
 * alternate version whose validity window covers the week. Scenario moves are
 * then applied in `seq` order, so a scenario reads as a decision log and the
 * last enabled move wins.
 *
 * No move is ever dropped silently: every rejection pushes a warning naming
 * the move and the reason.
 */
export function resolveSourcing(
  snap: Snapshot,
  idx: SnapshotIndexes,
  scenario: Scenario,
): SourcingPlan {
  const weeks = idx.weekCount
  const rows = snap.supplyPlan.rowKeys.length
  const planeSize = rows * weeks

  const routingOfRow = new Int32Array(planeSize * SOURCING_PLANES).fill(-1)
  const shareOfRow = new Float64Array(planeSize * SOURCING_PLANES)
  const warnings: string[] = []
  /** Set the moment anything writes a second source, so the common all-single case skips the final scan. */
  let anySecondSource = false

  const routingIndexById = new Map<RoutingId, number>()
  for (let i = 0; i < snap.routings.length; i++) {
    routingIndexById.set(at(snap.routings, i, 'routing').id, i)
  }

  // ---- baseline: the primary production version, week by week --------------
  for (let row = 0; row < rows; row++) {
    const rowKey = at(snap.supplyPlan.rowKeys, row, 'supply row key')
    const candidates = idx.routingsByMaterialPlant.get(rowKey)
    if (candidates === undefined || candidates.length === 0) continue

    const base = row * weeks
    const primary = idx.primaryRouting.get(rowKey)

    // Fast path: an unrestricted primary covers the whole horizon in one fill.
    if (
      primary !== undefined &&
      primary.validFromWeek === undefined &&
      primary.validToWeek === undefined
    ) {
      const ri = routingIndexById.get(primary.id)
      if (ri !== undefined) {
        routingOfRow.fill(ri, base, base + weeks)
        shareOfRow.fill(1, base, base + weeks)
        continue
      }
    }

    for (let w = 0; w < weeks; w++) {
      let chosen: Routing | undefined
      if (primary !== undefined && validAt(primary, w)) {
        chosen = primary
      } else {
        for (const candidate of candidates) {
          if (validAt(candidate, w)) {
            chosen = candidate
            break
          }
        }
      }
      if (chosen === undefined) continue
      const ri = routingIndexById.get(chosen.id)
      if (ri === undefined) continue
      routingOfRow[base + w] = ri
      shareOfRow[base + w] = 1
    }
  }

  const clampWeek = (w: number): WeekIndex => {
    const v = Math.floor(w)
    return v < 0 ? 0 : v > weeks - 1 ? weeks - 1 : v
  }

  // ---- scenario moves, in decision-log order -------------------------------
  const ordered = [...scenario.moves].sort((a, b) => a.seq - b.seq)
  for (const entry of ordered) {
    if (!entry.enabled) continue
    const move = entry.move
    const label = entry.label.length > 0 ? entry.label : entry.id

    if (move.kind === 'sourceSwitch') {
      const materials = selectMaterials(snap, idx, move.selector)
      const switchWeek = clampWeek(move.switchWeek)
      const overlap = move.overlapWeeks > 0 ? Math.floor(move.overlapWeeks) : 0
      const overlapEnd = switchWeek + overlap
      let noOriginRow = 0
      let noTargetRouting = 0
      let switched = 0

      for (const materialId of materials) {
        const originRow = idx.supplyRow.get(key(materialId, move.fromPlantId))
        if (originRow === undefined) {
          noOriginRow++
          continue
        }
        const target = idx.primaryRouting.get(key(materialId, move.toPlantId))
        const targetIndex = target === undefined ? undefined : routingIndexById.get(target.id)
        if (targetIndex === undefined) {
          noTargetRouting++
          continue
        }

        const base = originRow * weeks
        for (let w = switchWeek; w < weeks; w++) {
          const i0 = base + w
          const i1 = planeSize + i0
          const previous = i32(routingOfRow, i0)
          if (w < overlapEnd && previous >= 0 && previous !== targetIndex) {
            // Qualification parallel run. Both sources are legal here, and the
            // volume splits evenly so the plan quantity stays conserved — an
            // even split is the neutral assumption, and it keeps the
            // "shares sum to 1" invariant true everywhere.
            routingOfRow[i0] = targetIndex
            shareOfRow[i0] = 0.5
            routingOfRow[i1] = previous
            shareOfRow[i1] = 0.5
            anySecondSource = true
          } else {
            routingOfRow[i0] = targetIndex
            shareOfRow[i0] = 1
            routingOfRow[i1] = -1
            shareOfRow[i1] = 0
          }
        }
        switched++
      }

      if (switched === 0) {
        warnings.push(
          `sourceSwitch "${label}" changed nothing: no supply rows for ${selectorLabel(move.selector)} at plant ${move.fromPlantId}.`,
        )
      }
      if (noOriginRow > 0) {
        warnings.push(
          `sourceSwitch "${label}": ${noOriginRow} material(s) have no supply row at origin plant ${move.fromPlantId} and were skipped.`,
        )
      }
      if (noTargetRouting > 0) {
        warnings.push(
          `sourceSwitch "${label}": ${noTargetRouting} material(s) have no routing at target plant ${move.toPlantId}; they keep their existing source.`,
        )
      }
      continue
    }

    if (move.kind !== 'resourceMove') continue

    // ---- resourceMove ------------------------------------------------------
    if (!(move.share > 0)) {
      warnings.push(
        `resourceMove "${label}" rejected: share ${move.share} is not a positive fraction.`,
      )
      continue
    }
    const share = move.share > 1 ? 1 : move.share
    if (share < 1 && !move.allowDualSource) {
      warnings.push(
        `resourceMove "${label}" rejected: moving ${Math.round(share * 100)}% of ${selectorLabel(move.selector)} off ${move.fromWorkCenterId} leaves two sources in the same week, which is dual sourcing. Move the whole volume, or set allowDualSource.`,
      )
      continue
    }

    const targetWc = idx.workCenterById.get(move.toWorkCenterId)
    if (targetWc === undefined) {
      warnings.push(
        `resourceMove "${label}" rejected: target work center ${move.toWorkCenterId} is not in the snapshot.`,
      )
      continue
    }
    const fromWeek = clampWeek(move.fromWeek)
    const toWeek = clampWeek(move.toWeek)
    if (toWeek < fromWeek) {
      warnings.push(
        `resourceMove "${label}" rejected: window ${move.fromWeek}..${move.toWeek} is empty.`,
      )
      continue
    }

    const usesFromCache = new Map<number, boolean>()
    const usesSourceWorkCenter = (routingIndex: number): boolean => {
      const cached = usesFromCache.get(routingIndex)
      if (cached !== undefined) return cached
      const routing = at(snap.routings, routingIndex, 'routing')
      let uses = false
      for (const op of routing.operations) {
        if (op.workCenterId === move.fromWorkCenterId) {
          uses = true
          break
        }
      }
      usesFromCache.set(routingIndex, uses)
      return uses
    }

    const variantCache = new Map<string, number>()
    const variantFor = (materialId: MaterialId, plantId: PlantId): number => {
      const cacheKey = key(materialId, plantId)
      const cached = variantCache.get(cacheKey)
      if (cached !== undefined) return cached
      const candidates = idx.routingsByMaterialPlant.get(cacheKey) ?? []
      let best = -1
      let bestScore = -1
      for (const candidate of candidates) {
        let usesTarget = false
        let usesSource = false
        for (const op of candidate.operations) {
          if (op.workCenterId === move.toWorkCenterId) usesTarget = true
          if (op.workCenterId === move.fromWorkCenterId) usesSource = true
        }
        if (!usesTarget) continue
        // Prefer a version that leaves the saturated work center entirely, then
        // prefer the primary version.
        const score = (usesSource ? 0 : 2) + (candidate.primary ? 1 : 0)
        if (score > bestScore) {
          const ri = routingIndexById.get(candidate.id)
          if (ri !== undefined) {
            bestScore = score
            best = ri
          }
        }
      }
      variantCache.set(cacheKey, best)
      return best
    }

    const materials = selectMaterials(snap, idx, move.selector)
    let moved = 0
    let noVariant = 0
    let thirdSource = 0

    for (const materialId of materials) {
      const material = idx.materialById.get(materialId)
      if (material === undefined) continue
      for (const plantId of material.plantIds) {
        const row = idx.supplyRow.get(key(materialId, plantId))
        if (row === undefined) continue
        const base = row * weeks
        let touched = false

        for (let w = fromWeek; w <= toWeek; w++) {
          const i0 = base + w
          const current = i32(routingOfRow, i0)
          if (current < 0) continue
          if (!usesSourceWorkCenter(current)) continue

          const variant = variantFor(materialId, targetWc.plantId)
          if (variant < 0) {
            noVariant++
            break
          }
          const i1 = planeSize + i0
          if (share >= 1) {
            routingOfRow[i0] = variant
            shareOfRow[i0] = 1
            routingOfRow[i1] = -1
            shareOfRow[i1] = 0
          } else {
            const existing = i32(routingOfRow, i1)
            if (existing >= 0 && existing !== variant) {
              // Two sources is the ceiling. A third would be a data error, not
              // a plan, so refuse it rather than silently overwrite.
              thirdSource++
              continue
            }
            shareOfRow[i0] = 1 - share
            routingOfRow[i1] = variant
            shareOfRow[i1] = share
            anySecondSource = true
          }
          touched = true
        }
        if (touched) moved++
      }
    }

    if (moved === 0 && noVariant === 0) {
      warnings.push(
        `resourceMove "${label}" changed nothing: no supply row for ${selectorLabel(move.selector)} runs on ${move.fromWorkCenterId} in weeks ${fromWeek}..${toWeek}.`,
      )
    }
    if (noVariant > 0) {
      warnings.push(
        `resourceMove "${label}": ${noVariant} material(s) have no routing version that runs on ${move.toWorkCenterId}, so their volume stayed on ${move.fromWorkCenterId}.`,
      )
    }
    if (thirdSource > 0) {
      warnings.push(
        `resourceMove "${label}": ${thirdSource} bucket(s) already carried two sources; a third source is not representable and was refused.`,
      )
    }
  }

  // ---- final pass: who ended up dual sourced -------------------------------
  // Recomputed from the finished planes rather than accumulated as moves are
  // applied, so a later move that collapses a bucket back to one source cannot
  // leave a stale "dual sourced" flag behind.
  const dualSourced = new Set<string>()
  if (anySecondSource) {
    for (let row = 0; row < rows; row++) {
      const base = planeSize + row * weeks
      for (let w = 0; w < weeks; w++) {
        if (i32(routingOfRow, base + w) >= 0) {
          dualSourced.add(at(snap.supplyPlan.rowKeys, row, 'supply row key'))
          break
        }
      }
    }
  }

  return { routingOfRow, shareOfRow, dualSourced, warnings }
}

/** Work centers a resolved plan actually uses, for the "where does it run" views. */
export function workCentersUsed(
  snap: Snapshot,
  plan: SourcingPlan,
  rowCount: number,
  weekCount: number,
  row: number,
): WorkCenterId[] {
  const seen = new Set<WorkCenterId>()
  const out: WorkCenterId[] = []
  for (let plane = 0; plane < SOURCING_PLANES; plane++) {
    for (let w = 0; w < weekCount; w++) {
      const ri = i32(plan.routingOfRow, sourcingIndex(rowCount, weekCount, plane, row, w))
      if (ri < 0) continue
      for (const op of at(snap.routings, ri, 'routing').operations) {
        if (!seen.has(op.workCenterId)) {
          seen.add(op.workCenterId)
          out.push(op.workCenterId)
        }
      }
    }
  }
  return out
}
