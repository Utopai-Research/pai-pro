/**
 * tidy.ts — type-clustered grid pack for the "Tidy" button and the
 * one-time auto-arrange on first load (sidecar empty). Replaces the
 * dagre hierarchical layer that used to run on every projection.
 *
 * Rows (top to bottom):
 *   1. characters (image_result.subtype === 'character'), each
 *      followed by its attached voice (audio_result.subtype === 'voice'
 *      reachable via a derived edge) sitting adjacent.
 *   2. locations (image_result.subtype === 'location').
 *   3. notes
 *   4. shot videos (video_result, sorted by shot_id then id)
 *   5. other images (image_result with edit/reference/split/storyboard/plain
 *      subtype or no subtype)
 *   6. orphan audios (audio_result not attached to any character)
 *
 * Within a row, nodes pack left → right and wrap when the cumulative
 * width exceeds `wrapWidth` (default 2× viewport). The next row's
 * baseline drops by the tallest item in the prior row plus
 * PLACEMENT_PADDING.
 *
 * Deterministic: sort by node id within type so a second Tidy on the
 * same graph produces identical output.
 */
import type { CanvasNode } from '@/types/canvas'
import { PLACEMENT_PADDING } from './placement'

interface NodeInput {
  id: string
  type: CanvasNode['type']
  data: CanvasNode['data']
}

interface EdgeInput {
  from: string
  to: string
}

const DEFAULT_WRAP_WIDTH = 2400

export function tidyAll(args: {
  nodes: ReadonlyArray<NodeInput>
  edges: ReadonlyArray<EdgeInput>
  sizeFor: (n: NodeInput) => { w: number; h: number }
  wrapWidth?: number
}): Map<string, { x: number; y: number }> {
  const { nodes, edges, sizeFor } = args
  const wrap = args.wrapWidth ?? DEFAULT_WRAP_WIDTH

  const byId = new Map(nodes.map((n) => [n.id, n]))

  // Voice → character link: a `derived` edge whose source is an
  // image_result.subtype=character and target is an
  // audio_result.subtype=voice means the voice belongs to that
  // character. We render the voice adjacent in the character row
  // rather than dropping it into the orphan-audio row.
  const subtypeOf = (n: NodeInput): string | undefined =>
    (n.data as { subtype?: string }).subtype
  const voiceByChar = new Map<string, string>()
  for (const e of edges) {
    const src = byId.get(e.from)
    const tgt = byId.get(e.to)
    if (src === undefined || tgt === undefined) continue
    if (src.type !== 'image_result' || subtypeOf(src) !== 'character') continue
    if (tgt.type !== 'audio_result' || subtypeOf(tgt) !== 'voice') continue
    voiceByChar.set(src.id, tgt.id)
  }
  const attachedVoiceIds = new Set(voiceByChar.values())

  const characters: NodeInput[] = []
  const locations: NodeInput[] = []
  const notes: NodeInput[] = []
  const otherImages: NodeInput[] = []
  const videos: NodeInput[] = []
  const orphanAudios: NodeInput[] = []
  for (const n of nodes) {
    if (n.type === 'image_result') {
      const sub = subtypeOf(n)
      if (sub === 'character') characters.push(n)
      else if (sub === 'location') locations.push(n)
      else otherImages.push(n)
    } else if (n.type === 'note') notes.push(n)
    else if (n.type === 'video_result') videos.push(n)
    else if (n.type === 'audio_result' && !attachedVoiceIds.has(n.id)) {
      orphanAudios.push(n)
    }
  }

  const byIdAsc = (a: NodeInput, b: NodeInput): number => a.id.localeCompare(b.id)
  characters.sort(byIdAsc)
  locations.sort(byIdAsc)
  notes.sort(byIdAsc)
  otherImages.sort(byIdAsc)
  orphanAudios.sort(byIdAsc)
  videos.sort((a, b) => {
    const sa = (a.data as { shot_id?: number | null }).shot_id ?? Number.POSITIVE_INFINITY
    const sb = (b.data as { shot_id?: number | null }).shot_id ?? Number.POSITIVE_INFINITY
    if (sa !== sb) return sa - sb
    return a.id.localeCompare(b.id)
  })

  const out = new Map<string, { x: number; y: number }>()
  let y = PLACEMENT_PADDING

  const layRow = (items: ReadonlyArray<NodeInput>): void => {
    if (items.length === 0) return
    let x = PLACEMENT_PADDING
    let rowMaxH = 0
    for (const n of items) {
      const size = sizeFor(n)
      const voiceId = voiceByChar.get(n.id)
      const voice = voiceId !== undefined ? byId.get(voiceId) : undefined
      const voiceSize = voice !== undefined ? sizeFor(voice) : null
      const totalW =
        size.w + (voiceSize !== null ? PLACEMENT_PADDING + voiceSize.w : 0)

      if (x > PLACEMENT_PADDING && x + totalW > wrap) {
        x = PLACEMENT_PADDING
        y += rowMaxH + PLACEMENT_PADDING
        rowMaxH = 0
      }
      out.set(n.id, { x, y })
      let nextX = x + size.w
      let pairH = size.h
      if (voice !== undefined && voiceSize !== null) {
        out.set(voice.id, { x: nextX + PLACEMENT_PADDING, y })
        nextX += PLACEMENT_PADDING + voiceSize.w
        if (voiceSize.h > pairH) pairH = voiceSize.h
      }
      x = nextX + PLACEMENT_PADDING
      if (pairH > rowMaxH) rowMaxH = pairH
    }
    y += rowMaxH + PLACEMENT_PADDING
  }

  for (const bucket of [characters, locations, notes, videos, otherImages, orphanAudios]) {
    layRow(bucket)
  }
  return out
}
