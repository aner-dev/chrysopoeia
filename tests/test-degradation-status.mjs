#!/usr/bin/env node
/**
 * test-degradation-status.mjs — offline suite for extensions/degradation-status.ts.
 *
 * Run: node --test tests/extensions/test-degradation-status.mjs
 *
 * The real extension file is imported directly (the host node, v22.23.5, strips
 * TypeScript types natively, no flag). That is only possible because the file
 * uses `import type { ExtensionAPI }`, whose statement node erases completely;
 * the inline `import { type ExtensionAPI }` form is erased to `import {} from
 * "..."` and would still resolve the SDK package, so this suite proves the
 * "dependency-free" contract rather than assuming it.
 *
 * The harness is stubbed end to end: `pi` only records the handlers, `ctx.ui`
 * only records calls, and every file lives under a per-test mkdtemp sandbox in
 * the system temp dir (never in the worktree). Poll cadence is compressed with
 * DEGRADATION_STATUS_POLL_MS so no case waits five seconds.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const mod = await import(new URL("../extension/degradation-status.ts", import.meta.url).href);

const POLL_MS = "25";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 3000, step = 15 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(step);
  }
  return predicate();
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "degradation-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sink = path.join(dir, "degradation.jsonl");
  return { dir, sink };
}

/** Set env for one test and restore it afterwards. */
function withEnv(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Stub `pi` + `ctx`: capture handlers, footer writes and notifications. */
function harness(overrides = {}) {
  const handlers = new Map();
  const statuses = [];
  const notifies = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const ctx = {
    cwd: overrides.cwd,
    env: overrides.env,
    ui: {
      setStatus: (key, value) => statuses.push([key, value]),
      notify: (text, level) => notifies.push([text, level]),
    },
  };
  const emit = (name, event) => handlers.get(name)(event, ctx);
  return { pi, ctx, handlers, statuses, notifies, emit };
}

const event = (overrides = {}) => ({
  ts: "2026-01-01T00:00:00.000Z",
  producer: "fetch",
  from: "L4",
  to: "L3",
  reason: "429",
  latency_ms: 812,
  exit: 0,
  ...overrides,
});

/** Boot the extension on an empty sink and return the live harness. */
async function boot(t, { sink, content = "" }) {
  fs.mkdirSync(path.dirname(sink), { recursive: true });
  fs.writeFileSync(sink, content);
  withEnv(t, { FETCH_EVENTS_SINK: sink, DEGRADATION_STATUS_POLL_MS: POLL_MS });
  const h = harness();
  mod.default(h.pi);
  await h.emit("session_start", {});
  return h;
}

test("sink path resolution honours FETCH_EVENTS_SINK, then XDG_STATE_HOME, then the home default", () => {
  assert.equal(mod.resolveSinkPath({ FETCH_EVENTS_SINK: "/tmp/explicit.jsonl" }), "/tmp/explicit.jsonl");
  assert.equal(
    mod.resolveSinkPath({ XDG_STATE_HOME: "/tmp/state" }),
    "/tmp/state/agent-events/degradation.jsonl",
  );
  assert.equal(
    mod.resolveSinkPath({}),
    path.join(os.homedir(), ".local", "state", "agent-events", "degradation.jsonl"),
  );
});

test("a new sink line updates the footer and notifies exactly once", async (t) => {
  const { sink } = sandbox(t);
  const h = await boot(t, { sink });

  fs.appendFileSync(sink, `${JSON.stringify(event())}\n`);

  assert.ok(await waitFor(() => h.notifies.length > 0), "expected one notification for the new line");
  await sleep(POLL_MS * 4); // several further ticks must not ring the bell again

  assert.equal(h.notifies.length, 1);
  assert.deepEqual(h.notifies[0], ["fetch: downgrade L4->L3 (429) 812ms", "warning"]);
  assert.equal(h.statuses.length, 1);
  assert.deepEqual(h.statuses[0], ["degradation", "fetch: downgrade L4->L3 (429)"]);
});

test("the 5-minute throttle suppresses a second notification for the same reason", async (t) => {
  const { sink } = sandbox(t);
  const h = await boot(t, { sink });

  fs.appendFileSync(sink, `${JSON.stringify(event())}\n`);
  assert.ok(await waitFor(() => h.notifies.length === 1));
  fs.appendFileSync(sink, `${JSON.stringify(event({ from: "L3", to: "L2", latency_ms: 940 }))}\n`);

  assert.ok(await waitFor(() => h.statuses.length === 2), "the footer must keep tracking sustained degradation");
  await sleep(POLL_MS * 4);

  assert.equal(h.notifies.length, 1, "second notify within the window must be throttled");
  assert.deepEqual(h.statuses.at(-1), ["degradation", "fetch: downgrade L3->L2 (429)"]);
});

test("malformed sink lines are skipped without throwing and do not disturb valid ones", async (t) => {
  const { sink } = sandbox(t);
  const h = await boot(t, {
    sink,
    content: [
      "not json at all",
      '{"from":"L4"}',
      "[1,2,3]",
      "",
      '{"producer":"fetch","from":"L4","to":"L3","reason":"429","latency_ms":10,"exit":0}',
      '{"to":"L1"}',
      "",
    ].join("\n"),
  });

  assert.deepEqual(h.statuses, [["degradation", "fetch: downgrade L4->L3 (429)"]]);
  assert.equal(h.notifies.length, 0, "priming must never notify about historic events");

  fs.appendFileSync(sink, '}{oops\nstill not json\n');
  await sleep(POLL_MS * 4);

  assert.deepEqual(h.statuses, [["degradation", "fetch: downgrade L4->L3 (429)"]]);
  assert.equal(h.notifies.length, 0);
});

test("web_search observer notifies on a 429 marker only, throttled per reason", async (t) => {
  const { sink } = sandbox(t);
  const h = await boot(t, { sink });

  const result = await h.emit("tool_execution_end", { toolName: "bash", result: "Error: 429 Too Many Requests" });
  assert.equal(result, undefined, "the observer must return nothing");
  assert.equal(h.notifies.length, 0, "non-web_search tools are ignored");

  await h.emit("tool_execution_end", {
    toolName: "web_search",
    result: { content: [{ type: "text", text: '{"results":[{"title":"clean"}]}' }] },
  });
  assert.equal(h.notifies.length, 0, "a clean web_search result must not notify");

  await h.emit("tool_execution_end", { name: "web_search", output: "Exa API error: 429 Too Many Requests" });
  assert.deepEqual(h.notifies, [["web_search degraded (429)", "warning"]]);

  await h.emit("tool_execution_end", { tool: { name: "web-search" }, result: "cooldown active for this key" });
  assert.equal(h.notifies.length, 1, "a second hit inside the window is throttled");

  assert.equal(h.statuses.length, 0, "the observer never touches the footer");
});

test("a missing sink never throws and never notifies", async (t) => {
  const { dir } = sandbox(t);
  withEnv(t, {
    FETCH_EVENTS_SINK: path.join(dir, "absent", "degradation.jsonl"),
    DEGRADATION_STATUS_POLL_MS: POLL_MS,
  });
  const h = harness();
  mod.default(h.pi);

  await assert.doesNotReject(() => h.emit("session_start", {}));
  await sleep(POLL_MS * 4); // let the poller hit the missing path repeatedly

  assert.equal(h.notifies.length, 0);
  assert.equal(h.statuses.length, 0);
  assert.equal(await h.emit("tool_execution_end", { toolName: "web_search", result: "429" }), undefined);
});

test("session_start adopts a non-empty sink silently and truncates what it surfaces", async (t) => {
  const { sink } = sandbox(t);
  const longReason = `rate-limited-${"x".repeat(400)}`;
  const h = await boot(t, { sink, content: `${JSON.stringify(event({ reason: longReason }))}\n` });

  assert.equal(h.notifies.length, 0);
  assert.equal(h.statuses.length, 1);
  const [key, text] = h.statuses[0];
  assert.equal(key, "degradation");
  assert.ok(text.length <= 160, `surfaced text must be truncated, got ${text.length} chars`);
  assert.ok(text.startsWith("fetch: downgrade L4->L3 (rate-limited-"));
  assert.ok(text.endsWith("~"));
});

// ---------------------------------------------------------------------------
// Tier 3a (T6): fetch_local tool + usage footer
// ---------------------------------------------------------------------------

/** Write an executable fake `scripts/fetch.sh` under `dir`. */
function fakeFetchScript(t, dir, body) {
  const scripts = path.join(dir, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const file = path.join(scripts, "fetch.sh");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

const TOOL_ENV = () => ({ PATH: process.env.PATH ?? "", HOME: os.homedir() });

test("fetch_local search returns the script stdout and passes args as an array", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, 'printf "argc=%s\\n" "$#"\nprintf "a1=%s\\n" "$1"\nprintf "a2=%s\\n" "$2"');

  const tool = mod.buildFetchLocalTool({ cwd: dir, env: TOOL_ENV() });
  const out = await tool.execute("call-1", { action: "search", query: "hello world" });

  const text = out.content[0].text;
  assert.match(text, /argc=2/, "query with a space must arrive as ONE argument");
  assert.match(text, /a1=search/);
  assert.match(text, /a2=hello world/);
});

test("fetch_local reports a clear error when scripts/fetch.sh is absent", async (t) => {
  const { dir } = sandbox(t);
  const tool = mod.buildFetchLocalTool({ cwd: dir, env: TOOL_ENV() });
  const out = await tool.execute("call-2", { action: "search", query: "x" });

  assert.match(out.content[0].text, /scripts\/fetch\.sh not found/);
});

test("fetch_local maps exit 1 and exit 2 to distinct text, never a tool error", async (t) => {
  const dir1 = sandbox(t).dir;
  fakeFetchScript(t, dir1, "exit 1");
  const out1 = await mod
    .buildFetchLocalTool({ cwd: dir1, env: TOOL_ENV() })
    .execute("c", { action: "search", query: "x" });
  assert.match(out1.content[0].text, /exit 1/);
  assert.match(out1.content[0].text, /no results or upstream failed/);

  const dir2 = sandbox(t).dir;
  fakeFetchScript(t, dir2, "exit 2");
  const out2 = await mod
    .buildFetchLocalTool({ cwd: dir2, env: TOOL_ENV() })
    .execute("c", { action: "scrape", url: "http://x/" });
  assert.match(out2.content[0].text, /exit 2/);
  assert.notEqual(out1.content[0].text, out2.content[0].text);
});

test("fetch_local validates params without spawning", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, "exit 0");
  const tool = mod.buildFetchLocalTool({ cwd: dir, env: TOOL_ENV() });

  const badAction = await tool.execute("c", { action: "nope" });
  assert.match(badAction.content[0].text, /must be "search" or "scrape"/);

  const missing = await tool.execute("c", { action: "search" });
  assert.match(missing.content[0].text, /"query" is required/);
});

test("fetch_local truncates oversized output with a marker", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, "head -c 20000 /dev/zero | tr '\\0' 'x'");

  const tool = mod.buildFetchLocalTool({ cwd: dir, env: TOOL_ENV() });
  const out = await tool.execute("c", { action: "search", query: "x" });

  assert.match(out.content[0].text, /\[fetch_local\] output truncated at 8192 chars/);
  assert.ok(out.content[0].text.length < 9000, `must stay bounded, got ${out.content[0].text.length}`);
});

test("a bash call to fetch.sh paints the usage footer and notifies nothing", async (t) => {
  const { dir } = sandbox(t);
  const logDir = path.join(dir, "fetch-stack");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "calls.log"),
    `${JSON.stringify({
      ts: "2026-11-19T18:54:46Z",
      cmd: "search",
      arg: "q",
      layer: "L3",
      results: 20,
      latency_ms: 1883,
      exit: 0,
    })}\n`,
  );
  withEnv(t, { XDG_STATE_HOME: dir, DEGRADATION_STATUS_POLL_MS: POLL_MS });

  const h = harness();
  mod.default(h.pi);
  await h.emit("tool_execution_end", {
    toolName: "bash",
    input: { command: "scripts/fetch.sh search q" },
  });

  assert.deepEqual(h.statuses.at(-1), ["fetch", "fetch: L3 hit, 20 results, 1.9s"]);
  assert.equal(h.notifies.length, 0, "usage must never notify");
});

test("an unrelated bash call leaves the usage footer untouched", async (t) => {
  const { dir } = sandbox(t);
  withEnv(t, { XDG_STATE_HOME: dir, DEGRADATION_STATUS_POLL_MS: POLL_MS });

  const h = harness();
  mod.default(h.pi);
  await h.emit("tool_execution_end", { toolName: "bash", input: { command: "ls -la" } });

  assert.equal(h.statuses.length, 0);
});

// ---------------------------------------------------------------------------
// Slice A: provider-choice log (routing measurement)
// ---------------------------------------------------------------------------

test("slice B: default is OFF — web_search is never blocked", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, "exit 0");
  withEnv(t, { XDG_STATE_HOME: dir, DEGRADATION_STATUS_POLL_MS: POLL_MS });
  delete process.env.FETCH_LOCAL_ENFORCE;

  const h = harness({ cwd: dir, probe: async () => true });
  mod.default(h.pi, { probe: async () => true });
  const decision = await h.emit("tool_call", { toolName: "web_search" });

  assert.equal(decision, undefined, "enforcement must be opt-in");
});

test("slice B: enforce on + local up blocks web_search and names fetch_local", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, "exit 0");
  withEnv(t, {
    XDG_STATE_HOME: dir,
    DEGRADATION_STATUS_POLL_MS: POLL_MS,
    FETCH_LOCAL_ENFORCE: "1",
  });

  const h = harness({ cwd: dir });
  mod.default(h.pi, { probe: async () => true });
  const decision = await h.emit("tool_call", { toolName: "web_search" });

  assert.equal(decision?.block, true);
  assert.match(decision.reason, /fetch_local/);
});

test("slice B: enforce on + local down lets web_search through", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, "exit 0");
  withEnv(t, {
    XDG_STATE_HOME: dir,
    DEGRADATION_STATUS_POLL_MS: POLL_MS,
    FETCH_LOCAL_ENFORCE: "1",
  });

  const h = harness({ cwd: dir });
  mod.default(h.pi, { probe: async () => false });
  const decision = await h.emit("tool_call", { toolName: "web_search" });

  assert.equal(decision, undefined, "a down stack must not remove the paid fallback");
});

test("slice B: no checkout in cwd lets web_search through", async (t) => {
  const { dir } = sandbox(t); // no scripts/fetch.sh here
  withEnv(t, {
    XDG_STATE_HOME: dir,
    DEGRADATION_STATUS_POLL_MS: POLL_MS,
    FETCH_LOCAL_ENFORCE: "1",
  });

  const h = harness({ cwd: dir });
  mod.default(h.pi, { probe: async () => true });
  const decision = await h.emit("tool_call", { toolName: "web_search" });

  assert.equal(decision, undefined);
});

test("slice B: a probe that throws fails open", async (t) => {
  const { dir } = sandbox(t);
  fakeFetchScript(t, dir, "exit 0");
  withEnv(t, {
    XDG_STATE_HOME: dir,
    DEGRADATION_STATUS_POLL_MS: POLL_MS,
    FETCH_LOCAL_ENFORCE: "1",
  });

  const h = harness({ cwd: dir });
  mod.default(h.pi, {
    probe: async () => {
      throw new Error("boom");
    },
  });
  const decision = await h.emit("tool_call", { toolName: "web_search" });

  assert.equal(decision, undefined, "an internal error must never block a search");
});

test("a web_search call is recorded in the provider-choice log", async (t) => {
  const { dir } = sandbox(t);
  withEnv(t, { XDG_STATE_HOME: dir, DEGRADATION_STATUS_POLL_MS: POLL_MS });

  const h = harness();
  mod.default(h.pi);
  await h.emit("tool_execution_end", { toolName: "web_search", result: "ok" });

  const log = path.join(dir, "agent-events", "provider-choice.jsonl");
  assert.ok(fs.existsSync(log), "choice log must exist");
  const rec = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
  assert.equal(rec.tool, "web_search");
  assert.equal(rec.ok, true);
  assert.equal(typeof rec.ts, "string");
});

test("fetch_local is recorded too, and the query text never reaches the log", async (t) => {
  const { dir } = sandbox(t);
  withEnv(t, { XDG_STATE_HOME: dir, DEGRADATION_STATUS_POLL_MS: POLL_MS });

  const h = harness();
  mod.default(h.pi);
  await h.emit("tool_execution_end", {
    toolName: "fetch_local",
    input: { action: "search", query: "SECRET-CANARY-QUERY" },
    result: "results",
  });

  const log = path.join(dir, "agent-events", "provider-choice.jsonl");
  const raw = fs.readFileSync(log, "utf8");
  const rec = JSON.parse(raw.trim().split("\n").pop());
  assert.equal(rec.tool, "fetch_local");
  assert.ok(!raw.includes("SECRET-CANARY-QUERY"), "prompt text must never be logged");
});

test("a failed web_search is recorded with ok=false", async (t) => {
  const { dir } = sandbox(t);
  withEnv(t, { XDG_STATE_HOME: dir, DEGRADATION_STATUS_POLL_MS: POLL_MS });

  const h = harness();
  mod.default(h.pi);
  await h.emit("tool_execution_end", { toolName: "web_search", result: "Error: rate limited" });

  const log = path.join(dir, "agent-events", "provider-choice.jsonl");
  const rec = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
  assert.equal(rec.ok, false);
});

test("an unwritable choice log never breaks the observer", async (t) => {
  const { dir } = sandbox(t);
  const readOnly = path.join(dir, "readonly");
  fs.mkdirSync(readOnly, { recursive: true });
  fs.chmodSync(readOnly, 0o500);
  withEnv(t, { XDG_STATE_HOME: readOnly, DEGRADATION_STATUS_POLL_MS: POLL_MS });

  const h = harness();
  mod.default(h.pi);
  await assert.doesNotReject(() =>
    h.emit("tool_execution_end", { toolName: "web_search", result: "ok" }),
  );
  assert.equal(h.notifies.length, 0);
});
