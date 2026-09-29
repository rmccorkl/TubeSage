import { describe, expect, it } from "vitest";
import { assertRecordIsMetadataOnly } from "./job-record";
import type { NoteJobRecord } from "./job-record";
import { JobStore } from "./job-store";
import { DEFAULT_DEADLINES, JobRunner, NoteChangedError, PathDriftError, PermanentJobError } from "./job-runner";
import type { JobEvent, JobStages, RunnerDeps, SubmitInput } from "./job-runner";
import { JobProgressNotices } from "../runtime/job-progress-notice";
import type { ProgressNoticeHandle } from "../runtime/job-progress-notice";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
// #13: the 600 s stage budget that used to kill a live LLM call. It is gone
// from the runner, so the tests name it themselves — what they assert is that
// this much wall clock passing changes nothing for a paid stage. It also
// serves as "much longer than any deadline the runner still has".
const OLD_LLM_BUDGET_MS = 600_000;
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
  /** A real consumer wired to the live event stream (the surface-lifetime invariant, #14). */
  onEvent?: (event: JobEvent) => void;
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
      options.onEvent?.(event);
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

/**
 * Stops the pending summarize call the only way a paid stage can be stopped
 * now (#13): the call itself fails. It used to be a deadline the runner armed
 * against it — that budget is gone, so the vehicle is a transient rejection,
 * which leaves the same record shape (`interrupted`, still in flight) through
 * the same `settleFailure` path.
 */
async function interruptSummary(h: Harness): Promise<void> {
  const pending = h.stages.summ.pending[h.stages.summ.pending.length - 1];
  expect(pending).toBeDefined();
  pending.reject(new Error("socket hang up"));
  await flush();
  const record = lastRecord(h);
  expect(record.status).toBe("interrupted");
  expect(record.inFlight).toBe(true);
}

/** Submits and runs until `fetchTranscript` is pending (manual). */
async function submitUntilTranscriptPending(h: Harness): Promise<string> {
  h.stages.fetch.manual = true;
  const result = await h.runner.submit(SUBMIT);
  expect(result.kind).toBe("started");
  await flush();
  expect(h.stages.fetch.pending.length).toBe(1);
  return (result as { id: string }).id;
}

/** Times out the pending transcript fetch: a bounded HTTP call, which KEEPS its deadline (#13). */
async function timeOutTranscript(h: Harness): Promise<void> {
  await h.clock.advance(DEFAULT_DEADLINES.transcriptMs);
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

    // Every in-flight checkpoint was stamped; only the ones the runner still
    // arms a timer against carry a deadline (#13). `deadlineAt` means "a timer
    // is armed against this call", so the paid stages leave it unset.
    const inFlight = persistedRecords(h).filter((r) => r.inFlight);
    for (const record of inFlight) {
      expect(record.inFlightSince).toBe(NOW);
    }
    const dated = new Map(inFlight.map((r) => [r.stage, r.deadlineAt]));
    expect(dated.get("transcript")).toBe(NOW + DEFAULT_DEADLINES.transcriptMs);
    expect(dated.get("note-creating")).toBe(NOW + DEFAULT_DEADLINES.vaultMs);
    expect(dated.get("summary")).toBeUndefined();
    expect(dated.get("timestamps")).toBeUndefined();

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
    // At the TRANSCRIPT stage: the paid stages no longer carry a deadline at
    // all (#13), so the only timeout the runner can still produce is this one
    // — a bounded HTTP fetch — and the fence it needs is the same one.
    const h = makeHarness();
    await submitUntilTranscriptPending(h);
    await timeOutTranscript(h);
    const writesAtTimeout = h.io.calls.length;
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id: "job-1" }]);
    expect(h.runner.isActive("job-1")).toBe(false);

    h.stages.fetch.resolveLast({ transcript: TRANSCRIPT_BODY, title: VIDEO_TITLE });
    await flush();
    await h.clock.advance(OLD_LLM_BUDGET_MS);

    expect(h.stages.summ.count).toBe(0);
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
    await h.clock.advance(OLD_LLM_BUDGET_MS);

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
    await interruptSummary(h);
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
    // Driven at the transcript stage, which is where a deadline still exists
    // to be left behind (#13): the paid stages arm none.
    const h = makeHarness();
    const id = await submitUntilTranscriptPending(h);
    // A live transcript fetch has its stage deadline armed.
    expect(h.clock.pendingCount()).toBe(1);
    await h.runner.cancel(id);
    await flush();
    const writes = h.io.calls.length;
    // cancel (stopRun) disarmed the dangling call's deadline (T6 review #2).
    expect(h.clock.pendingCount()).toBe(0);
    // Advance well past what that deadline would have been.
    await h.clock.advance(OLD_LLM_BUDGET_MS);
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

  it("cancel during a pending summary ends it at once, with no timer involved either way (#13)", async () => {
    const h = makeHarness();
    const id = await submitUntilSummaryPending(h);
    // Nothing was armed against the paid call to begin with (#13), and the
    // cancel is instant regardless: the fence, not a timer, is what ends it.
    expect(h.clock.pendingCount()).toBe(0);
    await h.runner.cancel(id);
    await flush();
    expect(h.store.get(id)?.status).toBe("cancelled");
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
    await h.clock.advance(OLD_LLM_BUDGET_MS);
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
    // The paid translation checkpoint is stamped in flight but armed against
    // nothing (#13).
    expect(records[8].inFlight).toBe(true);
    expect(records[8].deadlineAt).toBeUndefined();
    expect(h.stages.stamps.count).toBe(1);
    expect(h.stages.translate.calls).toEqual([[expect.objectContaining({ translation: FR }), TARGET_PATH]]);
    expect(h.events.filter((e) => e.type === "progress").map((e) => (e.type === "progress" ? e.message : ""))).toContain("Translating note");
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
  });

  it("a translation that FAILS still interrupts at its own checkpoint, and the late completion applies nothing", async () => {
    // Was "a translation timeout leaves the stage in flight on its own
    // budget". There is no translation budget any more (#13 — see 13c), so
    // the vehicle is the other half of settleFailure: the call rejects. What
    // the test still holds is the checkpoint and the fence.
    const h = makeHarness({ translation: FR });
    h.stages.translate.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.translate.count).toBe(1);
    h.stages.translate.pending[0].reject(new Error("socket hang up"));
    await flush();
    const record = lastRecord(h);
    expect(record).toMatchObject({ stage: "translation", status: "interrupted", inFlight: true, lastError: "socket hang up" });
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id: "job-1" }]);
    // A second, late arrival applies nothing (generation fence).
    await h.clock.advance(OLD_LLM_BUDGET_MS);
    expect(lastRecord(h).status).toBe("interrupted");
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
  });
});

describe("JobRunner — #13: no wall-clock deadline on the paid LLM stages", () => {
  it("13a. a timestamps call that outlives the old 600 s budget still completes, and the job reports done", async () => {
    const h = makeHarness();
    h.stages.stamps.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    // Nothing is armed against the pass, so nothing can fire against it.
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.store.get("job-1")?.deadlineAt).toBeUndefined();

    // An hour on the clock: ten times the budget that used to end this job.
    await h.clock.advance(6 * OLD_LLM_BUDGET_MS);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
    expect(h.store.get("job-1")?.status).toBe("running");

    // The call returns when it returns, and the job finishes normally.
    h.stages.stamps.resolveLast(undefined);
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ stage: "done", status: "done", notePath: TARGET_PATH });
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
  });

  it("13b. a summary call that outlives the old 600 s budget still completes, and the note is still created", async () => {
    const h = makeHarness();
    await submitUntilSummaryPending(h);
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.store.get("job-1")?.deadlineAt).toBeUndefined();

    await h.clock.advance(6 * OLD_LLM_BUDGET_MS);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
    expect(h.store.get("job-1")?.status).toBe("running");

    h.stages.summ.resolveLast(SUMMARY_BODY);
    await flush();
    expect(h.vault.files.get(TARGET_PATH)).toBe(renderedContent());
    expect(h.store.get("job-1")).toMatchObject({ stage: "done", status: "done" });
  });

  it("13c. a translation call that outlives the old 600 s budget still completes, and the job reports done", async () => {
    const h = makeHarness({ translation: { language: "fr", country: "FR" } });
    h.stages.translate.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.translate.count).toBe(1);
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.store.get("job-1")?.deadlineAt).toBeUndefined();

    await h.clock.advance(6 * OLD_LLM_BUDGET_MS);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
    expect(h.store.get("job-1")).toMatchObject({ stage: "translation", status: "running" });

    h.stages.translate.resolveLast(undefined);
    await flush();
    expect(h.store.get("job-1")).toMatchObject({ stage: "done", status: "done" });
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id: "job-1", notePath: TARGET_PATH }]);
  });

  it("13d. cancel still ends a job INSTANTLY mid-timestamps-call, with no deadline left to do it", async () => {
    // The guard rail on #13: removing the budget must not weaken cancel. The
    // fence, not the clock, is what stops a cancelled job — so a cancel lands
    // at once even though the paid call is still out there and nothing is
    // armed against it.
    const h = makeHarness();
    h.stages.stamps.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.stamps.count).toBe(1);
    expect(h.clock.pendingCount()).toBe(0);

    await h.runner.cancel("job-1");

    // Instant: the cancelled record and its event are there before anything
    // else is awaited, and long before the LLM call returns.
    expect(h.store.get("job-1")).toMatchObject({ status: "cancelled", generation: 2 });
    expect(h.events.filter((e) => e.type === "cancelled")).toEqual([{ type: "cancelled", id: "job-1" }]);
    expect(h.runner.isActive("job-1")).toBe(false);

    // Counted after the cancel's own upsert: what must not move from here is
    // anything the abandoned pass does.
    const writesAtCancel = h.io.calls.length;

    // The abandoned pass returning later applies nothing: no done, no write.
    h.stages.stamps.resolveLast(undefined);
    await flush();
    await h.clock.advance(6 * OLD_LLM_BUDGET_MS);
    expect(h.io.calls.length).toBe(writesAtCancel);
    expect(h.stages.translate.count).toBe(0);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    expect(h.store.get("job-1")?.status).toBe("cancelled");
  });
});

describe("JobRunner — #14: a run that ends says so, on every exit path", () => {
  /** Every event that tells a consumer the job is over. */
  const isTerminalEvent = (e: JobEvent): boolean =>
    e.type === "done" || e.type === "failed" || e.type === "cancelled" || e.type === "interrupted";

  it("14a. a run that exits through a silent guard() failure still reports that its run ended", async () => {
    const h = makeHarness();
    h.stages.stamps.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    expect(h.stages.stamps.count).toBe(1);

    // Supersede the record under the live run: its generation moves on, which
    // is precisely what guard() re-reads after every await. No cancel, so no
    // cancelled event — this is the exit path that emits nothing at all.
    const superseded = h.store.get("job-1");
    if (superseded === undefined) {
      throw new Error("the job's record went missing");
    }
    superseded.generation += 1;
    await h.store.upsert(superseded, h.clock.now);

    h.stages.stamps.resolveLast(undefined);
    await flush();

    // No outcome is invented: the record was superseded, so this run is not
    // done, failed, cancelled or interrupted, and must not claim to be.
    expect(h.events.filter(isTerminalEvent)).toEqual([]);
    // But the run IS over, and it says so exactly once.
    expect(h.events.filter((e) => e.type === "run-ended")).toEqual([{ type: "run-ended", id: "job-1" }]);
    expect(h.runner.isActive("job-1")).toBe(false);
  });
});

// The invariant that must outlive #14's specific bug: NO run, ending by ANY
// path, may leave a progress surface behind. It is asserted against the real
// JobProgressNotices rather than a hand-rolled stand-in, because the thing
// being proven is the wiring between the two — the runner's events and the
// surface's lifetime — and a stand-in would only prove the test's own idea of
// it. (main.ts does this wiring in `onJobEvent`.)
describe("JobRunner + JobProgressNotices — no exit path leaves a live surface (#14)", () => {
  class SurfaceDouble implements ProgressNoticeHandle {
    hidden = 0;
    constructor(public message: string) {}
    setMessage(message: string): void {
      this.message = message;
    }
    hide(): void {
      this.hidden += 1;
    }
  }

  /**
   * `owns` mirrors main.ts's `collectionRunner.owns(event.id)` — the host
   * tells the notices whether a job is a collection child, and the notices
   * decide what that means. Default false: an ordinary standalone job.
   */
  function wired(
    options: HarnessOptions = {},
    owns: () => boolean = () => false,
  ): { h: Harness; notices: JobProgressNotices; surfaces: SurfaceDouble[] } {
    const surfaces: SurfaceDouble[] = [];
    const notices = new JobProgressNotices((message) => {
      const surface = new SurfaceDouble(message);
      surfaces.push(surface);
      return surface;
    });
    const h = makeHarness({ ...options, onEvent: (event) => { notices.handle(event, owns()); } });
    return { h, notices, surfaces };
  }

  /** Every way a run can end, each one driven to its real exit. */
  const exits: { name: string; drive: (w: ReturnType<typeof wired>) => Promise<void> }[] = [
    {
      name: "done",
      drive: async ({ h }) => {
        await h.runner.submit(SUBMIT);
        await flush();
      },
    },
    {
      name: "done with the timestamps pass skipped by the record's own flags",
      drive: async ({ h }) => {
        await h.runner.submit({ ...SUBMIT, useFastSummary: true });
        await flush();
      },
    },
    {
      name: "done with the note edited under the timestamps pass",
      drive: async ({ h }) => {
        h.stages.stamps.failWith = new NoteChangedError("note changed");
        await h.runner.submit(SUBMIT);
        await flush();
      },
    },
    {
      name: "failed (a permanent verdict)",
      drive: async ({ h }) => {
        h.stages.fetch.failWith = new PermanentJobError("no captions");
        await h.runner.submit(SUBMIT);
        await flush();
      },
    },
    {
      name: "failed (the template engine went away)",
      drive: async ({ h }) => {
        h.stages.templaterAvailable = false;
        await h.runner.submit(SUBMIT);
        await flush();
      },
    },
    {
      name: "interrupted (a transient error)",
      drive: async ({ h }) => {
        h.stages.summ.failWith = new Error("socket hang up");
        await h.runner.submit(SUBMIT);
        await flush();
      },
    },
    {
      name: "interrupted (the transcript deadline, the one that is left)",
      drive: async ({ h }) => {
        await submitUntilTranscriptPending(h);
        await timeOutTranscript(h);
      },
    },
    {
      name: "cancelled mid-LLM-call",
      drive: async ({ h }) => {
        h.stages.stamps.manual = true;
        await h.runner.submit(SUBMIT);
        await flush();
        await h.runner.cancel("job-1");
        h.stages.stamps.resolveLast(undefined);
        await flush();
      },
    },
    {
      name: "a silent guard() failure: the record is superseded under the run",
      drive: async ({ h }) => {
        h.stages.stamps.manual = true;
        await h.runner.submit(SUBMIT);
        await flush();
        const record = h.store.get("job-1");
        if (record === undefined) {
          throw new Error("the job's record went missing");
        }
        record.generation += 1;
        await h.store.upsert(record, h.clock.now);
        h.stages.stamps.resolveLast(undefined);
        await flush();
      },
    },
    {
      name: "a store rejection escaping the stage functions",
      drive: async ({ h }) => {
        h.store.failEvery = (record) => record.stage === "timestamps";
        await h.runner.submit(SUBMIT);
        await flush();
      },
    },
  ];

  for (const exit of exits) {
    it(`leaves no surface behind when a run ends by: ${exit.name}`, async () => {
      const w = wired();
      await exit.drive(w);

      expect(w.h.runner.isActive("job-1")).toBe(false);
      expect(w.notices.activeCount()).toBe(0);
      // Whatever was opened was closed exactly once.
      for (const surface of w.surfaces) {
        expect(surface.hidden).toBe(1);
      }
    });
  }

  it("leaves no surface behind when a collection ADOPTS the running job mid-flight (#14 F2)", async () => {
    // Wired as the host wires it. A standalone job is showing its own notice
    // when the user starts a playlist containing that video; submitChild
    // adopts the live job, and from that moment the host reports every one of
    // its events as a collection child's. The outcome is suppressed — the
    // collection's notice narrates it — so the run ending is the only thing
    // left that can close the surface this job already opened.
    let adopted = false;
    const w = wired({}, () => adopted);
    w.h.stages.stamps.manual = true;
    await w.h.runner.submit(SUBMIT);
    await flush();
    expect(w.notices.activeCount()).toBe(1);

    adopted = true;
    w.h.stages.stamps.resolveLast(undefined);
    await flush();

    expect(w.h.events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(w.notices.activeCount()).toBe(0);
    expect(w.surfaces.every((surface) => surface.hidden === 1)).toBe(true);
  });

  it("opens no surface at all for a job that was a collection child throughout", async () => {
    const w = wired({}, () => true);
    await w.h.runner.submit(SUBMIT);
    await flush();
    expect(w.surfaces).toHaveLength(0);
    expect(w.notices.activeCount()).toBe(0);
  });

  it("leaves no surface behind when the plugin unloads mid-run", async () => {
    // Unload is the one exit that emits nothing by design — a fenced run must
    // not reach a torn-down plugin — so the sweep is the host's, exactly as
    // main.ts's onunload does it (stopAll, then dismissAll).
    const w = wired();
    w.h.stages.stamps.manual = true;
    await w.h.runner.submit(SUBMIT);
    await flush();
    expect(w.notices.activeCount()).toBe(1);

    // Everything said before the unload is legitimate — by this point the
    // note has been created and announced (#20). The claim below is about
    // what the FENCED run says afterwards, so the line is drawn here.
    const beforeUnload = w.h.events.length;

    w.h.runner.stopAll();
    w.notices.dismissAll();
    w.h.stages.stamps.resolveLast(undefined);
    await flush();

    expect(w.notices.activeCount()).toBe(0);
    expect(w.surfaces.every((surface) => surface.hidden === 1)).toBe(true);
    // And the fenced late completion emitted nothing at all, so nothing could
    // have re-opened one.
    expect(w.h.events.slice(beforeUnload)).toEqual([]);
  });
});

describe("JobRunner — #20: the host is told a note exists as soon as it does", () => {
  it("20a. announces the note when the create returns, with its path, before the timestamps pass", async () => {
    // The gap #20 closes: the record moves to `note-created` here, but
    // nothing said so, and only `note-creating` was ever emitted — carrying
    // no path. The host could not know the note existed until `done`, which
    // is after the timestamps pass and the translation.
    const h = makeHarness();
    h.stages.stamps.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();

    // The job is sitting in the timestamps pass, nowhere near done.
    expect(h.stages.stamps.count).toBe(1);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);

    expect(h.events.filter((e) => e.type === "note-created")).toEqual([
      { type: "note-created", id: "job-1", notePath: TARGET_PATH },
    ]);

    // And it arrives BEFORE the pass that rewrites the note, which is the
    // whole point: the user watches the timestamps land in an open note.
    const order = h.events.map((e) => (e.type === "progress" ? `progress:${e.stage}` : e.type));
    expect(order.indexOf("note-created")).toBeGreaterThan(-1);
    expect(order.indexOf("note-created")).toBeLessThan(order.indexOf("progress:timestamps"));
  });

  it("20b. carries the path the create RESOLVED with, never the one it asked for", async () => {
    // The adapter steps past an occupied path to a free neighbour, and the
    // host opens what this event carries: the wrong path here would open
    // someone else's note.
    const h = makeHarness();
    h.stages.create.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    const landed = "Video-Title 1.md";
    h.stages.create.resolveLast(landed);
    await flush();

    expect(h.events.filter((e) => e.type === "note-created")).toEqual([
      { type: "note-created", id: "job-1", notePath: landed },
    ]);
  });

  it("20c. says nothing when the job was cancelled while the create was in flight", async () => {
    // A late create is fenced like every other side effect: the note may
    // exist, but this run no longer owns the job, so it does not announce it.
    const h = makeHarness();
    h.stages.create.manual = true;
    await h.runner.submit(SUBMIT);
    await flush();
    await h.runner.cancel("job-1");
    h.stages.create.resolveLast(TARGET_PATH);
    await flush();

    expect(h.events.filter((e) => e.type === "note-created")).toEqual([]);
  });
});
