/**
 * Socket.IO client singleton.
 *
 * One connection per browser tab to the local viewer (port 7488). The
 * server pushes `canvas-state`, `canvas-positions`, `generation-results`,
 * `title`, and `pty:*` events; we emit `subscribe` (per project room) and `pty:spawn` /
 * `pty:input` / `pty:resize` / `pty:kill`.
 */
import { io, type Socket } from 'socket.io-client'

// Default to the page's own origin so production builds (Docker, any
// reverse proxy) always talk to whichever host:port served them. Vite
// dev mode keeps the explicit VITE_VIEWER_URL=http://localhost:7488
// set by scripts/start.sh, since the frontend there lives on a different port.
const VIEWER =
  (import.meta.env.VITE_VIEWER_URL as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:7488')

let socket: Socket | null = null

// Rooms are joined per server-side connection, so a reconnect (viewer
// restart, transport drop) lands on a fresh server socket with no rooms —
// without re-emitting `subscribe` the tab silently stops receiving project
// events. Track live subscriptions here and replay them on every connect.
const subscriptionRefs = new Map<string, number>()

export function getSocket(): Socket {
  if (!socket) {
    socket = io(VIEWER, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
    })
    socket.on('connect', () => {
      for (const projectId of subscriptionRefs.keys()) {
        socket?.emit('subscribe', { projectId })
      }
    })
  }
  return socket
}

/**
 * Join a project's Socket.IO room, resilient to reconnects. The initial
 * `subscribe` is sent on connect (or immediately if already connected);
 * later reconnects replay it automatically. Returns a release fn —
 * subscriptions are refcounted so overlapping subscribers to the same
 * project don't cancel each other.
 */
export function subscribeProject(projectId: string): () => void {
  const s = getSocket()
  subscriptionRefs.set(projectId, (subscriptionRefs.get(projectId) ?? 0) + 1)
  if (s.connected) s.emit('subscribe', { projectId })
  let released = false
  return () => {
    if (released) return
    released = true
    const count = subscriptionRefs.get(projectId) ?? 0
    if (count <= 1) subscriptionRefs.delete(projectId)
    else subscriptionRefs.set(projectId, count - 1)
  }
}

export const VIEWER_URL = VIEWER
