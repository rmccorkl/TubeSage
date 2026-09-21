import { sanitizeFilename } from "../utils/filename-sanitizer";

// Pure data + pure helpers for a single-video note job. No Obsidian, no I/O,
// no clock reads except to interpret a `now`/`createdAt` epoch a caller
// already captured. Task 3 persists this shape; Task 4 enforces the claim
// protocol described at the bottom of job-planner.ts.

export type JobStage =
  | "transcript" // fetch transcript + title; billing risk configured (ScrapeCreators/Supadata keys => paid)
  | "summary" // paid LLM call + template + vault.create, ONE stage until the note is durable; summary text is NEVER persisted
  | "note-creating" // claim persisted (path + content fingerprint), vault.create in progress
  | "note-created" // note exists at record.notePath (durable checkpoint)
  | "timestamps" // paid LLM call(s) + one guarded vault.process
  | "translation" // paid LLM call + one guarded vault.process; entered ONLY when `translation` is frozen on the record
  | "done";

export type JobStatus = "running" | "interrupted" | "failed" | "cancelled" | "done";
export type BillingRisk = "free" | "paid" | "unknown";
/** `app-closed`: the Obsidian instance that ran the job is gone; the job died with it (terminal, never resumed). `app-restart` is kept only to type records written before that rule. */
export type InterruptionReason = "timeout" | "network" | "app-restart" | "app-closed" | "cancelled" | "unknown";
/**
 * Runner-level reasons a job stopped short of (or, for path-drift, right after) a paid call; the pure
 * planner cannot know them, so they ride on the record. `path-drift`: the path derived from the frozen
 * record no longer matches `targetNotePath` (a config/code condition, resumable at summary, never terminal).
 */
export type BlockedReason = "note-collision" | "templater-unavailable" | "paid-refetch-required" | "path-drift";

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
  billing: { transcript: BillingRisk }; // summary/timestamps are always paid
  generation: number; // monotonic run token; bumped on every (re)start (F2)
  /**
   * The installation (device + vault, from Obsidian's per-vault localStorage) that created this job. A
   * job lives and dies with that instance: cold start closes only this installation's non-terminal
   * records; a record owned by another installation is ignored (may be live on that device). A record
   * with no id (older than this field) can never be matched to an owner and is removed on cold start
   * instead (#3 batch G item 1), a one-time cleanup rather than staying invisible forever.
   */
  installationId?: string;
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
  claimedNotePath?: string; // persisted BEFORE vault.create
  claimedAt?: number;
  claimedContentHash?: string; // fnv1a64 hex of the exact bytes about to be written (F1/F4)
  claimedContentLength?: number;
  notePath?: string; // persisted AFTER vault.create succeeded
  attempts: { transcript: number; summary: number; timestamps: number; translation: number }; // one ledger per paid call (F6)
  heartbeatAt: number;
  updatedAt: number;
  interruption?: InterruptionReason;
  blocked?: BlockedReason; // set by the runner when it stopped short of a paid call; cleared on resume
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

export const MAX_STAGE_ATTEMPTS = 3;

export const PAID_STAGES: ReadonlySet<JobStage> = new Set<JobStage>(["summary", "timestamps", "translation"]);

export function createJobRecord(input: {
  id: string;
  url: string;
  videoId: string;
  folder: string;
  customTitle: string;
  useFastSummary: boolean;
  addTimestampLinks?: boolean;
  installationId?: string;
  transcriptBilling: BillingRisk;
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
    ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
    createdAt: input.now,
    billing: { transcript: input.transcriptBilling },
    generation: 1,
    stage: "transcript",
    status: "running",
    inFlight: false,
    attempts: { transcript: 0, summary: 0, timestamps: 0, translation: 0 },
    heartbeatAt: input.now,
    updatedAt: input.now,
  };
}

export function transcriptBillingRisk(settings: {
  scrapcreatorsApiKey?: string;
  supadataApiKey?: string;
}): BillingRisk {
  const hasKey = (key?: string): boolean => typeof key === "string" && key.trim() !== "";
  return hasKey(settings.scrapcreatorsApiKey) || hasKey(settings.supadataApiKey) ? "paid" : "free";
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

export function stageBillingRisk(record: NoteJobRecord, stage: JobStage): BillingRisk {
  switch (stage) {
    case "transcript":
      return record.billing.transcript;
    case "summary":
    case "note-creating":
    case "timestamps":
    case "translation":
      // note-creating's summary text is never persisted, so retrying it means
      // re-running the paid summary call — same risk as "summary" itself.
      return "paid";
    case "note-created":
    case "done":
      return "free";
  }
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

/**
 * Re-normalizes the three stored paths of a record frozen before paths were normalized at the point of
 * writing. Mutates in place; returns whether anything changed. Idempotent for an already-normal record.
 */
export function normalizeRecordPaths(record: NoteJobRecord, normalize: PathNormalizer): boolean {
  let changed = false;
  for (const key of ["targetNotePath", "claimedNotePath", "notePath"] as const) {
    const current = record[key];
    if (current === undefined) {
      continue;
    }
    const normalized = normalize(current);
    if (normalized !== current) {
      record[key] = normalized;
      changed = true;
    }
  }
  return changed;
}

// FNV-1a 64-bit over UTF-16 code units. Deterministic, dependency-free, used
// only as an exact-write fingerprint (never a security hash).
//
// No BigInt (the bundle targets es2018): the 64-bit state is two 32-bit
// halves. The prime is 2^40 + 0x1b3, so hash * prime mod 2^64 is
//   (hash * 0x1b3) + (hash << 40)          (both mod 2^64)
// The small multiply runs over four 16-bit limbs (each product < 2^25, no
// intermediate anywhere near 2^53); the shift only moves the low 24 bits of
// the low half into bits 40..63 of the high half.
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LOW = 0x1b3;

export function fnv1a64Hex(text: string): string {
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (let i = 0; i < text.length; i++) {
    // XOR one UTF-16 code unit (< 2^16) into the low half.
    lo = (lo ^ text.charCodeAt(i)) >>> 0;
    const l0 = lo & 0xffff;
    const l1 = lo >>> 16;
    const l2 = hi & 0xffff;
    const l3 = hi >>> 16;
    const p0 = l0 * FNV_PRIME_LOW;
    const p1 = l1 * FNV_PRIME_LOW + (p0 >>> 16);
    const p2 = l2 * FNV_PRIME_LOW + (p1 >>> 16);
    const p3 = l3 * FNV_PRIME_LOW + (p2 >>> 16); // carry out of bit 63 is discarded (mod 2^64)
    const mulLo = (((p1 & 0xffff) << 16) | (p0 & 0xffff)) >>> 0;
    const mulHi = (((p3 & 0xffff) << 16) | (p2 & 0xffff)) >>> 0;
    // + (lo << 40) mod 2^64 == ((lo & 0xffffff) << 8) added to the high half;
    // the sum is < 2^33, and ToUint32 reduces it mod 2^32.
    hi = (mulHi + (lo & 0xffffff) * 0x100) >>> 0;
    lo = mulLo;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

export function contentMatchesClaim(record: NoteJobRecord, currentContent: string): boolean {
  if (record.claimedContentHash === undefined || record.claimedContentLength === undefined) {
    return false;
  }
  if (currentContent.length !== record.claimedContentLength) {
    return false;
  }
  return fnv1a64Hex(currentContent) === record.claimedContentHash;
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

// Schema-declared fields whose NAMES collide with FORBIDDEN_RECORD_KEYS but
// whose values are an enum (BillingRisk) or a retry counter, never content.
// Matched by exact dotted path from the record root — the allowlist is not
// container-wide, so e.g. "billing.apiKey" still throws.
export const ALLOWED_RECORD_PATHS: readonly string[] = [
  "billing.transcript",
  "attempts.transcript",
  "attempts.summary",
];

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
