/**
 * The dashed-border + diagonal-striped tile that replaces a clip's
 * visible body for the duration of a drag (handover §10.1). Communicates
 * "the dragged clip's slot lives here; neighbors slide around it" — the
 * Premiere/CapCut convention.
 *
 * Sized to fill its sortable wrapper's box; absolute-positioned so it
 * sits inside the same rounded rect the live clip body uses.
 */
export default function StripedPlaceholder(): JSX.Element {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        borderRadius: 6,
        border: '1.5px dashed rgba(255,255,255,0.22)',
        background: `repeating-linear-gradient(
          135deg,
          rgba(255,255,255,0.10) 0px 6px,
          rgba(255,255,255,0.04) 6px 12px
        ), #1c1c1c`,
      }}
    />
  )
}
