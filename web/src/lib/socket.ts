/**
 * Socket.IO client singleton.
 *
 * One connection per browser tab to the local viewer (port 7488). The
 * server pushes `canvas-state`, `canvas-positions`, `title`, and `pty:*`
 * events; we emit `subscribe` (per project room) and `pty:spawn` /
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

export function getSocket(): Socket {
  if (!socket) {
    socket = io(VIEWER, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
    })
  }
  return socket
}

export const VIEWER_URL = VIEWER
