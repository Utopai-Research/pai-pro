/**
 * The catalogue's index. Adding a component to the app means adding one row
 * here — the shell derives the sidebar, the groups, and the URL slugs from it.
 *
 * `source` is the PRODUCT file the row documents (relative to `web/src`), not
 * the demo: the demos live in demos.tsx, so import specifiers would only ever
 * prove the demo exists. This field is what makes a deleted component visible.
 */
import * as D from './demos'
import type { Entry } from './types'

/** Sidebar section order. A row whose group is missing here is dropped. */
export const GROUP_ORDER = ['Primitives', 'Overlays', 'App pieces'] as const

export const REGISTRY: Entry[] = [
  // ── Primitives ───────────────────────────────────────────────────────
  {
    group: 'Primitives',
    slug: 'button',
    name: 'Button',
    description:
      'Six variants, four sizes. Ghost and Outline paint their hover from the accent token, which makes this the row that proves the two token worlds coexist — flip the surface and the hover must survive.',
    surface: 'app',
    source: 'components/ui/button.tsx',
    Demo: D.ButtonDemo,
  },
  {
    group: 'Primitives',
    slug: 'badge',
    name: 'Badge',
    description: 'Status labels: draft, running, failed, queued.',
    surface: 'app',
    source: 'components/ui/badge.tsx',
    Demo: D.BadgeDemo,
  },
  {
    group: 'Primitives',
    slug: 'card',
    name: 'Card',
    description: 'Panel container with header, description, and body slots.',
    surface: 'app',
    source: 'components/ui/card.tsx',
    Demo: D.CardDemo,
  },
  {
    group: 'Primitives',
    slug: 'input',
    name: 'Input',
    description: 'Single-line text field.',
    surface: 'app',
    source: 'components/ui/input.tsx',
    Demo: D.InputDemo,
  },
  {
    group: 'Primitives',
    slug: 'label',
    name: 'Label',
    description: 'Field label wired to its control by htmlFor — click it to focus.',
    surface: 'app',
    source: 'components/ui/label.tsx',
    Demo: D.LabelDemo,
  },
  {
    group: 'Primitives',
    slug: 'select',
    name: 'Select',
    description:
      'Portalled listbox. The highlighted item uses the accent token, so it is a second coexistence check.',
    surface: 'app',
    source: 'components/ui/select.tsx',
    Demo: D.SelectDemo,
  },
  {
    group: 'Primitives',
    slug: 'switch',
    name: 'Switch',
    description: 'Binary toggle.',
    surface: 'app',
    source: 'components/ui/switch.tsx',
    Demo: D.SwitchDemo,
  },
  {
    group: 'Primitives',
    slug: 'separator',
    name: 'Separator',
    description: 'Hairline divider.',
    surface: 'app',
    source: 'components/ui/separator.tsx',
    Demo: D.SeparatorDemo,
  },
  {
    group: 'Primitives',
    slug: 'tabs',
    name: 'Tabs',
    description: 'Segmented switcher; the selected trigger uses background, not accent.',
    surface: 'app',
    source: 'components/ui/tabs.tsx',
    Demo: D.TabsDemo,
  },

  // ── Overlays ─────────────────────────────────────────────────────────
  {
    group: 'Overlays',
    slug: 'dialog',
    name: 'Dialog',
    description:
      'Modal with scrim. Portalled to document.body, so it renders on app tokens even when opened from inside the canvas.',
    surface: 'app',
    source: 'components/ui/dialog.tsx',
    Demo: D.DialogDemo,
  },
  {
    group: 'Overlays',
    slug: 'alert-dialog',
    name: 'AlertDialog',
    description: 'Confirm/cancel modal for a destructive act.',
    surface: 'app',
    source: 'components/ui/alert-dialog.tsx',
    Demo: D.AlertDialogDemo,
  },
  {
    group: 'Overlays',
    slug: 'dropdown-menu',
    name: 'DropdownMenu',
    description: 'Anchored menu with labels, separators, and shortcut hints.',
    surface: 'app',
    source: 'components/ui/dropdown-menu.tsx',
    Demo: D.DropdownMenuDemo,
  },
  {
    group: 'Overlays',
    slug: 'popover',
    name: 'Popover',
    description: 'Anchored free-form container.',
    surface: 'app',
    source: 'components/ui/popover.tsx',
    Demo: D.PopoverDemo,
  },
  {
    group: 'Overlays',
    slug: 'tooltip',
    name: 'Tooltip',
    description: 'Hover hint. Needs a TooltipProvider above it.',
    surface: 'app',
    source: 'components/ui/tooltip.tsx',
    Demo: D.TooltipDemo,
  },

  // ── App pieces ───────────────────────────────────────────────────────
  {
    group: 'App pieces',
    slug: 'undo-toast',
    name: 'UndoToast',
    description:
      'The transient affordance after an archive: what left, and a way back. Lives on the canvas, so it opens under canvas tokens.',
    surface: 'canvas',
    source: 'pages/CanvasPage/UndoToast.tsx',
    Demo: D.UndoToastDemo,
  },
]
