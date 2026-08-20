import { useEffect, useState } from 'react'

/**
 * Keeps an overlay mounted long enough to play its exit animation.
 *
 * Overlays that render `open ? <div/> : null` unmount in one frame, which
 * makes an exit animation impossible. Drive them with this instead:
 *
 *   const { mounted, closing } = usePresence(open)
 *   if (!mounted) return null
 *   return <div className={closing ? 'presence-closing' : undefined}>…
 *
 * `exitMs` must cover the exit animation's duration (the shared
 * presence-*-out pair in index.css runs 160ms). Reopening mid-exit is
 * interruptible: `open` flipping back true returns straight to 'open'.
 */
export function usePresence(
  open: boolean,
  exitMs = 160,
): { mounted: boolean; closing: boolean } {
  const [state, setState] = useState<'open' | 'closing' | 'closed'>(
    open ? 'open' : 'closed',
  )

  useEffect(() => {
    if (open) {
      setState('open')
      return
    }
    setState((s) => (s === 'closed' ? 'closed' : 'closing'))
  }, [open])

  useEffect(() => {
    if (state !== 'closing') return
    const t = setTimeout(() => setState('closed'), exitMs)
    return () => clearTimeout(t)
  }, [state, exitMs])

  return { mounted: state !== 'closed', closing: state === 'closing' }
}
