import { aggregateProgress } from "../jobs/collection-record";
import type { CollectionJobRecord, CollectionProgress, CollectionStatus } from "../jobs/collection-record";
import type { NoteJobRecord } from "../jobs/job-record";
import { renderProgressNotice } from "./progress-notice-control";
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

  /**
   * `onStop` cancels the whole RUN, not one of its videos — the run is what
   * this notice represents. Optional: without it the notice is text only.
   * `stopLabel` supplies the already-translated tap hint, like `text`.
   */
  constructor(
    private readonly create: ProgressNoticeFactory,
    private readonly text: (progress: CollectionProgress, parent: CollectionJobRecord) => string,
    private readonly onStop?: (parentId: string) => void,
    private readonly stopLabel?: () => string,
  ) {}

  /** Opens the run's single notice and takes ownership of its children's ids. */
  start(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void {
    if (this.handle !== undefined || this.finished) return;
    const progress = aggregateProgress(parent, children);
    this.handle = this.create(this.text(progress, parent));
    // `create` already carried the opening text, so only the control is added
    // here — painting again would write the same message twice.
    this.renderControl(parent, this.text(progress, parent));
  }

  /**
   * Rewrites the existing notice. Deliberately a no-op once the run has
   * finished: cancelling a collection leaves the in-flight child running (it is
   * already paid for), and that child still reports when it lands — which must
   * not reopen a notice for a run the user has already ended.
   */
  update(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void {
    if (this.finished || this.handle === undefined) return;
    this.paint(parent, children);
  }

  /**
   * Draws the notice. With an element and a cancel route it renders the same
   * in-notice stop control a single job gets; otherwise plain text.
   */
  private paint(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void {
    if (this.handle === undefined) return;
    const message = this.text(aggregateProgress(parent, children), parent);
    if (!this.renderControl(parent, message)) {
      this.handle.setMessage(message);
    }
  }

  /** Renders the in-notice stop control; false when this surface cannot carry one. */
  private renderControl(parent: CollectionJobRecord, message: string): boolean {
    const element = this.handle?.element;
    const onStop = this.onStop;
    const stopLabel = this.stopLabel;
    if (element === undefined || onStop === undefined || stopLabel === undefined) return false;
    renderProgressNotice(element, { stage: message, hint: stopLabel(), onStop: () => onStop(parent.id) });
    return true;
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

  /**
   * Hides the run's notice without narrating an outcome. `onunload` must leave
   * none floating: on desktop the surface is a status-bar item with a live
   * `window.setInterval` behind it, on mobile a notice nothing is left to drive
   * — either would outlive the plugin and only go on a restart.
   *
   * Deliberately not `finish`: there is no terminal status to report here and
   * the run's PERSISTED state is untouched, exactly as `JobRunner.stopAll`
   * leaves its records for the next cold start to close. Marking the run
   * finished is what stops a straggling event reopening a surface this plugin
   * no longer drives. Idempotent, and named for its counterpart on
   * `JobProgressNotices` even though a run has at most one notice.
   */
  dismissAll(): void {
    this.finished = true;
    this.handle?.hide();
    this.handle = undefined;
  }
}
