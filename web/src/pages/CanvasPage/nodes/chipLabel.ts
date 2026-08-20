/**
 * chipLabel — which text the floating card label shows, and the reference
 * string behind it.
 *
 * Semantic name first: a trimmed non-empty label wins; anything else (absent,
 * empty, whitespace-only) falls back to the `@<id>` reference so the row is
 * never blank. That fallback is load-bearing on a chromeless card — the head
 * row that used to print `@<id>` unconditionally is gone, and the @id is the
 * key users type at the agent. `chipRefText` is the single place that mints it.
 */

export function chipRefText(id: string): string {
  return `@${id}`
}

export function chipDisplayLabel(label: string | null | undefined, id: string): string {
  if (typeof label === 'string') {
    const trimmed = label.trim()
    if (trimmed !== '') return trimmed
  }
  return chipRefText(id)
}
