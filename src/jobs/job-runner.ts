import {
  MAX_STAGE_ATTEMPTS,
  createJobRecord,
  deriveNotePath,
  fnv1a64Hex,
  normalizeRecordPaths,
  type BillingRisk,
  type BlockedReason,
  type JobStage,
  type NoteJobRecord,
  type NotePathSettings,
  type PathNormalizer,
  type TranslationSettings,
} from "./job-record";
import type { JobStore } from "./job-store";
import { HEARTBEAT_INTERVAL_MS, classifyOnResume, type ResumeDecision, type VaultProbe } from "./job-planner";

// Executes a job stage by stage. Still Obsidian-free: every effect (network,
// LLM, vault) is an injected stage function, and the clock and timers come
// from deps. Three rules make a run survive suspension, kill and restart:
//  - persist BEFORE every stage call (the record always knows what may
//    already have been spent), and again after it settles;
//  - fence every side effect with the record's `generation` (F2): after
//    EVERY await the record is re-read from the store and the run gives up
//    silently if it no longer owns the job;
//  - claim the note path + a content fingerprint before vault.create (F1/F4)
//    so ownership of a note that landed during a crash is provable later.

/** Thrown by a stage to mark the job FAILED (bad URL, no captions, template missing) rather than interrupted. */
export class PermanentJobError extends Error {}
/** Thrown by addTimestamps / translateNote when the note's content changed between read and write (F5). */
export class NoteChangedError extends Error {}
/**
 * Thrown by renderNote when the host rendered a path other than the record's frozen target. A
 * code/config condition, never "this video can never work": the runner BLOCKS the job (path-drift,
 * resumable at summary) instead of failing it (#3 final review C1).
 */
export class PathDriftError extends Error {}

export interface JobStages {
  fetchTranscript(record: NoteJobRecord): Promise<{ transcript: string; title: string }>;
  /** Cheap precheck run BEFORE the paid summary: is the template engine available right now? */
  canRenderNote(): boolean;
  summarize(record: NoteJobRecord, transcript: string): Promise<string>;
  renderNote(record: NoteJobRecord, input: { transcript: string; summary: string; title: string }): Promise<string>;
  createNote(path: string, content: string): Promise<void>;
  /** Reads the note, calls the LLM, writes through a guarded atomic process; throws NoteChangedError if the note changed. */
  addTimestamps(record: NoteJobRecord, notePath: string): Promise<void>;
  /**
   * Reads the note, translates it into the RECORD's frozen `translation` target, writes through a guarded
   * atomic process; throws NoteChangedError if the note changed and rethrows LLM failures (never swallowed).
   */
  translateNote(record: NoteJobRecord, notePath: string): Promise<void>;
}

export interface RunnerVault {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | undefined>;
}

export interface RunnerDeadlines {
  transcriptMs: number;
  llmMs: number;
  vaultMs: number;
}
export const DEFAULT_DEADLINES: RunnerDeadlines = { transcriptMs: 90_000, llmMs: 600_000, vaultMs: 30_000 };

/**
 * `timestamps-skipped` (#3 D2 legacy parity): the job's own flags (fast summary /
 * addTimestampLinks:false) skipped the timestamps pass, so a translation was never
 * frozen and never attempted either — only ever paired with timestampsSkipped:
 * "user-choice" on `translationSkipped`.
 */
export type SkipReason = "note-changed" | "user-choice" | "timestamps-skipped";

export type JobEvent =
  | { type: "progress"; id: string; stage: JobStage; message: string }
  | { type: "done"; id: string; notePath: string; timestampsSkipped?: SkipReason; translationSkipped?: SkipReason }
  | { type: "interrupted"; id: string; prompt: RecoveryPrompt }
  | { type: "failed"; id: string; error: string }
  | { type: "cancelled"; id: string };

/** Runner-level ask-user reasons: the persisted block reasons (a record another installation owns is never asked about — it is ignored). */
export type RunnerAskReason = BlockedReason;

/** The planner's decision, plus runner-level reasons the pure planner cannot know. */
export type RecoveryPrompt =
  | ResumeDecision
  | { action: "ask-user"; reason: RunnerAskReason; stage: JobStage; canFinishWithoutTimestamps: boolean; interruption: "unknown" };

/**
 * One record `closeOwnRuns` closed, plus a one-time vault probe (#3 batch G item 7): `noteMayExist` is
 * true only when `notePath` is unset, `claimedNotePath` is set, and a file was found there at close time —
 * the note-creating crash window, where a note may have landed at the claimed path without the record ever
 * learning it. Riding on the drained summary (not the record) keeps this out of the persisted schema.
 */
export interface ClosedOnColdStart {
  record: NoteJobRecord;
  noteMayExist: boolean;
}

export interface RunnerDeps {
  store: JobStore;
  stages: JobStages;
  vault: RunnerVault;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  notePathSettings(): NotePathSettings;
  /** Live translate settings, already reduced to "the pair to freeze, or undefined for en/US" (translationSettingsFrom). */
  translationSettings(): TranslationSettings | undefined;
  /** The host's path normalizer (Obsidian's `normalizePath`); applied wherever a note path is derived, stored or compared. */
  normalizePath: PathNormalizer;
  /** This device+vault's stable id (per-vault localStorage, never data.json): only this installation's records are recovered, listed or closed here. */
  installationId(): string;
  transcriptBilling(): BillingRisk;
  generateId(): string;
  deadlines?: Partial<RunnerDeadlines>;
  onEvent(event: JobEvent): void;
}

export interface SubmitInput {
  url: string;
  videoId: string;
  folder: string;
  customTitle: string;
  useFastSummary: boolean;
  /** Frozen on the record like useFastSummary; false skips the timestamps stage (legacy modal parity). */
  addTimestampLinks?: boolean;
}
export type SubmitResult =
  | { kind: "started"; id: string }
  | { kind: "already-running"; id: string }
  | { kind: "recovery"; record: NoteJobRecord; prompt: RecoveryPrompt };

export interface ResumeOptions {
  confirmed: boolean;
  /** Finish now with no further LLM call: skips the timestamps pass and/or the translation, whichever is still pending. */
  finishWithoutTimestamps?: boolean;
}

type ResumeResult = { kind: "resumed" } | { kind: "prompt"; prompt: RecoveryPrompt } | { kind: "missing" };
type RecoveredPrompts = Array<{ id: string; prompt: RecoveryPrompt }>;

export interface RecoverOptions {
  /**
   * Cold start: the process that ran this installation's jobs is gone, and a job lives and dies with
   * its instance — every non-terminal record it owns is closed (failed / app-closed), nothing is resumed.
   */
  coldStart?: boolean;
}

type AttemptsKey = keyof NoteJobRecord["attempts"];
type CalledStage = "transcript" | "summary" | "timestamps" | "translation";

// The outcome of one raced stage call. "timeout" means the deadline fired
// first; the underlying promise is still dangling and may settle later.
type Settled<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

// Per-run state that must NOT reach the record: the transcript text lives
// here (memory only) for as long as the run loop is alive. A resumed run
// starts with no transcript and re-fetches it.
interface RunContext {
  confirmed: boolean;
  transcript?: { text: string; title: string };
  /** Why this run skipped the timestamps pass, carried to the done event of a later translation stage. */
  timestampsSkipped?: SkipReason;
}

interface Heartbeat {
  handle: unknown;
  stopped: boolean;
}

interface ActiveRun {
  gen: number;
  heartbeat: Heartbeat;
  /** Armed deadline timers of this run's in-flight stage calls (race()); cleared with the run. */
  deadlines: Set<unknown>;
}

// Ask-user reasons after which the note content must be regenerated: the
// summary text is never persisted, so the only re-entry point is "summary".
const REGENERATE_REASONS: ReadonlySet<string> = new Set([
  "note-collision",
  "claim-unresolved",
  "note-missing",
  "path-drift",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attemptsKeyFor(stage: CalledStage): AttemptsKey {
  return stage;
}

// Record-scoped, frozen at submit (F1/F4): true when this job's own flags
// mean the timestamps pass never runs for it — the legacy modal skipped the
// timestamps pass in fast-summary mode and when timestamp links were turned
// off. `addTimestampLinks` absent means true (a record older than the
// field). Used both to gate freezing a translation target (#3 D2: no frozen
// translation the job will never bill for) and to gate the timestamps stage
// itself.
function skipsTimestamps(record: NoteJobRecord): boolean {
  return record.useFastSummary || record.addTimestampLinks === false;
}

// Paid budgets a resume may not bypass, keyed by the stage it would start
// from. note-creating re-runs the summary; transcript is gated by the
// planner (a clean, free checkpoint stays resumable).
function paidAttemptsKeyFor(stage: JobStage): AttemptsKey | undefined {
  switch (stage) {
    case "summary":
    case "note-creating":
      return "summary";
    case "timestamps":
      return "timestamps";
    case "translation":
      return "translation";
    case "transcript":
    case "note-created":
    case "done":
      return undefined;
  }
}

const LIVE_PROMPT: RecoveryPrompt = { action: "nothing", why: "live" };

/** Terminal = nothing left to run: a done/cancelled/failed status, or the done stage. */
export function isTerminal(record: NoteJobRecord): boolean {
  return (
    record.status === "done" || record.status === "cancelled" || record.status === "failed" || record.stage === "done"
  );
}

const PROGRESS_MESSAGES: Record<CalledStage, string> = {
  transcript: "Fetching transcript",
  summary: "Summarizing transcript",
  timestamps: "Adding timestamps",
  translation: "Translating note",
};

function blockedPrompt(reason: RunnerAskReason, stage: JobStage): RecoveryPrompt {
  return { action: "ask-user", reason, stage, canFinishWithoutTimestamps: false, interruption: "unknown" };
}

export class JobRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly deadlines: RunnerDeadlines;
  private recovering: Promise<RecoveredPrompts> | undefined;
  private recoveringColdStart = false;
  private coldStartQueued = false;
  /** Records closed by cold-start passes since the host last drained them (its one Notice). */
  private closedOnColdStart: ClosedOnColdStart[] = [];
  // Set by stopAll(): the plugin is unloading. guard() is the single
  // chokepoint every stage re-checks after every await, so one flag there
  // fences every late completion of every in-process run.
  private stopped = false;

  constructor(private readonly deps: RunnerDeps) {
    this.deadlines = {
      transcriptMs: deps.deadlines?.transcriptMs ?? DEFAULT_DEADLINES.transcriptMs,
      llmMs: deps.deadlines?.llmMs ?? DEFAULT_DEADLINES.llmMs,
      vaultMs: deps.deadlines?.vaultMs ?? DEFAULT_DEADLINES.vaultMs,
    };
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /**
   * Plugin unload: stops every heartbeat timer and fences every in-process run so a completion that
   * lands later applies no side effect (no store write, no vault write, no event). Persisted status is
   * NOT changed — the records stay `running`, and the next cold start (`recoverAll({ coldStart: true })`)
   * closes them exactly as it would after a kill.
   */
  stopAll(): void {
    this.stopped = true;
    for (const run of this.active.values()) {
      this.stopHeartbeat(run.heartbeat);
      this.clearDeadlines(run);
    }
    this.active.clear();
  }

  /**
   * Classification for the recovery UI: `live` for a run alive in this process, the same prompt
   * `recoverAll` / `resume` would act on otherwise, undefined for an unknown id or another
   * installation's record (never listed here). Probes the vault but never bumps or starts anything;
   * the sole write it may make is the one-time, idempotent re-normalization of a legacy record's
   * stored paths (see promptForRecord).
   */
  async promptFor(id: string): Promise<RecoveryPrompt | undefined> {
    const record = this.deps.store.get(id);
    if (record === undefined || !this.owns(record)) {
      return undefined;
    }
    if (this.isActive(id)) {
      return LIVE_PROMPT;
    }
    return this.promptForRecord(record);
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    // Another installation's in-progress job for this video is its own
    // business (never listed here): it neither blocks nor is taken over.
    const existing = this.deps.store.findByVideoId(input.videoId);
    if (existing !== undefined && this.owns(existing)) {
      if (this.isActive(existing.id)) {
        return { kind: "already-running", id: existing.id };
      }
      return { kind: "recovery", record: existing, prompt: await this.promptForRecord(existing) };
    }
    const now = this.deps.now();
    const record = createJobRecord({
      id: this.deps.generateId(),
      url: input.url,
      videoId: input.videoId,
      folder: input.folder,
      customTitle: input.customTitle,
      useFastSummary: input.useFastSummary,
      addTimestampLinks: input.addTimestampLinks,
      installationId: this.deps.installationId(),
      transcriptBilling: this.deps.transcriptBilling(),
      now,
    });
    // The store applies the upsert in memory synchronously; start the run
    // BEFORE awaiting its flush so there is no window in which the record is
    // `running` but not active — a concurrent cold-start closing pass would
    // otherwise read it as a dead run and close it.
    const flushed = this.deps.store.upsert(record, now);
    this.start(record.id, record.generation, "transcript", { confirmed: false });
    await flushed;
    return { kind: "started", id: record.id };
  }

  /** Classifies; if the prompt requires confirmation and !confirmed, returns the prompt without side effects. Otherwise bumps generation and runs. Another installation's record reads as missing. */
  async resume(id: string, options: ResumeOptions): Promise<ResumeResult> {
    const record = this.deps.store.get(id);
    if (record === undefined || !this.owns(record)) {
      return { kind: "missing" };
    }
    const prompt = await this.promptForRecord(record);
    return this.resumeWith(id, record.generation, prompt, options);
  }

  /** A record from another installation (or from before installation tagging) is that installation's business: never listed, closed, resumed or discarded here. */
  private owns(record: NoteJobRecord): boolean {
    return record.installationId === this.deps.installationId();
  }

  /** The records closed by cold-start passes since the last call; cleared on read (the host shows them once). */
  drainClosedOnColdStart(): ClosedOnColdStart[] {
    const closed = this.closedOnColdStart;
    this.closedOnColdStart = [];
    return closed;
  }

  // status cancelled, generation++, heartbeat stopped. An in-flight native
  // request cannot be aborted: if the stage was note-creating the create may
  // still land, so the record keeps its claim fields as evidence of what it
  // owned. discard() never deletes notes.
  async cancel(id: string): Promise<void> {
    const record = this.deps.store.get(id);
    if (record === undefined || !this.owns(record) || isTerminal(record)) {
      return;
    }
    this.stopRun(id);
    record.status = "cancelled";
    record.generation += 1;
    record.interruption = "cancelled";
    // promptForRecord checks `blocked` BEFORE the planner's terminal rule: an
    // uncleared block would still render a live Resume on a cancelled record.
    delete record.blocked;
    await this.deps.store.upsert(record, this.deps.now());
    this.deps.onEvent({ type: "cancelled", id });
  }

  /** Removes the record; never deletes notes. A live loop loses the guard (record missing) and exits. */
  async discard(id: string): Promise<void> {
    const record = this.deps.store.get(id);
    if (record === undefined || !this.owns(record)) {
      return;
    }
    this.stopRun(id);
    await this.deps.store.remove(id);
  }

  /**
   * Recovery entry point (cold start / visibility / manual). Skips jobs whose run loop is alive in this
   * process. Overlapping calls (visibilitychange + manual, a double tap) coalesce behind the one in flight
   * so a job can never be auto-resumed twice. A coldStart request arriving while a plain pass is in flight
   * is not dropped: one follow-up cold-start pass runs after it, and every waiter gets that pass's result.
   */
  recoverAll(options: RecoverOptions = {}): Promise<RecoveredPrompts> {
    if (this.recovering === undefined) {
      // A request queued in the microtask window between the previous pass
      // completing and its finally reaction is honoured by the fresh pass.
      const coldStart = options.coldStart === true || this.coldStartQueued;
      this.coldStartQueued = false;
      this.recoveringColdStart = coldStart;
      this.recovering = this.recoverPasses(coldStart).finally(() => {
        this.recovering = undefined;
      });
    } else if (options.coldStart === true && !this.recoveringColdStart) {
      this.coldStartQueued = true;
      // Normally the in-flight recoverPasses loop consumes the queue. If it
      // had already checked it (the completion→finally microtask window),
      // the flag is still set when the pass settles: run the follow-up here
      // so this caller is served too, not merely the next one.
      return this.recovering.then((prompts) => (this.coldStartQueued ? this.recoverAll({ coldStart: true }) : prompts));
    }
    return this.recovering;
  }

  private async recoverPasses(coldStart: boolean): Promise<RecoveredPrompts> {
    let prompts = await this.recoverAllOnce({ coldStart });
    while (this.coldStartQueued) {
      this.coldStartQueued = false;
      this.recoveringColdStart = true;
      prompts = await this.recoverAllOnce({ coldStart: true });
    }
    return prompts;
  }

  private async recoverAllOnce(options: RecoverOptions): Promise<RecoveredPrompts> {
    if (options.coldStart === true) {
      // Nothing is left to classify: every own non-terminal record is now
      // terminal, and foreign records are never classified.
      await this.closeOwnRuns();
      return [];
    }
    const prompts: RecoveredPrompts = [];
    for (const listed of this.deps.store.list()) {
      if (isTerminal(listed) || this.isActive(listed.id) || !this.owns(listed)) {
        continue;
      }
      const prompt = await this.promptForRecord(listed);
      // continue / auto-resume / adopt-note carry no duplicate-billing risk
      // by construction (promptFor already turned a paid transcript re-fetch
      // into an ask-user prompt), so they run unattended.
      if (prompt.action === "ask-user") {
        prompts.push({ id: listed.id, prompt });
      } else if (prompt.action !== "nothing") {
        await this.resumeWith(listed.id, listed.generation, prompt, { confirmed: false });
      }
    }
    return prompts;
  }

  // A job lives and dies with the Obsidian instance that started it. On a
  // cold start every non-terminal record THIS installation owns belonged to
  // a process that is gone, so it is closed: failed / app-closed, no call
  // pending, and notePath, the claim fields, attempts and lastError kept as
  // evidence of what was done (and possibly billed). A run active in this
  // process (submitted while the pass was in flight) is not a dead run. A
  // record owned by another installation may be live on that device when
  // data.json is synced: it is left untouched. A pre-tagging record (no
  // installationId) can never be either — it is removed instead (#3 batch G
  // item 1), see below.
  private async closeOwnRuns(): Promise<void> {
    for (const listed of this.deps.store.list()) {
      // A record from before installation tagging can never be matched to an
      // owner again (owns() always says no): instead of leaving it invisible
      // in data.json forever, cold start drops it once. It is cleanup, not a
      // closure — it never joins the drained list (no "interrupted when
      // Obsidian closed" Notice for a job this installation never owned).
      if (listed.installationId === undefined) {
        await this.deps.store.remove(listed.id);
        continue;
      }
      if (isTerminal(listed) || !this.owns(listed) || this.isActive(listed.id)) {
        continue;
      }
      const record = this.deps.store.get(listed.id);
      if (record === undefined || isTerminal(record) || this.isActive(record.id)) {
        continue;
      }
      record.status = "failed";
      record.interruption = "app-closed";
      this.clearFlight(record);
      delete record.blocked;
      // Probed once, at close time: a note may have landed at the claimed
      // path even though this record never learned it (the crash window
      // right after vault.create started). Only relevant when notePath is
      // still unset — once it is set, the outcome is already known.
      const claimedNotePath = record.claimedNotePath;
      const noteMayExist =
        record.notePath === undefined &&
        claimedNotePath !== undefined &&
        (await this.deps.vault.exists(this.deps.normalizePath(claimedNotePath)));
      await this.deps.store.upsert(record, this.deps.now());
      this.closedOnColdStart.push({ record, noteMayExist });
    }
  }

  // ---- recovery -----------------------------------------------------------

  // `record.blocked ? ask-user(blocked) : classifyOnResume(...)`, with two
  // runner-level refinements the pure planner cannot make: a template-engine
  // block is a live condition, re-checked so a cleared block is not treated
  // as a paid retry; and a clean summary continue whose transcript re-fetch
  // would be billed is surfaced as a prompt instead of run unattended.
  private async promptForRecord(record: NoteJobRecord): Promise<RecoveryPrompt> {
    // Records frozen before paths were normalized at the point of writing
    // (NFD from sanitizeFilename) would miss Obsidian's NFC index at every
    // probe: normalize before classifying, and persist the normalized paths
    // once (idempotent). The write goes to a fresh read of the record, not
    // the caller's copy, so it can only ever rewrite the three paths.
    if (normalizeRecordPaths(record, this.deps.normalizePath) && !this.isActive(record.id)) {
      const fresh = this.deps.store.get(record.id);
      if (fresh !== undefined && normalizeRecordPaths(fresh, this.deps.normalizePath)) {
        await this.deps.store.upsert(fresh, this.deps.now());
      }
    }
    if (record.blocked !== undefined) {
      const cleared = record.blocked === "templater-unavailable" && this.deps.stages.canRenderNote();
      if (!cleared) {
        return blockedPrompt(record.blocked, record.stage);
      }
    }
    return this.refine(await this.classify(record));
  }

  private async classify(record: NoteJobRecord): Promise<ResumeDecision> {
    const probe = await this.buildProbe(record);
    return classifyOnResume(record, probe, this.deps.now());
  }

  // The planner judges what may already have been spent from the record's
  // frozen billing; whether the NEXT fetch will be billed is a live question
  // (a key configured after the job was created makes it paid), so any
  // unattended decision that re-fetches the transcript is re-checked here.
  private refine(decision: ResumeDecision): RecoveryPrompt {
    if (this.deps.transcriptBilling() === "free") {
      return decision;
    }
    if (decision.action === "continue" && decision.fromStage === "summary") {
      return blockedPrompt("paid-refetch-required", "summary");
    }
    if (decision.action === "auto-resume") {
      return blockedPrompt("paid-refetch-required", decision.fromStage);
    }
    return decision;
  }

  // The planner's probe is synchronous; pre-resolve the only three paths it
  // may ask about. Key present = exists; value = content (undefined when the
  // file exists but could not be read, which rule 5 treats as unresolved).
  private async buildProbe(record: NoteJobRecord): Promise<VaultProbe> {
    const map = new Map<string, string | undefined>();
    for (const path of new Set([record.notePath, record.claimedNotePath, record.targetNotePath])) {
      if (path !== undefined && (await this.deps.vault.exists(path))) {
        map.set(path, await this.deps.vault.read(path));
      }
    }
    return { exists: (path) => map.has(path), content: (path) => map.get(path) };
  }

  // `promptGen` is the generation the prompt was computed from. Two callers
  // racing on the same job (a double tap, visibilitychange + manual resume)
  // both compute a prompt at gen N; only the first to bump the record wins,
  // the other sees gen N+1 and reports the job as live. Idempotent by
  // construction, so a duplicate paid run cannot start.
  private async resumeWith(
    id: string,
    promptGen: number,
    prompt: RecoveryPrompt,
    options: ResumeOptions,
  ): Promise<ResumeResult> {
    if (prompt.action === "nothing") {
      return { kind: "prompt", prompt };
    }
    const rawNotePath = prompt.action === "adopt-note" ? prompt.notePath : this.deps.store.get(id)?.notePath;
    const notePath = rawNotePath === undefined ? undefined : this.deps.normalizePath(rawNotePath);
    const canFinish =
      options.finishWithoutTimestamps === true && notePath !== undefined && (await this.deps.vault.exists(notePath));
    // promptFor (and the probe above) awaited the vault: re-read before
    // deciding anything.
    const record = this.deps.store.get(id);
    if (record === undefined) {
      return { kind: "missing" };
    }
    if (record.generation !== promptGen) {
      return { kind: "prompt", prompt: LIVE_PROMPT };
    }
    if (canFinish && notePath !== undefined) {
      // No LLM call: finishing without the pending pass(es) is allowed
      // whatever the prompt said, including attempts-exhausted. At the
      // translation checkpoint the timestamps pass is already on disk, so
      // only the translation is reported skipped.
      this.stopRun(id);
      record.generation += 1;
      this.clearFlight(record);
      delete record.blocked;
      delete record.interruption;
      record.notePath = notePath;
      normalizeRecordPaths(record, this.deps.normalizePath);
      const atTranslation = record.stage === "translation";
      await this.finish(record, {
        timestampsSkipped: atTranslation ? undefined : "user-choice",
        translationSkipped: record.translation === undefined ? undefined : "user-choice",
      });
      return { kind: "resumed" };
    }
    if (prompt.action === "ask-user") {
      // The retry budget is final, even with confirmed: true (F6).
      if (prompt.reason === "attempts-exhausted" || !options.confirmed) {
        return { kind: "prompt", prompt };
      }
    }
    const start = this.startStageFor(record, prompt);
    // A prompt that is not itself attempts-exhausted (note-missing, a
    // collision block, ...) can still lead back into a paid stage whose
    // budget is spent; the budget wins over confirmation (F6).
    const budgetKey = paidAttemptsKeyFor(start);
    if (budgetKey !== undefined && record.attempts[budgetKey] >= MAX_STAGE_ATTEMPTS) {
      return {
        kind: "prompt",
        prompt: {
          action: "ask-user",
          reason: "attempts-exhausted",
          stage: start,
          canFinishWithoutTimestamps: false,
          interruption: "unknown",
        },
      };
    }
    this.stopRun(id);
    record.generation += 1;
    record.status = "running";
    this.clearFlight(record);
    delete record.blocked;
    delete record.interruption;
    if (prompt.action === "adopt-note") {
      record.notePath = prompt.notePath;
      record.stage = "note-created";
    }
    // Run start: every stored path is normalized before any stage reads it
    // (older records; idempotent for records written after this fix).
    normalizeRecordPaths(record, this.deps.normalizePath);
    const gen = record.generation;
    await this.deps.store.upsert(record, this.deps.now());
    // The flush awaited above is a window for cancel/discard: start only
    // if the bumped record is still ours.
    if (this.guard(id, gen) === undefined) {
      return { kind: "prompt", prompt: LIVE_PROMPT };
    }
    this.start(id, gen, start, { confirmed: options.confirmed });
    return { kind: "resumed" };
  }

  private startStageFor(record: NoteJobRecord, prompt: RecoveryPrompt): JobStage {
    switch (prompt.action) {
      case "continue":
      case "auto-resume":
        return prompt.fromStage;
      case "adopt-note":
        return "timestamps"; // = nextStage() of a note-created record
      case "ask-user":
        return REGENERATE_REASONS.has(prompt.reason) ? "summary" : prompt.stage;
      case "nothing":
        return record.stage;
    }
  }

  // ---- run loop -----------------------------------------------------------

  private start(id: string, gen: number, from: JobStage, ctx: RunContext): void {
    const heartbeat: Heartbeat = { handle: undefined, stopped: false };
    this.active.set(id, { gen, heartbeat, deadlines: new Set() });
    this.armHeartbeat(id, gen, heartbeat);
    void this.run(id, gen, from, ctx, heartbeat).finally(() => {
      this.stopHeartbeat(heartbeat);
      // Only this run's own entry: a resume may already have replaced it.
      if (this.active.get(id)?.gen === gen) {
        this.active.delete(id);
      }
    });
  }

  private async run(id: string, gen: number, from: JobStage, ctx: RunContext, heartbeat: Heartbeat): Promise<void> {
    try {
      let stage: JobStage | undefined = from;
      while (stage !== undefined) {
        stage = await this.runStage(id, gen, stage, ctx);
      }
    } catch (error) {
      // A store rejection (metadata-only violation, disk failure) escapes
      // the stage functions. Stop heartbeating (a dead loop must not look
      // live) and, best effort, leave the record interrupted so recovery
      // sees it now rather than after the stale window — keeping inFlight
      // and the claim fields, which still say what may have been spent.
      this.stopHeartbeat(heartbeat);
      const message = errorMessage(error);
      const record = this.guard(id, gen);
      if (record !== undefined) {
        record.status = "interrupted";
        record.interruption = "unknown";
        record.lastError = message;
        try {
          await this.deps.store.upsert(record, this.deps.now());
        } catch {
          // The store itself is failing; the in-memory copy is already
          // interrupted and the event below is all that can be done.
        }
      }
      this.deps.onEvent({ type: "failed", id, error: message });
    }
  }

  /** Runs one stage; returns the next stage to run, or undefined when the loop must exit. */
  private runStage(id: string, gen: number, stage: JobStage, ctx: RunContext): Promise<JobStage | undefined> {
    switch (stage) {
      case "transcript":
        return this.runTranscript(id, gen, ctx);
      case "summary":
      case "note-creating":
        return this.runSummary(id, gen, ctx);
      case "note-created":
        return Promise.resolve("timestamps");
      case "timestamps":
        return this.runTimestamps(id, gen, ctx);
      case "translation":
        return this.runTranslation(id, gen, ctx);
      case "done":
        return Promise.resolve(undefined);
    }
  }

  // guard(id, gen): the stored record exists, is this run's generation and
  // is still running. Every stage re-reads through it after every await; a
  // failed guard means NO side effect and a silent exit.
  private guard(id: string, gen: number): NoteJobRecord | undefined {
    if (this.stopped) {
      return undefined;
    }
    const record = this.deps.store.get(id);
    if (record === undefined || record.generation !== gen || record.status !== "running") {
      return undefined;
    }
    return record;
  }

  // `nested` = re-fetch inside a resumed summary stage: the in-flight markers
  // are persisted but `stage` stays "summary", so a crash mid-re-fetch still
  // reads as "paid summary of unknown completion" — never as a free
  // transcript fetch that cold start would auto-resume straight into a paid
  // summary.
  private async runTranscript(
    id: string,
    gen: number,
    ctx: RunContext,
    nested = false,
  ): Promise<JobStage | undefined> {
    let record = await this.preCall(id, gen, "transcript", this.deadlines.transcriptMs, nested);
    if (record === undefined) {
      return undefined;
    }
    const settled = await this.race(id, gen, this.deps.stages.fetchTranscript(record), this.deadlines.transcriptMs);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (settled.kind !== "ok") {
      if (nested) {
        // The runner knows the paid summary was never called: a settled
        // re-fetch failure leaves a clean summary checkpoint, not a
        // "paid stage in flight" mystery. (An unsettled crash keeps the
        // in-flight markers — that window is still unknown-completion.)
        this.clearFlight(record);
      }
      await this.settleFailure(record, settled);
      return undefined;
    }
    // Freeze the title, the path settings and the target path now (F1/F4):
    // every later decision about this note uses the path derived at this
    // moment, and a nested re-fetch re-derives under the SAME frozen
    // settings, so a setting toggled mid-job can never move the note.
    const title = record.customTitle.trim() || settled.value.title;
    const resolvedTitle = title.trim() === "" ? undefined : title;
    const notePathSettings = record.notePathSettings ?? this.deps.notePathSettings();
    const target = deriveNotePath({ ...record, resolvedTitle }, notePathSettings, this.deps.normalizePath);
    if (target === undefined) {
      await this.fail(record, "no title");
      return undefined;
    }
    ctx.transcript = { text: settled.value.transcript, title };
    // The translation target is frozen ONCE, on the job's first pass through
    // this stage: a nested re-fetch belongs to a job whose translation was
    // already decided, and a setting toggled since must not add (or drop) a
    // paid call. Absent = none (en/US), so there is nothing to write then.
    // Legacy parity (#3 D2): a job whose own flags skip the timestamps pass
    // never freezes a translation target either — the legacy modal only ever
    // translated inside the timestamps pass, so a job that never runs that
    // pass must never bill a translation the previous version never made.
    const translation = nested || skipsTimestamps(record) ? undefined : this.deps.translationSettings();
    const exists = await this.deps.vault.exists(target);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    record.resolvedTitle = resolvedTitle;
    record.notePathSettings = notePathSettings;
    record.targetNotePath = target;
    if (translation !== undefined) {
      record.translation = translation;
    }
    record.stage = "summary";
    this.clearFlight(record);
    if (exists) {
      await this.block(record, "note-collision", `A note already exists at "${target}"`);
      return undefined;
    }
    await this.deps.store.upsert(record, this.deps.now());
    return "summary";
  }

  // Paid: ONE stage until the note is durable (summarize -> render -> claim
  // -> create -> note-created). Nothing produced here is ever persisted
  // except the claim's fingerprint of the exact content about to be written.
  private async runSummary(id: string, gen: number, ctx: RunContext): Promise<JobStage | undefined> {
    let record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    // Free prechecks first, in the order they cost nothing: a note already
    // at the frozen target (a still-colliding job resumed by the user) must
    // not trigger even a billed transcript re-fetch.
    const frozenTarget = record.targetNotePath;
    if (frozenTarget !== undefined && (await this.deps.vault.exists(frozenTarget))) {
      record = this.guard(id, gen);
      if (record === undefined) {
        return undefined;
      }
      await this.block(record, "note-collision", `A note already exists at "${frozenTarget}"`);
      return undefined;
    }
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (!this.deps.stages.canRenderNote()) {
      await this.block(record, "templater-unavailable", "The template engine is not available");
      return undefined;
    }
    // Pre-paid drift check (#3 final review C1): the path the frozen record
    // derives to must still be the frozen target, or nothing is billed. A
    // record frozen before path settings were frozen with it falls back to
    // the live settings, which are frozen onto it by the next persist only
    // once they are known to agree with its target.
    const notePathSettings = record.notePathSettings ?? this.deps.notePathSettings();
    const derived = deriveNotePath(record, notePathSettings, this.deps.normalizePath);
    if (frozenTarget === undefined || derived !== this.deps.normalizePath(frozenTarget)) {
      await this.block(
        record,
        "path-drift",
        `Target path drift: the job owns "${frozenTarget ?? "(none)"}" but its settings derive "${derived ?? "(none)"}"`,
      );
      return undefined;
    }
    if (record.notePathSettings === undefined) {
      record.notePathSettings = notePathSettings;
      await this.deps.store.upsert(record, this.deps.now());
      record = this.guard(id, gen);
      if (record === undefined) {
        return undefined;
      }
    }
    if (ctx.transcript === undefined) {
      // Resumed run: the transcript never leaves memory, so fetch it again —
      // but only unattended when that costs nothing.
      if (this.deps.transcriptBilling() !== "free" && !ctx.confirmed) {
        await this.block(record, "paid-refetch-required", "Resuming re-fetches the transcript, which is billed");
        return undefined;
      }
      if ((await this.runTranscript(id, gen, ctx, true)) === undefined) {
        return undefined;
      }
      record = this.guard(id, gen);
      if (record === undefined) {
        return undefined;
      }
    }
    const transcript = ctx.transcript;
    if (transcript === undefined) {
      return undefined;
    }
    record = await this.preCall(id, gen, "summary", this.deadlines.llmMs);
    if (record === undefined) {
      return undefined;
    }
    const summarized = await this.race(id, gen, this.deps.stages.summarize(record, transcript.text), this.deadlines.llmMs);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (summarized.kind !== "ok") {
      await this.settleFailure(record, summarized);
      return undefined;
    }
    // renderNote runs inside the summary's in-flight window (no second
    // pre-call persist): a crash here is still "summary paid, note not
    // durable", which is exactly what the in-flight summary record says.
    const title = record.resolvedTitle ?? transcript.title;
    const rendered = await this.race(
      id,
      gen,
      this.deps.stages.renderNote(record, { transcript: transcript.text, summary: summarized.value, title }),
      this.deadlines.vaultMs,
    );
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (rendered.kind === "error" && rendered.error instanceof PathDriftError) {
      // The adapter's defence fired after the paid summary: a config/code
      // condition, so block (resumable at summary), never fail (#3 C1).
      await this.block(record, "path-drift", errorMessage(rendered.error));
      return undefined;
    }
    if (rendered.kind !== "ok") {
      await this.settleFailure(record, rendered);
      return undefined;
    }
    const content = rendered.value;
    const target = record.targetNotePath;
    if (target === undefined) {
      await this.fail(record, "no target note path");
      return undefined;
    }
    // Claim (F1/F4): the path and an exact-content fingerprint go to disk
    // BEFORE vault.create, so a crash inside the create window leaves
    // evidence of what this job owns.
    const exists = await this.deps.vault.exists(target);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (exists) {
      await this.block(record, "note-collision", `A note appeared at "${target}" after the summary was already paid for`);
      return undefined;
    }
    let now = this.deps.now();
    record.claimedNotePath = target;
    record.claimedAt = now;
    record.claimedContentHash = fnv1a64Hex(content);
    record.claimedContentLength = content.length;
    record.stage = "note-creating";
    record.inFlight = true;
    record.inFlightSince = now;
    record.deadlineAt = now + this.deadlines.vaultMs;
    await this.deps.store.upsert(record, now);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    this.deps.onEvent({ type: "progress", id, stage: "note-creating", message: "Creating note" });
    const created = await this.race(id, gen, this.deps.stages.createNote(target, content), this.deadlines.vaultMs);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (created.kind !== "ok") {
      await this.settleFailure(record, created);
      return undefined;
    }
    now = this.deps.now();
    record.notePath = target;
    record.stage = "note-created";
    this.clearFlight(record);
    await this.deps.store.upsert(record, now);
    return "timestamps";
  }

  private async runTimestamps(id: string, gen: number, ctx: RunContext): Promise<JobStage | undefined> {
    let record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    const notePath = record.notePath;
    if (notePath === undefined) {
      await this.fail(record, "no note path");
      return undefined;
    }
    // Record-scoped, frozen at submit (F1/F4): the legacy modal skipped the
    // timestamp pass in fast-summary mode and when timestamp links were
    // turned off, so this stage makes no LLM call, no attempt bump and no
    // timestamps progress event. Every entry into this stage (note-created,
    // adopt-note, a continue from timestamps) passes here. A skip here also
    // skips a frozen translation (#3 D2 legacy parity): the legacy modal only
    // ever translated inside the timestamps pass.
    if (skipsTimestamps(record)) {
      ctx.timestampsSkipped = "user-choice";
      return this.afterTimestamps(record, ctx);
    }
    record = await this.preCall(id, gen, "timestamps", this.deadlines.llmMs);
    if (record === undefined) {
      return undefined;
    }
    const settled = await this.race(id, gen, this.deps.stages.addTimestamps(record, notePath), this.deadlines.llmMs);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (settled.kind === "error" && settled.error instanceof NoteChangedError) {
      // The user is editing the note (F5): the job ends here, translation
      // included — exactly where the legacy pass stopped too.
      this.clearFlight(record);
      await this.finish(record, { timestampsSkipped: "note-changed" });
      return undefined;
    }
    if (settled.kind !== "ok") {
      await this.settleFailure(record, settled);
      return undefined;
    }
    this.clearFlight(record);
    return this.afterTimestamps(record, ctx);
  }

  // The timestamps outcome is on disk (or was skipped by the record's own
  // flags). Without a frozen translation the job is done; with one, persist
  // a CLEAN translation checkpoint first — from here a crash or a failure
  // resumes at `translation`, and the timestamps pass is never re-billed.
  private async afterTimestamps(record: NoteJobRecord, ctx: RunContext): Promise<JobStage | undefined> {
    if (ctx.timestampsSkipped === "user-choice") {
      // Legacy parity (#3 D2): the job's own flags skipped the timestamps
      // pass, so the translation stage is never entered — the legacy modal
      // only ever translated inside the timestamps pass. `record.translation`
      // is never frozen for such a job (see runTranscript), so this reads the
      // live setting only to NAME why nothing ran in the done event, never to
      // decide whether to bill anything (a legacy record frozen before this
      // fix, whose `translation` still carries a stale value, is covered too).
      const translationSkipped: SkipReason | undefined =
        record.translation !== undefined || this.deps.translationSettings() !== undefined
          ? "timestamps-skipped"
          : undefined;
      await this.finish(record, { timestampsSkipped: ctx.timestampsSkipped, translationSkipped });
      return undefined;
    }
    if (record.translation === undefined) {
      await this.finish(record, { timestampsSkipped: ctx.timestampsSkipped });
      return undefined;
    }
    record.stage = "translation";
    await this.deps.store.upsert(record, this.deps.now());
    return "translation";
  }

  // Paid, its own ledger (attempts.translation, F6). Entered only from a
  // record whose `translation` was frozen at the transcript stage; the frozen
  // pair, never the live settings, reaches the host through the record.
  private async runTranslation(id: string, gen: number, ctx: RunContext): Promise<JobStage | undefined> {
    let record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    const notePath = record.notePath;
    if (notePath === undefined) {
      await this.fail(record, "no note path");
      return undefined;
    }
    if (record.translation === undefined || skipsTimestamps(record)) {
      // record.translation === undefined: unreachable by construction (the
      // stage is entered only when frozen) unless hand-edited — nothing to
      // translate. skipsTimestamps(record): a record persisted before this
      // fix (#3 D2) can already sit at stage "translation" with a stale
      // frozen `translation` and useFastSummary/addTimestampLinks:false; the
      // dispatch loop (runStage) resumes such a record straight into this
      // function, bypassing runTimestamps/afterTimestamps entirely, so the
      // gate has to be re-checked here too — never bill a translation the
      // job's own flags say its timestamps pass never ran to justify.
      const translationSkipped: SkipReason | undefined = record.translation !== undefined ? "timestamps-skipped" : undefined;
      await this.finish(record, { timestampsSkipped: ctx.timestampsSkipped, translationSkipped });
      return undefined;
    }
    record = await this.preCall(id, gen, "translation", this.deadlines.llmMs);
    if (record === undefined) {
      return undefined;
    }
    const settled = await this.race(id, gen, this.deps.stages.translateNote(record, notePath), this.deadlines.llmMs);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (settled.kind === "error" && settled.error instanceof NoteChangedError) {
      this.clearFlight(record);
      await this.finish(record, { timestampsSkipped: ctx.timestampsSkipped, translationSkipped: "note-changed" });
      return undefined;
    }
    if (settled.kind !== "ok") {
      await this.settleFailure(record, settled);
      return undefined;
    }
    this.clearFlight(record);
    await this.finish(record, { timestampsSkipped: ctx.timestampsSkipped });
    return undefined;
  }

  // ---- persistence steps --------------------------------------------------

  /** Pre-call persistence: inFlight, deadline and attempt bump go to disk before the stage runs. Returns the guarded record, or undefined. */
  private async preCall(
    id: string,
    gen: number,
    stage: CalledStage,
    deadlineMs: number,
    keepStage = false,
  ): Promise<NoteJobRecord | undefined> {
    let record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    const now = this.deps.now();
    if (!keepStage) {
      record.stage = stage;
    }
    record.inFlight = true;
    record.inFlightSince = now;
    record.deadlineAt = now + deadlineMs;
    record.attempts[attemptsKeyFor(stage)] += 1;
    await this.deps.store.upsert(record, now);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    this.deps.onEvent({ type: "progress", id, stage, message: PROGRESS_MESSAGES[stage] });
    return record;
  }

  private clearFlight(record: NoteJobRecord): void {
    record.inFlight = false;
    delete record.inFlightSince;
    delete record.deadlineAt;
  }

  private async settleFailure(record: NoteJobRecord, settled: Exclude<Settled<unknown>, { kind: "ok" }>): Promise<void> {
    if (settled.kind === "timeout") {
      // inFlight stays true: the call may still complete out there.
      await this.interrupt(record, "timeout", undefined);
      return;
    }
    if (settled.error instanceof PermanentJobError) {
      await this.fail(record, settled.error.message);
      return;
    }
    await this.interrupt(record, "network", errorMessage(settled.error));
  }

  private async interrupt(record: NoteJobRecord, reason: "timeout" | "network", lastError: string | undefined): Promise<void> {
    record.status = "interrupted";
    record.interruption = reason;
    if (lastError !== undefined) {
      record.lastError = lastError;
    }
    await this.deps.store.upsert(record, this.deps.now());
    // A running record carries no `blocked`, so the planner's decision is
    // the whole prompt here (modulo the paid re-fetch refinement).
    let decision = await this.classify(record);
    if (reason === "timeout" && decision.action === "ask-user") {
      // The planner only sees `now > deadlineAt`; this runner knows firsthand
      // that the deadline is what fired.
      decision = { ...decision, interruption: "timeout" };
    }
    this.deps.onEvent({ type: "interrupted", id: record.id, prompt: this.refine(decision) });
  }

  /** Stops short of a paid call: interrupted, not in flight, with the reason on the record. */
  private async block(record: NoteJobRecord, reason: BlockedReason, lastError: string): Promise<void> {
    record.status = "interrupted";
    record.blocked = reason;
    record.lastError = lastError;
    this.clearFlight(record);
    await this.deps.store.upsert(record, this.deps.now());
    this.deps.onEvent({ type: "interrupted", id: record.id, prompt: blockedPrompt(reason, record.stage) });
  }

  private async fail(record: NoteJobRecord, message: string): Promise<void> {
    record.status = "failed";
    record.lastError = message;
    this.clearFlight(record);
    await this.deps.store.upsert(record, this.deps.now());
    this.deps.onEvent({ type: "failed", id: record.id, error: message });
  }

  private async finish(
    record: NoteJobRecord,
    skipped: { timestampsSkipped?: SkipReason; translationSkipped?: SkipReason },
  ): Promise<void> {
    record.stage = "done";
    record.status = "done";
    await this.deps.store.upsert(record, this.deps.now());
    const notePath = record.notePath ?? "";
    // Skip keys are written only when set (the event's documented shape).
    this.deps.onEvent({
      type: "done",
      id: record.id,
      notePath,
      ...(skipped.timestampsSkipped !== undefined ? { timestampsSkipped: skipped.timestampsSkipped } : {}),
      ...(skipped.translationSkipped !== undefined ? { translationSkipped: skipped.translationSkipped } : {}),
    });
  }

  // ---- deadline race + heartbeat -----------------------------------------

  // Races a stage promise against deps.setTimeout. The settle handler is
  // attached at creation so a late rejection never goes unhandled; after a
  // timeout it only re-runs the guard (which the timeout's own persistence
  // has already made fail) and applies nothing.
  private race<T>(id: string, gen: number, call: Promise<T>, ms: number): Promise<Settled<T>> {
    return new Promise<Settled<T>>((resolve) => {
      let settled = false;
      // Tracked on the run so cancel/discard/resume (stopRun) and unload
      // (stopAll) can disarm a deadline that would otherwise stay pending
      // for up to the stage's full budget.
      const run = this.active.get(id);
      const handle = this.deps.setTimeout(() => {
        run?.deadlines.delete(handle);
        if (!settled) {
          settled = true;
          resolve({ kind: "timeout" });
        }
      }, ms);
      if (run !== undefined && run.gen === gen) {
        run.deadlines.add(handle);
      }
      const accept = (outcome: Settled<T>): void => {
        if (settled) {
          this.guard(id, gen);
          return;
        }
        settled = true;
        run?.deadlines.delete(handle);
        this.deps.clearTimeout(handle);
        resolve(outcome);
      };
      call.then(
        (value) => accept({ kind: "ok", value }),
        (error: unknown) => accept({ kind: "error", error }),
      );
    });
  }

  private armHeartbeat(id: string, gen: number, heartbeat: Heartbeat): void {
    heartbeat.handle = this.deps.setTimeout(() => {
      void this.beat(id, gen, heartbeat);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async beat(id: string, gen: number, heartbeat: Heartbeat): Promise<void> {
    if (heartbeat.stopped) {
      return;
    }
    const record = this.guard(id, gen);
    if (record === undefined) {
      return; // the loop is on its way out; its exit stops this heartbeat
    }
    const now = this.deps.now();
    record.heartbeatAt = now;
    try {
      await this.deps.store.upsert(record, now);
    } catch {
      // A failed heartbeat write is not fatal; the next stage persist
      // surfaces a broken store.
    }
    if (!heartbeat.stopped) {
      this.armHeartbeat(id, gen, heartbeat);
    }
  }

  private stopHeartbeat(heartbeat: Heartbeat): void {
    heartbeat.stopped = true;
    this.deps.clearTimeout(heartbeat.handle);
  }

  private clearDeadlines(run: ActiveRun): void {
    for (const handle of run.deadlines) {
      this.deps.clearTimeout(handle);
    }
    run.deadlines.clear();
  }

  // Stops a run's timers and drops it from `active`. Its loop is fenced by
  // the record (generation bump / status change / removal), not here; a
  // cleared deadline only means a dangling call settles "late" instead of
  // timing out, and a late settle re-runs the guard and applies nothing.
  private stopRun(id: string): void {
    const run = this.active.get(id);
    if (run !== undefined) {
      this.stopHeartbeat(run.heartbeat);
      this.clearDeadlines(run);
      this.active.delete(id);
    }
  }
}
