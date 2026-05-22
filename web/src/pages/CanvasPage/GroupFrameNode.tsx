/**
 * GroupFrameNode — RF custom node for `group_frame` type.
 *
 * Visual: translucent fill at oklch hue from `data.hue`, plain title
 * above the top edge, no border. Pointer-events: none on the
 * .group-fill backdrop so the frame doesn't intercept clicks to its
 * members (members are siblings rendered at higher zIndex).
 *
 * Drag behavior: when this frame node is dragged, the
 * useCanvasPositions hook (frame-aware drag handler) shifts member
 * positions by the same delta. Members aren't selected during this
 * drag — selection is preserved.
 */
import './group-frame.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeProps, OnResizeEnd } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import {
  deleteCanvasGroupFrame,
  setCanvasGroupFrame,
  type CanvasGroupFrame,
} from '@/lib/canvas-stub'
import { useProject } from '@/contexts/ProjectContext'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import { HUE_PRESETS } from './groupFrameHues'
import { useCanvasSaveStatus } from './saveStatusContext'

const FRAME_MIN_W = 160
const FRAME_MIN_H = 120

interface GroupFrameData {
  title: string
  hue: number
  memberIds: string[]
  width: number
  height: number
}

const TITLE_MAX_LENGTH = 40

export function GroupFrameNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as GroupFrameData
  const { projectId } = useProject()
  const saveStatus = useCanvasSaveStatus()
  const composer = useChatComposer()
  const rf = useReactFlow()
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(d.title)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [confirmUngroupOpen, setConfirmUngroupOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!editing) setTitleDraft(d.title)
  }, [d.title, editing])

  useEffect(() => {
    if (!paletteOpen) return undefined
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (containerRef.current === null || t === null) return
      if (!containerRef.current.contains(t)) setPaletteOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [paletteOpen])

  const persist = useCallback(
    async (next: Partial<CanvasGroupFrame>): Promise<void> => {
      if (projectId === null) return
      const merged: CanvasGroupFrame = {
        memberIds: d.memberIds,
        x: 0, // x/y owned by canvas_state.positions; setCanvasGroupFrame keeps existing
        y: 0,
        width: d.width,
        height: d.height,
        hue: d.hue,
        title: d.title,
        ...next,
      }
      saveStatus?.beginPersist()
      try {
        await setCanvasGroupFrame(projectId, id, merged)
        saveStatus?.endPersist(false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        saveStatus?.endPersist(true, msg)
        if (import.meta.env.DEV) {
          console.warn(`[GroupFrameNode:${id}] persist failed`, err)
        }
      }
    },
    [projectId, id, d.memberIds, d.width, d.height, d.hue, d.title, saveStatus],
  )

  const commitTitle = useCallback((): void => {
    const trimmed = titleDraft.trim().slice(0, TITLE_MAX_LENGTH)
    setEditing(false)
    if (trimmed === d.title) return
    void persist({ title: trimmed })
  }, [titleDraft, d.title, persist])

  const startEditing = useCallback((): void => {
    setTitleDraft(d.title)
    setEditing(true)
    setPaletteOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [d.title])

  const togglePalette = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      if (editing) return
      setPaletteOpen((v) => !v)
    },
    [editing],
  )

  const pickHue = useCallback(
    (hue: number): void => {
      setPaletteOpen(false)
      if (hue === d.hue) return
      void persist({ hue })
    },
    [d.hue, persist],
  )

  const onResizeEnd: OnResizeEnd = useCallback(
    (_e, params) => {
      void persist({ width: params.width, height: params.height })
    },
    [persist],
  )

  const requestUngroup = useCallback((): void => {
    if (editing) return
    setPaletteOpen(false)
    setConfirmUngroupOpen(true)
  }, [editing])

  // Archive state is read imperatively (rf.getNodes) so we don't have
  // to subscribe to every node change just for the click-time filter.
  const onReferAll = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      if (composer === null) return
      const memberSet = new Set(d.memberIds)
      const tokens = rf
        .getNodes()
        .filter(
          (n) =>
            memberSet.has(n.id) &&
            (n.data as { archived?: boolean } | undefined)?.archived !== true,
        )
        .map((n) => `@${(n.data as { shortId?: string } | undefined)?.shortId ?? n.id}`)
      if (tokens.length === 0) return
      composer.insertAtCursor(tokens.join('  ') + ' ')
    },
    [composer, d.memberIds, rf],
  )

  const confirmUngroup = useCallback(async (): Promise<void> => {
    setConfirmUngroupOpen(false)
    if (projectId === null) return
    saveStatus?.beginPersist()
    try {
      await deleteCanvasGroupFrame(projectId, id)
      saveStatus?.endPersist(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      saveStatus?.endPersist(true, msg)
      if (import.meta.env.DEV) {
        console.warn(`[GroupFrameNode:${id}] ungroup failed`, err)
      }
    }
  }, [projectId, id, saveStatus])

  useEffect(() => {
    if (selected !== true) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      const a = document.activeElement
      const tag = a?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (a as HTMLElement | null)?.isContentEditable === true
      ) {
        return
      }
      e.preventDefault()
      requestUngroup()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, requestUngroup])

  return (
    <div
      ref={containerRef}
      className={`group-frame${selected === true ? ' selected' : ''}`}
      style={{ ['--group-hue' as string]: d.hue }}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement
        if (
          t.closest('.group-title-button') !== null ||
          t.closest('.group-title-input') !== null ||
          t.closest('.group-palette') !== null ||
          t.closest('.group-confirm') !== null ||
          t.closest('.group-frame-action-btn') !== null
        ) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        requestUngroup()
      }}
    >
      {selected === true ? (
        <NodeResizer
          isVisible={!editing}
          minWidth={FRAME_MIN_W}
          minHeight={FRAME_MIN_H}
          handleClassName="group-resize-handle"
          lineClassName="group-resize-line"
          onResizeEnd={onResizeEnd}
        />
      ) : null}
      <div className="group-title-row">
        {editing ? (
          <input
            ref={inputRef}
            className="group-title group-title-input"
            type="text"
            value={titleDraft}
            maxLength={TITLE_MAX_LENGTH}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitTitle()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
                setTitleDraft(d.title)
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            type="button"
            className="group-title group-title-button"
            onClick={togglePalette}
            onDoubleClick={(e) => {
              e.stopPropagation()
              startEditing()
            }}
            title={d.title !== '' ? `${d.title} — double-click to rename, click for color` : 'double-click to rename, click for color'}
          >
            {d.title !== '' ? d.title : <span className="group-title-empty">untitled</span>}
          </button>
        )}
        {!editing && !confirmUngroupOpen ? (
          <>
            <button
              type="button"
              className="group-frame-action-btn group-frame-action-btn-text"
              onClick={(e) => {
                e.stopPropagation()
                requestUngroup()
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              title="Ungroup — frame removed, nodes stay where they are"
            >
              Ungroup
            </button>
            <button
              type="button"
              className="group-frame-action-btn"
              onClick={onReferAll}
              onDoubleClick={(e) => e.stopPropagation()}
              disabled={composer === null}
              title={
                composer === null
                  ? 'Chat composer not ready'
                  : 'Insert @-mentions for all live members into chat'
              }
            >
              📎
            </button>
          </>
        ) : null}
      </div>
      {paletteOpen && !editing ? (
        <div className="group-palette" onClick={(e) => e.stopPropagation()}>
          {HUE_PRESETS.map((opt) => (
            <button
              key={opt.hue}
              type="button"
              className={`group-palette-swatch${opt.hue === d.hue ? ' group-palette-swatch-active' : ''}`}
              style={{ ['--swatch-hue' as string]: opt.hue }}
              title={opt.label}
              aria-label={opt.label}
              onClick={() => pickHue(opt.hue)}
            />
          ))}
        </div>
      ) : null}
      {confirmUngroupOpen ? (
        <div
          className="group-confirm"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="group-confirm-msg">
            Ungroup{' '}
            <strong>
              {d.title !== '' ? `"${d.title}"` : 'this frame'}
            </strong>
            ?
            <br />
            <span className="group-confirm-sub">Members stay in place.</span>
          </span>
          <div className="group-confirm-actions">
            <button
              type="button"
              className="group-confirm-cancel"
              onClick={() => setConfirmUngroupOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="group-confirm-confirm"
              onClick={() => {
                void confirmUngroup()
              }}
            >
              Ungroup
            </button>
          </div>
        </div>
      ) : null}
      <div className="group-fill" />
    </div>
  )
}
