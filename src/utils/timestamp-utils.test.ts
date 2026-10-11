import { describe, expect, it } from "vitest";
import {
    buildSinglePassNote,
    convertTimeIndexToWatchUrls,
    countTimestampLinks,
    createOptimizedChunks,
    extractDocumentComponents,
    hasProperHeading,
    isChunkAcceptable,
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
