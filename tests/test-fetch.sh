#!/usr/bin/env bash
# test-fetch.sh — fixtures-only test for scripts/fetch.sh.
# Stub SearXNG + CRW on ephemeral localhost ports; hermetic (never touches
# the live stack). Run from the repo root: bash tests/scripts/test-fetch.sh
set -euo pipefail

FETCH="src/fetch.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(pwd)"
if [ ! -x "$REPO/$FETCH" ]; then bad "fetch missing at $FETCH"; echo "RESULT: $FAIL failed, $PASS passed"; exit 1; fi
command -v python3 >/dev/null || { bad "python3 missing (stub servers)"; echo "RESULT: $FAIL failed, $PASS passed"; exit 1; }
command -v jq >/dev/null || { bad "jq missing"; echo "RESULT: $FAIL failed, $PASS passed"; exit 1; }

FIX="$(mktemp -d)"
trap 'kill "$STUB1" "$STUB2" 2>/dev/null || true; rm -rf "$FIX"' EXIT
export FETCH_CACHE_DIR="$FIX/cache"
export FETCH_TIMEOUT=10

# One stub serves both APIs; run it on two ports (SearXNG-shape + CRW-shape).
cat > "$FIX/stub.py" <<'EOF'
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/search":
            q = parse_qs(u.query).get("q", [""])[0]
            res = [] if q == "noresults" else [
                {"title": f"Result for {q}", "url": "http://example.test/x", "content": "body"}]
            body = json.dumps({"query": q, "results": res}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
    def do_POST(self):
        if self.path == "/v1/scrape":
            n = int(self.headers.get("Content-Length", 0))
            self.rfile.read(n)
            body = json.dumps({"success": True, "data": {"markdown": "# Stub\n\nhello"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF

pick_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

P1="$(pick_port)"
P2="$(pick_port)"
python3 "$FIX/stub.py" "$P1" >/dev/null 2>&1 &
STUB1=$!
python3 "$FIX/stub.py" "$P2" >/dev/null 2>&1 &
STUB2=$!

wait_up() {
  local i=0
  while [ "$i" -lt 50 ]; do
    curl -fsS -m 1 "http://127.0.0.1:$1/search?q=x&format=json" >/dev/null 2>&1 && return 0
    i=$((i + 1))
    sleep 0.1
  done
  return 1
}
wait_up "$P1" || { bad "stub1 never came up"; echo "RESULT: $FAIL failed, $PASS passed"; exit 1; }
wait_up "$P2" || { bad "stub2 never came up"; echo "RESULT: $FAIL failed, $PASS passed"; exit 1; }

export SEARXNG_URL="http://127.0.0.1:$P1"
export CRW_URL="http://127.0.0.1:$P2"

run() { ( cd "$REPO" && bash "$FETCH" "$@" ); }

# 1. search hit
out="$(run search "wombats")"
code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | jq -e '.results[0].title == "Result for wombats"' >/dev/null; then
  ok "search hit (exit 0 + fields)"
else
  bad "search hit (exit $code)"
fi

# 2. search empty -> exit 1
if run search "noresults" >/dev/null 2>&1; then
  bad "search empty should exit 1"
else
  [ $? -eq 1 ] && ok "search empty exits 1" || bad "search empty wrong exit"
fi

# 3. scrape hit
out="$(run scrape "http://example.test/page")"
code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | jq -e '.markdown | contains("hello")' >/dev/null; then
  ok "scrape hit (exit 0 + markdown)"
else
  bad "scrape hit (exit $code)"
fi

# 4. CRW down -> exit 1 (closed port, nothing listening; fresh URL defeats cache)
PDEAD="$(pick_port)"
if CRW_URL="http://127.0.0.1:$PDEAD" run scrape "http://example.test/dead-port" >/dev/null 2>&1; then
  bad "scrape vs dead CRW should exit 1"
else
  [ $? -eq 1 ] && ok "scrape vs dead CRW exits 1" || bad "scrape vs dead CRW wrong exit"
fi

# 5. cache hit with servers killed
run search "cached-q" >/dev/null 2>&1
kill "$STUB1" "$STUB2" 2>/dev/null
sleep 0.3
out="$(run search "cached-q" 2>/dev/null)"
code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | jq -e '.results[0].title == "Result for cached-q"' >/dev/null; then
  ok "cache hit with servers down (exit 0)"
else
  bad "cache hit with servers down (exit $code)"
fi

# 6. usage errors -> exit 2
for args in "" "frobnicate" "scrape"; do
  if run $args >/dev/null 2>&1; then
    bad "args [$args] should exit 2"
  else
    [ $? -eq 2 ] && ok "args [$args] exits 2" || bad "args [$args] wrong exit"
  fi
done

# 7. call logging (metrics) — fresh stubs (case 5 killed the first pair)
Q1="$(pick_port)"; Q2="$(pick_port)"
python3 "$FIX/stub.py" "$Q1" >/dev/null 2>&1 &
S3=$!
python3 "$FIX/stub.py" "$Q2" >/dev/null 2>&1 &
S4=$!
if ! wait_up "$Q1" || ! wait_up "$Q2"; then bad "logging stubs never came up"; echo "RESULT: $FAIL failed, $PASS passed"; exit 1; fi
export FETCH_LOG="$FIX/calls.log"
export SEARXNG_URL="http://127.0.0.1:$Q1"
export CRW_URL="http://127.0.0.1:$Q2"
run search "logged-q" >/dev/null 2>&1
if [ "$(jq -s 'length' "$FETCH_LOG" 2>/dev/null)" -eq 1 ] && jq -s -e '.[0] | .cmd == "search" and .exit == 0 and .layer == "L3" and (.latency_ms | type == "number")' "$FETCH_LOG" >/dev/null; then
  ok "call logged on L3 hit"
else
  bad "call logged on L3 hit"
fi
run search "logged-q" >/dev/null 2>&1
if jq -s -e '.[1] | .layer == "L0" and .exit == 0' "$FETCH_LOG" >/dev/null; then
  ok "repeat call logged as L0"
else
  bad "repeat call logged as L0"
fi
PDEAD2="$(pick_port)"
if CRW_URL="http://127.0.0.1:$PDEAD2" run scrape "http://example.test/logged-dead" >/dev/null 2>&1; then
  bad "dead scrape should exit 1"
else
  if jq -s -e '.[2] | .exit == 1 and .layer == "L2"' "$FETCH_LOG" >/dev/null; then
    ok "failed call logged with exit 1"
  else
    bad "failed call logged with exit 1"
  fi
fi
kill "$S3" "$S4" 2>/dev/null || true

echo "RESULT: $FAIL failed, $PASS passed"
[ "$FAIL" -eq 0 ]
