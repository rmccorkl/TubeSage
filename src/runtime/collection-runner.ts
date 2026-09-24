import { planCancel, planColdStartClosure } from "../jobs/collection-policy";
import { allSubmittedSettled, isTerminalCollection, planCollection } from "../jobs/collection-record";
import type {
  CollectionContentType,
  CollectionJobRecord,
  CollectionVideo,
} from "../jobs/collection-record";
import type { NoteJobRecord } from "../jobs/job-record";

// Drives a channel/playlist run: one ordinary single job at a time, one notice
// for the whole run. Every capability is injected, so this holds no Obsidian
// and no runner import and can be tested against doubles.
//
// ONE AT A TIME is deliberate. Fanning children out would put several paid LLM
// calls in flight at once, which multiplies exactly the exposure #3 was built
// to bound — a crash mid-run could then leave several items half-paid rather
// than one. Sequential also makes "what is the collection doing right now" a
// question with a single honest answer.

export interface CollectionRunnerDeps {
  generateId(): string;
  now(): number;
  installationId(): string;
  /**
   * Submit ONE video through `JobRunner.submit()` and return the id of the job
   * now responsible for it — a freshly started one, or an existing job for the
   * same video that `submit()`'s duplicate detection matched. `undefined` means
   * the video could not be adopted at all, and the run's total shrinks by one
   * rather than waiting forever for a child that will never report.
   */
  submitChild(video: CollectionVideo, folder: string): Promise<string | undefined>;
  cancelChild(id: string): Promise<void>;
  isActive(id: string): boolean;
  getChild(id: string): NoteJobRecord | undefined;
  saveCollection(record: CollectionJobRecord): Promise<void>;
  /** Every collection in the store, including ones a previous instance left. */
  listCollections(): CollectionJobRecord[];
  notices: {
    start(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void;
    update(parent: CollectionJobRecord, children: readonly NoteJobRecord[]): void;
    finish(parent: CollectionJobRecord, children: readonly NoteJobRecord[], status: "cancelled" | "closed" | "done"): void;
  };
}

export interface BeginInput {
  url: string;
  folder: string;
  sourceName: string;
  contentType: CollectionContentType;
  videos: CollectionVideo[];
}

export class CollectionRunner {
  private readonly parents = new Map<string, CollectionJobRecord>();
  /** Videos still to submit, in order. In memory only — see `begin`. */
  private readonly queues = new Map<string, CollectionVideo[]>();

  constructor(private readonly deps: CollectionRunnerDeps) {}

  /** Creates the parent, opens the single notice and submits item one. */
  async begin(input: BeginInput): Promise<CollectionJobRecord> {
    const parent = planCollection({
      url: input.url,
      folder: input.folder,
      sourceName: input.sourceName,
      contentType: input.contentType,
      plannedCount: input.videos.length,
      id: this.deps.generateId(),
      installationId: this.deps.installationId(),
      createdAt: this.deps.now(),
    });
    this.parents.set(parent.id, parent);
    // The queue lives in memory only: a collection never resumes after the app
    // instance dies (#3), so persisting the pending videos would buy nothing.
    this.queues.set(parent.id, [...input.videos]);
    await this.deps.saveCollection(parent);
    this.deps.notices.start(parent, this.childRecords(parent));
    await this.startNext(parent.id);
    return this.parents.get(parent.id) ?? parent;
  }

  /**
   * Called when any child reaches a terminal state. Advances the run, or ends
   * it. A cancelled run never starts another item — but it is only FINISHED
   * once nothing of it is still executing, because cancel deliberately lets
   * the already-paid item run to its durable checkpoint.
   */
  async onChildSettled(parentId: string): Promise<void> {
    const parent = this.parents.get(parentId);
    if (parent === undefined) return;
    const children = this.childRecords(parent);
    if (parent.status === "cancelled") {
      // Judged on the child RECORDS, not on `deps.isActive`. The runner emits a
      // job's terminal event and only clears it from its active map afterwards,
      // in a `.finally`, so at this moment the very child that just settled
      // still reads as active — the run would take `update`, and since no
      // further event arrives for that job, it would never be asked again. The
      // notice then stayed on screen with stale progress until a restart, and
      // the owned child ids were never released. Records are already terminal
      // here, which is why `isTerminalCollection` never had this problem.
      if (allSubmittedSettled(parent, children)) {
        this.deps.notices.finish(parent, children, "cancelled");
        this.parents.delete(parentId);
        this.queues.delete(parentId);
        return;
      }
      this.deps.notices.update(parent, children);
      return;
    }
    if (isTerminalCollection(parent, children)) {
      const done: CollectionJobRecord = { ...parent, status: "done" };
      this.parents.set(parentId, done);
      await this.deps.saveCollection(done);
      this.deps.notices.finish(done, children, "done");
      this.parents.delete(parentId);
      this.queues.delete(parentId);
      return;
    }
    this.deps.notices.update(parent, children);
    await this.startNext(parentId);
  }

  /**
   * Stops SCHEDULING. Queued children are cancelled (never billed, so nothing
   * is lost); the item actually executing is left to finish, because its LLM
   * call is already paid for and killing it would leave the user charged with
   * no note. The per-item cancel remains available for immediate abandonment.
   */
  async cancel(parentId: string): Promise<void> {
    const parent = this.parents.get(parentId);
    if (parent === undefined || parent.status !== "running") return;
    const active = new Set(parent.childIds.filter((id) => this.deps.isActive(id)));
    const plan = planCancel(parent, this.childRecords(parent), active);
    for (const id of plan.cancelIds) {
      await this.deps.cancelChild(id);
    }
    const cancelled: CollectionJobRecord = { ...parent, status: plan.parentStatus };
    this.parents.set(parentId, cancelled);
    await this.deps.saveCollection(cancelled);
    if (plan.leaveRunningIds.length === 0) {
      this.deps.notices.finish(cancelled, this.childRecords(cancelled), "cancelled");
      this.parents.delete(parentId);
      this.queues.delete(parentId);
      return;
    }
    this.deps.notices.update(cancelled, this.childRecords(cancelled));
  }

  /**
   * Feed a runner event in. Returns true when the event belonged to a live
   * collection, so the host can suppress that job's individual notice.
   *
   * The routing lives HERE rather than in `main.ts` on purpose: the host has no
   * test harness, and leaving "advance the queue when a child settles" as host
   * code is exactly how the first cut shipped a collection that processed one
   * video. One line in the host, covered by tests here.
   */
  async handleJobEvent(event: { type: string; id: string }): Promise<boolean> {
    const parentId = this.parentIdForChild(event.id);
    if (parentId === undefined) return false;
    // `interrupted` counts: that child will not continue by itself, and a run
    // that kept waiting for it would never advance or close its notice.
    if (event.type === "done" || event.type === "failed" || event.type === "cancelled" || event.type === "interrupted") {
      await this.onChildSettled(parentId);
    }
    return true;
  }

  /**
   * The live run a child belongs to, or `undefined`.
   *
   * Added because `main.ts` receives runner events keyed by JOB id and has to
   * get from there to the collection that owns the job. Exposed as a lookup
   * rather than letting the host read `parents` directly: the host should not
   * depend on how a run stores its children.
   */
  parentIdForChild(childId: string): string | undefined {
    for (const [parentId, parent] of this.parents) {
      if (parent.childIds.includes(childId)) return parentId;
    }
    return undefined;
  }

  /**
   * Cold start: close every run this installation left behind.
   *
   * A run dies with the Obsidian instance that started it (#3), so a parent
   * still marked `running` on startup belongs to an instance that is gone. It
   * is closed and reported; children are NOT restarted — they are ordinary jobs
   * and the runner's own cold-start pass has already closed them. Returns how
   * many runs were closed, for the notice the rule requires.
   *
   * Reads from the STORE rather than from `parents`: the runs being closed
   * belong to a previous process, so they were never in this one's memory.
   */
  async closeAbandoned(): Promise<number> {
    const installationId = this.deps.installationId();
    let closed = 0;
    for (const parent of this.deps.listCollections()) {
      const plan = planColdStartClosure(parent, this.childRecords(parent), installationId);
      if (!plan.close) continue;
      await this.deps.saveCollection({ ...parent, status: plan.parentStatus });
      closed += 1;
    }
    return closed;
  }

  /**
   * True while `id` belongs to a live run, so its own per-video notice is
   * suppressed.
   *
   * Answered from the runner's own parents rather than from the notice: under
   * the submit()-driven design a run's `childIds` is EMPTY when the notice
   * opens and fills as ids come back, so a notice that captured ids at `start()`
   * owned nothing at all — every child would have shown its own notice on top
   * of the run's. Ownership ends when `finish()` drops the parent, which is the
   * same moment the notice closes.
   */
  owns(id: string): boolean {
    return this.parentIdForChild(id) !== undefined;
  }

  private childRecords(parent: CollectionJobRecord): NoteJobRecord[] {
    const out: NoteJobRecord[] = [];
    for (const id of parent.childIds) {
      const record = this.deps.getChild(id);
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  /**
   * Submits the next queued video, one at a time. Adopting whatever id
   * `submit()` hands back is what makes a child an ordinary job rather than a
   * look-alike — including when the id belongs to a job that already existed
   * for that video.
   */
  private async startNext(parentId: string): Promise<void> {
    const parent = this.parents.get(parentId);
    if (parent === undefined || parent.status !== "running") return;
    const queue = this.queues.get(parentId);
    const next = queue?.shift();
    if (next === undefined) return;
    // The folder belongs to the RUN, not to the plugin: two collections can be
    // in flight in different folders, so it travels with the call.
    const id = await this.deps.submitChild(next, parent.folder);
    const current = this.parents.get(parentId);
    // A `cancel()` can land DURING the await above, and it leaves the run in one
    // of two states: still tracked but no longer `running`, or — when nothing
    // was executing — removed from memory altogether. BOTH mean this child was
    // born into a run that has ended, so it is cancelled rather than adopted.
    // Returning early on the second case was itself the bug: the child was
    // neither adopted nor cancelled, so it ran on, billed and unattended.
    if (current === undefined || current.status !== "running") {
      if (id !== undefined) await this.deps.cancelChild(id);
      return;
    }
    const updated: CollectionJobRecord =
      id === undefined
        ? { ...current, plannedCount: Math.max(0, current.plannedCount - 1) }
        : { ...current, childIds: [...current.childIds, id] };
    this.parents.set(parentId, updated);
    await this.deps.saveCollection(updated);
    if (id === undefined) {
      // Nothing will report for this video, so move on immediately rather than
      // leaving the run one child short of terminal forever.
      await this.startNext(parentId);
    }
  }
}
