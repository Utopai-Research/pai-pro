/**
 * Node-sizing helpers.
 *
 * `NODE_SIZES` provides per-type fallback dimensions used when a node
 * lacks per-instance metadata (e.g. an image_result without an
 * aspect_ratio field). `parseAspectRatio` + `sizeForAspect` compute
 * per-instance dimensions from "W:H" strings while clamping to the
 * [140, 360] range so degenerate ratios (21:9, 1:4) don't break the
 * canvas layout.
 */

export const NODE_SIZES = {
  note: { w: 230, h: 140 },
  // image_result fallback when aspect_ratio metadata is missing
  image_result: { w: 260, h: 180 },
  // video_result fallback; per-instance size comes from sizeForAspect()
  video_result: { w: 300, h: 170 },
  // audio_result has no spatial extent — a compact horizontal pill.
  audio_result: { w: 240, h: 64 },
  pending: { w: 200, h: 140 },
  // Ghosts reserve image-card footprint so the placement primitives
  // don't pack other nodes too close when an image-shaped ghost is present.
  pending_attachment: { w: 260, h: 200 },
  pending_generation: { w: 260, h: 200 },
} as const

export type NodeSizeKey = keyof typeof NODE_SIZES

/** Parse "W:H" → { w, h } numeric. Returns null on malformed input. */
export function parseAspectRatio(s: string | null | undefined): { w: number; h: number } | null {
  if (s === null || s === undefined || typeof s !== 'string') return null
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/)
  if (m === null) return null
  const w = Number.parseFloat(m[1] ?? '')
  const h = Number.parseFloat(m[2] ?? '')
  if (!(w > 0 && h > 0)) return null
  return { w, h }
}

/**
 * Given an aspect ratio string (e.g. "16:9", "9:16", "1:1"), return a
 * {w, h} sized to roughly match a target on-screen area while
 * preserving the ratio. Clamped to [140, 360] px to keep card
 * footprints reasonable for degenerate ratios.
 */
export function sizeForAspect(
  aspectRatio: string | null | undefined,
  targetArea: number = NODE_SIZES.image_result.w * NODE_SIZES.image_result.h,
): { w: number; h: number } {
  const r = parseAspectRatio(aspectRatio) ?? { w: 16, h: 9 }
  const ratio = r.w / r.h
  // width² / ratio = targetArea → width = sqrt(targetArea * ratio)
  const width = Math.round(Math.sqrt(targetArea * ratio))
  const height = Math.round(width / ratio)
  return {
    w: Math.max(140, Math.min(360, width)),
    h: Math.max(120, Math.min(360, height)),
  }
}

// Canonical state machine for shot / video nodes:
// pending → running → complete | failed.
export type NodeState = 'pending' | 'running' | 'complete' | 'failed'

/**
 * Append `?download=1` to a viewer asset URL so the server returns
 * `Content-Disposition: attachment` and the browser saves the file
 * instead of navigating. Needed because the canvas page (7443) and
 * the asset endpoint (7488) are different origins, which makes the
 * HTML `download` attribute a no-op on its own.
 */
export function downloadHref(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'download=1'
}

// Constant cap on the on-canvas note body. The card has no min-height,
// so short notes hug their content — the placement primitives use
// measured heights (see useCanvasPositions.ts) so the layout footprint
// matches what the browser actually rendered.
export const NOTE_BODY_MAX_HEIGHT = 360

// Chrome wrapping the body of a COMPLETED image_result / video_result card.
// Those cards are chromeless (`.node--media` in nodes-base.css): the head and
// foot rows are gone, the border with them, and the label that replaced them
// is absolutely positioned above the card (`bottom: 100%`, out of flow) so it
// reserves no vertical footprint. The rendered card is therefore the body
// alone, and this constant is only a hair of slack — it was 56 when the card
// wore head + foot + borders.
//
// The renderer sizes the card by `style={{ width: size.w }}` and the body gets
// its height from CSS aspect-ratio, so placement adds this to the body height
// to reserve the footprint the user actually sees.
export const IMAGE_CARD_CHROME_PX = 2
// Chrome for the pending_generation pad. Pads are DELIBERATELY not chromeless:
// the head holds the model + specs and the foot holds Cancel / Generate·$, so
// a pad's AABB is body + ~56 even though the completed card that replaces it
// is body + 2. Numbers from nodes-base.css: head 7+7 padding + 10.5px line
// ≈ 28, foot 6+6 padding + 10px line ≈ 25, 2 × 1px borders → 55, rounded up.
export const PENDING_CARD_CHROME_PX = 56
// Worst-case card footprint (chrome + max body), used by projection as
// the first-paint fallback before RF measures. Replaced by the measured
// height on the next projection pass.
export const NOTE_CARD_FALLBACK_HEIGHT = 60 + NOTE_BODY_MAX_HEIGHT

