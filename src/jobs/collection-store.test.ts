import { describe, expect, it } from "vitest";
import { COLLECTIONS_KEY, planCollection } from "./collection-record";
import { JOBS_KEY, JobStore, hydrate } from "./job-store";

const sample = () => ({
  parent: {
    ...planCollection({
      url: "https://youtube.com/playlist?list=PL1",
      folder: "Inbox", sourceName: "Stuff", contentType: "Playlist",
      installationId: "inst-1", createdAt: 5, id: "p1", plannedCount: 1,
    }),
    childIds: ["c1"],
  },
});

describe("hydrate — collections are a sibling of jobs, never settings", () => {
  it("does not leave _collections in the settings object", () => {
    // The mirror of the flush-side trap: `hydrate` spreads everything that is
    // not `_jobs` into settings, so an unhandled reserved key would be read
    // back as user configuration.
    const out = hydrate({ theme: "dark", [JOBS_KEY]: [], [COLLECTIONS_KEY]: [sample().parent] });
    expect(out.settings).not.toHaveProperty(COLLECTIONS_KEY);
    expect(out.settings).toEqual({ theme: "dark" });
  });

  it("returns valid collection records", () => {
    const out = hydrate({ [COLLECTIONS_KEY]: [sample().parent] });
    expect(out.collections).toHaveLength(1);
    expect(out.collections[0]).toMatchObject({ id: "p1", kind: "collection", childIds: ["c1"] });
  });

  it("drops malformed entries instead of throwing", () => {
    const out = hydrate({ [COLLECTIONS_KEY]: [{ nope: true }, null, sample().parent] });
    expect(out.collections).toHaveLength(1);
  });

  it("survives a file with no collections key at all", () => {
    expect(hydrate({ [JOBS_KEY]: [] }).collections).toEqual([]);
  });
});

describe("JobStore — collections flush in the same payload as jobs", () => {
  const makeStore = () => {
    const saved: Record<string, unknown>[] = [];
    const store = new JobStore(
      { loadData: async () => ({}), saveData: async (d) => { saved.push(d as Record<string, unknown>); } },
      () => ({ theme: "dark" }),
    );
    return { store, saved };
  };

  it("writes jobs and collections into one data.json write", async () => {
    // Two writers would race on the same file, which is why the existing store
    // owns both rather than a second store being introduced.
    const { store, saved } = makeStore();
    const { parent } = sample();
    await store.upsertCollection(parent, 10);
    expect(saved).toHaveLength(1);
    expect(saved[0][COLLECTIONS_KEY]).toHaveLength(1);
    expect(saved[0][JOBS_KEY]).toEqual([]);
    expect(saved[0].theme).toBe("dark");
  });

  it("reads back what it wrote", async () => {
    const { store } = makeStore();
    const { parent } = sample();
    await store.upsertCollection(parent, 10);
    expect(store.getCollection("p1")).toMatchObject({ id: "p1" });
    expect(store.listCollections()).toHaveLength(1);
  });

  it("replaces a collection in place rather than appending a second copy", async () => {
    const { store } = makeStore();
    const { parent } = sample();
    await store.upsertCollection(parent, 10);
    await store.upsertCollection({ ...parent, status: "done" }, 11);
    expect(store.listCollections()).toHaveLength(1);
    expect(store.getCollection("p1")?.status).toBe("done");
    expect(store.getCollection("p1")?.updatedAt).toBe(11);
  });

  it("removes a collection", async () => {
    const { store } = makeStore();
    await store.upsertCollection(sample().parent, 10);
    await store.removeCollection("p1");
    expect(store.listCollections()).toEqual([]);
  });
});
