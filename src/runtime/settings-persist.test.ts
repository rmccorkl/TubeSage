import { describe, expect, it } from "vitest";
import { JOBS_KEY } from "../jobs/job-store";
import { COLLECTIONS_KEY } from "../jobs/collection-record";
import { SettingsWriter, settingsForPersist } from "./settings-persist";

// The real composer main.ts persists through: this test binds the exact
// function, not a re-implementation, so a regression in what reaches data.json
// is caught here. Since jobs became memory-only (#10) this is the ONLY code
// between the live settings — which do hold a cloud API key at runtime — and
// the file, which is why the integration-level proof below was rehosted here
// from the deleted persistence.test.ts rather than deleted with it.

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

/**
 * main.ts's persist(), transcribed: compose the live settings through the real
 * settingsForPersist and hand the result to Obsidian's Plugin.saveData(). The
 * spy stands in for saveData, so `calls` is literally what data.json would
 * hold.
 */
class FakePlugin {
  calls: Record<string, unknown>[] = [];

  constructor(private readonly settings: Record<string, unknown>) {}

  async persist(): Promise<void> {
    await this.saveData(settingsForPersist(this.settings, OLLAMA_DEFAULT));
  }

  private saveData(data: Record<string, unknown>): Promise<void> {
    this.calls.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
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

  it("bound to the real persist path: cloud API keys never reach the saved payload; only ollama survives", async () => {
    // Rehosted from persistence.test.ts: the integration-level proof of the
    // invariant. `settings` stands in for the plugin's live this.settings,
    // which DOES hold cloud keys at runtime (populated from secret storage on
    // load). Nothing between here and the file may leak one.
    const plugin = new FakePlugin(liveSettings());
    await plugin.persist();

    expect(plugin.calls).toHaveLength(1);
    const payload = plugin.calls[0];
    const payloadApiKeys = payload.apiKeys as Record<string, string>;
    expect(Object.keys(payloadApiKeys)).toEqual(["ollama"]);
    expect(payloadApiKeys.ollama).toBe("http://box:11434");
    expect(Object.prototype.hasOwnProperty.call(payloadApiKeys, "openai")).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("sk-openai");
    expect(JSON.stringify(payload)).not.toContain("sk-ant");
    expect(JSON.stringify(payload)).not.toContain("g-key");
    expect(JSON.stringify(payload)).not.toContain("or-key");
  });

  it("bound to the real persist path: a stale reserved key in the live settings is not written back", async () => {
    // The migration guard, end to end: `_jobs`/`_collections` left over from
    // an upgraded data.json must not round-trip out as user configuration.
    const plugin = new FakePlugin({
      ...liveSettings(),
      [JOBS_KEY]: [{ id: "stale" }],
      [COLLECTIONS_KEY]: [{ id: "stale-collection" }],
    });
    await plugin.persist();

    expect(plugin.calls).toHaveLength(1);
    expect(plugin.calls[0]).not.toHaveProperty(JOBS_KEY);
    expect(plugin.calls[0]).not.toHaveProperty(COLLECTIONS_KEY);
  });
});

describe("reserved store keys never round-trip as settings", () => {
  it("drops _collections as well as _jobs", () => {
    // Neither is a setting. If either survived here, a pair left over in an
    // upgraded data.json would be written back as user configuration instead
    // of being cleaned up on load.
    const payload = settingsForPersist(
      { apiKeys: { ollama: "http://localhost:11434" }, _jobs: [{ id: "j" }], _collections: [{ id: "c" }] } as never,
      "http://localhost:11434",
    );
    expect(payload).not.toHaveProperty("_jobs");
    expect(payload).not.toHaveProperty("_collections");
  });
});

// --- SettingsWriter -------------------------------------------------------
//
// Rehosts the intent of the deleted persistence.test.ts:98 ("concurrent
// settings flush and job upsert never overlap in saveData and coalesce into
// two writes"). The job half of that test is gone for good; the settings half
// came back when persist() stopped going through the job store's serialized
// writer.

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Obsidian's Plugin.saveData(), with the first write holdable and overlap detection. */
class FakeDisk {
  calls: Record<string, unknown>[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private gate: Promise<void> | null = null;

  /** The NEXT write blocks on `gate`; later writes run free. */
  block(gate: Promise<void>): void {
    this.gate = gate;
  }

  async write(payload: Record<string, unknown>): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.calls.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
    const gate = this.gate;
    this.gate = null;
    try {
      if (gate !== null) {
        await gate;
      }
    } finally {
      this.inFlight--;
    }
  }
}

describe("SettingsWriter — settings writes stay serialized and ordered", () => {
  it("coalesces every save that arrives during a write into ONE trailing write, composed at write time so the newest settings win", async () => {
    const disk = new FakeDisk();
    let settings: Record<string, unknown> = { ...liveSettings(), maxTokens: 4096 };
    const writer = new SettingsWriter(
      () => settingsForPersist(settings, OLLAMA_DEFAULT),
      (payload) => disk.write(payload),
    );

    const gate = deferred();
    disk.block(gate.promise);

    const first = writer.save();
    await Promise.resolve();
    // Two more saves land while the first write is still open, each with a
    // newer settings object than the last.
    settings = { ...settings, maxTokens: 8192 };
    const second = writer.save();
    settings = { ...settings, maxTokens: 16384 };
    const third = writer.save();

    gate.resolve();
    await Promise.all([first, second, third]);

    // Two writes, not three: the second and third collapsed into one.
    expect(disk.calls).toHaveLength(2);
    expect(disk.calls[0].maxTokens).toBe(4096);
    // The trailing write composed when it RAN, so it carries the latest value
    // rather than the one that was live when it was requested.
    expect(disk.calls[1].maxTokens).toBe(16384);
  });

  it("the trailing write composes when it RUNS, not when it was requested", async () => {
    // The property that makes coalescing safe rather than merely cheap. A
    // request-time composer also passes the test above, because there the last
    // save() happens to be the last settings change too. Here the settings move
    // once more AFTER the queued save was requested and before it runs — which
    // is what main.ts does whenever a code path mutates this.settings without a
    // save of its own (the load-time coercions and migrations do exactly that)
    // while an earlier fire-and-forget save is still in flight.
    const disk = new FakeDisk();
    let settings: Record<string, unknown> = { ...liveSettings(), maxTokens: 4096 };
    const writer = new SettingsWriter(
      () => settingsForPersist(settings, OLLAMA_DEFAULT),
      (payload) => disk.write(payload),
    );

    const gate = deferred();
    disk.block(gate.promise);

    const first = writer.save();
    await Promise.resolve();
    settings = { ...settings, maxTokens: 8192 };
    const second = writer.save(); // requested while maxTokens is 8192
    // A later change with NO save of its own. Composing at request time would
    // write 8192 here and silently lose this.
    settings = { ...settings, maxTokens: 16384 };

    gate.resolve();
    await Promise.all([first, second]);

    expect(disk.calls).toHaveLength(2);
    expect(disk.calls[1].maxTokens).toBe(16384);
  });

  it("never re-enters the disk while a write is unresolved", async () => {
    const disk = new FakeDisk();
    const settings = liveSettings();
    const writer = new SettingsWriter(() => settingsForPersist(settings, OLLAMA_DEFAULT), (p) => disk.write(p));

    const gate = deferred();
    disk.block(gate.promise);
    const saves = [writer.save(), writer.save(), writer.save(), writer.save()];
    gate.resolve();
    await Promise.all(saves);

    expect(disk.maxInFlight).toBe(1);
  });

  it("an earlier payload can never land after a later one", async () => {
    const disk = new FakeDisk();
    let settings: Record<string, unknown> = { ...liveSettings(), transcriptRootFolder: "Old" };
    const writer = new SettingsWriter(() => settingsForPersist(settings, OLLAMA_DEFAULT), (p) => disk.write(p));

    const gate = deferred();
    disk.block(gate.promise);
    const first = writer.save();
    await Promise.resolve();
    settings = { ...settings, transcriptRootFolder: "New" };
    const second = writer.save();
    gate.resolve();
    await Promise.all([first, second]);

    // The last thing on disk is the last settings, whatever the interleaving.
    expect(disk.calls[disk.calls.length - 1].transcriptRootFolder).toBe("New");
  });

  it("a failed write rejects only its own waiters and leaves the writer usable", async () => {
    const disk = new FakeDisk();
    const settings = liveSettings();
    const writer = new SettingsWriter(() => settingsForPersist(settings, OLLAMA_DEFAULT), (p) => disk.write(p));

    const gate = deferred();
    disk.block(gate.promise);
    const failing = writer.save();
    await Promise.resolve();
    gate.reject(new Error("disk full"));
    await expect(failing).rejects.toThrow("disk full");

    await writer.save();
    expect(disk.calls).toHaveLength(2);
  });

  it("carries the cloud-API-key invariant through the serialized path", async () => {
    const disk = new FakeDisk();
    const settings = liveSettings();
    const writer = new SettingsWriter(() => settingsForPersist(settings, OLLAMA_DEFAULT), (p) => disk.write(p));

    await writer.save();

    expect(disk.calls).toHaveLength(1);
    expect(disk.calls[0].apiKeys).toEqual({ ollama: "http://box:11434" });
    for (const secret of ["sk-openai", "sk-ant", "g-key", "or-key"]) {
      expect(JSON.stringify(disk.calls[0])).not.toContain(secret);
    }
  });
});
