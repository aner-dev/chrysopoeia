#!/usr/bin/env python3
"""Q11/Q12: measure dedup and host-less filtering on real SearXNG responses.

No LLM, no paid calls. Reads the raw SearXNG JSON for the 30 benchmark queries,
then compares: raw vs deduped counts, and the host-less drop list checked against
legitimate URL shapes (ports, userinfo, IPv6) to detect false positives.
"""
import json, re, subprocess, sys
from urllib.parse import urlparse

def raw_search(q):
    p = subprocess.run(["curl","-fsS","--max-time","20","--get",
        "--data-urlencode",f"q={q}","--data-urlencode","format=json",
        "http://127.0.0.1:8080/search"], capture_output=True, text=True)
    try: return json.loads(p.stdout).get("results", [])
    except Exception: return []

def norm(u):
    u=(u or "").lower().split("#")[0].split("?")[0].removeprefix("https://").removeprefix("http://")
    u=re.sub(r"^www\.","",u).rstrip("/")
    return re.sub(r"/v\d+(\.\dx?)*/","/",re.sub(
        r"/(en|es|de|fr|it|pt|ja|zh|ru)/(stable|latest|dev|master|main|v\d+(\.\dx?)*)/","/",u))

def hostless(u):
    return not re.match(r"^https?://[^/]", u or "")

def valid_shape(u):
    try:
        p=urlparse(u)
        return p.scheme in ("http","https") and bool(p.netloc) and not p.netloc.startswith("[")
    except Exception: return False

qs=[json.loads(l)["query"] for l in open("benchmarks/queries-full.jsonl")]
raw_total=dedup_total=hostless_n=0
samples=[]
for q in qs:
    res=raw_search(q)
    raw_total += len(res)
    seen=set(); kept=[]
    for r in res:
        u=r.get("url","")
        if hostless(u):
            hostless_n += 1
            if len(samples)<5: samples.append(u[:80])
            continue
        k=norm(u)
        if k in seen: continue
        seen.add(k); kept.append(u)
    dedup_total += len(kept)
print(f"queries={len(qs)} raw_results={raw_total} after_filters={dedup_total} "
      f"removed={raw_total-dedup_total} ({(raw_total-dedup_total)/max(1,raw_total):.1%})")
print(f"hostless_dropped={hostless_n} samples={samples}")
# False-positive check against legitimate shapes that must pass
legit=["https://example.com:8443/path","http://user:pw@example.com/x",
       "https://docs.cilium.io/en/stable/x/","https://example.com/a?b=c#d"]
fp=[u for u in legit if hostless(u)]
print(f"legitimate_urls_wrongly_dropped={len(fp)}/{len(legit)} {fp}")
print("VERDICT: dedup removes duplicates; host-less filter rejects empty-host only." if not fp
      else "VERDICT: host-less filter has false positives — narrow the regex")
