# Reduce vault-enumeration and clipboard surface — design

**Date:** 2026-05-17
**Status:** Approved, ready for implementation plan

## Goal

Clear two flags on the Obsidian community-plugin scorecard for TubeSage:

- **Vault Enumeration** — "Enumerates all files in the vault (`vault.getFiles`, `getMarkdownFiles`, etc.)."
- **Clipboard Access** — "Reads or writes the system clipboard."

The plugin's user-facing behavior must not change: the template picker and the folder picker keep working exactly as before.

## Background

The scorecard scanner flags any use of whole-vault enumeration APIs and any use of `navigator.clipboard`. TubeSage triggers both:

- Vault enumeration at three call sites in `main.ts`:
  - `~1706` — a diagnostic block that calls `getMarkdownFiles()` only to `logger.debug` files near a not-found note.
  - `~5320` — the template picker modal: `getMarkdownFiles()` over the whole vault, then filters to the templates folder.
  - `~5457` — the folder picker (`loadFolders`): `getAllLoadedFiles()` over the whole vault, then filters to folders under the configured root folder.
- Clipboard at one call site: `main.ts:~6454`, `navigator.clipboard.writeText(templateContent)` behind the "Copy template" button in the template-viewer modal.

There is no cross-platform clipboard API that avoids `navigator.clipboard`, and no way to obtain a folder/file list without an enumeration API. So the flags can only be cleared by removing the clipboard feature and by scoping enumeration to specific folder subtrees rather than the whole vault.

## Changes

### 1. Remove the "Copy template" button (clipboard)

In the template-viewer modal (`main.ts`, around line 6454), remove the "Copy template" button, its container element, and the `navigator.clipboard.writeText(...)` call and its handler. The template text remains visible in the modal and can still be selected and copied manually with Cmd/Ctrl+C.

After this change, `grep -rn "navigator.clipboard\|clipboard" main.ts src/` returns nothing.

### 2. Delete the diagnostic enumeration block (`main.ts:~1706`)

In the not-found error branch (the block beginning around `main.ts:1702` with the comment "Try to check if any similar files exist"), delete the `getMarkdownFiles()` call and the surrounding logging of "files in the same folder." The `logger.error` that reports the missing file path stays. This block only produced a debug log line; removing it has no functional effect.

### 3. Scoped folder-walk helper

Add one helper to `src/utils/path-utils.ts`:

```ts
import { TFolder, TFile, Vault } from "obsidian";

/**
 * Collect descendants of a folder by walking TFolder.children, without
 * enumerating the whole vault. Returns [] if the path is not a folder.
 * `kind` selects folders or markdown files; the start folder itself is
 * included when kind is "folder".
 */
export function collectUnder(
  vault: Vault,
  folderPath: string,
  kind: "folder" | "markdown",
): Array<TFolder | TFile>
```

Implementation: `vault.getAbstractFileByPath(folderPath)`; if it is not a `TFolder`, return `[]`. Otherwise walk `children` recursively (iteratively, to avoid deep recursion), collecting `TFolder`s (for `"folder"`, including the start folder) or `TFile`s whose extension is `md` (for `"markdown"`).

This touches only the named subtree, never the whole vault.

### 4. Template picker uses the helper (`main.ts:~5320`)

Replace `this.app.vault.getMarkdownFiles()` + the templates-folder filter with `collectUnder(this.app.vault, this.templatesFolder, "markdown")`. The resulting list is the markdown files under the configured templates folder.

Behavior note: the current filter also loosely matches a templates folder nested anywhere in the vault (`path.includes('/' + templatesFolder + '/')`). The helper resolves the exact configured `templatesFolder` path instead. This is a deliberate correctness tightening: the templates folder is a configured path and should be matched as such. Not treated as a regression.

### 5. Folder picker uses the helper (`main.ts:~5457`)

Replace `this.app.vault.getAllLoadedFiles()` + the under-root filter with `collectUnder(this.app.vault, rootFolder, "folder")`. The root folder is still added explicitly first (existing behavior); the helper supplies its descendant folders. The existing dedupe via `uniquePaths` stays.

## Result

`grep` for `getFiles`, `getMarkdownFiles`, `getAllLoadedFiles`, `getAllFiles`, and `navigator.clipboard` across `main.ts` and `src/` returns nothing. Both pickers list the same entries as before. The scanner has no vault-enumeration or clipboard API surface to flag.

## Error handling and edge cases

- `collectUnder` returns `[]` when the path does not exist or is not a folder. The template picker then shows no templates (same as today when the folder is empty or missing); the folder picker still has the explicitly-added root folder.
- The folder picker already ensures the root folder exists (`ensureFolder`) before walking; that stays.
- `getAbstractFileByPath` is a targeted lookup, already used widely in `main.ts`, and is not an enumeration API.

## Testing

No unit-test framework exists in this project; verification is:

- `npm run build` — clean (tsc + esbuild).
- `npm run lint` — clean (0 errors, 0 warnings).
- `grep` checks above return nothing.
- Manual: open the template picker and confirm it lists the template files under the configured templates folder; open the create-note folder picker and confirm it lists the folders under the root folder; confirm the template-viewer modal still shows template text (just without the Copy button).

## Out of scope

- The other scorecard items (`atob`/`btoa` in bundled dependencies, vault read/write, the "scan not available" lines) are not addressed here; they are either inherent functionality or not plugin-fixable.
- No release is performed by this work; releasing an updated build is a separate decision.
