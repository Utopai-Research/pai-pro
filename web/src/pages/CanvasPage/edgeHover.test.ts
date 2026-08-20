/**
 * edgeHover.test.ts — the geometry the hit test rests on, and the hover state
 * machine's two guard rails (the arm dwell and the post-press suppression).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEdgeHoverForTest,
  buildEdgeEntry,
  clearHoveredEdge,
  controlPolygonLength,
  distanceToCurve,
  edgeArmedSnapshot,
  edgeHoverSnapshot,
  flattenSteps,
  hitsCurve,
  isCuttableEdgeId,
  parseBezierPath,
  pickEdgeAt,
  pickNearest,
  pointerOverBlockingNode,
  registerEdgeCurve,
  reportHoveredEdge,
  suppressHoveredEdge,
  withinCurveBounds,
  type EdgeCurve,
} from './edgeHover'

afterEach(() => {
  __resetEdgeHoverForTest()
  vi.useRealTimers()
})

/** A straight horizontal "curve" — distances are then obvious by hand. */
const STRAIGHT: EdgeCurve = {
  sx: 0, sy: 0, c1x: 100, c1y: 0, c2x: 200, c2y: 0, tx: 300, ty: 0,
}
const STRAIGHT_PATH = 'M0,0 C100,0 200,0 300,0'

describe('parseBezierPath', () => {
  it("reads back React Flow's own path format", () => {
    expect(parseBezierPath(STRAIGHT_PATH)).toEqual(STRAIGHT)
  })

  it('rejects anything that is not one cubic', () => {
    expect(parseBezierPath('')).toBeNull()
    expect(parseBezierPath('M0,0 L10,10')).toBeNull()
    // Six numbers, not eight.
    expect(parseBezierPath('M0,0 C1,1 2,2')).toBeNull()
  })
})

describe('flattening budget', () => {
  it('is an upper bound on the arc length, so it errs toward more samples', () => {
    expect(controlPolygonLength(STRAIGHT)).toBe(300)
  })

  it('clamps at both ends and scales in between', () => {
    expect(flattenSteps(0)).toBe(8)
    expect(flattenSteps(-1)).toBe(8)
    expect(flattenSteps(Number.NaN)).toBe(8)
    // A short edge takes the floor, not 300/30 = 10.
    expect(flattenSteps(60)).toBe(8)
    expect(flattenSteps(900)).toBe(30)
    // And a very long one takes the ceiling.
    expect(flattenSteps(100000)).toBe(96)
  })
})

describe('distance and hit test', () => {
  it('measures to the chords, not just the sample points', () => {
    // Midway along a straight edge: exactly the perpendicular offset.
    expect(distanceToCurve(STRAIGHT, 150, 7)).toBeCloseTo(7, 5)
  })

  it('rejects on the bounding box before measuring', () => {
    expect(withinCurveBounds(STRAIGHT, 150, 100, 10)).toBe(false)
    expect(withinCurveBounds(STRAIGHT, 150, 9, 10)).toBe(true)
    // The box is inflated by the threshold, so just outside still passes.
    expect(withinCurveBounds(STRAIGHT, -9, 0, 10)).toBe(true)
  })

  it('hits inside the band and misses outside it', () => {
    expect(hitsCurve(STRAIGHT, 150, 9, 10)).toBe(true)
    expect(hitsCurve(STRAIGHT, 150, 11, 10)).toBe(false)
  })

  it('picks the nearest of several candidates', () => {
    const near = buildEdgeEntry(STRAIGHT)
    const far = buildEdgeEntry({ ...STRAIGHT, sy: 8, c1y: 8, c2y: 8, ty: 8 })
    const picked = pickNearest(
      [
        ['far', far],
        ['near', near],
      ],
      150,
      1,
      10,
    )
    expect(picked).toBe('near')
  })

  it('returns null when nothing is within the band', () => {
    expect(pickNearest([['a', buildEdgeEntry(STRAIGHT)]], 150, 40, 10)).toBeNull()
  })
})

describe('pointerOverBlockingNode', () => {
  const node = {
    type: 'image_result',
    position: { x: 0, y: 0 },
    measured: { width: 100, height: 50 },
  }

  it('blocks inside a card rectangle', () => {
    expect(pointerOverBlockingNode([node], 50, 25)).toBe(true)
  })

  it('does not block outside it', () => {
    expect(pointerOverBlockingNode([node], 150, 25)).toBe(false)
  })

  it('does NOT treat a group frame as blocking', () => {
    // A frame is a React Flow node covering a large rectangle; treating it as
    // blocking would make the scissors unreachable across a tidied canvas.
    const frame = {
      type: 'group_frame',
      position: { x: 0, y: 0 },
      measured: { width: 1000, height: 800 },
    }
    expect(pointerOverBlockingNode([frame], 500, 400)).toBe(false)
  })

  it('prefers the resolved absolute position when there is one', () => {
    const nested = {
      type: 'note',
      position: { x: 0, y: 0 },
      internals: { positionAbsolute: { x: 500, y: 500 } },
      measured: { width: 100, height: 50 },
    }
    expect(pointerOverBlockingNode([nested], 50, 25)).toBe(false)
    expect(pointerOverBlockingNode([nested], 550, 525)).toBe(true)
  })
})

describe('cuttability', () => {
  it("excludes a pending pad's dashed edge", () => {
    // Cutting one would mean rewriting the pad's reference set, which the
    // viewer's PATCH route does not accept — so it must not steal the hover.
    expect(isCuttableEdgeId('pending:image_1->pending_abc')).toBe(false)
    expect(isCuttableEdgeId('image_1->video_2')).toBe(true)
  })
})

describe('hover state machine', () => {
  it('lights the line immediately but arms the button only after a dwell', () => {
    vi.useFakeTimers()
    registerEdgeCurve('e1', STRAIGHT_PATH)
    reportHoveredEdge(pickEdgeAt(150, 0, 10))
    expect(edgeHoverSnapshot('e1')).toBe(true)
    // A pointer merely crossing the line must not find a button in the way.
    expect(edgeArmedSnapshot('e1')).toBe(false)
    vi.advanceTimersByTime(900)
    expect(edgeArmedSnapshot('e1')).toBe(true)
  })

  it('does not restart the dwell while sliding along the same edge', () => {
    vi.useFakeTimers()
    registerEdgeCurve('e1', STRAIGHT_PATH)
    reportHoveredEdge('e1')
    vi.advanceTimersByTime(500)
    reportHoveredEdge('e1') // same id — must be a no-op
    vi.advanceTimersByTime(400)
    expect(edgeArmedSnapshot('e1')).toBe(true)
  })

  it('keeps the hover across a brief leave, then drops it', () => {
    vi.useFakeTimers()
    registerEdgeCurve('e1', STRAIGHT_PATH)
    reportHoveredEdge('e1')
    reportHoveredEdge(null)
    // Grace period — a hand holding still near a line jitters in and out.
    vi.advanceTimersByTime(100)
    expect(edgeHoverSnapshot('e1')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(edgeHoverSnapshot('e1')).toBe(false)
  })

  it('suppresses the same edge after a press until the pointer leaves it', () => {
    vi.useFakeTimers()
    registerEdgeCurve('e1', STRAIGHT_PATH)
    reportHoveredEdge('e1')
    vi.advanceTimersByTime(900)
    expect(edgeArmedSnapshot('e1')).toBe(true)

    suppressHoveredEdge()
    expect(edgeHoverSnapshot('e1')).toBe(false)
    expect(edgeArmedSnapshot('e1')).toBe(false)

    // Still inside the same band: stays suppressed, however long you wait.
    reportHoveredEdge('e1')
    vi.advanceTimersByTime(2000)
    expect(edgeHoverSnapshot('e1')).toBe(false)

    // Leaving and coming back is the only way out.
    reportHoveredEdge(null)
    vi.advanceTimersByTime(200)
    reportHoveredEdge('e1')
    expect(edgeHoverSnapshot('e1')).toBe(true)
  })

  it('clears immediately when the pointer leaves the canvas', () => {
    vi.useFakeTimers()
    registerEdgeCurve('e1', STRAIGHT_PATH)
    reportHoveredEdge('e1')
    clearHoveredEdge()
    expect(edgeHoverSnapshot('e1')).toBe(false)
  })
})
