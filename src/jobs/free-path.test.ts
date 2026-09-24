import { describe, expect, it } from "vitest";
import { MAX_FREE_PATH_SUFFIX, nextFreePath } from "./free-path";

// A `taken` probe over a fixed set, recording every path it was asked about
// so a test can prove the probe and the return value agree.
function probe(paths: readonly string[]): { taken: (path: string) => boolean; asked: string[] } {
  const set = new Set(paths);
  const asked: string[] = [];
  return {
    taken: (path: string): boolean => {
      asked.push(path);
      return set.has(path);
    },
    asked,
  };
}

const nfc = (path: string): string => path.normalize("NFC");

describe("nextFreePath", () => {
  it("returns the base unchanged when nothing is there", () => {
    expect(nextFreePath("Notes/Title.md", probe([]).taken)).toBe("Notes/Title.md");
  });

  it("appends Obsidian's ' 1' before the extension when the base is taken", () => {
    expect(nextFreePath("Notes/Title.md", probe(["Notes/Title.md"]).taken)).toBe("Notes/Title 1.md");
  });

  it("walks up while the suffixed candidates are taken too", () => {
    const taken = probe(["Notes/Title.md", "Notes/Title 1.md"]).taken;
    expect(nextFreePath("Notes/Title.md", taken)).toBe("Notes/Title 2.md");
  });

  it("takes the FIRST free number, not the highest (Obsidian fills gaps)", () => {
    const taken = probe(["Notes/Title.md", "Notes/Title 2.md"]).taken;
    expect(nextFreePath("Notes/Title.md", taken)).toBe("Notes/Title 1.md");
  });

  it("does not parse a trailing number out of the basename", () => {
    expect(nextFreePath("Notes/Title 1.md", probe(["Notes/Title 1.md"]).taken)).toBe("Notes/Title 1 1.md");
  });

  it("probes and returns the SAME normalized form for a non-ASCII (Hangul) title", () => {
    // Hangul's conjoining Jamo survive sanitizeFilename's diacritic strip, so
    // a base can arrive in NFD while the vault indexes NFC (#3 final review C1).
    const nfdBase = "Notes/한글.md".normalize("NFD");
    const p = probe([nfc("Notes/한글.md")]);
    const result = nextFreePath(nfdBase, p.taken, nfc);
    expect(result).toBe(nfc("Notes/한글 1.md"));
    expect(result).toBe(result.normalize("NFC"));
    // Every probe went out in the same form the answer came back in.
    expect(p.asked).toEqual([nfc("Notes/한글.md"), nfc("Notes/한글 1.md")]);
  });

  it("splits at the FINAL dot of the basename, never at a dot in the folder", () => {
    const taken = probe(["Notes/v1.2/My Note.md"]).taken;
    expect(nextFreePath("Notes/v1.2/My Note.md", taken)).toBe("Notes/v1.2/My Note 1.md");
  });

  it("appends at the end when there is no extension, instead of throwing", () => {
    expect(nextFreePath("Notes/README", probe(["Notes/README"]).taken)).toBe("Notes/README 1");
    // A leading dot is the whole basename, not an extension.
    expect(nextFreePath(".md", probe([".md"]).taken)).toBe(".md 1");
  });

  it("stops at the cap and returns the last candidate rather than looping forever", () => {
    const result = nextFreePath("Notes/Title.md", () => true);
    expect(result).toBe(`Notes/Title ${MAX_FREE_PATH_SUFFIX}.md`);
  });
});
