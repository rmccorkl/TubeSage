import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "./filename-sanitizer";

// Issue #6: sanitizeFilename's allow-list (`[^\p{L}\p{N}\s-]`) omits `\p{M}`,
// so after the leading `normalize('NFD')` every remaining combining mark is
// deleted. That's correct for Latin diacritics (café -> cafe is intentional,
// handled separately by the explicit strip of the Combining Diacritical
// Marks block, codepoints U+0300 through U+036F) but wrong for scripts where
// combining marks are semantically load-bearing: Japanese voiced/semi-voiced
// sound marks and Thai vowel/tone signs are combining marks OUTSIDE that
// Latin diacritic block, and deleting them corrupts the text
// (がんばれ -> かんはれ). The fix allows `\p{M}` through the filter and
// recomposes with `normalize('NFC')` at the end so the sanitizer's own
// output is already NFC (matching Obsidian's NFC vault index, issue #3's
// invariant), while the explicit U+0300-U+036F strip still runs first
// (while decomposed) so Latin diacritics keep being removed.

describe("sanitizeFilename - non-Latin combining marks (#6)", () => {
  it("keeps Japanese voiced sound marks: がんばれ日本", () => {
    expect(sanitizeFilename("がんばれ日本")).toBe("がんばれ日本");
  });

  it("keeps Japanese semi-voiced sound marks and replaces the space: パンダ プロジェクト", () => {
    expect(sanitizeFilename("パンダ プロジェクト")).toBe("パンダ-プロジェクト");
  });

  it("leaves an iteration-mark title untouched (no combining marks): 人々の時代", () => {
    expect(sanitizeFilename("人々の時代")).toBe("人々の時代");
  });

  it("leaves a prolonged-sound-mark title untouched (no combining marks): コーヒーメーカー", () => {
    expect(sanitizeFilename("コーヒーメーカー")).toBe("コーヒーメーカー");
  });

  it("keeps Thai vowel signs: บทเรียนภาษาไทย", () => {
    expect(sanitizeFilename("บทเรียนภาษาไทย")).toBe("บทเรียนภาษาไทย");
  });

  it("handles a mixed Latin/Japanese title, stripping disallowed punctuation: Python 入門 #1", () => {
    expect(sanitizeFilename("Python 入門 #1")).toBe("Python-入門-1");
  });
});

describe("sanitizeFilename - regression: unaffected scripts (#6)", () => {
  it("Chinese (simplified) is unchanged: 中文视频教程", () => {
    expect(sanitizeFilename("中文视频教程")).toBe("中文视频教程");
  });

  it("Chinese (traditional) is unchanged: 繁體中文教學", () => {
    expect(sanitizeFilename("繁體中文教學")).toBe("繁體中文教學");
  });

  it("Korean is unchanged (Hangul jamo carry no combining marks) and space becomes a hyphen: 안녕하세요 튜토리얼", () => {
    expect(sanitizeFilename("안녕하세요 튜토리얼")).toBe("안녕하세요-튜토리얼");
  });
});

describe("sanitizeFilename - regression: Latin diacritics still stripped (#6)", () => {
  it("café -> cafe", () => {
    expect(sanitizeFilename("café")).toBe("cafe");
  });

  it("naïve -> naive", () => {
    expect(sanitizeFilename("naïve")).toBe("naive");
  });
});

describe("sanitizeFilename - NFC invariant (#6 / #3)", () => {
  const samples = [
    "がんばれ日本",
    "パンダ プロジェクト",
    "人々の時代",
    "コーヒーメーカー",
    "บทเรียนภาษาไทย",
    "Python 入門 #1",
    "中文视频教程",
    "繁體中文教學",
    "안녕하세요 튜토리얼",
    "café",
    "naïve",
  ];

  it.each(samples)("result for %j is already NFC-normalized", (input) => {
    const result = sanitizeFilename(input);
    expect(result).toBe(result.normalize("NFC"));
  });
});

describe("sanitizeFilename - existing edge cases (regression, #6)", () => {
  it("empty string -> untitled-note", () => {
    expect(sanitizeFilename("")).toBe("untitled-note");
  });

  it("whitespace-only -> untitled-note", () => {
    expect(sanitizeFilename("   ")).toBe("untitled-note");
  });

  it("dot-only title -> untitled", () => {
    expect(sanitizeFilename("...")).toBe("untitled");
  });

  it("slash-only title -> untitled", () => {
    expect(sanitizeFilename("///")).toBe("untitled");
  });

  it("a title that sanitizes to nothing (only disallowed punctuation) -> untitled", () => {
    expect(sanitizeFilename("###")).toBe("untitled");
  });

  it("a title starting with a digit gets a note- prefix", () => {
    expect(sanitizeFilename("123 My Video")).toBe("note-123-My-Video");
  });

  it("a title over 255 characters is truncated to 252 chars (the length cap appends '...', but the final trailing-separator strip removes it again since periods are in [-_.]+$)", () => {
    const longTitle = "A".repeat(300);
    const result = sanitizeFilename(longTitle);
    expect(result).toBe("A".repeat(252));
    expect(result.length).toBe(252);
  });
});
