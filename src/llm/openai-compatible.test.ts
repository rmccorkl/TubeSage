import { describe, expect, it } from "vitest";
import { isMissingApiKey, parseBaseUrl, providerSetupProblem } from "./openai-compatible";
import type { ProviderSetup } from "./openai-compatible";
import { t } from "../i18n";
import { LOCALES } from "../i18n/locales";

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

describe("isMissingApiKey — the key rule, with the one exception", () => {
  it("is never true for the OpenAI-compatible server, whose key is optional", () => {
    expect(isMissingApiKey("openai-compatible", {})).toBe(false);
    expect(isMissingApiKey("openai-compatible", { "openai-compatible": "" })).toBe(false);
  });

  it("is true for any other provider without a key, and false with one", () => {
    expect(isMissingApiKey("openai", { openai: "" })).toBe(true);
    expect(isMissingApiKey("openai", { openai: "   " })).toBe(true);
    expect(isMissingApiKey("openrouter", {})).toBe(true);
    expect(isMissingApiKey("openai", { openai: "sk-test" })).toBe(false);
  });
});

describe("providerSetupProblem — what stops a note from starting", () => {
  const setup = (overrides: Partial<ProviderSetup> = {}): ProviderSetup => ({
    selectedLLM: "openai-compatible",
    apiKeys: { openai: "", "openai-compatible": "" },
    selectedModels: { "openai-compatible": "llama-3.1-8b-instruct" },
    openaiCompatibleBaseUrl: "http://192.168.1.20:1234/v1",
    ...overrides,
  });

  it("lets the OpenAI-compatible server start with an address and a model and NO key", () => {
    expect(providerSetupProblem(setup())).toBeNull();
  });

  it("stops it with the clear address message when the URL is blank or malformed", () => {
    expect(providerSetupProblem(setup({ openaiCompatibleBaseUrl: "" }))).toBe(t("notice.openaiCompatible.invalidUrl"));
    expect(providerSetupProblem(setup({ openaiCompatibleBaseUrl: "192.168.1.20:1234" }))).toBe(t("notice.openaiCompatible.invalidUrl"));
  });

  it("stops it when no model is typed, including a data.json from before the provider existed", () => {
    // Without this a blank model would reach TranscriptSummarizer, whose
    // fallback for a falsy model is 'gemini-1.5-pro' — sent to the user's server.
    expect(providerSetupProblem(setup({ selectedModels: { "openai-compatible": "  " } }))).toBe(t("notice.openaiCompatible.modelMissing"));
    expect(providerSetupProblem(setup({ selectedModels: {} }))).toBe(t("notice.openaiCompatible.modelMissing"));
  });

  it("keeps the key rule for every other provider, with the notice it always showed", () => {
    expect(providerSetupProblem(setup({ selectedLLM: "openai" }))).toBe(t("notice.apiKey.missing", { provider: "openai" }));
    expect(providerSetupProblem(setup({ selectedLLM: "openai", apiKeys: { openai: "sk-test" } }))).toBeNull();
  });
});

describe("the new strings are translated in every bundled locale (#25)", () => {
  const NEW_KEYS = [
    "settings.llm.provider.openaiCompatible",
    "settings.llm.openaiCompatible.url.name",
    "settings.llm.openaiCompatible.url.desc",
    "settings.llm.model.descFreeText",
    "notice.openaiCompatible.invalidUrl",
    "notice.openaiCompatible.modelMissing",
  ];

  it.each(NEW_KEYS)("%s: present and non-empty everywhere, with OpenAI and /v1 kept verbatim", (key) => {
    const english = LOCALES.en[key];
    expect(english, `${key} must exist in en`).toBeTruthy();
    for (const [code, entries] of Object.entries(LOCALES)) {
      const text = entries[key] ?? "";
      expect(text.trim(), `${code} ${key}`).not.toBe("");
      if (english.includes("OpenAI")) expect(text, `${code} ${key} lost OpenAI`).toContain("OpenAI");
      if (english.includes("/v1")) expect(text, `${code} ${key} lost /v1`).toContain("/v1");
    }
  });
});
