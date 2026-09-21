import { describe, expect, it, vi } from "vitest";
import { sanitizeFilename } from "../utils/filename-sanitizer";
import {
  ALLOWED_RECORD_PATHS,
  FORBIDDEN_RECORD_KEYS,
  assertRecordIsMetadataOnly,
  contentMatchesClaim,
  createJobRecord,
  deriveNotePath,
  normalizeRecordPaths,
  PAID_STAGES,
  effectiveTitle,
  fnv1a64Hex,
  formatDatePrefix,
  stageBillingRisk,
  transcriptBillingRisk,
  translationSettingsFrom,
  type BillingRisk,
  type JobStage,
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
    transcriptBilling: "free" as const,
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
      billing: { transcript: "free" },
      generation: 1,
      stage: "transcript",
      status: "running",
      inFlight: false,
      attempts: { transcript: 0, summary: 0, timestamps: 0, translation: 0 },
      heartbeatAt: NOW,
      updatedAt: NOW,
    });
  });

  it("sets no optional fields (key set is exactly the required contract fields)", () => {
    const record = createJobRecord(baseInput());
    expect(Object.keys(record).sort()).toEqual(
      [
        "attempts",
        "billing",
        "createdAt",
        "customTitle",
        "folder",
        "generation",
        "heartbeatAt",
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

  it("carries the paid transcript billing risk through when provided", () => {
    const record = createJobRecord(baseInput({ transcriptBilling: "paid" }));
    expect(record.billing).toEqual({ transcript: "paid" });
  });
});

describe("transcriptBillingRisk", () => {
  it("is free when neither key is set", () => {
    expect(transcriptBillingRisk({})).toBe("free");
  });

  it("is paid when only scrapcreatorsApiKey is set", () => {
    expect(transcriptBillingRisk({ scrapcreatorsApiKey: "sk-123" })).toBe("paid");
  });

  it("is paid when only supadataApiKey is set", () => {
    expect(transcriptBillingRisk({ supadataApiKey: "sd-123" })).toBe("paid");
  });

  it("is free when both keys are whitespace-only", () => {
    expect(
      transcriptBillingRisk({ scrapcreatorsApiKey: "   ", supadataApiKey: "\t\n" }),
    ).toBe("free");
  });
});

describe("stageBillingRisk", () => {
  // Explicit expected values (not re-derived from the implementation's own
  // switch) so a wrong branch in stageBillingRisk actually fails a test.
  const casesWithFreeTranscript: Array<[JobStage, BillingRisk]> = [
    ["transcript", "free"],
    ["summary", "paid"],
    ["note-creating", "paid"],
    ["note-created", "free"],
    ["timestamps", "paid"],
    ["translation", "paid"],
    ["done", "free"],
  ];

  const casesWithPaidTranscript: Array<[JobStage, BillingRisk]> = [
    ["transcript", "paid"],
    ["summary", "paid"],
    ["note-creating", "paid"],
    ["note-created", "free"],
    ["timestamps", "paid"],
    ["translation", "paid"],
    ["done", "free"],
  ];

  it.each(casesWithFreeTranscript)(
    "reports %s as %s risk when transcript billing is free",
    (stage, expected) => {
      const record = createJobRecord(baseInput({ transcriptBilling: "free" }));
      expect(stageBillingRisk(record, stage)).toBe(expected);
    },
  );

  it.each(casesWithPaidTranscript)(
    "reports %s as %s risk when transcript billing is paid",
    (stage, expected) => {
      const record = createJobRecord(baseInput({ transcriptBilling: "paid" }));
      expect(stageBillingRisk(record, stage)).toBe(expected);
    },
  );
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

describe("fnv1a64Hex", () => {
  it("hashes the empty string to the standard FNV-1a 64 offset vector", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
  });

  it("hashes 'a' to the standard FNV-1a 64 vector", () => {
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
  });

  it("is deterministic for the same input", () => {
    const text = "some note content";
    expect(fnv1a64Hex(text)).toBe(fnv1a64Hex(text));
  });

  it("differs for 'ab' vs 'ba'", () => {
    expect(fnv1a64Hex("ab")).not.toBe(fnv1a64Hex("ba"));
  });

  it("produces 16 lowercase hex characters for a long string", () => {
    const long = "x".repeat(20000);
    const hash = fnv1a64Hex(long);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  // Reference implementation with BigInt — test-only (tests are never
  // bundled), so the production hash can stay free of BigInt literals for
  // the es2018 bundle target while remaining bit-exact with FNV-1a 64 over
  // UTF-16 code units.
  function referenceFnv1a64Hex(text: string): string {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, "0");
  }

  it("matches the BigInt reference on fixed vectors: ab, hello world, a Latin-1 char, a non-BMP emoji, 20 000 chars", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2); // two UTF-16 code units, hashed as two units
    for (const text of ["ab", "hello world", "\u00e9", emoji, "x".repeat(20000), "a".repeat(20000)]) {
      expect(fnv1a64Hex(text), JSON.stringify(text.slice(0, 8))).toBe(referenceFnv1a64Hex(text));
    }
    // Pinned so a regression in either implementation is visible, not just a shared drift.
    expect(fnv1a64Hex("ab")).toBe("089c4407b545986a");
    expect(fnv1a64Hex("hello world")).toBe("779a65e7023cd2e7");
  });

  it("matches the BigInt reference on random strings across the whole UTF-16 range (seeded)", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x2545f491;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < 24; n++) {
      const length = next() % 300;
      let text = "";
      for (let i = 0; i < length; i++) {
        text += String.fromCharCode(next() & 0xffff);
      }
      expect(fnv1a64Hex(text), `case ${n} (length ${length})`).toBe(referenceFnv1a64Hex(text));
      expect(fnv1a64Hex(text)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("contentMatchesClaim", () => {
  it("is false when no claim is set", () => {
    const record = createJobRecord(baseInput());
    expect(contentMatchesClaim(record, "some content")).toBe(false);
  });

  it("is true when content matches the claimed hash and length", () => {
    const record = createJobRecord(baseInput());
    const content = "# Note\n\nBody text";
    record.claimedContentHash = fnv1a64Hex(content);
    record.claimedContentLength = content.length;
    expect(contentMatchesClaim(record, content)).toBe(true);
  });

  it("is false when content differs by one character", () => {
    const record = createJobRecord(baseInput());
    const content = "# Note\n\nBody text";
    record.claimedContentHash = fnv1a64Hex(content);
    record.claimedContentLength = content.length;
    const changed = "# Note\n\nBody Text"; // capital T
    expect(contentMatchesClaim(record, changed)).toBe(false);
  });

  it("is false on a length mismatch even with a matching prefix", () => {
    const record = createJobRecord(baseInput());
    const content = "# Note\n\nBody text";
    record.claimedContentHash = fnv1a64Hex(content);
    record.claimedContentLength = content.length;
    const longer = content + "!";
    expect(contentMatchesClaim(record, longer)).toBe(false);
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

  it("throws for billing.apiKey — the allowlist is exact-path, not container-wide", () => {
    expect(() => assertRecordIsMetadataOnly({ billing: { apiKey: "x" } })).toThrow(/"billing\.apiKey"/);
  });

  it("allowlisted paths are rooted: a nested billing.transcript still throws", () => {
    // Distinguishes the exact-path allowlist from a container-wide one —
    // only "billing.transcript" (from the record root) is exempt, not any
    // "billing.transcript" wherever it appears in the tree.
    expect(() => assertRecordIsMetadataOnly({ outer: { billing: { transcript: "free" } } })).toThrow(
      /"outer\.billing\.transcript"/,
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
    expect([...ALLOWED_RECORD_PATHS].sort()).toEqual(
      ["billing.transcript", "attempts.transcript", "attempts.summary"].sort(),
    );
  });
});

// Type-only assertion: NoteJobRecord's optional fields are absent by default,
// so this compiles without needing `!` assertions anywhere above.
const _typeCheck: NoteJobRecord = createJobRecord(baseInput());
void _typeCheck;

describe("deriveNotePath — injected normalizer (#3 final review C1)", () => {
  const settings = { prependDate: false, dateFormat: "YYYY-MM-DD" };
  const nfc = (path: string): string => path.normalize("NFC");

  it("applies the injected normalizer to the whole derived path (a Hangul title is NFD after sanitizeFilename)", () => {
    const title = "안녕하세요 튜토리얼";
    const record = createJobRecord(baseInput({ folder: "Inbox", customTitle: title }));
    const raw = `Inbox/${sanitizeFilename(title)}.md`;
    expect(raw.normalize("NFC")).not.toBe(raw);
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

describe("normalizeRecordPaths", () => {
  const nfc = (path: string): string => path.normalize("NFC");
  const nfd = "Inbox/한.md".normalize("NFD");

  it("rewrites targetNotePath, claimedNotePath and notePath in place and reports the change", () => {
    const record = createJobRecord(baseInput({ folder: "Inbox" }));
    record.targetNotePath = nfd;
    record.claimedNotePath = nfd;
    record.notePath = nfd;
    expect(normalizeRecordPaths(record, nfc)).toBe(true);
    expect(record.targetNotePath).toBe(nfd.normalize("NFC"));
    expect(record.claimedNotePath).toBe(nfd.normalize("NFC"));
    expect(record.notePath).toBe(nfd.normalize("NFC"));
  });

  it("is idempotent and reports false when nothing changes, leaving absent fields absent", () => {
    const record = createJobRecord(baseInput({ folder: "Inbox" }));
    record.targetNotePath = "Inbox/Title.md";
    expect(normalizeRecordPaths(record, nfc)).toBe(false);
    expect(record.targetNotePath).toBe("Inbox/Title.md");
    expect("claimedNotePath" in record).toBe(false);
    expect("notePath" in record).toBe(false);
  });
});

describe("translation stage (#3 final review residual: translation is a checkpointed paid stage)", () => {
  it("PAID_STAGES lists translation next to summary and timestamps", () => {
    expect([...PAID_STAGES].sort()).toEqual(["summary", "timestamps", "translation"]);
  });

  it("translationSettingsFrom mirrors the legacy needsTranslation test: en/US (or absent) is none, anything else is frozen verbatim", () => {
    expect(translationSettingsFrom({ translateLanguage: "en", translateCountry: "US" })).toBeUndefined();
    expect(translationSettingsFrom({})).toBeUndefined();
    expect(translationSettingsFrom({ translateLanguage: "fr", translateCountry: "FR" })).toEqual({ language: "fr", country: "FR" });
    expect(translationSettingsFrom({ translateLanguage: "en", translateCountry: "GB" })).toEqual({ language: "en", country: "GB" });
    expect(translationSettingsFrom({ translateLanguage: "de" })).toEqual({ language: "de", country: "US" });
  });

  it("a frozen translation field and its attempts ledger are metadata (no forbidden key involved)", () => {
    const record: NoteJobRecord = { ...createJobRecord(baseInput()), translation: { language: "fr", country: "FR" } };
    expect(() => assertRecordIsMetadataOnly(record)).not.toThrow();
    expect(FORBIDDEN_RECORD_KEYS).not.toContain("translation");
    expect(FORBIDDEN_RECORD_KEYS).not.toContain("language");
    expect(FORBIDDEN_RECORD_KEYS).not.toContain("country");
  });
});

describe("createJobRecord — installationId (#3 final review I3)", () => {
  it("writes installationId only when supplied, so the documented key set is unchanged", () => {
    const without = createJobRecord(baseInput());
    expect("installationId" in without).toBe(false);
    const withId = createJobRecord({ ...baseInput(), installationId: "install-1" });
    expect(withId.installationId).toBe("install-1");
  });
});
