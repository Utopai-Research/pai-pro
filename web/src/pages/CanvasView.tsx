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
import {
  ChatComposerProvider,
  useChatComposer,
} from '@/contexts/ChatComposerContext'
import { MediaExpandProvider } from '@/contexts/MediaExpandContext'
import { useWorkflow } from '@/hooks/useWorkflow'
import {
  patchCanvasNodeDataBatch,
  type CanvasNodeDataUpdate,
} from '@/lib/canvas-stub'
import { getSocket, VIEWER_URL } from '@/lib/socket'
import { ModelsProvider } from '@/lib/useModels'
import type { AutoRun, CanvasNode, VideoResultNode } from '@/types/canvas'

type CanvasTab = 'canvas' | 'timeline'
type AutoModePhase = 'idle' | 'armed' | 'planning' | 'approval_required' | 'running'

interface AutoEstimate {
  plannedSeconds: number
  requestedSeconds: number
  shots: number
  resolution: '720p' | '480p'
  estimatedLow: number
  estimatedHigh: number
  characterSheets: number
  characterVariants: number
  locationAnchors: number
  locationVariants: number
  voiceAnchors: number
  notes: string[]
}

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

function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$--'
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`
}

/** For prompts sent to the agent: the server enforces the exact cap, so
 * never round it ("$31" for a $30.75 cap plans past the gate). */
function formatUsdExact(value: number): string {
  return `$${value.toFixed(2)}`
}

function parseBudgetCap(value: string): number | null {
  let cleaned = value.replace(/[$\s]/g, '')
  // A lone trailing ",dd" is a decimal comma ("12,50" = 12.50); any
  // other comma is a thousands separator ("1,250" = 1250).
  cleaned = /^\d+,\d{1,2}$/.test(cleaned)
    ? cleaned.replace(',', '.')
    : cleaned.replace(/,/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

function inferDurationSeconds(brief: string): number {
  const text = brief.toLowerCase()
  const minute = text.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/)
  if (minute) return Math.min(1800, Math.max(15, Math.round(Number(minute[1]) * 60)))
  const second = text.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/)
  // Ignore implausibly large "Ns" matches: "a 1990s noir short" names a
  // decade, not a 33-minute runtime request.
  if (second && Number(second[1]) <= 600) return Math.max(15, Math.round(Number(second[1])))
  return 60
}

async function fetchEstimatedCost(
  model: string,
  params: Record<string, string | number> = {},
): Promise<number> {
  const r = await fetch(`${VIEWER_URL}/cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, params }),
  })
  if (!r.ok) return 0
  const body = await r.json() as { cost?: unknown }
  return typeof body.cost === 'number' && Number.isFinite(body.cost)
    ? body.cost
    : 0
}

async function buildAutoEstimate(
  brief: string,
  budgetCap: number | null,
): Promise<AutoEstimate> {
  const requestedSeconds = inferDurationSeconds(brief)
  const shots = Math.max(1, Math.ceil(requestedSeconds / 15))
  const characterSheets = Math.min(4, Math.max(2, Math.ceil(shots / 3)))
  const locationAnchors = Math.min(6, Math.max(2, Math.ceil(shots / 4)))
  const voiceAnchors = characterSheets + 1
  const characterVariants = characterSheets
  const locationVariants = locationAnchors
  const expectedRefUploads = Math.max(shots * 2, characterSheets + locationAnchors)

  const [
    video720,
    video480,
    proImage,
    standardImage,
    voice,
    assetUpload,
  ] = await Promise.all([
    fetchEstimatedCost('video-generation', { resolution: '720p', duration: requestedSeconds }),
    fetchEstimatedCost('video-generation', { resolution: '480p', duration: requestedSeconds }),
    fetchEstimatedCost('image-generation-pro', { size: '2560x1440' }),
    fetchEstimatedCost('image-generation', { image_size: '2K' }),
    fetchEstimatedCost('tts', { text_chars: 500 }),
    fetchEstimatedCost('video-generation-assets'),
  ])

  // If the viewer's /cost route is unreachable every rate comes back 0 —
  // throw so the caller sends the honest "estimate unavailable" prompt
  // instead of a confident-looking near-zero range.
  if (video720 <= 0 && video480 <= 0 && proImage <= 0 && standardImage <= 0) {
    throw new Error('cost estimates unavailable')
  }

  const anchorCost =
    characterSheets * proImage +
    (locationAnchors + locationVariants) * standardImage +
    voiceAnchors * voice +
    expectedRefUploads * assetUpload
  let plannedSeconds = requestedSeconds
  let resolution: AutoEstimate['resolution'] = '720p'
  const notes: string[] = []

  if (budgetCap !== null && video720 + anchorCost > budgetCap) {
    resolution = '480p'
    notes.push('Budget pressure lowers video resolution before changing the anchor plan.')
    if (video480 + anchorCost > budgetCap) {
      const perSecond480 = requestedSeconds > 0 ? video480 / requestedSeconds : 0.08
      const availableForVideo = Math.max(0, budgetCap - anchorCost)
      plannedSeconds = Math.max(15, Math.floor(availableForVideo / Math.max(perSecond480, 0.01) / 15) * 15)
      if (plannedSeconds < requestedSeconds) {
        notes.push('If 480p still exceeds the cap, Auto should shorten runtime instead of removing variants.')
      }
    }
  }

  const chosenVideo =
    resolution === '720p'
      ? video720
      : requestedSeconds > 0
        ? video480 * (plannedSeconds / requestedSeconds)
        : video480
  const total = chosenVideo + anchorCost
  return {
    plannedSeconds,
    requestedSeconds,
    shots: Math.max(1, Math.ceil(plannedSeconds / 15)),
    resolution,
    estimatedLow: Math.max(0.01, total * 0.9),
    estimatedHigh: Math.max(0.01, total * 1.2),
    characterSheets,
    characterVariants,
    locationAnchors,
    locationVariants,
    voiceAnchors,
    notes,
  }
}

function buildAutoPlanningPrompt({
  brief,
  budgetCap,
  estimate,
}: {
  brief: string
  budgetCap: number | null
  estimate: AutoEstimate | null
}): string {
  const budgetLine = budgetCap === null
    ? 'Budget cap: not provided yet. Ask for an explicit cap in the approval summary and suggest a cap from your estimate plus a small cushion.'
    : `Budget cap: ${formatUsdExact(budgetCap)} hard cap.`
  const estimateLine = estimate
    ? `UI rough estimate: requested ${estimate.requestedSeconds}s, planned ${estimate.plannedSeconds}s, ${estimate.shots} clips, ${estimate.resolution}, ${estimate.characterSheets} character sheets, ${estimate.characterVariants} character variants, ${estimate.locationAnchors} location anchors, ${estimate.locationVariants} location variants, ${estimate.voiceAnchors} voice anchors, roughly ${formatUsd(estimate.estimatedLow)}-${formatUsd(estimate.estimatedHigh)}.`
    : 'UI rough estimate unavailable; compute your own from the model registry/project guidance.'
  return [
    'Auto Mode planning request. Do not start paid image, voice, or video generation yet.',
    '',
    `Brief: ${brief}`,
    budgetLine,
    estimateLine,
    '',
    'Plan the full story-to-video run using story-to-video-workflow and the related script/image/voice/video skills. If the brief is raw, compose a dialogue-forward script. Split shots close to 15s while leaving enough time for dialogue. Keep detailed location anchors and variants, and keep character variants. Default to straight-to-video reference-to-clip, not storyboard. Use hybrid dispatch: sequential inside continuity-dependent clusters, parallel across independent scenes.',
    '',
    'Approval summary required before spending: inferred runtime, planned runtime, budget cap, estimated spend/range, resolution choice, script/scenes/shots/clips, character sheets and variants, location anchors and variants, voice anchors including VO, dispatch strategy, and final output as Timeline assignment only. If estimate exceeds cap, lower resolution first, then shorten runtime/clip count; do not remove character or location variants. Wait for the user to click Run Auto before running any generation CLI.',
  ].join('\n')
}

function buildAutoExecutionPrompt({
  projectId,
  run,
  budgetCap,
  brief,
  estimate,
}: {
  projectId: string
  run: AutoRun
  budgetCap: number
  brief: string
  estimate: AutoEstimate | null
}): string {
  const runId = run.id ?? ''
  const cap = formatUsdExact(budgetCap)
  const completionUrl = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/auto-runs/${encodeURIComponent(runId)}/complete`
  return [
    'Run Auto is approved. Proceed end-to-end now.',
    '',
    `Project id: ${projectId}`,
    `Auto run id: ${runId}`,
    `Budget cap: ${cap} hard cap.`,
    `Brief: ${brief}`,
    estimate
      ? `Approved rough plan: ${estimate.plannedSeconds}s, ${estimate.shots} clips, ${estimate.resolution}, estimated ${formatUsd(estimate.estimatedLow)}-${formatUsd(estimate.estimatedHigh)}.`
      : 'Use your planning summary as the approved plan.',
    '',
    'Important execution rules:',
    `- Add --auto-run-id ${runId} to every generate_image.js, generate_image_pro.js, generate_voice.js, and generate_video.js command.`,
    '- Still pass --stage on every media generation CLI. The Auto run id is the scoped approval gate; do not ask the user to enable global Run immediately.',
    '- If any CLI returns budget_exceeded or conflict for the Auto run, stop staging new jobs and explain what fit and what did not.',
    '- Keep character variants and detailed location variants. Under budget pressure, use 480p before shortening runtime; only shorten after keeping the anchor plan intact.',
    '- Use straight-to-video by default, no storyboard unless a shot truly requires it.',
    '- Use hybrid dispatch: parallel independent clusters, sequential continuity-dependent clusters.',
    '- After all planned clips land, assign numeric Timeline shot_id order with one updateBatch. Do not run reel_stitch unless the user explicitly asks.',
    `- When Timeline assignment is done, mark the run completed with: curl -sS -X POST ${JSON.stringify(completionUrl)} -H 'Content-Type: application/json' -d '{"status":"completed"}'`,
  ].join('\n')
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
          <AgentPanel
            projectId={projectId}
            agentId={bundle?.agent_id ?? null}
            agentLabel={bundle?.agent_label ?? null}
            activated={activated}
            autoRun={bundle?.auto_run ?? null}
          />
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

function AgentPanel({
  projectId,
  agentId,
  agentLabel,
  activated,
  autoRun,
}: {
  projectId: string | null
  agentId: string | null
  agentLabel: string | null
  activated: boolean
  autoRun: AutoRun | null
}): JSX.Element {
  const composer = useChatComposer()
  const [autoPhase, setAutoPhase] = useState<AutoModePhase>('idle')
  const sawActiveRunRef = useRef(false)

  const activeServerRun =
    autoRun?.status === 'approved' || autoRun?.status === 'running'

  // Auto UI state is per project; the /p/:projectId route reuses this
  // component instance across navigations.
  useEffect(() => {
    setAutoPhase('idle')
    sawActiveRunRef.current = false
  }, [projectId])

  useEffect(() => {
    if (activeServerRun) {
      sawActiveRunRef.current = true
      if (autoPhase === 'idle') setAutoPhase('running')
      return
    }
    // Close the banner only on the active → not-active transition. A
    // terminal run lingers in meta.auto_run forever, so resetting on
    // terminal status alone would keep re-closing the panel and make
    // Auto un-armable after the project's first finished run.
    if (sawActiveRunRef.current && autoPhase === 'running') {
      sawActiveRunRef.current = false
      setAutoPhase('idle')
    }
  }, [activeServerRun, autoPhase])

  const armAuto = useCallback(() => {
    setAutoPhase((prev) => (prev === 'idle' ? 'armed' : prev))
    window.setTimeout(() => composer?.focus(), 0)
  }, [composer])

  return (
    <div className="flex h-full w-full flex-col bg-[#0a0a0a]">
      <AgentHeader
        agentLabel={agentLabel}
        autoActive={autoPhase !== 'idle'}
        onAutoClick={armAuto}
      />
      {autoPhase !== 'idle' ? (
        <AutoModePanel
          key={projectId ?? 'none'}
          projectId={projectId}
          composerReady={composer !== null}
          phase={autoPhase}
          setPhase={setAutoPhase}
          sendToAgent={(text) => composer?.sendToAgent(text)}
          autoRun={autoRun}
        />
      ) : null}
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0">
          {activated ? (
            <TerminalPanel projectId={projectId} agentId={agentId} />
          ) : (
            <div className="h-full w-full bg-[#0a0a0a]" />
          )}
        </div>
      </div>
    </div>
  )
}

function AutoModePanel({
  projectId,
  composerReady,
  phase,
  setPhase,
  sendToAgent,
  autoRun,
}: {
  projectId: string | null
  composerReady: boolean
  phase: AutoModePhase
  setPhase: (phase: AutoModePhase) => void
  sendToAgent: (text: string) => void
  autoRun: AutoRun | null
}): JSX.Element {
  const [brief, setBrief] = useState('')
  const [budget, setBudget] = useState('30')
  const [estimate, setEstimate] = useState<AutoEstimate | null>(null)
  // The brief the estimate was computed for — an estimate is only the
  // "approved plan" while the brief it priced is still the brief.
  const [estimateBrief, setEstimateBrief] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localRunId, setLocalRunId] = useState<string | null>(null)
  const cancelRequestedRef = useRef(false)

  const budgetCap = parseBudgetCap(budget)
  const canPlan =
    composerReady &&
    brief.trim().length > 0 &&
    phase !== 'planning' &&
    phase !== 'running'
  const canRun =
    composerReady &&
    projectId !== null &&
    brief.trim().length > 0 &&
    budgetCap !== null &&
    phase === 'approval_required'

  const plan = async (): Promise<void> => {
    if (!canPlan) {
      setError(brief.trim() === '' ? 'Describe the video first.' : 'Agent is not ready yet.')
      return
    }
    setError(null)
    setPhase('planning')
    let nextEstimate: AutoEstimate | null = null
    try {
      nextEstimate = await buildAutoEstimate(brief, budgetCap)
      setEstimate(nextEstimate)
      setEstimateBrief(brief.trim())
    } catch {
      nextEstimate = null
      setEstimate(null)
      setEstimateBrief(null)
    }
    sendToAgent(buildAutoPlanningPrompt({
      brief: brief.trim(),
      budgetCap,
      estimate: nextEstimate,
    }))
    setPhase('approval_required')
  }

  const run = async (): Promise<void> => {
    if (!canRun || budgetCap === null || projectId === null) {
      setError(budgetCap === null ? 'Enter a budget cap before running Auto.' : 'Agent is not ready yet.')
      return
    }
    setError(null)
    setPhase('running')
    cancelRequestedRef.current = false
    // An estimate priced for an older brief is not this brief's plan.
    const freshEstimate = estimateBrief === brief.trim() ? estimate : null
    try {
      const r = await fetch(`${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/auto-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budget_cap_usd: budgetCap,
          estimate_usd: freshEstimate?.estimatedHigh ?? null,
          planned_runtime_seconds: freshEstimate?.plannedSeconds ?? inferDurationSeconds(brief),
          brief: brief.trim(),
        }),
      })
      const body = await r.json() as { ok?: boolean; auto_run?: AutoRun; error?: string }
      if (!r.ok || body.ok === false || !body.auto_run?.id) {
        throw new Error(body.error || `viewer ${r.status}`)
      }
      if (cancelRequestedRef.current) {
        // Cancel was clicked while the POST was in flight: undo the run
        // we just created instead of dispatching the agent.
        void fetch(
          `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/auto-runs/${encodeURIComponent(body.auto_run.id)}`,
          { method: 'DELETE' },
        ).catch(() => undefined)
        return
      }
      setLocalRunId(body.auto_run.id)
      sendToAgent(buildAutoExecutionPrompt({
        projectId,
        run: body.auto_run,
        budgetCap,
        brief: brief.trim(),
        estimate: freshEstimate,
      }))
    } catch (err) {
      if (cancelRequestedRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('approval_required')
    }
  }

  const cancel = async (): Promise<void> => {
    cancelRequestedRef.current = true
    // Only DELETE something that can still be active — a terminal run
    // from an earlier session would just 409.
    const runId =
      autoRun !== null && (autoRun.status === 'approved' || autoRun.status === 'running')
        ? autoRun.id
        : localRunId
    setPhase('idle')
    setError(null)
    setLocalRunId(null)
    if (projectId !== null && runId) {
      await fetch(
        `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/auto-runs/${encodeURIComponent(runId)}`,
        { method: 'DELETE' },
      ).catch(() => undefined)
    }
  }

  const serverRunActive =
    autoRun !== null && (autoRun.status === 'approved' || autoRun.status === 'running')
  const activeBudgetText = serverRunActive
    ? `${formatUsd(autoRun.spent_usd)} of ${autoRun.budget_cap_usd !== null ? formatUsd(autoRun.budget_cap_usd) : '$--'} cap`
    : budgetCap === null ? 'No cap' : `${formatUsd(budgetCap)} cap`
  const phaseText =
    phase === 'armed' ? 'Armed'
    : phase === 'planning' ? 'Planning'
    : phase === 'approval_required' ? 'Approval required'
    : 'Running'

  return (
    <div className="border-b border-neutral-800 bg-[#101010] px-3 py-2 text-neutral-100">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
            Auto {phaseText}
          </span>
          <span className="truncate text-[11px] text-neutral-400">
            {activeBudgetText} · own approval gate
          </span>
        </div>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          onClick={() => { void cancel() }}
        >
          Cancel
        </button>
      </div>
      <div className="grid gap-2">
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="One prompt for the whole video..."
          rows={2}
          disabled={phase === 'running'}
          className="min-h-[3.25rem] resize-none rounded-md border border-neutral-700 bg-black/40 px-2.5 py-2 text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 focus:border-neutral-400 disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            Budget
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              disabled={phase === 'running'}
              className="h-7 w-20 rounded-md border border-neutral-700 bg-black/40 px-2 text-xs text-neutral-100 outline-none focus:border-neutral-400 disabled:opacity-60"
              placeholder="$30"
            />
          </label>
          <button
            type="button"
            className="h-7 rounded-md bg-neutral-100 px-3 text-xs font-medium text-neutral-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canPlan}
            onClick={() => { void plan() }}
          >
            {phase === 'approval_required' ? 'Revise plan' : 'Plan'}
          </button>
          <button
            type="button"
            className="h-7 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canRun}
            onClick={() => { void run() }}
          >
            Run Auto
          </button>
          {estimate ? (
            <span className="text-[11px] text-neutral-400">
              {estimate.plannedSeconds}s · {estimate.shots} clips · {estimate.resolution} · {formatUsd(estimate.estimatedLow)}-{formatUsd(estimate.estimatedHigh)}
            </span>
          ) : null}
        </div>
        {estimate?.notes.length ? (
          <div className="text-[11px] leading-4 text-neutral-500">
            {estimate.notes.join(' ')}
          </div>
        ) : null}
        {error ? (
          <div className="text-[11px] leading-4 text-red-300">{error}</div>
        ) : null}
      </div>
    </div>
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

function AgentHeader({
  agentLabel,
  autoActive,
  onAutoClick,
}: {
  agentLabel: string | null
  autoActive: boolean
  onAutoClick: () => void
}): JSX.Element {
  return (
    <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-neutral-800 bg-[#0a0a0a] px-2">
      <div />
      <div className="flex min-w-0 items-center justify-center gap-2">
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
      <div className="flex justify-end">
        <button
          type="button"
          aria-pressed={autoActive}
          className={
            'h-7 rounded-full border px-3 text-[11px] font-semibold uppercase tracking-wider transition-colors ' +
            (autoActive
              ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-100'
              : 'border-neutral-700 bg-neutral-950 text-neutral-400 hover:border-neutral-500 hover:text-neutral-100')
          }
          onClick={onAutoClick}
          title="Plan and run a full video through a scoped Auto approval gate."
        >
          Auto
        </button>
      </div>
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
