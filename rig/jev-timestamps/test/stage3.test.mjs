// Stage 3 on SYNTHETIC notes (no real note is ever committed), with fake
// clients: no request leaves the process.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../cli.mjs";
import { monotonicAssign } from "../lib/assign.mjs";
import { MODEL_PIN } from "../lib/constants.mjs";
import { backwardsSteps, decoySummary, rawArgmax, unconstrainedSummary } from "../lib/diagnostics.mjs";
import { cellId, planMatrixBodies, plainView, shuffledView } from "../lib/matrix.mjs";
import { formatClock, parseNote } from "../lib/note.mjs";
import { loadNote, runStage3 } from "../stages/stage3.mjs";
import { fakeSpawn, makeRequestFn } from "./fakes.mjs";

// Four topics, two one-minute segments each (minutes 0-1 topic 1, 2-3 topic 2...).
const TOPICS = [
  ["compound interest savings", "Interest earned this year earns interest next year, so compound savings snowball."],
  ["photosynthesis chlorophyll", "Leaves capture sunlight with chlorophyll and photosynthesis splits water."],
  ["roman empire collapse", "The western roman empire collapsed when the legions went unpaid."],
  ["guitar chords practice", "Practise switching guitar chords until fingers move smoothly between them."],
];
const TOPIC_WORDS = ["savings", "photosynthesis", "roman", "guitar"];
const BODY_MARKER = "UNIQUE-BODY-TEXT-MARKER";
const TRANSCRIPT_MARKER = "UNIQUE-TRANSCRIPT-MARKER";

function transcriptLine(minute) {
  const [, text] = TOPICS[Math.floor(minute / 2)];
  return `    [00:${String(minute).padStart(2, "0")}:00] [TimeIndex:${minute * 60}] ${TRANSCRIPT_MARKER} ${text} Note\\: part ${minute}.`;
}

function sectionBlock([words, text], n) {
  const link = n === 3 ? "" : ` [Watch](https://www.youtube.com/watch?v=abc123&t=${(n - 1) * 120})`;
  return `## ${n}. All about ${words}${link}\n\n${BODY_MARKER} ${text} More on ${words}.\n`;
}

const NOTE = [
  "---",
  'title: "A video"',
  "transcript:  |",
  "",
  ...Array.from({ length: 8 }, (_, minute) => transcriptLine(minute)),
  "---",
  "",
  "# A video",
  "",
  "> intro",
  "",
  ...TOPICS.map((topic, k) => sectionBlock(topic, k + 1)),
  "## Conclusion",
  "",
  "Wrap up that is not a numbered section.",
  "",
].join("\n");

function writeNote(text = NOTE) {
  const path = join(mkdtempSync(join(tmpdir(), "jev-rig-note-")), "note.md");
  writeFileSync(path, text);
  return path;
}

describe("parseNote", () => {
  const note = parseNote(NOTE);

  it("reads one segment per transcript line, timed by TimeIndex, colons unescaped", () => {
    expect(note.segments.map((s) => s.startSeconds)).toEqual([0, 60, 120, 180, 240, 300, 360, 420]);
    expect(note.segments[0].text).toContain("Note: part 0.");
  });

  it("reads numbered sections only, headings cleaned of their Watch links, with the current pass's link mapped to a segment", () => {
    expect(note.sections.map((s) => s.heading)).toEqual([
      "1. All about compound interest savings",
      "2. All about photosynthesis chlorophyll",
      "3. All about roman empire collapse",
      "4. All about guitar chords practice",
    ]);
    expect(note.sections[3].body).not.toContain("Wrap up");
    expect(note.sections.map((s) => s.currentSegment)).toEqual([0, 2, null, 6]);
  });

  it("formats clocks", () => {
    expect([formatClock(0), formatClock(725), formatClock(3723)]).toEqual(["0:00", "12:05", "1:02:03"]);
  });
});

describe("monotonicAssign", () => {
  it("maximises total weight, not each section greedily", () => {
    const w = [
      [0.8, 0.9, null],
      [null, 0.95, 0.1],
    ];
    expect(monotonicAssign(2, 3, (j, i) => w[j][i])).toEqual([0, 1]);
  });

  it("leaves a section unlinked rather than giving it the least-bad segment", () => {
    expect(monotonicAssign(2, 3, (j, i) => (j === 0 ? null : [0.1, 0.2, 0.3][i]))).toEqual([null, 2]);
  });
});

describe("matrix planning", () => {
  const note = parseNote(NOTE);

  it("asks every cell once, at most 20 per request, with no clock time anywhere in a request", () => {
    const bodies = planMatrixBodies(plainView(note.segments), note.sections);
    const qids = bodies.flatMap((body) => Object.keys(body.questions));
    expect(new Set(qids).size).toBe(32);
    expect(qids).toHaveLength(32);
    for (const body of bodies) {
      expect(Object.keys(body.questions).length).toBeLessThanOrEqual(20);
      expect(body.state).not.toMatch(/\[\d{1,2}:\d{2}/);
    }
  });

  it("a shuffled view relabels segments out of video order, reproducibly, and ids follow the labels", () => {
    const a = shuffledView(note.segments, 7);
    expect(shuffledView(note.segments, 7).order).toEqual(a.order);
    expect(a.order).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const first = a.order[0];
    expect(a.labelOf[first]).toBe("T1");
    expect(cellId(a, first, 0)).toBe("t1_n1");
    const state = planMatrixBodies(a, note.sections).map((b) => b.state).join("\n");
    expect(state).toContain(`T1: ${note.segments[first].text}`);
  });
});

describe("diagnostics", () => {
  const cells = (rows) =>
    rows.map((row) =>
      row.map((p) => (p === null ? null : { choice: p >= 0.5 ? "pertains" : "does_not_pertain", probabilities: { pertains: p, does_not_pertain: 1 - p, insufficient_evidence: 0 }, confidence: p })),
    );

  it("counts backward steps in the raw argmax, skipping unlinked sections", () => {
    expect(backwardsSteps([0, 2, null, 1, 3, 2])).toBe(2);
  });

  it("reports the top-2 margin, and an exact tie resolved to the earliest segment", () => {
    expect(rawArgmax(cells([[0.2, 0.9, 0.6]]), 0)).toMatchObject({ segment: 1, top: 0.9 });
    expect(rawArgmax(cells([[0.2, 0.9, 0.6]]), 0).margin).toBeCloseTo(0.3);
    expect(rawArgmax(cells([[0.99, 0.5, 0.99]]), 0)).toMatchObject({ segment: 0, margin: 0, tied: true });
  });

  it("calls an ordered, decisive matrix near-ordered and a scattered one not", () => {
    expect(unconstrainedSummary(cells([[0.9, 0.1, 0.1], [0.1, 0.9, 0.1], [0.1, 0.1, 0.9]])).nearOrdered).toBe(true);
    expect(unconstrainedSummary(cells([[0.1, 0.1, 0.9], [0.9, 0.1, 0.1], [0.1, 0.9, 0.1]])).nearOrdered).toBe(false);
  });

  it("passes a decoy matrix that rejects everything and fails one that accepts", () => {
    expect(decoySummary(cells([[0.01, 0.02], [0.03, 0.01]])).pass).toBe(true);
    expect(decoySummary(cells([[0.9, 0.02], [0.03, 0.01]])).pass).toBe(false);
  });
});

// A content-driven fake: it reads the segment TEXT shown for a label (never
// the label's number), so its answers are the same however segments are
// listed. On-topic: a topic's first minute p 0.8, its second 0.9; knockouts
// pick the earlier minute. Anything off-topic (and every decoy) is rejected.
function segmentText(state, label) {
  return new RegExp(`^${label}: (.*)$`, "m").exec(state)[1];
}

function topicOf(text) {
  return TOPIC_WORDS.findIndex((word) => text.includes(word)) + 1;
}

function minuteOf(text) {
  return Number(/part (\d+)/.exec(text)?.[1] ?? -1);
}

function honestCell(state, label, section) {
  const text = segmentText(state, label);
  const onTopic = topicOf(text) === section;
  const p = onTopic ? (minuteOf(text) % 2 === 0 ? 0.8 : 0.9) : 0.02;
  const probabilities = { pertains: p, does_not_pertain: 0.99 - p, insufficient_evidence: 0.01 };
  return { type: "choice", choice: onTopic ? "pertains" : "does_not_pertain", probabilities, confidence: 0.95 };
}

function honestComparison(state, question) {
  const [, a, b] = /(T\d+) \(first\) or (T\d+) \(second\)/.exec(question.instructions);
  const first = minuteOf(segmentText(state, a)) < minuteOf(segmentText(state, b));
  return { type: "choice", choice: first ? "first" : "second", probabilities: { first: Number(first), second: Number(!first) }, confidence: 1 };
}

function honestAnswer(body, qid) {
  const cell = /^(t\d+)_n(\d+)$/.exec(qid);
  return cell ? honestCell(body.state, cell[1].toUpperCase(), Number(cell[2])) : honestComparison(body.state, body.questions[qid]);
}

// A worthless matcher: says pertains to every cell with the same probability.
function credulousAnswer(_body, qid) {
  if (!qid.startsWith("t")) return { type: "choice", choice: "first", probabilities: { first: 1, second: 0 }, confidence: 1 };
  return { type: "choice", choice: "pertains", probabilities: { pertains: 0.99, does_not_pertain: 0.005, insufficient_evidence: 0.005 }, confidence: 0.99 };
}

function fakeClient(answerFor = honestAnswer) {
  const bodies = [];
  return {
    bodies,
    post: async (body) => {
      bodies.push(body);
      const answers = Object.fromEntries(Object.keys(body.questions).map((qid) => [qid, answerFor(body, qid)]));
      const text = JSON.stringify({ model: MODEL_PIN, answers, usage: { cost: 0.0001 }, id: "x", provider: "TypeSafe" });
      return { kind: "ok", status: 200, headers: {}, bodyText: text, bodyBytes: text.length, timings: {}, socketReused: true, errorCode: null };
    },
  };
}

function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(c), text: () => chunks.join("") };
}

function fakeRecorder() {
  const recorder = { records: [], files: {}, summary: null, runDir: "/tmp/run" };
  recorder.record = (r) => recorder.records.push(r);
  recorder.writeRun = (s) => (recorder.summary = s);
  recorder.writeJson = (name, value) => (recorder.files[name] = value);
  return recorder;
}

async function stage3(opts, answerFor) {
  const stdout = sink();
  const recorder = fakeRecorder();
  const client = fakeClient(answerFor);
  const { exitCode } = await runStage3({ client, recorder, stdout, key: "k", opts });
  return { exitCode, out: stdout.text(), recorder, client };
}

describe("runStage3", () => {
  it("an honest matcher: near-ordered unconstrained, passes the decoy, stable under shuffle", async () => {
    const { exitCode, out, recorder } = await stage3({ notes: [writeNote()], shuffleSegments: true, seed: 3 });

    expect(exitCode).toBe(0);
    const [note] = recorder.summary.notes;
    expect(note.sections.map((s) => s.rawArgmax)).toEqual([1, 3, 5, 7]);
    expect(note.sections.map((s) => s.D)).toEqual([1, 3, 5, 7]);
    expect(note.sections.map((s) => s.C)).toEqual([0, 2, 4, 6]);
    expect(out).toContain("steps backwards 0 times over 3 consecutive pairs");
    expect(out).toContain("-> NEAR-ORDERED");
    expect(out).toContain("Decoy - this note's sections vs SYNTHETIC unrelated segments (not a real transcript)");
    expect(out).toContain("EXPECTATION: near-zero pertains");
    expect(out).toContain("-> PASS");
    expect(out).toContain("raw argmax on the same segment 4/4 | arm D on the same segment 4/4");
    expect(out).toContain("-> STABLE");
  });

  it("persists every round-1 matrix with all three probabilities, the choice and the confidence", async () => {
    const { recorder } = await stage3({ notes: [writeNote()], shuffleSegments: true });
    expect(Object.keys(recorder.files).sort()).toEqual(["matrix-note1-decoy.json", "matrix-note1-main.json", "matrix-note1-shuffled.json"]);
    const main = recorder.files["matrix-note1-main.json"];
    expect(main.cells).toHaveLength(4 * 8);
    expect(main.cells[0]).toMatchObject({ section: 0, segment: 0, choice: "pertains", confidence: 0.95 });
    expect(Object.keys(main.cells[0].probabilities).sort()).toEqual(["does_not_pertain", "insufficient_evidence", "pertains"]);
    expect(main.segments.map((s) => s.startSeconds)).toEqual([0, 60, 120, 180, 240, 300, 360, 420]);
    expect(main.sections[0].heading).toBe("1. All about compound interest savings");
    expect(recorder.files["matrix-note1-shuffled.json"].listingOrder).toHaveLength(8);
  });

  it("a matcher that says pertains to everything FAILS the decoy and is not near-ordered", async () => {
    const { out } = await stage3({ notes: [writeNote()] }, credulousAnswer);
    expect(out).toContain("-> FAIL: Jev says pertains to unrelated content");
    expect(out).toContain("-> SCATTERED");
    expect(out).toContain("Shuffle: not run (add --shuffle-segments).");
  });

  it("uses a real decoy note when given, and says so", async () => {
    const decoyText = NOTE.replaceAll("savings", "beekeeping").replaceAll("photosynthesis", "pottery").replaceAll("roman", "knitting").replaceAll("guitar", "origami");
    const decoy = writeNote(decoyText);
    const { out } = await stage3({ notes: [writeNote()], decoyNote: decoy });
    expect(out).toContain(`vs decoy note ${decoy}`);
    expect(out).not.toContain("SYNTHETIC");
    expect(out).toContain("-> PASS");
  });

  it("reports each note and an aggregate when given several", async () => {
    const { out, recorder } = await stage3({ notes: [writeNote(), writeNote()] });
    expect(out).toContain("=== Note 1 of 2:");
    expect(out).toContain("=== Note 2 of 2:");
    expect(out).toContain("=== Aggregate over 2 notes (8 sections) ===");
    expect(recorder.summary.notes).toHaveLength(2);
  });

  it("prints headings and clock times only: no transcript or body text", async () => {
    const { out } = await stage3({ notes: [writeNote()], shuffleSegments: true });
    expect(out).toContain("1. All about compound interest savings");
    expect(out).not.toContain(BODY_MARKER);
    expect(out).not.toContain(TRANSCRIPT_MARKER);
  });

  it("refuses a note with no transcript, naming only the path", () => {
    const noTranscript = writeNote("# x\n\n## 1. A\n\nbody\n");
    expect(() => loadNote(noTranscript)).toThrow(`no transcript segments found in the frontmatter of ${noTranscript}`);
  });
});

describe("cli stage3", () => {
  function deps() {
    return {
      env: { VITEST: "true" },
      execArgv: [],
      now: () => new Date(Date.UTC(2026, 9, 11)),
      baseDir: mkdtempSync(join(tmpdir(), "jev-rig-s3-")),
      stdout: sink(),
      stderr: sink(),
      requestFn: makeRequestFn(),
      spawn: fakeSpawn({ stdout: "sk-never-used" }),
    };
  }

  it("needs --note", async () => {
    const d = deps();
    expect(await run(["stage3", "--dry-run"], d)).toBe(1);
    expect(d.stderr.text()).toContain("stage3 needs --note PATH");
  });

  it("--dry-run plans every note's round 1, decoy and shuffle, previews, and spends nothing", async () => {
    const d = deps();
    const [a, b] = [writeNote(), writeNote()];
    expect(await run(["stage3", "--dry-run", "--note", a, "--note", b, "--shuffle-segments"], d)).toBe(0);
    const out = d.stdout.text();
    const note = parseNote(NOTE);
    const perNote = planMatrixBodies(plainView(note.segments), note.sections).length;
    // per note: round 1 + decoy (10 synthetic segments x 4 sections = 40 cells, 2 requests) + shuffle
    expect(out).toContain(`Planned requests: ${2 * (perNote + 2 + perNote)}\n`);
    expect(out).toContain("hard cap of 250 requests per note");
    expect(out).toContain(`To spend, run: node rig/jev-timestamps/cli.mjs stage3 --yes --note ${JSON.stringify(a)} --note ${JSON.stringify(b)} --shuffle-segments`);
    expect(out).not.toContain(BODY_MARKER);
    expect(out).not.toContain(TRANSCRIPT_MARKER);
    expect(d.requestFn.calls).toHaveLength(0);
    expect(d.spawn.calls).toHaveLength(0);
    expect(readdirSync(d.baseDir)).toHaveLength(1);
  });
});
