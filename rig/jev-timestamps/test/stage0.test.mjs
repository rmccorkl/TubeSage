import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStage0Body, runStage0 } from "../stages/stage0.mjs";
import { createRecorder } from "../lib/recorder.mjs";
import { MODEL_PIN } from "../lib/constants.mjs";

const FAKE_KEY = "sk-test-FAKE-KEY-0123456789";

function makeStdout() {
  const chunks = [];
  return { write: (c) => chunks.push(c), text: () => chunks.join("") };
}

// A client.post()-shaped result with sane defaults; each test overrides only
// what it's actually exercising.
function fakeResult(overrides) {
  return {
    kind: null,
    status: null,
    headers: {},
    bodyText: "",
    bodyBytes: 0,
    timings: { connectMs: null, tlsMs: null, ttfbMs: null, totalMs: 1 },
    socketReused: false,
    errorCode: null,
    ...overrides,
  };
}

function fakeClient(result) {
  return { post: async () => result };
}

function tempRecorder() {
  const baseDir = mkdtempSync(join(tmpdir(), "jev-rig-stage0-"));
  return createRecorder({ baseDir, stage: "stage0", now: () => new Date(Date.UTC(2026, 8, 25, 0, 0, 0)), key: FAKE_KEY });
}

async function runWithResult(overrides, { stdout = makeStdout(), recorder = tempRecorder() } = {}) {
  const client = fakeClient(fakeResult(overrides));
  const outcome = await runStage0({ client, recorder, stdout, key: FAKE_KEY });
  return { ...outcome, stdout, recorder };
}

describe("buildStage0Body", () => {
  it("builds the exact pinned body shape", () => {
    const body = buildStage0Body();
    expect(body.model).toBe(MODEL_PIN);
    expect(body.state).toContain("Segment S1");
    expect(body.state).toContain("Section A");
    expect(body.questions.liveness.type).toBe("choice");
    expect(body.questions.liveness.criteria).toEqual({
      pertains: "The segment discusses the topic of the section.",
      does_not_pertain: "The segment discusses something else.",
      insufficient_evidence: "The segment does not contain enough information to decide.",
    });
  });
});

describe("runStage0: verdicts", () => {
  it("LIVE when ok and model matches the pin", async () => {
    const { verdict, exitCode, stdout } = await runWithResult({
      kind: "ok",
      status: 200,
      bodyText: JSON.stringify({ model: MODEL_PIN, answer: "pertains" }),
      bodyBytes: 10,
    });

    expect(verdict).toBe("LIVE");
    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("verdict: LIVE");
  });

  it("LIVE-PIN-CHANGED when ok but model differs", async () => {
    const { verdict, exitCode } = await runWithResult({
      kind: "ok",
      status: 200,
      bodyText: JSON.stringify({ model: "typesafe/jev-9.99-new" }),
      bodyBytes: 10,
    });
    expect(verdict).toBe("LIVE-PIN-CHANGED");
    expect(exitCode).toBe(1);
  });

  it("MODEL-GONE on 404", async () => {
    const { verdict, exitCode } = await runWithResult({ kind: "model-gone", status: 404 });
    expect(verdict).toBe("MODEL-GONE");
    expect(exitCode).toBe(1);
  });

  it("AUTH on 401/403", async () => {
    const { verdict } = await runWithResult({ kind: "auth", status: 401 });
    expect(verdict).toBe("AUTH");
  });

  it("CREDITS on 402", async () => {
    const { verdict } = await runWithResult({ kind: "credits", status: 402 });
    expect(verdict).toBe("CREDITS");
  });

  it("ENV-BLOCKED for any network-* kind", async () => {
    const { verdict, exitCode } = await runWithResult({
      kind: "network-dns",
      status: null,
      headers: null,
      bodyText: null,
      socketReused: null,
      errorCode: "ENOTFOUND",
    });
    expect(verdict).toBe("ENV-BLOCKED");
    expect(exitCode).toBe(1);
  });

  it("OTHER for anything else (e.g. rate-limited)", async () => {
    const { verdict } = await runWithResult({ kind: "rate-limited", status: 429 });
    expect(verdict).toBe("OTHER");
  });
});

describe("runStage0: never prints upstream prose or the key", () => {
  it("keeps a sentinel string from a 400 error body out of stdout, but records the shape", async () => {
    const sentinel = "UPSTREAM-PROSE-SENTINEL-DO-NOT-PRINT";
    const { stdout } = await runWithResult({
      kind: "schema",
      status: 400,
      bodyText: JSON.stringify({ error: `${sentinel} and key ${FAKE_KEY}` }),
      bodyBytes: 40,
    });

    expect(stdout.text()).not.toContain(sentinel);
    expect(stdout.text()).not.toContain(FAKE_KEY);
    expect(stdout.text()).toContain("body shape");
  });

  it("truncates a model string to 100 JSON-escaped characters", async () => {
    const longModel = "x".repeat(200);
    const { stdout } = await runWithResult({
      kind: "ok",
      status: 200,
      bodyText: JSON.stringify({ model: longModel }),
      bodyBytes: 10,
    });

    const modelLine = stdout.text().split("\n").find((l) => l.startsWith("model:"));
    // "model: " prefix + up to 100 chars of JSON-escaped model text
    expect(modelLine.length).toBeLessThanOrEqual("model: ".length + 100 + " (matches pin: false)".length);
  });

  it("records the exchange with the key redacted on disk", async () => {
    const recorder = tempRecorder();
    const { recorder: usedRecorder } = await runWithResult(
      {
        kind: "ok",
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ model: MODEL_PIN }),
        bodyBytes: 10,
        timings: { connectMs: 1, tlsMs: 2, ttfbMs: 3, totalMs: 4 },
      },
      { recorder },
    );

    const raw = readFileSync(join(usedRecorder.runDir, "exchanges.jsonl"), "utf8");
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).toContain("Bearer [REDACTED]");
  });
});
