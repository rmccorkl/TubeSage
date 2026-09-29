import { describe, expect, it } from "vitest";
import { chunkFailureAction, timestampPassFailure } from "./timestamp-pass-policy";

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

describe("chunkFailureAction — what a pass does when ONE chunk's request fails (#15)", () => {
  it("strict (the runner path): the pass is abandoned, so nothing can reach its write", () => {
    // THE PROPERTY THAT CHOSE PER-REQUEST OVER PER-STAGE. A request the shim
    // gave up on rejects one chunk call; the pass must end there, before the
    // `writeIfUnchanged` at the bottom of addTimestampLinksInChunks. Were
    // this decision ever to say "carry on with the original chunk", the note
    // would gain partial timestamps behind an abandoned request — which is
    // exactly the abandoned-write hazard #13 removed at stage level and #15
    // was designed not to reintroduce.
    const timedOut = new Error("TubeSage stopped waiting for a reply after 600 s (its per-request limit).");
    const action = chunkFailureAction({ strict: true }, 3, timedOut);

    expect(action.kind).toBe("fail-pass");
    // The original instance, so the runner classifies what actually happened.
    expect(action.kind === "fail-pass" && action.error).toBe(timedOut);
  });

  it("strict: a chunk that failed without an Error cause still abandons the pass", () => {
    const action = chunkFailureAction({ strict: true }, 1, "something unthrowable");
    expect(action.kind).toBe("fail-pass");
    expect(action.kind === "fail-pass" && action.error).toBeInstanceOf(Error);
    expect(action.kind === "fail-pass" && action.error.message).toContain("chunk 1");
  });

  it("there is NO strict outcome that lets the pass carry on to its write", () => {
    // Stated as a loop rather than a single case: the guarantee is about the
    // whole space of causes, not about one of them.
    const causes: unknown[] = [
      new Error("socket hang up"),
      new TypeError("Invalid URL"),
      "a string",
      undefined,
      { status: 500 },
    ];
    for (const cause of causes) {
      expect(chunkFailureAction({ strict: true }, 2, cause).kind).toBe("fail-pass");
    }
  });

  it("not strict (the legacy modal): the chunk keeps its original text and the pass goes on", () => {
    // Unchanged legacy behaviour, pinned so the strict rule above cannot be
    // generalised over it by accident: this path DOES write a partially
    // linked note, and that is what it has always done.
    expect(chunkFailureAction(undefined, 2, new Error("socket hang up")).kind).toBe("keep-original");
    expect(chunkFailureAction({}, 2, new Error("socket hang up")).kind).toBe("keep-original");
    expect(chunkFailureAction({ strict: false }, 2, new Error("socket hang up")).kind).toBe("keep-original");
  });
});
