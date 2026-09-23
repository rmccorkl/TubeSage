// Script detection for the one UI-text rule that is not universal.
//
// Obsidian's style guide (and the `obsidianmd/ui/sentence-case` ESLint rule)
// asks for sentence case in UI text. Sentence case is a property of bicameral
// Latin-script writing: Japanese, Chinese and Korean have no letter case at
// all, so applying — or checking — the rule there is meaningless at best and a
// corrupting mechanical transform at worst (issue #4, comment 1). The check
// below therefore reports `skipped` for anything that is not Latin script,
// decided by Unicode script property rather than by locale code: `ja.json`
// could legitimately carry a Latin-script string, and a Latin-script locale
// could carry a transliteration.

const LETTERS = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** True when every letter in `text` is Latin script (text with no letters counts). */
export function isLatinScript(text: string): boolean {
    for (const letter of text.match(LETTERS) ?? []) {
        if (!LATIN_LETTER.test(letter)) return false;
    }
    return true;
}

/**
 * Brand and product names whose internal capitals are intentional. Kept in
 * step with `i18n/TERMS.md`: these are exactly the words that are never
 * translated, and they are also the words sentence case must not lowercase.
 */
const BRANDS: ReadonlySet<string> = new Set([
    'Anthropic',
    'Gemini',
    'Google',
    'Obsidian',
    'Ollama',
    'OpenAI',
    'OpenRouter',
    'README',
    'ScrapeCreators',
    'Supadata',
    'Templater',
    'TubeSage',
    'Tubesage',
    'YouTube',
]);

export type SentenceCaseStatus = 'ok' | 'violation' | 'skipped';

/** `{provider}`, `({provider})` — a substitution slot, not a word. */
const PLACEHOLDER = /^\{[A-Za-z0-9_]+\}$/;

/**
 * Strip the punctuation a word may be wrapped in before judging its case,
 * keeping the braces of a `{placeholder}` so it stays recognisable as one.
 */
function core(word: string): string {
    const trimmed = word.replace(/^[(["']+/, '').replace(/[)\]"',.:;!?]+$/, '');
    return PLACEHOLDER.test(trimmed) ? trimmed : trimmed.replace(/^\{+/, '').replace(/\}+$/, '');
}

/**
 * Sentence case for Latin-script UI text: an initial capital, and no further
 * Title Case word. A capital followed by a lower-case letter mid-string is
 * Title Case; an all-caps run (API, OPENAI) is an acronym and is fine.
 * Returns `skipped` — never `violation` — outside Latin script.
 *
 * A `{placeholder}` is never judged: its case belongs to whatever is
 * substituted in. A string that *begins* with one ("{provider} api key" ->
 * "OpenAI api key") therefore has its initial-capital requirement carried by
 * the substituted value, and the words after it are judged as mid-sentence.
 */
export function sentenceCaseStatus(text: string): SentenceCaseStatus {
    if (!isLatinScript(text)) return 'skipped';
    const words = text.split(/\s+/).filter((word) => word !== '').map(core);
    const firstReal = words.findIndex((word) => !PLACEHOLDER.test(word));
    if (firstReal === -1) return 'ok';
    if (firstReal === 0) {
        const first = words[0];
        if (!/^[A-Z]/.test(first) && !BRANDS.has(first) && /\p{L}/u.test(first)) return 'violation';
    }
    for (const word of words.slice(Math.max(firstReal, 1))) {
        if (PLACEHOLDER.test(word)) continue;
        if (/^[A-Z][a-z]/.test(word) && !BRANDS.has(word)) return 'violation';
    }
    return 'ok';
}
