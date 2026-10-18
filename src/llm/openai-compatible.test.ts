import { describe, expect, it } from "vitest";
import { isMissingApiKey, providerSetupProblem } from "./openai-compatible";
import type { ProviderSetup } from "./openai-compatible";
import { t } from "../i18n";
import { LOCALES } from "../i18n/locales";

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
    customBaseUrls: {},
    customBaseUrlEnabled: {},
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

  it("stops any other provider whose custom base URL is set but malformed, and only then (#29)", () => {
    const openai = { selectedLLM: "openai", apiKeys: { openai: "sk-test" }, customBaseUrlEnabled: { openai: true, anthropic: true } };
    expect(providerSetupProblem(setup({ ...openai, customBaseUrls: { openai: "proxy.example.com/v1" } }))).toBe(t("notice.baseUrl.invalid"));
    expect(providerSetupProblem(setup({ ...openai, customBaseUrls: { openai: "http://proxy.example.com/v1" } }))).toBeNull();
    expect(providerSetupProblem(setup({ ...openai, customBaseUrls: { openai: "" } }))).toBeNull();
    // Another provider's broken override is not this one's problem.
    expect(providerSetupProblem(setup({ ...openai, customBaseUrls: { anthropic: "nope" } }))).toBeNull();
    // Nor is one switched off (#28): it is kept, but not in use.
    expect(providerSetupProblem(setup({ ...openai, customBaseUrls: { openai: "nope" }, customBaseUrlEnabled: {} }))).toBeNull();
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
