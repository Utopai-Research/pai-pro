/**
 * ChatComposerContext — bridge between the canvas (SelectionToolbar)
 * and the AgentPanel composer.
 *
 * The canvas's "📎 Refer" button needs to inject `@<nodeId>` text into
 * the AgentPanel composer at the user's cursor. The canvas + AgentPanel
 * sit as siblings under separate layout subtrees, so lifting a ref
 * through every intermediate would be invasive. Context fits: AgentPanel
 * registers its imperative handle on mount; SelectionToolbar consumes
 * it.
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

/** Imperative handle exposed by the AgentPanel composer. */
export interface ChatComposerHandle {
  /**
   * Insert text at the current caret position. If the input has a
   * selection range, the snippet replaces it. Focuses the input and
   * positions the cursor immediately after the inserted text via
   * requestAnimationFrame so the user can keep typing.
   */
  insertAtCursor: (text: string) => void
  /** Submit a complete message to the mounted agent session. */
  sendToAgent: (text: string) => void
  /** Move keyboard focus to the composer input. */
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
 * (e.g. SelectionToolbar's Refer button). Returns null when no
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
