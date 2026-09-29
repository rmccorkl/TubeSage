import { describe, expect, it } from "vitest";
import { llmCallTimingMessage } from "./call-timing";

describe("llmCallTimingMessage (#16)", () => {
  it("names the provider, the model and the elapsed ms, so a measurement is attributable", () => {
    // #16 has to compare providers. A duration with no provider and no model
    // beside it measures nothing anyone can act on.
    const message = llmCallTimingMessage("openrouter", "anthropic/claude-sonnet-4", 12_345, "ok");
    expect(message).toContain("provider=openrouter");
    expect(message).toContain("model=anthropic/claude-sonnet-4");
    expect(message).toContain("elapsed=12345ms");
  });

  it("says whether the call succeeded, so a slow failure is not read as a slow answer", () => {
    // A call that gave up at the budget and one that answered at the budget
    // are the same number and opposite facts.
    expect(llmCallTimingMessage("openai", "gpt-5", 600_000, "error")).toContain("outcome=error");
    expect(llmCallTimingMessage("openai", "gpt-5", 900, "ok")).toContain("outcome=ok");
  });

  it("carries one stable prefix, so the lines can be found and parsed as a set", () => {
    const ok = llmCallTimingMessage("ollama", "llama3", 10, "ok");
    const failed = llmCallTimingMessage("anthropic", "claude-opus-4", 10, "error");
    expect(ok.startsWith("LLM call ")).toBe(true);
    expect(failed.startsWith("LLM call ")).toBe(true);
  });
});
