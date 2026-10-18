import { t } from "../i18n";

// Where each provider's requests go (#29). Every provider with a vendor
// endpoint can be pointed somewhere else — a proxy, a gateway, a mirror — and
// a blank override means the vendor's default. Two providers are not here:
// Ollama, whose address has always been its apiKeys entry, and the
// OpenAI-compatible server, whose address is required and has no default.
//
// ONE resolver decides the address for every caller: the chat builders, the
// Anthropic and Gemini calls, the four model-list fetchers and the start-up
// check. Two answers to the same question is exactly the half-working state
// #29 warns about — chat on the proxy while "refresh models" asks the vendor.

/**
 * Each provider's endpoint when its custom base URL is blank. Code only, never
 * stored: a blank setting resolves here at call time, so a change to a default
 * reaches every user who has not overridden it.
 *
 * The conventions differ by vendor and follow each one's own SDK: OpenAI and
 * OpenRouter put the API version in the base URL, Anthropic and Google put it
 * in the request path. The settings tab shows each default as its field's
 * placeholder so that a user copies the right shape.
 */
export const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
};

/** The path under each base URL that lists the provider's models. */
const MODEL_LIST_PATHS: Readonly<Record<string, string>> = {
  openai: "/models",
  openrouter: "/models",
  anthropic: "/v1/models",
  google: "/v1beta/models",
};

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

/** Whether a custom base URL can be used: blank (the default applies) or an absolute http(s) URL. */
export function isUsableBaseUrl(override: string | undefined): boolean {
  const raw = typeof override === "string" ? override.trim() : "";
  return raw === "" || parseBaseUrl(raw) !== null;
}

/**
 * The address a provider's requests go to: the override, trimmed and without
 * a trailing slash, when one is set; the provider's default when it is blank.
 * A set override that is not usable throws, with the message the settings tab
 * shows, rather than falling back: the default would send the user's key to a
 * host they chose not to use.
 */
export function resolveBaseUrl(provider: string, override: string | undefined): string {
  if (!isUsableBaseUrl(override)) {
    throw new Error(t("notice.baseUrl.invalid"));
  }
  const raw = typeof override === "string" ? override.trim() : "";
  return raw === "" ? DEFAULT_BASE_URLS[provider] : raw.replace(/\/+$/, "");
}

/** The settings the base URLs come from; the plugin's settings interface satisfies it. */
export interface BaseUrlSettings {
  customBaseUrls: Record<string, string>;
  customBaseUrlEnabled: Record<string, boolean>;
  openaiCompatibleBaseUrl: string;
}

/**
 * Every provider's base URL in force, blank or absent meaning the default.
 * An override counts only while its toggle is on (#28); switched off, it is
 * kept but not used. The one map handed to TranscriptSummarizer, so no call
 * site has to know about the toggle, or that the OpenAI-compatible server
 * keeps its address in a setting of its own.
 */
export function baseUrlOverrides(settings: BaseUrlSettings): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [provider, url] of Object.entries(settings.customBaseUrls)) {
    if (settings.customBaseUrlEnabled[provider] === true) overrides[provider] = url;
  }
  overrides["openai-compatible"] = settings.openaiCompatibleBaseUrl;
  return overrides;
}

/** Where a provider's model list is fetched: under the SAME base URL its chat requests use. */
export function modelListUrl(provider: string, settings: BaseUrlSettings): string {
  return `${resolveBaseUrl(provider, baseUrlOverrides(settings)[provider])}${MODEL_LIST_PATHS[provider]}`;
}
