/**
 * tidy.test.ts — behavior tests for the type-clustered grid pack: row
 * bucketing order, voice adjacency, in-row ordering, wrapping, and
 * input-order independence.
 */
import { describe, expect, it } from 'vitest'
import type {
  AudioResultNode,
  CanvasNode,
  ImageResultNode,
  ImageSubtype,
  NoteNode,
  VideoResultNode,
} from '@/types/canvas'
import { PLACEMENT_PADDING } from './placement'
import { tidyAll } from './tidy'

const PAD = PLACEMENT_PADDING
// Row pitch when every node is 100 tall: baseline drops by tallest + pad.
const ROW = 100 + PAD

const img = (id: string, subtype?: ImageSubtype): ImageResultNode => ({
  id,
  type: 'image_result',
  data: {
    subtype,
    label: id,
    local_path: `assets/images/${id}.png`,
    image_url: '',
    metadata: {},
  },
})

const note = (id: string): NoteNode => ({
  id,
  type: 'note',
  data: { label: id, body: '' },
})

const video = (id: string, shotId: number | null = null): VideoResultNode => ({
  id,
  type: 'video_result',
  data: {
    label: id,
    local_path: `assets/videos/${id}.mp4`,
    video_url: '',
    duration: 5,
    aspect: '16:9',
    shot_id: shotId,
    metadata: {},
  },
})

const audio = (id: string): AudioResultNode => ({
  id,
  type: 'audio_result',
  data: {
    subtype: 'voice',
    label: id,
    local_path: `assets/audios/${id}.mp3`,
    audio_url: '',
    metadata: {},
  },
})

const size100 = (): { w: number; h: number } => ({ w: 100, h: 100 })

/** Type-aware sizing: compact audio pill, 100x100 everything else. */
const sizeFor = (n: { type: CanvasNode['type'] }): { w: number; h: number } =>
  n.type === 'audio_result' ? { w: 60, h: 40 } : { w: 100, h: 100 }

describe('tidyAll', () => {
  it('lays out rows top-to-bottom: characters, locations, notes, videos, other images, orphan audios', () => {
    const nodes: CanvasNode[] = [
      audio('aud_orphan'),
      img('img_other'),
      video('vid_1', 1),
      note('note_1'),
      img('img_loc', 'location'),
      img('img_char', 'character'),
    ]
    const out = tidyAll({ nodes, edges: [], sizeFor: size100 })
    expect(out.get('img_char')).toEqual({ x: PAD, y: PAD })
    expect(out.get('img_loc')).toEqual({ x: PAD, y: PAD + ROW })
    expect(out.get('note_1')).toEqual({ x: PAD, y: PAD + 2 * ROW })
    expect(out.get('vid_1')).toEqual({ x: PAD, y: PAD + 3 * ROW })
    expect(out.get('img_other')).toEqual({ x: PAD, y: PAD + 4 * ROW })
    expect(out.get('aud_orphan')).toEqual({ x: PAD, y: PAD + 5 * ROW })
    expect(out.size).toBe(nodes.length)
  })

  it('skips empty buckets without leaving vertical gaps', () => {
    const out = tidyAll({
      nodes: [note('note_1'), img('img_char', 'character')],
      edges: [],
      sizeFor: size100,
    })
    expect(out.get('img_char')).toEqual({ x: PAD, y: PAD })
    expect(out.get('note_1')).toEqual({ x: PAD, y: PAD + ROW })
  })

  it('seats an attached voice directly right of its character, not in the orphan row', () => {
    const nodes: CanvasNode[] = [
      img('img_char', 'character'),
      audio('aud_voice'),
      audio('aud_orphan'),
    ]
    const edges = [{ from: 'img_char', to: 'aud_voice' }]
    const out = tidyAll({ nodes, edges, sizeFor })
    expect(out.get('img_char')).toEqual({ x: PAD, y: PAD })
    expect(out.get('aud_voice')).toEqual({ x: PAD + 100 + PAD, y: PAD })
    // the unattached voice lands in the orphan-audio row below
    expect(out.get('aud_orphan')).toEqual({ x: PAD, y: PAD + ROW })
    expect(out.size).toBe(3)
  })

  it('ignores edges that do not run character to voice', () => {
    const nodes: CanvasNode[] = [img('img_char', 'character'), audio('aud_voice')]
    // reversed direction — must NOT attach
    const out = tidyAll({
      nodes,
      edges: [{ from: 'aud_voice', to: 'img_char' }],
      sizeFor,
    })
    expect(out.get('aud_voice')).toEqual({ x: PAD, y: PAD + ROW })
  })

  it('orders videos by shot_id ascending with null last, tie-broken by id', () => {
    const nodes: CanvasNode[] = [
      video('vid_c', null),
      video('vid_b', 2),
      video('vid_d', 2),
      video('vid_a', 1),
    ]
    const out = tidyAll({ nodes, edges: [], sizeFor: size100 })
    const xs = ['vid_a', 'vid_b', 'vid_d', 'vid_c'].map((id) => out.get(id)?.x)
    expect(xs).toEqual([PAD, PAD + 140, PAD + 280, PAD + 420])
    const ys = new Set([...out.values()].map((p) => p.y))
    expect(ys.size).toBe(1)
  })

  it('sorts within a bucket by id so layout ignores input order', () => {
    const first = tidyAll({
      nodes: [img('img_b', 'character'), img('img_a', 'character')],
      edges: [],
      sizeFor: size100,
    })
    const second = tidyAll({
      nodes: [img('img_a', 'character'), img('img_b', 'character')],
      edges: [],
      sizeFor: size100,
    })
    expect(first.get('img_a')).toEqual({ x: PAD, y: PAD })
    expect(first.get('img_b')).toEqual({ x: PAD + 140, y: PAD })
    expect(Object.fromEntries(first)).toEqual(Object.fromEntries(second))
  })

  it('produces identical output for any input order of the same graph', () => {
    const nodes: CanvasNode[] = [
      img('img_char', 'character'),
      img('img_loc', 'location'),
      img('img_other'),
      note('note_1'),
      video('vid_1', 1),
      audio('aud_voice'),
      audio('aud_orphan'),
    ]
    const edges = [{ from: 'img_char', to: 'aud_voice' }]
    const forward = tidyAll({ nodes, edges, sizeFor })
    const reversed = tidyAll({ nodes: [...nodes].reverse(), edges, sizeFor })
    expect(Object.fromEntries(forward)).toEqual(Object.fromEntries(reversed))
    expect(forward.size).toBe(nodes.length)
  })

  it('wraps a row at wrapWidth and drops by the row height', () => {
    const nodes: CanvasNode[] = [
      img('img_a', 'character'),
      img('img_b', 'character'),
      img('img_c', 'character'),
      img('img_loc', 'location'),
    ]
    const out = tidyAll({ nodes, edges: [], sizeFor: size100, wrapWidth: 300 })
    expect(out.get('img_a')).toEqual({ x: PAD, y: PAD })
    expect(out.get('img_b')).toEqual({ x: PAD + 140, y: PAD })
    expect(out.get('img_c')).toEqual({ x: PAD, y: PAD + ROW }) // wrapped
    // next bucket starts after both wrapped lines
    expect(out.get('img_loc')).toEqual({ x: PAD, y: PAD + 2 * ROW })
  })

  it('keeps a character/voice pair on one line when wrapping', () => {
    const nodes: CanvasNode[] = [
      img('img_a', 'character'),
      img('img_b', 'character'),
      audio('aud_v'),
    ]
    const edges = [{ from: 'img_a', to: 'aud_v' }]
    const out = tidyAll({ nodes, edges, sizeFor, wrapWidth: 300 })
    expect(out.get('img_a')).toEqual({ x: PAD, y: PAD })
    expect(out.get('aud_v')).toEqual({ x: PAD + 140, y: PAD })
    // pair width (100 + pad + 60) pushed the second character to wrap
    expect(out.get('img_b')).toEqual({ x: PAD, y: PAD + ROW })
  })
})
