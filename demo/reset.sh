#!/usr/bin/env bash
# Returns a demo vault to the seed state and rebuilds its embedding index.
#
#   demo/reset.sh <vault-dir> [--url http://127.0.0.1:5678]
#
# Deletes every note in <vault-dir> (keeping Obsidian's own .obsidian folder),
# copies in demo/seed-vault/, and throws the index away. With --url it then
# asks the service running there to rebuild the index from the seed;
# otherwise the service builds it when it next starts.
#
# It only ever wipes a folder that is empty, missing, or marked as a demo
# vault by an earlier reset (.knowledge-graph-demo-vault), so it can't touch a real
# vault. Don't run it while a capture is still being processed.
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DEMO")"
MARKER=".knowledge-graph-demo-vault"

usage() { echo "usage: demo/reset.sh <vault-dir> [--url <service-url>]" >&2; exit 1; }
[ $# -ge 1 ] || usage
VAULT="$1"; shift
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done

mkdir -p "$VAULT"
VAULT="$(cd "$VAULT" && pwd)"
if [ ! -f "$VAULT/$MARKER" ] && [ -n "$(ls -A "$VAULT" | grep -v '^\.obsidian$' || true)" ]; then
  echo "reset: $VAULT has files and is not a demo vault (no $MARKER); refusing to wipe it" >&2
  exit 1
fi

# Everything but Obsidian's settings, so the graph view keeps its layout.
find "$VAULT" -mindepth 1 -maxdepth 1 ! -name .obsidian -exec rm -rf {} +
cp -R "$DEMO/seed-vault/." "$VAULT/"
touch "$VAULT/$MARKER"
echo "reset: $VAULT holds the seed again ($(find "$VAULT" -name '*.md' -not -path '*/.*' | wc -l | tr -d ' ') notes)"

if [ -z "$URL" ]; then
  echo "reset: no service URL given; the index is rebuilt when the service starts"
  exit 0
fi
if ! curl -s -o /dev/null --max-time 2 "$URL/webhook/knowledge-graph/runs/ping"; then
  echo "reset: no service at $URL; the index is rebuilt when the service starts"
  exit 0
fi
KG_SERVICE_URL="$URL" node "$REPO/dist/reindex.js"
