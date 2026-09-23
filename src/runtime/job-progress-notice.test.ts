import { afterEach, describe, expect, it } from "vitest";
import { setLanguageResolver } from "../i18n";
import type { JobStage } from "../jobs/job-record";
import type { JobEvent } from "../jobs/job-runner";
import { JobProgressNotices, progressNoticeText } from "./job-progress-notice";
import type { ProgressNoticeHandle } from "./job-progress-notice";

/**
 * Notice double. The failure mode this whole suite is aimed at is a notice
 * being RE-CREATED per progress event instead of updated in place, so the
 * double records construction and every setMessage separately.
 */
class NoticeDouble implements ProgressNoticeHandle {
  readonly messages: string[] = [];
  updates = 0;
  hidden = 0;

  constructor(initial: string) {
    this.messages.push(initial);
  }

  setMessage(message: string): this {
    this.updates += 1;
    this.messages.push(message);
    return this;
  }

  hide(): void {
    this.hidden += 1;
  }
}

function spyFactory() {
  const created: NoticeDouble[] = [];
  const create = (message: string): ProgressNoticeHandle => {
    const notice = new NoticeDouble(message);
    created.push(notice);
    return notice;
  };
  return { created, create };
}

const progress = (id: string, stage: JobStage): JobEvent => ({
  type: "progress",
  id,
  stage,
  // The runner's own English text. Nothing may render it: the notice shows a
  // translated label derived from `stage` instead.
  message: "Fetching transcript",
});

afterEach(() => {
  setLanguageResolver(null);
});

describe("progressNoticeText", () => {
  it("names every stage the runner can emit a progress event for", () => {
    // Two emission sites in job-runner.ts: the four PROGRESS_MESSAGES stages
    // (line 1130) and "note-creating" (line 961).
    expect(progressNoticeText("transcript")).toContain("Fetching transcript");
    expect(progressNoticeText("summary")).toContain("Summarizing transcript");
    expect(progressNoticeText("note-creating")).toContain("Creating note");
    expect(progressNoticeText("timestamps")).toContain("Adding timestamps");
    expect(progressNoticeText("translation")).toContain("Translating note");
  });

  it("falls back to a generic label for a stage that never emits progress", () => {
    expect(progressNoticeText("done")).toContain("Processing video");
    expect(progressNoticeText("note-created")).not.toBe("");
  });

  it("says where to cancel, in one short clause", () => {
    const text = progressNoticeText("transcript");
    expect(text).toContain("Show active jobs");
    expect(text.length).toBeLessThan(80);
  });

  it("is translated, never the runner's English message verbatim", () => {
    setLanguageResolver(() => "de");
    const text = progressNoticeText("transcript");
    expect(text).not.toContain("Fetching transcript");
    expect(text).toContain("Transkript");
    // The command name stays English on purpose: the command itself is not
    // translated, so a translated label could not be found in the palette.
    expect(text).toContain("Show active jobs");
  });
});

describe("JobProgressNotices", () => {
  it("drives ONE notice per job, updated in place by setMessage", () => {
    const { created, create } = spyFactory();
    const notices = new JobProgressNotices(create);

    notices.handle(progress("job-1", "transcript"));
    notices.handle(progress("job-1", "summary"));
    notices.handle(progress("job-1", "timestamps"));

    expect(created).toHaveLength(1);
    expect(created[0].updates).toBe(2);
    expect(created[0].messages).toEqual([
      progressNoticeText("transcript"),
      progressNoticeText("summary"),
      progressNoticeText("timestamps"),
    ]);
  });

  it("keeps two concurrent jobs on two notices with no cross-talk", () => {
    const { created, create } = spyFactory();
    const notices = new JobProgressNotices(create);

    notices.handle(progress("job-1", "transcript"));
    notices.handle(progress("job-2", "transcript"));
    notices.handle(progress("job-2", "summary"));

    expect(created).toHaveLength(2);
    expect(created[0].messages).toEqual([progressNoticeText("transcript")]);
    expect(created[1].messages).toEqual([progressNoticeText("transcript"), progressNoticeText("summary")]);
    expect(notices.activeCount()).toBe(2);

    notices.handle({ type: "cancelled", id: "job-2" });
    expect(created[1].hidden).toBe(1);
    expect(created[0].hidden).toBe(0);
    expect(notices.activeCount()).toBe(1);
  });

  const terminals: JobEvent[] = [
    { type: "done", id: "job-1", notePath: "Notes/a.md" },
    { type: "failed", id: "job-1", error: "boom" },
    { type: "cancelled", id: "job-1" },
    { type: "interrupted", id: "job-1", prompt: { action: "nothing", why: "live" } },
  ];

  for (const terminal of terminals) {
    it(`hides the notice and forgets the job on ${terminal.type}`, () => {
      const { created, create } = spyFactory();
      const notices = new JobProgressNotices(create);

      notices.handle(progress("job-1", "transcript"));
      notices.handle(terminal);

      expect(created[0].hidden).toBe(1);
      expect(notices.activeCount()).toBe(0);
      // No second surface: a terminal event never creates a notice of its own.
      // The completion Notice and the note opening stay where they are, in
      // the plugin's own event policy.
      expect(created).toHaveLength(1);
    });
  }

  it("creates nothing for a job that reaches a terminal event without progress", () => {
    const { created, create } = spyFactory();
    const notices = new JobProgressNotices(create);

    notices.handle({ type: "failed", id: "job-1", error: "boom" });

    expect(created).toHaveLength(0);
    expect(notices.activeCount()).toBe(0);
  });

  it("leaks nothing across sequential jobs", () => {
    const { created, create } = spyFactory();
    const notices = new JobProgressNotices(create);

    for (const id of ["job-1", "job-2", "job-3"]) {
      notices.handle(progress(id, "transcript"));
      expect(notices.activeCount()).toBe(1);
      notices.handle({ type: "done", id, notePath: `Notes/${id}.md` });
      expect(notices.activeCount()).toBe(0);
    }

    expect(created).toHaveLength(3);
    expect(created.every((notice) => notice.hidden === 1)).toBe(true);
  });

  it("ignores a terminal event for a job it never saw", () => {
    const { created, create } = spyFactory();
    const notices = new JobProgressNotices(create);

    notices.handle(progress("job-1", "transcript"));
    notices.handle({ type: "done", id: "job-other", notePath: "Notes/other.md" });

    expect(created[0].hidden).toBe(0);
    expect(notices.activeCount()).toBe(1);
  });

  it("hides every live notice on unload", () => {
    const { created, create } = spyFactory();
    const notices = new JobProgressNotices(create);

    notices.handle(progress("job-1", "transcript"));
    notices.handle(progress("job-2", "summary"));
    notices.dismissAll();

    expect(created.map((notice) => notice.hidden)).toEqual([1, 1]);
    expect(notices.activeCount()).toBe(0);
    // Idempotent: a second unload pass must not hide a notice twice.
    notices.dismissAll();
    expect(created.map((notice) => notice.hidden)).toEqual([1, 1]);
  });
});
