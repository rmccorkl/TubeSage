import { describe, expect, it, vi } from "vitest";
import { sanitizeFilename } from "../utils/filename-sanitizer";
import {
  ALLOWED_RECORD_PATHS,
  FORBIDDEN_RECORD_KEYS,
  assertRecordIsMetadataOnly,
  createJobRecord,
  deriveNotePath,
  effectiveTitle,
  formatDatePrefix,
  translationSettingsFrom,
  type NoteJobRecord,
} from "./job-record";

// Fixed "now" used across tests that don't care about a specific instant.
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

// Identity stand-in for the injected normalizer where normalization is not under test.
const identity = (path: string): string => path;

function baseInput(overrides: Partial<Parameters<typeof createJobRecord>[0]> = {}) {
  return {
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "",
    customTitle: "",
    useFastSummary: false,
    now: NOW,
    ...overrides,
  };
}

describe("createJobRecord", () => {
  it("produces exactly the documented defaults for a fresh job", () => {
    const record = createJobRecord(baseInput());
    expect(record).toStrictEqual({
      version: 1,
      id: "job-1",
      kind: "single",
      url: "https://youtu.be/abc123",
      videoId: "abc123",
      folder: "",
      customTitle: "",
      useFastSummary: false,
      createdAt: NOW,
      generation: 1,
      stage: "transcript",
      status: "running",
      inFlight: false,
      updatedAt: NOW,
    });
  });

  it("sets no optional fields (key set is exactly the required contract fields)", () => {
    const record = createJobRecord(baseInput());
    expect(Object.keys(record).sort()).toEqual(
      [
        "createdAt",
        "customTitle",
        "folder",
        "generation",
        "id",
        "inFlight",
        "kind",
        "stage",
        "status",
        "updatedAt",
        "url",
        "useFastSummary",
        "version",
        "videoId",
      ].sort(),
    );
  });
});

describe("formatDatePrefix", () => {
  // Local time, per the contract: new Date(2026, 8, 20, 23, 59) is Sep 20 2026 23:59 local.
  const createdAt = new Date(2026, 8, 20, 23, 59).getTime();

  it("formats YYYY-MM-DD with a trailing space", () => {
    expect(formatDatePrefix(createdAt, { prependDate: true, dateFormat: "YYYY-MM-DD" })).toBe(
      "2026-09-20 ",
    );
  });

  it("formats MM-DD-YYYY with a trailing space", () => {
    expect(formatDatePrefix(createdAt, { prependDate: true, dateFormat: "MM-DD-YYYY" })).toBe(
      "09-20-2026 ",
    );
  });

  it("formats DD-MM-YYYY with a trailing space", () => {
    expect(formatDatePrefix(createdAt, { prependDate: true, dateFormat: "DD-MM-YYYY" })).toBe(
      "20-09-2026 ",
    );
  });

  it("returns empty string when prependDate is false, regardless of dateFormat", () => {
    expect(formatDatePrefix(createdAt, { prependDate: false, dateFormat: "MM-DD-YYYY" })).toBe("");
  });

  it("falls back to YYYY-MM-DD for an unrecognized dateFormat", () => {
    expect(formatDatePrefix(createdAt, { prependDate: true, dateFormat: "bogus" })).toBe(
      "2026-09-20 ",
    );
  });
});

describe("effectiveTitle", () => {
  it("uses customTitle when non-empty", () => {
    const record = createJobRecord(baseInput({ customTitle: "My Title" }));
    expect(effectiveTitle(record)).toBe("My Title");
  });

  it("falls back to resolvedTitle when customTitle is empty", () => {
    const record = createJobRecord(baseInput({ customTitle: "" }));
    record.resolvedTitle = "Resolved Title";
    expect(effectiveTitle(record)).toBe("Resolved Title");
  });

  it("trims a padded customTitle — the same title the runner renders with, so the frozen target path cannot drift", () => {
    const record = createJobRecord(baseInput({ customTitle: " My Title " }));
    expect(effectiveTitle(record)).toBe("My Title");
    // sanitizeFilename turns a leading space into a leading hyphen, so an
    // untrimmed title here would freeze "-My-Title.md" while the note is
    // rendered as "My-Title.md".
    expect(deriveNotePath(record, { prependDate: false, dateFormat: "YYYY-MM-DD" }, identity)).toBe("My-Title.md");
  });

  it("falls back to resolvedTitle when customTitle is whitespace-only", () => {
    const record = createJobRecord(baseInput({ customTitle: "   " }));
    record.resolvedTitle = "Resolved Title";
    expect(effectiveTitle(record)).toBe("Resolved Title");
  });

  it("is undefined when neither customTitle nor resolvedTitle is set", () => {
    const record = createJobRecord(baseInput({ customTitle: "" }));
    expect(effectiveTitle(record)).toBeUndefined();
  });
});

describe("deriveNotePath — midnight / clock-independence", () => {
  it("is identical on repeated calls for the same createdAt (23:59:30 local)", () => {
    const createdAt = new Date(2026, 8, 20, 23, 59, 30).getTime();
    const record = createJobRecord(baseInput({ customTitle: "Video Title", now: createdAt }));
    const settings = { prependDate: true, dateFormat: "YYYY-MM-DD" };
    const first = deriveNotePath(record, settings, identity);
    const second = deriveNotePath(record, settings, identity);
    expect(first).toBe(second);
  });

  it("produces a different date prefix for a record created 40 seconds later, across midnight", () => {
    const beforeMidnight = new Date(2026, 8, 20, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 8, 21, 0, 0, 10).getTime();
    const settings = { prependDate: true, dateFormat: "YYYY-MM-DD" };
    const recordBefore = createJobRecord(baseInput({ customTitle: "Video Title", now: beforeMidnight }));
    const recordAfter = createJobRecord(baseInput({ customTitle: "Video Title", now: afterMidnight }));
    expect(deriveNotePath(recordBefore, settings, identity)).not.toBe(deriveNotePath(recordAfter, settings, identity));
  });

  it("never reads the clock — result is unaffected by fake-timer advance", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 20, 23, 59, 30));
      const createdAt = Date.now();
      const record = createJobRecord(baseInput({ customTitle: "Video Title", now: createdAt }));
      const settings = { prependDate: true, dateFormat: "YYYY-MM-DD" };
      const before = deriveNotePath(record, settings, identity);
      vi.advanceTimersByTime(48 * 60 * 60 * 1000);
      const after = deriveNotePath(record, settings, identity);
      expect(before).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deriveNotePath", () => {
  const settings = { prependDate: false, dateFormat: "YYYY-MM-DD" };

  it("has no leading slash when folder is empty", () => {
    const record = createJobRecord(baseInput({ folder: "", customTitle: "Title" }));
    const path = deriveNotePath(record, settings, identity);
    expect(path).toBe("Title.md");
  });

  it("nests under folder when folder is set", () => {
    const record = createJobRecord(baseInput({ folder: "Notes/YT", customTitle: "Title" }));
    const path = deriveNotePath(record, settings, identity);
    expect(path).toBe("Notes/YT/Title.md");
  });

  it("prefers customTitle over resolvedTitle", () => {
    const record = createJobRecord(baseInput({ customTitle: "Custom" }));
    record.resolvedTitle = "Resolved";
    expect(deriveNotePath(record, settings, identity)).toBe("Custom.md");
  });

  it("falls back to resolvedTitle when customTitle is whitespace-only", () => {
    const record = createJobRecord(baseInput({ customTitle: "   " }));
    record.resolvedTitle = "Resolved";
    expect(deriveNotePath(record, settings, identity)).toBe("Resolved.md");
  });

  it("is undefined when there is no title at all", () => {
    const record = createJobRecord(baseInput({ customTitle: "" }));
    expect(deriveNotePath(record, settings, identity)).toBeUndefined();
  });

  it("sanitizes the title identically to a direct sanitizeFilename call", () => {
    const title = "Weird: Title 😀";
    const record = createJobRecord(baseInput({ customTitle: title }));
    expect(deriveNotePath(record, settings, identity)).toBe(`${sanitizeFilename(title)}.md`);
  });
});

describe("assertRecordIsMetadataOnly", () => {
  it("does not throw for a valid record from createJobRecord", () => {
    const record = createJobRecord(baseInput());
    expect(() => assertRecordIsMetadataOnly(record)).not.toThrow();
  });

  it("throws naming the dotted path for a top-level apiKey", () => {
    // Anchored on the quoted path segment so this can't pass on a wrong path
    // that merely contains the substring "apiKey" somewhere in the message.
    expect(() => assertRecordIsMetadataOnly({ apiKey: "sk-live-123" })).toThrow(/"apiKey"/);
  });

  it("throws naming the dotted path for a nested Authorization key", () => {
    expect(() => assertRecordIsMetadataOnly({ x: { Authorization: "" } })).toThrow(/"x\.Authorization"/);
  });

  it("throws naming the dotted path for a top-level transcript key", () => {
    expect(() => assertRecordIsMetadataOnly({ transcript: "full text" })).toThrow(/"transcript"/);
  });

  it("throws naming the dotted path for a top-level summary key", () => {
    expect(() => assertRecordIsMetadataOnly({ summary: "full text" })).toThrow(/"summary"/);
  });

  it("throws naming the dotted path for a forbidden key inside an array element", () => {
    expect(() => assertRecordIsMetadataOnly({ items: [{ token: 1 }] })).toThrow(/"items\.0\.token"/);
  });

  it("throws naming the dotted path for a forbidden key nested in plain objects", () => {
    expect(() => assertRecordIsMetadataOnly({ outer: { inner: { apiKey: "x" } } })).toThrow(
      /"outer\.inner\.apiKey"/,
    );
  });
});

describe("FORBIDDEN_RECORD_KEYS / ALLOWED_RECORD_PATHS", () => {
  it("forbidden keys are the documented list", () => {
    expect([...FORBIDDEN_RECORD_KEYS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it("allowed paths are the documented list", () => {
    expect([...ALLOWED_RECORD_PATHS]).toEqual([]);
  });
});

// Type-only assertion: NoteJobRecord's optional fields are absent by default,
// so this compiles without needing `!` assertions anywhere above.
const _typeCheck: NoteJobRecord = createJobRecord(baseInput());
void _typeCheck;

describe("deriveNotePath — injected normalizer (#3 final review C1)", () => {
  const settings = { prependDate: false, dateFormat: "YYYY-MM-DD" };
  const nfc = (path: string): string => path.normalize("NFC");

  it("applies the injected normalizer to the whole derived path (a Hangul title is already NFC after sanitizeFilename (#6), so both normalizers agree)", () => {
    const title = "안녕하세요 튜토리얼";
    const record = createJobRecord(baseInput({ folder: "Inbox", customTitle: title }));
    const raw = `Inbox/${sanitizeFilename(title)}.md`;
    expect(raw).toBe(raw.normalize("NFC"));
    expect(deriveNotePath(record, settings, identity)).toBe(raw);
    expect(deriveNotePath(record, settings, nfc)).toBe(raw.normalize("NFC"));
  });

  it("the normalizer sees folder, date prefix and file name together (one point of truth)", () => {
    const seen: string[] = [];
    const record = createJobRecord(baseInput({ folder: "Notes", customTitle: "Title" }));
    deriveNotePath(record, { prependDate: true, dateFormat: "YYYY-MM-DD" }, (path) => {
      seen.push(path);
      return path;
    });
    expect(seen).toEqual(["Notes/2026-09-20 Title.md"]);
  });
});

describe("translation stage (#3 final review residual: translation is a checkpointed paid stage)", () => {
  it("translationSettingsFrom mirrors the legacy needsTranslation test: en/US (or absent) is none, anything else is frozen verbatim", () => {
    expect(translationSettingsFrom({ translateLanguage: "en", translateCountry: "US" })).toBeUndefined();
    expect(translationSettingsFrom({})).toBeUndefined();
    expect(translationSettingsFrom({ translateLanguage: "fr", translateCountry: "FR" })).toEqual({ language: "fr", country: "FR" });
    expect(translationSettingsFrom({ translateLanguage: "en", translateCountry: "GB" })).toEqual({ language: "en", country: "GB" });
    expect(translationSettingsFrom({ translateLanguage: "de" })).toEqual({ language: "de", country: "US" });
  });

  it("a frozen translation field is metadata (no forbidden key involved)", () => {
    const record: NoteJobRecord = { ...createJobRecord(baseInput()), translation: { language: "fr", country: "FR" } };
    expect(() => assertRecordIsMetadataOnly(record)).not.toThrow();
    expect(FORBIDDEN_RECORD_KEYS).not.toContain("translation");
    expect(FORBIDDEN_RECORD_KEYS).not.toContain("language");
    expect(FORBIDDEN_RECORD_KEYS).not.toContain("country");
  });
});
