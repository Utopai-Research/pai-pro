import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_PRO_SIZE_TIERS,
  IMAGE_PRO_SUPPORTED_SIZES,
  aspectRatioForImageProSize,
  imageProCostBySize,
  imageProSizeTier,
  normalizeImageProOutputFormat,
} from "../image_pro_sizes.js";

test("image pro size allowlist accepts every documented exact size", () => {
  assert.equal(IMAGE_PRO_SUPPORTED_SIZES.length, 30);
  for (const [tier, sizes] of Object.entries(IMAGE_PRO_SIZE_TIERS)) {
    for (const size of sizes) {
      assert.equal(imageProSizeTier(size), tier);
    }
  }
});

test("image pro size allowlist rejects derived and auto sizes", () => {
  for (const size of ["auto", "1920x1080", "1024X1024", "1024", ""]) {
    assert.equal(imageProSizeTier(size), null);
  }
});

test("image pro aspect ratio derivation reduces exact sizes", () => {
  assert.equal(aspectRatioForImageProSize("2560x1440"), "16:9");
  assert.equal(aspectRatioForImageProSize("1440x2560"), "9:16");
  assert.equal(aspectRatioForImageProSize("1024x1024"), "1:1");
  assert.equal(aspectRatioForImageProSize("2912x1248"), "7:3");
});

test("image pro cost maps exact size tiers", () => {
  assert.equal(imageProCostBySize({ size: "1024x1024" }), 0.26);
  assert.equal(imageProCostBySize({ size: "2560x1440" }), 0.45);
  assert.equal(imageProCostBySize({ size: "3840x2160" }), 0.77);
  assert.equal(imageProCostBySize({ size: "1920x1080" }), null);
  assert.equal(imageProCostBySize({ image_size: "2K" }), null);
  assert.equal(imageProCostBySize(), null);
});

test("image pro output formats are explicit", () => {
  assert.equal(normalizeImageProOutputFormat("png"), "png");
  assert.equal(normalizeImageProOutputFormat("JPEG"), "jpeg");
  assert.equal(normalizeImageProOutputFormat("webp"), null);
});
