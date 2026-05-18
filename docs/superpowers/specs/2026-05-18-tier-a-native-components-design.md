# Tier A native-component migration — design

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan

## Goal

Replace hand-rolled UI primitives in TubeSage's modals and settings tab with native Obsidian components, with **no intended change to look and feel**. The bespoke pieces were already styled to mimic native Obsidian UI, so the native components render essentially the same. The win is removing hand-written SVG construction and bespoke markup plus the CSS that propped it up.

This is "Tier A" of a larger UI audit. Two further findings — replacing the hand-rolled markdown renderer with `MarkdownRenderer` (#1) and the custom picker modals with `FuzzySuggestModal` (#3) — visibly change appearance and are **deliberately deferred**; they are out of scope here.

The 1.3.3 release is the "before" reference point for auditioning the result.

## Background

A UI audit of `main.ts` (8 modal/settings classes) and `styles.css` found bespoke UI where native Obsidian APIs exist. Tier A is the subset with negligible visual impact:

- **Hand-built SVG icons** — 4 icons constructed element-by-element with `createElementNS`: an eye icon for the license-view button (~`main.ts:3798`) and the README-view button (~`3868`), the info icon in `createInfoIcon` (~`4980`), and the copy icon in the template-viewer copy button (~`6358`).
- **Raw `<button>` elements** — 9 buttons created with `createEl('button')`: the create-note modal Process button (~`2925`), the license-view and README-view icon buttons (~`3792`, `3862`), three modal Close buttons (~`5756`, `6089`, `6474`), and the LicenseRequiredModal's Open-settings and Close buttons (~`5854`, `5860`).
- **Raw inputs in the create-note modal** — `YouTubeTranscriptModal` builds raw `<input type=text>` for the URL and title fields and a raw `<select>` for the video-count dropdown.

Native equivalents already used elsewhere in the codebase: `setIcon` (~10 uses), `ExtraButtonComponent` (1 use), `TextComponent` and `DropdownComponent` (settings tab). `ButtonComponent` is not yet used and will be added to the `obsidian` import.

## Changes

### Piece 1 — Icons via `setIcon`

Replace the 4 hand-built SVGs with `setIcon(el, name)` (Lucide icon set, Obsidian's built-in):
- the two eye icons → `setIcon(el, 'eye')`
- the info icon in `createInfoIcon` → `setIcon(el, 'info')` (the info `<span>` stays a span; only the SVG construction is replaced; the existing `setTooltip` call stays)
- the copy icon → `setIcon(el, 'copy')`

Remove the `createElementNS` SVG-building blocks and any now-unused `svgNamespace` constants local to those blocks.

Note: the three eye/copy icons live on buttons that Piece 2 converts to `ExtraButtonComponent`, which sets its icon via its own `.setIcon()`. So in practice Piece 1's eye/copy work is subsumed by Piece 2; the standalone `setIcon` change there applies only if a button is not converted. The info icon is the one genuinely standalone `setIcon` change (it is not a button).

### Piece 2 — Buttons via `ButtonComponent` / `ExtraButtonComponent`

- **Icon buttons** (license-view eye, README-view eye, template-viewer copy) → `ExtraButtonComponent`. Each call sets `.setIcon('eye' | 'copy')`, `.setTooltip(...)` (preserving the current tooltip text), and `.onClick(...)` (preserving the current click behavior). This replaces the raw `<button>`, the hand-built SVG, the manual hover handlers, and the tooltip in one component.
- **Text buttons** (Process, the three Close buttons, Open settings) → `ButtonComponent` with `.setButtonText(...)` and `.onClick(...)`. The Process button additionally calls `.setCta()` — the native equivalent of the `mod-cta` class it currently carries. The mobile full-width behavior of the Process button is preserved (the existing mobile class stays on the component's `buttonEl`).
- Add `ButtonComponent` to the `obsidian` import.

### Piece 3 — Modal inputs via `TextComponent` / `DropdownComponent`

In `YouTubeTranscriptModal`:
- The URL `<input type=text>` and the title `<input type=text>` → `TextComponent`. The modal currently keeps element references (`this.urlInputEl`, `this.titleInputEl`) for focus handling, value reads, and `keydown` listeners; these are repointed to the component's `.inputEl`. Placeholders, the `input` event for URL validation, and the Enter-key handling are preserved.
- The video-count `<select>` → `DropdownComponent`: add options "1".."50" via `.addOption`, default "1", read via `.getValue()`.
- The radio buttons (All videos / Limited number) **stay as raw `<input type=radio>`** — Obsidian has no native radio component.

## Constraint and acceptance

- **No visible change** is the acceptance criterion. Layout containers (`form-group`, the modal-controls flex rows, etc.) and their CSS are kept.
- Bespoke CSS that becomes genuinely dead because a native component replaces it (e.g. hand-built icon-button styling fully superseded by `ExtraButtonComponent`) is removed. CSS still doing layout or still referenced is kept. The implementation plan identifies dead rules case by case; CSS is only removed when a `grep` confirms no remaining reference.
- Verification: `npm run build` clean, `npm run lint` clean (0/0), and a manual before/after comparison against the 1.3.3 release.

## Risk

Native components carry Obsidian's default metrics (padding, height, border-radius). Where the bespoke CSS deliberately differed, the native rendering may differ by a few pixels. The layout classes are kept so structure holds. Any visible drift surfaces in the audition against 1.3.3 and is correctable with a small CSS rule on the native component — not a revert.

## Out of scope

- **#1** — replacing the hand-rolled markdown renderer in `LicenseModal` / `READMEModal` with `MarkdownRenderer`. Visibly changes those modals; deferred.
- **#3** — replacing `TemplateFilePickerModal` / `FolderPickerModal` with `FuzzySuggestModal`. Visibly changes the pickers; deferred.
- The `ProcessingSpinner` (no native equivalent), modal sizing via CSS, and `addEventListener` vs `registerDomEvent` — all assessed as acceptable, no change.

## Testing

No unit-test framework exists; verification is:
- `npm run build` clean.
- `npm run lint` clean (0 errors, 0 warnings).
- `grep` confirms `createElementNS` count dropped to only any intentionally-kept SVGs, and `createEl('button'`/`createEl('input'`/`createEl('select'` in the converted regions are gone.
- Manual: in a dev vault, open the create-note modal, the settings tab, and each modal; confirm the icons, buttons, URL/title fields, and video-count dropdown look and behave as in 1.3.3.
