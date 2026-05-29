import type { AgentContinuation } from '@/types/canvas'

interface ContinuationPanelProps {
  continuations: AgentContinuation[]
}

function statusLabel(status: AgentContinuation['status']): string {
  if (status === 'running') return 'Running'
  if (status === 'failed') return 'Failed'
  if (status === 'applied') return 'Applied'
  return 'Pending'
}

function timeLabel(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ContinuationPanel({ continuations }: ContinuationPanelProps): JSX.Element | null {
  if (continuations.length === 0) return null
  const visible = continuations.slice(0, 4)
  return (
    <aside className="continuation-panel" aria-label="Agent follow-up">
      <div className="continuation-panel-head">
        <span>Agent follow-up</span>
        <span>{continuations.length}</span>
      </div>
      <div className="continuation-list">
        {visible.map((item) => {
          const staged = item.applied?.staged_job_ids ?? []
          const error = item.error?.message
          return (
            <article className="continuation-item" data-status={item.status} key={item.id}>
              <div className="continuation-item-top">
                <span className="continuation-status">{statusLabel(item.status)}</span>
                <span className="continuation-time">{timeLabel(item.updated_at)}</span>
              </div>
              <p className="continuation-summary">
                {error && item.status === 'failed' ? error : item.summary}
              </p>
              {item.job_ids.length > 0 ? (
                <div className="continuation-jobs">
                  {item.job_ids.slice(0, 3).map((jobId) => (
                    <code key={jobId}>{jobId}</code>
                  ))}
                  {item.job_ids.length > 3 ? <span>+{item.job_ids.length - 3}</span> : null}
                </div>
              ) : null}
              {staged.length > 0 ? (
                <div className="continuation-staged">
                  <span>Staged</span>
                  {staged.slice(0, 3).map((jobId) => (
                    <code key={jobId}>{jobId}</code>
                  ))}
                </div>
              ) : null}
            </article>
          )
        })}
      </div>
    </aside>
  )
}
