/**
 * copyPaste.test.ts — the rules a copy must obey: no bytes move, no archive
 * state travels, incoming edges follow but outgoing ones don't, edges between
 * copied nodes remap onto the copies, and a clip from another project is
 * refused.
 */
import { describe, expect, it } from 'vitest'
import {
  buildClipPayload,
  cleanNodeData,
  pastePositions,
  planPaste,
  readClipPayload,
  SYNTHESIZED_URL_FIELDS,
  type ClipPayload,
} from './copyPaste'
import { synthesizeAssetUrls } from '@/lib/workflowMerge'
import type { Workflow } from '@/types/canvas'

const IMAGE_NODE = {
  id: 'image_1',
  type: 'image_result',
  data: {
    label: 'A still',
    local_path: 'assets/images/image_1.png',
    image_url: '/projects/p/assets/images/image_1.png',
    archived: true,
    archived_at: '2026-08-18T00:00:00Z',
    metadata: { source: 'pai', pending_job_id: 'pending_abc' },
  },
}

describe('cleanNodeData', () => {
  it('keeps local_path — a copy is a second pointer at the same bytes', () => {
    const out = cleanNodeData(IMAGE_NODE.data)
    expect(out.local_path).toBe('assets/images/image_1.png')
  })

  it('drops archive state, render-time URLs, and the original pending job id', () => {
    const out = cleanNodeData(IMAGE_NODE.data)
    expect(out.archived).toBeUndefined()
    expect(out.archived_at).toBeUndefined()
    expect(out.image_url).toBeUndefined()
    expect((out.metadata as Record<string, unknown>).pending_job_id).toBeUndefined()
    // The rest of the metadata bag survives.
    expect((out.metadata as Record<string, unknown>).source).toBe('pai')
  })

  it('does not mutate the source node', () => {
    cleanNodeData(IMAGE_NODE.data)
    expect(IMAGE_NODE.data.archived).toBe(true)
    expect(IMAGE_NODE.data.image_url).toBe('/projects/p/assets/images/image_1.png')
  })

  it('strips exactly the URL fields the wire→state seam injects', () => {
    // Derived from the real function so this list cannot fall behind it: feed
    // one node of each media type through synthesizeAssetUrls and see which
    // keys it added.
    const wf = {
      version: 2,
      workflow_id: 'p',
      title: '',
      nodes: [
        { id: 'image_1', type: 'image_result', data: { label: 'i', local_path: 'assets/images/image_1.png', metadata: {} } },
        { id: 'video_1', type: 'video_result', data: { label: 'v', local_path: 'assets/videos/video_1.mp4', duration: 5, aspect: '16:9', metadata: {} } },
        { id: 'audio_1', type: 'audio_result', data: { label: 'a', subtype: 'voice', local_path: 'assets/audios/audio_1.wav', metadata: {} } },
      ],
      edges: [],
    } as unknown as Workflow
    const decorated = synthesizeAssetUrls(wf, 'p')
    const injected = new Set<string>()
    decorated?.nodes.forEach((n, i) => {
      const before = Object.keys(wf.nodes[i].data)
      Object.keys(n.data).forEach((k) => {
        if (!before.includes(k)) injected.add(k)
      })
    })
    expect([...injected].sort()).toEqual([...SYNTHESIZED_URL_FIELDS].sort())
  })
})

describe('buildClipPayload', () => {
  const workflowNodes = [
    { id: 'image_1', type: 'image_result', data: { label: 'a', local_path: 'x.png', metadata: {} } },
    { id: 'image_2', type: 'image_result', data: { label: 'b', local_path: 'y.png', metadata: {} } },
    { id: 'note_1', type: 'note', data: { label: 'n', body: 'text' } },
  ]

  it('returns null when nothing copyable is selected', () => {
    const clip = buildClipPayload({
      projectId: 'p',
      // A pending pad: on the React Flow surface but not a workflow node.
      selection: [{ id: 'pending_x', position: { x: 0, y: 0 } }],
      workflowNodes,
      workflowEdges: [],
    })
    expect(clip).toBeNull()
  })

  it('records positions relative to the selection bounding box', () => {
    const clip = buildClipPayload({
      projectId: 'p',
      selection: [
        { id: 'image_1', position: { x: 100, y: 50 } },
        { id: 'image_2', position: { x: 160, y: 90 } },
      ],
      workflowNodes,
      workflowEdges: [],
    })
    expect(clip?.origin).toEqual({ x: 100, y: 50 })
    expect(clip?.nodes[0].relPos).toEqual({ x: 0, y: 0 })
    expect(clip?.nodes[1].relPos).toEqual({ x: 60, y: 40 })
  })

  it('copies incoming edges and never outgoing ones', () => {
    const clip = buildClipPayload({
      projectId: 'p',
      selection: [{ id: 'image_2', position: { x: 0, y: 0 } }],
      workflowNodes,
      workflowEdges: [
        // incoming: image_2 was made from image_1 — the copy shares that lineage
        { from: 'image_1', to: 'image_2', kind: 'derived' },
        // outgoing: note_1 referenced the ORIGINAL, so the copy must not claim it
        { from: 'image_2', to: 'note_1', kind: 'derived' },
      ],
    })
    expect(clip?.edges).toEqual([
      { from: 'image_1', to: '$0', kind: 'derived' },
    ])
  })

  it('remaps an edge between two copied nodes onto the copies', () => {
    const clip = buildClipPayload({
      projectId: 'p',
      selection: [
        { id: 'image_1', position: { x: 0, y: 0 } },
        { id: 'image_2', position: { x: 10, y: 0 } },
      ],
      workflowNodes,
      workflowEdges: [{ from: 'image_1', to: 'image_2', kind: 'derived' }],
    })
    expect(clip?.edges).toEqual([{ from: '$0', to: '$1', kind: 'derived' }])
  })
})

describe('readClipPayload', () => {
  it('rejects anything that is not a v1 payload', () => {
    expect(readClipPayload('')).toBeNull()
    expect(readClipPayload('not json')).toBeNull()
    expect(readClipPayload('{"v":2}')).toBeNull()
    expect(readClipPayload(JSON.stringify({ v: 1, projectId: 'p' }))).toBeNull()
  })

  it('round-trips a payload it built', () => {
    const clip = buildClipPayload({
      projectId: 'p',
      selection: [{ id: 'image_1', position: { x: 0, y: 0 } }],
      workflowNodes: [
        { id: 'image_1', type: 'image_result', data: { label: 'a', local_path: 'x.png', metadata: {} } },
      ],
      workflowEdges: [],
    })
    expect(readClipPayload(JSON.stringify(clip))).toEqual(clip)
  })
})

describe('planPaste', () => {
  const clip: ClipPayload = {
    v: 1,
    projectId: 'p',
    origin: { x: 0, y: 0 },
    nodes: [{ type: 'note', data: { label: 'n', body: 'b' }, relPos: { x: 0, y: 0 } }],
    edges: [],
  }

  it('refuses a clip from another project', () => {
    // Its bytes live under the other project's directory, so the copied
    // local_path would not resolve here.
    expect(planPaste(clip, 'other')).toEqual({ kind: 'foreign' })
  })

  it('produces an addBatch with no tmp_path, so no asset move happens', () => {
    const plan = planPaste(clip, 'p')
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.addBatch.nodes[0]).not.toHaveProperty('tmp_path')
    expect(plan.addBatch.nodes[0].type).toBe('note')
  })
})

describe('pastePositions', () => {
  const clip: ClipPayload = {
    v: 1,
    projectId: 'p',
    origin: { x: 100, y: 100 },
    nodes: [
      { type: 'note', data: {}, relPos: { x: 0, y: 0 }, size: { w: 200, h: 100 } },
      { type: 'note', data: {}, relPos: { x: 220, y: 0 }, size: { w: 200, h: 100 } },
    ],
    edges: [],
  }

  it('centres the pasted set on the pointer when there is one', () => {
    const out = pastePositions({
      nodeIds: ['note_9', 'note_10'],
      clip,
      anchor: { x: 500, y: 300 },
      pasteCount: 1,
    })
    // Full width 420, height 100 → top-left is (500-210, 300-50).
    expect(out[0].position).toEqual({ x: 290, y: 250 })
    expect(out[1].position).toEqual({ x: 510, y: 250 })
  })

  it('stairs repeated pastes instead of stacking them', () => {
    const first = pastePositions({ nodeIds: ['a', 'b'], clip, anchor: null, pasteCount: 1 })
    const second = pastePositions({ nodeIds: ['c', 'd'], clip, anchor: null, pasteCount: 2 })
    expect(first[0].position).toEqual({ x: 140, y: 140 })
    expect(second[0].position).toEqual({ x: 180, y: 180 })
  })

  it('zips ids with clip nodes by index and stops at the shorter one', () => {
    const out = pastePositions({ nodeIds: ['only_one'], clip, anchor: null, pasteCount: 1 })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('only_one')
  })
})
