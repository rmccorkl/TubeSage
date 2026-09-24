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

/** The CLDR plural categories, in CLDR's own order. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = typeof PLURAL_CATEGORIES[number];

/**
 * Which plural form `count` takes in `code`.
 *
 * `Intl.PluralRules` is the platform's own CLDR data and is the only correct
 * answer here: the categories are not a property of the number, they are a
 * property of the language. English and German have two, French six fewer than
 * Arabic's six, Polish four, and Japanese exactly one — so a hand-rolled
 * `count === 1 ? a : b` is wrong everywhere outside a handful of languages.
 *
 * Verified available before this was written: Obsidian runs Chromium (1.12.7
 * ships Chrome 142) and `minAppVersion` here is 1.13.0, while `Intl.PluralRules`
 * has existed since Chrome 63. The `try` is not for that — it is for a locale
 * code ICU does not know, which throws on construction rather than falling back.
 *
 * NOTE on the fallback ICU performs SILENTLY: `sa` (Sanskrit) has no CLDR
 * plural data, so `new Intl.PluralRules('sa').resolvedOptions().locale` is
 * `en-US`. The categories it returns are English's, not Sanskrit's. That is an
 * acceptable answer — it is still `one`/`other` — but it is a fallback, and the
 * locale data is not evidence about Sanskrit.
 */
export function pluralCategory(code: string, count: number): PluralCategory {
    try {
        const selected = new Intl.PluralRules(code).select(count);
        return (PLURAL_CATEGORIES as readonly string[]).includes(selected) ? selected : 'other';
    } catch {
        return count === 1 ? 'one' : 'other';
    }
}

/**
 * Translate a counted string, choosing the plural form of whichever locale
 * actually answers.
 *
 * The category is recomputed at EVERY rung of the fallback chain, not once for
 * the requested language. If Japanese is asked for and Japanese has the key,
 * Japanese has one category and takes `other`. If Japanese does NOT have the
 * key, the English string is what the user will read, so the form must be
 * English's — asking Japanese's rules about a sentence rendered in English
 * would pick a form the English text does not have.
 *
 * `{count}` is supplied as a parameter automatically, so a translation may use
 * it without the caller passing it twice; an explicit `params.count` wins.
 */
export function translatePlural(
    table: LocaleTable,
    code: string,
    key: string,
    count: number,
    params?: TranslationParams,
): string {
    const withCount: TranslationParams = { count, ...params };
    for (const locale of resolveLocaleChain(code)) {
        const entries = table[locale];
        if (entries === undefined) continue;
        const category = pluralCategory(locale, count);
        // `other` is the one category CLDR guarantees every language has, so it
        // is the within-locale fallback before dropping to the next language.
        for (const candidate of [`${key}.${category}`, `${key}.other`]) {
            const value = entries[candidate];
            if (typeof value === 'string' && value !== '') return substitute(value, withCount);
        }
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

/** Translate a counted `key` into the current interface language. */
export function tPlural(key: string, count: number, params?: TranslationParams): string {
    return translatePlural(LOCALES, currentLanguage(), key, count, params);
}
