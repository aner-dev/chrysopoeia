# Paired search benchmark — full run (2026-11-20)

## What happened

T4 aimed for 30 paired queries with Exa keyless. The local arm completed **30/30**
with extracted content. The Exa arm completed **9/30** and then hit the keyless
rate limit: the remaining 21 queries returned `429 Exa MCP rate limit reached`.

**The benchmark stopped because of the exact failure mode this project exists
to detect.** That is the headline result, not an inconvenience.

| Arm | Completed | Failed | Success rate |
|---|---|---|---|
| Local (SearXNG + CRW) | 30/30 (all with markdown) | 0 | **100%** |
| Exa keyless | 9/30 | 21 × 429 | **30%** |

## Surface comparison (the 9 paired successes only)

Deterministic judge: source authority 60% + title/query token overlap 40%.
No LLM, no cost, reproducible in `judge.py`.

| id | class | local | exa | ratio |
|---|---|---|---|---|
| f01 | error | 0.686 | 0.857 | 0.80 |
| f02 | error | 0.000 | 0.860 | 0.00 |
| f03 | error | 0.933 | 0.800 | 1.17 |
| f04 | error | 0.640 | 0.867 | 0.74 |
| f05 | error | 0.805 | 0.981 | 0.82 |
| f06 | error | 0.600 | 0.767 | 0.78 |
| f07 | freshness | 0.900 | 1.000 | 0.90 |
| f08 | freshness | 0.960 | 0.800 | 1.20 |
| f09 | freshness | 0.620 | 0.733 | 0.85 |

**MEAN surface score (n=9): local 0.683 vs exa 0.852 → 80%.**

This is **lower than the v1 smoke sample (97%, n=6)**. The larger sample is the
one to trust. Local led on 2 of 9 queries (f03, f08); f02 returned no usable
surface at all.

## Honest interpretation

1. **Availability is the strongest finding.** With no API key, Exa was unable to
   answer 70% of this workload. The local stack answered everything. For an
   agent that searches continuously, that is the difference between a degraded
   session and a working one.
2. **Quality is not at parity.** On the queries Exa did answer, its source
   surface scored 0.852 vs local 0.683 (~80%). The v1 "97%" claim does **not**
   survive the larger sample and must be corrected in the README.
3. **Survivorship bias is real and unfavorable to local.** Exa failed on the
   last 21 queries, which include the harder longtail/freshness/bulk/locale
   classes. We therefore cannot compare local against Exa precisely where the
   gap might be largest. The 80% may be optimistic or pessimistic — we do not
   know, and we say so.
4. **f02 scored 0.000 locally** — a total miss for that query's query set. One
   bad result does not invalidate the stack, but it is a concrete regression
   to investigate, not to average away.

## What is still NOT measured

- Answer correctness (the judge reads source titles, not answers).
- Blind human/LLM A/B scoring — still the open half of T4.
- Paid tiers (Brave/Tavily/Jina) — no keys.
- p50/p95 with a cold cache across all 30 queries (the local arm logged
  per-query latency; class means were 1.9–2.7 s).
- `retried_with` from real agent sessions — the outcome sink only starts
  recording on sessions launched with the updated extension.

## Verdict for the operator

> ¿Cuánto estoy pagando por funcionalidad?

With an Exa keyless account, **you are not paying money — you are paying in
availability**: 70% of this workload was unserviceable after 9 queries. The local
stack delivers ~80% of Exa's source surface on the queries where both worked,
with 100% availability and 0 marginal cost.

The honest recommendation remains **hybrid**: local as the default (it always
answers, at lower surface quality), paid as a supplement for the long tail when
a key exists — never as the sole path, because it demonstrably runs out.

## Follow-up

- Correct the `chrysopoeia` README: replace the v1 97% claim with this run's 80%
  (n=9) and the 100% vs 30% availability table.
- Re-run the Exa arm with a key (operator-provided) to remove survivorship bias.
- Investigate f02's zero-score local result.
