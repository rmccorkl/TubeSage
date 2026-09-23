// TubeSage's interface language follows Obsidian's own. There is no plugin
// language setting and there never will be one: `getLanguage()` (public API
// since Obsidian 1.8.7; minAppVersion here is 1.13.0, so it is unconditionally
// available) reports Settings -> General -> Language, and that is the answer.
//
// The language is *not* cached. The 1.13.1 API surface carries no
// language-change event, so there is nothing to subscribe to; instead the code
// is read through an injected resolver at every lookup, and every lookup
// happens while the settings definitions are being built. `getSettingDefinitions()`
// re-runs on registration and on every `update()`, so the rendered text is
// self-correcting whether or not Obsidian re-renders plugin tabs when its
// language changes. A resolver call is one synchronous function call, never
// I/O, so the "building the definitions must stay cheap" rule (issue #5) holds.
//
// The resolver is injected rather than imported because `getLanguage` is a
// value export of `obsidian`, and the `obsidian` package ships types only
// (`"main": ""`). `src/settings/setting-definitions.ts` deliberately imports
// nothing but types from it so that it stays unit-testable without an Obsidian
// runtime; a value import anywhere on the path into it would break that.
// `main.ts` installs the real resolver in `onload()`.
import { LOCALES } from './locales';

export type TranslationParams = Record<string, string | number>;
/** One locale's strings, flattened to `key -> text`. */
export type LocaleEntries = Record<string, string>;
/** Every shipped locale, keyed by its Obsidian language code. */
export type LocaleTable = Record<string, LocaleEntries>;

/** The language every other locale falls back to, and the source of truth. */
export const BASE_LOCALE = 'en';

/**
 * Canonicalise a language code to the spelling Obsidian's translation table
 * uses: lower-case language, upper-case region (`pt-br` -> `pt-BR`).
 */
export function normalizeLanguageCode(code: string): string {
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (trimmed === '') return BASE_LOCALE;
    const parts = trimmed.split('-');
    const language = parts[0].toLowerCase();
    if (parts.length === 1) return language;
    return `${language}-${parts.slice(1).join('-').toUpperCase()}`;
}

/** Resolution order: exact code, then the base language, then English. */
export function resolveLocaleChain(code: string): string[] {
    const exact = normalizeLanguageCode(code);
    const chain = [exact];
    const dash = exact.indexOf('-');
    if (dash > 0) chain.push(exact.slice(0, dash));
    if (!chain.includes(BASE_LOCALE)) chain.push(BASE_LOCALE);
    return chain;
}

/**
 * Fill `{name}` placeholders. Parameter substitution is the *only* composition
 * this module performs: a sentence is never assembled from fragments in code,
 * because `${a} ${b}` puts a space where Japanese and Chinese want none and
 * fixes an order those languages do not share. A placeholder with no supplied
 * value is left standing rather than becoming "undefined". Values are
 * stringified plainly — `Intl.NumberFormat`/`Intl.DateTimeFormat` are a later
 * phase, and the one numeric parameter here (the temperature slider) is a
 * setting value echoed back, not a formatted quantity.
 */
export function substitute(template: string, params?: TranslationParams): string {
    if (params === undefined) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole: string, name: string) => {
        const value = params[name];
        return value === undefined ? whole : String(value);
    });
}

/**
 * Look `key` up in `table` for `code`, walking exact -> base -> English.
 * A key missing from a locale yields the English string, never the raw key;
 * a key missing from English too yields the key, which `npm run i18n:check`
 * makes impossible to commit.
 */
export function translate(table: LocaleTable, code: string, key: string, params?: TranslationParams): string {
    for (const locale of resolveLocaleChain(code)) {
        const entries = table[locale];
        const value = entries === undefined ? undefined : entries[key];
        if (typeof value === 'string' && value !== '') return substitute(value, params);
    }
    return key;
}

let languageResolver: (() => string) | null = null;

/** Install (or, with `null`, remove) the source of the interface language. */
export function setLanguageResolver(resolver: (() => string) | null): void {
    languageResolver = resolver;
}

/** The interface language right now. English until a resolver is installed. */
export function currentLanguage(): string {
    if (languageResolver === null) return BASE_LOCALE;
    try {
        const code = languageResolver();
        return typeof code === 'string' && code.trim() !== '' ? code : BASE_LOCALE;
    } catch {
        return BASE_LOCALE;
    }
}

/** Translate `key` into the current interface language. */
export function t(key: string, params?: TranslationParams): string {
    return translate(LOCALES, currentLanguage(), key, params);
}
