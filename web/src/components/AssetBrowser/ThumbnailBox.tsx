/**
 * ThumbnailBox — the asset preview used by both the rail's rows and the
 * browser's grid cards.
 *
 * One file rather than two copies so the video-poster trick and the
 * archived-desaturation rule stay defined once.
 *
 * WHY THUMBNAILS CARRY THE LIST AT ALL: our ids are `image_72`, `image_73`,
 * `image_74`, and most items have no prompt excerpt either. A text-only list
 * of auto-generated ids is unreadable in a media app — the picture is the
 * name here.
 */
import { cn } from '@/lib/utils'
import { KIND_ICONS } from './kindIcons'
import type { AssetItem } from './useAssets'

export function ThumbnailBox({
  item,
  size = 56,
  fill = false,
}: {
  item: AssetItem
  /** Box edge in px. 56 = rail row (default), 132 = grid card height. */
  size?: number
  /** Grid card: stretch to the cell's width, keep `size` as the height. The
   *  card owns the column width; the thumbnail just fills it. */
  fill?: boolean
}): JSX.Element {
  // Archived media is desaturated rather than hidden — paired with the dimmed
  // text it reads as "off canvas" at a glance, without costing the
  // recognisability of the frame itself.
  const box = cn(
    fill ? 'w-full' : 'shrink-0',
    'overflow-hidden',
    fill ? 'rounded-none' : 'rounded-md',
    item.archived && 'saturate-50',
  )
  const style = fill ? { height: size } : { width: size, height: size }

  if (item.kind === 'images' && item.thumbnail_url !== null) {
    // These are the FULL-RES assets scaled down by the browser — there is no
    // thumbnail endpoint. `lazy` keeps offscreen cards off the wire and
    // `async` keeps decode off the main thread, which is enough at this size;
    // a server-side thumbnailer is the fix if a project's pool outgrows it.
    if (fill) {
      // Grid cards show the WHOLE frame (contain), with the letterbox filled
      // by the image's own blurred echo — two layers, so `contain` never
      // reads as dead grey bars. The backdrop is decorative: aria-hidden and
      // not the drag image, so a11y and drag-and-drop only ever see the front.
      return (
        <div style={style} className={cn(box, 'relative')}>
          <img
            src={item.thumbnail_url}
            alt=""
            aria-hidden
            draggable={false}
            style={{ filter: 'blur(16px) saturate(1.1)', opacity: 0.45 }}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <img
            src={item.thumbnail_url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            data-drag-image="true"
            className="relative h-full w-full object-contain"
          />
        </div>
      )
    }
    return (
      <img
        src={item.thumbnail_url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        data-drag-image="true"
        style={style}
        className={cn(box, 'object-cover')}
      />
    )
  }
  // Video — `<video preload="metadata">` shows the first frame as a poster,
  // mimicking a real thumbnail. `#t=0.1` nudges the seek position so we get a
  // slightly more interesting frame than the literal frame 0 (often black).
  // Grid cards switch to object-contain over the muted ground but stay a
  // SINGLE element — dozens of grid cards × 2 media pipelines per <video>
  // (fetch + decode) is real cost, unlike the free second <img>.
  if (item.kind === 'videos' && item.video_url !== null) {
    return (
      <video
        src={`${item.video_url}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        data-drag-image="true"
        style={style}
        className={cn(box, 'bg-muted', fill ? 'object-contain' : 'object-cover')}
        aria-hidden
      />
    )
  }
  // Audio / notes — kind glyph fallback.
  const Icon = KIND_ICONS[item.kind]
  return (
    <div
      aria-hidden
      data-drag-image="true"
      style={style}
      className={cn(box, 'flex items-center justify-center bg-muted text-muted-foreground')}
    >
      <Icon size={Math.max(10, Math.round(size * 0.4))} strokeWidth={1.6} aria-hidden />
    </div>
  )
}
