# Mobile template-viewer height fix — design

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan

## Goal

On Obsidian mobile, the template-viewer modal (`TemplateViewModal`, which shows the example Templater template) collapses so its content area is a single blank line — the template appears to be missing. Make the mobile template-viewer large enough that a real portion of the template is visible and scrollable, as it is on desktop.

## Background

`.tubesage-template-view-container` in `styles.css` (line 648) sets only `max-height` (500px, narrowed to 250px by the `tubesage-template-view-container-short` modifier the modal also applies) plus `overflow-y: auto` and `-webkit-overflow-scrolling: touch`. `max-height` only caps height; the box's actual height is the content's intrinsic height. On desktop the `<pre>` establishes a normal height, so the box fills to it. On mobile the box collapses to roughly one blank line.

Separately, `.tubesage-template-view-modal-size.modal` (line 638) has no entry in the `@media (max-width: 768px)` block, unlike the license and readme modals, which get explicit mobile size overrides there.

## Change

Add two rules to the existing `@media (max-width: 768px)` block in `styles.css`:

1. `.tubesage-template-view-modal-size.modal` — mobile size override, matching the license/readme pattern already in that block:
   ```css
   width: 95vw;
   max-width: 95vw;
   max-height: 85vh;
   ```

2. `.tubesage-template-view-container` — a definite height for mobile (overrides the desktop `max-height`):
   ```css
   height: 50vh;
   max-height: 50vh;
   ```
   A definite `height` (not just `max-height`) forces the box to a usable size regardless of the content's intrinsic height, so a portion of the template is always shown. The existing `overflow-y: auto` and `-webkit-overflow-scrolling: touch` make the rest scrollable.

CSS only. No TypeScript change, no behavior change. Desktop styling is untouched — the new rules live only inside the `@media (max-width: 768px)` block.

## Out of scope

No change to the desktop template viewer, the modal contents, or any other modal.

## Testing

No unit-test framework. Verification:
- `npm run build` clean (the CSS is not built, but confirm nothing broke).
- Manual on Obsidian mobile (or a narrow window): open the template viewer; the modal is ~95vw, the template content area is ~50vh tall, a portion of the template is visible, and it scrolls. Desktop unchanged.
