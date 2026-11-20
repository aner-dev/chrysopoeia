# Chrysopoeia

> *Turn paid search quotas into local, measured gold.*

**Chrysopoeia** (χρυσοποιία, "the making of gold") is a small, portable pattern
that gives a coding agent a **local web-fetch capability with content parity to
a paid search API** — without forking the harness, without prompt-text logging,
and without spending quota to find out whether the local path is being used.

It started as an alchemical problem in an [Athanor](https://github.com/aner-dev/athanor)
homelab: the raw material was paid search calls and their rate limits; the gold
is extracted markdown, locally produced, measured and visible in the terminal.
The **furnace** is a self-hosted [SearXNG](https://searxng.org/) +
[CRW](https://github.com/fastcrw/crw) pair. The **philosopher's stone** is a
one-line JSONL event that turns routing from a guess into a measurement.

## The problem

A local fetch stack looks worse than a paid search API for one reason: it
returns *links*, while the paid API returns *content*. The agent then needs
1 + N calls, or it gives up and burns quota. And there is normally no signal
showing which provider served a search, so "are we using the local stack?" has
no answer.

In our case the capability was **already installed but unconfigured**: CRW is
Firecrawl-compatible and exposes `/v1/search` with `scrapeOptions`, but reported
`capabilities.search.supported = false` because no search backend was set.
Wiring it to the local SearXNG closed the functional gap in one call.

## The pattern

Three decoupled layers, no harness changes:

1. **Producer** — a local script wraps the stack:
   `fetch.sh search --content "query"` returns the same envelope as a plain
   search, with each result's extracted markdown. Results are deduplicated by
   normalized URL (so four versions of the same docs page arrive once) and
   host-less redirects are dropped fail-closed.
2. **Observer** — a ~300-line Gentle Shell extension with three jobs:
   a native `fetch_local` tool (so the agent can *choose* the local path),
   a TUI footer/notification for degradation events, and a
   `provider-choice.jsonl` line per `web_search` / `fetch_local` call —
   `{ts, tool, cwd, ok}`, never the query text.
3. **Policy** — measurement first, enforcement second. A report aggregates the
   log into a local-vs-paid share. If the agent still ignores the local path,
   an **opt-in, fail-open** guard blocks `web_search` only while the local
   stack actually answers. Default off; merging changes nothing.

The portable suite runs both layers offline: `bash tests/test-fetch.sh` and
`node --test tests/test-degradation-status.mjs`.

## Measured results

| | Before | After |
|---|---|---|
| Calls for search + content | 1 + N scrapes | **1** |
| Latency | 1–3 s + up to 15 s of scrapes | **1.1–1.9 s** |
| Content | links only | 4–5 results × up to 4000 chars of markdown |
| Routing visibility | session JSONL forensics | footer + `provider-choice.jsonl` |
| Local share (first real window) | unknown | **0%** — 15 paid, 5 errored |
| Quota | burned on every search | zero marginal cost |

That 0% measurement is the point: doctrine alone did not move the agent. The
enforcement layer exists because the measurement justified it, not because we
guessed.

## Design rules

- **Fail open, always.** Stack down, missing checkout, probe throws → the paid
  path stays available. A restarting container must never remove a search.
- **Never log the prompt.** The sink carries codes, numbers, one-way hashes and
  tool names. Canary tests assert a query string never reaches a log line.
- **Opt-in enforcement.** Changing a native tool's behavior is an operator
  decision, not a default.
- **Measure before tightening policy.** A report is not a gate; a paid-first
  trend is the signal.
- **Read `/capabilities` before replacing a component.** A capability that is
  installed but unconfigured looks identical from the outside — and is much
  cheaper to fix.

## Repository layout

```
src/
  fetch.sh                     # producer: search --content, dedup, fail-closed
  fetch-events.sh              # degradation sink (producer-agnostic JSONL)
  agent-fetch-report.sh        # local-vs-paid share + verdict
extension/
  degradation-status.ts        # observer: tool, footer, choice log
tests/
  test-fetch.sh
  test-degradation-status.mjs
infra/
  create.sh                    # reproducible bridge network + containers
```

> This repository is the portable pattern. The production deployment, the ODD
> trackers and the cluster-side conventions live in the source homelab repo.

## License

Apache-2.0.
