# Real effectiveness verdict — blind A/B judge (2026-11-20)

This is the answer the surface proxy could not give. We ran a **blind judge** on
the actual result content of the 9 queries where both providers answered.

## Method (auditable)

1. Both arms' full passages (title + source + ~900 chars of content) were
   extracted into two separate files.
2. A deterministic seeded shuffle assigned each query's sets to anonymous
   **A** and **B**. The mapping was written to `blind-key.json` and withheld
   from the judge.
3. An **independent subagent** with no access to this session, no web access,
   and no access to the key or any result file except `blind-package.json`
   scored both sets 1–5 on four dimensions and declared a winner per query.
4. Only after the verdict was returned did we unblind and compute totals.

The judge was explicitly told: judge only the material, do not infer provider
identity from style or domain, do not reward verbosity, ties require comparable
correctness with comparable effort.

## Result — Exa wins on content quality

| | Local (SearXNG+CRW) | Exa keyless | Δ |
|---|---|---|---|
| answerability (avg/5) | 3.11 | **3.44** | +0.33 |
| specificity (avg/5) | 3.11 | **3.89** | +0.78 |
| freshness_fit (avg/5) | 3.78 | 3.78 | 0 |
| actionability (avg/5) | 3.00 | **3.22** | +0.22 |
| **total (of 180)** | **117** | **129** | **+12 (10.3%)** |
| **query wins** | **2** | **6** | 1 tie |

Per query:

| id | class | winner | local | exa |
|---|---|---|---|---|
| f01 | error | exa | 12 | 13 |
| f02 | error | **local** | 16 | 14 |
| f03 | error | exa | 14 | 16 |
| f04 | error | **local** | 15 | 12 |
| f05 | error | exa | 9 | 15 |
| f06 | error | exa | 9 | 15 |
| f07 | freshness | exa | 14 | 19 |
| f08 | freshness | tie | 11 | 11 |
| f09 | freshness | exa | 16 | 15 |

## What this means, precisely

**Exa is ~10% better on content quality** when both providers answer. It wins
because its passages are more specific: concrete flags (`force=true`), exact
URLs (vendored checkout), pinned dates and versions. Local wins when the exact
root-cause discussion lives in a GitHub issue that metasearch surfaces first
(f02, f04).

**Freshness is a tie.** The local stack is not behind here — both scored 3.78.

**This is different from the surface proxy.** The proxy said 80%; the blind
judge says ~90% relative quality (117/129). Both point the same direction: Exa
is better, but not overwhelmingly. The honest range is "Exa is modestly better
at content; local is dramatically better at being there".

## Combined verdict (the answer to the operator's question)

| Dimension | Winner | Magnitude | Evidence |
|---|---|---|---|
| Availability | **Local** | 100% vs 30% | 30/30 answered vs 9/30 (21× 429) |
| Content quality | **Exa** | ~10% | blind A/B, 6 wins vs 2, 129 vs 117 |
| Freshness | Tie | 0 | 3.78 both |
| Cost | **Local** | $0 marginal | no key, no quota |
| Prompt privacy | **Local** | queries stay local | paid API ships them out |

**Recommendation (data-backed)**: use local as the always-on default; keep a
paid key as a *quality supplement*, not a primary path. The 10% quality edge
does not compensate for being unavailable 70% of the time on a keyless account.
With a paid key (no 429), the tradeoff becomes 10% quality vs cost+privacy —
an operator decision, not a technical verdict.

## Limitations of this verdict

- n=9 paired successes. Small. The 21 Exa failures are excluded by definition,
  and they were the harder later classes → survivorship bias remains.
- The judge is an LLM, not a human expert. Its rubric is explicit, but it can
  err. The per-query notes are included so a human can audit any disagreement.
- Content was capped at ~900 chars per passage; deeper pages may differ.
- No Brave/Tavily/Jina arms (no keys).

## Artifacts

- `blind-package.json` — anonymous A/B input
- `blind-key.json` — unblinding map (kept for audit)
- `blind-judge-verdict.json` — raw per-query scores and notes
- `blind-verdict.json` — unblinded aggregate
- `answers-local-arm.json` / `answers-exa-arm.json` — source material
