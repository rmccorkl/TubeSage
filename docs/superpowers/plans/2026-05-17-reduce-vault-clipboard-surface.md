# Reduce Vault-Enumeration and Clipboard Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every whole-vault enumeration call and the only `navigator.clipboard` call from the TubeSage plugin, so the Obsidian scorecard's "Vault Enumeration" and "Clipboard Access" flags clear, without changing user-facing behavior.

**Architecture:** Add one scoped folder-walk helper (`collectUnder`) to `src/utils/path-utils.ts`. Rewrite the template picker and folder picker to walk only the relevant folder subtree via that helper instead of `getMarkdownFiles()` / `getAllLoadedFiles()`. Delete a diagnostic-only enumeration block. Remove the "Copy template" button (the only clipboard user).

**Tech Stack:** TypeScript, Obsidian Plugin API (`Vault`, `TFolder`, `TFile`), esbuild. Verification is `npm run build` and `npm run lint`; there is no unit-test framework, so the build, the lint, and targeted `grep` checks are the tests.

**Design reference:** `docs/superpowers/specs/2026-05-17-reduce-vault-clipboard-surface-design.md`

---

### Task 1: Add the `collectUnder` folder-walk helper

**Files:**
- Modify: `src/utils/path-utils.ts`

- [ ] **Step 1: Check the existing obsidian import**

Open `src/utils/path-utils.ts`. Note whether it already imports from `"obsidian"`. The helper needs `Vault`, `TFolder`, and `TFile`. Add an import line if none exists, or extend the existing one:

```ts
import { Vault, TFolder, TFile } from "obsidian";
```

- [ ] **Step 2: Add the `collectUnder` helper**

Append this to `src/utils/path-utils.ts`:

```ts
/**
 * Collect descendants of a single folder by walking `TFolder.children`,
 * without enumerating the whole vault.
 *
 * - `kind: "folder"` returns the start folder plus all descendant folders.
 * - `kind: "markdown"` returns all descendant Markdown (`.md`) files.
 *
 * Returns an empty array when `folderPath` does not resolve to a folder.
 */
export function collectUnder(vault: Vault, folderPath: string, kind: "folder"): TFolder[];
export function collectUnder(vault: Vault, folderPath: string, kind: "markdown"): TFile[];
export function collectUnder(
    vault: Vault,
    folderPath: string,
    kind: "folder" | "markdown",
): Array<TFolder | TFile> {
    const start = vault.getAbstractFileByPath(folderPath);
    if (!(start instanceof TFolder)) return [];

    const out: Array<TFolder | TFile> = [];
    const stack: TFolder[] = [start];
    while (stack.length > 0) {
        const folder = stack.pop();
        if (!folder) break;
        if (kind === "folder") out.push(folder);
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                stack.push(child);
            } else if (kind === "markdown" && child instanceof TFile && child.extension === "md") {
                out.push(child);
            }
        }
    }
    return out;
}
```

- [ ] **Step 3: Build and lint**

Run: `npm run build`
Expected: completes with no TypeScript errors.
Run: `npm run lint`
Expected: no new errors or warnings.

- [ ] **Step 4: Commit**

```bash
git add src/utils/path-utils.ts
git commit -m "feat: add collectUnder folder-walk helper"
```

---

### Task 2: Template picker uses `collectUnder` instead of `getMarkdownFiles()`

**Files:**
- Modify: `main.ts` — template picker `onOpen()`, around lines 5318-5345

- [ ] **Step 1: Add `collectUnder` to the path-utils import**

`main.ts` line 7 imports from `./src/utils/path-utils`. Add `collectUnder` to that import list. It currently reads:

```ts
import { normalizePath, ensureFolder, joinPaths, sanitizePathComponent } from './src/utils/path-utils';
```

Change it to:

```ts
import { normalizePath, ensureFolder, joinPaths, sanitizePathComponent, collectUnder } from './src/utils/path-utils';
```

- [ ] **Step 2: Replace the whole-vault enumeration + filter**

In the template picker `onOpen()`, replace this block (currently around lines 5318-5345):

```ts
        // Get all markdown files in the vault
        // @ts-ignore - Using Obsidian API types
        const allFiles = this.app.vault.getMarkdownFiles();
        logger.debug("Total markdown files in vault:", allFiles.length);
        
        // Filter to only include files from the templates folder
        this.templates = allFiles
            // @ts-ignore - Using Obsidian API types
            .filter(file => {
                // Check if the file path starts with the templates folder
                // or if it's in a subfolder of the templates folder
                const path = file.path.toLowerCase();
                const templatesFolder = this.templatesFolder.toLowerCase();
                
                const isTemplate = path.startsWith(templatesFolder + '/') || 
                       path === templatesFolder ||
                       path.includes('/' + templatesFolder + '/');
                       
                if (isTemplate) {
                    logger.debug("Found template file:", file.path);
                }
                
                return isTemplate;
            })
            // @ts-ignore - Using Obsidian API types
            .map(file => ({ path: file.path }));
        
        logger.debug(`Found ${this.templates.length} template files`);
```

with:

```ts
        // Collect template files by walking only the configured templates
        // folder subtree — no whole-vault enumeration.
        this.templates = collectUnder(this.app.vault, this.templatesFolder, 'markdown')
            .map(file => ({ path: file.path }));
        logger.debug(`Found ${this.templates.length} template files in "${this.templatesFolder}"`);
```

Leave the rest of `onOpen()` (the "no templates found" message, the search input, the list container) unchanged.

- [ ] **Step 3: Build and lint**

Run: `npm run build`
Expected: no TypeScript errors. If `this.templates`'s declared type rejects `{ path: string }[]`, it already accepted it before this change (the old `.map` produced the same shape), so no type change is needed.
Run: `npm run lint`
Expected: no new errors or warnings. Note the two `@ts-ignore` comments in the old block are removed with it; that is intended.

- [ ] **Step 4: Commit**

```bash
git add main.ts
git commit -m "refactor: template picker walks the templates folder subtree"
```

---

### Task 3: Folder picker uses `collectUnder` instead of `getAllLoadedFiles()`

**Files:**
- Modify: `main.ts` — folder picker `loadFolders()`, around lines 5455-5493

- [ ] **Step 1: Replace the whole-vault enumeration loop**

In `loadFolders()`, replace this block (currently around lines 5455-5493):

```ts
            // Cross-platform implementation: get all files using Obsidian API
            // This works on both desktop and mobile
            const files = this.app.vault.getAllLoadedFiles();
            
            // Add root folder first
            this.folders.push({ 
                path: normalizedRootFolder, 
                name: rootFolder
            });
            uniquePaths.add(normalizedRootFolder);
            
            // Collection of folders for summarized logging
            const foundFolders: string[] = [];
            
            // Process all folders from the vault
            for (const file of files) {
                // Check if it's a folder by testing its instance type
                // This approach works on both desktop and mobile
                if (file && 'children' in file) {
                    const path = file.path || '';
                    
                    // Add all folders that are inside the root folder
                    if (path !== rootFolder && (
                        path.startsWith(rootFolder + '/') || 
                        path.startsWith(normalizedRootFolder + '/'))) {
                        
                        const normalizedPath = normalizePath(path, false); // Keep leading slash for display
                        if (!uniquePaths.has(normalizedPath)) {
                            this.folders.push({
                                path: normalizedPath,
                                name: path
                            });
                            uniquePaths.add(normalizedPath);
                            // Add to our collection for logging
                            foundFolders.push(path);
                        }
                    }
                }
            }
```

with:

```ts
            // Add root folder first — explicit, so the picker always has it
            // even if the subtree walk below returns nothing.
            this.folders.push({ 
                path: normalizedRootFolder, 
                name: rootFolder
            });
            uniquePaths.add(normalizedRootFolder);
            
            // Collection of folders for summarized logging
            const foundFolders: string[] = [];
            
            // Walk only the configured root-folder subtree — no whole-vault
            // enumeration. collectUnder includes the root folder itself, which
            // is skipped here since it was already added above.
            for (const folder of collectUnder(this.app.vault, rootFolder, 'folder')) {
                const path = folder.path;
                if (path === rootFolder) continue;
                const normalizedPath = normalizePath(path, false); // Keep leading slash for display
                if (!uniquePaths.has(normalizedPath)) {
                    this.folders.push({
                        path: normalizedPath,
                        name: path
                    });
                    uniquePaths.add(normalizedPath);
                    foundFolders.push(path);
                }
            }
```

Leave the folder sort and the summary logging that follow (around lines 5495 onward) unchanged. `collectUnder` is already imported into `main.ts` by Task 2.

- [ ] **Step 2: Build and lint**

Run: `npm run build`
Expected: no TypeScript errors.
Run: `npm run lint`
Expected: no new errors or warnings.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "refactor: folder picker walks the root folder subtree"
```

---

### Task 4: Delete the diagnostic enumeration block

**Files:**
- Modify: `main.ts` — note-not-found error branch, around lines 1701-1725

- [ ] **Step 1: Remove the diagnostic block**

In the `if (!(file instanceof TFile))` branch, replace this block (currently around lines 1701-1725):

```ts
                logger.error(`Could not find note file: ${filePath}`);
                // Try to check if any similar files exist
                const folder = filePath.substring(0, filePath.lastIndexOf('/'));
                try {
                    // @ts-ignore - Using internal Obsidian API
                    const folderContents = (this.app.vault.getMarkdownFiles() as Array<{ path: string }>)
                        .filter((f) => f.path.startsWith(folder))
                        .map((f) => f.path);
                    if (folderContents.length > 0) {
                        // Only show a limited number of files to avoid excessive logging
                        const MAX_FILES_TO_LOG = 3;
                        if (folderContents.length <= MAX_FILES_TO_LOG) {
                            logger.debug(`Files in the same folder: ${folderContents.join(', ')}`);
                        } else {
                            const shownFiles = folderContents.slice(0, MAX_FILES_TO_LOG);
                            logger.debug(`Files in the same folder (${folderContents.length} total): ${shownFiles.join(', ')}... and ${folderContents.length - MAX_FILES_TO_LOG} more`);
                        }
                    } else {
                        logger.debug(`No files found in folder: ${folder}`);
                    }
                } catch (folderError) {
                    const errorMessage = getSafeErrorMessage(folderError);
                    logger.error(`Error checking folder contents: ${errorMessage}`);
                }
                throw new Error('Could not find note file');
```

with:

```ts
                logger.error(`Could not find note file: ${filePath}`);
                throw new Error('Could not find note file');
```

This removes the only purpose of the `getMarkdownFiles()` call here (debug logging of nearby files). The error log and the thrown error are preserved.

- [ ] **Step 2: Build and lint**

Run: `npm run build`
Expected: no TypeScript errors. If `getSafeErrorMessage` becomes an unused import, the build (or lint) will flag it — only remove the import if a build/lint error explicitly says it is now unused; it is used elsewhere in `main.ts`, so expect no change.
Run: `npm run lint`
Expected: no new errors or warnings.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "refactor: drop diagnostic vault enumeration in note-not-found branch"
```

---

### Task 5: Remove the "Copy template" button

**Files:**
- Modify: `main.ts` — template-viewer modal, around lines 6398-6481

- [ ] **Step 1: Remove the copy-button block**

In the template-viewer modal, delete the entire block that builds the copy button — from the `// Create a container for the copy button` comment through the closing brace of the `if (copyTextElement)` block. Currently around lines 6398-6481, it starts with:

```ts
            // Create a container for the copy button
            const copyContainer = contentEl.createDiv({
                cls: ['tubesage-template-view-copy-container', 'tubesage-row-end']
            });
```

and ends with:

```ts
            copyButton.addEventListener('click', handleCopy);
            if (copyTextElement) {
                copyTextElement.addEventListener('click', handleCopy);
            }
```

Delete everything from the `// Create a container for the copy button` comment line through that final `}` inclusive. This removes `copyContainer`, the "Copy template" span, `copyButton`, the copy SVG, the hover handlers, the `handleCopy` function, and the `navigator.clipboard.writeText` call.

Keep the line that follows — `templateContainer.createEl('pre', { ... text: templateContent })` — and everything after it. `templateContent` is still used by that `pre` element. Leave the `tubesage-divider` separator line that precedes the deleted block; it still visually separates the template content from the explanation below.

- [ ] **Step 2: Build and verify the clipboard call is gone**

Run: `npm run build`
Expected: no TypeScript errors. If `svgNamespace` was declared inside the deleted block and is referenced later in the same method, the build will fail with an undefined-name error — in that case, also move/keep the single `const svgNamespace = "http://www.w3.org/2000/svg";` declaration that is still needed. (Expected: no such error; the copy SVG is self-contained.)
Run: `npm run lint`
Expected: no new errors or warnings.
Run: `grep -rn "navigator.clipboard\|clipboard" main.ts src/ --include="*.ts"`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "refactor: remove Copy template button (drops navigator.clipboard use)"
```

---

## Final verification

- [ ] `npm run build` is green.
- [ ] `npm run lint` reports 0 errors and 0 warnings.
- [ ] `grep -rn "getMarkdownFiles\|getAllLoadedFiles\|getFiles\|navigator.clipboard" main.ts src/ --include="*.ts"` returns nothing.
- [ ] `grep -rn "getAbstractFileByPath" main.ts | wc -l` is unchanged or higher (targeted lookups are fine; only enumeration APIs were removed).
- [ ] Manual check in a dev vault: open the create-note folder picker — it lists the folders under the configured root folder. Open the template picker — it lists the Markdown files under the configured templates folder. Open the template viewer — the template text shows, with no Copy button.
