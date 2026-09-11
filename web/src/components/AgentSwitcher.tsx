/**
 * AgentSwitcher — the control in the terminal panel's header that changes
 * which coding agent owns this project.
 *
 * It renders a trigger plus two absolutely-positioned layers. The trigger
 * belongs in the header's left track; the menu and the confirm anchor to the
 * PANEL, not the header, so the dialog can cover the terminal and the menu can
 * hang below a 48px bar. That means the panel — not the header — is the
 * positioned ancestor. See CanvasView's right-hand column.
 *
 * The header already named the agent before this existed: a static pill
 * reading AGENT with the provider beside it, centred. Putting a second strip
 * underneath to change it printed the same word twice, so the label became
 * this control and moved left. The word "Agent" is gone from the trigger on
 * purpose — the menu says it at the top, and what actually varies is the
 * provider.
 *
 * Switching is not cosmetic. PATCH /projects/:id { agent_id } rewrites the
 * project's meta, lays down the incoming agent's scaffolding, and kills the
 * running pty; the server then broadcasts `title` with the new agent_id, which
 * moves the key CanvasView puts on TerminalPanel and remounts it clean against
 * the respawned agent.
 *
 * Two consequences shape this component:
 *
 *   1. The running agent is stopped, so anything it was mid-way through is
 *      gone. Work already on the canvas survives — the conversation does not.
 *      Hence the confirm, and hence the confirm ONLY when something is
 *      actually running: on an idle panel there is nothing to lose and a
 *      dialog is pure friction.
 *
 *   2. A provider whose CLI is not on this machine cannot be switched to. It
 *      is listed and disabled rather than hidden, because a missing row turns
 *      "why can't I pick that one" into a question with no answer on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { VIEWER_URL } from '@/lib/socket'
import './AgentSwitcher.css'

export interface AgentOption {
  id: string
  label: string
  installed: boolean
  is_default: boolean
}

function Bolt(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M11 2.5L4.5 11h4l-1 6.5L15 9h-4l1-6.5z" fill="currentColor" />
    </svg>
  )
}

function Check(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4.5 10.5l3.5 3.5 7.5-8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The roster is fetched once per mount rather than pushed, because it only
 * changes when someone installs a CLI — and the probe is a PATH lookup per
 * provider, which is not worth a socket channel.
 */
function useAgentRoster(): AgentOption[] {
  const [agents, setAgents] = useState<AgentOption[]>([])
  useEffect(() => {
    let cancelled = false
    fetch(`${VIEWER_URL}/agents`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.agents) return
        setAgents(data.agents as AgentOption[])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  return agents
}

interface AgentSwitcherProps {
  projectId: string | null
  /** The project's owning agent, from the bundle. Null until it loads. */
  agentId: string | null
  /**
   * True while an Auto run is armed or in flight. Switching kills the pty, so
   * this is what decides whether the confirm is worth a click: mid-run there is
   * a plan to lose, and on an idle panel the dialog is pure friction.
   *
   * It is the best signal the client has. The pty being alive is not visible
   * from here, and an Auto run is the case where losing the conversation
   * actually costs the user something they approved a budget for.
   */
  autoActive?: boolean
}

export function AgentSwitcher({ projectId, agentId, autoActive = false }: AgentSwitcherProps): JSX.Element {
  const agents = useAgentRoster()
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [pending, setPending] = useState<AgentOption | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const goRef = useRef<HTMLButtonElement | null>(null)

  const current = agents.find((a) => a.id === agentId) ?? null
  const label = current?.label ?? (agentId ? agentId : 'Agent')

  const openMenu = useCallback(() => {
    setError(null)
    setCursor(Math.max(0, agents.findIndex((a) => a.id === agentId)))
    setOpen(true)
  }, [agents, agentId])

  const close = useCallback(() => {
    setOpen(false)
    btnRef.current?.focus()
  }, [])

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (pending) goRef.current?.focus()
  }, [pending])

  const commit = useCallback(
    async (next: AgentOption) => {
      if (!projectId) return
      setPending(null)
      setSending(true)
      setError(null)
      try {
        const res = await fetch(`${VIEWER_URL}/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: next.id }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setError(body?.error ?? `switch failed (${res.status})`)
        }
        // On success nothing else happens here: the server broadcasts `title`
        // with the new agent_id, CanvasView's key moves, and this whole panel
        // remounts. Setting state optimistically would only race that.
      } catch {
        setError('could not reach the viewer')
      } finally {
        setSending(false)
      }
      btnRef.current?.focus()
    },
    [projectId],
  )

  const pick = useCallback(
    (option: AgentOption) => {
      if (!option.installed) return
      setOpen(false)
      if (option.id === agentId) return
      if (autoActive) setPending(option)
      else void commit(option)
    },
    [agentId, autoActive, commit],
  )

  const onMenuKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (agents.length === 0) return
        const dir = e.key === 'ArrowDown' ? 1 : -1
        setCursor((c) => (c + dir + agents.length) % agents.length)
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const option = agents[cursor]
        if (option) pick(option)
      }
    },
    [agents, close, cursor, pick],
  )

  useEffect(() => {
    if (!pending) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending])

  return (
    <>
      <div className="agent-trigger-wrap">
        <button
          ref={btnRef}
          type="button"
          className="agent-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Agent: ${label}. Change agent.`}
          disabled={!projectId || agents.length === 0 || sending}
          onClick={() => (open ? close() : openMenu())}
        >
          <span className="agent-bolt" aria-hidden="true">
            <Bolt />
          </span>
          <span>{label}</span>
          <span className="agent-chev" aria-hidden="true">
            ▾
          </span>
        </button>
        {error ? (
          <span className="agent-error" role="status">
            {error}
          </span>
        ) : null}
      </div>

      {open ? (
        <>
          {/* A click-catcher rather than a document listener: it cannot race a
              re-render, and it stops the dismissing click from also landing in
              the terminal underneath. */}
          <div className="agent-catcher" onClick={close} />
          <div
            ref={listRef}
            className="agent-menu"
            role="menu"
            aria-label="Agent"
            tabIndex={-1}
            onKeyDown={onMenuKey}
          >
            <div className="agent-menu-label">Agent</div>
            {agents.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={a.id === agentId}
                disabled={!a.installed}
                className={`agent-row${i === cursor ? ' at-cursor' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(a)}
              >
                <span className="agent-row-icon">
                  <Bolt />
                </span>
                <span className="agent-row-label">{a.label}</span>
                <span className="agent-row-right">
                  {a.is_default ? <span className="agent-pill">default</span> : null}
                  {!a.installed ? <span className="agent-pill warn">not on PATH</span> : null}
                  {a.id === agentId ? <Check /> : null}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {pending ? (
        <div className="agent-confirm">
          <div className="agent-confirm-box" role="alertdialog" aria-label={`Switch to ${pending.label}?`}>
            <h4>Switch to {pending.label}?</h4>
            <p>
              The agent running here will be stopped. Work already on the canvas is kept — the
              conversation is not, and {pending.label} starts fresh.
            </p>
            <div className="agent-confirm-actions">
              <button type="button" onClick={() => setPending(null)}>
                Keep {label}
              </button>
              <button ref={goRef} type="button" className="go" onClick={() => void commit(pending)}>
                Stop and switch
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
