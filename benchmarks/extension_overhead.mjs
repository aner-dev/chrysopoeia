#!/usr/bin/env node
/** Q13: paired AB/BA overhead of the observer handlers, no harness required.
 * Mirrors Gentle Shell's render-cache methodology: median + p95, AB/BA pairs. */
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const mod = await import(new URL("../extensions/degradation-status.ts", import.meta.url).href);
const t = fs.mkdtempSync(path.join(os.tmpdir(), "overhead-"));
const sink = path.join(t, "o.jsonl");
process.env.XDG_STATE_HOME = t;
process.env.DEGRADATION_STATUS_POLL_MS = "16";
const handlers = new Map();
const pi = { on: (n, h) => handlers.set(n, h), registerTool: () => {} };
mod.default(pi);

const event = {
  toolName: "fetch_local",
  input: { action: "search", query: "benchmark overhead query" },
  result: JSON.stringify({ results: [{ content: "x".repeat(500) }] }),
};

async function runOnce() {
  const a = performance.now();
  await handlers.get("tool_execution_end")(event, { ui: { setStatus(){}, notify(){} } });
  return performance.now() - a;
}
const stats = (xs) => { xs.sort((a,b)=>a-b); return { p50: xs[Math.floor(xs.length/2)].toFixed(3), p95: xs[Math.floor(xs.length*0.95)].toFixed(3), max: xs.at(-1).toFixed(3) }; };
const A=[],B=[];
for (let i=0;i<200;i++){ A.push(await runOnce()); B.push(await runOnce()); }
console.log("extension handler overhead (ms), n=400, AB order:");
console.log(" A", JSON.stringify(stats(A)));
console.log(" B", JSON.stringify(stats(B)));
const all=stats([...A,...B]);
console.log(" combined", JSON.stringify(all));
console.log(Number(all.p95) < 50 ? "VERDICT: observer overhead under 50ms p95 — no throttling needed" : "VERDICT: overhead too high — investigate");
fs.rmSync(t,{recursive:true,force:true});
