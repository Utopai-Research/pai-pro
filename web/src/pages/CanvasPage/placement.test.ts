/**
 * placement.test.ts — behavior tests for the deterministic spiral
 * placement primitives. Pure geometry: no DOM, no randomness, no clock.
 */
import { describe, expect, it } from 'vitest'
import type {
  AudioResultData,
  CanvasNode,
  ImageResultData,
  NoteData,
  VideoResultData,
} from '@/types/canvas'
import {
  IMAGE_CARD_CHROME_PX,
  NODE_SIZES,
  NOTE_CARD_FALLBACK_HEIGHT,
  sizeForAspect,
} from './nodeData'
import {
  PLACEMENT_PADDING,
  computeAABBSet,
  pickSize,
  pickStart,
  placeNode,
  type AABB,
  type Viewport,
} from './placement'

const imageData = (over: Partial<ImageResultData> = {}): ImageResultData => ({
  label: 'img',
  local_path: 'assets/images/img_1.png',
  image_url: '',
  metadata: {},
  ...over,
})

const videoData = (over: Partial<VideoResultData> = {}): VideoResultData => ({
  label: 'vid',
  local_path: 'assets/videos/vid_1.mp4',
  video_url: '',
  duration: 5,
  aspect: '16:9',
  shot_id: null,
  metadata: {},
  ...over,
})

const audioData = (): AudioResultData => ({
  subtype: 'voice',
  label: 'aud',
  local_path: 'assets/audios/aud_1.mp3',
  audio_url: '',
  metadata: {},
})

const noteData = (): NoteData => ({ label: 'note', body: 'body' })

const vp = (over: Partial<Viewport> = {}): Viewport => ({
  x: 0,
  y: 0,
  zoom: 1,
  width: 1000,
  height: 800,
  ...over,
})

/** Strict AABB interior intersection — touching edges do not count. */
const intersects = (
  x: number,
  y: number,
  w: number,
  h: number,
  b: AABB,
): boolean => x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h

describe('pickSize', () => {
  it('sizes an image_result from aspect_ratio metadata plus card chrome', () => {
    const size = pickSize(
      'img_1',
      'image_result',
      imageData({ metadata: { aspect_ratio: '1:1' } }),
      undefined,
    )
    const body = sizeForAspect('1:1')
    expect(size).toEqual({ w: body.w, h: body.h + IMAGE_CARD_CHROME_PX })
    // Pinned literal so a sizeForAspect regression cannot hide inside the
    // shared-helper comparison above.
    expect(size).toEqual({ w: 216, h: 216 + IMAGE_CARD_CHROME_PX })
  })

  it('defaults an image_result without aspect_ratio metadata to 16:9', () => {
    // Documented in placement.ts: the fallback must match the renderer's
    // 16:9 default or pasted batches overlap horizontally.
    const fallback = pickSize('img_1', 'image_result', imageData(), undefined)
    const explicit = pickSize(
      'img_2',
      'image_result',
      imageData({ metadata: { aspect_ratio: '16:9' } }),
      undefined,
    )
    expect(fallback).toEqual(explicit)
  })

  it('prefers video_result data.aspect over metadata.aspect_ratio', () => {
    const size = pickSize(
      'vid_1',
      'video_result',
      videoData({ aspect: '9:16', metadata: { aspect_ratio: '1:1' } }),
      undefined,
    )
    const body = sizeForAspect('9:16')
    expect(size).toEqual({ w: body.w, h: body.h + IMAGE_CARD_CHROME_PX })
    // portrait body, so aspect (not the square metadata ratio) clearly won
    expect(size.h - IMAGE_CARD_CHROME_PX).toBeGreaterThan(size.w)
  })

  it('falls back to metadata.aspect_ratio when a video_result lacks aspect', () => {
    // Wire data predating the `aspect` field can omit it even though the
    // type marks it required — cast to exercise the runtime fallback chain.
    const data = videoData({ metadata: { aspect_ratio: '1:1' } })
    delete (data as { aspect?: string }).aspect
    const size = pickSize('vid_1', 'video_result', data, undefined)
    const body = sizeForAspect('1:1')
    expect(size).toEqual({ w: body.w, h: body.h + IMAGE_CARD_CHROME_PX })
  })

  it('returns the fixed compact pill for audio_result', () => {
    const size = pickSize('aud_1', 'audio_result', audioData(), undefined)
    expect(size).toEqual(NODE_SIZES.audio_result)
  })

  it('uses the measured height for a note when available', () => {
    const measured = new Map([['note_1', 333]])
    const size = pickSize('note_1', 'note', noteData(), measured)
    expect(size).toEqual({ w: 280, h: 333 })
  })

  it('falls back to NOTE_CARD_FALLBACK_HEIGHT for an unmeasured note', () => {
    expect(pickSize('note_1', 'note', noteData(), undefined)).toEqual({
      w: 280,
      h: NOTE_CARD_FALLBACK_HEIGHT,
    })
    // A map that does not know this id behaves like no map at all.
    const other = new Map([['note_other', 999]])
    expect(pickSize('note_1', 'note', noteData(), other)).toEqual({
      w: 280,
      h: NOTE_CARD_FALLBACK_HEIGHT,
    })
  })

  it('routes unknown node types to the note-shaped fallback', () => {
    // The renderer can grow node types before this module learns about
    // them; the terminal branch is the documented catch-all.
    const type = 'mystery' as unknown as CanvasNode['type']
    expect(pickSize('x_1', type, noteData(), undefined)).toEqual({
      w: 280,
      h: NOTE_CARD_FALLBACK_HEIGHT,
    })
  })
})

describe('computeAABBSet', () => {
  it('reads position plus sizeFor into AABBs, preserving order', () => {
    const nodes = [
      { id: 'a', position: { x: 10, y: 20 } },
      { id: 'b', position: { x: -5, y: 0 } },
    ]
    const aabbs = computeAABBSet(nodes, (n) =>
      n.id === 'a' ? { w: 100, h: 50 } : { w: 30, h: 40 },
    )
    expect(aabbs).toEqual([
      { id: 'a', x: 10, y: 20, w: 100, h: 50 },
      { id: 'b', x: -5, y: 0, w: 30, h: 40 },
    ])
  })
})

describe('pickStart', () => {
  it('returns the anchor when it is visible in the viewport', () => {
    expect(pickStart({ x: 100, y: 100 }, vp())).toEqual({ x: 100, y: 100 })
  })

  it('returns the viewport center when the anchor is off-screen', () => {
    expect(pickStart({ x: 5000, y: 100 }, vp())).toEqual({ x: 500, y: 400 })
  })

  it('maps the viewport center through pan and zoom', () => {
    // pan (-200, 100) at zoom 2 → ((w/2 − x)/zoom, (h/2 − y)/zoom)
    expect(pickStart(null, vp({ x: -200, y: 100, zoom: 2 }))).toEqual({
      x: 350,
      y: 150,
    })
  })

  it('returns the anchor when no viewport is known', () => {
    expect(pickStart({ x: 7, y: 9 }, null)).toEqual({ x: 7, y: 9 })
  })

  it('returns the origin when neither anchor nor viewport is known', () => {
    expect(pickStart(null, null)).toEqual({ x: 0, y: 0 })
  })
})

describe('placeNode', () => {
  const size = { w: 100, h: 100 }

  it('places at the anchor when the slot is free', () => {
    const pos = placeNode({ anchor: { x: 40, y: 60 }, viewport: null, size, aabbs: [] })
    expect(pos).toEqual({ x: 40, y: 60 })
  })

  it('spirals to the first free slot when the anchor is blocked', () => {
    const aabbs: AABB[] = [{ id: 'block', x: 0, y: 0, w: 100, h: 100 }]
    const pos = placeNode({ anchor: { x: 0, y: 0 }, viewport: null, size, aabbs })
    // Ring 4 is the first whose east column (x = 4·PADDING = 160) clears
    // the 100-wide blocker by PLACEMENT_PADDING; that column scans
    // top-down, so its first candidate (dy = −4) wins.
    expect(pos).toEqual({ x: 4 * PLACEMENT_PADDING, y: -4 * PLACEMENT_PADDING })
    expect(intersects(pos.x, pos.y, size.w, size.h, aabbs[0])).toBe(false)
  })

  it('is deterministic for identical input', () => {
    const aabbs: AABB[] = [
      { id: 'a', x: 0, y: 0, w: 200, h: 150 },
      { id: 'b', x: 240, y: 0, w: 160, h: 220 },
      { id: 'c', x: 0, y: 190, w: 300, h: 100 },
    ]
    const args = {
      anchor: { x: 50, y: 50 },
      viewport: null,
      size: { w: 120, h: 90 },
      aabbs,
    }
    expect(placeNode(args)).toEqual(placeNode(args))
  })

  it('never overlaps existing nodes across sequential placements', () => {
    // Deterministic cluttered canvas (formula-driven sizes, no RNG), then
    // 20 sequential placements feeding each result back in — mirroring how
    // the projection accumulates AABBs as fresh nodes arrive.
    const aabbs: AABB[] = []
    for (let i = 0; i < 12; i += 1) {
      aabbs.push({
        id: `seed_${i}`,
        x: (i % 4) * 150,
        y: Math.floor(i / 4) * 120,
        w: 100 + ((i * 37) % 120),
        h: 80 + ((i * 53) % 140),
      })
    }
    for (let i = 0; i < 20; i += 1) {
      const s = { w: 90 + ((i * 41) % 130), h: 70 + ((i * 29) % 110) }
      const pos = placeNode({
        anchor: { x: 100, y: 100 },
        viewport: null,
        size: s,
        aabbs,
      })
      for (const a of aabbs) {
        expect(intersects(pos.x, pos.y, s.w, s.h, a)).toBe(false)
      }
      aabbs.push({ id: `placed_${i}`, x: pos.x, y: pos.y, w: s.w, h: s.h })
    }
  })

  it('returns the anchor when the spiral is exhausted', () => {
    // One AABB covering everything the bounded spiral can reach, so even
    // this degenerate case produces a defined position (the anchor).
    const wall: AABB[] = [{ id: 'wall', x: -10000, y: -10000, w: 20000, h: 20000 }]
    const pos = placeNode({ anchor: { x: 3, y: 4 }, viewport: null, size, aabbs: wall })
    expect(pos).toEqual({ x: 3, y: 4 })
  })
})
