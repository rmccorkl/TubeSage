#!/usr/bin/env node
// Generate src/locales/*.json from the authoring matrix i18n/strings.csv.
// The matrix is the single place a translator edits; the JSON files are
// generated artifacts (committed, because the bundle imports them statically).
//
// Two shapes are emitted per translated locale: the paired
// `src/locales/<code>.json` (`{ original, translation }`, mirroring
// Obsidian's own translation files so `npm run i18n:check` can detect a
// drifted English original), and the flat `src/locales/flat/<code>.json`
// (`key -> translation`) that `src/i18n/locales.ts` actually imports into the
// bundle — shipping only the translation, not the duplicated English, per
// key. `en.json` is already `key -> string`; it needs no flat sibling.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocales, flattenTranslations, formatLocaleJson } from "./i18n-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = join(root, "i18n", "strings.csv");
const localesDir = join(root, "src", "locales");
const flatDir = join(localesDir, "flat");

const { en, locales, languages } = buildLocales(readFileSync(matrix, "utf8"));

mkdirSync(localesDir, { recursive: true });
writeFileSync(join(localesDir, "en.json"), formatLocaleJson(en));
if (languages.length > 0) mkdirSync(flatDir, { recursive: true });
for (const code of languages) {
    writeFileSync(join(localesDir, `${code}.json`), formatLocaleJson(locales[code]));
    writeFileSync(join(flatDir, `${code}.json`), formatLocaleJson(flattenTranslations(locales[code])));
}

const keyCount = Object.keys(en).length;
console.log(`i18n:build — ${keyCount} keys -> en.json${languages.length > 0 ? ` + ${languages.join(", ")} (paired + flat)` : ""}`);
