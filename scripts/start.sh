#!/bin/bash
# pai-pro — local dev launcher.
#
# Launches the canvas viewer (server/local_viewer.js) and the web frontend
# (Vite) in tmux. Ports come from .env (VIEWER_PORT / WEB_PORT); defaults
# 7488 / 7443. The embedded terminal in the right rail runs each project's
# owning agent inside the per-project cwd; no separate shell is needed.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Capture env-set value before we overwrite, so the singleton check can
# detect the "user pre-set PAI_REPO_ROOT to a different checkout" case.
PAI_REPO_ROOT_ENV="${PAI_REPO_ROOT:-}"
PAI_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PAI_REPO_ROOT

# ============================================================================
# Helpers
# ============================================================================

# Install a missing CLI via Homebrew; exit if brew itself isn't installed.
install_brew_pkg() {
    local pkg="$1"
    if ! command -v brew >/dev/null 2>&1; then
        echo "ERROR: Homebrew is required to install $pkg but is not installed."
        echo "  Install Homebrew first: https://brew.sh"
        exit 1
    fi
    echo "Installing $pkg via Homebrew…"
    brew install "$pkg"
}

# ensure_tool <cmd> [pkg]
# Make sure `cmd` is on PATH; install `pkg` (default: `cmd`) via brew if not.
ensure_tool() {
    local cmd="$1"
    local pkg="${2:-$1}"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "$cmd not found — installing…"
        install_brew_pkg "$pkg"
    fi
}

# tmux_ensure_session <session> <command>
# Start a detached tmux session running `command`. The trailing `; read`
# keeps the pane open after the inner process exits — useful for postmortem
# `tmux attach`. No-op if the session already exists.
tmux_ensure_session() {
    local session="$1"
    local cmd="$2"
    if tmux has-session -t "$session" 2>/dev/null; then
        return 0
    fi
    tmux new-session -d -s "$session" "$cmd; read"
}

# wait_until <max_seconds> <cmd...>
# Run `cmd` every 0.5s until it succeeds or `max_seconds` elapses. Each
# failed attempt prints a dot; the caller owns the leading label and the
# trailing newline.
wait_until() {
    local max_seconds="$1"; shift
    local tries=$(( max_seconds * 2 )) i
    for ((i = 0; i < tries; i++)); do
        if "$@"; then
            return 0
        fi
        echo -n "."
        sleep 0.5
    done
    return 1
}

normalize_agent_id() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]'
}

# ============================================================================
# Phases
# ============================================================================

print_banner() {
    echo "============================================================"
    echo "pai-pro — local dev"
    echo "============================================================"
}

preflight_tools() {
    ensure_tool node
    ensure_tool tmux
    ensure_tool cloudflared
    ensure_tool pdftotext poppler
}

# Refuse to run if another pai-pro checkout already owns this port. Two
# checkouts on the same port would share $PAI_REPO_ROOT/.tunnel_url —
# writes from this checkout would clobber the live URL from the other,
# and video gen would 530 from a dead host. The contract is per-port
# (different VIEWER_PORTs are independent stacks).
#
# Must run after derive_config so VIEWER_PORT/WEB_PORT are resolved.
require_singleton_checkout() {
    if [ -n "$PAI_REPO_ROOT_ENV" ] && [ "$PAI_REPO_ROOT_ENV" != "$PAI_REPO_ROOT" ]; then
        echo "ERROR: PAI_REPO_ROOT='${PAI_REPO_ROOT_ENV}' doesn't match this checkout at '${PAI_REPO_ROOT}'."
        echo "  Fix: cd \$PAI_REPO_ROOT && ./scripts/start.sh   (or unset PAI_REPO_ROOT if this IS the active checkout)"
        exit 1
    fi

    local conflicts=() session cwd
    while IFS= read -r session; do
        cwd=$(tmux list-panes -t "$session" -F "#{pane_current_path}" 2>/dev/null | head -1)
        # Web sessions cd into $PAI_REPO_ROOT/web before starting Vite —
        # strip /web so we compare apples-to-apples with PAI_REPO_ROOT.
        # Empty cwd means the working directory was unlinked under the
        # running process (e.g., the checkout was moved to ~/.Trash without
        # stopping the session), which is still a zombie binding our port.
        cwd="${cwd%/web}"
        if [ "$cwd" != "$PAI_REPO_ROOT" ]; then
            if [ -z "$cwd" ]; then
                conflicts+=("  $session  →  (zombie — kill with: tmux kill-session -t $session)")
            else
                conflicts+=("  $session  →  $cwd")
            fi
        fi
    done < <(tmux list-sessions -F "#{session_name}" 2>/dev/null \
             | grep -E "^pai_pro_(viewer|tunnel)_${VIEWER_PORT}\$|^pai_pro_web_${WEB_PORT}\$" \
             || true)

    if [ "${#conflicts[@]}" -gt 0 ]; then
        echo "ERROR: another pai-pro checkout already owns ports ${VIEWER_PORT}/${WEB_PORT}:"
        printf '%s\n' "${conflicts[@]}"
        echo ""
        echo "  This checkout: $PAI_REPO_ROOT"
        echo "  Two checkouts can't share a port — they'd drift on .tunnel_url."
        echo ""
        echo "  Fix one of:"
        echo "    • cd <other checkout> && ./scripts/start.sh   (use that one as active)"
        echo "    • cd <other checkout> && ./scripts/stop.sh    (then re-run ./scripts/start.sh here)"
        echo "    • Change VIEWER_PORT in this checkout's .env to run alongside the other"
        exit 1
    fi
}

sync_skills() {
    # Run setup every time so skills are always linked at THIS checkout, even
    # if ~/.claude/skills/<name> already has a dangling or foreign-checkout
    # symlink from another clone. --force re-links anything whose target
    # isn't us; already-correct symlinks short-circuit to "ok" with no rewrite.
    echo "Syncing agent setup…"
    if [ "$PAI_DEFAULT_AGENT_ID" = "codex" ]; then
        "$SCRIPT_DIR/setup" --agent claude --force
        echo ""
        "$SCRIPT_DIR/setup" --agent codex
    else
        "$SCRIPT_DIR/setup" --agent all --force
    fi
}

load_env() {
    if [ ! -f "$PAI_REPO_ROOT/.env" ]; then
        echo "⚠️  .env not found. Copy .env.example → .env and fill PAI_KEY"
        echo "    (one key for image + video + voice + asset upload) before you"
        echo "    trigger any media-generation skill. The viewer alone runs"
        echo "    without it."
        return
    fi
    set -a
    . "$PAI_REPO_ROOT/.env"
    set +a

    # Interactive PAI_KEY prompt — catches users who only ran
    # `cp .env.example .env` (the old README on-ramp) and never filled
    # the key. Skip in non-TTY contexts (CI, scripted setup) where
    # the user can't respond to a prompt.
    if [ -z "${PAI_KEY:-}" ] && [ -t 0 ]; then
        echo ""
        echo "PAI_KEY isn't set in your .env yet."
        echo "Get a key at https://pai-pro.utopaistudios.com/keys (format: PAI_<random>)."
        printf "Paste your PAI_KEY here (or Ctrl+C to abort): "
        read -r PAI_KEY
        if [ -z "$PAI_KEY" ]; then
            echo "ERROR: PAI_KEY still empty; aborting."
            exit 1
        fi
        # Replace the existing PAI_KEY= line in place (sed -i.bak then rm
        # the .bak — portable across BSD/macOS sed and GNU/Linux sed).
        # Both parsers (bash source + dotenv pkg) honor last-occurrence,
        # but in-place replacement keeps .env clean for users who later
        # edit it manually.
        sed -i.bak "s|^PAI_KEY=.*|PAI_KEY=$PAI_KEY|" "$PAI_REPO_ROOT/.env" && \
            rm -f "$PAI_REPO_ROOT/.env.bak"
        export PAI_KEY
        echo "Saved to .env. Continuing boot."
        echo ""
    fi
}

derive_config() {
    # Ports — overridable via .env; defaults are 7488 / 7443. Derive the
    # cross-process URLs so both children (viewer + Vite) see them.
    VIEWER_PORT="${VIEWER_PORT:-7488}"
    WEB_PORT="${WEB_PORT:-7443}"
    if [ -n "${PAI_AGENT:-}" ]; then
        echo "WARNING: PAI_AGENT is ignored. Use PAI_DEFAULT_AGENT_ID to choose the default owner for new projects."
        unset PAI_AGENT
    fi
    PAI_DEFAULT_AGENT_ID_RAW="${PAI_DEFAULT_AGENT_ID:-}"
    PAI_DEFAULT_AGENT_ID="$(normalize_agent_id "$PAI_DEFAULT_AGENT_ID_RAW")"
    case "$PAI_DEFAULT_AGENT_ID" in
        ""|claude) PAI_DEFAULT_AGENT_DISPLAY="claude" ;;
        codex) PAI_DEFAULT_AGENT_DISPLAY="codex" ;;
        *)
            echo "WARNING: unsupported PAI_DEFAULT_AGENT_ID='${PAI_DEFAULT_AGENT_ID_RAW}' — new projects will use claude."
            PAI_DEFAULT_AGENT_ID=""
            PAI_DEFAULT_AGENT_DISPLAY="claude"
            ;;
    esac
    export VIEWER_PORT WEB_PORT PAI_DEFAULT_AGENT_ID
    export WEB_ORIGIN="http://localhost:${WEB_PORT}"
    export VITE_VIEWER_URL="http://localhost:${VIEWER_PORT}"

    # Session names include the port so two clones with different .env values
    # get distinct tmux sessions instead of one stomping the other.
    VIEWER_SESSION="pai_pro_viewer_${VIEWER_PORT}"
    WEB_SESSION="pai_pro_web_${WEB_PORT}"
    TUNNEL_SESSION="pai_pro_tunnel_${VIEWER_PORT}"
    TUNNEL_URL_FILE="$PAI_REPO_ROOT/.tunnel_url"
    # Port-suffix the log so a stale `tee` from a prior port can't keep
    # an FD open on the same path and corrupt the new log with NUL holes.
    TUNNEL_LOG_FILE="$PAI_REPO_ROOT/.tunnel_url.${VIEWER_PORT}.log"
}

install_deps() {
    if [ ! -d "$PAI_REPO_ROOT/server/node_modules" ]; then
        echo "Installing server deps…"
        (cd "$PAI_REPO_ROOT/server" && npm install)
    fi
    if [ ! -d "$PAI_REPO_ROOT/web/node_modules" ]; then
        echo "Installing web deps…"
        (cd "$PAI_REPO_ROOT/web" && npm install)
    fi
}

# ---- tunnel ---------------------------------------------------------------
# PAI's `video-generation-assets` endpoint fetches video refs server-side and can't
# reach localhost. We expose the viewer's /projects/:id/assets/... routes
# via a free Cloudflare quick tunnel and write the URL to .tunnel_url;
# local_mirror.js reads from there. Override the auto-launch by setting
# PUBLIC_VIEWER_URL in .env.

# Kill a tunnel session whose state is no longer trustworthy. The tmux
# session can outlive the cloudflared process inside it (pane stays in
# `; read` after the process exits) and .tunnel_url can disappear
# independently — either condition is unrecoverable in place.
reap_stale_tunnel() {
    tmux has-session -t "$TUNNEL_SESSION" 2>/dev/null || return 0
    if ! pgrep -f "cloudflared tunnel --url http://localhost:${VIEWER_PORT}" >/dev/null 2>&1; then
        echo "Tunnel session '$TUNNEL_SESSION' is stale (cloudflared exited) — restarting."
        tmux kill-session -t "$TUNNEL_SESSION" 2>/dev/null || true
        rm -f "$TUNNEL_URL_FILE"
    elif [ ! -s "$TUNNEL_URL_FILE" ]; then
        # cloudflared only prints the URL banner once at registration, so
        # if .tunnel_url is gone we can't recover it — rebuild for a fresh URL.
        echo "Tunnel session '$TUNNEL_SESSION' is alive but .tunnel_url is missing — restarting to re-write the URL."
        tmux kill-session -t "$TUNNEL_SESSION" 2>/dev/null || true
    fi
}

# Used as the wait_until test predicate while the cloudflared log is being
# written. Captures the first trycloudflare URL it sees into .tunnel_url.
_grep_tunnel_url_to_file() {
    local url
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG_FILE" 2>/dev/null | head -1)
    [ -n "$url" ] || return 1
    echo "$url" > "$TUNNEL_URL_FILE"
    return 0
}

launch_tunnel() {
    echo "Starting cloudflared tunnel for port $VIEWER_PORT…"
    : > "$TUNNEL_LOG_FILE"
    rm -f "$TUNNEL_URL_FILE"
    tmux_ensure_session "$TUNNEL_SESSION" \
        "cloudflared tunnel --url http://localhost:${VIEWER_PORT} 2>&1 | tee '${TUNNEL_LOG_FILE}'"

    echo -n "  Waiting for tunnel URL"
    if ! wait_until 30 _grep_tunnel_url_to_file; then
        echo ""
        echo "ERROR: cloudflared tunnel did not come up in 30s."
        echo "  Video generation needs a publicly-fetchable URL for PAI's"
        echo "  video-generation-assets endpoint to pull refs from, so this is a hard"
        echo "  prerequisite — the server won't start."
        echo ""
        echo "  Diagnose: tmux attach -t $TUNNEL_SESSION   (then Ctrl-b d to detach)"
        echo "  Common causes:"
        echo "    • trycloudflare.com is having an outage — retry in a minute"
        echo "    • UDP/QUIC blocked on your network — add '--protocol http2' to"
        echo "      the cloudflared command in scripts/start.sh"
        echo "    • cloudflared is outdated — 'brew upgrade cloudflared'"
        echo "  Workaround: run a named Cloudflare tunnel and set"
        echo "    PUBLIC_VIEWER_URL=https://your.named.tunnel in .env"
        exit 1
    fi
    echo " $(cat "$TUNNEL_URL_FILE")"
}

ensure_tunnel() {
    reap_stale_tunnel
    if [ -n "${PUBLIC_VIEWER_URL:-}" ]; then
        echo "Tunnel: using PUBLIC_VIEWER_URL from .env (${PUBLIC_VIEWER_URL})"
        echo "$PUBLIC_VIEWER_URL" > "$TUNNEL_URL_FILE"
    elif tmux has-session -t "$TUNNEL_SESSION" 2>/dev/null; then
        echo "Tunnel session '$TUNNEL_SESSION' already running."
    else
        launch_tunnel
    fi
}

# ---- services -------------------------------------------------------------

smoke_check_clis() {
    echo "Smoke-checking CLIs…"
    local script out
    for script in generate_image generate_image_pro generate_video generate_voice split_image switch_project; do
        out=$(cd "$PAI_REPO_ROOT" && node "server/cli/${script}.js" 2>/dev/null || true)
        if echo "$out" | grep -q '"ok":false,"klass":"bad_args"'; then
            echo "  OK  ${script}.js"
        else
            echo "  ERR ${script}.js — unexpected output: ${out:0:120}"
        fi
    done
}

start_viewer() {
    if tmux has-session -t "$VIEWER_SESSION" 2>/dev/null; then
        echo "Viewer session '$VIEWER_SESSION' already running — leaving as-is."
        if [ -n "$PAI_DEFAULT_AGENT_ID" ]; then
            echo "  PAI_DEFAULT_AGENT_ID only applies when a new viewer starts; run ./scripts/stop.sh first to change it."
        fi
        return
    fi
    echo "Starting viewer (port $VIEWER_PORT) in tmux…"
    # tmux strips most parent env vars; inline what the viewer needs that
    # isn't already in .env (WEB_ORIGIN is derived from WEB_PORT here).
    # PAI_DEFAULT_AGENT_ID / PAI_AGENT_BYPASS may come from a one-shot prefix
    # (e.g. `PAI_AGENT_BYPASS=0 ./scripts/start.sh`) or .env, so pass them
    # explicitly too.
    tmux_ensure_session "$VIEWER_SESSION" \
        "cd ${PAI_REPO_ROOT} && WEB_ORIGIN='${WEB_ORIGIN}' VIEWER_PORT='${VIEWER_PORT}' PAI_DEFAULT_AGENT_ID='${PAI_DEFAULT_AGENT_ID}' PAI_AGENT_BYPASS='${PAI_AGENT_BYPASS:-}' node --watch server/local_viewer.js"
}

start_web() {
    if tmux has-session -t "$WEB_SESSION" 2>/dev/null; then
        echo "Web session '$WEB_SESSION' already running — leaving as-is."
        return
    fi
    echo "Starting web (port $WEB_PORT) in tmux…"
    # Inline env into the tmux command — tmux's default new-session env strips
    # custom vars, so vite.config.ts wouldn't see WEB_PORT and the web bundle
    # wouldn't see VITE_VIEWER_URL otherwise.
    tmux_ensure_session "$WEB_SESSION" \
        "cd ${PAI_REPO_ROOT}/web && WEB_PORT='${WEB_PORT}' VITE_VIEWER_URL='${VITE_VIEWER_URL}' npm run dev"
}

# ---- verification ---------------------------------------------------------

# wait_for_local_port <label> <port> <session>
# Curl http://localhost:<port>/ until it answers. Hard-exit on timeout with
# a hint pointing at the tmux session that should be hosting it.
wait_for_local_port() {
    local label="$1" port="$2" session="$3"
    echo -n "Waiting for ${label} to listen on :${port}"
    if ! wait_until 10 curl -sf -o /dev/null "http://localhost:${port}/"; then
        echo ""
        echo "ERROR: ${label} did not come up on port ${port}."
        echo "  Check: tmux attach -t $session"
        exit 1
    fi
    echo ""
}

# Used as the wait_until predicate when waiting for DNS to propagate.
# Writes the resolved A record into TUNNEL_IP for the caller.
_resolve_tunnel_ip() {
    TUNNEL_IP=$(dig +short +time=2 +tries=1 @1.1.1.1 "$TUNNEL_HOST" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
    [ -n "$TUNNEL_IP" ]
}

# End-to-end tunnel probe. cloudflared printing "Registered tunnel connection"
# means it's talking to Cloudflare's edge — it does NOT mean DNS for the new
# subdomain has propagated, or that the edge is routing traffic back to the
# local viewer. We refuse to declare "Ready" until a real request through the
# tunnel reaches the local server.
#
# We resolve via Cloudflare's public resolver (1.1.1.1) and pin the IP with
# curl --resolve, instead of relying on the OS resolver. This matches what
# PAI's server-side fetcher experiences: fresh trycloudflare subdomains are
# visible on Cloudflare's authoritative DNS within seconds, while consumer
# routers/ISPs can lag a minute or more. Probing through 1.1.1.1 makes the
# check converge on what actually matters for video refs — and if 1.1.1.1
# can't see it after our retry budget, neither can PAI, so it's a real fail.
verify_tunnel_reachable() {
    if [ ! -s "$TUNNEL_URL_FILE" ]; then
        echo "ERROR: .tunnel_url is missing after tunnel setup — refusing to declare Ready."
        echo "  Recover: ./scripts/stop.sh && ./scripts/start.sh"
        exit 1
    fi
    TUNNEL_URL_VAL="$(cat "$TUNNEL_URL_FILE")"
    TUNNEL_HOST="${TUNNEL_URL_VAL#https://}"
    TUNNEL_HOST="${TUNNEL_HOST%%/*}"

    echo -n "Resolving tunnel ${TUNNEL_HOST} via 1.1.1.1"
    if ! wait_until 30 _resolve_tunnel_ip; then
        echo ""
        echo "ERROR: tunnel hostname ${TUNNEL_HOST} did not resolve via 1.1.1.1 in 30s."
        echo "  Cloudflare's authoritative DNS doesn't see this subdomain yet, which"
        echo "  means PAI won't be able to fetch refs through it either."
        echo "  Recover: ./scripts/stop.sh && ./scripts/start.sh   (forces a fresh tunnel URL)"
        exit 1
    fi
    echo " → $TUNNEL_IP"

    echo -n "Probing tunnel end-to-end"
    if ! wait_until 30 curl -sf -m 3 --resolve "${TUNNEL_HOST}:443:${TUNNEL_IP}" -o /dev/null "${TUNNEL_URL_VAL}/"; then
        echo ""
        echo "ERROR: tunnel ${TUNNEL_URL_VAL} resolved but is not routing to the local viewer."
        echo "  Cloudflare's edge isn't forwarding to localhost:${VIEWER_PORT} — the tunnel"
        echo "  is broken on cloudflared's side. Diagnose:"
        echo "    tmux attach -t $TUNNEL_SESSION"
        echo "    curl -v --resolve ${TUNNEL_HOST}:443:${TUNNEL_IP} ${TUNNEL_URL_VAL}/"
        echo "  Recover: ./scripts/stop.sh && ./scripts/start.sh"
        exit 1
    fi
    echo ""
}

# ---- finale ---------------------------------------------------------------

print_ready_banner() {
    echo ""
    echo "============================================================"
    echo "Ready."
    echo "============================================================"
    echo ""
    echo "  Viewer:   http://localhost:${VIEWER_PORT}/projects"
    echo "  Web UI:   http://localhost:${WEB_PORT}/"
    if [ -s "$TUNNEL_URL_FILE" ]; then
        echo "  Tunnel:   $(cat "$TUNNEL_URL_FILE")   (rotates on restart)"
    fi
    echo ""
    echo "  New project agent default: ${PAI_DEFAULT_AGENT_DISPLAY}"
    echo ""
    echo "  Attach:   tmux attach -t $VIEWER_SESSION"
    echo "            tmux attach -t $WEB_SESSION"
    if tmux has-session -t "$TUNNEL_SESSION" 2>/dev/null; then
        echo "            tmux attach -t $TUNNEL_SESSION"
    fi
    echo "  Stop:     ./scripts/stop.sh"
    echo "============================================================"
}

# ============================================================================
# main
# ============================================================================

main() {
    print_banner
    preflight_tools
    load_env
    derive_config
    require_singleton_checkout
    sync_skills
    install_deps
    ensure_tunnel
    smoke_check_clis
    start_viewer
    wait_for_local_port "viewer" "$VIEWER_PORT" "$VIEWER_SESSION"
    verify_tunnel_reachable
    start_web
    wait_for_local_port "web"    "$WEB_PORT"    "$WEB_SESSION"
    print_ready_banner
}

main "$@"
