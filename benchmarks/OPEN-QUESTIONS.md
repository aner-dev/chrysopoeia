# Open questions in chrysopoeia — and the experiment that answers each

Doctrine: **no claim without a method**. Each row pairs a question worth asking
with the smallest honest experiment that can answer it, and the kill criterion
that tells us to stop. Questions already answered are marked CLOSED.

| # | Question | Method | Measurement | Kill / stop criterion | Status |
|---|---|---|---|---|---|
| Q1 | Does local content parity actually work? | One-call `search --content` on real queries | 4–5 results × markdown, 1.1–1.9s | If no content -> CRW wiring broken; fix `/capabilities` first | **CLOSED** — yes |
| Q2 | Does the agent choose local when available? | `provider-choice.jsonl` observer | local-vs-paid share | 0% share -> prose doctrine insufficient | **CLOSED** — 0% (15 paid / 0 local) |
| Q3 | Does enforcement change routing? | `FETCH_LOCAL_ENFORCE=1` in real sessions | share before/after; blocked-call count | If share stays 0% with local up -> hook not firing | OPEN — needs real sessions |
| Q4 | Does local *answer* as well as Exa? | Blind A/B judge on content | 4-dim rubric, query wins | If local wins < 1/3 of pairs -> stop claiming quality parity | **CLOSED** — Exa 6 vs local 2, ~10% edge |
| Q5 | How reliable is each provider? | 30-query paired run | answered/attempted, 429 count | 429 > 20% -> availability becomes the headline | **CLOSED** — local 100%, Exa keyless 30% |
| Q6 | Is local fresher for fast-moving docs? | FreshStack/FreshQA slices + release-date probes | nugget hit rate; pinned release dates | If local trails by >1 release -> use paid for freshness class | PARTIAL — freshness tie in blind judge, no dataset slice |
| Q7 | Is local better in Spanish/locale queries? | Paired locale queries with relevance judge | answerability by class | If locale class loses badly -> drop the README claim | OPEN — survivorship bias hit this class (Exa 429 before it) |
| Q8 | What is the real $/query with a paid key? | `search_evals`-style trace: agent cost vs grader cost | tokens+calls per provider | If cost/query > budget -> hybrid not viable | OPEN — no key available; $0 keyless measured |
| Q9 | Does `retried_with` predict user dissatisfaction? | Correlate outcome sink with follow-up queries | retry rate vs session abandonment | Retry rate < 5% -> metric too weak to gate on | OPEN — sink deployed, no sessions yet |
| Q10 | Which query classes should stay paid? | Blind judge broken down by class | wins per class | Class with local wins 0 and exa wins 3+ -> route to paid | PARTIAL — error 2-4, freshness 0-2-1; longtail/bulk/locale unpaired |
| Q11 | Does dedup change answer quality? | A/B with `JQ_DEDUPE` on/off on same queries | judge score + result count | If score drops >10% -> dedup too aggressive | OPEN — dedup shipped, unmeasured |
| Q12 | Does host-less filtering lose good results? | Replay the 20 dropped Brave URLs; judge validity | false-positive rate | >5% valid URLs dropped -> narrow the regex | OPEN — filter shipped, unmeasured |
| Q13 | Does the extension cost latency in the agent loop? | Gentle Shell-style paired AB/BA worktrees, p50/p95 | footer write + poll + notify overhead | p95 > 50ms -> throttle more | OPEN — mirror `render-cache-performance.md` |
| Q14 | Does enforcement risk removing the fallback? | Fault injection: stop CRW, issue search | exit code + provider used | Any case where BOTH paths fail -> fail-open broken | PARTIAL — unit tests cover it; no live fault injection |
| Q15 | Does the pattern port to another harness? | Port observer to a non-Pi agent with tool hooks | same suite passes | If >20% of code is Pi-specific -> document as Pi-only | OPEN — repo claims portability, untested |

## Priority order for the next session

1. **Q10 + Q7** — rerun the Exa arm with a real key to cover longtail/bulk/locale.
   This is the only way to remove the survivorship bias that currently weakens
   every quality claim. Needs an operator-provided key (no money spent by agent).
2. **Q3 + Q9** — run normal sessions with the updated extension and read
   `search-outcome.jsonl`. Cheapest, highest-signal, no key needed.
3. **Q11 + Q12** — replay harness for the two shipped filters. Deterministic,
   offline, cheap; protects against silent regressions.
4. **Q13** — mirror Gentle Shell's own AB/BA methodology before adding features
   to the extension.
5. **Q6 + Q8** — once a key exists, use FreshStack slices and `search_evals`
   cost traces.

## Method rules (inherited from Gentle Shell's benchmark doctrine)

- AB/BA paired runs, report **median + p95**, never a single sample.
- State **n** and all caveats next to every number.
- Keep benchmark data in the repo, not just in chat (Gentle Shell ships none —
  we explicitly do better here).
- A report is **not** a gate. Thresholds are operator decisions.
- If a metric needs a paid resource, ask before spending; keyless quotas count
  as a real limit and their exhaustion is data, not an error to hide.
