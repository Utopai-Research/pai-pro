// Regression test for the archived-clip leak into the master MP4.
//
// Bug history: `selectReel` originally only checked type + local_path + shot_id.
// If a clip was archived but its shot_id wasn't cleared (an inconsistent state
// possible via a non-canonical archive path), the clip leaked into the stitched
// reel — meaning users got content in their /reel.mp4 they thought they removed.
//
// Fix (defense-in-depth): selectReel now also requires `data.archived !== true`.
// The canonical archive path in CanvasPage clears shot_id atomically; this
// filter guards against any future path that forgets.

import test from "node:test";
import assert from "node:assert/strict";

import { selectReel } from "../reel_stitch.js";

test("selectReel includes live video_result nodes with shot_id, sorted ascending", () => {
  const state = {
    nodes: [
      { id: "video_3", type: "video_result", data: { local_path: "assets/videos/v3.mp4", shot_id: 3 } },
      { id: "video_1", type: "video_result", data: { local_path: "assets/videos/v1.mp4", shot_id: 1 } },
      { id: "video_2", type: "video_result", data: { local_path: "assets/videos/v2.mp4", shot_id: 2 } },
    ],
  };
  const reel = selectReel(state);
  assert.equal(reel.length, 3);
  assert.deepEqual(reel.map((n) => n.id), ["video_1", "video_2", "video_3"]);
});

test("selectReel excludes archived video_result nodes even when they have shot_id set (regression: bug-2026-05-21)", () => {
  const state = {
    nodes: [
      { id: "video_1", type: "video_result", data: { local_path: "assets/videos/v1.mp4", shot_id: 1 } },
      // Inconsistent state — archived but still has shot_id. The canonical
      // archive path now clears shot_id atomically, but this guard catches
      // any future path that forgets.
      { id: "video_2", type: "video_result", data: { local_path: "assets/videos/v2.mp4", shot_id: 2, archived: true } },
      { id: "video_3", type: "video_result", data: { local_path: "assets/videos/v3.mp4", shot_id: 3 } },
    ],
  };
  const reel = selectReel(state);
  assert.equal(reel.length, 2, "archived clip with shot_id should be filtered out");
  assert.deepEqual(reel.map((n) => n.id), ["video_1", "video_3"]);
});

test("selectReel ignores nodes without shot_id (Available clips, not on reel)", () => {
  const state = {
    nodes: [
      { id: "video_1", type: "video_result", data: { local_path: "assets/videos/v1.mp4", shot_id: 1 } },
      { id: "video_2", type: "video_result", data: { local_path: "assets/videos/v2.mp4", shot_id: null } },
      { id: "video_3", type: "video_result", data: { local_path: "assets/videos/v3.mp4" /* no shot_id */ } },
    ],
  };
  const reel = selectReel(state);
  assert.equal(reel.length, 1);
  assert.equal(reel[0].id, "video_1");
});

test("selectReel handles empty + missing state gracefully", () => {
  assert.deepEqual(selectReel(null), []);
  assert.deepEqual(selectReel(undefined), []);
  assert.deepEqual(selectReel({}), []);
  assert.deepEqual(selectReel({ nodes: [] }), []);
});

test("selectReel skips non-video node types", () => {
  const state = {
    nodes: [
      { id: "image_1", type: "image_result", data: { local_path: "assets/images/i1.png", shot_id: 1 } },
      { id: "note_1", type: "note", data: { body: "hello", shot_id: 1 } },
      { id: "video_1", type: "video_result", data: { local_path: "assets/videos/v1.mp4", shot_id: 2 } },
    ],
  };
  const reel = selectReel(state);
  assert.equal(reel.length, 1);
  assert.equal(reel[0].id, "video_1");
});
