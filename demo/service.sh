#!/usr/bin/env bash
# Runs the built knowledge-graph service in the foreground against a demo vault and
# the local Ollama, so its console shows each run as it finishes.
#
#   demo/service.sh <vault-dir> [port]
#
# Defaults: port 5678, OLLAMA_URL http://localhost:11434, OLLAMA_MODEL
# qwen3.5:9b, OLLAMA_EMBED_MODEL bge-large, Researcher off. Any of them can be
# overridden from the environment.
set -euo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DEMO")"
[ $# -ge 1 ] || { echo "usage: demo/service.sh <vault-dir> [port]" >&2; exit 1; }
[ -f "$REPO/dist/index.js" ] || { echo "service: run 'npm run build' in $REPO first" >&2; exit 1; }

export VAULT_PATH="$(cd "$1" && pwd)"
export PORT="${2:-${PORT:-5678}}"
export HOST=127.0.0.1
export OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:9b}"
export OLLAMA_EMBED_MODEL="${OLLAMA_EMBED_MODEL:-bge-large}"
export RESEARCHER_ENABLED="${RESEARCHER_ENABLED:-false}"
exec node "$REPO/dist/index.js"
