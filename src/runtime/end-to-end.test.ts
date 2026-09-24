import { describe, expect, it } from "vitest";
import { JobRunner, NoteChangedError, PathDriftError, PermanentJobError } from "../jobs/job-runner";
import type { JobEvent, RecoveryPrompt } from "../jobs/job-runner";
import { JOBS_KEY, JobStore, hydrate } from "../jobs/job-store";
import { createJobRecord, formatDatePrefix } from "../jobs/job-record";
import type { NoteJobRecord, NotePathSettings } from "../jobs/job-record";
import { createRunnerDeps } from "./job-adapters";
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

const INSTALLATION = "install-e2e";

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
  /** Optional per-url title, for runs where every item must land on its own path. */
  titleFor: ((url: string) => string) | undefined = undefined;
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

  /**
   * The real adapter passes `record.url` here, so a test can give each video
   * its own title — which a collection needs, since otherwise every child
   * derives the SAME note path and all but the first block on note-collision.
   */
  extractTranscriptStrict(url?: string): Promise<{ transcript: string; metadata: { title?: string } }> {
    if (this.extractError !== null) {
      return Promise.reject(this.extractError);
    }
    const title = url !== undefined && this.titleFor !== undefined ? this.titleFor(url) : this.title;
    return Promise.resolve({ transcript: "[00:00:01] hello", metadata: { title } });
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
  /** Every payload the store handed to saveData (what data.json would hold). */
  writes: unknown[];
}

function harness(options: { records?: NoteJobRecord[]; files?: Record<string, string>; onEvent?: (event: JobEvent) => void } = {}): Harness {
  const vault = new ObsidianLikeVault();
  for (const [path, content] of Object.entries(options.files ?? {})) {
    vault.files.set(path, content);
  }
  const host = new MainLikeHost(vault);
  const writes: unknown[] = [];
  const store = new JobStore(
    {
      loadData: () => Promise.resolve(undefined),
      saveData: (data) => {
        writes.push(JSON.parse(JSON.stringify(data)));
        return Promise.resolve();
      },
    },
    () => ({}),
  );
  if (options.records !== undefined) {
    // Through hydrate, exactly as main.ts loads data.json.
    store.load(hydrate({ [JOBS_KEY]: options.records }).jobs);
  }
  const events: JobEvent[] = [];
  // Inert timers: no stage here ever times out and no heartbeat needs to
  // fire, so nothing is left armed after a test (no globals, no cleanup).
  const deps = createRunnerDeps(host, store, (event) => {
    events.push(event);
    // Lets a test observe events as the runner emits them, which is how the
    // host wires a collection to the runner.
    options.onEvent?.(event);
  }, {
    vault,
    normalizePath: obsidianNormalizePath,
    installationId: () => INSTALLATION,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => HARNESS_NOW,
  });
  const runner = new JobRunner(deps);
  return { vault, host, store, events, runner, writes };
}

const HANGUL_TITLE = "안녕하세요 튜토리얼";

function submitInput(videoId: string) {
  return { url: `https://youtu.be/${videoId}`, videoId, folder: "Inbox", customTitle: "", useFastSummary: false, addTimestampLinks: true };
}

function askUser(prompt: RecoveryPrompt | undefined): Extract<RecoveryPrompt, { action: "ask-user" }> {
  if (prompt === undefined || prompt.action !== "ask-user") {
    throw new Error(`expected an ask-user prompt, got ${JSON.stringify(prompt)}`);
  }
  return prompt;
}

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
    expect(record.claimedNotePath).toBe(expected);
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

  it("P2b a genuine drift (target corrupted after the freeze) blocks with path-drift BEFORE any paid call", async () => {
    const h = harness();
    // Stop at the summary stage without paying: the template engine is
    // unavailable on the first pass, so the target is frozen and the job is
    // blocked with zero summary calls.
    h.host.templaterAvailable = false;
    const submitted = await h.runner.submit(submitInput("c1"));
    await settle();
    const id = (submitted as { id: string }).id;
    let record = h.store.get(id);
    expect(record?.blocked).toBe("templater-unavailable");
    expect(record?.targetNotePath).toBe(TARGET_PATH);
    // Corrupt the frozen target (what a bug, a hand edit or a sync merge could do).
    record = h.store.get(id);
    if (record === undefined) {
      throw new Error("record missing");
    }
    record.targetNotePath = `Inbox/${HARNESS_DATE_PREFIX}Somewhere-else.md`;
    await h.store.upsert(record, HARNESS_NOW);
    h.host.templaterAvailable = true;
    const resumed = await h.runner.resume(id, { confirmed: false });
    expect(resumed.kind).toBe("resumed");
    await settle();
    record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.blocked).toBe("path-drift");
    expect(h.host.summarizeCalls).toBe(0);
    expect(h.vault.files.size).toBe(0);
    const prompt = await h.runner.promptFor(id);
    expect(askUser(prompt)).toMatchObject({ reason: "path-drift", stage: "summary" });
  });

  it("adapter drift: a rendered path that differs from the target is a PathDriftError (never PermanentJobError) and the runner blocks, not fails", async () => {
    const h = harness();
    h.host.renderPathOverride = `Inbox/${HARNESS_DATE_PREFIX}Elsewhere.md`;
    const submitted = await h.runner.submit(submitInput("r1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.blocked).toBe("path-drift");
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
    expect(h.vault.files.size).toBe(0);
    expect(PathDriftError.prototype).not.toBeInstanceOf(PermanentJobError);
  });

  it("a hand-built interrupted/network fixture with an NFD notePath resumes at note-created (visibility pass) against an NFC index: no note-missing, no drift, paths persisted NFC", async () => {
    // sanitizeFilename now returns NFC itself (#6), so this legacy-record
    // fixture builds its NFD path explicitly rather than relying on the
    // (now-fixed) sanitizer to have produced it.
    const nfdPath = `Inbox/${HARNESS_DATE_PREFIX}${sanitizeFilename(HANGUL_TITLE)}.md`.normalize("NFD");
    const nfcPath = nfdPath.normalize("NFC");
    expect(nfdPath).not.toBe(nfcPath);
    const base = createJobRecord({
      id: "old-1",
      url: "https://youtu.be/old1",
      videoId: "old1",
      folder: "Inbox",
      customTitle: "",
      useFastSummary: false,
      addTimestampLinks: true,
      installationId: INSTALLATION,
      transcriptBilling: "free",
      now: HARNESS_NOW,
    });
    const old: NoteJobRecord = {
      ...base,
      // Frozen before this fix: NFD everywhere, no notePathSettings. Not
      // "app-restart" (#3 batch G item b closes that reason on hydrate): this
      // fixture is exercising the in-process visibility pass, still live.
      status: "interrupted",
      interruption: "network",
      stage: "note-created",
      resolvedTitle: HANGUL_TITLE,
      targetNotePath: nfdPath,
      claimedNotePath: nfdPath,
      notePath: nfdPath,
      attempts: { transcript: 1, summary: 1, timestamps: 0, translation: 0 },
    };
    const h = harness({ records: [old], files: { [nfcPath]: "RENDERED" } });
    const prompt = await h.runner.promptFor("old-1");
    expect(prompt).toEqual({ action: "continue", fromStage: "timestamps" });
    const prompts = await h.runner.recoverAll();
    await settle();
    expect(prompts).toEqual([]);
    const record = h.store.get("old-1");
    expect(record?.status).toBe("done");
    expect(record?.notePath).toBe(nfcPath);
    expect(record?.claimedNotePath).toBe(nfcPath);
    expect(record?.targetNotePath).toBe(nfcPath);
    expect(h.host.summarizeCalls).toBe(0);
    expect(h.host.timestampCalls).toBe(1);
    expect(h.vault.files.size).toBe(1);
  });
});

describe("end-to-end: timestamps-stage failures surface as recoverable on the runner path (#3 final review I1)", () => {
  it("(a) a network Error from the strict timestamp pass → interrupted, in flight, paid-stage-in-flight with finish-without-timestamps, still found by video id, no done event", async () => {
    const h = harness();
    h.host.timestampsError = new Error("Error adding timestamp links: fetch failed");
    const submitted = await h.runner.submit(submitInput("t1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.stage).toBe("timestamps");
    expect(record?.interruption).toBe("network");
    expect(record?.inFlight).toBe(true);
    expect(record?.lastError).toBe("Error adding timestamp links: fetch failed");
    expect(h.vault.files.size).toBe(1);
    expect(h.store.findByVideoId("t1")?.id).toBe(id);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    const interrupted = h.events.find((e) => e.type === "interrupted");
    expect(interrupted).toBeDefined();
    if (interrupted === undefined || interrupted.type !== "interrupted") {
      throw new Error("expected an interrupted event");
    }
    expect(askUser(interrupted.prompt)).toMatchObject({
      reason: "paid-stage-in-flight",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
    });
    expect(askUser(await h.runner.promptFor(id))).toMatchObject({ reason: "paid-stage-in-flight", canFinishWithoutTimestamps: true });
  });

  it("(b) the strict pass is a single billed attempt: the host is called STRICT exactly once per attempt and attempts.timestamps counts it; finishing without timestamps then completes with no further call", async () => {
    const h = harness();
    h.host.timestampsError = new Error("Error adding timestamp links: fetch failed");
    const submitted = await h.runner.submit(submitInput("t2"));
    await settle();
    const id = (submitted as { id: string }).id;
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.timestampOptions).toEqual([{ strict: true }]);
    expect(h.store.get(id)?.attempts.timestamps).toBe(1);
    const resumed = await h.runner.resume(id, { confirmed: true, finishWithoutTimestamps: true });
    expect(resumed.kind).toBe("resumed");
    await settle();
    const record = h.store.get(id);
    expect(record?.status).toBe("done");
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});

describe("end-to-end: extraction failures are classified, never disguised (#3 final review I2)", () => {
  it("(c) a transient extractor rejection → interrupted at transcript, resumable, still found by video id", async () => {
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
    expect(record?.interruption).toBe("network");
    expect(h.store.findByVideoId("x1")?.id).toBe(id);
    expect(h.events.filter((e) => e.type === "failed")).toEqual([]);
    expect(h.host.summarizeCalls).toBe(0);
    // A free transcript stage recovers unattended once the network is back.
    h.host.extractError = null;
    const prompts = await h.runner.recoverAll();
    await settle();
    expect(prompts).toEqual([]);
    expect(h.store.get(id)?.status).toBe("done");
    expect(h.host.summarizeCalls).toBe(1);
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

describe("end-to-end: translation is a checkpointed paid stage — failures surface, resumes never re-bill timestamps (#3 final review residual)", () => {
  function progressStages(events: JobEvent[]): string[] {
    return events.flatMap((e) => (e.type === "progress" ? [e.stage] : []));
  }

  function translating(h: Harness): void {
    h.host.settings = { ...h.host.settings, translateLanguage: "fr", translateCountry: "FR" };
  }

  it("(a) a network Error from the strict translation → interrupted at translation, in flight, paid-stage-in-flight with finish offered, NO done event, the timestamped note on disk", async () => {
    const h = harness();
    translating(h);
    h.host.translateError = new Error("Translation error: fetch failed");
    const submitted = await h.runner.submit(submitInput("tr1"));
    await settle();
    const id = (submitted as { id: string }).id;
    const record = h.store.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.stage).toBe("translation");
    expect(record?.interruption).toBe("network");
    expect(record?.inFlight).toBe(true);
    expect(record?.lastError).toBe("Translation error: fetch failed");
    expect(record?.translation).toEqual({ language: "fr", country: "FR" });
    expect(record?.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 1 });
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.translateCalls).toEqual([[TARGET_PATH, "fr", "FR"]]);
    expect(h.vault.files.get(TARGET_PATH)).toBe("RENDERED\n[Watch]");
    expect(h.store.findByVideoId("tr1")?.id).toBe(id);
    expect(h.events.filter((e) => e.type === "done")).toEqual([]);
    const interrupted = h.events.find((e) => e.type === "interrupted");
    if (interrupted === undefined || interrupted.type !== "interrupted") {
      throw new Error("expected an interrupted event");
    }
    expect(askUser(interrupted.prompt)).toMatchObject({
      reason: "paid-stage-in-flight",
      stage: "translation",
      canFinishWithoutTimestamps: true,
    });
    expect(askUser(await h.runner.promptFor(id))).toMatchObject({ reason: "paid-stage-in-flight", stage: "translation", canFinishWithoutTimestamps: true });
  });

  it("(b) a confirmed resume re-runs ONLY the translation: exactly one more strict translation call, ZERO further timestamp passes, then done", async () => {
    const h = harness();
    translating(h);
    h.host.translateError = new Error("Translation error: fetch failed");
    const submitted = await h.runner.submit(submitInput("tr2"));
    await settle();
    const id = (submitted as { id: string }).id;
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.translateCalls).toHaveLength(1);
    h.host.translateError = null;
    // Live settings changed after the freeze must not leak into the resumed call.
    h.host.settings = { ...h.host.settings, translateLanguage: "de", translateCountry: "DE" };
    const resumed = await h.runner.resume(id, { confirmed: true });
    expect(resumed.kind).toBe("resumed");
    await settle();
    const record = h.store.get(id);
    expect(record?.status).toBe("done");
    expect(record?.stage).toBe("done");
    expect(record?.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 2 });
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.host.translateCalls).toEqual([
      [TARGET_PATH, "fr", "FR"],
      [TARGET_PATH, "fr", "FR"],
    ]);
    expect(h.vault.files.get(TARGET_PATH)).toBe("RENDERED\n[Watch]\n[translated fr-FR]");
    expect(h.events.filter((e) => e.type === "done")).toEqual([{ type: "done", id, notePath: TARGET_PATH }]);
  });

  it("(b′) finishing without translation at the translation stage → done with translationSkipped user-choice, no further call of any kind", async () => {
    const h = harness();
    translating(h);
    h.host.translateError = new Error("Translation error: fetch failed");
    const submitted = await h.runner.submit(submitInput("tr3"));
    await settle();
    const id = (submitted as { id: string }).id;
    const resumed = await h.runner.resume(id, { confirmed: true, finishWithoutTimestamps: true });
    expect(resumed.kind).toBe("resumed");
    await settle();
    expect(h.store.get(id)?.status).toBe("done");
    expect(h.host.timestampCalls).toBe(1);
    expect(h.host.translateCalls).toHaveLength(1);
    expect(h.host.summarizeCalls).toBe(1);
    expect(h.events.filter((e) => e.type === "done")).toEqual([
      { type: "done", id, notePath: TARGET_PATH, translationSkipped: "user-choice" },
    ]);
    expect(h.vault.files.get(TARGET_PATH)).toBe("RENDERED\n[Watch]");
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
    expect(record?.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 0 });
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
    expect(record?.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 0, translation: 0 });
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
    expect(record?.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 0, translation: 0 });
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

  it("(g) a hand-built interrupted/network fixture at a clean translation checkpoint (timestamps written, translation not yet called) resumes at translation only (visibility pass)", async () => {
    const record: NoteJobRecord = {
      ...createJobRecord({
        id: "ckpt-1",
        url: "https://youtu.be/ck1",
        videoId: "ck1",
        folder: "Inbox",
        customTitle: "",
        useFastSummary: false,
        addTimestampLinks: true,
        installationId: INSTALLATION,
        transcriptBilling: "free",
        now: HARNESS_NOW,
      }),
      // Not "app-restart" (#3 batch G item b closes that reason on hydrate):
      // this fixture exercises the in-process visibility pass, still live.
      status: "interrupted",
      interruption: "network",
      stage: "translation",
      inFlight: false,
      resolvedTitle: "Video",
      notePathSettings: { prependDate: true, dateFormat: "YYYY-MM-DD" },
      targetNotePath: TARGET_PATH,
      claimedNotePath: TARGET_PATH,
      notePath: TARGET_PATH,
      translation: { language: "fr", country: "FR" },
      attempts: { transcript: 1, summary: 1, timestamps: 1, translation: 0 },
    };
    const h = harness({ records: [record], files: { [TARGET_PATH]: "RENDERED\n[Watch]" } });
    expect(await h.runner.promptFor("ckpt-1")).toEqual({ action: "continue", fromStage: "translation" });
    const prompts = await h.runner.recoverAll();
    await settle();
    expect(prompts).toEqual([]);
    expect(h.store.get("ckpt-1")?.status).toBe("done");
    expect(h.host.summarizeCalls).toBe(0);
    expect(h.host.timestampCalls).toBe(0);
    expect(h.host.translateCalls).toEqual([[TARGET_PATH, "fr", "FR"]]);
    expect(h.store.get("ckpt-1")?.attempts).toEqual({ transcript: 1, summary: 1, timestamps: 1, translation: 1 });
  });
});

describe("end-to-end: no resume path exists after a cold start (#3 batch E — a job dies with its instance)", () => {
  // Pending = a call that never settles: the process dies with it in flight.
  const pending = <T,>(): Promise<T> => new Promise<T>(() => undefined);

  /** Runs the REAL pipeline up to the named crash window and returns what data.json held at that moment. */
  async function crashWindowSnapshot(window: "summary" | "note-creating" | "timestamps" | "translation"): Promise<unknown> {
    const source = harness();
    if (window === "translation") {
      source.host.settings = { ...source.host.settings, translateLanguage: "fr", translateCountry: "FR" };
    }
    switch (window) {
      case "summary":
        source.host.summarizeTranscript = () => pending();
        break;
      case "note-creating":
        source.vault.create = () => pending();
        break;
      case "timestamps":
        source.host.addSectionLinksToNote = () => pending();
        break;
      case "translation":
        source.host.translateNoteStrict = () => pending();
        break;
    }
    expect((await source.runner.submit(submitInput(`crash-${window}`))).kind).toBe("started");
    await settle();
    const snapshot = source.writes[source.writes.length - 1];
    const record = (snapshot as Record<string, NoteJobRecord[]>)[JOBS_KEY][0];
    expect(record).toMatchObject({ status: "running", inFlight: true, stage: window, installationId: INSTALLATION });
    return snapshot;
  }

  it("every crash-window snapshot is closed on cold start; resume, finish-without-timestamps and the visibility pass then do nothing: zero stage calls, no writes beyond the closing", async () => {
    for (const window of ["summary", "note-creating", "timestamps", "translation"] as const) {
      const snapshot = await crashWindowSnapshot(window);
      const persisted = hydrate(snapshot).jobs;
      // The note is on disk for the windows past note creation (and, for
      // window B, may have landed even though the record never learned it).
      const files = window === "summary" ? {} : { [TARGET_PATH]: "RENDERED" };
      const h = harness({ records: persisted, files });
      const id = persisted[0].id;

      expect(await h.runner.recoverAll({ coldStart: true }), window).toEqual([]);
      await settle();
      const closed = h.store.get(id);
      expect(closed, window).toMatchObject({ status: "failed", interruption: "app-closed", inFlight: false, stage: window, generation: 1 });
      expect(closed?.notePath, window).toBe(persisted[0].notePath);
      expect(closed?.claimedNotePath, window).toBe(persisted[0].claimedNotePath);
      expect(closed?.attempts, window).toEqual(persisted[0].attempts);
      expect(h.writes, window).toHaveLength(1);
      expect(h.runner.drainClosedOnColdStart().map((c) => c.record.id), window).toEqual([id]);

      // No resume path: confirmed, finish-without, the visibility pass, the read-only prompt.
      const terminal = { kind: "prompt", prompt: { action: "nothing", why: "terminal" } };
      expect(await h.runner.resume(id, { confirmed: true }), window).toEqual(terminal);
      expect(await h.runner.resume(id, { confirmed: true, finishWithoutTimestamps: true }), window).toEqual(terminal);
      expect(await h.runner.recoverAll(), window).toEqual([]);
      expect(await h.runner.promptFor(id), window).toEqual({ action: "nothing", why: "terminal" });
      await settle();
      expect(h.runner.isActive(id), window).toBe(false);
      expect(h.host.summarizeCalls + h.host.timestampCalls + h.host.translateCalls.length, window).toBe(0);
      expect(h.vault.created, window).toEqual([]);
      expect(h.vault.files.size, window).toBe(Object.keys(files).length);
      expect(h.writes, window).toHaveLength(1);
      expect(h.events, window).toEqual([]);
      // The closed job no longer claims its video: a fresh submit is a new job.
      expect(h.store.findByVideoId(`crash-${window}`), window).toBeUndefined();
    }
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
    // Distinct titles: three videos must land on three paths. With one shared
    // title they would collide, which is a real scenario in its own right (see
    // the duplicate-title note in the report) but not what this test proves.
    h.host.titleFor = (url) => `Video ${url.slice(-1)}`;
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
      installationId: () => INSTALLATION,
      submitChild: async (video) => {
        const result = await h.runner.submit({
          url: video.url, videoId: video.videoId, folder: "Inbox",
          customTitle: "", useFastSummary: false, addTimestampLinks: true,
        });
        if (result.kind === "started" || result.kind === "already-running") return result.id;
        if (result.kind === "recovery") return result.record.id;
        return undefined;
      },
      cancelChild: (id) => h.runner.cancel(id),
      isActive: (id) => h.runner.isActive(id),
      getChild: (id) => h.store.get(id),
      saveCollection: (record) => h.store.upsertCollection(record, HARNESS_NOW),
      listCollections: () => h.store.listCollections(),
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

