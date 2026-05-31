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
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { getSocket } from '@/lib/socket'
import {
  useChatComposerRegistration,
  type ChatComposerHandle,
} from '@/contexts/ChatComposerContext'

interface TerminalPanelProps {
  projectId: string | null
  inputDisabled?: boolean
}

export function TerminalPanel({
  projectId,
  inputDisabled = false,
}: TerminalPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const inputDisabledRef = useRef(inputDisabled)

  useEffect(() => {
    inputDisabledRef.current = inputDisabled
    if (termRef.current !== null) {
      termRef.current.options.disableStdin = inputDisabled
    }
  }, [inputDisabled])

  // Stable handle so the registration effect only fires once.
  const composerHandle = useMemo<ChatComposerHandle>(
    () => ({
      insertAtCursor(text) {
        if (inputDisabledRef.current) return
        getSocket().emit('pty:input', text)
        termRef.current?.focus()
      },
      focus() {
        termRef.current?.focus()
      },
    }),
    [],
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
      disableStdin: inputDisabledRef.current,
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
      if (inputDisabledRef.current) return
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
