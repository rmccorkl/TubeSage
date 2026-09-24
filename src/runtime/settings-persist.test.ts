import { describe, expect, it } from "vitest";
import { JOBS_KEY, JobStore } from "../jobs/job-store";
import type { JobStoreIO } from "../jobs/job-store";
import { createJobRecord } from "../jobs/job-record";
import { settingsForPersist } from "./settings-persist";

// The real composeSettings main.ts hands to the JobStore: this test binds the
// exact function, not a re-implementation, so a regression in what reaches
// data.json is caught here.

const OLLAMA_DEFAULT = "http://localhost:11434";

function liveSettings(): Record<string, unknown> & { apiKeys: Record<string, string> } {
  return {
    selectedLLM: "anthropic",
    apiKeys: {
      openai: "sk-openai",
      anthropic: "sk-ant",
      google: "g-key",
      openrouter: "or-key",
      ollama: "http://box:11434",
    },
    useFastSummary: true,
    debugLogging: false,
  };
}

class FakeIO implements JobStoreIO {
  calls: unknown[] = [];
  loadData(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  saveData(data: unknown): Promise<void> {
    this.calls.push(JSON.parse(JSON.stringify(data)));
    return Promise.resolve();
  }
}

describe("settingsForPersist", () => {
  it("strips every cloud API key and keeps only the ollama entry", () => {
    const out = settingsForPersist(liveSettings(), OLLAMA_DEFAULT);
    expect(out.apiKeys).toEqual({ ollama: "http://box:11434" });
    expect(JSON.stringify(out)).not.toContain("sk-openai");
    expect(JSON.stringify(out)).not.toContain("sk-ant");
    expect(JSON.stringify(out)).not.toContain("g-key");
    expect(JSON.stringify(out)).not.toContain("or-key");
    expect(out.selectedLLM).toBe("anthropic");
    expect(out.useFastSummary).toBe(true);
  });

  it("uses the ollama default when the live settings carry none", () => {
    const settings = liveSettings();
    delete settings.apiKeys.ollama;
    expect(settingsForPersist(settings, OLLAMA_DEFAULT).apiKeys).toEqual({ ollama: OLLAMA_DEFAULT });
  });

  it("never emits the reserved _jobs key, even when the live settings object carries one", () => {
    const settings = { ...liveSettings(), [JOBS_KEY]: [{ id: "stale" }] };
    const out = settingsForPersist(settings, OLLAMA_DEFAULT);
    expect(Object.keys(out)).not.toContain(JOBS_KEY);
  });

  it("does not mutate the live settings object", () => {
    const settings = liveSettings();
    settingsForPersist(settings, OLLAMA_DEFAULT);
    expect(settings.apiKeys.anthropic).toBe("sk-ant");
  });

  it("bound to a real JobStore: the flushed payload has stripped keys and _jobs holds only the store's records", async () => {
    const settings = { ...liveSettings(), [JOBS_KEY]: [{ id: "stale" }] };
    const io = new FakeIO();
    const store = new JobStore(io, () => settingsForPersist(settings, OLLAMA_DEFAULT));
    const record = createJobRecord({
      id: "job-1",
      url: "https://youtu.be/abc123",
      videoId: "abc123",
      folder: "",
      customTitle: "",
      useFastSummary: false,
      transcriptBilling: "free",
      now: 1000,
    });
    await store.upsert(record, 1000);
    expect(io.calls).toHaveLength(1);
    const payload = io.calls[0] as Record<string, unknown>;
    expect(payload.apiKeys).toEqual({ ollama: "http://box:11434" });
    expect(JSON.stringify(payload)).not.toContain("sk-ant");
    expect(payload[JOBS_KEY]).toEqual([expect.objectContaining({ id: "job-1" })]);
  });
});

describe("reserved store keys never round-trip as settings", () => {
  it("drops _collections as well as _jobs", () => {
    // Both are owned by the store and re-added at flush. If either survived
    // here it would be written back as user configuration and then grow on
    // every save.
    const payload = settingsForPersist(
      { apiKeys: { ollama: "http://localhost:11434" }, _jobs: [{ id: "j" }], _collections: [{ id: "c" }] } as never,
      "http://localhost:11434",
    );
    expect(payload).not.toHaveProperty("_jobs");
    expect(payload).not.toHaveProperty("_collections");
  });
});
