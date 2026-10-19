import { t } from "../i18n";
import { nextFreePath } from "../jobs/free-path";
import type { JobEvent } from "../jobs/job-runner";
import { sanitizeFilename } from "../utils/filename-sanitizer";
import { doneNoticeText } from "./job-progress-notice";

// DEBUG LOGGING PUTS THE LOGS IN THE NOTE (#32).
//
// One condition decides whether a job's captured logs are written down: is
// debug logging on. No outcome decides it. A job that ends, however it ends,
// leaves its logs in a note — appended to its own note when it has one, or in
// a debug note of their own when it never got that far. Before this, only a
// `failed` job left anything: a successful note had the callout removed when
// single videos moved onto the runner, and an `interrupted` one — every
// provider and network error (#31) — left nothing at all.
//
// The callout goes on when the job ENDS, never at render time. The timestamps
// and translation passes read the note back and send it to the model, so a
// callout written any earlier would travel with it and be translated, and it
// would miss every line logged after it. The legacy modal appended it after
// all processing too.
//
// Scoped to the job. The logger's buffer is never cleared on this path, so
// without a mark every note would carry every earlier job's lines, prompts and
// transcripts included. A job's lines run from its first event to its last; a
// job running alongside it interleaves its own lines there, and nothing is
// lost (clearing at submit would wipe the other job's).
//
// A class rather than code in onJobEvent because main.ts has no test harness.

export const DEBUG_CALLOUT_TITLE = "> [!info]- Debug Information (hidden)";

/**
 * The collapsed callout appended to a note: the captured lines inside a fenced block. The fence is
 * longer than any backtick run in the lines (CommonMark): a logged model reply routinely carries a
 * code block, whose ``` would otherwise close a fixed three-backtick fence and spill the rest of the
 * log into the note as markdown.
 */
function debugCallout(logs: string): string {
  const runs: string[] = logs.match(/`+/g) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `\n\n${DEBUG_CALLOUT_TITLE}\n> ${fence}\n${logs}\n> ${fence}`;
}

/** What every masked secret and URL credential becomes: a fixed run, so the note says nothing about its length. */
const MASK = "XXXXXXXX";
/** Shorter values are not masked: a blank or stub key must not X out ordinary words. */
const MIN_SECRET_LENGTH = 8;
// scheme://user:pass@ — the userinfo of a URL, such as a basic-auth proxy's base URL.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;

/**
 * Every configured secret value, and the userinfo of every URL, replaced with X's. A wrong key comes
 * back in a 401 body ("Incorrect API key provided: …") and a credentialed base URL is logged on every
 * request, so either would otherwise be written into the vault in plain text.
 */
function maskSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  const values = secrets
    .map((secret) => (typeof secret === "string" ? secret.trim() : ""))
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    // Longest first, so a key that contains another is masked whole.
    .sort((a, b) => b.length - a.length);
  let masked = text.replace(URL_USERINFO, `$1${MASK}@`);
  for (const value of values) {
    masked = masked.split(value).join(MASK);
  }
  return masked;
}

type OutcomeEvent = Extract<JobEvent, { type: "done" | "failed" | "interrupted" | "cancelled" }>;

const OUTCOMES: ReadonlySet<JobEvent["type"]> = new Set(["done", "failed", "interrupted", "cancelled"]);

function isOutcome(event: JobEvent): event is OutcomeEvent {
  return OUTCOMES.has(event.type);
}

/** How a job ended, in the words its notice uses; a debug note records the same sentence. */
export function outcomeText(event: OutcomeEvent): string {
  switch (event.type) {
    case "done":
      return doneNoticeText(event);
    case "failed":
      return t("notice.job.failed", { error: event.error });
    case "interrupted":
      return t("notice.job.interrupted", { error: event.error });
    case "cancelled":
      return t("notice.job.cancelled");
  }
}

/** What the host knows about a job, reduced to what a debug note needs. */
export interface DebugNoteJob {
  title: string;
  url: string;
  folder: string;
  /** Where the job's own note landed; absent until it exists. */
  notePath?: string;
}

/** Obsidian's Vault satisfies this structurally (main.ts adapts getFile from getAbstractFileByPath). */
export interface DebugNoteVault<F> {
  getFile(path: string): F | null;
  create(path: string, content: string): Promise<unknown>;
  process(file: F, fn: (data: string) => string): Promise<string>;
}

export interface DebugNoteDeps<F> {
  /** The one condition: is debug logging on. */
  enabled(): boolean;
  /**
   * The lines logged from `mark` on, formatted for a callout (getLogsForCallout), each passed through
   * `redact` BEFORE it is wrapped: a real key is longer than the wrap width, so masking the formatted
   * text would miss the halves of a key split across two lines.
   */
  logsSince(mark: number, redact: (text: string) => string): string;
  /** Every configured secret value: provider keys, transcript-service keys, the YouTube Data API key. */
  secrets(): ReadonlyArray<string | undefined>;
  job(id: string): DebugNoteJob | undefined;
  vault: DebugNoteVault<F>;
  ensureFolder(folder: string): Promise<void>;
  /** Obsidian's normalizePath: the debug note's path is probed and created under the same key. */
  normalizePath: (path: string) => string;
  notify(message: string, durationMs: number): void;
  logError(message: string, error: unknown): void;
}

export class DebugNotes<F> {
  // Where each live job's lines begin. Set at its first event and dropped at
  // its last, so it only ever holds jobs that are running.
  private readonly marks = new Map<string, number>();

  constructor(private readonly deps: DebugNoteDeps<F>) {}

  /**
   * Every runner event, with the log mark taken before the host logged anything for it. Resolves once
   * the logs are written down; the host does not wait for that.
   */
  async handle(event: JobEvent, mark: number): Promise<void> {
    if (!isOutcome(event)) {
      this.track(event, mark);
      return;
    }
    const since = this.marks.get(event.id) ?? mark;
    this.marks.delete(event.id);
    if (!this.deps.enabled()) {
      return;
    }
    const job = this.deps.job(event.id);
    if (job === undefined) {
      return;
    }
    await this.writeDown(job, event, debugCallout(this.deps.logsSince(since, (text) => this.mask(text))));
  }

  // Applied to everything a note receives (#32): the callout's lines and the debug note's own text.
  private mask(text: string): string {
    return maskSecrets(text, this.deps.secrets());
  }

  // A job's first event marks where its lines begin; `run-ended` follows the
  // outcome and only makes sure nothing is left behind.
  private track(event: Exclude<JobEvent, OutcomeEvent>, mark: number): void {
    if (event.type === "run-ended") {
      this.marks.delete(event.id);
    } else if (!this.marks.has(event.id)) {
      this.marks.set(event.id, mark);
    }
  }

  // Onto the job's own note when it has one, otherwise into a note of their own.
  private async writeDown(job: DebugNoteJob, event: OutcomeEvent, callout: string): Promise<void> {
    const note = job.notePath === undefined ? null : this.deps.vault.getFile(job.notePath);
    if (note === null) {
      await this.writeDebugNote(job, event, callout);
      return;
    }
    await this.append(note, callout);
  }

  // Through vault.process, the read-modify-write that is atomic against the
  // editor: the note is usually open by now, and may be mid-edit.
  private async append(note: F, callout: string): Promise<void> {
    try {
      await this.deps.vault.process(note, (data) => data + callout);
    } catch (error) {
      this.deps.logError("Could not append the debug information to the note:", error);
    }
  }

  // The legacy error note, on a free path (#31): `vault.create` does not
  // auto-version, and a video that fails twice derives the same title — most
  // often the shared fallback title of a job that never got its own.
  private async writeDebugNote(job: DebugNoteJob, event: OutcomeEvent, callout: string): Promise<void> {
    const content = this.mask(`# ${job.title}\n\n> [!error] ${outcomeText(event)}\n\n**URL:** ${job.url}`) + callout;
    try {
      if (job.folder !== "") {
        await this.deps.ensureFolder(job.folder);
      }
      const base = `${job.folder !== "" ? `${job.folder}/` : ""}${sanitizeFilename(job.title)}.md`;
      const path = nextFreePath(base, (candidate) => this.deps.vault.getFile(candidate) !== null, this.deps.normalizePath);
      await this.deps.vault.create(path, content);
      this.deps.notify(t("notice.debugNote.created", { file: path.slice(path.lastIndexOf("/") + 1) }), 8000);
    } catch (error) {
      this.deps.logError("Failed to create error note:", error);
      const reason = event.type === "failed" || event.type === "interrupted" ? event.error : outcomeText(event);
      this.deps.notify(t("notice.debugNote.failed", { error: reason }), 5000);
    }
  }
}
