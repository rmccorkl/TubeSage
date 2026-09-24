import type { ProgressNoticeFactory, ProgressNoticeHandle } from "./job-progress-notice";

// WHERE A RUNNING JOB IS REPORTED, decided once.
//
// Desktop and mobile want different things, and #7/#9 got this wrong by
// replacing BOTH when only mobile needed changing: the desktop lost the
// status-bar spinner it had and gained a popup it never asked for. The original
// `ProcessingSpinner` already branched on `Platform.isMobile`; that decision
// comes back here, as ONE branch, rather than being scattered through the
// notice code.
//
//   desktop -> a status-bar item. No popup, no floating notice.
//   mobile  -> a floating notice (Obsidian has no status bar there), whose
//              whole surface is the cancel control.
//
// Obsidian-free by construction: both surfaces arrive as injected factories,
// which is also what makes the choice testable without a plugin instance.

/** The desktop spinner, reduced to what this module needs of it. */
export interface StatusBarHandle {
  setLabel(label: string): void;
  stop(): void;
}

export interface ProgressSurfaceDeps {
  /** `Platform.isMobile`, read once by the host. */
  isMobile: boolean;
  createNotice(message: string): ProgressNoticeHandle;
  createStatusBar(message: string): StatusBarHandle;
}

/**
 * The factory `JobProgressNotices` and `CollectionNotices` build their surface
 * with. The desktop handle reports NO element, which is what stops the notice
 * contents (pulse, stage, tap-to-cancel) being rendered into a status bar that
 * has nothing to tap — the same absence those classes already fall back on.
 */
export function createProgressSurface(deps: ProgressSurfaceDeps): ProgressNoticeFactory {
  if (deps.isMobile) {
    return (message: string) => deps.createNotice(message);
  }
  return (message: string): ProgressNoticeHandle => {
    const bar = deps.createStatusBar(message);
    return {
      setMessage: (text: string) => { bar.setLabel(text); },
      hide: () => { bar.stop(); },
    };
  };
}
