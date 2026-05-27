import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl === null) {
  throw new Error('root element not found')
}

// Note: StrictMode disabled in dev because TerminalPanel's pty:spawn
// isn't idempotent under double-mount — the first pty gets killed
// and respawned, which is wasteful and confuses the agent launch
// sequence. Re-enable once the spawn cycle is StrictMode-safe.
createRoot(rootEl).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
