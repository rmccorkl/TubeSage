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
 */
export const requestTimeoutMessage = (ms: number): string =>
  `TubeSage stopped waiting for a reply after ${Math.round(ms / 1000)} s (its per-request limit). ` +
  `The provider never responded; nothing was written.`;
