/**
 * degradation-status — Tier 2 delivery for the degradation event bus (S1, S5).
 *
 * Reads the agnostic JSONL sink (`$FETCH_EVENTS_SINK`, else
 * `$XDG_STATE_HOME/agent-events/degradation.jsonl`, else
 * `~/.local/state/agent-events/degradation.jsonl`) and surfaces each new
 * `{ts, producer, from, to, reason, latency_ms, exit}` event in the TUI footer
 * (`ui.setStatus`) plus one throttled warning (`ui.notify`, at most 1 per
 * reason per 5 min — the bell must not ring per call).
 *
 * It also observes `tool_execution_end` for `web_search` and surfaces a
 * rate-limit / cooldown marker found in the finalized result. Read-only by
 * construction: no handler returns a value, mutates the event, or throws.
 *
 * Dependency-free by contract: `import type` of the SDK is erased at runtime,
 * and every other import is a node builtin. Use `import type { ... }` (not the
 * inline `import { type ... }` form) — the inline form is erased to an empty
 * `import {} from "..."` and still resolves the package, which breaks any host
 * that loads this file without the SDK present (e.g. `node --test`).
 *
 * Every surfaced string is truncated to 160 chars. The contract for the sink is
 * codes/hashes only, but truncation keeps a misbehaving producer from pushing
 * prompt text or PII into the footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const STATUS_KEY = "degradation";
const NOTIFY_THROTTLE_MS = 5 * 60 * 1000;
const MAX_SURFACED_CHARS = 160;
const SCAN_CAP_CHARS = 4096;
const DEFAULT_POLL_MS = 5000;
const MIN_POLL_MS = 16;
const WEB_SEARCH_RE = /^web[-_]?search$/i;
const MARKER_RE = /429|rate.?limit|cooldown|providers used/i;

// Tier 3a (T6): the local fetch stack had NO usage surface — it is reached only
// when the agent happens to run `scripts/fetch.sh` by bash, so "is my stack being
// used?" was unanswerable. `fetch_local` gives it a native card and lets the agent
// choose it; the bash observer paints the footer for direct script runs.
const USAGE_STATUS_KEY = "fetch";
const BASH_RE = /^bash$/i;
// Provider-choice log (slice A): the routing question — "does the agent pick Exa
// while the local stack is available?" — is unanswerable without a record of
// which provider served each search. One JSONL line per web_search/fetch_local
// call, no prompt text, never fatal.
const CHOICE_LOG_REL = path.join("agent-events", "provider-choice.jsonl");
const OUTCOME_LOG_REL = path.join("agent-events", "search-outcome.jsonl");
const LOCAL_TOOL_RE = /^fetch_local$/i;
// Slice B: deterministic routing. Default OFF — enforcement is opt-in through
// FETCH_LOCAL_ENFORCE=1 so merging this never changes anyone's behavior. When
// on, a `web_search` call is blocked *only if the local stack actually answers*;
// if the stack is down the paid path stays available as the fallback.
const ENFORCE_ENV = "FETCH_LOCAL_ENFORCE";
const DEFAULT_SEARXNG_PORT = 8080;
const FETCH_SCRIPT_RE = /scripts\/fetch(?:-smart)?\.sh/;
const CALLS_LOG_REL = path.join("fetch-stack", "calls.log");
const MAX_TOOL_OUTPUT_CHARS = 8192;
const SPAWN_TIMEOUT_MS = 60_000;
// Minimal env: fetch.sh needs no API key for L2/L3, so the whole ambient env
// (which may carry credentials) is deliberately not forwarded.
const SPAWN_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "FETCH_EVENTS_SINK",
];

/** One sink event (S1 schema), normalized: only the fields we surface. */
export interface DegradationEvent {
  producer: string;
  from: string;
  to: string;
  reason: string;
  latencyMs?: number;
}

/** The slice of `ExtensionContext` this extension touches. */
interface UiLike {
  setStatus?: (key: string, text?: string) => void;
  notify?: (text: string, level?: string) => void;
}

interface CtxLike {
  ui?: UiLike;
}

interface SinkScanState {
  path?: string;
  offset: number;
  mtimeMs: number;
}

/** Truncate any string that reaches the TUI. */
export function trunc(value: unknown, max = MAX_SURFACED_CHARS): string {
  const str = typeof value === "string" ? value : String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}~` : str;
}

/** Resolve the sink path from env, never throwing. */
export function resolveSinkPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.FETCH_EVENTS_SINK ?? "").trim();
  if (explicit) return explicit;
  const stateHome = (env.XDG_STATE_HOME ?? "").trim();
  const base = stateHome || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agent-events", "degradation.jsonl");
}

/** Poll cadence; `DEGRADATION_STATUS_POLL_MS` exists so tests need not wait 5s. */
export function pollIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(String(env.DEGRADATION_STATUS_POLL_MS ?? ""), 10);
  return Number.isFinite(raw) && raw >= MIN_POLL_MS ? raw : DEFAULT_POLL_MS;
}

/** Parse one sink line, returning null for anything malformed (never throws). */
export function parseSinkEvent(line: unknown): DegradationEvent | null {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const from = typeof rec.from === "string" ? rec.from.trim() : "";
  const to = typeof rec.to === "string" ? rec.to.trim() : "";
  if (!from || !to) return null;
  const reason = typeof rec.reason === "string" && rec.reason.trim() ? rec.reason.trim() : "unknown";
  const producer = typeof rec.producer === "string" && rec.producer.trim() ? rec.producer.trim() : "fetch";
  const latencyMs =
    typeof rec.latency_ms === "number" && Number.isFinite(rec.latency_ms) ? rec.latency_ms : undefined;
  return { producer, from, to, reason, latencyMs };
}

/** The one human line used by both the footer and the notification. */
export function formatEventLine(event: DegradationEvent): string {
  return trunc(`${event.producer}: downgrade ${event.from}->${event.to} (${event.reason})`);
}

/** Footer line plus measured latency (the reason to look at the clock). */
export function formatNotifyLine(event: DegradationEvent): string {
  const base = formatEventLine(event);
  if (typeof event.latencyMs !== "number") return base;
  return trunc(`${base} ${Math.round(event.latencyMs)}ms`);
}

/** First rate-limit marker in a bounded scan of `text`, or null. */
export function firstMarker(text: unknown): string | null {
  if (typeof text !== "string" || !text) return null;
  const match = MARKER_RE.exec(text.slice(0, SCAN_CAP_CHARS));
  return match ? trunc(match[0].toLowerCase()) : null;
}

/** Best-effort tool name across the event shapes the harness may send. */
export function toolNameOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const rec = event as Record<string, unknown>;
  for (const key of ["toolName", "tool_name", "name", "tool"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).name;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return "";
}

/**
 * Collect candidate result text from a finalized tool event. Deliberately
 * whitelists result-bearing keys only: arguments/inputs (prompt text, search
 * queries) are never scanned, let alone surfaced.
 */
const RESULT_KEYS = ["result", "output", "content", "text", "stdout", "stderr", "error", "message"];
export function resultTextOf(event: unknown, depth = 0): string {
  if (typeof event === "string") return event.slice(0, SCAN_CAP_CHARS);
  if (depth > 4) return "";
  if (Array.isArray(event)) {
    let out = "";
    for (const item of event) {
      out += resultTextOf(item, depth + 1);
      if (out.length >= SCAN_CAP_CHARS) break;
    }
    return out.slice(0, SCAN_CAP_CHARS);
  }
  if (!event || typeof event !== "object") return "";
  const rec = event as Record<string, unknown>;
  let out = "";
  for (const key of RESULT_KEYS) {
    if (!(key in rec)) continue;
    out += resultTextOf(rec[key], depth + 1);
    if (out.length >= SCAN_CAP_CHARS) break;
  }
  return out.slice(0, SCAN_CAP_CHARS);
}

/** Read the not-yet-consumed, complete lines of the sink. Never throws. */
export function readNewSinkLines(sinkPath: string, state: SinkScanState): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sinkPath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  if (stat.size === state.offset && stat.mtimeMs === state.mtimeMs) return [];
  if (stat.size < state.offset) state.offset = 0; // truncated or rotated
  state.mtimeMs = stat.mtimeMs;
  const length = stat.size - state.offset;
  if (length <= 0) {
    state.offset = Math.max(0, stat.size);
    return [];
  }
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  try {
    const fd = fs.openSync(sinkPath, "r");
    try {
      read = fs.readSync(fd, buffer, 0, length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const chunk = buffer.subarray(0, read).toString("utf8");
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) return []; // partial line mid-append: wait for the newline
  const complete = chunk.slice(0, lastNewline);
  state.offset += Buffer.byteLength(complete, "utf8") + 1;
  return complete.split("\n");
}

/** One line of the fetch-stack call log (scripts/fetch.sh log_call). */
export interface CallEntry {
  cmd?: string;
  layer?: string;
  results?: number;
  latencyMs?: number;
  exit?: number;
  arg?: string;
}

/** Parse one calls.log line; null when malformed (never throws). */
export function parseCallLogLine(line: unknown): CallEntry | null {
  if (typeof line !== "string" || !line.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const entry: CallEntry = {};
  if (typeof rec.cmd === "string") entry.cmd = rec.cmd;
  if (typeof rec.layer === "string") entry.layer = rec.layer;
  if (typeof rec.arg === "string") entry.arg = rec.arg;
  if (typeof rec.results === "number" && Number.isFinite(rec.results)) entry.results = rec.results;
  if (typeof rec.latency_ms === "number" && Number.isFinite(rec.latency_ms)) entry.latencyMs = rec.latency_ms;
  if (typeof rec.exit === "number" && Number.isFinite(rec.exit)) entry.exit = rec.exit;
  return entry;
}

/** Resolve the fetch-stack call log path from env, never throwing. */
export function resolveCallsLogPath(env: Record<string, string | undefined> = process.env): string {
  const stateHome = (env.XDG_STATE_HOME ?? "").trim();
  const base = stateHome || path.join(os.homedir(), ".local", "state");
  return path.join(base, CALLS_LOG_REL);
}

/** Footer line for a usage event, e.g. `fetch: L3 hit, 20 results, 1.9s`. */
export function formatUsageLine(entry: CallEntry): string {
  const layer = entry.layer?.trim() || "L?";
  const cmd = entry.cmd?.trim();
  const what = cmd === "scrape" ? "scrape" : "hit";
  const results = typeof entry.results === "number" ? `${entry.results} results` : "no results";
  const ms = typeof entry.latencyMs === "number" ? `, ${(entry.latencyMs / 1000).toFixed(1)}s` : "";
  return trunc(`fetch: ${layer} ${what}, ${results}${ms}`);
}

/** Last non-empty line of the call log, reading only its tail. Never throws. */
export function latestCallLine(callsLogPath: string, maxBytes = 8192): string | null {
  try {
    const stat = fs.statSync(callsLogPath);
    if (!stat.isFile() || stat.size === 0) return null;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(callsLogPath, "r");
    try {
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      const lines = buf
        .subarray(0, read)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      return lines.length ? lines[lines.length - 1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Find `scripts/fetch.sh` in cwd or up to `maxDepth` parents. */
export function resolveFetchScript(cwd: string | undefined, maxDepth = 3): string | null {
  let dir = (cwd || "").trim();
  if (!dir) return null;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(dir, "scripts", "fetch.sh");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Cap tool output so a huge page cannot flood the context. */
export function truncateOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[fetch_local] output truncated at ${max} chars`;
}

export type FetchParamsCheck =
  | { ok: true; action: "search" | "scrape"; value: string }
  | { ok: false; message: string };

/** Validate tool params. Returns a message, never throws. */
export function validateFetchParams(params: unknown): FetchParamsCheck {
  const rec = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const action = typeof rec.action === "string" ? rec.action.trim() : "";
  if (action !== "search" && action !== "scrape") {
    return { ok: false, message: 'fetch_local: "action" must be "search" or "scrape".' };
  }
  const key = action === "search" ? "query" : "url";
  const raw = rec[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return { ok: false, message: `fetch_local: "${key}" is required when action=${action}.` };
  }
  return { ok: true, action, value };
}

export interface FetchRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run the script with an args array (never a shell string). Never rejects. */
export function runFetch(
  script: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = SPAWN_TIMEOUT_MS,
): Promise<FetchRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: FetchRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(script, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ code: null, stdout, stderr, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, error: err.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });
}

export interface FetchLocalTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

/**
 * The native tool. Parameters are a plain JSON Schema object on purpose: Pi
 * accepts JSON Schema directly, and importing typebox here would break the
 * offline `node --test` suite that imports this file.
 */
export function buildFetchLocalTool(
  deps: { env?: Record<string, string | undefined>; cwd?: string } = {},
): FetchLocalTool {
  const env = deps.env ?? process.env;
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

  return {
    name: "fetch_local",
    label: "Fetch Local",
    description:
      "Search or scrape with the local self-hosted fetch stack (SearXNG + CRW) instead of paid APIs. " +
      "Prefer it when a local-first or zero-quota path matters.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "scrape"],
          description: "search = query SearXNG; scrape = extract markdown from a URL via CRW",
        },
        query: { type: "string", description: "Search query (required when action=search)" },
        url: { type: "string", description: "Absolute URL (required when action=scrape)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const checked = validateFetchParams(params);
      if (!checked.ok) return text(checked.message);

      const cwd = deps.cwd ?? process.cwd();
      const script = resolveFetchScript(cwd);
      if (!script) {
        return text(
          "fetch_local: scripts/fetch.sh not found in this checkout. It lives in the homelab repo " +
            "(ADR-074 lane) — run from a homelab worktree.",
        );
      }

      const args = checked.action === "search" ? ["search", checked.value] : ["scrape", checked.value];
      const childEnv: Record<string, string> = {};
      for (const key of SPAWN_ENV_KEYS) {
        const value = env[key];
        if (typeof value === "string") childEnv[key] = value;
      }

      let result: FetchRunResult;
      try {
        result = await runFetch(script, args, childEnv);
      } catch (err) {
        return text(`fetch_local: could not run ${path.basename(script)} (${err instanceof Error ? err.message : String(err)})`);
      }

      const stderrTail = trunc(result.stderr.trim(), 400);
      if (result.error) return text(`fetch_local: ${result.error}${stderrTail ? ` — ${stderrTail}` : ""}`);
      if (result.code === 0) {
        const body = result.stdout.trim();
        return text(truncateOutput(body || "(no output)"));
      }
      if (result.code === 1) {
        return text(`fetch_local: no results or upstream failed (exit 1)${stderrTail ? ` — ${stderrTail}` : ""}`);
      }
      if (result.code === 2) {
        return text(`fetch_local: usage or config error (exit 2)${stderrTail ? ` — ${stderrTail}` : ""}`);
      }
      return text(`fetch_local: failed (exit ${result.code})${stderrTail ? ` — ${stderrTail}` : ""}`);
    },
  };
}

/** Resolve the provider-choice log path from env, never throwing. */
export function resolveChoiceLogPath(env: Record<string, string | undefined> = process.env): string {
  const stateHome = (env.XDG_STATE_HOME ?? "").trim();
  const base = stateHome || path.join(os.homedir(), ".local", "state");
  return path.join(base, CHOICE_LOG_REL);
}

/**
 * Append one provider-choice record. Best-effort: a full disk or a read-only
 * state dir degrades to "no record", never to a broken session. The payload is
 * tool name + cwd + timestamp only — never the query, never the results.
 */
export function appendChoice(
  choiceLogPath: string,
  record: { tool: string; cwd?: string; ok?: boolean },
): boolean {
  try {
    const dir = path.dirname(choiceLogPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: trunc(record.tool, 40),
      cwd: trunc(record.cwd ?? "", 200),
      ok: record.ok === true,
    });
    fs.appendFileSync(choiceLogPath, `${line}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the search-outcome log path from env, never throwing. */
export function resolveOutcomeLogPath(env: Record<string, string | undefined> = process.env): string {
  const stateHome = (env.XDG_STATE_HOME ?? "").trim();
  const base = stateHome || path.join(os.homedir(), ".local", "state");
  return path.join(base, OUTCOME_LOG_REL);
}

/** One-way query fingerprint: the raw query NEVER reaches a sink. */
export function queryHashOf(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const input = (event as Record<string, unknown>).input;
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).query ?? (input as Record<string, unknown>).url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return `sha256:${createHash("sha256").update(raw.trim()).digest("hex")}`;
}

/** Read the tail of the outcome log for retry correlation. Never throws. */
export function readRecentOutcomes(outcomePath: string, maxBytes = 65536): Array<Record<string, unknown>> {
  try {
    const stat = fs.statSync(outcomePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(outcomePath, "r");
    try {
      const buf = Buffer.allocUnsafe(stat.size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      return buf.subarray(0, read).toString("utf8").split("\n")
        .filter((l) => l.trim())
        .map((l) => { try { const v = JSON.parse(l); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; } })
        .filter((v): v is Record<string, unknown> => v !== null);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

export interface OutcomeRecord {
  queryHash: string;
  provider: "local" | "paid";
  tool: string;
  klass?: string;
  latencyMs?: number;
  withContent?: number;
  ok: boolean;
}

/** Append one outcome record. A paid search after a local one with the SAME
 * hash within 60s gets retried_with — local did not serve. Never throws. */
export function appendOutcome(outcomePath: string, record: OutcomeRecord): boolean {
  try {
    const dir = path.dirname(outcomePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let retriedWith: string | undefined;
    if (record.provider === "paid") {
      const now = Date.now();
      const prior = readRecentOutcomes(outcomePath).find((r) => {
        if (r.provider !== "local" || r.query_hash !== record.queryHash) return false;
        const prev = Date.parse(String(r.ts ?? ""));
        return Number.isFinite(prev) && now - prev < 60_000;
      });
      if (prior) retriedWith = String(prior.tool ?? "fetch_local");
    }
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      query_hash: record.queryHash,
      provider: record.provider,
      tool: trunc(record.tool, 40),
      class: record.klass ? trunc(record.klass, 40) : undefined,
      latency_ms: typeof record.latencyMs === "number" ? Math.round(record.latencyMs) : undefined,
      with_content: typeof record.withContent === "number" ? record.withContent : undefined,
      ok: record.ok === true,
    };
    if (retriedWith) line.retried_with = trunc(retriedWith, 40);
    fs.appendFileSync(outcomePath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

function countWithContent(text: string): number {
  try {
    const parsed = JSON.parse(text.slice(0, 20_000));
    const results = parsed && typeof parsed === "object" ? (parsed as { results?: unknown }).results : null;
    return Array.isArray(results)
      ? results.filter((r) => r && typeof r === "object" && String((r as { content?: unknown }).content ?? "").length > 200).length
      : 0;
  } catch { return 0; }
}

/** Is enforcement on? Default OFF, opt-in per environment. */
export function enforceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[ENFORCE_ENV] ?? "").trim() === "1";
}

/** Port of the local SearXNG, from `SEARXNG_URL` or the default. */
export function localPort(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.SEARXNG_URL ?? "").trim();
  const match = /^https?:\/\/[^/:]+:(\d+)/.exec(raw);
  if (match) return Number.parseInt(match[1], 10);
  return DEFAULT_SEARXNG_PORT;
}

/**
 * Can the local stack answer right now? A TCP connect, not a request: it must
 * be cheap enough to run before every web_search and must never throw.
 */
export function probeLocalStack(
  port = localPort(),
  timeoutMs = 400,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.destroy();
        finish(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        finish(false);
      });
      socket.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** Command text of a bash tool event, for matching only — never surfaced. */
export function commandOf(event: unknown, depth = 0): string {
  if (depth > 3 || !event || typeof event !== "object") return "";
  const rec = event as Record<string, unknown>;
  const direct = rec.command ?? rec.cmd;
  if (typeof direct === "string" && direct.trim()) return direct;
  for (const key of ["input", "arguments", "args", "params"]) {
    const nested = commandOf(rec[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

export default function degradationStatus(
  pi: ExtensionAPI,
  deps: { probe?: (port: number) => Promise<boolean> } = {},
): void {
  const enforceProbe = deps.probe;
  if (!pi || typeof pi.on !== "function") return;

  // Native tool registration (Tier 3a). Guarded: a host without registerTool
  // (and the offline test stub) degrades to the observer only.
  try {
    const register = (pi as unknown as { registerTool?: (tool: unknown) => void }).registerTool;
    if (typeof register === "function") register.call(pi, buildFetchLocalTool());
  } catch {
    /* a host that cannot register tools must still get the footer */
  }

  if (!pi || typeof pi.on !== "function") return;

  const state: SinkScanState = { offset: 0, mtimeMs: -1 };
  const notifyTimes = new Map<string, number>();
  const ctxRef: { current: CtxLike | undefined } = { current: undefined };
  let timer: ReturnType<typeof setInterval> | undefined;

  const setStatusKey = (ctx: CtxLike | undefined, key: string, text: string): void => {
    try {
      ctx?.ui?.setStatus?.(key, trunc(text));
    } catch {
      /* a footer that cannot update must never break a session */
    }
  };

  const setStatus = (ctx: CtxLike | undefined, text: string): void => {
    setStatusKey(ctx, STATUS_KEY, text);
  };

  const shouldNotify = (reason: string): boolean => {
    const now = Date.now();
    const previous = notifyTimes.get(reason) ?? 0;
    if (previous && now - previous < NOTIFY_THROTTLE_MS) return false;
    notifyTimes.set(reason, now);
    return true;
  };

  const notify = (ctx: CtxLike | undefined, text: string, reason: string): void => {
    try {
      if (!shouldNotify(reason)) return;
      ctx?.ui?.notify?.(trunc(text), "warning");
    } catch {
      /* notification is best-effort */
    }
  };

  /** Baseline: adopt existing content silently, surface only its last event. */
  const prime = (ctx: CtxLike | undefined): void => {
    try {
      state.path = resolveSinkPath();
      state.offset = 0;
      state.mtimeMs = -1;
      const lines = readNewSinkLines(state.path, state);
      const events: DegradationEvent[] = [];
      for (const line of lines) {
        const event = parseSinkEvent(line);
        if (event) events.push(event);
      }
      const last = events[events.length - 1];
      if (last) setStatus(ctx, formatEventLine(last));
      // Drain whatever still sits past the last newline so the poller starts clean.
      try {
        const stat = fs.statSync(state.path);
        state.offset = stat.size;
        state.mtimeMs = stat.mtimeMs;
      } catch {
        /* sink disappeared between reads: keep the drained offset */
      }
    } catch {
      /* an unreadable sink must never break session start */
    }
  };

  const poll = (): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    try {
      state.path = state.path ?? resolveSinkPath();
      const lines = readNewSinkLines(state.path, state);
      for (const line of lines) {
        const event = parseSinkEvent(line);
        if (!event) continue;
        setStatus(ctx, formatEventLine(event));
        notify(ctx, formatNotifyLine(event), event.reason);
      }
    } catch {
      /* polling is a pure observer: one bad tick must not kill the timer */
    }
  };

  const startPoller = (): void => {
    if (timer) clearInterval(timer);
    try {
      timer = setInterval(poll, pollIntervalMs());
      // Do not hold the process open on the poller alone (matters for hosts and tests).
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* no timers in this host: the extension degrades to session_start only */
    }
  };

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    try {
      ctxRef.current = (ctx ?? undefined) as CtxLike | undefined;
      prime(ctxRef.current);
      startPoller();
    } catch {
      /* never let the observer break session start */
    }
  });

  // Slice B: deterministic routing, opt-in. Blocks web_search only when
  // FETCH_LOCAL_ENFORCE=1 AND the local stack actually answers; otherwise the
  // paid path stays available as the fallback.
  pi.on("tool_call", async (event: unknown, ctx: unknown) => {
    try {
      const name = toolNameOf(event);
      if (!name || !WEB_SEARCH_RE.test(name)) return;
      const env = (ctx as { env?: Record<string, string | undefined> } | undefined)?.env ?? process.env;
      if (!enforceEnabled(env)) return;
      const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
      const where = typeof cwd === "string" && cwd ? cwd : process.cwd();
      if (!resolveFetchScript(where)) return; // no local stack in this checkout: allow
      const probe = enforceProbe ?? probeLocalStack;
      let reachable = false;
      try {
        reachable = await probe(localPort(env));
      } catch {
        reachable = false;
      }
      if (!reachable) return; // local stack down: the paid fallback must stay usable
      return {
        block: true,
        reason:
          "web_search is disabled while the local fetch stack answers " +
          "(FETCH_LOCAL_ENFORCE=1). Call fetch_local with action=search and the same query " +
          "instead; use web_search only if fetch_local reports the stack is unavailable.",
      };
    } catch {
      /* never block on an internal error: fail open to the paid path */
      return;
    }
  });

  pi.on("tool_execution_end", async (event: unknown, ctx: unknown) => {
    try {
      ctxRef.current = ((ctx ?? ctxRef.current) ?? undefined) as CtxLike | undefined;
      const name = toolNameOf(event);
      if (!name) return;

      // Bash usage observer: the command is matched only, never surfaced.
      if (BASH_RE.test(name)) {
        const command = commandOf(event);
        if (!command || !FETCH_SCRIPT_RE.test(command)) return;
        const line = latestCallLine(resolveCallsLogPath());
        const entry = line ? parseCallLogLine(line) : null;
        setStatusKey(
          ctxRef.current,
          USAGE_STATUS_KEY,
          entry ? formatUsageLine(entry) : "fetch: local stack used",
        );
        return; // usage never notifies
      }

      if (!WEB_SEARCH_RE.test(name) && !LOCAL_TOOL_RE.test(name)) return;

      // Provider-choice record: which provider served this search, and whether
      // the call itself succeeded. This is the measurement slice A needs —
      // without it, "is the agent using the local stack?" has no answer.
      const resultText = resultTextOf(event);
      const ok = !/\b(error|failed|exception)\b/i.test(resultText.slice(0, 400));
      try {
        const cwd = (ctxRef.current as { cwd?: unknown } | undefined)?.cwd;
        appendChoice(resolveChoiceLogPath(), {
          tool: name,
          cwd: typeof cwd === "string" ? cwd : "",
          ok,
        });
      } catch {
        /* the choice log is observability, never semantics */
      }

      // Outcome record (S4): one-way query hash + retry correlation. This is
      // what turns "share" into "success rate" and answers what % is paid for.
      try {
        const hash = queryHashOf(event);
        if (hash) {
          const input = (event as { input?: Record<string, unknown> }).input ?? {};
          const klass = typeof input.klass === "string" ? input.klass : undefined;
          const ev = event as { duration_ms?: unknown; latency_ms?: unknown };
          const latency = ev.duration_ms ?? ev.latency_ms;
          appendOutcome(resolveOutcomeLogPath(), {
            queryHash: hash,
            provider: LOCAL_TOOL_RE.test(name) ? "local" : "paid",
            tool: name,
            klass,
            latencyMs: typeof latency === "number" ? latency : undefined,
            withContent: countWithContent(resultText),
            ok,
          });
        }
      } catch {
        /* the outcome log is observability, never semantics */
      }

      if (!WEB_SEARCH_RE.test(name)) return;
      const marker = firstMarker(resultText);
      if (!marker) return;
      notify(ctxRef.current, `web_search degraded (${marker})`, "web_search");
    } catch {
      /* pure observer: never throws, never returns a value, never mutates */
    }
  });
}
