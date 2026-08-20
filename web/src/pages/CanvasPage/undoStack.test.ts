/**
 * undoStack.test.ts — the ordering rules the canvas's Cmd+Z relies on:
 * push clears the redo branch, undo/redo move entries between the two
 * sides, the depth cap drops the oldest entry, and the surface stays
 * exactly what the apply-side is allowed to call.
 */
import { describe, expect, it } from 'vitest'
import { createUndoStack } from './undoStack'

describe('createUndoStack', () => {
  it('starts empty', () => {
    const s = createUndoStack<number>()
    expect(s.canUndo()).toBe(false)
    expect(s.canRedo()).toBe(false)
    expect(s.popUndo()).toBeNull()
    expect(s.popRedo()).toBeNull()
  })

  it('undo returns the newest act and arms redo', () => {
    const s = createUndoStack<number>()
    s.push(1)
    s.push(2)
    expect(s.popUndo()).toBe(2)
    expect(s.canRedo()).toBe(true)
    expect(s.peekUndo()).toBe(1)
    expect(s.peekRedo()).toBe(2)
  })

  it('redo moves the entry back to the undo side', () => {
    const s = createUndoStack<number>()
    s.push(1)
    s.popUndo()
    expect(s.popRedo()).toBe(1)
    expect(s.canUndo()).toBe(true)
    expect(s.canRedo()).toBe(false)
  })

  it('a new act clears the redo branch', () => {
    const s = createUndoStack<number>()
    s.push(1)
    s.popUndo()
    expect(s.canRedo()).toBe(true)
    s.push(2)
    // Once you act, the futures you undid are gone.
    expect(s.canRedo()).toBe(false)
    expect(s.popRedo()).toBeNull()
  })

  it('discardRedoTop drops an unreplayable entry without re-arming undo', () => {
    const s = createUndoStack<number>()
    s.push(1)
    s.popUndo()
    expect(s.discardRedoTop()).toBe(1)
    expect(s.canRedo()).toBe(false)
    // Crucially NOT back on the undo side in an un-applied state.
    expect(s.canUndo()).toBe(false)
  })

  it('caps depth by dropping the oldest entry', () => {
    const s = createUndoStack<number>(3)
    s.push(1)
    s.push(2)
    s.push(3)
    s.push(4)
    expect(s.popUndo()).toBe(4)
    expect(s.popUndo()).toBe(3)
    expect(s.popUndo()).toBe(2)
    // 1 fell off the bottom when 4 arrived.
    expect(s.popUndo()).toBeNull()
  })

  it('clear empties both sides', () => {
    const s = createUndoStack<number>()
    s.push(1)
    s.push(2)
    s.popUndo()
    s.clear()
    expect(s.canUndo()).toBe(false)
    expect(s.canRedo()).toBe(false)
  })

  it('exposes only the documented surface', () => {
    // Guard: entries must enter ONLY through push (a UI gesture). If a
    // mutation path is ever added here, agent/CLI writes could land in the
    // user's undo history — see the doctrine note in undoStack.ts.
    const s = createUndoStack<number>()
    expect(Object.keys(s).sort()).toEqual([
      'canRedo',
      'canUndo',
      'clear',
      'discardRedoTop',
      'peekRedo',
      'peekUndo',
      'popRedo',
      'popUndo',
      'push',
    ])
  })
})
