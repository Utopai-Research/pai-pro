/**
 * The reference preview's decidable parts.
 *
 * The gate is here because it decides whether a reference gets an enlarged
 * view at all, and a gate that fails closed fails SILENTLY — the thumbnail
 * still renders, hovering it just does nothing, and there is no error anywhere
 * to notice. The two timings are pinned for the same reason: they are numbers
 * the interaction depends on, and both have a failure mode that reads as
 * flakiness rather than as a bug.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_AUTOPLAY_DELAY_MS,
  audioDurationOf,
  audioTextOf,
  canPreviewRef,
} from './refPreviewRules'
import { REF_PREVIEW_HIDE_DELAY_MS } from './useRefHoverPreview'

describe('canPreviewRef', () => {
  it('previews every media kind a reference can be', () => {
    expect(canPreviewRef('image', '/a.png')).toBe(true)
    expect(canPreviewRef('video', '/b.mp4')).toBe(true)
    // Audio has no picture to enlarge; it gets a preview of a different shape.
    // Excluding it would leave every audio reference with an identical 🔊 and
    // no way to reach its source.
    expect(canPreviewRef('audio', '/c.mp3')).toBe(true)
  })

  it('refuses a reference with no bytes, whatever its kind', () => {
    expect(canPreviewRef('image', '')).toBe(false)
    expect(canPreviewRef('audio', '')).toBe(false)
  })

  it('refuses a kind that is not media', () => {
    expect(canPreviewRef('note', '/n.md')).toBe(false)
    expect(canPreviewRef('', '/x')).toBe(false)
  })
})

describe('audioDurationOf', () => {
  it('reads the one spelling this repo writes', () => {
    // server/canvas_schema.js declares metadata.duration_sec; generate_voice.js
    // is what stamps it.
    expect(audioDurationOf({ metadata: { duration_sec: 3.5 } })).toBe(3.5)
  })

  it('answers null rather than a duration it made up', () => {
    // A node minted before the field existed knows nothing. The preview then
    // shows no clock — and prefers what the <audio> element reports once it
    // loads, which is a measurement.
    expect(audioDurationOf({ metadata: {} })).toBe(null)
    expect(audioDurationOf({})).toBe(null)
    expect(audioDurationOf(null)).toBe(null)
    expect(audioDurationOf(undefined)).toBe(null)
    expect(audioDurationOf({ metadata: null })).toBe(null)
    expect(audioDurationOf({ metadata: { duration_sec: '3.5' } })).toBe(null)
    // Zero is not a length; it would render a 0:00 clock on a real clip.
    expect(audioDurationOf({ metadata: { duration_sec: 0 } })).toBe(null)
    expect(audioDurationOf({ metadata: { duration_sec: Number.NaN } })).toBe(null)
  })
})

describe('audioTextOf', () => {
  it('returns the spoken line, trimmed', () => {
    expect(audioTextOf({ text: '  Take me home.  ' })).toBe('Take me home.')
  })

  it('treats blank as no line at all', () => {
    // The preview omits the line rather than reserving an empty row for it.
    expect(audioTextOf({ text: '   ' })).toBe(null)
    expect(audioTextOf({ text: '' })).toBe(null)
    expect(audioTextOf({})).toBe(null)
    expect(audioTextOf({ text: 42 })).toBe(null)
    expect(audioTextOf(null)).toBe(null)
  })
})

describe('the two timings', () => {
  it('leaves a grace period long enough to cross the gap to the preview', () => {
    // Zero fails the same way a CSS :hover rule does — the cursor is in
    // neither element for a frame or two mid-traversal — and a long delay
    // leaves stale previews hanging over the canvas.
    expect(REF_PREVIEW_HIDE_DELAY_MS).toBe(100)
  })

  it('keeps the audio enter-delay separate from that grace period', () => {
    // They run in opposite directions and overlap in time: one is a LEAVE
    // grace, this one is an ENTER delay so sweeping along a row of references
    // does not fire every clip in it.
    expect(AUDIO_AUTOPLAY_DELAY_MS).toBe(300)
    expect(AUDIO_AUTOPLAY_DELAY_MS).not.toBe(REF_PREVIEW_HIDE_DELAY_MS)
  })
})
