#!/usr/bin/env bash
# Creates the demo: two throwaway projects and a demo vault, under one folder.
#
#   demo/setup.sh <demo-dir> [--port 5678] [--force]
#
#   <demo-dir>/shortlinks   project A: a tiny URL shortener (a git repository)
#   <demo-dir>/notes-api    project B: a tiny notes REST API (a git repository)
#   <demo-dir>/vault        the demo vault, reset to the seed (demo/reset.sh)
#   <demo-dir>/demo.env     the paths and service URL, for `source`
#
# Both projects are wired with the example config from examples/: the capture
# hook, the swarm-kg MCP server, the /recall and /remember skills, and
# settings pointing them at the service on --port. Context injection starts
# off in both; switch it with demo/injection.sh. Nothing is written outside
# <demo-dir>. --force recreates projects an earlier setup made.
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DEMO")"
MARKER=".swarm-kg-demo-project"

usage() { echo "usage: demo/setup.sh <demo-dir> [--port <port>] [--force]" >&2; exit 1; }
[ $# -ge 1 ] || usage
TARGET="$1"; shift
PORT=5678
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) usage ;;
  esac
done

for f in dist/hook/stop.js dist/hook/prompt.js dist/mcp/server.js dist/remember.js dist/reindex.js; do
  [ -f "$REPO/$f" ] || { echo "setup: $REPO/$f is missing; run 'npm install && npm run build' first" >&2; exit 1; }
done

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
URL="http://127.0.0.1:$PORT"
VAULT="$TARGET/vault"

# Commits as a throwaway demo identity, never touching the user's git config.
git_demo() { git -c user.name="swarm-kg demo" -c user.email="demo@swarm-kg.invalid" -c commit.gpgsign=false "$@"; }

for name in shortlinks notes-api; do
  dir="$TARGET/$name"
  if [ -e "$dir" ]; then
    if [ "$FORCE" = 1 ] && [ -f "$dir/$MARKER" ]; then
      rm -rf "$dir"
    else
      echo "setup: $dir exists; pass --force to recreate a project setup made" >&2
      exit 1
    fi
  fi
  cp -R "$DEMO/projects/$name" "$dir"
  node "$DEMO/wire.mjs" project "$dir" "$VAULT" "$URL"
  touch "$dir/$MARKER"
  printf '%s\n' "$MARKER" ".claude/settings.local.json" "data/" > "$dir/.gitignore"
  git -C "$dir" init -q -b main
  git_demo -C "$dir" add -A
  git_demo -C "$dir" commit -q -m "Initial $name"
  echo "setup: $dir (project $name) wired to $URL"
done

"$DEMO/reset.sh" "$VAULT"

cat > "$TARGET/demo.env" <<EOF
# source this file: paths and the service URL for the demo in $TARGET
export DEMO_DIR="$TARGET"
export DEMO_VAULT="$VAULT"
export DEMO_A="$TARGET/shortlinks"
export DEMO_B="$TARGET/notes-api"
export SWARM_KG_SERVICE_URL="$URL"
EOF
echo "setup: done. source $TARGET/demo.env, then start the service: demo/service.sh \"$VAULT\" $PORT"
