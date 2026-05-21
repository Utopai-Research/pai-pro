// Boundary checks for buildProviderRefs after the URL-passthrough removal.
// External URLs are mirrored onto the canvas first via mirror_url.js;
// generation CLIs only accept --ref-source-id (canvas node ids).
//
// Source-id resolution reads workflow.json + .tunnel_url out of the real
// repo's PROJECT_ROOT/projects/<id>/ (the module derives PROJECT_ROOT
// from its own location), so happy-path tunnel resolution requires
// either a fixture project or an integration test through the CLI.
// These unit tests focus on the bad_args boundary cases that don't
// need a configured tunnel or workflow.

import test from "node:test";
import assert from "node:assert/strict";

import { buildProviderRefs } from "../local_mirror.js";

test("buildProviderRefs with empty sourceIds returns []", async () => {
  const out = await buildProviderRefs({ sourceIds: [] });
  assert.deepEqual(out, []);
});

test("buildProviderRefs with no args returns []", async () => {
  const out = await buildProviderRefs();
  assert.deepEqual(out, []);
});

test("buildProviderRefs with unknown sourceId → bad_args (no local_path)", async () => {
  await assert.rejects(
    () => buildProviderRefs({ sourceIds: ["image_does_not_exist"], projectId: "nonexistent_project" }),
    (err) => {
      assert.equal(err.klass, "bad_args");
      assert.match(err.message, /local_path/);
      return true;
    },
  );
});

test("buildProviderRefs skips empty / falsy ids", async () => {
  const out = await buildProviderRefs({ sourceIds: ["", null, undefined], projectId: "nonexistent_project" });
  assert.deepEqual(out, []);
});
