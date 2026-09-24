import { describe, expect, it, vi } from "vitest";
import { CollectionRunner } from "./collection-runner";
import type { CollectionJobRecord, CollectionVideo } from "../jobs/collection-record";
import type { NoteJobRecord } from "../jobs/job-record";

const video = (n: number): CollectionVideo => ({
  url: `https://youtu.be/${n}`, videoId: `v${n}`, title: `Video ${n}`,
});

function harness(opts: { videos?: number; submit?: (v: CollectionVideo) => string | undefined } = {}) {
  const videos = Array.from({ length: opts.videos ?? 3 }, (_, i) => video(i + 1));
  const records = new Map<string, NoteJobRecord>();
  const stored = new Map<string, CollectionJobRecord>();
  const active = new Set<string>();
  const submitted: string[] = [];
  const cancelled: string[] = [];
  let seq = 0;

  const deps = {
    generateId: () => `p-${++seq}`,
    now: () => 1000,
    installationId: () => "inst-1",
    // Stands in for JobRunner.submit(): returns the id now responsible for the video.
    submitChild: vi.fn(async (v: CollectionVideo, _folder: string) => {
      const id = opts.submit ? opts.submit(v) : `job-${v.videoId}`;
      if (id === undefined) return undefined;
      records.set(id, { id, status: "running" } as NoteJobRecord);
      active.add(id);
      submitted.push(id);
      return id;
    }),
    cancelChild: vi.fn(async (id: string) => {
      cancelled.push(id);
      active.delete(id);
      const r = records.get(id);
      if (r) records.set(id, { ...r, status: "cancelled" });
    }),
    isActive: (id: string) => active.has(id),
    getChild: (id: string) => records.get(id),
    saveCollection: vi.fn(async (record: CollectionJobRecord) => { stored.set(record.id, record); }),
    listCollections: () => Array.from(stored.values()),
    notices: { start: vi.fn(), update: vi.fn(), finish: vi.fn() },
  };
  const runner = new CollectionRunner(deps);
  const settle = (id: string, status: NoteJobRecord["status"] = "done") => {
    active.delete(id);
    const r = records.get(id);
    if (r) records.set(id, { ...r, status });
  };
  const begin = () =>
    runner.begin({ url: "u", folder: "f", sourceName: "s", contentType: "Playlist", videos });
  return { runner, deps, begin, submitted, cancelled, settle };
}

describe("CollectionRunner — one item at a time, so a run cannot fan out paid calls", () => {
  it("submits only the first video on begin", async () => {
    const { begin, submitted } = harness();
    await begin();
    expect(submitted).toEqual(["job-v1"]);
  });

  it("advances only after the current child settles", async () => {
    const { runner, begin, submitted, settle } = harness();
    const parent = await begin();
    settle("job-v1");
    await runner.onChildSettled(parent.id);
    expect(submitted).toEqual(["job-v1", "job-v2"]);
  });

  it("adopts the id submit() hands back, so a child is an ordinary job", async () => {
    const { begin } = harness({ videos: 1 });
    const parent = await begin();
    expect(parent.childIds).toEqual(["job-v1"]);
  });

  it("finishes the run once the last child lands", async () => {
    const { runner, deps, begin, settle } = harness({ videos: 1 });
    const parent = await begin();
    settle("job-v1");
    await runner.onChildSettled(parent.id);
    expect(deps.notices.finish).toHaveBeenCalledTimes(1);
  });

  it("shrinks the total when a video cannot be adopted, rather than hanging on it", async () => {
    // submit() declining a video (nothing to attach to) must not leave the run
    // one child short of terminal for ever.
    const { runner, deps, begin, settle } = harness({
      videos: 2,
      submit: (v) => (v.videoId === "v1" ? undefined : `job-${v.videoId}`),
    });
    const parent = await begin();
    const saved = deps.saveCollection.mock.calls;
    const latest = saved[saved.length - 1][0];
    expect(latest.plannedCount).toBe(1);
    expect(latest.childIds).toEqual(["job-v2"]);
    settle("job-v2");
    await runner.onChildSettled(parent.id);
    expect(deps.notices.finish).toHaveBeenCalledTimes(1);
  });
});

describe("CollectionRunner cancel — stop scheduling, never strand a paid call", () => {
  it("leaves the executing child alone and submits nothing further", async () => {
    const { runner, begin, submitted, cancelled, settle } = harness({ videos: 3 });
    const parent = await begin();
    await runner.cancel(parent.id);
    // Only v1 was ever submitted, and it is running: nothing to cancel.
    expect(cancelled).toEqual([]);
    settle("job-v1");
    await runner.onChildSettled(parent.id);
    expect(submitted).toEqual(["job-v1"]);
  });

  it("cancels a submitted child that is no longer executing", async () => {
    const { runner, begin, cancelled, settle } = harness({ videos: 2 });
    const parent = await begin();
    settle("job-v1", "interrupted");
    await runner.cancel(parent.id);
    expect(cancelled).toEqual(["job-v1"]);
  });

  it("marks the collection cancelled and persists that", async () => {
    const { runner, deps, begin } = harness({ videos: 2 });
    const parent = await begin();
    await runner.cancel(parent.id);
    const calls = deps.saveCollection.mock.calls;
    expect(calls[calls.length - 1][0].status).toBe("cancelled");
  });
});

describe("CollectionRunner.closeAbandoned — a run dies with its app instance", () => {
  it("closes a run this installation left running, and reports it", async () => {
    const { runner, begin, deps } = harness({ videos: 3 });
    await begin();
    // Simulate a restart: the parent is still `running` in the store.
    expect(await runner.closeAbandoned()).toBe(1);
    const saved = deps.saveCollection.mock.calls;
    expect(saved[saved.length - 1][0].status).toBe("closed");
  });

  it("does not restart any child", async () => {
    const { runner, begin, deps } = harness({ videos: 3 });
    await begin();
    deps.submitChild.mockClear();
    await runner.closeAbandoned();
    expect(deps.submitChild).not.toHaveBeenCalled();
  });

  it("leaves another installation's run alone — it may be live on that device", async () => {
    const { runner, begin, deps } = harness({ videos: 2 });
    const parent = await begin();
    deps.installationId = () => "a-different-install";
    void parent;
    expect(await runner.closeAbandoned()).toBe(0);
  });
});

describe("CollectionRunner — a cancel landing mid-submit", () => {
  it("does not adopt a child submitted into an already-cancelled run", async () => {
    // The latent race: `startNext` awaits submitChild, and a cancel can land
    // during that await. Without the post-await status re-check the new child
    // is appended to a cancelled parent that cancel() never saw, and then runs
    // unattended — billed, with nothing watching it.
    const records = new Map<string, NoteJobRecord>();
    const stored = new Map<string, CollectionJobRecord>();
    const cancelled: string[] = [];
    let release: (() => void) | undefined;
    let runner: CollectionRunner;
    let parentId = "";

    const deps = {
      generateId: () => "p-1",
      now: () => 1000,
      installationId: () => "inst-1",
      submitChild: vi.fn(async (v: CollectionVideo, _folder: string) => {
        // Cancel arrives while this submit is still in flight.
        await new Promise<void>((resolve) => { release = resolve; });
        const id = `job-${v.videoId}`;
        records.set(id, { id, status: "running" } as NoteJobRecord);
        return id;
      }),
      cancelChild: vi.fn(async (id: string) => { cancelled.push(id); }),
      isActive: () => false,
      getChild: (id: string) => records.get(id),
      saveCollection: vi.fn(async (record: CollectionJobRecord) => { stored.set(record.id, record); }),
      listCollections: () => Array.from(stored.values()),
      notices: { start: vi.fn(), update: vi.fn(), finish: vi.fn() },
    };
    runner = new CollectionRunner(deps);

    const begun = runner.begin({
      url: "u", folder: "f", sourceName: "s", contentType: "Playlist",
      videos: [{ url: "1", videoId: "v1", title: "" }, { url: "2", videoId: "v2", title: "" }],
    });
    // Let begin() reach the awaiting submitChild, then cancel the run. Flushing
    // microtasks rather than using a timer: everything in between is promise
    // work, and a bare `setTimeout` trips the plugin's popout-window lint rule.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    parentId = Array.from(stored.keys())[0];
    await runner.cancel(parentId);
    release?.();
    await begun;

    const parent = stored.get(parentId);
    expect(parent?.status).toBe("cancelled");
    // The child born during the await is cancelled, not adopted and abandoned.
    expect(parent?.childIds).not.toContain("job-v1");
    expect(cancelled).toContain("job-v1");
  });
});

describe("CollectionRunner ownership — which jobs are part of a live run", () => {
  it("owns a child only once submit() has handed back its id", async () => {
    // The defect this pins: ownership used to be captured by the NOTICE at
    // start(), from a `childIds` that is still empty at that moment — so no
    // child was ever owned and every one of them would have shown its own
    // notice alongside the run's.
    const { runner, begin } = harness({ videos: 2 });
    await begin();
    expect(runner.owns("job-v1")).toBe(true);
    expect(runner.owns("job-v2")).toBe(false); // not submitted yet
    expect(runner.owns("an-unrelated-single-job")).toBe(false);
  });

  it("releases the ids when the run ends, so later jobs notice normally", async () => {
    const { runner, begin, settle } = harness({ videos: 1 });
    const parent = await begin();
    expect(runner.owns("job-v1")).toBe(true);
    settle("job-v1");
    await runner.onChildSettled(parent.id);
    expect(runner.owns("job-v1")).toBe(false);
  });
});
