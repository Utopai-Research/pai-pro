/**
 * MediaExpandOverlay — full-canvas-pane overlay invoked by
 * NodeActionsContext.onExpandMedia. Mounts inside .canvas-host so the
 * agent panel on the right stays visible and interactive.
 *
 * Layout: V3 (top strip + media + chat bar) picked 2026-05-11.
 * The previous V2 (320px left sidebar) traded media size for prompt
 * readability; V3 takes the opposite stance — image gets the full
 * width, prompt + refs collapse into a single compact strip on top
 * (click to expand into a detail panel), and a chat bar at the
 * bottom lets the user fire edit instructions directly to the
 * agent's pty session, pre-scoped to the current node.
 *
 * Real media (`image` / `video` / `audio`) render the asset; generation
 * media (`*-generation`) render draft/running/failed pending pads opened
 * from PendingGenerationNode.
 *
 * Mention chips inside the prompt (`@Image1`, `@Video1`, `@Audio1`)
 * render as inline thumbnails when their indexed reference is present;
 * unresolved tokens fall back to a tagged-only chip. Token counter is
 * per-kind (separate `@Image*` / `@Video*` / `@Audio*` counters).
 */
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import { useCanvasFocus } from '@/contexts/CanvasFocusContext'
import { MediaExpandChat } from './MediaExpandChat'
import { buildGenerationFailureAgentPrompt } from './generationFailurePrompt'
import { downloadHref } from './nodeData'
import { useNodeActions } from './NodeActionsContext'
import { mutateCanvas } from '@/lib/canvas-stub'
import { useFireConfirm } from './FireConfirmProvider'
import { useCost } from '@/lib/useModels'
import { VIEWER_URL } from '@/lib/socket'
import type { NoteSubtype } from '@/types/canvas'
import './expand-overlay.css'

export type MediaRefKind = 'image' | 'video' | 'audio'

export interface MediaRef {
  kind: MediaRefKind
  url: string
}

export interface MediaMetadata {
  model?: string
  source?: string
  aspect_ratio?: string
  image_size?: string
  resolution?: string
  generate_audio?: boolean
  generated_at?: string
}

export interface MediaPayload {
  /** node id; used for state-reset effects */
  id?: string
  kind: 'image' | 'video' | 'audio' | 'image-generation' | 'video-generation' | 'audio-generation' | 'note'
  url?: string | null
  label?: string
  meta?: string
  prompt?: string
  /** Audio-only: spoken text (TTS subtype). */
  text?: string
  references?: MediaRef[]
  nodeType?: 'image_result' | 'video_result' | 'audio_result' | 'note'
  metadata?: MediaMetadata
  /** Top-level duration on video_result (not in metadata). */
  duration?: number | string
  /** Note-only: markdown body, rendered + editable in the overlay. */
  body?: string
  /** Note-only: subtype variant (script/shot) — drives header chip. */
  subtype?: NoteSubtype
  /** True when opened from the sidebar against a soft-deleted node.
   * Hides the chat composer and surfaces a "Put on canvas" bar at the
   * bottom of the modal. */
  archived?: boolean
  /** Pending-only. When 'draft', the expanded PROMPT section renders
   * an editable textarea so the user can revise without leaving the
   * overlay. */
  stage?: 'draft' | 'running' | 'failed'
  /** Pending failed result context. Durable details live in `.results/<jobId>.json`. */
  failure?: {
    klass?: string
    message?: string
    sent?: unknown
    jobId?: string
  }
}

export function MediaExpandOverlay({
  media,
  onClose,
  projectId,
}: {
  media: MediaPayload | null
  onClose: () => void
  projectId: string | null
}): JSX.Element | null {
  const [topExpanded, setTopExpanded] = useState(false)
  const [noteEditing, setNoteEditing] = useState(false)
  const [noteEditBody, setNoteEditBody] = useState('')
  const [noteEditLabel, setNoteEditLabel] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null)
  const { onSaveNote, onPatchDraft, onFireDraft, onDiscardDraft, onDismissFailedGeneration } = useNodeActions()
  const composer = useChatComposer()
  const [fireError, setFireError] = useState<string | null>(null)
  // First-fire gate: routes the overlay's Generate click through the
  // centered confirmation modal owned by FireConfirmProvider. Same
  // ack key as the card, so confirming once silences both surfaces.
  const { requestFire } = useFireConfirm()
  const canvasFocus = useCanvasFocus()

  // Esc closes the overlay, but only when no input/textarea has focus
  // (so the chat composer's Esc handler still owns its own keystroke).
  useEffect(() => {
    if (media === null) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const a = document.activeElement
      const tag = a?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (a as HTMLElement | null)?.isContentEditable === true) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [media, onClose])

  // Reset transient panel state when the modal switches nodes.
  useEffect(() => {
    setTopExpanded(false)
    setNoteEditing(false)
    setNoteEditBody('')
    setNoteEditLabel('')
    setNoteSaveError(null)
    setNoteSaving(false)
    setFireError(null)
  }, [media?.id])

  // Hooks must run unconditionally and before any early return. We read
  // metadata fields off `media` here (with optional chaining) so the
  // hook order stays stable when media goes from null → present.
  const mediaMetadata = media?.metadata
  const mediaDuration = media?.duration
  const mediaHasMetadata = mediaMetadata !== undefined
  const cost = useCost(
    mediaHasMetadata ? mediaMetadata?.model : null,
    mediaHasMetadata
      ? {
          image_size: mediaMetadata?.image_size,
          resolution: mediaMetadata?.resolution,
          duration: mediaDuration,
        }
      : undefined,
  )

  if (media === null) return null

  const { kind, url, label, meta, prompt, references, id, nodeType, metadata, duration, body, subtype, archived, text, stage, failure } = media
  const refs: MediaRef[] = Array.isArray(references) ? references : []
  const hasPrompt = typeof prompt === 'string' && prompt.trim() !== ''
  const hasRefs = refs.length > 0
  const isGenerating = kind === 'image-generation' || kind === 'video-generation' || kind === 'audio-generation'
  const isDraft = isGenerating && stage === 'draft'
  const isFailed = isGenerating && stage === 'failed'
  const isNote = kind === 'note'
  const isAudio = kind === 'audio'
  const isArchived = archived === true
  const hasMetadata = !isNote && metadata !== undefined
  const hasTopContent = !isNote && (hasPrompt || hasRefs || hasMetadata || failure !== undefined)
  // Archived nodes can't be referenced by agent tools (the
  // `buildProviderRefs` / `postNodeAddBatch` chokepoints reject them),
  // so the chat composer would just lead to a `bad_args` failure. Hide
  // it and surface a Restore CTA in the same slot instead.
  const canChat = !isGenerating && !isArchived && typeof id === 'string' && id !== ''
  const failureJobId = failure?.jobId ?? (isFailed && typeof id === 'string' ? id : undefined)

  const onFireFromOverlay = (): void => {
    if (onFireDraft === undefined || typeof id !== 'string' || id === '') return
    requestFire({
      cost: cost ?? undefined,
      onConfirm: () => {
        // Fire-and-forget: POST returns 202 once the spawn lands; the
        // running state flows back via the pending-generations socket
        // event and the card's running branch takes over. Close the
        // overlay immediately so the user sees the card flip behind it.
        onFireDraft(id).catch((err) => {
          console.warn('[expand] fire failed:', err)
        })
        onClose()
      },
    })
  }
  const onCancelFromOverlay = (): void => {
    if (onDiscardDraft === undefined || typeof id !== 'string' || id === '') return
    onDiscardDraft(id).then(() => {
      onClose()
    }).catch((err) => {
      setFireError(err instanceof Error ? err.message : String(err))
    })
  }
  const onSendFailureToAgent = (): void => {
    if (!isFailed || composer === null || typeof failureJobId !== 'string' || failureJobId === '') return
    composer.insertAtCursor(buildGenerationFailureAgentPrompt({
      jobId: failureJobId,
      kind: kind === 'video-generation' ? 'video' : kind === 'audio-generation' ? 'audio' : 'image',
      klass: failure?.klass,
      message: failure?.message,
      sent: failure?.sent,
    }) + '\r')
    onDismissFailedGeneration?.(failureJobId)
    onClose()
  }
  const onDismissFailure = (): void => {
    if (!isFailed || typeof failureJobId !== 'string' || failureJobId === '') return
    onDismissFailedGeneration?.(failureJobId)
    onClose()
  }

  const onRestore = async (): Promise<void> => {
    if (projectId === null || typeof id !== 'string' || id === '') return
    try {
      await mutateCanvas(projectId, 'updateNode', {
        id,
        patch: { archived: null, archived_at: null },
      })
      onClose()
      // Center the canvas on the restored node so the user sees where
      // it landed. Wait one socket round-trip for the node to appear in
      // React Flow before calling setCenter.
      setTimeout(() => {
        canvasFocus?.(id)
      }, 200)
    } catch (err) {
      console.warn(`[expand] restore ${id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const noteBody = typeof body === 'string' ? body : ''
  const noteLabel = typeof label === 'string' ? label : ''
  const noteDownloadHref =
    isNote && typeof id === 'string' && id !== '' && typeof projectId === 'string' && projectId !== ''
      ? downloadHref(`${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/assets/notes/${encodeURIComponent(id)}.md`)
      : null
  const startEditingNote = (): void => {
    setNoteEditBody(noteBody)
    setNoteEditLabel(noteLabel)
    setNoteSaveError(null)
    setNoteEditing(true)
  }
  const cancelEditingNote = (): void => {
    setNoteEditing(false)
    setNoteSaveError(null)
  }
  const saveNoteEdits = async (): Promise<void> => {
    if (typeof id !== 'string' || id === '' || onSaveNote === undefined) return
    const patch: { label?: string; body?: string } = {}
    if (noteEditLabel !== noteLabel) patch.label = noteEditLabel
    if (noteEditBody !== noteBody) patch.body = noteEditBody
    if (Object.keys(patch).length === 0) {
      setNoteEditing(false)
      return
    }
    setNoteSaving(true)
    setNoteSaveError(null)
    try {
      await onSaveNote(id, patch)
      setNoteEditing(false)
    } catch (err) {
      setNoteSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setNoteSaving(false)
    }
  }

  // Group refs by kind so positional numbering matches the prompt-token
  // convention: `@Image1` is the first image ref, etc — independent
  // counters per kind.
  const refsByKind: Record<MediaRefKind, MediaRef[]> = { image: [], video: [], audio: [] }
  for (const r of refs) {
    if (r.kind in refsByKind) refsByKind[r.kind].push(r)
  }

  // Eat drag events at the overlay level so UploadOverlay's window
  // listeners don't ALSO process them (which would tint the canvas
  // behind the backdrop blur). The chat bar attaches its own deeper
  // handlers that fire first; everything else is silently swallowed.
  const swallowDrag = (e: React.DragEvent): void => {
    e.preventDefault()
    e.nativeEvent.stopImmediatePropagation()
  }

  return (
    <div
      className="media-expand-overlay"
      onClick={onClose}
      onWheel={(e) => e.stopPropagation()}
      onDragEnter={swallowDrag}
      onDragOver={swallowDrag}
      onDragLeave={swallowDrag}
      onDrop={swallowDrag}
      role="dialog"
      aria-label={label ?? 'expanded media'}
    >
      <div
        className={
          'media-expand-content' +
          (topExpanded ? ' media-expand-content-top-open' : '') +
          (isDraft ? ' media-expand-content-draft' : '') +
          (isFailed ? ' media-expand-content-failed' : '')
        }
        onClick={(e) => {
          e.stopPropagation()
          // When the top details panel is open, treat any click outside
          // `.me-top` (which wraps both the toggle bar and the dropdown
          // panel) as a dismiss — same mental model as the outer backdrop.
          // Skipped for drafts since the panel IS the main content.
          if (!isDraft && topExpanded && (e.target as HTMLElement).closest('.me-top') === null) {
            setTopExpanded(false)
          }
        }}
      >
        {/* Close lives INSIDE the content card so it's anchored to the
            modal's top-right edge, not the canvas pane's. The card
            itself sits behind the agent panel on the right; placing
            the X on the overlay would hide it under the agent panel.
            Archived state's "Put on canvas" CTA lives down in the
            chat-bar slot, not up here. */}
        <button
          type="button"
          className="media-expand-close"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
        >
          ×
        </button>

        {hasTopContent ? (
          <TopStrip
            prompt={hasPrompt ? prompt! : null}
            text={kind === 'audio-generation' ? text ?? '' : null}
            refs={refs}
            refsByKind={refsByKind}
            expanded={topExpanded}
            onToggle={() => setTopExpanded((v) => !v)}
            nodeType={nodeType === 'note' ? undefined : nodeType}
            metadata={hasMetadata ? metadata : undefined}
            duration={duration}
            cost={cost}
            failure={failure}
            forceExpanded={isDraft || isFailed}
            onSavePrompt={
              isDraft && onPatchDraft !== undefined && typeof id === 'string' && id !== ''
                ? (newPrompt) => { onPatchDraft(id, { prompt: newPrompt }).catch((e) => {
                    console.warn('[expand] draft prompt PATCH failed:', e)
                  }) }
                : undefined
            }
            onSaveText={
              isDraft && kind === 'audio-generation' && onPatchDraft !== undefined && typeof id === 'string' && id !== ''
                ? (newText) => { onPatchDraft(id, { text: newText }).catch((e) => {
                    console.warn('[expand] draft text PATCH failed:', e)
                  }) }
                : undefined
            }
          />
        ) : (
          <div className="me-top-spacer" aria-hidden />
        )}

        {isDraft || isFailed ? null : (
        <div className="media-expand-main">
          {/* Notes carry Download in the panel action bar instead — see NoteExpanded. */}
          {!isNote && !isGenerating && typeof url === 'string' && url !== '' ? (
            <a
              className="media-expand-download"
              href={downloadHref(url)}
              download
              title="Download"
              aria-label="Download"
            >
              ⬇
            </a>
          ) : null}
          {isGenerating ? (
            <GeneratingPlaceholder
              kind={kind === 'video-generation' ? 'video' : kind === 'audio-generation' ? 'audio' : 'image'}
              aspectRatio={metadata?.aspect_ratio}
            />
          ) : isNote ? (
            <NoteExpanded
              subtype={subtype}
              label={noteLabel}
              body={noteBody}
              editable={onSaveNote !== undefined && typeof id === 'string' && id !== '' && !isArchived}
              editing={noteEditing}
              editBody={noteEditBody}
              editLabel={noteEditLabel}
              saving={noteSaving}
              saveError={noteSaveError}
              downloadHref={noteDownloadHref}
              downloadName={`${noteLabel || id || 'note'}.md`}
              onStartEdit={startEditingNote}
              onCancelEdit={cancelEditingNote}
              onChangeBody={setNoteEditBody}
              onChangeLabel={setNoteEditLabel}
              onSave={saveNoteEdits}
            />
          ) : kind === 'video' && typeof url === 'string' && url !== '' ? (
            // biome-ignore lint/a11y/useMediaCaption: provider videos lack captions.
            <video src={url} controls autoPlay playsInline preload="metadata" />
          ) : kind === 'image' && typeof url === 'string' && url !== '' ? (
            <img src={url} alt={label ?? ''} />
          ) : isAudio && typeof url === 'string' && url !== '' ? (
            <div className="media-expand-audio-stage">
              {typeof text === 'string' && text !== '' ? (
                <p className="media-expand-audio-text">{text}</p>
              ) : null}
              {/* biome-ignore lint/a11y/useMediaCaption: TTS audio doesn't carry captions. */}
              <audio src={url} controls autoPlay preload="metadata" />
            </div>
          ) : null}
          {!isNote && (label !== undefined || meta !== undefined) ? (
            <div className="media-expand-caption">
              {label !== undefined && label !== '' ? (
                <span className="media-expand-label">{label}</span>
              ) : null}
              {meta !== undefined && meta !== '' ? (
                <span className="media-expand-meta">{meta}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        )}

        {isArchived ? (
          <div className="media-expand-archived-bar">
            <span className="media-expand-archived-note">
              Archived — agent tools can't reference this until it's on canvas.
            </span>
            <button
              type="button"
              className="media-expand-archived-cta"
              onClick={onRestore}
            >
              Put on canvas
            </button>
          </div>
        ) : isDraft ? (
          <div className="media-expand-draft-bar">
            {fireError ? (
              <span className="media-expand-draft-error" title={fireError}>{fireError}</span>
            ) : (
              <span className="media-expand-draft-hint">
                Real call, real money — no cancel once it fires.
              </span>
            )}
            <div className="media-expand-draft-actions">
              <button
                type="button"
                className="media-expand-cancel-cta"
                onClick={onCancelFromOverlay}
                disabled={onDiscardDraft === undefined}
              >
                Cancel
              </button>
              <button
                type="button"
                className="media-expand-generate-cta"
                onClick={onFireFromOverlay}
                disabled={onFireDraft === undefined}
              >
                {`Generate${typeof cost === 'number' && Number.isFinite(cost) ? ` · $${cost.toFixed(2)}` : ''}`}
              </button>
            </div>
          </div>
        ) : isFailed ? (
          <div className="media-expand-failure-bar">
            <button
              type="button"
              className="media-expand-failure-dismiss"
              onClick={onDismissFailure}
              disabled={typeof failureJobId !== 'string' || failureJobId === ''}
              title="Dismiss this failed generation"
            >
              Dismiss
            </button>
            <button
              type="button"
              className="media-expand-failure-cta"
              onClick={onSendFailureToAgent}
              disabled={composer === null || typeof failureJobId !== 'string' || failureJobId === ''}
              title={composer === null ? 'Terminal not ready' : 'Send this failure to the agent'}
            >
              Send failure to agent
            </button>
          </div>
        ) : canChat ? (
          <MediaExpandChat nodeId={id!} projectId={projectId} />
        ) : (
          <div className="me-chat-spacer" aria-hidden />
        )}
      </div>
    </div>
  )
}

/* ── Top strip: compact prompt + refs, click-to-expand details panel ── */

interface TopStripProps {
  prompt: string | null
  /** Audio drafts: the spoken line, editable when onSaveText present.
   * null for image/video — the TEXT section just doesn't render. */
  text?: string | null
  refs: MediaRef[]
  refsByKind: Record<MediaRefKind, MediaRef[]>
  expanded: boolean
  onToggle: () => void
  nodeType?: 'image_result' | 'video_result' | 'audio_result'
  metadata?: MediaMetadata
  duration?: number | string
  cost?: number | null
  failure?: MediaPayload['failure']
  /** Draft-only: when present, the PROMPT section in the expanded panel
   * renders an editable textarea instead of the rich PromptText. onBlur
   * fires PATCH /pending/:jobId via the parent. */
  onSavePrompt?: (prompt: string) => void
  /** Audio draft-only: same shape but for the spoken `text` field. */
  onSaveText?: (text: string) => void
  /** Skip the collapsed click-bar and render the panel statically.
   * Used by the draft overlay where the panel IS the main content. */
  forceExpanded?: boolean
}

function formatCost(c: number | null | undefined): string | null {
  if (c === null || c === undefined || !Number.isFinite(c)) return null
  if (c < 0.01) return `~$${c.toFixed(3)}`
  return `~$${c.toFixed(2)}`
}

function TopStrip({ prompt, text, refs, refsByKind, expanded, onToggle, nodeType, metadata, duration, cost, failure, onSavePrompt, onSaveText, forceExpanded = false }: TopStripProps): JSX.Element {
  const modelChip =
    nodeType === 'video_result' ? 'video'
    : nodeType === 'audio_result' ? 'voice'
    : 'image'
  const resChip = nodeType === 'video_result' ? metadata?.resolution : metadata?.image_size
  const provider = metadata?.source
  const costChip = formatCost(cost)
  const detailsSummary = [modelChip, resChip, provider, costChip]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' · ')
  const showPanel = forceExpanded || expanded
  return (
    <div className={
      'me-top' +
      (showPanel ? ' me-top-open' : '') +
      (forceExpanded ? ' me-top-static' : '')
    }>
      {forceExpanded ? null : (
      <button
        type="button"
        className="me-top-bar"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? 'Hide details' : 'Show details'}
      >
        <span className="me-top-label">PROMPT</span>
        <span className="me-top-prompt">
          {prompt !== null ? prompt : <em className="me-top-empty">No prompt</em>}
        </span>
        {refs.length > 0 ? (
          <span className="me-top-refs" aria-label={`${refs.length} reference${refs.length === 1 ? '' : 's'}`}>
            {refs.slice(0, 6).map((r, i) => (
              <span className={'me-top-ref me-top-ref-' + r.kind} key={i}>
                {r.kind === 'image' ? (
                  <img src={r.url} alt="" />
                ) : r.kind === 'video' ? (
                  // biome-ignore lint/a11y/useMediaCaption: thumbnail
                  <video src={r.url} muted playsInline preload="metadata" />
                ) : (
                  <span className="me-top-ref-glyph">🔊</span>
                )}
              </span>
            ))}
            {refs.length > 6 ? <span className="me-top-ref-more">+{refs.length - 6}</span> : null}
          </span>
        ) : null}
        {detailsSummary !== '' ? (
          <>
            <span className="me-top-label me-top-label-details">DETAILS</span>
            <span className="me-top-details-summary">{detailsSummary}</span>
          </>
        ) : null}
        <span className={'me-top-caret' + (expanded ? ' me-top-caret-open' : '')} aria-hidden>
          ▾
        </span>
      </button>
      )}
      <div className="me-top-panel" aria-hidden={!showPanel}>
        <div className="me-top-panel-inner">
          {/* Voice drafts: TEXT (spoken line — the deliverable) above
              PROMPT (voice design brief). For image/video, text is null
              and the section just doesn't render. */}
          {text !== null && text !== undefined ? (
            <section className="me-section me-prompt-section">
              <header className="me-section-title">TEXT</header>
              <div className="me-prompt">
                {onSaveText !== undefined ? (
                  <textarea
                    className="me-prompt-textarea"
                    defaultValue={text}
                    placeholder="What should the voice say…"
                    onBlur={(e) => {
                      const v = e.currentTarget.value
                      if (v !== text) onSaveText(v)
                    }}
                  />
                ) : (
                  <div>{text}</div>
                )}
              </div>
            </section>
          ) : null}
          {prompt !== null ? (
            <section className="me-section me-prompt-section">
              <header className="me-section-title">PROMPT</header>
              <div className="me-prompt">
                {onSavePrompt !== undefined ? (
                  <textarea
                    className="me-prompt-textarea"
                    defaultValue={prompt}
                    placeholder="Describe what to generate…"
                    onBlur={(e) => {
                      const v = e.currentTarget.value
                      if (v !== prompt) onSavePrompt(v)
                    }}
                  />
                ) : (
                  <PromptText prompt={prompt} refsByKind={refsByKind} />
                )}
              </div>
            </section>
          ) : null}
          {refs.length > 0 ? (
            <section className="me-section me-refs-section">
              <header className="me-section-title">
                <span>REFERENCES</span>
                <span className="me-section-count">{refs.length}</span>
              </header>
              <RefGrid refsByKind={refsByKind} />
            </section>
          ) : null}
          {failure !== undefined ? (
            <section className="me-section me-failure-section">
              <header className="me-section-title">FAILURE</header>
              <div className="me-failure-box">
                {failure.klass ? (
                  <div className="me-failure-class">{failure.klass}</div>
                ) : null}
                {failure.message ? (
                  <div className="me-failure-message">{failure.message}</div>
                ) : (
                  <div className="me-failure-message">Generation failed.</div>
                )}
                {failure.jobId ? (
                  <code className="me-failure-command">
                    node "$PAI_REPO_ROOT/server/cli/list_generation_results.js" --job-id {failure.jobId}
                  </code>
                ) : null}
              </div>
            </section>
          ) : null}
          {metadata !== undefined ? (
            <section className="me-section me-meta-section">
              <header className="me-section-title">DETAILS</header>
              <MetaTable nodeType={nodeType} metadata={metadata} duration={duration} cost={cost} />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ── Prompt text with inline reference chips ───────────────────── */

interface PromptTextProps {
  prompt: string
  refsByKind: Record<MediaRefKind, MediaRef[]>
}

function PromptText({ prompt, refsByKind }: PromptTextProps): JSX.Element {
  const re = /@(Image|Video|Audio)(\d+)/g
  const parts: (
    | { kind: 'text'; value: string }
    | { kind: 'chip'; refKind: MediaRefKind; label: string; url?: string }
  )[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', value: prompt.slice(last, m.index) })
    const refKind = m[1].toLowerCase() as MediaRefKind
    const num = Number(m[2])
    const ref = refsByKind[refKind]?.[num - 1]
    parts.push({ kind: 'chip', refKind, label: m[0], url: ref?.url })
    last = re.lastIndex
  }
  if (last < prompt.length) parts.push({ kind: 'text', value: prompt.slice(last) })
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'chip' ? (
          <RefChip key={i} kind={p.refKind} url={p.url} label={p.label} />
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  )
}

interface RefChipProps {
  kind: MediaRefKind
  url?: string
  label: string
}

function RefChip({ kind, url, label }: RefChipProps): JSX.Element {
  const className =
    'me-ref-chip me-ref-chip-' + kind + (url === undefined || url === '' ? ' me-ref-chip-missing' : '')
  const inner = (
    <>
      <span className="me-ref-chip-thumb">
        {url !== undefined && url !== '' && kind === 'image' ? (
          <img src={url} alt={label} />
        ) : null}
        {url !== undefined && url !== '' && kind === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: thumbnail
          <video src={url} muted playsInline preload="metadata" />
        ) : null}
        {url === undefined || url === '' || kind === 'audio' ? (
          <span className="me-ref-chip-glyph">{kind === 'audio' ? '🔊' : '?'}</span>
        ) : null}
      </span>
      <span className="me-ref-chip-tag">{label}</span>
    </>
  )
  if (url === undefined || url === '') {
    return (
      <span className={className} title={`${label} (reference not found)`}>
        {inner}
      </span>
    )
  }
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${label} — open in new tab`}
    >
      {inner}
    </a>
  )
}

/* ── Reference grid inside the expanded top panel ──────────────── */

interface RefGridProps {
  refsByKind: Record<MediaRefKind, MediaRef[]>
}

function RefGrid({ refsByKind }: RefGridProps): JSX.Element {
  return (
    <div className="me-ref-grid">
      {refsByKind.image.map((r, i) => (
        <RefThumb key={'i' + i} kind="image" url={r.url} index={i + 1} />
      ))}
      {refsByKind.video.map((r, i) => (
        <RefThumb key={'v' + i} kind="video" url={r.url} index={i + 1} />
      ))}
      {refsByKind.audio.map((r, i) => (
        <RefThumb key={'a' + i} kind="audio" url={r.url} index={i + 1} />
      ))}
    </div>
  )
}

interface RefThumbProps {
  kind: MediaRefKind
  url: string
  index: number
}

function RefThumb({ kind, url, index }: RefThumbProps): JSX.Element {
  const tag =
    kind === 'image' ? `@Image${index}` : kind === 'video' ? `@Video${index}` : `@Audio${index}`
  return (
    <a
      className={'me-ref-thumb me-ref-thumb-' + kind}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${tag} — open in new tab`}
    >
      <div className="me-ref-thumb-media">
        {kind === 'image' ? (
          <img src={url} alt={tag} />
        ) : kind === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: thumbnail
          <video src={url} muted playsInline preload="metadata" />
        ) : (
          <div className="me-ref-thumb-audio-glyph">🔊</div>
        )}
      </div>
      <div className="me-ref-thumb-tag">{tag}</div>
    </a>
  )
}

/* ── Metadata table rendered inside the top strip's DETAILS section. ── */

interface MetaTableProps {
  nodeType?: 'image_result' | 'video_result' | 'audio_result'
  metadata: MediaMetadata
  duration?: number | string
  cost?: number | null
}

function MetaTable({ nodeType, metadata, duration, cost }: MetaTableProps): JSX.Element | null {
  const rows: [string, string][] = []
  const modelId = metadata.model
  // Expand shows the raw wire-side model ID — labels live on the card.
  if (typeof modelId === 'string' && modelId !== '') {
    rows.push(['model', modelId])
  }
  if (typeof metadata.source === 'string' && metadata.source !== '') {
    rows.push(['provider', metadata.source])
  }
  // Row layout: provenance (model/provider/generated) then specs (aspect/size/...) then cost.
  const generated = formatRelativeTime(metadata.generated_at)
  if (generated !== null) rows.push(['generated', generated])
  if (typeof metadata.aspect_ratio === 'string' && metadata.aspect_ratio !== '') {
    rows.push(['aspect', metadata.aspect_ratio])
  }
  if (nodeType === 'image_result' && typeof metadata.image_size === 'string' && metadata.image_size !== '') {
    rows.push(['size', metadata.image_size])
  }
  if (nodeType === 'video_result') {
    if (typeof metadata.resolution === 'string' && metadata.resolution !== '') {
      rows.push(['resolution', metadata.resolution])
    }
    if (duration !== undefined && duration !== '' && duration !== null) {
      rows.push(['duration', `${duration}s`])
    }
    if (typeof metadata.generate_audio === 'boolean') {
      rows.push(['audio', metadata.generate_audio ? 'on' : 'off'])
    }
  }
  const costStr = formatCost(cost)
  if (costStr !== null) rows.push(['est. cost', costStr])

  if (rows.length === 0) return null
  return (
    <dl className="media-expand-metatable">
      {rows.map(([k, v]) => (
        <div className="media-expand-metarow" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

// Relative for ≤7 days, absolute date after. Mirrors the convention
// most CMS / activity feeds use; no library dependency.
function formatRelativeTime(iso: string | undefined): string | null {
  if (iso === undefined || iso === '') return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`
  if (sec < 7 * 86400) return `${Math.round(sec / 86400)} d ago`
  return new Date(t).toLocaleDateString()
}

/* ── Placeholder for pending image-generation / video-generation ── */

function GeneratingPlaceholder({
  kind,
  aspectRatio,
}: {
  kind: 'image' | 'video' | 'audio'
  aspectRatio?: string
}): JSX.Element {
  const m =
    typeof aspectRatio === 'string'
      ? aspectRatio.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/)
      : null
  // Voice has no spatial extent — give it a stable 16:9 banner so the
  // shimmer reads as a placeholder, not a misaligned square.
  const ratio = m !== null ? `${m[1]} / ${m[2]}` : '16 / 9'
  const label = kind === 'audio' ? 'voice' : kind
  return (
    <div className="media-expand-generating" style={{ aspectRatio: ratio }}>
      <div className="media-expand-generating-shimmer" aria-hidden />
      <div className="media-expand-generating-caption">Generating {label}…</div>
    </div>
  )
}

interface NoteExpandedProps {
  subtype: NoteSubtype | undefined
  label: string
  body: string
  editable: boolean
  editing: boolean
  editBody: string
  editLabel: string
  saving: boolean
  saveError: string | null
  downloadHref: string | null
  downloadName: string
  onStartEdit: () => void
  onCancelEdit: () => void
  onChangeBody: (v: string) => void
  onChangeLabel: (v: string) => void
  onSave: () => void
}

function NoteExpanded({
  subtype,
  label,
  body,
  editable,
  editing,
  editBody,
  editLabel,
  saving,
  saveError,
  downloadHref,
  downloadName,
  onStartEdit,
  onCancelEdit,
  onChangeBody,
  onChangeLabel,
  onSave,
}: NoteExpandedProps): JSX.Element {
  const subtypeChip: string = subtype ?? 'note'
  return (
    <div className="note-expand" data-subtype={subtype ?? 'note'}>
      <div className="note-expand-head">
        <span className="note-expand-kind">{subtypeChip}</span>
        {editing ? (
          <input
            className="note-expand-label-input"
            value={editLabel}
            onChange={(e) => onChangeLabel(e.target.value)}
            placeholder="title"
            maxLength={30}
            disabled={saving}
          />
        ) : (
          <span className="note-expand-label">{label}</span>
        )}
        <span className="note-expand-actions">
          {downloadHref !== null && !editing ? (
            <a
              className="note-expand-btn"
              href={downloadHref}
              download={downloadName}
              title="Download as Markdown"
            >
              Download
            </a>
          ) : null}
          {editable && !editing ? (
            <button
              type="button"
              className="note-expand-btn"
              onClick={onStartEdit}
              title="Edit (in overlay)"
            >
              Edit
            </button>
          ) : null}
          {editable && editing ? (
            <>
              <button
                type="button"
                className="note-expand-btn note-expand-btn-secondary"
                onClick={onCancelEdit}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="note-expand-btn note-expand-btn-primary"
                onClick={onSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            </>
          ) : null}
        </span>
      </div>
      {saveError !== null ? (
        <div className="note-expand-error" role="alert">
          {saveError}
        </div>
      ) : null}
      <div className="note-expand-body">
        {editing ? (
          <textarea
            className="note-expand-textarea"
            value={editBody}
            onChange={(e) => onChangeBody(e.target.value)}
            disabled={saving}
            spellCheck={false}
            placeholder="# Markdown body"
          />
        ) : (
          <div className="note-markdown-expanded">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
