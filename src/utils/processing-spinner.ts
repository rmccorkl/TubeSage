import type { Plugin } from "obsidian";

// Braille-dots spinner — ten frames, animates smoothly. Ticks every 100ms
// while a long-running operation is active so the user sees the plugin is
// alive even during a single long LLM call.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

/**
 * The desktop processing spinner: a status-bar item that animates while a job
 * runs, so the desktop needs no popup and no floating notice at all.
 *
 * RECOVERED from git (564f927) rather than rewritten, after #7/#9 replaced BOTH
 * surfaces when only mobile needed changing. The original was platform-aware —
 * status bar on desktop, a text element inside the processing modal on mobile.
 * The modal is gone, and mobile now uses a floating notice, so only the desktop
 * half is kept here; the platform choice itself lives in ONE place
 * (`createProgressSurface`), not in this class.
 *
 * Lifecycle: `start()` mounts and animates; `stop()` removes the item and
 * clears the interval. Safe to call `stop()` more than once.
 */
export class ProcessingSpinner {
  private statusBarItem: HTMLElement | null = null;
  private currentLabel: string;
  private spinnerFrame = 0;
  private spinnerHandle: number | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly prefix: string,
    initialLabel = "starting…",
  ) {
    this.currentLabel = initialLabel;
  }

  /** Mounts the status-bar item and starts animating. */
  start(): void {
    this.statusBarItem = this.plugin.addStatusBarItem();
    this.render();
    this.spinnerHandle = window.setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  /** Replaces the label after the prefix (e.g. from a job runner `progress` event) and redraws at once. */
  setLabel(label: string): void {
    this.currentLabel = label;
    this.render();
  }

  /** Removes the spinner and stops the animation. Safe to call more than once. */
  stop(): void {
    if (this.spinnerHandle !== null) {
      window.clearInterval(this.spinnerHandle);
      this.spinnerHandle = null;
    }
    if (this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
  }

  private render(): void {
    const spinner = SPINNER_FRAMES[this.spinnerFrame];
    const text = `${spinner} ${this.prefix} · ${this.currentLabel}`;
    if (this.statusBarItem) this.statusBarItem.setText(text);
  }
}
