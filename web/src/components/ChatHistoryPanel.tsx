/**
 * ChatHistoryPanel — read-only view of the project's past Claude
 * conversation. Reads `~/.claude/projects/<encoded-cwd>/<latest>.jsonl`
 * via the viewer's GET /projects/:id/chat-history endpoint and renders
 * the user/assistant messages in a scrollable column.
 *
 * The terminal still runs `claude --continue` so the underlying session
 * is the live one. This panel just makes the prior turns visible.
 */
import { useEffect, useState } from 'react'
import { VIEWER_URL } from '@/lib/socket'

interface ToolUse {
  name: string
  input?: unknown
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUse[]
  timestamp: string | null
  uuid: string | null
}

interface ChatHistoryResponse {
  session_id: string | null
  mtime: number | null
  messages: ChatMessage[]
}

interface ChatHistoryPanelProps {
  projectId: string | null
  /** When true, the panel is in view; when false, skip refetching. */
  active: boolean
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export function ChatHistoryPanel({
  projectId,
  active,
}: ChatHistoryPanelProps): JSX.Element {
  const [data, setData] = useState<ChatHistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!active || projectId === null) return undefined
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(
      `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/chat-history`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`viewer ${res.status}`)
        return res.json() as Promise<ChatHistoryResponse>
      })
      .then((j) => {
        if (!cancelled) setData(j)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, active])

  if (!active) return <div className="hidden" />

  if (loading && data === null) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-neutral-500">
        Loading chat history…
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-red-400">
        Couldn't load chat history: {error}
      </div>
    )
  }

  const messages = data?.messages ?? []

  if (messages.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-neutral-500">
        No prior chat history yet — your next turn in the terminal will start
        the conversation.
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="scrollbar-subtle flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.map((m, i) => (
            <MessageRow key={m.uuid ?? `${i}-${m.timestamp ?? ''}`} message={m} />
          ))}
        </div>
      </div>
      {data?.session_id !== null && data?.session_id !== undefined ? (
        <div className="border-t border-neutral-800 bg-[#0a0a0a] px-4 py-2 text-[11px] text-neutral-500">
          session{' '}
          <code className="text-neutral-400">
            {data.session_id.slice(0, 8)}
          </code>{' '}
          · {messages.length} turn{messages.length === 1 ? '' : 's'}
        </div>
      ) : null}
    </div>
  )
}

function MessageRow({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === 'user'
  const time = formatTime(message.timestamp)
  return (
    <div className={isUser ? 'text-neutral-100' : 'text-neutral-300'}>
      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-neutral-500">
        <span>{isUser ? 'you' : 'claude'}</span>
        {time !== '' ? <span className="text-neutral-600">· {time}</span> : null}
      </div>
      {message.text !== '' ? (
        <div
          className={
            'whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm leading-relaxed ' +
            (isUser
              ? 'bg-neutral-900 text-neutral-100'
              : 'bg-neutral-950 text-neutral-300')
          }
        >
          {message.text}
        </div>
      ) : null}
      {message.toolUses.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {message.toolUses.map((t, i) => (
            <span
              key={i}
              className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400"
            >
              {t.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
