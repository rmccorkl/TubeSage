// Pure decision -> UI mapping for the job-recovery modal. No Obsidian, no
// I/O, no clock reads: everything here is a total function of a job record
// and the prompt the runner/planner already classified. Reviewers required
// this split so the modal itself can stay a thin renderer over
// `buildRecoveryRow` (Task 6a brief, #3).
//
// PURITY IS UNAFFECTED BY THE i18n IMPORT. `src/runtime/*` and `src/jobs/*`
// must never pull a VALUE out of `obsidian` (the package ships types only, so
// such an import breaks every unit test in this tree). `../i18n` does not: it
// imports `./locales`, which is static JSON, and reads the interface language
// through a resolver `main.ts` installs at runtime with `setLanguageResolver`
// — `getLanguage` is imported in main.ts and nowhere else. `job-progress-
// notice.ts` in this same directory has imported `t` exactly this way since
// the progress notice was localised; this module follows it.
//
// WHY WHOLE SENTENCES RATHER THAN ASSEMBLED ONES. This module used to build
// its English in code: a `note` PARAMETER was threaded in so a caller could
// supply the article ("the note" in the modal row, "note" in the notice), and
// a ternary spliced the word "translation" or "timestamps" into the middle of
// a clause. Both are English grammar encoded as an API. No other language is
// obliged to place an article, inflect that noun, or put the clause where
// English puts it — so the record's state now SELECTS a whole translated
// sentence, and the only composition left is parameter substitution (see
// src/i18n/index.ts).

import { t } from "../i18n";
import { effectiveTitle, type JobStage, type NoteJobRecord } from "../jobs/job-record";
import type { ClosedOnColdStart, JobEvent, RecoveryPrompt } from "../jobs/job-runner";

export type RecoveryActionId = "resume" | "finish-without-timestamps" | "cancel" | "discard" | "open-note";

export interface RecoveryAction {
  id: RecoveryActionId;
  /** Button label, already translated. Sentence case is a Latin-script rule; see src/i18n/script.ts. */
  label: string;
  /**
   * True when the action may re-bill a previous request. The English label
   * then reads "Resume (may re-bill)", but the warning is carried by this
   * FLAG, not by matching words inside the label: the label is translated and
   * no locale is obliged to spell the caveat the way English does.
   */
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

/**
 * The modal's own label for a stage. Deliberately NOT the progress notice's
 * `notice.progress.stage.*` family: four of the five overlapping stages say
 * something different there ("Summarizing transcript", "Adding timestamps",
 * "Translating note"), and the modal additionally needs `note-created` and
 * `done`, which the runner never emits as progress. Each key is written out
 * literally because the i18n usage gate scans for exactly that shape.
 */
function stageLabel(stage: JobStage): string {
  switch (stage) {
    case "transcript":
      return t("modal.jobs.stage.transcript");
    case "summary":
      return t("modal.jobs.stage.summary");
    case "note-creating":
      return t("modal.jobs.stage.noteCreating");
    case "note-created":
      return t("modal.jobs.stage.noteCreated");
    case "timestamps":
      return t("modal.jobs.stage.timestamps");
    case "translation":
      return t("modal.jobs.stage.translation");
    case "done":
      return t("modal.jobs.stage.done");
  }
}

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

/** What a job closed with its instance left behind. */
type ClosedOutcome = "no-note" | "may-exist" | "without-timestamps" | "without-translation";

/**
 * Decide that outcome from `notePath` (set only after vault.create), the stage
 * the job reached, and — only when `notePath` is still unset — a one-time vault
 * probe of the claimed path (#3 batch G item 7): the note-creating crash window
 * can land a note the record never learned about.
 *
 * Returns an OUTCOME ID, never a phrase. That is what lets the two places which
 * report it — the modal's status line and the cold-start notice — each render a
 * complete sentence of their own. They are not one sentence with two prefixes:
 * one is a bare status, the other names the job and carries its title.
 */
function closedOutcome(record: NoteJobRecord, noteMayExist: boolean): ClosedOutcome {
  if (record.notePath !== undefined) {
    return record.stage === "translation" ? "without-translation" : "without-timestamps";
  }
  if (noteMayExist && record.claimedNotePath !== undefined) {
    return "may-exist";
  }
  return "no-note";
}

function isClosedWithInstance(record: NoteJobRecord): boolean {
  return record.status === "failed" && record.interruption === "app-closed";
}

function terminalStatusLine(record: NoteJobRecord, noteMayExist: boolean): string {
  if (isClosedWithInstance(record)) {
    // Honest about the cause: `lastError` (kept as evidence) is not why the job
    // ended. One whole sentence per outcome — the cause and what it left behind
    // are a single clause in English and need not be two anywhere else.
    switch (closedOutcome(record, noteMayExist)) {
      case "without-translation":
        return t("modal.jobs.closed.withoutTranslation");
      case "without-timestamps":
        return t("modal.jobs.closed.withoutTimestamps");
      case "may-exist":
        // `claimedNotePath` is always defined when this branch is reached (see
        // closedOutcome); the fallback exists only to satisfy the compiler.
        return t("modal.jobs.closed.mayExist", { path: record.claimedNotePath ?? "" });
      case "no-note":
        return t("modal.jobs.closed.noNote");
    }
  }
  switch (record.status) {
    case "failed":
      // `lastError` is THIRD-PARTY text — the model provider's, YouTube's or
      // Obsidian's own message, in whatever language it arrived in. It is
      // substituted verbatim and never translated or re-cased.
      return record.lastError !== undefined
        ? t("modal.jobs.status.failedWithError", { error: record.lastError })
        : t("modal.jobs.status.failed");
    case "cancelled":
      return t("modal.jobs.status.cancelled");
    case "done":
    case "running":
    case "interrupted":
      return t("modal.jobs.status.finished");
  }
}

// The action constants became factories when the labels became translated: a
// module-level object would have frozen whichever language was current when
// this file was first imported, and `t()` is deliberately re-read per lookup
// (src/i18n/index.ts) because Obsidian's 1.13 API has no language-change event.
function cancelAction(): RecoveryAction {
  return { id: "cancel", label: t("modal.jobs.action.cancel"), warnsAboutBilling: false, cta: false };
}

function discardAction(): RecoveryAction {
  return { id: "discard", label: t("modal.jobs.action.discard"), warnsAboutBilling: false, cta: false };
}

// An explicit click only (a recovered job never auto-opens its note, F5);
// offered on a job closed with its instance when its note exists.
function openNoteAction(): RecoveryAction {
  return { id: "open-note", label: t("modal.jobs.action.openNote"), warnsAboutBilling: false, cta: false };
}

// One action id ("finish now, no further LLM call" — job-runner.ts
// ResumeOptions.finishWithoutTimestamps); the label names the pass that is
// still pending at the row's stage. At `translation` the timestamps pass is
// already on disk, so only the translation is what gets skipped. TWO WHOLE
// LABELS rather than one with the noun spliced in: which word a language uses
// for the skipped pass, how it inflects and where in the phrase it sits are
// not English's to decide.
function finishAction(stage: JobStage): RecoveryAction {
  return {
    id: "finish-without-timestamps",
    label:
      stage === "translation"
        ? t("modal.jobs.action.finishWithoutTranslation")
        : t("modal.jobs.action.finishWithoutTimestamps"),
    warnsAboutBilling: false,
    cta: false,
  };
}

function resumeAction(warnsAboutBilling: boolean): RecoveryAction {
  return {
    id: "resume",
    label: warnsAboutBilling ? t("modal.jobs.action.resumeMayRebill") : t("modal.jobs.action.resume"),
    warnsAboutBilling,
    cta: false,
  };
}

type AskUserPrompt = Extract<RecoveryPrompt, { action: "ask-user" }>;

function describeAskUser(
  prompt: AskUserPrompt,
  stageLabelText: string,
): { statusLine: string; actions: RecoveryAction[] } {
  const canFinish = prompt.canFinishWithoutTimestamps;
  const finish = finishAction(prompt.stage);
  const reason = prompt.reason;
  let statusLine: string;
  let actions: RecoveryAction[];

  switch (reason) {
    case "paid-stage-in-flight":
      statusLine = t("modal.jobs.reason.paidStageInFlight", { stage: stageLabelText });
      actions = [resumeAction(true), ...(canFinish ? [finish] : []), discardAction()];
      break;
    case "unknown-billing-in-flight":
      statusLine = t("modal.jobs.reason.unknownBilling", { stage: stageLabelText });
      actions = [resumeAction(true), ...(canFinish ? [finish] : []), discardAction()];
      break;
    case "attempts-exhausted":
      statusLine = t("modal.jobs.reason.attemptsExhausted", { stage: stageLabelText });
      actions = [...(canFinish ? [finish] : []), discardAction()];
      break;
    case "note-collision":
      // Ruling (T6b brief #1): resume IS offered, with the billing warning —
      // job-runner.ts's REGENERATE_REASONS re-enters this reason at
      // "summary", a paid re-run, so an unwarned resume is never correct
      // here. The guidance still says to clear the collision first: a
      // resume against a note that is still there re-blocks before any
      // paid call (runner precheck), so the warning is about the re-run
      // that follows once the path is free.
      //
      // This row QUOTES the plugin's own command by name. It used to hardcode
      // the English "Show active jobs"; now each locale's row carries that
      // locale's own command name (common.command.showActiveJobs), and the
      // pairing is enforced by QUOTED_LABELS in scripts/i18n-lib.mjs.
      statusLine = t("modal.jobs.reason.noteCollision");
      actions = [resumeAction(true), discardAction()];
      break;
    case "claim-unresolved":
      statusLine = t("modal.jobs.reason.claimUnresolved");
      actions = [discardAction()];
      break;
    case "note-missing":
      statusLine = t("modal.jobs.reason.noteMissing");
      actions = [resumeAction(true), discardAction()];
      break;
    case "note-changed":
      statusLine = t("modal.jobs.reason.noteChanged");
      actions = [discardAction()];
      break;
    case "templater-unavailable":
      statusLine = t("modal.jobs.reason.templaterUnavailable");
      actions = [resumeAction(false), discardAction()];
      break;
    case "paid-refetch-required":
      statusLine = t("modal.jobs.reason.paidRefetch");
      actions = [resumeAction(true), ...(canFinish ? [finish] : []), discardAction()];
      break;
    case "path-drift":
      // Re-entry is at "summary" (job-runner.ts REGENERATE_REASONS), a paid
      // re-run, so the resume carries the billing warning.
      statusLine = t("modal.jobs.reason.pathDrift");
      actions = [resumeAction(true), discardAction()];
      break;
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled recovery reason: ${String(exhaustive)}`);
    }
  }

  if (prompt.interruption === "timeout") {
    // Substitution, not concatenation: a language that leads with the status
    // and trails the qualifier can order the row however it needs to.
    statusLine = t("modal.jobs.status.timedOut", { status: statusLine });
  }

  return { statusLine, actions };
}

function describePrompt(
  record: NoteJobRecord,
  prompt: RecoveryPrompt,
  stageLabelText: string,
  noteExists: boolean,
  noteMayExist: boolean,
): { statusLine: string; actions: RecoveryAction[] } {
  switch (prompt.action) {
    case "nothing":
      if (prompt.why === "live") {
        return { statusLine: t("modal.jobs.status.running"), actions: [cancelAction()] };
      }
      return {
        statusLine: terminalStatusLine(record, noteMayExist),
        actions:
          isClosedWithInstance(record) && record.notePath !== undefined && noteExists
            ? [openNoteAction(), discardAction()]
            : [discardAction()],
      };
    case "continue":
    case "auto-resume":
    case "adopt-note":
      return {
        statusLine: t("modal.jobs.status.readyToContinue"),
        actions: [resumeAction(false), discardAction()],
      };
    case "ask-user":
      return describeAskUser(prompt, stageLabelText);
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
  const stageLabelText = stageLabel(stage);
  const { statusLine, actions } = describePrompt(record, prompt, stageLabelText, noteExists, noteMayExist);
  const title = effectiveTitle(record) ?? record.url;
  const notePath = record.notePath ?? record.claimedNotePath;

  return {
    id: record.id,
    title,
    stageLabel: stageLabelText,
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
      return timestampsEdited ? t("notice.note.done.timestampsEdited") : t("notice.note.done.created");
    case "note-changed":
      return timestampsEdited ? t("notice.note.done.bothEdited") : t("notice.note.done.translationEdited");
    case "user-choice":
      return event.timestampsSkipped === "user-choice"
        ? t("notice.note.done.withoutBoth")
        : t("notice.note.done.withoutTranslation");
    case "timestamps-skipped":
      // Only ever paired with timestampsSkipped: "user-choice" (#3 D2 legacy
      // parity): the job's own flags skipped the timestamps pass, so a
      // translation was never attempted either — same wording as skipping
      // both by explicit choice, since the legacy modal showed nothing more
      // specific for this case either.
      return t("notice.note.done.withoutBoth");
  }
}

/**
 * Pure: the one Notice after a cold start, for the jobs it closed (a job dies with the instance that
 * started it); undefined when none. One job is named with what it left behind; more point to the list —
 * worded so it stays true even when more were closed than the modal's recent-terminal cap shows (#3 batch
 * G item 2), instead of promising a full list that may only show the most recent few.
 *
 * The one-job and many-job forms are two different STATEMENTS, not one sentence in two numbers: the first
 * names the job and says what is on disk, the second gives a count and points at the list. So this branch
 * is content rather than grammar, and the many-job row is written to read correctly for any count from two
 * upwards — which is why it is an ordinary key and not a `tPlural` family.
 */
export function coldStartNoticeText(closed: readonly ClosedOnColdStart[]): string | undefined {
  if (closed.length === 0) {
    return undefined;
  }
  if (closed.length === 1) {
    const { record, noteMayExist } = closed[0];
    const title = effectiveTitle(record) ?? record.url;
    switch (closedOutcome(record, noteMayExist)) {
      case "without-translation":
        return t("notice.coldStart.single.withoutTranslation", { title });
      case "without-timestamps":
        return t("notice.coldStart.single.withoutTimestamps", { title });
      case "may-exist":
        // Always defined when this branch is reached; see closedOutcome.
        return t("notice.coldStart.single.mayExist", { title, path: record.claimedNotePath ?? "" });
      case "no-note":
        return t("notice.coldStart.single.noNote", { title });
    }
  }
  return t("notice.coldStart.several", { count: closed.length });
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
    return t("notice.recovery.single");
  }
  return t("notice.recovery.several", { count: promptCount });
}

/**
 * Pure: a coarse relative age for the modal's meta line, from two epochs the caller already holds
 * (`record.updatedAt`, `now`). Clock skew (a future updatedAt) reads as "just now".
 *
 * DELIBERATELY STILL ENGLISH, and the only text in this module that is. A relative age is not a sentence
 * to translate but a quantity to FORMAT: the four forms below are four counted strings — a `tPlural`
 * family each, 24 matrix rows — and `Intl.RelativeTimeFormat` already produces all four correctly in every
 * locale from the platform's own CLDR data. Hand-authoring in the matrix what the platform holds would be
 * the wrong fix, so this is left for a follow-up that replaces the function rather than translating it.
 * `modal.jobs.meta`'s shipped context note already records that `{age}` arrives English.
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
