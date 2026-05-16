# Processing Spinner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TubeSage's in-modal CSS pulse-bar animation with a Braille-dots spinner — in the status bar on desktop (adapted from TubeSage-Wiki-Pro), in-modal on mobile (which has no status bar).

**Architecture:** A single platform-aware `ProcessingSpinner` class. `start()` mounts the spinner — a status-bar item on desktop, a text element inside the processing modal on mobile — and animates the same Braille frames via `setInterval`. The two existing pulse-bar call sites in `main.ts` switch to it; the pulse CSS is removed.

**Tech Stack:** TypeScript, esbuild, Obsidian plugin API (`addStatusBarItem`, `Platform`).

**Testing note:** No automated test harness exists (`npm test` is undefined). Verification is `npm run build` plus the manual checks in Task 4.

---

## File structure

| File | Change |
|---|---|
| `src/utils/processing-spinner.ts` | New — the `ProcessingSpinner` class |
| `main.ts` | Replace 2 pulse-bar blocks (~3137, ~3461) with `ProcessingSpinner`; stop it in a `finally` |
| `styles.css` | Remove `.pulse-container` / `.pulse-bar` / `@keyframes pulse` (lines ~261-293 and the `@media` variant ~1068-1084); add `.tubesage-spinner` |

---

## Task 1: Create the ProcessingSpinner class

**Files:**
- Create: `src/utils/processing-spinner.ts`

- [ ] **Step 1: Write the file**

Create `src/utils/processing-spinner.ts` with exactly:

```typescript
import { Plugin, Platform } from "obsidian";

// Braille-dots spinner — ten frames, animates smoothly. Ticks every 100ms
// while a long-running operation is active so the user sees the plugin is
// alive even during a single long LLM call.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

/**
 * Platform-aware processing spinner.
 *
 * Desktop: drives a status-bar item (Obsidian's bottom status bar).
 * Mobile: Obsidian has no status bar, so it renders a text element inside
 * the supplied modal content element instead. Same Braille frames either way.
 *
 * Lifecycle: `start()` mounts and animates; `setLabel(text)` updates the
 * per-step label and bumps the call counter; `stop()` removes the spinner
 * and clears the interval. Safe to call `stop()` more than once.
 */
export class ProcessingSpinner {
  private statusBarItem: HTMLElement | null = null;
  private modalSpinnerEl: HTMLElement | null = null;
  private callCount = 0;
  private currentLabel: string;
  private spinnerFrame = 0;
  private spinnerHandle: number | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly prefix: string,
    private readonly modalContentEl: HTMLElement,
    initialLabel = "starting…",
  ) {
    this.currentLabel = initialLabel;
  }

  /** Mounts the spinner (status bar on desktop, in-modal on mobile) and starts animating. */
  start(): void {
    if (Platform.isMobile) {
      this.modalSpinnerEl = this.modalContentEl.createDiv({ cls: "tubesage-spinner" });
    } else {
      this.statusBarItem = this.plugin.addStatusBarItem();
    }
    this.render();
    this.spinnerHandle = activeWindow.setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  /** Update the per-step label and bump the call counter. */
  setLabel(label: string): void {
    if (label) this.currentLabel = label;
    this.callCount += 1;
    this.render();
  }

  /** Removes the spinner and stops the animation. Safe to call more than once. */
  stop(): void {
    if (this.spinnerHandle !== null) {
      activeWindow.clearInterval(this.spinnerHandle);
      this.spinnerHandle = null;
    }
    if (this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
    if (this.modalSpinnerEl) {
      this.modalSpinnerEl.remove();
      this.modalSpinnerEl = null;
    }
  }

  private render(): void {
    const spinner = SPINNER_FRAMES[this.spinnerFrame];
    const text = `${spinner} ${this.prefix} · ${this.currentLabel} · #${this.callCount}`;
    if (this.statusBarItem) this.statusBarItem.setText(text);
    if (this.modalSpinnerEl) this.modalSpinnerEl.setText(text);
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds (file compiles; unused until Task 2).

- [ ] **Step 3: Commit**

```bash
git add src/utils/processing-spinner.ts
git commit -m "feat: add platform-aware ProcessingSpinner (Braille status-bar / in-modal)"
```

## Task 2: Wire ProcessingSpinner into the two processing flows

`main.ts` creates a `.pulse-container` with 5 `.pulse-bar` divs in two places:
`beginCollectionProcessing` (~line 3137) and the single-video processing flow
(~line 3461). Both run inside an `async` method with a `try { this.isProcessing = true; ... }`.

**Files:**
- Modify: `main.ts` — import (line 1 area), and the two blocks

- [ ] **Step 1: Add the import**

Near the other `src/utils` imports at the top of `main.ts`, add:

```typescript
import { ProcessingSpinner } from "./src/utils/processing-spinner";
```

(Match the existing relative-path style of neighboring `src/` imports in `main.ts`.)

- [ ] **Step 2: Replace the first pulse block (`beginCollectionProcessing`, ~3137-3145)**

Replace:

```typescript
            // Create a minimal container just for centering the pulse bars
            const pulseContainerEl = contentEl.createDiv({ 
                cls: 'pulse-container'
            });
            
            // Just create the pulse bars
            for (let i = 0; i < 5; i++) {
                pulseContainerEl.createDiv({ cls: 'pulse-bar' });
            }
```

with:

```typescript
            // Braille-dots processing spinner (status bar on desktop, in-modal on mobile)
            const spinner = new ProcessingSpinner(this.plugin, 'Processing collection', contentEl);
            spinner.start();
```

- [ ] **Step 3: Ensure the first spinner stops**

`beginCollectionProcessing` wraps its work in `try { ... }`. Find the matching
`catch`/end of that `try` block and ensure the method stops the spinner on every
exit path by adding a `finally` block (or extending the existing one) that calls:

```typescript
            } finally {
                spinner.stop();
            }
```

If a `finally` already exists, add `spinner.stop();` to it. The `spinner` const is
in scope for the whole `try` because it is declared at the top of the `try` body.

- [ ] **Step 4: Replace the second pulse block (single-video flow, ~3461-3469)**

Replace the identical block:

```typescript
            // Create a minimal container just for centering the pulse bars
            const pulseContainerEl = contentEl.createDiv({ 
                cls: 'pulse-container'
            });
            
            // Just create the pulse bars
            for (let i = 0; i < 5; i++) {
                pulseContainerEl.createDiv({ cls: 'pulse-bar' });
            }
```

with:

```typescript
            // Braille-dots processing spinner (status bar on desktop, in-modal on mobile)
            const spinner = new ProcessingSpinner(this.plugin, 'Processing video', contentEl);
            spinner.start();
```

- [ ] **Step 5: Ensure the second spinner stops**

As in Step 3, ensure the single-video flow's `try` block has a `finally` that calls
`spinner.stop();` on every exit path.

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: build succeeds; no `pulse-container` / `pulse-bar` references remain in `main.ts`
(`grep -c "pulse-" main.ts` returns 0).

- [ ] **Step 7: Commit**

```bash
git add main.ts
git commit -m "feat: use ProcessingSpinner in collection and single-video flows"
```

## Task 3: Remove pulse CSS, add the mobile spinner rule

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Delete the main pulse rules**

Remove this entire block (currently ~lines 261-293):

```css
.pulse-container {
    display: flex;
    justify-content: center;
    align-items: center;
    margin: 0 auto;
    height: 40px;
    border: none;
    background: none;
    box-shadow: none;
    width: fit-content;
    max-width: 100%;
}

.pulse-bar {
    width: 8px;
    height: 40px;
    margin: 0 3px;
    border-radius: 4px;
    background-color: var(--interactive-accent);
    animation: pulse 1.5s ease-in-out infinite;
    display: inline-block;
}

.pulse-bar:nth-child(1) { animation-delay: 0s;   }
.pulse-bar:nth-child(2) { animation-delay: 0.2s; }
.pulse-bar:nth-child(3) { animation-delay: 0.4s; }
.pulse-bar:nth-child(4) { animation-delay: 0.6s; }
.pulse-bar:nth-child(5) { animation-delay: 0.8s; }

@keyframes pulse {
    0%, 100% { height: 5px;  opacity: 0.3; }
    50%      { height: 40px; opacity: 1;   }
}
```

- [ ] **Step 2: Delete the `@media` pulse rules**

Inside the `@media (max-width: 768px)` block, remove the `.pulse-container`,
`.pulse-bar`, and `@keyframes pulse` rules (and their explanatory comments). Read
the file to find their exact current lines — leave the rest of the `@media` block intact.

- [ ] **Step 3: Add the mobile spinner rule**

Add this rule (place it where the `.pulse-container` block was):

```css
.tubesage-spinner {
    display: flex;
    justify-content: center;
    align-items: center;
    margin: 0 auto;
    min-height: 40px;
    font-family: var(--font-monospace);
    font-size: 14px;
    color: var(--text-normal);
    text-align: center;
}
```

- [ ] **Step 4: Verify**

Run: `grep -c "pulse" styles.css`
Expected: `0`.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "fix: remove pulse-bar CSS, add tubesage-spinner rule"
```

## Task 4: Manual verification

- [ ] **Step 1: Build** — `npm run build` succeeds.
- [ ] **Step 2: Desktop** — process a video in desktop Obsidian; confirm a Braille spinner
      animates in the status bar and disappears when processing ends.
- [ ] **Step 3: Mobile** — process a video in mobile Obsidian; confirm a Braille spinner
      animates inside the processing modal (no status bar there) and disappears when done.
- [ ] **Step 4: No leak** — after processing completes on desktop, confirm the status-bar
      item is gone (not left behind).

---

## Self-review

- **Spec coverage:** desktop status-bar spinner (Task 1 + 2), mobile in-modal spinner
  (Task 1 `Platform.isMobile` branch + Task 3 CSS), pulse removal (Task 3). Covered.
- **Placeholder scan:** Steps 3, 5, and Task 3 Step 2 reference "find the exact lines"
  rather than pre-quoting — this is deliberate: the surrounding `try`/`finally` and the
  `@media` block contents must be read live so the edit is correct against current code.
  Every code-producing step has complete code.
- **Type consistency:** `ProcessingSpinner` constructor `(plugin, prefix, modalContentEl, initialLabel?)`
  is used consistently in Task 2 with 3 args. `start()`/`stop()` names match between Tasks 1 and 2.
