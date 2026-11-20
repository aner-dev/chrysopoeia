# Paired search benchmark — v1 results (2026-11-20)

## Scope actually executed

- **n = 6** queries, one per class (`error` ×2, `freshness`, `longtail`, `bulk`,
  `locale`), authored by the agent in `queries.jsonl` and marked as **first-pass,
  operator-reviewable** — the ODD plan calls for operator-authored queries in the
  full run.
- **Arms**: local `fetch.sh search --content` (SearXNG + CRW, bridge network) vs
  `web_search` → **Exa keyless** (no API key, quota-limited, $0 marginal).
- **No paid money was spent.** Brave/Tavily/Jina arms are `skipped: no key`.
- **Judge**: deterministic surface proxy (source authority 60% + title/query
  token overlap 40%), reproducible in `judge.py` (`python3 benchmarks/judge.py`). No LLM judge, no blind A/B.

## Results

| id | class | local | exa | local/exa |
|---|---|---|---|---|
| q01 | error | 0.767 | 0.800 | 0.96 |
| q02 | error | 0.780 | 0.867 | 0.90 |
| q03 | freshness | 0.947 | 0.860 | 1.10 |
| q04 | longtail | 0.690 | 0.713 | 0.97 |
| q05 | bulk | 0.816 | 0.810 | 1.01 |
| q06 | locale | 0.580 | 0.650 | 0.89 |

**MEAN surface score: local 0.763 vs exa 0.783 → 97%.**

Content parity: local returned 5 results with markdown in 5/6 queries (q01 had
2 of 3 with content). Latencies: local p50 ≈ 27 ms on cached/warm engine answers,
4.1 s on the cold Spanish query; Exa returned 5 passages per query in one call
(latency not exposed by the tool result — **not measured**).

## What this DOES say

- For these six coding-adjacent queries, the local stack surfaces **comparable
  source authority and topical coverage** to Exa keyless. Local even led on the
  freshness query (official Cilium docs and release notes ranked first).
- Combined with the earlier one-call content measurement (4–5 × 4000 chars in
  1.1–1.9 s), the **functional form** is replicated and the source surface is
  close on this small sample.

## What this DOES NOT say — read before quoting the 97%

1. **Surface ≠ correctness.** The judge never read an answer. It cannot tell if
   either provider would have led the agent to the right fix.
2. **n=6 is not a benchmark.** It is a smoke sample; confidence intervals are
   meaningless at this size. The ODD plan calls for 30–50 operator-authored
   queries before any percentage claim is public-facing.
3. **Exa keyless only.** No Brave/Tavily/Jina comparison — no keys. Paid tiers
   with semantic reranking may behave differently from the free tier.
4. **No retry signal from this run.** `search-outcome.jsonl` was deployed in the
   same session but this paired run was executed by the agent directly, so
   `retried_with` has no data yet. The "did local actually serve?" metric is
   still pending real agent sessions.
5. **Query text locality**: the shipped observer hashes queries one-way; this
   benchmark stores them in plaintext in `queries.jsonl` because it is an
   operator-curated fixture, not a runtime log. Do not put secrets in it.

## Verdict for the operator's question

> "¿Estoy pagando por un 50% de funcionalidad, menos o más?"

With the data available: **the local stack covers the functional form (content
in one call) and, on this tiny sample, ~97% of the source surface of Exa
keyless.** That is NOT a claim about answer quality. The honest estimate for
decision-making is: *you are probably paying Exa for the long-tail and semantic
queries, not for the everyday stack-trace/docs searches — but we need the full
30–50 query run and a blind judge before putting a number in a README.*

## Next

T4 of `odd/tasks/search-benchmark-plan.md` remains the authoritative follow-up:
operator-authored query set, blind A/B judge, p50/p95 by provider, and
`retried_with` from real agent sessions. This v1 is the harness proof, not the
final measurement.
