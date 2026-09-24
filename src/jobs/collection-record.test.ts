import { describe, expect, it } from "vitest";
import {
  COLLECTIONS_KEY,
  aggregateProgress,
  isTerminalCollection,
  planCollection,
} from "./collection-record";
import type { NoteJobRecord } from "./job-record";

const child = (id: string, status: NoteJobRecord["status"]) => ({ id, status }) as NoteJobRecord;

const base = {
  url: "https://youtube.com/playlist?list=PL1",
  folder: "Inbox/Playlist - Stuff",
  sourceName: "Stuff",
  contentType: "Playlist" as const,
  id: "p",
  installationId: "inst-1",
  createdAt: 1_000,
};
const parentOf = (plannedCount: number, childIds: string[] = []) => ({
  ...planCollection({ ...base, plannedCount }),
  childIds,
});

describe("planCollection — a thin parent; children come from submit()", () => {
  it("records how many videos the run is for before any child exists", () => {
    const parent = planCollection({ ...base, plannedCount: 3 });
    expect(parent.plannedCount).toBe(3);
    expect(parent.childIds).toEqual([]);
    expect(parent.kind).toBe("collection");
  });

  it("carries no paid-work or claim fields, so it can never bill or create a note", () => {
    const parent = planCollection({ ...base, plannedCount: 2 });
    for (const forbidden of ["stage", "attempts", "billing", "claimedNotePath", "claimedContentHash", "notePath"]) {
      expect(parent, `parent must not carry ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it("stamps the owning installation, so the app-instance rule applies", () => {
    expect(planCollection({ ...base, plannedCount: 1 }).installationId).toBe("inst-1");
  });
});

describe("aggregateProgress — the total is the run's size, not how much of it exists yet", () => {
  it("counts videos not yet submitted as remaining", () => {
    // The trap this closes: with ids arriving one at a time, using childIds.length
    // as the total would report '1 of 1' on the first item of a ten-video run.
    const got = aggregateProgress(parentOf(10, ["c1"]), [child("c1", "done")]);
    expect(got).toMatchObject({ total: 10, done: 1, remaining: 9 });
  });

  it("counts each settled child exactly once", () => {
    const got = aggregateProgress(parentOf(3, ["c1", "c2", "c3"]), [
      child("c1", "done"), child("c2", "failed"), child("c3", "running"),
    ]);
    expect(got).toMatchObject({ total: 3, done: 1, failed: 1, remaining: 1 });
  });

  it("treats a submitted child whose record vanished as remaining, not as finished", () => {
    const got = aggregateProgress(parentOf(3, ["c1", "c2", "c3"]), [child("c1", "done")]);
    expect(got).toMatchObject({ total: 3, remaining: 2 });
  });

  it("counts a cancelled child as finished", () => {
    const got = aggregateProgress(parentOf(3, ["c1", "c2", "c3"]), [
      child("c1", "done"), child("c2", "cancelled"), child("c3", "cancelled"),
    ]);
    expect(got).toMatchObject({ cancelled: 2, remaining: 0 });
  });
});

describe("isTerminalCollection", () => {
  it("is not terminal while videos remain to be submitted", () => {
    expect(isTerminalCollection(parentOf(3, ["c1"]), [child("c1", "done")])).toBe(false);
  });

  it("is not terminal while a submitted child can still run", () => {
    expect(isTerminalCollection(parentOf(2, ["c1", "c2"]), [child("c1", "done"), child("c2", "running")])).toBe(false);
  });

  it("is terminal once every video is submitted and every child has settled", () => {
    expect(isTerminalCollection(parentOf(2, ["c1", "c2"]), [child("c1", "done"), child("c2", "cancelled")])).toBe(true);
  });
});

describe("the persisted envelope", () => {
  it("reserves its own key so collections never leak into settings", () => {
    expect(COLLECTIONS_KEY).toBe("_collections");
  });
});
