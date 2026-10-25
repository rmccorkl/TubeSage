// How hard a reasoning model thinks before it answers (#43). One setting for
// every provider that can take it; each builder maps it to the field its
// provider reads (langchain-client.ts, and OllamaClient for Ollama notes).
// Anthropic and Gemini do not read it. Free of LangChain, so the settings
// tab and its tests can load it.

/** The levels, in the order the settings dropdown offers them. */
export const REASONING_EFFORTS = ["default", "none", "low", "medium", "high"] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * The level to put on the wire, or undefined to send nothing. `default` sends
 * nothing, which is exactly the request every provider got before #43; so
 * does anything that is not a level, as a hand-edited data.json can hold.
 */
export function effortToSend(effort: string | undefined): Exclude<ReasoningEffort, "default"> | undefined {
  return isReasoningEffort(effort) && effort !== "default" ? effort : undefined;
}
