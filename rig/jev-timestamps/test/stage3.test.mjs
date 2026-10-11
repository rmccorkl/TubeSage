// Stage 3 on a SYNTHETIC note (no real note is ever committed), with a fake
// client: no request leaves the process.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../cli.mjs";
import { monotonicAssign } from "../lib/assign.mjs";
import { MODEL_PIN } from "../lib/constants.mjs";
import { formatClock, parseNote } from "../lib/note.mjs";
import { similarityMatrix } from "../lib/similarity.mjs";
import { loadNote, planStage3Bodies, runStage3 } from "../stages/stage3.mjs";
import { fakeSpawn, makeRequestFn } from "./fakes.mjs";

// Four topics, two one-minute segments each (T1-T2 topic 1, T3-T4 topic 2...).
const TOPICS = [
  ["compound interest savings", "Interest earned this year earns interest next year, so compound savings snowball."],
  ["photosynthesis chlorophyll", "Leaves capture sunlight with chlorophyll and photosynthesis splits water."],
  ["roman empire collapse", "The western roman empire collapsed when the legions went unpaid."],
  ["guitar chords practice", "Practise switching guitar chords until fingers move smoothly between them."],
];
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
    expect(note.segments).toHaveLength(8);
    expect(note.segments.map((s) => s.startSeconds)).toEqual([0, 60, 120, 180, 240, 300, 360, 420]);
    expect(note.segments[0].text).toContain("Note: part 0.");
  });

  it("reads numbered sections only, with headings cleaned of their Watch links", () => {
    expect(note.sections.map((s) => s.heading)).toEqual([
      "1. All about compound interest savings",
      "2. All about photosynthesis chlorophyll",
      "3. All about roman empire collapse",
      "4. All about guitar chords practice",
    ]);
    expect(note.sections[3].body).not.toContain("Wrap up");
  });

  it("captures the current pass's link per section, and maps it to a segment", () => {
    expect(note.sections.map((s) => s.currentSeconds)).toEqual([0, 120, null, 360]);
    expect(note.sections.map((s) => s.currentSegment)).toEqual([0, 2, null, 6]);
  });

  it("formats clocks", () => {
    expect([formatClock(0), formatClock(725), formatClock(3723)]).toEqual(["0:00", "12:05", "1:02:03"]);
  });
});

describe("monotonicAssign", () => {
  it("maximises total weight, not each section greedily", () => {
    // Greedy gives section 0 segment 1 (0.9) and section 1 segment 2 (0.1) = 1.0;
    // the optimum is 0 -> 0 (0.8), 1 -> 1 (0.95) = 1.75.
    const w = [
      [0.8, 0.9, null],
      [null, 0.95, 0.1],
    ];
    expect(monotonicAssign(2, 3, (j, i) => w[j][i])).toEqual([0, 1]);
  });

  it("leaves a section unlinked rather than giving it the least-bad segment", () => {
    expect(monotonicAssign(2, 3, (j, i) => (j === 0 ? null : [0.1, 0.2, 0.3][i]))).toEqual([null, 2]);
  });

  it("never lets a later section point earlier in the video", () => {
    // Section 1 strongly prefers segment 0, but section 0 already holds segment 1.
    const w = [
      [null, 0.9],
      [0.99, null],
    ];
    const result = monotonicAssign(2, 2, (j, i) => w[j][i]);
    expect(result.filter((x) => x !== null)).toHaveLength(1);
  });
});

describe("similarityMatrix", () => {
  it("scores a segment highest against the section on its topic", () => {
    const sim = similarityMatrix(["guitar chords practice fingers"], ["roman legions unpaid empire", "practise guitar chords smoothly fingers"]);
    expect(sim[0][1]).toBeGreaterThan(sim[0][0]);
  });
});

describe("planStage3Bodies", () => {
  it("asks every cell exactly once, at most 20 per request, each request naming only what it asks about", () => {
    const note = parseNote(NOTE);
    const bodies = planStage3Bodies(note);
    const qids = bodies.flatMap((body) => Object.keys(body.questions));
    expect(qids).toHaveLength(8 * 4);
    expect(new Set(qids).size).toBe(32);
    for (const body of bodies) {
      expect(Object.keys(body.questions).length).toBeLessThanOrEqual(20);
      expect(body.model).toBe(MODEL_PIN);
      for (const qid of Object.keys(body.questions)) {
        const [, t, n] = /^t(\d+)_n(\d+)$/.exec(qid);
        expect(body.state).toContain(`T${t} [`);
        expect(body.state).toContain(`N${n} "`);
      }
    }
  });
});

/**
 * The fake model: a segment "pertains" to the section on its topic, the
 * topic's second segment slightly more probable; knockouts pick the earlier
 * segment. So arm C should land on each topic's FIRST segment and arm D
 * (maximising total probability) on its SECOND.
 */
const ON_TOPIC = { 1: 0.8, 0: 0.9 }; // a topic's first segment (odd T) 0.8, its second 0.9

function cellAnswer(t, n) {
  const pertains = Math.ceil(t / 2) === n;
  const p = pertains ? ON_TOPIC[t % 2] : 0.05;
  const probabilities = { pertains: p, does_not_pertain: 1 - p - 0.01, insufficient_evidence: 0.01 };
  return { type: "choice", choice: pertains ? "pertains" : "does_not_pertain", probabilities, confidence: p };
}

function comparisonAnswer(question) {
  const [, a, b] = /T(\d+) \(first\) or T(\d+) \(second\)/.exec(question.instructions).map(Number);
  const first = a < b;
  return { type: "choice", choice: first ? "first" : "second", probabilities: { first: Number(first), second: Number(!first) }, confidence: 1 };
}

function answer(qid, question) {
  const cell = /^t(\d+)_n(\d+)$/.exec(qid);
  return cell ? cellAnswer(Number(cell[1]), Number(cell[2])) : comparisonAnswer(question);
}

function fakeClient() {
  const bodies = [];
  return {
    bodies,
    post: async (body) => {
      bodies.push(body);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([qid, q]) => [qid, answer(qid, q)]));
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
  const recorder = { records: [], summary: null, runDir: "/tmp/run" };
  recorder.record = (r) => recorder.records.push(r);
  recorder.writeRun = (s) => (recorder.summary = s);
  return recorder;
}

describe("runStage3", () => {
  it("runs round 1, the knockout and all three arms, and compares them with the current pass", async () => {
    const client = fakeClient();
    const stdout = sink();
    const recorder = fakeRecorder();
    let t = 0;
    const { exitCode } = await runStage3({ client, recorder, stdout, key: "k", opts: { note: writeNote() }, clock: () => (t += 100) });
    const out = stdout.text();

    expect(exitCode).toBe(0);
    const round1 = client.bodies.filter((b) => Object.keys(b.questions)[0].startsWith("t"));
    const round2 = client.bodies.filter((b) => Object.keys(b.questions)[0].startsWith("r"));
    expect(round1.length).toBeGreaterThan(0);
    expect(round2).toHaveLength(1); // every section's single comparison, batched into one request
    expect(recorder.summary.sections.map((s) => [s.C, s.D])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    expect(out).toContain("Arm C vs current: exact 3/3");
    expect(out).toContain("Arm D vs current: exact 0/3 | within +/-1 segment 3/3");
    expect(out).toContain(`Total: ${client.bodies.length} requests (cap 200; 0 retries, 0 failed)`);
  });

  it("prints headings and clock times only: no transcript or body text", async () => {
    const stdout = sink();
    await runStage3({ client: fakeClient(), recorder: fakeRecorder(), stdout, key: "k", opts: { note: writeNote() } });
    expect(stdout.text()).toContain("1. All about compound interest savings");
    expect(stdout.text()).not.toContain(BODY_MARKER);
    expect(stdout.text()).not.toContain(TRANSCRIPT_MARKER);
  });

  it("refuses a note with no transcript or no numbered sections, naming only the path", () => {
    const noTranscript = writeNote("# x\n\n## 1. A\n\nbody\n");
    expect(() => loadNote(noTranscript)).toThrow(`no transcript segments found in the frontmatter of ${noTranscript}`);
    expect(() => loadNote("/no/such/note.md")).toThrow("--note: cannot read /no/such/note.md (ENOENT)");
  });
});

describe("cli stage3", () => {
  function deps(overrides = {}) {
    return {
      env: { VITEST: "true" },
      execArgv: [],
      now: () => new Date(Date.UTC(2026, 9, 11)),
      baseDir: mkdtempSync(join(tmpdir(), "jev-rig-s3-")),
      stdout: sink(),
      stderr: sink(),
      requestFn: makeRequestFn(),
      spawn: fakeSpawn({ stdout: "sk-never-used" }),
      ...overrides,
    };
  }

  it("needs --note", async () => {
    const d = deps();
    expect(await run(["stage3", "--dry-run"], d)).toBe(1);
    expect(d.stderr.text()).toContain("stage3 needs --note PATH");
  });

  it("--dry-run plans round 1, previews arm B against the current pass, and spends nothing", async () => {
    const d = deps();
    const note = writeNote();
    expect(await run(["stage3", "--dry-run", "--note", note], d)).toBe(0);
    const out = d.stdout.text();
    expect(out).toContain(`To spend, run: node rig/jev-timestamps/cli.mjs stage3 --yes --note ${JSON.stringify(note)}`);
    expect(out).toMatch(/Planned requests: \d+\n/);
    expect(out).toContain("hard cap 200 requests in total");
    expect(out).toContain("Arm B vs current:");
    expect(out).not.toContain(BODY_MARKER);
    expect(out).not.toContain(TRANSCRIPT_MARKER);
    expect(d.requestFn.calls).toHaveLength(0);
    expect(d.spawn.calls).toHaveLength(0);
    expect(readdirSync(d.baseDir)).toHaveLength(1);
  });
});
