// The strict/non-strict failure policy of main.ts's timestamp passes
// (addSectionLinksToNote → addTimestampLinksSinglePass / addTimestampLinksInChunks
// / translateContent). No `obsidian` import: main.ts applies the outcome
// (show the notice and return null, or throw).

/** Options the timestamp passes accept. The job runner's adapter sets `strict`; legacy callers pass nothing. */
export interface TimestampPassOptions {
  /**
   * Runner path (#3 final review I1): every failure inside the passes is thrown instead of being
   * shown as a Notice and swallowed into a null return, so the runner can classify it (plain Error →
   * interrupted, resumable; PermanentJobError → failed) rather than finishing the job as done with a
   * success notice and no timestamps. Also disables the pass's hidden reduced-token retry: on this path
   * every billed call is one counted attempt (spec F6).
   */
  strict?: boolean;
}

export type TimestampPassFailure =
  | { kind: "throw"; error: Error }
  | { kind: "swallow"; notice: string };

/**
 * The one policy for every failure site inside the timestamp passes.
 *
 * - Not strict (the legacy modal and the collection path): swallow — show `notice`, return null.
 *   Byte-for-byte the behaviour before the runner existed.
 * - Strict (the runner path): throw. An `Error` cause is rethrown as the same instance so the runner
 *   classifies the original; a soft failure (empty response, no TimeIndex markers, validation, a
 *   non-Error throw) becomes a plain `Error` carrying the notice text — transient by classification,
 *   bounded by the stage's attempt budget, never permanent.
 */
export function timestampPassFailure(
  options: TimestampPassOptions | undefined,
  notice: string,
  cause?: unknown,
): TimestampPassFailure {
  if (options?.strict !== true) {
    return { kind: "swallow", notice };
  }
  if (cause instanceof Error) {
    return { kind: "throw", error: cause };
  }
  return { kind: "throw", error: new Error(notice) };
}
