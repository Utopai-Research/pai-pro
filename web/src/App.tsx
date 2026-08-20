import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Home } from './pages/Home'
import CanvasView from './pages/CanvasView'
import TmpRoute from './pages/_tmp/TmpRoute'

// Dev-only component catalogue. The ternary is what keeps it out of a
// production build entirely: `import.meta.env.DEV` is replaced with a literal
// at build time, so the dynamic import becomes dead code and Rollup emits no
// chunk for it at all. (A runtime-only guard inside the page would still ship
// the demos and their radix/lucide deps as an unreachable chunk.) In
// production the path falls through to the catch-all and lands on Home.
const ComponentsPage = import.meta.env.DEV
  ? lazy(() => import('./pages/_debug/ComponentsPage'))
  : null

export default function App() {
  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/p/:projectId" element={<CanvasView />} />
        <Route path="/tmp/:slug" element={<TmpRoute />} />
        {ComponentsPage !== null ? (
          <Route
            path="/debug/components"
            element={
              <Suspense fallback={null}>
                <ComponentsPage />
              </Suspense>
            }
          />
        ) : null}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
