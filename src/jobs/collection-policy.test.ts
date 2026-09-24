import { describe, expect, it } from "vitest";
import { planCancel } from "./collection-policy";
import { planCollection } from "./collection-record";
import type { NoteJobRecord } from "./job-record";

const child = (id: string, status: NoteJobRecord["status"]) => ({ id, status }) as NoteJobRecord;

const parentOf = (n: number) => ({
  ...planCollection({
    url: "u", folder: "f", sourceName: "s", contentType: "Playlist",
    createdAt: 0, id: "p", plannedCount: n,
  }),
  // Every video already submitted: these tests are about children that exist.
  childIds: Array.from({ length: n }, (_, i) => `c${i + 1}`),
});

describe("planCancel — stop scheduling, never strand a paid call", () => {
  // NOTE: `createJobRecord` stamps every record `status: "running"` the moment
  // it is planned, so a child's status can NOT tell a queued item from the one
  // actually executing. The runner's live `active` set is the only honest
  // source for that, so it is an input here rather than something inferred.
  it("cancels the queued children and LEAVES the in-flight one to finish", () => {
    // The whole point: the in-flight child's LLM call is already billed. Killing
    // it would leave the user charged with no note. It runs to its durable
    // checkpoint; only work that has not started is cancelled.
    const plan = planCancel(parentOf(4), [
      child("c1", "done"),
      child("c2", "running"),
      child("c3", "running"),
      child("c4", "running"),
    ], new Set(["c2"]));
    expect(plan.cancelIds).toEqual(["c3", "c4"]);
    expect(plan.leaveRunningIds).toEqual(["c2"]);
  });

  it("never re-touches a child that already finished, so completed work is not re-billed", () => {
    const plan = planCancel(parentOf(3), [
      child("c1", "done"), child("c2", "failed"), child("c3", "cancelled"),
    ], new Set());
    expect(plan.cancelIds).toEqual([]);
    expect(plan.leaveRunningIds).toEqual([]);
  });

  it("marks the parent cancelled immediately, even while a child still runs", () => {
    // Honest status: the run is cancelled: what is still moving is the one item
    // being allowed to finish, not new work.
    const plan = planCancel(parentOf(2), [child("c1", "running"), child("c2", "running")], new Set(["c1"]));
    expect(plan.parentStatus).toBe("cancelled");
  });

  it("cancels a child whose record is missing by id, so a gap cannot silently resume later", () => {
    const plan = planCancel(parentOf(2), [child("c1", "done")], new Set());
    expect(plan.cancelIds).toEqual(["c2"]);
  });
});
