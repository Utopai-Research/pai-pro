/**
 * Canvas save-status context. Tracks how many position-persist writes
 * are in flight ("Saving…") and whether the most recent one failed
 * ("Save failed"). Consumed by SaveStatusPill (visible UI) and produced
 * by useCanvasPositions's persistDrag wrapper.
 *
 * The beforeunload guard lives here rather than in the pill. What decides
 * whether leaving the page loses work is the number of writes still in
 * flight, and this is the thing that holds that number; the pill only
 * renders it, and a pill that happened to be unmounted would take the
 * guard down with it.
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

interface CanvasSaveStatusValue {
  pendingCount: number
  lastError: string | null
  beginPersist: () => void
  endPersist: (failed: boolean, errMsg?: string) => void
}

const CanvasSaveStatusContext = createContext<CanvasSaveStatusValue | null>(null)

export function CanvasSaveStatusProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pendingCount, setPendingCount] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)

  const beginPersist = useCallback(() => {
    setPendingCount((c) => c + 1)
  }, [])

  const endPersist = useCallback((failed: boolean, errMsg?: string) => {
    setPendingCount((c) => Math.max(0, c - 1))
    if (failed) {
      setLastError(errMsg ?? 'save failed')
    } else {
      setLastError(null)
    }
  }, [])

  // beforeunload guard — while pendingCount > 0, refresh / tab close
  // triggers the browser's native "Leave site? Changes you made may
  // not be saved." dialog. Modern browsers ignore custom messages
  // (anti-phishing); this is purely "interrupt the unintentional
  // refresh." It does NOT save the data — if the user confirms Leave,
  // the in-flight Firestore write still gets cancelled. Proper fix
  // would be navigator.sendBeacon (deferred).
  useEffect(() => {
    if (pendingCount === 0) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      // Required by older browsers; modern browsers read the prevented
      // state, not the value.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [pendingCount])

  const value = useMemo<CanvasSaveStatusValue>(
    () => ({ pendingCount, lastError, beginPersist, endPersist }),
    [pendingCount, lastError, beginPersist, endPersist],
  )

  return (
    <CanvasSaveStatusContext.Provider value={value}>
      {children}
    </CanvasSaveStatusContext.Provider>
  )
}

// Returns null when used outside a provider — callers (useCanvasPositions)
// treat null as "skip the status update" so the canvas still works in
// environments without the provider mounted (tests, isolated stories).
export function useCanvasSaveStatus(): CanvasSaveStatusValue | null {
  return useContext(CanvasSaveStatusContext)
}
