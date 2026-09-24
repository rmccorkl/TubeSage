import { describe, expect, it } from "vitest";
import { createJobRecord } from "./job-record";
import type { NoteJobRecord } from "./job-record";
import { COLLECTIONS_KEY } from "./collection-record";
import { JOBS_KEY, JobStore, hydrate } from "./job-store";
import { settingsForPersist } from "../runtime/settings-persist";

// Job records are memory-only (#10). What survives here is the migration
// story: upgraded vaults still have `_jobs`/`_collections` sitting in
// data.json, and hydrate() is the one place that sees them — it hands main.ts
// the settings without them plus the flag that triggers the one-time cleanup
// save. The store itself is now a Map, so the only thing worth asserting
// about it is that it starts empty and hands out copies.

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const OLLAMA_DEFAULT = "http://localhost:11434";

function makeRecord(overrides: Partial<Parameters<typeof createJobRecord>[0]> = {}): NoteJobRecord {
  return createJobRecord({
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "",
    customTitle: "",
    useFastSummary: false,
    now: NOW,
    ...overrides,
  });
}

describe("hydrate — the reserved keys never reach the settings merge", () => {
  it("leaves a settings-only object unchanged", () => {
    const raw = { theme: "dark", maxTokens: 4000 };
    const result = hydrate(raw);
    expect(result).toEqual({ settings: { theme: "dark", maxTokens: 4000 }, hadReservedKeys: false });
    expect(Object.prototype.hasOwnProperty.call(result.settings, JOBS_KEY)).toBe(false);
  });

  it("strips _jobs and _collections out of the settings", () => {
    const raw = { theme: "dark", [JOBS_KEY]: [makeRecord()], [COLLECTIONS_KEY]: [{ id: "c1" }] };
    const result = hydrate(raw);
    expect(result.settings).toEqual({ theme: "dark" });
  });

  it("strips a _jobs that is not even an array (a corrupted file is still cleaned up)", () => {
    const raw = { theme: "dark", [JOBS_KEY]: "not-an-array" };
    const result = hydrate(raw);
    expect(result).toEqual({ settings: { theme: "dark" }, hadReservedKeys: true });
  });

  it("does not mutate the object it was handed", () => {
    const raw = { theme: "dark", [JOBS_KEY]: [makeRecord()] };
    hydrate(raw);
    expect(Object.prototype.hasOwnProperty.call(raw, JOBS_KEY)).toBe(true);
  });
});

describe("the one-time data.json cleanup", () => {
  it("reports a data.json carrying _jobs so main.ts can save it away once, settings intact", () => {
    const raw = { theme: "dark", maxTokens: 4000, [JOBS_KEY]: [makeRecord()] };
    const result = hydrate(raw);
    expect(result.hadReservedKeys).toBe(true);
    expect(result.settings).toEqual({ theme: "dark", maxTokens: 4000 });
  });

  it("reports a data.json carrying _collections the same way, settings intact", () => {
    const raw = { theme: "dark", [COLLECTIONS_KEY]: [{ id: "c1" }] };
    const result = hydrate(raw);
    expect(result.hadReservedKeys).toBe(true);
    expect(result.settings).toEqual({ theme: "dark" });
  });

  it("reports nothing to clean up for a data.json that never held either key, or held nothing at all", () => {
    expect(hydrate({ theme: "dark" }).hadReservedKeys).toBe(false);
    expect(hydrate(undefined)).toEqual({ settings: {}, hadReservedKeys: false });
    expect(hydrate(null)).toEqual({ settings: {}, hadReservedKeys: false });
    expect(hydrate("nope")).toEqual({ settings: {}, hadReservedKeys: false });
    expect(hydrate(42)).toEqual({ settings: {}, hadReservedKeys: false });
  });

  it("hydrate -> persist: the cleanup write drops both keys and keeps every setting", () => {
    // What main.ts does when hadReservedKeys is true: compose the live
    // settings and save. The record array must not survive the round trip,
    // and nothing else may be lost with it.
    const raw = {
      theme: "dark",
      maxTokens: 4000,
      apiKeys: { openai: "sk-openai", ollama: "http://box:11434" },
      [JOBS_KEY]: [makeRecord()],
      [COLLECTIONS_KEY]: [{ id: "c1" }],
    };
    const hydrated = hydrate(raw);
    expect(hydrated.hadReservedKeys).toBe(true);

    const written = settingsForPersist(hydrated.settings, OLLAMA_DEFAULT);
    expect(written).not.toHaveProperty(JOBS_KEY);
    expect(written).not.toHaveProperty(COLLECTIONS_KEY);
    expect(written.theme).toBe("dark");
    expect(written.maxTokens).toBe(4000);
  });
});

describe("a job record does not outlive the process", () => {
  it("a fresh store is empty, and nothing in data.json can seed it", () => {
    const raw = { theme: "dark", [JOBS_KEY]: [makeRecord()], [COLLECTIONS_KEY]: [{ id: "c1" }] };
    // hydrate hands main.ts settings and a cleanup flag — there is no job or
    // collection channel out of it any more.
    expect(Object.keys(hydrate(raw)).sort()).toEqual(["hadReservedKeys", "settings"]);
    const store = new JobStore();
    expect(store.list()).toEqual([]);
    expect(store.listCollections()).toEqual([]);
  });

  it("hands out copies in both directions, so a caller cannot mutate what is stored", async () => {
    const store = new JobStore();
    const record = makeRecord();
    await store.upsert(record, NOW);

    record.stage = "done";
    expect(store.get("job-1")?.stage).toBe("transcript");

    const listed = store.list();
    listed[0].stage = "done";
    expect(store.get("job-1")?.stage).toBe("transcript");
  });
});
