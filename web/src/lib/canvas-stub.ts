/**
 * Canvas position writes — Socket.IO + HTTP backing.
 *
 * CanvasPage talks to this module to (a) read drag positions + group
 * frames via `subscribeCanvasPositions`, and (b) persist user
 * mutations via the four set/delete fns below. The wire format:
 *
 *   READ: GET /projects/:id (bundle.canvas_positions) seeds initial
 *         state, then `canvas-positions` Socket.IO events deliver
 *         every disk change.
 *   WRITE: PATCH /projects/:id/positions
 *          POST /projects/:id/canvas-layout
 *
 * The server persists each mutation to projects/<id>/canvas_positions.json
 * and rebroadcasts the new full state to every subscribed socket.
 */
import { getSocket, VIEWER_URL } from './socket'

export interface CanvasGroupFrame {
  memberIds: string[]
  x: number
  y: number
  width: number
  height: number
  hue: number
  title: string
}

export interface CanvasPositionsState {
  positions: Record<string, { x: number; y: number }>
  groupFrames: Record<string, CanvasGroupFrame>
}

export interface CanvasLayoutPatch {
  positions?: Record<string, { x: number; y: number } | null>
  groupFrames?: {
    upsert?: Record<string, CanvasGroupFrame>
    delete?: string[]
  }
}

// ────────────────────────────────────────────────────────────────────
// Writes — fire-and-forget HTTP. Server emits canvas-positions via
// Socket.IO once the disk write lands; that updates every connected
// tab's React state.
// ────────────────────────────────────────────────────────────────────

async function patch(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`PATCH ${url} → ${res.status} ${res.statusText} ${txt}`)
  }
}

async function del(url: string): Promise<void> {
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`DELETE ${url} → ${res.status} ${res.statusText} ${txt}`)
  }
}

export async function setCanvasNodePosition(
  projectId: string | null,
  nodeId: string,
  pos: { x: number; y: number },
): Promise<void> {
  if (!projectId) return
  await patch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/positions`,
    { [nodeId]: pos },
  )
}

/**
 * Batched position write — single PATCH that lands N updates atomically
 * on the server. Use over a loop of `setCanvasNodePosition` for batch
 * placement / handoff / Tidy persists: one CORS preflight + one fetch
 * is dramatically more likely to survive page unload than N parallel
 * calls (each triggering its own preflight; even with keepalive the
 * preflight itself isn't keepalive-able).
 */
export async function setCanvasNodePositions(
  projectId: string | null,
  updates: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
): Promise<void> {
  if (!projectId || updates.length === 0) return
  const body: Record<string, { x: number; y: number }> = {}
  for (const u of updates) body[u.id] = u.position
  await patch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/positions`,
    body,
  )
}

export async function applyCanvasLayout(
  projectId: string | null,
  layout: CanvasLayoutPatch,
): Promise<void> {
  if (!projectId) return
  const url = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/canvas-layout`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`POST ${url} → ${res.status} ${res.statusText} ${txt}`)
  }
}

/**
 * Generic canvas mutator entry. Posts an envelope (request_id, op, payload)
 * to the viewer's `/projects/:id/mutate` route, which fans through
 * `server/canvas_mutator.js` and broadcasts the new canvas-state on
 * success. Rejects with an Error carrying the mutator's failure class
 * + message when the reply is `{ ok: false }`.
 */
export async function mutateCanvas(
  projectId: string | null,
  op: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true; [key: string]: unknown }> {
  if (!projectId) throw new Error('mutateCanvas: no projectId')
  const requestId = `viewer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const url = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/mutate`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, op, payload, actor: 'browser' }),
  })
  const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; klass?: string; message?: string }
  if (!res.ok || reply.ok !== true) {
    const klass = reply.klass ?? `http_${res.status}`
    const msg = reply.message ?? `${res.status} ${res.statusText}`
    throw new Error(`${op} failed (${klass}): ${msg}`)
  }
  return reply as { ok: true; [key: string]: unknown }
}

export interface CanvasNodeDataUpdate {
  nodeId: string
  data: Record<string, unknown>
}

export async function patchCanvasNodeDataBatch(
  projectId: string | null,
  updates: ReadonlyArray<CanvasNodeDataUpdate>,
): Promise<void> {
  if (!projectId || updates.length === 0) return
  await patch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/nodes/batch-data`,
    { updates },
  )
}

// ────────────────────────────────────────────────────────────────────
// Pending-draft mutations. Each round-trip is fire-and-forget HTTP;
// the viewer's chokidar watcher fans the resulting sidecar
// add/change/unlink back via the `pending-generations` socket event,
// while Generate/Cancel resolve `.results/<jobId>.json` for agents.
// ────────────────────────────────────────────────────────────────────

export interface PendingDraftPatch {
  prompt?: string
  aspect_ratio?: string
  image_size?: string
  resolution?: string
  duration?: number
  text?: string
}

export async function patchPendingDraft(
  projectId: string | null,
  jobId: string,
  body: PendingDraftPatch,
): Promise<void> {
  if (!projectId) throw new Error('patchPendingDraft: no projectId')
  await patch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/pending/${encodeURIComponent(jobId)}`,
    body,
  )
}

/**
 * Persist a pending pad's drag position into its sidecar so the
 * position survives page refresh + stage transitions (draft → running).
 * The PATCH route allows `position` on any stage; only `prompt` and the
 * other content fields are gated on draft.
 */
export async function setPendingPosition(
  projectId: string | null,
  jobId: string,
  pos: { x: number; y: number },
): Promise<void> {
  if (!projectId) return
  await patch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/pending/${encodeURIComponent(jobId)}`,
    { position: pos },
  )
}

export async function firePendingDraft(
  projectId: string | null,
  jobId: string,
): Promise<void> {
  if (!projectId) throw new Error('firePendingDraft: no projectId')
  const url = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/pending/${encodeURIComponent(jobId)}/generate`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`POST ${url} → ${res.status} ${res.statusText} ${txt}`)
  }
}

export async function discardPendingDraft(
  projectId: string | null,
  jobId: string,
): Promise<void> {
  if (!projectId) throw new Error('discardPendingDraft: no projectId')
  await del(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/pending/${encodeURIComponent(jobId)}`,
  )
}

export interface ReelUpscaleDraft {
  reel_node_id: string
  job_id: string
  cost_usd?: number
  shot_count?: number
  source_resolution?: string
  target_resolution?: string
  duration?: number
  prompt?: string
}

export async function stageReelUpscaleDraft(
  projectId: string | null,
): Promise<ReelUpscaleDraft> {
  if (!projectId) throw new Error('stageReelUpscaleDraft: no projectId')
  const url = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/reel/upscale-4k/draft`
  const res = await fetch(url, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.ok !== true) {
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : `POST ${url} -> ${res.status} ${res.statusText}`,
    )
  }
  return body as ReelUpscaleDraft
}

// ────────────────────────────────────────────────────────────────────
// User-dropped / pasted file upload. POSTs multipart/form-data to
// /projects/:id/upload. Server builds the canvas node + appends it
// to workflow.json, then broadcasts canvas-state so this tab and any
// other connected tabs see the new node land. The fetch resolves to
// the node descriptor; callers can use it for inline UX (toast etc.)
// but don't need to push it into local state — Socket.IO handles that.
// ────────────────────────────────────────────────────────────────────

export interface UploadedNode {
  id: string
  type: 'image_result' | 'video_result' | 'audio_result' | 'note'
  data: Record<string, unknown>
}

/**
 * Multi-file upload. Sends N files in one POST → server does one `addBatch`
 * mutation → one canvas-state broadcast → the client merge layer sees N
 * fresh ids together so `gridPackBatch` lays them out as a grid instead of
 * spiraling them into a chain. `pos` is honored only when `files.length`
 * is 1 (single drag-drop's "land at cursor" UX); multi-file batches let
 * gridPackBatch decide placement.
 */
export async function apiUploadAttachments(
  projectId: string | null,
  files: ReadonlyArray<File>,
  pos?: { x: number; y: number } | null,
): Promise<UploadedNode[]> {
  if (!projectId) throw new Error('apiUploadAttachments: projectId required')
  if (files.length === 0) return []
  const form = new FormData()
  for (const f of files) form.append('file', f, f.name)
  if (files.length === 1 && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    form.append('x', String(pos.x))
    form.append('y', String(pos.y))
  }
  const res = await fetch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/upload`,
    { method: 'POST', body: form },
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`POST upload → ${res.status} ${res.statusText} ${txt}`)
  }
  const j = (await res.json()) as { ok: boolean; nodes?: UploadedNode[]; error?: string }
  if (!j.ok || !j.nodes) {
    throw new Error(j.error || 'upload failed')
  }
  return j.nodes
}

/** Single-file convenience over `apiUploadAttachments` — used by inline
 *  flows (MediaExpandChat drop-to-attach) that author one node at a time. */
export async function apiUploadAttachment(
  projectId: string | null,
  file: File,
  pos?: { x: number; y: number } | null,
): Promise<UploadedNode> {
  const nodes = await apiUploadAttachments(projectId, [file], pos)
  const first = nodes[0]
  if (!first) throw new Error('upload failed: server returned no node')
  return first
}

// ────────────────────────────────────────────────────────────────────
// Subscribe — Socket.IO. Server emits canvas-positions on subscribe
// (initial seed) and on every disk change. Returns unsubscribe.
// ────────────────────────────────────────────────────────────────────

export function subscribeCanvasPositions(
  projectId: string | null,
  onSnapshot: (state: CanvasPositionsState | null) => void,
  onError?: (err: Error) => void,
): () => void {
  if (!projectId) {
    Promise.resolve().then(() =>
      onSnapshot({ positions: {}, groupFrames: {} }),
    )
    return () => {
      /* no-op */
    }
  }
  const socket = getSocket()
  const handler = (msg: { projectId: string; state: CanvasPositionsState }) => {
    if (msg.projectId !== projectId) return
    try {
      onSnapshot(msg.state)
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)))
    }
  }
  socket.on('canvas-positions', handler)
  socket.emit('subscribe', { projectId })
  return () => {
    socket.off('canvas-positions', handler)
  }
}
