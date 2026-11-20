#!/usr/bin/env node
/** Q3/Q9: session-level behavior of enforcement + retry correlation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const mod = await import(new URL("../extensions/degradation-status.ts", import.meta.url).href);
const sandbox = (t) => { const d=fs.mkdtempSync(path.join(os.tmpdir(),"sess-")); t.after(()=>fs.rmSync(d,{recursive:true,force:true})); return d; };
const mk = (cwd, probe) => {
  const h = new Map();
  const pi = { on:(n,f)=>h.set(n,f), registerTool(){}, };
  mod.default(pi, { probe });
  return { emit:(n,e,c={ui:{setStatus(){},notify(){}},cwd})=>h.get(n)(e,c), h };
};

test("Q3: enforcement flips routing from paid to blocked when local is up", async (t) => {
  const d=sandbox(t);
  const scripts=path.join(d,"scripts"); fs.mkdirSync(scripts); fs.writeFileSync(path.join(scripts,"fetch.sh"),"#!/bin/sh\n",{mode:0o755});
  process.env.FETCH_LOCAL_ENFORCE="1"; process.env.FETCH_CHOICE_LOG=path.join(d,"c.jsonl");
  t.after(()=>delete process.env.FETCH_LOCAL_ENFORCE);
  const up=mk(d, async()=>true), down=mk(d, async()=>false);
  const paid={toolName:"web_search",input:{query:"routing test"}};
  assert.equal((await up.emit("tool_call",paid,{cwd:d}))?.block,true,"local up -> block paid");
  assert.equal(await down.emit("tool_call",paid,{cwd:d}),undefined,"local down -> allow paid");
});

test("Q9: a paid call after a local one is recorded as a retry", async (t) => {
  const d=sandbox(t); const log=path.join(d,"o.jsonl");
  const hash=mod.queryHashOf({input:{query:"same query"}});
  assert.ok(mod.appendOutcome(log,{queryHash:hash,provider:"local",tool:"fetch_local",ok:true}));
  assert.ok(mod.appendOutcome(log,{queryHash:hash,provider:"paid",tool:"web_search",ok:true}));
  const lines=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines[1].retried_with,"fetch_local");
  // a different query must NOT be a retry
  const other=mod.queryHashOf({input:{query:"different"}});
  mod.appendOutcome(log,{queryHash:other,provider:"paid",tool:"web_search",ok:true});
  const all=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(all[2].retried_with,undefined);
  const retryRate=all.filter(r=>r.retried_with).length/all.length;
  assert.equal(retryRate,1/3);
});

test("Q9: outcome log never stores the raw query", async (t) => {
  const d=sandbox(t); const log=path.join(d,"o.jsonl");
  const h=mod.queryHashOf({input:{query:"TOP-SECRET-CANARY"}});
  mod.appendOutcome(log,{queryHash:h,provider:"paid",tool:"web_search",ok:true});
  assert.ok(!fs.readFileSync(log,"utf8").includes("TOP-SECRET-CANARY"));
});
