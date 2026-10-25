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

/**
 * The debug line naming the level a request carries and the field it went out
 * as (#46). A plain string on purpose: the debug callout keeps only a log
 * call's message and drops any object passed beside it, which is how the
 * level stayed out of the note before.
 */
export function effortLogLine(effort: string | undefined, sentAs: string): string {
  const sent = effortToSend(effort);
  return sent ? `Reasoning effort: ${sent} -> ${sentAs}` : "Reasoning effort: default (nothing sent)";
}

/** Ollama's line, on both its paths: it has only an off switch, so only `none` goes out. */
export function ollamaEffortLogLine(effort: string | undefined): string {
  const sent = effortToSend(effort);
  return sent && sent !== "none"
    ? `Reasoning effort: ${sent} (nothing sent: Ollama can only turn thinking off)`
    : effortLogLine(sent, "think:false");
}
