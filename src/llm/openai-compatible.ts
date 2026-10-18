import { t } from "../i18n";

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

const HTTP_PREFIX = /^https?:\/\//i;

/**
 * The address to use, trimmed, when it is an absolute http(s) URL; null when
 * it is not. The prefix is checked literally before parsing because `new URL`
 * alone is lenient: it reads `http:foo` as `http://foo/`. Plain http is
 * accepted on purpose — a server on the local network rarely has a
 * certificate. The address is otherwise left exactly as typed: the SDK
 * appends `/chat/completions` to it, so `/v1` is the user's to include.
 */
export function parseBaseUrl(raw: string): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!HTTP_PREFIX.test(trimmed)) return null;
  try {
    return new URL(trimmed).hostname === "" ? null : trimmed;
  } catch {
    return null;
  }
}

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

/** The settings providerSetupProblem reads; the plugin's settings interface satisfies it. */
export interface ProviderSetup {
  selectedLLM: string;
  apiKeys: Record<string, string>;
  selectedModels: Record<string, string>;
  openaiCompatibleBaseUrl: string;
}

/**
 * The notice that stops a note from starting with the selected provider, or
 * null when nothing does. Every other provider needs a key. This one needs an
 * address and a model instead: its key is optional, and its model is free
 * text with no default, because only the user knows what their server serves.
 */
export function providerSetupProblem(settings: ProviderSetup): string | null {
  const provider = settings.selectedLLM;
  if (provider === "openai-compatible") {
    return openAiCompatibleSetupProblem(settings.openaiCompatibleBaseUrl, settings.selectedModels[provider]);
  }
  return isMissingApiKey(provider, settings.apiKeys) ? t("notice.apiKey.missing", { provider }) : null;
}

function openAiCompatibleSetupProblem(baseUrl: string, model: string | undefined): string | null {
  if (parseBaseUrl(baseUrl) === null) return t("notice.openaiCompatible.invalidUrl");
  if (!model || model.trim() === "") return t("notice.openaiCompatible.modelMissing");
  return null;
}
