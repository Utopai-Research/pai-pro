/**
 * AudioResultNode — compact horizontal pill. Subtypes from `@/types/canvas`:
 * `voice` / `upload`. Plays through the canvas-wide one-at-a-time
 * controller so two audio nodes never play simultaneously.
 */
import { useRef, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import type { AudioResultData } from '@/types/canvas'
import { formatAudioTime, notifyPaused, notifyPlaying } from '../audioPlayback'
import { type NodeState } from '../nodeData'
import { useIsInSelectedFrame } from './_shared'

type AudioResultRenderData = Partial<AudioResultData> & { state?: NodeState }

export function AudioResultNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as AudioResultRenderData
  const state: NodeState = d.state ?? 'complete'
  const url = d.audio_url ?? null
  const label = d.label ?? 'audio'
  const subtype = d.subtype ?? 'upload'
  const initialDuration =
    typeof d.metadata?.duration_sec === 'number' && Number.isFinite(d.metadata.duration_sec)
      ? d.metadata.duration_sec
      : null

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number | null>(initialDuration)
  const target = Position.Left, source = Position.Right

  const togglePlay = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      a.play().catch(() => {})
    } else {
      a.pause()
    }
  }
  const onScrub = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    const a = audioRef.current
    if (!a || !duration || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    a.currentTime = ratio * duration
    setCurrentTime(a.currentTime)
  }

  const progress = duration && duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const timeText =
    duration !== null
      ? `${formatAudioTime(currentTime)} / ${formatAudioTime(duration)}`
      : formatAudioTime(currentTime)

  const isGroupSelected = useIsInSelectedFrame(id)

  return (
    <div
      className={`node audio_result${selected ? ' selected' : ''}${isGroupSelected ? ' is-group-selected' : ''}`}
      data-state={state}
      data-subtype={subtype}
    >
      <Handle type="target" position={target} />
      <button
        type="button"
        className={`audio-play nodrag${isPlaying ? ' playing' : ''}`}
        onClick={togglePlay}
        onDoubleClick={(e) => e.stopPropagation()}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      <div className="audio-content">
        <div className="audio-row-top">
          <span className="audio-label" title={label}>{label}</span>
          <span className="audio-subtype">@{id}</span>
        </div>
        <div className="audio-row-bottom">
          <div className="audio-scrubber nodrag" onClick={onScrub}>
            <div className="audio-scrubber-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="audio-time">{timeText}</span>
        </div>
      </div>
      {url !== null && url !== '' ? (
        // biome-ignore lint/a11y/useMediaCaption: audio nodes carry no captions.
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={(e) => {
            setIsPlaying(true)
            notifyPlaying(e.currentTarget as HTMLAudioElement)
          }}
          onPause={(e) => {
            setIsPlaying(false)
            notifyPaused(e.currentTarget as HTMLAudioElement)
          }}
          onEnded={(e) => {
            setIsPlaying(false)
            notifyPaused(e.currentTarget as HTMLAudioElement)
            setCurrentTime(0)
          }}
          onTimeUpdate={(e) => setCurrentTime((e.currentTarget as HTMLAudioElement).currentTime)}
          onLoadedMetadata={(e) => {
            const dur = (e.currentTarget as HTMLAudioElement).duration
            if (Number.isFinite(dur) && dur > 0) setDuration(dur)
          }}
        />
      ) : null}
      <Handle type="source" position={source} />
    </div>
  )
}
