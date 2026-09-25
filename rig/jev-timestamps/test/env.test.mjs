import { describe, expect, it } from "vitest";
import { assertNoEnvProxy, readKey } from "../lib/env.mjs";
import { KEY_ENV } from "../lib/constants.mjs";

const FAKE_KEY = "sk-test-FAKE-KEY-0123456789";

describe("readKey", () => {
  it("returns ok:true and the key when set", () => {
    expect(readKey({ [KEY_ENV]: FAKE_KEY })).toEqual({ ok: true, key: FAKE_KEY });
  });

  it("returns ok:false with a helpful message when unset", () => {
    const result = readKey({});
    expect(result.ok).toBe(false);
    expect(result.message).toContain(KEY_ENV);
    expect(result.message).toContain("op read");
    expect(result.message).toContain("1Password");
    expect(result.message).not.toContain(FAKE_KEY);
  });

  it("returns ok:false when the value is empty", () => {
    const result = readKey({ [KEY_ENV]: "" });
    expect(result.ok).toBe(false);
  });

  it("never includes any candidate key value in the failure message", () => {
    // Even an env with unrelated secret-looking values must not leak into
    // the message when the actual key is unset.
    const result = readKey({ SOME_OTHER_SECRET: "sk-other-leaked-value" });
    expect(result.message).not.toContain("sk-other-leaked-value");
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
