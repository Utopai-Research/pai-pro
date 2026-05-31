/**
 * TerminalPanel — embedded xterm.js connected to the server's node-pty
 * bridge. Auto-spawns the owning agent 500ms post-connect (server side; see
 * server/services/socket.js pty:spawn handler).
 *
 * Wires:
 *   socket.emit('pty:spawn', { projectId })              on mount
 *   socket.emit('pty:input', data)                       on keystroke
 *   socket.emit('pty:resize', { cols, rows })            on container resize
 *
 *   socket.on('pty:output', data)   → term.write(data)
 *   socket.on('pty:exit')           → annotate the terminal
 *   socket.on('pty:error', msg)     → annotate (e.g. node-pty missing)
 *
 * Registers a ChatComposerHandle so CanvasPage's SelectionToolbar
 * "Refer" button can type `@<nodeId>` text into the terminal directly.
 */
import { useEffect, useMemo, useRef } from 'react'
import { io } from 'socket.io-client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { getSocket, VIEWER_URL } from '@/lib/socket'
import {
  useChatComposerRegistration,
  type ChatComposerHandle,
} from '@/contexts/ChatComposerContext'

interface TerminalPanelProps {
  projectId: string | null
  agentId: string | null
}

const CODEX_SUBMIT_PHASE_GAP_MS = 500
const PTY_ATTACH_SETTLE_MS = 200
const PTY_WRITE_GRACE_MS = 200
const PTY_FRESH_TIMEOUT_MS = 5000

interface PtySize {
  cols: number
  rows: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

function currentPtySize(term: Terminal | null): PtySize {
  const cols = typeof term?.cols === 'number' && term.cols >= 10 ? term.cols : 120
  const rows = typeof term?.rows === 'number' && term.rows >= 3 ? term.rows : 36
  return { cols, rows }
}

function writeFreshPtyInput(projectId: string, text: string, size: PtySize): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let timeout: number | null = null
    const socket = io(VIEWER_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: false,
      timeout: PTY_FRESH_TIMEOUT_MS,
    })

    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (timeout !== null) window.clearTimeout(timeout)
      socket.disconnect()
      resolve(ok)
    }

    timeout = window.setTimeout(() => finish(false), PTY_FRESH_TIMEOUT_MS)
    socket.on('connect', () => {
      socket.emit('pty:spawn', { projectId, ...size })
    })
    socket.on('pty:spawned', () => {
      window.setTimeout(() => {
        if (done) return
        socket.emit('pty:input', text)
        window.setTimeout(() => finish(true), PTY_WRITE_GRACE_MS)
      }, PTY_ATTACH_SETTLE_MS)
    })
    socket.on('pty:error', () => finish(false))
    socket.on('connect_error', () => finish(false))
    socket.on('disconnect', () => {
      finish(false)
    })
  })
}

async function submitCodexMessage(projectId: string, text: string, size: PtySize): Promise<void> {
  const textSent = await writeFreshPtyInput(projectId, text, size)
  if (!textSent) return
  await sleep(CODEX_SUBMIT_PHASE_GAP_MS)
  await writeFreshPtyInput(projectId, '\r', size)
}

export function TerminalPanel({ projectId, agentId }: TerminalPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const submitQueueRef = useRef<Promise<void>>(Promise.resolve())

  // Keep draft insertion separate from true submission: Refer buttons use
  // insertAtCursor, while Expansion chat uses sendToAgent.
  const composerHandle = useMemo<ChatComposerHandle>(
    () => ({
      insertAtCursor(text) {
        getSocket().emit('pty:input', text)
        termRef.current?.focus()
      },
      sendToAgent(text) {
        const message = text.replace(/\r+$/g, '')
        if (message.trim() === '') return
        if (agentId?.toLowerCase() === 'codex' && projectId !== null) {
          const size = currentPtySize(termRef.current)
          submitQueueRef.current = submitQueueRef.current
            .catch(() => undefined)
            .then(() => submitCodexMessage(projectId, message, size))
          void submitQueueRef.current
        } else {
          getSocket().emit('pty:input', message + '\r')
        }
        termRef.current?.focus()
      },
      focus() {
        termRef.current?.focus()
      },
    }),
    [agentId, projectId],
  )
  useChatComposerRegistration(composerHandle)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#fafafa',
        selectionBackground: 'rgba(250, 250, 250, 0.2)',
      },
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    termRef.current = term

    const socket = getSocket()
    let lastSentSize: { cols: number; rows: number } | null = null
    let resizeFrame: number | null = null

    const fitTerminal = (emitResize: boolean): { cols: number; rows: number } | null => {
      const dims = fit.proposeDimensions()
      if (!dims || dims.cols < 10 || dims.rows < 3) return null
      fit.fit()
      term.refresh(0, term.rows - 1)
      const size = { cols: term.cols, rows: term.rows }
      if (
        emitResize &&
        (lastSentSize === null ||
          lastSentSize.cols !== size.cols ||
          lastSentSize.rows !== size.rows)
      ) {
        socket.emit('pty:resize', size)
        lastSentSize = size
      }
      return size
    }

    const initialSize = fitTerminal(false)
    if (initialSize !== null) lastSentSize = initialSize
    socket.emit(
      'pty:spawn',
      initialSize === null ? { projectId } : { projectId, ...initialSize },
    )

    const dataDisp = term.onData((data) => {
      socket.emit('pty:input', data)
    })

    const onOutput = (data: string) => {
      term.write(data)
    }
    const onError = (msg: string) => {
      term.write(`\r\n\x1b[31m[pty error] ${msg}\x1b[0m\r\n`)
    }
    const onExit = () => {
      term.write('\r\n\x1b[33m[pty exited — close and reopen the project to restart]\x1b[0m\r\n')
    }
    socket.on('pty:output', onOutput)
    socket.on('pty:error', onError)
    socket.on('pty:exit', onExit)

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width < 1 || rect.height < 1) return
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null
        fitTerminal(true)
      })
    })
    ro.observe(container)

    return () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
      ro.disconnect()
      dataDisp.dispose()
      socket.off('pty:output', onOutput)
      socket.off('pty:error', onError)
      socket.off('pty:exit', onExit)
      // Detach only — DO NOT emit pty:kill. The server keeps the pty
      // alive across unmount/refresh so in-flight `generate_video.js`
      // (2-4 minute jobs) survive the user navigating away. The next
      // mount re-attaches and replays the recent buffer. Tmux-style.
      term.dispose()
      termRef.current = null
    }
  }, [projectId])

  // Outer wrapper pins the panel to its parent's height; the inner div
  // is what xterm mounts into. xterm handles its own scrollback via the
  // viewport scrollbar — the outer overflow-hidden just stops the canvas
  // from pushing the page itself when fit.fit() races a layout pass.
  return (
    <div className="h-full w-full overflow-hidden bg-[#0a0a0a]">
      <div className="box-border h-full w-full p-2 pr-4">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  )
}
