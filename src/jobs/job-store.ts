import { assertRecordIsMetadataOnly } from "./job-record";
import { COLLECTIONS_KEY } from "./collection-record";
import type { CollectionJobRecord } from "./collection-record";
import type { JobStatus, NoteJobRecord } from "./job-record";

// In-memory job records. No Obsidian, no clock reads (`now` is always a
// parameter), and — since #10 — no persistence at all: a job lives for the
// length of its run and dies with the process that started it. Retrieval is
// serial and atomic; when one fails the person re-submits the URL, so there is
// nothing worth remembering across a restart.
//
// `JOBS_KEY` survives the removal because upgraded vaults still have `_jobs`
// (and `_collections`) sitting in data.json. Those keys are now only ever READ
// — once, by hydrate(), so main.ts can save them away — and stripped from
// every settings payload by settings-persist.ts.

export const JOBS_KEY = "_jobs";

export interface HydratedData {
  /** everything in data.json except the reserved keys — what loadSettings merges over DEFAULT_SETTINGS */
  settings: Record<string, unknown>;
  /** data.json still holds `_jobs` and/or `_collections`: save once without them */
  hadReservedKeys: boolean;
}

// Terminal statuses: a job in one of these states is finished, so it is not
// the in-progress job for its video.
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "cancelled", "failed"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: object | null = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Pure: strip the reserved keys out of raw data.json content and say whether
 * either was there. Never throws on bad input. The records themselves are not
 * read — nothing resumes across a process boundary any more, so a stale `_jobs`
 * array is dead weight to be deleted, not data to validate.
 */
export function hydrate(raw: unknown): HydratedData {
  if (!isPlainObject(raw)) {
    return { settings: {}, hadReservedKeys: false };
  }
  // `in` is safe here: isPlainObject has already established that the
  // prototype is Object.prototype or null, so neither key can be inherited.
  const hadReservedKeys = JOBS_KEY in raw || COLLECTIONS_KEY in raw;
  const settings: Record<string, unknown> = { ...raw };
  delete settings[JOBS_KEY];
  delete settings[COLLECTIONS_KEY];
  return { settings, hadReservedKeys };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The job records of THIS process, in a Map.
 *
 * `upsert`/`upsertCollection`/`removeCollection` stay async even though
 * nothing awaits I/O any more: the runner awaits them, and each await is a
 * fencing window it relies on — a cancel landing inside one must be seen
 * before the next stage starts. Making them synchronous would close those
 * windows and let a cancelled job reach a paid call.
 *
 * Every record crossing the boundary is cloned, in both directions: with no
 * serialization step left, that is the only thing keeping a caller from
 * mutating stored state behind the store's back.
 */
export class JobStore {
  private readonly jobs = new Map<string, NoteJobRecord>();
  private readonly collections = new Map<string, CollectionJobRecord>();

  /** Replace the in-memory set. */
  load(jobs: NoteJobRecord[]): void {
    this.jobs.clear();
    for (const job of jobs) {
      this.jobs.set(job.id, clone(job));
    }
  }

  listCollections(): CollectionJobRecord[] {
    return Array.from(this.collections.values())
      .map((collection) => clone(collection))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getCollection(id: string): CollectionJobRecord | undefined {
    const collection = this.collections.get(id);
    return collection === undefined ? undefined : clone(collection);
  }

  /** Stores a copy with updatedAt = now. */
  async upsertCollection(record: CollectionJobRecord, now: number): Promise<void> {
    const copy = clone(record);
    copy.updatedAt = now;
    this.collections.set(copy.id, copy);
  }

  async removeCollection(id: string): Promise<void> {
    this.collections.delete(id);
  }

  list(): NoteJobRecord[] {
    return Array.from(this.jobs.values())
      .map((job) => clone(job))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): NoteJobRecord | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : clone(job);
  }

  findByVideoId(videoId: string): NoteJobRecord | undefined {
    let best: NoteJobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.videoId !== videoId || TERMINAL_STATUSES.has(job.status)) {
        continue;
      }
      if (best === undefined || job.updatedAt > best.updatedAt) {
        best = job;
      }
    }
    return best === undefined ? undefined : clone(best);
  }

  /** Validates (assertRecordIsMetadataOnly), then stores a copy with updatedAt = now. */
  async upsert(record: NoteJobRecord, now: number): Promise<void> {
    // `async` turns a validation throw into a rejection of the promise this
    // method always returns (matching the Promise<void> contract), while
    // still running synchronously before the record is stored — an invalid
    // record never lands in the map.
    assertRecordIsMetadataOnly(record);
    const copy = clone(record);
    copy.updatedAt = now;
    this.jobs.set(copy.id, copy);
  }
}
