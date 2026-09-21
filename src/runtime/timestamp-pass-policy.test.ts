import { describe, expect, it } from "vitest";
import { timestampPassFailure } from "./timestamp-pass-policy";

// The strict/non-strict error policy main.ts's timestamp passes apply at
// every failure site (#3 final review I1). main.ts itself is not unit-tested;
// this is the one decision it delegates.

class SubclassedError extends Error {}

describe("timestampPassFailure", () => {
  it("non-strict (legacy modal / collection path): every failure is swallowed into a notice, whatever the cause", () => {
    const cause = new Error("fetch failed");
    expect(timestampPassFailure(undefined, "Error adding timestamp links: fetch failed", cause)).toEqual({
      kind: "swallow",
      notice: "Error adding timestamp links: fetch failed",
    });
    expect(timestampPassFailure({ strict: false }, "Failed to add timestamp links (empty response from LLM)")).toEqual({
      kind: "swallow",
      notice: "Failed to add timestamp links (empty response from LLM)",
    });
    expect(timestampPassFailure({}, "LLM did not add TimeIndex markers to headings", "a thrown string")).toEqual({
      kind: "swallow",
      notice: "LLM did not add TimeIndex markers to headings",
    });
  });

  it("strict (runner path): an Error cause is rethrown as the SAME instance, so the runner classifies the original (subclass preserved)", () => {
    const cause = new SubclassedError("max_tokens exceeded");
    const outcome = timestampPassFailure({ strict: true }, "Error adding timestamp links: max_tokens exceeded", cause);
    expect(outcome.kind).toBe("throw");
    if (outcome.kind !== "throw") {
      throw new Error("expected throw");
    }
    expect(outcome.error).toBe(cause);
    expect(outcome.error).toBeInstanceOf(SubclassedError);
  });

  it("strict: a soft failure (no cause, or a non-Error cause) becomes a plain Error carrying the notice text — transient by classification, never permanent", () => {
    const soft = timestampPassFailure({ strict: true }, "LLM did not add TimeIndex markers to headings");
    expect(soft.kind).toBe("throw");
    if (soft.kind !== "throw") {
      throw new Error("expected throw");
    }
    expect(soft.error).toBeInstanceOf(Error);
    expect(soft.error.constructor).toBe(Error);
    expect(soft.error.message).toBe("LLM did not add TimeIndex markers to headings");

    const nonError = timestampPassFailure({ strict: true }, "Error adding timestamp links: boom", "boom");
    expect(nonError.kind).toBe("throw");
    if (nonError.kind !== "throw") {
      throw new Error("expected throw");
    }
    expect(nonError.error.constructor).toBe(Error);
    expect(nonError.error.message).toBe("Error adding timestamp links: boom");
  });
});
