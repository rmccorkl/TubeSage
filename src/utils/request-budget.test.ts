import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  requestBudgetMs,
  setRequestBudgetMs,
} from "./request-budget";

afterEach(() => {
  setRequestBudgetMs(DEFAULT_REQUEST_TIMEOUT_MS);
});

describe("the request budget as a setting (#19 part 3)", () => {
  it("is ten minutes until something sets it, and the default is not raised", () => {
    // The maintainer's ruling: 600 s for ONE request is already generous —
    // what punished long notes was the old budget being per-pass, and that is
    // fixed. The setting exists to accommodate a slow model deliberately,
    // from the per-call timings 1.12.0 logs, not to paper over a wedge.
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(requestBudgetMs()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("takes a value from the host and hands it to whoever asks next", () => {
    expect(setRequestBudgetMs(900_000)).toBe(true);
    expect(requestBudgetMs()).toBe(900_000);
  });

  it("refuses a value that would break every request, and keeps the one it had", () => {
    // A settings field is a text box: it will receive "", "abc" and 5. None
    // of those may become the budget — a 5 ms budget fails every call before
    // it starts, and the user would have no way to tell that from the plugin
    // being broken.
    setRequestBudgetMs(900_000);
    for (const junk of [0, -1, 5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setRequestBudgetMs(junk), `${String(junk)} must be refused`).toBe(false);
      expect(requestBudgetMs()).toBe(900_000);
    }
  });

  it("accepts the floor itself, so the boundary is not off by one", () => {
    expect(setRequestBudgetMs(MIN_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(requestBudgetMs()).toBe(MIN_REQUEST_TIMEOUT_MS);
    expect(setRequestBudgetMs(MIN_REQUEST_TIMEOUT_MS - 1)).toBe(false);
  });
});
