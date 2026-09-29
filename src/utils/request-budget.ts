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
 * There is no setting behind it.
 *
 * WHAT IT ACTUALLY COVERS — three of the five provider paths, not five
 * (#15 review; corrected from the claim made when this landed). The bound
 * applies wherever a request goes through `obsidianFetch`: Ollama through
 * ChatOllama (which reads a top-level `fetch`, @langchain/ollama
 * chat_models.cjs:545), the Anthropic direct call, GeminiClient, and every
 * direct call in the plugin — transcript extraction, the playlist and
 * channel APIs, the Ollama client.
 *
 * OpenAI and OpenRouter do NOT reach it. `getLangChainConfiguration` returns
 * `fetch` at the top level, and ChatOpenAI builds its client from
 * `{apiKey, organization, dangerouslyAllowBrowser, ...fields.configuration}`
 * (@langchain/openai@0.6.17 chat_models.cjs:625-630), so a top-level `fetch`
 * is dropped on the floor. Those two are bounded instead by the OpenAI SDK's
 * own clock: `openai@5.12.2` defaults to `DEFAULT_TIMEOUT` = 600000 ms
 * (client.js:100 and :497) and LangChain passes `maxRetries: 0`
 * (chat_models.cjs:697) — the same ten minutes per request, owned by someone
 * else. #19 tracks moving them onto the shim; it changes headers, error
 * shapes and the mobile transport on the most-used path, so it is not a
 * change to make in passing.
 */
export const REQUEST_TIMEOUT_MS = 600_000;

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
