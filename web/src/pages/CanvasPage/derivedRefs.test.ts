/**
 * Which card a reference thumbnail's preview jumps to.
 *
 * The point of this file is that the answer is STAMPED, not reconstructed.
 * Resolving a reference to its source is index math in every tempting shape,
 * and every one of those shapes is wrong: React Flow's edges have already
 * dropped archived endpoints while `workflow.edges` have not, so any list
 * built from one and zipped against a list built from the other can differ in
 * length — and from the first gap onward every entry names a different asset's
 * node, with nothing visible to notice. `sourceId` rides on the ref itself,
 * put there by the same pass that read the edge, so there is no second list to
 * drift against.
 */
import { describe, expect, it } from 'vitest'
import type { CanvasNode, Edge, Workflow } from '@/types/canvas'
import { collectDerivedRefs } from './projection'

function wf(nodes: CanvasNode[], edges: Edge[]): Workflow {
  return { version: 2, workflow_id: 'wf_test', title: 'test', nodes, edges }
}

const IMAGE_1 = {
  id: 'image_1',
  type: 'image_result',
  data: { label: 'plate', local_path: 'x', image_url: '/one.png' },
} as unknown as CanvasNode
const AUDIO_4 = {
  id: 'audio_4',
  type: 'audio_result',
  data: { subtype: 'tts', label: 'line', local_path: 'x', audio_url: '/four.mp3', metadata: {} },
} as unknown as CanvasNode
const IMAGE_9 = {
  id: 'image_9',
  type: 'image_result',
  data: { label: 'comp', local_path: 'x', image_url: '/nine.png' },
} as unknown as CanvasNode
const VIDEO_2 = {
  id: 'video_2',
  type: 'video_result',
  data: { label: 'shot', local_path: 'x', video_url: '/two.mp4', aspect: '16:9' },
} as unknown as CanvasNode

describe('collectDerivedRefs', () => {
  it('names the node each reference came from', () => {
    const refs = collectDerivedRefs(
      wf([IMAGE_1, AUDIO_4, IMAGE_9, VIDEO_2], [
        { from: 'image_1', to: 'video_2', kind: 'derived' },
        { from: 'audio_4', to: 'video_2', kind: 'derived' },
        { from: 'image_9', to: 'video_2', kind: 'derived' },
      ]),
      'video_2',
    )
    expect(refs.map((r) => r.sourceId)).toEqual(['image_1', 'audio_4', 'image_9'])
    // The pairing is what matters: every ref's id belongs to the node that
    // published its bytes, not to whatever sat at the same position in some
    // other list.
    expect(refs.map((r) => [r.kind, r.url, r.sourceId])).toEqual([
      ['image', '/one.png', 'image_1'],
      ['audio', '/four.mp3', 'audio_4'],
      ['image', '/nine.png', 'image_9'],
    ])
  })

  it('drops an edge whose source publishes no asset', () => {
    // Notes carry authorship edges (`--source-node-id`) with the same
    // `kind: 'derived'` as byte references — they are sources with nothing to
    // show, and must not shift the refs that follow them.
    const note = { id: 'note_1', type: 'note', data: { body: 'hi' } } as unknown as CanvasNode
    const refs = collectDerivedRefs(
      wf([note, IMAGE_9, VIDEO_2], [
        { from: 'note_1', to: 'video_2', kind: 'derived' },
        { from: 'image_9', to: 'video_2', kind: 'derived' },
      ]),
      'video_2',
    )
    expect(refs.map((r) => r.sourceId)).toEqual(['image_9'])
  })

  it('ignores edges that are not provenance', () => {
    const refs = collectDerivedRefs(
      wf([IMAGE_1, VIDEO_2], [{ from: 'image_1', to: 'video_2' }]),
      'video_2',
    )
    expect(refs).toEqual([])
  })
})
