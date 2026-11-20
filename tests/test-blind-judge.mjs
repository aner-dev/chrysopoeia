#!/usr/bin/env node
/** Hermetic checks for the blind-judge harness: shuffle + unblind integrity. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const B = path.join(import.meta.dirname, "..", "benchmarks");
const read = (f) => JSON.parse(fs.readFileSync(path.join(B, f), "utf8"));

test("blind package contains no provider identity markers", () => {
  const raw = fs.readFileSync(path.join(B, "blind-package.json"), "utf8");
  // Whole-word / exact markers only: "hexabase" contains "exa", and words like
  // "local reply" (Envoy) or "Provider" (Flux CRD) are legitimate technical text.
  for (const marker of [/\bsearxng\b/i, /\bcrw\b/i, /\bexa (api|mcp|keyless|search)\b/i,
                        /\*\*Provider:\*\*/i, /"provider"\s*:/i, /home-made/i]) {
    assert.ok(!marker.test(raw), `leaked identity: ${marker}`);
  }
});

test("every query has exactly two arms and a key", () => {
  const pkg = read("blind-package.json");
  const key = read("blind-key.json");
  assert.equal(Object.keys(pkg).length, 9);
  for (const [id, q] of Object.entries(pkg)) {
    assert.ok(q.A && q.B, `${id} missing an arm`);
    assert.notDeepEqual(q.A, q.B, `${id}: arms are identical`);
    assert.ok(["A", "B"].includes(key[id]), `${id}: bad key`);
  }
});

test("unblinding matches the source arms", () => {
  const pkg = read("blind-package.json");
  const key = read("blind-key.json");
  const exa = read("answers-exa-arm.json");
  const local = read("answers-local-arm.json");
  for (const [id, exaSide] of Object.entries(key)) {
    const localSide = exaSide === "A" ? "B" : "A";
    assert.deepEqual(pkg[id][exaSide].results, exa[id].results, `${id}: exa mismatch`);
    assert.deepEqual(pkg[id][localSide].results, local[id].results, `${id}: local mismatch`);
  }
});

test("aggregate scores are internally consistent", () => {
  const verdict = read("blind-verdict.json");
  assert.equal(verdict.wins.local + verdict.wins.exa + verdict.wins.tie, 9);
  assert.equal(verdict.detail.length, 9);
  for (const d of verdict.detail) assert.ok(["local", "exa", "tie"].includes(d.winner));
  assert.ok(verdict.scores.exa.actionability > verdict.scores.local.actionability,
    "verdict should reflect the judge's observed specificity edge");
});

test("shuffle is not degenerate (both identities appear in each side)", () => {
  const key = read("blind-key.json");
  const a = Object.values(key).filter((v) => v === "A").length;
  assert.ok(a > 0 && a < 9, `degenerate shuffle: ${a}/9`);
});
