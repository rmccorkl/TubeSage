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
 * Lifecycle: `start()` mounts and animates; `stop()` removes the spinner
 * and clears the interval. Safe to call `stop()` more than once.
 */
export class ProcessingSpinner {
  private statusBarItem: HTMLElement | null = null;
  private modalSpinnerEl: HTMLElement | null = null;
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
    this.spinnerHandle = window.setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
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
    if (this.modalSpinnerEl) {
      this.modalSpinnerEl.remove();
      this.modalSpinnerEl = null;
    }
  }

  private render(): void {
    const spinner = SPINNER_FRAMES[this.spinnerFrame];
    const text = `${spinner} ${this.prefix} · ${this.currentLabel}`;
    if (this.statusBarItem) this.statusBarItem.setText(text);
    if (this.modalSpinnerEl) this.modalSpinnerEl.setText(text);
  }
}
