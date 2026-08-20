/**
 * KIND_ICONS — kind → lucide glyph, plus the labels and the order the four
 * kinds are always listed in.
 *
 * Its own module because ThumbnailBox, the browser's tabs and (soon) the
 * empty states all need the table, and an icon table has no business living
 * inside one of its consumers.
 *
 * The rail's 44px icon column keeps its own hand-drawn SVGs — they are sized
 * and stroked for that column specifically.
 */
import {
  AudioLines,
  FileText,
  Image as ImageIcon,
  Video,
  type LucideIcon,
} from 'lucide-react'
import type { AssetKind } from './useAssets'

export const KIND_ICONS: Record<AssetKind, LucideIcon> = {
  images: ImageIcon,
  videos: Video,
  audios: AudioLines,
  notes: FileText,
}

export const KIND_LABELS: Record<AssetKind, string> = {
  images: 'Images',
  videos: 'Videos',
  audios: 'Audio',
  notes: 'Notes',
}

export const KIND_ORDER: AssetKind[] = ['images', 'videos', 'audios', 'notes']

/**
 * SUBTYPE — the asset's PRODUCTION ROLE, which is the difference between a
 * gallery and a file drawer. We have carried `data.subtype` since the first
 * media CLI and never shown it: the rail says "14 images" where the project
 * actually has "5 characters, 6 locations, 3 references".
 *
 * Ids are the union of the schema's subtype enums across all four node types
 * (server/canvas_schema.js) — they don't collide, so one flat table serves
 * every kind. Videos carry no subtype at all.
 */
export const SUBTYPE_LABELS: Record<string, string> = {
  character: 'Characters',
  location: 'Locations',
  storyboard: 'Storyboards',
  reference: 'References',
  edit: 'Edits',
  split: 'Splits',
  script: 'Script',
  shot: 'Shots',
  voice: 'Voices',
  upload: 'Uploads',
}

/** Section order — narrative importance, not alphabetical. Subtypes absent
 *  from this list sort after it, alphabetically; the no-subtype bucket last. */
export const SUBTYPE_ORDER: string[] = [
  'script',
  'character',
  'location',
  'storyboard',
  'shot',
  'voice',
  'reference',
  'edit',
  'split',
  'upload',
]

/** Bucket key for an item with no subtype (videos never carry one). */
export const SUBTYPE_NONE = '_none'

export function subtypeLabel(key: string): string {
  return SUBTYPE_LABELS[key] ?? (key === SUBTYPE_NONE ? 'Other' : key)
}

export function subtypeRank(key: string): number {
  if (key === SUBTYPE_NONE) return SUBTYPE_ORDER.length + 1
  const i = SUBTYPE_ORDER.indexOf(key)
  return i === -1 ? SUBTYPE_ORDER.length : i
}
