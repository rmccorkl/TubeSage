import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// main.ts has no test harness, so its wiring is read as text. That is a weak
// check and deliberately a narrow one: it guards the single defect shape this
// project keeps producing — a correct mechanism that nothing calls. Three of
// them shipped or nearly shipped in one release cycle (`onChildSettled` with no
// production caller, `CollectionRunner.cancel` unreachable, and the collection
// progress surface never dismissed at unload).
//
// The precedent for scanning main.ts from a test is i18n-usage.test.mjs, which
// does it for translation keys.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "main.ts"), "utf8");

/** The body of a top-level method of the plugin class, by name. */
function methodBody(name) {
  const open = main.indexOf(`\n    ${name}() {`);
  expect(open, `main.ts has no ${name}()`).toBeGreaterThan(-1);
  const close = main.indexOf("\n    }", open);
  expect(close, `${name}() is not closed at the expected indent`).toBeGreaterThan(open);
  return main.slice(open, close);
}

describe("onunload leaves no progress surface behind", () => {
  // Both surfaces are persistent (`new Notice(message, 0)`) and, on desktop,
  // carry a live window.setInterval. Nothing drives either once the plugin
  // unloads, so one that is not dismissed stays until Obsidian restarts.
  const body = methodBody("onunload");

  it.each([
    ["single-video jobs", "this.progressNotices.dismissAll()"],
    ["channel/playlist runs", "this.collectionNotices.dismissAll()"],
  ])("dismisses the surface for %s", (_what, call) => {
    expect(body).toContain(call);
  });
});

describe("the licence is never composed through a translation", () => {
  // src/runtime/license-view.test.ts renders the licence under every locale
  // and compares it with the licence file, but it can only see the view. The
  // element loop in main.ts is outside its reach, and `t` is already imported
  // and used throughout that file — so re-wrapping the clause heading in a
  // translation there would restore the defect with nothing failing. This
  // reads both halves as text, the way the file header explains.
  //
  // The licence is reproduced verbatim and stays in English in every
  // interface language; its punctuation is part of the instrument.

  /** Code with its comments removed — prose about `t()` is not a call to it. */
  function code(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  it("renders the licence in main.ts without translating any part of it", () => {
    const start = main.indexOf("for (const block of licenseView())");
    expect(start, "main.ts no longer renders licenseView() in a loop — check this test still looks in the right place").toBeGreaterThan(-1);
    const end = main.indexOf("\n        }\n", start);
    expect(end, "the licence render loop is not closed at the expected indent").toBeGreaterThan(start);

    const loop = code(main.slice(start, end));
    expect(loop).not.toMatch(/\bt\(/);
    expect(loop).not.toMatch(/\btPlural\(/);
  });

  it("builds the view itself without reaching for the translation table", () => {
    // No i18n import at all: the strongest form of the same guarantee, and one
    // that cannot be argued about, unlike scanning for call shapes.
    const view = readFileSync(join(root, "src", "runtime", "license-view.ts"), "utf8");
    expect(code(view)).not.toMatch(/from '\.\.\/i18n'/);
  });
});
