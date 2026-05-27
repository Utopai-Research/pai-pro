/** Modal that gates run-immediately mode behind typing "I understand"
 *  (case-insensitive, trimmed). Parent owns the PATCH and close. */
import { useEffect, useState } from 'react'
import './draft-gate-modal.css'

const CONFIRM_PHRASE = 'i understand'

interface DraftGateModalProps {
  isOpen: boolean
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function DraftGateModal({
  isOpen,
  onConfirm,
  onCancel,
}: DraftGateModalProps): JSX.Element | null {
  const [phrase, setPhrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setPhrase('')
      setSubmitting(false)
      setError(null)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const matches = phrase.trim().toLowerCase() === CONFIRM_PHRASE
  const canSubmit = matches && !submitting

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="draft-gate-backdrop" onClick={onCancel}>
      <form
        className="draft-gate-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="draft-gate-head">
          <span className="draft-gate-warn">⚠</span>
          <span className="draft-gate-title">Run generations immediately?</span>
        </div>

        <div className="draft-gate-body">
          <p>
            Draft review will be turned off. Generations will run immediately,
            with no draft card to approve first.
          </p>
          <p className="draft-gate-pricing">
            A 10s 1080p clip is ~$3.41; an image generation is ~$0.10.
          </p>
        </div>

        <div className="draft-gate-field">
          <label className="draft-gate-label" htmlFor="draft-gate-input">
            To confirm, type: <code>I understand</code>
          </label>
          <input
            id="draft-gate-input"
            className="draft-gate-input"
            type="text"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="I understand"
            disabled={submitting}
            // biome-ignore lint/a11y/noAutofocus: modal first-focus is canonical
            autoFocus
          />
        </div>

        {error !== null ? (
          <div className="draft-gate-error">{error}</div>
        ) : null}

        <div className="draft-gate-actions">
          <button
            type="button"
            className="draft-gate-cancel"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="draft-gate-confirm"
            disabled={!canSubmit}
          >
            {submitting ? 'Saving…' : 'Run immediately'}
          </button>
        </div>
      </form>
    </div>
  )
}
