# Chrysopoeia

> *Turn paid search quotas into local, measured gold.*

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Built for Gentle Shell](https://img.shields.io/badge/built%20for-Gentle%20Shell-7c3aed.svg)](https://github.com/earendil-works/gentle-shell)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-orange.svg)](#requirements)

**Chrysopoeia** (χρυσοποιία, *"the making of gold"*) is a small, portable
pattern that gives a coding agent a **local web-fetch capability with content
parity to a paid search API** — without forking the harness, without logging
prompt text, and without burning quota to find out whether the local path is
actually being used.

It was developed **with Gentle Shell and for Gentle Shell**, on an Artix Linux
workstation. It is also useful to any Linux agent harness that can run shell
commands and load an extension: the producer is a shell script, the observer is
a ~300-line TypeScript extension, and the policy is documentation. No Rust, no
recompiled TUI, no patched agent runtime.

The name is an alchemical joke with a precise mapping:

| Alchemy | This project |
|---|---|
| Raw material (lead) | Paid search calls and their rate limits |
| Gold | Extracted markdown, produced locally, measured in the terminal |
| Athanor (furnace) | The operator workstation running the fetch stack |
| Crucible | Self-hosted [SearXNG](https://searxng.org/) + [CRW](https://github.com/fastcrw/crw) |
| The fire | `CRW_SEARCH__SEARXNG_URL` — without it the gold stays lead |
| Philosopher's stone | One JSONL line per search: routing stops being a guess |

## Why this exists

A local fetch stack looks worse than a paid search API for one reason: it
returns *links*, while the paid API returns *content*. The agent then needs
1 + N calls, or it gives up and burns quota. And there is normally no signal
showing which provider served a search, so "are we using the local stack?" has
no answer.

In our case the capability was **already installed but unconfigured**: CRW is
Firecrawl-compatible and exposes `/v1/search` with `scrapeOptions`, but reported
`capabilities.search.supported = false` because no search backend was set.
Wiring it to the local SearXNG closed the functional gap in one call.

**Rule of thumb:** read `/capabilities` and `/openapi.json` before replacing a
component. An unconfigured capability looks identical to a missing one from the
outside — and is far cheaper to fix.

## What it gives you

| | Without | With Chrysopoeia |
|---|---|---|
| Calls for search + content | 1 + N scrapes | **1** |
| Latency (measured) | 1–3 s + up to 15 s of scrapes | **1.1–1.9 s** |
| Content returned | links only | 4–5 results × up to 4000 chars of markdown |
| Routing visibility | session-log forensics | TUI footer + `provider-choice.jsonl` |
| Quota | burned on every search | zero marginal cost |
| "Five copies of the same docs page" | accepted as-is | deduplicated by normalized URL |
| Local stack down | silent failure | paid path stays available (fail-open) |

## The pattern

Three decoupled layers. No harness forks, no TUI rewrite, no prompt logging.

### 1. Producer — `src/fetch.sh`

```bash
./src/fetch.sh search "q"             # links, deduplicated, host-less dropped
./src/fetch.sh search --content "q"   # links + extracted markdown, ONE call
./src/fetch.sh scrape URL             # single-page extraction via CRW
```

Same JSON envelope in all search modes: `{query, results: [{title, url, content}]}`.
Host-less redirects (`http:///go/v1/...`) are dropped fail-closed; dedup strips
locale and version segments (`/en/stable/x` and `/en/v1.12/x` are one page).

### 2. Observer — `extension/degradation-status.ts`

A dependency-free Gentle Shell extension with three jobs:

- **`fetch_local` tool** — a native card, so the agent can *choose* the local path.
- **TUI footer + throttled warning** — degradation events from the shared sink
  (`degradation.jsonl`) become visible without reading logs.
- **Provider-choice log** — one line per finalized `web_search` / `fetch_local`
  call: `{ts, tool, cwd, ok}`. Never the query text. Canary tests assert it.

### 3. Policy — `src/agent-fetch-report.sh`

```bash
./src/agent-fetch-report.sh           # local-vs-paid share + verdict
```

The first real measurement in our deployment: **15 paid calls, 0 local, 5 of
the paid ones errored — 0% local share**. Doctrine alone did not move the agent.
That evidence justified an **opt-in, fail-open** guard:
`FETCH_LOCAL_ENFORCE=1` blocks `web_search` only while the local stack answers.
Default off. Merging changes nothing.

Fail-open paths are tested, not assumed: no checkout in cwd → allow; stack down
→ allow; probe throws → allow. The paid fallback never disappears because a
container is restarting.

## Requirements

- Linux with `bash`, `curl`, `jq`, `python3` (tests only) and Node.js ≥ 22
  (extension tests use native TypeScript type stripping).
- Podman rootless with a bridge network for the stack (see `infra/create.sh`).
- Gentle Shell (or another Pi-compatible harness) for the observer layer. The
  producer works standalone from any shell.

## Quick start

```bash
# 1. Bring up the local stack (SearXNG + CRW on a shared bridge network)
./infra/create.sh

# 2. Verify
./src/fetch.sh search --content "how does cilium egress gateway work"

# 3. Install the observer in Gentle Shell
cp extension/degradation-status.ts ~/.gentle-shell/agent/extensions/
# add the absolute path to the "extensions" array in ~/.gentle-shell/agent/settings.json,
# then start a NEW shell session (a /reload does not discover new global files)

# 4. Optional: deterministic local-first
export FETCH_LOCAL_ENFORCE=1

# 5. See whether it is working
./src/agent-fetch-report.sh
```

> The extension writes to `~/.gentle-shell/agent`, **not** `~/.pi/agent` —
> Gentle Shell uses an isolated agent home. This distinction cost us a debug
> session; it is called out here so it costs you none.

## Tests

```bash
bash tests/test-fetch.sh                  # 11 checks, offline stub servers
node --test tests/test-degradation-status.mjs   # 23 checks, real .ts imported
```

Both suites are hermetic: no network, no credentials, no prompt text in logs.

## Repository layout

```
src/
  fetch.sh                 # producer: search, search --content, scrape
  fetch-events.sh          # shared producer-agnostic degradation sink
  agent-fetch-report.sh    # local-vs-paid share + verdict
extension/
  degradation-status.ts    # tool + footer + choice log (Gentle Shell)
infra/
  create.sh                # reproducible SearXNG + CRW bridge network
tests/
  test-fetch.sh
  test-degradation-status.mjs
```

This repository is the portable pattern. The production deployment, ODD
trackers and cluster-side conventions live in the source homelab.

## Design rules

1. **Fail open, always.** Stack down, missing checkout, probe throws → the paid
   path stays available. A restarting container must never remove a search.
2. **Never log the prompt.** Codes, numbers, one-way hashes and tool names only.
3. **Opt-in enforcement.** Changing a native tool's behavior is an operator
   decision, not a default.
4. **Measure before tightening policy.** A report is not a gate; a paid-first
   trend is the signal.
5. **No harness coupling.** One extension file, no forks, no TUI patches.

## Gentle Shell ecosystem

Built with [Gentle Shell](https://github.com/earendil-works/gentle-shell)'s
extension API (`ctx.ui.setStatus`, `ctx.ui.notify`, `pi.registerTool`,
`pi.on("tool_call")`). Listed in the Gentle Programming Hub — the collection of
programs and projects built for Gentle Shell.

## License

Apache-2.0. Copyright 2026 Aner.
