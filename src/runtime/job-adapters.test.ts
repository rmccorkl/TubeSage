import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobRecord, deriveNotePath, formatDatePrefix } from "../jobs/job-record";
import type { NoteJobRecord, NotePathSettings } from "../jobs/job-record";
import { JobStore } from "../jobs/job-store";
import { NoteChangedError, PathDriftError, PermanentJobError } from "../jobs/job-runner";
import type { JobEvent } from "../jobs/job-runner";
import { MAX_CREATE_ATTEMPTS, createJobStages, createRunnerDeps } from "./job-adapters";
import type { JobHost, JobHostSettings, RenderedNote, TimestampPassOptions, VaultLike } from "./job-adapters";
import { sanitizeFilename } from "../utils/filename-sanitizer";
import { NoCaptionsError } from "../utils/transcript-errors";

// Integration tests for the Obsidian adapters with injected doubles: no
// `obsidian` import, no network, no real vault. The host double stands in
// for the plugin (main.ts) and the vault double for the three Vault calls
// the adapters are allowed to make.

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
// The normalizer injected into the adapters (main.ts passes Obsidian's
// normalizePath). NFC is the part that matters here; the vault index is NFC.
const nfc = (path: string): string => path.normalize("NFC");
// Derived, never hardcoded: the record's frozen target and the host's
// rendered path must come from the same inputs (#3 final review C1).
const FROZEN_SETTINGS: NotePathSettings = { prependDate: false, dateFormat: "YYYY-MM-DD" };
const TARGET = nfc(`Notes/${sanitizeFilename("Video Title")}.md`);

interface FakeFile {
  path: string;
}

class FakeVault implements VaultLike<FakeFile> {
  readonly files = new Map<string, string>();
  readonly created: Array<[string, string]> = [];
  /**
   * Paths `create` rejects as already existing although `getFile` cannot see them —
   * Obsidian's public `getAbstractFileByPath` is case-SENSITIVE while a macOS/Windows
   * filesystem is not, so a differently-cased neighbour collides only at create time.
   */
  readonly invisible = new Set<string>();
  /** When set, `create` rejects with it instead (a failure that is NOT a collision). */
  createError: Error | null = null;

  getFile(path: string): FakeFile | null {
    return this.files.has(path) ? { path } : null;
  }

  read(file: FakeFile): Promise<string> {
    const content = this.files.get(file.path);
    if (content === undefined) {
      return Promise.reject(new Error(`no such file: ${file.path}`));
    }
    return Promise.resolve(content);
  }

  create(path: string, content: string): Promise<unknown> {
    if (this.createError !== null) {
      return Promise.reject(this.createError);
    }
    if (this.files.has(path) || this.invisible.has(path)) {
      return Promise.reject(new Error("File already exists."));
    }
    this.created.push([path, content]);
    this.files.set(path, content);
    return Promise.resolve({ path });
  }
}

class FakeHost implements JobHost {
  settings: JobHostSettings = { prependDate: false, dateFormat: "YYYY-MM-DD", scrapcreatorsApiKey: "", supadataApiKey: "" };
  extractResult: { transcript: string; metadata: { title?: string; author?: string } } = {
    transcript: "[00:00:01] hello world",
    metadata: { title: "Video Title" },
  };
  extractError: Error | null = null;
  templaterAvailable = true;
  summaryResult = "a summary";
  renderContent = "rendered";
  /** When set, replaces the derived path (simulates a host whose derivation disagrees with the record). */
  renderPathOverride: string | null = null;
  timestampsError: Error | null = null;
  readonly extractCalls: string[] = [];
  readonly summarizeCalls: Array<[string, boolean | undefined]> = [];
  readonly renderCalls: unknown[][] = [];
  readonly ensured: string[] = [];
  readonly timestampCalls: Array<[string, string]> = [];
  readonly timestampOptions: Array<TimestampPassOptions | undefined> = [];
  translateError: Error | null = null;
  readonly translateCalls: Array<[string, string, string]> = [];

  extractTranscriptStrict(videoUrl: string): Promise<{ transcript: string; metadata: { title?: string } }> {
    this.extractCalls.push(videoUrl);
    return this.extractError === null ? Promise.resolve(this.extractResult) : Promise.reject(this.extractError);
  }
  canRenderNote(): boolean {
    return this.templaterAvailable;
  }
  summarizeTranscript(transcript: string, useFastSummary?: boolean): Promise<string> {
    this.summarizeCalls.push([transcript, useFastSummary]);
    return Promise.resolve(this.summaryResult);
  }
  // Mirrors main.ts renderNoteContent's path derivation: date prefix from
  // the frozen settings when the adapter passes them, else the live ones.
  renderNoteContent(
    title: string,
    videoUrl: string,
    transcript: string,
    summary: string,
    folder: string,
    createdAt: number,
    notePathSettings?: NotePathSettings,
  ): Promise<RenderedNote> {
    this.renderCalls.push([title, videoUrl, transcript, summary, folder, createdAt, notePathSettings]);
    const fileName = `${formatDatePrefix(createdAt, notePathSettings ?? this.settings)}${sanitizeFilename(title)}.md`;
    const derived = nfc(folder ? `${folder}/${fileName}` : fileName);
    return Promise.resolve({ filePath: this.renderPathOverride ?? derived, content: this.renderContent, folder });
  }
  ensureFolder(folderPath: string): Promise<void> {
    this.ensured.push(folderPath);
    return Promise.resolve();
  }
  addSectionLinksToNote(notePath: string, videoUrl: string, options?: TimestampPassOptions): Promise<void> {
    this.timestampCalls.push([notePath, videoUrl]);
    this.timestampOptions.push(options);
    return this.timestampsError === null ? Promise.resolve() : Promise.reject(this.timestampsError);
  }
  translateNoteStrict(notePath: string, language: string, country: string): Promise<void> {
    this.translateCalls.push([notePath, language, country]);
    return this.translateError === null ? Promise.resolve() : Promise.reject(this.translateError);
  }
}

function record(overrides: Partial<NoteJobRecord> = {}): NoteJobRecord {
  const base = createJobRecord({
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "Notes",
    customTitle: "",
    useFastSummary: false,
    now: NOW,
  });
  const frozen: NoteJobRecord = { ...base, notePathSettings: FROZEN_SETTINGS };
  return { ...frozen, targetNotePath: deriveNotePath({ ...frozen, resolvedTitle: "Video Title" }, FROZEN_SETTINGS, nfc), ...overrides };
}

describe("createJobStages — fetchTranscript", () => {
  it("returns the transcript and the metadata title, calling the host with the record's url", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    const result = await stages.fetchTranscript(record());
    expect(result).toEqual({ transcript: "[00:00:01] hello world", title: "Video Title" });
    expect(host.extractCalls).toEqual(["https://youtu.be/abc123"]);
  });

  it("an empty transcript is a PermanentJobError", async () => {
    const host = new FakeHost();
    host.extractResult = { transcript: "", metadata: { title: "Video Title" } };
    const stages = createJobStages(host, new FakeVault(), nfc);
    await expect(stages.fetchTranscript(record())).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("a [TRANSCRIPT EXTRACTION FAILED marker (no captions, metadata recovered) is a PermanentJobError carrying exactly the reason", async () => {
    const host = new FakeHost();
    // Exactly what extractTranscriptStrict returns for the extractor's
    // single failure segment: formatTranscriptForYaml prefixes the
    // timestamp + TimeIndex marker and escapes every colon in the text.
    host.extractResult = {
      transcript:
        "\n    [00:00:00] [TimeIndex:0] [TRANSCRIPT EXTRACTION FAILED\\: iOS player methods all failed. Last error\\: No captions available for this video]\n",
      metadata: { title: "Video Title" },
    };
    const stages = createJobStages(host, new FakeVault(), nfc);
    const failure = await stages.fetchTranscript(record()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PermanentJobError);
    // The reason is what follows the marker (unescaped) — not the marker's own tail, not the closing bracket.
    expect((failure as Error).message).toBe("iOS player methods all failed. Last error: No captions available for this video");
  });

  it("any other rejection from the strict host call propagates unchanged (transient — the runner interrupts, never fails)", async () => {
    const host = new FakeHost();
    const network = new Error("Network error while fetching transcript. Please check your internet connection.");
    host.extractError = network;
    const stages = createJobStages(host, new FakeVault(), nfc);
    const failure = await stages.fetchTranscript(record()).catch((error: unknown) => error);
    expect(failure).toBe(network);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
  });

  it("I2: a NoCaptionsError from the strict host call is a PermanentJobError carrying its message (the job fails, never interrupts)", async () => {
    const host = new FakeHost();
    host.extractError = new NoCaptionsError("No captions available for this video");
    const stages = createJobStages(host, new FakeVault(), nfc);
    const failure = await stages.fetchTranscript(record()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PermanentJobError);
    expect((failure as Error).message).toBe("No captions available for this video");
  });

  it("I2: a transient rejection whose message names the failed caption fetch still propagates unchanged (the extractor no longer folds it into the marker)", async () => {
    const host = new FakeHost();
    const transient = new Error(
      "Network error while fetching transcript. Please check your internet connection. (All transcript extraction methods failed (iOS player). Last error: fetch failed)",
    );
    host.extractError = transient;
    const stages = createJobStages(host, new FakeVault(), nfc);
    const failure = await stages.fetchTranscript(record()).catch((error: unknown) => error);
    expect(failure).toBe(transient);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
  });

  it("a missing or blank title falls back to `YouTube Video <videoId>`", async () => {
    const host = new FakeHost();
    host.extractResult = { transcript: "text", metadata: {} };
    const stages = createJobStages(host, new FakeVault(), nfc);
    expect((await stages.fetchTranscript(record())).title).toBe("YouTube Video abc123");
    host.extractResult = { transcript: "text", metadata: { title: "   " } };
    expect((await stages.fetchTranscript(record())).title).toBe("YouTube Video abc123");
  });
});

describe("createJobStages — summary, render, create, timestamps", () => {
  it("canRenderNote delegates to the host", () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    expect(stages.canRenderNote()).toBe(true);
    host.templaterAvailable = false;
    expect(stages.canRenderNote()).toBe(false);
  });

  it("summarize returns the host's summary; an empty summary is a plain (transient) Error, never permanent", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    expect(await stages.summarize(record(), "text")).toBe("a summary");
    expect(host.summarizeCalls).toEqual([["text", false]]);
    host.summaryResult = "   ";
    const failure = await stages.summarize(record(), "text").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
  });

  it("renderNote passes the frozen inputs (record url, folder, createdAt, notePathSettings) and returns the content", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    const content = await stages.renderNote(record(), { transcript: "t", summary: "s", title: "Video Title" });
    expect(content).toBe("rendered");
    expect(host.renderCalls).toEqual([["Video Title", "https://youtu.be/abc123", "t", "s", "Notes", NOW, FROZEN_SETTINGS]]);
  });

  it("renderNote: the record's FROZEN date settings win over live settings that changed since (no drift, both sides derived)", async () => {
    const host = new FakeHost();
    host.settings.prependDate = true; // toggled after the transcript stage
    const stages = createJobStages(host, new FakeVault(), nfc);
    const rec = record();
    expect(rec.targetNotePath).toBe(TARGET);
    await expect(stages.renderNote(rec, { transcript: "t", summary: "s", title: "Video Title" })).resolves.toBe("rendered");
  });

  it("renderNote: a Hangul title derives to the same normalized path on both sides; a normalization-only difference is not drift", async () => {
    const host = new FakeHost();
    const title = "안녕하세요 튜토리얼";
    const stages = createJobStages(host, new FakeVault(), nfc);
    const rec = record({ resolvedTitle: title });
    rec.targetNotePath = deriveNotePath(rec, FROZEN_SETTINGS, nfc);
    expect(rec.targetNotePath).toBe(`Notes/${sanitizeFilename(title)}.md`.normalize("NFC"));
    await expect(stages.renderNote(rec, { transcript: "t", summary: "s", title })).resolves.toBe("rendered");
    // A host that renders the un-normalized (NFD) form is still the same note.
    // sanitizeFilename itself now returns NFC (#6), so the NFD variant has to
    // be constructed explicitly here rather than relying on the sanitizer.
    host.renderPathOverride = `Notes/${sanitizeFilename(title)}.md`.normalize("NFD");
    expect(host.renderPathOverride).not.toBe(rec.targetNotePath);
    await expect(stages.renderNote(rec, { transcript: "t", summary: "s", title })).resolves.toBe("rendered");
  });

  it("renderNote: a filePath that drifted from record.targetNotePath is a PathDriftError, never a PermanentJobError", async () => {
    const host = new FakeHost();
    host.renderPathOverride = "Notes/2026-09-20 Video Title.md";
    const stages = createJobStages(host, new FakeVault(), nfc);
    const failure = await stages
      .renderNote(record(), { transcript: "t", summary: "s", title: "Video Title" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PathDriftError);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    expect((failure as Error).message).toContain("drift");
  });

  it("renderNote: a record with no frozen target is treated as drift too", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    await expect(
      stages.renderNote(record({ targetNotePath: undefined }), { transcript: "t", summary: "s", title: "Video Title" }),
    ).rejects.toBeInstanceOf(PathDriftError);
  });

  it("createNote ensures the parent folder, then creates the file with the exact content", async () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    const stages = createJobStages(host, vault, nfc);
    expect(await stages.createNote("Notes/Sub/Video.md", "body")).toBe("Notes/Sub/Video.md");
    expect(host.ensured).toEqual(["Notes/Sub"]);
    expect(vault.created).toEqual([["Notes/Sub/Video.md", "body"]]);
    await stages.createNote("Root.md", "root body");
    expect(host.ensured).toEqual(["Notes/Sub"]); // no folder to ensure at the vault root
    expect(vault.files.get("Root.md")).toBe("root body");
  });

  it("createNote lands on the next free neighbour when the target is taken, and returns it", async () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    vault.files.set("Notes/Video.md", "the first run");
    const stages = createJobStages(host, vault, nfc);
    expect(await stages.createNote("Notes/Video.md", "the second run")).toBe("Notes/Video 1.md");
    expect(await stages.createNote("Notes/Video.md", "the third run")).toBe("Notes/Video 2.md");
    expect(vault.files.get("Notes/Video.md")).toBe("the first run"); // never overwritten
    expect(vault.files.get("Notes/Video 1.md")).toBe("the second run");
  });

  it("createNote probes and creates the SAME normalized path for an NFD target", async () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    vault.files.set(nfc("Notes/한글.md"), "the first run");
    const stages = createJobStages(host, vault, nfc);
    const created = await stages.createNote("Notes/한글.md".normalize("NFD"), "the second run");
    expect(created).toBe(nfc("Notes/한글 1.md"));
    expect(vault.files.get(created)).toBe("the second run");
  });

  it("createNote survives a collision its probe could not see (case-insensitive filesystem)", async () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    // getFile says free, create still rejects: exactly the divergence between
    // Obsidian's case-SENSITIVE public lookup and a case-insensitive filesystem.
    vault.invisible.add("Notes/Video.md");
    const stages = createJobStages(host, vault, nfc);
    expect(await stages.createNote("Notes/Video.md", "body")).toBe("Notes/Video 1.md");
    expect(vault.files.has("Notes/Video.md")).toBe(false);
    expect(vault.files.get("Notes/Video 1.md")).toBe("body");
  });

  it("createNote reports an unresolvable collision as a failure, never as success", async () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    for (let n = 0; n < MAX_CREATE_ATTEMPTS; n++) {
      vault.invisible.add(n === 0 ? "Notes/Video.md" : `Notes/Video ${n}.md`);
    }
    const stages = createJobStages(host, vault, nfc);
    await expect(stages.createNote("Notes/Video.md", "body")).rejects.toThrow("File already exists.");
    expect(vault.files.size).toBe(0);
  });

  it("createNote rethrows a non-collision failure immediately, without burning retries", async () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    vault.createError = new Error("EACCES: permission denied");
    const stages = createJobStages(host, vault, nfc);
    await expect(stages.createNote("Notes/Video.md", "body")).rejects.toThrow("EACCES: permission denied");
  });

  it("addTimestamps calls the host with the note path and url; a NoteChangedError propagates unchanged", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    await stages.addTimestamps(record(), TARGET);
    expect(host.timestampCalls).toEqual([[TARGET, "https://youtu.be/abc123"]]);
    const changed = new NoteChangedError("the note was edited");
    host.timestampsError = changed;
    const failure = await stages.addTimestamps(record(), TARGET).catch((error: unknown) => error);
    expect(failure).toBe(changed);
  });

  it("I1: addTimestamps calls the host STRICT (the pass rethrows instead of swallowing), and a plain rejection propagates unchanged", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    await stages.addTimestamps(record(), TARGET);
    expect(host.timestampOptions).toEqual([{ strict: true }]);
    const network = new Error("Error adding timestamp links: fetch failed");
    host.timestampsError = network;
    const failure = await stages.addTimestamps(record(), TARGET).catch((error: unknown) => error);
    expect(failure).toBe(network);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
  });
});

describe("createJobStages — translation (#3 final review residual)", () => {
  const frozen = { language: "fr", country: "FR" };

  it("translateNote passes the record's FROZEN language/country to the strict host call, never the live settings", async () => {
    const host = new FakeHost();
    host.settings = { ...host.settings, translateLanguage: "de", translateCountry: "DE" };
    const stages = createJobStages(host, new FakeVault(), nfc);
    await stages.translateNote(record({ translation: frozen }), TARGET);
    expect(host.translateCalls).toEqual([[TARGET, "fr", "FR"]]);
    expect(host.timestampCalls).toEqual([]);
  });

  it("translateNote lets a NoteChangedError and a plain Error propagate unchanged (never permanent, never swallowed)", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    const changed = new NoteChangedError("the note was edited");
    host.translateError = changed;
    expect(await stages.translateNote(record({ translation: frozen }), TARGET).catch((error: unknown) => error)).toBe(changed);
    const network = new Error("Translation error: fetch failed");
    host.translateError = network;
    const failure = await stages.translateNote(record({ translation: frozen }), TARGET).catch((error: unknown) => error);
    expect(failure).toBe(network);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
  });

  it("translateNote on a record with nothing frozen rejects with a plain Error and makes no host call", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    const failure = await stages.translateNote(record(), TARGET).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    expect(host.translateCalls).toEqual([]);
  });

  it("addTimestamps (strict) never triggers translation, even when the live settings ask for it", async () => {
    const host = new FakeHost();
    host.settings = { ...host.settings, translateLanguage: "fr", translateCountry: "FR" };
    const stages = createJobStages(host, new FakeVault(), nfc);
    await stages.addTimestamps(record({ translation: frozen }), TARGET);
    expect(host.timestampOptions).toEqual([{ strict: true }]);
    expect(host.translateCalls).toEqual([]);
  });

  it("createRunnerDeps.translationSettings reads the LIVE host settings: undefined for en/US or absent, the pair otherwise", () => {
    const host = new FakeHost();
    const deps = createRunnerDeps(host, new JobStore(), () => undefined, {
      vault: new FakeVault(),
      normalizePath: nfc,
    });
    expect(deps.translationSettings()).toBeUndefined();
    host.settings = { ...host.settings, translateLanguage: "en", translateCountry: "US" };
    expect(deps.translationSettings()).toBeUndefined();
    host.settings = { ...host.settings, translateLanguage: "fr", translateCountry: "FR" };
    expect(deps.translationSettings()).toEqual({ language: "fr", country: "FR" });
  });
});

describe("createRunnerDeps", () => {
  it("wires the store, live note-path settings, ids and the injected clock/timers", () => {
    const host = new FakeHost();
    const vault = new FakeVault();
    const store = new JobStore();
    const events: JobEvent[] = [];
    const timers: Array<[() => void, number]> = [];
    const cleared: unknown[] = [];
    const deps = createRunnerDeps(host, store, (event) => events.push(event), {
      vault,
      normalizePath: nfc,
      now: () => NOW,
      setTimeout: (fn, ms) => {
        timers.push([fn, ms]);
        return "handle";
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
      },
      generateId: () => "fixed-id",
      deadlines: { llmMs: 1234 },
    });
    expect(deps.store).toBe(store);
    expect(deps.now()).toBe(NOW);
    expect(deps.generateId()).toBe("fixed-id");
    expect(deps.deadlines).toEqual({ llmMs: 1234 });
    expect(deps.notePathSettings()).toEqual({ prependDate: false, dateFormat: "YYYY-MM-DD" });
    host.settings.prependDate = true;
    host.settings.dateFormat = "DD-MM-YYYY";
    expect(deps.notePathSettings()).toEqual({ prependDate: true, dateFormat: "DD-MM-YYYY" });
    expect(deps.normalizePath("a/한".normalize("NFD"))).toBe("a/한");
    expect(deps.setTimeout(() => undefined, 5)).toBe("handle");
    expect(timers).toHaveLength(1);
    deps.clearTimeout("handle");
    expect(cleared).toEqual(["handle"]);
    const event: JobEvent = { type: "cancelled", id: "job-1" };
    deps.onEvent(event);
    expect(events).toEqual([event]);
  });

  it("uses a real clock and unique ids by default", () => {
    const deps = createRunnerDeps(new FakeHost(), new JobStore(), () => undefined, {
      vault: new FakeVault(),
      normalizePath: nfc,
    });
    const before = Date.now();
    expect(deps.now()).toBeGreaterThanOrEqual(before);
    const a = deps.generateId();
    const b = deps.generateId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(deps.deadlines).toBeUndefined();
  });
});

describe("createJobStages — T6b: record-scoped fast summary", () => {
  it("summarize passes the record's frozen useFastSummary flag to the host, never the live setting", async () => {
    const host = new FakeHost();
    const stages = createJobStages(host, new FakeVault(), nfc);
    await stages.summarize(record({ useFastSummary: true }), "text a");
    await stages.summarize(record({ useFastSummary: false }), "text b");
    expect(host.summarizeCalls).toEqual([
      ["text a", true],
      ["text b", false],
    ]);
  });
});

describe("createRunnerDeps — T6b: id fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to a time+random id when crypto.randomUUID is unavailable", () => {
    // A crypto double without randomUUID (older WebViews).
    vi.stubGlobal("crypto", {});
    const deps = createRunnerDeps(new FakeHost(), new JobStore(), () => undefined, {
      vault: new FakeVault(),
      normalizePath: nfc,
    });
    const a = deps.generateId();
    const b = deps.generateId();
    // Shape only: <base36 time>-<8 base36 chars>. The time prefix is not
    // asserted against Date.now() (a tick between the two reads would flake).
    expect(a).toMatch(/^[0-9a-z]{6,12}-[0-9a-z]{8}$/);
    expect(b).toMatch(/^[0-9a-z]{6,12}-[0-9a-z]{8}$/);
    expect(a).not.toBe(b);
  });

  it("falls back the same way when there is no crypto global at all", () => {
    vi.stubGlobal("crypto", undefined);
    const deps = createRunnerDeps(new FakeHost(), new JobStore(), () => undefined, {
      vault: new FakeVault(),
      normalizePath: nfc,
    });
    expect(deps.generateId()).toMatch(/^[0-9a-z]+-[0-9a-z]{8}$/);
  });
});
