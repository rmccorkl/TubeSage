import type { NoteJobRecord } from "./job-record";

// Pure data + pure helpers for a channel/playlist run. No Obsidian, no I/O, no
// clock reads except to interpret a `now` the caller already captured — the
// same rule the single-video record follows.
//
// WHY A THIN PARENT PLUS N ORDINARY SINGLE JOBS, rather than one job with N
// items (#9): every invariant issue #3 established is per-NOTE, not per-run —
// the stage machine, generation fencing, the two-phase claim (path + content
// fingerprint persisted before `vault.create`), the frozen `targetNotePath`,
// and the `attempts` ledger. A single record holding N items would have to
// embed all of that N times, which is N jobs with extra steps but WITHOUT the
// store's per-record serialized writes and without fencing operating per item.
//
// Each video is submitted through `JobRunner.submit()` like any other job, so a
// child is not merely shaped like a single-video job — it IS one, and it
// inherits `submit()`'s duplicate detection too. That guard matters here more
// than anywhere: the same video appears in more than one playlist, and a
// playlist gets re-run. The hard requirement that "per-item paid work must be
// attributable so an interrupted collection cannot re-bill items already
// completed" is then satisfied for free: each child owns its own `attempts`
// ledger and `billing`.
//
// Because ids come back FROM `submit()`, `childIds` grows as the run proceeds
// and cannot be the run's size. `plannedCount` carries that instead, so a
// half-submitted run still reports an honest total.
//
// The parent below therefore owns NO paid work and NO claim fields. It cannot
// bill and it cannot create a note; it is a grouping and a progress aggregate.
// `collection-record.test.ts` asserts that as a property, not as a convention.

/** Reserved key in `data.json`, a sibling of `_jobs`. */
export const COLLECTIONS_KEY = "_collections";

export type CollectionStatus = "running" | "cancelled" | "closed" | "done";
export type CollectionContentType = "Channel" | "Playlist";

export interface CollectionJobRecord {
  version: 1;
  kind: "collection";
  id: string;
  url: string;
  /** Vault-relative folder the notes are written into; already normalized by the caller. */
  folder: string;
  sourceName: string;
  contentType: CollectionContentType;
  /** How many videos the run is for. Fixed at plan time; `childIds` catches up. */
  plannedCount: number;
  /** Ids of the children submitted SO FAR, in processing order. */
  childIds: string[];
  createdAt: number;
  /** The installation that started this run; a run lives and dies with it (#3). */
  installationId?: string;
  status: CollectionStatus;
  updatedAt: number;
}

export interface CollectionVideo {
  url: string;
  videoId: string;
  title: string;
}

/** What the notice renders. Derived from the children every time, never cached on the parent. */
export interface CollectionProgress {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Children still able to run, plus any whose record is not present. */
  remaining: number;
}

/**
 * Settled FROM THE RUN'S POINT OF VIEW — which is not the same as a job being
 * terminal. `interrupted` is included: that child will not continue by itself
 * in this session, so a run that kept waiting for it would never finish and its
 * notice would never close. The child stays an ordinary recoverable job and can
 * be resumed on its own from the jobs modal; the collection simply stops
 * blocking on it. `aggregateProgress` still counts it as remaining, so the
 * closing message is honest about what was not done.
 */
const SETTLED_FOR_RUN: ReadonlySet<NoteJobRecord["status"]> = new Set([
  "done",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Start a collection: the parent record only.
 *
 * Children are NOT built here. They are submitted one at a time through
 * `JobRunner.submit()`, which owns record creation, so their ids arrive as the
 * run proceeds. `createdAt` is shared by every child the runner submits, which
 * is the sole source of a note's date prefix — so a run crossing midnight
 * cannot scatter its notes across two date folders.
 */
export function planCollection(input: {
  url: string;
  folder: string;
  sourceName: string;
  contentType: CollectionContentType;
  plannedCount: number;
  id: string;
  installationId?: string;
  createdAt: number;
}): CollectionJobRecord {
  return {
    version: 1,
    kind: "collection",
    id: input.id,
    url: input.url,
    folder: input.folder,
    sourceName: input.sourceName,
    contentType: input.contentType,
    plannedCount: input.plannedCount,
    childIds: [],
    createdAt: input.createdAt,
    ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
    status: "running",
    updatedAt: input.createdAt,
  };
}

/**
 * Count the run's children. `total` is always the parent's declared child
 * count: a child whose record has been pruned or discarded counts as
 * REMAINING rather than shrinking the total, so the notice can never claim a
 * run finished because its evidence went missing.
 */
export function aggregateProgress(
  parent: CollectionJobRecord,
  children: readonly NoteJobRecord[],
): CollectionProgress {
  const byId = new Map(children.map((child) => [child.id, child]));
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let submittedButUnfinished = 0;
  for (const id of parent.childIds) {
    const child = byId.get(id);
    if (child === undefined) {
      submittedButUnfinished += 1;
      continue;
    }
    switch (child.status) {
      case "done":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
      default:
        submittedButUnfinished += 1;
    }
  }
  // Videos not yet submitted are remaining too, which is why the total comes
  // from `plannedCount` and never from how many ids exist so far.
  const notYetSubmitted = Math.max(0, parent.plannedCount - parent.childIds.length);
  return {
    total: parent.plannedCount,
    done,
    failed,
    cancelled,
    remaining: submittedButUnfinished + notYetSubmitted,
  };
}

/**
 * True when every child that was actually SUBMITTED has settled, ignoring
 * videos still queued.
 *
 * This is the question a CANCELLED run asks: its queued videos will never be
 * submitted, so `isTerminalCollection` (which waits for `plannedCount`) would
 * never be satisfied. Like that function it reads the child RECORDS, which are
 * terminal by the time the runner emits a job's terminal event — unlike the
 * runner's live `active` set, which still contains the settling job at that
 * moment.
 */
export function allSubmittedSettled(
  parent: CollectionJobRecord,
  children: readonly NoteJobRecord[],
): boolean {
  const byId = new Map(children.map((child) => [child.id, child]));
  return parent.childIds.every((id) => {
    const child = byId.get(id);
    return child !== undefined && SETTLED_FOR_RUN.has(child.status);
  });
}

/**
 * True when nothing of the run can still move: every planned video has been
 * submitted AND every child has settled. A run with videos still to submit is
 * never terminal, however many of its existing children are done.
 */
export function isTerminalCollection(
  parent: CollectionJobRecord,
  children: readonly NoteJobRecord[],
): boolean {
  if (parent.childIds.length < parent.plannedCount) return false;
  const byId = new Map(children.map((child) => [child.id, child]));
  return parent.childIds.every((id) => {
    const child = byId.get(id);
    return child !== undefined && SETTLED_FOR_RUN.has(child.status);
  });
}
