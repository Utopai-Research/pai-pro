/**
 * browserQuery.test.ts — the search / sort / sectioning rules of the asset
 * browser, and the two that are easy to get wrong: `recent` must not re-sort
 * (useAssets already ordered the group), and a single-role kind must render
 * flat rather than under one pointless header.
 */
import { describe, expect, it } from 'vitest'
import { matchesQuery, sectionBySubtype, sortItems } from './browserQuery'
import type { AssetItem } from './useAssets'

function item(over: Partial<AssetItem> & { id: string }): AssetItem {
  return {
    kind: 'images',
    type: 'image_result',
    label: over.id,
    thumbnail_url: null,
    video_url: null,
    audio_url: null,
    prompt_excerpt: '',
    archived: false,
    generated_at: null,
    archived_at: null,
    used_in: [],
    ...over,
  }
}

describe('matchesQuery', () => {
  const it0 = item({
    id: 'image_7',
    label: 'Causeway wide',
    prompt_excerpt: 'low sun raking across wet stone',
  })

  it('matches id, label and prompt, case-insensitively', () => {
    expect(matchesQuery(it0, 'IMAGE_7')).toBe(true)
    expect(matchesQuery(it0, 'causeway')).toBe(true)
    expect(matchesQuery(it0, 'wet stone')).toBe(true)
  })

  it('an empty or whitespace query matches everything', () => {
    expect(matchesQuery(it0, '')).toBe(true)
    expect(matchesQuery(it0, '   ')).toBe(true)
  })

  it('rejects what is in none of the three fields', () => {
    expect(matchesQuery(it0, 'harbour')).toBe(false)
  })
})

describe('sortItems', () => {
  const a = item({ id: 'image_1', label: 'Zebra', used_in: ['x', 'y'] })
  const b = item({ id: 'image_2', label: 'Apple', used_in: [] })
  const c = item({ id: 'image_3', label: 'Mango', used_in: ['x'] })

  it('leaves `recent` exactly as useAssets ordered it', () => {
    const input = [a, b, c]
    expect(sortItems(input, 'recent')).toBe(input)
  })

  it('ranks `uses` by live derived count, id as tie-break', () => {
    expect(sortItems([b, c, a], 'uses').map((i) => i.id)).toEqual([
      'image_1',
      'image_3',
      'image_2',
    ])
  })

  it('sorts `name` by label', () => {
    expect(sortItems([a, b, c], 'name').map((i) => i.label)).toEqual([
      'Apple',
      'Mango',
      'Zebra',
    ])
  })

  it('never mutates its input', () => {
    const input = [a, b, c]
    sortItems(input, 'name')
    expect(input.map((i) => i.id)).toEqual(['image_1', 'image_2', 'image_3'])
  })
})

describe('sectionBySubtype', () => {
  it('returns nothing when the kind has a single role — a lone header labels nothing', () => {
    expect(
      sectionBySubtype([
        item({ id: 'image_1', subtype: 'character' }),
        item({ id: 'image_2', subtype: 'character' }),
      ]),
    ).toEqual([])
    // Videos carry no subtype at all — same flat grid.
    expect(sectionBySubtype([item({ id: 'video_1' }), item({ id: 'video_2' })])).toEqual([])
  })

  it('orders sections by narrative importance, not alphabetically', () => {
    const sections = sectionBySubtype([
      item({ id: 'image_1', subtype: 'reference' }),
      item({ id: 'image_2', subtype: 'character' }),
      item({ id: 'image_3', subtype: 'location' }),
    ])
    expect(sections.map((s) => s.label)).toEqual(['Characters', 'Locations', 'References'])
  })

  it('puts the no-subtype bucket last and labels it Other', () => {
    const sections = sectionBySubtype([
      item({ id: 'image_1' }),
      item({ id: 'image_2', subtype: 'character' }),
    ])
    expect(sections.map((s) => s.label)).toEqual(['Characters', 'Other'])
    expect(sections[1]?.items.map((i) => i.id)).toEqual(['image_1'])
  })

  it('keeps an unknown subtype rather than dropping it', () => {
    const sections = sectionBySubtype([
      item({ id: 'image_1', subtype: 'character' }),
      item({ id: 'image_2', subtype: 'moodboard' }),
    ])
    expect(sections.map((s) => s.label)).toEqual(['Characters', 'moodboard'])
  })
})
