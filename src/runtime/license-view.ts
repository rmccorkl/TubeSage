// The licence document the licence modal shows, parsed here rather than in
// `main.ts` so that it can be tested.
//
// WHY IT LIVES UNDER `src/`. `main.ts` imports `obsidian`, which ships types
// only, so nothing that lives there can be loaded by a test. The parsing of
// the licence was inside the modal's `onOpen()`, where the only way to check
// what a user is shown was to read the code and believe it. This module has no
// `obsidian` import and takes no arguments, so a test can render the whole
// document and compare it with the licence itself.
//
// The licence comes from `src/bundled`, inlined from `MIT-license-tubesage.md`
// at build time: Obsidian's community installer copies only `main.js`,
// `manifest.json` and `styles.css` into a store install, so the file the modal
// used to read was not there. Nothing here can fail — there is no read, so
// there is no failure path and no catch.
//
// NOTHING HERE IS TRANSLATED, and this module calls no `t()` at all. The
// licence is reproduced verbatim and stays in English in every interface
// language: displaying an instrument that differs from the one distributed has
// legal consequences, and its punctuation is part of it. A clause heading used
// to be recomposed through a translation row that spelled the numbering and
// the colon the way each language's typography does, so six of the shipped
// locales showed a licence the file does not state. Every character below is
// carried across from the licence's own bytes — the only thing dropped is the
// markdown emphasis markers, which the stylesheet re-expresses as weight.
import { licenseText } from '../bundled';

/**
 * One rendered element of the licence document.
 *
 * `clause` carries the two spans a numbered clause renders as: the heading
 * segment, which the stylesheet sets in bold, and the clause text after it.
 * Joined, they are the source line again with its `**` markers gone.
 */
export type LicenseBlock =
    | { kind: 'heading'; text: string }
    | { kind: 'clause'; heading: string; body: string }
    | { kind: 'subItem'; text: string }
    | { kind: 'paragraph'; text: string }
    | { kind: 'spacer' };

/**
 * A numbered clause, taken apart into the pieces the modal renders: the
 * numbering, the emphasised title, and everything after it.
 *
 * The third group starts at the closing `**`, so the separator that follows
 * the title — a colon and a space in this licence — is carried into the clause
 * text exactly as the file writes it rather than being supplied from anywhere
 * else. The numbering and the title are likewise the file's own characters.
 */
const CLAUSE_LINE = /^(\d+\.\s+)\*\*(.*?)\*\*(.*)$/;
/** A sub-item under a clause: leading indent, a dash, the text. */
const SUB_ITEM_LINE = /^\s+-\s+/;

/** Parse the bundled licence into the blocks the modal renders. */
export function licenseView(): LicenseBlock[] {
    const blocks: LicenseBlock[] = [];
    let inList = false;

    for (const line of licenseText().split('\n')) {
        const clause = line.match(CLAUSE_LINE);
        if (line.startsWith('# ')) {
            inList = false;
            blocks.push({ kind: 'heading', text: line.substring(2) });
        } else if (clause) {
            inList = true;
            const [, numbering, title, body] = clause;
            blocks.push({ kind: 'clause', heading: `${numbering}${title}`, body });
        } else if (inList && SUB_ITEM_LINE.test(line)) {
            blocks.push({ kind: 'subItem', text: line.replace(SUB_ITEM_LINE, '• ') });
        } else if (line.trim() !== '') {
            inList = false;
            blocks.push({ kind: 'paragraph', text: line });
        } else {
            blocks.push({ kind: 'spacer' });
        }
    }

    return blocks;
}
