#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).
# Requires: CLAUDE_BRIDGE_TESTING_ALT_MODEL (e.g. "openrouter/z-ai/glm-4.7-flash")

set -euo pipefail
echo "=== smoke-test.sh ==="

if [ -z "${CLAUDE_BRIDGE_TESTING_ALT_MODEL:-}" ]; then
  echo "ERROR: CLAUDE_BRIDGE_TESTING_ALT_MODEL not set (e.g. openrouter/z-ai/glm-4.7-flash)"
  exit 1
fi
ALT_MODEL="$CLAUDE_BRIDGE_TESTING_ALT_MODEL"

# npm prepends node_modules/.bin to PATH, which shadows the system pi
# with the vendored pi-coding-agent (used only for types). Strip it.
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')

TIMEOUT=60
PASS=0
FAIL=0
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$DIR/.test-output"
mkdir -p "$LOGDIR"

# Kill child processes spawned by pi (Agent SDK, node, etc.) that outlive the test.
kill_descendants() {
  pkill -P $$ 2>/dev/null || true
  sleep 1
}
trap kill_descendants EXIT

run() {
  local name="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    echo "$output" > "$logfile"
    if [ -n "$output" ]; then
      echo "PASS"
      ((PASS++))
    else
      echo "FAIL (empty output)"
      echo "  Log: $logfile"
      ((FAIL++))
    fi
  else
    local rc=$?
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit $rc)"
    echo "  Log: $logfile"
    ((FAIL++))
  fi
  kill_descendants
}

# --- Tests ---

run "provider: print mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

run "provider: --provider flag works" \
  pi --no-session -ne -e "$DIR" \
  --provider claude-bridge \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-bridge"

# AskClaude only registers when a non-claude-bridge provider is active
run "tool: AskClaude registered" \
  bash -c "pi --no-session -ne -e '$DIR' --mode json --model '$ALT_MODEL' -p 'list your tools' 2>&1 | grep -q AskClaude && echo ok"

# AskClaude e2e: force a non-Claude model to call the tool and check for a tool result
run "tool: AskClaude responds" \
  bash -c "pi --no-session -ne -e '$DIR' --model '$ALT_MODEL' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>&1 \
    | grep -q '\"toolName\":\"AskClaude\"' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
