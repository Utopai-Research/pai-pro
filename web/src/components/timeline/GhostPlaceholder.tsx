/**
 * Transparent dashed-border tile rendered in the Available section at
 * the in-flight cross-region source's slot, so Available's bounding
 * rect doesn't shrink mid-drag (handover §10.2 / §5.7-B — strobe
 * killer for the Available rect collapse).
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
