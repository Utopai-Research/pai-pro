/**
 * The cursor-following ghost rendered inside <DragOverlay> during an
 * active reel drag. Detached from the layout flow — sits in a portal,
 * follows the pointer, dismissed instantly on drop (no fly-back tween;
 * <DragOverlay dropAnimation={null}> in the caller).
 *
 * Sized roughly card-shaped so it reads as "the clip you're moving."
 * Translucent so the placeholder + neighbor reflow underneath stay
 * visible.
 */
import type { VideoResultNode } from '@/types/canvas'

export default function ClipGhostBody({
  node,
}: {
  node: VideoResultNode | null
}): JSX.Element | null {
  if (!node) return null
  const url = node.data.video_url
  const aspect = node.data.aspect ?? '16:9'
  const shotId = node.data.shot_id
  return (
    <div
      className="overflow-hidden rounded-md border border-neutral-300/40 bg-neutral-950 opacity-85 shadow-xl shadow-black/50"
      style={{
        width: 160,
        aspectRatio: aspect.replace(':', ' / '),
        maxHeight: 90,
      }}
    >
      <div className="relative h-full w-full">
        {url !== '' ? (
          <video
            src={url}
            preload="metadata"
            muted
            playsInline
            className="h-full w-full object-cover"
          />
        ) : null}
        {typeof shotId === 'number' ? (
          <div className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1 py-0.5 font-mono text-[10px] text-neutral-100">
            #{String(shotId).padStart(2, '0')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
