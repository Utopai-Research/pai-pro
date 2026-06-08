// Unit tests for pai_assets_client. Mocks globalThis.fetch and uses
// node:test mock timers to fast-forward the transient-retry 5s backoff
// that lives in pai_client.js.

import test from "node:test";
import assert from "node:assert/strict";

process.env.PAI_KEY ||= "test_key";

// Fresh module instance per scenario so module-level state
// (_groupIdPromise, _assetCache) is isolated between tests.
async function freshClient() {
  const cacheBust = `?t=${Date.now()}-${Math.random()}`;
  return await import(`../pai_assets_client.js${cacheBust}`);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchMock(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    let body = null;
    try { body = JSON.parse(opts.body || "null"); } catch {}
    const entry = { url: String(url), action: body?.query_params?.Action, body };
    calls.push(entry);
    const resp = await handler(entry, calls.length - 1);
    if (resp instanceof Response) return resp;
    if (resp?.status != null) return jsonResponse(resp.body ?? {}, resp.status);
    return jsonResponse(resp ?? {});
  };
  fn.calls = calls;
  return fn;
}

function installFetch(fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = prev; };
}

// pai_client.js's withTransientRetry waits 5s before retrying a transient.
// We use node:test's mock timers to skip the wait without making the test
// take 5+ seconds. setImmediate / queueMicrotask / etc are left alone so
// awaited fetch responses still resolve.
function withFakeTimers(fn) {
  return async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      // Eagerly drain any setTimeout that the code under test schedules;
      // process.nextTick lets awaited promises chain before we tick.
      const drain = setInterval(() => {
        process.nextTick(() => {
          try { t.mock.timers.tick(10_000); } catch { /* timers may be reset by t */ }
        });
      }, 5);
      try {
        await fn(t);
      } finally {
        clearInterval(drain);
      }
    } finally {
      t.mock.timers.reset();
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Wire fixtures
// ─────────────────────────────────────────────────────────────────────────

const GROUP_OK = {
  ResponseMetadata: { Action: "CreateAssetGroup" },
  Result: { Id: "group-test-123" },
};
const CREATE_OK = (id = "asset-test-1") => ({
  ResponseMetadata: { Action: "CreateAsset" },
  Result: { Id: id },
});
const GET_ACTIVE = (id = "asset-test-1") => ({
  ResponseMetadata: { Action: "GetAsset" },
  Result: { Id: id, Status: "Active", URL: "https://signed/" + id, AssetType: "Image" },
});
const GET_PENDING = (id = "asset-test-1") => ({
  ResponseMetadata: { Action: "GetAsset" },
  Result: { Id: id, Status: "Pending" },
});
const GET_FAILED = (id = "asset-test-1", reason = "content rejected") => ({
  ResponseMetadata: { Action: "GetAsset" },
  Result: { Id: id, Status: "Failed", FailReason: reason },
});
const ERR_INVALID_WIDTH = {
  detail: "video-generation-assets [CreateAsset]: InvalidParameter.WidthTooSmall — Width must be between 300px and 6000px.",
};
const ERR_INVALID_WIDTH_400 = {
  ResponseMetadata: {
    Action: "CreateAsset",
    Error: {
      Code: "InvalidParameter.WidthTooSmall",
      Message: "Width must be between 300px and 6000px.",
      Data: null,
    },
  },
};
const ERR_GROUP_NOTFOUND = {
  detail: "video-generation-assets [CreateAsset]: NotFound.group_id — The specified asset_group is not found.",
};
const ERR_BREAKER_OPEN = { detail: "video-generation-assets circuit breaker open" };

// ─────────────────────────────────────────────────────────────────────────

test("happy path: CreateAssetGroup → CreateAsset → GetAsset(Active)", async () => {
  const client = await freshClient();
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return GROUP_OK;
    if (action === "CreateAsset") return CREATE_OK();
    if (action === "GetAsset") return GET_ACTIVE();
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    const id = await client.uploadReferenceUrl("https://ex.com/a.png", "image");
    assert.equal(id, "asset-test-1");
    const actions = fetchMock.calls.map((c) => c.action);
    assert.deepEqual(actions, ["CreateAssetGroup", "CreateAsset", "GetAsset"]);
    assert.equal(client.snapshotAssetStates()["https://ex.com/a.png"]?.status, "active");
  } finally {
    restore();
  }
});

test("poll loop: Pending → Active resolves with assetId", withFakeTimers(async () => {
  const client = await freshClient();
  let getAssetCalls = 0;
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return GROUP_OK;
    if (action === "CreateAsset") return CREATE_OK();
    if (action === "GetAsset") {
      getAssetCalls++;
      return getAssetCalls < 2 ? GET_PENDING() : GET_ACTIVE();
    }
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    const id = await client.uploadReferenceUrl("https://ex.com/b.png", "image");
    assert.equal(id, "asset-test-1");
    assert.equal(getAssetCalls, 2, "poll should run twice (pending then active)");
  } finally {
    restore();
  }
}));

test("Failed status surfaces as bad_args + assetRejected", async () => {
  const client = await freshClient();
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return GROUP_OK;
    if (action === "CreateAsset") return CREATE_OK();
    if (action === "GetAsset") return GET_FAILED("asset-test-1", "moderation: explicit");
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    await assert.rejects(
      () => client.uploadReferenceUrl("https://ex.com/c.png", "image"),
      (e) => {
        assert.equal(e.klass, "bad_args");
        assert.equal(e.assetRejected, true);
        assert.match(e.message, /moderation/);
        return true;
      },
    );
    assert.equal(client.snapshotAssetStates()["https://ex.com/c.png"]?.status, "rejected");
  } finally {
    restore();
  }
});

test("InvalidParameter 502 (after retry) → bad_args assetRejected", withFakeTimers(async () => {
  const client = await freshClient();
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return GROUP_OK;
    if (action === "CreateAsset") return { status: 502, body: ERR_INVALID_WIDTH };
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    await assert.rejects(
      () => client.uploadReferenceUrl("https://ex.com/d.png", "image"),
      (e) => {
        assert.equal(e.klass, "bad_args", `expected bad_args, got ${e.klass}`);
        assert.equal(e.assetRejected, true);
        assert.match(e.message, /WidthTooSmall/);
        return true;
      },
    );
  } finally {
    restore();
  }
}));

test("InvalidParameter 400 ResponseMetadata.Error → bad_args assetRejected", async () => {
  const client = await freshClient();
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return GROUP_OK;
    if (action === "CreateAsset") return { status: 400, body: ERR_INVALID_WIDTH_400 };
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    await assert.rejects(
      () => client.uploadReferenceUrl("https://ex.com/d2.png", "image"),
      (e) => {
        assert.equal(e.klass, "bad_args");
        assert.equal(e.assetRejected, true);
        assert.match(e.message, /InvalidParameter\.WidthTooSmall/);
        return true;
      },
    );
    assert.equal(client.snapshotAssetStates()["https://ex.com/d2.png"]?.status, "rejected");
  } finally {
    restore();
  }
});

test("group TTL: NotFound.group_id recreates group, retries CreateAsset once", withFakeTimers(async () => {
  const client = await freshClient();
  let createAssetCalls = 0;
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return GROUP_OK;
    if (action === "CreateAsset") {
      createAssetCalls++;
      // First two attempts (initial + transient retry) both return NotFound.group_id;
      // after the client recreates the group, the next two succeed.
      if (createAssetCalls <= 2) return { status: 502, body: ERR_GROUP_NOTFOUND };
      return CREATE_OK();
    }
    if (action === "GetAsset") return GET_ACTIVE();
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    const id = await client.uploadReferenceUrl("https://ex.com/e.png", "image");
    assert.equal(id, "asset-test-1");
    const groupCalls = fetchMock.calls.filter((c) => c.action === "CreateAssetGroup").length;
    assert.equal(groupCalls, 2, "second CreateAssetGroup means TTL recovery ran");
  } finally {
    restore();
  }
}));

test("canonicalAssetKey collapses every canvas-asset URL form to the relative path", async () => {
  const client = await freshClient();
  const k = client.canonicalAssetKey;
  assert.equal(
    k("/projects/p/assets/images/image_1.jpg"),
    "/projects/p/assets/images/image_1.jpg",
    "relative form unchanged",
  );
  assert.equal(
    k("http://localhost:7488/projects/p/assets/images/image_1.jpg"),
    "/projects/p/assets/images/image_1.jpg",
    "viewer-host absolute → relative",
  );
  assert.equal(
    k("https://administered-till-sectors-deserve.trycloudflare.com/projects/p/assets/images/image_1.jpg"),
    "/projects/p/assets/images/image_1.jpg",
    "tunnel-host absolute → relative",
  );
  assert.equal(
    k("https://picsum.photos/seed/x/512/512"),
    "https://picsum.photos/seed/x/512/512",
    "external URL unchanged",
  );
  assert.equal(k(""), "");
  assert.equal(k(null), null);
});

test("cross-flow dedup: chip preupload then video gen → one PAI upload, both flows see active", withFakeTimers(async () => {
  const client = await freshClient();
  process.env.PAI_KEY = "test_key"; // preuploadCanvasUrl gates on this

  let createGroupCalls = 0;
  let createAssetCalls = 0;
  let getAssetCalls = 0;
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") { createGroupCalls++; return GROUP_OK; }
    if (action === "CreateAsset")      { createAssetCalls++; return CREATE_OK(); }
    if (action === "GetAsset")         { getAssetCalls++; return GET_ACTIVE(); }
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);

  // Fake a tunnel origin so preuploadCanvasUrl actually fires.
  // (readTunnelOrigin reads from disk; the test imports the module fresh,
  // and the env-based tunnel file isn't present — we exercise the cross-
  // flow path via uploadReferenceUrl directly with both URL forms.)
  try {
    // Step 1: video gen lands first with the tunnel-host URL.
    const tunnelUrl = "https://administered-till-sectors-deserve.trycloudflare.com/projects/p/assets/images/image_1.jpg";
    const id1 = await client.uploadReferenceUrl(tunnelUrl, "image");
    assert.equal(id1, "asset-test-1");
    assert.equal(createAssetCalls, 1, "first upload triggered CreateAsset");

    // Step 2: chip preupload comes in for the same asset with the relative form.
    const relativeUrl = "/projects/p/assets/images/image_1.jpg";
    const id2 = await client.uploadReferenceUrl(relativeUrl, "image");
    assert.equal(id2, "asset-test-1", "same assetId returned from cache");
    assert.equal(createAssetCalls, 1, "no new CreateAsset — cache hit");
    assert.equal(getAssetCalls, 1, "no new GetAsset — cache hit");

    // Step 3: snapshot is keyed by the canonical relative path so the chip
    // (which reads assets.get(n.data.image_url)) sees it.
    const snap = client.snapshotAssetStates();
    assert.equal(snap[relativeUrl]?.status, "active");
    assert.equal(snap[relativeUrl]?.assetId, "asset-test-1");
    assert.equal(snap[tunnelUrl], undefined, "no duplicate entry under the tunnel URL");
  } finally {
    restore();
  }
}));

test("reseedFromCanvas primes _assetCache from node.data.metadata.asset_id", async () => {
  const client = await freshClient();
  const nodes = [
    {
      id: "image_1",
      type: "image_result",
      data: {
        label: "active one",
        local_path: "assets/images/image_1.png",
        metadata: { source: "t", asset_id: "asset-active-1" },
      },
    },
    {
      id: "image_2",
      type: "image_result",
      data: {
        label: "rejected one",
        local_path: "assets/images/image_2.png",
        metadata: { source: "t", asset_rejected_reason: "moderation" },
      },
    },
    {
      id: "image_3",
      type: "image_result",
      data: {
        label: "no asset state yet",
        local_path: "assets/images/image_3.png",
        metadata: { source: "t" },
      },
    },
    {
      id: "note_1",
      type: "note",
      data: { label: "n", body: "ignored — not an asset", metadata: {} },
    },
  ];
  client.reseedFromCanvas("p", nodes);
  const snap = client.snapshotAssetStates();
  assert.equal(
    snap["/projects/p/assets/images/image_1.png"]?.status,
    "active",
    "asset_id primes an 'active' entry",
  );
  assert.equal(
    snap["/projects/p/assets/images/image_1.png"]?.assetId,
    "asset-active-1",
    "assetId carried into the cache",
  );
  assert.equal(
    snap["/projects/p/assets/images/image_2.png"]?.status,
    "rejected",
    "asset_rejected_reason primes a 'rejected' entry",
  );
  assert.equal(
    snap["/projects/p/assets/images/image_3.png"],
    undefined,
    "nodes with no asset state stay out of the cache",
  );
  assert.equal(Object.keys(snap).filter((k) => k.includes("note_")).length, 0,
    "non-asset nodes ignored");
});

test("reseedFromCanvas does not overwrite existing _assetCache entries", async () => {
  const client = await freshClient();
  // Imagine an upload already happened (different assetId).
  client.reseedFromCanvas("p", [
    { id: "image_1", type: "image_result", data: { label: "x", local_path: "assets/images/image_1.png", metadata: { asset_id: "old-1" } } },
  ]);
  // Reseed again with a different id should not clobber.
  client.reseedFromCanvas("p", [
    { id: "image_1", type: "image_result", data: { label: "x", local_path: "assets/images/image_1.png", metadata: { asset_id: "new-1" } } },
  ]);
  const snap = client.snapshotAssetStates();
  assert.equal(snap["/projects/p/assets/images/image_1.png"]?.assetId, "old-1",
    "reseed is idempotent — existing cache entries are not replaced");
});

test("circuit breaker open → infra (regression signal)", withFakeTimers(async () => {
  const client = await freshClient();
  const fetchMock = makeFetchMock(({ action }) => {
    if (action === "CreateAssetGroup") return { status: 502, body: ERR_BREAKER_OPEN };
    throw new Error(`unexpected action: ${action}`);
  });
  const restore = installFetch(fetchMock);
  try {
    await assert.rejects(
      () => client.uploadReferenceUrl("https://ex.com/f.png", "image"),
      (e) => {
        assert.equal(e.klass, "infra");
        assert.match(e.message, /circuit breaker open/);
        return true;
      },
    );
  } finally {
    restore();
  }
}));

// _assetCache is an LRUCache(max: 2000), not an unbounded Map (audit N23):
// over a long viewer uptime the old Map only ever grew. Seed more than max
// distinct keys (via reseedFromCanvas, which needs no network) and assert
// the cache evicts the oldest while keeping the most recent — and that the
// resident set never exceeds the bound.
test("_assetCache evicts least-recently-used entries past its max", async () => {
  const client = await freshClient();
  const MAX = 2000;
  const N = MAX + 1; // one over the bound → the first key must be evicted

  // Each node mints one cache entry keyed by /projects/p/<local_path>,
  // inserted in array order, so index 0 is the oldest.
  const nodes = Array.from({ length: N }, (_, i) => ({
    id: `image_${i}`,
    type: "image_result",
    data: {
      label: `a${i}`,
      local_path: `assets/images/image_${i}.png`,
      metadata: { asset_id: `asset-${i}` },
    },
  }));
  client.reseedFromCanvas("p", nodes);

  const snap = client.snapshotAssetStates();
  const keyFor = (i) => `/projects/p/assets/images/image_${i}.png`;

  assert.equal(Object.keys(snap).length, MAX, "resident entries are capped at max");
  assert.equal(snap[keyFor(0)], undefined, "oldest entry evicted once over the bound");
  assert.equal(snap[keyFor(N - 1)]?.assetId, `asset-${N - 1}`, "most-recent entry retained");
  assert.equal(snap[keyFor(1)]?.assetId, "asset-1", "second-oldest survives (only one over max)");
});
