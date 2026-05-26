/**
 * PendingGenerationNode — chrome for optimistic placeholders during
 * in-flight generation. Driven by the `pending-generations` Socket.IO
 * channel, not workflow.json — these nodes never persist, they're
 * synthesized client-side from `.pending/<jobId>.json` sidecars and
 * vanish when the real image_result / video_result / audio_result lands.
 *
 * Audio drafts/running share the same chrome as image — taller body
 * with the spoken text (the deliverable) editable on draft. The voice
 * design prompt is metadata-only and surfaces in the overlay.
 */
import { useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import { useFireConfirm } from '../FireConfirmProvider'
import { parseAspectRatio, sizeForAspect, type NodeState } from '../nodeData'
import { useNodeActions } from '../NodeActionsContext'
import { NodeHead } from './_shared'

interface PendingGenerationData {
  kind?: 'image' | 'video' | 'audio'
  stage?: 'running' | 'failed' | 'draft'
  prompt?: string
  aspect_ratio?: string
  references?: { kind: 'image' | 'video' | 'audio'; url: string }[]
  model?: string
  image_size?: string
  resolution?: string
  duration?: number
  /** Draft-only: snapshot price for the card chip. */
  cost_usd?: number
  /** Audio drafts: the spoken line for voice generations. */
  text?: string
  klass?: string
  message?: string
  sent?: unknown
}

// Cards narrower than this get the portrait/narrow-only layout fixes
// (shorter state label, shorter bottom hint pill copy). Catches 9:16
// (162px) and 3:4 (187px); 1:1 (216px) and 16:9 (288px) stay on the
// canonical landscape layout.
const PENDING_NARROW_THRESHOLD_PX = 200

export function PendingGenerationNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as PendingGenerationData
  const kind = d.kind ?? 'image'
  const stage = d.stage ?? 'running'
  const rawAr = d.aspect_ratio
  const prompt = d.prompt ?? ''
  const text = d.text ?? ''
  const isAudio = kind === 'audio'
  const failureMessage = d.message ?? d.klass ?? 'Generation failed'
  // For voice, the body content is the spoken text (the deliverable);
  // the voice design `prompt` is metadata shown only in the overlay.
  // For image/video, it's the prompt verbatim.
  const bodyText = stage === 'failed' ? failureMessage : isAudio ? text : prompt
  const dataState: NodeState =
    stage === 'failed' ? 'failed'
    : stage === 'draft' ? 'pending'
    : 'running'
  // Placeholder ids are job UUIDs, not addressable — use the kind word
  // instead of an `@id` until the mutator mints the real id.
  const kindLabel = kind === 'video' ? 'video' : kind === 'audio' ? 'voice' : 'image'
  const parsed = parseAspectRatio(rawAr) ?? { w: 16, h: 9 }
  const bodyAspect = `${parsed.w} / ${parsed.h}`
  const size = sizeForAspect(rawAr)
  const isNarrow = size.w < PENDING_NARROW_THRESHOLD_PX
  // Narrow cards swap the verbose "generating image…" / "generating
  // video…" label for the short canonical "running" so the head row
  // never wraps at 162-187px widths.
  const stageLabel: string =
    stage === 'failed' ? 'failed'
    : stage === 'draft' ? 'draft'
    : isNarrow ? 'running'
    : kind === 'video' ? 'generating video…'
    : kind === 'audio' ? 'designing voice…'
    : 'generating image…'
  const resolutionChip = kind === 'video' ? d.resolution : kind === 'image' ? d.image_size : undefined
  const footMeta = [
    kindLabel,
    resolutionChip,
    kind === 'video' && d.duration !== undefined && d.duration !== null
      ? `${d.duration}s`
      : null,
  ]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' · ')

  const { onExpandMedia, onPatchDraft, onFireDraft, onDiscardDraft } = useNodeActions()
  const composer = useChatComposer()
  const canExpand = onExpandMedia !== undefined
  const isDraft = stage === 'draft'
  const isFailed = stage === 'failed'

  // Textarea is uncontrolled (defaultValue + onBlur PATCH); a controlled
  // input would re-mount on every keystroke as the socket fans the new
  // sidecar back. `firing` stays true between click and the running flip.
  const [firing, setFiring] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [failureSent, setFailureSent] = useState(false)
  // First-fire gate: routes the very first Generate click in this
  // browser through a centered confirmation modal owned by
  // FireConfirmProvider. Subsequent clicks run `onConfirm` immediately.
  const { requestFire } = useFireConfirm()

  const handleBodyBlur = (e: React.FocusEvent<HTMLTextAreaElement>): void => {
    if (!onPatchDraft) return
    const value = e.currentTarget.value
    if (value === bodyText) return
    const patch = isAudio ? { text: value } : { prompt: value }
    onPatchDraft(id, patch).catch((err) => {
      setDraftError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleFire = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!onFireDraft || firing) return
    requestFire({
      cost: d.cost_usd,
      onConfirm: () => {
        setFiring(true)
        setDraftError(null)
        onFireDraft(id).catch((err) => {
          setFiring(false)
          setDraftError(err instanceof Error ? err.message : String(err))
        })
      },
    })
  }

  const handleCancel = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!onDiscardDraft || firing) return
    onDiscardDraft(id).catch((err) => {
      setDraftError(err instanceof Error ? err.message : String(err))
    })
  }
  const handleSendFailure = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (composer === null || failureSent) return
    composer.insertAtCursor(buildFailureAgentPrompt(id, kind, d) + '\r')
    setFailureSent(true)
  }
  const handleExpand = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!canExpand) return
    // Synthesize a metadata object so the overlay's DETAILS section can
    // render mid-flight. `source` matches what the matching generate_*.js
    // persists on completion so the chip doesn't change shape when the
    // final node lands.
    const overlaySource = 'pai'
    const metadata = {
      model: d.model,
      source: overlaySource,
      aspect_ratio: rawAr,
      ...(kind === 'video' ? { resolution: d.resolution }
        : kind === 'image' ? { image_size: d.image_size }
        : {}),
    }
    const overlayKind: 'image-generation' | 'video-generation' | 'audio-generation' =
      kind === 'video' ? 'video-generation'
      : kind === 'audio' ? 'audio-generation'
      : 'image-generation'
    const overlayNodeType: 'image_result' | 'video_result' | 'audio_result' =
      kind === 'video' ? 'video_result'
      : kind === 'audio' ? 'audio_result'
      : 'image_result'
    const labelSource = isAudio ? text : prompt
    onExpandMedia({
      id,
      kind: overlayKind,
      label: labelSource.length > 80 ? labelSource.slice(0, 79) + '…' : labelSource,
      prompt,
      text,
      references: d.references ?? [],
      nodeType: overlayNodeType,
      metadata,
      duration: kind === 'video' ? d.duration : undefined,
      stage,
    })
  }
  const target = Position.Left, source = Position.Right

  return (
    <div
      className={`node image_result pending${selected ? ' selected' : ''}${stage === 'failed' ? ' failed' : ''}`}
      data-kind={kind}
      data-stage={stage}
      data-state={dataState}
      data-narrow={isNarrow ? 'true' : undefined}
      title={bodyText}
      style={{ width: size.w }}
    >
      <Handle type="target" position={target} />
      {/* Drafts surface kind + resolution in the head (no foot meta);
          narrow cards (9:16, 3:4) keep just the kind so the head
          doesn't collide with the state chip on the right. */}
      <NodeHead
        label={isDraft && !isNarrow
          ? [kindLabel, resolutionChip,
              kind === 'video' && d.duration !== undefined && d.duration !== null
                ? `${d.duration}s` : null]
            .filter((v): v is string => typeof v === 'string' && v !== '')
            .join(' · ')
          : kindLabel}
        state={dataState}
        stateLabel={stageLabel}
      />
      <div
        className="node-body"
        style={{
          position: 'relative',
          aspectRatio: bodyAspect,
          overflow: 'hidden',
          background: 'var(--bg-1, #1a1a1f)',
        }}
      >
        {stage === 'running' ? <div className="pending-shimmer" aria-hidden /> : null}
        {isDraft ? (
          <textarea
            className="draft-prompt scrollbar-subtle nodrag nowheel"
            defaultValue={bodyText}
            onBlur={handleBodyBlur}
            placeholder={isAudio ? 'What should the voice say…' : 'Describe what to generate…'}
            disabled={firing}
          />
        ) : bodyText !== '' ? (
          <div className="pending-gen-prompt">{bodyText}</div>
        ) : (
          <div className="pending-glyph">
            <span style={{ fontSize: 28, opacity: 0.5 }}>{kind === 'video' ? '🎬' : kind === 'audio' ? '🎙' : '🖼'}</span>
          </div>
        )}
        {canExpand ? (
          <button
            type="button"
            className="pending-gen-hint"
            title="More details"
            onClick={handleExpand}
          >
            <span>⤢</span>
            <span>more details</span>
          </button>
        ) : null}
        {draftError ? (
          <div className="draft-error nodrag" title={draftError}>{draftError}</div>
        ) : null}
      </div>
      <div className="node-foot nodrag">
        {isDraft ? (
          <>
            <button
              type="button"
              className="btn-cancel"
              onClick={handleCancel}
              disabled={firing || onDiscardDraft === undefined}
              title="Discard this draft"
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-generate-primary"
              onClick={handleFire}
              disabled={firing || onFireDraft === undefined}
            >
              {firing
                ? 'Firing…'
                : `Generate${d.cost_usd !== undefined ? ` · $${d.cost_usd.toFixed(2)}` : ''}`}
            </button>
          </>
        ) : isFailed ? (
          <button
            type="button"
            className="btn-generate-primary pending-send-agent"
            onClick={handleSendFailure}
            disabled={composer === null || failureSent}
            title={composer === null ? 'Terminal not ready' : 'Send this failure to the agent'}
          >
            {failureSent ? 'Sent' : 'Send failure to agent'}
          </button>
        ) : (
          <span>{footMeta}</span>
        )}
      </div>
      <Handle type="source" position={source} />
    </div>
  )
}

function buildFailureAgentPrompt(
  jobId: string,
  kind: 'image' | 'video' | 'audio',
  data: PendingGenerationData,
): string {
  const lines = [
    'A browser-fired generation failed.',
    '',
    `Job: ${jobId}`,
    `Kind: ${kind}`,
    'Status: failed',
  ]
  if (data.klass) lines.push(`Class: ${data.klass}`)
  if (data.message) lines.push(`Message: ${data.message}`)
  const sentSummary = summarizeSent(data.sent)
  if (sentSummary) lines.push(`Request summary: ${sentSummary}`)
  lines.push(
    '',
    'Please inspect this result with:',
    `node "$PAI_REPO_ROOT/server/cli/list_generation_results.js" --job-id ${jobId}`,
    '',
    'Then explain the cause and stage a corrected generation if appropriate.',
  )
  return lines.join('\n')
}

function summarizeSent(sent: unknown): string | null {
  if (!sent || typeof sent !== 'object') return null
  const rec = sent as Record<string, unknown>
  const parts: string[] = []
  const refIds = rec.ref_source_ids
  if (Array.isArray(refIds) && refIds.length > 0) {
    parts.push(`ref_source_ids=${refIds.filter((v) => typeof v === 'string').join(',')}`)
  }
  for (const key of ['aspect_ratio', 'image_size', 'resolution', 'duration']) {
    const value = rec[key]
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(`${key}=${String(value)}`)
    }
  }
  return parts.length > 0 ? parts.join('; ') : null
}
