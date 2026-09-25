// Hardened HTTPS POST client for the decisions endpoint. `post()` NEVER
// rejects: every failure path (network error, timeout, oversized response,
// even a synchronous throw from JSON.stringify/requestFn/write/end) resolves
// a result object instead. Upstream error TEXT (err.message, response body
// prose) is never propagated into that result's `kind`/`errorCode` fields —
// only a classified kind, the HTTP status, and a Node error `code` survive.
//
// The request lifecycle is broken into small named functions operating on a
// shared per-call `state` object, rather than one large executor closure —
// each step (timeout, data, end, error) is independently readable and small.
import https from "node:https";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";
import { ENDPOINT_HOST, ENDPOINT_PATH, USER_AGENT, MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS } from "./constants.mjs";

// Shared keep-alive agent: one TLS handshake reused across calls in a single
// process run when no explicit `agent` is injected, mirroring how the real
// CLI behaves across the lifetime of one invocation.
const defaultAgent = new https.Agent({ keepAlive: true });

// Exact status -> kind lookups. Anything not listed falls through to the
// 2xx/3xx family checks in kindForStatus.
const EXACT_STATUS_KIND = { 400: "schema", 401: "auth", 402: "credits", 403: "auth", 404: "model-gone", 429: "rate-limited" };

function kindForStatus(status) {
  if (EXACT_STATUS_KIND[status]) return EXACT_STATUS_KIND[status];
  const family = Math.floor(status / 100);
  if (family === 2) return "ok";
  if (family === 3) return "redirect-refused";
  return "unavailable";
}

// Exact Node error-code -> kind lookups, checked first.
const EXACT_CODE_KIND = {
  ENOTFOUND: "network-dns",
  EAI_AGAIN: "network-dns",
  ECONNREFUSED: "network-refused",
  EPERM: "network-blocked",
  EACCES: "network-blocked",
};

// TLS-related codes are matched by prefix rather than exact value.
const TLS_CODE_PREFIXES = ["CERT_", "ERR_TLS", "UNABLE_TO_VERIFY", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"];

function isTlsCode(code) {
  return typeof code === "string" && TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function kindForErrorCode(code) {
  if (EXACT_CODE_KIND[code]) return EXACT_CODE_KIND[code];
  if (isTlsCode(code)) return "network-tls";
  return "network-other";
}

function isRefusedUnderTest(requestFn, env) {
  return requestFn === https.request && Boolean(env?.VITEST);
}

const EMPTY_TIMINGS = { connectMs: null, tlsMs: null, ttfbMs: null, totalMs: null };

function refusedUnderTestResult() {
  return {
    kind: "refused-under-test",
    status: null,
    headers: null,
    bodyText: null,
    bodyBytes: 0,
    requestBytes: 0,
    timings: EMPTY_TIMINGS,
    socketReused: null,
    errorCode: null,
  };
}

function networkOtherFallback(err) {
  return {
    kind: "network-other",
    status: null,
    headers: null,
    bodyText: null,
    bodyBytes: 0,
    requestBytes: 0,
    timings: EMPTY_TIMINGS,
    socketReused: null,
    errorCode: err?.code ?? null,
  };
}

function makeResult(state, overrides) {
  return {
    kind: null,
    status: null,
    headers: null,
    bodyText: null,
    bodyBytes: 0,
    requestBytes: state.requestBytes,
    timings: { connectMs: state.connectMs, tlsMs: state.tlsMs, ttfbMs: state.ttfbMs, totalMs: state.elapsed() },
    socketReused: state.req?.reusedSocket ?? null,
    errorCode: null,
    ...overrides,
  };
}

function finishState(state, overrides) {
  if (state.settled) return;
  state.settled = true;
  cancelTimeout(state.timer);
  state.resolve(makeResult(state, overrides));
}

function handleTimeout(state) {
  // Total wall-clock deadline. Node's `timeout` request option is idle-only
  // (it resets on every byte received), so a slow-but-steady trickle would
  // never trip it — this timer is the only thing enforcing an overall
  // ceiling.
  state.req?.destroy();
  finishState(state, { kind: "timeout" });
}

function handleResponseData(state, res, chunk) {
  if (state.settled) return;
  state.bytes += chunk.length;
  if (state.bytes > state.maxBodyBytes) {
    state.req.destroy();
    finishState(state, { kind: "body-too-large", status: res.statusCode, headers: res.headers, bodyBytes: state.bytes });
    return;
  }
  state.chunks.push(chunk);
}

// A response body legitimately needs to reach the caller (stage0 parses it
// for the shape and model fields) — but if an upstream error response ever
// echoed the key back (e.g. a 401 quoting the bad credential), it must not
// survive into the result. This is content-scrubbing, distinct from the
// classified `kind`/`errorCode` fields, which never carry upstream text at
// all.
function scrubKeyFromText(text, key) {
  return key ? text.split(key).join("[REDACTED]") : text;
}

function handleResponseEnd(state, res) {
  if (state.settled) return;
  const bodyText = scrubKeyFromText(Buffer.concat(state.chunks).toString("utf8"), state.key);
  finishState(state, {
    kind: kindForStatus(res.statusCode),
    status: res.statusCode,
    headers: res.headers,
    bodyText,
    bodyBytes: state.bytes,
  });
}

function handleResponseError(state, res, err) {
  finishState(state, { kind: "network-other", status: res.statusCode ?? null, errorCode: err?.code ?? null });
}

function handleRequestError(state, err) {
  finishState(state, { kind: kindForErrorCode(err?.code), errorCode: err?.code ?? null });
}

function handleResponse(state, res) {
  state.ttfbMs = state.elapsed();
  res.on("data", (chunk) => handleResponseData(state, res, chunk));
  res.on("end", () => handleResponseEnd(state, res));
  res.on("error", (err) => handleResponseError(state, res, err));
}

function attachSocketTimers(state, req) {
  req.on("socket", (socket) => {
    socket.once("connect", () => {
      state.connectMs = state.elapsed();
    });
    socket.once("secureConnect", () => {
      state.tlsMs = state.elapsed();
    });
  });
}

function startRequest(state, key, agent) {
  state.req = state.requestFn(
    {
      method: "POST",
      hostname: ENDPOINT_HOST,
      path: ENDPOINT_PATH,
      agent,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    (res) => handleResponse(state, res),
  );
  attachSocketTimers(state, state.req);
  state.req.on("error", (err) => handleRequestError(state, err));
  state.req.write(state.bodyJson);
  state.req.end();
}

/**
 * @param {object} deps
 * @param {string} [deps.key] - Bearer key. Only ever placed in the outgoing
 *   Authorization header; never present anywhere in a resolved result.
 * @param {typeof https.request} [deps.requestFn]
 * @param {https.Agent} [deps.agent]
 * @param {() => number} [deps.now] - monotonic-ish clock for timings, in ms.
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.maxBodyBytes]
 * @param {Record<string, string | undefined>} [deps.env]
 */
export function createClient({
  key,
  requestFn = https.request,
  agent = defaultAgent,
  now = () => performance.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES,
  env = process.env,
} = {}) {
  function post(bodyObject) {
    return new Promise((resolve) => {
      // Belt-and-braces "never rejects": every synchronous throw in this
      // executor (JSON.stringify on a cyclic body, a requestFn that throws,
      // req.write/end throwing) lands here instead of rejecting the promise.
      try {
        // Safety net, not the primary guard: never make a live call from the
        // default requestFn while running under the test runner, even if a
        // test forgets to inject a fake one.
        if (isRefusedUnderTest(requestFn, env)) {
          resolve(refusedUnderTestResult());
          return;
        }

        const startedAt = now();
        const bodyJson = JSON.stringify(bodyObject);
        const state = {
          resolve,
          requestFn,
          maxBodyBytes,
          bodyJson,
          key,
          requestBytes: Buffer.byteLength(bodyJson),
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          settled: false,
          req: undefined,
          chunks: [],
          bytes: 0,
          elapsed: () => now() - startedAt,
        };
        state.timer = scheduleTimeout(() => handleTimeout(state), timeoutMs);
        startRequest(state, key, agent);
      } catch (err) {
        resolve(networkOtherFallback(err));
      }
    });
  }

  return { post };
}
