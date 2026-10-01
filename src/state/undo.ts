/**
 * A bounded undo/redo stack.
 *
 * Moves in this product apply immediately — there is no Apply button anywhere —
 * so undo is not a convenience, it is the entire safety net. A planner drags
 * load between two work centers, watches the network re-solve, and takes it
 * back. That round trip has to be free, and it has to be exact.
 *
 * The stack stores *whole before/after states* rather than inverse operations.
 * Inverting a move is easy for `shiftChange` and quietly wrong for
 * `resourceMove`, where applying and un-applying is not symmetric once other
 * moves in the scenario have re-sorted around it. A move list is a handful of
 * small objects; keeping fifty snapshots of one costs nothing and cannot drift.
 *
 * Generic over the state it captures, so it is testable without a store, a
 * worker or a browser anywhere in sight.
 */

import { at } from '@/domain/lookup'

/** How many steps back a planner can go. Beyond this the oldest is forgotten. */
export const UNDO_LIMIT = 50

export interface UndoEntry<T> {
  /** What the step did, in the planner's words. Shown in the undo tooltip. */
  label: string
  /** The state before the step. `undo()` restores this. */
  before: T
  /** The state after the step. `redo()` restores this. */
  after: T
}

/**
 * Classic cursor-over-a-list model.
 *
 * `entries` is the timeline; `cursor` is how many of them are currently
 * applied. Undo walks the cursor back, redo walks it forward, and a fresh push
 * truncates whatever was ahead of it — the future you did not take stops
 * existing the moment you do something else, which is what every editor does
 * and therefore the only behaviour that will not surprise anyone.
 */
export class UndoStack<T> {
  private entries: UndoEntry<T>[] = []
  private cursor = 0
  private readonly limit: number

  constructor(limit: number = UNDO_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get canUndo(): boolean {
    return this.cursor > 0
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length
  }

  /** Steps currently on the timeline, applied and unapplied together. */
  get size(): number {
    return this.entries.length
  }

  /** Label of the step `undo()` would take back, for the button's tooltip. */
  get undoLabel(): string | null {
    return this.cursor > 0 ? at(this.entries, this.cursor - 1, 'undo entry').label : null
  }

  /** Label of the step `redo()` would re-apply. */
  get redoLabel(): string | null {
    return this.cursor < this.entries.length
      ? at(this.entries, this.cursor, 'redo entry').label
      : null
  }

  /**
   * Record a step. Anything that was undone but not yet redone is discarded,
   * and the oldest entry is evicted once the cap is reached.
   */
  push(entry: UndoEntry<T>): void {
    if (this.cursor < this.entries.length) this.entries.length = this.cursor
    this.entries.push(entry)
    while (this.entries.length > this.limit) this.entries.shift()
    this.cursor = this.entries.length
  }

  /**
   * Step back. Returns the entry that was undone — the caller applies its
   * `before` — or `null` at the beginning of the timeline. Undoing past the
   * beginning is a no-op, never a throw: the keyboard shortcut is held down,
   * and the twenty-first press must do exactly nothing.
   */
  undo(): UndoEntry<T> | null {
    if (this.cursor === 0) return null
    this.cursor -= 1
    return at(this.entries, this.cursor, 'undo entry')
  }

  /** Step forward. Returns the entry to re-apply (`after`), or `null`. */
  redo(): UndoEntry<T> | null {
    if (this.cursor >= this.entries.length) return null
    const entry = at(this.entries, this.cursor, 'redo entry')
    this.cursor += 1
    return entry
  }

  /** Forget everything. Used when the underlying dataset is replaced. */
  clear(): void {
    this.entries = []
    this.cursor = 0
  }

  /**
   * The timeline as labels, newest first, with the cursor position — the
   * history list on the Scenarios screen renders straight from this.
   */
  history(): { labels: string[]; cursor: number } {
    return { labels: this.entries.map((entry) => entry.label), cursor: this.cursor }
  }
}
