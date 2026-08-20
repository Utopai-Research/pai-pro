/**
 * Component catalogue — dev-only route at /debug/components.
 *
 * Sidebar of grouped entries on the left, the selected component on the
 * right. Adding a component means adding one row to registry.tsx; the
 * layout scales with the list instead of with the viewport.
 *
 * The selection lives in the URL (`?component=<slug>`) so a specific
 * component can be linked to. It replaces rather than pushes — browsing a
 * catalogue shouldn't build a back-stack.
 *
 * The surface switcher above the demo frame is the standing regression check
 * for the two token systems: every primitive must look right under the app
 * (shadcn HSL) tokens AND inside `.canvas-host` (canvas oklch). Accent-driven
 * states — ghost/outline hover, select highlight — are what break first if
 * the two ever collide again.
 *
 * Production builds redirect to `/`.
 */
import { useMemo, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { GROUP_ORDER, REGISTRY } from './registry'
import type { Entry, Surface } from './types'
import '../CanvasPage/nodes-base.css'

/** Wraps a demo in the CSS-variable scope it is being viewed under. */
function SurfaceFrame({
  entry,
  surface,
}: {
  entry: Entry
  surface: Surface
}): JSX.Element {
  const { Demo } = entry
  if (surface === 'canvas') {
    return (
      <div className="canvas-host rounded-xl border border-border bg-[var(--bg-0)] p-6">
        <Demo />
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <Demo />
    </div>
  )
}

export default function ComponentsPage(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const slug = params.get('component')
  const active = REGISTRY.find((e) => e.slug === slug) ?? REGISTRY[0]
  // Each entry opens in the world it belongs to; the switcher is per-view
  // state, not per-entry, so flipping it and clicking through the list is
  // how you sweep every component under one surface.
  const [surfaceOverride, setSurfaceOverride] = useState<Surface | null>(null)
  const surface: Surface = surfaceOverride ?? active.surface

  const grouped = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        group,
        entries: REGISTRY.filter((e) => e.group === group),
      })).filter((g) => g.entries.length > 0),
    [],
  )

  if (!import.meta.env.DEV) {
    return <Navigate to="/" replace />
  }

  const select = (next: string): void => {
    setParams({ component: next }, { replace: true })
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="w-56 shrink-0 overflow-y-auto border-r border-border p-4">
        <div className="mb-4">
          <div className="text-[13px] font-medium">Component catalogue</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            dev only · not in production builds
          </div>
        </div>
        {grouped.map(({ group, entries }) => (
          <div key={group} className="mb-4">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {group}
            </div>
            {entries.map((e) => (
              <button
                key={e.slug}
                type="button"
                onClick={() => select(e.slug)}
                className={`block w-full rounded-lg px-2 py-1 text-left text-[12.5px] transition-colors ${
                  e.slug === active.slug
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                {e.name}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[22px] font-medium">{active.name}</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {active.description}
          </p>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground/70">
            {active.source} · belongs to: {active.surface}
          </div>

          <div className="mt-6 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Surface
            </span>
            {(['app', 'canvas'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSurfaceOverride(s)}
                className={`rounded-md px-2 py-1 text-[11.5px] transition-colors ${
                  surface === s
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {s === 'app' ? 'app-shell' : 'canvas-host'}
              </button>
            ))}
            {surfaceOverride !== null && surfaceOverride !== active.surface ? (
              <span className="text-[11px] text-muted-foreground">
                (overridden — this component normally opens under {active.surface})
              </span>
            ) : null}
          </div>

          <div className="mt-3">
            <SurfaceFrame entry={active} surface={surface} />
          </div>
        </div>
      </main>
    </div>
  )
}
