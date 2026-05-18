# Restore copy button, fix info-tooltips, refresh diagrams — design

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan

## Goal

Three independent improvements to the TubeSage plugin, plus a documented assessment:

1. **Restore the "Copy template" button** in the template-viewer modal. On mobile the template example cannot be scrolled, so users have no way to read it; the copy button lets them get the text out. Also make a best-effort fix to mobile touch-scrolling of that modal.
2. **Fix the settings info (ⓘ) tooltips.** They currently fail to render reliably on hover. Replace the hand-rolled tooltip mechanism with Obsidian's native `setTooltip()`. Add an OpenRouter reliability note to the LLM tooltip.
3. **Refresh the mermaid diagrams** (`docs/workflow-diagram.md`, `docs/data-flow-diagram.md`) to match the current architecture.
4. **Scorecard disclosures** — assessment only, no code (see end).

## Background

### Part 1 — copy button
The "Copy template" button was removed in commits `d658ae21` (markup in `main.ts`) and `3710f47f` (CSS in `styles.css`) as part of the 1.3.2 vault/clipboard surface reduction. Removing it cleared the scorecard "Clipboard Access" flag, but on Obsidian mobile the template-viewer's scroll box cannot be scrolled by touch, leaving mobile users unable to read the example template. The button is being restored deliberately; the returning "Clipboard Access" disclosure is an accepted trade-off.

### Part 2 — info tooltips
`main.ts` has a private helper `createInfoIcon(container, tooltipText)` used in exactly three places — the *Transcript settings*, *LLM*, and *Advanced* section headings. Each call passes full tooltip text; the text is present in the source and in the deployed 1.3.2 build. The helper builds the tooltip three ways:
- a `data-tooltip` attribute plus a CSS `::after { content: attr(data-tooltip) }` rule shown on `:hover` (custom, should be instant),
- a raw `title` attribute (browser-native, slow),
- a `cursor: help` style.

Observed behavior: on hover the `help` cursor (a question mark) shows instantly; 2-3 seconds later the browser `title` tooltip sometimes appears. The custom `::after` tooltip is flaky/not rendering. The custom mechanism also does nothing on mobile (no hover on touch).

The LLM heading tooltip currently ends: *"Suggested for most users: Google provider with the gemini-2.5-flash model — fast, inexpensive, and high-quality."*

### Part 3 — diagrams
`docs/workflow-diagram.md` and `docs/data-flow-diagram.md` contain themed mermaid flowcharts. They predate recent changes: API keys now use Obsidian secret storage, the UI uses native components, folder access is scoped, LangChain's tiktoken helper is stubbed, and clipboard/enumeration surface was reduced.

## Changes

### Part 1: Restore the copy button

In `main.ts`, in the template-viewer modal, restore the copy-button block that `d658ae21` removed: the `copyContainer` div, the "Copy template" label span, the `copyButton` with its copy-icon SVG, the hover handlers, and the `handleCopy` function that calls `navigator.clipboard.writeText(templateContent)` with success/error feedback on the label. It is placed where it was before — associated with the template-viewer's content area.

In `styles.css`, restore the two rules `3710f47f` removed: `.tubesage-template-view-copy-container` and `.tubesage-template-view-copy-text`. Use the current spacing-variable conventions (`var(--size-4-*)`, `var(--radius-*)`) consistent with the rest of `styles.css`.

`git revert d658ae21 3710f47f` is the expected mechanism; the implementer should confirm the reverts apply cleanly and, if not, re-apply the block by hand from those commits' diffs.

Best-effort mobile-scroll fix: add `-webkit-overflow-scrolling: touch;` to the scrollable template/license/readme container rules (`.tubesage-template-view-container`, `.tubesage-license-container`, `.tubesage-readme-container`). This is the standard momentum-scroll enabler for the mobile webview. If it does not fully resolve mobile scrolling, that is a deeper investigation out of scope here — the copy button is the guaranteed path and the primary deliverable of Part 1.

### Part 2: Native tooltips for info icons

In `main.ts`:
- Add `setTooltip` to the `import { ... } from 'obsidian'` line.
- In `createInfoIcon`, replace the three-way custom tooltip with a single call: `setTooltip(infoIcon, tooltipText, { placement: 'bottom' })`. Remove the `data-tooltip` `setAttribute`, the `addClass('tubesage-settings-info-icon-with-tooltip')`, and the raw `setAttr('title', tooltipText)`.
- Keep the `.tubesage-settings-info-icon` class on the span (icon styling, including `cursor: help`).
- Append to the LLM heading tooltip text: `" If you hit rate limits or reliability issues, OpenRouter is a solid fallback."`

In `styles.css`:
- Remove the now-unused rules: `.tubesage-settings-info-icon-with-tooltip` and `.tubesage-settings-info-icon-with-tooltip::after` and `.tubesage-settings-info-icon-with-tooltip:hover::after`.
- Keep `.tubesage-settings-info-icon`.

Result: the three info tooltips render via Obsidian's native tooltip — fast, reliably, correctly positioned, and functional on mobile. This is the same native mechanism the plugin already uses for button tooltips (`.setTooltip(...)`).

Scope note: there are three info icons and there always have been (since v1.2.21). This change fixes those three; it does not add info icons to additional settings. If broader coverage is wanted, that is a separate additive change.

### Part 3: Refresh the mermaid diagrams

Run graphify over the repository to produce current dependency/community/structure output as factual input. Then update the mermaid flowcharts in `docs/workflow-diagram.md` and `docs/data-flow-diagram.md` so they reflect the current architecture, specifically:
- API keys stored in Obsidian secret storage (cloud providers), not `data.json`.
- Native Obsidian UI components in the modal and settings.
- Scoped folder traversal (`collectUnder`) rather than whole-vault enumeration.
- LangChain tiktoken helper stubbed (no `tiktoken.pages.dev` request).
- Providers: OpenAI, Anthropic, Google, OpenRouter (LangChain), Ollama (local).

Keep the existing mermaid theme/init block and the documents' prose structure; update node/edge content only. Preserve mermaid syntax validity.

## Out of scope / assessment

### Part 4: Scorecard disclosures (no code)
- `tiktoken.pages.dev` — already eliminated in 1.3.1 (build-time stub). A re-scan of 1.3.2+ will not show it.
- Vault Enumeration — already eliminated in 1.3.2.
- Clipboard Access — returns with Part 1; accepted trade-off (mobile readability outweighs the disclosure).
- `atob()/btoa()` and the `fetch`/`request` counts — inside bundled dependencies (LangChain, zod); not removable without dropping those libraries. Disclosed in the README.
- "Malware/Obfuscation/Network scan not available" — Obsidian-side tooling; nothing in the plugin to change.

No code changes for Part 4.

## Error handling and edge cases

- Copy button: `navigator.clipboard.writeText` returns a promise; the restored `handleCopy` keeps its existing `.then`/`.catch` that shows "Copied" / "Failed to copy" feedback on the label.
- `setTooltip` on an element is a no-op visually until hover; passing the full (possibly long) text is fine — Obsidian wraps native tooltips.
- Removing the custom tooltip CSS while a `data-tooltip` attribute lingered would be harmless, but the attribute is also removed, so no dead attribute remains.

## Testing

No unit-test framework exists; verification is:
- `npm run build` clean (tsc + esbuild).
- `npm run lint` clean (0 errors, 0 warnings).
- `grep` confirms `data-tooltip` and `tubesage-settings-info-icon-with-tooltip` are gone from `main.ts` and `styles.css`.
- Manual in a dev vault: the template viewer shows the Copy button and it copies; the three settings info icons show their tooltip promptly on hover (desktop) and on tap (mobile); the LLM tooltip includes the OpenRouter note.
- Mermaid: the two diagram files render without syntax errors.
