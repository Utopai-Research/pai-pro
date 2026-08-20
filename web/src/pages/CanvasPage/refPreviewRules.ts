/**
 * The decidable half of the reference preview — the gate, the timing, and the
 * two fields the audio preview reads off its source node.
 *
 * It lives in a `.ts` beside the portal rather than inside it because
 * `web/vitest.config.ts` collects `.test.ts` files under `src/` in a node
 * environment: a rule that only exists inside a `.tsx` is a rule nothing can
 * assert — there is no DOM to render it into and no suite that reaches it. The
 * gate below is the one worth pinning — it decides whether a reference gets an
 * enlarged view at all, and getting it wrong fails silently as "hovering does
 * nothing".
 */

/**
 * Which references get an enlarged view.
 *
 * `url !== ''` gates everything: a reference with no bytes has nothing to show
 * whatever its kind is. Audio passes even though it has no picture to
 * enlarge — it gets a preview of a different SHAPE instead of a bigger image:
 * the line it speaks, how long it is, and which card it came from. Leaving it
 * out would give every audio reference the same `🔊` and no way to reach its
 * source.
 */
export function canPreviewRef(kind: string, url: string): boolean {
  return url !== '' && (kind === 'image' || kind === 'video' || kind === 'audio')
}

/**
 * How long the cursor must rest on an audio reference before it starts
 * playing.
 *
 * NOT the same timer as `REF_PREVIEW_HIDE_DELAY_MS`, and it must not share a
 * ref with it. That one is a LEAVE grace period — it keeps the preview alive
 * while the cursor crosses the gap to reach it. This one is an ENTER delay,
 * and it exists so that sweeping the mouse along a row of references does not
 * fire every clip in it. They run in opposite directions and overlap in time.
 */
export const AUDIO_AUTOPLAY_DELAY_MS = 300

/** The subset of a projected audio node's data this module reads. */
export interface AudioNodeDataLike {
  text?: unknown
  metadata?: { duration_sec?: unknown } | unknown
}

/**
 * An audio node's duration in seconds, or null when the node doesn't know.
 *
 * One spelling in this repo: `metadata.duration_sec`, declared in
 * `server/canvas_schema.js` and written by `server/cli/generate_voice.js`.
 * Nodes minted before that field existed carry nothing, which is why null is a
 * real answer rather than an error — the preview then shows no clock instead
 * of a `0:00` it made up. A duration read off the `<audio>` element once it
 * loads is a measurement, and the caller prefers that over nothing.
 */
export function audioDurationOf(data: AudioNodeDataLike | null | undefined): number | null {
  if (data === null || data === undefined) return null
  const meta = (typeof data.metadata === 'object' && data.metadata !== null
    ? data.metadata
    : {}) as { duration_sec?: unknown }
  const v = meta.duration_sec
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** The spoken line, when there is one. Empty/whitespace counts as none. */
export function audioTextOf(data: AudioNodeDataLike | null | undefined): string | null {
  if (data === null || data === undefined) return null
  const t = data.text
  if (typeof t !== 'string') return null
  const trimmed = t.trim()
  return trimmed === '' ? null : trimmed
}
