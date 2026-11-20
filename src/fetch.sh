#!/usr/bin/env bash
# fetch.sh — one-command local-first web fetching (fetch-strategy L0/L2/L3).
#   fetch.sh search "query"   -> SearXNG JSON envelope on stdout
#   fetch.sh scrape URL       -> CRW JSON envelope on stdout
# Paid path: none. Budget-zero is enforced here, not just in doctrine.
set -euo pipefail

SEARXNG_URL="${SEARXNG_URL:-http://127.0.0.1:8080}"
CRW_URL="${CRW_URL:-http://127.0.0.1:3001}"
FETCH_TIMEOUT="${FETCH_TIMEOUT:-30}"
CACHE_DIR="${FETCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/fetch-stack}"
TTL=86400
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
FETCH_LOG="${FETCH_LOG:-$STATE_HOME/fetch-stack/calls.log}"

ms_since() {
  echo $(( ($(date +%s%N) - $1) / 1000000 ))
}

log_call() { # $1=cmd $2=arg $3=layer $4=results $5=latency_ms $6=exit — never fails the call
  local dir
  dir="$(dirname "$FETCH_LOG")"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"ts":"%s","cmd":%s,"arg":%s,"layer":"%s","results":%s,"latency_ms":%s,"exit":%s}\n' \
    "$(date -u +%FT%TZ)" "$(jq -n --arg c "$1" '$c')" "$(jq -n --arg a "$2" '$a')" \
    "$3" "$4" "$5" "$6" >>"$FETCH_LOG" 2>/dev/null || true
}

usage() {
  echo "usage: fetch.sh search \"query\" | fetch.sh scrape URL" >&2
  exit 2
}

cache_key() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

cache_get() {
  local f
  f="$CACHE_DIR/$(cache_key "$1")"
  if [ -f "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt "$TTL" ]; then
    cat "$f"
    return 0
  fi
  return 1
}

cache_put() {
  mkdir -p "$CACHE_DIR"
  printf '%s' "$2" > "$CACHE_DIR/$(cache_key "$1")"
}

exhausted() {
  echo "all local layers exhausted; paid path requires explicit budget (see fetch-strategy skill)" >&2
  exit 1
}

cmd_search() {
  local query="$1"
  local key="search:$query" cached body n out t0
  t0=$(date +%s%N)
  if cached="$(cache_get "$key")"; then
    n="$(printf '%s' "$cached" | jq -r '.results | length' 2>/dev/null || printf '0')"
    printf '%s\n' "$cached"
    log_call "search" "$query" "L0" "$n" "$(ms_since "$t0")" 0
    return 0
  fi
  if ! body="$(curl -fsS --max-time "$FETCH_TIMEOUT" --get \
      --data-urlencode "q=$query" --data-urlencode "format=json" \
      "$SEARXNG_URL/search" 2>/dev/null)"; then
    log_call "search" "$query" "L3" 0 "$(ms_since "$t0")" 1
    exhausted
  fi
  n="$(printf '%s' "$body" | jq -r '.results | length' 2>/dev/null || printf '0')"
  if [ "$n" -eq 0 ]; then
    log_call "search" "$query" "L3" 0 "$(ms_since "$t0")" 1
    exhausted
  fi
  out="$(printf '%s' "$body" | jq -c '{query, results: [.results[] | {title, url, content}]}')"
  cache_put "$key" "$out"
  printf '%s\n' "$out"
  log_call "search" "$query" "L3" "$n" "$(ms_since "$t0")" 0
}

cmd_scrape() {
  local url="$1"
  local key="scrape:$url" cached payload body md out t0
  t0=$(date +%s%N)
  if cached="$(cache_get "$key")"; then
    md="$(printf '%s' "$cached" | jq -r '.markdown | length' 2>/dev/null || printf '0')"
    printf '%s\n' "$cached"
    log_call "scrape" "$url" "L0" "$md" "$(ms_since "$t0")" 0
    return 0
  fi
  payload="$(jq -n --arg u "$url" '{url: $u, formats: ["markdown"]}')"
  if ! body="$(curl -fsS --max-time "$FETCH_TIMEOUT" -X POST \
      -H 'Content-Type: application/json' -d "$payload" \
      "$CRW_URL/v1/scrape" 2>/dev/null)"; then
    log_call "scrape" "$url" "L2" 0 "$(ms_since "$t0")" 1
    exhausted
  fi
  md="$(printf '%s' "$body" | jq -r '.data.markdown // empty' 2>/dev/null)"
  if [ -z "$md" ]; then
    log_call "scrape" "$url" "L2" 0 "$(ms_since "$t0")" 1
    exhausted
  fi
  out="$(printf '%s' "$body" | jq -c '{url: $url, markdown: .data.markdown}' --arg url "$url")"
  cache_put "$key" "$out"
  printf '%s\n' "$out"
  log_call "scrape" "$url" "L2" "${#md}" "$(ms_since "$t0")" 0
}

[ $# -ge 1 ] || usage
case "$1" in
  search) [ $# -eq 2 ] || usage; cmd_search "$2" ;;
  scrape) [ $# -eq 2 ] || usage; cmd_scrape "$2" ;;
  *) usage ;;
esac
