import { describe, expect, it } from "vitest";
import { assertRecordIsMetadataOnly } from "./job-record";
import type { NoteJobRecord } from "./job-record";
import { JobStore } from "./job-store";
import { DEFAULT_DEADLINES, JobRunner, NoteChangedError, PathDriftError, PermanentJobError } from "./job-runner";
import type { JobEvent, JobStages, RunnerDeps, SubmitInput } from "./job-runner";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
// This harness's installation (spec I3): stamped on every record submit
// creates, which is all the id is used for now.

// Distinctive bodies so test 16 can prove they never reach data.json. The
// word "summary" legitimately appears in payloads (useFastSummary, a
// lastError mentioning the paid summary), so the sentinels must not be that
// word.
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

// The real store, with every mutation recorded and made gateable.
//
// Records are memory-only (#10), so there is no saveData to observe any more.
// What these tests were really watching through it — the sequence of record
// states, and the window an `await store.upsert(...)` holds open for a cancel
// to land in — lives on the store itself, so that is where the recorder sits
// now. Each entry in `calls` is the whole record set as it stood after one
// mutation, which is exactly what a written payload used to hold.
class RecordingStore extends JobStore {
  calls: unknown[] = [];
  /** when it matches the first record of a snapshot, that mutation blocks on `gate` (once) */
  gateWhen: ((record: NoteJobRecord) => boolean) | null = null;
  gate: Promise<void> | null = null;
  /** when it matches, that mutation rejects (once) */
  failWhen: ((record: NoteJobRecord) => boolean) | null = null;
  /** when it matches, that mutation rejects (every time — a store that keeps failing) */
  failEvery: ((record: NoteJobRecord) => boolean) | null = null;

  async upsert(record: NoteJobRecord, now: number): Promise<void> {
    // Validation first, exactly as the base class orders it: an invalid
    // record is rejected before it is stored or recorded.
    assertRecordIsMetadataOnly(record);
    // The base upsert has no internal await, so the map is updated by the
    // time it returns. Snapshot in this same tick — the old serialized writer
    // composed its payload synchronously inside upsert too, and a mutation
    // landing while this call is suspended must not overwrite this one's
    // evidence.
    const applied = super.upsert(record, now);
    this.calls.push(this.list());
    await applied;
    await this.gateOrFail();
  }

  private async gateOrFail(): Promise<void> {
    const record = (this.calls[this.calls.length - 1] as NoteJobRecord[])[0];
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

// Just the file map now: the runner stopped probing the vault with #10, so
// the only thing that still touches this is FakeStages.create and the tests
// that assert what did (or did not) land.
class FakeVault {
  readonly files = new Map<string, string>();
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
  readonly create: Stub<[string, string], string>;
  readonly stamps = new Stub<[NoteJobRecord, string], void>(() => undefined);
  readonly translate = new Stub<[NoteJobRecord, string], void>(() => undefined);

  constructor(vault: FakeVault) {
    // Returns the path it wrote: the real adapter resolves with the path the
    // note actually landed on, which the runner records as notePath.
    this.create = new Stub<[string, string], string>((path, content) => {
      vault.files.set(path, content);
      return path;
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
  createNote(path: string, content: string): Promise<string> {
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
  store: RecordingStore;
  io: RecordingStore;
  stages: FakeStages;
  vault: FakeVault;
  clock: FakeClock;
  events: JobEvent[];
  deps: RunnerDeps;
}

// The `records` / `snapshot` / `files` options are gone with #10: every one of
// them pre-loaded a store with a record from a previous process, which was only
// ever an input to recovery. A job now starts at submit and nowhere else.
interface HarnessOptions {
  /** Live translation settings the transcript stage freezes (undefined = en/US, nothing frozen). */
  translation?: { language: string; country: string };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const store = new RecordingStore();
  const io = store;
  const vault = new FakeVault();
  const stages = new FakeStages(vault);
  const clock = new FakeClock(NOW);
  const events: JobEvent[] = [];
  let ids = 0;
  const deps: RunnerDeps = {
    store,
    stages,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    notePathSettings: () => ({ prependDate: false, dateFormat: "YYYY-MM-DD" }),
    translationSettings: () => options.translation,
    normalizePath: (path) => path.normalize("NFC"),
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

/** One recorded snapshot: the store's whole record set after a single mutation. */
function jobsIn(snapshot: unknown): NoteJobRecord[] {
  return snapshot as NoteJobRecord[];
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
  expect(record.inFlight).toBe(true);
}

describe("JobRunner — happy path", () => {
  it("1. runs every stage in order and creates the note with the rendered content", async () => {
    const h = makeHarness();
    let contentGiven = "";
    h.stages.create.onCall = (_path, content) => {
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

    // The note is created with exactly what renderNote produced.
    expect(contentGiven).toBe(renderedContent());
    expect(h.vault.files.get(TARGET_PATH)).toBe(renderedContent());

    // Every in-flight checkpoint carried a deadline and an attempt bump.
    for (const record of persistedRecords(h).filter((r) => r.inFlight)) {
      expect(record.deadlineAt).toBeGreaterThan(NOW);
      expect(record.inFlightSince).toBe(NOW);
    }

    const final = lastRecord(h);
    expect(final.stage).toBe("done");
    expect(final.status).toBe("done");
    expect(final.inFlight).toBe(false);
    expect(final.notePath).toBe(TARGET_PATH);
    expect(final.resolvedTitle).toBe(VIDEO_TITLE);
    expect(final.targetNotePath).toBe(TARGET_PATH);
    expect(final.deadlineAt).toBeUndefined();
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
  });

  it("1b. notePath is the path createNote RESOLVED with, never the one it was asked for", async () => {
    // The real adapter steps to a free neighbour when the target is taken and
    // resolves with the path the note actually landed on; the record must
    // follow the create, not the request.
    const h = makeHarness();
    h.stages.create.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.create.count).toBe(1);
    expect(h.stages.create.calls[0][0]).toBe(TARGET_PATH);
    const landed = "Video-Title 1.md";
    h.vault.files.set(landed, renderedContent());
    h.stages.create.resolveLast(landed);
    await flush();
    const final = lastRecord(h);
    expect(final.notePath).toBe(landed);
    expect(h.stages.stamps.calls[0][1]).toBe(landed);
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: landed }]);
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

describe("JobRunner — generation fence", () => {
  it("5. a completion that lands after the deadline timeout applies no side effect", async () => {
    const h = makeHarness();
    await submitUntilSummaryPending(h);
    await timeOutSummary(h);
    const writesAtTimeout = h.io.calls.length;
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id: "job-1" }]);
    expect(h.runner.isActive("job-1")).toBe(false);

    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    await h.clock.advance(DEFAULT_DEADLINES.llmMs);

    expect(h.stages.render.count).toBe(0);
    expect(h.stages.create.count).toBe(0);
    expect(h.io.calls.length).toBe(writesAtTimeout);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", inFlight: true, generation: 1 });
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

describe("JobRunner — submit", () => {
  it("9. a duplicate videoId is refused only while that job is LIVE; once it has stopped, a second submit is a second job", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    // Live in this process: the same video twice at once is a double tap.
    expect(await h.runner.submit(SUBMIT)).toEqual({ kind: "already-running", id });
    expect(h.store.list()).toHaveLength(1);

    // Once that run has stopped, the person asking again is asking again: the
    // job that died is not offered back to them, a new one starts (#10).
    await timeOutSummary(h);
    // The second run is an ordinary one: let its summarize resolve.
    h.stages.summ.manual = false;
    const again = await h.runner.submit(SUBMIT);
    expect(again).toEqual({ kind: "started", id: "job-2" });
    await flush();
    expect(h.store.list()).toHaveLength(2);
    expect(h.store.get("job-2")?.status).toBe("done");
    expect(h.stages.fetch.count).toBe(2);
  });
});

describe("JobRunner — the free prechecks before a paid call", () => {
  it("11. an unavailable template engine FAILS the job before the paid call, never after it", async () => {
    // It used to be a `block`: an interrupted job the person could resume once
    // Templater was back. There is no resume left (#10), so it is an ordinary
    // failure — and the point that mattered still holds, which is that nothing
    // is billed for a note that could never have been rendered.
    const h = makeHarness();
    h.stages.templaterAvailable = false;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    expect(h.stages.create.count).toBe(0);
    expect(lastRecord(h)).toMatchObject({ status: "failed", inFlight: false, stage: "summary" });
    expect(h.events.filter((e) => e.type === "failed")).toEqual([
      { type: "failed", id: "job-1", error: "The template engine is not available" },
    ]);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
    expect(h.runner.isActive("job-1")).toBe(false);
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

  it("12b. a job whose own flags skip the pass finishes with timestampsSkipped: user-choice and no LLM call", async () => {
    // The vehicle used to be finishWithoutTimestamps on a resume. The SKIP
    // REASON outlives it: `user-choice` is still what a job says when its own
    // frozen flags mean the paid pass never runs.
    const h = makeHarness();
    await h.runner.submit({ ...SUBMIT, addTimestampLinks: false });
    await flush();
    expect(h.stages.stamps.count).toBe(0);
    const final = lastRecord(h);
    expect(final).toMatchObject({ stage: "done", status: "done", inFlight: false, generation: 1 });
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

  it("a non-permanent error interrupts rather than fails, keeps inFlight, and emits the interrupted event", async () => {
    // Why `interrupted` and not `failed`: a socket hanging up is not a verdict
    // that the video can never work. The EVENT is still live wiring — a
    // collection advances past the child on it, and the progress notice closes.
    const h = makeHarness();
    h.stages.fetch.failWith = new Error("socket hang up");
    await h.runner.submit(SUBMIT);
    await flush();
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", inFlight: true, lastError: "socket hang up" });
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id: "job-1" }]);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
  });
});

describe("JobRunner — timer hygiene", () => {
  // These two used to be about the heartbeat, which #10 removed: it was a
  // liveness probe, and nothing is left that needs to tell a stale run from a
  // live one. The claim they made is still true and still worth proving, so
  // they are re-expressed against the deadline timers, which stay: a cancelled
  // or unloaded run leaves NO timer behind and writes nothing afterwards.
  it("a cancelled run leaves no timer behind: nothing fires, and nothing is written, ever again", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    // A live run has its stage deadline armed.
    expect(h.clock.pendingCount()).toBe(1);
    await h.runner.cancel(id);
    await flush();
    const writes = h.io.calls.length;
    // cancel (stopRun) disarmed the dangling call's deadline (T6 review #2).
    expect(h.clock.pendingCount()).toBe(0);
    // Advance well past what the summary's own deadline would have been.
    await h.clock.advance(3 * DEFAULT_DEADLINES.llmMs);
    expect(h.io.calls.length).toBe(writes);
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
  });
});

describe("JobRunner — cancel fences a run mid-flight", () => {
  it("cancel during note-creating (ii): a create that lands anyway never becomes notePath", async () => {
    const h = makeHarness();
    h.stages.create.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.create.count).toBe(1);
    await h.runner.cancel("job-1");
    await flush();
    h.stages.create.resolveLast(TARGET_PATH);
    await flush();
    const record = lastRecord(h);
    expect(record).toMatchObject({ status: "cancelled", stage: "note-creating", generation: 2 });
    // The generation fence, not a claim record, is what stops the late create
    // from being adopted as this job's note.
    expect(record.notePath).toBeUndefined();
    expect(h.stages.stamps.count).toBe(0);
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
    expect(lastRecord(h)).toMatchObject({ status: "cancelled", stage: "note-creating", generation: 2 });
  });

  it("C: a store rejection inside a post-call persist leaves the record interrupted, not running", async () => {
    const h = makeHarness();
    h.io.failWhen = (record) => record.stage === "summary" && !record.inFlight;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([{ type: "failed", id: "job-1", error: "disk full" }]);
    expect(lastRecord(h)).toMatchObject({ status: "interrupted", lastError: "disk full", stage: "summary" });
    expect(h.store.get("job-1")).toMatchObject({ status: "interrupted" });
    expect(h.runner.isActive("job-1")).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
  });
});

describe("JobRunner — a store that keeps failing", () => {
  it("5. run()'s catch whose own persist also rejects still emits failed once, leaves no timer and no unhandled rejection", async () => {
    const h = makeHarness();
    // Every write of a summary-stage record fails: the post-transcript
    // persist AND the catch's best-effort interrupted persist.
    h.io.failEvery = (record) => record.stage === "summary";
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.fetch.count).toBe(1);
    expect(h.stages.summ.count).toBe(0);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([{ type: "failed", id: "job-1", error: "disk full" }]);
    expect(h.store.get("job-1")).toMatchObject({ status: "interrupted", lastError: "disk full", stage: "summary" });
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
    expect(lastRecord(h)).toMatchObject({ stage: "done", addTimestampLinks: true });
    expect(h.stages.stamps.count).toBe(1);
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

});

describe("JobRunner — T6b: stopAll, fast summary", () => {
  it("stopAll disarms every timer, fences late completions in-process and rewrites nothing", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    expect(h.runner.isActive(id)).toBe(true);
    const writesBefore = h.io.calls.length;

    h.runner.stopAll();

    expect(h.runner.isActive(id)).toBe(false);
    // Every runner timer is gone — here, the pending summary's deadline.
    expect(h.clock.pendingCount()).toBe(0);
    // The record is NOT rewritten: the process is going away with it.
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
    // And nothing fires later: no timer survived stopAll to write anything.
    await h.clock.advance(3 * DEFAULT_DEADLINES.llmMs);
    expect(h.io.calls.length).toBe(writesBefore);
    expect(h.clock.pendingCount()).toBe(0);
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
    });
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id: "job-1", notePath: TARGET_PATH, timestampsSkipped: "user-choice" },
    ]);
    expect(h.events.filter((e) => e.type === "progress").map((e) => (e as { stage: string }).stage)).not.toContain("timestamps");
    expect(h.runner.isActive("job-1")).toBe(false);
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
    expect(record?.status).toBe("done");
  });

  it("a PathDriftError from renderNote fails the job without creating anything", async () => {
    // The CHECK survives #10; its outcome no longer does. It used to block —
    // an interrupted job resumable at summary — because the drift might be
    // cleared and the note still wanted. Nothing resumes now, so it is an
    // ordinary failure. What it still guarantees is that a note is never
    // written at a path the record does not own.
    const h = makeHarness();
    h.stages.render.failWith = new PathDriftError("Target path drift: rendered elsewhere");
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ status: "failed", stage: "summary", inFlight: false });
    expect(h.stages.create.count).toBe(0);
    expect(h.vault.files.size).toBe(0);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([
      { type: "failed", id: "job-1", error: "Target path drift: rendered elsewhere" },
    ]);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
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
      "translation/in", // pre-translate checkpoint: the stage is marked in flight before the call
      "done/out",
    ]);
    expect(records[8].deadlineAt).toBe(NOW + DEFAULT_DEADLINES.llmMs);
    expect(h.stages.stamps.count).toBe(1);
    expect(h.stages.translate.calls).toEqual([[expect.objectContaining({ translation: FR }), TARGET_PATH]]);
    expect(h.events.filter((e) => e.type === "progress").map((e) => (e.type === "progress" ? e.message : ""))).toContain("Translating note");
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
  });

  it("a translation timeout leaves the stage in flight on its own budget, and the late completion applies nothing", async () => {
    const h = makeHarness({ translation: FR });
    h.stages.translate.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.translate.count).toBe(1);
    await h.clock.advance(DEFAULT_DEADLINES.llmMs + 1);
    const record = lastRecord(h);
    expect(record).toMatchObject({ stage: "translation", status: "interrupted", inFlight: true });
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id: "job-1" }]);
    // The late completion applies nothing (generation fence).
    h.stages.translate.resolveLast(undefined);
    await flush();
    expect(lastRecord(h).status).toBe("interrupted");
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
  });
});
