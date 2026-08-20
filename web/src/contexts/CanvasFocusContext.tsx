/**
 * CanvasFocusContext — bridge between the AssetRail (sidebar) and the
 * React Flow surface inside CanvasPage.
 *
 * AssetRow's click handler needs to scroll the canvas viewport to
 * center on a node, which requires `useReactFlow().setCenter` — only
 * available inside <ReactFlowProvider>. The AssetRail sits OUTSIDE
 * that provider (it's a sibling of CanvasPage under CanvasView), so
 * we use the same register/consume pattern as ChatComposerContext:
 * CanvasPageInner registers its focus function on mount; AssetRail
 * consumes via `useCanvasFocus()`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/** One id centers that node; several frame all of them at once (the asset
 *  browser's "used in N" jump — the answer to that question is a set, and
 *  showing it one node at a time would lose the shape of it). */
export type CanvasFocusFn = (nodeId: string | string[]) => void

interface CanvasFocusContextValue {
  focus: CanvasFocusFn | null
  register: (fn: CanvasFocusFn | null) => void
}

const CanvasFocusContext = createContext<CanvasFocusContextValue | null>(null)

export function CanvasFocusProvider({ children }: { children: ReactNode }): JSX.Element {
  const [focus, setFocus] = useState<CanvasFocusFn | null>(null)

  const register = useCallback((fn: CanvasFocusFn | null) => {
    setFocus(() => fn)
  }, [])

  const value = useMemo<CanvasFocusContextValue>(
    () => ({ focus, register }),
    [focus, register],
  )

  return (
    <CanvasFocusContext.Provider value={value}>
      {children}
    </CanvasFocusContext.Provider>
  )
}

/** Returns the registered focus fn, or null if no canvas is mounted. */
export function useCanvasFocus(): CanvasFocusFn | null {
  const ctx = useContext(CanvasFocusContext)
  return ctx?.focus ?? null
}

/** CanvasPage calls this in a useEffect to publish its setCenter wrapper. */
export function useCanvasFocusRegistration(fn: CanvasFocusFn | null): void {
  const ctx = useContext(CanvasFocusContext)
  useEffect(() => {
    if (ctx === null) return
    if (fn === null) return
    ctx.register(fn)
    return () => {
      ctx.register(null)
    }
  }, [ctx, fn])
}
