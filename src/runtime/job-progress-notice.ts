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

/** What this module needs of Obsidian's `Notice`; see `new Notice(message, 0)` in main.ts. */
export interface ProgressNoticeHandle {
  setMessage(message: string): unknown;
  hide(): void;
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
 * The whole notice text: the stage label plus the clause saying where to
 * cancel. Composed by placeholder substitution, never by concatenation — a
 * sentence assembled from fragments in code puts a space where Japanese and
 * Chinese want none (see src/i18n/index.ts).
 */
export function progressNoticeText(stage: JobStage): string {
  return t("notice.progress.message", { stage: stageLabel(stage) });
}

/**
 * One notice per job, keyed by job id. Fed from the plugin's `onJobEvent`,
 * the same lifecycle slot the status-bar spinners occupied, so every terminal
 * path and the unload path are the ones already written for them.
 */
export class JobProgressNotices {
  private readonly notices = new Map<string, ProgressNoticeHandle>();

  constructor(private readonly create: ProgressNoticeFactory) {}

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
      existing.setMessage(message);
      return;
    }
    this.notices.set(id, this.create(message));
  }
}
