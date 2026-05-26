import { useMemo, useState } from 'react'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import type { GenerationResult } from '@/types/canvas'

interface GenerationResultsPanelProps {
  results: GenerationResult[]
}

const MAX_VISIBLE = 5

export function GenerationResultsPanel({
  results,
}: GenerationResultsPanelProps): JSX.Element | null {
  const composer = useChatComposer()
  const [sentIds, setSentIds] = useState<ReadonlySet<string>>(() => new Set())
  const visible = useMemo(() => results.slice(0, MAX_VISIBLE), [results])

  if (visible.length === 0) return null

  const sendToAgent = (result: GenerationResult): void => {
    if (composer === null) return
    composer.insertAtCursor(buildAgentPrompt(result) + '\r')
    setSentIds((prev) => {
      const next = new Set(prev)
      next.add(result.job_id)
      return next
    })
  }

  return (
    <aside className="generation-results-panel" aria-label="Recent generation results">
      <div className="generation-results-head">
        <span>Recent generations</span>
        <span>{visible.length}</span>
      </div>
      <div className="generation-results-list">
        {visible.map((result) => {
          const canSend = result.status !== 'succeeded'
          const sent = sentIds.has(result.job_id)
          const message = result.message ?? result.node_id ?? result.output_url ?? ''
          return (
            <article
              key={result.job_id}
              className={`generation-result-card generation-result-${result.status}`}
            >
              <div className="generation-result-main">
                <div className="generation-result-row">
                  <span className="generation-result-kind">{kindLabel(result.kind)}</span>
                  <span className="generation-result-status">{statusLabel(result)}</span>
                  <span className="generation-result-time">{formatTime(result.completed_at)}</span>
                </div>
                <div className="generation-result-message" title={message}>
                  {message || shortJobId(result.job_id)}
                </div>
              </div>
              {canSend ? (
                <button
                  type="button"
                  className="generation-result-send"
                  onClick={(e) => {
                    e.stopPropagation()
                    sendToAgent(result)
                  }}
                  disabled={composer === null || sent}
                  title={composer === null ? 'Terminal not ready' : 'Send this failure to the agent'}
                >
                  {sent ? 'Sent' : 'Send to agent'}
                </button>
              ) : null}
            </article>
          )
        })}
      </div>
    </aside>
  )
}

function kindLabel(kind: GenerationResult['kind']): string {
  if (kind === 'audio') return 'voice'
  return kind
}

function statusLabel(result: GenerationResult): string {
  if (result.status === 'succeeded' && result.node_id) return `succeeded -> ${result.node_id}`
  if (result.klass) return `${result.status} - ${result.klass}`
  return result.status
}

function shortJobId(jobId: string): string {
  if (jobId.length <= 18) return jobId
  return `${jobId.slice(0, 10)}...${jobId.slice(-6)}`
}

function formatTime(value: string | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function buildAgentPrompt(result: GenerationResult): string {
  const statusLine =
    result.status === 'timeout' ? 'A browser-fired generation timed out.'
    : result.status === 'aborted' ? 'A browser-fired generation was aborted.'
    : 'A browser-fired generation failed.'
  const lines = [
    statusLine,
    '',
    `Job: ${result.job_id}`,
    `Kind: ${result.kind}`,
    `Status: ${result.status}`,
  ]
  if (result.klass) lines.push(`Class: ${result.klass}`)
  if (result.message) lines.push(`Message: ${result.message}`)
  const sentSummary = summarizeSent(result.sent)
  if (sentSummary) lines.push(`Request summary: ${sentSummary}`)
  lines.push(
    '',
    'Please inspect this result with:',
    `node "$PAI_REPO_ROOT/server/cli/list_generation_results.js" --job-id ${result.job_id}`,
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
