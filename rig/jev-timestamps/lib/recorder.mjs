// Writes what happened to disk, with the key and sensitive header values
// scrubbed out before a single byte is written.
//
// Two passes, deliberately kept separate:
//  1. Header POLICY (structural): decide which header fields survive, get
//     dropped, or get replaced outright, independent of the key.
//  2. Key SCRUB (content): after the whole record is serialized to one JSON
//     string, every literal occurrence of the key text is replaced — this
//     covers bodyText, nested body fields, and even an object key, because
//     by this point it is all just one string. If the key were somehow still
//     present afterward, refuse to write rather than silently leak it.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_DIR = join(moduleDir, "..", "runs");

// Response header names whose value is operationally useful and never
// carries the key, so they pass the structural policy untouched (still
// subject to the whole-string key scrub below, belt-and-braces).
const KEPT_RESPONSE_HEADERS = new Set(["content-type", "content-length", "date", "retry-after"]);

function isRateLimitHeader(lowerName) {
  return lowerName.startsWith("x-ratelimit-");
}

function redactRequestHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = name.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : value;
  }
  return out;
}

// Returns `undefined` to signal "drop this header entirely" (set-cookie),
// otherwise the value to keep (verbatim, or "[REDACTED]").
function responseHeaderValue(name, value) {
  const lower = name.toLowerCase();
  if (lower === "set-cookie") return undefined;
  const keep = KEPT_RESPONSE_HEADERS.has(lower) || isRateLimitHeader(lower);
  return keep ? value : "[REDACTED]";
}

function redactResponseHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const kept = responseHeaderValue(name, value);
    if (kept !== undefined) out[name] = kept;
  }
  return out;
}

function withRedactedHeaders(part, redact) {
  if (!part) return part;
  return part.headers ? { ...part, headers: redact(part.headers) } : { ...part };
}

function applyHeaderPolicy(exchange) {
  return {
    ...exchange,
    request: withRedactedHeaders(exchange.request, redactRequestHeaders),
    response: withRedactedHeaders(exchange.response, redactResponseHeaders),
  };
}

function scrubSerialized(value, key) {
  const json = JSON.stringify(value);
  if (!key) return json;
  const scrubbed = json.split(key).join("[REDACTED]");
  /* c8 ignore next 3 -- split/join cannot leave a literal occurrence behind;
     this is a refuse-to-leak safety net, not a reachable branch. */
  if (scrubbed.includes(key)) {
    throw new Error("recorder: key still present after scrubbing; refusing to write");
  }
  return scrubbed;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTimestamp(date) {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * @param {object} deps
 * @param {string} [deps.baseDir] - defaults to rig/jev-timestamps/runs,
 *   resolved from this module's own location (not cwd), so the recorder
 *   writes to the same place regardless of where the CLI was invoked from.
 * @param {string} deps.stage
 * @param {() => Date} deps.now
 * @param {string | null | undefined} deps.key
 */
export function createRecorder({ baseDir = DEFAULT_BASE_DIR, stage, now, key }) {
  const dirName = `${formatTimestamp(now())}-${stage}`;
  const runDir = join(baseDir, dirName);
  mkdirSync(runDir, { recursive: true });
  const exchangesPath = join(runDir, "exchanges.jsonl");

  function record(exchange) {
    const structured = applyHeaderPolicy(exchange);
    const line = scrubSerialized(structured, key);
    appendFileSync(exchangesPath, line + "\n", "utf8");
  }

  function writeRun(summary) {
    const line = scrubSerialized(summary, key);
    writeFileSync(join(runDir, "run.json"), line, "utf8");
  }

  return { runDir, record, writeRun };
}
