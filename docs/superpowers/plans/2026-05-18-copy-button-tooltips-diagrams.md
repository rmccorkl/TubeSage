# Copy Button, Info-Tooltips, Diagram Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the "Copy template" button, fix the settings info-icon tooltips by switching to Obsidian's native `setTooltip`, and refresh the two mermaid architecture diagrams.

**Architecture:** Three independent tasks. Task 1 reverts the two commits that removed the copy button and adds a mobile touch-scroll hint. Task 2 replaces the hand-rolled `data-tooltip`/`::after`/`title` tooltip in `createInfoIcon` with Obsidian's native `setTooltip` and deletes the dead CSS. Task 3 refreshes the mermaid docs using graphify output as factual input.

**Tech Stack:** TypeScript, Obsidian Plugin API (`setTooltip`), esbuild, mermaid. Verification is `npm run build` and `npm run lint`; there is no unit-test framework, so build, lint, and `grep` checks are the tests.

**Design reference:** `docs/superpowers/specs/2026-05-18-copy-button-tooltips-diagrams-design.md`

---

### Task 1: Restore the "Copy template" button

**Files:**
- Modify: `main.ts` (template-viewer modal — restored by revert)
- Modify: `styles.css` (copy-button rules restored by revert; touch-scroll hint added)

- [ ] **Step 1: Revert the two removal commits**

Run: `git revert --no-commit d658ae21 3710f47f`

`d658ae21` removed the copy-button markup from `main.ts`; `3710f47f` removed `.tubesage-template-view-copy-container` and `.tubesage-template-view-copy-text` from `styles.css`. Reverting both restores the copy button, its `handleCopy` function (which calls `navigator.clipboard.writeText(templateContent)` with "Copied" / "Failed to copy" feedback), and the two CSS rules.

If `git revert` reports a conflict, resolve it by taking the restored copy-button block: inspect each commit with `git show d658ae21` / `git show 3710f47f` and re-apply the removed lines by hand, then `git revert --skip` or clear the revert state. The regions involved (the template-viewer modal in `main.ts`, the two CSS rules in `styles.css`) were not modified after those commits, so a clean revert is expected.

- [ ] **Step 2: Add a mobile touch-scroll hint to the scroll containers**

In `styles.css`, the three scrollable content boxes — `.tubesage-template-view-container`, `.tubesage-license-container`, `.tubesage-readme-container` — each already have `overflow-y: auto`. Add this one declaration to each of the three rules:

```css
    -webkit-overflow-scrolling: touch;
```

This is the standard momentum-scroll enabler for the mobile webview. It is harmless on desktop. (If mobile scrolling is still broken after this, that is a deeper investigation out of scope for this task — the copy button is the guaranteed path.)

- [ ] **Step 3: Build and lint**

Run: `npm run build`
Expected: completes with no TypeScript errors. The restored `handleCopy` uses `window.setTimeout` (already lint-clean) and `navigator.clipboard.writeText`.
Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

Step 1 used `git revert --no-commit`, so the revert changes are staged but not yet committed. Commit them together with the Step 2 CSS edit as one commit:

```bash
git add main.ts styles.css
git commit -m "feat: restore Copy template button, add mobile touch-scroll hint"
```

---

### Task 2: Native tooltips for the settings info icons

**Files:**
- Modify: `main.ts` — `createInfoIcon` (~line 4971-5018), the obsidian import (line 1), the LLM heading tooltip text (~line 4170)
- Modify: `styles.css` — remove dead tooltip rules (~lines 282-314)

- [ ] **Step 1: Add `setTooltip` to the obsidian import**

`main.ts` line 1 imports a list of names from `'obsidian'`. Add `setTooltip` to that import list (it is a documented Obsidian API function: `setTooltip(el, tooltip, options?)`).

- [ ] **Step 2: Replace the custom tooltip in `createInfoIcon`**

In `createInfoIcon` (around `main.ts:5010-5016`), find this block:

```ts
        // Add tooltip using pure CSS approach
        infoIcon.setAttribute('data-tooltip', tooltipText);
        infoIcon.addClass('tubesage-settings-info-icon-with-tooltip');
        
        // Provide native tooltip fallback
        infoIcon.setAttr('title', tooltipText);
```

Replace it with:

```ts
        // Native Obsidian tooltip — renders reliably, positioned correctly,
        // and works on mobile (unlike the prior hover-only CSS tooltip).
        setTooltip(infoIcon, tooltipText, { placement: 'bottom' });
```

Leave the rest of `createInfoIcon` (the span creation, the SVG icon, `return infoIcon`) unchanged. The `aria-label` attribute and the `.tubesage-settings-info-icon` class stay.

- [ ] **Step 3: Append the OpenRouter reliability note to the LLM tooltip**

Around `main.ts:4170`, the LLM heading `createInfoIcon` call passes this tooltip string:

```
Choose an AI provider, enter its API key, and pick a model. Temperature controls creativity; max tokens caps output length. Suggested for most users: Google provider with the gemini-2.5-flash model — fast, inexpensive, and high-quality.
```

Append one sentence to the end of that string (inside the quotes), so it reads:

```
... fast, inexpensive, and high-quality. If you hit rate limits or reliability issues, OpenRouter is a solid fallback.
```

Change only the string content; do not change the `createInfoIcon` call structure.

- [ ] **Step 4: Delete the dead tooltip CSS**

In `styles.css`, remove these three now-unused rules (around lines 282-314):
- `.tubesage-settings-info-icon-with-tooltip` (the `position: relative` rule)
- `.tubesage-settings-info-icon-with-tooltip::after` (the `content: attr(data-tooltip)` tooltip box)
- `.tubesage-settings-info-icon-with-tooltip:hover::after`

Keep `.tubesage-settings-info-icon` (the icon span styling, including `cursor: help`).

- [ ] **Step 5: Build, lint, and verify the old mechanism is gone**

Run: `npm run build`
Expected: no TypeScript errors.
Run: `npm run lint`
Expected: 0 errors, 0 warnings.
Run: `grep -rn "data-tooltip\|info-icon-with-tooltip" main.ts styles.css`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add main.ts styles.css
git commit -m "fix: use native setTooltip for settings info icons, add OpenRouter note"
```

---

### Task 3: Refresh the mermaid architecture diagrams

**Files:**
- Modify: `docs/workflow-diagram.md`
- Modify: `docs/data-flow-diagram.md`

- [ ] **Step 1: Generate current architecture facts with graphify**

From the repo root, run `graphify . --update` to refresh the knowledge graph (AST-only, no API cost), then read `graphify-out/GRAPH_REPORT.md` for the current module/community structure. Use it as factual input — do not invent architecture.

- [ ] **Step 2: Read the current diagrams and the codebase entry points**

Read `docs/workflow-diagram.md` and `docs/data-flow-diagram.md` in full. Note the existing mermaid `%%{init: ...}%%` theme block and the surrounding prose — these are kept. Cross-check against `main.ts` (the orchestrator), `src/llm/` (provider clients), `src/youtube-transcript.ts`, `src/utils/fetch-shim.ts`, and `manifest.json`.

- [ ] **Step 3: Update `workflow-diagram.md`**

Update the mermaid flowchart's nodes/edges so the user-and-system workflow reflects the current architecture. It must accurately show:
- API keys read from / written to Obsidian secret storage for cloud providers (OpenAI, Anthropic, Google, OpenRouter); the Ollama server URL stays in plugin data.
- Native Obsidian UI components (modal, settings toggles, CTA button).
- Folder/template selection via scoped subtree traversal (`collectUnder`), not whole-vault enumeration.
- Providers: OpenAI, Anthropic, Google, OpenRouter via LangChain; Ollama local.
Keep the `%%{init}` theme block and the document's prose headings. Change only diagram content. Do not remove sections that are still accurate.

- [ ] **Step 4: Update `data-flow-diagram.md`**

Update the mermaid flowchart so the data flow reflects the current architecture. It must accurately show:
- Cloud API keys flowing through Obsidian secret storage, never `data.json`.
- The transcript → LLM summarization → template → note pipeline.
- The cross-platform `obsidianFetch` shim for HTTP.
- LangChain's tiktoken helper stubbed at build time (no `tiktoken.pages.dev` request).
Keep the `%%{init}` theme block and prose. Change only diagram content.

- [ ] **Step 5: Verify mermaid validity**

Confirm both files' mermaid blocks are syntactically valid (balanced brackets, valid node/edge syntax, every node referenced is defined). There is no mermaid CLI in the project; review by reading. `npm run build` does not cover docs, so just confirm the markdown is well-formed.

- [ ] **Step 6: Commit**

```bash
git add docs/workflow-diagram.md docs/data-flow-diagram.md
git commit -m "docs: refresh workflow and data-flow mermaid diagrams"
```

---

## Final verification

- [ ] `npm run build` is green.
- [ ] `npm run lint` reports 0 errors and 0 warnings.
- [ ] `grep -rn "data-tooltip\|info-icon-with-tooltip" main.ts styles.css` returns nothing.
- [ ] `grep -n "navigator.clipboard" main.ts` shows the restored copy-button call (the clipboard surface is intentionally back).
- [ ] The LLM info tooltip text contains the OpenRouter sentence.
- [ ] Manual in a dev vault: the template viewer shows the Copy button and it copies; the three settings info icons (Transcript, LLM, Advanced headings) show their tooltip promptly on hover; both mermaid diagrams render.
