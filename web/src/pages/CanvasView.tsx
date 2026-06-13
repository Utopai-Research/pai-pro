/**
 * CanvasView — outer layout for /p/:projectId.
 *
 * Splits the viewport horizontally:
 *   left  → CanvasPage (React Flow surface)
 *   right → Agent terminal (xterm.js + node-pty bridge)
 *
 * ChatComposerProvider wraps both panels so SelectionToolbar's "Refer"
 * button can type `@<nodeId>` into the terminal without prop-drilling.
 *
 * Resizable via react-resizable-panels — drag the divider.
 *
 * On mount we POST /projects/:id/activate so `.active_project` and the
 * workflow.json symlink line up with whatever URL the user is viewing —
 * otherwise the agent's generation scripts would mirror assets into a
 * stale "active" project. The terminal spawns AFTER this resolves so
 * its first agent invocation sees the right symlink.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Link, useParams } from 'react-router-dom'
import CanvasPage from './CanvasPage'
import { DraftGateModal } from './CanvasPage/DraftGateModal'
import { AssetRail, type AssetRailRevealRequest } from '@/components/AssetRail'
import { TerminalPanel } from '@/components/TerminalPanel'
import { TimelinePanel } from '@/components/TimelinePanel'
import { CanvasFocusProvider } from '@/contexts/CanvasFocusContext'
import { ChatComposerProvider } from '@/contexts/ChatComposerContext'
import { MediaExpandProvider } from '@/contexts/MediaExpandContext'
import { useWorkflow } from '@/hooks/useWorkflow'
import {
  patchCanvasNodeDataBatch,
  type CanvasNodeDataUpdate,
} from '@/lib/canvas-stub'
import { getSocket, VIEWER_URL } from '@/lib/socket'
import { ModelsProvider } from '@/lib/useModels'
import type { CanvasNode, VideoResultNode } from '@/types/canvas'

type CanvasTab = 'canvas' | 'timeline'

const LS_RAIL_HIDDEN = 'pai-pro:asset-rail:hidden'
const LS_ARCHIVE_RAIL_GUIDE_SHOWN = 'pai-pro:archive-rail-guide-shown'

function readRailHidden(): boolean {
  try {
    return window.localStorage.getItem(LS_RAIL_HIDDEN) === '1'
  } catch {
    return false
  }
}
function writeRailHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(LS_RAIL_HIDDEN, hidden ? '1' : '0')
  } catch {
    /* private mode etc — silent no-op */
  }
}
function readArchiveRailGuideShown(): boolean {
  try {
    return window.localStorage.getItem(LS_ARCHIVE_RAIL_GUIDE_SHOWN) === '1'
  } catch {
    return false
  }
}
function writeArchiveRailGuideShown(): void {
  try {
    window.localStorage.setItem(LS_ARCHIVE_RAIL_GUIDE_SHOWN, '1')
  } catch {
    /* private mode etc — silent no-op */
  }
}

function archiveKind(node: CanvasNode): AssetRailRevealRequest['kind'] {
  if (node.type === 'image_result') return 'images'
  if (node.type === 'video_result') return 'videos'
  if (node.type === 'audio_result') return 'audios'
  return 'notes'
}

function isVideoNode(node: CanvasNode): node is VideoResultNode {
  return node.type === 'video_result'
}

function isTypingTarget(target: Element | null): boolean {
  const tagName = target?.tagName
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    (target as HTMLElement | null)?.isContentEditable === true
  )
}

export default function CanvasView(): JSX.Element {
  const { projectId = null } = useParams<{ projectId: string }>()
  const [activated, setActivated] = useState(false)
  const [canvasTab, setCanvasTab] = useState<CanvasTab>('canvas')
  // Owned at CanvasView so the toggle button in CanvasHeader (always
  // visible) can flip the same state the rail itself reads.
  const [railHidden, setRailHidden] = useState<boolean>(readRailHidden)
  const archiveHistoryRef = useRef<string[][]>([])
  const archiveRailGuideShownRef = useRef(readArchiveRailGuideShown())
  const [railRevealRequest, setRailRevealRequest] =
    useState<AssetRailRevealRequest | null>(null)
  const toggleRail = useCallback(() => {
    setRailHidden((prev) => {
      const next = !prev
      writeRailHidden(next)
      return next
    })
  }, [])

  // `[` keyboard toggle (no modifier). Skip when focus is in a text
  // input — typing `[` into a textarea must not collapse the rail.
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== '[') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (isTypingTarget(document.activeElement)) return
      e.preventDefault()
      toggleRail()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleRail])
  // Subscribe at the outer layer so the Timeline tab gets workflow
  // updates without remounting CanvasPage's own subscription.
  const { workflow, pendingGenerations, bundle } = useWorkflow(projectId)

  const archiveNodes = useCallback(
    (ids: string[]): void => {
      if (projectId === null || workflow === null || ids.length === 0) return
      const idSet = new Set(ids)
      const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]))
      const targets = ids
        .map((id) => nodesById.get(id))
        .filter((node): node is CanvasNode => node !== undefined)
      if (targets.length === 0) return

      archiveHistoryRef.current.push(targets.map((node) => node.id))
      const archivedAt = new Date().toISOString()
      const updates: CanvasNodeDataUpdate[] = targets.map((node) => ({
        nodeId: node.id,
        data:
          node.type === 'video_result'
            ? { archived: true, archived_at: archivedAt, shot_id: null }
            : { archived: true, archived_at: archivedAt },
      }))

      if (
        targets.some(
          (node) =>
            node.type === 'video_result' &&
            typeof node.data.shot_id === 'number',
        )
      ) {
        workflow.nodes
          .filter(isVideoNode)
          .filter(
            (node) =>
              node.data.archived !== true &&
              !idSet.has(node.id) &&
              typeof node.data.shot_id === 'number',
          )
          .sort((a, b) => (a.data.shot_id ?? 0) - (b.data.shot_id ?? 0))
          .forEach((node, index) => {
            const shotId = index + 1
            if (node.data.shot_id !== shotId) {
              updates.push({ nodeId: node.id, data: { shot_id: shotId } })
            }
          })
      }

      const revealTarget = targets[0]
      const shouldRevealInRail = !railHidden || !archiveRailGuideShownRef.current
      if (shouldRevealInRail) {
        if (railHidden && !archiveRailGuideShownRef.current) {
          archiveRailGuideShownRef.current = true
          writeArchiveRailGuideShown()
          setRailHidden(false)
          writeRailHidden(false)
        }
        setRailRevealRequest({
          id: revealTarget.id,
          kind: archiveKind(revealTarget),
        })
      }

      void patchCanvasNodeDataBatch(projectId, updates).catch((err) => {
        console.warn(
          `[canvas:${projectId}] archive failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    },
    [projectId, workflow, railHidden],
  )

  const restoreLastArchive = useCallback((): boolean => {
    if (projectId === null) return false
    const ids = archiveHistoryRef.current.pop()
    if (ids === undefined || ids.length === 0) return false
    void patchCanvasNodeDataBatch(
      projectId,
      ids.map((id) => ({
        nodeId: id,
        data: { archived: null, archived_at: null },
      })),
    ).catch((err) => {
      console.warn(
        `[canvas:${projectId}] restore failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    return true
  }, [projectId])

  useEffect(() => {
    archiveHistoryRef.current = []
    setRailRevealRequest(null)
  }, [projectId])

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent): void => {
      const isCmdZ =
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'z' &&
        !e.shiftKey &&
        !e.altKey
      if (!isCmdZ) return
      if (isTypingTarget(document.activeElement)) return
      if (!restoreLastArchive()) return
      e.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [restoreLastArchive])

  // Project title tracked locally so we can show optimistic edits +
  // listen for the server's `title` broadcasts (which fire on meta
  // changes).
  const [title, setTitle] = useState<string>('')
  useEffect(() => {
    if (bundle?.title) setTitle(bundle.title)
  }, [bundle?.title])

  // `title` socket events include meta changes too; see watcher.js.
  const [runImmediately, setRunImmediately] = useState(false)
  useEffect(() => {
    setRunImmediately(bundle?.dangerously_skip_draft_gate === true)
  }, [bundle?.dangerously_skip_draft_gate])
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    if (projectId === null) return undefined
    const socket = getSocket()
    const onTitle = (msg: {
      projectId: string
      title: string
      dangerously_skip_draft_gate?: boolean
    }) => {
      if (msg.projectId !== projectId) return
      setTitle(msg.title)
      if (typeof msg.dangerously_skip_draft_gate === 'boolean') {
        setRunImmediately(msg.dangerously_skip_draft_gate)
      }
    }
    socket.on('title', onTitle)
    return () => {
      socket.off('title', onTitle)
    }
  }, [projectId])

  const patchRunImmediately = async (next: boolean): Promise<void> => {
    if (projectId === null) return
    const r = await fetch(
      `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dangerously_skip_draft_gate: next }),
      },
    )
    if (!r.ok) throw new Error(`viewer ${r.status}`)
    setRunImmediately(next)
  }

  useEffect(() => {
    if (projectId === null) return undefined
    let cancelled = false
    setActivated(false)
    fetch(`${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/activate`, {
      method: 'POST',
    })
      .catch(() => {
        /* viewer might be offline; surface failure as a non-activated state */
      })
      .finally(() => {
        if (!cancelled) setActivated(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const saveTitle = async (next: string) => {
    if (projectId === null) return
    const trimmed = next.trim()
    if (!trimmed || trimmed === title) return
    setTitle(trimmed)
    try {
      await fetch(`${VIEWER_URL}/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
    } catch {
      /* server will re-broadcast the canonical title on success */
    }
  }

  return (
    <ModelsProvider>
    <ChatComposerProvider>
    <CanvasFocusProvider>
    <MediaExpandProvider>
    <div className="fixed inset-0 h-screen w-screen overflow-hidden">
      <Group orientation="horizontal" className="h-full w-full overflow-hidden">
        <Panel defaultSize={65} minSize={30} className="overflow-hidden">
          <div className="flex h-full w-full flex-col overflow-hidden">
            <CanvasHeader
              title={title}
              currentTab={canvasTab}
              onTabChange={setCanvasTab}
              onSaveTitle={saveTitle}
              runImmediately={runImmediately}
              onReviewDrafts={() => { patchRunImmediately(false) }}
              onRunImmediately={() => setModalOpen(true)}
            />
            {runImmediately ? (
              <div className="draft-gate-banner" role="alert">
                <div className="draft-gate-banner-text">
                  <span className="draft-gate-banner-warn">⚠</span>
                  <span>
                    Draft review is off — agent generations run immediately and
                    may charge your card.
                  </span>
                </div>
                <button
                  type="button"
                  className="draft-gate-banner-action"
                  onClick={() => { patchRunImmediately(false) }}
                >
                  Review drafts
                </button>
              </div>
            ) : null}
            <div className="relative flex flex-1 overflow-hidden">
              <AssetRail
                projectId={projectId}
                workflow={workflow}
                hidden={railHidden}
                onToggleHidden={toggleRail}
                revealRequest={railRevealRequest}
              />
              <div className="relative h-full flex-1 overflow-hidden">
                {/*
                  Mount both. CanvasPage holds its own React Flow state +
                  drag handlers, so we keep it mounted and toggle visibility
                  rather than tearing it down on each tab switch.
                */}
                <div
                  className={
                    'absolute inset-0 ' +
                    (canvasTab === 'canvas' ? 'block' : 'hidden')
                  }
                >
                  <CanvasPage onArchiveNodes={archiveNodes} />
                </div>
                <div
                  className={
                    'absolute inset-0 ' +
                    (canvasTab === 'timeline' ? 'block' : 'hidden')
                  }
                >
                  <TimelinePanel
                    projectId={projectId}
                    projectTitle={title}
                    workflow={workflow}
                    pendingGenerations={pendingGenerations}
                    onArchiveNodes={archiveNodes}
                    isVisible={canvasTab === 'timeline'}
                  />
                </div>
              </div>
            </div>
          </div>
        </Panel>
        <Separator className="w-1 bg-border hover:bg-primary/40 transition-colors" />
        <Panel defaultSize={35} minSize={20} className="overflow-hidden">
          <div className="flex h-full w-full flex-col bg-[#0a0a0a]">
            <AgentHeader agentLabel={bundle?.agent_label ?? null} />
            <div className="relative flex-1 overflow-hidden">
              <div className="absolute inset-0">
                {activated ? (
                  <TerminalPanel projectId={projectId} agentId={bundle?.agent_id ?? null} />
                ) : (
                  <div className="h-full w-full bg-[#0a0a0a]" />
                )}
              </div>
            </div>
          </div>
        </Panel>
      </Group>
    </div>
    <DraftGateModal
      isOpen={modalOpen}
      onConfirm={async () => { await patchRunImmediately(true); setModalOpen(false) }}
      onCancel={() => setModalOpen(false)}
    />
    </MediaExpandProvider>
    </CanvasFocusProvider>
    </ChatComposerProvider>
    </ModelsProvider>
  )
}

function CanvasHeader({
  title,
  currentTab,
  onTabChange,
  onSaveTitle,
  runImmediately,
  onReviewDrafts,
  onRunImmediately,
}: {
  title: string
  currentTab: CanvasTab
  onTabChange: (t: CanvasTab) => void
  onSaveTitle: (next: string) => void
  runImmediately: boolean
  onReviewDrafts: () => void
  onRunImmediately: () => void
}): JSX.Element {
  const reviewClassName = !runImmediately
    ? 'generation-mode-option is-active'
    : 'generation-mode-option'
  const runClassName = runImmediately
    ? 'generation-mode-option is-run-immediately is-active'
    : 'generation-mode-option'

  return (
    <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-border bg-background px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/"
          aria-label="Back to projects"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
        >
          <ChevronLeftIcon />
        </Link>
        <EditableTitle value={title} onSave={onSaveTitle} />
      </div>
      <CanvasTabs current={currentTab} onChange={onTabChange} />
      <div className="flex min-w-0 items-center justify-end">
        <div
          className="generation-mode-control"
          role="group"
          aria-label="Generation mode"
        >
          <button
            type="button"
            className={reviewClassName}
            aria-pressed={!runImmediately}
            onClick={runImmediately ? onReviewDrafts : undefined}
            title="Paid generations pause for draft review before they run."
          >
            Review drafts
          </button>
          <button
            type="button"
            className={runClassName}
            aria-pressed={runImmediately}
            onClick={runImmediately ? undefined : onRunImmediately}
            title="Turn off draft review so paid generations run immediately."
          >
            Run immediately
          </button>
        </div>
      </div>
    </div>
  )
}

function EditableTitle({
  value,
  onSave,
}: {
  value: string
  onSave: (next: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (!editing) return
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [editing])

  const commit = () => {
    setEditing(false)
    onSave(draft)
  }

  const cancel = () => {
    setDraft(value)
    setEditing(false)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        maxLength={120}
        className="min-w-0 max-w-[28rem] flex-1 rounded-md border border-foreground/20 bg-background px-2 py-1 text-sm font-medium text-foreground focus:border-foreground/50 focus:outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to rename"
      className="group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-card"
    >
      <span className="truncate">{value || 'Untitled project'}</span>
      <PencilIcon className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

function CanvasTabs({
  current,
  onChange,
}: {
  current: CanvasTab
  onChange: (t: CanvasTab) => void
}): JSX.Element {
  const tabClass = (t: CanvasTab): string =>
    'relative rounded-full px-4 py-1 text-xs font-medium uppercase tracking-wider transition-colors ' +
    (current === t
      ? 'bg-foreground text-background'
      : 'text-muted-foreground hover:text-foreground')
  return (
    <div className="flex items-center gap-1 rounded-full border border-border bg-card p-0.5">
      <button
        type="button"
        className={tabClass('canvas')}
        onClick={() => onChange('canvas')}
      >
        Canvas
      </button>
      <button
        type="button"
        className={tabClass('timeline')}
        onClick={() => onChange('timeline')}
      >
        Timeline
      </button>
    </div>
  )
}

function AgentHeader({ agentLabel }: { agentLabel: string | null }): JSX.Element {
  return (
    <div className="flex h-12 shrink-0 items-center justify-center gap-2 border-b border-neutral-800 bg-[#0a0a0a] px-2">
      <div className="flex items-center rounded-full border border-border bg-card p-0.5">
        <div className="relative rounded-full bg-foreground px-4 py-1 text-xs font-medium uppercase tracking-wider text-background">
          Agent
        </div>
      </div>
      {agentLabel ? (
        <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          {agentLabel}
        </span>
      ) : null}
    </div>
  )
}

function ChevronLeftIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}


function PencilIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}
