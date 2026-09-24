import { aggregateProgress } from "./collection-record";
import type { CollectionJobRecord, CollectionProgress, CollectionStatus } from "./collection-record";
import type { NoteJobRecord } from "./job-record";

// Pure decisions about a collection's lifetime. No Obsidian, no I/O, no clock:
// the runtime applies what these return, which is what makes the two rules
// below testable without standing up a runner.

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
 * started is cancelled. A user who wants that item gone can cancel it
 * individually; the per-item cancel already exists in the jobs modal.
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

export interface ColdStartClosurePlan {
  close: boolean;
  parentStatus: CollectionStatus;
  progress: CollectionProgress;
}

/**
 * A run dies with the Obsidian instance that started it (#3, the maintainer's
 * rule). On the next cold start this installation's unfinished collection is
 * CLOSED and reported, never silently resumed — and closing the parent must not
 * resurrect its children, which is why nothing here returns ids to restart.
 *
 * A collection owned by another installation is left alone: it may be live on
 * that device, and taking it over is exactly the duplicate-note risk #3 closed.
 */
export function planColdStartClosure(
  parent: CollectionJobRecord,
  children: readonly NoteJobRecord[],
  installationId: string,
): ColdStartClosurePlan {
  const progress = aggregateProgress(parent, children);
  const ownedByThisInstall = parent.installationId === installationId;
  const alreadyTerminal = parent.status !== "running";
  const close = ownedByThisInstall && !alreadyTerminal;
  return { close, parentStatus: close ? "closed" : parent.status, progress };
}
