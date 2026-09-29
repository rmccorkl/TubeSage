import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "./error-utils";

// handleApiError logs the raw error before classifying it; the log is not what
// these tests are about, so it is silenced to keep the run's output pristine.
afterEach(() => {
  vi.restoreAllMocks();
});

function messageFor(error: unknown, apiName = "OpenAI"): string {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return handleApiError(error, apiName).message;
}

describe("handleApiError — the timeout message (#13)", () => {
  it("still names the API and says the request timed out", () => {
    const message = messageFor(new Error("request timed out"));
    expect(message).toContain("[OpenAI]");
    expect(message.toLowerCase()).toContain("timed out");
  });

  it("does not blame the model's generation timeout, which was never what ran out", () => {
    // The runner's own 600 s stage budget used to produce this message (#13).
    // That budget is gone, and it was never the model's clock in the first
    // place: advising a model with "a longer generation timeout" pointed the
    // user at a setting that could not have caused it.
    const message = messageFor(new Error("request timed out"));
    expect(message).not.toContain("generation timeout");
    expect(message).not.toContain("too large for the model to process in one pass");
  });
});
