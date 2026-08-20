/**
 * UploadOverlay — drag-and-drop + clipboard-paste entry point for
 * user-supplied media on the canvas.
 *
 * Mounted as a child of <ReactFlowProvider> (so it can use
 * useReactFlow's screenToFlowPosition) and as a sibling of the
 * ReactFlow renderer. Listens on the *window* for dragenter/dragleave/
 * dragover/drop and paste — that way drops anywhere over the canvas
 * area work without depending on whether the cursor is over a node,
 * the background, or a panel like the selection pill.
 *
 * Server-side, the upload endpoint creates the node + writes its drop
 * position. We don't render an optimistic ghost — the round trip is
 * fast (S3 upload + disk write), and the new node arrives via the
 * canvas-state Socket.IO broadcast and pops in at the drop point.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useReactFlow } from '@xyflow/react'
import { useProject } from '@/contexts/ProjectContext'
import { apiUploadAttachments } from '@/lib/canvas-stub'
import './upload-overlay.css'

interface InflightItem {
  id: number
  name: string
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof Element)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  // xterm.js's hidden textarea — typing into the terminal should not
  // hijack paste.
  if (el.closest('.xterm-helper-textarea')) return true
  if (el.closest('.xterm')) return true
  return false
}

function eventHasFiles(e: DragEvent | ClipboardEvent): boolean {
  const dt =
    e instanceof DragEvent ? e.dataTransfer : (e as ClipboardEvent).clipboardData
  if (!dt) return false
  if (!dt.types) return false
  // `types` is a DOMStringList in some browsers, an array in others.
  const types = Array.from(dt.types as unknown as Iterable<string>)
  return types.includes('Files')
}

function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.type}|${f.lastModified}`
}

function filesFromEvent(e: DragEvent | ClipboardEvent): File[] {
  const dt =
    e instanceof DragEvent ? e.dataTransfer : (e as ClipboardEvent).clipboardData
  if (!dt) return []
  // Take the *union* of items + files. macOS Chrome/Safari paste-from-
  // Finder splits a multi-file clipboard unpredictably across the two
  // APIs (some show up in `.files`, others only in `.items` as
  // kind:'file'). Returning early from either branch silently drops
  // files. Dedupe by name|size|type|lastModified — every reasonable
  // copy gives matching values for the same file.
  const out: File[] = []
  const seen = new Set<string>()
  const push = (f: File | null): void => {
    if (!f) return
    const k = fileKey(f)
    if (seen.has(k)) return
    seen.add(k)
    out.push(f)
  }
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const it = dt.items[i]
      if (it.kind === 'file') push(it.getAsFile())
    }
  }
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i += 1) push(dt.files.item(i))
  }
  return out
}

export function UploadOverlay(): JSX.Element {
  const { projectId } = useProject()
  const rf = useReactFlow()
  const [dragOver, setDragOver] = useState(false)
  const [inflight, setInflight] = useState<InflightItem[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const nextId = useRef(1)

  const handleFiles = useCallback(
    async (files: File[], opts: { clientX?: number; clientY?: number }): Promise<void> => {
      if (!projectId) return
      if (files.length === 0) return
      // Surface the batch size to devtools so a count mismatch (e.g. the
      // OS clipboard only handed us a subset of a multi-file copy) is
      // diagnosable without server logs.
      // eslint-disable-next-line no-console
      console.info(
        `[upload] batch of ${files.length}:`,
        files.map((f) => `${f.name} (${f.type || 'unknown'}, ${f.size}B)`),
      )
      const pos =
        typeof opts.clientX === 'number' && typeof opts.clientY === 'number'
          ? rf.screenToFlowPosition({ x: opts.clientX, y: opts.clientY })
          : null
      // One POST for the whole batch → server does one addBatch mutation →
      // one canvas-state broadcast → the client merge layer sees all N
      // fresh ids together and routes them through gridPackBatch (3×3 for
      // 9 files, 2×4 for 8, etc.). Single-file uploads keep their cursor
      // anchor — pos is honored only when files.length === 1.
      const id = nextId.current
      nextId.current += 1
      const inflightLabel =
        files.length === 1 ? files[0].name : `${files.length} files`
      setInflight((cur) => [...cur, { id, name: inflightLabel }])
      try {
        await apiUploadAttachments(projectId, files, pos)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setErrorMsg(`Upload failed: ${inflightLabel} — ${msg}`)
        window.setTimeout(
          () => setErrorMsg((cur) => (cur === `Upload failed: ${inflightLabel} — ${msg}` ? null : cur)),
          6000,
        )
      } finally {
        setInflight((cur) => cur.filter((it) => it.id !== id))
      }
    },
    [projectId, rf],
  )

  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!eventHasFiles(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDragOver(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!eventHasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!eventHasFiles(e)) return
      e.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragOver(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!eventHasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragOver(false)
      const files = filesFromEvent(e)
      if (files.length > 0) {
        void handleFiles(files, { clientX: e.clientX, clientY: e.clientY })
      }
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (isEditableTarget(document.activeElement)) return
      if (!eventHasFiles(e)) return
      const files = filesFromEvent(e)
      if (files.length === 0) return
      e.preventDefault()
      void handleFiles(files, {})
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [handleFiles])

  return (
    <>
      {dragOver ? (
        <div className="upload-overlay" aria-hidden="true">
          <div className="upload-overlay-card">
            <div className="upload-overlay-icon" aria-hidden="true">
              {/* paperclip glyph */}
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </div>
            <div className="upload-overlay-title">Drop to add to canvas</div>
            <div className="upload-overlay-sub">images · videos · audio · text · pdf</div>
          </div>
        </div>
      ) : null}
      {inflight.length > 0 ? (
        <div className="upload-status-pill" role="status">
          <span className="upload-status-dot" />
          Uploading {inflight.length === 1 ? inflight[0].name : `${inflight.length} files`}…
        </div>
      ) : null}
      {errorMsg !== null ? (
        <div className="upload-error-pill" role="alert">{errorMsg}</div>
      ) : null}
    </>
  )
}
