import { t } from "../i18n";
import { baseUrlOverrides, isUsableBaseUrl, parseBaseUrl } from "./base-url";
import type { BaseUrlSettings } from "./base-url";

// The custom OpenAI-compatible endpoint (#25): LM Studio, vLLM, llama.cpp
// server, LocalAI — any self-hosted server that speaks the OpenAI chat API.
// The model itself is ChatOpenAI at the user's base URL, built beside
// OpenRouter's in langchain-client.ts. What is particular to this provider
// lives here instead, free of LangChain, so the settings tab and main.ts can
// use it and a test can load it.

/**
 * The bearer token sent when the key field is blank. Most self-hosted servers
 * check no key at all, so a blank field is the normal case and has to WORK —
 * but the OpenAI SDK only rejects an undefined key, and would put an empty one
 * on the wire as `Authorization: Bearer ` with nothing after it. Any non-empty
 * value is harmless to a server that ignores the header.
 */
export const PLACEHOLDER_API_KEY = "not-needed";

/**
 * Whether the provider would be called without the key it needs. Never true
 * for the OpenAI-compatible server, whose key is optional: buildOpenAiCompatibleModel
 * sends PLACEHOLDER_API_KEY in place of a blank one.
 */
export function isMissingApiKey(provider: string, apiKeys: Record<string, string>): boolean {
  if (provider === "openai-compatible") return false;
  const key = apiKeys[provider];
  return !key || key.trim() === "";
}

/**
 * The server's extra request fields (#43): a JSON object the user typed,
 * merged into every request as it stands. Blank is no fields. Null means the
 * text is not a JSON object: the settings tab refuses it on blur, and
 * buildOpenAiCompatibleModel refuses it again, because a hand-edited
 * data.json can hold one the tab never saw.
 */
export function parseExtraParams(text: string | undefined): Record<string, unknown> | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The settings providerSetupProblem reads; the plugin's settings interface satisfies it. */
export interface ProviderSetup extends BaseUrlSettings {
  selectedLLM: string;
  apiKeys: Record<string, string>;
  selectedModels: Record<string, string>;
}

/**
 * The notice that stops a note from starting with the selected provider, or
 * null when nothing does. Every other provider needs a key, and a custom base
 * URL, if it has one, that can be used (#29). The OpenAI-compatible server
 * needs an address and a model instead: its key is optional, and its model is
 * free text with no default, because only the user knows what their server
 * serves.
 */
export function providerSetupProblem(settings: ProviderSetup): string | null {
  const provider = settings.selectedLLM;
  if (provider === "openai-compatible") {
    return openAiCompatibleSetupProblem(settings.openaiCompatibleBaseUrl, settings.selectedModels[provider]);
  }
  if (isMissingApiKey(provider, settings.apiKeys)) return t("notice.apiKey.missing", { provider });
  return isUsableBaseUrl(baseUrlOverrides(settings)[provider]) ? null : t("notice.baseUrl.invalid");
}

function openAiCompatibleSetupProblem(baseUrl: string, model: string | undefined): string | null {
  if (parseBaseUrl(baseUrl) === null) return t("notice.openaiCompatible.invalidUrl");
  if (!model || model.trim() === "") return t("notice.openaiCompatible.modelMissing");
  return null;
}
