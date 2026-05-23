/**
 * FireConfirmModal — centered confirmation modal shown by
 * FireConfirmProvider on the user's first paid Generate click in this
 * browser. After acknowledgement (Fire), the gate never opens again —
 * see firstFireGate.ts.
 *
 * Body wording is intentionally generic — kind-agnostic, model-
 * agnostic — because the lesson has to cover every future API call,
 * not just the request that triggered the modal. Only the price line
 * and Fire button suffix are request-specific.
 *
 * Backdrop click + Esc → cancel. Initial focus lands on Cancel
 * (Apple HIG: don't auto-focus the destructive primary).
 */
import { useEffect, useRef } from 'react'
import './fire-confirm-modal.css'

interface FireConfirmModalProps {
  cost?: number
  onFire: () => void
  onCancel: () => void
}

export function FireConfirmModal({
  cost,
  onFire,
  onCancel,
}: FireConfirmModalProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const priceLabel =
    typeof cost === 'number' && Number.isFinite(cost) && cost > 0
      ? `$${cost.toFixed(2)}`
      : null

  return (
    <div
      className="fire-confirm-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="fire-confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fire-confirm-title"
      >
        <div className="fire-confirm-icon" aria-hidden>
          ⚠
        </div>
        <h2 id="fire-confirm-title" className="fire-confirm-title">
          Heads up — fired API calls can't be cancelled
        </h2>
        <p className="fire-confirm-body">
          Once you fire a request, the API call goes through immediately
          and can't be cancelled. You pay for any successful generation
          whether or not you keep the result. Failed generations will
          get refunded. Review every API call you've made at{' '}
          <a
            href="https://pai-pro.utopaistudios.com/tasks"
            target="_blank"
            rel="noopener noreferrer"
            className="fire-confirm-link"
          >
            pai-pro.utopaistudios.com/tasks
          </a>
          .
        </p>
        {priceLabel !== null ? (
          <div className="fire-confirm-price">{priceLabel}</div>
        ) : null}
        <p className="fire-confirm-footnote">
          You only see this once. Future generations fire without a
          confirmation step.
        </p>
        <div className="fire-confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="fire-confirm-btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="fire-confirm-btn fire-confirm-btn-primary"
            onClick={onFire}
          >
            Fire{priceLabel !== null ? ` · ${priceLabel}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
