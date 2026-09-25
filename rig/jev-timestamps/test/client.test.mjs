// No network, ever: every requestFn below is a fake driven by hand. The
// default-requestFn-under-VITEST test is the one exception that deliberately
// exercises the real default, and asserts it never touches the wire either.
import https from "node:https";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../lib/client.mjs";
import { ENDPOINT_HOST, ENDPOINT_PATH, USER_AGENT } from "../lib/constants.mjs";
import { createFakeRes, makeRequestFn } from "./fakes.mjs";

const FAKE_KEY = "sk-test-FAKE-KEY-0123456789";
const SOME_BODY = { model: "m", state: "s", questions: {} };

function emit(res, chunks = []) {
  for (const chunk of chunks) {
    res.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  res.emit("end");
}

// requestFn is called synchronously inside client.post()'s executor, so by
// the time client.post(...) returns, requestFn.calls[0]/.req exist and the
// response handlers are already attached — emitting the response right after
// is safe and deterministic, no timers or real I/O involved.
function postAndRespond(client, requestFn, { statusCode, headers = {}, chunks = [] }, body = SOME_BODY) {
  const pending = client.post(body);
  const res = createFakeRes({ statusCode, headers });
  requestFn.emitResponse(res);
  emit(res, chunks);
  return pending;
}

describe("createClient: default requestFn under VITEST", () => {
  it("refuses without calling anything, using the untouched default requestFn", async () => {
    // If the VITEST guard in isRefusedUnderTest ever regresses, this spy
    // throws instead of quietly calling through to the real network —
    // turning a regression into a failing test with zero live traffic,
    // rather than an actual HTTPS connection attempt from the test suite.
    const spy = vi.spyOn(https, "request").mockImplementation(() => {
      throw Object.assign(new Error("no network in tests"), { code: "ETEST" });
    });
    const client = createClient({ key: FAKE_KEY });

    const result = await client.post(SOME_BODY);

    expect(result).toMatchObject({ kind: "refused-under-test", status: null, errorCode: null });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("createClient: request shape", () => {
  it("sends POST to the pinned host/path with exactly the three required headers", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    await postAndRespond(client, requestFn, { statusCode: 200 });

    expect(requestFn.calls).toHaveLength(1);
    const options = requestFn.calls[0];
    expect(options.method).toBe("POST");
    expect(options.hostname).toBe(ENDPOINT_HOST);
    expect(options.path).toBe(ENDPOINT_PATH);
    expect(options.headers).toEqual({
      Authorization: `Bearer ${FAKE_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    });
  });

  it("reflects req.reusedSocket on the result", async () => {
    const requestFn = makeRequestFn({ reusedSocket: true });
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    const result = await postAndRespond(client, requestFn, { statusCode: 200 });

    expect(result.socketReused).toBe(true);
  });

  it("includes timings for connect/tls/ttfb/total using the injected clock", async () => {
    let t = 0;
    const now = () => (t += 10);
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {}, now });

    const pending = client.post(SOME_BODY);
    // Attach the socket first (as attachSocketTimers listens for it), THEN
    // fire connect/secureConnect — emitting them before the "socket" event
    // would mean nothing is listening yet.
    requestFn.req.emit("socket", requestFn.socket);
    requestFn.socket.emit("connect");
    requestFn.socket.emit("secureConnect");
    const res = createFakeRes({ statusCode: 200 });
    requestFn.emitResponse(res);
    emit(res, ["{}"]);
    const result = await pending;

    // now() is called once per elapsed() invocation, advancing by 10 each
    // time: startedAt=10, connect=20 (elapsed 10), secureConnect=30
    // (elapsed 20), response callback=40 (elapsed 30), end=50 (elapsed 40).
    expect(result.timings).toEqual({ connectMs: 10, tlsMs: 20, ttfbMs: 30, totalMs: 40 });
  });
});

describe("createClient: status -> kind mapping", () => {
  it.each([
    [200, "ok"],
    [201, "ok"],
    [299, "ok"],
    [300, "redirect-refused"],
    [302, "redirect-refused"],
    [399, "redirect-refused"],
    [400, "schema"],
    [401, "auth"],
    [402, "credits"],
    [403, "auth"],
    [404, "model-gone"],
    [429, "rate-limited"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("status %i -> kind %s", async (statusCode, expectedKind) => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    const result = await postAndRespond(client, requestFn, { statusCode, chunks: ["{}"] });

    expect(result.kind).toBe(expectedKind);
    expect(result.status).toBe(statusCode);
  });
});

describe("createClient: redirect is never followed", () => {
  it("classifies a 3xx as redirect-refused and makes exactly one request", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    const result = await postAndRespond(client, requestFn, {
      statusCode: 302,
      headers: { location: "https://evil.example/steal" },
    });

    expect(result.kind).toBe("redirect-refused");
    expect(requestFn.calls).toHaveLength(1);
  });
});

describe("createClient: connection error code -> kind mapping", () => {
  it.each([
    ["ENOTFOUND", "network-dns"],
    ["EAI_AGAIN", "network-dns"],
    ["ECONNREFUSED", "network-refused"],
    ["EPERM", "network-blocked"],
    ["EACCES", "network-blocked"],
    ["CERT_HAS_EXPIRED", "network-tls"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "network-tls"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "network-tls"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "network-tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "network-tls"],
    ["ESOMETHINGELSE", "network-other"],
  ])("error code %s -> kind %s", async (code, expectedKind) => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    const pending = client.post(SOME_BODY);
    const sensitiveMessage = `upstream said: ${FAKE_KEY} is invalid, connection to internal-host failed`;
    requestFn.req.emit("error", { code, message: sensitiveMessage });
    const result = await pending;

    expect(result.kind).toBe(expectedKind);
    expect(result.errorCode).toBe(code);
    // Only the classified kind and Node's `code` survive — never err.message,
    // and never the key (global constraint #4, #5).
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sensitiveMessage);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("upstream said");
  });
});

describe("createClient: total-deadline timeout", () => {
  it("destroys the request and resolves kind timeout when nothing responds in time", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {}, timeoutMs: 20 });

    const result = await client.post(SOME_BODY);

    expect(result.kind).toBe("timeout");
    expect(requestFn.req.destroyed).toBe(true);
  }, 2000);

  it("does not fire the timeout once the response has already finished", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {}, timeoutMs: 500 });

    const result = await postAndRespond(client, requestFn, { statusCode: 200, chunks: ["{}"] });

    expect(result.kind).toBe("ok");
    expect(requestFn.req.destroyed).toBe(false);
  });
});

describe("createClient: response body cap", () => {
  it("destroys the request and resolves body-too-large once bytes exceed the cap", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {}, maxBodyBytes: 5 });

    const result = await postAndRespond(client, requestFn, { statusCode: 200, chunks: ["0123456789"] });

    expect(result.kind).toBe("body-too-large");
    expect(requestFn.req.destroyed).toBe(true);
  });

  it("allows a response at or under the cap through normally", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {}, maxBodyBytes: 5 });

    const result = await postAndRespond(client, requestFn, { statusCode: 200, chunks: ["abcde"] });

    expect(result.kind).toBe("ok");
    expect(result.bodyText).toBe("abcde");
  });
});

describe("createClient: never rejects", () => {
  it("resolves network-other instead of throwing when the body cannot be serialized", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });
    const circular = {};
    circular.self = circular;

    await expect(client.post(circular)).resolves.toMatchObject({ kind: "network-other" });
    expect(requestFn.calls).toHaveLength(0);
  });

  it("never includes the key anywhere in a successful result", async () => {
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    const result = await postAndRespond(client, requestFn, { statusCode: 200, chunks: ["{}"] });

    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it("scrubs the key out of bodyText even when an upstream error response echoes it back", async () => {
    // A 401 that quotes the bad credential back is a realistic upstream
    // shape. bodyText legitimately needs to reach the caller (stage0 parses
    // it), but the key itself must never survive inside it.
    const requestFn = makeRequestFn();
    const client = createClient({ key: FAKE_KEY, requestFn, env: {} });

    const result = await postAndRespond(client, requestFn, {
      statusCode: 401,
      chunks: [JSON.stringify({ error: `bad key ${FAKE_KEY}` })],
    });

    expect(result.kind).toBe("auth");
    expect(result.bodyText).not.toContain(FAKE_KEY);
    expect(result.bodyText).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});
