#!/bin/bash
# Stops the pai-pro viewer + web + tunnel tmux sessions for THIS clone.
#
# Session names are port-suffixed (pai_pro_{viewer,web,tunnel}_<PORT>)
# so we don't kill another clone's sessions. Source .env the same way
# start.sh does to discover the ports.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAI_REPO_ROOT="${PAI_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ -f "$PAI_REPO_ROOT/.env" ]; then
    set -a
    . "$PAI_REPO_ROOT/.env"
    set +a
fi

VIEWER_PORT="${VIEWER_PORT:-7488}"
WEB_PORT="${WEB_PORT:-7443}"

for s in "pai_pro_viewer_${VIEWER_PORT}" "pai_pro_web_${WEB_PORT}" "pai_pro_tunnel_${VIEWER_PORT}"; do
    if tmux has-session -t "$s" 2>/dev/null; then
        echo "Stopping $s"
        tmux kill-session -t "$s"
    else
        echo "$s — not running"
    fi
done

# Clean up tunnel state — the URL is ephemeral and tied to the dead session.
rm -f "$PAI_REPO_ROOT/.tunnel_url" "$PAI_REPO_ROOT/.tunnel_url.${VIEWER_PORT}.log"
