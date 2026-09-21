import { describe, expect, it } from "vitest";
import { writeIfUnchanged } from "./guarded-write";
import type { ProcessableVault } from "./guarded-write";

// FakeVault per the brief: process() mimics Obsidian's atomic read-modify-write
// against an in-memory store, so these tests need no `obsidian` import.
class FakeVault implements ProcessableVault<string> {
  store = new Map<string, string>();

  process(file: string, fn: (data: string) => string): Promise<string> {
    const cur = this.store.get(file) ?? "";
    const out = fn(cur);
    this.store.set(file, out);
    return Promise.resolve(out);
  }
}

// Simulates a user edit landing between the caller's earlier read (which
// produced `expected`) and the atomic section: mutates the stored content to
// "edited" immediately BEFORE invoking fn, so fn's own `data` argument
// reflects the edit, not the caller's stale read.
class EditsBeforeCallbackVault implements ProcessableVault<string> {
  store = new Map<string, string>();

  constructor(initial: string) {
    this.store.set("note.md", initial);
  }

  process(file: string, fn: (data: string) => string): Promise<string> {
    this.store.set(file, "edited");
    const cur = this.store.get(file) ?? "";
    const out = fn(cur);
    this.store.set(file, out);
    return Promise.resolve(out);
  }
}

describe("writeIfUnchanged", () => {
  it("writes next and returns true when content is unchanged", async () => {
    const vault = new FakeVault();
    vault.store.set("note.md", "original");

    const wrote = await writeIfUnchanged(vault, "note.md", "original", "updated");

    expect(wrote).toBe(true);
    expect(vault.store.get("note.md")).toBe("updated");
  });

  it("returns false and leaves content unchanged when it differs from expected at callback time", async () => {
    const vault = new FakeVault();
    vault.store.set("note.md", "different-content");

    const wrote = await writeIfUnchanged(vault, "note.md", "original", "updated");

    expect(wrote).toBe(false);
    expect(vault.store.get("note.md")).toBe("different-content");
  });

  it("compares inside the atomic callback: an edit landing before process() invokes fn wins over a stale expected", async () => {
    const vault = new EditsBeforeCallbackVault("original");

    // Caller's stale read is "original" (from before the simulated edit),
    // but process() mutates the store to "edited" right before fn runs. A
    // guard that compared outside process() (against a pre-fetched snapshot)
    // would not see this and would wrongly report success.
    const wrote = await writeIfUnchanged(vault, "note.md", "original", "updated");

    expect(wrote).toBe(false);
    expect(vault.store.get("note.md")).toBe("edited");
  });

  it("allows a no-op write when expected === next, and still returns true", async () => {
    const vault = new FakeVault();
    vault.store.set("note.md", "same");

    const wrote = await writeIfUnchanged(vault, "note.md", "same", "same");

    expect(wrote).toBe(true);
    expect(vault.store.get("note.md")).toBe("same");
  });
});
