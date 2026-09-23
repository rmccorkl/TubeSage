import { afterEach, describe, expect, it } from "vitest";
import {
    BASE_LOCALE,
    currentLanguage,
    normalizeLanguageCode,
    resolveLocaleChain,
    setLanguageResolver,
    substitute,
    t,
    translate,
} from "./index";
import type { LocaleTable } from "./index";
import { LOCALES, clearRuntimeLocales, installRuntimeLocale } from "./locales";
import { isLatinScript, sentenceCaseStatus } from "./script";
import EN from "../locales/en.json";
// The generated flat translations live at the repo root and are what
// `locales.ts` statically imports into the bundle. Importing them here too
// lets an assertion compare the live table against the file by identity.
import DE_FLAT from "../../locales/de.json";

// A synthetic table, for the fallback chain: `pt`/`pt-BR` are deliberately
// codes the real table does not carry, so a chain assertion tests
// `translate()` itself rather than the current translation set.
const TABLE: LocaleTable = {
    en: { greet: "Hello", only: "English only", param: "Hello {name}" },
    pt: { greet: "Olá", param: "Olá {name}" },
    "pt-BR": { greet: "Oi" },
};

afterEach(() => {
    setLanguageResolver(null);
    // Symmetric with installRuntimeLocale(): an override installed by one case
    // must not survive into the next, where it would look like a flake. Every
    // bundled locale is restored, not deleted.
    clearRuntimeLocales();
});

describe("normalizeLanguageCode", () => {
    it("canonicalises to Obsidian's spelling: lower language, upper region", () => {
        expect(normalizeLanguageCode("pt-br")).toBe("pt-BR");
        expect(normalizeLanguageCode("ZH-tw")).toBe("zh-TW");
        expect(normalizeLanguageCode("EN")).toBe("en");
    });

    it("treats an empty or blank code as the base locale", () => {
        expect(normalizeLanguageCode("")).toBe(BASE_LOCALE);
        expect(normalizeLanguageCode("   ")).toBe(BASE_LOCALE);
    });
});

describe("resolveLocaleChain — exact, then base, then en", () => {
    it("walks pt-BR to pt to en", () => {
        expect(resolveLocaleChain("pt-BR")).toEqual(["pt-BR", "pt", "en"]);
    });

    it("walks a base code straight to en", () => {
        expect(resolveLocaleChain("pt")).toEqual(["pt", "en"]);
    });

    it("never repeats en", () => {
        expect(resolveLocaleChain("en")).toEqual(["en"]);
        expect(resolveLocaleChain("en-GB")).toEqual(["en-GB", "en"]);
    });

    it("treats an unknown, empty or malformed code as resolvable to en", () => {
        expect(resolveLocaleChain("")).toEqual(["en"]);
        expect(resolveLocaleChain("  ")).toEqual(["en"]);
        expect(resolveLocaleChain("qq")).toEqual(["qq", "en"]);
    });

    it("is case-insensitive about the region subtag, as getLanguage() codes are", () => {
        expect(resolveLocaleChain("pt-br")).toEqual(["pt-BR", "pt", "en"]);
        expect(resolveLocaleChain("ZH-tw")).toEqual(["zh-TW", "zh", "en"]);
    });
});

describe("translate — resolution over a table", () => {
    it("prefers the exact locale", () => {
        expect(translate(TABLE, "pt-BR", "greet")).toBe("Oi");
    });

    it("falls back to the base language when the exact locale lacks the key", () => {
        expect(translate(TABLE, "pt-BR", "param", { name: "Ana" })).toBe("Olá Ana");
    });

    it("falls back to English when neither the exact code nor its base has the key", () => {
        expect(translate(TABLE, "pt-BR", "only")).toBe("English only");
    });

    it("falls back to English for an entirely unknown language", () => {
        expect(translate(TABLE, "zz", "greet")).toBe("Hello");
    });

    it("treats an empty string in a locale as absent and keeps falling back", () => {
        const table: LocaleTable = { en: { greet: "Hello" }, de: { greet: "" } };
        expect(translate(table, "de", "greet")).toBe("Hello");
    });

    it("returns the English string for a missing key — never the raw key", () => {
        // The contract the brief names: an absent translation must surface the
        // English text. A raw key reaching the UI is what i18n:check prevents.
        expect(translate(TABLE, "de", "greet")).toBe("Hello");
        expect(translate(TABLE, "de", "greet")).not.toBe("greet");
    });

    it("returns the key only when English has no such key either — the case i18n:check forbids", () => {
        expect(translate(TABLE, "en", "settings.nowhere")).toBe("settings.nowhere");
    });
});

describe("substitute — parameters only, never sentence assembly", () => {
    it("replaces every occurrence of a named placeholder", () => {
        expect(substitute("{a} and {a} and {b}", { a: "x", b: "y" })).toBe("x and x and y");
    });

    it("stringifies numbers plainly, with no locale-sensitive number formatting", () => {
        expect(substitute("Current value: {value}", { value: 0.7 })).toBe("Current value: 0.7");
        expect(substitute("{n}", { n: 1234567 })).toBe("1234567");
    });

    it("leaves an unsupplied placeholder intact rather than inserting undefined", () => {
        expect(substitute("Hello {name}", {})).toBe("Hello {name}");
        expect(substitute("Hello {name}")).toBe("Hello {name}");
    });

    it("does not treat a substituted value as a template", () => {
        expect(substitute("{a}", { a: "{b}" })).toBe("{b}");
    });
});

describe("t — the shipped helper", () => {
    it("reads the language through the injected resolver on every call, never a cached one", () => {
        let lang = "en";
        setLanguageResolver(() => lang);
        expect(currentLanguage()).toBe("en");
        lang = "pt-BR";
        expect(currentLanguage()).toBe("pt-BR");
    });

    it("defaults to en when no resolver has been installed", () => {
        expect(currentLanguage()).toBe(BASE_LOCALE);
    });

    it("falls back to en when the resolver throws or answers with nothing usable", () => {
        setLanguageResolver(() => {
            throw new Error("no app");
        });
        expect(currentLanguage()).toBe(BASE_LOCALE);
        setLanguageResolver(() => "");
        expect(currentLanguage()).toBe(BASE_LOCALE);
    });

    it("resolves a real shipped key against the shipped table", () => {
        expect(t("settings.transcripts.rootFolder.name")).toBe("Transcript root folder");
    });

    it("substitutes parameters into a real shipped key", () => {
        expect(t("settings.llm.apiKey.name", { provider: "OpenAI" })).toBe("OpenAI api key");
        expect(t("settings.llm.modelParams.headingOverride", { provider: "OPENAI" })).toBe("Model parameters (OPENAI) — override");
    });
});

describe("the locale table", () => {
    it("ships en as the base locale", () => {
        expect(Object.keys(LOCALES)).toContain(BASE_LOCALE);
        expect(LOCALES.en).toBe(EN);
    });

    it("serves Khmer under both kh and km, because the two sources disagree", () => {
        // Obsidian's published table says `km`; the 1.12.7 binary's own
        // language map says `kh` and has no `km` at all. Whichever a supported
        // install emits, `t()` must answer in Khmer rather than fall through to
        // English. Same object, not a copy: a copy could drift.
        expect(LOCALES.kh).toBe(LOCALES.km);
    });

    it("bundles every translated locale, because a locale FILE never reaches a catalogue install", () => {
        // The inversion of #8: Obsidian's installer downloads only main.js,
        // manifest.json and styles.css, so a translation that is not compiled
        // into main.js is a translation nobody sees. Growing main.js is the
        // price of the coverage, and it is the only mechanism that delivers it.
        expect(Object.keys(LOCALES).sort()).toEqual([
            "am", "ar", "be", "bg", "bn", "ca", "cs", "da", "de",
            "el", "en", "en-GB", "es", "fa", "fi", "fr", "ga", "gl",
            "he", "hu", "id", "it", "ja", "ka", "kab", "kh", "km", "ko",
            "lv", "ms", "ne", "nl", "no", "pl", "pt", "pt-BR", "ro",
            "ru", "sa", "si", "sk", "sq", "sr", "sv", "ta", "th",
            "tr", "uk", "uz", "vi", "zh", "zh-TW",
        ]);
    });

    it("answers in the language itself for every bundled code, whatever case it arrives in", () => {
        // The failure this exists for is silent: a bundled locale whose code
        // never matches what `getLanguage()` returns falls through to English
        // and nothing reports it — which is exactly how Italian was missing.
        // `pt-BR` and `zh-TW` are the sharp cases: with `en-GB` they are the
        // only codes carrying a region subtag, and `LOCALES['zh-TW']` is an
        // exact-key lookup, so if `translate` did not canonicalise, a `zh-tw`
        // from Obsidian would ship dead. `zh-TW` also exercises the fallback
        // rung — it must answer in Traditional Chinese rather than sliding
        // down to the Simplified `zh` that happens to sit under it.
        for (const code of Object.keys(LOCALES)) {
            if (code === BASE_LOCALE) continue;
            for (const spelling of [code, code.toLowerCase(), code.toUpperCase()]) {
                expect(normalizeLanguageCode(spelling), spelling).toBe(code);
                expect(translate(LOCALES, spelling, "common.close"), spelling).toBe(LOCALES[code]["common.close"]);
            }
        }
    });

    it("falls from pt-BR to pt before English, and the two are different translations", () => {
        // Both Portuguese variants ship, so the regional chain has a real
        // middle rung: a key thin in pt-BR would land on European Portuguese,
        // not on English.
        expect(resolveLocaleChain("pt-br")).toEqual(["pt-BR", "pt", BASE_LOCALE]);
        const key = "settings.templates.templaterFile.name";
        expect(translate(LOCALES, "pt", key)).not.toBe(translate(LOCALES, "pt-BR", key));
    });

    it("holds the generated file's own object, with no flattening step at load time", () => {
        // The generated file is already `key -> string`, so the table holds
        // the imported file itself rather than something computed at lookup
        // time from the paired src/locales/de.json. No install needed: this is
        // the bundled table, straight from the static import.
        expect(LOCALES.de).toBe(DE_FLAT);
    });

    it("lets a plugin-folder override displace a bundled translation", () => {
        installRuntimeLocale("de", { "settings.templates.heading": "Vorlagen (override)" });
        expect(LOCALES.de["settings.templates.heading"]).toBe("Vorlagen (override)");
        expect(LOCALES.de).not.toBe(DE_FLAT);
    });

    it("restores the bundled translation when the override is cleared", () => {
        installRuntimeLocale("de", { "settings.templates.heading": "Vorlagen (override)" });
        clearRuntimeLocales();
        expect(LOCALES.de).toBe(DE_FLAT);
    });

    it("refuses to let an override displace the bundled English fallback", () => {
        installRuntimeLocale(BASE_LOCALE, { "settings.templates.heading": "Hijacked" });
        expect(LOCALES.en).toBe(EN);
    });

    it("gives every bundled locale the full key set of en", () => {
        // `zh` IS Simplified Chinese in Obsidian's table; Traditional is `zh-TW`.
        const enKeys = Object.keys(LOCALES.en).sort();
        for (const code of Object.keys(LOCALES)) {
            expect(Object.keys(LOCALES[code]).sort(), `${code} key set`).toEqual(enKeys);
        }
    });
});

describe("t() over the bundled translations", () => {
    const sample = "settings.templates.heading";

    it("renders a bundled key in each translated locale, not in English", () => {
        for (const code of ["de", "fr", "es", "ja", "zh"]) {
            setLanguageResolver(() => code);
            expect(t(sample), `${code} ${sample}`).toBe(LOCALES[code][sample]);
            expect(t(sample), `${code} ${sample}`).not.toBe(LOCALES.en[sample]);
        }
    });

    it("substitutes parameters into a translated string", () => {
        setLanguageResolver(() => "de");
        const rendered = t("settings.llm.apiKey.name", { provider: "OpenAI" });
        expect(rendered).toContain("OpenAI");
        expect(rendered).not.toContain("{provider}");
    });

    it("falls back through an unbundled regional code to its base language", () => {
        setLanguageResolver(() => "de-AT");
        expect(t(sample)).toBe(LOCALES.de[sample]);
    });

    it("falls back to English for a locale that is not bundled", () => {
        // `qq`, not a real language code. This case used to name a language
        // that simply had not been translated yet, which made it a test with an
        // expiry date: bundling Korean turned it red, though the assertion it
        // was making — unbundled resolves to English — had not changed at all.
        // `qq` is the unassigned code this file already uses for exactly that
        // job in `resolveLocaleChain`, so no batch can ever bundle it out from
        // under this test. (`locale-loader.test.ts` picks `zxx` for its own
        // version of this problem; the reasoning there is the same.)
        setLanguageResolver(() => "qq");
        expect(t(sample)).toBe(LOCALES.en[sample]);
    });
});

// --- the shipped English -------------------------------------------------

const EN_ENTRIES: [string, string][] = Object.entries(EN as Record<string, string>);

describe("the shipped en.json", () => {
    it("has no empty value and no value that is merely its own key", () => {
        for (const [key, value] of EN_ENTRIES) {
            expect(value, `${key} is empty`).not.toBe("");
            expect(value, `${key} is its own key`).not.toBe(key);
        }
    });

    it("namespaces every key by area", () => {
        // The areas, in the order they arrived: the settings tab and the
        // licence dialog (#4 phase 1), shared words used by both, and the
        // floating job notices (#7). A new area belongs in this list
        // deliberately — the point is that a key cannot be coined outside one.
        for (const [key] of EN_ENTRIES) {
            expect(key, `${key} is not namespaced`).toMatch(/^(settings|license|common|notice)\.[A-Za-z0-9.]+$/);
        }
    });

    it("uses US spelling throughout the base English — en-GB carries the British variants", () => {
        const british = /\b\w*(?:ise|ised|ises|ising|isation|isations|iour|iours)\b|\blicence\b|\bcentre\b|\bcatalogue\b|\bwhilst\b|\bfavour\w*\b|\bcolour\w*\b/i;
        for (const [key, value] of EN_ENTRIES) {
            expect(british.test(value), `${key} contains a British spelling: ${value}`).toBe(false);
        }
    });

    it("builds no sentence by concatenation: every parameter is a named placeholder", () => {
        for (const [key, value] of EN_ENTRIES) {
            for (const match of value.matchAll(/\{([^}]*)\}/g)) {
                expect(match[1], `${key} has a placeholder that is not a plain name`).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
            }
        }
    });
});

describe("sentence case is a Latin-script rule", () => {
    it("recognises Latin-script text", () => {
        expect(isLatinScript("Transcript root folder")).toBe(true);
        expect(isLatinScript("Übersetzungssprache")).toBe(true);
        expect(isLatinScript("Model parameters (OPENAI) — override")).toBe(true);
        expect(isLatinScript("0.10 = 10%")).toBe(true);
    });

    it("recognises text that is not Latin script", () => {
        expect(isLatinScript("文字起こしのルートフォルダ")).toBe(false);
        expect(isLatinScript("转录根文件夹")).toBe(false);
        expect(isLatinScript("전사 루트 폴더")).toBe(false);
        expect(isLatinScript("Язык перевода")).toBe(false);
    });

    it("flags Title Case in Latin script", () => {
        expect(sentenceCaseStatus("Transcript Root Folder")).toBe("violation");
        expect(sentenceCaseStatus("transcript root folder")).toBe("violation");
    });

    it("accepts sentence case, brand names and acronyms in Latin script", () => {
        expect(sentenceCaseStatus("Transcript root folder")).toBe("ok");
        expect(sentenceCaseStatus("YouTube data API key")).toBe("ok");
        expect(sentenceCaseStatus("OpenRouter api key")).toBe("ok");
        expect(sentenceCaseStatus("Model parameters (OPENAI)")).toBe("ok");
    });

    it("never judges a placeholder, whose case belongs to the substituted value", () => {
        expect(sentenceCaseStatus("{provider} api key")).toBe("ok");
        expect(sentenceCaseStatus("{provider} model")).toBe("ok");
        expect(sentenceCaseStatus("Model parameters ({provider}) — override")).toBe("ok");
        // A real Title Case word after a placeholder is still a violation.
        expect(sentenceCaseStatus("{provider} Api Key")).toBe("violation");
    });

    it("is a no-op outside Latin script — never a mechanical case transform", () => {
        expect(sentenceCaseStatus("文字起こしのルートフォルダ")).toBe("skipped");
        expect(sentenceCaseStatus("转录根文件夹")).toBe("skipped");
        expect(sentenceCaseStatus("전사 루트 폴더")).toBe("skipped");
        // Mixed: a CJK string carrying a Latin brand name is still skipped.
        expect(sentenceCaseStatus("YouTube データ API キー")).toBe("skipped");
    });

    it("applies to every name-like key of the shipped English", () => {
        for (const [key, value] of EN_ENTRIES) {
            if (!/\.(name|heading|label|title)$/.test(key)) continue;
            expect(sentenceCaseStatus(value), `${key}: "${value}" is not sentence case`).not.toBe("violation");
        }
    });
});
