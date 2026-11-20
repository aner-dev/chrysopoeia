# Chrysopoeia

> ## ⚗️ Stop paying for AI web search. Free, self-hosted, local search engine.
>
> **A local drop-in for the paid-search leg of your agent**: replace Exa, Brave
> Search API, Tavily, Jina and friends for the searches your workstation can
> answer — with extracted content, zero marginal cost, no account, no key and no
> rate limit.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Built for Gentle Shell](https://img.shields.io/badge/built%20for-Gentle%20Shell-7c3aed.svg)](https://github.com/earendil-works/gentle-shell)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-orange.svg)](#requirements)
[![Cost: $0 marginal](https://img.shields.io/badge/cost-%240%20marginal-green.svg)](#honest-limitations--roi)

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
| Cost per search | metered | **$0 marginal** (electricity + hardware you own) |
| Account / API key | required | none for the local layers |
| Rate limit | per account/day | none — bounded by your hardware |
| "Five copies of the same docs page" | accepted as-is | deduplicated by normalized URL |
| Local stack down | silent failure | paid path stays available (fail-open) |

## Honest limitations & ROI

Sincerity over slogans. This section is the one to read before replacing
anything.

### What is measured

| Metric | Local (this stack) | Paid API (Exa, n=1 — see below) |
|---|---|---|
| Results with extracted content, one call | 4–5, up to 4000 chars each | 5 passages |
| Latency for that call | **1.1–1.9 s** (5 queries) | ~1 s (1 query) |
| Cost | $0 marginal | metered; free tier exhausted in ~2 sessions of heavy agent use |
| Rate limit | hardware bound (concurrency 1–2 here) | per account/day; 429s were the origin of this project |
| Query text stays local | yes | no — leaves your machine |
| Routing observable by the agent | yes (footer + JSONL) | only a `Providers used:` line in the session log |

First routing measurement in our deployment: **15 `web_search` calls, 0
`fetch_local`, 5 of the paid ones errored — 0% local share**. That is not a
failure of the pattern; it is the reason the measurement and the opt-in guard
exist. Skill prose alone did not move the agent.

#### First paired benchmark (v1, 2026-11-20)

A reproducible harness is included in [`benchmarks/`](benchmarks/). First run:
6 paired coding queries, local vs Exa keyless, deterministic surface judge
(source authority + title/query overlap):

| class | local | exa | ratio |
|---|---|---|---|
| error ×2 | 0.767 / 0.780 | 0.800 / 0.867 | 0.96 / 0.90 |
| freshness | **0.947** | 0.860 | **1.10** |
| longtail | 0.690 | 0.713 | 0.97 |
| bulk | 0.816 | 0.810 | 1.01 |
| locale | 0.580 | 0.650 | 0.89 |
| **mean (v1, n=6)** | **0.763** | **0.783** | **97%** |

> **Final effectiveness verdict — blind A/B judge (2026-11-20).** An independent
> judge scored the full passages of the 9 paired queries without knowing which
> provider produced them. Result: **Exa won 6, local won 2, 1 tie**; totals
> 129 vs 117 of 180 (~10% Exa edge). Specificity was Exa's advantage (+0.78);
> **freshness tied** (3.78 both). Availability still favours local 100% vs 30%.
> See [`benchmarks/RESULTS-effectiveness.md`](benchmarks/RESULTS-effectiveness.md).
> The 15 remaining answerable questions and their methods live in
> [`benchmarks/OPEN-QUESTIONS.md`](benchmarks/OPEN-QUESTIONS.md).

> **Superseded by the full run (n=30, 2026-11-20).** Exa keyless hit its rate
> limit at query 10: it answered 9/30 and returned 429 on the other 21. The
> local stack answered **30/30 with extracted content**. On the 9 paired
> successes the surface ratio was **80%** (local 0.683 vs exa 0.852), lower than
> v1's 97%. The larger sample is the one to trust. See
> [`benchmarks/RESULTS-full.md`](benchmarks/RESULTS-full.md).

| Availability (full run) | Local | Exa keyless |
|---|---|---|
| Queries answered | **30/30** | 9/30 |
| Success rate | **100%** | **30%** |

`python3 benchmarks/judge.py` reproduces the surface proxy. It is **not** an
answer-quality judge. The full run has survivorship bias (Exa failed on the
harder later classes), and the blind human/LLM judge is still open.

## What is NOT measured — do not extrapolate

- **Index breadth and relevance**: no blinded head-to-head with Exa, Brave,
  Tavily or Jina. Paid engines have indexing infrastructure and semantic rankers
  a two-container workstation cannot replicate. For hard, novel, long-tail
  queries the paid API may simply find better sources.
- **Recall / precision**: we measured *content parity* (can we get markdown in
  one call?), **not** answer quality. There is no relevance judge here.
- **Cold-query latency across many domains**: 5 queries on familiar technical
  topics is a smoke benchmark, not a P50/P99 study.
- **Freshness**: no systematic comparison of how fast each index picks up new
  pages. Metasearch is often fresher, but we did not prove it.
- **Reliability of engines**: SearXNG aggregates third-party engines; Brave
  intermittently returns empty-host redirects here (we drop them fail-closed).
  Engines change without notice. A paid API is one contract, not a shifting set.
- **Uptime**: this is a single workstation. Sleep/poweroff = down. No SLO.
- **Non-English / semantic queries**: our local queries in Spanish returned
  42–46 results, but we have no relevance scoring against Exa's mostly-English
  index. Do not claim a win where we did not measure one.

### Where the ROI actually is

The saving is not "local search is smarter". It is **you stop spending a
metered resource on the searches that do not need it**:

| Query class | Recommended path | Why |
|---|---|---|
| Error messages, stack traces, local docs, known domains | **Local** | keyword precision, zero cost, no rate limit |
| Bulk / batch research, many queries | **Local** | marginal cost dominates the decision |
| Spanish / locale-specific | **Local** (with the caveat above) | paid indexes skew English |
| Fresh releases, today's prices/news | **Local** first | metasearch freshness, verify key facts |
| Novel, ambiguous, long-tail conceptual research | **Paid** | index breadth and semantic ranking |
| When the local stack is down | **Paid** (automatic fail-open) | availability wins over cost |

**ROI verdict**: the full run showed the rate-limit failure mode directly —
Exa keyless became unavailable after 9 queries while local kept answering. That
availability difference, not a quality claim, is the main reason to adopt this.
If most of your agent's searches are in the first four rows, it pays for itself
immediately. If your work is dominated by the fifth row, keep the paid key — use
Chrysopoeia as the *measurement and fallback layer*, not as a replacement. The
honest recommendation is **hybrid**, and the included report tells you which
regime you are actually in.

**Do not use this project if**: you need a contractual SLO, you cannot run
Podman on a Linux host, you need guaranteed commercial indexing rights, or you
want us to claim quality we have not measured.

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

The first real measurement (15/0/5) justified an **opt-in, fail-open** guard:
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
bash tests/test-fetch.sh                       # 11 checks, offline stub servers
node --test tests/test-degradation-status.mjs  # 23 checks, real .ts imported
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
benchmarks/
  queries.jsonl                # paired query set (agent-drafted, operator-reviewable)
  run_local.sh                 # local arm, zero cost
  judge.py                     # deterministic surface judge (no LLM, no cost)
  RESULTS-v1.md                # first paired run + caveats
```

This repository is the portable pattern. The production deployment, ODD
trackers and cluster-side conventions live in the source homelab.

## Experimental status

Every claim above is backed by a reproducible experiment in [`benchmarks/`](benchmarks/):

- Availability, content parity and the blind effectiveness verdict — `RESULTS-full.md`, `RESULTS-effectiveness.md`.
- Fail-open under real fault injection (CRW stopped): search still exits 0 with 26 degraded results — `RESULTS-remaining.md`.
- Filters: 669 raw results -> 567 (15.2%), 99 host-less redirects dropped, **0 false positives**.
- Observer overhead: p50 0.089 ms, p95 0.664 ms (400 AB/BA calls).
- Enforcement and retry-correlation mechanisms: `tests/test-session-behavior.mjs`.

[`benchmarks/OPEN-QUESTIONS.md`](benchmarks/OPEN-QUESTIONS.md) tracks 15 questions with
method, metric and kill criterion. The four that need a **paid** Exa key are
deliberately left open: this project does not require paying any provider.

## Design rules

1. **Fail open, always.** Stack down, missing checkout, probe throws → the paid
   path stays available. A restarting container must never remove a search.
2. **Never log the prompt.** Codes, numbers, one-way hashes and tool names only.
3. **Opt-in enforcement.** Changing a native tool's behavior is an operator
   decision, not a default.
4. **Measure before tightening policy.** A report is not a gate; a paid-first
   trend is the signal.
5. **No harness coupling.** One extension file, no forks, no TUI patches.
6. **Honesty over reach.** We claim content parity and cost, not semantic
   superiority.

## Gentle Shell ecosystem

Built with [Gentle Shell](https://github.com/earendil-works/gentle-shell)'s
extension API (`ctx.ui.setStatus`, `ctx.ui.notify`, `pi.registerTool`,
`pi.on("tool_call")`). Listed in the Gentle Programming Hub — the collection of
programs and projects built for Gentle Shell.

## License

Apache-2.0. Copyright 2026 Aner.
