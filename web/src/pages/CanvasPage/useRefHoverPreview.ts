/**
 * Hover state for a reference thumbnail's floating preview.
 *
 * A CSS `:hover` rule cannot express this interaction. The preview floats
 * ABOVE the thumb with a real gap between them, and the whole point of the
 * feature is that the cursor can travel off the thumb, across that gap, and
 * onto the preview — which is the only clickable part. Under `:hover` the
 * preview dies the instant the cursor leaves the thumb, so it can never be
 * reached, and the click half of the feature does not exist.
 *
 * The grace window is what bridges the gap: leaving starts a timer instead of
 * hiding, and an enter on EITHER the thumb or the preview cancels it. Zero
 * delay fails the same way as CSS, just less reliably — the cursor is in
 * neither element for a frame or two mid-traversal.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Grace period for the cursor to cross the thumb → preview gap. */
export const REF_PREVIEW_HIDE_DELAY_MS = 100

export interface RefHoverPreview {
  isHover: boolean
  /** Put on BOTH the thumb wrapper and the preview — that is what makes the
   *  preview keep itself alive once the cursor lands on it. */
  onMouseEnter: () => void
  onMouseLeave: () => void
  /**
   * Close NOW, with no grace period. Call this the moment the preview's own
   * click is acted on.
   *
   * Without it the preview survives the jump, and it looks like a bug in the
   * jump rather than in the preview: the preview is `position: fixed` in a
   * body portal, so panning the canvas slides the world underneath it while it
   * stays nailed to the screen — and the cursor is still inside it, so the
   * hover that keeps it alive never ends.
   *
   * `onMouseLeave` is not a substitute: it only starts the timer below, and
   * the cursor is still over the preview, so the enter/leave pair that timer
   * exists to bridge never fires again.
   */
  dismiss: () => void
}

export function useRefHoverPreview(): RefHoverPreview {
  const [isHover, setIsHover] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = (): void => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }

  const onMouseEnter = useCallback((): void => {
    clear()
    setIsHover(true)
  }, [])

  const onMouseLeave = useCallback((): void => {
    clear()
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      setIsHover(false)
    }, REF_PREVIEW_HIDE_DELAY_MS)
  }, [])

  const dismiss = useCallback((): void => {
    clear()
    setIsHover(false)
  }, [])

  useEffect(() => clear, [])

  return { isHover, onMouseEnter, onMouseLeave, dismiss }
}
