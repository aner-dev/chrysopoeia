#!/usr/bin/env python3
"""Reproducible paired judge (surface proxy). No LLM, no network, no cost.

Scores source authority + title/query token overlap for each provider arm.
This is NOT an answer-quality oracle: it cannot judge correctness, freshness
of claims, or actionability. Treat it as 'did we get comparable source
surface?' and keep the human/LLM judge task open in the ODD plan.
"""
import json
import re
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent
AUTHORITATIVE = (
    "docs.", "github.com", "kubernetes.io", "openbao.org",
    "bugs.launchpad.net", "forum.proxmox.com", "lists.proxmox.com",
    "pkg.go.dev", "cilium.io", "docs.oracle.com",
)
STOP = set("the a an of for in on with and or to how after from is are be by".split())


def tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2 and w not in STOP}


def load(name: str) -> dict:
    return {r["id"]: r for r in map(json.loads, (HERE / name).read_text().splitlines()) if r}


def score(sources: list[str], query: str) -> float:
    q = tokens(query)
    if not sources:
        return 0.0
    values = []
    for src in sources:
        title, domain = (src.split("|", 1) + [""])[:2]
        authority = 1.0 if any(a in domain for a in AUTHORITATIVE) else 0.5
        overlap = len(q & tokens(title)) / max(1, len(q))
        values.append(0.6 * authority + 0.4 * min(1.0, overlap * 3))
    return round(sum(values) / len(values), 3)


def main() -> None:
    local, paid = load("results-local-titles.jsonl"), load("results-exa.jsonl")
    rows = []
    print(f"{'id':4} {'class':10} {'local':>6} {'exa':>6} {'ratio':>6}")
    for qid, p in paid.items():
        if qid not in local:
            continue
        ls, ps = score(local[qid]["sources"], p["query"]), score(p["sources"], p["query"])
        rows.append({"id": qid, "class": p["class"], "local": ls, "exa": ps,
                     "ratio": round(ls / ps, 2) if ps else None})
        print(f"{qid:4} {p['class']:10} {ls:6.3f} {ps:6.3f} {ls / ps:6.2f}")
    if rows:
        a = sum(r["local"] for r in rows) / len(rows)
        b = sum(r["exa"] for r in rows) / len(rows)
        print(f"\nMEAN surface score: local={a:.3f} exa={b:.3f} ratio={a / b:.0%}")
        print("PROXY ONLY — authority + title/query overlap. NOT answer correctness.")
    (HERE / "judge-results.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()
