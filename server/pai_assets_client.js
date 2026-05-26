// PAI raw passthrough → video-generation-assets (asset preupload).
//
// PAI handles auth signing and rate limiting server-side; this file is
// cache + event-emitter + the CreateAsset → GetAsset poll loop.
//
// Reference: raw-models.md § "video-generation-assets".
//
// Public surface:
//
//   paiAssetEvents        EventEmitter  ("update" → { url, status, assetId?, reason? })
//   snapshotAssetStates()              for socket 'pai-assets-snapshot' replay
//   reseedFromCanvas(projectId, nodes) on project load, prime _assetCache from
//                                      data.metadata.asset_id / asset_rejected_reason
//   uploadReferenceUrl(url, kind)      one-shot upload with dedupe + cache
//   preuploadReferenceUrl(url, kind)   fire-and-forget wrapper
//   preuploadCanvasUrl({ projectId, localPath, mimeType })
//                                      chip-UX entry: builds tunnel URL,
//                                      cache-keys by relative form
//   uploadReferences({ images, audios, videos })
//
// Socket event names (`pai-assets`, `pai-assets-snapshot`) are the
// wire protocol with the browser client.
//
// Persistence: the per-project `.asset_cache.json` sidecar is gone; asset_id
// and asset_rejected_reason now live on the node's data.metadata. The
// services/asset_sync.js bridge dispatches mutator updateNode patches in
// response to paiAssetEvents 'update' (active / rejected) so workflow.json
// becomes the durable cache. On boot, services/projects.js calls
// reseedFromCanvas to re-prime the in-process Map from that metadata.
//
// **Wire shapes (post-fix):**
//   CreateAsset → 200 { Result: { Id } }                        (no Status)
//   GetAsset    → 200 { Result: { Id, Status: "Active"|"Pending"|"Failed", URL, ... } }
//   InvalidParameter / DurationTooLong / WidthTooSmall →
//                  502 { detail: "video-generation-assets [CreateAsset]: InvalidParameter.* — ..." }
//   Group expired (~1h server-side TTL) →
//                  502 { detail: "video-generation-assets [CreateAsset]: NotFound.group_id ..." }
//   Circuit breaker (regression) →
//                  502 { detail: "video-generation-assets circuit breaker open" }

import { EventEmitter } from "node:events";
import { callGenerate, err } from "./pai_client.js";
import { readTunnelOrigin } from "./local_mirror.js";

const GROUP_NAME = "pai-pro";

// URL-extension → asset kind. Fallback for callers (e.g. voice gen)
// that don't pass a mimeType to preuploadCanvasUrl.
const EXT_TO_KIND = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
};

const KIND_TO_ASSET_TYPE = {
  image: "Image",
  audio: "Audio",
  video: "Video",
};

function kindFromUrl(url) {
  const ext = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return ext ? EXT_TO_KIND[ext] || null : null;
}

// --- public: event stream for the UI badge -------------------------------

export const paiAssetEvents = new EventEmitter();
paiAssetEvents.setMaxListeners(100);

function emitUpdate(url, status, extra = {}) {
  paiAssetEvents.emit("update", { url, status, ...extra });
}

// --- cache ---------------------------------------------------------------

// Map<canonicalKey, { status, assetId?, reason?, promise? }>
const _assetCache = new Map();

// Collapse the five URL forms that flow through the system onto one cache
// key per logical asset. Without this, the same image gets a separate
// cache entry per caller (chip preupload sends the relative form, video
// gen sends the tunnel-host absolute form), so video gen re-uploads
// everything the chip already paid for.
//
//   /projects/<id>/assets/<...>                               → unchanged
//   http://localhost:<port>/projects/<id>/assets/<...>        → /projects/<id>/assets/<...>
//   https://<tunnel-origin>/projects/<id>/assets/<...>        → /projects/<id>/assets/<...>
//   https://picsum.photos/...    (external)                   → unchanged
//   data:image/png;base64,...    (data URI)                   → unchanged
//
// The relative form matches what `viewerUrlForLocalPath` emits, what
// the client renderer derives (synthesizeAssetUrls in
// web/src/lib/workflowMerge.ts), what the chip looks up, and what
// `projectIdFromCanvasUrl` parses. The wire shape on disk carries only
// `data.local_path`; the URL is composed from that + projectId.
export function canonicalAssetKey(url) {
  if (typeof url !== "string" || !url) return url;
  const m = url.match(/(\/projects\/[^/]+\/assets\/[^?#]+)/);
  return m ? m[1] : url;
}

export function snapshotAssetStates() {
  const out = {};
  for (const [url, entry] of _assetCache) {
    const { status, assetId, reason } = entry;
    out[url] = { status, assetId, reason };
  }
  return out;
}

/**
 * Prime the in-process cache from workflow.json on project load.
 * Walks asset_result nodes; for any with `data.metadata.asset_id` or
 * `data.metadata.asset_rejected_reason`, seeds an `_assetCache` entry
 * keyed by the canonical form (`/projects/<id>/assets/<bucket>/<file>`).
 *
 * Replaces the old `seedAssetCache(readAssetCache(id))` flow that pulled
 * from `.asset_cache.json`. workflow.json is now the durable cache.
 */
export function reseedFromCanvas(projectId, nodes) {
  if (!projectId || !Array.isArray(nodes)) return;
  for (const n of nodes) {
    if (n?.type !== "image_result" && n?.type !== "video_result" && n?.type !== "audio_result") continue;
    const localPath = n?.data?.local_path;
    if (typeof localPath !== "string" || !localPath) continue;
    const md = n?.data?.metadata;
    const key = `/projects/${encodeURIComponent(projectId)}/${String(localPath).replace(/^\/+/, "")}`;
    if (_assetCache.has(key)) continue;
    if (typeof md?.asset_id === "string" && md.asset_id) {
      _assetCache.set(key, { status: "active", assetId: md.asset_id });
    } else if (typeof md?.asset_rejected_reason === "string" && md.asset_rejected_reason) {
      _assetCache.set(key, { status: "rejected", reason: md.asset_rejected_reason });
    }
  }
}

// --- low-level: one video-generation-assets action ------------------------------------

// Reclassify the generic transient/transient_exhausted that pai_client.js
// emits for HTTP 502s, when the response body matches a known provider wire
// signature (see file header for shapes).
function reclassifyAssetError(e) {
  const m = String(e?.message || "");
  if (/\[\w+\]: InvalidParameter\./.test(m)) {
    // Deterministic provider rejection (e.g. WidthTooSmall, DurationTooLong).
    return err("bad_args", m, { assetRejected: true });
  }
  if (/\[\w+\]: NotFound\.group_id/.test(m)) {
    // Asset group expired (provider TTLs groups after ~1h).
    return err("bad_args", m, { groupExpired: true });
  }
  if (/circuit breaker open/i.test(m)) {
    // Should not fire post-fix; treat as P0 regression.
    return err("infra", `video-generation-assets circuit breaker open (regression — page Anton): ${m}`);
  }
  return e;
}

async function paiAssetsCall({ action, payload, timeoutMs = 60_000 }) {
  try {
    return await callGenerate({
      model: "video-generation-assets",
      payload,
      queryParams: { Action: action },
      timeoutMs,
      logTag: `pai-assets:${action}`,
    });
  } catch (e) {
    throw reclassifyAssetError(e);
  }
}

// --- asset group (created once per process) ------------------------------

let _groupIdPromise = null;

async function ensureAssetGroup() {
  if (_groupIdPromise) return _groupIdPromise;
  _groupIdPromise = (async () => {
    const data = await paiAssetsCall({
      action: "CreateAssetGroup",
      payload: {
        Name: GROUP_NAME,
        Description: GROUP_NAME,
        GroupType: "AIGC",
        ProjectName: "default",
      },
    });
    const groupId = data?.Result?.Id;
    if (!groupId) {
      _groupIdPromise = null;
      throw err("infra", `CreateAssetGroup returned no Id: ${JSON.stringify(data).slice(0, 300)}`);
    }
    console.error(`[pai-assets] asset group ready: ${groupId}`);
    return groupId;
  })().catch((e) => {
    _groupIdPromise = null;
    throw e;
  });
  return _groupIdPromise;
}

// --- GetAsset poll until terminal Status --------------------------------

// CreateAsset's response has no Status field (provider passthrough
// behavior, not a PAI bug). Status becomes Active after the provider
// fetches and validates the URL; typical is 2 polls (Processing →
// Active) over 5-10s wall. GetAsset requests are themselves
// ~2-3s each at the PAI hop. The wall ceiling is generous so a slow
// provider day doesn't throw transient_exhausted on a ref that would
// have landed in 30s — the happy path is unaffected (we return ASAP on Active).
const GET_ASSET_POLL_INTERVAL_MS = 1_500;
const GET_ASSET_POLL_CEILING_MS = 60_000;
const GET_ASSET_REQUEST_TIMEOUT_MS = 8_000;

async function pollGetAssetToTerminal(assetId) {
  const started = Date.now();
  let attempts = 0;
  let lastTransient = null;
  for (;;) {
    if (attempts > 0) {
      if (Date.now() - started >= GET_ASSET_POLL_CEILING_MS) {
        throw lastTransient ?? err(
          "transient_exhausted",
          `GetAsset still Pending after ${GET_ASSET_POLL_CEILING_MS / 1000}s (assetId=${assetId})`,
        );
      }
      await new Promise((r) => setTimeout(r, GET_ASSET_POLL_INTERVAL_MS));
    }
    attempts++;
    let resp;
    try {
      resp = await paiAssetsCall({
        action: "GetAsset",
        payload: { Id: assetId },
        timeoutMs: GET_ASSET_REQUEST_TIMEOUT_MS,
      });
    } catch (e) {
      // bad_args (assetRejected, group missing) and infra fail fast.
      if (e.klass === "bad_args" || e.klass === "infra") throw e;
      // transient / transient_exhausted — keep polling within wall budget.
      lastTransient = e;
      continue;
    }
    const result = resp?.Result;
    const status = result?.Status;
    if (status === "Active") return result;
    if (status === "Failed") {
      const reason = result?.FailReason || result?.Message
        || "Asset marked Failed (content moderation most likely)";
      throw err("bad_args", reason, { assetRejected: true });
    }
    // Pending / unknown / missing → keep polling.
  }
}

// --- single-URL upload ----------------------------------------------------

async function doUpload(url, kind) {
  const assetType = KIND_TO_ASSET_TYPE[kind];
  if (!assetType) throw err("bad_args", `unknown asset kind: ${kind}`);

  const createWithGroup = async (groupId) => {
    const name = String(url).split("/").pop().slice(0, 64) || "asset";
    const data = await paiAssetsCall({
      action: "CreateAsset",
      payload: {
        GroupId: groupId,
        URL: url,
        AssetType: assetType,
        Name: name,
        ProjectName: "default",
      },
    });
    const assetId = data?.Result?.Id;
    if (!assetId) {
      throw err(
        "infra",
        `CreateAsset returned no Id for ${url}: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    return assetId;
  };

  let assetId;
  try {
    assetId = await createWithGroup(await ensureAssetGroup());
  } catch (e) {
    if (e?.groupExpired) {
      // Provider TTL'd the cached group — drop and recreate, retry CreateAsset once.
      _groupIdPromise = null;
      assetId = await createWithGroup(await ensureAssetGroup());
    } else {
      throw e;
    }
  }

  await pollGetAssetToTerminal(assetId);
  return assetId;
}

// --- public: single-URL upload with dedupe + cache -----------------------

export async function uploadReferenceUrl(url, kind) {
  if (typeof url !== "string" || !url) throw err("bad_args", "uploadReferenceUrl: url required");

  // Cache key is the canonical form so chip preupload (relative URL) and
  // video gen (tunnel URL) for the same asset hit the same entry. The
  // original `url` keeps flowing to doUpload — PAI needs the fetchable
  // form to read the bytes.
  const key = canonicalAssetKey(url);

  const existing = _assetCache.get(key);
  if (existing) {
    if (existing.status === "active") return existing.assetId;
    if (existing.status === "rejected") {
      throw err("bad_args", existing.reason || "Asset previously rejected", {
        assetRejected: true,
        failedUrl: url,
        kind,
      });
    }
    if (existing.status === "pending" && existing.promise) {
      return existing.promise;
    }
  }

  const promise = (async () => {
    try {
      const assetId = await doUpload(url, kind);
      _assetCache.set(key, { status: "active", assetId });
      emitUpdate(key, "active", { assetId });
      return assetId;
    } catch (e) {
      if (e.assetRejected) {
        _assetCache.set(key, { status: "rejected", reason: e.message });
        emitUpdate(key, "rejected", { reason: e.message });
        // Re-throw with consistent attribution for the caller (generate_video.js).
        const re = err("bad_args", e.message, { assetRejected: true, failedUrl: url, kind });
        throw re;
      }
      // Transient / infra failure — drop cache so the next call retries cleanly.
      _assetCache.delete(key);
      throw e;
    }
  })();

  _assetCache.set(key, { status: "pending", promise });
  emitUpdate(key, "pending");
  return promise;
}

// Fire-and-forget wrapper. Used by canvas-time pre-upload hooks where a
// rejection is fine to silently log (the chip flips red); the agent
// learns about it later if it tries to use the URL for video gen.
export function preuploadReferenceUrl(url, kind) {
  uploadReferenceUrl(url, kind).catch((e) => {
    if (e.assetRejected) {
      console.warn(`[pai-assets] pre-upload rejected (${kind}) ${url}: ${e.message}`);
    } else {
      console.warn(`[pai-assets] pre-upload transient error (${kind}) ${url}: ${e.message}`);
    }
  });
}

// --- public: canvas chip UX entry point ----------------------------------

// Pre-upload a canvas-local asset for the chip UX.
//
// Input is the disk-relative form (the wire shape stored on every asset
// node). Builds the cache key and the fetchable tunnel URL itself — no
// callers need to know about the tunnel origin.
//
// No-op when no tunnel is configured, no PAI_KEY, or the entry is
// already cached.
export function preuploadCanvasUrl({ projectId, localPath, mimeType }) {
  if (!process.env.PAI_KEY) return; // no key → no upload, no chip
  if (!projectId || !localPath) return;
  const rel = String(localPath).replace(/^\/+/, "");
  const kind = (mimeType?.split("/")[0]) || kindFromUrl(rel);
  if (kind !== "image" && kind !== "audio" && kind !== "video") return;
  const key = `/projects/${encodeURIComponent(projectId)}/${rel}`;
  if (_assetCache.has(key)) return;

  const origin = readTunnelOrigin();
  if (!origin) return;
  const tunnelUrl = `${origin}${key}`;

  const promise = (async () => {
    const assetId = await doUpload(tunnelUrl, kind);
    _assetCache.set(key, { status: "active", assetId });
    emitUpdate(key, "active", { assetId });
    return assetId;
  })();

  _assetCache.set(key, { status: "pending", promise });
  emitUpdate(key, "pending");

  promise.catch((e) => {
    if (e?.assetRejected) {
      _assetCache.set(key, { status: "rejected", reason: e.message });
      emitUpdate(key, "rejected", { reason: e.message });
    } else {
      _assetCache.delete(key);
      console.warn(`[pai-assets] pre-upload transient (${kind}) ${key}: ${e?.message}`);
    }
  });
}

// --- public: bulk fan-out used by generate_video.js ----------------------

// Each input array is a list of { tunnelUrl, assetId } objects (the
// shape `buildProviderRefs` produces). Refs that arrive with a non-null
// assetId already have a PAI asset id on file (from a prior preupload
// recorded in workflow.json metadata) — those skip the upload entirely.
// Refs with assetId=null fall through to uploadReferenceUrl, which
// fires CreateAsset + GetAsset and returns a fresh id. Order is
// preserved per kind so positional ref semantics survive.
export async function uploadReferences({ images = [], audios = [], videos = [] } = {}) {
  const per = async (refs, kind) => {
    const out = [];
    for (const r of refs) {
      if (r.assetId) {
        out.push(r.assetId);
        continue;
      }
      try {
        const id = await uploadReferenceUrl(r.tunnelUrl, kind);
        out.push(id);
      } catch (e) {
        if (!e.failedUrl) e.failedUrl = r.tunnelUrl;
        if (!e.kind) e.kind = kind;
        throw e;
      }
    }
    return out;
  };
  const [imageIds, audioIds, videoIds] = await Promise.all([
    per(images, "image"),
    per(audios, "audio"),
    per(videos, "video"),
  ]);
  return { images: imageIds, audios: audioIds, videos: videoIds };
}
