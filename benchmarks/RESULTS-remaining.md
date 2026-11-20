# Remaining questions executed (2026-11-20) — final experimental record

This closes every question in `OPEN-QUESTIONS.md` that does **not** require a
paid API key. Q6/Q8/Q10/Q7 remain open by explicit operator decision: no paid
Exa key will be purchased; the paid-arm recommendation stays documented for
repo users.

## Q3 — Does enforcement change routing? CLOSED (controlled)

- Local up + `FETCH_LOCAL_ENFORCE=1` → `web_search` **blocked**, reason names `fetch_local`.
- Local down → `web_search` **allowed** (fail-open).
- No checkout in cwd → allowed; probe throws → allowed.
- Evidence: `tests/test-session-behavior.mjs` (3/3). Real-session share change
  still depends on launching a shell with the env var — the mechanism is proven,
  the adoption metric is not.

## Q9 — Does `retried_with` work as a signal? CLOSED (mechanism), OPEN (predictive value)

- Same query hash within 60s local→paid → `retried_with=fetch_local`.
- Different query → no retry recorded. Retry rate computed correctly (1/3 fixture).
- Raw query never reaches the sink (canary test).
- Evidence: `tests/test-session-behavior.mjs`. Whether retry rate predicts
  user dissatisfaction still needs real sessions — it cannot be simulated.

## Q11/Q12 — Dedup and host-less filter A/B CLOSED

Raw SearXNG responses for all 30 benchmark queries:

```
queries=30  raw_results=669  after_filters=567  removed=102 (15.2%)
hostless_dropped=99   legitimate_urls_wrongly_dropped=0/4
```

- The host-less filter drops **99** empty-host redirects (`http:///go/v1/...`)
  with **zero false positives** on ports, userinfo, versioned docs and query strings.
- The remaining 3 removals are normalized-URL duplicates — the "five versions
  of the same docs page" problem is real and the fix removes ~0.5% extra noise.
- Evidence: `benchmarks/filters_ab.py`.

## Q13 — Extension overhead CLOSED

Gentle Shell-style AB/BA paired run, 400 handler invocations, real `.ts`:

```
A p50 0.089ms p95 0.749ms | B p50 0.089ms p95 0.630ms
combined p50 0.089ms p95 0.664ms max 34.627ms
```

No throttling needed. The occasional max is a GC/first-write outlier, not a
steady-state cost.

## Q14 — Fail-open under real fault injection CLOSED

Stopped the live `crw` container, ran `search --content`, restarted it:

- CRW down → command **exited 0**, degraded to link-only SearXNG search,
  returned **26 results (8 with content from snippets)**, stderr reported
  11 host-less drops.
- CRW restarted → `health=200`, both containers Up.
- Conclusion: a local failure removes *content*, not *search*. The paid path
  is not required for availability. This is the strongest practical result of
  the whole project.

## Q15 — Portability CLOSED (measured surface)

`extensions/degradation-status.ts`: 906 lines, **6 Pi-specific lines** (`pi.on`,
`pi.registerTool`, `ctx.ui`, SDK type import) = **0.7%**. The remaining 99.3%
is node builtins + pure exported functions. The README's portability claim is
supported mechanically, though an actual second-harness port was not executed.

## Corrected status table

| Question | Status | Evidence |
|---|---|---|
| Q1 content parity | CLOSED | 1.1–1.9s, 4–5 × 4000 chars |
| Q2 routing share | CLOSED | 0% local (15/0/5) |
| Q3 enforcement | CLOSED (mechanism) | test-session-behavior |
| Q4 effectiveness | CLOSED | blind judge: Exa 6-2-1, +10% |
| Q5 availability | CLOSED | 100% vs 30%, 21×429 |
| Q6 freshness dataset | PARTIAL | tie in blind judge; no FreshStack slice |
| Q7 locale | OPEN (operator decision) | needs paid key |
| Q8 $/query | OPEN (operator decision) | $0 keyless measured |
| Q9 retry signal | CLOSED (mechanism) | test-session-behavior |
| Q10 per-class paid routing | OPEN (operator decision) | needs paid key |
| Q11 dedup | CLOSED | 3/669 duplicates removed, 0 FP |
| Q12 host-less | CLOSED | 99 dropped, 0 FP |
| Q13 overhead | CLOSED | p95 0.664ms |
| Q14 fail-open | CLOSED | live fault injection |
| Q15 portability | CLOSED (surface) | 6/906 Pi-specific lines |

## Final synthesis

The project's claims now have the following evidence quality:

- **Hard, measured, reproducible**: availability, content parity, fail-open,
  filter correctness, overhead, routing enforcement mechanism, Pi coupling.
- **Measured with caveats**: blind effectiveness (n=9, LLM judge, survivorship bias).
- **Explicitly open by operator choice**: any question requiring a paid key.

No claim in the public README exceeds this evidence table. That was the goal
of the documentation and testing pass.
