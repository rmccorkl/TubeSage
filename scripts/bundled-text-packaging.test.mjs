// The bug these tests exist for: three informational modals used to read their
// text off disk at runtime, and on a community-store install that text is not
// there. Obsidian's installer downloads exactly `main.js`, `manifest.json` and
// `styles.css` from a release and copies those into the plugin folder —
// nothing else. `scripts/deploy.sh` copies the repo files into a local vault,
// which is why the licence, README and example-template modals looked fine in
// development and said "could not load" for everyone who installed from the
// catalogue.
//
// The fix is the one `src/i18n/locales.ts` already uses for translations:
// generate a committed constant from the real repo file and let the bundle
// carry it. That only stays true if a regeneration that was never run turns
// something red, so the drift gate below compares each constant against its
// source file BYTE FOR BYTE — buffers, not decoded strings, because a decoded
// comparison would survive a BOM or a CRLF normalisation the bundle would then
// ship.
//
// One `describe` per file on purpose: three independently provable gates, not
// one gate that happens to loop. A shared helper that only really covered the
// smallest file would be exactly the failure this is meant to prevent.
//
// `.test.mjs` for the same reason as `i18n-packaging.test.mjs`: it reads files
// off disk, and the shipped `src/**/*.ts` are linted with
// `import/no-nodejs-modules`.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { BUNDLED_TEXTS, renderModule } from "./bundled-text-lib.mjs";
import * as bundled from "../src/bundled/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * An `App` that fails the test the moment anything is read off it. The content
 * sources take no arguments at all — there is no seam to inject a vault
 * through, which is the fix — so this is handed in anyway: if a future change
 * gives one of them a parameter and starts reading from the vault again, the
 * very first property access throws instead of quietly working in development.
 */
const hostileApp = new Proxy(
    {},
    {
        get(_target, property) {
            throw new Error(`a bundled content source read app.${String(property)} — it must touch no vault at all`);
        },
    },
);

/** Anything that would mean "this module goes back to disk at runtime". */
const DISK_ACCESS = [/\bvault\b/, /\badapter\b/, /from\s+['"]obsidian['"]/, /node:fs/, /\brequire\s*\(/];

/**
 * The bundle, built and executed from a directory that holds nothing else: the
 * simulated store install. `main.js` is all an installer copies, so if the text
 * is not reachable from the bundle alone, the user does not get it.
 */
let installed;

beforeAll(async () => {
    const result = await build({
        entryPoints: [join(root, "src", "bundled", "index.ts")],
        bundle: true,
        format: "cjs",
        target: "es2018",
        charset: "utf8",
        write: false,
        logLevel: "silent",
    });
    const installDir = mkdtempSync(join(tmpdir(), "tubesage-store-install-"));
    const installedBundle = join(installDir, "main.cjs");
    writeFileSync(installedBundle, result.outputFiles[0].text);
    installed = createRequire(import.meta.url)(installedBundle);
});

for (const entry of BUNDLED_TEXTS) {
    describe(`${entry.source} reaches a store install`, () => {
        const sourceBytes = readFileSync(join(root, entry.source));
        const accessor = () => bundled[entry.accessor];

        it("is bundled byte for byte — a regeneration that was never run fails here", () => {
            // The whole point of the fix. `templates/YouTubeTranscript.md`,
            // `MIT-license-tubesage.md` and `README.md` remain the single
            // source of truth; edit one without running the generator and this
            // goes red rather than shipping stale text. Buffers, not strings.
            expect(Buffer.from(accessor()(), "utf8")).toEqual(sourceBytes);
        });

        it("has a generated module that is exactly what the generator writes today", () => {
            // Catches the other half of drift: a generated file edited by hand,
            // or written by an older version of the generator.
            const expected = renderModule(entry, readFileSync(join(root, entry.source), "utf8"));
            expect(readFileSync(join(root, entry.module), "utf8")).toBe(expected);
        });

        it("renders with no filesystem access at all", () => {
            expect(accessor().length, "the content source must take nothing — there is no vault to hand it").toBe(0);
            expect(accessor()(hostileApp)).toBe(sourceBytes.toString("utf8"));
        });

        it("has no route back to disk in its source: it is one string literal and nothing else", () => {
            // The guard cannot simply scan the whole file — README.md says
            // "vault" in its own prose, and that prose is the data. So the
            // module is split at its one declaration: the header must name no
            // way of reaching disk, and everything from the declaration on must
            // be a single string literal, which cannot execute anything.
            const moduleText = readFileSync(join(root, entry.module), "utf8");
            const declaration = `export const ${entry.constant} = `;
            const at = moduleText.indexOf(declaration);
            expect(at, `${entry.module} must declare ${entry.constant}`).toBeGreaterThan(-1);
            for (const pattern of DISK_ACCESS) {
                expect(moduleText.slice(0, at), `${entry.module} header matches ${pattern}`).not.toMatch(pattern);
            }
            expect(moduleText.slice(at)).toMatch(/^export const [A-Z_]+ = "(?:[^"\\]|\\.)*";\n$/);
        });

        it("survives into the bundle: a store install with nothing on disk still has the full text", () => {
            expect(Buffer.from(installed[entry.accessor](), "utf8")).toEqual(sourceBytes);
        });
    });
}

describe("the modals go to the bundle, never to disk", () => {
    const mainText = readFileSync(join(root, "main.ts"), "utf8");

    // One `it` per file: naming the path is the only way a modal could look
    // for it again, so this is the regression gate for the original bug. A
    // deliberate change would have to delete the assertion, which is visible
    // in review in a way a quietly reintroduced read is not.
    for (const entry of BUNDLED_TEXTS) {
        it(`main.ts names no path to ${entry.source}`, () => {
            expect(mainText).not.toContain(entry.source);
        });
    }
});

describe("the module the modals import", () => {
    const indexText = readFileSync(join(root, "src", "bundled", "index.ts"), "utf8");

    it("has no route back to disk either", () => {
        for (const pattern of DISK_ACCESS) {
            expect(indexText, `src/bundled/index.ts matches ${pattern}`).not.toMatch(pattern);
        }
    });

    it("exports an accessor for every bundled file and nothing else", () => {
        expect(Object.keys(bundled).sort()).toEqual(BUNDLED_TEXTS.map((entry) => entry.accessor).sort());
    });
});
