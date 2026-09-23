#!/usr/bin/env node
// CI gate. Fails when the matrix, en.json, a locale file, the flat bundle
// artifact for that locale, and the code that calls t() have drifted apart: a
// missing key, an orphan key any of several ways, a locale whose `original`
// no longer matches en.json, an empty translation, a never-translate
// glossary term that was translated anyway, or a flat file that no longer
// matches the paired translations it was generated from.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLocales, scanKeysUsedInCode } from "./i18n-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src", "locales");
const flatDir = join(localesDir, "flat");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const en = readJson(join(localesDir, "en.json"));
const locales = {};
for (const file of readdirSync(localesDir)) {
    if (!file.endsWith(".json") || file === "en.json") continue;
    locales[file.slice(0, -".json".length)] = readJson(join(localesDir, file));
}

const flat = {};
if (existsSync(flatDir)) {
    for (const file of readdirSync(flatDir)) {
        if (!file.endsWith(".json")) continue;
        flat[file.slice(0, -".json".length)] = readJson(join(flatDir, file));
    }
}

/** main.ts plus every shipped module under src/, tests excluded. */
const sources = [{ path: "main.ts", text: readFileSync(join(root, "main.ts"), "utf8") }];
const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts") && !entry.includes(".test.")) sources.push({ path: full, text: readFileSync(full, "utf8") });
    }
};
walk(join(root, "src"));

const matrix = join(root, "i18n", "strings.csv");
const problems = checkLocales({
    csvText: existsSync(matrix) ? readFileSync(matrix, "utf8") : undefined,
    en,
    locales,
    flat,
    keysUsedInCode: scanKeysUsedInCode(sources),
});

if (problems.length > 0) {
    for (const problem of problems) console.error(`${problem.code}: ${problem.message}`);
    console.error(`\ni18n:check — ${problems.length} problem(s)`);
    process.exit(1);
}
console.log(`i18n:check — ${Object.keys(en).length} keys, ${Object.keys(locales).length} translated locale(s), no problems`);
