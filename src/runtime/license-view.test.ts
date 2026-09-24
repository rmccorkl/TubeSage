// The licence the modal shows must be the licence the project distributes,
// in every language Obsidian can be set to. It is reproduced verbatim and
// stays in English always: there are legal consequences to displaying an
// instrument that differs from the one shipped, and punctuation is part of the
// instrument.
//
// THE DEFECT THIS PINS. The renderer used to rebuild each clause heading
// through `t('modal.license.listItem', { number, title })`. That row reads
// `"{number}. {title}: "` in most locales but not all — ja, zh and zh-TW write
// fullwidth numbering and a fullwidth colon, km and am their own colons, fr a
// space before it — so the displayed licence differed from the file in six of
// the shipped languages. Rendering it in English, or in any of the other
// forty-odd, showed nothing wrong, which is exactly why the check below
// iterates the real locale table instead of a chosen language.
//
// WHAT IS COMPARED. `licenseText()` is the licence file inlined at build time;
// `scripts/bundled-text-packaging.test.mjs` fails if that constant and
// `MIT-license-tubesage.md` differ by one byte, so comparing against the
// constant is comparing against the file, without this test reading a file.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { licenseText } from "../bundled";
import { setLanguageResolver } from "../i18n";
import { BUNDLED_LOCALES } from "../i18n/locales";
import { licenseView } from "./license-view";
import type { LicenseBlock } from "./license-view";

/**
 * Every language code the plugin can resolve — the bundled table itself, not a
 * list written out here, so a locale added later is covered without anyone
 * remembering to add it. It carries one alias (`kh` for Khmer), which is a
 * code `getLanguage()` may return and so is a case that must hold too.
 */
const LOCALE_CODES = Object.keys(BUNDLED_LOCALES);

/** The rendered document, one string per block, in render order. */
function renderedLines(blocks: LicenseBlock[]): string[] {
    return blocks.map((block) => {
        switch (block.kind) {
            case "heading":
                return block.text;
            case "clause":
                return `${block.heading}${block.body}`;
            case "subItem":
                return block.text;
            case "paragraph":
                return block.text;
            case "spacer":
                return "";
        }
    });
}

/**
 * The licence's own lines under THE ONE TRANSFORMATION THE DISPLAY REQUIRES,
 * written here independently of the code under test.
 *
 * "Byte-identical" cannot mean "equal to the raw file bytes": the modal shows
 * rendered markdown, not a source listing, so the three markers that BECOME
 * the rendering are consumed —
 *
 *   `# ` the line is an <h3>; the marker is the markdown for that element.
 *   `**` the clause title is set in bold, so the pair of markers around it is
 *        the markdown for that weight. The span carrying the weight is wider
 *        than the markers — it holds the numbering too, which the file does
 *        not emphasise — but that is where the bold begins and ends visually,
 *        not a change to a character. Only that first pair goes: a further
 *        pair on the same line would be shown, not silently eaten, because
 *        nothing renders it.
 *   ` - ` the sub-item is an indented bullet div; the indent is CSS margin and
 *         the dash becomes the bullet glyph the div displays.
 *
 * and an empty line becomes a spacer div, compared here as an empty string.
 * That is the whole of it. Nothing else is added, removed, reordered or
 * substituted — in particular the clause numbers, the title text and every
 * character of punctuation between and after them are the file's own bytes.
 * The same transformation is applied for every locale, because it is a
 * property of rendering markdown and not of any language.
 */
function displayedLines(licence: string): string[] {
    return licence.split("\n").map((line) => {
        if (line.startsWith("# ")) return line.substring(2);
        if (/^\d+\.\s+\*\*/.test(line)) return line.replace(/\*\*(.*?)\*\*/, "$1");
        if (/^\s+-\s+/.test(line)) return line.replace(/^\s+-\s+/, "• ");
        return line;
    });
}

describe("the licence modal's contents", () => {
    beforeEach(() => {
        setLanguageResolver(() => "en");
    });

    afterAll(() => {
        setLanguageResolver(null);
    });

    it("covers the whole shipped locale table, not a sample of it", () => {
        // A check that ran in one language is what let the defect through.
        expect(LOCALE_CODES.length).toBeGreaterThanOrEqual(51);
        for (const code of ["en", "ja", "zh", "zh-TW", "am", "km", "fr"]) {
            expect(LOCALE_CODES, `${code} must be among the locales checked`).toContain(code);
        }
    });

    it("shows the very same text in every locale — the licence does not translate", () => {
        // The unconditional property, and the one that holds whatever anybody
        // later decides the markdown transformation below should be: what the
        // modal displays must not depend on the interface language at all.
        const english = renderedLines(licenseView());
        const divergent: string[] = [];
        for (const code of LOCALE_CODES) {
            setLanguageResolver(() => code);
            const rendered = renderedLines(licenseView());
            if (rendered.join("\n") !== english.join("\n")) divergent.push(code);
        }
        expect(divergent, "these locales displayed a licence other than the English one").toEqual([]);
    });

    it.each(LOCALE_CODES)(
        "in %s shows the licence file's own bytes, markdown markers aside",
        (code) => {
            setLanguageResolver(() => code);
            expect(renderedLines(licenseView())).toEqual(displayedLines(licenseText()));
        },
    );

    it.each(LOCALE_CODES)("in %s takes each clause heading straight from the file", (code) => {
        // The defect was here specifically: the number, the title and the
        // punctuation after it were recomposed from a translation row instead
        // of emitted from the line being rendered. Heading and body joined must
        // give back the source line with only its `**` markers gone.
        setLanguageResolver(() => code);
        const clauses = licenseView().filter((block): block is Extract<LicenseBlock, { kind: "clause" }> => block.kind === "clause");
        const sourceClauses = licenseText()
            .split("\n")
            .filter((line) => /^\d+\.\s+\*\*/.test(line));

        expect(clauses.length, "the licence's numbered clauses must all be parsed as clauses").toBe(sourceClauses.length);
        expect(clauses.length).toBeGreaterThan(0);
        expect(clauses.map((clause) => `${clause.heading}${clause.body}`)).toEqual(
            sourceClauses.map((line) => line.replace(/\*\*(.*?)\*\*/, "$1")),
        );
    });
});
