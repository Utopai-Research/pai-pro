/**
 * Transparent dashed-border tile rendered in the Available section at
 * the in-flight cross-region source's slot, so Available's bounding
 * rect doesn't shrink mid-drag (handover §10.2 / §5.7-B — strobe
 * killer for the Available rect collapse).
 *
 * Unused in Stage 1 (intra-reel only). Wired in Stage 2 when cross-
 * region drag moves from HTML5 to dnd-kit. Shipped now so Stage 2 is
 * a small additive PR rather than a leaf-and-wiring PR.
 */
export default function GhostPlaceholder(): JSX.Element {
  return (
    <div
      aria-hidden
      className="rounded-md border border-dashed border-white/[0.12]"
      style={{ aspectRatio: '16 / 9' }}
    />
  )
}
