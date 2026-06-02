/**
 * Workflow / canvas types — mirror PROJECT_AGENT.md's `version: 2` schema.
 *
 * Source-of-truth shape: each project's `workflow.json` on disk under
 * `projects/<id>/workflow.json`. The viewer (`server/local_viewer.js`)
 * surfaces the parsed JSON via the `canvas_state` field on
 * `/projects/:id`. We don't interpret position here — the renderer
 * computes layout (and persists position via Phase-6 Socket.IO writes,
 * not yet wired).
 */

export type NodeType = 'note' | 'image_result' | 'video_result' | 'audio_result'

export interface NodeMetadataBase {
  source?: string
  task_type?: string
  generated_at?: string
  /** Generation job that minted this node; used for exact pending-card handoff. */
  pending_job_id?: string
}

export type NoteSubtype = 'script' | 'shot'

export interface NoteData {
  /** Optional subtype variant. Plain note when undefined. */
  subtype?: NoteSubtype
  label: string
  body: string
  /** Soft-delete flag. Absent / false → visible. true → filtered out of
   * the projection and from agent reads. Toggled via updateNode patch
   * (`archived: true` to archive, `archived: null` to restore). */
  archived?: boolean
  /** ISO timestamp stamped when the node was archived. Cleared on
   * restore. Sidebar sorts archived rows by this so the most-recently
   * archived appears at the top. */
  archived_at?: string
  metadata?: {
    author?: string
    timestamp?: string
    source_filename?: string
    source_url?: string
  } & NodeMetadataBase
}

export interface NoteNode {
  id: string
  type: 'note'
  data: NoteData
}

export interface ImageResultMetadata extends NodeMetadataBase {
  model?: string
  /** Exact provider size for image-generation-pro, e.g. "2560x1440". */
  size?: string
  aspect_ratio?: string
  image_size?: string
  grid?: string
  /** video-generation-assets asset id once the preupload landed. Persisted by
   * server/services/asset_sync.js on paiAssetEvents 'update' (active).
   * Replaces the per-project .asset_cache.json sidecar. */
  asset_id?: string
  /** Set when the provider moderated the upload. Same persistence path as
   * asset_id. Tells the asset cache reseeder not to retry. */
  asset_rejected_reason?: string
}

export type ImageSubtype =
  | 'character'
  | 'location'
  | 'edit'
  | 'reference'
  | 'split'
  | 'storyboard'

export interface ImageResultData {
  /** Optional subtype variant. Plain image when undefined. */
  subtype?: ImageSubtype
  label: string
  /** Disk truth — wire field. Relative to projects/<id>/.
   * `image_url` is derived by `synthesizeAssetUrls` at the useWorkflow
   * boundary and exposed alongside; the renderer reads `image_url`. */
  local_path: string
  /** Synthesized at the useWorkflow boundary from local_path + projectId.
   * Not stored on disk; refresh-safe because every load re-synthesizes. */
  image_url: string
  prompt?: string
  /** Soft-delete flag. See NoteData.archived. */
  archived?: boolean
  /** ISO timestamp stamped when archived. See NoteData.archived_at. */
  archived_at?: string
  metadata: ImageResultMetadata

  // character / location additions
  name?: string
  role?: string
  description?: string

  // edit additions
  source_id?: string

  // reference additions
  source_filename?: string
  attachment_id?: string

  // split additions
  grid_position?: [number, number]
}

export interface ImageResultNode {
  id: string
  type: 'image_result'
  data: ImageResultData
}

export interface VideoResultMetadata extends NodeMetadataBase {
  model?: string
  duration?: number
  aspect_ratio?: string
  resolution?: string
  generate_audio?: boolean
  /** See ImageResultMetadata.asset_id. */
  asset_id?: string
  asset_rejected_reason?: string
  /** PAI's signed upstream MP4 URL (~24h TTL). Surfaced for future
   * re-download paths; never used as the canvas URL (which always
   * resolves via local_path). */
  provider_output_url?: string
}

export interface VideoResultData {
  label: string
  /** Disk truth — wire field. See ImageResultData.local_path. */
  local_path: string
  /** Synthesized at the useWorkflow boundary. Not stored on disk. */
  video_url: string
  prompt?: string
  duration: number
  aspect: string
  shot_id: number | null
  /** Soft-delete flag. See NoteData.archived. */
  archived?: boolean
  /** ISO timestamp stamped when archived. See NoteData.archived_at. */
  archived_at?: string
  metadata: VideoResultMetadata
}

export interface VideoResultNode {
  id: string
  type: 'video_result'
  data: VideoResultData
}

export type AudioSubtype = 'voice' | 'upload'

export interface AudioResultMetadata extends NodeMetadataBase {
  model?: string
  duration_sec?: number
  source_filename?: string
  content_type?: string
  size_bytes?: number
  attachment_id?: string
  /** See ImageResultMetadata.asset_id. */
  asset_id?: string
  asset_rejected_reason?: string
}

export interface AudioResultData {
  subtype: AudioSubtype
  label: string
  /** Disk truth — wire field. See ImageResultData.local_path. */
  local_path: string
  /** Synthesized at the useWorkflow boundary. Not stored on disk. */
  audio_url: string
  /** TTS subtype: the spoken text. */
  text?: string
  /** TTS subtype: the design brief. */
  prompt?: string
  /** Voice subtype: id of the character this voice was generated for, when attached. */
  source_id?: string
  /** Soft-delete flag. See NoteData.archived. */
  archived?: boolean
  /** ISO timestamp stamped when archived. See NoteData.archived_at. */
  archived_at?: string
  metadata: AudioResultMetadata
}

export interface AudioResultNode {
  id: string
  type: 'audio_result'
  data: AudioResultData
}

export type CanvasNode = NoteNode | ImageResultNode | VideoResultNode | AudioResultNode

export interface Edge {
  from: string
  to: string
  /** Provenance / data-flow link. Renders as a solid gray line. */
  kind?: 'derived'
}

/** Persistent monotonic id counters keyed by schema type. Optional —
 * absent on legacy projects; backfilled by the mutator on first mint. */
export interface NextIds {
  note?: number
  image_result?: number
  video_result?: number
  audio_result?: number
}

export interface Workflow {
  version: 2
  workflow_id: string
  title: string
  nodes: CanvasNode[]
  edges: Edge[]
  next_ids?: NextIds
}

/**
 * Pending-generation sidecars from `projects/<id>/.pending/<jobId>.json`.
 * Lives entirely in viewer + browser state — never persisted into
 * workflow.json.
 *
 *  - `running` — a CLI is in-flight. Removed when the CLI's `finally`
 *    unlinks the sidecar (real image_result / video_result lands).
 *  - `draft`   — agent staged the call via `--stage`; awaiting user
 *    approval on the canvas.
 *  - `failed`  — CLI reported failure and left the sidecar visible.
 */
export interface PendingGeneration {
  id: string
  kind: 'image' | 'video' | 'audio'
  stage: 'running' | 'failed' | 'draft'
  prompt: string
  aspect_ratio: string
  created_at: string | null
  /** Wire-side model id (e.g. "image-generation"); absent if the
   * CLI couldn't resolve a model before writing the sidecar. */
  model?: string
  /** Image pro only: exact provider size (e.g. "2560x1440"). */
  size?: string
  /** Image-only: requested output size ("1K" / "2K" / "4K"). */
  image_size?: string
  /** Video-only: requested resolution ("720p" / "1080p"). */
  resolution?: string
  /** Video-only: requested duration in seconds. */
  duration?: number
  /** Draft-only: USD price snapshot at staging time, for the card chip. */
  cost_usd?: number
  /** Draft-only: CLI filename for replay (e.g. "generate_image.js"). Opaque to UI. */
  script?: string
  /** Audio-only: the spoken line for voice drafts. */
  text?: string
  /** Failed result class/message, when a settled result is shown as a failed pad. */
  klass?: string
  message?: string
  completed_at?: string
  sent?: unknown
  /** Sidecar-persisted drag position. Survives refresh + stage
   * transitions so dragged draft/running pads keep their spot. */
  position?: { x: number; y: number }
  /** Captured `--ref-source-id` / `--ref-audio-source-id` values from
   * the staged invocation. Projection uses these to draw dashed
   * visual edges from source canvas nodes into the pending pad and to
   * resolve into the chip preview list. */
  reference_source_ids?: string[]
  /** Captured `--source-node-id` (the authorship parent for this
   * generation). Projection also draws a dashed edge from this node to
   * the pending pad so the user sees every edge the final node will
   * end up with. Deduped against `reference_source_ids` upstream so
   * the same node never produces two dashed edges. */
  source_node_id?: string
}

export interface GenerationResult {
  job_id: string
  kind: 'image' | 'video' | 'audio'
  status: 'succeeded' | 'failed' | 'aborted' | 'cancelled' | 'timeout'
  ok: boolean
  completed_at?: string
  klass?: string
  message?: string
  node_id?: string | null
  local_path?: string | null
  output_url?: string | null
  model?: string
  prompt?: string
  size?: string
  aspect_ratio?: string
  image_size?: string
  resolution?: string
  duration?: number
  cost_usd?: number
  text?: string
  position?: { x: number; y: number }
  reference_source_ids?: string[]
  source_node_id?: string
  sent?: unknown
  limits?: unknown
}

/** Bundle the viewer returns for `GET /projects/:id`. */
export interface ProjectBundle {
  id: string
  title: string
  agent_id: string
  agent_label: string
  saved: boolean
  created_at?: string
  last_active_at?: string
  canvas_state: Workflow | null
  /** Drag-position + group-frame sidecar; empty if the file doesn't exist yet. */
  canvas_positions?: {
    positions: Record<string, { x: number; y: number }>
    groupFrames: Record<string, {
      memberIds: string[]
      x: number; y: number; width: number; height: number
      hue: number; title: string
    }>
  }
  /** Pending-generation placeholder pads — empty array when no generator is running. */
  pending_generations?: PendingGeneration[]
  /** Durable summaries from `.results/<jobId>.json`, newest first. */
  generation_results?: GenerationResult[]
  /** True iff the user has opted out of the draft gate for this project. */
  dangerously_skip_draft_gate?: boolean
}

/** Row shape for `GET /projects` listing. */
export interface ProjectRow {
  id: string
  title: string
  agent_id: string
  agent_label: string
  saved: boolean
  created_at?: string
  last_active_at?: string
  /** First non-archived video_result's video_url, or null. */
  cover_url: string | null
}
