// The gate, run against the real repository: no orphan keys in either
// direction, and en.json exactly what the matrix builds.
//
// `.test.mjs` on purpose. This test reads source files, and the shipped
// `src/**/*.ts` are linted with `import/no-nodejs-modules`; the pure module
// tests live in `src/i18n/i18n.test.ts` and touch no Node builtin.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLocales, checkLocales, scanKeysUsedInCode } from "./i18n-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src", "locales");

const en = JSON.parse(readFileSync(join(localesDir, "en.json"), "utf8"));
const csvText = readFileSync(join(root, "i18n", "strings.csv"), "utf8");

const locales = {};
for (const file of readdirSync(localesDir)) {
  if (!file.endsWith(".json") || file === "en.json") continue;
  locales[file.slice(0, -".json".length)] = JSON.parse(readFileSync(join(localesDir, file), "utf8"));
}

const flatDir = join(localesDir, "flat");
const flat = {};
for (const file of readdirSync(flatDir)) {
  if (!file.endsWith(".json")) continue;
  flat[file.slice(0, -".json".length)] = JSON.parse(readFileSync(join(flatDir, file), "utf8"));
}

/** main.ts plus every shipped module under src/, tests excluded. */
function sources() {
  const out = [{ path: "main.ts", text: readFileSync(join(root, "main.ts"), "utf8") }];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(join(root, "src"));
  return out;
}

const keysUsedInCode = scanKeysUsedInCode(sources());

describe("i18n:check against the repository", () => {
  it("reports no problems at all", () => {
    const problems = checkLocales({ csvText, en, locales, flat, keysUsedInCode });
    expect(problems.map((p) => p.message)).toEqual([]);
  });

  it("keeps every shipped flat locale file exactly matching its paired translations", () => {
    // Guards the second generated artifact locales.ts actually imports:
    // src/locales/flat/<code>.json must equal { key: paired[key].translation }
    // for every key of every shipped locale — a stale flat file, hand-edited
    // or left behind by a partial i18n:build, must fail here.
    const problems = checkLocales({ en, locales, flat, keysUsedInCode });
    const flatProblems = problems.filter((p) => p.code.startsWith("flat-"));
    expect(flatProblems).toEqual([]);
  });

  it("has no orphan keys: every key the code asks for exists in en.json", () => {
    const missing = [...keysUsedInCode].filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });

  it("has no orphan keys the other way: every en.json key is asked for by the code", () => {
    const unused = Object.keys(en).filter((key) => !keysUsedInCode.has(key));
    expect(unused).toEqual([]);
  });

  it("keeps en.json byte-identical to what the authoring matrix builds", () => {
    expect(buildLocales(csvText).en).toEqual(en);
  });

  it("gives every key a context note", () => {
    const { context } = buildLocales(csvText);
    const bare = Object.keys(en).filter((key) => (context[key] ?? "").trim() === "");
    expect(bare).toEqual([]);
  });
});
