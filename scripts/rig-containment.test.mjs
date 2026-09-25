// rig/jev-timestamps/ does not exist yet (it lands in a later task), and this
// test must not depend on it — proof 1 below builds a synthetic temp
// directory instead. Its job is to prove the mechanism (rigGuardPlugin) works
// in isolation, before rig/ ever has real content to protect.
//
// `.test.mjs` for the same reason as bundled-text-packaging.test.mjs and
// main-wiring.test.mjs: it drives esbuild and reads project source as text.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { rigGuardPlugin } from "./rig-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("rigGuardPlugin rejects a leading rig/ path segment", () => {
    // A fresh synthetic project per test run: this proof must hold with no
    // dependency on the real rig/jev-timestamps/, which does not exist yet.
    // realpathSync matters on macOS: os.tmpdir() returns a path under /var,
    // which is a symlink to /private/var, and esbuild reports resolved paths
    // through the symlink. Comparing rootDir against those paths without
    // resolving it the same way makes every relative() come out as a string
    // of "..", not a rig/... path.
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rig-guard-")));

    it("fails a build that reaches rig/x.mjs from the entry point", async () => {
        mkdirSync(join(tmpRoot, "rig"));
        writeFileSync(join(tmpRoot, "rig", "x.mjs"), "export const x = 1;\n");
        writeFileSync(join(tmpRoot, "entry.mjs"), "export { x } from './rig/x.mjs';\n");

        await expect(
            build({
                entryPoints: [join(tmpRoot, "entry.mjs")],
                bundle: true,
                write: false,
                logLevel: "silent",
                absWorkingDir: tmpRoot,
                plugins: [rigGuardPlugin(tmpRoot)],
            }),
        ).rejects.toThrow(/rig-guard: rig[\\/]x\.mjs is test-rig code and must never enter main\.js/);
    });

    it("does not reject a rig/ segment nested under node_modules", async () => {
        mkdirSync(join(tmpRoot, "node_modules", "pkg", "rig"), { recursive: true });
        writeFileSync(join(tmpRoot, "node_modules", "pkg", "rig", "y.mjs"), "export const y = 2;\n");
        writeFileSync(
            join(tmpRoot, "entry-node-modules.mjs"),
            "export { y } from 'pkg/rig/y.mjs';\n",
        );
        writeFileSync(
            join(tmpRoot, "node_modules", "pkg", "package.json"),
            JSON.stringify({ name: "pkg", main: "rig/y.mjs" }),
        );

        const result = await build({
            entryPoints: [join(tmpRoot, "entry-node-modules.mjs")],
            bundle: true,
            write: false,
            logLevel: "silent",
            absWorkingDir: tmpRoot,
            plugins: [rigGuardPlugin(tmpRoot)],
        });

        expect(result.outputFiles[0].text).toContain("var y = 2;");
    });
});

describe("main.ts builds with the guard installed and stays rig-free", () => {
    // Mirrors esbuild.config.mjs's real build settings closely enough to be a
    // faithful proof, but with write:false/metafile:true so the test can
    // inspect inputs and output without touching main.js on disk.
    it(
        "has no metafile input under rig/ and no bundle marker in the output",
        async () => {
            const result = await build({
                entryPoints: [join(root, "main.ts")],
                bundle: true,
                format: "cjs",
                target: "es2018",
                write: false,
                // The .wasm: "file" loader needs an output path to name the
                // copied asset after, even with write:false — it is never
                // actually written to disk.
                outfile: join(root, "main.js"),
                metafile: true,
                absWorkingDir: root,
                logLevel: "silent",
                loader: {
                    ".css": "text",
                    ".wasm": "file",
                },
                external: [
                    "obsidian",
                    "electron",
                    "@codemirror/autocomplete",
                    "@codemirror/collab",
                    "@codemirror/commands",
                    "@codemirror/language",
                    "@codemirror/lint",
                    "@codemirror/search",
                    "@codemirror/state",
                    "@codemirror/view",
                    "@lezer/common",
                    "@lezer/highlight",
                    "@lezer/lr",
                    ...builtinModules,
                ],
                plugins: [rigGuardPlugin(root)],
            });

            const rigInputs = Object.keys(result.metafile.inputs).filter((path) => path.startsWith("rig/"));
            expect(rigInputs).toEqual([]);

            const outputText = result.outputFiles[0].text;
            const bundleMarkers = ["alpha/decisions", "typesafe/jev", "OPENROUTER_API_KEY_JEV", "jev-timestamps"];
            for (const marker of bundleMarkers) {
                expect(outputText).not.toContain(marker);
            }
        },
        60_000,
    );
});

describe("esbuild.config.mjs wires the guard in", () => {
    const configText = readFileSync(join(root, "esbuild.config.mjs"), "utf8");

    it("imports rigGuardPlugin", () => {
        expect(configText).toMatch(/import\s*\{\s*rigGuardPlugin\s*\}\s*from\s*["']\.\/scripts\/rig-guard\.mjs["']/);
    });

    it("calls rigGuardPlugin(...) as the FIRST entry in the plugins list", () => {
        // Not just "is present" — the brief requires it first, before
        // stubLangchainTiktoken, so a rig-bound file is rejected before any
        // other plugin's onLoad gets a chance to transform it away.
        const pluginsMatch = configText.match(/plugins:\s*\[([^\]]*)\]/);
        expect(pluginsMatch, "esbuild.config.mjs has no plugins: [...] array").not.toBeNull();
        expect(pluginsMatch[1].trim()).toMatch(/^rigGuardPlugin\(/);
    });
});
