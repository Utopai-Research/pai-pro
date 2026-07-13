/**
 * workflowMerge.test.ts — behavior tests for the structural-sharing
 * merge and the asset-URL synthesis seam. Identity assertions use toBe
 * on purpose: reference stability is the module's contract.
 */
import { describe, expect, it } from 'vitest'
import type { CanvasNode, Workflow } from '@/types/canvas'
import { mergeWorkflow, synthesizeAssetUrls } from './workflowMerge'

const baseWorkflow = (): Workflow => ({
  version: 2,
  workflow_id: 'wf_1',
  title: 'Test project',
  nodes: [
    { id: 'note_1', type: 'note', data: { label: 'Script', body: 'INT. LAB — NIGHT' } },
    {
      id: 'img_1',
      type: 'image_result',
      data: {
        label: 'Hero',
        local_path: 'assets/images/img_1.png',
        image_url: '',
        metadata: { aspect_ratio: '1:1' },
      },
    },
    {
      id: 'vid_1',
      type: 'video_result',
      data: {
        label: 'Shot 1',
        local_path: 'assets/videos/vid_1.mp4',
        video_url: '',
        duration: 5,
        aspect: '16:9',
        shot_id: 1,
        metadata: {},
      },
    },
  ],
  edges: [
    { from: 'note_1', to: 'img_1', kind: 'derived' },
    { from: 'img_1', to: 'vid_1', kind: 'derived' },
  ],
  next_ids: { note: 2, image_result: 2, video_result: 2 },
})

const assetWorkflow = (): Workflow => ({
  version: 2,
  workflow_id: 'wf_1',
  title: 'Assets',
  nodes: [
    { id: 'note_1', type: 'note', data: { label: 'n', body: '' } },
    {
      id: 'img_1',
      type: 'image_result',
      data: { label: 'i', local_path: 'assets/images/img_1.png', image_url: '', metadata: {} },
    },
    {
      id: 'vid_1',
      type: 'video_result',
      data: {
        label: 'v',
        local_path: 'assets/videos/vid_1.mp4',
        video_url: '',
        duration: 5,
        aspect: '16:9',
        shot_id: null,
        metadata: {},
      },
    },
    {
      id: 'aud_1',
      type: 'audio_result',
      data: { subtype: 'voice', label: 'a', local_path: 'assets/audios/aud_1.mp3', audio_url: '', metadata: {} },
    },
  ],
  edges: [],
})

const dataOf = (n: CanvasNode): Record<string, unknown> =>
  n.data as unknown as Record<string, unknown>

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

describe('mergeWorkflow', () => {
  it('returns prev by reference when prev and next are the same object', () => {
    const wf = baseWorkflow()
    expect(mergeWorkflow(wf, wf)).toBe(wf)
    expect(mergeWorkflow(null, null)).toBeNull()
  })

  it('returns next when prev is null', () => {
    const next = baseWorkflow()
    expect(mergeWorkflow(null, next)).toBe(next)
  })

  it('returns null when next is null', () => {
    expect(mergeWorkflow(baseWorkflow(), null)).toBeNull()
  })

  it('returns prev by reference when next is a content-identical clone', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    expect(next).not.toBe(prev)
    expect(mergeWorkflow(prev, next)).toBe(prev)
  })

  it('replaces only the changed node and keeps identity for everything else', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.nodes[1].data.label = 'Hero v2'
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged).not.toBe(prev)
    expect(merged.nodes).not.toBe(prev.nodes)
    expect(merged.nodes[0]).toBe(prev.nodes[0])
    expect(merged.nodes[1]).toBe(next.nodes[1]) // changed subtree is a new object
    expect(merged.nodes[2]).toBe(prev.nodes[2])
    expect(merged.edges).toBe(prev.edges) // untouched array keeps identity
    expect(merged.next_ids).toBe(prev.next_ids)
  })

  it('keeps node and edge array identity when only a scalar changed', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.title = 'Renamed'
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged).not.toBe(prev)
    expect(merged.title).toBe('Renamed')
    expect(merged.nodes).toBe(prev.nodes)
    expect(merged.edges).toBe(prev.edges)
  })

  it('keeps prev node identity when a node is appended', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.nodes.push({ id: 'note_2', type: 'note', data: { label: 'New', body: '' } })
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged.nodes).toHaveLength(4)
    expect(merged.nodes[0]).toBe(prev.nodes[0])
    expect(merged.nodes[1]).toBe(prev.nodes[1])
    expect(merged.nodes[2]).toBe(prev.nodes[2])
    expect(merged.nodes[3]).toBe(next.nodes[3])
  })

  it('drops removed nodes while preserving identity of the survivors', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.nodes.splice(1, 1)
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged.nodes.map((n) => n.id)).toEqual(['note_1', 'vid_1'])
    expect(merged.nodes[0]).toBe(prev.nodes[0])
    expect(merged.nodes[1]).toBe(prev.nodes[2])
  })

  it('adopts next order while reusing prev node objects', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.nodes.reverse()
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged).not.toBe(prev)
    expect(merged.nodes.map((n) => n.id)).toEqual(['vid_1', 'img_1', 'note_1'])
    expect(merged.nodes[0]).toBe(prev.nodes[2])
    expect(merged.nodes[2]).toBe(prev.nodes[0])
  })

  it('replaces only the changed edge', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    delete next.edges[1].kind
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged.edges).not.toBe(prev.edges)
    expect(merged.edges[0]).toBe(prev.edges[0])
    expect(merged.edges[1]).toBe(next.edges[1])
  })

  it('takes next_ids from next when counters advanced', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.next_ids = { ...next.next_ids, note: 3 }
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged.next_ids).toBe(next.next_ids)
    expect(merged.nodes).toBe(prev.nodes)
  })

  it('never mutates its inputs (frozen workflows merge without throwing)', () => {
    const prev = baseWorkflow()
    const next = structuredClone(prev)
    next.nodes[0].data.label = 'Edited'
    deepFreeze(prev)
    deepFreeze(next)
    const merged = mergeWorkflow(prev, next)
    if (merged === null) throw new Error('expected a workflow')
    expect(merged.nodes[0]).toBe(next.nodes[0])
    expect(merged.nodes[1]).toBe(prev.nodes[1])
  })
})

describe('synthesizeAssetUrls', () => {
  it('derives image_url / video_url / audio_url from local_path', () => {
    const wf = assetWorkflow()
    const out = synthesizeAssetUrls(wf, 'proj-1')
    if (out === null) throw new Error('expected a workflow')
    expect(out).not.toBe(wf)
    expect(dataOf(out.nodes[1]).image_url).toBe('/projects/proj-1/assets/images/img_1.png')
    expect(dataOf(out.nodes[2]).video_url).toBe('/projects/proj-1/assets/videos/vid_1.mp4')
    expect(dataOf(out.nodes[3]).audio_url).toBe('/projects/proj-1/assets/audios/aud_1.mp3')
    // non-asset nodes keep identity
    expect(out.nodes[0]).toBe(wf.nodes[0])
  })

  it('does not mutate its input workflow', () => {
    const wf = deepFreeze(assetWorkflow())
    const out = synthesizeAssetUrls(wf, 'proj-1')
    if (out === null) throw new Error('expected a workflow')
    expect(dataOf(wf.nodes[1]).image_url).toBe('')
    expect(dataOf(out.nodes[1]).image_url).toBe('/projects/proj-1/assets/images/img_1.png')
  })

  it('returns the same reference when every URL is already correct', () => {
    const once = synthesizeAssetUrls(assetWorkflow(), 'proj-1')
    if (once === null) throw new Error('expected a workflow')
    expect(synthesizeAssetUrls(once, 'proj-1')).toBe(once)
  })

  it('strips leading slashes from local_path', () => {
    const wf = assetWorkflow()
    dataOf(wf.nodes[1]).local_path = '//assets/images/img_1.png'
    const out = synthesizeAssetUrls(wf, 'p')
    if (out === null) throw new Error('expected a workflow')
    expect(dataOf(out.nodes[1]).image_url).toBe('/projects/p/assets/images/img_1.png')
  })

  it('URL-encodes the project id', () => {
    const out = synthesizeAssetUrls(assetWorkflow(), 'my project/2')
    if (out === null) throw new Error('expected a workflow')
    expect(dataOf(out.nodes[1]).image_url).toBe(
      '/projects/my%20project%2F2/assets/images/img_1.png',
    )
  })

  it('leaves asset nodes without a local_path untouched, by reference', () => {
    const wf: Workflow = {
      version: 2,
      workflow_id: 'wf_1',
      title: 'Empty path',
      nodes: [
        {
          id: 'img_1',
          type: 'image_result',
          data: { label: 'i', local_path: '', image_url: '', metadata: {} },
        },
      ],
      edges: [],
    }
    expect(synthesizeAssetUrls(wf, 'p')).toBe(wf)
  })

  it('passes null workflow / null projectId through unchanged', () => {
    expect(synthesizeAssetUrls(null, 'p')).toBeNull()
    const wf = assetWorkflow()
    expect(synthesizeAssetUrls(wf, null)).toBe(wf)
  })
})
