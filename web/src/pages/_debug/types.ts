/**
 * The catalogue's entry contract.
 *
 * `surface` exists because our UI lives in two CSS-variable scopes that do not
 * see each other:
 *
 *   app     the shadcn HSL tokens (`bg-background`) — Home, panels, modals.
 *   canvas  `.canvas-host` (pages/CanvasPage/nodes-base.css) — the oklch
 *           token world the canvas nodes and their chrome live in.
 *
 * A component rendered under the wrong scope doesn't look "slightly off": a
 * canvas-native pill under app tokens comes out with colours that don't exist
 * in the product. Each entry declares the world it belongs to, and the shell
 * still lets you flip the frame, because "the same primitive looks right in
 * both worlds" is exactly the invariant this page is here to guard.
 */
import type { ComponentType } from 'react'

export type Surface = 'app' | 'canvas'

export interface Entry {
  /** Sidebar section. Must appear in GROUP_ORDER or the shell drops it. */
  group: string
  /** URL identity (`?component=<slug>`). Unique. */
  slug: string
  name: string
  description: string
  /** The CSS-variable scope this entry opens in. */
  surface: Surface
  /** The product file this entry documents, relative to `web/src`. */
  source: string
  Demo: ComponentType
}
