import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../cli.mjs";
import { KEY_ENV } from "../lib/constants.mjs";
import { createFakeRes, makeRequestFn } from "./fakes.mjs";

const FAKE_KEY = "sk-test-FAKE-KEY-0123456789";

function makeStream() {
  const chunks = [];
  return { write: (c) => chunks.push(c), text: () => chunks.join("") };
}

// Every CLI-level test builds env this way: VITEST is always set (defence in
// depth alongside the injected requestFn, per the client's own refusal
// check), and a spy requestFn is always present so a forgotten override can
// never reach the real network.
function baseDeps(overrides = {}) {
  return {
    env: { VITEST: "true" },
    execArgv: [],
    now: () => new Date(Date.UTC(2026, 8, 25, 0, 0, 0)),
    baseDir: mkdtempSync(join(tmpdir(), "jev-rig-cli-")),
    stdout: makeStream(),
    stderr: makeStream(),
    requestFn: makeRequestFn(),
    ...overrides,
  };
}

function runsDirEntries(baseDir) {
  return readdirSync(baseDir);
}

describe("cli run(): usage", () => {
  it("prints usage and exits 0 with no arguments", async () => {
    const deps = baseDeps();
    const code = await run([], deps);
    expect(code).toBe(0);
    expect(deps.stdout.text()).toContain("Usage:");
    expect(deps.requestFn.calls).toHaveLength(0);
  });

  it("prints usage and exits 0 for --help", async () => {
    const deps = baseDeps();
    const code = await run(["--help"], deps);
    expect(code).toBe(0);
    expect(deps.stdout.text()).toContain("Usage:");
  });

  it("exits 1 for an unknown stage", async () => {
    const deps = baseDeps();
    const code = await run(["bogus-stage"], deps);
    expect(code).toBe(1);
    expect(deps.stderr.text()).toContain("Unknown stage");
    expect(deps.requestFn.calls).toHaveLength(0);
  });
});

describe("cli run(): dry-run makes zero requestFn calls", () => {
  it("exits 0, records planned requests, prints the estimate first, and touches no network", async () => {
    const deps = baseDeps();
    const code = await run(["stage0", "--dry-run"], deps);

    expect(code).toBe(0);
    expect(deps.requestFn.calls).toHaveLength(0);

    const out = deps.stdout.text();
    const estimateIndex = out.indexOf("Planned requests:");
    const plannedIndex = out.indexOf("planned request:");
    expect(estimateIndex).toBeGreaterThanOrEqual(0);
    expect(plannedIndex).toBeGreaterThan(estimateIndex);

    const [runDir] = runsDirEntries(deps.baseDir);
    expect(runDir).toMatch(/^\d{8}T\d{6}Z-stage0$/);
    const exchanges = readFileSync(join(deps.baseDir, runDir, "exchanges.jsonl"), "utf8");
    expect(JSON.parse(exchanges.trim()).dryRun).toBe(true);
  });

  it("does not require a key: unset OPENROUTER_API_KEY_JEV still succeeds", async () => {
    const deps = baseDeps({ env: { VITEST: "true" } });
    const code = await run(["stage0", "--dry-run"], deps);
    expect(code).toBe(0);
  });
});

describe("cli run(): refuse makes zero requestFn calls and writes nothing", () => {
  it("exits 2 with no flags, and the run dir stays empty", async () => {
    const deps = baseDeps();
    const code = await run(["stage0"], deps);

    expect(code).toBe(2);
    expect(deps.stdout.text()).toContain("Re-run with --yes to spend, or --dry-run to preview");
    expect(deps.requestFn.calls).toHaveLength(0);
    expect(runsDirEntries(deps.baseDir)).toHaveLength(0);
  });

  it("prints the estimate before the refuse message", async () => {
    const deps = baseDeps();
    await run(["stage0"], deps);

    const out = deps.stdout.text();
    const estimateIndex = out.indexOf("Planned requests:");
    const refuseIndex = out.indexOf("Re-run with --yes to spend, or --dry-run to preview");
    expect(estimateIndex).toBeGreaterThanOrEqual(0);
    expect(refuseIndex).toBeGreaterThan(estimateIndex);
  });

  it("exits 1 when both --dry-run and --yes are given, before any request", async () => {
    const deps = baseDeps();
    const code = await run(["stage0", "--dry-run", "--yes"], deps);
    expect(code).toBe(1);
    expect(deps.requestFn.calls).toHaveLength(0);
  });
});

describe("cli run(): stage1 stub", () => {
  it("prints not built yet and exits 1, before any body/estimate work", async () => {
    const deps = baseDeps();
    const code = await run(["stage1"], deps);
    expect(code).toBe(1);
    expect(deps.stdout.text()).toContain("not built yet");
    expect(deps.requestFn.calls).toHaveLength(0);
  });
});

describe("cli run(): go path", () => {
  it("exits 1 with the operator message when the key is unset, before any request", async () => {
    const deps = baseDeps({ env: { VITEST: "true" } });
    const code = await run(["stage0", "--yes"], deps);

    expect(code).toBe(1);
    expect(deps.stderr.text()).toContain(KEY_ENV);
    expect(deps.requestFn.calls).toHaveLength(0);
  });

  it("prints the estimate before the first requestFn call (before any spend)", async () => {
    const requestFn = makeRequestFn();
    const deps = baseDeps({ env: { VITEST: "true", [KEY_ENV]: FAKE_KEY } });
    let stdoutAtFirstCall = null;
    // Snapshot stdout the instant the request is actually placed, so this
    // fails if the estimate ever moved to print after the request instead
    // of before it. `requestFn.emitResponse` still works afterward because
    // it closes over the same `capturedCallback` this wrapper populates.
    deps.requestFn = (options, callback) => {
      stdoutAtFirstCall = deps.stdout.text();
      return requestFn(options, callback);
    };

    const pending = run(["stage0", "--yes"], deps);
    await Promise.resolve();
    await Promise.resolve();
    const res = createFakeRes({ statusCode: 200 });
    requestFn.emitResponse(res);
    res.emit("data", Buffer.from(JSON.stringify({ model: "typesafe/jev-1.13-20260917" })));
    res.emit("end");
    await pending;

    expect(stdoutAtFirstCall).not.toBeNull();
    expect(stdoutAtFirstCall).toContain("Planned requests:");
  });

  it("runs stage0 against the injected fake client, exits 0 on LIVE, and never leaks the key", async () => {
    const requestFn = makeRequestFn();
    const deps = baseDeps({ env: { VITEST: "true", [KEY_ENV]: FAKE_KEY }, requestFn });

    const pending = run(["stage0", "--yes"], deps);
    // client.post() is called synchronously inside runStage0's await chain;
    // give the microtask queue a turn so requestFn has been invoked before
    // we respond.
    await Promise.resolve();
    await Promise.resolve();
    const res = createFakeRes({ statusCode: 200 });
    requestFn.emitResponse(res);
    res.emit("data", Buffer.from(JSON.stringify({ model: "typesafe/jev-1.13-20260917" })));
    res.emit("end");

    const code = await pending;

    expect(code).toBe(0);
    expect(deps.stdout.text()).toContain("verdict: LIVE");
    expect(deps.stdout.text()).not.toContain(FAKE_KEY);
    expect(deps.stderr.text()).not.toContain(FAKE_KEY);

    const [runDir] = runsDirEntries(deps.baseDir);
    const exchanges = readFileSync(join(deps.baseDir, runDir, "exchanges.jsonl"), "utf8");
    const summary = readFileSync(join(deps.baseDir, runDir, "run.json"), "utf8");
    expect(exchanges).not.toContain(FAKE_KEY);
    expect(summary).not.toContain(FAKE_KEY);
    expect(exchanges).toContain("Bearer [REDACTED]");
  });
});

describe("cli run(): --timeout-ms and --samples validation", () => {
  it("rejects a non-integer --timeout-ms before any request", async () => {
    const deps = baseDeps();
    const code = await run(["stage0", "--timeout-ms", "not-a-number", "--dry-run"], deps);
    expect(code).toBe(1);
    expect(deps.requestFn.calls).toHaveLength(0);
  });

  it("rejects a non-positive --samples before any request", async () => {
    const deps = baseDeps();
    const code = await run(["stage0", "--samples", "0", "--dry-run"], deps);
    expect(code).toBe(1);
    expect(deps.requestFn.calls).toHaveLength(0);
  });

  it("rejects an unknown flag before any request", async () => {
    const deps = baseDeps();
    const code = await run(["stage0", "--not-a-real-flag"], deps);
    expect(code).toBe(1);
    expect(deps.requestFn.calls).toHaveLength(0);
  });
});
