// Tests for the pure half of the i18n tooling. `.test.mjs` on purpose:
// tsconfig.json includes only `**/*.ts`, so a `.ts` test importing this `.mjs`
// lib would drag it into `tsc -noEmit` under allowJs for no benefit.
import { describe, expect, it } from "vitest";
import {
  GLOSSARY,
  buildLocales,
  checkLocales,
  flattenTranslations,
  formatCsv,
  parseCsv,
  scanKeysUsedInCode,
} from "./i18n-lib.mjs";

const CSV = formatCsv(
  ["key", "context", "en", "de"],
  [
    ["settings.a.name", "Row label", "Transcript root folder", "Transkript-Stammordner"],
    ["settings.a.desc", "", "Where notes go", "Wohin Notizen gehen"],
  ],
);

describe("parseCsv / formatCsv — the authoring matrix round-trips byte-exactly", () => {
  it("preserves a trailing space, an em dash, an ellipsis, apostrophes and embedded quotes", () => {
    const rows = [
      ["a", "trailing space is deliberate", "Example "],
      ["b", "", "Model parameters (OPENAI) — override"],
      ["c", "", "…and help seed a bigger vision: technology that serves people and planet.."],
      ["d", "", "Required: this model isn't in the registry — set context window."],
      ["e", 'a comma, and a "quote"', 'He said "no", loudly'],
      ["f", "", "line one\nline two"],
    ];
    const round = parseCsv(formatCsv(["key", "context", "en"], rows));
    expect(round.header).toEqual(["key", "context", "en"]);
    expect(round.rows).toEqual(rows);
  });

  it("rejects a matrix whose rows do not all have the header's width", () => {
    expect(() => parseCsv("key,context,en\na,b\n")).toThrow(/column/i);
  });
});

describe("buildLocales — matrix to locale JSON", () => {
  it("emits en as key -> string and every other language as key -> { original, translation }", () => {
    const built = buildLocales(CSV);
    expect(built.en).toEqual({
      "settings.a.name": "Transcript root folder",
      "settings.a.desc": "Where notes go",
    });
    expect(built.locales.de["settings.a.name"]).toEqual({
      original: "Transcript root folder",
      translation: "Transkript-Stammordner",
    });
  });

  it("carries the context column through as a comment-free side channel, not into the locale files", () => {
    const built = buildLocales(CSV);
    expect(JSON.stringify(built.en)).not.toContain("Row label");
    expect(built.context["settings.a.name"]).toBe("Row label");
  });

  it("refuses a duplicate key", () => {
    const dup = formatCsv(["key", "context", "en"], [["k", "", "one"], ["k", "", "two"]]);
    expect(() => buildLocales(dup)).toThrow(/duplicate/i);
  });
});

describe("scanKeysUsedInCode", () => {
  it("finds t('key') and t(\"key\") calls and ignores identifiers that merely end in t", () => {
    const found = scanKeysUsedInCode([
      { path: "a.ts", text: "name: t('settings.a.name'), desc: t(\"settings.a.desc\")" },
      { path: "b.ts", text: "parseInt('10'); format('x'); list.at('0'); obj.t('not.a.key')" },
    ]);
    expect(found).toEqual(new Set(["settings.a.name", "settings.a.desc"]));
  });

  it("finds a key passed with substitution parameters", () => {
    const found = scanKeysUsedInCode([{ path: "a.ts", text: "t('settings.llm.model.name', { provider: displayName })" }]);
    expect(found).toEqual(new Set(["settings.llm.model.name"]));
  });
});

describe("flattenTranslations — the paired form reduced to the bundle's lookup form", () => {
  it("keeps only the translation of each { original, translation } pair", () => {
    expect(
      flattenTranslations({
        "a.name": { original: "Folder", translation: "Ordner" },
        "a.desc": { original: "Where", translation: "Wo" },
      }),
    ).toEqual({ "a.name": "Ordner", "a.desc": "Wo" });
  });

  it("preserves key order", () => {
    const flat = flattenTranslations({
      z: { original: "Z", translation: "zed" },
      a: { original: "A", translation: "ay" },
    });
    expect(Object.keys(flat)).toEqual(["z", "a"]);
  });
});

// --- the CI gate ---------------------------------------------------------

const EN = { "settings.a.name": "Transcript root folder", "settings.a.desc": "Where notes go" };
const DE = {
  "settings.a.name": { original: "Transcript root folder", translation: "Transkript-Stammordner" },
  "settings.a.desc": { original: "Where notes go", translation: "Wohin Notizen gehen" },
};
const DE_FLAT = { "settings.a.name": "Transkript-Stammordner", "settings.a.desc": "Wohin Notizen gehen" };

function check(overrides = {}) {
  return checkLocales({
    csvText: CSV,
    en: EN,
    locales: { de: DE },
    keysUsedInCode: new Set(Object.keys(EN)),
    ...overrides,
  });
}

describe("checkLocales — the i18n:check gate", () => {
  it("passes a consistent matrix, en.json, locale and code", () => {
    expect(check()).toEqual([]);
  });

  it("fails on a deliberately stale original", () => {
    const stale = structuredClone(DE);
    stale["settings.a.name"].original = "Transcript root folder (old wording)";
    const problems = check({ locales: { de: stale } });
    expect(problems.map((p) => p.code)).toContain("stale-original");
    expect(problems.find((p) => p.code === "stale-original")).toMatchObject({ locale: "de", key: "settings.a.name" });
  });

  it("fails when a locale is missing a key that en.json has", () => {
    const short = structuredClone(DE);
    delete short["settings.a.desc"];
    expect(check({ locales: { de: short } }).map((p) => p.code)).toContain("missing-in-locale");
  });

  it("fails on an orphan key in a locale — one en.json does not have", () => {
    const extra = structuredClone(DE);
    extra["settings.gone.name"] = { original: "Gone", translation: "Weg" };
    expect(check({ locales: { de: extra } }).map((p) => p.code)).toContain("orphan-in-locale");
  });

  it("fails on an empty translation", () => {
    const blank = structuredClone(DE);
    blank["settings.a.desc"].translation = "";
    expect(check({ locales: { de: blank } }).map((p) => p.code)).toContain("empty-translation");
  });

  it("fails on a key used in code but absent from en.json", () => {
    const used = new Set([...Object.keys(EN), "settings.nowhere.name"]);
    const problems = check({ keysUsedInCode: used });
    expect(problems.map((p) => p.code)).toContain("missing-key-used-in-code");
  });

  it("fails on an en.json key no code ever asks for", () => {
    const used = new Set(["settings.a.name"]);
    expect(check({ keysUsedInCode: used }).map((p) => p.code)).toContain("orphan-key-in-en");
  });

  it("fails when en.json has drifted from the matrix", () => {
    const drifted = { ...EN, "settings.a.desc": "Where the notes go" };
    expect(check({ en: drifted }).map((p) => p.code)).toContain("csv-drift");
  });

  it("fails when a glossary term present in the English is missing from the translation", () => {
    const en = { "settings.b.desc": "Get a free key at ScrapeCreators." };
    const de = { "settings.b.desc": { original: en["settings.b.desc"], translation: "Holen Sie sich einen Schlüssel bei Schöpferabkratzer." } };
    const problems = checkLocales({
      en,
      locales: { de },
      keysUsedInCode: new Set(["settings.b.desc"]),
    });
    expect(problems.map((p) => p.code)).toContain("glossary-not-preserved");
    expect(problems.find((p) => p.code === "glossary-not-preserved")?.term).toBe("ScrapeCreators");
  });

  it("accepts a translation that keeps the glossary term verbatim, whatever its case in the original", () => {
    const en = { "settings.b.desc": "The Tubesage plugin uses Obsidian." };
    const de = { "settings.b.desc": { original: en["settings.b.desc"], translation: "Das TubeSage-Plugin verwendet Obsidian." } };
    expect(
      checkLocales({ en, locales: { de }, keysUsedInCode: new Set(["settings.b.desc"]) }),
    ).toEqual([]);
  });

  it("lists the never-translate terms the brief names", () => {
    for (const term of ["TubeSage", "Obsidian", "YouTube", "OpenRouter", "ScrapeCreators", "Supadata", "Ollama", "Templater", "OpenAI", "Anthropic", "Google", "Gemini"]) {
      expect(GLOSSARY).toContain(term);
    }
  });
});

// --- the flat bundle artifact: a second drift surface the gate must guard --

describe("checkLocales — the flat translation-only artifact", () => {
  it("passes when the flat file exactly matches the paired translations", () => {
    expect(check({ flat: { de: DE_FLAT } })).toEqual([]);
  });

  it("fails when a flat value has been hand-edited away from the paired translation", () => {
    const corrupted = { ...DE_FLAT, "settings.a.name": "Falscher Ordner" };
    const problems = check({ flat: { de: corrupted } });
    expect(problems.map((p) => p.code)).toContain("flat-stale");
    expect(problems.find((p) => p.code === "flat-stale")).toMatchObject({ locale: "de", key: "settings.a.name" });
  });

  it("fails when the flat file is missing a key the paired file has", () => {
    const short = { ...DE_FLAT };
    delete short["settings.a.desc"];
    expect(check({ flat: { de: short } }).map((p) => p.code)).toContain("flat-missing-key");
  });

  it("fails when the flat file carries a key the paired file does not", () => {
    const extra = { ...DE_FLAT, "settings.gone.name": "Weg" };
    expect(check({ flat: { de: extra } }).map((p) => p.code)).toContain("flat-orphan-key");
  });

  it("fails when a paired locale has no matching flat file", () => {
    expect(check({ flat: {} }).map((p) => p.code)).toContain("flat-missing-locale");
  });

  it("fails when a flat file exists for a locale the paired set no longer has — the one that actually rots", () => {
    const problems = check({ flat: { de: DE_FLAT, it: { "settings.a.name": "Cartella" } } });
    expect(problems.map((p) => p.code)).toContain("flat-orphan-locale");
  });

  it("is skipped entirely when no flat argument is passed — existing callers are unaffected", () => {
    expect(check()).toEqual([]);
  });
});
