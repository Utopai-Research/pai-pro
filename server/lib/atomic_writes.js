import fsp from "node:fs/promises";
import path from "node:path";

const LINK_FALLBACK_CODES = new Set([
  "EACCES",
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
  "EXDEV",
]);

function tempPathFor(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const nonce = Math.random().toString(36).slice(2, 10);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${nonce}.tmp`);
}

export async function writeFileAtomic(target, contents) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  try {
    await fsp.writeFile(tmp, contents);
    await fsp.rename(tmp, target);
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}

// Fallback for filesystems where `fsp.link` is unsupported (EXDEV on a
// cross-mount target, EPERM/ENOTSUP on some overlay or bind mounts — the
// shipped Docker layout). Claim the target directly with an exclusive
// create: the first opener wins and writes the bytes, every later opener
// sees EEXIST and reports the loss. There is no separate lock file, so a
// crash mid-write cannot orphan a lock and permanently wedge the target.
// The trade-off is a small partial-write-on-crash window — a crash between
// the create and the bytes landing leaves a short or empty file — which is
// strictly better than a lock that could never be reclaimed.
async function createOnce(target, contents) {
  let handle = null;
  try {
    handle = await fsp.open(target, "wx");
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    await handle.writeFile(contents);
    await handle.sync();
    return true;
  } finally {
    try { await handle.close(); } catch {}
  }
}

export async function writeFileOnce(target, contents) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  try {
    await fsp.writeFile(tmp, contents);
    try {
      await fsp.link(tmp, target);
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      if (!LINK_FALLBACK_CODES.has(e.code)) throw e;
    }
    return await createOnce(target, contents);
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}
