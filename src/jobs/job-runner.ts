import {
  createJobRecord,
  deriveNotePath,
  type JobStage,
  type NoteJobRecord,
  type NotePathSettings,
  type PathNormalizer,
  type TranslationSettings,
} from "./job-record";
import type { JobStore } from "./job-store";

// Executes a job stage by stage. Still Obsidian-free: every effect (network,
// LLM, vault) is an injected stage function, and the clock and timers come
// from deps.
//
// A run lives and dies inside this process (#10): nothing is recovered, so
// nothing needs to be reconstructible from a record after the fact. What is
// left is the rule that keeps a cancel honest —
//  - fence every side effect with the record's `generation` (F2): after
//    EVERY await the record is re-read from the store and the run gives up
//    silently if it no longer owns the job.
// The store's `upsert` is still awaited at each checkpoint even though it is
// memory-only, because those awaits ARE the windows a cancel lands in; the
// re-read that follows each one is what stops a cancelled job reaching a paid
// call. See job-store.ts, which keeps them async for exactly this reason.

/** Thrown by a stage to mark the job FAILED (bad URL, no captions, template missing) rather than interrupted. */
export class PermanentJobError extends Error {}
/** Thrown by addTimestamps / translateNote when the note's content changed between read and write (F5). */
export class NoteChangedError extends Error {}
/**
 * Thrown by renderNote when the host rendered a path other than the record's frozen target: the live
 * settings moved while the job was under way, so the note would land somewhere its own record does not
 * name. It fails the job (#3 final review C1 kept the check; #10 dropped the block it used to raise,
 * since there is no resume left to be resumable at).
 */
export class PathDriftError extends Error {}

export interface JobStages {
  fetchTranscript(record: NoteJobRecord): Promise<{ transcript: string; title: string }>;
  /** Cheap precheck run BEFORE the paid summary: is the template engine available right now? */
  canRenderNote(): boolean;
  summarize(record: NoteJobRecord, transcript: string): Promise<string>;
  renderNote(record: NoteJobRecord, input: { transcript: string; summary: string; title: string }): Promise<string>;
  /**
   * Creates the note and resolves with the path it ACTUALLY landed on: the adapter derives a free
   * neighbour when `path` is taken (Obsidian's `Vault.create` does not auto-version), so the caller
   * must record the resolved value rather than the path it asked for.
   */
  createNote(path: string, content: string): Promise<string>;
  /** Reads the note, calls the LLM, writes through a guarded atomic process; throws NoteChangedError if the note changed. */
  addTimestamps(record: NoteJobRecord, notePath: string): Promise<void>;
  /**
   * Reads the note, translates it into the RECORD's frozen `translation` target, writes through a guarded
   * atomic process; throws NoteChangedError if the note changed and rethrows LLM failures (never swallowed).
   */
  translateNote(record: NoteJobRecord, notePath: string): Promise<void>;
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
  /**
   * The run stopped without finishing and without a verdict that the video can never work: a timeout,
   * or a transient error. TERMINAL to every consumer — nothing resumes it, so a collection advances
   * past the child (collection-runner.ts) and the progress notice closes (job-progress-notice.ts).
   * The reason lives on the record's `lastError`, not here; no consumer has ever read one off the event.
   */
  | { type: "interrupted"; id: string }
  | { type: "failed"; id: string; error: string }
  | { type: "cancelled"; id: string };

export interface RunnerDeps {
  store: JobStore;
  stages: JobStages;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  notePathSettings(): NotePathSettings;
  /** Live translate settings, already reduced to "the pair to freeze, or undefined for en/US" (translationSettingsFrom). */
  translationSettings(): TranslationSettings | undefined;
  /** The host's path normalizer (Obsidian's `normalizePath`); applied wherever a note path is derived, stored or compared. */
  normalizePath: PathNormalizer;
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
export type SubmitResult = { kind: "started"; id: string } | { kind: "already-running"; id: string };

type CalledStage = "transcript" | "summary" | "timestamps" | "translation";

// The outcome of one raced stage call. "timeout" means the deadline fired
// first; the underlying promise is still dangling and may settle later.
type Settled<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

// Per-run state that never reaches the record: the transcript text lives here
// for as long as the run loop is alive, and dies with it. One run fetches it
// once, at the transcript stage, and every later stage of that same run reads
// it from here.
interface RunContext {
  transcript?: { text: string; title: string };
  /** Why this run skipped the timestamps pass, carried to the done event of a later translation stage. */
  timestampsSkipped?: SkipReason;
}

interface ActiveRun {
  gen: number;
  /** Armed deadline timers of this run's in-flight stage calls (race()); cleared with the run. */
  deadlines: Set<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export class JobRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly deadlines: RunnerDeadlines;
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
   * Plugin unload: stops every armed deadline timer and fences every in-process run so a completion
   * that lands later applies no side effect (no store write, no vault write, no event). The in-memory
   * records are left as they are; they die with the process, along with everything else here.
   */
  stopAll(): void {
    this.stopped = true;
    for (const run of this.active.values()) {
      this.clearDeadlines(run);
    }
    this.active.clear();
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    // The ONE duplicate check left: a video whose run is alive in this process
    // right now. A finished job never blocks a second run of the same URL —
    // that is a second request, and it gets its own note.
    //
    // Terminal BEFORE isActive, deliberately: a job leaves `active` in
    // `run().finally()`, but its terminal event is emitted synchronously from
    // inside a stage that run() is still awaiting, so `isActive` is briefly
    // true for a job that has already finished.
    const existing = this.deps.store.findByVideoId(input.videoId);
    if (existing !== undefined && !isTerminal(existing) && this.isActive(existing.id)) {
      return { kind: "already-running", id: existing.id };
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
      now,
    });
    // The store applies the upsert in memory synchronously; start the run
    // BEFORE awaiting it so the record is never `running` without a live run
    // behind it.
    const started = this.deps.store.upsert(record, now);
    this.start(record.id, record.generation, "transcript");
    await started;
    return { kind: "started", id: record.id };
  }

  // status cancelled, generation++, timers cleared. An in-flight native
  // request cannot be aborted: if the stage was note-creating the create may
  // still land, and the generation fence is what stops the late completion
  // being recorded as this job's note. Notes are never deleted here.
  async cancel(id: string): Promise<void> {
    const record = this.deps.store.get(id);
    if (record === undefined || isTerminal(record)) {
      return;
    }
    this.stopRun(id);
    record.status = "cancelled";
    record.generation += 1;
    await this.deps.store.upsert(record, this.deps.now());
    this.deps.onEvent({ type: "cancelled", id });
  }

  // ---- run loop -----------------------------------------------------------

  private start(id: string, gen: number, from: JobStage): void {
    this.active.set(id, { gen, deadlines: new Set() });
    void this.run(id, gen, from, { transcript: undefined }).finally(() => {
      // Only this run's own entry.
      if (this.active.get(id)?.gen === gen) {
        this.active.delete(id);
      }
    });
  }

  private async run(id: string, gen: number, from: JobStage, ctx: RunContext): Promise<void> {
    try {
      let stage: JobStage | undefined = from;
      while (stage !== undefined) {
        stage = await this.runStage(id, gen, stage, ctx);
      }
    } catch (error) {
      // A store rejection (a metadata-only violation) escapes the stage
      // functions. Best effort: mark the record interrupted so it does not
      // sit in the list saying it is still running, then report the failure.
      const message = errorMessage(error);
      const record = this.guard(id, gen);
      if (record !== undefined) {
        record.status = "interrupted";
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

  private async runTranscript(id: string, gen: number, ctx: RunContext): Promise<JobStage | undefined> {
    let record = await this.preCall(id, gen, "transcript", this.deadlines.transcriptMs);
    if (record === undefined) {
      return undefined;
    }
    const settled = await this.race(id, gen, this.deps.stages.fetchTranscript(record), this.deadlines.transcriptMs);
    record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    if (settled.kind !== "ok") {
      await this.settleFailure(record, settled);
      return undefined;
    }
    // Freeze the title, the path settings and the target path now (F1/F4):
    // every later decision about this note uses the path derived at this
    // moment, so a setting toggled mid-job can never move the note.
    const title = record.customTitle.trim() || settled.value.title;
    const resolvedTitle = title.trim() === "" ? undefined : title;
    const notePathSettings = record.notePathSettings ?? this.deps.notePathSettings();
    const target = deriveNotePath({ ...record, resolvedTitle }, notePathSettings, this.deps.normalizePath);
    if (target === undefined) {
      await this.fail(record, "no title");
      return undefined;
    }
    ctx.transcript = { text: settled.value.transcript, title };
    // The translation target is frozen here, from the live settings, so a
    // setting toggled later in the run can neither add nor drop a paid call.
    // Absent = none (en/US), so there is nothing to write then. Legacy parity
    // (#3 D2): a job whose own flags skip the timestamps pass never freezes a
    // translation target either — the legacy modal only ever translated inside
    // the timestamps pass, so a job that never runs that pass must never bill
    // a translation the previous version never made.
    const translation = skipsTimestamps(record) ? undefined : this.deps.translationSettings();
    record.resolvedTitle = resolvedTitle;
    record.notePathSettings = notePathSettings;
    record.targetNotePath = target;
    if (translation !== undefined) {
      record.translation = translation;
    }
    record.stage = "summary";
    this.clearFlight(record);
    // No occupancy probe: `target` is where this job WANTS the note, and
    // createNote steps to the next free neighbour if something is already
    // there. Two runs of the same URL are two requests, not a duplicate.
    await this.deps.store.upsert(record, this.deps.now());
    return "summary";
  }

  // Paid: ONE stage from the summary to the note existing (summarize ->
  // render -> create -> note-created). Nothing it produces is written down
  // anywhere but the note itself.
  private async runSummary(id: string, gen: number, ctx: RunContext): Promise<JobStage | undefined> {
    let record = this.guard(id, gen);
    if (record === undefined) {
      return undefined;
    }
    // Free precheck first, because it costs nothing: an unavailable template
    // engine means nothing can be rendered, so nothing may be billed.
    const frozenTarget = record.targetNotePath;
    if (!this.deps.stages.canRenderNote()) {
      await this.fail(record, "The template engine is not available");
      return undefined;
    }
    // Pre-paid drift check (#3 final review C1): the path the frozen record
    // derives to must still be the frozen target, or nothing is billed. It
    // catches the live path settings moving between the transcript stage and
    // this one — unrelated to whether anything already occupies the target,
    // which is no longer this runner's business.
    const notePathSettings = record.notePathSettings ?? this.deps.notePathSettings();
    const derived = deriveNotePath(record, notePathSettings, this.deps.normalizePath);
    if (frozenTarget === undefined || derived !== this.deps.normalizePath(frozenTarget)) {
      await this.fail(
        record,
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
    const transcript = ctx.transcript;
    if (transcript === undefined) {
      // Unreachable: the only way into this stage is a transcript stage that
      // just filled ctx. Failing rather than exiting silently keeps a job
      // that somehow got here from sitting at `running` for ever.
      await this.fail(record, "no transcript");
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
    // renderNote runs inside the summary's in-flight window: no second
    // checkpoint, because rendering is free and the record already says a
    // paid summary is in flight.
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
      // The adapter's defence fired after the paid summary: the settings moved
      // under the job. A definite verdict, not a transient one, so it fails
      // rather than reporting itself interrupted (#3 C1 kept the check).
      await this.fail(record, errorMessage(rendered.error));
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
    // The in-flight marker goes in BEFORE createNote, and the awaited upsert
    // that carries it is a window a cancel can land in — the re-read below is
    // what stops a cancelled job creating a note.
    let now = this.deps.now();
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
    // The path the create actually used, which is the target this job asked
    // for unless the adapter stepped past an occupied path to a free
    // neighbour (src/jobs/free-path.ts).
    record.notePath = created.value;
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

  // The timestamps pass has written (or was skipped by the record's own
  // flags). Without a frozen translation the job is done; with one, the
  // record moves to a clean `translation` checkpoint, so the two paid passes
  // stay separately accounted for (F6) rather than one compound stage.
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

  // Paid. Entered only from a record whose `translation` was frozen at the
  // transcript stage; the frozen pair, never the live settings, reaches the
  // host through the record.
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
      // Both arms are defensive, and neither is reachable through the run
      // loop as it stands: this stage is entered only from afterTimestamps,
      // which has already checked both. They are kept because the cost of
      // being wrong is a paid call the job's own frozen flags say must never
      // happen (#3 D2 legacy parity).
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

  // ---- stage checkpoints --------------------------------------------------

  /**
   * Marks the record in flight — stage and deadline — before the stage call runs, so the progress
   * surface reflects the call that is about to happen. The
   * upsert is awaited and the record re-read afterwards: that await is a window a cancel can land in,
   * and the re-read is what stops a cancelled job making the call. Returns the guarded record, or
   * undefined when this run no longer owns the job.
   */
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

  // A transient outcome (a timeout, a network error) is NOT a verdict that
  // this video can never work, so it stays `interrupted` rather than `failed`
  // — the person decides, by submitting the URL again or not.
  private async settleFailure(record: NoteJobRecord, settled: Exclude<Settled<unknown>, { kind: "ok" }>): Promise<void> {
    if (settled.kind === "timeout") {
      // inFlight stays true: the call may still complete out there.
      await this.interrupt(record, undefined);
      return;
    }
    if (settled.error instanceof PermanentJobError) {
      await this.fail(record, settled.error.message);
      return;
    }
    await this.interrupt(record, errorMessage(settled.error));
  }

  private async interrupt(record: NoteJobRecord, lastError: string | undefined): Promise<void> {
    record.status = "interrupted";
    if (lastError !== undefined) {
      record.lastError = lastError;
    }
    await this.deps.store.upsert(record, this.deps.now());
    this.deps.onEvent({ type: "interrupted", id: record.id });
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

  // ---- deadline race -------------------------------------------------------

  // Races a stage promise against deps.setTimeout. The settle handler is
  // attached at creation so a late rejection never goes unhandled; after a
  // timeout it only re-runs the guard (which the timeout's own status change
  // has already made fail) and applies nothing.
  private race<T>(id: string, gen: number, call: Promise<T>, ms: number): Promise<Settled<T>> {
    return new Promise<Settled<T>>((resolve) => {
      let settled = false;
      // Tracked on the run so cancel (stopRun) and unload (stopAll) can
      // disarm a deadline that would otherwise stay pending for up to the
      // stage's full budget.
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

  private clearDeadlines(run: ActiveRun): void {
    for (const handle of run.deadlines) {
      this.deps.clearTimeout(handle);
    }
    run.deadlines.clear();
  }

  // Stops a run's deadline timers and drops it from `active`. Its loop is
  // fenced by the record (generation bump / status change / removal), not
  // here; a cleared deadline only means a dangling call settles "late"
  // instead of timing out, and a late settle re-runs the guard and applies
  // nothing.
  private stopRun(id: string): void {
    const run = this.active.get(id);
    if (run !== undefined) {
      this.clearDeadlines(run);
      this.active.delete(id);
    }
  }
}
