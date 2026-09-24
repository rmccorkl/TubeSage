import type { CollectionJobRecord, CollectionStatus } from "./collection-record";
import type { NoteJobRecord } from "./job-record";

// Pure decisions about a collection's lifetime. No Obsidian, no I/O, no clock:
// the runtime applies what this returns, which is what makes the rule below
// testable without standing up a runner.

const FINISHED: ReadonlySet<NoteJobRecord["status"]> = new Set(["done", "failed", "cancelled"]);

export interface CancelPlan {
  /** Children to cancel now: queued, or gone missing. Never billed, so nothing is lost. */
  cancelIds: string[];
  /** Children left alone to finish — at most the one actually executing. */
  leaveRunningIds: string[];
  parentStatus: Extract<CollectionStatus, "cancelled">;
}

/**
 * Cancelling a collection stops SCHEDULING; it does not kill work in flight.
 *
 * The child currently executing has already paid for its LLM call, and
 * `JobRunner.cancel` cannot abort an in-flight native request anyway — it says
 * so itself: if the stage was `note-creating` the create may still land. Killing
 * it would therefore leave the user billed with no note, which serves none of
 * the stated priorities (no duplicate notes, no double billing, honest status).
 * So it is left to reach its durable checkpoint, and only work that has not
 * started is cancelled. There is no per-item cancel while a collection runs:
 * the run reports through one notice, and that notice's stop control stops
 * the run.
 *
 * `activeIds` is the runner's live set. It is an input rather than something
 * inferred from `status`, because `createJobRecord` stamps every child
 * `"running"` at plan time — status cannot distinguish queued from executing.
 *
 * A child whose record is missing is cancelled rather than ignored, so a gap
 * can never be picked up and run after the collection was cancelled.
 */
export function planCancel(
  parent: CollectionJobRecord,
  children: readonly NoteJobRecord[],
  activeIds: ReadonlySet<string>,
): CancelPlan {
  const byId = new Map(children.map((child) => [child.id, child]));
  const cancelIds: string[] = [];
  const leaveRunningIds: string[] = [];
  for (const id of parent.childIds) {
    const child = byId.get(id);
    if (child !== undefined && FINISHED.has(child.status)) continue;
    if (child !== undefined && activeIds.has(id)) {
      leaveRunningIds.push(id);
      continue;
    }
    cancelIds.push(id);
  }
  return { cancelIds, leaveRunningIds, parentStatus: "cancelled" };
}
