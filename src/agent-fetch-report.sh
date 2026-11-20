#!/usr/bin/env bash
# agent-fetch-report.sh — did the agent pick the local fetch stack or a paid API?
#
# Reads the provider-choice log written by the degradation-status extension
# ($XDG_STATE_HOME/agent-events/provider-choice.jsonl, one JSONL line per
# web_search / fetch_local call) and prints the routing verdict.
#
# Read-only. No secret values (the log carries tool name, cwd and timestamp only).
#
# Usage: scripts/agent-fetch-report.sh [--log PATH] [--json]
# Exit: 0 always (a report is never a gate); 2 on unknown flag.
set -uo pipefail

LOG="${FETCH_CHOICE_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-events/provider-choice.jsonl}"
MODE="text"

while [ $# -gt 0 ]; do
  case "$1" in
    --log) LOG="${2:-}"; shift 2 ;;
    --json) MODE="json"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "agent-fetch-report: unknown flag '$1' (see --help)" >&2; exit 2 ;;
  esac
done

if [ ! -r "$LOG" ]; then
  echo "agent-fetch-report: no choice log at $LOG" >&2
  echo "  (it appears once the degradation-status extension records a web_search or fetch_local call)"
  exit 0
fi

command -v jq >/dev/null || { echo "agent-fetch-report: jq is required" >&2; exit 0; }

total=$(jq -s 'length' "$LOG" 2>/dev/null || echo 0)
local_n=$(jq -s '[.[] | select(.tool | test("^fetch_local$"; "i"))] | length' "$LOG" 2>/dev/null || echo 0)
paid_n=$(jq -s '[.[] | select(.tool | test("^web_?search$"; "i"))] | length' "$LOG" 2>/dev/null || echo 0)
paid_err=$(jq -s '[.[] | select((.tool | test("^web_?search$"; "i")) and .ok == false)] | length' "$LOG" 2>/dev/null || echo 0)
first=$(jq -rs 'map(.ts) | min // "-"' "$LOG" 2>/dev/null || echo "-")
last=$(jq -rs 'map(.ts) | max // "-"' "$LOG" 2>/dev/null || echo "-")

if [ "$MODE" = "json" ]; then
  jq -n --arg log "$LOG" --argjson total "$total" --argjson local "$local_n" \
        --argjson paid "$paid_n" --argjson paid_err "$paid_err" \
        --arg first "$first" --arg last "$last" \
        '{log: $log, total: $total, local: $local, paid: $paid, paid_errors: $paid_err, first: $first, last: $last}'
  exit 0
fi

pct="n/a"
if [ "$((local_n + paid_n))" -gt 0 ]; then
  pct=$(( local_n * 100 / (local_n + paid_n) ))
fi

cat <<EOF
provider-choice report
  log:        $LOG
  window:     $first .. $last
  total:      $total calls
  local:      $local_n  (fetch_local)
  paid:       $paid_n  (web_search), of which $paid_err errored
  local share: ${pct}%
EOF

if [ "$((local_n + paid_n))" -eq 0 ]; then
  echo "  verdict: no data yet"
elif [ "$pct" -ge 80 ]; then
  echo "  verdict: local-first is holding"
elif [ "$pct" -ge 40 ]; then
  echo "  verdict: mixed — doctrine is only half-respected"
else
  echo "  verdict: paid-first — the doctrine is not being followed"
fi