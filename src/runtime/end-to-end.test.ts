import { describe, expect, it } from "vitest";
import { JobRunner, NoteChangedError, PathDriftError, PermanentJobError } from "../jobs/job-runner";
import type { JobEvent } from "../jobs/job-runner";
import { JOBS_KEY, JobStore } from "../jobs/job-store";
import { COLLECTIONS_KEY } from "../jobs/collection-record";
import { settingsForPersist } from "./settings-persist";
import { formatDatePrefix } from "../jobs/job-record";
import type { NotePathSettings } from "../jobs/job-record";
import { createJobStages, createRunnerDeps } from "./job-adapters";
import { CollectionRunner } from "./collection-runner";
import { CollectionNotices } from "./collection-notice";
import type { CollectionVideo } from "../jobs/collection-record";
import type { JobHost, JobHostSettings, RenderedNote, TimestampPassOptions, VaultLike } from "./job-adapters";
import { sanitizeFilename } from "../utils/filename-sanitizer";
import { NoCaptionsError } from "../utils/transcript-errors";

// Seam-level tests (#3 final review C1): the REAL JobRunner + REAL adapters +
// REAL JobStore, driven through a host double that mirrors main.ts and a
// vault double that mirrors Obsidian. No `obsidian` import: the two Obsidian
// behaviours that matter are transcribed below from obsidian.asar 1.12.7.
//
//  - Vault.create(path):  `i = cu(e)` (normalizePath, NFC) before the write and
//    before its own lookup — the note always lands at the NFC path.
//  - Vault.getAbstractFileByPath(path): `fileMap.hasOwnProperty(path)` — an
//    exact lookup, no normalization; the index itself is NFC.
//
// Before issue #6's fix, sanitizeFilename left Hangul in NFD (conjoining Jamo
// survived its diacritic strip, and nothing recomposed them), so a note path
// derived without normalization was never found again. sanitizeFilename now
// recomposes to NFC itself (#6), so its output already matches the NFC vault
// index; the normalizer injected below stays in place as a defense for paths
// built or persisted before that fix (see the frozen NFD fixture below).


// Pinned harness clock (#3 fix-wave D1): every assertion below hardcodes a
// dated path (e.g. TARGET_PATH). Without an injected `now`
// the runner's `createdAt` comes from the REAL clock (createRunnerDeps'
// default), so every dated assertion only matched on 2026-09-20 itself and
// the suite failed 10/325 on any other day. Pinning `now` here makes every
// record's `createdAt` — and therefore every derived path — deterministic
// regardless of the day this suite actually runs.
const HARNESS_NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const HARNESS_DATE_PREFIX = formatDatePrefix(HARNESS_NOW, { prependDate: true, dateFormat: "YYYY-MM-DD" });
/** The derived path of a default "Video" title submitted through this harness. */
const TARGET_PATH = `Inbox/${HARNESS_DATE_PREFIX}Video.md`;

// obsidian.asar 1.12.7: cu(e) = tu(uu(e)).normalize("NFC");
//   uu: collapse [\\/]+ -> "/", trim leading/trailing "/", "" -> "/";
//   tu: U+00A0 | U+202F -> " ".
function obsidianNormalizePath(path: string): string {
  let out = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  if (out === "") {
    out = "/";
  }
  return out.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}

// src/utils/path-utils.ts normalizePath/joinPaths, transcribed (that module
// imports `obsidian` values, so it cannot be loaded here). main.ts renders
// the note path through these, THEN through Obsidian's normalizePath.
function pathUtilsNormalizePath(path: string): string {
  if (!path) {
    return "";
  }
  let normalized = path.trim();
  if (normalized.startsWith("/")) {
    normalized = normalized.substring(1);
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

function pathUtilsJoinPaths(...segments: string[]): string {
  const filtered = segments.filter((segment) => segment !== "");
  return filtered.length === 0 ? "" : pathUtilsNormalizePath(filtered.join("/"));
}

class ObsidianLikeVault implements VaultLike<{ path: string }> {
  readonly files = new Map<string, string>();
  readonly created: string[] = [];

  getFile(path: string): { path: string } | null {
    return this.files.has(path) ? { path } : null;
  }

  read(file: { path: string }): Promise<string> {
    return Promise.resolve(this.files.get(file.path) ?? "");
  }

  create(path: string, content: string): Promise<unknown> {
    const normalized = obsidianNormalizePath(path);
    if (this.files.has(normalized)) {
      return Promise.reject(new Error("File already exists."));
    }
    this.files.set(normalized, content);
    this.created.push(normalized);
    return Promise.resolve({ path: normalized });
  }
}

class MainLikeHost implements JobHost {
  settings: JobHostSettings = { prependDate: true, dateFormat: "YYYY-MM-DD", scrapcreatorsApiKey: "", supadataApiKey: "" };
  title = "Video";
  templaterAvailable = true;
  summarizeCalls = 0;
  timestampCalls = 0;
  /** (notePath, language, country) of every strict translation call. */
  readonly translateCalls: Array<[string, string, string]> = [];
  /** When set, translateNoteStrict rejects with it AFTER the note lookup succeeded (the strict pass rethrowing). */
  translateError: Error | null = null;
  /** What the adapter passed as the timestamp pass options, per call. */
  readonly timestampOptions: Array<TimestampPassOptions | undefined> = [];
  /** When set, extractTranscriptStrict rejects with it (the extractor's strict-mode rejection). */
  extractError: Error | null = null;
  /** When set, addSectionLinksToNote rejects with it AFTER the note lookup succeeded (a strict pass rethrowing). */
  timestampsError: Error | null = null;
  /** Hook run inside summarizeTranscript (after the transcript stage froze the path, before the render). */
  onSummarize: (() => void) | null = null;
  /** Overrides the rendered filePath (adapter-level drift simulation). */
  renderPathOverride: string | null = null;

  constructor(private readonly vault: ObsidianLikeVault) {}

  extractTranscriptStrict(_url?: string): Promise<{ transcript: string; metadata: { title?: string } }> {
    if (this.extractError !== null) {
      return Promise.reject(this.extractError);
    }
    return Promise.resolve({ transcript: "[00:00:01] hello", metadata: { title: this.title } });
  }

  canRenderNote(): boolean {
    return this.templaterAvailable;
  }

  summarizeTranscript(): Promise<string> {
    this.summarizeCalls++;
    this.onSummarize?.();
    return Promise.resolve("SUMMARY");
  }

  // Mirrors main.ts renderNoteContent: date prefix from the FROZEN settings
  // when given, path-utils folder/join, then Obsidian's normalizePath.
  renderNoteContent(
    title: string,
    _videoUrl: string,
    _transcript: string,
    _summary: string,
    folder: string,
    createdAt: number,
    notePathSettings?: NotePathSettings,
  ): Promise<RenderedNote> {
    const normalizedFolder = pathUtilsNormalizePath(folder || "");
    const fileName = `${formatDatePrefix(createdAt, notePathSettings ?? this.settings)}${sanitizeFilename(title)}.md`;
    const joined = normalizedFolder ? pathUtilsJoinPaths(normalizedFolder, fileName) : fileName;
    const filePath = this.renderPathOverride ?? obsidianNormalizePath(joined);
    return Promise.resolve({ filePath, content: "RENDERED", folder: normalizedFolder });
  }

  ensureFolder(): Promise<void> {
    return Promise.resolve();
  }

  // Mirrors main.ts addSectionLinksToNote: an exact getAbstractFileByPath
  // lookup that throws when the stored path is not in the index.
  addSectionLinksToNote(notePath: string, _videoUrl: string, options?: TimestampPassOptions): Promise<void> {
    this.timestampCalls++;
    this.timestampOptions.push(options);
    if (this.vault.getFile(notePath) === null) {
      return Promise.reject(new Error("Could not find note file"));
    }
    if (this.timestampsError !== null) {
      return Promise.reject(this.timestampsError);
    }
    // The pass wrote the timestamped note: what a resume must find on disk.
    this.vault.files.set(notePath, `${this.vault.files.get(notePath) ?? ""}\n[Watch]`);
    return Promise.resolve();
  }

  // Mirrors main.ts translateNoteStrict: exact lookup, then the LLM call
  // whose failure is rethrown, then the guarded write.
  translateNoteStrict(notePath: string, language: string, country: string): Promise<void> {
    this.translateCalls.push([notePath, language, country]);
    if (this.vault.getFile(notePath) === null) {
      return Promise.reject(new Error("Could not find note file"));
    }
    if (this.translateError !== null) {
      return Promise.reject(this.translateError);
    }
    this.vault.files.set(notePath, `${this.vault.files.get(notePath) ?? ""}\n[translated ${language}-${country}]`);
    return Promise.resolve();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Harness {
  vault: ObsidianLikeVault;
  host: MainLikeHost;
  store: JobStore;
  events: JobEvent[];
  runner: JobRunner;
  /** Every payload saveData received (what data.json would hold). */
  writes: unknown[];
  /** main.ts persist(): compose the live settings and write them. */
  persist: () => Promise<void>;
  liveSettings: Record<string, unknown>;
}

function harness(options: { onEvent?: (event: JobEvent) => void } = {}): Harness {
  const vault = new ObsidianLikeVault();
  const host = new MainLikeHost(vault);
  const writes: unknown[] = [];
  // The ONE data.json writer, standing in for Obsidian's Plugin.saveData().
  // Everything that could ever reach data.json has to come through here, so
  // an empty `writes` is evidence that nothing was written at all.
  const saveData = (data: unknown): Promise<void> => {
    writes.push(JSON.parse(JSON.stringify(data)));
    return Promise.resolve();
  };
  // Mirrors main.ts persist(): the live settings, composed through the real
  // settingsForPersist, handed straight to saveData.
  const liveSettings: Record<string, unknown> = {
    selectedLLM: "openai",
    apiKeys: { openai: "sk-e2e-secret", ollama: "http://box:11434" },
  };
  const persist = (): Promise<void> => saveData(settingsForPersist(liveSettings, "http://localhost:11434"));
  const store = new JobStore();
  const events: JobEvent[] = [];
  // Inert timers: no stage here ever times out, so nothing is left armed
  // after a test (no globals, no cleanup).
  const deps = createRunnerDeps(host, store, (event) => {
    events.push(event);
    // Lets a test observe events as the runner emits them, which is how the
    // host wires a collection to the runner.
    options.onEvent?.(event);
  }, {
    vault,
    normalizePath: obsidianNormalizePath,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => HARNESS_NOW,
  });
  const runner = new JobRunner(deps);
  return { vault, host, store, events, runner, writes, persist, liveSettings };
}

const HANGUL_TITLE = "안녕하세요 튜토리얼";

function submitInput(videoId: string) {
  return { url: `https://youtu.be/${videoId}`, videoId, folder: "Inbox", customTitle: "", useFastSummary: false, addTimestampLinks: true };
}

describe("end-to-end: nothing the job machinery does reaches data.json", () => {
  it("a job runs to completion without a single write, and the settings writes around it never carry _jobs or _collections", async () => {
    const h = harness();
    // A stale reserved key, as an upgraded user's data.json still holds it:
    // it must not round-trip back out through the settings composer.
    h.liveSettings[JOBS_KEY] = [{ id: "stale" }];
    h.liveSettings[COLLECTIONS_KEY] = [{ id: "stale-collection" }];

    await h.runner.submit(submitInput("nw1"));
    await h.persist(); // a setting saved while the job is in flight
    await settle();
    await h.persist(); // and once it has finished

    expect(h.store.list()[0].status).toBe("done");
    // Exactly the two settings saves: the runner and the store wrote nothing.
    expect(h.writes).toHaveLength(2);
    for (const payload of h.writes) {
      expect(payload).not.toHaveProperty(JOBS_KEY);
      expect(payload).not.toHaveProperty(COLLECTIONS_KEY);
    }
  });
});

describe("end-to-end: runner + adapters + store against Obsidian-like doubles (#3 C1)", () => {
  it("P0 an ASCII title completes with one note at the derived path", async () => {
    const h = harness();
    await h.runner.submit(submitInput("a1"));
    await settle();
    const record = h.store.list()[0];
    expect(record.status).toBe("done");
    expect(h.vault.files.size).toBe(1);
    expect(record.notePath).toBe(TARGET_PATH);
    expect(h.vault.getFile(record.notePath ?? "")).not.toBeNull();
    expect(h.host.summarizeCalls).toBe(1);
  });

  it("P1 a Hangul title completes: exactly one note at the NFC path, every stored path finds it, one paid summary", async () => {
    const h = harness();
    h.host.title = HANGUL_TITLE;
    await h.runner.submit(submitInput("k1"));
    await settle();
    const record = h.store.list()[0];
    const expected = `Inbox/${HARNESS_DATE_PREFIX}${sanitizeFilename(HANGUL_TITLE)}.md`.normalize("NFC");
    expect(expected).toBe(`Inbox/${HARNESS_DATE_PREFIX}${sanitizeFilename(HANGUL_TITLE)}.md`); // sanitizeFilename now returns NFC itself (#6)
    expect(record.status).toBe("done");
    expect(record.lastError).toBeUndefined();
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.host.timestampCalls).toBe(1);
    expect(h.vault.created).toEqual([expected]);
    expect(record.targetNotePath).toBe(expected);
    expect(record.notePath).toBe(expected);
    expect(h.vault.getFile(record.notePath ?? "")).not.toBeNull();
    expect(h.events.filter((e) => e.type === "failed" || e.type === "interrupted")).toEqual([]);
  });

  it("P2 prependDate toggled after the transcript stage: the note still lands at the FROZEN path, one summary", async () => {
    const h = harness();
    h.host.settings.prependDate = false;
    h.host.onSummarize = () => {
      h.host.settings.prependDate = true; // after the freeze, before the render
    };
    await h.runner.submit(submitInput("d1"));
    await settle();
    const record = h.store.list()[0];
    expect(record.status).toBe("done");
    expect(record.notePathSettings).toEqual({ prependDate: false, dateFormat: "YYYY-MM-DD" });
    expect(record.targetNotePath).toBe("Inbox/Video.md");
    expect(record.notePath).toBe("Inbox/Video.md");
    expect(h.vault.created).toEqual(["Inbox/Video.md"]);
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
  });

  it("adapter drift: a rendered path that differs from the target is a PathDriftError, and the job fails without creating anything", async () => {
    // The check survives #10; its outcome no longer does. There is no resume
    // to be resumable at, so a drifted render is a plain failure — but still a
    // DISTINCT error class from PermanentJobError, because the adapter must
    // not be able to disguise "the settings moved" as "this video can never
    // work".
    const h = harness();
    h.host.renderPathOverride = `Inbox/${HARNESS_DATE_PREFIX}Elsewhere.md`;
    const submitted = await h.runner.submit(submitInput("r1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("failed");
    expect(record?.lastError ?? "").toMatch(/drift/i);
    expect(h.events.filter((e) => e.type === "failed")).toHaveLength(1);
    expect(h.vault.files.size).toBe(0);
    expect(PathDriftError.prototype).not.toBeInstanceOf(PermanentJobError);
  });
});

describe("end-to-end: timestamps-stage failures surface as recoverable on the runner path (#3 final review I1)", () => {
  it("(a) a network Error from the strict timestamp pass → interrupted, in flight, still found by video id, no done event", async () => {
    const h = harness();
    h.host.timestampsError = new Error("Error adding timestamp links: fetch failed");
    const submitted = await h.runner.submit(submitInput("t1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.stage).toBe("timestamps");
    expect(record?.inFlight).toBe(true);
    expect(record?.lastError).toBe("Error adding timestamp links: fetch failed");
    expect(h.vault.files.size).toBe(1);
    expect(h.store.findByVideoId("t1")?.id).toBe(id);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    // A transient failure is NOT a verdict that the video can never work: it
    // surfaces as `interrupted`, never `failed`.
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id }]);
  });

  it("(b) the strict pass is a single billed attempt: the host is called STRICT exactly once", async () => {
    const h = harness();
    h.host.timestampsError = new Error("Error adding timestamp links: fetch failed");
    await h.runner.submit(submitInput("t2"));
    await settle();
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.timestampOptions).toEqual([{ strict: true }]);
    // The failed pass is not retried behind the person's back.
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
  });
});

describe("end-to-end: extraction failures are classified, never disguised (#3 final review I2)", () => {
  it("(c) a transient extractor rejection → interrupted at transcript, never failed, still found by video id", async () => {
    const h = harness();
    h.host.extractError = new Error(
      "Network error while fetching transcript. Please check your internet connection. (All transcript extraction methods failed (iOS player). Last error: fetch failed)",
    );
    const submitted = await h.runner.submit(submitInput("x1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.stage).toBe("transcript");
    expect(record?.lastError ?? "").toMatch(/Network error/);
    expect(h.store.findByVideoId("x1")?.id).toBe(id);
    // Transient, so never `failed` — and nothing paid was reached.
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id }]);
    expect(h.host.summarizeCalls).toBe(0);
    expect(h.vault.files.size).toBe(0);
  });

  it("(c′) a genuine NoCaptionsError → failed with the reason, terminal (not found by video id), no paid call", async () => {
    const h = harness();
    h.host.extractError = new NoCaptionsError("No captions available for this video");
    const submitted = await h.runner.submit(submitInput("x2"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("failed");
    expect(record?.lastError).toBe("No captions available for this video");
    expect(h.store.findByVideoId("x2")).toBeUndefined();
    expect(h.events.filter((e) => e.type === "failed")).toHaveLength(1);
    expect(h.host.summarizeCalls).toBe(0);
    expect(h.vault.files.size).toBe(0);
  });
});

describe("end-to-end: translation is a checkpointed paid stage — failures surface, the timestamped note survives (#3 final review residual)", () => {
  function progressStages(events: JobEvent[]): string[] {
    return events.flatMap((e) => (e.type === "progress" ? [e.stage] : []));
  }

  function translating(h: Harness): void {
    h.host.settings = { ...h.host.settings, translateLanguage: "fr", translateCountry: "FR" };
  }

  it("(a) a network Error from the strict translation → interrupted at translation, in flight, NO done event, the timestamped note on disk", async () => {
    const h = harness();
    translating(h);
    h.host.translateError = new Error("Translation error: fetch failed");
    const submitted = await h.runner.submit(submitInput("tr1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.stage).toBe("translation");
    expect(record?.inFlight).toBe(true);
    expect(record?.lastError).toBe("Translation error: fetch failed");
    expect(record?.translation).toEqual({ language: "fr", country: "FR" });
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.translateCalls).toEqual([[TARGET_PATH, "fr", "FR"]]);
    expect(h.vault.files.get(TARGET_PATH)).toBe("RENDERED\n[Watch]");
    expect(h.store.findByVideoId("tr1")?.id).toBe(id);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([{ type: "interrupted", id }]);
  });

  it("(c) no frozen translation (en/US): the stage sequence never includes translation, zero translation calls, nothing frozen on the record", async () => {
    const h = harness();
    const submitted = await h.runner.submit(submitInput("tr4"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("done");
    expect(record?.translation).toBeUndefined();
    expect("translation" in (record ?? {})).toBe(false);
    expect(progressStages(h.events)).toEqual(["transcript", "summary", "note-creating", "timestamps"]);
    expect(h.host.translateCalls).toEqual([]);
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id, notePath: TARGET_PATH }]);
  });

  it("(d) a NoteChangedError from the translation → done with translationSkipped note-changed (never interrupted, never a Notice-and-done)", async () => {
    const h = harness();
    translating(h);
    h.host.translateError = new NoteChangedError("The note was edited while it was being translated, so the translation was not applied");
    const submitted = await h.runner.submit(submitInput("tr5"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("done");
    expect(record?.inFlight).toBe(false);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id, notePath: TARGET_PATH, translationSkipped: "note-changed" },
    ]);
  });

  it("(e) fast summary skips the timestamps pass, so the frozen-nothing translation never runs either (legacy parity #3 D2)", async () => {
    const h = harness();
    translating(h);
    const submitted = await h.runner.submit({ ...submitInput("tr6"), useFastSummary: true });
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("done");
    expect(record?.translation).toBeUndefined();
    expect("translation" in (record ?? {})).toBe(false);
    expect(h.host.timestampCalls).toBe(0);
    expect(h.host.translateCalls).toEqual([]);
    expect(progressStages(h.events)).toEqual(["transcript", "summary", "note-creating"]);
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id, notePath: TARGET_PATH, timestampsSkipped: "user-choice", translationSkipped: "timestamps-skipped" },
    ]);
  });

  it("(e′) addTimestampLinks:false skips the timestamps pass, so the frozen-nothing translation never runs either (legacy parity #3 D2)", async () => {
    const h = harness();
    translating(h);
    const submitted = await h.runner.submit({ ...submitInput("tr6b"), addTimestampLinks: false });
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("done");
    expect(record?.translation).toBeUndefined();
    expect("translation" in (record ?? {})).toBe(false);
    expect(h.host.timestampCalls).toBe(0);
    expect(h.host.translateCalls).toEqual([]);
    expect(progressStages(h.events)).toEqual(["transcript", "summary", "note-creating"]);
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id, notePath: TARGET_PATH, timestampsSkipped: "user-choice", translationSkipped: "timestamps-skipped" },
    ]);
  });

  it("(f) a note edited during the TIMESTAMPS pass ends the job there: the translation is not attempted on a note the user is editing", async () => {
    const h = harness();
    translating(h);
    h.host.timestampsError = new NoteChangedError("The note was edited while timestamps were being added, so the timestamps were not applied");
    const submitted = await h.runner.submit(submitInput("tr7"));
    await settle();
    const id = (submitted as { id: string }).id;
    expect(h.store.get(id)?.status).toBe("done");
    expect(h.host.translateCalls).toEqual([]);
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id, notePath: TARGET_PATH, timestampsSkipped: "note-changed" },
    ]);
  });
});

describe("C a collection runs every one of its videos, not just the first", () => {
  // THE REGRESSION THIS LOCKS: the first cut wired `begin()` and nothing else,
  // so a 3-video playlist submitted ONE child, created ONE note and left its
  // notice stuck on the opening message for ever — a regression against the
  // blocking loop it replaced, which did process every video. Every module was
  // green at the time; the gap was entirely in the host wiring, which is why
  // the routing now lives in `CollectionRunner.handleJobEvent` and is driven
  // here against a REAL `JobRunner`.
  const videos: CollectionVideo[] = [1, 2, 3].map((n) => ({
    url: `https://youtu.be/c${n}`, videoId: `c${n}`, title: `Video ${n}`,
  }));

  function collectionHarness(options: { route?: boolean } = {}) {
    const pending: Promise<unknown>[] = [];
    let collection: CollectionRunner;
    const h = harness({
      onEvent: (event) => {
        // `route: false` reproduces the shipped bug: events arrive and nothing
        // advances the queue.
        if (options.route === false) return;
        pending.push(collection.handleJobEvent(event));
      },
    });
    // Every child shares the host's one title, so all three derive the SAME
    // note path. That used to need a per-url title here, because all but the
    // first child blocked on note-collision; now each one steps to its own
    // free neighbour, so the workaround is gone and the shared title is the
    // harsher case rather than a broken one.
    // A REAL CollectionNotices, not a double: `finish()` is what releases the
    // owned child ids, and a double cannot show that. The notice handle is fake
    // only in that it records instead of drawing.
    const shown: string[] = [];
    let hidden = 0;
    const notices = new CollectionNotices(
      (message) => { shown.push(message); return { setMessage: (m: string) => { shown.push(m); return undefined; }, hide: () => { hidden += 1; } }; },
      (progress) => `${progress.done}/${progress.total}`,
    );
    const noticeState = { shown, hidden: () => hidden };
    collection = new CollectionRunner({
      generateId: () => `col-${Math.random().toString(36).slice(2)}`,
      now: () => HARNESS_NOW,
      submitChild: async (video) => {
        const result = await h.runner.submit({
          url: video.url, videoId: video.videoId, folder: "Inbox",
          customTitle: "", useFastSummary: false, addTimestampLinks: true,
        });
        if (result.kind === "started" || result.kind === "already-running") return result.id;
        return undefined;
      },
      cancelChild: (id) => h.runner.cancel(id),
      isActive: (id) => h.runner.isActive(id),
      getChild: (id) => h.store.get(id),
      saveCollection: (record) => h.store.upsertCollection(record, HARNESS_NOW),
      notices,
    });
    const drain = async () => {
      for (let i = 0; i < 12; i += 1) {
        await settle();
        await Promise.all(pending.splice(0));
      }
    };
    return { h, collection, notices, noticeState, drain };
  }

  it("submits all three, creates three notes, and finishes its notice", async () => {
    const { h, collection, noticeState, drain } = collectionHarness();
    await collection.begin({ url: "https://youtube.com/playlist?list=PL", folder: "Inbox", sourceName: "Stuff", contentType: "Playlist", videos });
    await drain();
    expect(h.store.list()).toHaveLength(3);
    expect(h.store.list().every((r) => r.status === "done")).toBe(true);
    expect(h.vault.files.size).toBe(3);
    // Three same-titled children, three notes: each steps past the one before
    // it instead of blocking on the path the first one took.
    expect(h.vault.created).toEqual([
      TARGET_PATH,
      `Inbox/${HARNESS_DATE_PREFIX}Video 1.md`,
      `Inbox/${HARNESS_DATE_PREFIX}Video 2.md`,
    ]);
    expect(h.host.summarizeCalls).toBe(3);
    expect(noticeState.hidden()).toBe(1);
  });


  it("closes its notice when the run is stopped mid-item, and releases the child ids", async () => {
    // THE DEFECT THIS LOCKS: the cancelled branch used to ask the RUNNER whether
    // any child was still active. The runner emits a job's terminal event and
    // only clears it from its active map afterwards, in a `.finally`, so the
    // very child that just settled still read as active — the run took `update`,
    // was never asked again, and its persistent (timeout 0) notice stayed on
    // screen with stale progress until Obsidian restarted. A module double
    // cannot reproduce that ordering, which is why this test drives a real
    // JobRunner and a real CollectionNotices.
    const { h, collection, noticeState, drain } = collectionHarness();
    const parent = await collection.begin({
      url: "https://youtube.com/playlist?list=PL", folder: "Inbox",
      sourceName: "Stuff", contentType: "Playlist", videos,
    });
    const executing = h.store.list()[0].id;
    expect(collection.owns(executing)).toBe(true);

    // Stop the run while item one is still being processed.
    await collection.cancel(parent.id);
    await drain();

    // The already-paid item finished and wrote its note; nothing further ran.
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.vault.files.size).toBe(1);
    // ...and the run's notice is closed, exactly once.
    expect(noticeState.hidden()).toBe(1);
    // finish() is also what releases the ids, so later single jobs notice again.
    expect(collection.owns(executing)).toBe(false);
  });

  it("leaves no surface behind when the plugin unloads mid-run", async () => {
    // THE LEAK THIS LOCKS: `onunload` stopped the single-job surface and never
    // touched the collection's. On desktop that surface is a status-bar item
    // with a live `window.setInterval` behind it, so disabling or reloading the
    // plugin during a channel/playlist left an item and its timer running until
    // Obsidian restarted — on mobile, an ownerless floating notice.
    //
    // Driven against a real JobRunner and a real CollectionNotices, and the
    // runner is deliberately NOT stopped: letting the children keep reporting
    // is the harsher case, because a straggler must not repaint or reopen a
    // surface the plugin no longer drives.
    const { collection, notices, noticeState, drain } = collectionHarness();
    await collection.begin({
      url: "https://youtube.com/playlist?list=PL", folder: "Inbox",
      sourceName: "Stuff", contentType: "Playlist", videos,
    });
    expect(noticeState.hidden()).toBe(0);
    const shownAtUnload = noticeState.shown.length;

    // What `onunload` now does to this surface.
    notices.dismissAll();
    expect(noticeState.hidden()).toBe(1);

    await drain();
    expect(noticeState.hidden()).toBe(1);
    expect(noticeState.shown.length).toBe(shownAtUnload);
  });

  // The call site — that `onunload` actually ASKS for this — is guarded in
  // scripts/main-wiring.test.mjs. It reads main.ts as text, and `src/` may not
  // import node:fs (the lint rule that keeps this bundle mobile-safe), which is
  // why it lives beside the other main.ts scanner rather than here.

  it("stalls on item one when nothing routes the events — the shipped bug", async () => {
    // The control arm. If this ever starts passing three, the routing has been
    // removed and the test above is no longer proving anything.
    const { h, collection, noticeState, drain } = collectionHarness({ route: false });
    await collection.begin({ url: "https://youtube.com/playlist?list=PL", folder: "Inbox", sourceName: "Stuff", contentType: "Playlist", videos });
    await drain();
    expect(h.store.list()).toHaveLength(1);
    expect(h.vault.files.size).toBe(1);
    expect(noticeState.hidden()).toBe(0);
  });
});


describe("end-to-end: the create stage never overwrites — it steps to Obsidian's next free path", () => {
  // Against the vault double that mirrors Obsidian's own refusal
  // (`Vault.create` rejects with "File already exists.", it does not version),
  // so this is the one place the stepping is observed rather than assumed.
  function stages(vault: ObsidianLikeVault) {
    return createJobStages(new MainLikeHost(vault), vault, obsidianNormalizePath);
  }

  it("a second and third note for the same derived path land on ' 1' and ' 2', with the first untouched", async () => {
    const vault = new ObsidianLikeVault();
    vault.files.set(TARGET_PATH, "the first run");
    const created = stages(vault);
    expect(await created.createNote(TARGET_PATH, "the second run")).toBe(`Inbox/${HARNESS_DATE_PREFIX}Video 1.md`);
    expect(await created.createNote(TARGET_PATH, "the third run")).toBe(`Inbox/${HARNESS_DATE_PREFIX}Video 2.md`);
    expect(vault.files.get(TARGET_PATH)).toBe("the first run");
    expect(vault.files.get(`Inbox/${HARNESS_DATE_PREFIX}Video 1.md`)).toBe("the second run");
    expect(vault.files.size).toBe(3);
    // Two creates, in order, neither of them a second write to the same path.
    expect(vault.created).toEqual([
      `Inbox/${HARNESS_DATE_PREFIX}Video 1.md`,
      `Inbox/${HARNESS_DATE_PREFIX}Video 2.md`,
    ]);
  });

  it("the same URL submitted twice produces TWO notes: the second lands on the next free path", async () => {
    // THE HEADLINE OF #10. Retrieval is atomic and the human is the loop: a
    // second run of a URL is a second request, not a duplicate to refuse. The
    // runner used to probe the target and block the job on `note-collision`
    // before it spent anything; now nothing probes, and `createNote` steps to
    // the free neighbour Obsidian's own UI would have picked.
    const h = harness();
    await h.runner.submit(submitInput("twice"));
    await settle();
    await h.runner.submit(submitInput("twice"));
    await settle();

    const suffixed = `Inbox/${HARNESS_DATE_PREFIX}Video 1.md`;
    expect(h.store.list().map((record) => record.notePath)).toEqual([TARGET_PATH, suffixed]);
    expect(h.store.list().map((record) => record.status)).toEqual(["done", "done"]);
    expect(h.vault.created).toEqual([TARGET_PATH, suffixed]);
    // Two separate summaries: the second run is a real run, not an adoption.
    expect(h.host.summarizeCalls).toBe(2);
    expect(h.events.filter((e) => e.type === "interrupted")).toEqual([]);
  });

  it("an NFD Hangul target is probed, created and reported at the SAME NFC path", async () => {
    const vault = new ObsidianLikeVault();
    const target = `Inbox/${HARNESS_DATE_PREFIX}${sanitizeFilename(HANGUL_TITLE)}.md`.normalize("NFC");
    vault.files.set(target, "the first run");
    const suffixed = await stages(vault).createNote(target.normalize("NFD"), "the second run");
    // The vault indexes NFC and its lookup is exact, so the reported path has
    // to be the key the note actually landed under (#3 final review C1).
    expect(suffixed).toBe(suffixed.normalize("NFC"));
    expect(vault.created).toEqual([suffixed]);
    expect(vault.getFile(suffixed)).not.toBeNull();
  });
});
