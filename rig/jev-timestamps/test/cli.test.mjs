import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.mjs";
import { createFakeRes, fakeSpawn, makeRequestFn } from "./fakes.mjs";

const KEY_ENV = "OPENROUTER_API_KEY_JEV";
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

function readOnlyRunFile(baseDir, fileName) {
  const [runDir] = runsDirEntries(baseDir);
  return readFileSync(join(baseDir, runDir, fileName), "utf8");
}

// Starts run(), lets the microtask queue reach requestFn (client.post() is
// called inside runStage0's await chain), then answers with a LIVE response.
// `requestFn` is the fake whose emitResponse is used; deps.requestFn may wrap it.
async function runAnsweredLive(argv, deps, requestFn) {
  const pending = run(argv, deps);
  await Promise.resolve();
  await Promise.resolve();
  answerLive(requestFn);
  return pending;
}

function answerLive(requestFn) {
  const res = createFakeRes({ statusCode: 200 });
  requestFn.emitResponse(res);
  res.emit("data", Buffer.from(JSON.stringify({ model: "typesafe/jev-1.13-20260917" })));
  res.emit("end");
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

describe("cli run(): stages 1 and 2 are priced on their upper bound and spend nothing without --yes", () => {
  it.each([
    ["stage1", 5],
    ["stage2", 60],
  ])("%s --dry-run plans %i requests, prints the --yes command, and makes no request", async (stage, requests) => {
    const deps = baseDeps();
    const code = await run([stage, "--dry-run"], deps);
    expect(code).toBe(0);
    expect(deps.stdout.text()).toContain(`Planned requests: ${requests}\n`);
    expect(deps.stdout.text()).toContain(`To spend, run: node rig/jev-timestamps/cli.mjs ${stage} --yes`);
    expect(deps.requestFn.calls).toHaveLength(0);
  });

  it("refuses stage2 without --yes and writes nothing", async () => {
    const deps = baseDeps();
    expect(await run(["stage2"], deps)).toBe(2);
    expect(deps.requestFn.calls).toHaveLength(0);
    expect(runsDirEntries(deps.baseDir)).toHaveLength(0);
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

    await runAnsweredLive(["stage0", "--yes"], deps, requestFn);

    expect(stdoutAtFirstCall).not.toBeNull();
    expect(stdoutAtFirstCall).toContain("Planned requests:");
  });

  it("runs stage0 against the injected fake client, exits 0 on LIVE, and never leaks the key", async () => {
    const requestFn = makeRequestFn();
    const deps = baseDeps({ env: { VITEST: "true", [KEY_ENV]: FAKE_KEY }, requestFn });

    const code = await runAnsweredLive(["stage0", "--yes"], deps, requestFn);

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

describe("cli run(): --env-file", () => {
  function envFileWith(text) {
    const path = join(mkdtempSync(join(tmpdir(), "jev-rig-envfile-")), ".env");
    writeFileSync(path, text);
    return path;
  }

  it("exits 1 naming the path when the file does not exist, before any request", async () => {
    const deps = baseDeps();
    const missing = join(mkdtempSync(join(tmpdir(), "jev-rig-envfile-")), "nope.env");
    const code = await run(["stage0", "--yes", "--env-file", missing], deps);
    expect(code).toBe(1);
    expect(deps.stderr.text()).toContain(missing);
    expect(deps.requestFn.calls).toHaveLength(0);
  });

  it("rejects --env-file with no path", async () => {
    const deps = baseDeps();
    const code = await run(["stage0", "--dry-run", "--env-file"], deps);
    expect(code).toBe(1);
    expect(deps.stderr.text()).toContain("--env-file needs a value");
  });

  it("emits no value from the file when no accepted key is in it", async () => {
    const secrets = ["sk-openai-SECRET-VALUE-111", "sk-typo-SECRET-VALUE-222", "plain-SECRET-333"];
    const path = envFileWith(
      `OPENAI_API_KEY=${secrets[0]}\nOPENROUTER_KEY="${secrets[1]}"\n# OPENROUTER_API_KEY=${secrets[2]}\n`,
    );
    const deps = baseDeps();
    const code = await run(["stage0", "--yes", "--env-file", path], deps);

    expect(code).toBe(1);
    const output = deps.stdout.text() + deps.stderr.text();
    expect(output).toContain("OPENROUTER_API_KEY");
    expect(output).toContain(path);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(deps.requestFn.calls).toHaveLength(0);
    expect(runsDirEntries(deps.baseDir)).toHaveLength(0);
  });

  it("emits no value from the file on a dry run", async () => {
    const path = envFileWith(`OPENROUTER_API_KEY=${FAKE_KEY}\n`);
    const deps = baseDeps();
    const code = await run(["stage0", "--dry-run", "--env-file", path], deps);

    expect(code).toBe(0);
    expect(deps.stdout.text() + deps.stderr.text()).not.toContain(FAKE_KEY);
    expect(readOnlyRunFile(deps.baseDir, "exchanges.jsonl")).not.toContain(FAKE_KEY);
  });

  it("uses OPENROUTER_API_KEY from the file, names only the variable, and never leaks the value", async () => {
    const requestFn = makeRequestFn();
    const path = envFileWith(`OPENROUTER_API_KEY='${FAKE_KEY}'\n`);
    const deps = baseDeps({ requestFn });

    const code = await runAnsweredLive(["stage0", "--yes", "--env-file", path], deps, requestFn);

    expect(code).toBe(0);
    expect(requestFn.calls[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(deps.stdout.text()).toContain("using key from OPENROUTER_API_KEY (--env-file");
    expect(deps.stdout.text() + deps.stderr.text()).not.toContain(FAKE_KEY);
    expect(readOnlyRunFile(deps.baseDir, "exchanges.jsonl")).not.toContain(FAKE_KEY);
  });

  it("does not let the file override a key already in the real environment", async () => {
    const requestFn = makeRequestFn();
    const path = envFileWith("OPENROUTER_API_KEY=sk-from-file-should-not-win\n");
    const deps = baseDeps({ env: { VITEST: "true", OPENROUTER_API_KEY: FAKE_KEY }, requestFn });

    await runAnsweredLive(["stage0", "--yes", "--env-file", path], deps, requestFn);

    expect(requestFn.calls[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(deps.stdout.text()).toContain("using key from OPENROUTER_API_KEY (environment)");
  });
});

describe("cli run(): 1Password key resolution", () => {
  const OP_TOKEN = "ops_FAKE-CLI-SERVICE-ACCOUNT-TOKEN-0123";
  const OP_KEY = "sk-or-v1-FAKE-CLI-KEY-FROM-1PASSWORD-4567";

  function homeWithToken() {
    const home = mkdtempSync(join(tmpdir(), "jev-rig-cli-home-"));
    const dir = join(home, ".hermes", "profiles", "tvmacro-bot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), "OP_SERVICE_ACCOUNT_TOKEN=\"" + OP_TOKEN + "\"\n");
    return home;
  }

  it.each(["stage0", "stage1", "stage2"])("%s --dry-run never runs op, even with no credential at all", async (stage) => {
    const spawn = fakeSpawn({ stdout: OP_KEY });
    const deps = baseDeps({ spawn, home: homeWithToken() });
    expect(await run([stage, "--dry-run"], deps)).toBe(0);
    expect(spawn.calls).toHaveLength(0);
  });

  it("with no key in the environment, reads it from 1Password and leaks neither secret", async () => {
    const spawn = fakeSpawn({ stdout: OP_KEY + "\n" });
    const requestFn = makeRequestFn();
    const deps = baseDeps({ spawn, home: homeWithToken(), requestFn });

    // The key is resolved (op runs) before the request is placed, so wait for it.
    const pending = run(["stage0", "--yes"], deps);
    await vi.waitFor(() => expect(requestFn.calls).toHaveLength(1));
    answerLive(requestFn);
    expect(await pending).toBe(0);

    expect(requestFn.calls[0].headers.Authorization).toBe("Bearer " + OP_KEY);
    expect(deps.stdout.text()).toContain("using key from op://HermesAutomationVault/OpenRouter API Key/API_Key_JevOpenrouter (1Password");
    const everything =
      deps.stdout.text() + deps.stderr.text() + readOnlyRunFile(deps.baseDir, "exchanges.jsonl") + readOnlyRunFile(deps.baseDir, "run.json");
    expect(everything).not.toContain(OP_KEY);
    expect(everything).not.toContain(OP_TOKEN);
  });

  it("an op failure exits 1 before any request and prints only names, the reference and the exit code", async () => {
    const spawn = fakeSpawn({ exitCode: 1, stdout: OP_KEY, stderr: "[ERROR] 403 Service Account Deleted " + OP_TOKEN });
    const deps = baseDeps({ spawn, home: homeWithToken() });

    expect(await run(["stage1", "--yes"], deps)).toBe(1);
    expect(deps.requestFn.calls).toHaveLength(0);
    const output = deps.stdout.text() + deps.stderr.text();
    expect(output).toContain("(op exit 1)");
    expect(output).not.toContain(OP_KEY);
    expect(output).not.toContain(OP_TOKEN);
    expect(output).not.toContain("Service Account Deleted");
  });
});
