import { sanitizeFilename } from "../utils/filename-sanitizer";

// Pure data + pure helpers for a single-video note job. No Obsidian, no I/O,
// no clock reads except to interpret a `now`/`createdAt` epoch a caller
// already captured. Nothing here is persisted (#10): a record lives in memory
// for the length of its run and dies with the process that made it.

export type JobStage =
  | "transcript" // fetch transcript + title
  | "summary" // paid LLM call + template + vault.create, ONE stage until the note exists; summary text never leaves memory
  | "note-creating" // vault.create in progress
  | "note-created" // note exists at record.notePath
  | "timestamps" // paid LLM call(s) + one guarded vault.process
  | "translation" // paid LLM call + one guarded vault.process; entered ONLY when `translation` is frozen on the record
  | "done";

export type JobStatus = "running" | "interrupted" | "failed" | "cancelled" | "done";

export interface NoteJobRecord {
  version: 1;
  id: string; // opaque, generated once by the caller
  kind: "single";
  url: string;
  videoId: string;
  folder: string; // vault-relative, already normalized by the caller ("" = root)
  customTitle: string; // "" when none
  useFastSummary: boolean;
  addTimestampLinks?: boolean; // frozen at submit like useFastSummary; ABSENT (records older than this field) means true
  createdAt: number; // ms epoch; SOLE source of the date prefix
  generation: number; // monotonic run token; bumped on every (re)start (F2)
  resolvedTitle?: string; // frozen after the transcript stage
  /** Frozen with the target path (F1/F4): live settings toggled later must not move the note. Absent = older record. */
  notePathSettings?: NotePathSettings;
  /** Frozen after the transcript stage = deriveNotePath at that moment (F1/F4), NORMALIZED (Obsidian's index is NFC). */
  targetNotePath?: string;
  /**
   * Frozen at the job's first transcript stage from the live translate settings, ONLY when they differ
   * from en/US (the legacy `needsTranslation` test). Absent = no translation stage for this job — a
   * setting toggled later never adds or removes the paid translation call of a job already under way.
   */
  translation?: TranslationSettings;
  stage: JobStage;
  status: JobStatus;
  inFlight: boolean;
  inFlightSince?: number;
  deadlineAt?: number; // wall-clock deadline of the in-flight call (F2)
  notePath?: string; // set AFTER vault.create succeeded, to the path it actually landed on
  updatedAt: number;
  lastError?: string; // message only
}

export interface NotePathSettings {
  prependDate: boolean;
  dateFormat: string;
}

/** The target of the translation pass, as the legacy settings name it (`translateLanguage` / `translateCountry`). */
export interface TranslationSettings {
  language: string;
  country: string;
}

export function createJobRecord(input: {
  id: string;
  url: string;
  videoId: string;
  folder: string;
  customTitle: string;
  useFastSummary: boolean;
  addTimestampLinks?: boolean;
  now: number;
}): NoteJobRecord {
  return {
    version: 1,
    id: input.id,
    kind: "single",
    url: input.url,
    videoId: input.videoId,
    folder: input.folder,
    customTitle: input.customTitle,
    useFastSummary: input.useFastSummary,
    // Written only when the caller supplies it, so the documented default
    // key set is unchanged and an absent field keeps meaning "true".
    ...(input.addTimestampLinks !== undefined ? { addTimestampLinks: input.addTimestampLinks } : {}),
    createdAt: input.now,
    generation: 1,
    stage: "transcript",
    status: "running",
    inFlight: false,
    updatedAt: input.now,
  };
}

// The legacy `needsTranslation` test from main.ts's addSectionLinksToNote,
// verbatim (case-sensitive, en/US is the only "no translation" pair); absent
// settings are the defaults. Returns the pair to freeze, or undefined.
export function translationSettingsFrom(settings: {
  translateLanguage?: string;
  translateCountry?: string;
}): TranslationSettings | undefined {
  const language = settings.translateLanguage ?? "en";
  const country = settings.translateCountry ?? "US";
  if (language === "en" && country === "US") {
    return undefined;
  }
  return { language, country };
}

export function formatDatePrefix(createdAt: number, settings: NotePathSettings): string {
  if (!settings.prependDate) {
    return "";
  }
  // Interpreting a passed-in epoch, not reading the clock — mirrors the
  // existing switch in main.ts (search "Format date based on the selected format").
  const date = new Date(createdAt);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  switch (settings.dateFormat) {
    case "MM-DD-YYYY":
      return `${mm}-${dd}-${yyyy} `;
    case "DD-MM-YYYY":
      return `${dd}-${mm}-${yyyy} `;
    case "YYYY-MM-DD":
    default:
      return `${yyyy}-${mm}-${dd} `;
  }
}

// Trimmed: the runner freezes `resolvedTitle` from `customTitle.trim()` and
// renders with it, and sanitizeFilename maps a leading space to a leading
// hyphen — the frozen target path and the rendered path must agree.
export function effectiveTitle(record: NoteJobRecord): string | undefined {
  const custom = record.customTitle.trim();
  if (custom !== "") {
    return custom;
  }
  return record.resolvedTitle;
}

/** The host's path normalizer (main.ts injects Obsidian's `normalizePath`: NFC, NBSP→space, slash cleanup). */
export type PathNormalizer = (path: string) => string;

// The ONE derivation of a job's note path. `normalize` is applied to the
// whole path because sanitizeFilename leaves some scripts in NFD (Hangul's
// conjoining Jamo survive its diacritic strip) while Obsidian creates and
// indexes files under NFC: a path stored un-normalized is created at one key
// and looked up at another (#3 final review C1).
export function deriveNotePath(
  record: NoteJobRecord,
  settings: NotePathSettings,
  normalize: PathNormalizer,
): string | undefined {
  const title = effectiveTitle(record);
  if (title === undefined) {
    return undefined;
  }
  const folderPrefix = record.folder ? `${record.folder}/` : "";
  const datePrefix = formatDatePrefix(record.createdAt, settings);
  return normalize(`${folderPrefix}${datePrefix}${sanitizeFilename(title)}.md`);
}

export const FORBIDDEN_RECORD_KEYS: readonly string[] = [
  "apikey",
  "apikeys",
  "authorization",
  "token",
  "secret",
  "transcript",
  "summary",
  "prompt",
  "systemprompt",
  "userprompt",
];

// Exemptions for schema-declared fields whose NAMES collide with
// FORBIDDEN_RECORD_KEYS but whose values are an enum, never content. Matched
// by exact dotted path from the record root, so an exemption never covers a
// whole container.
//
// EMPTY, and nothing on the record needs it today: every exemption it ever
// held belonged to a field that has since been deleted — the per-stage retry
// ledger ("attempts.transcript", "attempts.summary"), then the transcript
// billing risk ("billing.transcript"). The list stays because it is how a
// future colliding field would be declared; while it is empty every forbidden
// key throws, wherever it appears.
export const ALLOWED_RECORD_PATHS: readonly string[] = [];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Object.getPrototypeOf's lib typing is (o: any) => any; pin the result's
  // type explicitly so this stays an unsafe-assignment-free comparison.
  const proto: object | null = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

const forbiddenKeySet = new Set(FORBIDDEN_RECORD_KEYS);
const allowedPathSet = new Set(ALLOWED_RECORD_PATHS);

function walkForForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForForbiddenKeys(item, path ? `${path}.${index}` : String(index)));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (forbiddenKeySet.has(key.toLowerCase()) && !allowedPathSet.has(keyPath)) {
      throw new Error(`Job record contains forbidden key at "${keyPath}" — job records are metadata only`);
    }
    walkForForbiddenKeys(value[key], keyPath);
  }
}

export function assertRecordIsMetadataOnly(record: unknown): void {
  walkForForbiddenKeys(record, "");
}
