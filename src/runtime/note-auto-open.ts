import type { JobEvent } from "../jobs/job-runner";

// WHEN A NEW NOTE IS SHOWN (#20).
//
// The legacy behaviour this restores: `applyTemplate` created the note and
// opened it as its own next step, so it appeared and took focus immediately
// and the timestamps pass then rewrote it underneath. The job-runner
// migration (5fed8a7) left the only auto-open on `done`, which arrives after
// the timestamps pass and the translation — and never at all when a job ends
// `failed`, `cancelled` or `interrupted`, leaving a note sitting in the vault
// that nothing ever mentioned.
//
// It is a class rather than four conditions inline in `onJobEvent` because
// main.ts has no test harness, and the mistake this policy exists to prevent
// is invisible to inspection: `openNote` uses `getLeaf(true)`, which builds a
// NEW leaf every time. Opening at creation while leaving the `done` open in
// place would give one note two tabs.
//
// The runner stays presentation-free throughout: it emits the fact that a
// note exists and where, this decides whether to show it, and the host does
// the showing.

/** What the HOST knows and this policy does not. */
export interface AutoOpenConditions {
  /** The job is a child of a live collection (`CollectionRunner.owns`). */
  inCollection: boolean;
  /** The job was submitted in this session (`sessionJobIds`). */
  inSession: boolean;
  /** The app window is visible (`activeDocument.visibilityState`). */
  visible: boolean;
}

export class NoteAutoOpen {
  // Jobs whose note this session has already opened. Only ever holds ids
  // between a note being created and its run ending, so it cannot grow across
  // a session — every terminal event clears one, and `run-ended` catches the
  // rest (#14).
  private readonly opened = new Set<string>();

  /**
   * The note to open right now, or undefined.
   *
   * `note-created` is the moment that matters: the note exists, the summary
   * is in it, and the passes that follow rewrite it in place while the user
   * watches. `done` is kept as a FALLBACK rather than deleted, for exactly
   * one case — the window was hidden when the note was created, so the open
   * was declined, and the user is back by the time the job finishes. It is a
   * no-op once this job has opened its note, which is what stops the second
   * leaf.
   *
   * Nothing opens on a failure path. If the note was created, it is already
   * open by then; if it was not opened, a job that has just failed is not the
   * moment to seize focus. The gap that fixes — a created note going
   * unmentioned when a job ends any way but `done` — is closed by opening at
   * creation, not by opening on failure.
   */
  handle(event: JobEvent, conditions: AutoOpenConditions): string | undefined {
    switch (event.type) {
      case "note-created":
        return this.open(event.id, event.notePath, conditions);
      case "done": {
        const path = this.open(event.id, event.notePath, conditions);
        this.opened.delete(event.id);
        return path;
      }
      case "failed":
      case "cancelled":
      case "interrupted":
      case "run-ended":
        this.opened.delete(event.id);
        return undefined;
      default:
        return undefined;
    }
  }

  /** Ids currently held. Exposed for the leak checks; the plugin does not read it. */
  pendingCount(): number {
    return this.opened.size;
  }

  private open(id: string, notePath: string, conditions: AutoOpenConditions): string | undefined {
    // A collection is reported by its own single surface and must never throw
    // one leaf per video; a job from another session is not this window's to
    // show; and a hidden window must not have focus taken from it.
    if (conditions.inCollection || !conditions.inSession || !conditions.visible) {
      return undefined;
    }
    if (this.opened.has(id)) {
      return undefined;
    }
    if (notePath === "") {
      return undefined;
    }
    this.opened.add(id);
    return notePath;
  }
}
