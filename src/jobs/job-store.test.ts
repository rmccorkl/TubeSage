import { describe, expect, it } from "vitest";
import { createJobRecord } from "./job-record";
import type { NoteJobRecord } from "./job-record";
import { JOBS_KEY, JobStore, PRUNE_AFTER_MS, hydrate } from "./job-store";
import type { JobStoreIO } from "./job-store";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

function makeRecord(overrides: Partial<Parameters<typeof createJobRecord>[0]> = {}): NoteJobRecord {
  return createJobRecord({
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "",
    customTitle: "",
    useFastSummary: false,
    transcriptBilling: "free",
    now: NOW,
    ...overrides,
  });
}

// Minimal deferred helper for controlling when a fake saveData resolves.
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Records every payload io.saveData receives, tracks whether calls overlap
// (the serialization guarantee under test), and can be gated to block on a
// deferred or made to reject its next call, on demand.
class FakeIO implements JobStoreIO {
  calls: unknown[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private gate: Promise<void> | null = null;
  private rejectNextWith: Error | null = null;

  block(gate: Promise<void>): void {
    this.gate = gate;
  }

  failNext(err: Error): void {
    this.rejectNextWith = err;
  }

  async loadData(): Promise<unknown> {
    return undefined;
  }

  async saveData(data: unknown): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.calls.push(data);
    if (this.gate) {
      await this.gate;
    }
    this.inFlight--;
    if (this.rejectNextWith !== null) {
      const err = this.rejectNextWith;
      this.rejectNextWith = null;
      throw err;
    }
  }
}

const noSettings = (): Record<string, unknown> => ({});

describe("hydrate", () => {
  it("returns empty defaults for undefined/null/non-object input", () => {
    expect(hydrate(undefined)).toEqual({ settings: {}, jobs: [], dropped: 0 });
    expect(hydrate(null)).toEqual({ settings: {}, jobs: [], dropped: 0 });
    expect(hydrate("nope")).toEqual({ settings: {}, jobs: [], dropped: 0 });
    expect(hydrate(42)).toEqual({ settings: {}, jobs: [], dropped: 0 });
  });

  it("leaves a settings-only object unchanged with no _jobs key", () => {
    const raw = { theme: "dark", maxTokens: 4000 };
    const result = hydrate(raw);
    expect(result).toEqual({ settings: { theme: "dark", maxTokens: 4000 }, jobs: [], dropped: 0 });
    expect(Object.prototype.hasOwnProperty.call(result.settings, JOBS_KEY)).toBe(false);
  });

  it("returns valid _jobs records and strips _jobs from settings", () => {
    const record = makeRecord();
    const raw = { theme: "dark", [JOBS_KEY]: [record] };
    const result = hydrate(raw);
    expect(result.settings).toEqual({ theme: "dark" });
    expect(result.jobs).toEqual([record]);
    expect(result.dropped).toBe(0);
  });

  it("drops invalid entries (counted) and keeps valid siblings", () => {
    const valid = makeRecord({ id: "valid-1" });
    const missingVersion = { ...makeRecord({ id: "bad-1" }), version: undefined };
    const wrongStage = { ...makeRecord({ id: "bad-2" }), stage: "not-a-real-stage" };
    const withApiKey = { ...makeRecord({ id: "bad-3" }), apiKey: "sk-leaked" };
    const withSummary = { ...makeRecord({ id: "bad-4" }), summary: "leaked summary text" };
    const raw = { [JOBS_KEY]: [valid, missingVersion, wrongStage, withApiKey, withSummary] };
    const result = hydrate(raw);
    expect(result.jobs).toEqual([valid]);
    expect(result.dropped).toBe(4);
  });

  it("drops a record whose inFlight is a non-boolean and one missing useFastSummary", () => {
    const valid = makeRecord({ id: "valid-1" });
    const stringInFlight = { ...makeRecord({ id: "bad-1" }), inFlight: "true" };
    const missingUseFastSummary = { ...makeRecord({ id: "bad-2" }) } as Record<string, unknown>;
    delete missingUseFastSummary.useFastSummary;
    const raw = { [JOBS_KEY]: [valid, stringInFlight, missingUseFastSummary] };
    const result = hydrate(raw);
    expect(result.jobs).toEqual([valid]);
    expect(result.dropped).toBe(2);
  });

  it("addTimestampLinks: absent is accepted (older records), booleans pass through, a non-boolean is dropped and counted", () => {
    const absent = makeRecord({ id: "absent" });
    expect(absent.addTimestampLinks).toBeUndefined();
    const off = makeRecord({ id: "off", addTimestampLinks: false });
    const on = makeRecord({ id: "on", addTimestampLinks: true });
    const bad = { ...makeRecord({ id: "bad" }), addTimestampLinks: "false" };
    const result = hydrate({ [JOBS_KEY]: [absent, off, on, bad] });
    expect(result.jobs).toEqual([absent, off, on]);
    expect(result.jobs.map((job) => job.addTimestampLinks)).toEqual([undefined, false, true]);
    expect(result.dropped).toBe(1);
  });

  it("installationId: absent is accepted (pre-I3 records), a string passes through, a non-string is dropped and counted", () => {
    const absent = makeRecord({ id: "absent" });
    expect(absent.installationId).toBeUndefined();
    const owned = makeRecord({ id: "owned", installationId: "install-1" });
    const bad = { ...makeRecord({ id: "bad" }), installationId: 42 };
    const result = hydrate({ [JOBS_KEY]: [absent, owned, bad] });
    expect(result.jobs).toEqual([absent, owned]);
    expect(result.jobs.map((job) => job.installationId)).toEqual([undefined, "install-1"]);
    expect(result.dropped).toBe(1);
  });

  it("notePathSettings: absent is accepted (pre-C1 records), a well-formed object passes through, a malformed one is dropped and counted", () => {
    const absent = makeRecord({ id: "absent" });
    const frozen: NoteJobRecord = { ...makeRecord({ id: "frozen" }), notePathSettings: { prependDate: true, dateFormat: "DD-MM-YYYY" } };
    const badShape = { ...makeRecord({ id: "bad-shape" }), notePathSettings: { prependDate: "yes", dateFormat: "YYYY-MM-DD" } };
    const badType = { ...makeRecord({ id: "bad-type" }), notePathSettings: "YYYY-MM-DD" };
    const result = hydrate({ [JOBS_KEY]: [absent, frozen, badShape, badType] });
    expect(result.jobs).toEqual([absent, frozen]);
    expect(result.jobs[1].notePathSettings).toEqual({ prependDate: true, dateFormat: "DD-MM-YYYY" });
    expect(result.dropped).toBe(2);
  });

  it("attempts.translation: absent is coerced to 0 (records older than the translation stage), a number passes through, a non-number is dropped and counted", () => {
    const { translation: _omitted, ...olderAttempts } = makeRecord({ id: "older" }).attempts;
    void _omitted;
    const older = { ...makeRecord({ id: "older" }), attempts: olderAttempts };
    expect("translation" in older.attempts).toBe(false);
    const counted: NoteJobRecord = { ...makeRecord({ id: "counted" }), attempts: { transcript: 1, summary: 1, timestamps: 1, translation: 2 } };
    const bad = { ...makeRecord({ id: "bad" }), attempts: { ...olderAttempts, translation: "2" } };
    const result = hydrate({ [JOBS_KEY]: [older, counted, bad] });
    expect(result.jobs.map((job) => job.id)).toEqual(["older", "counted"]);
    // Coerced, not merely tolerated: the runner increments this counter and
    // the planner bounds it, so an undefined here would be NaN forever.
    expect(result.jobs[0].attempts).toEqual({ transcript: 0, summary: 0, timestamps: 0, translation: 0 });
    expect(result.jobs[1].attempts.translation).toBe(2);
    expect(result.dropped).toBe(1);
  });

  it("translation: absent is accepted (no translation frozen), a well-formed object passes through, a malformed one is dropped and counted", () => {
    const absent = makeRecord({ id: "absent" });
    const frozen: NoteJobRecord = { ...makeRecord({ id: "frozen" }), translation: { language: "fr", country: "FR" } };
    const badShape = { ...makeRecord({ id: "bad-shape" }), translation: { language: "fr" } };
    const badType = { ...makeRecord({ id: "bad-type" }), translation: "fr-FR" };
    const result = hydrate({ [JOBS_KEY]: [absent, frozen, badShape, badType] });
    expect(result.jobs).toEqual([absent, frozen]);
    expect(result.jobs[1].translation).toEqual({ language: "fr", country: "FR" });
    expect(result.dropped).toBe(2);
  });

  it("a record checkpointed at the translation stage is a valid v1 record (never dropped on restart)", () => {
    const atTranslation: NoteJobRecord = { ...makeRecord({ id: "t" }), stage: "translation", status: "interrupted", notePath: "Video.md" };
    const result = hydrate({ [JOBS_KEY]: [atTranslation] });
    expect(result.jobs.map((job) => job.stage)).toEqual(["translation"]);
    expect(result.dropped).toBe(0);
  });

  it("a non-terminal record carrying legacy interruption 'app-restart' is closed on hydrate: failed/app-closed, no call pending, not dropped (#3 batch G item b)", () => {
    const legacy: NoteJobRecord = {
      ...makeRecord({ id: "legacy" }),
      status: "interrupted",
      interruption: "app-restart",
      stage: "summary",
      inFlight: true,
      inFlightSince: NOW,
      deadlineAt: NOW + 1000,
      blocked: "templater-unavailable",
      lastError: "net down",
    };
    const result = hydrate({ [JOBS_KEY]: [legacy] });
    expect(result.dropped).toBe(0);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ status: "failed", interruption: "app-closed", inFlight: false, stage: "summary", lastError: "net down" });
    expect(result.jobs[0].inFlightSince).toBeUndefined();
    expect(result.jobs[0].deadlineAt).toBeUndefined();
    expect(result.jobs[0].blocked).toBeUndefined();
  });

  it("a TERMINAL record carrying legacy interruption 'app-restart' is left as-is (already resolved, nothing to close)", () => {
    const terminal: NoteJobRecord = { ...makeRecord({ id: "t" }), status: "cancelled", interruption: "app-restart" };
    const result = hydrate({ [JOBS_KEY]: [terminal] });
    expect(result.jobs[0]).toMatchObject({ status: "cancelled", interruption: "app-restart" });
  });

  it("keeps the duplicate id with the larger updatedAt, without counting it dropped", () => {
    const older = { ...makeRecord({ id: "dup" }), updatedAt: NOW };
    const newer = { ...makeRecord({ id: "dup" }), updatedAt: NOW + 1000 };
    const raw = { [JOBS_KEY]: [older, newer] };
    const result = hydrate(raw);
    expect(result.jobs).toEqual([newer]);
    expect(result.dropped).toBe(0);
  });

  it("treats a non-array _jobs as dropped:0, jobs:[], still stripped from settings", () => {
    const raw = { theme: "dark", [JOBS_KEY]: "not-an-array" };
    const result = hydrate(raw);
    expect(result).toEqual({ settings: { theme: "dark" }, jobs: [], dropped: 0 });
  });
});

describe("JobStore load/list/get/findByVideoId", () => {
  it("list() returns copies sorted by createdAt ascending; mutating the result does not change the store", () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const older = makeRecord({ id: "a", now: NOW });
    const newer = makeRecord({ id: "b", now: NOW + 5000 });
    store.load([newer, older]);

    const listed = store.list();
    expect(listed.map((r) => r.id)).toEqual(["a", "b"]);

    listed[0].customTitle = "mutated";
    expect(store.get("a")?.customTitle).toBe("");
  });

  it("get() returns a copy for a known id and undefined for an unknown id", () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const record = makeRecord({ id: "a" });
    store.load([record]);

    const got = store.get("a");
    expect(got).toEqual(record);
    got!.customTitle = "mutated";
    expect(store.get("a")?.customTitle).toBe("");

    expect(store.get("missing")).toBeUndefined();
  });

  it("findByVideoId ignores terminal statuses and picks the most recently updated", () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const done = { ...makeRecord({ id: "d", videoId: "v1" }), status: "done" as const, updatedAt: NOW + 9000 };
    const older = { ...makeRecord({ id: "o", videoId: "v1" }), status: "running" as const, updatedAt: NOW + 1000 };
    const newer = { ...makeRecord({ id: "n", videoId: "v1" }), status: "interrupted" as const, updatedAt: NOW + 2000 };
    store.load([done, older, newer]);

    const found = store.findByVideoId("v1");
    expect(found?.id).toBe("n");
    expect(store.findByVideoId("no-such-video")).toBeUndefined();
  });
});

describe("JobStore upsert", () => {
  it("rejects before any write for a record containing transcript", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const tainted = { ...makeRecord(), transcript: "leaked transcript text" } as unknown as NoteJobRecord;
    await expect(store.upsert(tainted, NOW)).rejects.toThrow();
    expect(io.calls.length).toBe(0);
  });

  it("stores a copy, sets updatedAt = now, and flushes exactly once with { ...settings, _jobs: [record] }", async () => {
    const io = new FakeIO();
    const settings = { theme: "dark" };
    const store = new JobStore(io, () => settings);
    const record = makeRecord({ id: "a" });
    const mutable = { ...record };

    await store.upsert(mutable, NOW + 1234);
    mutable.customTitle = "mutated-after-call";

    expect(io.calls.length).toBe(1);
    const expected = { ...record, updatedAt: NOW + 1234 };
    expect(io.calls[0]).toEqual({ theme: "dark", [JOBS_KEY]: [expected] });
    expect(store.get("a")?.customTitle).toBe("");
    expect(store.get("a")?.updatedAt).toBe(NOW + 1234);
  });

  it("serializes concurrent upserts: exactly two saveData calls, never overlapping, both later payloads coalesced", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const gate = deferred();
    io.block(gate.promise);

    const a = makeRecord({ id: "a" });
    const b = makeRecord({ id: "b" });
    const aPrime = { ...a, customTitle: "updated" };

    const pA = store.upsert(a, NOW);
    const pB = store.upsert(b, NOW + 1);
    const pAPrime = store.upsert(aPrime, NOW + 2);

    gate.resolve();
    await Promise.all([pA, pB, pAPrime]);

    expect(io.calls.length).toBe(2);
    expect(io.maxInFlight).toBe(1);

    const secondPayload = io.calls[1] as Record<string, unknown>;
    const secondJobs = secondPayload[JOBS_KEY] as NoteJobRecord[];
    const byId = new Map(secondJobs.map((r) => [r.id, r]));
    expect(byId.size).toBe(2);
    expect(byId.get("a")?.customTitle).toBe("updated");
    expect(byId.get("b")).toBeDefined();
  });

  it("composes settings at flush time, not at the time the follow-up write was enqueued", async () => {
    // Mutating settings only AFTER pB is enqueued (but before the blocked
    // first write resolves) is what discriminates this from a broken
    // "capture composeSettings() when flush() is called" implementation: a
    // broken store would already have snapshotted v1 at pB's enqueue time,
    // same as a correct one, since the mutation hadn't happened yet — so the
    // follow-up payload only reveals v2 if composition happens lazily, right
    // before the second io.saveData call actually fires.
    const io = new FakeIO();
    let settings: Record<string, unknown> = { version: 1 };
    const store = new JobStore(io, () => settings);
    const gate = deferred();
    io.block(gate.promise);

    const a = makeRecord({ id: "a" });
    const pA = store.upsert(a, NOW);
    // First write is already in flight with the old settings baked in.
    const pB = store.upsert(makeRecord({ id: "b" }), NOW + 1);
    // Enqueued while settings was still v1 — mutate only now, while the
    // follow-up write is pending behind the still-blocked first write.
    settings = { version: 2 };

    gate.resolve();
    await Promise.all([pA, pB]);

    expect(io.calls.length).toBe(2);
    expect((io.calls[0] as Record<string, unknown>).version).toBe(1);
    expect((io.calls[1] as Record<string, unknown>).version).toBe(2);
  });

  it("hydrate -> load -> settings-only flush still writes _jobs (migration persist must not erase jobs)", async () => {
    const record = makeRecord({ id: "a" });
    const raw = { theme: "dark", [JOBS_KEY]: [record] };
    const hydrated = hydrate(raw);

    const io = new FakeIO();
    const store = new JobStore(io, () => hydrated.settings);
    store.load(hydrated.jobs);

    await store.flush();

    expect(io.calls.length).toBe(1);
    const payload = io.calls[0] as Record<string, unknown>;
    expect(payload[JOBS_KEY]).toEqual([record]);
    expect(payload.theme).toBe("dark");
  });

  it("isolates a rejected write: the upsert promise rejects, store stays usable, next upsert succeeds with both records", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    io.failNext(new Error("disk full"));

    const a = makeRecord({ id: "a" });
    await expect(store.upsert(a, NOW)).rejects.toThrow("disk full");

    const b = makeRecord({ id: "b" });
    await store.upsert(b, NOW + 1);

    expect(io.calls.length).toBe(2);
    const lastPayload = io.calls[1] as Record<string, unknown>;
    const jobs = lastPayload[JOBS_KEY] as NoteJobRecord[];
    expect(jobs.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("isolates a throwing composeSettings: the upsert promise rejects, store stays usable, next upsert succeeds with both records", async () => {
    const io = new FakeIO();
    let throwNext = true;
    const composeSettings = (): Record<string, unknown> => {
      if (throwNext) {
        throwNext = false;
        throw new Error("settings composition failed");
      }
      return {};
    };
    const store = new JobStore(io, composeSettings);

    const a = makeRecord({ id: "a" });
    await expect(store.upsert(a, NOW)).rejects.toThrow("settings composition failed");
    // The throw happens before io.saveData is ever reached for this write.
    expect(io.calls.length).toBe(0);

    const b = makeRecord({ id: "b" });
    await store.upsert(b, NOW + 1);

    expect(io.calls.length).toBe(1);
    const payload = io.calls[0] as Record<string, unknown>;
    const jobs = payload[JOBS_KEY] as NoteJobRecord[];
    expect(jobs.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("JobStore prune", () => {
  it("removes only terminal records older than PRUNE_AFTER_MS; keeps running/interrupted regardless of age", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const veryOld = NOW - PRUNE_AFTER_MS - 1;
    const oldDone = { ...makeRecord({ id: "old-done" }), status: "done" as const, updatedAt: veryOld };
    const oldRunning = { ...makeRecord({ id: "old-running" }), status: "running" as const, updatedAt: veryOld };
    const recentFailed = { ...makeRecord({ id: "recent-failed" }), status: "failed" as const, updatedAt: NOW };
    store.load([oldDone, oldRunning, recentFailed]);

    await store.prune(NOW);

    expect(io.calls.length).toBe(1);
    const ids = store.list().map((r) => r.id);
    expect(ids.sort()).toEqual(["old-running", "recent-failed"]);
  });

  it("keeps a terminal record whose age is exactly PRUNE_AFTER_MS; removes one that is 1ms older", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const exactlyAtBoundary = {
      ...makeRecord({ id: "at-boundary" }),
      status: "done" as const,
      updatedAt: NOW - PRUNE_AFTER_MS,
    };
    const oneMsPastBoundary = {
      ...makeRecord({ id: "past-boundary" }),
      status: "done" as const,
      updatedAt: NOW - PRUNE_AFTER_MS - 1,
    };
    store.load([exactlyAtBoundary, oneMsPastBoundary]);

    await store.prune(NOW);

    expect(io.calls.length).toBe(1);
    const ids = store.list().map((r) => r.id);
    expect(ids).toEqual(["at-boundary"]);
  });

  it("does not call saveData when nothing changes", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    const running = { ...makeRecord({ id: "running" }), status: "running" as const, updatedAt: NOW };
    store.load([running]);

    await store.prune(NOW);

    expect(io.calls.length).toBe(0);
  });
});

describe("JobStore remove", () => {
  it("removes an existing record and flushes", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    store.load([makeRecord({ id: "a" })]);

    await store.remove("a");

    expect(io.calls.length).toBe(1);
    expect(store.get("a")).toBeUndefined();
  });

  it("does not write when removing an unknown id", async () => {
    const io = new FakeIO();
    const store = new JobStore(io, noSettings);
    store.load([makeRecord({ id: "a" })]);

    await store.remove("does-not-exist");

    expect(io.calls.length).toBe(0);
  });
});
