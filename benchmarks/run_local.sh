#!/usr/bin/env bash
# Local arm of the paired benchmark. Writes one JSON line per query with the
# SAME shape the paid arm records. No network cost; no credentials.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="${1:-$HERE/results-local.jsonl}"
: > "$OUT"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(printf '%s' "$line" | jq -r '.id')
  klass=$(printf '%s' "$line" | jq -r '.class')
  q=$(printf '%s' "$line" | jq -r '.query')
  t0=$(date +%s%N)
  body=$(bash "$ROOT/scripts/fetch.sh" search --content "$q" 2>/dev/null)
  rc=$?
  ms=$(( ($(date +%s%N)-t0)/1000000 ))
  n=$(printf '%s' "$body" | jq -r '.results|length' 2>/dev/null || echo 0)
  wc=$(printf '%s' "$body" | jq -r '[.results[]|select((.content//"")|length>200)]|length' 2>/dev/null || echo 0)
  jq -nc --arg id "$id" --arg klass "$klass" --arg q "$q" \
    --argjson ms "$ms" --argjson rc "$rc" --argjson n "$n" --argjson wc "$wc" \
    '{id:$id,class:$klass,query:$q,provider:"local",latency_ms:$ms,exit:$rc,results:$n,with_content:$wc}' >> "$OUT"
  printf '%s local %sms results=%s content=%s\n' "$id" "$ms" "$n" "$wc"
done < "$HERE/queries.jsonl"
