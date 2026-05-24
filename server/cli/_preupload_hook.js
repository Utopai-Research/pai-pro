// CLI-side asset pre-upload kick. POSTs to the viewer's /preupload-asset
// endpoint so the work happens in the long-lived process that owns the
// asset cache and the Socket.IO fan-out. Fire-and-forget; the chip
// flips on its own.

export async function kickPreupload({ projectId, localPath, mimeType }) {
  if (!projectId || !localPath) return;
  const host = process.env.VIEWER_HOST || "localhost";
  const port = parseInt(process.env.VIEWER_PORT ?? "7488", 10);
  const url  = `http://${host}:${port}/projects/${encodeURIComponent(projectId)}/preupload-asset`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ local_path: localPath, mime_type: mimeType }),
    });
  } catch {
    // viewer down — no chip, no harm; CLI proceeds.
  }
}
