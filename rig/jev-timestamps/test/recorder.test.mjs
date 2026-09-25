import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecorder } from "../lib/recorder.mjs";

const FAKE_KEY = "sk-test-FAKE-KEY-0123456789";
const FIXED_NOW = () => new Date(Date.UTC(2026, 8, 25, 12, 34, 56)); // 2026-09-25T12:34:56Z

function tempBaseDir() {
  return mkdtempSync(join(tmpdir(), "jev-rig-recorder-"));
}

function readRaw(path) {
  return readFileSync(path, "utf8");
}

describe("createRecorder: run directory naming", () => {
  it("names the run dir <UTC YYYYMMDDTHHMMSSZ>-<stage>, derived from the injected clock", () => {
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: FAKE_KEY });

    expect(recorder.runDir).toBe(join(baseDir, "20260925T123456Z-stage0"));
    expect(existsSync(recorder.runDir)).toBe(true);
  });
});

describe("createRecorder: record()", () => {
  it("appends one JSON line per call to exchanges.jsonl", () => {
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: FAKE_KEY });

    recorder.record({ request: { headers: {} }, response: null, kind: "ok" });
    recorder.record({ request: { headers: {} }, response: null, kind: "auth" });

    const lines = readRaw(join(recorder.runDir, "exchanges.jsonl")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe("ok");
    expect(JSON.parse(lines[1]).kind).toBe("auth");
  });

  it("redacts the Authorization header unconditionally, independent of the whole-string key scrub", () => {
    // key: null means the whole-string scrub pass is a no-op (nothing to
    // scrub for), and the header value below doesn't contain the key either
    // — so if this assertion holds, it can only be because
    // redactRequestHeaders itself forced the Authorization value, not
    // because the value happened to contain a scrubbed key.
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: null });

    recorder.record({
      request: { headers: { Authorization: "Bearer some-other-token", "Content-Type": "application/json" } },
      response: null,
      kind: "ok",
    });

    const line = JSON.parse(readRaw(join(recorder.runDir, "exchanges.jsonl")).trim());
    expect(line.request.headers.Authorization).toBe("Bearer [REDACTED]");
    expect(line.request.headers["Content-Type"]).toBe("application/json");
  });

  it("keeps the response header allowlist verbatim, drops set-cookie, and redacts everything else", () => {
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: FAKE_KEY });

    recorder.record({
      request: { headers: {} },
      response: {
        headers: {
          "content-type": "application/json",
          "content-length": "42",
          date: "Tue, 01 Jan 2030 00:00:00 GMT",
          "retry-after": "5",
          "x-ratelimit-remaining": "10",
          "set-cookie": "session=abc",
          "x-some-other-header": "opaque value",
        },
      },
      kind: "ok",
    });

    const line = JSON.parse(readRaw(join(recorder.runDir, "exchanges.jsonl")).trim());
    expect(line.response.headers["content-type"]).toBe("application/json");
    expect(line.response.headers["content-length"]).toBe("42");
    expect(line.response.headers.date).toBe("Tue, 01 Jan 2030 00:00:00 GMT");
    expect(line.response.headers["retry-after"]).toBe("5");
    expect(line.response.headers["x-ratelimit-remaining"]).toBe("10");
    expect(line.response.headers["set-cookie"]).toBeUndefined();
    expect(line.response.headers["x-some-other-header"]).toBe("[REDACTED]");
  });
});

describe("createRecorder: writeRun()", () => {
  it("writes run.json", () => {
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: FAKE_KEY });

    recorder.writeRun({ stage: "stage0", verdict: "LIVE" });

    const summary = JSON.parse(readRaw(join(recorder.runDir, "run.json")));
    expect(summary).toEqual({ stage: "stage0", verdict: "LIVE" });
  });
});

describe("createRecorder: adversarial key scrubbing", () => {
  // The key is planted in every place it could plausibly leak: the
  // Authorization header, a whitelisted response header, a non-whitelisted
  // response header, top-level bodyText, a nested body field, an object KEY
  // name, and the run summary. If any protection here were removed, at least
  // one of these assertions would fail.
  it("removes the key from every written byte across exchanges.jsonl and run.json", () => {
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: FAKE_KEY });

    recorder.record({
      request: {
        headers: { Authorization: `Bearer ${FAKE_KEY}`, "User-Agent": `agent-${FAKE_KEY}` },
        body: {
          state: `state mentions ${FAKE_KEY} inline`,
          nested: { deeper: { text: `deep leak ${FAKE_KEY}` } },
          [`field-${FAKE_KEY}`]: "value under a key-shaped key",
        },
      },
      response: {
        headers: {
          date: `Tue, 01 Jan 2030 00:00:00 GMT ${FAKE_KEY}`,
          "x-custom": `contains ${FAKE_KEY}`,
        },
        bodyText: `{"error":"denied for ${FAKE_KEY}"}`,
      },
      kind: "auth",
    });
    recorder.writeRun({ stage: "stage0", verdict: "AUTH", note: `summary leak ${FAKE_KEY}` });

    const exchangesRaw = readRaw(join(recorder.runDir, "exchanges.jsonl"));
    const runRaw = readRaw(join(recorder.runDir, "run.json"));

    expect(exchangesRaw).not.toContain(FAKE_KEY);
    expect(runRaw).not.toContain(FAKE_KEY);

    // Structural sanity: the [REDACTED] marker actually landed where the key
    // was, rather than the whole record silently vanishing.
    expect(exchangesRaw).toContain("[REDACTED]");
    const parsed = JSON.parse(exchangesRaw.trim());
    expect(parsed.request.headers.Authorization).toBe("Bearer [REDACTED]");
  });

  it("dry-run exchanges (no key yet) still redact structurally and write cleanly", () => {
    const baseDir = tempBaseDir();
    const recorder = createRecorder({ baseDir, stage: "stage0", now: FIXED_NOW, key: null });

    recorder.record({
      request: { headers: { "Content-Type": "application/json" }, body: { state: "planned" } },
      response: null,
      dryRun: true,
    });
    recorder.writeRun({ stage: "stage0", dryRun: true, requests: 1 });

    const parsed = JSON.parse(readRaw(join(recorder.runDir, "exchanges.jsonl")).trim());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.response).toBeNull();
  });
});
