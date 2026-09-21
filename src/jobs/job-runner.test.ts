import { describe, expect, it } from "vitest";
import { MAX_STAGE_ATTEMPTS, assertRecordIsMetadataOnly, createJobRecord, fnv1a64Hex } from "./job-record";
import type { BillingRisk, NoteJobRecord } from "./job-record";
import { HEARTBEAT_INTERVAL_MS } from "./job-planner";
import { JOBS_KEY, JobStore, hydrate } from "./job-store";
import type { JobStoreIO } from "./job-store";
import { DEFAULT_DEADLINES, JobRunner, NoteChangedError, PathDriftError, PermanentJobError } from "./job-runner";
import type { JobEvent, JobStages, RecoveryPrompt, RunnerDeps, RunnerVault, SubmitInput } from "./job-runner";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
// This harness's installation (spec I3): cold start marks dead only the
// running records this id owns.
const INSTALLATION_ID = "install-test";

// Distinctive bodies so test 16 can prove they never reach data.json. The
// word "summary" legitimately appears in payloads (attempts.summary,
// useFastSummary, a lastError mentioning the paid summary), so the sentinels
// must not be that word.
const TRANSCRIPT_BODY = "TRANSCRIPT_BODY_SENTINEL lorem ipsum";
const SUMMARY_BODY = "SUMMARY_BODY_SENTINEL dolor sit amet";
const VIDEO_TITLE = "Video Title";
const RENDERED_PREFIX = "RENDERED::";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drains the microtask queue (and any resolved promise chains) so the
// runner's `.then` continuations settle before assertions run.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Deterministic clock + timer queue. No vi.useFakeTimers(): the lint gate
// covers test files and forbids bare setTimeout identifiers.
class FakeClock {
  now: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start: number) {
    this.now = start;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = ++this.seq;
    this.timers.set(handle, { at: this.now + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingCount(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let dueHandle: number | undefined;
      let due: { at: number; fn: () => void } | undefined;
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && (due === undefined || timer.at < due.at)) {
          dueHandle = handle;
          due = timer;
        }
      }
      if (due === undefined || dueHandle === undefined) {
        break;
      }
      this.timers.delete(dueHandle);
      this.now = Math.max(this.now, due.at);
      due.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

// Records every payload io.saveData receives (deep-cloned so later mutation
// of the store cannot alter the evidence).
class FakeIO implements JobStoreIO {
  calls: unknown[] = [];
  /** when it matches a payload, that write blocks on `gate` (once) */
  gateWhen: ((record: NoteJobRecord) => boolean) | null = null;
  gate: Promise<void> | null = null;
  /** when it matches a payload, that write rejects (once) */
  failWhen: ((record: NoteJobRecord) => boolean) | null = null;
  /** when it matches a payload, that write rejects (every time — a store that keeps failing) */
  failEvery: ((record: NoteJobRecord) => boolean) | null = null;

  async loadData(): Promise<unknown> {
    return undefined;
  }

  async saveData(data: unknown): Promise<void> {
    this.calls.push(JSON.parse(JSON.stringify(data)));
    const record = jobsIn(data)[0];
    if (this.gateWhen !== null && this.gate !== null && record !== undefined && this.gateWhen(record)) {
      const gate = this.gate;
      this.gateWhen = null;
      await gate;
    }
    if (this.failWhen !== null && record !== undefined && this.failWhen(record)) {
      this.failWhen = null;
      throw new Error("disk full");
    }
    if (this.failEvery !== null && record !== undefined && this.failEvery(record)) {
      throw new Error("disk full");
    }
  }
}

// A stage method stub: counts calls, returns a manually-settled deferred when
// `manual` is set, otherwise resolves with `produce(...)`.
class Stub<A extends unknown[], T> {
  calls: A[] = [];
  pending: Array<Deferred<T>> = [];
  manual = false;
  failWith: Error | null = null;
  onCall: ((...args: A) => void) | null = null;

  constructor(private readonly produce: (...args: A) => T) {}

  invoke(...args: A): Promise<T> {
    this.calls.push(args);
    if (this.onCall) {
      this.onCall(...args);
    }
    if (this.failWith !== null) {
      const err = this.failWith;
      this.failWith = null;
      return Promise.reject(err);
    }
    if (this.manual) {
      const d = deferred<T>();
      // Never-awaited deferreds must not surface as unhandled rejections.
      d.promise.catch(() => undefined);
      this.pending.push(d);
      return d.promise;
    }
    return Promise.resolve(this.produce(...args));
  }

  get count(): number {
    return this.calls.length;
  }

  resolveLast(value: T): void {
    const d = this.pending[this.pending.length - 1];
    if (d === undefined) {
      throw new Error("no pending call to resolve");
    }
    d.resolve(value);
  }
}

class FakeVault implements RunnerVault {
  readonly files = new Map<string, string>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  read(path: string): Promise<string | undefined> {
    return Promise.resolve(this.files.get(path));
  }
}

class FakeStages implements JobStages {
  templaterAvailable = true;
  readonly fetch = new Stub<[NoteJobRecord], { transcript: string; title: string }>(() => ({
    transcript: TRANSCRIPT_BODY,
    title: VIDEO_TITLE,
  }));
  readonly summ = new Stub<[NoteJobRecord, string], string>(() => SUMMARY_BODY);
  readonly render = new Stub<[NoteJobRecord, { transcript: string; summary: string; title: string }], string>(
    (_record, input) => `${RENDERED_PREFIX}${input.title}\n${input.summary}`,
  );
  readonly create: Stub<[string, string], void>;
  readonly stamps = new Stub<[NoteJobRecord, string], void>(() => undefined);
  readonly translate = new Stub<[NoteJobRecord, string], void>(() => undefined);

  constructor(vault: FakeVault) {
    this.create = new Stub<[string, string], void>((path, content) => {
      vault.files.set(path, content);
    });
  }

  fetchTranscript(record: NoteJobRecord): Promise<{ transcript: string; title: string }> {
    return this.fetch.invoke(record);
  }
  canRenderNote(): boolean {
    return this.templaterAvailable;
  }
  summarize(record: NoteJobRecord, transcript: string): Promise<string> {
    return this.summ.invoke(record, transcript);
  }
  renderNote(record: NoteJobRecord, input: { transcript: string; summary: string; title: string }): Promise<string> {
    return this.render.invoke(record, input);
  }
  createNote(path: string, content: string): Promise<void> {
    return this.create.invoke(path, content);
  }
  addTimestamps(record: NoteJobRecord, notePath: string): Promise<void> {
    return this.stamps.invoke(record, notePath);
  }
  translateNote(record: NoteJobRecord, notePath: string): Promise<void> {
    return this.translate.invoke(record, notePath);
  }
}

interface Harness {
  runner: JobRunner;
  store: JobStore;
  io: FakeIO;
  stages: FakeStages;
  vault: FakeVault;
  clock: FakeClock;
  events: JobEvent[];
  deps: RunnerDeps;
}

interface HarnessOptions {
  /** a saveData payload captured from another harness; hydrated into the new store */
  snapshot?: unknown;
  /** hand-built records loaded straight into the store */
  records?: NoteJobRecord[];
  billing?: BillingRisk;
  startAt?: number;
  files?: Record<string, string>;
  /** Live translation settings the transcript stage freezes (undefined = en/US, nothing frozen). */
  translation?: { language: string; country: string };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const io = new FakeIO();
  const store = new JobStore(io, () => ({}));
  if (options.snapshot !== undefined) {
    store.load(hydrate(options.snapshot).jobs);
  }
  if (options.records !== undefined) {
    store.load(options.records);
  }
  const vault = new FakeVault();
  for (const [path, content] of Object.entries(options.files ?? {})) {
    vault.files.set(path, content);
  }
  const stages = new FakeStages(vault);
  const clock = new FakeClock(options.startAt ?? NOW);
  const events: JobEvent[] = [];
  let ids = 0;
  const deps: RunnerDeps = {
    store,
    stages,
    vault,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    notePathSettings: () => ({ prependDate: false, dateFormat: "YYYY-MM-DD" }),
    translationSettings: () => options.translation,
    normalizePath: (path) => path.normalize("NFC"),
    installationId: () => INSTALLATION_ID,
    transcriptBilling: () => options.billing ?? "free",
    generateId: () => `job-${++ids}`,
    onEvent: (event) => {
      events.push(event);
    },
  };
  const runner = new JobRunner(deps);
  return { runner, store, io, stages, vault, clock, events, deps };
}

const SUBMIT: SubmitInput = {
  url: "https://youtu.be/abc123",
  videoId: "abc123",
  folder: "",
  customTitle: "",
  useFastSummary: false,
};

const TARGET_PATH = "Video-Title.md";

function jobsIn(payload: unknown): NoteJobRecord[] {
  return (payload as Record<string, NoteJobRecord[]>)[JOBS_KEY];
}

/** A record as a dead run would have left it: interrupted, with the given overrides. */
function recordFixture(overrides: Partial<NoteJobRecord>): NoteJobRecord {
  const base = createJobRecord({
    id: "job-1",
    url: SUBMIT.url,
    videoId: SUBMIT.videoId,
    folder: "",
    customTitle: "",
    useFastSummary: false,
    transcriptBilling: "free",
    installationId: INSTALLATION_ID,
    now: NOW,
  });
  return { ...base, status: "interrupted", resolvedTitle: VIDEO_TITLE, targetNotePath: TARGET_PATH, ...overrides };
}

function lastRecord(h: Harness): NoteJobRecord {
  const payload = h.io.calls[h.io.calls.length - 1];
  const jobs = jobsIn(payload);
  return jobs[jobs.length - 1];
}

function persistedRecords(h: Harness, id = "job-1"): NoteJobRecord[] {
  return h.io.calls.map((payload) => jobsIn(payload).find((job) => job.id === id)).filter((r): r is NoteJobRecord => r !== undefined);
}

function renderedContent(): string {
  return `${RENDERED_PREFIX}${VIDEO_TITLE}\n${SUMMARY_BODY}`;
}

/** Submits and runs until `summarize` is pending (manual). Returns the job id. */
async function submitUntilSummaryPending(h: Harness): Promise<string> {
  h.stages.summ.manual = true;
  const result = await h.runner.submit(SUBMIT);
  expect(result.kind).toBe("started");
  await flush();
  expect(h.stages.summ.count).toBe(1);
  expect(h.stages.summ.pending.length).toBe(1);
  return (result as { id: string }).id;
}

/** Times out the pending summarize call (advances past llmMs). */
async function timeOutSummary(h: Harness): Promise<void> {
  await h.clock.advance(DEFAULT_DEADLINES.llmMs);
  const record = lastRecord(h);
  expect(record.status).toBe("interrupted");
  expect(record.interruption).toBe("timeout");
  expect(record.inFlight).toBe(true);
}

function askUser(prompt: RecoveryPrompt): Extract<RecoveryPrompt, { action: "ask-user" }> {
  expect(prompt.action).toBe("ask-user");
  return prompt as Extract<RecoveryPrompt, { action: "ask-user" }>;
}

describe("JobRunner — happy path", () => {
  it("1. runs every stage in order with pre-call persistence and the claim before createNote", async () => {
    const h = makeHarness();
    let payloadBeforeCreate: unknown;
    let contentGiven = "";
    h.stages.create.onCall = (_path, content) => {
      payloadBeforeCreate = h.io.calls[h.io.calls.length - 1];
      contentGiven = content;
    };

    const result = await h.runner.submit(SUBMIT);
    expect(result).toEqual({ kind: "started", id: "job-1" });
    await flush();

    // Stage order.
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(1);
    expect(h.stages.render.count).toBe(1);
    expect(h.stages.create.count).toBe(1);
    expect(h.stages.stamps.count).toBe(1);
    expect(h.stages.summ.calls[0][1]).toBe(TRANSCRIPT_BODY);
    expect(h.stages.create.calls[0][0]).toBe(TARGET_PATH);
    expect(h.stages.stamps.calls[0][1]).toBe(TARGET_PATH);

    const records = persistedRecords(h);
    const stagesSeen = records.map((r) => `${r.stage}/${r.inFlight ? "in" : "out"}`);
    expect(stagesSeen).toEqual([
      "transcript/out", // created
      "transcript/in", // pre-fetch
      "summary/out", // transcript done, title + target frozen
      "summary/in", // pre-summarize
      "note-creating/in", // claim
      "note-created/out", // create landed
      "timestamps/in", // pre-addTimestamps
      "done/out",
    ]);
    // Every in-flight persist carries a deadline and an attempt bump.
    for (const record of records.filter((r) => r.inFlight)) {
      expect(record.deadlineAt).toBeGreaterThan(NOW);
      expect(record.inFlightSince).toBe(NOW);
    }
    expect(records[1].attempts).toEqual({ transcript: 1, summary: 0, timestamps: 0, translation: 0 });
    expect(records[3].attempts).toEqual({ transcript: 1, summary: 1, timestamps: 0, translation: 0 });
    expect(records[6].attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 0 });
    expect(records[2].resolvedTitle).toBe(VIDEO_TITLE);
    expect(records[2].targetNotePath).toBe(TARGET_PATH);

    // The payload persisted immediately before createNote is the claim.
    const claim = jobsIn(payloadBeforeCreate)[0];
    expect(contentGiven).toBe(renderedContent());
    expect(claim.stage).toBe("note-creating");
    expect(claim.inFlight).toBe(true);
    expect(claim.claimedNotePath).toBe(TARGET_PATH);
    expect(claim.claimedContentHash).toBe(fnv1a64Hex(contentGiven));
    expect(claim.claimedContentLength).toBe(contentGiven.length);
    expect(claim.claimedAt).toBe(NOW);
    expect(claim.notePath).toBeUndefined();

    const final = lastRecord(h);
    expect(final.stage).toBe("done");
    expect(final.status).toBe("done");
    expect(final.inFlight).toBe(false);
    expect(final.notePath).toBe(TARGET_PATH);
    expect(final.deadlineAt).toBeUndefined();
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
  });

  it("16. every persisted payload is metadata only and never carries transcript or summary text", async () => {
    const h = makeHarness();
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.io.calls.length).toBeGreaterThanOrEqual(8);
    for (const payload of h.io.calls) {
      for (const job of jobsIn(payload)) {
        expect(() => assertRecordIsMetadataOnly(job)).not.toThrow();
      }
      const text = JSON.stringify(payload);
      expect(text).not.toContain(TRANSCRIPT_BODY);
      expect(text).not.toContain(SUMMARY_BODY);
      expect(text).not.toContain(RENDERED_PREFIX);
    }
  });
});

describe("JobRunner — crash windows (rebuilt from a persisted snapshot)", () => {
  async function snapshotAfterClaim(): Promise<{ snapshot: unknown; content: string }> {
    const h = makeHarness();
    h.stages.create.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.create.count).toBe(1);
    const snapshot = h.io.calls[h.io.calls.length - 1];
    const record = jobsIn(snapshot)[0];
    expect(record.stage).toBe("note-creating");
    expect(record.claimedNotePath).toBe(TARGET_PATH);
    return { snapshot, content: h.stages.create.calls[0][1] };
  }

  it("2. window A — claim persisted, createNote never landed: cold start closes the job; no prompt, no paid call, the claim kept as evidence", async () => {
    const { snapshot } = await snapshotAfterClaim();
    // Cold start: the run that owned this record died with its process, so
    // there is nothing to resume (a job lives and dies with its instance).
    const h = makeHarness({ snapshot });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    expect(h.stages.summ.count).toBe(0);
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.create.count).toBe(0);
    // The only write is the closing; everything else is untouched.
    expect(h.io.calls).toHaveLength(1);
    expect(lastRecord(h)).toMatchObject({
      status: "failed",
      interruption: "app-closed",
      inFlight: false,
      stage: "note-creating",
      claimedNotePath: TARGET_PATH,
      generation: 1,
    });
    expect(lastRecord(h).notePath).toBeUndefined();
    expect(lastRecord(h).attempts).toEqual({ transcript: 1, summary: 1, timestamps: 0, translation: 0 });
    expect(h.events).toEqual([]);
    // The closed records are handed to the host once, for its Notice.
    expect(h.runner.drainClosedOnColdStart().map((c) => c.record.id)).toEqual(["job-1"]);
    expect(h.runner.drainClosedOnColdStart()).toEqual([]);
  });

  it("without coldStart a fresh-heartbeat running record is left alone (it may be live on another device)", async () => {
    const { snapshot } = await snapshotAfterClaim();
    const h = makeHarness({ snapshot });
    expect(await h.runner.recoverAll()).toEqual([]);
    await flush();
    expect(h.io.calls).toHaveLength(0);
    expect(h.stages.summ.count).toBe(0);
    expect(h.stages.stamps.count).toBe(0);
    expect(h.store.get("job-1")).toMatchObject({ status: "running", generation: 1 });
  });

  it("3. window B / B′ — whether the note landed (exact content or differing by one character), cold start closes the job the same way: never adopted, never stamped, nothing written to the vault", async () => {
    const { snapshot, content } = await snapshotAfterClaim();
    for (const onDisk of [content, `${content}x`]) {
      const h = makeHarness({ snapshot, files: { [TARGET_PATH]: onDisk } });
      expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
      await flush();
      expect(h.io.calls).toHaveLength(1); // the closing only
      expect(lastRecord(h)).toMatchObject({
        status: "failed",
        interruption: "app-closed",
        stage: "note-creating",
        claimedNotePath: TARGET_PATH,
        generation: 1,
      });
      expect(lastRecord(h).notePath).toBeUndefined();
      expect(h.vault.files.get(TARGET_PATH)).toBe(onDisk);
      expect(h.stages.stamps.count).toBe(0);
      expect(h.stages.summ.count).toBe(0);
      expect(h.stages.create.count).toBe(0);
      expect(h.events).toEqual([]);
    }
  });
});

describe("JobRunner — generation fence", () => {
  it("5. a completion that lands after the deadline timeout applies no side effect", async () => {
    const h = makeHarness();
    await submitUntilSummaryPending(h);
    await timeOutSummary(h);
    const writesAtTimeout = h.io.calls.length;
    const interrupted = h.events.filter((e) => e.type === "interrupted");
    expect(interrupted).toHaveLength(1);
    expect(askUser((interrupted[0] as { prompt: RecoveryPrompt }).prompt)).toMatchObject({
      reason: "paid-stage-in-flight",
      stage: "summary",
      interruption: "timeout",
    });
    expect(h.runner.isActive("job-1")).toBe(false);

    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    await h.clock.advance(DEFAULT_DEADLINES.llmMs);

    expect(h.stages.render.count).toBe(0);
    expect(h.stages.create.count).toBe(0);
    expect(h.io.calls.length).toBe(writesAtTimeout);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", interruption: "timeout", inFlight: true, generation: 1 });
  });

  it("6. a completion that lands after cancel applies no side effect", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await h.runner.cancel(id);
    await flush();
    const cancelled = lastRecord(h);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.generation).toBe(2);
    expect(h.events.filter((e) => e.type === "cancelled")).toEqual([{ type: "cancelled", id }]);
    expect(h.runner.isActive(id)).toBe(false);
    const writesAtCancel = h.io.calls.length;

    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    await h.clock.advance(DEFAULT_DEADLINES.llmMs);

    expect(h.stages.render.count).toBe(0);
    expect(h.stages.create.count).toBe(0);
    expect(h.io.calls.length).toBe(writesAtCancel);
    expect(h.events.filter((e) => e.type === "done" || e.type === "interrupted")).toEqual([]);
    expect(lastRecord(h)).toMatchObject({ status: "cancelled", generation: 2 });
  });
});

describe("JobRunner — resume", () => {
  it("7. a paid stage in flight needs confirmation; confirmed resume bumps generation and re-bills once", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await timeOutSummary(h);

    const declined = await h.runner.resume(id, { confirmed: false });
    expect(declined.kind).toBe("prompt");
    expect(askUser((declined as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "paid-stage-in-flight", stage: "summary" });
    await flush();
    expect(h.stages.summ.count).toBe(1);
    expect(lastRecord(h).generation).toBe(1);

    const accepted = await h.runner.resume(id, { confirmed: true });
    expect(accepted).toEqual({ kind: "resumed" });
    await flush();
    // The transcript lives in memory only: the resumed run re-fetched it
    // (free billing here) before re-running the paid summary.
    expect(h.stages.fetch.count).toBe(2);
    expect(h.stages.summ.count).toBe(2);
    const current = lastRecord(h);
    expect(current.generation).toBe(2);
    expect(current.status).toBe("running");
    expect(current.stage).toBe("summary");
    expect(current.inFlight).toBe(true);
    expect(current.attempts.summary).toBe(2);
    expect(current.blocked).toBeUndefined();
    expect(current.interruption).toBeUndefined();
  });

  it("8. attempts are bounded even with confirmed: true", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await timeOutSummary(h);
    for (let attempt = 2; attempt <= MAX_STAGE_ATTEMPTS; attempt++) {
      expect(await h.runner.resume(id, { confirmed: true })).toEqual({ kind: "resumed" });
      await flush();
      expect(h.stages.summ.count).toBe(attempt);
      await timeOutSummary(h);
    }
    expect(lastRecord(h).attempts.summary).toBe(MAX_STAGE_ATTEMPTS);

    const refused = await h.runner.resume(id, { confirmed: true });
    expect(refused.kind).toBe("prompt");
    expect(askUser((refused as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "attempts-exhausted", stage: "summary" });
    await flush();
    expect(h.stages.summ.count).toBe(MAX_STAGE_ATTEMPTS);
    expect(lastRecord(h).generation).toBe(MAX_STAGE_ATTEMPTS);
  });

  it("9. submit routes a duplicate videoId to the active or interrupted job instead of creating a record", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    expect(await h.runner.submit(SUBMIT)).toEqual({ kind: "already-running", id });
    expect(h.store.list()).toHaveLength(1);

    await timeOutSummary(h);
    const routed = await h.runner.submit(SUBMIT);
    expect(routed.kind).toBe("recovery");
    const recovery = routed as Extract<typeof routed, { kind: "recovery" }>;
    expect(recovery.record.id).toBe(id);
    expect(askUser(recovery.prompt)).toMatchObject({ reason: "paid-stage-in-flight", stage: "summary" });
    await flush();
    expect(h.store.list()).toHaveLength(1);
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(1);
  });
});

describe("JobRunner — blocks", () => {
  it("10a. a note already at the target when the transcript completes blocks before any paid call", async () => {
    const h = makeHarness({ files: { [TARGET_PATH]: "someone else's note" } });
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    const record = lastRecord(h);
    expect(record).toMatchObject({ status: "interrupted", blocked: "note-collision", inFlight: false });
    expect(record.targetNotePath).toBe(TARGET_PATH);
    const interrupted = h.events.filter((e) => e.type === "interrupted");
    expect(interrupted).toHaveLength(1);
    expect(askUser((interrupted[0] as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "note-collision" });
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("10b. a note appearing between the precheck and the claim blocks after the paid summary, without creating", async () => {
    const h = makeHarness();
    await submitUntilSummaryPending(h);
    h.vault.files.set(TARGET_PATH, "raced in");
    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    expect(h.stages.render.count).toBe(1);
    expect(h.stages.create.count).toBe(0);
    const record = lastRecord(h);
    expect(record).toMatchObject({ status: "interrupted", blocked: "note-collision", inFlight: false, stage: "summary" });
    expect(record.claimedNotePath).toBeUndefined();
    expect(record.lastError ?? "").toMatch(/summary/i);
    expect(h.vault.files.get(TARGET_PATH)).toBe("raced in");
  });

  it("11. an unavailable template engine blocks before the paid call; a cleared block resumes without confirmation", async () => {
    const h = makeHarness();
    h.stages.templaterAvailable = false;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", blocked: "templater-unavailable", inFlight: false, stage: "summary" });
    const interrupted = h.events.filter((e) => e.type === "interrupted");
    expect(askUser((interrupted[0] as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "templater-unavailable" });

    // Still unavailable: the block holds and asks.
    const stillBlocked = await h.runner.resume("job-1", { confirmed: false });
    expect(stillBlocked.kind).toBe("prompt");
    expect(h.stages.summ.count).toBe(0);

    h.stages.templaterAvailable = true;
    expect(await h.runner.resume("job-1", { confirmed: false })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.summ.count).toBe(1);
    const final = lastRecord(h);
    expect(final.status).toBe("done");
    expect(final.generation).toBe(2);
    expect(final.blocked).toBeUndefined();
  });
});

describe("JobRunner — timestamps stage", () => {
  it("12a. NoteChangedError finishes the job with timestampsSkipped: note-changed", async () => {
    const h = makeHarness();
    h.stages.stamps.failWith = new NoteChangedError("note changed");
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done", inFlight: false, notePath: TARGET_PATH });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "note-changed" },
    ]);
  });

  it("12b. finishWithoutTimestamps on resume finishes with user-choice and no LLM call", async () => {
    const h = makeHarness();
    h.stages.stamps.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    await h.clock.advance(DEFAULT_DEADLINES.llmMs);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", stage: "timestamps", inFlight: true });
    const interrupted = h.events.filter((e) => e.type === "interrupted");
    expect(askUser((interrupted[0] as { prompt: RecoveryPrompt }).prompt)).toMatchObject({
      reason: "paid-stage-in-flight",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
    });

    expect(await h.runner.resume("job-1", { confirmed: true, finishWithoutTimestamps: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done", inFlight: false, generation: 2 });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice" },
    ]);
    expect(h.runner.isActive("job-1")).toBe(false);
  });
});

describe("JobRunner — errors", () => {
  it("13. PermanentJobError from fetchTranscript fails the job", async () => {
    const h = makeHarness();
    h.stages.fetch.failWith = new PermanentJobError("no captions");
    await h.runner.submit(SUBMIT);
    await flush();
    const record = lastRecord(h);
    expect(record).toMatchObject({ status: "failed", inFlight: false, lastError: "no captions", stage: "transcript" });
    expect(record.deadlineAt).toBeUndefined();
    expect(h.events.filter((e) => e.type === "failed")).toEqual([{ type: "failed", id: "job-1", error: "no captions" }]);
    expect(h.stages.summ.count).toBe(0);
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
  });

  it("a non-permanent error interrupts with interruption: network and inFlight kept", async () => {
    const h = makeHarness();
    h.stages.fetch.failWith = new Error("socket hang up");
    await h.runner.submit(SUBMIT);
    await flush();
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", interruption: "network", inFlight: true, lastError: "socket hang up" });
    const interrupted = h.events.filter((e) => e.type === "interrupted");
    expect(interrupted).toHaveLength(1);
    // Free transcript billing: the planner classifies this as auto-resumable.
    expect((interrupted[0] as { prompt: RecoveryPrompt }).prompt).toEqual({ action: "auto-resume", fromStage: "transcript" });
  });
});

describe("JobRunner — heartbeat", () => {
  it("14. persists heartbeatAt every HEARTBEAT_INTERVAL_MS while a stage is pending", async () => {
    const h = makeHarness();
    await submitUntilSummaryPending(h);
    const before = h.io.calls.length;
    await h.clock.advance(2 * HEARTBEAT_INTERVAL_MS);
    const records = persistedRecords(h).slice(before - 1);
    let heartbeatOnly = 0;
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const next = records[i];
      const changed = (Object.keys(next) as Array<keyof NoteJobRecord>).filter(
        (key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]),
      );
      if (changed.length > 0 && changed.every((key) => key === "heartbeatAt" || key === "updatedAt")) {
        heartbeatOnly++;
        expect(next.heartbeatAt).toBeGreaterThan(prev.heartbeatAt);
      }
    }
    expect(heartbeatOnly).toBeGreaterThanOrEqual(2);
    expect(lastRecord(h).heartbeatAt).toBe(NOW + 2 * HEARTBEAT_INTERVAL_MS);
    expect(h.stages.summ.count).toBe(1);
  });

  it("stops the heartbeat when the loop exits", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await h.runner.cancel(id);
    await flush();
    const writes = h.io.calls.length;
    await h.clock.advance(3 * HEARTBEAT_INTERVAL_MS);
    expect(h.io.calls.length).toBe(writes);
    // cancel (stopRun) disarmed the dangling call's deadline as well (T6
    // review #2): no runner timer is left, and nothing fires later.
    expect(h.clock.pendingCount()).toBe(0);
    await h.clock.advance(DEFAULT_DEADLINES.llmMs);
    expect(h.io.calls.length).toBe(writes);
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
  });
});

describe("JobRunner — recoverAll", () => {
  it("15a. skips ids whose run loop is alive in this process", async () => {
    const h = makeHarness();
    await submitUntilSummaryPending(h);
    const writes = h.io.calls.length;
    expect(await h.runner.recoverAll()).toEqual([]);
    await flush();
    expect(h.io.calls.length).toBe(writes);
    expect(h.stages.summ.count).toBe(1);
    expect(lastRecord(h).generation).toBe(1);
  });

  it("15b. a free transcript stage killed in flight is closed on cold start, never auto-continued", async () => {
    const source = makeHarness();
    source.stages.fetch.manual = true;
    await source.runner.submit(SUBMIT);
    await flush();
    const snapshot = source.io.calls[source.io.calls.length - 1];
    expect(jobsIn(snapshot)[0]).toMatchObject({ stage: "transcript", inFlight: true, status: "running" });

    const h = makeHarness({ snapshot });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
    expect(persistedRecords(h)).toHaveLength(1);
    expect(lastRecord(h)).toMatchObject({ generation: 1, status: "failed", interruption: "app-closed", inFlight: false, stage: "transcript" });
    expect(lastRecord(h).attempts.transcript).toBe(1);
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("15c. converts a clean summary continue with paid transcript billing into a paid-refetch-required prompt (visibility pass)", async () => {
    // A clean summary checkpoint interrupted in-process (network blip) with a
    // paid transcript key configured: the free continue would re-fetch
    // through a paid service, so it is surfaced instead of run unattended.
    const h = makeHarness({
      billing: "paid",
      records: [recordFixture({ stage: "summary", inFlight: false, interruption: "network", billing: { transcript: "paid" } })],
    });
    const prompts = await h.runner.recoverAll();
    await flush();
    expect(prompts).toHaveLength(1);
    expect(askUser(prompts[0].prompt)).toMatchObject({ reason: "paid-refetch-required", stage: "summary" });
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
    expect(h.io.calls).toHaveLength(0);

    // With confirmation the re-fetch is allowed and the job completes.
    expect(await h.runner.resume("job-1", { confirmed: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ status: "done", generation: 2 });
  });

  it("returns { kind: 'missing' } for an unknown id and discard removes the record without touching the vault", async () => {
    const h = makeHarness();
    expect(await h.runner.resume("nope", { confirmed: true })).toEqual({ kind: "missing" });
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.vault.files.has(TARGET_PATH)).toBe(true);
    await h.runner.discard("job-1");
    expect(h.store.get("job-1")).toBeUndefined();
    expect(h.vault.files.has(TARGET_PATH)).toBe(true);
    expect(jobsIn(h.io.calls[h.io.calls.length - 1])).toEqual([]);
  });
});

describe("JobRunner — review fixes", () => {
  it("attempts guard (a): note-missing at note-created with attempts.summary = 3 is attempts-exhausted even when confirmed", async () => {
    const h = makeHarness({
      records: [
        recordFixture({
          stage: "note-created",
          notePath: TARGET_PATH, // deleted from the vault
          attempts: { transcript: 1, summary: MAX_STAGE_ATTEMPTS, timestamps: 0, translation: 0 },
        }),
      ],
    });
    const declined = await h.runner.resume("job-1", { confirmed: false });
    expect(askUser((declined as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "note-missing", stage: "note-created" });
    const confirmed = await h.runner.resume("job-1", { confirmed: true });
    expect(confirmed.kind).toBe("prompt");
    expect(askUser((confirmed as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "attempts-exhausted", stage: "summary" });
    await flush();
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
    expect(h.io.calls).toHaveLength(0);
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("attempts guard (b): a note-collision block with attempts.summary = 3 is attempts-exhausted even when confirmed", async () => {
    const h = makeHarness({
      records: [
        recordFixture({
          stage: "summary",
          blocked: "note-collision",
          attempts: { transcript: 1, summary: MAX_STAGE_ATTEMPTS, timestamps: 0, translation: 0 },
        }),
      ],
    });
    const confirmed = await h.runner.resume("job-1", { confirmed: true });
    expect(askUser((confirmed as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "attempts-exhausted", stage: "summary" });
    await flush();
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
    expect(h.io.calls).toHaveLength(0);
  });

  it("idempotent resume: two concurrent confirmed resumes start exactly one run", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await timeOutSummary(h);
    const results = await Promise.all([
      h.runner.resume(id, { confirmed: true }),
      h.runner.resume(id, { confirmed: true }),
    ]);
    expect(results.filter((r) => r.kind === "resumed")).toHaveLength(1);
    expect(results.find((r) => r.kind === "prompt")).toEqual({ kind: "prompt", prompt: { action: "nothing", why: "live" } });
    await flush();
    expect(h.runner.isActive(id)).toBe(true);
    expect(h.stages.fetch.count).toBe(2);
    expect(h.stages.summ.count).toBe(2); // 1 original + 1 resumed, still pending
    expect(lastRecord(h)).toMatchObject({ generation: 2, status: "running", stage: "summary", inFlight: true });
    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    expect(h.runner.isActive(id)).toBe(false);
    expect(lastRecord(h)).toMatchObject({ status: "done", generation: 2 });
    expect(h.stages.summ.count).toBe(2);
  });

  it("idempotent recoverAll: overlapping calls coalesce and never auto-resume a job twice", async () => {
    // A clean transcript checkpoint interrupted in-process (network blip):
    // two overlapping visibility passes must start exactly one run.
    const h = makeHarness({
      records: [recordFixture({ stage: "transcript", interruption: "network", resolvedTitle: undefined, targetNotePath: undefined })],
    });
    h.stages.fetch.manual = true;
    const [first, second] = await Promise.all([h.runner.recoverAll(), h.runner.recoverAll()]);
    expect(first).toBe(second);
    expect(h.stages.fetch.count).toBe(1);
    h.stages.fetch.resolveLast({ transcript: TRANSCRIPT_BODY, title: VIDEO_TITLE });
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(1);
    expect(persistedRecords(h).filter((r) => r.generation === 2 && r.status === "running")).not.toHaveLength(0);
    expect(persistedRecords(h).every((r) => r.generation <= 2)).toBe(true);
    // A later call is a fresh pass again.
    expect(await h.runner.recoverAll()).toEqual([]);
  });

  it("collision precheck (i): a confirmed resume of a still-colliding job makes zero transcript/summary calls", async () => {
    const h = makeHarness({ files: { [TARGET_PATH]: "someone else's note" } });
    await h.runner.submit(SUBMIT);
    await flush();
    expect(lastRecord(h)).toMatchObject({ blocked: "note-collision", stage: "summary" });
    expect(await h.runner.resume("job-1", { confirmed: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.fetch.count).toBe(1); // the original fetch only
    expect(h.stages.summ.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ blocked: "note-collision", status: "interrupted", generation: 2, inFlight: false });
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("cancel during note-creating (ii): a create that lands anyway never becomes notePath; the claim is kept", async () => {
    const h = makeHarness();
    h.stages.create.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.create.count).toBe(1);
    await h.runner.cancel("job-1");
    await flush();
    h.stages.create.resolveLast(undefined);
    await flush();
    const record = lastRecord(h);
    expect(record).toMatchObject({ status: "cancelled", stage: "note-creating", generation: 2, claimedNotePath: TARGET_PATH });
    expect(record.notePath).toBeUndefined();
    expect(h.stages.stamps.count).toBe(0);
    await h.runner.discard("job-1");
    expect(h.store.get("job-1")).toBeUndefined();
  });

  it("cancel during preCall's flush (ii): the re-guard after the upsert prevents the paid call", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.io.gate = gate.promise;
    h.io.gateWhen = (record) => record.stage === "summary" && record.inFlight;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    const cancelling = h.runner.cancel("job-1");
    gate.resolve();
    await cancelling;
    await flush();
    expect(h.stages.summ.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ status: "cancelled", generation: 2 });
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("cancel during the claim's flush (ii): the re-guard after the upsert prevents createNote", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.io.gate = gate.promise;
    h.io.gateWhen = (record) => record.stage === "note-creating";
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.summ.count).toBe(1);
    expect(h.stages.create.count).toBe(0);
    const cancelling = h.runner.cancel("job-1");
    gate.resolve();
    await cancelling;
    await flush();
    expect(h.stages.create.count).toBe(0);
    expect(h.vault.files.has(TARGET_PATH)).toBe(false);
    expect(lastRecord(h)).toMatchObject({ status: "cancelled", generation: 2, claimedNotePath: TARGET_PATH });
  });

  it("A: an auto-resume whose re-fetch is billed under the LIVE settings becomes a paid-refetch prompt", async () => {
    const h = makeHarness({
      billing: "paid", // key configured after the job was created
      records: [recordFixture({ stage: "transcript", inFlight: true, billing: { transcript: "free" }, resolvedTitle: undefined, targetNotePath: undefined })],
    });
    const prompts = await h.runner.recoverAll();
    await flush();
    expect(prompts).toHaveLength(1);
    expect(askUser(prompts[0].prompt)).toMatchObject({ reason: "paid-refetch-required", stage: "transcript" });
    expect(h.stages.fetch.count).toBe(0);
    expect(h.io.calls).toHaveLength(0);
    // Confirmed, the fetch is allowed.
    expect(await h.runner.resume("job-1", { confirmed: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ status: "done" });
  });

  it("B: a crash during the nested transcript re-fetch is closed on cold start with its ledgers intact (nothing re-fetched, nothing re-billed)", async () => {
    const source = makeHarness();
    const id = await submitUntilSummaryPending(source);
    await timeOutSummary(source);
    source.stages.fetch.manual = true;
    expect(await source.runner.resume(id, { confirmed: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(source.stages.fetch.count).toBe(2);
    const snapshot = source.io.calls[source.io.calls.length - 1];
    expect(jobsIn(snapshot)[0]).toMatchObject({ stage: "summary", inFlight: true, status: "running", generation: 2 });
    expect(jobsIn(snapshot)[0].attempts).toEqual({ transcript: 2, summary: 1, timestamps: 0, translation: 0 });

    const h = makeHarness({ snapshot });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ status: "failed", interruption: "app-closed", inFlight: false, stage: "summary", generation: 2 });
    expect(lastRecord(h).attempts).toEqual({ transcript: 2, summary: 1, timestamps: 0, translation: 0 });
    expect(await h.runner.resume(id, { confirmed: true })).toEqual({ kind: "prompt", prompt: { action: "nothing", why: "terminal" } });
    expect(h.stages.fetch.count).toBe(0);
  });

  it("C: a store rejection inside a post-call persist leaves the record interrupted/unknown, not running", async () => {
    const h = makeHarness();
    h.io.failWhen = (record) => record.stage === "summary" && !record.inFlight;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([{ type: "failed", id: "job-1", error: "disk full" }]);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", interruption: "unknown", lastError: "disk full", stage: "summary" });
    expect(h.store.get("job-1")).toMatchObject({ status: "interrupted", interruption: "unknown" });
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
    // Recovery sees it immediately (no stale window), and a clean summary
    // checkpoint with free billing simply continues.
    expect(await h.runner.recoverAll()).toEqual([]);
    await flush();
    expect(h.stages.summ.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ status: "done", generation: 2 });
  });
});

describe("JobRunner — T5b follow-ups", () => {
  // A dead run as a cold start finds it: `running`, fresh heartbeat, paid
  // summary in flight. Without coldStart the planner reads it as live.
  function deadSummaryRun(overrides: Partial<NoteJobRecord>): NoteJobRecord {
    return recordFixture({
      status: "running",
      stage: "summary",
      inFlight: true,
      inFlightSince: NOW,
      deadlineAt: NOW + DEFAULT_DEADLINES.llmMs,
      attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 },
      ...overrides,
    });
  }

  it("1. a coldStart recoverAll arriving during a plain pass is not dropped: a follow-up pass closes the dead run", async () => {
    const clean = recordFixture({
      id: "job-a",
      videoId: "aaa",
      stage: "transcript",
      interruption: "network",
      resolvedTitle: undefined,
      targetNotePath: undefined,
    });
    const dead = deadSummaryRun({ id: "job-b", videoId: "bbb" });
    const h = makeHarness({ records: [clean, dead] });
    h.stages.fetch.manual = true;
    const gate = deferred<void>();
    h.io.gate = gate.promise;
    // The plain pass resumes job-a (continue/transcript); its bumped-record
    // write is what the gate parks.
    h.io.gateWhen = (record) => record.id === "job-a" && record.generation === 2;
    const plain = h.runner.recoverAll();
    await flush();
    expect(h.store.get("job-b")).toMatchObject({ status: "running" });
    const cold = h.runner.recoverAll({ coldStart: true });
    gate.resolve();
    const [plainPrompts, coldPrompts] = await Promise.all([plain, cold]);
    await flush();
    expect(coldPrompts).toEqual([]);
    expect(plainPrompts).toEqual(coldPrompts);
    expect(h.store.get("job-b")).toMatchObject({ status: "failed", interruption: "app-closed", inFlight: false });
    expect(h.runner.drainClosedOnColdStart().map((c) => c.record.id)).toEqual(["job-b"]);
    // job-a was resumed exactly once by the plain pass and is still alive:
    // an active run is never closed by the follow-up cold pass.
    expect(h.stages.fetch.count).toBe(1);
    expect(h.runner.isActive("job-a")).toBe(true);
    expect(h.store.get("job-a")).toMatchObject({ status: "running", generation: 2 });
    expect(h.stages.summ.count).toBe(0);
    // Nothing is left queued: a later call is a fresh pass with nothing to report.
    expect(await h.runner.recoverAll()).toEqual([]);
  });

  it("1b. a coldStart request landing in the microtask window between a pass completing and its finally reaction is not lost", async () => {
    // The window is a fixed number of microtask hops after the pass's last
    // write resolves; instead of guessing the depth, every depth from 0 to
    // 16 ticks is tried on a fresh harness and the dead run must be marked
    // in all of them (the request either joins the in-flight pass, is
    // queued behind it, or starts a fresh cold pass — never dropped).
    for (let ticks = 0; ticks <= 16; ticks++) {
      const clean = recordFixture({
        id: "job-a",
        videoId: "aaa",
        stage: "transcript",
        interruption: "network",
        resolvedTitle: undefined,
        targetNotePath: undefined,
      });
      const dead = deadSummaryRun({ id: "job-b", videoId: "bbb" });
      const h = makeHarness({ records: [clean, dead] });
      h.stages.fetch.manual = true;
      const gate = deferred<void>();
      h.io.gate = gate.promise;
      h.io.gateWhen = (record) => record.id === "job-a" && record.generation === 2;
      const plain = h.runner.recoverAll();
      await flush();
      gate.resolve();
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      const cold = h.runner.recoverAll({ coldStart: true });
      await Promise.all([plain, cold]);
      await flush();
      expect(h.store.get("job-b"), `ticks=${ticks}`).toMatchObject({ status: "failed", interruption: "app-closed" });
      expect(await cold, `ticks=${ticks}`).toEqual([]);
      expect(h.stages.fetch.count, `ticks=${ticks}`).toBe(1);
    }
  });

  it("2. a nested transcript re-fetch that settles as a network error leaves a clean summary checkpoint, not paid-stage-in-flight", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await timeOutSummary(h);
    h.stages.fetch.failWith = new Error("net down");
    expect(await h.runner.resume(id, { confirmed: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.fetch.count).toBe(2);
    expect(h.stages.summ.count).toBe(1);
    expect(h.runner.isActive(id)).toBe(false);
    expect(lastRecord(h)).toMatchObject({
      status: "interrupted",
      interruption: "network",
      stage: "summary",
      inFlight: false,
      lastError: "net down",
      generation: 2,
    });
    const interrupted = h.events.filter((e) => e.type === "interrupted").pop();
    expect(interrupted).toEqual({ type: "interrupted", id, prompt: { action: "continue", fromStage: "summary" } });
    // Free billing: recovery continues it unattended — re-fetch, then the summary again.
    expect(await h.runner.recoverAll()).toEqual([]);
    await flush();
    expect(h.stages.fetch.count).toBe(3);
    expect(h.stages.summ.count).toBe(2);
    expect(lastRecord(h)).toMatchObject({ status: "running", stage: "summary", inFlight: true, generation: 3 });
  });

  it("2b. the same re-fetch settling as a timeout also clears the flight (the summary was never called)", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await timeOutSummary(h);
    h.stages.fetch.manual = true;
    expect(await h.runner.resume(id, { confirmed: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.fetch.count).toBe(2);
    await h.clock.advance(DEFAULT_DEADLINES.transcriptMs);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", interruption: "timeout", stage: "summary", inFlight: false });
    const interrupted = h.events.filter((e) => e.type === "interrupted").pop();
    expect(interrupted).toEqual({ type: "interrupted", id, prompt: { action: "continue", fromStage: "summary" } });
    expect(h.stages.summ.count).toBe(1);
  });

  it("3. submit during a cold-start recoverAll: the new job is active before the closing pass lists it, so it runs", async () => {
    const h = makeHarness();
    h.stages.fetch.manual = true;
    const gate = deferred<void>();
    h.io.gate = gate.promise;
    h.io.gateWhen = (record) => record.id === "job-1";
    const submitted = h.runner.submit(SUBMIT);
    const recovered = h.runner.recoverAll({ coldStart: true });
    gate.resolve();
    const [result, prompts] = await Promise.all([submitted, recovered]);
    await flush();
    expect(result).toEqual({ kind: "started", id: "job-1" });
    expect(prompts).toEqual([]);
    expect(h.runner.isActive("job-1")).toBe(true);
    expect(h.stages.fetch.count).toBe(1);
    expect(h.store.get("job-1")).toMatchObject({ status: "running", stage: "transcript", inFlight: true, generation: 1 });
    expect(persistedRecords(h).some((r) => r.interruption === "app-closed")).toBe(false);
    // The pre-call persist still precedes the fetch and the initial record write still lands first.
    expect(persistedRecords(h)[0]).toMatchObject({ stage: "transcript", inFlight: false, attempts: { transcript: 0 } });
    expect(persistedRecords(h)[1]).toMatchObject({ stage: "transcript", inFlight: true, attempts: { transcript: 1 } });
  });

  it("4. note-missing at timestamps with attempts.summary = 3 is attempts-exhausted even when confirmed (coverage)", async () => {
    const h = makeHarness({
      records: [
        recordFixture({
          stage: "timestamps",
          notePath: TARGET_PATH, // deleted from the vault
          attempts: { transcript: 1, summary: MAX_STAGE_ATTEMPTS, timestamps: 1, translation: 0 },
        }),
      ],
    });
    const declined = await h.runner.resume("job-1", { confirmed: false });
    expect(askUser((declined as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "note-missing", stage: "timestamps" });
    const confirmed = await h.runner.resume("job-1", { confirmed: true });
    expect(confirmed.kind).toBe("prompt");
    expect(askUser((confirmed as { prompt: RecoveryPrompt }).prompt)).toMatchObject({ reason: "attempts-exhausted", stage: "summary" });
    await flush();
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
    expect(h.stages.stamps.count).toBe(0);
    expect(h.io.calls).toHaveLength(0);
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("5. run()'s catch whose own persist also rejects still emits failed once, stops the heartbeat and leaves no unhandled rejection (coverage)", async () => {
    const h = makeHarness();
    // Every write of a summary-stage record fails: the post-transcript
    // persist AND the catch's best-effort interrupted persist.
    h.io.failEvery = (record) => record.stage === "summary";
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([{ type: "failed", id: "job-1", error: "disk full" }]);
    expect(h.store.get("job-1")).toMatchObject({ status: "interrupted", interruption: "unknown", lastError: "disk full", stage: "summary" });
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
    // FakeIO records a payload before rejecting it: exactly two summary-stage
    // writes were attempted (post-transcript, then the catch's own), no more.
    const summaryWrites = persistedRecords(h).filter((r) => r.stage === "summary");
    expect(summaryWrites.map((r) => r.status)).toEqual(["running", "interrupted"]);
  });
});

describe("JobRunner — T6 review: addTimestampLinks, deadline timers", () => {
  it("a record with addTimestampLinks: false never calls addTimestamps: done/user-choice, no timestamps attempt", async () => {
    const h = makeHarness();
    await h.runner.submit({ ...SUBMIT, addTimestampLinks: false });
    await flush();
    expect(h.stages.summ.count).toBe(1);
    expect(h.stages.create.count).toBe(1);
    expect(h.stages.stamps.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({
      stage: "done",
      status: "done",
      addTimestampLinks: false,
      notePath: TARGET_PATH,
      attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 },
    });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice" },
    ]);
  });

  it("submit persists addTimestampLinks: true verbatim and the timestamps stage then runs", async () => {
    const h = makeHarness();
    await h.runner.submit({ ...SUBMIT, addTimestampLinks: true });
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ stage: "done", addTimestampLinks: true, attempts: { timestamps: 1 } });
  });

  it("an older record without the field (absent ⇒ true) still runs the timestamps stage", async () => {
    const h = makeHarness({
      records: [recordFixture({ stage: "note-created", notePath: TARGET_PATH, inFlight: false })],
      files: { [TARGET_PATH]: "anything" },
    });
    expect(h.store.get("job-1")?.addTimestampLinks).toBeUndefined();
    expect(await h.runner.resume("job-1", { confirmed: false })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.stamps.count).toBe(1);
  });

  it("an addTimestampLinks: false record resumed at note-created finishes without a timestamps call", async () => {
    const h = makeHarness({
      records: [recordFixture({ addTimestampLinks: false, stage: "note-created", notePath: TARGET_PATH, inFlight: false })],
      files: { [TARGET_PATH]: "anything" },
    });
    expect(await h.runner.resume("job-1", { confirmed: false })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.stamps.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done", generation: 2, attempts: { timestamps: 0 } });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice" },
    ]);
  });

  it("cancel during a pending summary clears the deadline timer too (stopRun leaves no timers)", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await h.runner.cancel(id);
    await flush();
    expect(h.clock.pendingCount()).toBe(0);
    const writes = h.io.calls.length;
    // The dangling call settling later still applies nothing.
    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    expect(h.stages.render.count).toBe(0);
    expect(h.io.calls.length).toBe(writes);
  });

  it("discard during a pending summary leaves no timers", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    await h.runner.discard(id);
    await flush();
    expect(h.clock.pendingCount()).toBe(0);
  });
});

describe("JobRunner — T6b: stopAll, fast summary, promptFor", () => {
  it("stopAll stops every heartbeat, fences late completions in-process and leaves the persisted status untouched", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    expect(h.runner.isActive(id)).toBe(true);
    const writesBefore = h.io.calls.length;

    h.runner.stopAll();

    expect(h.runner.isActive(id)).toBe(false);
    // Every runner timer is gone: the heartbeat AND the summary's deadline.
    expect(h.clock.pendingCount()).toBe(0);
    // The persisted record is NOT rewritten: the next cold start closes it (app-closed).
    expect(h.io.calls.length).toBe(writesBefore);
    expect(lastRecord(h).status).toBe("running");
    expect(h.store.get(id)?.status).toBe("running");

    // A completion landing after stopAll applies no side effect at all.
    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    expect(h.stages.render.count).toBe(0);
    expect(h.stages.create.count).toBe(0);
    expect(h.io.calls.length).toBe(writesBefore);
    expect(h.events.filter((e) => e.type !== "progress")).toEqual([]);
    // No heartbeat write ever comes back either.
    await h.clock.advance(3 * HEARTBEAT_INTERVAL_MS);
    expect(h.io.calls.length).toBe(writesBefore);
  });

  it("a fast-summary record never calls addTimestamps: done with timestampsSkipped user-choice, no timestamps attempt", async () => {
    const h = makeHarness();
    await h.runner.submit({ ...SUBMIT, useFastSummary: true });
    await flush();
    expect(h.stages.summ.count).toBe(1);
    expect(h.stages.create.count).toBe(1);
    expect(h.stages.stamps.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({
      stage: "done",
      status: "done",
      inFlight: false,
      notePath: TARGET_PATH,
      attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 },
    });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice" },
    ]);
    expect(h.events.filter((e) => e.type === "progress").map((e) => (e as { stage: string }).stage)).not.toContain("timestamps");
    expect(h.runner.isActive("job-1")).toBe(false);
  });

  it("a fast-summary record resumed at note-created also finishes without a timestamps call", async () => {
    const h = makeHarness({
      records: [recordFixture({ useFastSummary: true, stage: "note-created", notePath: TARGET_PATH, inFlight: false })],
      files: { [TARGET_PATH]: "anything" },
    });
    expect(await h.runner.resume("job-1", { confirmed: false })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.stamps.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done", generation: 2 });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice" },
    ]);
  });

  it("promptFor(id) is read-only: live for an active run, the classified prompt otherwise, undefined for an unknown id", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    const writes = h.io.calls.length;
    expect(await h.runner.promptFor(id)).toEqual({ action: "nothing", why: "live" });
    await timeOutSummary(h);
    const interrupted = h.events.filter((e) => e.type === "interrupted") as Array<{ prompt: RecoveryPrompt }>;
    expect(interrupted).toHaveLength(1);
    const writesAfterTimeout = h.io.calls.length;
    expect(writesAfterTimeout).toBeGreaterThan(writes);
    // One tick past the deadline so the planner (now > deadlineAt) reads the
    // interruption as a timeout, exactly as the runner reported it firsthand.
    await h.clock.advance(1);
    expect(await h.runner.promptFor(id)).toEqual(interrupted[0].prompt);
    // Holds because this record's paths are already normalized: the only
    // write promptFor may ever make is a legacy record's path re-normalization.
    expect(h.io.calls.length).toBe(writesAfterTimeout);
    expect(h.runner.isActive(id)).toBe(false);
    expect(await h.runner.promptFor("nope")).toBeUndefined();
  });
});

describe("JobRunner — cold start: a job lives and dies with the instance that started it (#3 batch E)", () => {
  function runningTranscript(overrides: Partial<NoteJobRecord>): NoteJobRecord {
    return recordFixture({
      status: "running",
      stage: "transcript",
      inFlight: true,
      inFlightSince: NOW,
      deadlineAt: NOW + DEFAULT_DEADLINES.transcriptMs,
      resolvedTitle: undefined,
      targetNotePath: undefined,
      attempts: { transcript: 1, summary: 0, timestamps: 0, translation: 0 },
      ...overrides,
    });
  }

  const CLOSED = { status: "failed", interruption: "app-closed", inFlight: false, generation: 1 };

  it("(a) a running record owned by THIS installation is closed on cold start: failed/app-closed, no prompt, no stage call", async () => {
    const h = makeHarness({ records: [runningTranscript({ installationId: INSTALLATION_ID })] });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    expect(h.io.calls).toHaveLength(1);
    expect(h.stages.fetch.count).toBe(0);
    expect(h.store.get("job-1")).toMatchObject({ ...CLOSED, installationId: INSTALLATION_ID, attempts: { transcript: 1 } });
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.runner.drainClosedOnColdStart().map((c) => c.record.id)).toEqual(["job-1"]);
  });

  it("(b) a running record owned by ANOTHER installation is ignored entirely: not closed, not prompted, not listed, not resumable here", async () => {
    const h = makeHarness({ records: [runningTranscript({ id: "job-elsewhere", installationId: "install-elsewhere" })] });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    expect(h.io.calls).toHaveLength(0);
    expect(h.stages.fetch.count).toBe(0);
    expect(h.store.get("job-elsewhere")).toMatchObject({ status: "running", generation: 1, installationId: "install-elsewhere" });
    expect(h.runner.drainClosedOnColdStart()).toEqual([]);
    // Invisible to the recovery UI and to resume; the visibility pass skips it too.
    expect(await h.runner.promptFor("job-elsewhere")).toBeUndefined();
    expect(await h.runner.resume("job-elsewhere", { confirmed: true })).toEqual({ kind: "missing" });
    expect(await h.runner.recoverAll()).toEqual([]);
    await flush();
    expect(h.io.calls).toHaveLength(0);
    expect(h.stages.fetch.count).toBe(0);
    // Submitting the same video here starts this installation's own job; the
    // foreign record is neither taken over nor touched.
    h.stages.fetch.manual = true;
    expect(await h.runner.submit(SUBMIT)).toEqual({ kind: "started", id: "job-1" });
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ status: "running", generation: 1, installationId: INSTALLATION_ID });
    expect(h.store.get("job-elsewhere")).toMatchObject({ status: "running", generation: 1, installationId: "install-elsewhere" });
    expect(h.stages.fetch.count).toBe(1);
  });

  it("(c) a running record with NO installation id (pre-tagging) is removed on cold start (one-time cleanup, never closed or resumed); a foreign record with a DIFFERENT id is left untouched (#3 batch G item 1)", async () => {
    const legacy = runningTranscript({});
    delete legacy.installationId;
    // Stale heartbeat: without the ownership guard the planner would auto-resume it.
    legacy.heartbeatAt = NOW - 10 * HEARTBEAT_INTERVAL_MS;
    const foreign = runningTranscript({ id: "job-elsewhere", installationId: "install-elsewhere" });
    const h = makeHarness({ records: [legacy, foreign] });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    // One write (the removal); the foreign record is never touched.
    expect(h.io.calls).toHaveLength(1);
    // Removed, not closed: no failed/app-closed record left behind, no entry in the cold-start Notice list.
    expect(h.store.get("job-1")).toBeUndefined();
    expect(h.runner.drainClosedOnColdStart()).toEqual([]);
    expect(h.stages.fetch.count).toBe(0);
    expect(await h.runner.promptFor("job-1")).toBeUndefined();
    expect(await h.runner.resume("job-1", { confirmed: true })).toEqual({ kind: "missing" });
    // A foreign (differently-installationId'd) record is a different case entirely and stays untouched.
    expect(h.store.get("job-elsewhere")).toMatchObject({ status: "running", generation: 1, installationId: "install-elsewhere" });
    expect(await h.runner.recoverAll()).toEqual([]);
    await flush();
    expect(h.stages.fetch.count).toBe(0);
  });

  it("closeOwnRuns persists each closure as it happens: a save that rejects on the SECOND record still leaves the first in the drained list (#3 batch G item 5)", async () => {
    const first = runningTranscript({ id: "job-a", videoId: "aaa" });
    const second = runningTranscript({ id: "job-b", videoId: "bbb" });
    const h = makeHarness({ records: [first, second] });
    // Not a record-shaped predicate: every closeOwnRuns write carries the FULL
    // store (both records), so a per-record check can't tell which write this
    // is. A call counter can: let the first write (job-a's closure) through,
    // fail the second (job-b's).
    let writes = 0;
    h.io.failWhen = () => {
      writes += 1;
      return writes === 2;
    };
    await expect(h.runner.recoverAll({ coldStart: true })).rejects.toThrow("disk full");
    await flush();
    expect(h.store.get("job-a")).toMatchObject({ status: "failed", interruption: "app-closed" });
    // closeOwnRuns only pushes to the drained list AFTER its own upsert
    // resolves: job-b's rejected write means it never joins the list, even
    // though the store's optimistic in-memory copy was already mutated
    // before the write was attempted (JobStore.upsert's documented order).
    // The host's Notice (main.ts, verified by inspection: recoverJobs's
    // finally drains and shows it even when the pass rejects) still has
    // job-a to report.
    expect(h.runner.drainClosedOnColdStart().map((c) => c.record.id)).toEqual(["job-a"]);
  });

  it("(d) every non-terminal shape of an own job is closed the same way, keeping notePath, claim fields, attempts and lastError as evidence", async () => {
    const shapes: Array<[string, NoteJobRecord]> = [
      [
        "interrupted, paid summary in flight",
        recordFixture({ stage: "summary", inFlight: true, inFlightSince: NOW, interruption: "timeout", attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 } }),
      ],
      [
        "note-created (note on disk)",
        recordFixture({ stage: "note-created", claimedNotePath: TARGET_PATH, claimedContentHash: "abc", claimedContentLength: 3, notePath: TARGET_PATH, attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 } }),
      ],
      [
        "running, timestamps in flight",
        recordFixture({ status: "running", stage: "timestamps", inFlight: true, inFlightSince: NOW, notePath: TARGET_PATH, attempts: { transcript: 1, summary: 1, timestamps: 1, translation: 0 } }),
      ],
      [
        "translation checkpoint",
        recordFixture({ stage: "translation", inFlight: false, notePath: TARGET_PATH, translation: { language: "fr", country: "FR" }, attempts: { transcript: 1, summary: 1, timestamps: 1, translation: 0 } }),
      ],
      [
        "interrupted with a persisted block and a lastError",
        recordFixture({ stage: "note-creating", blocked: "templater-unavailable", lastError: "Templater missing", attempts: { transcript: 1, summary: 0, timestamps: 0, translation: 0 } }),
      ],
    ];
    for (const [label, record] of shapes) {
      const h = makeHarness({ records: [record], files: { [TARGET_PATH]: "note" } });
      expect(await h.runner.recoverAll({ coldStart: true }), label).toEqual([]);
      await flush();
      const closed = h.store.get("job-1");
      expect(closed, label).toMatchObject({ ...CLOSED, stage: record.stage, attempts: record.attempts });
      expect(closed?.notePath, label).toBe(record.notePath);
      expect(closed?.claimedNotePath, label).toBe(record.claimedNotePath);
      expect(closed?.lastError, label).toBe(record.lastError);
      expect(closed?.blocked, label).toBeUndefined(); // no call is pending any more
      expect(h.io.calls, label).toHaveLength(1);
      expect(h.stages.fetch.count + h.stages.summ.count + h.stages.stamps.count + h.stages.translate.count, label).toBe(0);
      // Closed is terminal: the UI reads it so, and neither a confirmed resume nor
      // finishing without timestamps can start anything.
      expect(await h.runner.promptFor("job-1"), label).toEqual({ action: "nothing", why: "terminal" });
      expect(await h.runner.resume("job-1", { confirmed: true }), label).toEqual({ kind: "prompt", prompt: { action: "nothing", why: "terminal" } });
      expect(await h.runner.resume("job-1", { confirmed: true, finishWithoutTimestamps: true }), label).toEqual({ kind: "prompt", prompt: { action: "nothing", why: "terminal" } });
      expect(await h.runner.recoverAll(), label).toEqual([]);
      await flush();
      expect(h.io.calls, label).toHaveLength(1);
      expect(h.events, label).toEqual([]);
    }
  });

  it("noteMayExist probes the NORMALIZED claimed path: an NFD claimedNotePath still matches the vault's NFC-indexed note (#3 batch H)", async () => {
    const nfcPath = "안녕하세요.md".normalize("NFC");
    const nfdPath = "안녕하세요.md".normalize("NFD");
    expect(nfdPath).not.toBe(nfcPath); // the fixture really is NFD
    const record = recordFixture({
      stage: "note-creating",
      claimedNotePath: nfdPath,
      notePath: undefined,
      attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 },
    });
    const h = makeHarness({ records: [record], files: { [nfcPath]: "note" } });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    await flush();
    const [closed] = h.runner.drainClosedOnColdStart();
    expect(closed?.noteMayExist).toBe(true);
  });

  it("(e) a closed job no longer claims its video: submitting the same URL again starts a NEW job", async () => {
    const h = makeHarness({ records: [runningTranscript({ id: "job-0", installationId: INSTALLATION_ID })] });
    expect(await h.runner.recoverAll({ coldStart: true })).toEqual([]);
    h.stages.fetch.manual = true;
    const result = await h.runner.submit(SUBMIT);
    expect(result).toEqual({ kind: "started", id: "job-1" });
    await flush();
    expect(h.store.list().map((r) => [r.id, r.status])).toEqual([
      ["job-0", "failed"],
      ["job-1", "running"],
    ]);
  });

  it("submit stamps the record with this installation's id", async () => {
    const h = makeHarness();
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.store.get("job-1")?.installationId).toBe(INSTALLATION_ID);
  });

  it("a legacy record carrying interruption 'app-restart' is closed on hydrate, before the runner ever sees it: never offered as Resume (#3 batch G item b)", async () => {
    const legacy = recordFixture({
      status: "interrupted",
      interruption: "app-restart",
      stage: "summary",
      blocked: "templater-unavailable",
      installationId: INSTALLATION_ID,
    });
    const snapshot = { [JOBS_KEY]: [legacy] };
    const h = makeHarness({ snapshot });
    const record = h.store.get("job-1");
    expect(record).toMatchObject({ status: "failed", interruption: "app-closed" });
    expect(record?.blocked).toBeUndefined();
    expect(await h.runner.promptFor("job-1")).toEqual({ action: "nothing", why: "terminal" });
    expect(await h.runner.resume("job-1", { confirmed: true })).toEqual({
      kind: "prompt",
      prompt: { action: "nothing", why: "terminal" },
    });
  });
});

describe("JobRunner — cancel and discard ignore records owned by another installation (#3 batch F)", () => {
  it("cancel on a foreign record is a silent no-op: no status/generation change, no store write, no cancelled event", async () => {
    const h = makeHarness({ records: [recordFixture({ id: "job-elsewhere", status: "running", installationId: "install-elsewhere" })] });
    const writesBefore = h.io.calls.length;
    await h.runner.cancel("job-elsewhere");
    await flush();
    expect(h.store.get("job-elsewhere")).toMatchObject({ status: "running", generation: 1, installationId: "install-elsewhere" });
    expect(h.io.calls.length).toBe(writesBefore);
    expect(h.events.filter((e) => e.type === "cancelled")).toEqual([]);
  });

  it("cancel on a record with no installationId (pre-tagging) is likewise ignored", async () => {
    const legacy = recordFixture({ status: "running" });
    delete legacy.installationId;
    const h = makeHarness({ records: [legacy] });
    const writesBefore = h.io.calls.length;
    await h.runner.cancel("job-1");
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ status: "running", generation: 1 });
    expect(h.io.calls.length).toBe(writesBefore);
    expect(h.events.filter((e) => e.type === "cancelled")).toEqual([]);
  });

  it("discard on a foreign record leaves it present in the store, no write", async () => {
    const h = makeHarness({ records: [recordFixture({ id: "job-elsewhere", installationId: "install-elsewhere" })] });
    const writesBefore = h.io.calls.length;
    await h.runner.discard("job-elsewhere");
    await flush();
    expect(h.store.get("job-elsewhere")).toMatchObject({ installationId: "install-elsewhere" });
    expect(h.io.calls.length).toBe(writesBefore);
  });

  it("discard on a record with no installationId is likewise ignored", async () => {
    const legacy = recordFixture({});
    delete legacy.installationId;
    const h = makeHarness({ records: [legacy] });
    const writesBefore = h.io.calls.length;
    await h.runner.discard("job-1");
    await flush();
    expect(h.store.get("job-1")).toBeDefined();
    expect(h.io.calls.length).toBe(writesBefore);
  });

  it("cancel and discard on an OWNED record still work as before", async () => {
    const h = makeHarness({ records: [recordFixture({ status: "running", installationId: INSTALLATION_ID })] });
    await h.runner.cancel("job-1");
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ status: "cancelled", generation: 2 });
    expect(h.events.filter((e) => e.type === "cancelled")).toEqual([{ type: "cancelled", id: "job-1" }]);
    await h.runner.discard("job-1");
    await flush();
    expect(h.store.get("job-1")).toBeUndefined();
  });

  it("cancel clears a persisted `blocked` so a cancelled record never renders a live Resume (#3 batch G item 3)", async () => {
    const h = makeHarness({
      records: [recordFixture({ status: "interrupted", stage: "note-creating", blocked: "note-collision", installationId: INSTALLATION_ID })],
    });
    await h.runner.cancel("job-1");
    await flush();
    const record = h.store.get("job-1");
    expect(record).toMatchObject({ status: "cancelled", interruption: "cancelled" });
    expect(record?.blocked).toBeUndefined();
    // promptForRecord checks `blocked` before terminality: an uncleared block would still ask-user a Resume.
    expect(await h.runner.promptFor("job-1")).toEqual({ action: "nothing", why: "terminal" });
  });
});

describe("JobRunner — final review C1: path drift and frozen path settings", () => {
  it("freezes notePathSettings and a NORMALIZED target at the transcript stage", async () => {
    const h = makeHarness();
    await h.runner.submit({ ...SUBMIT, customTitle: "안녕하세요" });
    await flush();
    const record = h.store.get("job-1");
    expect(record?.notePathSettings).toEqual({ prependDate: false, dateFormat: "YYYY-MM-DD" });
    expect(record?.targetNotePath).toBe("안녕하세요.md".normalize("NFC"));
    expect(record?.targetNotePath).not.toBe("안녕하세요.md".normalize("NFD"));
    expect(record?.notePath).toBe(record?.targetNotePath);
    expect(record?.claimedNotePath).toBe(record?.targetNotePath);
    expect(record?.status).toBe("done");
  });

  it("a PathDriftError from renderNote blocks the job as path-drift (interrupted, resumable at summary), never failed", async () => {
    const h = makeHarness();
    h.stages.render.failWith = new PathDriftError("Target path drift: rendered elsewhere");
    await h.runner.submit(SUBMIT);
    await flush();
    const record = h.store.get("job-1");
    expect(record).toMatchObject({ status: "interrupted", blocked: "path-drift", stage: "summary", inFlight: false });
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
    expect(h.stages.create.count).toBe(0);
    const interrupted = h.events.filter((e) => e.type === "interrupted") as Array<{ prompt: RecoveryPrompt }>;
    expect(askUser(interrupted[0].prompt)).toMatchObject({ reason: "path-drift", stage: "summary" });
    // Resume re-enters at summary: the render is now consistent, and the job completes.
    h.stages.render.failWith = null;
    expect((await h.runner.resume("job-1", { confirmed: true })).kind).toBe("resumed");
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ status: "done", generation: 2 });
    expect(h.stages.summ.count).toBe(2);
  });

  it("pre-paid drift check: a target that no longer matches the frozen derivation blocks BEFORE any refetch or summary", async () => {
    const drifted = recordFixture({
      stage: "summary",
      interruption: "network",
      notePathSettings: { prependDate: false, dateFormat: "YYYY-MM-DD" },
      targetNotePath: "Somewhere-else.md",
    });
    const h = makeHarness({ records: [drifted] });
    expect((await h.runner.resume("job-1", { confirmed: true })).kind).toBe("resumed");
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ status: "interrupted", blocked: "path-drift", stage: "summary" });
    expect(h.stages.fetch.count).toBe(0);
    expect(h.stages.summ.count).toBe(0);
  });

  it("a record frozen before notePathSettings existed falls back to the live settings once and freezes them", async () => {
    const legacy = recordFixture({ stage: "summary", interruption: "network" });
    delete legacy.notePathSettings;
    const h = makeHarness({ records: [legacy] });
    expect((await h.runner.resume("job-1", { confirmed: true })).kind).toBe("resumed");
    await flush();
    expect(h.store.get("job-1")).toMatchObject({
      status: "done",
      notePathSettings: { prependDate: false, dateFormat: "YYYY-MM-DD" },
      notePath: TARGET_PATH,
    });
  });
});

describe("JobRunner — translation stage (#3 final review residual)", () => {
  const FR = { language: "fr", country: "FR" };

  it("freezes the live translation settings at the transcript stage and persists a CLEAN translation checkpoint after the timestamps write, before the translation pre-call", async () => {
    const h = makeHarness({ translation: FR });
    await h.runner.submit(SUBMIT);
    await flush();
    const records = persistedRecords(h);
    expect(records[2].translation).toEqual(FR); // frozen with the title and target
    expect(records.map((r) => `${r.stage}/${r.inFlight ? "in" : "out"}`)).toEqual([
      "transcript/out",
      "transcript/in",
      "summary/out",
      "summary/in",
      "note-creating/in",
      "note-created/out",
      "timestamps/in",
      "translation/out", // the timestamps pass is on disk: a crash here resumes at translation, never at timestamps
      "translation/in", // pre-translate: attempts.translation bumped
      "done/out",
    ]);
    expect(records[7].attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 0 });
    expect(records[8].attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 1 });
    expect(records[8].deadlineAt).toBe(NOW + DEFAULT_DEADLINES.llmMs);
    expect(h.stages.stamps.count).toBe(1);
    expect(h.stages.translate.calls).toEqual([[expect.objectContaining({ translation: FR }), TARGET_PATH]]);
    expect(h.events.filter((e) => e.type === "progress").map((e) => (e.type === "progress" ? e.message : ""))).toContain("Translating note");
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
  });

  it("a nested re-fetch (resumed summary) never re-freezes: settings changed since submit do not reach the record", async () => {
    const h = makeHarness({
      records: [recordFixture({ stage: "summary", inFlight: false })],
      translation: FR,
    });
    expect(h.store.get("job-1")?.translation).toBeUndefined();
    expect(await h.runner.resume("job-1", { confirmed: false })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done" });
    expect("translation" in lastRecord(h)).toBe(false);
    expect(h.stages.translate.count).toBe(0);
  });

  it("a translation timeout leaves the stage in flight and asks with finish offered; the budget is its own (attempts.translation)", async () => {
    const h = makeHarness({ translation: FR });
    h.stages.translate.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.translate.count).toBe(1);
    await h.clock.advance(DEFAULT_DEADLINES.llmMs + 1);
    const record = lastRecord(h);
    expect(record).toMatchObject({ stage: "translation", status: "interrupted", interruption: "timeout", inFlight: true });
    expect(record.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 1 });
    const interrupted = h.events.find((e) => e.type === "interrupted");
    expect(interrupted).toMatchObject({
      prompt: { action: "ask-user", reason: "paid-stage-in-flight", stage: "translation", canFinishWithoutTimestamps: true, interruption: "timeout" },
    });
    // The late completion applies nothing (generation fence).
    h.stages.translate.resolveLast(undefined);
    await flush();
    expect(lastRecord(h).status).toBe("interrupted");
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
  });

  it("attempts.translation exhausted: a confirmed resume is refused, finishing without translation completes with no call", async () => {
    const h = makeHarness({
      records: [
        recordFixture({
          stage: "translation",
          inFlight: true,
          notePath: TARGET_PATH,
          translation: FR,
          attempts: { transcript: 1, summary: 1, timestamps: 1, translation: MAX_STAGE_ATTEMPTS },
        }),
      ],
      files: { [TARGET_PATH]: "anything" },
      translation: FR,
    });
    const refused = await h.runner.resume("job-1", { confirmed: true });
    expect(refused).toMatchObject({ kind: "prompt", prompt: { reason: "attempts-exhausted", stage: "translation", canFinishWithoutTimestamps: true } });
    expect(await h.runner.resume("job-1", { confirmed: true, finishWithoutTimestamps: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.translate.count).toBe(0);
    expect(h.stages.stamps.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done", inFlight: false });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, translationSkipped: "user-choice" },
    ]);
  });

  it("finishing without timestamps at the TIMESTAMPS stage of a job with frozen translation skips both, and says so", async () => {
    const h = makeHarness({
      records: [recordFixture({ stage: "timestamps", inFlight: true, notePath: TARGET_PATH, translation: FR, attempts: { transcript: 1, summary: 1, timestamps: 1, translation: 0 } })],
      files: { [TARGET_PATH]: "anything" },
      translation: FR,
    });
    expect(await h.runner.resume("job-1", { confirmed: true, finishWithoutTimestamps: true })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.translate.count).toBe(0);
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice", translationSkipped: "user-choice" },
    ]);
  });

  it("the note-created checkpoint of a frozen-translation record resumes through timestamps then translation (adopt-note path)", async () => {
    const h = makeHarness({
      records: [recordFixture({ stage: "note-created", inFlight: false, notePath: TARGET_PATH, translation: FR })],
      files: { [TARGET_PATH]: "anything" },
    });
    expect(await h.runner.resume("job-1", { confirmed: false })).toEqual({ kind: "resumed" });
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    expect(h.stages.translate.count).toBe(1);
    expect(lastRecord(h)).toMatchObject({ stage: "done", status: "done", attempts: { timestamps: 1, translation: 1 } });
  });
});
