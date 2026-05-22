import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useProject } from '@/contexts/ProjectContext'
import { VIEWER_URL } from '@/lib/socket'
import type { NoteSubtype } from '@/types/canvas'
import { downloadHref, NOTE_BODY_MAX_HEIGHT, type NodeState } from '../nodeData'
import { useNodeActions } from '../NodeActionsContext'
import { NodeHead, useIsInSelectedFrame } from './_shared'

interface NoteRenderData {
  label?: string
  body?: string
  subtype?: NoteSubtype
  shortId?: string
  state?: NodeState
}

export function NoteNodeRenderer({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as NoteRenderData
  const state: NodeState = d.state ?? 'complete'
  const subtype = d.subtype
  const body = d.body ?? ''
  const label = d.label ?? ''

  const { onExpandMedia } = useNodeActions()
  const { projectId } = useProject()
  const canExpand = onExpandMedia !== undefined
  const expandNote = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!canExpand) return
    onExpandMedia?.({
      id,
      kind: 'note',
      label,
      body,
      subtype,
      nodeType: 'note',
    })
  }

  const downloadUrl =
    projectId !== null && projectId !== ''
      ? downloadHref(`${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/assets/notes/${encodeURIComponent(id)}.md`)
      : null
  const downloadName = `${label || id || 'note'}.md`

  const target = Position.Left, source = Position.Right
  const isGroupSelected = useIsInSelectedFrame(id)
  return (
    <div
      className={`node note${selected ? ' selected' : ''}${isGroupSelected ? ' is-group-selected' : ''}`}
      data-state={state}
      data-subtype={subtype ?? 'note'}
      style={{ width: 280 }}
    >
      <Handle type="target" position={target} />
      <NodeHead label={`@${id}`} state={state} hideStateChip />
      <div
        className="node-body scrollbar-subtle"
        onDoubleClick={canExpand ? expandNote : undefined}
        style={{
          padding: '12px',
          maxHeight: NOTE_BODY_MAX_HEIGHT,
          overflowY: 'auto',
          fontSize: 12,
          lineHeight: 1.5,
          wordBreak: 'break-word',
          background: 'var(--bg-1, #1a1a1f)',
          cursor: canExpand ? 'zoom-in' : 'default',
        }}
      >
        <div className="note-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      </div>
      {/* Buttons sit outside .node-body so they stay pinned while the body scrolls. */}
      {downloadUrl !== null ? (
        <a
          className="media-download-btn"
          href={downloadUrl}
          download={downloadName}
          title="Download as Markdown"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          ⬇
        </a>
      ) : null}
      {canExpand ? (
        <button
          type="button"
          className="media-expand-btn"
          title="Expand (or double-click the body)"
          onClick={expandNote}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          ⤢
        </button>
      ) : null}
      <div className="node-foot">
        <span>{label}</span>
      </div>
      <Handle type="source" position={source} />
    </div>
  )
}
