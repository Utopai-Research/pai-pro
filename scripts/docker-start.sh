#!/bin/bash
# pai-pro — Docker launcher/update path.
#
# Pulls the latest repo state, rebuilds the Docker image, and recreates the
# container while preserving the named Docker volumes that hold projects and
# Codex auth/session state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAI_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PAI_REPO_ROOT"

CALLER_PAI_DEFAULT_AGENT_ID_IS_SET=0
CALLER_PAI_DEFAULT_AGENT_ID="${PAI_DEFAULT_AGENT_ID:-}"
if [ "${PAI_DEFAULT_AGENT_ID+x}" = "x" ]; then
    CALLER_PAI_DEFAULT_AGENT_ID_IS_SET=1
fi

normalize_agent_id() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]'
}

load_env() {
    if [ -f "$PAI_REPO_ROOT/.env" ]; then
        set -a
        . "$PAI_REPO_ROOT/.env"
        set +a
    else
        echo "WARNING: .env not found. Copy .env.example to .env and set PAI_KEY before media generation."
    fi

    if [ "$CALLER_PAI_DEFAULT_AGENT_ID_IS_SET" = "1" ]; then
        PAI_DEFAULT_AGENT_ID="$CALLER_PAI_DEFAULT_AGENT_ID"
    fi

    if [ -n "${PAI_AGENT:-}" ]; then
        echo "WARNING: PAI_AGENT is ignored. Use PAI_DEFAULT_AGENT_ID to choose the default owner for new projects."
        unset PAI_AGENT
    fi

    local raw_agent="${PAI_DEFAULT_AGENT_ID:-}"
    PAI_DEFAULT_AGENT_ID="$(normalize_agent_id "$raw_agent")"
    case "$PAI_DEFAULT_AGENT_ID" in
        ""|claude|codex) ;;
        *)
            echo "WARNING: unsupported PAI_DEFAULT_AGENT_ID='${raw_agent}' — new projects will use claude."
            PAI_DEFAULT_AGENT_ID=""
            ;;
    esac
    export PAI_DEFAULT_AGENT_ID
}

pull_latest() {
    if [ ! -d "$PAI_REPO_ROOT/.git" ]; then
        echo "ERROR: $PAI_REPO_ROOT is not a git checkout; cannot pull latest repo state."
        exit 1
    fi

    echo "Pulling latest repo state..."
    git pull --ff-only
}

start_docker() {
    # Keep Docker volume names stable even when launched from a second checkout
    # such as pai-pro-2. This matches the fixed container_name in
    # docker-compose.yml and preserves existing pai-pro_pai_projects data.
    export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pai-pro}"

    echo "Building Docker image..."
    local codex_install_refresh="${CODEX_INSTALL_REFRESH:-$(date -u +%Y%m%d%H%M%S)}"
    docker compose build --pull \
        --build-arg CODEX_VERSION="${CODEX_VERSION:-latest}" \
        --build-arg CODEX_INSTALL_REFRESH="$codex_install_refresh"

    echo "Recreating Docker container..."
    docker compose up -d --force-recreate --remove-orphans
}

print_status() {
    local host_port="${HOST_VIEWER_PORT:-7588}"
    echo ""
    echo "PAI-Pro Docker is starting."
    echo "Open: http://localhost:${host_port}"
    echo ""
    docker compose ps
}

load_env
pull_latest
start_docker
print_status
