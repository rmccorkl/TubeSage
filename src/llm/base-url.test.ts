import { describe, expect, it } from "vitest";
import { baseUrlOverrides, DEFAULT_BASE_URLS, isUsableBaseUrl, modelListUrl, parseBaseUrl, resolveBaseUrl } from "./base-url";
import type { BaseUrlSettings } from "./base-url";
import { t } from "../i18n";

describe("parseBaseUrl — an absolute http(s) address, or nothing (#25)", () => {
  it.each([
    ["LM Studio on this machine", "http://localhost:1234/v1"],
    ["a server on the local network, plain http", "http://192.168.1.20:8000/v1"],
    ["a hosted server over https", "https://llm.example.com/v1"],
    ["an IPv6 literal", "http://[::1]:8080/v1"],
    ["a scheme in capitals", "HTTP://BOX:1234/v1"],
    ["a trailing slash", "http://localhost:1234/v1/"],
  ])("accepts %s, exactly as typed", (_what, url) => {
    expect(parseBaseUrl(url)).toBe(url);
  });

  it("trims the surrounding whitespace a paste brings with it, and changes nothing else", () => {
    expect(parseBaseUrl("  http://localhost:1234/v1 \n")).toBe("http://localhost:1234/v1");
  });

  it.each([
    ["blank", ""],
    ["only spaces", "   "],
    ["no scheme", "localhost:1234/v1"],
    ["a protocol-relative address", "//localhost:1234/v1"],
    // `new URL` alone reads this as http://foo/ — the literal prefix check is what refuses it.
    ["a scheme with no slashes", "http:foo"],
    ["a scheme the SDK cannot use", "ftp://localhost/v1"],
    ["a websocket scheme", "ws://localhost:1234/v1"],
    ["a scheme and nothing else", "http://"],
    ["a space inside the host", "http://local host:1234/v1"],
  ])("refuses %s", (_what, url) => {
    expect(parseBaseUrl(url)).toBeNull();
  });
});

describe("resolveBaseUrl — the override when set, the vendor default when blank (#29)", () => {
  it.each(Object.entries(DEFAULT_BASE_URLS))("%s: blank, absent or only spaces resolves to %s", (provider, fallback) => {
    expect(resolveBaseUrl(provider, "")).toBe(fallback);
    expect(resolveBaseUrl(provider, undefined)).toBe(fallback);
    expect(resolveBaseUrl(provider, "   ")).toBe(fallback);
  });

  it("uses an override trimmed, without a trailing slash, so `${base}/path` never doubles one", () => {
    expect(resolveBaseUrl("anthropic", "  http://gateway.local:4000/anthropic/ ")).toBe("http://gateway.local:4000/anthropic");
    expect(resolveBaseUrl("openai", "https://proxy.example.com/v1//")).toBe("https://proxy.example.com/v1");
  });

  it("refuses a malformed override with the settings-tab message instead of falling back to the vendor", () => {
    // Falling back would send the key to a host the user chose not to use.
    expect(() => resolveBaseUrl("openai", "proxy.example.com/v1")).toThrow(t("notice.baseUrl.invalid"));
    expect(isUsableBaseUrl("proxy.example.com/v1")).toBe(false);
    expect(isUsableBaseUrl("")).toBe(true);
    expect(isUsableBaseUrl(undefined)).toBe(true);
  });
});

describe("modelListUrl — the model list comes from the SAME base URL as the chat (#29)", () => {
  /** Overrides with their toggles ON (#28), unless `enabled` says otherwise. */
  const settings = (customBaseUrls: Record<string, string> = {}, enabled?: Record<string, boolean>): BaseUrlSettings => ({
    customBaseUrls,
    customBaseUrlEnabled: enabled ?? Object.fromEntries(Object.keys(customBaseUrls).map((provider) => [provider, true])),
    openaiCompatibleBaseUrl: "",
  });

  it("asks each vendor exactly where it always did when nothing is overridden", () => {
    expect(modelListUrl("openai", settings())).toBe("https://api.openai.com/v1/models");
    expect(modelListUrl("openrouter", settings())).toBe("https://openrouter.ai/api/v1/models");
    expect(modelListUrl("anthropic", settings())).toBe("https://api.anthropic.com/v1/models");
    expect(modelListUrl("google", settings())).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("asks the custom host instead when one is set, with no doubled slash", () => {
    const custom = settings({
      openai: "http://gateway.local:4000/v1/",
      openrouter: "http://gateway.local:4000/openrouter/v1",
      anthropic: "http://gateway.local:4000/anthropic/",
      google: "http://gateway.local:4000/google",
    });
    expect(modelListUrl("openai", custom)).toBe("http://gateway.local:4000/v1/models");
    expect(modelListUrl("openrouter", custom)).toBe("http://gateway.local:4000/openrouter/v1/models");
    expect(modelListUrl("anthropic", custom)).toBe("http://gateway.local:4000/anthropic/v1/models");
    expect(modelListUrl("google", custom)).toBe("http://gateway.local:4000/google/v1beta/models");
  });

  it("refuses a malformed override here too, rather than quietly asking the vendor", () => {
    expect(() => modelListUrl("anthropic", settings({ anthropic: "gateway.local" }))).toThrow(t("notice.baseUrl.invalid"));
  });

  it.each(["openai-compatible", "ollama", "not-a-provider"])(
    "refuses %s, which has no model-list path, instead of building a URL around undefined",
    (provider) => {
      // A user's address is set, so a careless build would have produced
      // http://192.168.1.20:1234/v1undefined, not an error.
      const withAddress = { ...settings(), openaiCompatibleBaseUrl: "http://192.168.1.20:1234/v1" };
      let url: string | undefined;
      expect(() => { url = modelListUrl(provider, withAddress); }).toThrow(`No model-list endpoint is known for provider "${provider}"`);
      expect(url).toBeUndefined();
      expect(String(url)).not.toContain("http");
    },
  );

  it("asks the vendor while the toggle is off, though the typed URL is kept (#28)", () => {
    const off = settings({ anthropic: "http://gateway.local:4000/anthropic" }, { anthropic: false });
    expect(modelListUrl("anthropic", off)).toBe("https://api.anthropic.com/v1/models");
    expect(off.customBaseUrls.anthropic).toBe("http://gateway.local:4000/anthropic");
  });
});

describe("baseUrlOverrides — one map for every caller", () => {
  it("folds in the OpenAI-compatible server's own setting, so no call site has to remember it", () => {
    expect(baseUrlOverrides({
      customBaseUrls: { openai: "http://proxy/v1" },
      customBaseUrlEnabled: { openai: true },
      openaiCompatibleBaseUrl: "http://box:1234/v1",
    })).toEqual({ openai: "http://proxy/v1", "openai-compatible": "http://box:1234/v1" });
  });

  it("leaves out an override whose toggle is off or was never turned on (#28)", () => {
    expect(baseUrlOverrides({
      customBaseUrls: { openai: "http://proxy/v1", anthropic: "http://proxy/anthropic", google: "http://proxy/google" },
      customBaseUrlEnabled: { openai: false, google: true },
      openaiCompatibleBaseUrl: "",
    })).toEqual({ google: "http://proxy/google", "openai-compatible": "" });
  });
});
