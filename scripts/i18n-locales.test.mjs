// The six shipped translations, checked against the English they came from.
//
// `.test.mjs` for the same reason as the other two script tests: this reads
// `src/locales/*.json` and `i18n/strings.csv` off disk, and the shipped
// `src/**/*.ts` are linted with `import/no-nodejs-modules`.
//
// What is deliberately NOT here: a sentence-case check per locale. Sentence
// case is a Latin-script rule that German noun capitalisation legitimately
// breaks, and `sentenceCaseStatus` already reports `skipped` for ja/zh by
// script. Asserting it per locale would fail correct translations.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLocales, GLOSSARY } from "./i18n-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src", "locales");

/** Obsidian's own codes. `zh` IS Simplified Chinese; Traditional is `zh-TW`. */
const SHIPPED = ["en-GB", "de", "fr", "es", "ja", "zh"];
/** en-GB is a spelling variant of en, so it matches on most rows by design. */
const TRANSLATED = SHIPPED.filter((code) => code !== "en-GB");

const en = JSON.parse(readFileSync(join(localesDir, "en.json"), "utf8"));
const enKeys = Object.keys(en);

const read = (code) => {
  try {
    return JSON.parse(readFileSync(join(localesDir, `${code}.json`), "utf8"));
  } catch {
    return null;
  }
};
const locales = Object.fromEntries(SHIPPED.map((code) => [code, read(code)]));

const translationOf = (code, key) => locales[code]?.[key]?.translation;

/** `{name}` placeholders, as a sorted, de-duplicated list. */
function placeholders(text) {
  return [...new Set((text ?? "").match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort();
}

// --- the US -> GB sweep, derived from the data rather than from a hand list --

const US_GB_PAIRS = [
  ["summarize", "summarise"], ["summarizes", "summarises"], ["summarized", "summarised"],
  ["summarizing", "summarising"], ["summarization", "summarisation"],
  ["organize", "organise"], ["organized", "organised"], ["organizes", "organises"],
  ["organizing", "organising"], ["organization", "organisation"],
  ["customize", "customise"], ["customized", "customised"], ["recognize", "recognise"],
  ["analyze", "analyse"], ["normalize", "normalise"], ["initialize", "initialise"],
  ["behavior", "behaviour"], ["behaviors", "behaviours"], ["color", "colour"],
  ["colors", "colours"], ["favorite", "favourite"], ["labor", "labour"], ["honor", "honour"],
  ["license", "licence"], ["licenses", "licences"], ["dialog", "dialogue"],
  ["dialogs", "dialogues"], ["catalog", "catalogue"], ["center", "centre"],
  ["defense", "defence"], ["fulfill", "fulfil"], ["canceled", "cancelled"],
  ["modeling", "modelling"], ["traveling", "travelling"], ["gray", "grey"],
  ["meter", "metre"], ["liter", "litre"], ["offense", "offence"],
];

/** Apply every US -> GB pair to `text`, preserving each occurrence's case. */
function toBritish(text) {
  let out = text;
  for (const [us, gb] of US_GB_PAIRS) {
    out = out.replace(new RegExp(`\\b${us}\\b`, "gi"), (match) =>
      match[0] === match[0].toUpperCase() ? gb[0].toUpperCase() + gb.slice(1) : gb,
    );
  }
  return out;
}

const gbDeltaKeys = enKeys.filter((key) => toBritish(en[key]) !== en[key]);

// --------------------------------------------------------------------------

describe("the shipped locale files", () => {
  it.each(SHIPPED)("%s exists and is readable", (code) => {
    expect(locales[code]).not.toBeNull();
  });

  it.each(SHIPPED)("%s has every en.json key and no extras", (code) => {
    const entries = locales[code] ?? {};
    expect(Object.keys(entries).sort()).toEqual([...enKeys].sort());
  });

  it.each(SHIPPED)("%s has a non-empty translation for every key", (code) => {
    const bare = enKeys.filter((key) => (translationOf(code, key) ?? "").trim() === "");
    expect(bare).toEqual([]);
  });

  it.each(SHIPPED)("%s keeps the exact placeholder set of the English, per key", (code) => {
    const wrong = enKeys
      .filter((key) => placeholders(en[key]).join() !== placeholders(translationOf(code, key)).join())
      .map((key) => `${key}: expected ${placeholders(en[key]).join(" ")}, got ${placeholders(translationOf(code, key)).join(" ")}`);
    expect(wrong).toEqual([]);
  });

  it.each(SHIPPED)("%s preserves every never-translate glossary term, per key", (code) => {
    // Case-insensitive, as TERMS.md states: a locale may follow its own
    // capitalisation around a term, but may not replace the term itself.
    const wrong = [];
    for (const key of enKeys) {
      const translation = (translationOf(code, key) ?? "").toLowerCase();
      for (const term of GLOSSARY) {
        const lower = term.toLowerCase();
        if (en[key].toLowerCase().includes(lower) && !translation.includes(lower)) {
          wrong.push(`${key}: lost "${term}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each(SHIPPED)("%s keeps the mangled product names exactly as the English spells them", (code) => {
    // Known-pending: the shipped English carries `Scrape creators`, `Supa data`
    // and `Tubesage` rather than the canonical product names. Until the
    // maintainer decides, a translation must not quietly "fix" one — and this
    // test is what makes the later one-word-per-locale correction findable.
    const wrong = [];
    for (const mangled of ["Scrape creators", "Supa data", "Tubesage"]) {
      for (const key of enKeys) {
        if (en[key].includes(mangled) && !(translationOf(code, key) ?? "").includes(mangled)) {
          wrong.push(`${key}: lost "${mangled}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each(TRANSLATED)("%s is a real translation, not a copy of the English", (code) => {
    // Some rows legitimately match — `{provider} api key` is nearly a brand
    // string — so this is a bulk guard, not a per-row inequality.
    const differing = enKeys.filter((key) => translationOf(code, key) !== en[key]);
    expect(differing.length).toBeGreaterThan(80);
  });

  it("builds every locale from the authoring matrix, byte for byte", () => {
    const built = buildLocales(readFileSync(join(root, "i18n", "strings.csv"), "utf8"));
    expect(built.languages).toEqual(SHIPPED);
    for (const code of SHIPPED) expect(locales[code]).toEqual(built.locales[code]);
  });
});

describe("en-GB is the British spelling of en, and nothing else", () => {
  it("finds British-variant rows in the English to carry over", () => {
    expect(gbDeltaKeys.length).toBeGreaterThan(0);
  });

  it("differs from en on exactly the rows that contain a US spelling", () => {
    const differing = enKeys.filter((key) => translationOf("en-GB", key) !== en[key]);
    expect(differing.sort()).toEqual([...gbDeltaKeys].sort());
  });

  it("is the English with every US form swapped for its British one", () => {
    const wrong = gbDeltaKeys.filter((key) => translationOf("en-GB", key) !== toBritish(en[key]));
    expect(wrong).toEqual([]);
  });

  it("is byte-identical to en wherever no British variant exists", () => {
    const rest = enKeys.filter((key) => !gbDeltaKeys.includes(key));
    const wrong = rest.filter((key) => translationOf("en-GB", key) !== en[key]);
    expect(wrong).toEqual([]);
  });

  it("carries the British spelling of licence and summarisation specifically", () => {
    expect(translationOf("en-GB", "settings.support.license.label")).toBe("Licence & disclaimer");
    expect(translationOf("en-GB", "settings.llm.provider.desc")).toContain("summarisation");
    expect(translationOf("en-GB", "settings.llm.provider.desc")).not.toContain("summarization");
  });
});
