import { describe, expect, it } from "vitest";
import { createJobRecord } from "../jobs/job-record";
import type { NoteJobRecord } from "../jobs/job-record";
import { JOBS_KEY, JobStore, hydrate } from "../jobs/job-store";
import type { JobStoreIO } from "../jobs/job-store";

// Exercises the exact startup/runtime sequence Task 5 wires into main.ts:
// loadData() -> hydrate() -> store.load(jobs) -> settings merge/migration ->
// composeSettings()-driven flush(). No Obsidian, no clock reads (NOW is a
// fixed constant). Only hydrate/JobStore (job-store.ts) and createJobRecord
// (job-record.ts) are imported from src/jobs — nothing else in that
// directory is touched by this task.

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

function makeRunningRecord(): NoteJobRecord {
  return createJobRecord({
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "",
    customTitle: "",
    useFastSummary: false,
    transcriptBilling: "free",
    now: NOW,
  });
}

// Minimal deferred helper for controlling when a fake saveData resolves —
// same shape as job-store.test.ts's, duplicated locally since this is a test
// double, not production code shared across the two suites.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Records every payload io.saveData receives and tracks whether calls
// overlap (max concurrent in-flight saveData calls).
class FakeIO implements JobStoreIO {
  calls: unknown[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private gate: Promise<void> | null = null;

  block(gate: Promise<void>): void {
    this.gate = gate;
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
  }
}

describe("startup persistence sequence", () => {
  it("hydrate -> load -> legacy settings migration -> flush writes migrated settings AND jobs, and settings handed to the merge never carries _jobs", async () => {
    const record = makeRunningRecord();
    expect(record.status).toBe("running");

    const raw = { selectedLLM: "openai", maxTokens: 4096, [JOBS_KEY]: [record] };
    const hydrated = hydrate(raw);

    // What main.ts's loadSettings() would merge over DEFAULT_SETTINGS must
    // never see the reserved jobs key.
    expect(Object.prototype.hasOwnProperty.call(hydrated.settings, JOBS_KEY)).toBe(false);

    // Mutable settings object standing in for `this.settings`, merged from
    // hydrated.settings (mirrors main.ts: `{ ...DEFAULT_SETTINGS, ...loadedSettings }`).
    let settings: Record<string, unknown> = { ...hydrated.settings };

    const io = new FakeIO();
    const store = new JobStore(io, () => settings);
    store.load(hydrated.jobs);

    // Simulate a one-time legacy migration bumping maxTokens, mirroring
    // main.ts's pattern of mutating settings then calling persist().
    settings = { ...settings, maxTokens: 8192 };
    await store.flush();

    expect(io.calls.length).toBe(1);
    const payload = io.calls[0] as Record<string, unknown>;
    expect(payload.maxTokens).toBe(8192);
    expect(payload[JOBS_KEY]).toEqual([record]);
  });

  it("concurrent settings flush and job upsert never overlap in saveData and coalesce into two writes with both records", async () => {
    const record1 = makeRunningRecord();
    const record2 = { ...makeRunningRecord(), id: "job-2", videoId: "def456" };

    const io = new FakeIO();
    const settings = { selectedLLM: "openai" };
    const store = new JobStore(io, () => settings);
    store.load([record1]);

    const gate = deferred();
    io.block(gate.promise);

    const pFlush = store.flush();
    const pUpsert = store.upsert(record2, NOW + 1000);

    gate.resolve();
    await Promise.all([pFlush, pUpsert]);

    expect(io.calls.length).toBe(2);
    expect(io.maxInFlight).toBe(1);

    const finalPayload = io.calls[1] as Record<string, unknown>;
    expect(finalPayload.selectedLLM).toBe("openai");
    const finalJobs = finalPayload[JOBS_KEY] as NoteJobRecord[];
    expect(finalJobs.map((r) => r.id).sort()).toEqual(["job-1", "job-2"]);
  });

  it("cloud API keys never reach the saved payload; only ollama survives composeSettings", async () => {
    // liveSettings stands in for the plugin's live this.settings, which DOES
    // hold a cloud key at runtime (populated from secret storage on load).
    const liveSettings: Record<string, unknown> = {
      selectedLLM: "openai",
      apiKeys: { openai: "sk-super-secret", ollama: "http://localhost:11434" },
    };

    // composeSettings mimics main.ts's persist(): sanitizedApiKeys = { ollama: ... }.
    const composeSettings = (): Record<string, unknown> => {
      const apiKeys = liveSettings.apiKeys as Record<string, string>;
      return { ...liveSettings, apiKeys: { ollama: apiKeys.ollama ?? "" } };
    };

    const io = new FakeIO();
    const store = new JobStore(io, composeSettings);

    await store.flush();

    expect(io.calls.length).toBe(1);
    const payload = io.calls[0] as Record<string, unknown>;
    const payloadApiKeys = payload.apiKeys as Record<string, string>;
    expect(Object.keys(payloadApiKeys)).toEqual(["ollama"]);
    expect(payloadApiKeys.ollama).toBe("http://localhost:11434");
    expect(Object.prototype.hasOwnProperty.call(payloadApiKeys, "openai")).toBe(false);
  });
});
