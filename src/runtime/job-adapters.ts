import { PathDriftError, PermanentJobError } from "../jobs/job-runner";
import type { JobEvent, JobStages, RunnerDeadlines, RunnerDeps, RunnerVault } from "../jobs/job-runner";
import type { JobStore } from "../jobs/job-store";
import { transcriptBillingRisk, translationSettingsFrom } from "../jobs/job-record";
import type { NoteJobRecord, NotePathSettings, PathNormalizer } from "../jobs/job-record";
import { NoCaptionsError } from "../utils/transcript-errors";
import type { TimestampPassOptions } from "./timestamp-pass-policy";

export type { TimestampPassOptions } from "./timestamp-pass-policy";

// Obsidian adapters for the job runner. No `obsidian` import: everything
// Obsidian-specific (TFile checks, Vault, timers) is injected from main.ts
// through the structural interfaces below, so these adapters get real tests
// with doubles. The plugin class satisfies JobHost as-is; VaultLike is the
// three Vault calls the runner is allowed to make, with the `instanceof
// TFile` check living in main.ts's `getFile`.

/**
 * The marker youtube-transcript.ts embeds as the only segment when every extraction method failed but
 * the video's metadata was recovered — for ANY last error, a network failure during the caption fetch
 * included. The strict extractor call (`strict: true`) never returns it: it rejects with NoCaptionsError
 * or a plain Error instead (#3 final review I2). The mapping below is kept only as a defensive fallback
 * for a host that forgot strict mode; it then has to guess, and a permanent failure is the guess.
 */
export const TRANSCRIPT_FAILED_MARKER = "[TRANSCRIPT EXTRACTION FAILED";

export interface RenderedNote {
  filePath: string;
  content: string;
  folder: string;
}

export interface JobHostSettings extends NotePathSettings {
  scrapcreatorsApiKey?: string;
  supadataApiKey?: string;
  /** The translate target (main.ts settings); absent means the en/US default, i.e. no translation. */
  translateLanguage?: string;
  translateCountry?: string;
}

/** The minimal surface of the plugin the stages need. main.ts passes the plugin itself. */
export interface JobHost {
  readonly settings: JobHostSettings;
  /**
   * Strict: rejects on any failure — nothing folded into the transcript text. A genuine no-captions
   * outcome rejects with NoCaptionsError; a network error, a timeout or a bad URL rejects as-is.
   */
  extractTranscriptStrict(videoUrl: string): Promise<{ transcript: string; metadata: { title?: string } }>;
  canRenderNote(): boolean;
  /** `useFastSummary` is the RECORD's frozen flag (F1/F4); legacy callers omit it and get the live setting. */
  summarizeTranscript(transcript: string, useFastSummary?: boolean): Promise<string>;
  /**
   * `notePathSettings` is the RECORD's frozen date-prefix settings (F1/F4); legacy callers omit it and
   * get the live settings. The returned filePath must go through Obsidian's normalizePath.
   */
  renderNoteContent(
    title: string,
    videoUrl: string,
    transcript: string,
    summary: string,
    folder: string,
    createdAt: number,
    notePathSettings?: NotePathSettings,
  ): Promise<RenderedNote>;
  ensureFolder(folderPath: string): Promise<void>;
  /**
   * Reads the note, calls the LLM, writes through the guarded atomic process; throws NoteChangedError
   * when the note changed. With `{ strict: true }` every other failure throws too (#3 final review I1);
   * without it (legacy callers) failures are shown as a Notice and swallowed.
   */
  addSectionLinksToNote(notePath: string, videoUrl: string, options?: TimestampPassOptions): Promise<void>;
  /**
   * Strict translation pass (the runner's own stage): reads the note, translates it into `language`/`country`
   * (the RECORD's frozen pair, never the live settings), writes through the guarded atomic process. Throws
   * NoteChangedError when the note changed and RETHROWS LLM failures — no Notice, nothing swallowed.
   */
  translateNoteStrict(notePath: string, language: string, country: string): Promise<void>;
}

/** `getFile` returns the file only when the path is a file (main.ts: `instanceof TFile ? f : null`). */
export interface VaultLike<F = { path: string }> {
  getFile(path: string): F | null;
  read(file: F): Promise<string>;
  create(path: string, content: string): Promise<unknown>;
}

export interface RunnerExtras<F = { path: string }> {
  vault: VaultLike<F>;
  /** Obsidian's `normalizePath` (main.ts) — the one normalizer every stored or compared note path goes through. */
  normalizePath: PathNormalizer;
  /** This device+vault's stable id from per-vault localStorage (main.ts); never stored in data.json settings. */
  installationId: () => string;
  deadlines?: Partial<RunnerDeadlines>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  generateId?: () => string;
}

// crypto.randomUUID is missing from some older mobile WebViews; the fallback
// only needs to be unique within one data.json (job ids) or across a user's
// devices (installation ids), not cryptographically strong.
export function generateOpaqueId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isBlank(text: string | undefined): text is undefined | "" {
  return text === undefined || text.trim() === "";
}

function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function createJobStages<F>(host: JobHost, vault: VaultLike<F>, normalizePath: PathNormalizer): JobStages {
  return {
    async fetchTranscript(record: NoteJobRecord): Promise<{ transcript: string; title: string }> {
      // Only genuine no-captions outcomes become permanent: the extractor's
      // NoCaptionsError (strict mode) and a blank transcript. Every other
      // rejection (network, timeout, ...) propagates unchanged so the runner
      // interrupts the job as resumable instead of failing it.
      let transcript: string;
      let metadata: { title?: string };
      try {
        ({ transcript, metadata } = await host.extractTranscriptStrict(record.url));
      } catch (error) {
        if (error instanceof NoCaptionsError) {
          throw new PermanentJobError(error.message);
        }
        throw error;
      }
      if (isBlank(transcript)) {
        throw new PermanentJobError("No transcript is available for this video");
      }
      const markerAt = transcript.indexOf(TRANSCRIPT_FAILED_MARKER);
      if (markerAt !== -1) {
        // Defensive only: the strict extractor never returns the marker (see
        // TRANSCRIPT_FAILED_MARKER). "[TRANSCRIPT EXTRACTION FAILED\: <reason>]"
        // → "<reason>" (metadata only — it is the extractor's reason, not
        // transcript text). The YAML formatter escaped every colon in the
        // text as "\:"; undo that.
        const reason = transcript
          .slice(markerAt + TRANSCRIPT_FAILED_MARKER.length)
          .replace(/^\\?:\s*/, "")
          .replace(/\]\s*$/, "")
          .replace(/\\:/g, ":");
        throw new PermanentJobError(reason);
      }
      const title = isBlank(metadata.title) ? `YouTube Video ${record.videoId}` : metadata.title;
      return { transcript, title };
    },

    canRenderNote(): boolean {
      return host.canRenderNote();
    },

    async summarize(record: NoteJobRecord, transcript: string): Promise<string> {
      // The record's flag, never the live setting: a toggle flipped mid-job
      // must not change what a resumed run produces.
      const summary = await host.summarizeTranscript(transcript, record.useFastSummary);
      if (isBlank(summary)) {
        // Transient by classification: a provider hiccup, bounded by the
        // stage's attempt budget — never permanent.
        throw new Error("Empty summary");
      }
      return summary;
    },

    async renderNote(record, input): Promise<string> {
      // The record's FROZEN date settings, never the live ones (F1/F4).
      const rendered = await host.renderNoteContent(
        input.title,
        record.url,
        input.transcript,
        input.summary,
        record.folder,
        record.createdAt,
        record.notePathSettings,
      );
      // Defence behind the runner's pre-paid drift check: the path was
      // frozen at the transcript stage and the note must land exactly
      // there. Compared normalized on both sides — a normalization-only
      // difference is the same note. Drift is a block, never a failure.
      if (
        record.targetNotePath === undefined ||
        normalizePath(rendered.filePath) !== normalizePath(record.targetNotePath)
      ) {
        throw new PathDriftError(
          `Target path drift: rendered "${rendered.filePath}" but the job owns "${record.targetNotePath ?? "(none)"}"`,
        );
      }
      return rendered.content;
    },

    async createNote(path: string, content: string): Promise<void> {
      const folder = parentFolder(path);
      if (folder !== "") {
        await host.ensureFolder(folder);
      }
      await vault.create(path, content);
    },

    addTimestamps(record: NoteJobRecord, notePath: string): Promise<void> {
      // Strict: the pass rethrows instead of swallowing, so a failed
      // timestamps stage is interrupted (or failed), never "done" (I1). The
      // strict pass never translates: that is the runner's own next stage.
      return host.addSectionLinksToNote(notePath, record.url, { strict: true });
    },

    translateNote(record: NoteJobRecord, notePath: string): Promise<void> {
      // The record's FROZEN target, never the live settings: a translate
      // setting changed mid-job must not change what a resumed run writes.
      const translation = record.translation;
      if (translation === undefined) {
        // Unreachable through the runner (the stage is entered only when
        // frozen); transient by classification, bounded by the stage budget.
        return Promise.reject(new Error("No translation target is frozen on this job"));
      }
      return host.translateNoteStrict(notePath, translation.language, translation.country);
    },
  };
}

export function createRunnerVault<F>(vault: VaultLike<F>): RunnerVault {
  return {
    exists(path: string): Promise<boolean> {
      return Promise.resolve(vault.getFile(path) !== null);
    },
    read(path: string): Promise<string | undefined> {
      const file = vault.getFile(path);
      return file === null ? Promise.resolve(undefined) : vault.read(file);
    },
  };
}

export function createRunnerDeps<F>(
  host: JobHost,
  store: JobStore,
  onEvent: (event: JobEvent) => void,
  extras: RunnerExtras<F>,
): RunnerDeps {
  const deps: RunnerDeps = {
    store,
    stages: createJobStages(host, extras.vault, extras.normalizePath),
    vault: createRunnerVault(extras.vault),
    now: extras.now ?? (() => Date.now()),
    // Lazy: `window` is only touched when the runner arms a timer, so the
    // deps can be built (and tested) outside a browser.
    setTimeout: extras.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms)),
    clearTimeout: extras.clearTimeout ?? ((handle) => window.clearTimeout(handle as number)),
    notePathSettings: () => ({ prependDate: host.settings.prependDate, dateFormat: host.settings.dateFormat }),
    translationSettings: () => translationSettingsFrom(host.settings),
    normalizePath: extras.normalizePath,
    installationId: extras.installationId,
    transcriptBilling: () => transcriptBillingRisk(host.settings),
    generateId: extras.generateId ?? generateOpaqueId,
    onEvent,
  };
  if (extras.deadlines !== undefined) {
    deps.deadlines = extras.deadlines;
  }
  return deps;
}
