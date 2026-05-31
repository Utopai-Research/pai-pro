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

async function renameOnceWithLock(tmp, target) {
  const lock = `${target}.lock`;
  let handle = null;
  try {
    handle = await fsp.open(lock, "wx");
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }

  try {
    try {
      await fsp.access(target);
      return false;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await fsp.rename(tmp, target);
    return true;
  } finally {
    try { await handle?.close(); } catch {}
    try { await fsp.unlink(lock); } catch {}
  }
}

export async function writeFileOnce(target, contents) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  let removeTmp = true;
  try {
    await fsp.writeFile(tmp, contents);
    try {
      await fsp.link(tmp, target);
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      if (!LINK_FALLBACK_CODES.has(e.code)) throw e;
    }
    const wrote = await renameOnceWithLock(tmp, target);
    if (wrote) removeTmp = false;
    return wrote;
  } finally {
    if (removeTmp) {
      try { await fsp.unlink(tmp); } catch {}
    }
  }
}
