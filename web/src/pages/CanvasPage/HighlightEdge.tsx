/**
 * HighlightEdge — the canvas's only edge renderer.
 *
 * Three states, in priority order:
 *   hovered      the pane-level hit test (edgeHover.ts) says the pointer is
 *                within the band. Brightest, and after a dwell it also mounts
 *                the ✂ that cuts the connection.
 *   highlighted  an endpoint node is selected — how you trace a card's lineage.
 *   idle         a faint line.
 *
 * `interactionWidth={0}`: this edge contributes NO invisible grab path. Hover
 * comes from geometry instead — edgeHover.ts explains the three ways a per-edge
 * grab path breaks this canvas.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useStore,
} from '@xyflow/react'
import { Scissors } from 'lucide-react'
import {
  attachPointSink,
  edgeArmedSnapshot,
  edgeHoverSnapshot,
  isCuttableEdgeId,
  registerEdgeCurve,
  subscribeEdgeHover,
  suppressHoveredEdge,
  unregisterEdgeCurve,
} from './edgeHover'
import { useNodeActions } from './NodeActionsContext'

/**
 * The cut button — mounted ONLY on the ARMED edge, and drawn AT THE POINTER so
 * it rides the line under the cursor. Aiming at a button that appears where you
 * are already looking is much easier than reaching for one parked at the
 * geometric midpoint.
 *
 * A separate component for two reasons that both come down to cost:
 *  - its position NEVER goes through React. The coordinate changes every frame,
 *    and this canvas can carry hundreds of edges; it is written straight onto
 *    the element as CSS custom properties, and the stylesheet composes the
 *    transform.
 *  - the viewport-zoom subscription is then ONE, not one per edge. Inside
 *    HighlightEdge every wheel tick would re-render every visible edge.
 */
function EdgeScissors({
  from,
  to,
  kind,
}: {
  from: string
  to: string
  kind?: string
}): JSX.Element {
  const { onDeleteEdge } = useNodeActions()
  const ref = useRef<HTMLDivElement | null>(null)

  // Take over the pointer sink for as long as this button exists.
  // `attachPointSink` hands back the CURRENT point immediately, which matters:
  // the button mounts on a dwell timer, so if the hand is holding still there
  // is no further pointermove to position it.
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    return attachPointSink((x, y) => {
      el.style.setProperty('--ecx', `${x}px`)
      el.style.setProperty('--ecy', `${y}px`)
    })
  }, [])

  // EdgeLabelRenderer's content lives INSIDE the transformed viewport, so a
  // 30px button would shrink with the zoom. Counter-scale to hold it at 30 on
  // screen. Written as a property too, so React never owns `transform` and
  // cannot clobber the coordinate the sink just wrote.
  const zoom = useStore((s) => s.transform[2])
  useLayoutEffect(() => {
    ref.current?.style.setProperty('--ecz', String(1 / (zoom === 0 ? 1 : zoom)))
  }, [zoom])

  const onClick = useCallback(
    (e: ReactMouseEvent) => {
      // Without this the click reaches React Flow's edge <g>, whose handler
      // unselects all NODES — the selection pill would vanish as a side effect
      // of cutting a line.
      e.stopPropagation()
      // Latch this edge off. The button is under the pointer, so otherwise the
      // dwell would simply re-arm here and the next click would land on a
      // button again; the pointer has to leave the band and come back.
      suppressHoveredEdge()
      // No toast and no dialog — but the failure must not be swallowed: with no
      // optimistic update, a rejected mutation reads as "the scissors did
      // nothing".
      void onDeleteEdge?.(from, to, kind).catch((err: unknown) => {
        console.error(`[canvas] could not cut ${from} -> ${to}:`, err)
      })
    },
    [from, to, kind, onDeleteEdge],
  )

  // Naming both ends is the ONLY warning this gesture has: an authorship edge
  // between a note and its media is invisible everywhere else, and most edges
  // here cannot be redrawn by any gesture.
  const label = `Delete link: ${from} → ${to}`

  return (
    <EdgeLabelRenderer>
      <div ref={ref} className="edge-cut-layer nodrag nopan">
        <button
          type="button"
          className="edge-cut-btn"
          aria-label={label}
          title={label}
          onClick={onClick}
        >
          <Scissors size={15} />
        </button>
      </div>
    </EdgeLabelRenderer>
  )
}

function HighlightEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  source,
  target,
  markerEnd,
  data,
  style: incomingStyle,
}: EdgeProps): JSX.Element {
  // Per-edge selector — only edges whose source or target is currently
  // selected re-render when that node's `selected` flag flips.
  const highlighted = useStore((s) =>
    Boolean(
      s.nodeLookup.get(source)?.selected || s.nodeLookup.get(target)?.selected,
    ),
  )

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const cuttable = isCuttableEdgeId(id)

  // Register the geometry the renderer is about to paint, keyed by the path
  // string — it encodes both endpoints and both control points, so anything
  // that moves the line re-registers it.
  useEffect(() => {
    if (!cuttable) return
    registerEdgeCurve(id, path)
    return () => unregisterEdgeCurve(id)
  }, [id, path, cuttable])

  // Primitive per-edge snapshots: only the edge whose state flipped
  // re-renders, not all of them.
  const hovered = useSyncExternalStore(
    subscribeEdgeHover,
    () => edgeHoverSnapshot(id),
    () => false,
  )
  const armed = useSyncExternalStore(
    subscribeEdgeHover,
    () => edgeArmedSnapshot(id),
    () => false,
  )

  const lit = hovered || highlighted
  const kind = (data as { kind?: string } | undefined)?.kind

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={0}
        style={{
          ...incomingStyle,
          stroke: lit ? '#ffffff' : 'var(--line-2)',
          strokeWidth: hovered ? 2 : 1,
          opacity: lit ? 1 : 0.32,
          filter: lit
            ? 'drop-shadow(0 0 3px rgba(255, 255, 255, 0.55))'
            : undefined,
          transition:
            'opacity 160ms ease, stroke 160ms ease, filter 160ms ease, stroke-width 160ms ease',
        }}
      />
      {armed && cuttable ? (
        <EdgeScissors from={source} to={target} kind={kind} />
      ) : null}
    </>
  )
}

export const HighlightEdge = memo(HighlightEdgeImpl)
