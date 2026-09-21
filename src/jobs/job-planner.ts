import {
  MAX_STAGE_ATTEMPTS,
  PAID_STAGES,
  contentMatchesClaim,
  stageBillingRisk,
  type JobStage,
  type NoteJobRecord,
} from "./job-record";

// Pure resume-time decisions for a job record. No Obsidian, no I/O, no clock
// reads except to interpret a passed-in `now`. Task 4 enforces the claim
// protocol documented at the bottom of this file at runtime; this module
// only decides what is SAFE to do, never does it.

/** What the planner may ask about the vault. Callers pre-resolve these synchronously. */
export interface VaultProbe {
  exists(path: string): boolean;
  /** current content if readable synchronously by the caller (pre-read), else undefined */
  content(path: string): string | undefined;
}

export const HEARTBEAT_INTERVAL_MS = 45_000;
export const STALE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS; // 135 000

export type AskReason =
  | "paid-stage-in-flight"
  | "unknown-billing-in-flight"
  | "attempts-exhausted"
  | "note-collision"
  | "claim-unresolved"
  | "note-missing"
  | "note-changed"
  | "templater-unavailable";

export type ResumeDecision =
  | { action: "nothing"; why: "terminal" }
  | { action: "nothing"; why: "live" } // running, fresh heartbeat, not past deadline
  | { action: "continue"; fromStage: JobStage } // clean checkpoint (not in flight)
  | { action: "auto-resume"; fromStage: JobStage } // in-flight stage with billing risk "free" and attempts remaining
  | { action: "adopt-note"; notePath: string } // exact-write evidence matched
  | {
      action: "ask-user";
      reason: AskReason;
      stage: JobStage;
      canFinishWithoutTimestamps: boolean;
      interruption: "timeout" | "unknown";
    };

// Stages at which record.notePath names a durable note (rule 4).
const NOTE_ON_DISK_STAGES: ReadonlySet<JobStage> = new Set<JobStage>(["note-created", "timestamps", "translation"]);

export function isStale(record: NoteJobRecord, now: number): boolean {
  return record.status === "running" && now - record.heartbeatAt > STALE_AFTER_MS;
}

export function isPastDeadline(record: NoteJobRecord, now: number): boolean {
  return record.inFlight && record.deadlineAt !== undefined && now > record.deadlineAt;
}

// note-creating shares the "summary" retry budget (retrying it means
// re-running the paid summary call); note-created/done have no budget.
// timestamps and translation are separate paid calls with separate ledgers
// (F6): a spent timestamps budget never gates the translation stage.
function attemptsKeyForStage(stage: JobStage): keyof NoteJobRecord["attempts"] | undefined {
  switch (stage) {
    case "transcript":
      return "transcript";
    case "summary":
    case "note-creating":
      return "summary";
    case "timestamps":
      return "timestamps";
    case "translation":
      return "translation";
    case "note-created":
    case "done":
      return undefined;
  }
}

function interruptionFor(record: NoteJobRecord, now: number): "timeout" | "unknown" {
  return isPastDeadline(record, now) ? "timeout" : "unknown";
}

function askUser(
  reason: AskReason,
  stage: JobStage,
  canFinishWithoutTimestamps: boolean,
  interruption: "timeout" | "unknown",
): ResumeDecision {
  return { action: "ask-user", reason, stage, canFinishWithoutTimestamps, interruption };
}

export function classifyOnResume(record: NoteJobRecord, probe: VaultProbe, now: number): ResumeDecision {
  // Rule 1: terminal states need no action.
  if (
    record.status === "done" ||
    record.status === "cancelled" ||
    record.status === "failed" ||
    record.stage === "done"
  ) {
    return { action: "nothing", why: "terminal" };
  }

  // Rule 2: a live runner still owns this job. If it is past its deadline,
  // fall through anyway: the runner's timer may be frozen (e.g. app
  // suspended), and the resume path bumps `generation`, which fences the
  // stale runner (F2).
  if (record.status === "running" && !isStale(record, now) && !isPastDeadline(record, now)) {
    return { action: "nothing", why: "live" };
  }

  const interruption = interruptionFor(record, now);

  // Rule 3: a stage whose retry budget is exhausted always needs a human —
  // whether or not the failed attempt is still in flight — except a clean
  // (not-in-flight), non-paid checkpoint, which stays safe to resume.
  const attemptsKey = attemptsKeyForStage(record.stage);
  const stageNeedsAttemptsGate = record.inFlight || PAID_STAGES.has(record.stage) || record.stage === "note-creating";
  if (attemptsKey !== undefined && record.attempts[attemptsKey] >= MAX_STAGE_ATTEMPTS && stageNeedsAttemptsGate) {
    // canFinishWithoutTimestamps (= "finish now, no further LLM call") only
    // when a durable note is confirmed to exist: past note-created with the
    // note present, the job may finish even though its timestamps or
    // translation budget is spent (#3 final review M2). Stages before the
    // note exist never qualify.
    const noteExists =
      NOTE_ON_DISK_STAGES.has(record.stage) && record.notePath !== undefined && probe.exists(record.notePath);
    return askUser("attempts-exhausted", record.stage, noteExists, interruption);
  }

  // Rule 4: past the note-created checkpoint, the note must already exist —
  // never silently recreate it. The paid stages here (timestamps, then
  // translation) are separate checkpoints: a resume from `translation`
  // never re-runs the timestamps pass, whose output is already on disk.
  if (NOTE_ON_DISK_STAGES.has(record.stage)) {
    if (record.notePath === undefined || !probe.exists(record.notePath)) {
      return askUser("note-missing", record.stage, false, interruption);
    }
    if (record.stage === "timestamps" || record.stage === "translation") {
      if (record.inFlight) {
        // The note already exists, so the job can finish without this pass.
        return askUser("paid-stage-in-flight", record.stage, true, interruption);
      }
      return { action: "continue", fromStage: record.stage };
    }
    return { action: "continue", fromStage: "timestamps" };
  }

  // Rule 5: note-creating is the crash-safe ownership window (F1/F4) — the
  // claim persisted before vault.create is the only evidence of what, if
  // anything, actually landed. ctime is never consulted.
  if (record.stage === "note-creating") {
    if (
      record.claimedNotePath === undefined ||
      record.claimedContentHash === undefined ||
      record.claimedContentLength === undefined
    ) {
      return askUser("claim-unresolved", "note-creating", false, interruption);
    }
    if (!probe.exists(record.claimedNotePath)) {
      // The create never landed, and the summary text is never persisted by
      // design, so the only safe re-entry point is re-running the summary.
      return askUser("paid-stage-in-flight", "summary", false, interruption);
    }
    const content = probe.content(record.claimedNotePath);
    if (content === undefined) {
      return askUser("claim-unresolved", "note-creating", false, interruption);
    }
    if (contentMatchesClaim(record, content)) {
      return { action: "adopt-note", notePath: record.claimedNotePath };
    }
    return askUser("note-collision", "note-creating", false, interruption);
  }

  // Rule 6: summary is a single paid stage until the note is durable.
  if (record.stage === "summary") {
    if (record.inFlight) {
      return askUser("paid-stage-in-flight", "summary", false, interruption);
    }
    return { action: "continue", fromStage: "summary" };
  }

  // Rule 7: transcript — free stages can auto-resume unattended; anything
  // that might already have spent money must ask. Guarded explicitly: a
  // stage string this build does not know (a record written by a newer
  // plugin) must never be auto-resumed as if it were the free first stage.
  if (record.stage !== "transcript") {
    return { action: "nothing", why: "terminal" };
  }
  if (!record.inFlight) {
    return { action: "continue", fromStage: "transcript" };
  }
  const billing = stageBillingRisk(record, "transcript");
  if (billing === "free") {
    return { action: "auto-resume", fromStage: "transcript" };
  }
  if (billing === "unknown") {
    return askUser("unknown-billing-in-flight", "transcript", false, interruption);
  }
  return askUser("paid-stage-in-flight", "transcript", false, interruption);
}

const LINEAR_NEXT_STAGE: Record<JobStage, JobStage> = {
  transcript: "summary",
  summary: "note-creating",
  "note-creating": "note-created",
  "note-created": "timestamps",
  timestamps: "done", // or "translation" when the record froze translation settings (see nextStage)
  translation: "done",
  done: "done",
};

const SHORTCUT_ELIGIBLE_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "transcript",
  "summary",
  "note-creating",
]);

export function nextStage(record: NoteJobRecord, probe: VaultProbe): JobStage {
  // A merely derivable (targetNotePath) or claimed (claimedNotePath) path
  // that happens to be occupied is NOT a shortcut — that is collision
  // territory (rule 5). Only a persisted, confirmed notePath qualifies.
  if (
    SHORTCUT_ELIGIBLE_STAGES.has(record.stage) &&
    record.notePath !== undefined &&
    probe.exists(record.notePath)
  ) {
    return "timestamps";
  }
  if (record.stage === "timestamps" && record.translation !== undefined) {
    return "translation";
  }
  return LINEAR_NEXT_STAGE[record.stage];
}

/**
 * Claim protocol (enforced by Task 4, documented here for reference):
 *  (a) use record.targetNotePath (frozen after transcript);
 *  (b) probe.exists(target) => ask-user/note-collision BEFORE any paid call
 *      is made for the summary, if the note already exists at job start;
 *  (c) after the summary returns and the template is rendered to
 *      finalContent, persist claimedNotePath = target, claimedAt = now,
 *      claimedContentHash = fnv1a64Hex(finalContent),
 *      claimedContentLength = finalContent.length, stage = "note-creating",
 *      inFlight = true;
 *  (d) vault.create(target, finalContent);
 *  (e) persist notePath = target, stage = "note-created", inFlight = false.
 * Persisting (c) before (d) is what makes ownership crash-safe; the
 * fingerprint is what makes adoption evidence-based.
 */
