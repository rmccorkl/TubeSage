import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoEnvProxy, loadEnvFile, parseEnvFile, readKey } from "../lib/env.mjs";

const FAKE_KEY = "sk-test-FAKE-KEY-0123456789";
const OTHER_KEY = "sk-test-OTHER-KEY-9876543210";

describe("readKey", () => {
  it("prefers OPENROUTER_API_KEY_JEV over OPENROUTER_API_KEY", () => {
    expect(readKey({ OPENROUTER_API_KEY_JEV: FAKE_KEY, OPENROUTER_API_KEY: OTHER_KEY })).toEqual({
      ok: true,
      key: FAKE_KEY,
      name: "OPENROUTER_API_KEY_JEV",
      source: "environment",
    });
  });

  it("falls back to OPENROUTER_API_KEY when OPENROUTER_API_KEY_JEV is unset or empty", () => {
    expect(readKey({ OPENROUTER_API_KEY: OTHER_KEY })).toMatchObject({ ok: true, key: OTHER_KEY, name: "OPENROUTER_API_KEY" });
    expect(readKey({ OPENROUTER_API_KEY_JEV: "", OPENROUTER_API_KEY: OTHER_KEY })).toMatchObject({ name: "OPENROUTER_API_KEY" });
  });

  it("never falls back to another provider's key", () => {
    const result = readKey({ OPENAI_API_KEY: OTHER_KEY });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(OTHER_KEY);
  });

  it("names every accepted variable and --env-file when nothing is set", () => {
    const result = readKey({});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OPENROUTER_API_KEY_JEV");
    expect(result.message).toContain("OPENROUTER_API_KEY_JEV, OPENROUTER_API_KEY.");
    expect(result.message).toContain("--env-file");
    expect(result.message).toContain("--op-token-file");
  });

  it("reads the key from env-file variables when the environment has none", () => {
    expect(readKey({}, { OPENROUTER_API_KEY: FAKE_KEY })).toEqual({
      ok: true,
      key: FAKE_KEY,
      name: "OPENROUTER_API_KEY",
      source: "env-file",
    });
  });

  it("never lets an env-file value override the same variable in the real environment", () => {
    expect(readKey({ OPENROUTER_API_KEY: FAKE_KEY }, { OPENROUTER_API_KEY: OTHER_KEY })).toMatchObject({
      key: FAKE_KEY,
      source: "environment",
    });
  });

  it("emits no value at all on the failure path, from the environment or the env-file", () => {
    const result = readKey(
      { OPENAI_API_KEY: FAKE_KEY, SOME_OTHER_SECRET: "sk-other-leaked-value" },
      { OPENAI_API_KEY: OTHER_KEY, OPENROUTER_API_KEY_TYPO: "sk-typo-leaked-value" },
      "/tmp/some/.env",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("/tmp/some/.env");
    for (const value of [FAKE_KEY, OTHER_KEY, "sk-other-leaked-value", "sk-typo-leaked-value"]) {
      expect(result.message).not.toContain(value);
    }
  });
});

describe("parseEnvFile", () => {
  it("parses KEY=VALUE, skipping blank lines and # comments", () => {
    const vars = parseEnvFile("# a comment\n\nOPENROUTER_API_KEY=abc\n   # indented comment\n\nOTHER=1\n");
    expect({ ...vars }).toEqual({ OPENROUTER_API_KEY: "abc", OTHER: "1" });
  });

  it("strips matching surrounding double or single quotes, and only matching ones", () => {
    const vars = parseEnvFile(`A="double"\nB='single'\nC="mismatched'\nD=plain\nE=""`);
    expect({ ...vars }).toEqual({ A: "double", B: "single", C: `"mismatched'`, D: "plain", E: "" });
  });

  it("keeps = signs inside the value, trims whitespace, and handles CRLF", () => {
    const vars = parseEnvFile("A = b=c==\r\nB=x\r\n");
    expect({ ...vars }).toEqual({ A: "b=c==", B: "x" });
  });

  it("ignores lines that are not simple KEY=VALUE", () => {
    const vars = parseEnvFile("no equals sign\n=no-name\n1BAD=x\nexport X=y\nGOOD=ok\n");
    expect({ ...vars }).toEqual({ GOOD: "ok" });
  });
});

describe("loadEnvFile", () => {
  it("reads and parses a real file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-rig-env-")), ".env");
    writeFileSync(path, "OPENROUTER_API_KEY=\"" + FAKE_KEY + "\"\n");
    const result = loadEnvFile(path);
    expect(result.ok).toBe(true);
    expect(result.vars.OPENROUTER_API_KEY).toBe(FAKE_KEY);
  });

  it("fails naming the path when the file does not exist", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-rig-env-")), "missing.env");
    const result = loadEnvFile(path);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(path);
    expect(result.message).toContain("ENOENT");
  });

  it("fails naming the path when the path cannot be read as a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-rig-env-"));
    const result = loadEnvFile(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(dir);
  });
});

describe("assertNoEnvProxy", () => {
  it("does not throw when nothing is set", () => {
    expect(() => assertNoEnvProxy({}, [])).not.toThrow();
  });

  it("throws naming NODE_USE_ENV_PROXY, without the value, when set", () => {
    let caught;
    try {
      assertNoEnvProxy({ NODE_USE_ENV_PROXY: "1" }, []);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain("NODE_USE_ENV_PROXY");
  });

  it("throws when --use-env-proxy is present in execArgv", () => {
    expect(() => assertNoEnvProxy({}, ["--use-env-proxy"])).toThrow(/--use-env-proxy/);
  });

  it("throws when NODE_OPTIONS contains --use-env-proxy", () => {
    expect(() => assertNoEnvProxy({ NODE_OPTIONS: "--max-old-space-size=4096 --use-env-proxy" }, [])).toThrow(
      /NODE_OPTIONS/,
    );
  });

  it("does not throw for an unrelated NODE_OPTIONS value", () => {
    expect(() => assertNoEnvProxy({ NODE_OPTIONS: "--max-old-space-size=4096" }, [])).not.toThrow();
  });
});
