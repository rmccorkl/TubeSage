// The two things that can silently break translations for everyone who
// installed TubeSage from Obsidian's catalogue.
//
// ONE: the release tries to distribute locales as assets. Obsidian's community
// installer downloads exactly `main.js`, `manifest.json` and `styles.css` from
// a release and copies those into the plugin folder — nothing else. A locale
// published as a fourth asset is therefore read by nobody, and every
// non-English user silently gets English. That is why issue #8's
// ship-the-files approach was reversed and why these tests pin the published
// set to those three and assert there is no locale asset: re-adding one would
// not fail anything at runtime, it would just quietly stop working.
//
// TWO: `npm run i18n:build` generates a locale file that nothing imports.
// Bundling is now the distribution mechanism, so a generated
// `locales/<code>.json` that `src/i18n/locales.ts` never imported is a
// language that was authored, checked, committed — and ships to no one.
// `npm run i18n:check` cannot see that; it reads files, not imports. The
// table-coverage test below is the gate for it, and the 44 remaining
// languages lean on it.
//
// These tests read the real workflow file and the real locale table rather
// than a second copy of either, so they cannot drift apart without going red.
//
// `.test.mjs` for the same reason as the other script tests: it reads files
// off disk, and the shipped `src/**/*.ts` are linted with
// `import/no-nodejs-modules`.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_LOCALES } from "../src/i18n/locales.ts";
import { buildLocales, flattenTranslations } from "./i18n-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github", "workflows", "release.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** The relative directory `npm run i18n:build` writes the generated files to. */
const GENERATED_DIR = "locales";
const generatedDir = join(root, GENERATED_DIR);

/** The only three files Obsidian's installer downloads from a release. */
const INSTALLED_FILES = ["main.js", "manifest.json", "styles.css"];

/** Everything `gh release create` is handed as an asset, flags removed. */
function publishedAssets(text) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.includes("gh release create"));
    if (start < 0) throw new Error("release.yml has no `gh release create`");
    const collected = [];
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        collected.push(line.replace(/\\\s*$/, ""));
        if (!/\\\s*$/.test(line)) break;
    }
    return collected
        .join(" ")
        .replace(/gh release create\s+"\$tag"/, "")
        .split(/\s+/)
        .filter((token) => token !== "" && !token.startsWith("-"));
}

/** The `subject-path:` block of the attestation step, one path per line. */
function attestedPaths(text) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === "subject-path: |");
    if (start < 0) throw new Error("release.yml has no `subject-path: |` block");
    const indent = lines[start].length - lines[start].trimStart().length;
    const paths = [];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") break;
        if (line.length - line.trimStart().length <= indent) break;
        paths.push(line.trim());
    }
    return paths;
}

const assets = publishedAssets(workflow);
const attested = attestedPaths(workflow);
const extraAssets = assets.filter((token) => !INSTALLED_FILES.includes(token));
const generatedFiles = readdirSync(generatedDir).filter((file) => file.endsWith(".json"));
const generatedCodes = generatedFiles.map((file) => file.slice(0, -".json".length));

describe("the release publishes exactly the three files Obsidian's installer downloads", () => {
    it("publishes main.js, manifest.json and styles.css", () => {
        for (const required of INSTALLED_FILES) {
            expect(assets, `gh release create is missing ${required}`).toContain(required);
        }
    });

    it("publishes NOTHING else — an extra asset is one the installer ignores", () => {
        expect([...assets].sort()).toEqual([...INSTALLED_FILES].sort());
    });

    it("publishes no locale asset: a locale file cannot reach a catalogue install", () => {
        expect(extraAssets).toEqual([]);
        expect(workflow).not.toContain(`${GENERATED_DIR}/`);
    });

    it("attests every asset it publishes, and publishes every asset it attests", () => {
        expect([...assets].sort()).toEqual([...attested].sort());
    });
});

/**
 * Table keys that are a second name for another locale's data, not a locale of
 * their own. `kh` -> `km`: Obsidian's published table spells Khmer `km`, the
 * 1.12.7 binary spells it `kh`, and no 1.13.x binary was available to settle
 * it, so both are served.
 */
const ALIASES = { kh: "km" };

describe("every generated locale is actually bundled — the distribution path", () => {
    it("has the locale table import every generated file, and nothing it did not generate", () => {
        // The gate for the silent failure this design has: a language that is
        // authored, generated and committed but never imported into
        // `src/i18n/locales.ts` ships to nobody, and no file-reading check can
        // see that. `en` is bundled from `src/locales/en.json`, which is not
        // in the generated dir, so it is added here.
        // `kh` is an ALIAS of `km` (see src/i18n/locales.ts), so it is a table
        // key with no generated file of its own and must be named here rather
        // than allowed to widen the equality.
        expect(Object.keys(BUNDLED_LOCALES).sort()).toEqual(["en", ...generatedCodes, ...Object.keys(ALIASES)].sort());
    });

    it("points every alias at the very table it aliases", () => {
        for (const [alias, target] of Object.entries(ALIASES)) {
            expect(BUNDLED_LOCALES[alias], `${alias} must serve ${target}'s table`).toBe(BUNDLED_LOCALES[target]);
        }
    });

    it("bundles the exact contents of each generated file, not a stale copy", () => {
        for (const code of generatedCodes) {
            const generated = JSON.parse(readFileSync(join(generatedDir, `${code}.json`), "utf8"));
            expect(BUNDLED_LOCALES[code], `${code}: bundled table vs generated file`).toEqual(generated);
        }
    });
});

describe("the generated locale set is the matrix's, no more and no less", () => {
    const { locales, languages } = buildLocales(readFileSync(join(root, "i18n", "strings.csv"), "utf8"));

    it("has a generated file for every language in the authoring matrix", () => {
        const missing = languages.filter((code) => !generatedCodes.includes(code));
        expect(missing).toEqual([]);
    });

    it("has no orphan generated file for a language the matrix dropped", () => {
        const orphans = generatedCodes.filter((code) => !languages.includes(code));
        expect(orphans).toEqual([]);
    });

    it("has no stale generated file: each one equals its paired translations", () => {
        const stale = languages.filter((code) => {
            const generated = JSON.parse(readFileSync(join(generatedDir, `${code}.json`), "utf8"));
            return JSON.stringify(generated) !== JSON.stringify(flattenTranslations(locales[code]));
        });
        expect(stale).toEqual([]);
    });

    it("does not generate a flat English file: en.json is the source of truth", () => {
        expect(generatedCodes).not.toContain("en");
    });
});
