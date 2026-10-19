import { describe, expect, it } from "vitest";
import type { JobEvent } from "../jobs/job-runner";
import { DEBUG_CALLOUT_TITLE, DebugNotes, outcomeText } from "./debug-note";
import type { DebugNoteJob } from "./debug-note";

// The decision itself, against a vault double: what lands where, for every
// outcome, with the setting on and off. The real runner, adapters and logger
// drive it in end-to-end.test.ts.

type Outcome = Extract<JobEvent, { type: "done" | "failed" | "interrupted" | "cancelled" }>;

class FakeVault {
  readonly files = new Map<string, string>();
  readonly folders: string[] = [];

  getFile(path: string): { path: string } | null {
    return this.files.has(path) ? { path } : null;
  }

  create(path: string, content: string): Promise<unknown> {
    if (this.files.has(path)) {
      return Promise.reject(new Error("File already exists."));
    }
    this.files.set(path, content);
    return Promise.resolve({ path });
  }

  process(file: { path: string }, fn: (data: string) => string): Promise<string> {
    const next = fn(this.files.get(file.path) ?? "");
    this.files.set(file.path, next);
    return Promise.resolve(next);
  }
}

function setup(options: { enabled?: boolean } = {}) {
  const vault = new FakeVault();
  const jobs = new Map<string, DebugNoteJob>();
  const lines: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const state = { enabled: options.enabled ?? true };
  const notes = new DebugNotes<{ path: string }>({
    enabled: () => state.enabled,
    logsSince: (mark) => lines.slice(mark).map((line) => `> ${line}`).join("\n"),
    secrets: () => [],
    job: (id) => jobs.get(id),
    vault,
    ensureFolder: (folder) => {
      vault.folders.push(folder);
      return Promise.resolve();
    },
    normalizePath: (path) => path,
    notify: (message) => notices.push(message),
    logError: (message) => errors.push(message),
  });
  // Mirrors main.ts onJobEvent: the mark is taken first, then the host logs
  // the event, then the event is handed over.
  const emit = (event: JobEvent): Promise<void> => {
    const mark = lines.length;
    lines.push(`[jobs] ${event.id} ${event.type}`);
    return notes.handle(event, mark);
  };
  return { vault, jobs, lines, notices, errors, state, emit };
}

const NOTE = "Inbox/2026-10-19 Video.md";
const DONE: Outcome = { type: "done", id: "j1", notePath: NOTE };
const FAILED: Outcome = { type: "failed", id: "j1", error: "no captions" };
const INTERRUPTED: Outcome = { type: "interrupted", id: "j1", error: "connect ECONNREFUSED 127.0.0.1:1234" };
const CANCELLED: Outcome = { type: "cancelled", id: "j1" };

describe("debug logging on: every outcome leaves its logs in a note (#32)", () => {
  it("a done job's own note ends with the collapsed callout carrying the job's lines", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox", notePath: NOTE });
    s.vault.files.set(NOTE, "RENDERED");
    await s.emit({ type: "progress", id: "j1", stage: "transcript", message: "Fetching transcript" });
    s.lines.push("summary request sent");
    await s.emit(DONE);
    const text = s.vault.files.get(NOTE) ?? "";
    expect(text.startsWith("RENDERED\n\n> [!info]- Debug Information (hidden)\n> ```\n")).toBe(true);
    expect(text).toContain("> [jobs] j1 progress");
    expect(text).toContain("> summary request sent");
    expect(text).toContain("> [jobs] j1 done");
    expect(text.endsWith("\n> ```")).toBe(true);
    // Appended to the note it has, so nothing else is written and nothing announced.
    expect([...s.vault.files.keys()]).toEqual([NOTE]);
    expect(s.notices).toEqual([]);
  });

  it("an interrupted job with no note gets a debug note carrying the error, the URL and the callout", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox" });
    await s.emit({ type: "progress", id: "j1", stage: "summary", message: "Summarizing transcript" });
    await s.emit(INTERRUPTED);
    const text = s.vault.files.get("Inbox/Video.md") ?? "";
    expect(text).toContain("# Video");
    expect(text).toContain("> [!error] Processing was interrupted: connect ECONNREFUSED 127.0.0.1:1234");
    expect(text).toContain("**URL:** https://youtu.be/v1");
    expect(text).toContain(DEBUG_CALLOUT_TITLE);
    expect(text).toContain("> [jobs] j1 interrupted");
    expect(s.vault.folders).toEqual(["Inbox"]);
    expect(s.notices).toEqual(["Error note created with debug information: Video.md"]);
  });

  it("a job interrupted AFTER its note exists gets the callout on that note, not a second note", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox", notePath: NOTE });
    s.vault.files.set(NOTE, "RENDERED");
    await s.emit({ type: "note-created", id: "j1", notePath: NOTE });
    await s.emit(INTERRUPTED);
    expect([...s.vault.files.keys()]).toEqual([NOTE]);
    const text = s.vault.files.get(NOTE) ?? "";
    expect(text.startsWith(`RENDERED\n\n${DEBUG_CALLOUT_TITLE}`)).toBe(true);
    expect(text).toContain("> [jobs] j1 interrupted");
    expect(s.notices).toEqual([]);
  });

  it.each([
    ["failed", FAILED, "> [!error] Error: no captions"],
    ["cancelled", CANCELLED, "> [!error] Processing cancelled"],
  ])("a %s job with no note gets a debug note saying so", async (_name, event, line) => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "" });
    await s.emit(event);
    const text = s.vault.files.get("Video.md") ?? "";
    expect(text).toContain(line);
    expect(text).toContain(DEBUG_CALLOUT_TITLE);
    expect(s.vault.folders).toEqual([]);
  });

  it("the same video failing twice writes two notes on free paths instead of throwing \"File already exists.\" (#31)", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Failed Youtube transcript", url: "https://youtu.be/v1", folder: "Inbox" });
    s.jobs.set("j2", { title: "Failed Youtube transcript", url: "https://youtu.be/v1", folder: "Inbox" });
    await s.emit(INTERRUPTED);
    await s.emit({ type: "interrupted", id: "j2", error: "socket hang up" });
    // sanitizeFilename's hyphens, as the error note has always had them.
    expect([...s.vault.files.keys()]).toEqual([
      "Inbox/Failed-Youtube-transcript.md",
      "Inbox/Failed-Youtube-transcript 1.md",
    ]);
    expect(s.vault.files.get("Inbox/Failed-Youtube-transcript 1.md")).toContain("socket hang up");
    expect(s.errors).toEqual([]);
    expect(s.notices).toEqual([
      "Error note created with debug information: Failed-Youtube-transcript.md",
      "Error note created with debug information: Failed-Youtube-transcript 1.md",
    ]);
  });

  it("a debug note that cannot be written says so, with the original error", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "" });
    s.vault.create = () => Promise.reject(new Error("disk full"));
    await s.emit(INTERRUPTED);
    expect(s.errors).toEqual(["Failed to create error note:"]);
    expect(s.notices).toEqual(["Error: connect ECONNREFUSED 127.0.0.1:1234 (Also failed to create debug note)"]);
  });
});

describe("debug logging off: no callout and no debug note, whatever the outcome", () => {
  it.each([
    ["done", DONE],
    ["failed", FAILED],
    ["interrupted", INTERRUPTED],
    ["cancelled", CANCELLED],
  ])("%s, with a note and without one", async (_name, event) => {
    const withNote = setup({ enabled: false });
    withNote.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox", notePath: NOTE });
    withNote.vault.files.set(NOTE, "RENDERED");
    await withNote.emit({ type: "progress", id: "j1", stage: "transcript", message: "Fetching transcript" });
    await withNote.emit(event);
    expect([...withNote.vault.files.entries()]).toEqual([[NOTE, "RENDERED"]]);

    const withoutNote = setup({ enabled: false });
    withoutNote.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox" });
    await withoutNote.emit(event);
    expect(withoutNote.vault.files.size).toBe(0);
    expect(withoutNote.notices).toEqual([]);
  });
});

describe("the callout carries the job's own lines", () => {
  it("a second job's note does not carry the first job's lines", async () => {
    const s = setup();
    s.jobs.set("a", { title: "A", url: "https://youtu.be/a", folder: "", notePath: "A.md" });
    s.jobs.set("b", { title: "B", url: "https://youtu.be/b", folder: "", notePath: "B.md" });
    s.vault.files.set("A.md", "A");
    s.vault.files.set("B.md", "B");
    await s.emit({ type: "progress", id: "a", stage: "transcript", message: "Fetching transcript" });
    s.lines.push("line from job A");
    await s.emit({ type: "done", id: "a", notePath: "A.md" });
    await s.emit({ type: "progress", id: "b", stage: "transcript", message: "Fetching transcript" });
    s.lines.push("line from job B");
    await s.emit({ type: "done", id: "b", notePath: "B.md" });
    expect(s.vault.files.get("A.md")).toContain("line from job A");
    expect(s.vault.files.get("B.md")).toContain("line from job B");
    expect(s.vault.files.get("B.md")).not.toContain("line from job A");
    expect(s.vault.files.get("B.md")).not.toContain("[jobs] a ");
  });

  it("a job that ends on its first event carries that event's lines and nothing logged before it", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "" });
    s.lines.push("an earlier job's line");
    await s.emit(CANCELLED);
    const text = s.vault.files.get("Video.md") ?? "";
    expect(text).toContain("> [jobs] j1 cancelled");
    expect(text).not.toContain("an earlier job's line");
  });

  it("run-ended after the outcome writes nothing more", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox", notePath: NOTE });
    s.vault.files.set(NOTE, "RENDERED");
    await s.emit(DONE);
    const once = s.vault.files.get(NOTE);
    await s.emit({ type: "run-ended", id: "j1" });
    expect(s.vault.files.get(NOTE)).toBe(once);
  });
});

describe("the callout's fence", () => {
  it("holds a logged code block: a triple-backtick run stays inside one unbroken fence", async () => {
    const s = setup();
    s.jobs.set("j1", { title: "Video", url: "https://youtu.be/v1", folder: "Inbox", notePath: NOTE });
    s.vault.files.set(NOTE, "RENDERED");
    await s.emit({ type: "progress", id: "j1", stage: "summary", message: "Summarizing transcript" });
    s.lines.push("Anthropic response text (40 chars): ```ts", "const x = 1;", "```");
    await s.emit(DONE);
    const text = s.vault.files.get(NOTE) ?? "";
    expect(text.split("\n").filter((line) => line.startsWith("> ```"))).toEqual(["> ````", "> ```", "> ````"]);
    expect(text.endsWith("\n> ````")).toBe(true);
  });
});

describe("outcomeText: the notice and the debug note say the same thing", () => {
  it("an interrupted job's notice carries its reason (#31)", () => {
    expect(outcomeText(INTERRUPTED)).toBe("Processing was interrupted: connect ECONNREFUSED 127.0.0.1:1234");
  });

  it("failed and cancelled read as they always have", () => {
    expect(outcomeText(FAILED)).toBe("Error: no captions");
    expect(outcomeText(CANCELLED)).toBe("Processing cancelled");
  });
});
