/**
 * MediaExpandChat — bottom chat bar inside MediaExpandOverlay.
 *
 * Send-only fast-lane into the existing per-project pty session.
 * Composes a message and submits it through ChatComposerContext;
 * SelectionToolbar's "📎 Refer" path still only inserts draft text.
 *
 * Default scope chip pins the message to the currently-expanded
 * node (`@image_5` etc). User can × the chip to send unscoped, or
 * drop a file onto the bar to append a fresh `@<new_id>` token
 * after the file uploads as a canvas node.
 *
 * No reply transcript is shown here — the agent's response lands
 * in the main terminal panel. This bar is write-only.
 */
import { useEffect, useRef, useState } from 'react'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import { apiUploadAttachment } from '@/lib/canvas-stub'

const MAX_TEXTAREA_HEIGHT = 140 // ~5 lines at 12px line-height + padding

export function MediaExpandChat({
  nodeId,
  projectId,
}: {
  nodeId: string
  projectId: string | null
}): JSX.Element {
  const composer = useChatComposer()
  const [value, setValue] = useState('')
  const [scopeOn, setScopeOn] = useState(true)
  const [toast, setToast] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

  // Reset state when the modal switches to a different node.
  useEffect(() => {
    setValue('')
    setScopeOn(true)
    setToast(false)
  }, [nodeId])

  // Auto-grow textarea up to MAX_TEXTAREA_HEIGHT, then scroll inside.
  useEffect(() => {
    const el = textRef.current
    if (el === null) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)
    el.style.height = next + 'px'
  }, [value])

  const onSend = (): void => {
    if (composer === null) return
    const text = value.trim()
    if (text === '') return
    const message = scopeOn ? `@${nodeId} ${text}` : text
    composer.sendToAgent(message)
    setValue('')
    setToast(true)
    window.setTimeout(() => setToast(false), 1500)
    // Keep focus so the user can fire follow-up edits without re-clicking.
    requestAnimationFrame(() => textRef.current?.focus())
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      onSend()
    }
    // Esc inside the textarea is intentionally a no-op: the modal's
    // window-level Esc handler already skips closing when an INPUT or
    // TEXTAREA owns focus, so we let it pass through silently. The
    // user clicks elsewhere (or the × close button) to dismiss.
  }

  // Drop-to-attach. UploadOverlay listens at window level; we stop
  // native propagation so it doesn't ALSO process the same drop.
  const onDragEnter = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.nativeEvent.stopImmediatePropagation()
    setDragOver(true)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.nativeEvent.stopImmediatePropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.nativeEvent.stopImmediatePropagation()
    setDragOver(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.nativeEvent.stopImmediatePropagation()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void attachFiles(files)
  }

  const attachFiles = async (files: File[]): Promise<void> => {
    if (projectId === null) return
    for (const file of files) {
      try {
        const node = await apiUploadAttachment(projectId, file, null)
        setValue((v) => {
          const sep = v === '' || v.endsWith(' ') || v.endsWith('\n') ? '' : ' '
          return v + sep + `@${node.id} `
        })
      } catch {
        // Silent — the modal isn't the place for error toasts. A future
        // pass could surface this in the toast slot below.
      }
    }
    textRef.current?.focus()
  }

  const sendDisabled = composer === null || value.trim() === ''

  return (
    <div
      className={'me-chat' + (dragOver ? ' me-chat-drag' : '')}
      onClick={(e) => e.stopPropagation()}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="me-chat-row">
        {scopeOn ? (
          <span className="me-chat-chip" title="Scope of this message — click × to remove">
            <span className="me-chat-chip-arrow" aria-hidden>↳</span>
            <span className="me-chat-chip-tag">@{nodeId}</span>
            <button
              type="button"
              className="me-chat-chip-x"
              onClick={() => {
                setScopeOn(false)
                textRef.current?.focus()
              }}
              aria-label="Remove scope"
              title="Remove scope (send without @reference)"
            >
              ×
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="me-chat-chip-restore"
            onClick={() => {
              setScopeOn(true)
              textRef.current?.focus()
            }}
            title="Restore scope to this image"
          >
            ↳ scope
          </button>
        )}
        <textarea
          ref={textRef}
          className="me-chat-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={scopeOn ? 'Describe an edit…' : 'Message the agent…'}
          rows={1}
          spellCheck={false}
        />
        <button
          type="button"
          className="me-chat-send"
          onClick={onSend}
          disabled={sendDisabled}
          aria-label="Send to agent"
          title={composer === null ? 'Composer not ready' : 'Send (Enter)'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <path
              d="M12 4 L12 20 M5 11 L12 4 L19 11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className={'me-chat-toast' + (toast ? ' me-chat-toast-on' : '')} aria-live="polite">
        Sent to agent
      </div>
      <div className={'me-chat-dropmask' + (dragOver ? ' me-chat-dropmask-on' : '')} aria-hidden>
        Drop to attach as @reference
      </div>
    </div>
  )
}

function hasFiles(e: React.DragEvent): boolean {
  const dt = e.dataTransfer
  if (!dt) return false
  if (dt.types && Array.from(dt.types).includes('Files')) return true
  if (dt.files && dt.files.length > 0) return true
  return false
}
