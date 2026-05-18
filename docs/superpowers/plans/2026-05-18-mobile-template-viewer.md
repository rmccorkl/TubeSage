# Mobile Template-Viewer Height Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Obsidian mobile, make the example-template viewer modal large enough that a real portion of the template is visible and scrollable, instead of collapsing to a blank single line.

**Architecture:** CSS-only. Two rules are added to the existing `@media (max-width: 768px)` block in `styles.css`: a mobile size override for the template-viewer modal, and a definite height for its content container. No TypeScript change, no behavior change, desktop untouched.

**Tech Stack:** CSS, Obsidian theme variables. The plugin is bundled with esbuild; `styles.css` is shipped verbatim (not bundled), so no rebuild is strictly required for the CSS to take effect, but a build is run as a regression check.

---

## Background

`.tubesage-template-view-container` (`styles.css:648`) sets only `max-height` — 500px, narrowed to 250px when the modal also applies the `tubesage-template-view-container-short` modifier (`styles.css:661`). `max-height` only caps height; the box's rendered height is the content's intrinsic height. On desktop the content establishes a normal height so the box fills out. On mobile the box collapses to roughly one blank line, so the template appears missing.

Separately, `.tubesage-template-view-modal-size.modal` (`styles.css:638`) has no entry in the `@media (max-width: 768px)` block, unlike the license and readme modals which get explicit mobile size overrides there (`styles.css:943-948`).

The fix: add both rules inside the existing mobile media query, immediately after the `.tubesage-license-required-modal-size.modal` rule and before the closing `}` of the media block (currently `styles.css:955`).

## File Structure

- Modify: `styles.css` — add two CSS rules inside the existing `@media (max-width: 768px)` block. This is the only file changed.

---

### Task 1: Add mobile sizing for the template-viewer modal and container

**Files:**
- Modify: `styles.css:950-955` (insert new rules after the `.tubesage-license-required-modal-size.modal` block, before the media query's closing brace)

This project has no unit-test framework and CSS is not unit-testable. Verification is a clean build plus a manual visual check; there is no failing-test step.

- [ ] **Step 1: Add the two CSS rules**

In `styles.css`, find this block (it ends the `@media (max-width: 768px)` section):

```css
    .tubesage-license-required-modal-size.modal {
        width: 90vw;
        max-width: 90vw;
        max-height: 85vh;
    }
}
```

Replace it with:

```css
    .tubesage-license-required-modal-size.modal {
        width: 90vw;
        max-width: 90vw;
        max-height: 85vh;
    }

    /* Template viewer: give the modal a mobile size and the content a
       definite height so a usable portion of the template shows and scrolls
       (max-height alone lets the box collapse to a blank line on mobile). */
    .tubesage-template-view-modal-size.modal {
        width: 95vw;
        max-width: 95vw;
        max-height: 85vh;
    }

    .tubesage-template-view-container {
        height: 50vh;
        max-height: 50vh;
    }
}
```

Note: the `.tubesage-template-view-container` rule deliberately re-states `max-height` so it overrides both the desktop `max-height: 500px` (`styles.css:649`) and the `tubesage-template-view-container-short` modifier's `max-height: 250px` (`styles.css:662`). The `height: 50vh` forces a definite height; the existing `overflow-y: auto` and `-webkit-overflow-scrolling: touch` on the base rule make the rest scrollable.

- [ ] **Step 2: Verify the build is clean**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. (`styles.css` is not processed by esbuild; this confirms nothing else broke.)

- [ ] **Step 3: Verify lint is clean**

Run: `npm run lint`
Expected: `0 errors, 0 warnings`. (ESLint does not lint CSS here; this confirms the repo still settles clean.)

- [ ] **Step 4: Manual visual check (desktop + narrow window)**

In a dev vault with the plugin loaded, open the example-template viewer modal.
- Desktop / wide window: modal is unchanged (700px wide, content area caps at its existing height).
- Narrow the window below 768px (or use Obsidian mobile): the modal is ~95vw wide and the template content area is ~50vh tall, showing a real portion of the template with scrolling for the rest — not a blank line.

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "$(cat <<'EOF'
fix: enlarge mobile example-template viewer so content is visible

The template-viewer content box used only max-height, so on mobile it
collapsed to a blank single line. Add a mobile size override for the
modal and a definite height for the content container inside the
existing max-width:768px media query. Desktop is unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Spec "Change" item 1 (`.tubesage-template-view-modal-size.modal` → 95vw/95vw/85vh) → Task 1 Step 1. ✓
- Spec "Change" item 2 (`.tubesage-template-view-container` → height/max-height 50vh) → Task 1 Step 1. ✓
- Spec "CSS only, no TypeScript change, desktop untouched" → only `styles.css` is modified, new rules live inside the mobile media query. ✓
- Spec "Testing" (`npm run build` clean, manual mobile check) → Task 1 Steps 2 and 4. ✓
- No spec requirement is unaddressed.

**2. Placeholder scan:** No TBD/TODO/vague steps. Every code step shows the exact before/after CSS. ✓

**3. Type consistency:** No types or function signatures involved (CSS-only). Selector names (`.tubesage-template-view-modal-size.modal`, `.tubesage-template-view-container`) match the existing rules in `styles.css` exactly. ✓
