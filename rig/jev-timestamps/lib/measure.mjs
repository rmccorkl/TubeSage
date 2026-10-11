// Helpers shared by stages 1 and 2: recording one exchange, formatting its
// timings, and summarising latencies. Nothing here makes a request.
import { ENDPOINT, USER_AGENT } from "./constants.mjs";

function ms(value) {
  return typeof value === "number" ? String(Math.round(value)) : "-";
}

/** "connect 3627 | tls 3649 | ttfb 4196 | total 4198 ms". A reused socket has no connect/tls ("-"). */
export function formatTimings(timings) {
  const t = timings ?? {};
  return `connect ${ms(t.connectMs)} | tls ${ms(t.tlsMs)} | ttfb ${ms(t.ttfbMs)} | total ${ms(t.totalMs)} ms`;
}

/** Nearest-rank percentile of a list of numbers; null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** usage.cost from a parsed body, or null. */
export function costOf(json) {
  const cost = json?.usage?.cost;
  return typeof cost === "number" ? cost : null;
}

/**
 * Records one exchange. The recorder redacts the Authorization header and
 * scrubs the key from every written byte; the full response body is kept so
 * a run can be re-analysed without spending again.
 */
export function recordRequest(recorder, { label, body, key, result, extra = {} }) {
  recorder.record({
    label,
    request: {
      method: "POST",
      url: ENDPOINT,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body,
    },
    response:
      result.status === null
        ? null
        : { status: result.status, headers: result.headers, bodyText: result.bodyText, bodyBytes: result.bodyBytes },
    kind: result.kind,
    errorCode: result.errorCode,
    timings: result.timings,
    socketReused: result.socketReused,
    ...extra,
  });
}
