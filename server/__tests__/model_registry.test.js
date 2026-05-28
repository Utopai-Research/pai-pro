import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODELS,
  getCost,
  getDefault,
  getModel,
} from "../model_registry.js";

test("model registry exposes image-generation-pro without changing image default", () => {
  assert.equal(getDefault("image").id, "image-generation");
  assert.equal(getDefault("image_pro").id, "image-generation-pro");

  const pro = getModel("image-generation-pro");
  assert.ok(pro);
  assert.equal(pro.kind, "image_pro");
  assert.equal(pro.hidden, undefined);
  assert.ok(MODELS.some((m) => m.id === "image-generation-pro"));
});

test("model registry prices image pro by exact size tier", () => {
  assert.equal(getCost("image-generation-pro", { size: "1024x1024" }), 0.26);
  assert.equal(getCost("image-generation-pro", { size: "2560x1440" }), 0.45);
  assert.equal(getCost("image-generation-pro", { size: "3840x2160" }), 0.77);
  assert.equal(getCost("image-generation-pro", { size: "1920x1080" }), null);
});
