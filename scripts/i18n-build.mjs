#!/usr/bin/env node
// Generate src/locales/*.json from the authoring matrix i18n/strings.csv.
// The matrix is the single place a translator edits; the JSON files are
// generated artifacts (committed, because the bundle imports them statically).
//
// Two shapes are emitted per translated locale: the paired
// `src/locales/<code>.json` (`{ original, translation }`, mirroring
// Obsidian's own translation files so `npm run i18n:check` can detect a
// drifted English original), and the flat `locales/<code>.json` at the repo
// root (`key -> translation`) — the BUNDLED form, statically imported by
// `src/i18n/locales.ts` and compiled into `main.js`, which is the only way a
// translation reaches a catalogue install. The same flat shape is what
// `src/i18n/locale-loader.ts` parses when someone drops an override file into
// the plugin folder. `en.json` is already `key -> string` and is imported from
// `src/locales/`, so it has no flat sibling.
//
// Idempotent: running it twice writes the same bytes, and a generated file for
// a language the matrix no longer carries is deleted rather than left to rot
// (`npm run i18n:check` would otherwise fail on the orphan).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocales, flattenTranslations, formatLocaleJson } from "./i18n-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = join(root, "i18n", "strings.csv");
const localesDir = join(root, "src", "locales");
const shippedDir = join(root, "locales");

const { en, locales, languages } = buildLocales(readFileSync(matrix, "utf8"));

mkdirSync(localesDir, { recursive: true });
writeFileSync(join(localesDir, "en.json"), formatLocaleJson(en));
if (languages.length > 0) mkdirSync(shippedDir, { recursive: true });
for (const code of languages) {
    writeFileSync(join(localesDir, `${code}.json`), formatLocaleJson(locales[code]));
    writeFileSync(join(shippedDir, `${code}.json`), formatLocaleJson(flattenTranslations(locales[code])));
}

const pruned = [];
if (existsSync(shippedDir)) {
    for (const file of readdirSync(shippedDir)) {
        if (!file.endsWith(".json")) continue;
        const code = file.slice(0, -".json".length);
        if (languages.includes(code)) continue;
        rmSync(join(shippedDir, file));
        pruned.push(file);
    }
}

const keyCount = Object.keys(en).length;
const built = languages.length > 0 ? ` + ${languages.join(", ")} (paired + bundled locales/)` : "";
console.log(`i18n:build — ${keyCount} keys -> en.json${built}${pruned.length > 0 ? ` — pruned ${pruned.join(", ")}` : ""}`);
