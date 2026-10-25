// The bound on ONE outbound request (#15), kept apart from the shim that
// applies it: `fetch-shim.ts` imports `obsidian`, and the budget and its
// wording are needed by code and tests that must not load the app.

/**
 * How long one request may go unanswered before the shim stops waiting.
 *
 * Per REQUEST, not per pass: a 12-chunk note legitimately makes twelve calls
 * and should be allowed twelve times as long, while any single call that
 * stops returning means something is wrong. It is the same number as the
 * stage budget #13 removed, deliberately — ten minutes for one call, not for
 * a whole pass — and it is a starting value chosen to be obviously generous
 * rather than a measured one (#15: tune it from real runs).
 *
 * It is the DEFAULT. Since #19 the effective value is a setting; see below.
 *
 * WHAT IT COVERS — every provider path, since #19. The bound applies
 * wherever a request goes through `obsidianFetch`, and they all do now:
 * OpenAI and OpenRouter through ChatOpenAI's `configuration.fetch`
 * (getOpenAiConfiguration), Ollama through ChatOllama's top-level `fetch`,
 * the Anthropic direct call, GeminiClient, and every direct call in the
 * plugin — transcript extraction, the playlist and channel APIs, the model
 * lists. `requestUrl` is imported in one file and there is no bare `fetch(`
 * in `src/` or `main.ts`.
 *
 * On the two ChatOpenAI paths this number is ALSO handed to the OpenAI SDK
 * as its `timeout`, because `openai@7.43.0` implements a timeout by aborting
 * the signal it hands to fetch and the shim honours signals: left unset, the
 * SDK's own DEFAULT_TIMEOUT of 600000 ms (client.mjs:238, :1815) would cap
 * whatever is configured here (#19 F1). The two are deliberately the same
 * number. The SDK's timer, armed first, is the one that fires on those
 * paths; on the other three this budget is the only bound there is, and the
 * setting has no upper limit — a very large value really does mean no
 * effective bound.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * The floor a configured budget may not go under. A handful of milliseconds
 * would fail every request before it started, and from the user's side that
 * is indistinguishable from the plugin being broken — so a value below this
 * is refused rather than applied.
 */
export const MIN_REQUEST_TIMEOUT_MS = 1_000;

// The effective budget for this session. Module state rather than a
// parameter because the shim is a free function every provider and the
// transcript extractor call, with no plugin object to carry a setting
// through, and threading one through all of them to deliver one number would
// be worse than this.
//
// The host pushes the value in (main.ts, on load and whenever the setting
// changes); nothing here reads settings or imports `obsidian`. That is load
// bearing, not incidental: this module's tests use the real message and the
// real numbers, and the seam-level suites — which cannot load `obsidian` at
// all — import it directly.
let currentBudgetMs: number = DEFAULT_REQUEST_TIMEOUT_MS;

/**
 * Applies a budget from the host. Returns false, changing nothing, when the
 * value is not a number a request could survive: a settings field is a text
 * box, and "", "abc" and 5 all arrive here eventually.
 */
export function setRequestBudgetMs(ms: number): boolean {
  if (!Number.isFinite(ms) || ms < MIN_REQUEST_TIMEOUT_MS) {
    return false;
  }
  currentBudgetMs = ms;
  return true;
}

/** The budget in force right now. Read per request, so a settings change applies to the next call. */
export function requestBudgetMs(): number {
  return currentBudgetMs;
}

/**
 * What the shim says when it gives up. It names US as the one who stopped
 * waiting, because that is what happened: the provider did not answer, and
 * nothing here can tell it to stop.
 *
 * Deliberately free of the words `error-utils` classifies on ("timed out",
 * "network", "connect"...), so `handleApiError` passes it through intact
 * instead of replacing it with generic advice about the model's own limits.
 *
 * It used to end "nothing was written", which was a promise this string is
 * in no position to make (#15 review F8). It happens to be true on every
 * path reachable today — both timestamp passes run strict for the runner, so
 * a failed chunk ends the pass before its write (timestamp-pass-policy.ts,
 * `chunkFailureAction`), and a timed-out transcript fetch has nothing to
 * write yet — but it is false on the non-strict legacy branch, which keeps
 * the original chunk and goes on to write a partially linked note. The
 * guarantee belongs where it is conditioned and tested, not in a sentence
 * shown beside every failure.
 */
export const requestTimeoutMessage = (ms: number): string =>
  `TubeSage stopped waiting for a reply after ${Math.round(ms / 1000)} s (its per-request limit). ` +
  `The provider never responded.`;
