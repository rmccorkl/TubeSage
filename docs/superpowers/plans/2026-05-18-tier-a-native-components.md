# Tier A Native-Component Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-rolled UI primitives in TubeSage's modals and settings tab with native Obsidian components (`setIcon`, `ExtraButtonComponent`, `ButtonComponent`, `TextComponent`, `DropdownComponent`) with no intended change to look and feel.

**Architecture:** Four independent tasks in `main.ts`: the standalone info icon, the three icon buttons, the six text buttons, and the create-note modal's inputs. Each converts hand-built markup to a native component while preserving every existing behavior (click handlers, tooltips, placeholders, validation) and keeping bespoke CSS classes where they carry look-and-feel.

**Tech Stack:** TypeScript, Obsidian Plugin API, esbuild. Verification is `npm run build` and `npm run lint`; there is no unit-test framework, so build, lint, and `grep` are the tests. The 1.3.3 release is the visual reference — no visible change is the acceptance bar.

**Design reference:** `docs/superpowers/specs/2026-05-18-tier-a-native-components-design.md`

**General rule for every task:** preserve behavior exactly. Do not change click handlers, tooltip text, copy, settings keys, or layout. When a native component replaces a raw element that carried a bespoke CSS class, re-apply that class to the component's element (`.buttonEl` / `.extraSettingsEl` / `.inputEl` / `.selectEl`) so the look is unchanged, unless the task says the class is now dead.

---

### Task 1: Info icon via `setIcon`

**Files:**
- Modify: `main.ts` — `createInfoIcon` (~lines 4971-5018)

- [ ] **Step 1: Replace the hand-built info SVG with `setIcon`**

In `createInfoIcon`, the body builds an info SVG with `createElementNS` (the `infoSvg`, `circle`, `line`, `dot` elements and the `infoSvgNamespace` constant, roughly lines 4979-5008). Replace that whole SVG-construction block with one call:

```ts
        setIcon(infoIcon, 'info');
```

`setIcon` is a global Obsidian function. Add `setIcon` to the `import { ... } from 'obsidian'` line at the top of `main.ts` if it is not already imported (it is used elsewhere in the file, so it likely already is — verify).

Keep the rest of `createInfoIcon` unchanged: the `infoIcon` span creation with class `tubesage-settings-info-icon` and the `aria-label`, the `setTooltip(infoIcon, tooltipText, ...)` call, and `return infoIcon`.

- [ ] **Step 2: Build and lint**

Run: `npm run build` — expect no TypeScript errors.
Run: `npm run lint` — expect 0 errors, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "refactor(ui): render settings info icon with native setIcon"
```

---

### Task 2: Icon buttons via `ExtraButtonComponent`

**Files:**
- Modify: `main.ts` — license-view button (~3792), README-view button (~3862), copy button (~6352)
- Modify: `styles.css` — `.tubesage-icon-button` / `.tubesage-icon-button-hover` if they become unused

Three buttons are raw `<button class="tubesage-icon-button">` elements with a hand-built SVG child, manual `mouseenter`/`mouseleave` hover-class handlers, and a click handler:
- the license-view eye button (~`main.ts:3792`) — opens `new LicenseModal(this.app)`
- the README-view eye button (~`main.ts:3862`) — opens `new READMEModal(this.app)`
- the copy button in `TemplateViewModal` (~`main.ts:6352`) — runs `handleCopy` (`navigator.clipboard.writeText`)

- [ ] **Step 1: Convert each icon button to `ExtraButtonComponent`**

For each of the three, replace the `createEl('button', ...)` + the `createElementNS` SVG block + the `mouseenter`/`mouseleave` handlers with:

```ts
new ExtraButtonComponent(container)
    .setIcon('eye')          // 'eye' for the two view buttons, 'copy' for the copy button
    .setTooltip('<existing tooltip text>')
    .onClick(() => { /* existing click handler body */ });
```

`ExtraButtonComponent` is already imported in `main.ts`. It renders an icon button with built-in hover styling and an accessible tooltip, so the hand-built SVG, the manual hover handlers, and (for the copy button) the separate tooltip wiring are all replaced. `container` is the element the old button was appended to (the existing `*ButtonContainer` / `copyContainer`).

Preserve exactly: the icon meaning (eye/eye/copy), the tooltip text each button currently has, and the click behavior. For the copy button, `handleCopy` and its `copyTextElement` success/error feedback stay; if `copyTextElement` was found via `copyContainer.querySelector('span')`, keep that lookup working (the "Copy template" label span still exists).

- [ ] **Step 2: Remove now-dead icon-button CSS**

After the conversion, run `grep -rn "tubesage-icon-button" main.ts`. If there are no remaining uses, delete the `.tubesage-icon-button` and `.tubesage-icon-button-hover` rules from `styles.css`. If any use remains, leave the rules.

- [ ] **Step 3: Build and lint**

Run: `npm run build` — expect no TypeScript errors.
Run: `npm run lint` — expect 0 errors, 0 warnings.
Run: `grep -rn "createElementNS" main.ts` — the eye and copy SVG blocks should be gone (only any unrelated SVG construction may remain).

- [ ] **Step 4: Commit**

```bash
git add main.ts styles.css
git commit -m "refactor(ui): convert icon buttons to ExtraButtonComponent"
```

---

### Task 3: Text buttons via `ButtonComponent`

**Files:**
- Modify: `main.ts` — Process button (~2925), three Close buttons (~5756, ~6089, ~6474), Open-settings button (~5854) and the LicenseRequiredModal Close button (~5860); the obsidian import (line 1)

Six raw text `<button>`s, each created with `createEl('button', { text, cls })` plus a click `addEventListener`:
- `YouTubeTranscriptModal` Process button (~2925) — carries `mod-cta`, conditionally `tubesage-process-btn-mobile`
- `LicenseModal` Close (~5756, class `tubesage-license-close-button`)
- `LicenseRequiredModal` Open-settings (~5854) and Close (~5860)
- `READMEModal` Close (~6089)
- `TemplateViewModal` Close (~6474)

- [ ] **Step 1: Add `ButtonComponent` to the obsidian import**

Add `ButtonComponent` to the `import { ... } from 'obsidian'` line at the top of `main.ts`.

- [ ] **Step 2: Convert each text button**

For each, replace `createEl('button', { text, cls })` + the click `addEventListener` with:

```ts
new ButtonComponent(container)
    .setButtonText('<existing text>')
    .onClick(() => { /* existing click handler body */ });
```

Then preserve look-and-feel:
- The **Process** button: instead of the `mod-cta` class, call `.setCta()` (the native equivalent). Keep the mobile branch — if the code adds `tubesage-process-btn-mobile` on mobile, add it to the component's `.buttonEl` instead (`processButton.buttonEl.addClass('tubesage-process-btn-mobile')`). Keep the existing process-click logic unchanged.
- The **Close / Open-settings** buttons each carry a bespoke class (`tubesage-license-close-button`, `tubesage-license-required-button-primary`, `tubesage-license-required-button-secondary`, `tubesage-readme-close-button`, and the TemplateViewModal close's class). Re-apply that same class to the component's `.buttonEl` (`btn.buttonEl.addClass('<class>')`) so the styling is identical. Do not remove these CSS rules — they still carry the look.

Preserve every click handler body exactly (`this.close()`, the open-settings `app.setting.open('tubesage')` logic, the Process flow).

- [ ] **Step 3: Build and lint**

Run: `npm run build` — expect no TypeScript errors.
Run: `npm run lint` — expect 0 errors, 0 warnings.
Run: `grep -rn "createEl('button'" main.ts` — expect no matches (all nine buttons across Tasks 2 and 3 are now components).

- [ ] **Step 4: Commit**

```bash
git add main.ts
git commit -m "refactor(ui): convert text buttons to ButtonComponent"
```

---

### Task 4: Create-note modal inputs via `TextComponent` / `DropdownComponent`

**Files:**
- Modify: `main.ts` — `YouTubeTranscriptModal.buildInputStage()` (~lines 2835-3015)

The modal builds raw inputs: a URL `<input type=text>`, a title `<input type=text>`, and a video-count `<select>`. The class keeps element references `this.urlInputEl` and `this.titleInputEl`.

- [ ] **Step 1: Convert the URL and title inputs to `TextComponent`**

Replace each raw `createEl('input', { type: 'text', ... })` with a `TextComponent`:

```ts
const urlText = new TextComponent(urlGroup);
urlText.setPlaceholder(YOUTUBE_URL_PLACEHOLDER);
this.urlInputEl = urlText.inputEl;
```

`TextComponent` is already imported. Repoint the class fields `this.urlInputEl` and `this.titleInputEl` to the component's `.inputEl`, so all existing code that uses those references (focus calls, `.value` reads, the `input` event listener for URL validation, the `keydown`/Enter handling) keeps working unchanged. Keep the placeholders identical (URL: `YOUTUBE_URL_PLACEHOLDER`; title: its current placeholder). Keep the `form-group` / `label` layout containers as they are.

- [ ] **Step 2: Convert the video-count `<select>` to `DropdownComponent`**

Replace the raw `createEl('select', ...)` plus its `for` loop of `createEl('option', ...)` with:

```ts
const videoCountDropdown = new DropdownComponent(limitedOptionContainer);
for (let i = 1; i <= 50; i++) {
    videoCountDropdown.addOption(String(i), String(i));
}
videoCountDropdown.setValue('1');
```

`DropdownComponent` is already imported. Where the old code read `videoCountDropdown.value`, read `videoCountDropdown.getValue()` instead. The "Process" click handler reads this value to decide the video count — update that read accordingly. Keep the `video-count-dropdown` class on the component's `.selectEl` if it carries sizing (`videoCountDropdown.selectEl.addClass('video-count-dropdown')`).

- [ ] **Step 3: Leave the radio buttons unchanged**

The "All videos" / "Limited number" radio `<input type=radio>` elements stay as raw inputs — Obsidian has no native radio component. Do not change them.

- [ ] **Step 4: Build and lint**

Run: `npm run build` — expect no TypeScript errors.
Run: `npm run lint` — expect 0 errors, 0 warnings.
Run: `grep -rn "createEl('input'\|createEl('select'" main.ts` — the only remaining `createEl('input'` matches should be the radio buttons; no `createEl('select'` should remain.

- [ ] **Step 5: Commit**

```bash
git add main.ts
git commit -m "refactor(ui): convert create-note modal inputs to native components"
```

---

## Final verification

- [ ] `npm run build` is green.
- [ ] `npm run lint` reports 0 errors and 0 warnings.
- [ ] `grep -rn "createEl('button'" main.ts` returns nothing.
- [ ] `grep -rn "createEl('select'" main.ts` returns nothing; `createEl('input'` returns only the radio buttons.
- [ ] The hand-built eye/info/copy SVG blocks are gone (`grep -rn "createElementNS" main.ts` shows only any unrelated remaining SVG, if any).
- [ ] Manual audition against the 1.3.3 release in a dev vault: the create-note modal (URL field, title field, video-count dropdown, Process button), the settings info icons, the license/README eye buttons, the copy button, and every Close / Open-settings button look and behave the same as 1.3.3. Note any pixel drift for a follow-up CSS tweak.
