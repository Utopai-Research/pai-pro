// Unit tests for the pending-generations broadcast debounce. Pure
// factory-level — no viewer, no chokidar — so regressions point at the
// debounce itself rather than upstream timing.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PENDING_BROADCAST_DEBOUNCE_MS,
  createBroadcasters,
} from "../lib/broadcasters.js";

function makeFakeIo() {
  const emits = [];
  return {
    emits,
    to(room) {
      return {
        emit(event, payload) {
          emits.push({ room, event, payload });
        },
      };
    },
  };
}

test("broadcastPending coalesces a burst into one emit", async () => {
  const io = makeFakeIo();
  const projects = new Map();
  projects.set("p1", {
    id: "p1",
    pendingGenerations: new Map(),
  });
  const { broadcastPending } = createBroadcasters({ io, projects });

  // Simulate three chokidar add events landing back-to-back.
  projects.get("p1").pendingGenerations.set("a", { id: "a", kind: "image", stage: "running" });
  broadcastPending("p1");
  projects.get("p1").pendingGenerations.set("b", { id: "b", kind: "image", stage: "running" });
  broadcastPending("p1");
  projects.get("p1").pendingGenerations.set("c", { id: "c", kind: "image", stage: "running" });
  broadcastPending("p1");

  // Within the debounce window, nothing has fired yet.
  assert.equal(io.emits.length, 0, "no emit during debounce window");

  // Wait past the debounce window plus a small slack.
  await new Promise((r) => setTimeout(r, PENDING_BROADCAST_DEBOUNCE_MS + 50));

  assert.equal(io.emits.length, 1, "exactly one emit after the window");
  const emit = io.emits[0];
  assert.equal(emit.room, "p1");
  assert.equal(emit.event, "pending-generations");
  assert.equal(emit.payload.projectId, "p1");
  assert.equal(emit.payload.state.length, 3, "emit carries all three entries");
  const ids = emit.payload.state.map((e) => e.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("broadcastPending fires again after window closes", async () => {
  const io = makeFakeIo();
  const projects = new Map();
  projects.set("p2", { id: "p2", pendingGenerations: new Map() });
  const { broadcastPending } = createBroadcasters({ io, projects });

  projects.get("p2").pendingGenerations.set("a", { id: "a", kind: "image", stage: "running" });
  broadcastPending("p2");
  await new Promise((r) => setTimeout(r, PENDING_BROADCAST_DEBOUNCE_MS + 50));
  assert.equal(io.emits.length, 1);

  // Second burst after the timer cleared — should produce a new emit.
  projects.get("p2").pendingGenerations.set("b", { id: "b", kind: "image", stage: "running" });
  broadcastPending("p2");
  await new Promise((r) => setTimeout(r, PENDING_BROADCAST_DEBOUNCE_MS + 50));
  assert.equal(io.emits.length, 2, "second burst produces a new emit");
  assert.equal(io.emits[1].payload.state.length, 2);
});

test("broadcastPending isolates timers per project", async () => {
  const io = makeFakeIo();
  const projects = new Map();
  projects.set("pA", { id: "pA", pendingGenerations: new Map([["a", { id: "a", kind: "image", stage: "running" }]]) });
  projects.set("pB", { id: "pB", pendingGenerations: new Map([["b", { id: "b", kind: "image", stage: "running" }]]) });
  const { broadcastPending } = createBroadcasters({ io, projects });

  broadcastPending("pA");
  broadcastPending("pB");
  broadcastPending("pA"); // coalesced into pA's timer
  broadcastPending("pB"); // coalesced into pB's timer

  await new Promise((r) => setTimeout(r, PENDING_BROADCAST_DEBOUNCE_MS + 50));
  assert.equal(io.emits.length, 2, "one emit per project");
  const rooms = io.emits.map((e) => e.room).sort();
  assert.deepEqual(rooms, ["pA", "pB"]);
});
