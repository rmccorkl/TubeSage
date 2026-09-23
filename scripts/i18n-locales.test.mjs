// The shipped translations, checked against the English they came from.
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

/**
 * Obsidian's own codes, in matrix column order — `buildLocales().languages` is
 * `header.slice(3)`, so the order below is asserted, not just the membership.
 * `zh` IS Simplified Chinese; Traditional is `zh-TW`. `no` is Obsidian's code
 * for Norwegian: neither `nb` nor `nn` would ever match `getLanguage()`.
 */
const SHIPPED = [
  "en-GB", "de", "fr", "es", "ja", "zh",
  "it", "pt", "pt-BR", "ca", "gl", "ro", "nl", "da", "no", "sv", "fi",
  "pl", "cs", "sk", "ru", "uk", "be", "bg", "sr", "lv", "hu",
  "ko", "zh-TW", "th", "vi", "id", "ms", "km", "ta", "si",
  "ar", "fa", "he", "am",
  "bn", "ne", "sa", "ka", "kab", "el", "tr", "uz", "sq", "ga",
];
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

describe("neighbouring languages are separate translations, not copies of each other", () => {
  // The "not a copy of the English" test above compares each locale to `en`
  // ONLY, so it would pass a column pasted from its nearest neighbour: `pt-BR`
  // copied from `pt`, or `ca`/`gl` machine-nudged from `es`. Those pairs share
  // vocabulary honestly on some rows — `Temperatura` is `Temperatura` in five
  // of these languages — so this is a bulk floor per pair, not a per-row
  // inequality, exactly like the English guard.
  //
  // `en-GB` is deliberately absent: it IS a derived column, and the block
  // below is what pins it.
  const NEIGHBOURS = [
    ["pt", "pt-BR", 40],
    ["es", "ca", 60],
    ["es", "gl", 60],
    ["ca", "gl", 60],
    ["da", "no", 60],
    ["da", "sv", 60],
    ["no", "sv", 60],
    // Batch 2's sibling pairs. Czech and Slovak, and the three East Slavic
    // languages, are the ones a translator is most tempted to derive from each
    // other by transliteration rather than translate from the English. All four
    // pairs measure 107-108 differing keys out of 113, so a floor of 90 is well
    // clear of the honest overlap and still catches a wholesale copy.
    ["cs", "sk", 90],
    ["ru", "uk", 90],
    ["ru", "be", 90],
    ["uk", "be", 90],
    // Batch 3's two. `zh`/`zh-TW` is the pair most likely to be produced by
    // running a Simplified-to-Traditional character converter over the shipped
    // `zh` column, which is not a translation: Taiwanese usage differs in
    // vocabulary, not only in glyphs, and a converted column would say
    // 視頻/設置/文件 where Taiwan says 影片/設定/檔案. Measured at 111 of 113.
    // `id`/`ms` is the opposite temptation — the two are close enough that a
    // translator may paste one into the other. They coincide honestly on 18
    // rows (Tutup, Templat, Transkrip, the brand-name rows), so the floor sits
    // below the measured 95 rather than at it.
    ["zh", "zh-TW", 90],
    ["id", "ms", 70],
    // Batch 4's one. `ar`/`fa` share the Arabic script, so the script family
    // below cannot tell them apart at all — this floor and the vocabulary and
    // letterform pins underneath it are the whole of what does. The temptation
    // here is not a paste but a transliteration: Persian is written in a
    // near-superset of the Arabic alphabet, so a column mechanically derived
    // from `ar` still looks like Persian at a glance. Measured at 113 of 113 —
    // the two coincide on no row, not even the brand-heavy ones, because each
    // still carries its own connecting prose — so a floor of 95 sits well
    // below the honest figure while still failing a derived column.
    ["ar", "fa", 95],
    // Batch 5's two. `ne` and `sa` share the Devanagari script, so — exactly as
    // with `ar`/`fa` above — the script family below cannot separate them, and
    // this floor plus the vocabulary and morphology pins underneath it are the
    // whole of what does. The pull here is specific: Nepali's technical
    // register is largely Devanagari-spelled English loans (सेटिङ, टेम्प्लेट,
    // टोकन, मोडेल), and reaching for those in `sa` instead of forming Sanskrit
    // words would collapse the two columns without either stopping being
    // Devanagari. Measured at 113 of 113 — they coincide on no row at all — so
    // 95 sits well below the honest figure while still failing a derived column.
    ["ne", "sa", 95],
    // `tr` and `uz` are both Turkic and both Latin-script, so neither the
    // script family nor a glance separates them; the shared suffixes make a
    // machine-derived column look plausible. Measured at 112 of 113. The one
    // genuine coincidence is `settings.llm.model.name`, where both languages
    // spell the possessive `{provider} modeli` — a real cognate, not a copy —
    // which is why the floor is 95 rather than 113.
    ["tr", "uz", 95],
  ];

  it.each(NEIGHBOURS)("%s and %s differ on at least %i keys", (a, b, floor) => {
    const differing = enKeys.filter((key) => translationOf(a, key) !== translationOf(b, key));
    expect(differing.length).toBeGreaterThanOrEqual(floor);
  });

  it("keeps pt and pt-BR apart on the vocabulary that actually splits them", () => {
    // European Portuguese "ficheiro"/"definições" vs Brazilian
    // "arquivo"/"configurações" — the split that makes them two translations.
    expect(translationOf("pt", "settings.templates.templaterFile.name")).toContain("Ficheiro");
    expect(translationOf("pt-BR", "settings.templates.templaterFile.name")).toContain("Arquivo");
    expect(translationOf("pt", "license.required.openSettings")).toContain("definições");
    expect(translationOf("pt-BR", "license.required.openSettings")).toContain("configurações");
  });

  it("keeps zh and zh-TW apart on vocabulary, not merely on Traditional glyphs", () => {
    // The failure this catches is a `zh-TW` column produced by running a
    // character converter over `zh`. Such a column is Traditional and still
    // wrong: each pair below is a word where Taiwan and the Mainland differ in
    // CHOICE OF WORD, so no glyph conversion can turn one into the other.
    // plugin: 外掛 (TW) / 插件 (CN); file: 檔案 / 文件; video: 影片 / 视频.
    expect(translationOf("zh-TW", "license.required.openSettings")).toContain("外掛");
    expect(translationOf("zh", "license.required.openSettings")).toContain("插件");
    expect(translationOf("zh-TW", "settings.templates.templaterFile.name")).toContain("檔案");
    expect(translationOf("zh", "settings.templates.templaterFile.name")).toContain("文件");
    expect(translationOf("zh-TW", "notice.progress.stage.working")).toContain("影片");
    expect(translationOf("zh", "notice.progress.stage.working")).toContain("视频");
  });

  it("keeps id and ms apart on the vocabulary that actually splits them", () => {
    // Indonesian "berkas"/"pengaturan"/"bawaan" against Malay
    // "fail"/"tetapan"/"lalai" — the everyday words that make these two
    // neighbours two translations rather than one with a relabelled column.
    expect(translationOf("id", "settings.templates.templaterFile.name")).toContain("Berkas");
    expect(translationOf("ms", "settings.templates.templaterFile.name")).toContain("Fail");
    expect(translationOf("id", "license.required.openSettings")).toContain("pengaturan");
    expect(translationOf("ms", "license.required.openSettings")).toContain("tetapan");
    expect(translationOf("id", "settings.llm.reservePct.desc")).toContain("bawaan");
    expect(translationOf("ms", "settings.llm.reservePct.desc")).toContain("lalai");
  });

  it("keeps ar and fa apart on the vocabulary that actually splits them", () => {
    // Arabic and Persian are two languages sharing one alphabet, and the
    // everyday words differ even where the script does not: file is ملف in
    // Arabic and فایل in Persian; settings are الإعدادات against تنظیمات;
    // video is الفيديو against ویدیو. None of the three can be reached from
    // the other by changing letterforms, so a `fa` column derived from `ar`
    // fails here however carefully its glyphs were converted.
    expect(translationOf("ar", "settings.templates.templaterFile.name")).toContain("ملف");
    expect(translationOf("fa", "settings.templates.templaterFile.name")).toContain("فایل");
    expect(translationOf("ar", "license.required.openSettings")).toContain("إعدادات");
    expect(translationOf("fa", "license.required.openSettings")).toContain("تنظیمات");
    expect(translationOf("ar", "notice.progress.stage.working")).toContain("الفيديو");
    expect(translationOf("fa", "notice.progress.stage.working")).toContain("ویدیو");
  });

  it("keeps ne and sa apart on the vocabulary that actually splits them", () => {
    // Nepali and Sanskrit are two languages sharing one script, and the
    // everyday technical words differ even where the letters do not. Nepali
    // borrows the English term and spells it in Devanagari; Sanskrit forms its
    // own. None of the Sanskrit forms below can be reached from the Nepali one
    // by respelling, so a `sa` column derived from `ne` fails here however
    // carefully its characters were copied.
    expect(translationOf("ne", "settings.templates.templaterFile.name")).toContain("फाइल");
    expect(translationOf("sa", "settings.templates.templaterFile.name")).toContain("सञ्चिका");
    expect(translationOf("ne", "settings.llm.contextWindow.name")).toContain("कन्टेक्स्ट विन्डो");
    expect(translationOf("sa", "settings.llm.contextWindow.name")).toContain("सन्दर्भगवाक्षः");
    expect(translationOf("ne", "notice.progress.stage.working")).toContain("भिडियो");
    expect(translationOf("sa", "notice.progress.stage.working")).toContain("चलचित्र");
  });

  it("writes sa in Sanskrit nominal morphology rather than Nepali's", () => {
    // The other half of the same failure, and the half a vocabulary pin cannot
    // see: a column that swapped the nouns but kept Nepali sentence shapes.
    // Classical Sanskrit inflects, so its nominatives and neuters end in
    // visarga `ः` or `म्` at a rate modern Nepali prose simply does not reach —
    // this is the structural analogue of the fa ی/ک letterform pin, and it is
    // what a loanword-substituted fake column fails. Currently 52 of 113 `sa`
    // rows carry a visarga against 4 in `ne`, and 38 carry `म्` against 19.
    const visarga = (code) => enKeys.filter((key) => (translationOf(code, key) ?? "").includes("ः")).length;
    const neuter = (code) => enKeys.filter((key) => (translationOf(code, key) ?? "").includes("म्")).length;
    expect(visarga("sa"), "sa must inflect: visarga endings are the marker").toBeGreaterThanOrEqual(35);
    expect(visarga("sa")).toBeGreaterThan(visarga("ne"));
    expect(neuter("sa")).toBeGreaterThan(neuter("ne"));
  });

  it("writes el with word-final sigma, never the medial form", () => {
    // Greek has two lowercase sigmas — medial σ and final ς — and the rule is
    // purely positional. A find-and-replace, or a paste from a source that
    // normalised the letter, leaves σ at the end of a word: correct-looking to
    // anyone not reading Greek, and wrong to everyone who is. Cheap to assert,
    // invisible to review, so it is asserted.
    const wrong = enKeys
      .filter((key) => /\u03C3(?![\p{L}])/u.test(translationOf("el", key) ?? ""))
      .map((key) => `${key}: ${translationOf("el", key)}`);
    expect(wrong, "el must write a word-final sigma as ς, not σ").toEqual([]);
    // And the converse, so this reads as a positional rule rather than a ban on
    // one letter: ς genuinely appears, on 76 rows at the time of writing.
    expect(enKeys.filter((key) => (translationOf("el", key) ?? "").includes("ς")).length).toBeGreaterThanOrEqual(50);
  });

  it("writes uz in the Latin orthography Obsidian's own table gives it", () => {
    // Uzbek is written in both Latin and Cyrillic, and this table follows the
    // same precedent `locales.ts` records for `sr`: the native name in
    // Obsidian's own translation table — `oʻzbekcha` — settles which. That
    // name also fixes the orthography, because `oʻ` and `gʻ` are spelled with
    // U+02BB MODIFIER LETTER TURNED COMMA, not an ASCII apostrophe and not a
    // curly quote. The three render similarly and sort differently, so the
    // substitution is exactly the kind of silent defect a test should hold.
    const turned = enKeys.filter((key) => (translationOf("uz", key) ?? "").includes("\u02BB"));
    expect(turned.length, "uz must spell oʻ/gʻ with U+02BB").toBeGreaterThanOrEqual(30);
    const wrong = enKeys
      .filter((key) => /[\u2018\u2019`]|(?<=[og])'/iu.test(translationOf("uz", key) ?? ""))
      .map((key) => `${key}: ${translationOf("uz", key)}`);
    expect(wrong, "uz must not use an ASCII or curly apostrophe for oʻ/gʻ").toEqual([]);
    // Cyrillic would be the other legitimate Uzbek orthography, and is not the
    // one this table chose — so it must not appear at all.
    expect(enKeys.filter((key) => /\p{Script=Cyrillic}/u.test(translationOf("uz", key) ?? ""))).toEqual([]);
  });

  it("writes fa in Persian letterforms rather than Arabic ones", () => {
    // The other half of the same failure, and the half a vocabulary pin cannot
    // see: a transliteration that got the words right but was typed on an
    // Arabic keyboard. Persian orthography uses ی (U+06CC) and ک (U+06A9) and
    // never the Arabic ي (U+064A) or ك (U+0643) — the shapes render almost
    // identically in many fonts, so this is invisible to review and trivial
    // for a test. Currently 95 of 113 `fa` rows carry U+06CC and 55 carry
    // U+06A9; the Arabic pair appears on none.
    const arabicOnly = enKeys.filter((key) => /[\u064A\u0643]/u.test(translationOf("fa", key) ?? ""));
    expect(arabicOnly, "fa must use Persian ی/ک, never Arabic ي/ك").toEqual([]);
    const persian = enKeys.filter((key) => /[\u06CC\u06A9]/u.test(translationOf("fa", key) ?? ""));
    expect(persian.length).toBeGreaterThanOrEqual(80);
    // And the converse, so the pair reads as a contrast rather than a ban:
    // Arabic legitimately uses the letters Persian does not.
    const arabic = enKeys.filter((key) => /[\u064A\u0643]/u.test(translationOf("ar", key) ?? ""));
    expect(arabic.length).toBeGreaterThanOrEqual(50);
  });
});

describe("the Cyrillic locales are written in Cyrillic, and the brand names are not", () => {
  // Two failures live here, and they pull in opposite directions.
  //
  // One is a locale that is nominally Cyrillic but was filled in with Latin
  // text — a transliteration, or a column pasted from a Latin-script sibling.
  // The "not a copy of the English" guard would not see it.
  //
  // The other is a translator transliterating a brand: Обсидиан, Ютуб. The
  // glossary check above already fails that, but only on the rows whose
  // English carries the term, and it fails with a message about a missing
  // substring rather than about script. Asserting the Latin spelling directly
  // on a Cyrillic row is what makes the intent legible.
  //
  // `sr` is here deliberately. Obsidian's table has a single Serbian code with
  // no script subtag, so one script had to be chosen for it; this is where
  // that choice — Cyrillic, following the `српски језик` native name in
  // Obsidian's own language table — is pinned rather than left to drift.
  const CYRILLIC = ["ru", "uk", "be", "bg", "sr"];
  const hasCyrillic = (text) => /\p{Script=Cyrillic}/u.test(text);

  it.each(CYRILLIC)("%s writes its prose in Cyrillic", (code) => {
    // Rows that are pure brand string or pure placeholder legitimately carry no
    // Cyrillic at all, so this is a bulk floor like the others, not per-row.
    const cyrillic = enKeys.filter((key) => hasCyrillic(translationOf(code, key)));
    expect(cyrillic.length).toBeGreaterThanOrEqual(100);
  });

  it.each(CYRILLIC)("%s keeps Obsidian and YouTube in Latin script", (code) => {
    // Both names are glossary terms whose English row is unambiguous, so the
    // expected spelling is the English one, letter for letter.
    expect(translationOf(code, "settings.llm.apiKey.desc.cloud")).toContain("Obsidian");
    expect(translationOf(code, "license.required.step1")).toContain("Obsidian");
    expect(translationOf(code, "settings.transcripts.youtubeApiKey.name")).toContain("YouTube");
  });

  it("writes Serbian in Cyrillic rather than Latin", () => {
    // The specific regression: `sr` refilled from a Latin-script Serbian or
    // from a neighbouring Latin Slavic language. `Затвори` is Cyrillic
    // Serbian; `Zatvori` is the Latin spelling of the very same word, so this
    // distinguishes script from vocabulary.
    expect(translationOf("sr", "common.close")).toBe("Затвори");
    expect(hasCyrillic(translationOf("sr", "settings.templates.heading"))).toBe(true);
  });
});

describe("each non-Latin locale is written in its own script, and the brand names are not", () => {
  // The same two opposing failures the Cyrillic block above describes, for the
  // six scripts batch 3 adds. The first — a column filled with Latin text, or
  // romanised rather than translated — is invisible to the "not a copy of the
  // English" guard, because a romanisation is not a copy. The second is a
  // translator transliterating a brand: 유튜브, 유튜브, ยูทูบ, யூடியூப். The glossary
  // check catches that one already, but only on the rows whose English carries
  // the term and with a message about a missing substring rather than about
  // script, so asserting the Latin spelling on a non-Latin row is what makes
  // the intent legible.
  //
  // `vi`, `id` and `ms` are deliberately absent: all three are written in the
  // Latin alphabet, so there is no script to assert. What keeps them honest is
  // the difference-floor pair and the vocabulary pins above.
  //
  // Batch 4 extends the same family. `ar` and `fa` BOTH resolve to `Arabic`,
  // which is the point rather than an oversight: the script property cannot
  // distinguish Persian from Arabic, so this block pins only that neither was
  // romanised, and the vocabulary and letterform pins above are what keep the
  // two columns apart. `am` is Ethiopic and, unlike its three batch-mates, is
  // written LEFT TO RIGHT — it is grouped with them by batch, not by direction.
  const SCRIPTS = [
    ["ko", "Hangul"],
    ["zh-TW", "Han"],
    ["th", "Thai"],
    ["km", "Khmer"],
    ["ta", "Tamil"],
    ["si", "Sinhala"],
    ["ar", "Arabic"],
    ["fa", "Arabic"],
    ["he", "Hebrew"],
    ["am", "Ethiopic"],
    // Batch 5 extends the same family. `ne` and `sa` BOTH resolve to
    // `Devanagari`, for the same reason `ar` and `fa` both resolve to `Arabic`:
    // the script property cannot tell one language from the other, so this
    // block pins only that neither was romanised, and the vocabulary and
    // morphology pins above are what keep the two columns apart. `kab`, `tr`,
    // `uz`, `sq` and `ga` are deliberately absent — all five are written in the
    // Latin alphabet, so there is no script to assert, and their difference
    // floors and orthography pins are what keep them honest.
    ["bn", "Bengali"],
    ["ne", "Devanagari"],
    ["sa", "Devanagari"],
    ["ka", "Georgian"],
    ["el", "Greek"],
  ];

  it.each(SCRIPTS)("%s writes its prose in %s", (code, script) => {
    // A bulk floor, like the Cyrillic one: a row that is pure brand string or
    // pure placeholder could legitimately carry none of its own script. All six
    // currently measure 113 of 113, so 100 leaves room for such a row to appear
    // without leaving room for a romanised column.
    const inScript = new RegExp(`\\p{Script=${script}}`, "u");
    const written = enKeys.filter((key) => inScript.test(translationOf(code, key) ?? ""));
    expect(written.length).toBeGreaterThanOrEqual(100);
  });

  it.each(SCRIPTS)("%s keeps Obsidian and YouTube in Latin script", (code) => {
    expect(translationOf(code, "settings.llm.apiKey.desc.cloud")).toContain("Obsidian");
    expect(translationOf(code, "license.required.step1")).toContain("Obsidian");
    expect(translationOf(code, "settings.transcripts.youtubeApiKey.name")).toContain("YouTube");
  });

  it("writes zh-TW in Traditional characters rather than Simplified", () => {
    // The specific regression: a `zh-TW` column left as, or refilled from, the
    // Simplified `zh` one. Each character below is Simplified-only, so finding
    // any of them in `zh-TW` means the conversion never happened — and the
    // vocabulary pins above are what catch the opposite error, a conversion
    // that happened but was mistaken for a translation.
    for (const simplified of ["设", "视", "频", "档", "关", "开", "译", "笔"]) {
      const found = enKeys.filter((key) => (translationOf("zh-TW", key) ?? "").includes(simplified));
      expect(found, `zh-TW carries the Simplified character ${simplified}`).toEqual([]);
    }
    expect(translationOf("zh-TW", "common.close")).toBe("關閉");
    expect(translationOf("zh", "common.close")).toBe("关闭");
  });
});

describe("every locale quotes its own accept-toggle label in the licence steps", () => {
  // `license.required.step5` tells the user to flip a toggle by name. The name
  // it quotes has to be the one this locale actually renders on that toggle —
  // `settings.support.license.acceptLabel` — or the instruction points at a
  // control the user cannot find. The English itself is the known-wrong case
  // (it quotes "Accept License" while the label reads "Accept license &
  // disclaimer"), which is why this checks the locales rather than `en`.
  const TRANSLATED_ONLY = SHIPPED.filter((code) => code !== "en-GB");

  it.each(TRANSLATED_ONLY)("%s quotes its own acceptLabel in step 5", (code) => {
    const label = translationOf(code, "settings.support.license.acceptLabel");
    expect(translationOf(code, "license.required.step5")).toContain(label);
  });
});

describe("the plugin's own command name survives every translation", () => {
  // `notice.progress.message` quotes this plugin's command, which Obsidian
  // lists untranslated in the command palette. A locale that translated it
  // would name a command the user cannot search for.
  it.each(SHIPPED)("%s leaves \"Show active jobs\" in English", (code) => {
    expect(translationOf(code, "notice.progress.message")).toContain("Show active jobs");
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

describe("values the plugin parses or matches survive translation verbatim", () => {
  // The near-miss this exists for: a batch localised `0.10` to `0,10` in
  // `settings.llm.reservePct.desc`, following its locale's decimal comma. The
  // comma is correct prose and wrong data — `setting-definitions.ts` reads that
  // field with `parseFloat`, and `parseFloat("0,10") === 0`, so the description
  // would have named a value the plugin cannot accept. It was caught by review,
  // and nothing in the suite would have caught it. This is that something.
  //
  // The class is wider than the one instance: the context-window and max-output
  // descriptions carry exemplar numbers for `parseInt` fields, and the batches
  // still to come (`ar`, `fa`, `bn`, `ne`, `sa`) are exactly the locales whose
  // scripts have their own digits — Eastern Arabic `٠.١٠`, Devanagari `०.१०` —
  // and whose translator is most likely to convert them. So the sweep below is
  // derived from the English rather than from a hand list of the known cases.
  //
  // TWO TIERS, and a later batch needs to be able to tell them apart. Most
  // swept rows carry a value something consumes: `0.10`, `400` and `128` are
  // read by `parseFloat`/`parseInt`, and `2.5` is part of the model identifier
  // `gemini-2.5-flash`. Two rows are NOT — `scrapeCreatorsApiKey.desc`'s `100`
  // (free requests) and `timestampLinks.infoTooltip`'s `12` (percent) are prose
  // numbers with no consumer. They are swept anyway, because one broad rule
  // derived from the English beats a hand list that rots. But if `ar`, `fa` or
  // `bn` fails on one of THOSE two rows, that is a numeral convention to
  // discuss, not the parseFloat bug — whereas a failure on any other row is.
  //
  // Deliberately NOT swept: a digit with `%` attached. Fifteen shipped locales
  // write `10 %` and `12 %` with a space, which is that typography's rule and
  // is prose, not a value anything parses. The regex matches the digit run
  // only, so the space is none of this test's business.

  /** An ASCII numeric run: `0.10`, `400`, `128`, `2.5`, `0`, `1`. */
  const NUMERIC_LITERAL = /\d+(?:\.\d+)?/g;
  const numeralsOf = (text) => [...new Set((text ?? "").match(NUMERIC_LITERAL) ?? [])];

  /** Every English row that carries one, found rather than listed. */
  const numeralKeys = enKeys.filter((key) => numeralsOf(en[key]).length > 0);

  it("finds the English rows that carry a numeric literal", () => {
    // If a future edit drops every number out of the English, the sweep below
    // would pass vacuously. This is what stops that.
    expect(numeralKeys.length).toBeGreaterThanOrEqual(5);
    expect(numeralKeys).toContain("settings.llm.reservePct.desc");
    expect(numeralKeys).toContain("settings.llm.contextWindow.desc");
    expect(numeralKeys).toContain("settings.llm.maxOutput.desc");
  });

  it.each(SHIPPED)("%s keeps every numeric literal in ASCII digits, spelled as the English spells it", (code) => {
    const wrong = [];
    for (const key of numeralKeys) {
      const translation = translationOf(code, key) ?? "";
      for (const literal of numeralsOf(en[key])) {
        if (!translation.includes(literal)) {
          wrong.push(
            `${key}: lost the literal "${literal}" — this number is machine-parsed ` +
            `(the token-limit fields are read with parseFloat/parseInt) or names a value ` +
            `the user types, so a localised decimal separator or a non-ASCII numeral ` +
            `describes a value the plugin cannot accept. Got: ${translation}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each(SHIPPED)("%s writes the reserve percentage as 0.10, never 0,10", (code) => {
    // The specific regression, asserted directly: `parseFloat("0,10") === 0`,
    // so a decimal comma here would document a reserve of zero.
    const translation = translationOf(code, "settings.llm.reservePct.desc") ?? "";
    expect(translation, `${code} must keep parseFloat-readable 0.10`).toContain("0.10");
    expect(translation, `${code} must not use a decimal comma in a parseFloat value`).not.toContain("0,10");
  });

  it.each([["ar", "Arabic-Indic"], ["fa", "Persian"], ["am", "Ethiopic"]])(
    "%s writes every digit in ASCII, never %s numerals",
    (code) => {
      // Batch 3's sweep above is an `includes` check for each literal the
      // English carries, and that leaves a hole this closes. `reservePct.desc`
      // yields the literals `0.10` and `10`, and `"0.10"` CONTAINS `"10"` as a
      // substring — so a row reading `(0.10 = ١٠٪، …)`, with the percentage in
      // Arabic-Indic digits and only the parseFloat value left in ASCII, walks
      // straight through it. So would any non-ASCII numeral on a row whose
      // English carries no number at all.
      //
      // The three locales here are the shipped ones whose scripts have digits
      // of their own — Arabic-Indic ٠١٢ (U+0660–U+0669), Persian ۰۱۲
      // (U+06F0–U+06F9) and Ethiopic ፩፪፫ (U+1369–U+137C) — plus the Arabic
      // decimal separator ٫ (U+066B) and thousands separator ٬ (U+066C), which
      // are the `0,10` mistake wearing a different glyph. `he` is absent: the
      // Hebrew numerals are letters, so there is no digit range to forbid
      // without forbidding the alphabet.
      //
      // This is an absence check rather than a presence one, which is why it
      // sweeps every key instead of only the numeric rows.
      const OWN_NUMERALS = /[\u0660-\u0669\u06F0-\u06F9\u066B\u066C\u1369-\u137C]/u;
      const wrong = enKeys
        .filter((key) => OWN_NUMERALS.test(translationOf(code, key) ?? ""))
        .map((key) => `${key}: ${translationOf(code, key)}`);
      expect(
        wrong,
        `${code} must write digits and decimal separators in ASCII: the token-limit ` +
        `fields are read with parseFloat/parseInt, and a localised numeral names a ` +
        `value the plugin cannot accept`,
      ).toEqual([]);
    },
  );

  it.each(SHIPPED)("%s writes every digit in ASCII, never its own script's numerals", (code) => {
    // The same absence check the batch 4 block above performs for `ar`, `fa`
    // and `am`, but DERIVED rather than hand-listed, because a hand list rots:
    // batch 4's names three locales, and `th`, `km`, `ta` and `si` have had
    // numeral sets of their own since batch 3 without ever being covered.
    // `\p{Nd}` is every Unicode decimal digit, so subtracting ASCII `0-9`
    // leaves exactly "a digit that is not the digit the plugin can parse" —
    // Bengali ০১২ (U+09E6–09EF), Devanagari ०१२ (U+0966–096F), Thai, Khmer,
    // Tamil and the rest, named by none of them.
    //
    // Why this exists at all, rather than trusting the presence sweep above:
    // that sweep is `translation.includes(literal)`, `reservePct.desc` yields
    // the literals `0.10` AND `10`, and the string `"0.10"` CONTAINS `"10"`.
    // So a row keeping `0.10` ASCII while localising the percentage to a native
    // numeral satisfies both presence checks and walks straight through. A
    // presence check can always be satisfied by a shadowing occurrence inside a
    // longer literal; it needs a companion absence check, and this is it.
    //
    // This does NOT replace the batch 4 test above, and must not be merged into
    // it: Ethiopic ፩፪፫ is `\p{No}`, not `\p{Nd}`, so this regex does not see
    // it, and the Arabic separators ٫ ٬ are punctuation rather than digits.
    // The two are a union, and dropping either loses real coverage.
    //
    // An absence check rather than a presence one, so it sweeps every key
    // rather than only the rows whose English carries a number.
    const NON_ASCII_DIGIT = /(?=\p{Nd})[^0-9]/u;
    const wrong = enKeys
      .filter((key) => NON_ASCII_DIGIT.test(translationOf(code, key) ?? ""))
      .map((key) => `${key}: ${translationOf(code, key)}`);
    expect(
      wrong,
      `${code} must write every digit in ASCII: the token-limit fields are read ` +
      `with parseFloat/parseInt, and a localised numeral names a value the ` +
      `plugin cannot accept`,
    ).toEqual([]);
  });

  it("has locales whose scripts carry digits of their own, so the sweep is not vacuous", () => {
    // The sweep above passes trivially if no shipped locale is written in a
    // script that HAS its own numerals — which would make it dead weight rather
    // than a guard. These eight are the ones at real risk.
    for (const code of ["bn", "ne", "sa", "th", "km", "ta", "si", "ar"]) {
      expect(SHIPPED, `${code} must be shipped for the digit sweep to mean anything`).toContain(code);
    }
    // And the regex must actually fire on the thing it is written to catch.
    expect(/(?=\p{Nd})[^0-9]/u.test("০১২")).toBe(true);
    expect(/(?=\p{Nd})[^0-9]/u.test("०१२")).toBe(true);
    expect(/(?=\p{Nd})[^0-9]/u.test("0.10 = 10%")).toBe(false);
  });

  it.each(SHIPPED)("%s keeps the aiza marker in the YouTube API key placeholder", (code) => {
    // The placeholder tells the user how to recognise the key they must paste;
    // the real prefix is `AIza`, and the field is matched against it, so the
    // marker is a value rather than a word. Case-insensitive: a locale may
    // capitalise around it, but may not translate or transliterate it.
    const translation = translationOf(code, "settings.transcripts.youtubeApiKey.placeholder") ?? "";
    expect(
      /aiza/i.test(translation),
      `${code} lost the literal "aiza" prefix marker, which is matched rather than read: ${translation}`,
    ).toBe(true);
  });

  it("keeps the date-format option labels out of the matrix, as literal pattern tokens", () => {
    // These are the third member of the class and the only one with no locale
    // row: TERMS.md puts them under "Not in the matrix at all" because each
    // label displays the literal pattern tokens of the value it sets, and a
    // translated token would describe a format the plugin does not accept.
    // So the guard is that they are STILL literals — a later commit routing
    // them through `t()` would reopen exactly the hole this block closes.
    const source = readFileSync(join(root, "src", "settings", "setting-definitions.ts"), "utf8");
    for (const [value, label] of [
      ["YYYY-MM-DD", "Yyyy-mm-dd"],
      ["MM-DD-YYYY", "Mm-dd-yyyy"],
      ["DD-MM-YYYY", "Dd-mm-yyyy"],
    ]) {
      expect(source, `the ${value} option label must stay a literal`).toContain(`'${value}': '${label}'`);
    }
    const localisable = enKeys.filter((key) => /Yyyy-mm-dd|Mm-dd-yyyy|Dd-mm-yyyy/i.test(en[key]));
    expect(localisable, "a date-format pattern token reached the translation matrix").toEqual([]);
  });
});
