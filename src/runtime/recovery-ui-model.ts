// Pure decision -> UI mapping for the job-recovery modal. No Obsidian, no
// I/O, no clock reads: everything here is a total function of a job record
// and the prompt the runner/planner already classified. Reviewers required
// this split so the modal itself can stay a thin renderer over
// `buildRecoveryRow` (Task 6a brief, #3).

import { effectiveTitle, type JobStage, type NoteJobRecord } from "../jobs/job-record";
import type { ClosedOnColdStart, JobEvent, RecoveryPrompt } from "../jobs/job-runner";

export type RecoveryActionId = "resume" | "finish-without-timestamps" | "cancel" | "discard" | "open-note";

export interface RecoveryAction {
  id: RecoveryActionId;
  /** Button label, sentence case (ESLint obsidianmd/ui/sentence-case applies to UI strings). */
  label: string;
  /** True when the action may re-bill a previous request; the label must then contain "may re-bill". */
  warnsAboutBilling: boolean;
  /** Call-to-action styling hint for the primary action. */
  cta: boolean;
}

export interface RecoveryRowModel {
  id: string;
  title: string;
  stageLabel: string;
  statusLine: string;
  notePath?: string;
  actions: RecoveryAction[];
}

const STAGE_LABELS: Record<JobStage, string> = {
  transcript: "Fetching transcript",
  summary: "Summarizing",
  "note-creating": "Creating note",
  "note-created": "Note created",
  timestamps: "Adding timestamp links",
  translation: "Translating",
  done: "Done",
};

// The runner's checkpoint stage (`record.stage`) and the prompt's own stage
// (e.g. planner rule 5 asks about "summary" while the record checkpoint is
// still "note-creating") can differ; the prompt always wins when it names
// one, since it describes what actually needs a decision.
function resolveStage(record: NoteJobRecord, prompt: RecoveryPrompt): JobStage {
  if (prompt.action === "ask-user") {
    return prompt.stage;
  }
  if (prompt.action === "continue" || prompt.action === "auto-resume") {
    return prompt.fromStage;
  }
  return record.stage;
}

/**
 * What a job closed with its instance left behind, from `notePath` (set only after vault.create), the
 * stage it reached, and — only when `notePath` is still unset — a one-time vault probe of the claimed
 * path (#3 batch G item 7): the note-creating crash window can land a note the record never learned about.
 */
function closedOutcome(record: NoteJobRecord, noteMayExist = false, note = "note"): string {
  if (record.notePath !== undefined) {
    return `${note} was created without ${record.stage === "translation" ? "translation" : "timestamps"}`;
  }
  if (noteMayExist && record.claimedNotePath !== undefined) {
    return `a note may exist at ${record.claimedNotePath}`;
  }
  return "no note was created";
}

function isClosedWithInstance(record: NoteJobRecord): boolean {
  return record.status === "failed" && record.interruption === "app-closed";
}

function terminalStatusLine(record: NoteJobRecord, noteMayExist: boolean): string {
  if (isClosedWithInstance(record)) {
    // Honest about the cause: `lastError` (kept as evidence) is not why the job ended.
    return `Interrupted when Obsidian closed; ${closedOutcome(record, noteMayExist, "the note")}`;
  }
  switch (record.status) {
    case "failed":
      return record.lastError !== undefined ? `Failed: ${record.lastError}` : "Failed";
    case "cancelled":
      return "Cancelled";
    case "done":
    case "running":
    case "interrupted":
      return "Finished";
  }
}

const cancelAction: RecoveryAction = { id: "cancel", label: "Cancel", warnsAboutBilling: false, cta: false };
const discardAction: RecoveryAction = { id: "discard", label: "Discard", warnsAboutBilling: false, cta: false };
// An explicit click only (a recovered job never auto-opens its note, F5);
// offered on a job closed with its instance when its note exists.
const openNoteAction: RecoveryAction = { id: "open-note", label: "Open note", warnsAboutBilling: false, cta: false };
// One action id ("finish now, no further LLM call" — job-runner.ts
// ResumeOptions.finishWithoutTimestamps); the label names the pass that is
// still pending at the row's stage. At `translation` the timestamps pass is
// already on disk, so only the translation is what gets skipped.
function finishAction(stage: JobStage): RecoveryAction {
  return {
    id: "finish-without-timestamps",
    label: stage === "translation" ? "Finish without translation" : "Finish without timestamps",
    warnsAboutBilling: false,
    cta: false,
  };
}

function resumeAction(warnsAboutBilling: boolean): RecoveryAction {
  return {
    id: "resume",
    label: warnsAboutBilling ? "Resume (may re-bill)" : "Resume",
    warnsAboutBilling,
    cta: false,
  };
}

type AskUserPrompt = Extract<RecoveryPrompt, { action: "ask-user" }>;

function describeAskUser(prompt: AskUserPrompt, stageLabel: string): { statusLine: string; actions: RecoveryAction[] } {
  const canFinish = prompt.canFinishWithoutTimestamps;
  const finish = finishAction(prompt.stage);
  const reason = prompt.reason;
  let statusLine: string;
  let actions: RecoveryAction[];

  switch (reason) {
    case "paid-stage-in-flight":
      statusLine = `Interrupted during ${stageLabel}; the previous request may already have been billed`;
      actions = [resumeAction(true), ...(canFinish ? [finish] : []), discardAction];
      break;
    case "unknown-billing-in-flight":
      statusLine = `Interrupted during ${stageLabel}; billing for the previous request is unknown`;
      actions = [resumeAction(true), ...(canFinish ? [finish] : []), discardAction];
      break;
    case "attempts-exhausted":
      statusLine = `Too many attempts for ${stageLabel}`;
      actions = [...(canFinish ? [finish] : []), discardAction];
      break;
    case "note-collision":
      // Ruling (T6b brief #1): resume IS offered, with the billing warning —
      // job-runner.ts's REGENERATE_REASONS re-enters this reason at
      // "summary", a paid re-run, so an unwarned resume is never correct
      // here. The guidance still says to clear the collision first: a
      // resume against a note that is still there re-blocks before any
      // paid call (runner precheck), so the warning is about the re-run
      // that follows once the path is free.
      statusLine = "A note already exists at the target path — rename or remove it, then resume from Show active jobs";
      actions = [resumeAction(true), discardAction];
      break;
    case "claim-unresolved":
      statusLine = "Could not confirm whether the note at the target path belongs to this job";
      actions = [discardAction];
      break;
    case "note-missing":
      statusLine = "The note for this job was moved or deleted";
      actions = [resumeAction(true), discardAction];
      break;
    case "note-changed":
      statusLine = "The note was edited during processing; timestamps were skipped";
      actions = [discardAction];
      break;
    case "templater-unavailable":
      statusLine = "Templater is not available; enable it, then resume";
      actions = [resumeAction(false), discardAction];
      break;
    case "paid-refetch-required":
      statusLine = "Resuming re-fetches the transcript through a paid service";
      actions = [resumeAction(true), ...(canFinish ? [finish] : []), discardAction];
      break;
    case "path-drift":
      // Re-entry is at "summary" (job-runner.ts REGENERATE_REASONS), a paid
      // re-run, so the resume carries the billing warning.
      statusLine = "The note path could not be computed consistently (check folder and date settings), then resume";
      actions = [resumeAction(true), discardAction];
      break;
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled recovery reason: ${String(exhaustive)}`);
    }
  }

  if (prompt.interruption === "timeout") {
    statusLine = `Timed out. ${statusLine}`;
  }

  return { statusLine, actions };
}

function describePrompt(
  record: NoteJobRecord,
  prompt: RecoveryPrompt,
  stageLabel: string,
  noteExists: boolean,
  noteMayExist: boolean,
): { statusLine: string; actions: RecoveryAction[] } {
  switch (prompt.action) {
    case "nothing":
      if (prompt.why === "live") {
        return { statusLine: "Running", actions: [cancelAction] };
      }
      return {
        statusLine: terminalStatusLine(record, noteMayExist),
        actions:
          isClosedWithInstance(record) && record.notePath !== undefined && noteExists ? [openNoteAction, discardAction] : [discardAction],
      };
    case "continue":
    case "auto-resume":
    case "adopt-note":
      return { statusLine: "Ready to continue", actions: [resumeAction(false), discardAction] };
    case "ask-user":
      return describeAskUser(prompt, stageLabel);
  }
}

function withCta(actions: RecoveryAction[]): RecoveryAction[] {
  return actions.map((action, index) => ({ ...action, cta: index === 0 }));
}

/**
 * Pure: builds the row shown for one job from its record and the runner's prompt. `noteExists` is the
 * caller's probe of `record.notePath` (this module cannot touch the vault); it only gates "Open note".
 * `noteMayExist` is the caller's probe of `record.claimedNotePath`, used only for wording (#3 batch G item
 * 7) — never as proof, so it never adds "Open note".
 */
export function buildRecoveryRow(
  record: NoteJobRecord,
  prompt: RecoveryPrompt,
  noteExists = false,
  noteMayExist = false,
): RecoveryRowModel {
  const stage = resolveStage(record, prompt);
  const stageLabel = STAGE_LABELS[stage];
  const { statusLine, actions } = describePrompt(record, prompt, stageLabel, noteExists, noteMayExist);
  const title = effectiveTitle(record) ?? record.url;
  const notePath = record.notePath ?? record.claimedNotePath;

  return {
    id: record.id,
    title,
    stageLabel,
    statusLine,
    ...(notePath !== undefined ? { notePath } : {}),
    actions: withCta(actions),
  };
}

type DoneEvent = Extract<JobEvent, { type: "done" }>;

/**
 * Pure: the Notice for a finished job. The two legacy texts are kept verbatim; a skipped translation is
 * named by its cause. A timestamps pass skipped by the record's own flags (`user-choice` with nothing else
 * skipped) stays silent, as it always was.
 */
export function doneNoticeText(event: DoneEvent): string {
  const timestampsEdited = event.timestampsSkipped === "note-changed";
  switch (event.translationSkipped) {
    case undefined:
      return timestampsEdited
        ? "Note created, but timestamps were skipped because the note was edited"
        : "Transcript note created successfully";
    case "note-changed":
      return timestampsEdited
        ? "Note created, but timestamps and the translation were skipped because the note was edited"
        : "Note created, but the translation was skipped because the note was edited";
    case "user-choice":
      return event.timestampsSkipped === "user-choice"
        ? "Note created without timestamps or translation"
        : "Note created without translation";
    case "timestamps-skipped":
      // Only ever paired with timestampsSkipped: "user-choice" (#3 D2 legacy
      // parity): the job's own flags skipped the timestamps pass, so a
      // translation was never attempted either — same wording as skipping
      // both by explicit choice, since the legacy modal showed nothing more
      // specific for this case either.
      return "Note created without timestamps or translation";
  }
}

/**
 * Pure: the one Notice after a cold start, for the jobs it closed (a job dies with the instance that
 * started it); undefined when none. One job is named with what it left behind; more point to the list —
 * worded so it stays true even when more were closed than the modal's recent-terminal cap shows (#3 batch
 * G item 2), instead of promising a full list that may only show the most recent few.
 */
export function coldStartNoticeText(closed: readonly ClosedOnColdStart[]): string | undefined {
  if (closed.length === 0) {
    return undefined;
  }
  if (closed.length === 1) {
    const { record, noteMayExist } = closed[0];
    const title = effectiveTitle(record) ?? record.url;
    return `TubeSage: 1 note job was interrupted when Obsidian closed — ${title}: ${closedOutcome(record, noteMayExist)}`;
  }
  return `TubeSage: ${closed.length} note jobs were interrupted when Obsidian closed; the most recent are listed under Show active jobs`;
}

export type RecoveryTrigger = "startup" | "visible" | "manual";

/**
 * Pure: whether to open the modal (vs. only a Notice) for a trigger. manual → always (even with zero
 * prompts, to show the empty state); visible and startup → never (Notice only). The cold-start pass never
 * classifies (`recoverAll({coldStart:true})` always resolves to zero prompts — a closed job gets its own
 * Notice from `coldStartNoticeText`, never a modal), so startup folds into the same "never" as visible.
 */
export function shouldOpenRecoveryModal(trigger: RecoveryTrigger, promptCount: number): boolean {
  switch (trigger) {
    case "manual":
      return true;
    case "startup":
    case "visible":
      return false;
  }
}

/** Pure: the Notice text for N prompts, or undefined when N === 0. */
export function recoveryNoticeText(promptCount: number): string | undefined {
  if (promptCount === 0) {
    return undefined;
  }
  if (promptCount === 1) {
    return "TubeSage: 1 interrupted job needs attention";
  }
  return `TubeSage: ${promptCount} interrupted jobs need attention`;
}

/**
 * Pure: a coarse relative age for the modal's meta line, from two epochs the caller already holds
 * (`record.updatedAt`, `now`). Clock skew (a future updatedAt) reads as "just now".
 */
export function formatJobAge(updatedAt: number, now: number): string {
  const elapsed = Math.max(0, now - updatedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
}
