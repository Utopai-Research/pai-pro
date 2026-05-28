/**
 * Models context — fetches /models from the viewer once at mount and
 * exposes lookups so card chrome and the expand overlay can render
 * human-readable labels for `metadata.model` (a wire-side ID like
 * `image-generation`).
 *
 * Server-side source of truth: server/model_registry.js.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { VIEWER_URL } from './socket'

export interface ModelInfo {
  id: string
  provider: string
  kind: 'image' | 'image_pro' | 'video' | 'voice'
  label: string
  capabilities: string[]
  cost_approx_usd: number | null
}

export interface ModelsValue {
  byId: ReadonlyMap<string, ModelInfo>
  /**
   * Display name for the card chip. Tries the registry first; on miss,
   * strips a trailing `-YYYYMMDD` revision suffix and retries; falls back
   * to a cleaned tail (provider prefix + date suffix dropped). Returns
   * null only when id is empty/missing.
   */
  displayLabelForModel: (id: string | null | undefined) => string | null
}

const EMPTY_BY_ID: ReadonlyMap<string, ModelInfo> = new Map()

const ModelsContext = createContext<ModelsValue>({
  byId: EMPTY_BY_ID,
  displayLabelForModel: () => null,
})

// Strip "<provider>/" prefix and a trailing "-YYYYMMDD" suffix so model
// IDs the registry hasn't been updated for still produce a short chip.
function cleanModelId(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.replace(/-\d{8}$/, '')
}

// Drop a trailing -YYYYMMDD revision suffix; preserves the provider/
// prefix so the result is still a valid registry key to retry against.
function stripDateSuffix(id: string): string {
  return id.replace(/-\d{8}$/, '')
}

export function ModelsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [byId, setById] = useState<ReadonlyMap<string, ModelInfo>>(EMPTY_BY_ID)

  useEffect(() => {
    let cancelled = false
    fetch(`${VIEWER_URL}/models`)
      .then((r) => r.json())
      .then((arr: ModelInfo[]) => {
        if (cancelled) return
        setById(new Map(arr.map((m) => [m.id, m])))
      })
      .catch(() => {
        // Renderer falls through to cleanModelId() on every lookup if
        // the fetch fails, so missing labels degrade to a short chip
        // (not a raw wire-side ID).
      })
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo<ModelsValue>(
    () => ({
      byId,
      displayLabelForModel: (id) => {
        if (id === undefined || id === null || id === '') return null
        const direct = byId.get(id)
        if (direct) return direct.label
        const stripped = stripDateSuffix(id)
        if (stripped !== id) {
          const retry = byId.get(stripped)
          if (retry) return retry.label
        }
        return cleanModelId(id)
      },
    }),
    [byId],
  )

  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
}

export function useModels(): ModelsValue {
  return useContext(ModelsContext)
}

/**
 * Per-asset cost estimate. POSTs to /cost with the model id + asset
 * params (size, image_size, resolution, duration). Returns null while loading
 * or when the registry can't price the call.
 */
export function useCost(
  modelId: string | null | undefined,
  params: { size?: string; image_size?: string; resolution?: string; duration?: number | string } | undefined,
): number | null {
  const [cost, setCost] = useState<number | null>(null)
  const key = modelId !== undefined && modelId !== null && modelId !== ''
    ? `${modelId}|${params?.size ?? ''}|${params?.image_size ?? ''}|${params?.resolution ?? ''}|${params?.duration ?? ''}`
    : null
  useEffect(() => {
    if (key === null || modelId === undefined || modelId === null || modelId === '') {
      setCost(null)
      return
    }
    let cancelled = false
    fetch(`${VIEWER_URL}/cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, params: params ?? {} }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setCost(typeof j?.cost === 'number' ? j.cost : null)
      })
      .catch(() => {
        if (!cancelled) setCost(null)
      })
    return () => {
      cancelled = true
    }
  }, [key, modelId, params?.size, params?.image_size, params?.resolution, params?.duration])
  return cost
}
