/**
 * The whitelist distiller. The load-bearing fixture is a real tombstone
 * message, `PAI 400: {…` truncated MID-STRING inside finishMessage's own
 * value — no closing quote, no closing braces — so the JSON.parse path must
 * fail on it and the regex fallback must carry it. Everything the whitelist
 * does not recognise has to come back byte-identical.
 */
import { describe, expect, it } from 'vitest'
import { failureDisplayCopy } from './failureDisplayCopy'

const REAL_TRUNCATED =
  'PAI 400: {"candidates":[{"content":{"role":"model"},"finishReason":"IMAGE_PROHIBITED_CONTENT","finishMessage":"Unable to show the generated image due to interests of third-party content providers. Please edit your prompt and try again. If you think this was an error, send feedback. Support code: 355'

const HUMAN_SENTENCE =
  'Unable to show the generated image due to interests of third-party content providers. Please edit your prompt and try again. If you think this was an error, send feedback. Support code: 355'

describe('failureDisplayCopy', () => {
  it('distills a truncated tombstone to its human sentence', () => {
    expect(failureDisplayCopy(REAL_TRUNCATED)).toBe(HUMAN_SENTENCE)
  })

  it('distills a well-formed payload through the parse path', () => {
    const wellFormed =
      'PAI 422: ' +
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model' },
            finishReason: 'IMAGE_PROHIBITED_CONTENT',
            finishMessage: 'Please edit your prompt and try again.',
          },
        ],
      })
    expect(failureDisplayCopy(wellFormed)).toBe('Please edit your prompt and try again.')
  })

  it('unescapes escaped characters in finishMessage', () => {
    const withEscapes =
      'PAI 400: {"candidates":[{"finishMessage":"Line one.\\nSee \\"policy\\" for details."}]}'
    expect(failureDisplayCopy(withEscapes)).toBe('Line one.\nSee "policy" for details.')
  })

  // ── everything below must come back byte-identical ──────────────────────

  it.each([
    ['a plain sentence', 'The upstream provider refused this request.'],
    ['a PAI-shaped message whose tail is not JSON', 'PAI 400: not-json'],
    ['an empty finishMessage', 'PAI 400: {"candidates":[{"finishMessage":""}]}'],
    ['a whitespace-only finishMessage', 'PAI 400: {"candidates":[{"finishMessage":"   "}]}'],
    ['JSON without candidates', 'PAI 500: {"error":"internal"}'],
    ['truncation mid-escape', 'PAI 400: {"candidates":[{"finishMessage":"cut off here \\'],
  ])('returns %s unchanged', (_name, message) => {
    expect(failureDisplayCopy(message)).toBe(message)
  })

  it('returns a message over the 4KB cap unchanged, without scanning', () => {
    const huge = 'PAI 400: {"candidates":[{"finishMessage":"' + 'x'.repeat(5000) + '"}]}'
    expect(huge.length).toBeGreaterThan(4096)
    expect(failureDisplayCopy(huge)).toBe(huge)
  })
})
