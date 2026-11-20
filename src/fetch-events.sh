#!/usr/bin/env bash
# fetch-events.sh — degradation event sink shared by the fetch stack (S1/S2/S4).
#
# Sourced, never executed:
#   . scripts/fetch-events.sh
#   emit_degradation_event <producer> <from> <to> <reason> <latency_ms> <exit> [context_hash]
#
# One downgrade = ONE JSONL line in the sink + ONE human-readable line on stderr:
#   sink:   {"ts","producer","from","to","reason","latency_ms","exit"[,"context_hash"]}
#   stderr: fetch: downgrade <from>-><to> (<reason>, <latency>ms)
#
# The sink is producer-agnostic on purpose: a fetch downgrade and a `jev` downgrade
# write the same schema, so the renderer never learns a producer (S1).
# Sink path: $FETCH_EVENTS_SINK, default $XDG_STATE_HOME/agent-events/degradation.jsonl.
# The directory is created mode 700 (umask 077) and the file is append-only.
#
# CONTRACT (S4): every argument except context_hash is a CODE, a NUMBER or a HASH.
# Callers never pass prompt text, query strings, URLs, page content, PII, secrets or
# key material. A code must *look* like a code: at most 24 chars from [A-Za-z0-9._:-],
# no whitespace (the longest real one is `budget_zero`; a sentence is never a code).
# Anything that does not match is replaced by `invalid`, and context_hash is dropped
# unless it is a hex sha256 (`sha256:` prefix tolerated) — so prompt text cannot reach
# the sink even when a caller passes the wrong variable. A sha256 of the context is
# the only caller-side data that may travel, and it is one-way.
#
# SAFETY: logging is observability, never semantics. This function writes nothing to
# stdout, never changes the caller's exit code and never fails: a full disk, a
# read-only state dir or a missing `mkdir` degrades to "no event", never to a broken
# fetch. Every step is guarded; callers may run under `set -euo pipefail`.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "fetch-events.sh is a sourced helper: . scripts/fetch-events.sh; emit_degradation_event ..." >&2
  exit 2
fi

_fetch_event_sink() { # resolved per call so a caller/test can point it anywhere
  printf '%s' "${FETCH_EVENTS_SINK:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-events/degradation.jsonl}"
}

_fetch_event_code() { # $1=value -> safe code token, or `invalid` (prose never passes)
  case "${1:-}" in
    ''|*[!A-Za-z0-9._:-]*) printf 'invalid' ;;
    *) if [ "${#1}" -le 24 ]; then printf '%s' "$1"; else printf 'invalid'; fi ;;
  esac
}

_fetch_event_uint() { # $1=value -> unsigned integer, or 0
  case "${1:-}" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

_fetch_event_hash() { # $1=hex sha256 (optional `sha256:` prefix); fails unless 64 hex
  local h="${1:-}"
  h="${h#sha256:}"
  case "$h" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "${#h}" -eq 64 ] || return 1
  printf '%s' "$h" | tr 'A-F' 'a-f'
}

emit_degradation_event() { # $1=producer $2=from $3=to $4=reason $5=latency_ms $6=exit [$7=context_hash]
  local producer from to reason latency exit_code hash sink dir line
  producer="$(_fetch_event_code "${1:-}")" || producer=invalid
  from="$(_fetch_event_code "${2:-}")" || from=invalid
  to="$(_fetch_event_code "${3:-}")" || to=invalid
  reason="$(_fetch_event_code "${4:-}")" || reason=invalid
  latency="$(_fetch_event_uint "${5:-}")" || latency=0
  exit_code="$(_fetch_event_uint "${6:-}")" || exit_code=0
  hash=""
  if [ "$#" -ge 7 ]; then
    hash="$(_fetch_event_hash "$7")" || hash=""
  fi

  # Human-readable half first: even a broken sink still tells the operator.
  printf 'fetch: downgrade %s->%s (%s, %sms)\n' \
    "$from" "$to" "$reason" "$latency" >&2 2>/dev/null || true

  # Machine half. Every field is a validated code/number/digest, so no JSON escaping
  # can be needed and no caller text can leak through.
  line="$(printf '{"ts":"%s","producer":"%s","from":"%s","to":"%s","reason":"%s","latency_ms":%s,"exit":%s' \
    "$(date -u +%FT%TZ)" "$producer" "$from" "$to" "$reason" "$latency" "$exit_code")" || return 0
  if [ -n "$hash" ]; then
    line="$line$(printf ',"context_hash":"%s"' "$hash")" || return 0
  fi
  line="$line}" || return 0

  sink="$(_fetch_event_sink)" || return 0
  dir="${sink%/*}"
  [ "$dir" = "$sink" ] && dir="."
  (
    umask 077
    mkdir -p "$dir" 2>/dev/null || exit 0
    chmod 700 "$dir" 2>/dev/null || true
    printf '%s\n' "$line" >>"$sink" 2>/dev/null || true
  ) 2>/dev/null || true
  return 0
}
