#!/bin/sh
# pai-pro — container entrypoint.
#
# Boot tasks before exec'ing the viewer:
#   1. Link in-image skills into ~/.claude/skills (idempotent).
#   2. Ensure the projects dir and Codex state dir exist.
#   3. Verify the selected agent CLI is available.
#   4. Verify PUBLIC_VIEWER_URL or a quick tunnel before showing the web UI.
#   5. Warn if PAI_KEY is absent.
#   6. Hand off to node with exec so tini sees node directly.
set -e

CLAUDE_DIR="${HOME}/.claude"
CODEX_DIR="${HOME}/.codex"
CODEX_HOST_DIR="${HOME}/.codex-host"

normalize_agent_id() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]'
}

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

# 2. Projects dir on the named volume and Docker-owned Codex state dir.
mkdir -p /repo/projects
if ! mkdir -p "${CODEX_DIR}" 2>/dev/null; then
  echo "[entrypoint] warning: could not create ${CODEX_DIR}; Codex auth/state may be unavailable" >&2
fi
if [ -f "${CODEX_HOST_DIR}/auth.json" ] && [ ! -f "${CODEX_DIR}/auth.json" ]; then
  if cp "${CODEX_HOST_DIR}/auth.json" "${CODEX_DIR}/auth.json" 2>/dev/null; then
    chmod 600 "${CODEX_DIR}/auth.json" 2>/dev/null || true
    echo "[entrypoint] codex auth: imported host auth.json into Docker Codex home"
  else
    echo "[entrypoint] warning: could not import ${CODEX_HOST_DIR}/auth.json; run codex login in Docker if needed" >&2
  fi
fi

PAI_DEFAULT_AGENT_ID_RAW="${PAI_DEFAULT_AGENT_ID:-}"
SELECTED_AGENT="$(normalize_agent_id "${PAI_DEFAULT_AGENT_ID_RAW}")"
case "${SELECTED_AGENT}" in
  ""|claude)
    SELECTED_AGENT="claude"
    ;;
  codex)
    ;;
  *)
    echo "[entrypoint] warning: unsupported PAI_DEFAULT_AGENT_ID='${PAI_DEFAULT_AGENT_ID_RAW}'; defaulting new projects to claude" >&2
    SELECTED_AGENT="claude"
    ;;
esac
export PAI_DEFAULT_AGENT_ID="${SELECTED_AGENT}"
echo "[entrypoint] selected default agent: ${SELECTED_AGENT}"

log_cli() {
  name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "[entrypoint] ${name} CLI: missing" >&2
    return 1
  fi
  version="$("${name}" --version 2>&1 || true)"
  echo "[entrypoint] ${name} CLI: ${version}"
  return 0
}

CLAUDE_OK=0
CODEX_OK=0
if log_cli claude; then CLAUDE_OK=1; fi
if log_cli codex; then CODEX_OK=1; fi

if [ "${SELECTED_AGENT}" = "claude" ] && [ "${CLAUDE_OK}" -ne 1 ]; then
  echo "[entrypoint] selected agent is claude but claude CLI is unavailable; refusing to boot" >&2
  exit 1
fi
if [ "${SELECTED_AGENT}" = "codex" ] && [ "${CODEX_OK}" -ne 1 ]; then
  echo "[entrypoint] selected agent is codex but codex CLI is unavailable; refusing to boot" >&2
  exit 1
fi
if [ "${SELECTED_AGENT}" = "codex" ] && [ ! -w "${CODEX_DIR}" ]; then
  echo "[entrypoint] selected agent is codex but ${CODEX_DIR} is not writable by UID $(id -u); refusing to boot" >&2
  exit 1
elif [ ! -w "${CODEX_DIR}" ]; then
  echo "[entrypoint] warning: ${CODEX_DIR} is not writable by UID $(id -u); Codex sessions may not persist" >&2
fi

wait_until() {
  max_seconds="$1"
  shift
  i=0
  while [ "$i" -lt "$max_seconds" ]; do
    if "$@"; then
      return 0
    fi
    printf "."
    i=$((i + 1))
    sleep 1
  done
  return 1
}

start_probe_server() {
  node -e 'require("http").createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("pai-pro tunnel probe\n")}).listen(7488,"127.0.0.1")' &
  PROBE_PID="$!"
  if ! wait_until 10 curl -sf -o /dev/null http://127.0.0.1:7488/; then
    echo "" >&2
    echo "[entrypoint] tunnel: local probe server did not start on 127.0.0.1:7488" >&2
    exit 1
  fi
  echo ""
}

stop_probe_server() {
  if [ -n "${PROBE_PID:-}" ]; then
    kill "${PROBE_PID}" 2>/dev/null || true
    wait "${PROBE_PID}" 2>/dev/null || true
    unset PROBE_PID
  fi
}

normalize_tunnel_url() {
  node -e 'const u = new URL(process.argv[1]); process.stdout.write(u.origin)' "$1"
}

resolve_tunnel_ip() {
  TUNNEL_IP=$(node -e 'const { Resolver } = require("dns").promises; const r = new Resolver(); r.setServers(["1.1.1.1"]); r.resolve4(process.argv[1]).then((ips) => { if (!ips[0]) process.exit(1); process.stdout.write(ips[0]); }).catch(() => process.exit(1));' "$TUNNEL_HOST" 2>/dev/null)
  [ -n "${TUNNEL_IP}" ]
}

probe_tunnel() {
  TUNNEL_PORT=$(node -e 'const u = new URL(process.argv[1]); process.stdout.write(u.port || (u.protocol === "https:" ? "443" : "80"))' "$TUNNEL_URL")
  curl -sf -m 3 --resolve "${TUNNEL_HOST}:${TUNNEL_PORT}:${TUNNEL_IP}" -o /dev/null "${TUNNEL_URL}/"
}

verify_tunnel_reachable() {
  TUNNEL_URL="$(cat /repo/.tunnel_url)"
  TUNNEL_HOST=$(node -e 'const u = new URL(process.argv[1]); process.stdout.write(u.hostname)' "$TUNNEL_URL")

  echo -n "[entrypoint] tunnel: resolving ${TUNNEL_HOST} via 1.1.1.1"
  if ! wait_until 30 resolve_tunnel_ip; then
    echo "" >&2
    echo "[entrypoint] tunnel: ${TUNNEL_HOST} did not resolve via 1.1.1.1; refusing to start the web UI" >&2
    exit 1
  fi
  echo " -> ${TUNNEL_IP}"

  echo -n "[entrypoint] tunnel: probing end-to-end"
  if ! wait_until 30 probe_tunnel; then
    echo "" >&2
    echo "[entrypoint] tunnel: ${TUNNEL_URL} resolved but did not route to the local viewer; refusing to start the web UI" >&2
    exit 1
  fi
  echo ""
}
trap stop_probe_server EXIT

# 4. Wire and verify the tunnel URL before the production viewer boots.
#    The viewer serves the web UI in Docker, so this entrypoint owns the
#    "don't show the browser URL until refs are publicly reachable" gate.
rm -f /repo/.tunnel_url
start_probe_server
if [ -n "${PUBLIC_VIEWER_URL:-}" ]; then
  TUNNEL_URL="$(normalize_tunnel_url "${PUBLIC_VIEWER_URL}")"
  printf '%s\n' "${TUNNEL_URL}" > /repo/.tunnel_url
  echo "[entrypoint] tunnel: using PUBLIC_VIEWER_URL=${TUNNEL_URL}"
elif command -v cloudflared >/dev/null 2>&1; then
  CF_LOG=/tmp/cloudflared.log
  : > "${CF_LOG}"
  # The real viewer will bind 0.0.0.0:7488 after this probe exits. During
  # setup, a tiny local server occupies the same port so cloudflared can be
  # tested end-to-end before users see the web UI.
  cloudflared tunnel --url http://127.0.0.1:7488 \
    --logfile "${CF_LOG}" \
    --no-autoupdate \
    >/dev/null 2>&1 &
  [ "${DEBUG:-}" = "1" ] && echo "[entrypoint] tunnel: cloudflared spawned (pid $!), polling for URL..."

  echo -n "[entrypoint] tunnel: waiting for URL"
  for i in $(seq 1 60); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${CF_LOG}" 2>/dev/null | head -1)
    if [ -n "${URL}" ]; then
      TUNNEL_URL="$(normalize_tunnel_url "${URL}")"
      printf '%s\n' "${TUNNEL_URL}" > /repo/.tunnel_url
      # Tunnel URL is always written to .tunnel_url.log for debugging
      # tunnel issues, regardless of DEBUG. Only show in stdout if
      # DEBUG=1 — the URL is internal infrastructure and looks like an
      # instruction to click if it appears in user-facing output.
      echo "[$(date -Iseconds)] tunnel URL: ${TUNNEL_URL}" >> /repo/.tunnel_url.log
      [ "${DEBUG:-}" = "1" ] && echo " ${TUNNEL_URL}"
      break
    fi
    printf "."
    sleep 1
  done
  if [ ! -s /repo/.tunnel_url ]; then
    echo "" >&2
    echo "[entrypoint] tunnel: cloudflared did not produce a URL within 60s; check /tmp/cloudflared.log" >&2
    exit 1
  fi
else
  echo "[entrypoint] tunnel: cloudflared not installed and PUBLIC_VIEWER_URL is unset; refusing to start the web UI" >&2
  exit 1
fi
verify_tunnel_reachable
stop_probe_server

# 5. PAI_KEY warn-but-don't-block. `docker compose up` has no TTY for an
#    interactive prompt; the next-best onboarding hint is a loud message
#    before the viewer boots so the user knows why generation later
#    fails. Canvas, terminal, project switching all work without a key —
#    only media CLIs need it. We don't exit here.
if [ -z "${PAI_KEY:-}" ]; then
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "  PAI_KEY is not set."
    echo ""
    echo "  Media generation will fail until you set it. Add one to your"
    echo "  .env (next to docker-compose.yml) and restart:"
    echo ""
    echo "    echo \"PAI_KEY=PAI_yourkey\" >> .env"
    echo "    docker compose restart"
    echo ""
    echo "  Get a key: https://pai-pro.utopaistudios.com/keys"
    echo "════════════════════════════════════════════════════════════════"
    echo ""
fi

# 6. Boot the viewer. exec ensures tini -> node directly, so SIGTERM lands
#    where the JS shutdown handler can react.
exec node /repo/server/local_viewer.js
