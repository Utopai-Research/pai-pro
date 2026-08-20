/**
 * UndoToast — what makes a silent archive safe.
 *
 * Archiving a node never stops to ask, so the safety net has to be right
 * where the act happened: a line saying what left, and a way back. Cmd+Z
 * does the same thing and always did; this is the discoverable version.
 *
 * Sits in the bottom-centre slot, one notch above SaveStatusPill.
 */
import { useEffect, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { usePresence } from '@/lib/usePresence'

interface UndoToastProps {
  message: string
  /** Absent = a purely informational line ("redo isn't available for that"):
   *  the Undo button is not rendered, because a button that pops whatever
   *  entry happens to be on top would not be undoing the thing the message
   *  is about. */
  onUndo?: () => void
  onDismiss: () => void
}

/** Long enough to notice and reach; short enough not to become furniture. */
const DISMISS_MS = 8000

export function UndoToast({
  message,
  onUndo,
  onDismiss,
}: UndoToastProps): JSX.Element | null {
  // The parent unmounts on onDismiss in one frame, so the exit has to play
  // here: flip `open` at DISMISS_MS, let usePresence hold the toast through
  // the pill-out fade, and only then report the dismissal upward.
  const [open, setOpen] = useState(true)

  useEffect(() => {
    setOpen(true)
    const t = window.setTimeout(() => setOpen(false), DISMISS_MS)
    return () => window.clearTimeout(t)
    // Re-arm on every new message: a second archive restarts the clock
    // rather than inheriting the remains of the first one's.
  }, [message])

  // The default exitMs (160ms) covers pill-out's var(--dur-fast).
  const { mounted, closing } = usePresence(open)

  useEffect(() => {
    if (!mounted) onDismiss()
  }, [mounted, onDismiss])

  if (!mounted) return null

  return (
    <div
      role="status"
      className={`pill-presence absolute bottom-[74px] left-1/2 z-[16] flex -translate-x-1/2 items-center gap-3 rounded-[10px] border border-[var(--line-2)] bg-[var(--bg-2)] px-3.5 py-2 text-[12px] text-[var(--ink-1)] shadow-[0_6px_20px_oklch(0_0_0_/_0.45)]${
        closing ? ' pill-closing' : ''
      }`}
    >
      <span>{message}</span>
      {onUndo !== undefined ? (
        <button
          type="button"
          onClick={onUndo}
          className="flex items-center gap-1 text-[12px] font-medium text-[var(--cv-accent)] transition-opacity hover:opacity-80"
        >
          <Undo2 size={12} strokeWidth={2} aria-hidden />
          Undo
        </button>
      ) : null}
    </div>
  )
}
