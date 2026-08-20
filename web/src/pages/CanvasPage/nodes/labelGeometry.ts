/**
 * labelGeometry — the width budget of the counter-scaled label row that rides
 * above every chromeless media card.
 *
 * The row is rendered at native px and visually shrunk by
 * `transform: scale(1/effectiveZoom)` (CounterScaledLabel in _shared.tsx), so
 * its on-screen width is `layoutWidth × zoom / effectiveZoom`. Capping the
 * LAYOUT width at `(cardWidth − inset) × effectiveZoom` therefore pins the
 * row's on-screen right edge to the card's own right edge at every zoom —
 * above the counter-scale floor, exactly at it, and below it (where the floor
 * factor cancels out of both sides).
 */

/**
 * Below this zoom the label stops counter-scaling and shrinks with the card
 * instead. A fully counter-scaled label holds a constant ON-SCREEN width,
 * which means its flow-space width grows as 1/zoom — at zoom 0.2 a ~120px
 * label would occupy ~600px of flow space while the card it names is ~260px,
 * so every row's labels smear into an unreadable band. Flooring the divisor
 * freezes the label's flow width at the floor; combined with the `nodeW`-derived
 * cap below, that flow width is exactly the card width minus the inset, so
 * labels stay inside their cards. Above the floor the constant-size,
 * always-readable behavior is unchanged.
 */
export const LABEL_COUNTERSCALE_FLOOR = 0.55

/**
 * Layout px kept clear of the card's right edge. The row sits at `left: 4px`,
 * so ~4px of visual margin remains on each side at zoom 1.
 */
export const LABEL_EDGE_INSET_PX = 8

export function labelEffectiveZoom(zoom: number): number {
  return Math.max(zoom, LABEL_COUNTERSCALE_FLOOR)
}

/** Layout-px cap for the counter-scaled label row of a `nodeW`-wide card. */
export function labelRowMaxWidth(nodeW: number, zoom: number): number {
  return (nodeW - LABEL_EDGE_INSET_PX) * labelEffectiveZoom(zoom)
}
