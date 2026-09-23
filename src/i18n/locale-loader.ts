// Reading an OVERRIDE translation out of the plugin's own folder.
//
// WHAT THIS IS NOT: the distribution path. Every locale is compiled into
// `main.js` (`./locales`), because Obsidian's community installer downloads
// only `main.js`, `manifest.json` and `styles.css` from a release — a locale
// published as a release asset would never reach a store install. This module
// exists so that a file dropped into the plugin folder by hand — a translator
// testing a revision, a user patching a string — takes precedence over the
// bundled table for that language, with no rebuild.
//
// WHY A FLAT `<manifest.dir>/<code>.json`, not `<manifest.dir>/locales/<code>.json`:
// the plugin folder is flat — Obsidian's installer puts `main.js`,
// `manifest.json` and `styles.css` directly in it and creates no
// subdirectory — so the file a person drops in beside them is `de.json`, and
// that is the one name a reader can be told without qualification.
//
// WHY THIS IS AWAITED INSIDE `onload()`: `addSettingTab` is registered during
// `onload`, and the tab can only be rendered once the user opens Settings,
// which is necessarily after `onload` has resolved. Awaiting one small JSON
// read therefore means an override is in force by the time anything renders,
// rather than being applied after a first paint. `Plugin.onload(): Promise<void>
// | void` supports this.
//
// WHY IT CANNOT HANG OR THROW: plugin load is on Obsidian's critical path, so
// the read is raced against a timer (`LOCALE_READ_TIMEOUT_MS`) and every
// failure — `manifest.dir` undefined, file absent, unreadable, malformed JSON,
// not a flat string table, timeout — degrades to the BUNDLED locale for that
// language, and to English only when nothing is bundled for it either. Nothing
// in here throws into `onload`. The common case, by a wide margin, is that no
// override file exists: that is the default, not a failure, and it is silent.
//
// Every dependency is injected. `obsidian` ships types only (`"main": ""`), so
// a value import of `normalizePath` would make this module unloadable under a
// bare test runner; `window` timers are injected for the same reason.
import { BASE_LOCALE, normalizeLanguageCode, resolveLocaleChain } from './index';
import type { LocaleEntries } from './index';
import { hasBundledLocale, installRuntimeLocale } from './locales';

/**
 * How long the locale read gets before it is abandoned. It is one small local
 * JSON file, so this is generous for a working adapter and short enough that a
 * wedged one costs a barely perceptible pause rather than a stalled load.
 */
export const LOCALE_READ_TIMEOUT_MS = 1500;

/**
 * The name an override file has *inside the plugin folder* — flat, no
 * directory part, because the plugin folder itself is flat. This is the single
 * definition of that string; nothing copies it.
 */
export function localeFileName(code: string): string {
    return `${normalizeLanguageCode(code)}.json`;
}

/** Everything the loader touches, injected so none of it is imported here. */
export interface LocaleLoaderDeps {
    /** `Plugin.manifest.dir` — OPTIONAL in Obsidian's API, so possibly absent. */
    dir?: string;
    /** The vault adapter's `read`. Async by contract. */
    read(path: string): Promise<string>;
    /** Obsidian's `normalizePath`. */
    normalizePath(path: string): string;
    /** `window.setTimeout`, returning an opaque handle. */
    setTimer(fn: () => void, ms: number): unknown;
    /** `window.clearTimeout`. */
    clearTimer(handle: unknown): void;
    /** The one line emitted when a language has no table at all. */
    log(message: string): void;
    /** Overrides `LOCALE_READ_TIMEOUT_MS`; tests use it, production does not. */
    timeoutMs?: number;
}

/**
 * A locale file is usable only if it parses to a flat `key -> string` object
 * with at least one string value. Non-string values are dropped rather than
 * failing the file, so a future schema addition cannot brick an older plugin;
 * a file with *no* usable string is treated as no file at all.
 */
export function parseLocaleFile(text: string): LocaleEntries | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries: LocaleEntries = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') entries[key] = value;
    }
    return Object.keys(entries).length === 0 ? null : entries;
}

/** Try each candidate in turn; the first usable file wins and is installed. */
async function readFirstUsable(candidates: string[], dir: string, deps: LocaleLoaderDeps): Promise<string | null> {
    for (const code of candidates) {
        let text: string;
        try {
            text = await deps.read(deps.normalizePath(`${dir}/${localeFileName(code)}`));
        } catch {
            continue;
        }
        const entries = parseLocaleFile(text);
        if (entries === null) continue;
        installRuntimeLocale(code, entries);
        return code;
    }
    return null;
}

/** Resolve to `null` if `work` has not settled within the budget. */
function withTimeout(work: Promise<string | null>, deps: LocaleLoaderDeps): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        let settled = false;
        const settle = (value: string | null): void => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const handle = deps.setTimer(() => settle(null), deps.timeoutMs ?? LOCALE_READ_TIMEOUT_MS);
        const finish = (value: string | null): void => {
            deps.clearTimer(handle);
            settle(value);
        };
        work.then(finish, () => finish(null));
    });
}

/**
 * Apply any plugin-folder override for `code` and report which locale is
 * actually in force — an overridden code, a bundled one, or `en`. Never
 * rejects.
 *
 * Resolution order, in full: an override file for the exact code, an override
 * file for its base language, the bundled table for the exact code, the
 * bundled table for its base language, bundled English. The folder chain is
 * walked out entirely before the bundled one, so a dropped `de.json` beats a
 * bundled `de-AT` — "a file a person put there wins" is the whole point of the
 * mechanism, and a half-and-half order would make it unpredictable.
 *
 * The one log line is emitted only when the language has NO table anywhere,
 * bundled or dropped — with every Obsidian language bundled, that is
 * effectively unreachable, which is the point. Having no override file is the
 * normal case and says nothing, and an English interface reads nothing at all:
 * there is no override to look for that English does not already have.
 */
export async function loadRuntimeLocale(code: string, deps: LocaleLoaderDeps): Promise<string> {
    const requested = normalizeLanguageCode(code);
    const candidates = resolveLocaleChain(requested).filter((candidate) => candidate !== BASE_LOCALE);
    if (candidates.length === 0) return BASE_LOCALE;

    const dir = typeof deps.dir === 'string' && deps.dir !== '' ? deps.dir : null;
    let loaded: string | null = null;
    if (dir !== null) {
        try {
            loaded = await withTimeout(readFirstUsable(candidates, dir, deps), deps);
        } catch {
            loaded = null;
        }
    }
    if (loaded !== null) return loaded;

    // No override, or an unusable one. The bundled table is not a fallback
    // here, it is the shipped answer: it is installed, complete, and silent.
    for (const candidate of candidates) {
        if (hasBundledLocale(candidate)) return candidate;
    }

    try {
        deps.log(`no locale file for "${requested}", falling back to "${BASE_LOCALE}"`);
    } catch {
        // A failing log sink is not a reason to fail plugin load.
    }
    return BASE_LOCALE;
}
