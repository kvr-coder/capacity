import { describe, expect, it } from 'vitest'
import { UNDO_LIMIT, UndoStack } from '@/state/undo'

/** The shape the store actually stores: one scenario's move list. */
interface MoveList {
  scenarioId: string
  moves: string[]
}

function step(label: string, before: string[], after: string[]) {
  return {
    label,
    before: { scenarioId: 'sc-1', moves: before } satisfies MoveList,
    after: { scenarioId: 'sc-1', moves: after } satisfies MoveList,
  }
}

describe('UndoStack', () => {
  it('starts empty and refuses to undo or redo', () => {
    const stack = new UndoStack<MoveList>()
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(false)
    expect(stack.size).toBe(0)
    expect(stack.undo()).toBeNull()
    expect(stack.redo()).toBeNull()
    expect(stack.undoLabel).toBeNull()
    expect(stack.redoLabel).toBeNull()
  })

  it('undoes steps in reverse order and redoes them forwards', () => {
    const stack = new UndoStack<MoveList>()
    stack.push(step('add A', [], ['A']))
    stack.push(step('add B', ['A'], ['A', 'B']))
    stack.push(step('add C', ['A', 'B'], ['A', 'B', 'C']))

    expect(stack.canUndo).toBe(true)
    expect(stack.canRedo).toBe(false)
    expect(stack.undoLabel).toBe('add C')

    const first = stack.undo()
    expect(first?.label).toBe('add C')
    expect(first?.before.moves).toEqual(['A', 'B'])

    const second = stack.undo()
    expect(second?.label).toBe('add B')
    expect(second?.before.moves).toEqual(['A'])

    const third = stack.undo()
    expect(third?.label).toBe('add A')
    expect(third?.before.moves).toEqual([])

    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(true)
    expect(stack.redoLabel).toBe('add A')

    expect(stack.redo()?.after.moves).toEqual(['A'])
    expect(stack.redo()?.after.moves).toEqual(['A', 'B'])
    expect(stack.redo()?.after.moves).toEqual(['A', 'B', 'C'])
    expect(stack.canRedo).toBe(false)
    expect(stack.redo()).toBeNull()
  })

  it('is a no-op past the beginning rather than a crash, and recovers after', () => {
    const stack = new UndoStack<MoveList>()
    stack.push(step('add A', [], ['A']))

    expect(stack.undo()?.label).toBe('add A')
    // Ten more presses of the shortcut, all of which must do nothing.
    for (let i = 0; i < 10; i += 1) expect(stack.undo()).toBeNull()

    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(true)
    // The timeline is intact: the redo that was always there still works.
    expect(stack.redo()?.after.moves).toEqual(['A'])
    expect(stack.canUndo).toBe(true)
  })

  it('is a no-op past the end rather than a crash', () => {
    const stack = new UndoStack<MoveList>()
    stack.push(step('add A', [], ['A']))
    for (let i = 0; i < 10; i += 1) expect(stack.redo()).toBeNull()
    expect(stack.canUndo).toBe(true)
    expect(stack.canRedo).toBe(false)
  })

  it('discards the redo branch when a new step is pushed', () => {
    const stack = new UndoStack<MoveList>()
    stack.push(step('add A', [], ['A']))
    stack.push(step('add B', ['A'], ['A', 'B']))
    stack.undo()
    expect(stack.canRedo).toBe(true)

    stack.push(step('add C', ['A'], ['A', 'C']))

    expect(stack.canRedo).toBe(false)
    expect(stack.redo()).toBeNull()
    expect(stack.size).toBe(2)
    expect(stack.history().labels).toEqual(['add A', 'add C'])
    expect(stack.undo()?.label).toBe('add C')
  })

  it('evicts the oldest entry once the cap is reached', () => {
    const stack = new UndoStack<MoveList>(3)
    stack.push(step('one', [], ['1']))
    stack.push(step('two', ['1'], ['1', '2']))
    stack.push(step('three', ['1', '2'], ['1', '2', '3']))
    stack.push(step('four', ['1', '2', '3'], ['1', '2', '3', '4']))

    expect(stack.size).toBe(3)
    expect(stack.history().labels).toEqual(['two', 'three', 'four'])

    expect(stack.undo()?.label).toBe('four')
    expect(stack.undo()?.label).toBe('three')
    expect(stack.undo()?.label).toBe('two')
    // 'one' is gone; it cannot be undone past.
    expect(stack.undo()).toBeNull()
  })

  it('keeps the cursor valid while evicting under a full stack', () => {
    const stack = new UndoStack<MoveList>(2)
    stack.push(step('a', [], ['a']))
    stack.push(step('b', ['a'], ['a', 'b']))
    stack.undo()
    // Cursor is 1 of 2; pushing truncates to 1 then appends, so nothing evicts.
    stack.push(step('c', ['a'], ['a', 'c']))
    expect(stack.size).toBe(2)
    expect(stack.history()).toEqual({ labels: ['a', 'c'], cursor: 2 })
    stack.push(step('d', ['a', 'c'], ['a', 'c', 'd']))
    expect(stack.history()).toEqual({ labels: ['c', 'd'], cursor: 2 })
  })

  it('clears to a fresh stack', () => {
    const stack = new UndoStack<MoveList>()
    stack.push(step('a', [], ['a']))
    stack.push(step('b', ['a'], ['a', 'b']))
    stack.undo()
    stack.clear()
    expect(stack.size).toBe(0)
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(false)
    expect(stack.history()).toEqual({ labels: [], cursor: 0 })
  })

  it('defaults to a cap of 50 and never grows past it', () => {
    const stack = new UndoStack<MoveList>()
    for (let i = 0; i < UNDO_LIMIT + 25; i += 1) {
      stack.push(step(`step ${i}`, [], [`${i}`]))
    }
    expect(stack.size).toBe(UNDO_LIMIT)
    expect(stack.history().labels[0]).toBe(`step ${25}`)
    expect(stack.undoLabel).toBe(`step ${UNDO_LIMIT + 24}`)
  })

  it('rejects a nonsensical cap instead of storing nothing', () => {
    const stack = new UndoStack<MoveList>(0)
    stack.push(step('a', [], ['a']))
    expect(stack.size).toBe(1)
    expect(stack.undo()?.label).toBe('a')
  })
})
