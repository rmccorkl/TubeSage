// The single progress surface for a single-video job (#7): one floating
// Notice per job, created on its first `progress` event, updated in place
// with `setMessage` for every later stage, and hidden on whichever terminal
// event arrives. It replaces both of the old surfaces — the desktop
// status-bar spinner the plugin owned and the blocking mobile processing
// panel inside the modal — so there is one code path on both platforms and
// the note underneath stays readable while the job runs.
//
// Obsidian's `Notice` is injected as a factory rather than imported: this
// module must stay unit-testable without an Obsidian runtime (the `obsidian`
// package ships types only), and the failure mode worth testing — a notice
// re-created per event instead of updated — is only visible with a double
// that counts constructions separately from updates.
//
// Wording is NOT taken from the event. `event.message` is the runner's own
// English (`PROGRESS_MESSAGES`, job-runner.ts:238, plus the "Creating note"
// emission at job-runner.ts:961); the runner is presentation-free and may not
// import the i18n layer, so the stage is mapped to a translated label here.
// Each `t()` call names its key literally: the i18n usage gate scans for
// exactly that shape, so a computed key would read as an orphan.
import { t } from "../i18n";
import type { JobStage } from "../jobs/job-record";
import type { JobEvent } from "../jobs/job-runner";
import { renderProgressNotice } from "./progress-notice-control";
import type { NoticeElementLike } from "./progress-notice-control";

/** What this module needs of Obsidian's `Notice`; see `new Notice(message, 0)` in main.ts. */
export interface ProgressNoticeHandle {
  setMessage(message: string): unknown;
  hide(): void;
  /**
   * The notice's message element, when the host can supply it. Present for a
   * real Obsidian `Notice` (its `messageEl`), which is what lets a tappable
   * stop control be rendered INSIDE the notice; absent in surfaces that only
   * carry text, which then keep the plain message.
   */
  element?: NoticeElementLike;
}

/** Builds a persistent notice showing `message`. */
export type ProgressNoticeFactory = (message: string) => ProgressNoticeHandle;

/**
 * The translated label for a progress stage. Only `transcript`, `summary`,
 * `note-creating`, `timestamps` and `translation` are ever emitted as
 * progress; the remaining `JobStage` members keep the function total.
 */
function stageLabel(stage: JobStage): string {
  switch (stage) {
    case "transcript":
      return t("notice.progress.stage.transcript");
    case "summary":
      return t("notice.progress.stage.summary");
    case "note-creating":
      return t("notice.progress.stage.noteCreating");
    case "timestamps":
      return t("notice.progress.stage.timestamps");
    case "translation":
      return t("notice.progress.stage.translation");
    default:
      return t("notice.progress.stage.working");
  }
}

/**
 * The notice's text: just the stage.
 *
 * It used to append `— cancel from "Show active jobs"`. That clause named a
 * command-palette entry with no ribbon icon, so on a phone it pointed at
 * something awkward to reach — and the notice now carries its own stop control,
 * which makes describing a remote one both wrong and unnecessary. The key that
 * embedded the command name is gone from all 51 locales with it.
 */
export function progressNoticeText(stage: JobStage): string {
  return stageLabel(stage);
}

/**
 * One notice per job, keyed by job id. Fed from the plugin's `onJobEvent`,
 * the same lifecycle slot the status-bar spinners occupied, so every terminal
 * path and the unload path are the ones already written for them.
 */
export class JobProgressNotices {
  private readonly notices = new Map<string, ProgressNoticeHandle>();

  /**
   * `onStop` cancels the job a notice belongs to. Optional so a surface with no
   * cancel route (or a test that does not care) still works; when it is absent
   * the notice simply shows its stage without a control.
   */
  constructor(
    private readonly create: ProgressNoticeFactory,
    private readonly onStop?: (id: string) => void,
  ) {}

  /**
   * Applies one runner event. `progress` creates the job's notice the first
   * time and updates it in place afterwards; every terminal event hides it
   * and forgets the job, which is what keeps the map from growing across a
   * session. A terminal event for a job that never reported progress (or for
   * another installation's job) is a no-op.
   */
  handle(event: JobEvent): void {
    switch (event.type) {
      case "progress":
        this.show(event.id, progressNoticeText(event.stage));
        break;
      case "done":
      case "failed":
      case "cancelled":
      case "interrupted":
        this.dismiss(event.id);
        break;
    }
  }

  /** Hides the job's notice, if it has one. */
  dismiss(id: string): void {
    const notice = this.notices.get(id);
    if (notice !== undefined) {
      notice.hide();
      this.notices.delete(id);
    }
  }

  /** Hides every live notice: `onunload` must leave none floating. Idempotent. */
  dismissAll(): void {
    for (const notice of this.notices.values()) {
      notice.hide();
    }
    this.notices.clear();
  }

  /** Live notices. Exposed for the leak checks; the plugin does not read it. */
  activeCount(): number {
    return this.notices.size;
  }

  private show(id: string, message: string): void {
    const existing = this.notices.get(id);
    if (existing !== undefined) {
      this.paint(id, existing, message);
      return;
    }
    const handle = this.create(message);
    this.notices.set(id, handle);
    // `create` already carried the opening text; only the control is added.
    this.renderControl(id, handle, message);
  }

  /**
   * Draws the notice's contents. With an element and a cancel route it renders
   * the stop control; otherwise it falls back to the plain message, so no
   * surface is left blank by the richer path being unavailable.
   *
   * Re-rendered on every progress event rather than only on creation: the stage
   * changes as the job advances, and re-rendering also rebinds the control's
   * action to THIS id — which is what stops a handler outliving its job. The
   * rebinding happens through the content the control reads, not by attaching
   * listeners again; see `renderProgressNotice`.
   */
  private paint(id: string, handle: ProgressNoticeHandle, message: string): void {
    if (!this.renderControl(id, handle, message)) {
      handle.setMessage(message);
    }
  }

  /** Renders the in-notice stop control; false when this surface cannot carry one. */
  private renderControl(id: string, handle: ProgressNoticeHandle, message: string): boolean {
    const element = handle.element;
    const onStop = this.onStop;
    if (element === undefined || onStop === undefined) return false;
    renderProgressNotice(element, {
      stage: message,
      hint: t("notice.progress.tapToCancel"),
      onStop: () => onStop(id),
    });
    return true;
  }
}
