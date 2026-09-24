// Deriving a free note path. Pure: no Obsidian, no `document`, no I/O — the
// vault probe and the path normalizer are both injected, like everything else
// in src/jobs.
//
// Obsidian's `Vault.create` does NOT auto-version: it rejects with
// "File already exists." So re-running the same video, which derives the same
// path, has to land on a free neighbour instead. Obsidian has an internal
// helper for exactly this, but it is absent from the public typings
// (obsidian.d.ts ships only `getAvailablePathForAttachment`), and this plugin
// does not call undocumented API. The CONVENTION below is copied from it so
// the result looks native: basename + " " + n before the extension, n from 1,
// first free number wins.

/** The host's path normalizer (main.ts injects Obsidian's `normalizePath`). Mirrors PathNormalizer in job-record.ts. */
export type FreePathNormalizer = (path: string) => string;

/**
 * The highest suffix tried. Obsidian's own loop is unbounded; this one stops so a
 * mis-wired `taken` probe that answers true forever cannot hang the job stage. At the
 * cap the last candidate is returned EVEN THOUGH the probe called it taken — the caller
 * then attempts a create that Obsidian rejects with "File already exists.", which is the
 * same failure the plugin had before free paths existed. Nothing is overwritten.
 */
export const MAX_FREE_PATH_SUFFIX = 1000;

/**
 * Splits at the final dot of the BASENAME, so a dot in a folder ("Notes/v1.2/x.md")
 * and a dotfile (".md", whose dot is the whole name) both keep the suffix at the end
 * of the basename. A path with no extension gets the suffix appended.
 */
function splitExtension(path: string): { stem: string; extension: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) {
    return { stem: path, extension: "" };
  }
  return { stem: path.slice(0, dot), extension: path.slice(dot) };
}

/**
 * The first path at or after `base` that `taken` reports free.
 *
 * `normalize`, when supplied, is applied to EVERY candidate before it is probed and to
 * the value returned, so the path this answers with is the same key the probe answered
 * about. That is not cosmetic: a base can still arrive in NFD while Obsidian's index is
 * NFC, and a path created under one key and looked up under another is issue #3.
 */
export function nextFreePath(base: string, taken: (path: string) => boolean, normalize?: FreePathNormalizer): string {
  const apply = normalize ?? ((path: string): string => path);
  const normalizedBase = apply(base);
  if (!taken(normalizedBase)) {
    return normalizedBase;
  }
  const { stem, extension } = splitExtension(normalizedBase);
  let candidate = normalizedBase;
  for (let n = 1; n <= MAX_FREE_PATH_SUFFIX; n++) {
    candidate = apply(`${stem} ${n}${extension}`);
    if (!taken(candidate)) {
      return candidate;
    }
  }
  return candidate;
}
