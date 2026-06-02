// Slice a public image URL into cols×rows tiles and write each tile into
// the active project's assets/images/ folder via local_mirror. Used by the
// split_image CLI. Tiles are PNGs.

import sharp from "sharp";
import { writeBytesToTmp, readActiveProject } from "./local_mirror.js";

const MAX_DIM = 8;
const MIN_DIM = 1;
const FETCH_TIMEOUT_MS = 30_000;

function badArgs(message) {
  const e = new Error(message);
  e.klass = "bad_args";
  return e;
}

function parseDimension(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DIM || n > MAX_DIM) {
    throw badArgs(`${name} must be an integer in [${MIN_DIM},${MAX_DIM}]`);
  }
  return n;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function reducedAspect(w, h) {
  const g = gcd(w, h) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

async function fetchBytes(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

export async function splitImage({ url, cols, rows, projectId }) {
  if (!url) throw badArgs("splitImage: url required");
  cols = parseDimension("cols", cols);
  rows = parseDimension("rows", rows);
  if (cols === 1 && rows === 1) throw badArgs("a 1x1 split is a no-op");

  const proj = projectId || await readActiveProject();
  const srcBytes = await fetchBytes(url);
  const meta = await sharp(srcBytes).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error("source image has no readable dimensions");

  const tileW = Math.floor(W / cols);
  const tileH = Math.floor(H / rows);
  if (tileW < 1 || tileH < 1) throw new Error(`source ${W}×${H} too small for ${cols}×${rows} split`);

  const pieces = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const left = (c - 1) * tileW;
      const top  = (r - 1) * tileH;
      const w = (c === cols) ? (W - left) : tileW;
      const h = (r === rows) ? (H - top)  : tileH;
      const tileBuf = await sharp(srcBytes)
        .extract({ left, top, width: w, height: h })
        .png()
        .toBuffer();
      const staged = await writeBytesToTmp({
        bytes: tileBuf,
        mimeType: "image/png",
        projectId: proj,
      });
      pieces.push({
        row: r, col: c,
        tmp_path: staged.absolute_path,
        width: w, height: h,
        aspect_ratio: reducedAspect(w, h),
      });
    }
  }
  return { sourceWidth: W, sourceHeight: H, pieces };
}
