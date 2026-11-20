#!/usr/bin/env bash
# create.sh — idempotently (re)create the operator fetch stack.
#
#   ./create.sh            # create what is missing, start what is stopped
#   DRY_RUN=1 ./create.sh  # print the commands instead of running them
#
# Order matters: the bridge network, then searxng, then crw. CRW probes its
# search backend at boot and logs "search backend unreachable" if SearXNG is not
# up yet — it recovers on the next call, but the warning is noise worth avoiding.
#
# Digests come from the *.container quadlets, which stay the source of truth for
# image pins. Nothing here touches secrets; searxng settings stay a bind mount.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NET="${FETCH_STACK_NETWORK:-fetch-stack}"
SUBNET="${FETCH_STACK_SUBNET:-10.89.7.0/24}"
GATEWAY="${FETCH_STACK_GATEWAY:-10.89.7.1}"
CRW_MEM="${CRW_MEM:-2g}"
SEARXNG_MEM="${SEARXNG_MEM:-2g}"
DRY_RUN="${DRY_RUN:-0}"

# Image pins: read them from the quadlets so this script cannot drift from them.
image_from_quadlet() { # $1=quadlet file -> first Image= value
  sed -n 's/^Image=//p' "$HERE/$1" | head -1
}
CRW_IMAGE="$(image_from_quadlet crw.container)"
SEARXNG_IMAGE="$(image_from_quadlet searxng.container)"
: "${CRW_IMAGE:?no Image= in crw.container}"
: "${SEARXNG_IMAGE:?no Image= in searxng.container}"

run() { # echo + execute, unless DRY_RUN=1
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY  %s\n' "$*"
  else
    printf '+ %s\n' "$*"
    "$@"
  fi
}

exists() { podman container exists "$1" >/dev/null 2>&1; }
running() { [ "$(podman inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]; }

if podman network exists "$NET" >/dev/null 2>&1; then
  echo "network $NET: present"
else
  echo "network $NET: creating"
  run podman network create --driver bridge --subnet "$SUBNET" --gateway "$GATEWAY" "$NET"
fi

if exists searxng; then
  echo "searxng: present ($(running searxng && echo running || echo stopped))"
else
  echo "searxng: creating"
  run podman create --name searxng --restart unless-stopped --memory="$SEARXNG_MEM" \
    --network "$NET" -p 127.0.0.1:8080:8080 \
    --dns=1.1.1.1 --dns=100.100.100.100 \
    -v "$HOME/.config/searxng/settings.yml:/etc/searxng/settings.yml:ro,Z" \
    "$SEARXNG_IMAGE"
fi

if exists crw; then
  echo "crw: present ($(running crw && echo running || echo stopped))"
else
  echo "crw: creating"
  run podman create --name crw --restart unless-stopped --memory="$CRW_MEM" \
    --network "$NET" -p 127.0.0.1:3001:3000 \
    -e CRW_SEARCH__SEARXNG_URL="http://searxng:8080" \
    --dns=1.1.1.1 --dns=100.100.100.100 \
    "$CRW_IMAGE"
fi

for c in searxng crw; do
  if ! running "$c"; then
    echo "$c: starting"
    run podman start "$c"
  fi
done

echo
echo "verify: $HERE/smoke.sh"
echo "content: scripts/fetch.sh search --content \"query\"   (from a homelab checkout)"