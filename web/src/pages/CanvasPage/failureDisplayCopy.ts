/**
 * failureDisplayCopy — what a failed pad's face says at a glance.
 *
 * Upstream refusals reach the tombstone as `PAI <status>: {raw json}`, and that
 * JSON usually carries a sentence WRITTEN FOR HUMANS in
 * `candidates[0].finishMessage` ("Unable to show the generated image … Please
 * edit your prompt and try again."). The card should show that sentence, not
 * three clamped lines of JSON punctuation.
 *
 * A WHITELIST, not a heuristic: only the one known shape is distilled, and
 * anything unrecognised comes back byte-identical. The raw message is never
 * lost either way — it stays on the card's `title` and in the expand overlay's
 * failure section, which the callers own.
 *
 * ⚠️ Real tombstones TRUNCATE. The message that motivated this ends mid-string,
 * inside finishMessage's own value, with no closing quote and no closing
 * braces — so JSON.parse on the tail is expected to fail on exactly the
 * messages most worth distilling. Hence two paths: parse when the payload is
 * whole, fall back to a regex that tolerates a missing terminator, and give up
 * (returning the original) on anything else.
 */

/** Render-path O(n) cap — a pathological payload is shown raw, not scanned. */
const MAX_DISTILL_LENGTH = 4096

/** `PAI 400: {…}` — the one shape this claims to understand. */
const UPSTREAM_SHAPE = /^PAI \d+: (.*)$/s

/**
 * finishMessage's value as a JSON string body: escaped-char runs up to a
 * closing quote OR the end of the input (a truncated tombstone never closes it).
 */
const FINISH_MESSAGE = /"finishMessage"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/

/** Unescape a JSON string body; null when it is not a valid body after all. */
function unescapeJsonString(body: string): string | null {
  try {
    const value: unknown = JSON.parse(`"${body}"`)
    return typeof value === 'string' ? value : null
  } catch {
    // A trailing lone backslash (truncation mid-escape) — not worth guessing.
    return null
  }
}

function finishMessageFromParsed(tail: string): string | null {
  try {
    const parsed: unknown = JSON.parse(tail)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidates = (parsed as { candidates?: unknown }).candidates
    if (!Array.isArray(candidates) || candidates.length === 0) return null
    const first: unknown = candidates[0]
    if (typeof first !== 'object' || first === null) return null
    const fm = (first as { finishMessage?: unknown }).finishMessage
    return typeof fm === 'string' ? fm : null
  } catch {
    // Truncated JSON — the normal case for a real tombstone. Fall through.
    return null
  }
}

/**
 * The distilled first-glance copy for a failure message: the upstream
 * finishMessage when the message has the known `PAI <n>: {json}` shape and one
 * can be extracted; the original message, byte-identical, otherwise.
 */
export function failureDisplayCopy(message: string): string {
  if (message.length > MAX_DISTILL_LENGTH) return message
  const shaped = UPSTREAM_SHAPE.exec(message)
  if (shaped === null) return message
  const tail = shaped[1]

  const parsed = finishMessageFromParsed(tail)
  if (parsed !== null && parsed.trim() !== '') return parsed

  const matched = FINISH_MESSAGE.exec(tail)
  if (matched !== null) {
    const unescaped = unescapeJsonString(matched[1])
    if (unescaped !== null && unescaped.trim() !== '') return unescaped
  }

  return message
}
