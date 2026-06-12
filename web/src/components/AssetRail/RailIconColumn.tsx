/**
 * RailIconColumn — always-visible 44 px tab bar.
 *
 * Four monochrome SVG icons (images / videos / audios / notes) with
 * neutral count badges. Clicking a tab calls `onTabClick(kind)`; the
 * parent decides whether that opens the panel, closes it, or just
 * switches tabs.
 *
 * Active highlight is suppressed when the panel is closed — without
 * the panel showing, a "selected" tab would suggest the panel is
 * open when it isn't.
 */
import type { AssetGroups, AssetKind } from './useAssets'

interface RailIconColumnProps {
  groups: AssetGroups
  activeTab: AssetKind
  panelClosed: boolean
  onTabClick: (tab: AssetKind) => void
}

const TABS: Array<{ kind: AssetKind; label: string; Icon: () => JSX.Element }> = [
  { kind: 'images', label: 'Images', Icon: ImageIcon },
  { kind: 'videos', label: 'Videos', Icon: VideoIcon },
  { kind: 'audios', label: 'Audios', Icon: AudioIcon },
  { kind: 'notes', label: 'Notes', Icon: NoteIcon },
]

export function RailIconColumn({
  groups,
  activeTab,
  panelClosed,
  onTabClick,
}: RailIconColumnProps): JSX.Element {
  return (
    <div className="flex h-full w-11 shrink-0 flex-col items-center border-r border-neutral-800 bg-[#0a0a0a] py-2">
      <div className="flex flex-col items-center gap-1">
        {TABS.map(({ kind, label, Icon }) => {
          const total = groups.counts[kind]
          const archived = groups.archivedCounts[kind]
          const active = !panelClosed && activeTab === kind
          const baseTip =
            archived > 0
              ? `${label} — ${total} total (${archived} archived)`
              : `${label} — ${total}`
          const tip = panelClosed
            ? `${baseTip} (click to open)`
            : active
              ? `${baseTip} (click to close)`
              : baseTip
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onTabClick(kind)}
              title={tip}
              aria-label={tip}
              aria-pressed={active}
              className={
                'relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ' +
                (active
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200')
              }
            >
              <Icon />
              {total > 0 ? (
                <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-neutral-800 px-1 text-[9px] font-mono leading-4 text-neutral-300 ring-1 ring-neutral-700">
                  {total}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ImageIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  )
}

function VideoIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="m22 8-6 4 6 4Z" />
    </svg>
  )
}

function AudioIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a9 9 0 0 1 0 14" />
    </svg>
  )
}

function NoteIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </svg>
  )
}
