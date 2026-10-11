// The 1Password step of key resolution, with `op` replaced by a fake spawn.
// The real op is never run and nothing touches the network.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OP_REF, readKeyFromOnePassword, resolveKey } from "../lib/env.mjs";
import { fakeSpawn } from "./fakes.mjs";

const OP_TOKEN = "ops_FAKE-SERVICE-ACCOUNT-TOKEN-0123456789";
const API_KEY = "sk-or-v1-FAKE-KEY-FROM-1PASSWORD-9876543210";
const OP_STDERR_SECRET = "upstream-detail-that-must-not-be-printed";

/** A temp home holding the Hermes profile token file, as the default --op-token-file expects. */
function homeWithTokenFile(contents = `OP_SERVICE_ACCOUNT_TOKEN='${OP_TOKEN}'\n`) {
  const home = mkdtempSync(join(tmpdir(), "jev-rig-home-"));
  const dir = join(home, ".hermes", "profiles", "tvmacro-bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
  return { home, tokenFile: join(dir, ".env") };
}

const SECRETS = [OP_TOKEN, API_KEY, OP_STDERR_SECRET];

function expectNoSecrets(text) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("resolveKey precedence: environment > --env-file > 1Password", () => {
  it("uses OPENROUTER_API_KEY from the environment and never runs op", async () => {
    const spawn = fakeSpawn({ stdout: `${API_KEY}\n` });
    const result = await resolveKey({ env: { OPENROUTER_API_KEY: "sk-env" }, deps: { spawn } });
    expect(result).toMatchObject({ ok: true, key: "sk-env", source: "environment" });
    expect(spawn.calls).toHaveLength(0);
  });

  it("uses --env-file before 1Password and never runs op", async () => {
    const spawn = fakeSpawn({ stdout: `${API_KEY}\n` });
    const result = await resolveKey({ env: {}, fileVars: { OPENROUTER_API_KEY: "sk-file" }, envFile: "/x/.env", deps: { spawn } });
    expect(result).toMatchObject({ ok: true, key: "sk-file", source: "env-file" });
    expect(spawn.calls).toHaveLength(0);
  });

  it("falls back to `op read` on the default reference, with the token from the default Hermes token file", async () => {
    const spawn = fakeSpawn({ stdout: `${API_KEY}\n` });
    const { home, tokenFile } = homeWithTokenFile();
    const result = await resolveKey({ env: { PATH: "/usr/bin" }, deps: { spawn, home } });

    expect(result).toEqual({ ok: true, key: API_KEY, name: DEFAULT_OP_REF, source: "1password", tokenSource: `token file ${tokenFile}` });
    expect(spawn.calls).toHaveLength(1);
  });

  it("prefers OP_SERVICE_ACCOUNT_TOKEN from the environment over the token file, and honours --op-ref", async () => {
    const spawn = fakeSpawn({ stdout: API_KEY });
    const { home } = homeWithTokenFile("OP_SERVICE_ACCOUNT_TOKEN=from-file\n");
    const result = await resolveKey({ env: { OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN }, op: { ref: "op://V/I/F" }, deps: { spawn, home } });

    expect(result).toMatchObject({ ok: true, key: API_KEY, name: "op://V/I/F", tokenSource: "OP_SERVICE_ACCOUNT_TOKEN in the environment" });
    expect(spawn.calls[0].args).toEqual(["read", "op://V/I/F"]);
    expect(spawn.calls[0].options.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(OP_TOKEN);
  });
});

describe("the service-account token travels only in the child's environment map", () => {
  it("is never in argv and never set in this process's environment", async () => {
    const spawn = fakeSpawn({ stdout: API_KEY });
    const { home, tokenFile } = homeWithTokenFile();
    const before = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    await resolveKey({ env: {}, op: { tokenFile }, deps: { spawn, home } });

    const [{ command, args, options }] = spawn.calls;
    expect(command).toBe("op");
    expect(args).toEqual(["read", DEFAULT_OP_REF]);
    expect(JSON.stringify(args)).not.toContain(OP_TOKEN);
    expect(options.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(OP_TOKEN);
    expect(process.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(before);
  });
});

describe("every 1Password failure is actionable and emits no secret", () => {
  it("token file missing: names the path and does not run op", async () => {
    const spawn = fakeSpawn();
    const missing = join(mkdtempSync(join(tmpdir(), "jev-rig-home-")), "nope.env");
    const result = await resolveKey({ env: {}, op: { tokenFile: missing }, deps: { spawn } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(missing);
    expect(result.message).toContain("ENOENT");
    expect(spawn.calls).toHaveLength(0);
  });

  it("token file without the token line: says so, without echoing the file", async () => {
    const { home, tokenFile } = homeWithTokenFile(`OTHER=${OP_TOKEN}\n`);
    const result = await resolveKey({ env: {}, deps: { spawn: fakeSpawn(), home } });
    expect(result.message).toContain(`${tokenFile} has no OP_SERVICE_ACCOUNT_TOKEN line`);
    expectNoSecrets(result.message);
  });

  it("op not on PATH", async () => {
    const { home } = homeWithTokenFile();
    const result = await resolveKey({ env: {}, deps: { spawn: fakeSpawn({ errorCode: "ENOENT" }), home } });
    expect(result.message).toContain("the op CLI is not on PATH");
    expectNoSecrets(result.message);
  });

  it("auth failure: op's exit code and a hint, never op's output", async () => {
    const { home } = homeWithTokenFile();
    const spawn = fakeSpawn({ exitCode: 1, stdout: API_KEY, stderr: `[ERROR] 403 Service Account Deleted ${OP_STDERR_SECRET}` });
    const result = await resolveKey({ env: {}, deps: { spawn, home } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`op read ${DEFAULT_OP_REF} failed (op exit 1)`);
    expect(result.message).toContain("service-account token");
    expectNoSecrets(result.message);
  });

  it("auth failure with a token from the environment adds the stale-token hint", async () => {
    const spawn = fakeSpawn({ exitCode: 1, stderr: "unauthorized" });
    const result = await resolveKey({ env: { OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN }, deps: { spawn } });
    expect(result.message).toContain("can be a stale or deleted token");
    expectNoSecrets(result.message);
  });

  it("reference not found", async () => {
    const { home } = homeWithTokenFile();
    const spawn = fakeSpawn({ exitCode: 1, stderr: `[ERROR] "Nope" isn't an item in the vault ${OP_STDERR_SECRET}` });
    const result = await resolveKey({ env: {}, op: { ref: "op://V/Nope/F" }, deps: { spawn, home } });
    expect(result.message).toContain("reference not found: op://V/Nope/F (op exit 1)");
    expectNoSecrets(result.message);
  });

  it("an empty value is a failure, not an empty key", async () => {
    const { home } = homeWithTokenFile();
    const result = await resolveKey({ env: {}, deps: { spawn: fakeSpawn({ stdout: "\n" }), home } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("returned an empty value");
  });

  it("a hung op is stopped after the timeout", async () => {
    const spawn = fakeSpawn({ hang: true });
    const result = await readKeyFromOnePassword({ ref: "op://V/I/F", token: OP_TOKEN, tokenSource: "x", env: {}, spawn, timeoutMs: 5 });
    expect(result.message).toContain("did not finish");
    expect(spawn.calls[0].child.killed).toBe(true);
  });

  it("is skipped under the test runner unless a spawn is injected", async () => {
    const result = await resolveKey({ env: { VITEST: "true" } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("skipped under the test runner");
  });
});
