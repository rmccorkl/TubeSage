// Per-call LLM timing, at the layer every provider passes through (#16).
//
// The shim already times one HTTP request (fetch-shim.ts), and that stays —
// the two answer different questions, transport against end-to-end. But the
// shim cannot answer this one at all for OpenAI and OpenRouter, because
// neither reaches it: `getLangChainConfiguration` returns `fetch` at the top
// level and ChatOpenAI builds its client from
// `{apiKey, organization, dangerouslyAllowBrowser, ...fields.configuration}`,
// so the shim is dropped (#19). That is precisely the provider whose latency
// #16 needs measured, which is why the timing also lives here, around the
// invocation itself, where all five paths are equal.
//
// No `obsidian` import, so the format is unit-testable; langchain-client.ts,
// which cannot be loaded in a test, only calls it.

/** Whether the call came back or threw. Both are timings; only one is a latency. */
export type LlmCallOutcome = "ok" | "error";

/**
 * One line per call, under `debugLogging` like every other line in this
 * plugin (main.ts maps that setting onto the logger's global level).
 *
 * `provider` and `model` are on it because #16 compares providers, and a
 * duration with neither beside it measures nothing anyone can act on. The
 * fixed `LLM call ` prefix and the `key=value` shape are so a session's lines
 * can be found and read as a set rather than one at a time.
 */
export function llmCallTimingMessage(
  provider: string,
  model: string,
  elapsedMs: number,
  outcome: LlmCallOutcome,
): string {
  return `LLM call ${outcome === "ok" ? "completed" : "failed"}: provider=${provider} model=${model} elapsed=${elapsedMs}ms outcome=${outcome}`;
}
