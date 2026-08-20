/**
 * browserQuery — search, sort and role-sectioning for the asset browser.
 *
 * Pure functions on `AssetItem[]`, kept out of the component so the rules can
 * be tested directly (a co-located `.test.ts` sits next to this file).
 *
 * Search and sort run INSIDE the sections rather than flattening them, so a
 * search that spans roles still tells you which hits are locations and which
 * are references.
 */
import { SUBTYPE_NONE, subtypeLabel, subtypeRank } from './kindIcons'
import type { AssetItem } from './useAssets'

export type SortMode = 'recent' | 'uses' | 'name'

export const SORT_MODES: Array<{ id: SortMode; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'uses', label: 'Uses' },
  { id: 'name', label: 'Name' },
]

/** Matches on id, label and the prompt excerpt — the three things a user can
 *  remember about a frame they generated an hour ago. Case-insensitive, plain
 *  substring: a 70-node project needs finding, not ranking. */
export function matchesQuery(item: AssetItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return (
    item.id.toLowerCase().includes(q) ||
    item.label.toLowerCase().includes(q) ||
    item.prompt_excerpt.toLowerCase().includes(q)
  )
}

/**
 * Sort a group in place-safe fashion (returns a new array).
 *
 * `recent` keeps the order useAssets already established (newest first for
 * live, most-recently archived first for archived) — it is the identity, not
 * a re-sort, so the two orderings don't have to be duplicated here.
 * `uses` ranks by how many live nodes were derived from the asset, which is
 * the question a media pool gets asked most. `name` is a plain label sort with
 * the id as tie-breaker so it is stable.
 */
export function sortItems(items: AssetItem[], mode: SortMode): AssetItem[] {
  if (mode === 'recent') return items
  const out = [...items]
  if (mode === 'uses') {
    out.sort((a, b) => {
      if (a.used_in.length !== b.used_in.length) return b.used_in.length - a.used_in.length
      return a.id.localeCompare(b.id)
    })
    return out
  }
  out.sort((a, b) => {
    const cmp = a.label.localeCompare(b.label)
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id)
  })
  return out
}

export interface AssetSection {
  key: string
  label: string
  items: AssetItem[]
}

/**
 * Group live items by production role.
 *
 * Sections appear only when a kind actually HAS more than one role — videos
 * carry no subtype at all, so their grid stays flat, and a search whose hits
 * all land in one role renders headless (a lone header labels nothing).
 */
export function sectionBySubtype(items: AssetItem[]): AssetSection[] {
  const buckets = new Map<string, AssetItem[]>()
  for (const item of items) {
    const key = item.subtype ?? SUBTYPE_NONE
    const list = buckets.get(key)
    if (list === undefined) buckets.set(key, [item])
    else list.push(item)
  }
  if (buckets.size <= 1) return []
  return [...buckets.entries()]
    .map(([key, list]) => ({ key, label: subtypeLabel(key), items: list }))
    .sort((a, b) => {
      const ra = subtypeRank(a.key)
      const rb = subtypeRank(b.key)
      return ra !== rb ? ra - rb : a.label.localeCompare(b.label)
    })
}
