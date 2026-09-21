import { assertRecordIsMetadataOnly } from "./job-record";
import type { BillingRisk, JobStage, JobStatus, NoteJobRecord } from "./job-record";

// Serialized, compose-at-flush persistence for job records. No Obsidian, no
// clock reads (`now` is always a parameter). Obsidian's Plugin.loadData()/
// saveData() read/write ONE data.json that also holds user settings, so this
// module never owns the settings — it only reserves the `_jobs` key and asks
// the caller (via `composeSettings`) for the rest of the payload, fresh, at
// the moment each write actually happens.

export const JOBS_KEY = "_jobs";
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The two Obsidian Plugin methods, injected so the store is testable without Obsidian. */
export interface JobStoreIO {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface HydratedData {
  /** everything in data.json except `_jobs` — what loadSettings should merge over DEFAULT_SETTINGS */
  settings: Record<string, unknown>;
  jobs: NoteJobRecord[];
  /** records dropped because they were not valid v1 records (logged by the caller) */
  dropped: number;
}

const VALID_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "transcript",
  "summary",
  "note-creating",
  "note-created",
  "timestamps",
  "translation",
  "done",
]);

const VALID_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "running",
  "interrupted",
  "failed",
  "cancelled",
  "done",
]);

const VALID_BILLING_RISKS: ReadonlySet<BillingRisk> = new Set<BillingRisk>(["free", "paid", "unknown"]);

// Terminal statuses are the ones prune() and findByVideoId() both need to
// agree on: a job in one of these states is finished and is neither a resume
// candidate nor an in-progress job for its video.
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "cancelled", "failed"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: object | null = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

// Validates the fields the brief enumerates, plus the two required booleans
// (useFastSummary, inFlight) review flagged as missing from that list — both
// are read by job-planner.ts's resume logic, so a malformed value there is
// exactly the kind of corrupt record hydrate() exists to drop. Fields outside
// this set (e.g. optional claim/timing bookkeeping) are passed through
// untouched — hydrate() is a v1-shape gate, not a full schema validator.
function isValidJobRecord(value: unknown): value is NoteJobRecord {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.version !== 1) {
    return false;
  }
  if (value.kind !== "single") {
    return false;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.videoId !== "string" ||
    typeof value.folder !== "string" ||
    typeof value.customTitle !== "string"
  ) {
    return false;
  }
  if (typeof value.stage !== "string" || !VALID_STAGES.has(value.stage as JobStage)) {
    return false;
  }
  if (typeof value.status !== "string" || !VALID_STATUSES.has(value.status as JobStatus)) {
    return false;
  }
  if (typeof value.useFastSummary !== "boolean" || typeof value.inFlight !== "boolean") {
    return false;
  }
  // Optional (added after v1 shipped): absent is an older record and means
  // true; present must be a boolean.
  if (value.addTimestampLinks !== undefined && typeof value.addTimestampLinks !== "boolean") {
    return false;
  }
  // Optional (final review I3): absent is a record from before installation
  // scoping and means "another/unknown installation"; present must be a string.
  if (value.installationId !== undefined && typeof value.installationId !== "string") {
    return false;
  }
  // Optional (final review C1): absent is a record frozen before path
  // settings were frozen with it; present must be the exact settings shape.
  if (value.notePathSettings !== undefined) {
    const settings = value.notePathSettings;
    if (
      !isPlainObject(settings) ||
      typeof settings.prependDate !== "boolean" ||
      typeof settings.dateFormat !== "string"
    ) {
      return false;
    }
  }
  // Optional (translation stage): absent means no translation was frozen for
  // this job; present must be the exact language/country pair.
  if (value.translation !== undefined) {
    const translation = value.translation;
    if (
      !isPlainObject(translation) ||
      typeof translation.language !== "string" ||
      typeof translation.country !== "string"
    ) {
      return false;
    }
  }
  if (
    typeof value.createdAt !== "number" ||
    typeof value.heartbeatAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.generation !== "number"
  ) {
    return false;
  }
  const attempts = value.attempts;
  if (
    !isPlainObject(attempts) ||
    typeof attempts.transcript !== "number" ||
    typeof attempts.summary !== "number" ||
    typeof attempts.timestamps !== "number" ||
    // Absent = a record older than the translation stage (coerced to 0 by
    // hydrate); present must be a number.
    (attempts.translation !== undefined && typeof attempts.translation !== "number")
  ) {
    return false;
  }
  const billing = value.billing;
  if (
    !isPlainObject(billing) ||
    typeof billing.transcript !== "string" ||
    !VALID_BILLING_RISKS.has(billing.transcript as BillingRisk)
  ) {
    return false;
  }
  try {
    assertRecordIsMetadataOnly(value);
  } catch {
    return false;
  }
  return true;
}

/** Pure: split raw data.json content into settings + valid job records. Never throws on bad input. */
export function hydrate(raw: unknown): HydratedData {
  if (!isPlainObject(raw)) {
    return { settings: {}, jobs: [], dropped: 0 };
  }
  const { [JOBS_KEY]: jobsRaw, ...settings } = raw;
  if (!Array.isArray(jobsRaw)) {
    return { settings, jobs: [], dropped: 0 };
  }

  let dropped = 0;
  const byId = new Map<string, NoteJobRecord>();
  for (const entry of jobsRaw) {
    if (!isValidJobRecord(entry)) {
      dropped++;
      continue;
    }
    const record = withTranslationLedger(closeLegacyAppRestart(entry));
    // Duplicate ids: keep the one with the larger updatedAt (not counted as
    // dropped — both entries were individually valid).
    const existing = byId.get(record.id);
    if (existing === undefined || record.updatedAt > existing.updatedAt) {
      byId.set(record.id, record);
    }
  }
  return { settings, jobs: Array.from(byId.values()), dropped };
}

// A record written before the translation stage existed has no
// `attempts.translation`. The runner increments that counter and the planner
// bounds it, so it must be a number from the moment the record is loaded —
// an absent key would read as NaN and never reach MAX_STAGE_ATTEMPTS (F6).
function withTranslationLedger(record: NoteJobRecord): NoteJobRecord {
  // Widened on purpose: the validated shape allows the key to be absent.
  const attempts: Partial<NoteJobRecord["attempts"]> & Omit<NoteJobRecord["attempts"], "translation"> = record.attempts;
  if (attempts.translation !== undefined) {
    return record;
  }
  return { ...record, attempts: { ...attempts, translation: 0 } };
}

// A record written under the pre-#3-batch-E rule ("app-restart" meant a job
// could resume across a restart) can never be safely resumed under the
// current rule (a job dies with the instance that started it): the process
// that would resume it is long gone. Hydrate is the one place every
// data.json-loaded record passes through, so a non-terminal survivor of that
// legacy rule is closed here, once, the same way closeOwnRuns closes a live
// cold-start record: failed/app-closed, no call pending (`blocked` cleared,
// same reason cancel() and closeOwnRuns clear it — promptForRecord checks
// `blocked` before terminality), the rest kept as evidence. A terminal record
// is already resolved and is left untouched.
function closeLegacyAppRestart(record: NoteJobRecord): NoteJobRecord {
  if (TERMINAL_STATUSES.has(record.status) || record.interruption !== "app-restart") {
    return record;
  }
  const closed: NoteJobRecord = { ...record, status: "failed", interruption: "app-closed", inFlight: false };
  delete closed.inFlightSince;
  delete closed.deadlineAt;
  delete closed.blocked;
  return closed;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface FlushWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class JobStore {
  private readonly jobs = new Map<string, NoteJobRecord>();
  private writing = false;
  private dirty = false;
  private pendingWaiters: FlushWaiter[] = [];

  constructor(
    private readonly io: JobStoreIO,
    private readonly composeSettings: () => Record<string, unknown>,
  ) {}

  /** Replace the in-memory set (called once by the plugin after hydrate()). */
  load(jobs: NoteJobRecord[]): void {
    this.jobs.clear();
    for (const job of jobs) {
      this.jobs.set(job.id, clone(job));
    }
  }

  list(): NoteJobRecord[] {
    return Array.from(this.jobs.values())
      .map((job) => clone(job))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): NoteJobRecord | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : clone(job);
  }

  findByVideoId(videoId: string): NoteJobRecord | undefined {
    let best: NoteJobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.videoId !== videoId || TERMINAL_STATUSES.has(job.status)) {
        continue;
      }
      if (best === undefined || job.updatedAt > best.updatedAt) {
        best = job;
      }
    }
    return best === undefined ? undefined : clone(best);
  }

  /** Validates (assertRecordIsMetadataOnly), stores a copy with updatedAt = now, and schedules a flush. Returns the flush promise. */
  async upsert(record: NoteJobRecord, now: number): Promise<void> {
    // `async` turns a validation throw into a rejection of the promise this
    // method always returns (matching the Promise<void> contract), while
    // still running synchronously before flush() is ever called — no write
    // is scheduled for an invalid record.
    assertRecordIsMetadataOnly(record);
    const copy = clone(record);
    copy.updatedAt = now;
    this.jobs.set(copy.id, copy);
    return this.flush();
  }

  remove(id: string): Promise<void> {
    if (!this.jobs.delete(id)) {
      return Promise.resolve();
    }
    return this.flush();
  }

  /** Drops done/cancelled/failed records with updatedAt older than PRUNE_AFTER_MS; flushes only if something changed. */
  prune(now: number): Promise<void> {
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (TERMINAL_STATUSES.has(job.status) && now - job.updatedAt > PRUNE_AFTER_MS) {
        this.jobs.delete(id);
        changed = true;
      }
    }
    return changed ? this.flush() : Promise.resolve();
  }

  /**
   * Serialized writer. At most one io.saveData in flight; concurrent callers coalesce into ONE
   * follow-up write. The payload is composed AT FLUSH TIME. Resolves when a write that includes
   * the caller's state has completed; rejections propagate to every waiter of that write and the
   * store stays usable afterwards.
   */
  flush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingWaiters.push({ resolve, reject });
      this.dirty = true;
      if (!this.writing) {
        // Fire-and-forget: runWriteLoop settles every waiter it captures itself.
        void this.runWriteLoop();
      }
    });
  }

  private async runWriteLoop(): Promise<void> {
    this.writing = true;
    // Re-checking `dirty` after each write (instead of returning) is what
    // coalesces every upsert/remove/prune that arrived while a write was in
    // flight into exactly one follow-up write, composed fresh at that point.
    while (this.dirty) {
      this.dirty = false;
      const waiters = this.pendingWaiters;
      this.pendingWaiters = [];
      try {
        // Composition lives inside the try: a throwing composeSettings() or
        // list() must reject this write's waiters and let the loop exit
        // cleanly (resetting `writing`), not escape and wedge the store.
        const payload = { ...this.composeSettings(), [JOBS_KEY]: this.list() };
        await this.io.saveData(payload);
        for (const waiter of waiters) {
          waiter.resolve();
        }
      } catch (err) {
        for (const waiter of waiters) {
          waiter.reject(err);
        }
      }
    }
    this.writing = false;
  }
}
