import { describe, expect, it } from "vitest";
import { createJobRecord, type NoteJobRecord } from "../jobs/job-record";
import type { ClosedOnColdStart, RecoveryPrompt } from "../jobs/job-runner";
import {
  buildRecoveryRow,
  coldStartNoticeText,
  doneNoticeText,
  formatJobAge,
  recoveryNoticeText,
  shouldOpenRecoveryModal,
} from "./recovery-ui-model";

// Every string the model can emit, gathered here so the sentence-case test
// (below) can check them all without hand-duplicating the list.
const ALL_LABELS = [
  "Resume",
  "Resume (may re-bill)",
  "Finish without timestamps",
  "Finish without translation",
  "Cancel",
  "Discard",
  "Open note",
];

function baseRecord(overrides: Partial<NoteJobRecord> = {}): NoteJobRecord {
  const record = createJobRecord({
    id: "job-1",
    url: "https://youtu.be/abc123",
    videoId: "abc123",
    folder: "",
    customTitle: "",
    useFastSummary: false,
    transcriptBilling: "free",
    now: 0,
  });
  return { ...record, ...overrides };
}

function actionIds(row: ReturnType<typeof buildRecoveryRow>): string[] {
  return row.actions.map((a) => a.id);
}

describe("buildRecoveryRow", () => {
  it("nothing/live: Running, cancel only, cta on cancel", () => {
    const record = baseRecord({ status: "running" });
    const prompt: RecoveryPrompt = { action: "nothing", why: "live" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Running");
    expect(actionIds(row)).toEqual(["cancel"]);
    expect(row.actions[0]?.cta).toBe(true);
    expect(row.actions[0]?.warnsAboutBilling).toBe(false);
  });

  it("nothing/terminal: Finished when done", () => {
    const record = baseRecord({ status: "done", stage: "done" });
    const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Finished");
    expect(actionIds(row)).toEqual(["discard"]);
    expect(row.actions[0]?.cta).toBe(true);
  });

  it("nothing/terminal: Failed: <lastError> when failed", () => {
    const record = baseRecord({ status: "failed", lastError: "network timeout" });
    const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Failed: network timeout");
    expect(actionIds(row)).toEqual(["discard"]);
  });

  it("nothing/terminal: Cancelled when cancelled", () => {
    const record = baseRecord({ status: "cancelled" });
    const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Cancelled");
    expect(actionIds(row)).toEqual(["discard"]);
  });

  it("continue/auto-resume/adopt-note: Ready to continue, resume (no billing warning) + discard", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary" });
    const prompts: RecoveryPrompt[] = [
      { action: "continue", fromStage: "summary" },
      { action: "auto-resume", fromStage: "transcript" },
      { action: "adopt-note", notePath: "notes/foo.md" },
    ];

    for (const prompt of prompts) {
      const row = buildRecoveryRow(record, prompt);
      expect(row.statusLine).toBe("Ready to continue");
      expect(actionIds(row)).toEqual(["resume", "discard"]);
      expect(row.actions[0]?.warnsAboutBilling).toBe(false);
      expect(row.actions[0]?.label).toBe("Resume");
      expect(row.actions[0]?.cta).toBe(true);
      expect(row.actions[1]?.cta).toBe(false);
    }
  });

  it("ask-user paid-stage-in-flight: billed warning, resume (may re-bill) first, no finish-without-timestamps when not allowed", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Interrupted during Summarizing; the previous request may already have been billed");
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    expect(row.actions[0]?.warnsAboutBilling).toBe(true);
    expect(row.actions[0]?.label).toBe("Resume (may re-bill)");
    expect(row.actions[0]?.cta).toBe(true);
  });

  it("ask-user paid-stage-in-flight: adds finish-without-timestamps when allowed (timestamps stage)", () => {
    const record = baseRecord({ status: "interrupted", stage: "timestamps" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe(
      "Interrupted during Adding timestamp links; the previous request may already have been billed",
    );
    expect(actionIds(row)).toEqual(["resume", "finish-without-timestamps", "discard"]);
    expect(row.actions[1]?.label).toBe("Finish without timestamps");
    expect(row.actions[1]?.warnsAboutBilling).toBe(false);
  });

  it("ask-user unknown-billing-in-flight: unknown billing wording, same action shape", () => {
    const record = baseRecord({ status: "interrupted", stage: "transcript" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "unknown-billing-in-flight",
      stage: "transcript",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe(
      "Interrupted during Fetching transcript; billing for the previous request is unknown",
    );
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    expect(row.actions[0]?.warnsAboutBilling).toBe(true);
  });

  it("ask-user attempts-exhausted: no resume, finish-without-timestamps only when allowed", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary" });
    const promptNoFinish: RecoveryPrompt = {
      action: "ask-user",
      reason: "attempts-exhausted",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const rowNoFinish = buildRecoveryRow(record, promptNoFinish);
    expect(rowNoFinish.statusLine).toBe("Too many attempts for Summarizing");
    expect(actionIds(rowNoFinish)).toEqual(["discard"]);
    expect(rowNoFinish.actions[0]?.cta).toBe(true);

    const promptFinish: RecoveryPrompt = {
      action: "ask-user",
      reason: "attempts-exhausted",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    };
    const rowFinish = buildRecoveryRow(record, promptFinish);
    expect(rowFinish.statusLine).toBe("Too many attempts for Adding timestamp links");
    expect(actionIds(rowFinish)).toEqual(["finish-without-timestamps", "discard"]);
    expect(rowFinish.actions[0]?.cta).toBe(true);
  });

  it("ask-user note-collision: resume (may re-bill) first, then discard; rename/remove guidance kept", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-creating" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "note-collision",
      stage: "note-creating",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe(
      "A note already exists at the target path — rename or remove it, then resume from Show active jobs",
    );
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    // Resuming re-enters at the paid summary stage (job-runner REGENERATE_REASONS), so the warning is required.
    expect(row.actions[0]?.warnsAboutBilling).toBe(true);
    expect(row.actions[0]?.label).toBe("Resume (may re-bill)");
    expect(row.actions[0]?.cta).toBe(true);
    expect(row.actions[1]?.warnsAboutBilling).toBe(false);
  });

  it("ask-user claim-unresolved: discard only", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-creating" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "claim-unresolved",
      stage: "note-creating",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Could not confirm whether the note at the target path belongs to this job");
    expect(actionIds(row)).toEqual(["discard"]);
  });

  it("ask-user note-missing: resume (may re-bill) + discard", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-created" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "note-missing",
      stage: "note-created",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("The note for this job was moved or deleted");
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    expect(row.actions[0]?.warnsAboutBilling).toBe(true);
    expect(row.actions[0]?.label).toBe("Resume (may re-bill)");
  });

  it("ask-user note-changed: discard only, no billing warning", () => {
    const record = baseRecord({ status: "interrupted", stage: "timestamps" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "note-changed",
      stage: "timestamps",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("The note was edited during processing; timestamps were skipped");
    expect(actionIds(row)).toEqual(["discard"]);
  });

  it("ask-user templater-unavailable: resume (no warning) + discard", () => {
    const record = baseRecord({ status: "interrupted", stage: "note-creating" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "templater-unavailable",
      stage: "note-creating",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Templater is not available; enable it, then resume");
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    expect(row.actions[0]?.warnsAboutBilling).toBe(false);
    expect(row.actions[0]?.label).toBe("Resume");
  });

  it("ask-user blocked paid-refetch-required: resume (may re-bill) + optional finish + discard", () => {
    const record = baseRecord({ status: "interrupted", stage: "transcript" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-refetch-required",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe("Resuming re-fetches the transcript through a paid service");
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    expect(row.actions[0]?.warnsAboutBilling).toBe(true);
    expect(row.actions[0]?.label).toBe("Resume (may re-bill)");

    const promptWithFinish: RecoveryPrompt = {
      ...prompt,
      canFinishWithoutTimestamps: true,
    };
    const rowWithFinish = buildRecoveryRow(record, promptWithFinish);
    expect(actionIds(rowWithFinish)).toEqual(["resume", "finish-without-timestamps", "discard"]);
  });

  it("ask-user blocked path-drift: settings guidance, resume (may re-bill) + discard", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary", blocked: "path-drift" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "path-drift",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);
    expect(row.statusLine).toBe(
      "The note path could not be computed consistently (check folder and date settings), then resume",
    );
    expect(actionIds(row)).toEqual(["resume", "discard"]);
    expect(row.actions[0]).toMatchObject({ label: "Resume (may re-bill)", warnsAboutBilling: true, cta: true });
  });

  it("terminal app-closed: interrupted-when-closed wording, open note (when the note exists) + discard, never resume", () => {
    const terminal: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const noNote = buildRecoveryRow(
      baseRecord({ status: "failed", interruption: "app-closed", stage: "summary", claimedNotePath: "Notes/A.md", lastError: "net down" }),
      terminal,
    );
    expect(noNote.statusLine).toBe("Interrupted when Obsidian closed; no note was created");
    expect(actionIds(noNote)).toEqual(["discard"]);

    // note-creating window, the vault probe found a file at the claimed path (#3 batch G item 7):
    // named as "may exist" (the record never learned it), and never offered as Open note (claimedNotePath
    // is not proof — only record.notePath gates that action).
    const mayExist = buildRecoveryRow(
      baseRecord({ status: "failed", interruption: "app-closed", stage: "note-creating", claimedNotePath: "Notes/A.md" }),
      terminal,
      false,
      true,
    );
    expect(mayExist.statusLine).toBe("Interrupted when Obsidian closed; a note may exist at Notes/A.md");
    expect(actionIds(mayExist)).toEqual(["discard"]);

    const noteGone = buildRecoveryRow(
      baseRecord({ status: "failed", interruption: "app-closed", stage: "timestamps", notePath: "Notes/A.md" }),
      terminal,
      false,
    );
    expect(noteGone.statusLine).toBe("Interrupted when Obsidian closed; the note was created without timestamps");
    expect(actionIds(noteGone)).toEqual(["discard"]);

    const withNote = buildRecoveryRow(
      baseRecord({ status: "failed", interruption: "app-closed", stage: "timestamps", notePath: "Notes/A.md" }),
      terminal,
      true,
    );
    expect(actionIds(withNote)).toEqual(["open-note", "discard"]);
    expect(withNote.actions[0]).toMatchObject({ label: "Open note", warnsAboutBilling: false, cta: true });
    expect(withNote.notePath).toBe("Notes/A.md");

    const atTranslation = buildRecoveryRow(
      baseRecord({ status: "failed", interruption: "app-closed", stage: "translation", notePath: "Notes/A.md" }),
      terminal,
      true,
    );
    expect(atTranslation.statusLine).toBe("Interrupted when Obsidian closed; the note was created without translation");
    expect(actionIds(atTranslation)).toEqual(["open-note", "discard"]);

    // noteExists never adds the action to any other terminal row.
    const done = buildRecoveryRow(baseRecord({ status: "done", stage: "done", notePath: "Notes/A.md" }), terminal, true);
    expect(actionIds(done)).toEqual(["discard"]);
    const failed = buildRecoveryRow(baseRecord({ status: "failed", notePath: "Notes/A.md", lastError: "x" }), terminal, true);
    expect(failed.statusLine).toBe("Failed: x");
    expect(actionIds(failed)).toEqual(["discard"]);
  });

  it("interruption timeout prefixes statusLine with 'Timed out. ' on ask-user prompts", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "timeout",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine).toBe(
      "Timed out. Interrupted during Summarizing; the previous request may already have been billed",
    );
  });

  it("does not prefix 'Timed out.' when interruption is unknown", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "summary",
      canFinishWithoutTimestamps: false,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);

    expect(row.statusLine.startsWith("Timed out.")).toBe(false);
  });

  it("stageLabel: one human label per JobStage", () => {
    const record = baseRecord({ status: "interrupted" });
    const cases: Array<[NoteJobRecord["stage"], string]> = [
      ["transcript", "Fetching transcript"],
      ["summary", "Summarizing"],
      ["note-creating", "Creating note"],
      ["note-created", "Note created"],
      ["timestamps", "Adding timestamp links"],
      ["translation", "Translating"],
      ["done", "Done"],
    ];

    for (const [stage, label] of cases) {
      const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
      const row = buildRecoveryRow({ ...record, stage, status: "done" }, prompt);
      expect(row.stageLabel).toBe(label);
    }
  });

  it("notePath: prefers record.notePath over claimedNotePath", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "note-created",
      notePath: "notes/real.md",
      claimedNotePath: "notes/claimed.md",
    });
    const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.notePath).toBe("notes/real.md");
  });

  it("notePath: falls back to claimedNotePath when notePath is undefined", () => {
    const record = baseRecord({
      status: "interrupted",
      stage: "note-creating",
      claimedNotePath: "notes/claimed.md",
    });
    const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.notePath).toBe("notes/claimed.md");
  });

  it("notePath: omitted when neither notePath nor claimedNotePath is set", () => {
    const record = baseRecord({ status: "interrupted", stage: "transcript" });
    const prompt: RecoveryPrompt = { action: "nothing", why: "terminal" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.notePath).toBeUndefined();
    expect("notePath" in row).toBe(false);
  });

  it("title: prefers effectiveTitle over url", () => {
    const record = baseRecord({ customTitle: "My custom title" });
    const prompt: RecoveryPrompt = { action: "nothing", why: "live" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.title).toBe("My custom title");
  });

  it("title: falls back to record.url when no title is resolved", () => {
    const record = baseRecord();
    const prompt: RecoveryPrompt = { action: "nothing", why: "live" };
    const row = buildRecoveryRow(record, prompt);

    expect(row.title).toBe(record.url);
  });

  it("every label in every row is sentence case (first char upper, no other capitalised word except Templater/TubeSage)", () => {
    const record = baseRecord({ status: "interrupted", stage: "summary" });
    const prompts: RecoveryPrompt[] = [
      { action: "nothing", why: "live" },
      { action: "nothing", why: "terminal" },
      { action: "continue", fromStage: "summary" },
      {
        action: "ask-user",
        reason: "paid-stage-in-flight",
        stage: "timestamps",
        canFinishWithoutTimestamps: true,
        interruption: "unknown",
      },
      {
        action: "ask-user",
        reason: "attempts-exhausted",
        stage: "timestamps",
        canFinishWithoutTimestamps: true,
        interruption: "unknown",
      },
      {
        action: "ask-user",
        reason: "note-collision",
        stage: "note-creating",
        canFinishWithoutTimestamps: false,
        interruption: "unknown",
      },
      {
        action: "ask-user",
        reason: "templater-unavailable",
        stage: "note-creating",
        canFinishWithoutTimestamps: false,
        interruption: "unknown",
      },
      {
        action: "ask-user",
        reason: "path-drift",
        stage: "summary",
        canFinishWithoutTimestamps: false,
        interruption: "unknown",
      },
      {
        action: "ask-user",
        reason: "paid-stage-in-flight",
        stage: "translation",
        canFinishWithoutTimestamps: true,
        interruption: "unknown",
      },
    ];

    const labels = new Set<string>();
    for (const prompt of prompts) {
      const row = buildRecoveryRow({ ...record, status: "done" }, prompt);
      for (const action of row.actions) {
        labels.add(action.label);
      }
    }
    const closed = buildRecoveryRow(
      { ...record, status: "failed", interruption: "app-closed", notePath: "A.md" },
      { action: "nothing", why: "terminal" },
      true,
    );
    for (const action of closed.actions) {
      labels.add(action.label);
    }

    const allowedInnerCaps = new Set(["Templater", "TubeSage"]);
    for (const label of labels) {
      expect(label[0]).toBe(label[0]?.toUpperCase());
      const words = label.split(/\s+/);
      for (const word of words.slice(1)) {
        // Strip trailing punctuation like ")" or "." before checking case.
        const bare = word.replace(/[^A-Za-z]/g, "");
        if (bare.length === 0) continue;
        const isAllCapsOrTitleCase = bare[0] === bare[0]?.toUpperCase() && bare !== bare.toLowerCase();
        if (isAllCapsOrTitleCase) {
          expect(allowedInnerCaps.has(bare)).toBe(true);
        }
      }
    }
    expect(labels.size).toBeGreaterThan(0);
    // Sanity: ALL_LABELS constant stays in sync with what the model actually emits.
    for (const label of labels) {
      expect(ALL_LABELS).toContain(label);
    }
  });
});

describe("buildRecoveryRow — translation stage (#3 final review residual)", () => {
  it("paid-stage-in-flight at translation: the finish action keeps its id but is labelled for translation; the timestamps pass is not offered again", () => {
    const record = baseRecord({ status: "interrupted", stage: "translation", notePath: "Video.md" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "translation",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);
    expect(row.stageLabel).toBe("Translating");
    expect(row.statusLine).toBe("Interrupted during Translating; the previous request may already have been billed");
    expect(actionIds(row)).toEqual(["resume", "finish-without-timestamps", "discard"]);
    expect(row.actions[1]?.label).toBe("Finish without translation");
    expect(row.actions[1]?.warnsAboutBilling).toBe(false);
  });

  it("attempts-exhausted at translation: finish (labelled for translation) and discard only", () => {
    const record = baseRecord({ status: "interrupted", stage: "translation", notePath: "Video.md" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "attempts-exhausted",
      stage: "translation",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    };
    const row = buildRecoveryRow(record, prompt);
    expect(row.statusLine).toBe("Too many attempts for Translating");
    expect(row.actions.map((a) => [a.id, a.label])).toEqual([
      ["finish-without-timestamps", "Finish without translation"],
      ["discard", "Discard"],
    ]);
  });

  it("the timestamps stage keeps its original finish label", () => {
    const record = baseRecord({ status: "interrupted", stage: "timestamps", notePath: "Video.md" });
    const prompt: RecoveryPrompt = {
      action: "ask-user",
      reason: "paid-stage-in-flight",
      stage: "timestamps",
      canFinishWithoutTimestamps: true,
      interruption: "unknown",
    };
    expect(buildRecoveryRow(record, prompt).actions[1]?.label).toBe("Finish without timestamps");
  });
});

describe("doneNoticeText", () => {
  it("keeps the two legacy notices byte-for-byte when translation was not skipped", () => {
    expect(doneNoticeText({ type: "done", id: "j", notePath: "V.md" })).toBe("Transcript note created successfully");
    expect(doneNoticeText({ type: "done", id: "j", notePath: "V.md", timestampsSkipped: "user-choice" })).toBe(
      "Transcript note created successfully",
    );
    expect(doneNoticeText({ type: "done", id: "j", notePath: "V.md", timestampsSkipped: "note-changed" })).toBe(
      "Note created, but timestamps were skipped because the note was edited",
    );
  });

  it("names a skipped translation (sentence case), by cause", () => {
    expect(doneNoticeText({ type: "done", id: "j", notePath: "V.md", translationSkipped: "note-changed" })).toBe(
      "Note created, but the translation was skipped because the note was edited",
    );
    expect(doneNoticeText({ type: "done", id: "j", notePath: "V.md", translationSkipped: "user-choice" })).toBe(
      "Note created without translation",
    );
    expect(
      doneNoticeText({ type: "done", id: "j", notePath: "V.md", timestampsSkipped: "note-changed", translationSkipped: "note-changed" }),
    ).toBe("Note created, but timestamps and the translation were skipped because the note was edited");
    expect(
      doneNoticeText({ type: "done", id: "j", notePath: "V.md", timestampsSkipped: "user-choice", translationSkipped: "user-choice" }),
    ).toBe("Note created without timestamps or translation");
  });

  it("a translation skipped because the timestamps pass itself was skipped (#3 D2 legacy parity) reads the same as skipping both by choice", () => {
    expect(
      doneNoticeText({ type: "done", id: "j", notePath: "V.md", timestampsSkipped: "user-choice", translationSkipped: "timestamps-skipped" }),
    ).toBe("Note created without timestamps or translation");
  });
});

describe("shouldOpenRecoveryModal", () => {
  it("startup never opens the modal (Notice only) — the cold-start pass never classifies, so there is nothing to prompt (#3 batch G item 8)", () => {
    expect(shouldOpenRecoveryModal("startup", 0)).toBe(false);
    expect(shouldOpenRecoveryModal("startup", 1)).toBe(false);
  });

  it("visible never opens the modal (Notice only)", () => {
    expect(shouldOpenRecoveryModal("visible", 0)).toBe(false);
    expect(shouldOpenRecoveryModal("visible", 1)).toBe(false);
  });

  it("manual always opens, even with zero prompts (empty state)", () => {
    expect(shouldOpenRecoveryModal("manual", 0)).toBe(true);
    expect(shouldOpenRecoveryModal("manual", 1)).toBe(true);
  });
});

describe("recoveryNoticeText", () => {
  it("returns undefined for zero prompts", () => {
    expect(recoveryNoticeText(0)).toBeUndefined();
  });

  it("uses singular wording for exactly one prompt", () => {
    expect(recoveryNoticeText(1)).toBe("TubeSage: 1 interrupted job needs attention");
  });

  it("uses plural wording for more than one prompt", () => {
    expect(recoveryNoticeText(2)).toBe("TubeSage: 2 interrupted jobs need attention");
  });
});

describe("coldStartNoticeText", () => {
  function closedOf(record: NoteJobRecord, noteMayExist = false): ClosedOnColdStart {
    return { record, noteMayExist };
  }

  it("returns undefined when nothing was closed", () => {
    expect(coldStartNoticeText([])).toBeUndefined();
  });

  it("one job: names it and says what exists on disk, from notePath, the vault probe and stage", () => {
    const closed = (overrides: Partial<NoteJobRecord>) =>
      baseRecord({ status: "failed", interruption: "app-closed", resolvedTitle: "My Talk", ...overrides });
    expect(coldStartNoticeText([closedOf(closed({ stage: "summary" }))])).toBe(
      "TubeSage: 1 note job was interrupted when Obsidian closed — My Talk: no note was created",
    );
    // note-creating window, the vault probe found nothing at the claimed path: still "no note was created".
    expect(coldStartNoticeText([closedOf(closed({ stage: "note-creating", claimedNotePath: "A.md" }), false)])).toBe(
      "TubeSage: 1 note job was interrupted when Obsidian closed — My Talk: no note was created",
    );
    // note-creating window, the vault probe found a file at the claimed path (#3 batch G item 7).
    expect(coldStartNoticeText([closedOf(closed({ stage: "note-creating", claimedNotePath: "A.md" }), true)])).toBe(
      "TubeSage: 1 note job was interrupted when Obsidian closed — My Talk: a note may exist at A.md",
    );
    expect(coldStartNoticeText([closedOf(closed({ stage: "timestamps", notePath: "A.md" }))])).toBe(
      "TubeSage: 1 note job was interrupted when Obsidian closed — My Talk: note was created without timestamps",
    );
    expect(coldStartNoticeText([closedOf(closed({ stage: "translation", notePath: "A.md" }))])).toBe(
      "TubeSage: 1 note job was interrupted when Obsidian closed — My Talk: note was created without translation",
    );
    // No resolved title yet: the URL stands in, as in the modal rows.
    expect(coldStartNoticeText([closedOf(closed({ stage: "transcript", resolvedTitle: undefined }))])).toBe(
      "TubeSage: 1 note job was interrupted when Obsidian closed — https://youtu.be/abc123: no note was created",
    );
  });

  it("several jobs: a count and an accurate pointer to the list, even beyond the recent-terminal cap (#3 batch G item 2)", () => {
    const a = baseRecord({ id: "a", status: "failed", interruption: "app-closed" });
    const b = baseRecord({ id: "b", status: "failed", interruption: "app-closed" });
    expect(coldStartNoticeText([closedOf(a), closedOf(b)])).toBe(
      "TubeSage: 2 note jobs were interrupted when Obsidian closed; the most recent are listed under Show active jobs",
    );
  });
});

describe("formatJobAge", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("is a pure function of the two epochs (no clock read)", () => {
    expect(formatJobAge(1_000, 1_000)).toBe("just now");
    expect(formatJobAge(1_000, 1_000 + 59_999)).toBe("just now");
    expect(formatJobAge(1_000, 1_000 + MIN)).toBe("1 min ago");
    expect(formatJobAge(1_000, 1_000 + 5 * MIN)).toBe("5 min ago");
    expect(formatJobAge(1_000, 1_000 + HOUR)).toBe("1 h ago");
    expect(formatJobAge(1_000, 1_000 + 3 * HOUR + 10 * MIN)).toBe("3 h ago");
    expect(formatJobAge(1_000, 1_000 + DAY)).toBe("1 d ago");
    expect(formatJobAge(1_000, 1_000 + 2 * DAY + 5 * HOUR)).toBe("2 d ago");
  });

  it("a future updatedAt (clock skew) reads as just now", () => {
    expect(formatJobAge(5_000, 1_000)).toBe("just now");
  });
});
