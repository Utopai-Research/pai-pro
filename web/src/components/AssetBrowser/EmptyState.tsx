/**
 * EmptyState — placeholder shown when a tab has no rows (live or
 * archived). Different copy per kind so the user understands the
 * absence without ambiguity ("no images" vs "no notes").
 */
import type { AssetKind } from './useAssets'

const COPY: Record<AssetKind, { headline: string; hint: string }> = {
  images: {
    headline: 'No images yet',
    hint: 'Generate one in chat, or drop a file onto the canvas.',
  },
  videos: {
    headline: 'No videos yet',
    hint: 'Ask the agent to generate one — it shows up here.',
  },
  audios: {
    headline: 'No audio yet',
    hint: 'Design a voice or drop an audio file.',
  },
  notes: {
    headline: 'No notes yet',
    hint: 'Tell the agent "take a note" to save one.',
  },
}

export function EmptyState({ kind }: { kind: AssetKind }): JSX.Element {
  const { headline, hint } = COPY[kind]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="text-sm font-medium text-neutral-300">{headline}</p>
      <p className="text-xs text-neutral-500">{hint}</p>
    </div>
  )
}
