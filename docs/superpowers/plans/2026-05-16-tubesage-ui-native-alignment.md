# TubeSage UI Native Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the TubeSage plugin UI so it reads as a native Obsidian surface: replace hand-rolled controls with Obsidian's component primitives, kill theme-breaking hardcoded values, and put spacing on Obsidian's variable scale.

**Architecture:** Three sequential tasks ordered so component replacement happens before the CSS sweep (replacing custom controls deletes CSS, so the final CSS pass runs on what survives). Surfaces: the create-note `Modal`, the `PluginSettingTab`, then a whole-file `styles.css` design-system pass. No behavior changes; only presentation and the markup that produces it.

**Tech Stack:** TypeScript, Obsidian Plugin API (`Setting`, `ToggleComponent`, `mod-cta`), esbuild. Verification is `npm run build` (tsc strict + esbuild bundle). There is no UI test framework; each task ends with a build and a manual checklist.

**Design rules (apply in every task):**
- Never hardcode a color. Obsidian theme variables only: `--text-accent`, `--text-normal`, `--text-muted`, `--text-on-accent`, `--background-*`, `--interactive-accent`.
- Never `#fff` / `#000` / `white` / `black`. Toggle knobs and accents come from theme variables or native components.
- Spacing uses Obsidian's scale, not ad-hoc pixels: `--size-4-1` (4px), `--size-4-2` (8px), `--size-4-3` (12px), `--size-4-4` (16px), `--size-4-5` (20px), `--size-4-6` (24px). Map existing values to the nearest step (15px→`--size-4-4`, 10px→`--size-4-2` or `--size-4-3`, 5px→`--size-4-1`).
- Radius: `--radius-s` for inputs/buttons/small controls, `--radius-m` for panels/containers. Replace the ad-hoc `4px/5px/6px/8px` mix.
- Shadows: `--shadow-s` / `--shadow-l`. No hand-rolled `rgba()` box-shadows.
- No inline styles set via JS (`attr: { style: ... }`). The project CLAUDE.md bans this. Use a CSS class.
- Prefer Obsidian native components over custom CSS replicas. `Setting`, `ToggleComponent`, `ButtonComponent`, and the `mod-cta` class already match the theme in every Obsidian theme.
- Do not change any logic, settings keys, event behavior, or copy. Presentation only.

---

### Task 1: Modal native components

The create-note modal (`YouTubeTranscriptModal`, `main.ts:2767`) is a hand-built form. It ships a CSS-only toggle switch and a custom-styled process button that both duplicate Obsidian primitives, plus five inline-style strings that duplicate classes already in `styles.css`.

**Files:**
- Modify: `main.ts` — `YouTubeTranscriptModal.buildInputStage()` approx `main.ts:2835-3015`
- Modify: `styles.css` — toggle and process-button rules

- [ ] **Step 1: Replace the custom toggle switch with a native Obsidian toggle**

In `buildInputStage()` (`main.ts` ~2987-3014) the "Fast summary mode" control is built from `<label class="toggle-switch">` + hidden checkbox + `<span class="toggle-slider">`. Replace the `toggleSwitch`/`fastSummaryToggleEl`/`toggle-slider` markup with Obsidian's `ToggleComponent`:
- Add `ToggleComponent` to the `obsidian` import on `main.ts:1`.
- Build the toggle as `const fastToggle = new ToggleComponent(toggleContainer);` then `fastToggle.setValue(this.plugin.settings.useFastSummary);` and `fastToggle.onChange(value => { this.plugin.settings.useFastSummary = value; void this.plugin.saveSettings(); });`
- The class field `fastSummaryToggleEl: HTMLInputElement` (`main.ts:2774`) becomes unused inside the modal. Search the class for other reads of `fastSummaryToggleEl` first; if none remain, delete the field, otherwise replace those reads with `fastToggle.getValue()`. Keep `.toggle-container` / `.toggle-label` / `.summary-info` — they still lay out the row.

- [ ] **Step 2: Replace the custom process button with a native CTA button**

The process button (`main.ts:2955`) uses `cls: 'tubesage-process-btn'` and, on mobile, `tubesage-process-btn-mobile`. Obsidian's native primary-button class is `mod-cta`. Change the button creation to `cls: ['mod-cta']` (keep the mobile full-width class). Keep the existing `addEventListener('click', ...)` untouched.

- [ ] **Step 3: Remove the five inline-style duplications in the modal**

`main.ts` lines ~2876, ~2882, ~2905, ~2911, ~2952 each pass `attr: { style: ... }` while also attaching a class that already defines the same flex layout in `styles.css`. Delete the `attr: { style: ... }` from each `createDiv` call. The classes (`tubesage-modal-controls-container` + desktop/mobile variant, `tubesage-modal-radio-option`, `tubesage-modal-limited-option-container`, `tubesage-modal-process-btn-container`) already cover the layout. Verify each class's rules in `styles.css:717-778` actually match the inline string before deleting; if a property is missing from the class, add it to the class rather than keeping the inline style.

- [ ] **Step 4: Delete the now-dead CSS**

In `styles.css` remove the rules made dead by Steps 1-2: `.toggle-switch` (209-214), `.toggle-switch input` (216-220), `.toggle-slider` (222-232), `.toggle-slider:before` (234-244), `input:checked + .toggle-slider` (246-248), `input:checked + .toggle-slider:before` (250-252), `.tubesage-process-btn` (288-295). Keep `.tubesage-process-btn-mobile` (297-299) only if the mobile class is still attached in Step 2; otherwise remove it too. Keep `.toggle-container`, `.toggle-label`, `.summary-info`.

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: completes with no TypeScript errors and writes `main.js`.
Manual check: confirm no remaining references to `toggle-slider`, `toggle-switch`, or `tubesage-process-btn` (without `-mobile`) exist: `grep -n "toggle-slider\|toggle-switch\|tubesage-process-btn[^-]" main.ts styles.css` should return nothing.

- [ ] **Step 6: Commit**

```bash
git add main.ts styles.css
git commit -m "refactor(ui): use native Obsidian toggle and CTA button in create-note modal"
```

---

### Task 2: Settings tab native components

The settings tab (`YouTubeTranscriptSettingTab`, `main.ts:3759`) hand-rolls a second toggle switch (the license-acceptance toggle, `main.ts:3895-3951`) and uses two inline-style spacer divs.

**Files:**
- Modify: `main.ts` — `YouTubeTranscriptSettingTab.display()` approx `main.ts:3771-3951`
- Modify: `styles.css` — license-toggle rules, spacer

- [ ] **Step 1: Replace the custom license toggle with a native Obsidian toggle**

`main.ts:3895-3951` builds `tubesage-license-toggle-wrapper` + `tubesage-license-toggle-input` + `tubesage-license-toggle-slider` + `tubesage-license-toggle-knob`, with manual click handlers on the slider and the label span. Replace the whole block with an Obsidian `ToggleComponent`:
- `const licenseToggle = new ToggleComponent(toggleContainer);`
- `licenseToggle.setValue(this.plugin.settings.licenseAccepted);`
- `licenseToggle.onChange(value => { this.plugin.settings.licenseAccepted = value; void this.plugin.saveSettings().then(updateSettingsState); });`
- The native component is already clickable, so delete the manual `toggleSlider` click handler and the `licenseTextElement` click handler (`main.ts:3924-3951`).
- `updateSettingsState` (`main.ts:4015-4023`) and the `toggleInput.addEventListener('change', ...)` block (`main.ts:4029-4032`) are replaced by the `onChange` above. Make sure `updateSettingsState()` is still called once for the initial state (`main.ts:4026`).
- Keep the `Accept license & disclaimer` label span; it can stay as plain text next to the native toggle.

- [ ] **Step 2: Remove the inline-style spacer divs**

`main.ts:3796` and `main.ts:3804` create `<div style="height:10px">` spacers around the Buy Me a Coffee button. Delete both `createDiv({ attr: { style: 'height:10px;' } })` calls and instead give `.tubesage-settings-bmc-container` symmetric vertical margin in `styles.css` (`margin: var(--size-4-3) 0;`). Remove the existing `margin-bottom: 20px` from that rule so spacing is not doubled.

- [ ] **Step 3: Delete the now-dead CSS**

In `styles.css` remove the license-toggle rules made dead by Step 1: `.tubesage-license-toggle-wrapper` (369-374), `.tubesage-license-toggle-input` (376-380), `.tubesage-license-toggle-slider` (382-392), `.tubesage-license-toggle-knob` (394-404), and the two `:checked` rules (406-412).

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: completes with no TypeScript errors.
Manual check: `grep -n "license-toggle" main.ts styles.css` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add main.ts styles.css
git commit -m "refactor(ui): use native Obsidian toggle for license acceptance in settings"
```

---

### Task 3: styles.css design-system sweep

With both custom toggles gone, sweep what remains of `styles.css` (and the three remaining inline styles in `main.ts`) onto Obsidian's variable scale.

**Files:**
- Modify: `styles.css` — whole file
- Modify: `main.ts:6483`, `main.ts:6489`, `main.ts:6619` — remaining inline styles

- [ ] **Step 1: Fix the hardcoded heading color**

`styles.css:895` sets `color: #007acc` on `.setting-item-heading.tubesage-heading .setting-item-name`. Replace with `var(--text-accent)` so section headings follow the active theme. Leave the other heading properties (`font-size`, `font-weight`, layout) as is.

- [ ] **Step 2: Replace the hand-rolled shadow**

`styles.css:353` (`.tubesage-settings-info-icon-with-tooltip::after`) uses `box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2)`. Replace with `box-shadow: var(--shadow-s)`.

- [ ] **Step 3: Normalize border-radius**

Across `styles.css`, replace the ad-hoc radius mix with theme variables: `border-radius: 4px` and `5px` on inputs, buttons, and small controls become `var(--radius-s)`; `6px` and `8px` on panels and containers (`.tubesage-custom-model-params`, `.tubesage-license-required-steps-container`) become `var(--radius-m)`. Do not change `border-radius: 50%` (circular) or pill radii that belonged to controls deleted in Tasks 1-2 (those rules are already gone).

- [ ] **Step 4: Put spacing on the Obsidian scale**

Across `styles.css`, replace ad-hoc pixel padding/margin/gap with the `--size-4-*` scale per the design rules above (5px→`--size-4-1`, 8px→`--size-4-2`, 10px→`--size-4-2`, 12px→`--size-4-3`, 15px→`--size-4-4`, 20px→`--size-4-5`, 30px→`--size-4-8`). Where two adjacent values are within one step of each other and serve the same role, collapse them to one step so the rhythm is regular. Leave fixed structural dimensions alone (modal `width`, `max-height`, `.video-count-dropdown` `width: 60px`, image dimensions, the `1px` borders).

- [ ] **Step 5: Remove the three remaining inline styles in main.ts**

- `main.ts:6483`: a `height:1px` divider with `background` and `margin`. Replace the `attr: { style: ... }` with a class `tubesage-divider` and add to `styles.css`: `.tubesage-divider { height: 1px; background: var(--background-modifier-border); margin: var(--size-4-3) 0; }`.
- `main.ts:6489` and `main.ts:6619`: both `display:flex; justify-content:flex-end; width:100%`. Add one class `tubesage-row-end { display: flex; justify-content: flex-end; width: 100%; }` to `styles.css` and use it for both.

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: completes with no TypeScript errors.
Manual check: `grep -rn "attr: { style" main.ts` returns nothing (all inline styles removed across all three tasks). `grep -n "#007acc\|rgba(0, 0, 0\|: white\b" styles.css` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add main.ts styles.css
git commit -m "refactor(ui): align styles.css to Obsidian theme variables and spacing scale"
```

---

## Final verification

- [ ] `npm run build` is green.
- [ ] `grep -rn "attr: { style" main.ts` returns nothing.
- [ ] No `#hex` colors, `rgba()`, or literal `white`/`black` remain in `styles.css` (except inside the base64 image data, which is not CSS).
- [ ] Load the plugin in the dev vault, open the create-note modal and the settings tab, toggle both switches, confirm state persists and the disabled-settings overlay still works.
- [ ] Diff review: confirm no logic, settings keys, copy, or event behavior changed.
