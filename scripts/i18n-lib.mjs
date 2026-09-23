// Pure half of the i18n tooling: CSV matrix <-> locale JSON, plus the gate.
// No filesystem, no process, no console — `i18n-build.mjs` and
// `i18n-check.mjs` are the thin CLIs over this, and the tests drive these
// functions directly with in-memory fixtures (batch A ships only `en`, so a
// stale `original` or a mistranslated glossary term can only be exercised
// against a synthetic locale).

/** Names that must survive translation verbatim. Mirrors i18n/TERMS.md. */
export const GLOSSARY = [
  "TubeSage",
  "Obsidian",
  "YouTube",
  "OpenRouter",
  "ScrapeCreators",
  "Supadata",
  "Ollama",
  "Templater",
  "OpenAI",
  "Anthropic",
  "Google",
  "Gemini",
  "Buy Me A Coffee",
  "README",
];

// --- CSV (RFC 4180) ------------------------------------------------------

const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/;

function quoteField(value) {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render a header and rows as RFC 4180 CSV, LF-terminated. */
export function formatCsv(header, rows) {
  const lines = [header.map(quoteField).join(",")];
  for (const row of rows) lines.push(row.map(quoteField).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Parse RFC 4180 CSV into `{ header, rows }`. Quoted fields keep their
 * leading/trailing whitespace, embedded commas, doubled quotes and newlines
 * exactly — byte-identity of the English is the whole point of the matrix.
 */
export function parseCsv(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  let started = false;

  const endField = () => {
    record.push(field);
    field = "";
    started = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      // Swallow CR; the following LF closes the record.
    } else {
      field += ch;
      started = true;
    }
  }
  if (field !== "" || record.length > 0) endRecord();

  if (records.length === 0) throw new Error("i18n matrix is empty");
  const [header, ...rows] = records;
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new Error(`i18n matrix row ${index + 2} has ${row.length} columns, expected ${header.length}`);
    }
  }
  return { header, rows };
}

// --- matrix -> locale JSON ----------------------------------------------

/**
 * Build the locale payloads from the matrix.
 * `en` is `key -> string`; every other language is `key -> { original,
 * translation }`, mirroring Obsidian's own `original=`/`translation=` pairs so
 * a drifted English original is detectable.
 */
export function buildLocales(csvText) {
  const { header, rows } = parseCsv(csvText);
  if (header[0] !== "key" || header[1] !== "context" || header[2] !== "en") {
    throw new Error(`i18n matrix header must start key,context,en — got ${header.slice(0, 3).join(",")}`);
  }
  const languages = header.slice(3);
  const en = {};
  const context = {};
  const locales = Object.fromEntries(languages.map((code) => [code, {}]));

  for (const row of rows) {
    const key = row[0];
    if (key === "") throw new Error("i18n matrix has a row with an empty key");
    if (key in en) throw new Error(`i18n matrix has a duplicate key: ${key}`);
    en[key] = row[2];
    context[key] = row[1];
    languages.forEach((code, index) => {
      locales[code][key] = { original: row[2], translation: row[3 + index] };
    });
  }
  return { en, context, locales, languages };
}

/** Render a locale payload as the JSON the repo commits (LF-terminated). */
export function formatLocaleJson(payload) {
  return `${JSON.stringify(payload, null, 4)}\n`;
}

/**
 * Reduce a `{ original, translation }` locale payload to `key -> translation`
 * — the flat, translation-only shape the bundle imports. Key order is
 * preserved from the input.
 */
export function flattenTranslations(entries) {
  const flat = {};
  for (const [key, pair] of Object.entries(entries)) flat[key] = pair.translation;
  return flat;
}

// --- key usage -----------------------------------------------------------

// `(?<![\w$.])` keeps `parseInt(`, `format(`, `.at(` and `obj.t(` out: only a
// free-standing `t(` call is a translation lookup.
const T_CALL = /(?<![\w$.])t\(\s*['"]([^'"]+)['"]/g;

/** Collect every key the given sources pass to `t()`. */
export function scanKeysUsedInCode(sources) {
  const keys = new Set();
  for (const { text } of sources) {
    for (const match of text.matchAll(T_CALL)) keys.add(match[1]);
  }
  return keys;
}

// --- the gate ------------------------------------------------------------

/**
 * Check the matrix, en.json, the locale files, the flat translation-only
 * bundle artifacts and the keys the code uses against each other. Returns a
 * list of problems; empty means the gate passes.
 *
 * `flat`, when passed, is `{ [code]: { key: translation } }` — the second
 * generated artifact (`npm run i18n:build`'s `src/locales/flat/<code>.json`)
 * that `locales.ts` actually imports. It must exactly mirror
 * `flattenTranslations(locales[code])`: same locale set, same key set, same
 * values. Omitting `flat` skips this check entirely (existing callers that
 * only care about the paired files are unaffected).
 */
export function checkLocales({ csvText, en, locales = {}, flat, keysUsedInCode, glossary = GLOSSARY }) {
  const problems = [];
  const add = (problem) => problems.push(problem);

  if (csvText !== undefined) {
    const built = buildLocales(csvText).en;
    for (const key of new Set([...Object.keys(built), ...Object.keys(en)])) {
      if (built[key] !== en[key]) {
        add({ code: "csv-drift", key, message: `en.json does not match i18n/strings.csv for ${key}` });
      }
    }
  }

  const enKeys = Object.keys(en);
  for (const [code, entries] of Object.entries(locales)) {
    for (const key of enKeys) {
      const entry = entries[key];
      if (entry === undefined) {
        add({ code: "missing-in-locale", locale: code, key, message: `${code}.json is missing ${key}` });
        continue;
      }
      if (entry.original !== en[key]) {
        add({ code: "stale-original", locale: code, key, message: `${code}.json original for ${key} no longer matches en.json` });
      }
      if (typeof entry.translation !== "string" || entry.translation === "") {
        add({ code: "empty-translation", locale: code, key, message: `${code}.json has no translation for ${key}` });
        continue;
      }
      for (const term of glossary) {
        const lower = term.toLowerCase();
        if (en[key].toLowerCase().includes(lower) && !entry.translation.toLowerCase().includes(lower)) {
          add({ code: "glossary-not-preserved", locale: code, key, term, message: `${code}.json translated the never-translate term "${term}" in ${key}` });
        }
      }
    }
    for (const key of Object.keys(entries)) {
      if (!(key in en)) {
        add({ code: "orphan-in-locale", locale: code, key, message: `${code}.json has ${key}, which en.json does not` });
      }
    }
  }

  if (flat !== undefined) {
    const pairedCodes = Object.keys(locales);
    const flatCodes = Object.keys(flat);
    for (const code of pairedCodes) {
      if (!(code in flat)) {
        add({ code: "flat-missing-locale", locale: code, message: `flat/${code}.json is missing though ${code}.json exists` });
      }
    }
    for (const code of flatCodes) {
      if (!(code in locales)) {
        add({ code: "flat-orphan-locale", locale: code, message: `flat/${code}.json exists but ${code}.json does not — a stale flat file` });
      }
    }
    for (const code of pairedCodes) {
      const flatEntries = flat[code];
      if (flatEntries === undefined) continue;
      const expected = flattenTranslations(locales[code]);
      for (const key of Object.keys(expected)) {
        if (!(key in flatEntries)) {
          add({ code: "flat-missing-key", locale: code, key, message: `flat/${code}.json is missing ${key}` });
          continue;
        }
        if (flatEntries[key] !== expected[key]) {
          add({ code: "flat-stale", locale: code, key, message: `flat/${code}.json value for ${key} does not match ${code}.json's translation` });
        }
      }
      for (const key of Object.keys(flatEntries)) {
        if (!(key in expected)) {
          add({ code: "flat-orphan-key", locale: code, key, message: `flat/${code}.json has ${key}, which ${code}.json does not` });
        }
      }
    }
  }

  if (keysUsedInCode !== undefined) {
    for (const key of keysUsedInCode) {
      if (!(key in en)) add({ code: "missing-key-used-in-code", key, message: `code calls t("${key}") but en.json has no such key` });
    }
    for (const key of enKeys) {
      if (!keysUsedInCode.has(key)) add({ code: "orphan-key-in-en", key, message: `en.json has ${key}, which no code uses` });
    }
  }

  return problems;
}
