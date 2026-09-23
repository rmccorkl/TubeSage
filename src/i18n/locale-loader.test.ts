import { afterEach, describe, expect, it } from "vitest";
import { BASE_LOCALE, setLanguageResolver, t } from "./index";
import { BUNDLED_LOCALES, LOCALES, clearRuntimeLocales, installRuntimeLocale } from "./locales";
// The bundled German, imported the way `locales.ts` imports it, so that
// "degraded to the BUNDLED locale" can be asserted by identity rather than by
// a string that might coincidentally match.
import DE_BUNDLED from "../../locales/de.json";
import {
    LOCALE_READ_TIMEOUT_MS,
    loadRuntimeLocale,
    localeFileName,
    parseLocaleFile,
} from "./locale-loader";
import type { LocaleLoaderDeps } from "./locale-loader";

// A key that really exists in the bundled English, so that a "did the runtime
// table actually take effect?" assertion is about the shipped lookup path and
// not about a synthetic key that `t()` would echo back either way.
const KEY = "settings.templates.heading";

interface Timer {
    fn: () => void;
    ms: number;
    cleared: boolean;
}

interface Harness {
    deps: LocaleLoaderDeps;
    reads: string[];
    lines: string[];
    timers: Timer[];
    /** Fire the timer the loader armed, as a hung read eventually would. */
    fire(): void;
}

const PLUGIN_DIR = "plugins/tubesage";

/** A read that never settles. Its own type, so the union stays discriminable. */
const HANG = { wedged: true } as const;
type Wedged = typeof HANG;

/**
 * `files` maps a plugin-folder-relative name to what the adapter does: a
 * string resolves as file contents, an Error rejects (absent or unreadable),
 * and `HANG` never settles — the case the timeout exists for.
 *
 * `dir` is read with `in` rather than a default: `manifest.dir` being genuinely
 * `undefined` is one of the cases under test, and both a default parameter and
 * a destructuring default would silently substitute a path for it.
 */
function harness(files: Record<string, string | Error | Wedged>, options: { dir?: string } = {}): Harness {
    const dir = "dir" in options ? options.dir : PLUGIN_DIR;
    const reads: string[] = [];
    const lines: string[] = [];
    const timers: Timer[] = [];
    const deps: LocaleLoaderDeps = {
        dir,
        read(path: string): Promise<string> {
            reads.push(path);
            const name = path.slice(path.lastIndexOf("/") + 1);
            const entry = files[name];
            if (entry === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
            if (entry instanceof Error) return Promise.reject(entry);
            // Whatever is left that is not file contents is HANG: never settles.
            if (typeof entry !== "string") return new Promise<string>(() => undefined);
            return Promise.resolve(entry);
        },
        normalizePath: (path: string) => path.replace(/\/+/g, "/"),
        setTimer(fn: () => void, ms: number): unknown {
            timers.push({ fn, ms, cleared: false });
            return timers.length - 1;
        },
        clearTimer(handle: unknown): void {
            const timer = timers[handle as number];
            if (timer !== undefined) timer.cleared = true;
        },
        log(message: string): void {
            lines.push(message);
        },
    };
    return {
        deps,
        reads,
        lines,
        timers,
        fire(): void {
            for (const timer of timers) if (!timer.cleared) timer.fn();
        },
    };
}

const GERMAN = JSON.stringify({ [KEY]: "Vorlagen (Harness)" });

// `de` is a bundled language and `zxx` is not. Every case below picks one
// deliberately: `de` exercises "degrade to the bundled table", `zxx` exercises
// the only path left that can reach English.
//
// `zxx` — ISO 639-2 for "no linguistic content" — rather than a real language:
// this constant used to be `it`, which went red the moment Italian was
// bundled, and every remaining batch of #4 would retire the next candidate the
// same way. `zxx` names no UI language, so Obsidian will never return it from
// `getLanguage()` and no batch can ever bundle it, which keeps the
// fall-to-English path testable after all 51 languages ship.
const BUNDLED_CODE = "de";
const UNBUNDLED_CODE = "zxx";

afterEach(() => {
    setLanguageResolver(null);
    clearRuntimeLocales();
});

describe("localeFileName — the plugin-folder-relative name of a locale file", () => {
    it("is the canonical code plus .json, flat, with no directory part", () => {
        expect(localeFileName("de")).toBe("de.json");
        expect(localeFileName("pt-br")).toBe("pt-BR.json");
        expect(localeFileName("de")).not.toContain("/");
    });
});

describe("parseLocaleFile — what counts as a usable locale file", () => {
    it("accepts a flat key -> string object and keeps only string values", () => {
        expect(parseLocaleFile('{"a":"x","b":2,"c":"y"}')).toEqual({ a: "x", c: "y" });
    });

    it("rejects malformed JSON, a non-object, and an object with no string values", () => {
        expect(parseLocaleFile("{not json")).toBeNull();
        expect(parseLocaleFile('["a","b"]')).toBeNull();
        expect(parseLocaleFile('"a string"')).toBeNull();
        expect(parseLocaleFile("null")).toBeNull();
        expect(parseLocaleFile('{"a":2}')).toBeNull();
    });
});

describe("loadRuntimeLocale — an override file wins over the bundled table", () => {
    it("reads <manifest.dir>/<code>.json and installs it over the bundled locale", async () => {
        const h = harness({ "de.json": GERMAN });
        await expect(loadRuntimeLocale(BUNDLED_CODE, h.deps)).resolves.toBe("de");
        expect(h.reads).toEqual(["plugins/tubesage/de.json"]);
        setLanguageResolver(() => "de");
        // The bundled German says something else for this key; the dropped
        // file is what `t()` answers with. That precedence IS the mechanism.
        expect(t(KEY)).toBe("Vorlagen (Harness)");
        expect(t(KEY)).not.toBe(DE_BUNDLED[KEY]);
        expect(h.lines).toEqual([]);
    });

    it("clears the timeout timer once the read wins, leaving no handle armed", async () => {
        const h = harness({ "de.json": GERMAN });
        await loadRuntimeLocale("de", h.deps);
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].cleared).toBe(true);
        expect(h.timers[0].ms).toBe(LOCALE_READ_TIMEOUT_MS);
    });

    it("falls from a regional code with no override file to its base language file", async () => {
        const h = harness({ "de.json": GERMAN });
        await expect(loadRuntimeLocale("de-AT", h.deps)).resolves.toBe("de");
        expect(h.reads).toEqual(["plugins/tubesage/de-AT.json", "plugins/tubesage/de.json"]);
        expect(h.lines).toEqual([]);
    });

    it("prefers the exact regional file over the base language one", async () => {
        const h = harness({ "de-AT.json": JSON.stringify({ [KEY]: "Vorlagen (AT)" }), "de.json": GERMAN });
        await expect(loadRuntimeLocale("de-AT", h.deps)).resolves.toBe("de-AT");
        expect(h.reads).toEqual(["plugins/tubesage/de-AT.json"]);
    });

    it("walks the whole override chain before consulting the bundled table", async () => {
        // A dropped `de.json` beats a bundled `de-AT` would-be match: the
        // folder chain is exhausted first, because "a file a person put there
        // wins" is the point and a half-and-half order would be unpredictable.
        const h = harness({ "de.json": GERMAN });
        await expect(loadRuntimeLocale("de-AT", h.deps)).resolves.toBe("de");
    });

    it("never reads and never speaks when the interface language is already English", async () => {
        const h = harness({ "de.json": GERMAN });
        await expect(loadRuntimeLocale("en", h.deps)).resolves.toBe(BASE_LOCALE);
        expect(h.reads).toEqual([]);
        expect(h.lines).toEqual([]);
        expect(h.timers).toEqual([]);
    });
});

describe("loadRuntimeLocale — no override file is the DEFAULT, not a fallback", () => {
    it("resolves a bundled language to itself, in silence, when no file is there", async () => {
        const h = harness({});
        await expect(loadRuntimeLocale(BUNDLED_CODE, h.deps)).resolves.toBe("de");
        // Not a fallback and not worth a word: this is what a catalogue
        // install looks like every single time it loads.
        expect(h.lines).toEqual([]);
        setLanguageResolver(() => "de");
        expect(t(KEY)).toBe(DE_BUNDLED[KEY]);
    });

    it("resolves a bundled REGIONAL language to itself, in silence", async () => {
        const h = harness({});
        await expect(loadRuntimeLocale("en-GB", h.deps)).resolves.toBe("en-GB");
        expect(h.lines).toEqual([]);
    });

    it("leaves the bundled table exactly as the code shipped it", async () => {
        const h = harness({});
        await loadRuntimeLocale(BUNDLED_CODE, h.deps);
        expect(LOCALES.de).toBe(BUNDLED_LOCALES.de);
    });
});

/** The six ways an override read can fail, for one language code. */
function failureCases(code: string): [string, () => Harness][] {
    const file = `${code}.json`;
    return [
        ["the file is absent", () => harness({})],
        ["the file is unreadable", () => harness({ [file]: new Error("EACCES") })],
        ["the file is malformed JSON", () => harness({ [file]: "{ not json" })],
        ["the file is JSON but not a flat string table", () => harness({ [file]: '["nope"]' })],
        ["manifest.dir is undefined", () => harness({ [file]: GERMAN }, { dir: undefined })],
        ["manifest.dir is the empty string", () => harness({ [file]: GERMAN }, { dir: "" })],
    ];
}

describe("loadRuntimeLocale — a broken override degrades to the BUNDLED locale, not to English", () => {
    // Factories, not instances: each case gets a fresh harness per assertion,
    // so no read, log line or installed table leaks between them.
    const cases = failureCases(BUNDLED_CODE);

    it.each(cases)("resolves to the bundled de when %s", async (_label, make) => {
        const h = make();
        await expect(loadRuntimeLocale(BUNDLED_CODE, h.deps)).resolves.toBe("de");
        expect(LOCALES.de).toBe(BUNDLED_LOCALES.de);
    });

    it.each(cases)("says nothing when %s, because German is still in force", async (_label, make) => {
        const h = make();
        await loadRuntimeLocale(BUNDLED_CODE, h.deps);
        expect(h.lines).toEqual([]);
    });

    it("degrades a PARTLY failed override chain to the bundled base language", async () => {
        // The one case where the two walks have to compose: the exact code has
        // an override file and it is unusable, the base language has none at
        // all, and the bundled table carries the base. `readFirstUsable` must
        // walk past the malformed de-AT.json AND the absent de.json, and the
        // bundled walk must then answer `de` — not English, and not a word.
        const h = harness({ "de-AT.json": "{ not json" });
        await expect(loadRuntimeLocale("de-AT", h.deps)).resolves.toBe("de");
        expect(h.reads).toEqual(["plugins/tubesage/de-AT.json", "plugins/tubesage/de.json"]);
        expect(h.lines).toEqual([]);
        setLanguageResolver(() => "de-AT");
        expect(t(KEY)).toBe(DE_BUNDLED[KEY]);
    });

    it("keeps the bundled German answering t() after a failed override read", async () => {
        const h = harness({ "de.json": "{ not json" });
        await loadRuntimeLocale(BUNDLED_CODE, h.deps);
        setLanguageResolver(() => "de");
        expect(t(KEY)).toBe(DE_BUNDLED[KEY]);
        expect(t(KEY)).not.toBe(LOCALES.en[KEY]);
    });
});

describe("loadRuntimeLocale — English is reached only when NOTHING is bundled for the language", () => {
    // `it` is not in the matrix yet, so it is the one shape that can still
    // reach English. Once all 51 languages are bundled this is unreachable
    // in production — which is the point of bundling them.
    const cases = failureCases(UNBUNDLED_CODE);

    it.each(cases)("resolves to en when %s", async (_label, make) => {
        const h = make();
        await expect(loadRuntimeLocale(UNBUNDLED_CODE, h.deps)).resolves.toBe(BASE_LOCALE);
        expect(LOCALES[UNBUNDLED_CODE]).toBeUndefined();
    });

    it.each(cases)("logs exactly one line naming the requested code and the fallback when %s", async (_label, make) => {
        const h = make();
        await loadRuntimeLocale(UNBUNDLED_CODE, h.deps);
        expect(h.lines).toEqual([`no locale file for "${UNBUNDLED_CODE}", falling back to "en"`]);
    });

    it("does not touch the adapter at all when manifest.dir is undefined", async () => {
        const h = harness({ [`${UNBUNDLED_CODE}.json`]: GERMAN }, { dir: undefined });
        await loadRuntimeLocale(UNBUNDLED_CODE, h.deps);
        expect(h.reads).toEqual([]);
    });

    it("keeps English answering t() for a language with no table anywhere", async () => {
        const h = harness({});
        await loadRuntimeLocale(UNBUNDLED_CODE, h.deps);
        setLanguageResolver(() => UNBUNDLED_CODE);
        expect(t(KEY)).toBe(LOCALES.en[KEY]);
    });

    it("survives a log sink that throws, because onload must not see an exception", async () => {
        const h = harness({});
        h.deps.log = () => {
            throw new Error("the log sink blew up");
        };
        await expect(loadRuntimeLocale(UNBUNDLED_CODE, h.deps)).resolves.toBe(BASE_LOCALE);
    });
});

describe("loadRuntimeLocale — a hung adapter cannot hang plugin load", () => {
    it("abandons the read when the timer fires and degrades to the bundled locale", async () => {
        const h = harness({ "de.json": HANG });
        const pending = loadRuntimeLocale(BUNDLED_CODE, h.deps);
        expect(h.timers).toHaveLength(1);
        h.fire();
        await expect(pending).resolves.toBe("de");
        expect(h.lines).toEqual([]);
    });

    it("falls all the way to English on a timeout when nothing is bundled", async () => {
        const h = harness({ [`${UNBUNDLED_CODE}.json`]: HANG });
        const pending = loadRuntimeLocale(UNBUNDLED_CODE, h.deps);
        expect(h.timers).toHaveLength(1);
        h.fire();
        await expect(pending).resolves.toBe(BASE_LOCALE);
        expect(h.lines).toEqual([`no locale file for "${UNBUNDLED_CODE}", falling back to "en"`]);
    });

    it("arms the timer with a short, explicit budget rather than waiting forever", () => {
        expect(LOCALE_READ_TIMEOUT_MS).toBeGreaterThan(0);
        expect(LOCALE_READ_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    });

    it("honours an overridden timeout budget", async () => {
        const h = harness({ [`${UNBUNDLED_CODE}.json`]: HANG });
        h.deps.timeoutMs = 7;
        const pending = loadRuntimeLocale(UNBUNDLED_CODE, h.deps);
        expect(h.timers[0].ms).toBe(7);
        h.fire();
        await expect(pending).resolves.toBe(BASE_LOCALE);
    });
});

describe("clearRuntimeLocales — restores the table the code shipped", () => {
    it("removes an override for a language that is not bundled", async () => {
        const h = harness({ [`${UNBUNDLED_CODE}.json`]: GERMAN });
        await loadRuntimeLocale(UNBUNDLED_CODE, h.deps);
        expect(LOCALES[UNBUNDLED_CODE]).toBeDefined();
        clearRuntimeLocales();
        expect(LOCALES[UNBUNDLED_CODE]).toBeUndefined();
    });

    it("restores a bundled translation an override had displaced", async () => {
        const h = harness({ "de.json": GERMAN });
        await loadRuntimeLocale(BUNDLED_CODE, h.deps);
        expect(LOCALES.de).not.toBe(BUNDLED_LOCALES.de);
        clearRuntimeLocales();
        expect(LOCALES.de).toBe(BUNDLED_LOCALES.de);
    });

    it("leaves the full bundled set standing, not English alone", () => {
        installRuntimeLocale(UNBUNDLED_CODE, { [KEY]: "Modelli" });
        clearRuntimeLocales();
        expect(Object.keys(LOCALES).sort()).toEqual(Object.keys(BUNDLED_LOCALES).sort());
        expect(Object.keys(LOCALES)).toContain(BASE_LOCALE);
    });
});
