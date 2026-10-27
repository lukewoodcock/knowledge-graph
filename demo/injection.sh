#!/usr/bin/env bash
# Switches context injection on or off for a demo project, by adding or
# removing the UserPromptSubmit hook entry (from examples/) in its
# .claude/settings.json. Takes effect in the next Claude Code session.
#
#   demo/injection.sh <project-dir> on|off [min-score]
#
# min-score sets SWARM_KG_MIN_SCORE in the hook's command; the demo uses
# the value measured against the seed vault (see demo/SCRIPT.md).
set -euo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 2 ] || { echo "usage: demo/injection.sh <project-dir> on|off [min-score]" >&2; exit 1; }
node "$DEMO/wire.mjs" injection "$@"
echo "context injection $2 in $1"
