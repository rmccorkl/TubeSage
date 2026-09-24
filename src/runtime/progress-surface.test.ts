import { describe, expect, it, vi } from "vitest";
import { createProgressSurface } from "./progress-surface";
import { JobProgressNotices } from "./job-progress-notice";
import type { JobEvent } from "../jobs/job-runner";

const deps = (isMobile: boolean) => {
  const notices: string[] = [];
  const statusBars: string[] = [];
  const hidden: string[] = [];
  const stopped: string[] = [];
  return {
    isMobile,
    notices, statusBars, hidden, stopped,
    createNotice: vi.fn((message: string) => {
      notices.push(message);
      return { setMessage: (m: string) => { notices.push(m); }, hide: () => { hidden.push(message); }, element: undefined };
    }),
    createStatusBar: vi.fn((message: string) => {
      statusBars.push(message);
      return { setLabel: (m: string) => { statusBars.push(m); }, stop: () => { stopped.push(message); } };
    }),
  };
};

describe("createProgressSurface — ONE platform decision, not branches everywhere", () => {
  it("uses the status bar on desktop and never opens a notice", () => {
    // The regression this locks: #7/#9 replaced BOTH surfaces when only mobile
    // needed changing, so desktop lost its status-bar spinner and gained a
    // popup it never wanted.
    const d = deps(false);
    const surface = createProgressSurface(d);
    const handle = surface("Fetching transcript");
    handle.setMessage("Summarizing transcript");
    handle.hide();
    expect(d.statusBars).toEqual(["Fetching transcript", "Summarizing transcript"]);
    expect(d.createNotice).not.toHaveBeenCalled();
    expect(d.stopped).toHaveLength(1);
  });

  it("uses a floating notice on mobile and never touches the status bar", () => {
    // Obsidian has no status bar on mobile, which is why the original spinner
    // branched here too.
    const d = deps(true);
    const surface = createProgressSurface(d);
    const handle = surface("Fetching transcript");
    handle.setMessage("Summarizing transcript");
    handle.hide();
    expect(d.notices).toEqual(["Fetching transcript", "Summarizing transcript"]);
    expect(d.createStatusBar).not.toHaveBeenCalled();
    expect(d.hidden).toHaveLength(1);
  });

  it("exposes an element only on the surface that can carry a tap target", () => {
    // Desktop's status bar has nothing to tap, so it reports no element and the
    // notice contents are never rendered into it.
    expect(createProgressSurface(deps(false))("x").element).toBeUndefined();
  });
});

describe("terminal events clear whichever surface is in use", () => {
  const progress = (id: string): JobEvent => ({ type: "progress", id, stage: "transcript", message: "" });

  it("stops the desktop status-bar spinner on a terminal event, with no leak across jobs", () => {
    const d = deps(false);
    const notices = new JobProgressNotices(createProgressSurface(d), () => {});
    notices.handle(progress("a"));
    notices.handle(progress("b"));
    expect(notices.activeCount()).toBe(2);
    notices.handle({ type: "done", id: "a", notePath: "n.md" });
    expect(d.stopped).toHaveLength(1);
    expect(notices.activeCount()).toBe(1);
    notices.handle({ type: "cancelled", id: "b" });
    expect(d.stopped).toHaveLength(2);
    expect(notices.activeCount()).toBe(0);
    // Never a notice on desktop, on any path.
    expect(d.createNotice).not.toHaveBeenCalled();
  });

  it("hides the mobile notice on a terminal event, with no leak across jobs", () => {
    const d = deps(true);
    const notices = new JobProgressNotices(createProgressSurface(d), () => {});
    notices.handle(progress("a"));
    notices.handle(progress("b"));
    notices.handle({ type: "failed", id: "a", error: "boom" });
    expect(d.hidden).toHaveLength(1);
    expect(notices.activeCount()).toBe(1);
    notices.dismissAll();
    expect(notices.activeCount()).toBe(0);
    expect(d.createStatusBar).not.toHaveBeenCalled();
  });
});
