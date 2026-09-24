import { aggregateProgress } from "../jobs/collection-record";
import type { CollectionJobRecord, CollectionProgress, CollectionStatus } from "../jobs/collection-record";
import type { NoteJobRecord } from "../jobs/job-record";
import type { ProgressNoticeFactory, ProgressNoticeHandle } from "./job-progress-notice";

// ONE floating notice for a whole collection.
//
// `JobProgressNotices` keys a notice by JOB id, which is right for single
// videos and wrong here: a 40-video playlist would stack 40 notices. So a
// collection's children have their individual notices suppressed by the caller
// (which asks the RUNNER what belongs to a live run — this class deliberately
// keeps no id bookkeeping of its own, because a run's children are not known
// when its notice opens), leaving one notice rewritten in place as items land.
//
// No Obsidian: the notice factory and the message formatter are both injected,
// which is also what lets the behaviour be tested without a locale table or a
// live Notice.

export class CollectionNotices {
  private handle: ProgressNoticeHandle | undefined;
  private finished = false;

  constructor(
    private readonly create: ProgressNoticeFactory,
    private readonly text: (progress: CollectionProgress, parent: CollectionJobRecord) => string,
  ) {}

  /** Opens the run's single notice and takes ownership of its children's ids. */
  start(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void {
    if (this.handle !== undefined || this.finished) return;
    const progress = aggregateProgress(parent, children);
    this.handle = this.create(this.text(progress, parent));
  }

  /**
   * Rewrites the existing notice. Deliberately a no-op once the run has
   * finished: cancelling a collection leaves the in-flight child running (it is
   * already paid for), and that child still reports when it lands — which must
   * not reopen a notice for a run the user has already ended.
   */
  update(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void {
    if (this.finished || this.handle === undefined) return;
    this.handle.setMessage(this.text(aggregateProgress(parent, children), parent));
  }

  /**
   * Ends the run: hides the notice exactly once.
   */
  finish(
    parent: CollectionJobRecord,
    children: readonly NoteJobRecord[],
    status: Exclude<CollectionStatus, "running">,
  ): void {
    if (this.finished) return;
    this.finished = true;
    // Last word before the notice goes, so a cancelled or closed run states
    // what it actually completed rather than vanishing silently.
    this.handle?.setMessage(this.text(aggregateProgress(parent, children), parent));
    this.handle?.hide();
    this.handle = undefined;
    void status;
  }
}
