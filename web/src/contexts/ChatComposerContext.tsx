/**
 * ChatComposerContext — bridge between canvas/timeline controls and the terminal.
 *
 * Refer buttons need to inject `@<nodeId>` text into the mounted agent
 * terminal. The terminal and controls sit as siblings under separate
 * layout subtrees, so lifting a ref through every intermediate would be
 * invasive. Context fits: TerminalPanel registers its imperative handle
 * on mount; canvas and timeline controls consume it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/** Imperative handle exposed by the mounted terminal. */
export interface ChatComposerHandle {
  /** Write draft text into the terminal input without submitting it. */
  insertAtCursor: (text: string) => void
  /** Submit a complete message to the mounted agent session. */
  sendToAgent: (text: string) => void
  /** Move keyboard focus to the terminal. */
  focus: () => void
}

interface ChatComposerContextValue {
  /** Current handle, or null if no composer is registered yet. */
  handle: ChatComposerHandle | null
  /**
   * Internal: AgentPanel calls this on mount to register its handle.
   * Call with `null` on unmount to deregister.
   */
  registerHandle: (handle: ChatComposerHandle | null) => void
}

const ChatComposerContext = createContext<ChatComposerContextValue | null>(null)

export function ChatComposerProvider({ children }: { children: ReactNode }): JSX.Element {
  const [handle, setHandle] = useState<ChatComposerHandle | null>(null)

  const registerHandle = useCallback((next: ChatComposerHandle | null) => {
    setHandle(next)
  }, [])

  const value = useMemo<ChatComposerContextValue>(
    () => ({ handle, registerHandle }),
    [handle, registerHandle],
  )

  return (
    <ChatComposerContext.Provider value={value}>
      {children}
    </ChatComposerContext.Provider>
  )
}

/**
 * Consumer hook for siblings that want to call into the composer
 * (e.g. SelectionToolbar or timeline Refer buttons). Returns null when no
 * composer is mounted — callers should treat null as "Refer is a
 * no-op right now" rather than crashing.
 */
export function useChatComposer(): ChatComposerHandle | null {
  const ctx = useContext(ChatComposerContext)
  return ctx?.handle ?? null
}

/**
 * Hook the AgentPanel composer calls in a useEffect to register its
 * imperative handle. Cleanup deregisters on unmount.
 *
 * Pass `null` to skip registration (e.g. when no provider is mounted
 * — useful for tests / isolated stories).
 */
export function useChatComposerRegistration(handle: ChatComposerHandle | null): void {
  const ctx = useContext(ChatComposerContext)
  useEffect(() => {
    if (ctx === null) return
    if (handle === null) return
    ctx.registerHandle(handle)
    return () => {
      ctx.registerHandle(null)
    }
  }, [ctx, handle])
}
