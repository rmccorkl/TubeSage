import { describe, expect, it } from "vitest";
import { createJobRecord, fnv1a64Hex, type JobStage, type NoteJobRecord } from "./job-record";
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_MS,
  classifyOnResume,
  nextStage,
  type VaultProbe,
} from "./job-planner";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

// In-memory VaultProbe fake backed by a Map, per the brief.
function makeProbe(entries: Record<string, string | undefined> = {}): VaultProbe {
  const map = new Map<string, string | undefined>(Object.entries(entries));
  return {
    exists: (path) => map.has(path),
    content: (path) => map.get(path),
  };
}

function baseRecord(overrides: Partial<NoteJobRecord> = {}): NoteJobRecord {
  const record = createJobRecord({
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "",
    customTitle: "Video Title",
    useFastSummary: false,
    transcriptBilling: "free",
    now: NOW,
  });
  return { ...record, ...overrides };
}

describe("classifyOnResume — rule 1: terminal", () => {
  it.each(["done", "cancelled", "failed"] as const)(
    "status %s returns nothing/terminal regardless of stage",
    (status) => {
      const record = baseRecord({ status, stage: "summary" });
      expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "nothing", why: "terminal" });
    },
  );

  it("stage 'done' with status 'running' returns nothing/terminal", () => {
    const record = baseRecord({ status: "running", stage: "done", heartbeatAt: NOW });
    expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "nothing", why: "terminal" });
  });
});

describe("classifyOnResume — rule 2: live runner", () => {
  it("running + fresh heartbeat + no deadline returns nothing/live", () => {
    const record = baseRecord({ status: "running", stage: "summary", heartbeatAt: NOW, inFlight: false });
    expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "nothing", why: "live" });
  });

  const nonTerminalStages: JobStage[] = ["transcript", "summary", "note-creating", "note-created", "timestamps"];
  it.each(nonTerminalStages)(
    "a fresh-heartbeat running record at stage %s returns nothing/live",
    (stage) => {
      const record = baseRecord({ status: "running", stage, heartbeatAt: NOW, inFlight: false });
      expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "nothing", why: "live" });
    },
  );

  it("running + fresh heartbeat + inFlight + past deadline is NOT live: falls through with interruption 'timeout'", () => {
    const record = baseRecord({
      status: "running",
      stage: "summary",
      heartbeatAt: NOW, // fresh — not stale
      inFlight: true,
      deadlineAt: NOW - 1, // already past
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "timeout",
    });
  });

  it("running + stale heartbeat falls through even without a deadline", () => {
    const record = baseRecord({
      status: "running",
      stage: "transcript",
      heartbeatAt: NOW - (STALE_AFTER_MS + 1), // stale
      inFlight: true,
      billing: { transcript: "free" },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    // If rule 2 had incorrectly matched, this would be nothing/live instead.
    expect(decision).toEqual({ action: "auto-resume", fromStage: "transcript" });
  });
});

describe("classifyOnResume — rule 3: attempts exhausted", () => {
  // status "interrupted" sidesteps rule 2 entirely (it only matches "running"),
  // which is also the realistic post-app-kill status for these fixtures.
  it("summary in flight with attempts.summary = 3 asks the user (attempts-exhausted)", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "summary",
      inFlight: true,
      attempts: { transcript: 0, summary: 3, timestamps: 0, translation: 0 },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "attempts-exhausted" });
  });

  it("timestamps clean (not in flight) with attempts.timestamps = 3 still asks the user", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "timestamps",
      inFlight: false,
      notePath: "Video Title.md",
      attempts: { transcript: 0, summary: 0, timestamps: 3, translation: 0 },
    });
    const decision = classifyOnResume(record, makeProbe({ "Video Title.md": "content" }), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "attempts-exhausted" });
  });

  it("M2: timestamps with attempts.timestamps = 3 CAN finish without timestamps when the note exists at notePath", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "timestamps",
      inFlight: true,
      notePath: "Video Title.md",
      attempts: { transcript: 1, summary: 1, timestamps: 3, translation: 0 },
    });
    const decision = classifyOnResume(record, makeProbe({ "Video Title.md": "content" }), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "attempts-exhausted",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    });
  });

  it("M2: timestamps with attempts.timestamps = 3 cannot finish when the note is missing or notePath is unset", () => {
    const missing = baseRecord({
      status: "interrupted",
      stage: "timestamps",
      inFlight: false,
      notePath: "Video Title.md",
      attempts: { transcript: 1, summary: 1, timestamps: 3, translation: 0 },
    });
    expect(classifyOnResume(missing, makeProbe(), NOW)).toMatchObject({
      reason: "attempts-exhausted",
      canFinishWithoutTimestamps: false,
    });
    const unset = baseRecord({
      status: "interrupted",
      stage: "timestamps",
      inFlight: false,
      attempts: { transcript: 1, summary: 1, timestamps: 3, translation: 0 },
    });
    expect(classifyOnResume(unset, makeProbe({ "Video Title.md": "content" }), NOW)).toMatchObject({
      reason: "attempts-exhausted",
      canFinishWithoutTimestamps: false,
    });
    // A paid stage that has no note yet never gets the flag, note or not.
    const summary = baseRecord({
      status: "interrupted",
      stage: "summary",
      inFlight: true,
      attempts: { transcript: 1, summary: 3, timestamps: 0, translation: 0 },
    });
    expect(classifyOnResume(summary, makeProbe({ "Video Title.md": "content" }), NOW)).toMatchObject({
      reason: "attempts-exhausted",
      canFinishWithoutTimestamps: false,
    });
  });

  it("transcript clean (not in flight) with attempts.transcript = 3 is allowed to continue", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "transcript",
      inFlight: false,
      attempts: { transcript: 3, summary: 0, timestamps: 0, translation: 0 },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toEqual({ action: "continue", fromStage: "transcript" });
  });

  it("transcript IN FLIGHT with free billing and attempts.transcript = 3 asks the user, not auto-resume (inFlight disjunct)", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "transcript",
      inFlight: true,
      billing: { transcript: "free" },
      attempts: { transcript: 3, summary: 0, timestamps: 0, translation: 0 },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "attempts-exhausted", stage: "transcript" });
  });

  it("note-creating with attempts.summary = 3 asks the user (attempts-exhausted)", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "note-creating",
      inFlight: false,
      claimedNotePath: "Video Title.md",
      claimedContentHash: fnv1a64Hex("x"),
      claimedContentLength: 1,
      attempts: { transcript: 0, summary: 3, timestamps: 0, translation: 0 },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "attempts-exhausted" });
  });
});

describe("classifyOnResume — rule 7: transcript", () => {
  it("in flight with free billing auto-resumes", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "transcript",
      inFlight: true,
      billing: { transcript: "free" },
    });
    expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "auto-resume", fromStage: "transcript" });
  });

  it("in flight with paid billing asks the user", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "transcript",
      inFlight: true,
      billing: { transcript: "paid" },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "transcript",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    });
  });

  it("in flight with unknown billing asks the user with unknown-billing-in-flight", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "transcript",
      inFlight: true,
      billing: { transcript: "unknown" },
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "unknown-billing-in-flight",
      stage: "transcript",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    });
  });

  it("clean (not in flight) continues regardless of billing", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "transcript",
      inFlight: false,
      billing: { transcript: "paid" },
    });
    expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "continue", fromStage: "transcript" });
  });

  it("an unknown stage string (record from a newer plugin) is nothing/terminal, never auto-resumed", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "bogus" as JobStage,
      inFlight: false,
      billing: { transcript: "free" },
    });
    expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "nothing", why: "terminal" });
  });
});

describe("classifyOnResume — rule 6: summary", () => {
  it("in flight asks the user, cannot finish without timestamps", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary", inFlight: true });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    });
  });

  it("clean (not in flight) continues", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary", inFlight: false });
    expect(classifyOnResume(record, makeProbe(), NOW)).toEqual({ action: "continue", fromStage: "summary" });
  });
});

describe("classifyOnResume — rule 5: note-creating", () => {
  const target = "Video Title.md";

  it("missing claim fields asks the user (claim-unresolved)", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-creating", inFlight: false });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "claim-unresolved" });
  });

  it("claimed file absent means the create never landed: asks to redo the summary", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "note-creating",
      inFlight: true,
      claimedNotePath: target,
      claimedContentHash: fnv1a64Hex("body"),
      claimedContentLength: 4,
    });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    });
  });

  it("claimed file present with matching fingerprint adopts the note", () => {
    const content = "# Video Title\n\nBody";
    const record = baseRecord({
      status: "interrupted",
      stage: "note-creating",
      inFlight: true,
      claimedNotePath: target,
      claimedContentHash: fnv1a64Hex(content),
      claimedContentLength: content.length,
    });
    const decision = classifyOnResume(record, makeProbe({ [target]: content }), NOW);
    expect(decision).toEqual({ action: "adopt-note", notePath: target });
  });

  it("claimed file present with different content is a collision", () => {
    const claimed = "# Video Title\n\nBody";
    const actual = "# Someone else's note";
    const record = baseRecord({
      status: "interrupted",
      stage: "note-creating",
      inFlight: true,
      claimedNotePath: target,
      claimedContentHash: fnv1a64Hex(claimed),
      claimedContentLength: claimed.length,
    });
    const decision = classifyOnResume(record, makeProbe({ [target]: actual }), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "note-collision" });
  });

  it("claimed file present but content unreadable is claim-unresolved (ctime is never consulted)", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "note-creating",
      inFlight: true,
      claimedNotePath: target,
      claimedContentHash: fnv1a64Hex("body"),
      claimedContentLength: 4,
    });
    // exists() true, content() undefined — file exists on disk but wasn't (or couldn't be) pre-read.
    const probe: VaultProbe = { exists: () => true, content: () => undefined };
    const decision = classifyOnResume(record, probe, NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "claim-unresolved" });
  });
});

describe("classifyOnResume — rule 4: note-created / timestamps", () => {
  const target = "Video Title.md";

  it("note-created with the note present continues to timestamps", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-created", inFlight: false, notePath: target });
    const decision = classifyOnResume(record, makeProbe({ [target]: "content" }), NOW);
    expect(decision).toEqual({ action: "continue", fromStage: "timestamps" });
  });

  it("note-created with the note missing asks the user (note-missing)", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-created", inFlight: false, notePath: target });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "note-missing" });
  });

  it("timestamps in flight asks the user, and CAN finish without timestamps", () => {
    const record = baseRecord({ status: "interrupted", stage: "timestamps", inFlight: true, notePath: target });
    const decision = classifyOnResume(record, makeProbe({ [target]: "content" }), NOW);
    expect(decision).toEqual({
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    });
  });

  it("timestamps clean (not in flight) continues", () => {
    const record = baseRecord({ status: "interrupted", stage: "timestamps", inFlight: false, notePath: target });
    const decision = classifyOnResume(record, makeProbe({ [target]: "content" }), NOW);
    expect(decision).toEqual({ action: "continue", fromStage: "timestamps" });
  });

  it("timestamps with notePath unset asks the user (note-missing)", () => {
    const record = baseRecord({ status: "interrupted", stage: "timestamps", inFlight: false });
    const decision = classifyOnResume(record, makeProbe(), NOW);
    expect(decision).toMatchObject({ action: "ask-user", reason: "note-missing" });
  });
});

describe("classifyOnResume — translation stage (#3 final review residual)", () => {
  const target = "Video Title.md";

  it("translation with the note missing (or notePath unset) asks the user (note-missing), never recreates the note", () => {
    const unset = baseRecord({ status: "interrupted", stage: "translation", inFlight: false });
    expect(classifyOnResume(unset, makeProbe(), NOW)).toMatchObject({ action: "ask-user", reason: "note-missing", stage: "translation" });
    const missing = baseRecord({ status: "interrupted", stage: "translation", inFlight: false, notePath: target });
    expect(classifyOnResume(missing, makeProbe(), NOW)).toMatchObject({ action: "ask-user", reason: "note-missing", stage: "translation" });
  });

  it("translation in flight asks the user (paid-stage-in-flight) and CAN finish without further LLM calls", () => {
    const record = baseRecord({ status: "interrupted", stage: "translation", inFlight: true, notePath: target });
    expect(classifyOnResume(record, makeProbe({ [target]: "content" }), NOW)).toEqual({
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "translation",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    });
  });

  it("translation in flight and past its deadline reports a timeout", () => {
    const record = baseRecord({ status: "interrupted", stage: "translation", inFlight: true, deadlineAt: NOW - 1, notePath: target });
    expect(classifyOnResume(record, makeProbe({ [target]: "content" }), NOW)).toMatchObject({ reason: "paid-stage-in-flight", interruption: "timeout" });
  });

  it("translation clean (not in flight) continues from translation — never from timestamps (the timestamps pass is on disk)", () => {
    const record = baseRecord({ status: "interrupted", stage: "translation", inFlight: false, notePath: target });
    expect(classifyOnResume(record, makeProbe({ [target]: "content" }), NOW)).toEqual({ action: "continue", fromStage: "translation" });
  });

  it("rule 3: translation reads its OWN attempts ledger — attempts.translation = 3 is exhausted (with finish offered when the note exists), a spent timestamps budget does not gate it", () => {
    const exhausted = baseRecord({
      status: "interrupted",
      stage: "translation",
      inFlight: false,
      notePath: target,
      attempts: { transcript: 1, summary: 1, timestamps: 1, translation: 3 },
    });
    expect(classifyOnResume(exhausted, makeProbe({ [target]: "content" }), NOW)).toEqual({
      action: "ask-user",
      reason: "attempts-exhausted",
      stage: "translation",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    });
    const noteGone = { ...exhausted };
    expect(classifyOnResume(noteGone, makeProbe(), NOW)).toMatchObject({ reason: "attempts-exhausted", canFinishWithoutTimestamps: false });
    const timestampsSpent = baseRecord({
      status: "interrupted",
      stage: "translation",
      inFlight: true,
      notePath: target,
      attempts: { transcript: 1, summary: 1, timestamps: 3, translation: 1 },
    });
    expect(classifyOnResume(timestampsSpent, makeProbe({ [target]: "content" }), NOW)).toMatchObject({ reason: "paid-stage-in-flight", stage: "translation" });
  });
});

describe("nextStage", () => {
  const linear: Array<[JobStage, JobStage]> = [
    ["transcript", "summary"],
    ["summary", "note-creating"],
    ["note-creating", "note-created"],
    ["note-created", "timestamps"],
    ["timestamps", "done"],
    ["translation", "done"],
    ["done", "done"],
  ];

  it.each(linear)("advances %s -> %s when there is no shortcut", (stage, expected) => {
    const record = baseRecord({ stage });
    expect(nextStage(record, makeProbe())).toBe(expected);
  });

  it("timestamps -> translation only when the record froze translation settings; translation -> done", () => {
    const frozen = baseRecord({ stage: "timestamps", translation: { language: "fr", country: "FR" } });
    expect(nextStage(frozen, makeProbe())).toBe("translation");
    expect(nextStage({ ...frozen, stage: "translation" }, makeProbe())).toBe("done");
    expect(nextStage(baseRecord({ stage: "timestamps" }), makeProbe())).toBe("done");
  });

  it("shortcuts straight to timestamps when notePath is set and exists", () => {
    const record = baseRecord({ stage: "summary", notePath: "Video Title.md" });
    expect(nextStage(record, makeProbe({ "Video Title.md": "content" }))).toBe("timestamps");
  });

  it("does NOT shortcut when notePath is unset even though targetNotePath exists in the vault", () => {
    const record = baseRecord({ stage: "transcript", targetNotePath: "Video Title.md" });
    expect(nextStage(record, makeProbe({ "Video Title.md": "content" }))).toBe("summary");
  });

  it("does NOT shortcut when claimedNotePath exists but notePath is unset", () => {
    const record = baseRecord({ stage: "note-creating", claimedNotePath: "Video Title.md" });
    expect(nextStage(record, makeProbe({ "Video Title.md": "content" }))).toBe("note-created");
  });

  it("does NOT shortcut when notePath is set but missing from the vault", () => {
    const record = baseRecord({ stage: "summary", notePath: "Video Title.md" });
    expect(nextStage(record, makeProbe())).toBe("note-creating");
  });
});

// Pin the exported heartbeat constants to literal values: the runner's
// heartbeat cadence and the planner's staleness window are a contract with
// records already on disk, so a change here must be deliberate.
describe("heartbeat constants", () => {
  it("HEARTBEAT_INTERVAL_MS is 45 000 and STALE_AFTER_MS is 135 000", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(45_000);
    expect(STALE_AFTER_MS).toBe(135_000);
  });
});
