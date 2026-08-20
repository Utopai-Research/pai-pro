/**
 * GroupCreateModal — opens when the selection pill's Group action or
 * Cmd+G fires. Captures title + hue, calls `onConfirm` with both.
 *
 * Inputs:
 *   - title: text. Empty allowed (frame just shows the hue with no
 *     label). Max ~40 chars to fit in the small frame title slot.
 *   - hue: 1 of 6 preset oklch hues. Default 220 (blue) matches the
 *     pick-variation preview. Custom hex picker deferred to PR #55.
 *
 * Closes on:
 *   - Confirm button → onConfirm(title, hue)
 *   - Cancel button → onCancel
 *   - Escape key → onCancel
 *   - Backdrop click → onCancel
 *
 * Does NOT close on confirm if the parent's onConfirm rejects (e.g.
 * Firestore write fails) — parent owns the close lifecycle.
 */
import './group-create-modal.css'
import { useEffect, useState } from 'react'
// HUE_PRESETS moved to groupFrameHues.ts (PR-C1) so the recolor
// toolbar inside GroupFrameNode shares the same palette.
import { HUE_PRESETS } from './groupFrameHues'

const TITLE_MAX_LENGTH = 40

interface GroupCreateModalProps {
  isOpen: boolean
  onConfirm: (title: string, hue: number) => void
  onCancel: () => void
}

export function GroupCreateModal({
  isOpen,
  onConfirm,
  onCancel,
}: GroupCreateModalProps): JSX.Element | null {
  const [title, setTitle] = useState('')
  const [hue, setHue] = useState(220)

  // Reset on open so consecutive opens don't show stale state.
  useEffect(() => {
    if (isOpen) {
      setTitle('')
      setHue(220)
    }
  }, [isOpen])

  // Escape closes.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onConfirm(title.trim(), hue)
  }

  return (
    <div className="group-modal-backdrop" onClick={onCancel}>
      <form
        className="group-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="group-modal-head">
          <span className="group-modal-title">Create group</span>
          <span className="group-modal-sub">
            Group the selected shots with a label and color.
          </span>
        </div>

        <div className="group-modal-field">
          <span className="group-modal-label">Title (optional)</span>
          <input
            className="group-modal-input"
            type="text"
            value={title}
            maxLength={TITLE_MAX_LENGTH}
            placeholder="e.g. Coastal driving sequence"
            onChange={(e) => setTitle(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: modal first-focus is canonical
            autoFocus
          />
        </div>

        <div className="group-modal-field">
          <span className="group-modal-label">Color</span>
          <div className="group-modal-hues">
            {HUE_PRESETS.map((preset) => (
              <button
                key={preset.hue}
                type="button"
                title={preset.label}
                className={`group-modal-hue${hue === preset.hue ? ' selected' : ''}`}
                style={{ ['--swatch-hue' as string]: preset.hue }}
                onClick={() => setHue(preset.hue)}
              />
            ))}
          </div>
        </div>

        <div className="group-modal-actions">
          <button
            type="button"
            className="group-modal-btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="group-modal-btn group-modal-btn-primary"
          >
            Create group
          </button>
        </div>
      </form>
    </div>
  )
}
