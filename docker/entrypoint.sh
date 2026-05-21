#!/bin/sh
# pai-pro — container entrypoint.
#
# Boot tasks before exec'ing the viewer:
#   1. Link in-image skills into ~/.claude/skills (idempotent).
#   2. Ensure the projects dir exists on the named volume.
#   3. Honor PUBLIC_VIEWER_URL by writing it into .tunnel_url for skills.
#   4. Hand off to node with exec so tini sees node directly.
set -e

CLAUDE_DIR="${HOME}/.claude"

# 1. Skills — link /repo/skills/* into ~/.claude/skills/ so claude CLI
#    auto-discovers them. The dir is in-image (NOT a bind-mount from host)
#    to avoid the host/container target-collision when the same skill set
#    is also installed in the user's ~/.claude/skills/ on the host.
mkdir -p "${CLAUDE_DIR}/skills"
for src in /repo/skills/*/; do
  [ -d "${src}" ] || continue
  name="$(basename "${src}")"
  dst="${CLAUDE_DIR}/skills/${name}"
  # Idempotent: skip if symlink already points at the right place.
  if [ -L "${dst}" ] && [ "$(readlink "${dst}")" = "${src}" ]; then
    continue
  fi
  rm -rf "${dst}"
  ln -s "${src}" "${dst}"
done

# 2. Projects dir on the named volume (no-op after first boot).
mkdir -p /repo/projects

# 3. Wire the tunnel URL into PAI_REPO_ROOT.
#    Priority:
#      a. PUBLIC_VIEWER_URL set → write directly (user's stable named tunnel)
#      b. Else → launch a cloudflared quick tunnel as a background process,
#         poll its log for the trycloudflare.com URL, write that into
#         /repo/.tunnel_url. Skills read the file lazily (only video gen
#         currently needs it).
rm -f /repo/.tunnel_url
if [ -n "${PUBLIC_VIEWER_URL:-}" ]; then
  printf '%s\n' "${PUBLIC_VIEWER_URL}" > /repo/.tunnel_url
  echo "[entrypoint] tunnel: using PUBLIC_VIEWER_URL=${PUBLIC_VIEWER_URL}"
elif command -v cloudflared >/dev/null 2>&1; then
  CF_LOG=/tmp/cloudflared.log
  : > "${CF_LOG}"
  # The container is going to be killed cleanly by tini; the background
  # cloudflared inherits SIGTERM forwarding via its parent shell.
  cloudflared tunnel --url http://localhost:7488 \
    --logfile "${CF_LOG}" \
    --no-autoupdate \
    >/dev/null 2>&1 &
  [ "${DEBUG:-}" = "1" ] && echo "[entrypoint] tunnel: cloudflared spawned (pid $!), polling for URL…"
  # Poll asynchronously so the viewer can boot in parallel; video gen
  # will fail with a clear bad_args until the tunnel lands.
  (
    for i in $(seq 1 60); do
      URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${CF_LOG}" 2>/dev/null | head -1)
      if [ -n "${URL}" ]; then
        printf '%s\n' "${URL}" > /repo/.tunnel_url
        # Tunnel URL is always written to .tunnel_url.log for debugging
        # tunnel issues, regardless of DEBUG. Only show in stdout if
        # DEBUG=1 — the URL is internal infrastructure and looks like an
        # instruction to click if it appears in user-facing output.
        echo "[$(date -Iseconds)] tunnel URL: ${URL}" >> /repo/.tunnel_url.log
        [ "${DEBUG:-}" = "1" ] && echo "[entrypoint] tunnel: URL ready after ${i}s — ${URL}"
        exit 0
      fi
      sleep 1
    done
    echo "[entrypoint] tunnel: cloudflared did not produce a URL within 60s; check /tmp/cloudflared.log" >&2
  ) &
else
  echo "[entrypoint] tunnel: cloudflared not installed; video gen will fail until PUBLIC_VIEWER_URL is set"
fi

# 4. Boot the viewer. exec ensures tini → node directly, so SIGTERM lands
#    where the JS shutdown handler can react.
exec node /repo/server/local_viewer.js
