/**
 * Edge hover — ONE pane-level hit test, and the store that broadcasts its answer.
 *
 * WHY NOT A TRANSPARENT GRAB PATH PER EDGE (React Flow's own `interactionWidth`
 * does it that way):
 *
 *  1. It silently kills rubber-band selection. This canvas sets
 *     `panOnDrag={[1, 2]}`, so the left button never pans, and React Flow starts
 *     a selection box only when the event target is the bare `.react-flow__pane`
 *     div. A wide grab path gives every edge a band in which a left drag does
 *     NOTHING — no pan, no rubber band, no deselect, and no error either.
 *  2. It is one extra <path> per edge, on a canvas that can hold hundreds.
 *  3. A stroke width is in FLOW units, so its on-screen width is `width * zoom`.
 *     One constant cannot be right at both ends of the zoom range.
 *
 * Geometry instead: each edge registers the cubic it already computed, and a
 * single pointermove on the canvas host asks which curve is nearest. Nothing is
 * added to the DOM, so none of the three problems exist. Hit-testing pure
 * geometry also sees edges that are painted UNDER something — group frames are
 * React Flow nodes whose whole rectangle takes pointer events, so on a tidied
 * canvas a DOM hit test would miss most edges.
 *
 * Import-free on purpose so the geometry is unit-testable without a DOM; the
 * edge shape is described structurally rather than imported from @xyflow/react.
 *
 * SCOPE: only real workflow edges register. The dashed `pending:` edges drawn
 * into in-flight pads are not cuttable here — removing one would mean rewriting
 * the pad's reference set, which this viewer's PATCH route does not accept — so
 * letting them steal the hover would offer an action that cannot happen.
 */

export interface EdgeCurve {
  sx: number
  sy: number
  c1x: number
  c1y: number
  c2x: number
  c2y: number
  tx: number
  ty: number
}

/** What a cut hands to the undo stack — enough to put the connection back. */
export interface EdgeCutRecord {
  from: string
  to: string
  kind?: string
}

/** The prefix projection.ts gives edges that exist only while a pad is in flight. */
export const PENDING_EDGE_PREFIX = 'pending:'

/** Only real workflow edges can be cut, so only they take part in the hit test. */
export function isCuttableEdgeId(edgeId: string): boolean {
  return !edgeId.startsWith(PENDING_EDGE_PREFIX)
}

// ─────────────────────────── pure geometry ───────────────────────────

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi

/**
 * Read back the cubic from the path string `getBezierPath` returned.
 *
 * Parsing rather than recomputing the control points on purpose: React Flow
 * formats exactly `M sx,sy C c1x,c1y c2x,c2y tx,ty`, and reading its own output
 * cannot drift from it the way a reimplementation of its control-offset formula
 * would.
 */
export function parseBezierPath(d: string): EdgeCurve | null {
  if (!d.startsWith('M') || !d.includes(' C')) return null
  const found = d.match(NUMBER)
  if (found === null || found.length !== 8) return null
  const n = found.map(Number)
  if (n.some((v) => !Number.isFinite(v))) return null
  return { sx: n[0], sy: n[1], c1x: n[2], c1y: n[3], c2x: n[4], c2y: n[5], tx: n[6], ty: n[7] }
}

function cubicAt(a: number, b: number, c: number, d: number, t: number): number {
  const mt = 1 - t
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/**
 * Flattening budget — adaptive, not a fixed segment count.
 *
 * A fixed count is wrong at high zoom: the deviation between the chords and the
 * painted curve is in FLOW units, so it is multiplied by the zoom on screen. On
 * a short, tightly-curved edge a coarse flattening can drift wider than the hit
 * band, and the test then misses silently on exactly the edges that are hardest
 * to aim at. SEG_MIN is the binding constraint for those short edges, not SEG_PX.
 */
const SEG_PX = 30
const SEG_MIN = 8
const SEG_MAX = 96

/**
 * Length of the CONTROL POLYGON, not the arc length — deliberately crude. It is
 * an upper bound on the true arc length, so it errs toward MORE samples, which
 * is the safe direction. An exact arc length would cost an integration per edge
 * to buy fewer samples than we want anyway.
 */
export function controlPolygonLength(c: EdgeCurve): number {
  return (
    Math.hypot(c.c1x - c.sx, c.c1y - c.sy) +
    Math.hypot(c.c2x - c.c1x, c.c2y - c.c1y) +
    Math.hypot(c.tx - c.c2x, c.ty - c.c2y)
  )
}

/** How many chords this curve is worth. */
export function flattenSteps(polyLen: number): number {
  if (!Number.isFinite(polyLen) || polyLen <= 0) return SEG_MIN
  return Math.min(SEG_MAX, Math.max(SEG_MIN, Math.ceil(polyLen / SEG_PX)))
}

/**
 * A registered edge: its curve, its FLATTENED polyline, and the polyline's
 * bounding box.
 *
 * The polyline is computed ONCE, when the edge registers, and reused by every
 * hit test after. Hit tests run on every throttled pointermove, so flattening
 * there would multiply the per-frame cost by up to SEG_MAX chords per edge.
 * Registration is keyed by the edge's PATH STRING, which encodes both endpoints
 * and both control points — a stricter cache key than the endpoints alone.
 */
export interface EdgeEntry {
  curve: EdgeCurve
  /** Flat [x0, y0, x1, y1, …] — one allocation per geometry, not per frame. */
  poly: Float64Array
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function flattenCurve(curve: EdgeCurve): Float64Array {
  const n = flattenSteps(controlPolygonLength(curve))
  const poly = new Float64Array((n + 1) * 2)
  for (let i = 0; i <= n; i += 1) {
    const t = i / n
    poly[i * 2] = cubicAt(curve.sx, curve.c1x, curve.c2x, curve.tx, t)
    poly[i * 2 + 1] = cubicAt(curve.sy, curve.c1y, curve.c2y, curve.ty, t)
  }
  return poly
}

export function buildEdgeEntry(curve: EdgeCurve): EdgeEntry {
  return {
    curve,
    poly: flattenCurve(curve),
    // The convex hull of the four control points bounds the cubic, so this box
    // is sound and needs no scan of the polyline.
    minX: Math.min(curve.sx, curve.c1x, curve.c2x, curve.tx),
    minY: Math.min(curve.sy, curve.c1y, curve.c2y, curve.ty),
    maxX: Math.max(curve.sx, curve.c1x, curve.c2x, curve.tx),
    maxY: Math.max(curve.sy, curve.c1y, curve.c2y, curve.ty),
  }
}

/**
 * Distance from a point to a flattened polyline. Chords, not sample POINTS: on
 * a long edge the samples sit far apart, so a point-only test would leave holes
 * between them wider than the band.
 */
export function distanceToPolyline(poly: Float64Array, px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const d = distanceToSegment(px, py, poly[i], poly[i + 1], poly[i + 2], poly[i + 3])
    if (d < best) best = d
  }
  return best
}

/** Convenient for tests; the hot path walks a cached `EdgeEntry.poly` instead. */
export function distanceToCurve(curve: EdgeCurve, px: number, py: number): number {
  return distanceToPolyline(flattenCurve(curve), px, py)
}

/**
 * Cheap reject before the distance test. A cubic never leaves the convex hull
 * of its four control points, so their bounding box (inflated by the threshold)
 * is a sound early-out.
 */
export function withinCurveBounds(
  curve: EdgeCurve,
  px: number,
  py: number,
  threshold: number,
): boolean {
  const minX = Math.min(curve.sx, curve.c1x, curve.c2x, curve.tx) - threshold
  if (px < minX) return false
  const maxX = Math.max(curve.sx, curve.c1x, curve.c2x, curve.tx) + threshold
  if (px > maxX) return false
  const minY = Math.min(curve.sy, curve.c1y, curve.c2y, curve.ty) - threshold
  if (py < minY) return false
  const maxY = Math.max(curve.sy, curve.c1y, curve.c2y, curve.ty) + threshold
  return py <= maxY
}

export function hitsCurve(
  curve: EdgeCurve,
  px: number,
  py: number,
  threshold: number,
): boolean {
  if (!withinCurveBounds(curve, px, py, threshold)) return false
  return distanceToCurve(curve, px, py) <= threshold
}

/** Nearest hit among registered entries, or null. Walks CACHED polylines. */
export function pickNearest(
  entries: Iterable<[string, EdgeEntry]>,
  px: number,
  py: number,
  threshold: number,
): string | null {
  let bestId: string | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const [id, entry] of entries) {
    if (px < entry.minX - threshold || px > entry.maxX + threshold) continue
    if (py < entry.minY - threshold || py > entry.maxY + threshold) continue
    const d = distanceToPolyline(entry.poly, px, py)
    if (d <= threshold && d < bestD) {
      bestD = d
      bestId = id
    }
  }
  return bestId
}

/**
 * Node types whose rectangle BLOCKS the gesture — the pointer being inside one
 * means it is on a card, not on the canvas, so no scissors may appear.
 *
 * Decided on TYPE, never on DOM ancestry. `group_frame` is a React Flow node
 * too, sized to the whole frame rectangle, and React Flow gives every node
 * `pointer-events: all` — so a `closest('.react-flow__node')` test would
 * swallow a frame's entire area and make the scissors unreachable across most
 * of a tidied canvas.
 */
export const CUT_BLOCKING_NODE_TYPES = new Set([
  'image_result',
  'video_result',
  'audio_result',
  'note',
  'pending_generation',
])

/**
 * Is the flow-space point inside any blocking node's rectangle? Pure.
 *
 * Prefers `internals.positionAbsolute` over `position`: the caller feeds React
 * Flow's `nodeLookup` values, where that field is the already-resolved absolute
 * coordinate. Nothing here nests nodes today, so the two agree — but a
 * rectangle test that silently used relative coordinates would be wrong the day
 * one does, and wrong quietly.
 */
export function pointerOverBlockingNode(
  nodes: Iterable<{
    type?: string
    position?: { x: number; y: number }
    internals?: { positionAbsolute?: { x: number; y: number } }
    measured?: { width?: number | null; height?: number | null }
    width?: number | null
    height?: number | null
    initialWidth?: number
    initialHeight?: number
  }>,
  px: number,
  py: number,
): boolean {
  for (const n of nodes) {
    if (n.type === undefined || !CUT_BLOCKING_NODE_TYPES.has(n.type)) continue
    const at = n.internals?.positionAbsolute ?? n.position
    if (at === undefined) continue
    const w = n.measured?.width ?? n.width ?? n.initialWidth
    const h = n.measured?.height ?? n.height ?? n.initialHeight
    if (typeof w !== 'number' || typeof h !== 'number') continue
    if (px < at.x || px > at.x + w) continue
    if (py < at.y || py > at.y + h) continue
    return true
  }
  return false
}

// ─────────────────────── registry + hover store ───────────────────────

let hoveredId: string | null = null

/**
 * The edge whose ✂ is actually MOUNTED — `hoveredId` after a short dwell.
 *
 * Two states rather than one, because the button is the only thing here that
 * occupies the pointer. The line brightens the instant the pointer is near it
 * (that is the feedback), but a hit target appearing under the cursor
 * immediately would steal clicks aimed at the canvas behind it: a
 * double-click on empty canvas, or the start of a rubber-band drag, would land
 * on a button that materialised on the way. A dwell fixes both without slowing
 * the cut itself down — anyone reaching for the ✂ has already looked at the
 * line for longer than this.
 */
let armedId: string | null = null
const listeners = new Set<() => void>()
let clearTimer: ReturnType<typeof setTimeout> | null = null
let armTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The edge whose ✂ is SUPPRESSED until the pointer leaves its band and comes
 * back. Without it the button re-arms under a cursor that is in the middle of a
 * press-and-drag, or immediately after a click, and keeps eating input meant
 * for the canvas. "The pointer left and came back" is the only thing that
 * clears it — that is what makes it a latch rather than a debounce.
 */
let suppressedId: string | null = null

const curves = new Map<string, EdgeEntry>()

export function registerEdgeCurve(id: string, path: string): void {
  const curve = parseBezierPath(path)
  if (curve === null) return
  // Flattened HERE, once per geometry — never on the hit-test path.
  curves.set(id, buildEdgeEntry(curve))
}

/**
 * Forget one edge's geometry. Does NOT touch the hover: re-registration is
 * routine (any geometry change re-runs the effect), and clearing here would
 * make the button vanish under a stationary cursor every time the projection
 * rebuilt. A stale `hoveredId` naming an edge that no longer exists is
 * harmless — nothing renders for it, and the next pointermove overwrites it.
 */
export function unregisterEdgeCurve(id: string): void {
  curves.delete(id)
}

/** How near the pointer has to be, in SCREEN pixels — the caller converts to
 *  flow units by dividing by the zoom, so the feel is the same at every zoom. */
export const HOVER_THRESHOLD_PX = 10

export function pickEdgeAt(px: number, py: number, threshold: number): string | null {
  return pickNearest(curves, px, py, threshold)
}

// ───────────────────────── the pointer position ─────────────────────────
//
// The button is drawn AT THE POINTER and follows it along the line, so its
// coordinate changes every frame. It must NOT travel through React: the hover
// BOOLEAN goes through this store + useSyncExternalStore, which re-renders
// exactly the one edge whose state flipped, but a per-frame coordinate down
// that path would re-render an edge on every pointermove. So the mounted button
// installs a sink here and the coordinate is written straight onto its element.

type PointSink = (x: number, y: number) => void

let pointSink: PointSink | null = null
let lastX = 0
let lastY = 0

/** Called from the pointermove effect, every throttled frame. No React. */
export function publishHoverPoint(x: number, y: number): void {
  lastX = x
  lastY = y
  pointSink?.(x, y)
}

/**
 * The mounted button claims the sink and gets the CURRENT point immediately —
 * it mounts on a dwell timer, so there may be no further pointermove at all if
 * the hand is holding still.
 */
export function attachPointSink(sink: PointSink): () => void {
  pointSink = sink
  sink(lastX, lastY)
  return () => {
    if (pointSink === sink) pointSink = null
  }
}

function emit(): void {
  for (const l of listeners) l()
}

function cancelArm(): void {
  if (armTimer !== null) {
    clearTimeout(armTimer)
    armTimer = null
  }
}

/**
 * How long the pointer has to stay on an edge before its ✂ becomes clickable.
 * Long on purpose: it is what keeps a pointer merely CROSSING a line, on its
 * way to click the canvas behind it, from finding a button in the way.
 *
 * It is a dwell on the EDGE, not on a point — `commit()` returns early when the
 * id is unchanged, so sliding along one line never restarts the timer.
 */
const ARM_DELAY_MS = 800

function commit(next: string | null): void {
  if (hoveredId === next) return
  hoveredId = next
  cancelArm()
  if (armedId !== null) armedId = null
  if (next !== null) {
    armTimer = setTimeout(() => {
      armTimer = null
      if (hoveredId !== next) return
      armedId = next
      emit()
    }, ARM_DELAY_MS)
  }
  emit()
}

function cancelClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
}

/** Grace period after the pointer leaves the band — keeps the button alive
 *  across the jitter of a hand holding still near a line. */
const LEAVE_DELAY_MS = 150

function scheduleClear(): void {
  if (clearTimer !== null) return
  clearTimer = setTimeout(() => {
    clearTimer = null
    commit(null)
  }, LEAVE_DELAY_MS)
}

/** What the pane-level pointermove reports. `null` = nothing under the pointer. */
export function reportHoveredEdge(id: string | null): void {
  // Still inside the band of the edge we suppressed: stay suppressed, and do
  // not light the line either. Leaving (or reaching a different edge) is the
  // ONLY way out.
  if (id !== null && id === suppressedId) {
    cancelClear()
    return
  }
  if (suppressedId !== null) suppressedId = null
  if (id === null) {
    scheduleClear()
    return
  }
  cancelClear()
  commit(id)
}

/**
 * A press happened. Whatever edge is hovered stops offering its ✂ until the
 * pointer leaves that edge's band.
 */
export function suppressHoveredEdge(): void {
  if (hoveredId !== null) suppressedId = hoveredId
  cancelClear()
  commit(null)
}

/** Leaving the canvas entirely — drop it now, no grace period. */
export function clearHoveredEdge(): void {
  cancelClear()
  suppressedId = null
  commit(null)
}

export function subscribeEdgeHover(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A PRIMITIVE snapshot, per edge — so only the edge whose state flips
 *  re-renders. */
export function edgeHoverSnapshot(id: string): boolean {
  return hoveredId === id
}

/** Same, for "is this edge's ✂ mounted". */
export function edgeArmedSnapshot(id: string): boolean {
  return armedId === id
}

/** Test-only: drop all registered geometry and hover state. */
export function __resetEdgeHoverForTest(): void {
  curves.clear()
  cancelArm()
  cancelClear()
  hoveredId = null
  armedId = null
  suppressedId = null
  pointSink = null
}
