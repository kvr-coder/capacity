import { describe, expect, it } from 'vitest'
import {
  DRAG_HANDLE_ATTRIBUTE,
  DRAG_THRESHOLD_PX,
  dragHandleKindAt,
  gestureFor,
  passedThreshold,
} from '@/canvas/gesture'

/**
 * A stand-in for the two Element methods the rules touch. Built as a chain so a
 * test can press on a mark BURIED inside a handle — which is the normal case:
 * the pointer lands on a label or a badge, never on the handle itself.
 */
function markInside(attributes: Array<Record<string, string>>): unknown {
  const chain = attributes.map((attrs) => ({
    attrs,
    getAttribute(name: string): string | null {
      return attrs[name] ?? null
    },
  }))
  const deepest = chain[chain.length - 1]
  return {
    closest(selector: string): { getAttribute(name: string): string | null } | null {
      const name = selector.slice(1, -1)
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const link = chain[i]
        if (link !== undefined && link.attrs[name] !== undefined) return link
      }
      return null
    },
    getAttribute: deepest?.getAttribute ?? (() => null),
  }
}

const stage = markInside([{ class: 'stage' }])
const node = markInside([{ [DRAG_HANDLE_ATTRIBUTE]: 'workCenter' }, { class: 'label' }])
const chip = markInside([{ [DRAG_HANDLE_ATTRIBUTE]: 'group' }, { class: 'hours' }])

describe('dragHandleKindAt', () => {
  it('finds the handle a buried mark belongs to', () => {
    expect(dragHandleKindAt(node)).toBe('workCenter')
    expect(dragHandleKindAt(chip)).toBe('group')
  })

  it('reports nothing for a press on the stage', () => {
    expect(dragHandleKindAt(stage)).toBeNull()
  })

  it('survives a target that is not an element at all', () => {
    expect(dragHandleKindAt(null)).toBeNull()
    expect(dragHandleKindAt(undefined)).toBeNull()
    expect(dragHandleKindAt('a string')).toBeNull()
    expect(dragHandleKindAt({ closest: 'not a function' })).toBeNull()
  })

  it('ignores a handle whose value names nothing it knows', () => {
    expect(dragHandleKindAt(markInside([{ [DRAG_HANDLE_ATTRIBUTE]: 'sandwich' }]))).toBeNull()
  })
})

describe('gestureFor', () => {
  it('reads a press on the stage as a pan', () => {
    expect(gestureFor({ target: stage })).toBe('pan')
  })

  it('reads a press on either kind of handle as a move', () => {
    expect(gestureFor({ target: node })).toBe('move')
    expect(gestureFor({ target: chip })).toBe('move')
  })

  it('leaves a non-primary mouse button to the browser', () => {
    expect(gestureFor({ target: stage, button: 2, pointerType: 'mouse' })).toBe('none')
    expect(gestureFor({ target: node, button: 1, pointerType: 'mouse' })).toBe('none')
  })

  it('does not consult the button for touch or pen, which have none to speak of', () => {
    expect(gestureFor({ target: node, button: -1, pointerType: 'touch' })).toBe('move')
    expect(gestureFor({ target: stage, button: -1, pointerType: 'pen' })).toBe('pan')
  })

  /**
   * The whole point of the attribute. A mark added later — a badge, a chip, a
   * status ring — inherits the gesture from the handle it sits inside, without
   * having to remember to stop propagation on its own.
   */
  it('classifies a mark drawn inside a handle as part of that handle', () => {
    const badge = markInside([
      { [DRAG_HANDLE_ATTRIBUTE]: 'workCenter' },
      { class: 'badge' },
      { class: 'badgeText' },
    ])
    expect(gestureFor({ target: badge })).toBe('move')
  })
})

describe('passedThreshold', () => {
  const origin = { x: 100, y: 100 }

  it('holds a press below the threshold, so a click stays a click', () => {
    expect(passedThreshold(origin, { x: 100, y: 100 })).toBe(false)
    expect(passedThreshold(origin, { x: 103, y: 103 })).toBe(false)
  })

  it('lets go at the threshold itself', () => {
    expect(passedThreshold(origin, { x: 100 + DRAG_THRESHOLD_PX, y: 100 })).toBe(true)
  })

  it('measures distance, not axis travel', () => {
    expect(passedThreshold(origin, { x: 104, y: 104 })).toBe(true)
    expect(passedThreshold(origin, { x: 96, y: 96 })).toBe(true)
  })

  it('takes a threshold of its own when one is given', () => {
    expect(passedThreshold(origin, { x: 108, y: 100 }, 12)).toBe(false)
    expect(passedThreshold(origin, { x: 118, y: 100 }, 12)).toBe(true)
  })
})
