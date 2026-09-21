// Atomic guarded note write. No Obsidian import: ProcessableVault is a
// structural interface that Obsidian's real Vault satisfies without this
// module ever depending on the `obsidian` package.

/** The one Vault capability the guard needs; Obsidian's Vault satisfies it structurally. */
export interface ProcessableVault<F = unknown> {
  process(file: F, fn: (data: string) => string): Promise<string>;
}

/**
 * Atomically writes `next` only if the file's content, read INSIDE the atomic callback, still equals `expected`.
 * Returns true when written, false when the content had changed (nothing written).
 * Why: timestamp/translation passes read a note, spend minutes in an LLM call, then write back; a user edit in
 * between must win. Obsidian's `vault.process` is the only read-modify-write that is atomic against the editor.
 */
export async function writeIfUnchanged<F>(
  vault: ProcessableVault<F>,
  file: F,
  expected: string,
  next: string,
): Promise<boolean> {
  let wrote = false;
  await vault.process(file, (data: string): string => {
    if (data === expected) {
      wrote = true;
      return next;
    }
    return data;
  });
  return wrote;
}
