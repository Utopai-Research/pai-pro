/**
 * batchPlace.test.ts — behavior tests for the batch grid-pack. Grid
 * shape, unit-shift collision handling, and determinism.
 */
import { describe, expect, it } from 'vitest'
import { gridPackBatch } from './batchPlace'
import { PLACEMENT_PADDING, type AABB, type Viewport } from './placement'

const PAD = PLACEMENT_PADDING

const batch = (
  n: number,
  size: { w: number; h: number } = { w: 100, h: 100 },
): Array<{ id: string; size: { w: number; h: number } }> =>
  Array.from({ length: n }, (_, i) => ({ id: `n${i}`, size }))

describe('gridPackBatch', () => {
  it('returns an empty map for an empty batch', () => {
    const out = gridPackBatch({
      nodes: [],
      anchor: { x: 0, y: 0 },
      viewport: null,
      existingAabbs: [],
    })
    expect(out.size).toBe(0)
  })

  it('lays out 9 uniform nodes as a 3x3 row-major grid from the anchor', () => {
    const out = gridPackBatch({
      nodes: batch(9),
      anchor: { x: 100, y: 200 },
      viewport: null,
      existingAabbs: [],
    })
    const step = 100 + PAD
    for (let i = 0; i < 9; i += 1) {
      expect(out.get(`n${i}`)).toEqual({
        x: 100 + (i % 3) * step,
        y: 200 + Math.floor(i / 3) * step,
      })
    }
  })

  it('picks ceil(sqrt(n)) columns so grids are slightly wider than tall', () => {
    // Rationale from the module header: 12 → 4×3, never clamped to the
    // viewport (a 1×N collapse when zoomed in was the failure mode).
    const out = gridPackBatch({
      nodes: batch(12),
      anchor: { x: 0, y: 0 },
      viewport: null,
      existingAabbs: [],
    })
    const xs = new Set([...out.values()].map((p) => p.x))
    const ys = new Set([...out.values()].map((p) => p.y))
    expect(xs.size).toBe(4)
    expect(ys.size).toBe(3)
  })

  it('wraps a non-square batch after ceil(sqrt(n)) columns', () => {
    const out = gridPackBatch({
      nodes: batch(5),
      anchor: { x: 0, y: 0 },
      viewport: null,
      existingAabbs: [],
    })
    expect(out.get('n0')).toEqual({ x: 0, y: 0 })
    expect(out.get('n2')).toEqual({ x: 280, y: 0 })
    expect(out.get('n3')).toEqual({ x: 0, y: 140 })
    expect(out.get('n4')).toEqual({ x: 140, y: 140 })
  })

  it('keeps a pair on a single row', () => {
    const out = gridPackBatch({
      nodes: batch(2),
      anchor: { x: 0, y: 0 },
      viewport: null,
      existingAabbs: [],
    })
    expect(out.get('n0')).toEqual({ x: 0, y: 0 })
    expect(out.get('n1')).toEqual({ x: 140, y: 0 })
  })

  it('drops the next row below the tallest node of the previous row', () => {
    const nodes = [
      { id: 'a', size: { w: 100, h: 100 } },
      { id: 'b', size: { w: 100, h: 200 } },
      { id: 'c', size: { w: 100, h: 100 } },
      { id: 'd', size: { w: 100, h: 100 } },
    ]
    const out = gridPackBatch({
      nodes,
      anchor: { x: 0, y: 0 },
      viewport: null,
      existingAabbs: [],
    })
    expect(out.get('a')).toEqual({ x: 0, y: 0 })
    expect(out.get('b')).toEqual({ x: 140, y: 0 })
    expect(out.get('c')).toEqual({ x: 0, y: 200 + PAD })
    expect(out.get('d')).toEqual({ x: 140, y: 200 + PAD })
  })

  it('shifts the whole batch down as a unit when the anchor area is occupied', () => {
    const anchor = { x: 100, y: 100 }
    const blocker: AABB = { id: 'block', x: 100, y: 100, w: 100, h: 100 }
    const clear = gridPackBatch({
      nodes: batch(4),
      anchor,
      viewport: null,
      existingAabbs: [],
    })
    const shifted = gridPackBatch({
      nodes: batch(4),
      anchor,
      viewport: null,
      existingAabbs: [blocker],
    })
    // One downward shift of rowMaxH + padding, relative offsets intact.
    for (const [id, p] of clear) {
      expect(shifted.get(id)).toEqual({ x: p.x, y: p.y + 100 + PAD })
    }
  })

  it('walks right after eight downward shifts fail to clear a tall blocker', () => {
    const blocker: AABB = { id: 'tall', x: 0, y: 0, w: 100, h: 2000 }
    const out = gridPackBatch({
      nodes: batch(9),
      anchor: { x: 0, y: 0 },
      viewport: null,
      existingAabbs: [blocker],
    })
    // Downward shifts cannot clear a 2000-tall column; on i % 8 === 0 the
    // batch steps right by 4·PADDING and retries from the anchor's y,
    // which immediately clears.
    expect(out.get('n0')).toEqual({ x: 4 * PAD, y: 0 })
    for (const p of out.values()) {
      expect(p.x).toBeGreaterThanOrEqual(blocker.w + PAD)
    }
  })

  it('is deterministic for identical input', () => {
    const args = {
      nodes: batch(7, { w: 130, h: 90 }),
      anchor: { x: 33, y: 44 },
      viewport: null,
      existingAabbs: [{ id: 'a', x: 0, y: 0, w: 300, h: 300 }] as AABB[],
    }
    const first = gridPackBatch(args)
    const second = gridPackBatch(args)
    expect(Object.fromEntries(first)).toEqual(Object.fromEntries(second))
  })

  it('starts from the viewport center when there is no anchor', () => {
    const viewport: Viewport = { x: 0, y: 0, zoom: 1, width: 1000, height: 800 }
    const out = gridPackBatch({
      nodes: batch(1),
      anchor: null,
      viewport,
      existingAabbs: [],
    })
    expect(out.get('n0')).toEqual({ x: 500, y: 400 })
  })
})
