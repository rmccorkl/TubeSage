import { describe, expect, it } from "vitest";
import {
    buildSinglePassNote,
    convertTimeIndexToWatchUrls,
    countTimestampLinks,
    createOptimizedChunks,
    dropUnofferedTimeIndices,
    extractDocumentComponents,
    fitTranscriptToBudget,
    hasProperHeading,
    isChunkAcceptable,
    MOBILE_CHUNK_TRANSCRIPT_BUDGET,
    offeredTimeIndices,
    SINGLE_PASS_TRANSCRIPT_BUDGET,
    reconstructDocument,
    validateEnhancedContent,
} from "./timestamp-utils";

const VIDEO_ID = "abc123XYZ_-";

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

// A transcript shaped like formatTranscriptForYaml's output, deliberately
// larger than the note body — as a real transcript usually is. That size
// difference is what hid defect 1 of #21.
const TRANSCRIPT = Array.from(
    { length: 40 },
    (_, minute) => `    [00:${pad(minute)}:00] [TimeIndex:${minute * 60}] ${"spoken words ".repeat(60)}`,
).join("\n");
const FRONTMATTER = `---\ntitle: "A video"\ntranscript:  |\n\n${TRANSCRIPT}\n---`;

function section(n: number): string {
    return `## ${n}. Topic ${n}\n\n${`Body sentence about topic ${n}. `.repeat(40)}\n\n`;
}

const BODY = `# A video\n\n> intro callout\n\n${[1, 2, 3, 4, 5, 6, 7, 8].map(section).join("")}## Conclusion\n\nWrap up.\n`;

/** What the LLM is asked to return: the same text, a marker on each numbered heading. */
function withMarkers(text: string): string {
    return text.replace(/^(#{1,6} (\d+)\. .+)$/gm, (_line, heading: string, n: string) => `${heading} [TimeIndex:${Number(n) * 60}]`);
}

/** The headings main.ts extracts before the pass (addSectionLinksToNote). */
function headingsOf(text: string): string[] {
    return [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => match[2].trim());
}

function watchUrl(seconds: number): string {
    return `[Watch](https://www.youtube.com/watch?v=${VIDEO_ID}&t=${seconds})`;
}

describe("extractDocumentComponents / reconstructDocument", () => {
    it("splits a note into frontmatter, body and transcript", () => {
        const { frontmatter, contentWithoutFrontmatter, transcript } = extractDocumentComponents(`${FRONTMATTER}\n${BODY}`);
        expect(frontmatter).toBe(FRONTMATTER);
        expect(contentWithoutFrontmatter).toBe(BODY.trim());
        expect(transcript.startsWith("[00:00:00] [TimeIndex:0] spoken words")).toBe(true);
    });

    it("returns the whole text as the body when there is no frontmatter", () => {
        expect(extractDocumentComponents(BODY)).toEqual({ frontmatter: "", contentWithoutFrontmatter: BODY, transcript: "" });
    });

    it("reconstructs frontmatter + body", () => {
        expect(reconstructDocument("---\na: 1\n---", "# Body")).toBe("---\na: 1\n---\n# Body");
    });
});

describe("convertTimeIndexToWatchUrls", () => {
    it("converts the marker on a heading line and leaves other lines alone", () => {
        const converted = convertTimeIndexToWatchUrls("## 1. Intro [TimeIndex:42]\nbody [TimeIndex:7]", VIDEO_ID);
        expect(converted).toBe(`## 1. Intro ${watchUrl(42)}\nbody [TimeIndex:7]`);
    });
});

describe("createOptimizedChunks", () => {
    it("keeps the text before the first numbered heading as its own chunk and covers the whole body", () => {
        const chunks = createOptimizedChunks(BODY, 100_000);
        expect(chunks[0]).toBe("# A video\n\n> intro callout\n\n");
        expect(hasProperHeading(chunks[0])).toBe(false);
        expect(chunks.join("")).toBe(BODY);
    });

    it("splits at numbered headings when the budget is small, never inside a section", () => {
        const chunks = createOptimizedChunks(BODY, 1_000);
        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks.slice(1)) expect(chunk.startsWith("## ")).toBe(true);
        expect(chunks.join("")).toBe(BODY);
    });
});

describe("countTimestampLinks", () => {
    it("counts numbered headings that carry a Watch link", () => {
        expect(countTimestampLinks(`## 1. A ${watchUrl(1)}\n## B ${watchUrl(2)}\n### 1.1. C ${watchUrl(3)}\n`)).toBe(2);
    });
});

describe("validateEnhancedContent", () => {
    const original = section(1) + section(2);
    const headings = headingsOf(original);
    const linked = convertTimeIndexToWatchUrls(withMarkers(original), VIDEO_ID);

    it("accepts a body that kept its length and headings and gained links", () => {
        expect(validateEnhancedContent(linked, original, headings, VIDEO_ID)).toBe(true);
    });

    it("rejects a body under 90% of the original length", () => {
        expect(validateEnhancedContent(linked.slice(0, Math.floor(original.length * 0.8)), original, headings, VIDEO_ID)).toBe(false);
    });

    it("rejects a body that dropped one of the headings it was given", () => {
        const withoutHeading2 = linked.replace(/^## 2\. Topic 2.*$/m, "");
        expect(validateEnhancedContent(withoutHeading2, original, headings, VIDEO_ID)).toBe(false);
    });

    it("rejects a body with no Watch link on any heading", () => {
        expect(validateEnhancedContent(original, original, headings, VIDEO_ID)).toBe(false);
    });
});

// Regression for #21 defect 1: the single pass validated the REBUILT note —
// frontmatter included, and the frontmatter carries the whole transcript —
// against the body alone, so the 90% length guard could never fail.
describe("buildSinglePassNote (#21 defect 1)", () => {
    const headings = headingsOf(BODY);

    it("accepts the full body with markers, keeping the frontmatter and converting heading markers", () => {
        const { note, valid } = buildSinglePassNote(FRONTMATTER, withMarkers(BODY), BODY.trim(), headings, VIDEO_ID);
        expect(valid).toBe(true);
        expect(note.startsWith(FRONTMATTER)).toBe(true);
        expect(note).toContain(`## 3. Topic 3 ${watchUrl(180)}`);
    });

    it("rejects a response that lost almost all of the body, however large the transcript", () => {
        const damaged = "## 1. Topic 1 [TimeIndex:60]\n\nshort\n";
        expect(buildSinglePassNote(FRONTMATTER, damaged, BODY.trim(), headings, VIDEO_ID).valid).toBe(false);
    });
});

// Regression for #21 defect 2: the chunked path — the normal case above five
// headings — accepted a chunk if any [TimeIndex:N] appeared anywhere in it.
describe("isChunkAcceptable (#21 defect 2)", () => {
    const chunk = section(1) + section(2);

    it("accepts a chunk returned whole with markers on its headings", () => {
        expect(isChunkAcceptable(withMarkers(chunk), chunk, VIDEO_ID)).toBe(true);
    });

    it("rejects a chunk that came back truncated", () => {
        expect(isChunkAcceptable("## 1. Topic 1 [TimeIndex:60]\n\nshort", chunk, VIDEO_ID)).toBe(false);
    });

    it("rejects a chunk that dropped a heading it was sent", () => {
        const withoutHeading2 = withMarkers(chunk).replace(/^## 2\. Topic 2.*$/m, "");
        expect(isChunkAcceptable(withoutHeading2, chunk, VIDEO_ID)).toBe(false);
    });

    it("rejects a chunk with a marker on a non-heading line", () => {
        const misplaced = withMarkers(chunk).replace("Body sentence about topic 2.", "Body sentence about topic 2. [TimeIndex:99]");
        expect(isChunkAcceptable(misplaced, chunk, VIDEO_ID)).toBe(false);
    });

    it("rejects a chunk with no marker at all", () => {
        expect(isChunkAcceptable(chunk, chunk, VIDEO_ID)).toBe(false);
    });
});

// Regression for #23: the transcript was cut to its first N characters, so on
// a 21-minute video only the first ~4 segment timestamps reached the model and
// every link landed in the first 3 minutes. Synthetic, same shape as the real
// failing note: 21 one-minute segments, ~28,000 characters, as extracted from
// the frontmatter (first line unindented, the rest indented four spaces).
function longTranscript(segments = 21, sentencesPerSegment = 42): string {
    return Array.from(
        { length: segments },
        (_, m) => `[${pad(Math.floor(m / 60))}:${pad(m % 60)}:00] [TimeIndex:${m * 60}] ${`talking about minute ${m} topic. `.repeat(sentencesPerSegment)}`,
    ).join("\n    ");
}

function choosableTimeIndices(transcript: string): number[] {
    return [...transcript.matchAll(/\[TimeIndex:(\d+)\]/g)].map((match) => Number(match[1]));
}

const ALL_21 = Array.from({ length: 21 }, (_, m) => m * 60);

describe("fitTranscriptToBudget (#23)", () => {
    const transcript = longTranscript();

    it("the synthetic transcript has the failing note's shape", () => {
        expect(transcript.length).toBeGreaterThan(26_000);
        expect(transcript.length).toBeLessThan(30_000);
        expect(choosableTimeIndices(transcript)).toEqual(ALL_21);
    });

    it("documents the bug: cutting to the first 5,000 characters leaves only 4 of 21 timestamps", () => {
        expect(choosableTimeIndices(transcript.substring(0, MOBILE_CHUNK_TRANSCRIPT_BUDGET))).toEqual([0, 60, 120, 180]);
    });

    it("keeps all 21 timestamps choosable within the 5,000-character mobile budget", () => {
        const fitted = fitTranscriptToBudget(transcript, MOBILE_CHUNK_TRANSCRIPT_BUDGET);
        expect(choosableTimeIndices(fitted)).toEqual(ALL_21);
        expect(fitted.length).toBeLessThanOrEqual(MOBILE_CHUNK_TRANSCRIPT_BUDGET);
    });

    it("keeps all 21 timestamps choosable within the 10,000-character single-pass budget", () => {
        const fitted = fitTranscriptToBudget(transcript, SINGLE_PASS_TRANSCRIPT_BUDGET);
        expect(choosableTimeIndices(fitted)).toEqual(ALL_21);
        expect(fitted.length).toBeLessThanOrEqual(SINGLE_PASS_TRANSCRIPT_BUDGET);
    });

    it("spends the budget on every segment's text, not just the opening ones", () => {
        const fitted = fitTranscriptToBudget(transcript, MOBILE_CHUNK_TRANSCRIPT_BUDGET);
        for (const minute of [0, 10, 20]) expect(fitted).toContain(`talking about minute ${minute} topic`);
    });

    it("returns a transcript within budget unchanged, and is deterministic", () => {
        const short = longTranscript(3);
        expect(fitTranscriptToBudget(short, MOBILE_CHUNK_TRANSCRIPT_BUDGET)).toBe(short);
        expect(fitTranscriptToBudget(transcript, 5000)).toBe(fitTranscriptToBudget(transcript, 5000));
    });

    it("on a very long video, merges into coarser buckets that still span the whole video", () => {
        const fiveHours = longTranscript(300);
        const fitted = fitTranscriptToBudget(fiveHours, MOBILE_CHUNK_TRANSCRIPT_BUDGET);
        const offered = choosableTimeIndices(fitted);
        expect(fitted.length).toBeLessThanOrEqual(MOBILE_CHUNK_TRANSCRIPT_BUDGET);
        expect(offered[0]).toBe(0);
        expect(offered[offered.length - 1]).toBeGreaterThanOrEqual(290 * 60);
        expect(offered.length).toBeGreaterThan(20);
    });
});

describe("a TimeIndex the model was never offered is not written into the note (#23)", () => {
    // Called inside each test (not at describe time) so a missing function fails tests, not the whole file.
    const offeredSample = () => offeredTimeIndices("[00:00:00] [TimeIndex:0] intro\n    [00:01:00] [TimeIndex:60] next");

    it("reads the offered values from the transcript shown to the model", () => {
        expect(offeredSample()).toEqual(new Set([0, 60]));
        expect(offeredTimeIndices("No transcript available")).toBeNull();
    });

    it("single pass: an unoffered value is dropped, an offered one is linked", () => {
        const body = `## 1. Intro\n\n${"Intro body. ".repeat(20)}\n\n## 2. Next\n\n${"Next body. ".repeat(20)}`;
        const response = body.replace("## 1. Intro", "## 1. Intro [TimeIndex:999]").replace("## 2. Next", "## 2. Next [TimeIndex:60]");
        const { note } = buildSinglePassNote("---\na: 1\n---", response, body, ["1. Intro", "2. Next"], VIDEO_ID, offeredSample());
        expect(note).not.toContain("t=999");
        expect(note).not.toContain("[TimeIndex:999]");
        expect(note).toContain(`## 1. Intro\n`);
        expect(note).toContain(`## 2. Next ${watchUrl(60)}`);
    });

    it("chunked path: unoffered markers are removed before the chunk is checked, so a chunk with none valid keeps its original text", () => {
        const chunk = `## 1. Intro\n\n${"Intro body. ".repeat(20)}\n`;
        const offered = offeredSample();
        const cleaned = dropUnofferedTimeIndices(chunk.replace("## 1. Intro", "## 1. Intro [TimeIndex:999]"), offered);
        expect(cleaned).not.toContain("[TimeIndex:999]");
        expect(isChunkAcceptable(cleaned, chunk, VIDEO_ID)).toBe(false);
        expect(dropUnofferedTimeIndices("## 1. Intro [TimeIndex:60]", offered)).toBe("## 1. Intro [TimeIndex:60]");
    });

    it("filters nothing when the transcript offered no timestamps at all", () => {
        expect(dropUnofferedTimeIndices("## 1. Intro [TimeIndex:999]", null)).toBe("## 1. Intro [TimeIndex:999]");
    });
});
