#!/usr/bin/env bash
# Switches context injection on or off for a demo project, by adding or
# removing the UserPromptSubmit hook entry (from examples/) in its
# .claude/settings.json. Takes effect in the next Claude Code session.
#
#   demo/injection.sh <project-dir> on|off [min-score]
#
# min-score sets KG_MIN_SCORE in the hook's command: 0.65 unless given,
# the value measured against the seed vault (see demo/SCRIPT.md).
set -euo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 2 ] || { echo "usage: demo/injection.sh <project-dir> on|off [min-score]" >&2; exit 1; }
node "$DEMO/wire.mjs" injection "$1" "$2" "${3:-0.65}"
echo "context injection $2 in $1"
