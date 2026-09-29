import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `obsidian` ships types only, so the one call this module makes into the app
// is mocked. Everything else here is the real shim.
const requestUrl = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({ requestUrl }));

import { handleApiError } from "./error-utils";
import { obsidianFetch } from "./fetch-shim";
import { REQUEST_TIMEOUT_MS, requestTimeoutMessage } from "./request-budget";

const URL_UNDER_TEST = "https://api.example.com/v1/chat/completions";

/** A request that never settles: the wedged socket #15 is about. */
const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

/** Runs the shim and reports what became of it, without ever awaiting a hang. */
function track(): { outcome: () => string } {
  let outcome = "pending";
  void obsidianFetch(URL_UNDER_TEST, { method: "POST", body: "{}" }).then(
    (response) => { outcome = `resolved ${response.status}`; },
    (error: unknown) => { outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`; },
  );
  return { outcome: () => outcome };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The shim uses `window` timers (this repo's popout-safe convention). This
  // suite runs on node, where there is no window at all, so `window` is
  // pointed at the same globals vitest has just faked — which is what puts
  // the shim's own timer under this test's control.
  //
  // The popout-window rules below are about plugin code running inside
  // Obsidian, where a second window genuinely exists; in a node test there is
  // neither an `activeWindow` nor a `window` to prefer, so they are disabled
  // for this one line rather than repo-wide.
  // eslint-disable-next-line obsidianmd/no-global-this, obsidianmd/prefer-active-doc -- no window exists on node; this is what creates one
  vi.stubGlobal("window", globalThis);
  requestUrl.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("obsidianFetch — the per-request budget (#15)", () => {
  it("gives up on a request that never settles, once the budget has run out", async () => {
    requestUrl.mockReturnValue(neverSettles());
    const call = track();

    // One tick short of the budget it is still waiting: a slow provider is
    // not a wedged one.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(call.outcome()).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    expect(call.outcome()).toMatch(/^rejected: /);
  });

  it("is ten minutes per request by default, and says so as a named export", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(600_000);
  });

  it("lets a request that answers just inside the budget through, and leaves no timer armed", async () => {
    let settle: (value: unknown) => void = () => undefined;
    requestUrl.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const call = track();

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    settle({ status: 200, text: "{}", headers: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.outcome()).toBe("resolved 200");
    // The budget's timer went with the answer. Left armed, it would fire into
    // a finished request — and, on a long pass, one per chunk would pile up.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives each request its own budget, so a pass of three calls gets three of them", async () => {
    // The point of #15 over a stage ceiling: a 12-chunk note should be allowed
    // twelve times as long as a 1-chunk note, not squeezed into one budget.
    const nearBudget = REQUEST_TIMEOUT_MS - 1;
    let answered = 0;
    requestUrl.mockImplementation(() => new Promise((resolve) => {
      window.setTimeout(() => { answered += 1; resolve({ status: 200, text: "{}", headers: {} }); }, nearBudget);
    }));

    for (let chunk = 0; chunk < 3; chunk++) {
      const call = track();
      await vi.advanceTimersByTimeAsync(nearBudget);
      expect(call.outcome()).toBe("resolved 200");
    }

    expect(answered).toBe(3);
    // Three near-budget calls in a row: well past a single 600 s ceiling.
    expect(Date.now()).toBeGreaterThan(REQUEST_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blames the client, not the model, and survives the error formatter intact", async () => {
    // A user reading this must not be sent to change a model setting: nothing
    // ran out at the provider's end, WE stopped waiting.
    const message = requestTimeoutMessage(REQUEST_TIMEOUT_MS);
    expect(message).toContain("TubeSage stopped waiting");
    expect(message).toContain("per-request limit");
    expect(message).toContain("nothing was written");
    expect(message).not.toContain("generation timeout");

    // error-utils classifies on the wording, so the message has to come out
    // the other side unchanged rather than being replaced by generic advice.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(handleApiError(new Error(message), "OpenAI").message).toBe(`[OpenAI] ${message}`);
  });
});
