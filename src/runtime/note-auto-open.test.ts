import { describe, expect, it } from "vitest";
import type { JobEvent } from "../jobs/job-runner";
import { NoteAutoOpen } from "./note-auto-open";
import type { AutoOpenConditions } from "./note-auto-open";

// WHEN A NEW NOTE IS SHOWN, decided here rather than in main.ts (#20).
//
// The behaviour being restored is the legacy one: the note appeared and took
// focus the moment it was CREATED, and the timestamps pass then rewrote it
// underneath. The job-runner migration (5fed8a7) left the only auto-open on
// `done`, so the note stayed hidden for the whole second LLM pass — minutes,
// since #13 stopped cutting that pass off — and never appeared at all when a
// job ended any other way.
//
// It lives in a class of its own because main.ts has no test harness and the
// failure this policy exists to avoid is invisible to inspection: `openNote`
// calls `getLeaf(true)`, which builds a NEW leaf every time, so opening at
// creation while leaving the `done` open in place gives one note two tabs.

const NOTE = "Inbox/2026-09-29 Video.md";
const created = (id = "job-1", notePath = NOTE): JobEvent => ({ type: "note-created", id, notePath });
const done = (id = "job-1", notePath = NOTE): JobEvent => ({ type: "done", id, notePath });

const ORDINARY: AutoOpenConditions = { inCollection: false, inSession: true, visible: true };

describe("NoteAutoOpen — the note opens when it is created (#20)", () => {
  it("opens at creation, and the later done does not open it again", () => {
    // The two-tab trap: `done` still carries the path and still arrives, so a
    // policy that answers both would leave the user with one note in two
    // leaves.
    const policy = new NoteAutoOpen();

    expect(policy.handle(created(), ORDINARY)).toBe(NOTE);
    expect(policy.handle(done(), ORDINARY)).toBeUndefined();
  });

  it("never opens a collection child, at creation or at the end", () => {
    // A 40-video playlist must not throw 40 notes open. This is the condition
    // that is not negotiable.
    const policy = new NoteAutoOpen();
    const child: AutoOpenConditions = { ...ORDINARY, inCollection: true };

    expect(policy.handle(created(), child)).toBeUndefined();
    expect(policy.handle(done(), child)).toBeUndefined();
  });

  it("does not yank focus into a window nobody is looking at", () => {
    const policy = new NoteAutoOpen();
    expect(policy.handle(created(), { ...ORDINARY, visible: false })).toBeUndefined();
  });

  it("opens at done what it could not open at creation, for exactly that reason", () => {
    // Submit, switch away, come back to a finished job. The creation open was
    // declined because the window was hidden, so `done` is the fallback — and
    // this is why the done open is kept rather than deleted.
    const policy = new NoteAutoOpen();

    expect(policy.handle(created(), { ...ORDINARY, visible: false })).toBeUndefined();
    expect(policy.handle(done(), ORDINARY)).toBe(NOTE);
  });

  it("ignores a job this session did not submit", () => {
    const policy = new NoteAutoOpen();
    expect(policy.handle(created(), { ...ORDINARY, inSession: false })).toBeUndefined();
  });

  it("does not reopen the note when the job later fails", () => {
    // The note is already open and being written into; a failure must not
    // throw a second leaf at it.
    const policy = new NoteAutoOpen();
    expect(policy.handle(created(), ORDINARY)).toBe(NOTE);
    expect(policy.handle({ type: "failed", id: "job-1", error: "boom" }, ORDINARY)).toBeUndefined();
    expect(policy.handle({ type: "interrupted", id: "job-1" }, ORDINARY)).toBeUndefined();
    expect(policy.handle({ type: "cancelled", id: "job-1" }, ORDINARY)).toBeUndefined();
  });

  it("keeps two concurrent jobs apart", () => {
    const policy = new NoteAutoOpen();
    const other = "Inbox/2026-09-29 Other.md";

    expect(policy.handle(created("job-1"), ORDINARY)).toBe(NOTE);
    expect(policy.handle(created("job-2", other), ORDINARY)).toBe(other);
    // job-1 finishing says nothing about job-2.
    expect(policy.handle(done("job-1"), ORDINARY)).toBeUndefined();
    expect(policy.handle(done("job-2", other), ORDINARY)).toBeUndefined();
  });

  it("remembers nothing once a run is over", () => {
    // The map must not grow for the length of a session.
    const policy = new NoteAutoOpen();
    for (const id of ["job-1", "job-2", "job-3"]) {
      policy.handle(created(id), ORDINARY);
      expect(policy.pendingCount()).toBe(1);
      policy.handle(done(id), ORDINARY);
      expect(policy.pendingCount()).toBe(0);
    }
  });

  it("forgets a job that ended without ever reaching done", () => {
    const policy = new NoteAutoOpen();
    policy.handle(created(), ORDINARY);
    policy.handle({ type: "run-ended", id: "job-1" }, ORDINARY);
    expect(policy.pendingCount()).toBe(0);
  });
});
