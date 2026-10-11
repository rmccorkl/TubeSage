// Stage 2: keep-alive and concurrency — the decisive test.
//
// Stage 0 measured 4.2 s for one request, of which ~3.6 s was a cold TCP +
// TLS handshake and only ~550 ms model time. The design is only viable if
// requests reuse connections.
//
//   A  keep-alive: 6 sequential requests on the client's one keep-alive
//      agent; socketReused and timings reported for EACH.
//   B  concurrency 1, 5, 10, 25: level 1 is 4 sequential requests, every
//      other level is one wave of that many requests in flight. Median and
//      p95 per level, socket reuse, and 429s.
//   C  a 429 is retried with backoff (Retry-After if given, else 1 s, 2 s),
//      at most 3 attempts per request. A request still rate-limited after
//      its retries is a SUSTAINED rate limit: climbing stops there, and the
//      ceiling is the highest level completed without one.
//
// A hard budget of 60 requests covers every attempt, retries included.
import { setTimeout as delay } from "node:timers/promises";
import { CELLS, sharedStateBody } from "../lib/cells.mjs";
import { formatTimings, percentile, recordRequest } from "../lib/measure.mjs";

export const STAGE2_MAX_REQUESTS = 60;
const KEEPALIVE_REQUESTS = 6;
const LEVELS = [1, 5, 10, 25];
const LEVEL_ONE_REQUESTS = 4;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;
// Kinds that will not get better by trying harder: stop the whole stage.
const FATAL_KINDS = new Set(["auth", "credits", "model-gone", "redirect-refused"]);

function bodyFor(index) {
  return sharedStateBody([CELLS[index % CELLS.length]]);
}

/** The budget's worth of requests: the upper bound the estimate is priced on. */
export function planStage2Bodies() {
  return Array.from({ length: STAGE2_MAX_REQUESTS }, (_, index) => bodyFor(index));
}

function createBudget(limit) {
  let used = 0;
  return {
    tryTake() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    used: () => used,
  };
}

/** Retry-After (seconds) when the server gives one, else 1 s, 2 s, ... capped at 30 s. */
export function backoffMs(attempt, headers) {
  const retryAfter = Number(headers?.["retry-after"]);
  const ms = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

async function attemptOnce(ctx, body, label) {
  if (!ctx.budget.tryTake()) return null;
  const result = await ctx.client.post(body);
  recordRequest(ctx.recorder, { label, body, key: ctx.key, result });
  return result;
}

async function waitBeforeRetry(ctx, attemptsSoFar, result) {
  if (attemptsSoFar >= MAX_ATTEMPTS) return;
  await ctx.sleep(backoffMs(attemptsSoFar, result.headers));
}

/** One logical request: retried on 429 with backoff. Returns every attempt's result. */
async function postWithBackoff(ctx, label) {
  const body = bodyFor(ctx.nextIndex());
  const attempts = [];
  while (attempts.length < MAX_ATTEMPTS) {
    const result = await attemptOnce(ctx, body, `${label} attempt ${attempts.length + 1}`);
    if (result === null) break;
    attempts.push(result);
    if (result.kind !== "rate-limited") break;
    await waitBeforeRetry(ctx, attempts.length, result);
  }
  return { label, attempts, result: lastOf(attempts) };
}

function lastOf(items) {
  return items.length > 0 ? items[items.length - 1] : null;
}

function isFatal(row) {
  return row.result !== null && (FATAL_KINDS.has(row.result.kind) || row.result.kind.startsWith("network-"));
}

function shouldStop(rows) {
  return rows.some((row) => row.result === null || isFatal(row));
}

async function runKeepAlive(ctx) {
  const rows = [];
  for (let i = 1; i <= KEEPALIVE_REQUESTS; i++) {
    rows.push(await postWithBackoff(ctx, `keepalive-${i}`));
    if (shouldStop(rows)) break;
  }
  return rows;
}

/** `count` requests, at most `concurrency` in flight at once. */
async function runLevel(ctx, concurrency) {
  const count = concurrency === 1 ? LEVEL_ONE_REQUESTS : concurrency;
  const rows = [];
  for (let start = 0; start < count; start += concurrency) {
    const wave = Array.from({ length: Math.min(concurrency, count - start) }, (_, i) =>
      postWithBackoff(ctx, `c${concurrency}-${start + i + 1}`),
    );
    rows.push(...(await Promise.all(wave)));
  }
  return rows;
}

function summariseLevel(concurrency, rows) {
  const ok = rows.filter((row) => row.result?.kind === "ok");
  const totals = ok.map((row) => row.result.timings.totalMs);
  return {
    concurrency,
    requests: rows.length,
    ok: ok.length,
    medianMs: percentile(totals, 50),
    p95Ms: percentile(totals, 95),
    reused: rows.filter((row) => row.result?.socketReused === true).length,
    rateLimitedAttempts: rows.flatMap((row) => row.attempts).filter((result) => result.kind === "rate-limited").length,
    sustainedRateLimit: rows.filter((row) => row.result?.kind === "rate-limited").length,
    failures: rows.filter((row) => row.result?.kind !== "ok").map((row) => row.result?.kind ?? "budget-exhausted"),
  };
}

async function runConcurrency(ctx) {
  const levels = [];
  for (const concurrency of LEVELS) {
    const rows = await runLevel(ctx, concurrency);
    const level = summariseLevel(concurrency, rows);
    levels.push(level);
    if (level.sustainedRateLimit > 0 || shouldStop(rows)) break;
  }
  return levels;
}

function keepAliveVerdict(rows) {
  const followUps = rows.slice(1).filter((row) => row.result?.kind === "ok");
  const reused = followUps.filter((row) => row.result.socketReused === true).length;
  if (followUps.length === 0) return "KEEP-ALIVE: UNKNOWN (no successful follow-up request)";
  if (reused === followUps.length) return `KEEP-ALIVE: REUSED on all ${reused} follow-up requests`;
  return reused === 0 ? `KEEP-ALIVE: NOT REUSED (0 of ${followUps.length})` : `KEEP-ALIVE: PARTIAL (${reused} of ${followUps.length} reused)`;
}

function ceiling(levels) {
  const clean = levels.filter((level) => level.sustainedRateLimit === 0 && level.ok === level.requests);
  return clean.length > 0 ? clean[clean.length - 1].concurrency : null;
}

function formatKeepAliveRow(row) {
  const r = row.result;
  if (r === null) return `${row.label}: not sent (budget exhausted)`;
  return `${row.label}: status ${r.status} (${r.kind}) | ${formatTimings(r.timings)} | socketReused ${r.socketReused}${row.attempts.length > 1 ? ` | attempts ${row.attempts.length}` : ""}`;
}

function formatLevel(level) {
  const ms = (value) => (value === null ? "-" : `${Math.round(value)} ms`);
  return (
    `concurrency ${level.concurrency}: ${level.ok}/${level.requests} ok | median ${ms(level.medianMs)} | p95 ${ms(level.p95Ms)}` +
    ` | reused sockets ${level.reused}/${level.requests} | 429 attempts ${level.rateLimitedAttempts} | sustained 429 ${level.sustainedRateLimit}` +
    (level.failures.length > 0 ? ` | failures: ${level.failures.join(", ")}` : "")
  );
}

function makeContext(deps) {
  let index = 0;
  return {
    client: deps.client,
    recorder: deps.recorder,
    key: deps.key,
    sleep: deps.sleep ?? ((ms) => delay(ms)),
    budget: createBudget(STAGE2_MAX_REQUESTS),
    nextIndex: () => index++,
  };
}

function ceilingLine(levels) {
  const safeCeiling = ceiling(levels);
  const tried = levels.map((level) => level.concurrency).join(", ");
  return `SAFE CONCURRENCY CEILING: ${safeCeiling ?? "none established"} (highest level with every request ok and no sustained 429; levels tried: ${tried || "none"})`;
}

function reportLines(ctx, keepAlive, levels, runDir) {
  return [
    "Keep-alive sequence (one agent, sequential):",
    ...keepAlive.map((row) => `  ${formatKeepAliveRow(row)}`),
    keepAliveVerdict(keepAlive),
    "",
    "Concurrency:",
    ...levels.map((level) => `  ${formatLevel(level)}`),
    ceilingLine(levels),
    `Requests made: ${ctx.budget.used()} (budget ${STAGE2_MAX_REQUESTS})`,
    `Full responses: ${runDir ?? "the run directory"}`,
  ];
}

const NOT_SENT = { kind: null, timings: null, socketReused: null };

function keepAliveRecord(row) {
  const result = row.result ?? NOT_SENT;
  return { label: row.label, attempts: row.attempts.length, kind: result.kind, timings: result.timings, socketReused: result.socketReused };
}

/**
 * @param {object} deps
 * @param {{ post: (body: object) => Promise<object> }} deps.client - must use ONE keep-alive agent
 * @param {{ record: Function, writeRun: Function, runDir?: string }} deps.recorder
 * @param {{ write: (chunk: string) => unknown }} deps.stdout
 * @param {string} deps.key - only ever handed to the recorder, which redacts it
 * @param {(ms: number) => Promise<unknown>} [deps.sleep] - backoff wait (injectable for tests)
 * @returns {Promise<{ exitCode: number }>} 0 when the keep-alive phase completed without a fatal error
 */
export async function runStage2(deps) {
  const ctx = makeContext(deps);
  const keepAlive = await runKeepAlive(ctx);
  const stopped = shouldStop(keepAlive);
  const levels = stopped ? [] : await runConcurrency(ctx);

  deps.stdout.write(reportLines(ctx, keepAlive, levels, deps.recorder.runDir).join("\n") + "\n");
  deps.recorder.writeRun({
    stage: "stage2",
    keepAlive: keepAlive.map(keepAliveRecord),
    keepAliveVerdict: keepAliveVerdict(keepAlive),
    levels,
    safeCeiling: ceiling(levels),
    requestsMade: ctx.budget.used(),
  });
  return { exitCode: stopped ? 1 : 0 };
}
