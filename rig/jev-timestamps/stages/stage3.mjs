// Stage 3: the pairwise-matrix design, end to end, on ONE real note.
//
//   parse     segments (frontmatter transcript), sections (numbered headings
//             + body), and the CURRENT pass's link per heading
//   round 1   every (segment, section) cell: pertains / does_not_pertain /
//             insufficient_evidence. 20 questions per request, concurrency
//             10 (stages 1-2). Each request carries only the segments and
//             sections its questions name, tiled to minimise text sent.
//   arm B     local TF-IDF similarity (no API) -> monotonic assignment
//   arm C     the maintainer design: a section with several "pertains"
//             candidates runs a pairwise knockout, k-1 comparisons, weakest
//             candidates first so the strongest meet last; serial within a
//             section, all sections' comparisons of one round batched and
//             concurrent. Then a monotonic repair over the candidates
//             (the tournament winner strongly preferred).
//   arm D     round-1 P(pertains) straight into the monotonic assignment
//
// Every arm: one segment per section at most, no segment used twice, time
// never runs backwards, and no eligible cell means UNLINKED.
//
// PRIVACY: stdout gets section headings, clock times and numbers only.
// Transcript and body text go only to the API and to the gitignored runs/.
import { readFileSync } from "node:fs";
import { monotonicAssign } from "../lib/assign.mjs";
import { MODEL_PIN } from "../lib/constants.mjs";
import { checkResponse, parseJson } from "../lib/contract.mjs";
import { costOf, recordRequest, runPool } from "../lib/measure.mjs";
import { formatClock, parseNote } from "../lib/note.mjs";
import { similarityMatrix } from "../lib/similarity.mjs";

export const STAGE3_MAX_REQUESTS = 200;
const QUESTIONS_PER_REQUEST = 20;
const CONCURRENCY = 10;
const SECTION_TEXT_LIMIT = 1500;
// Eligibility thresholds: below these a cell cannot be linked at all.
const D_MIN_PERTAINS = 0.5;
const B_MIN_SIMILARITY = 0.1; // heuristic for TF-IDF cosine, not tuned
const WINNER_BONUS = 1;
const RETRYABLE = new Set(["rate-limited", "unavailable", "timeout", "network-other"]);
// (segments, sections) per round-1 request; each multiplies to 20.
const TILE_SHAPES = [[1, 20], [2, 10], [4, 5], [5, 4], [10, 2], [20, 1]];

const CELL_CRITERIA = {
  pertains: "The segment discusses the topic of the section.",
  does_not_pertain: "The segment discusses something else.",
  insufficient_evidence: "The segment does not contain enough information to decide.",
};

// ---- the note ---------------------------------------------------------------

/** Reads and parses the note. Throws an Error whose message names only the path. */
function readNoteText(path, readFile) {
  try {
    return readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--note: cannot read ${path} (${err?.code ?? "read error"}).`);
  }
}

export function loadNote(path, readFile = readFileSync) {
  const note = parseNote(readNoteText(path, readFile));
  if (note.segments.length === 0) throw new Error(`--note: no transcript segments found in the frontmatter of ${path}.`);
  if (note.sections.length === 0) throw new Error(`--note: no numbered headings (e.g. "## 1. ...") found in ${path}.`);
  return note;
}

const segLabel = (i) => `T${i + 1}`;
const secLabel = (j) => `N${j + 1}`;

function segmentLine(note, i) {
  const segment = note.segments[i];
  return `${segLabel(i)} [${formatClock(segment.startSeconds)}]: ${segment.text}`;
}

function sectionLine(note, j) {
  const section = note.sections[j];
  return `${secLabel(j)} "${section.heading}": ${section.body.slice(0, SECTION_TEXT_LIMIT)}`;
}

function stateFor(note, segmentIndexes, sectionIndexes) {
  return [
    "Transcript segments:",
    ...segmentIndexes.map((i) => segmentLine(note, i)),
    "",
    "Note sections:",
    ...sectionIndexes.map((j) => sectionLine(note, j)),
  ].join("\n");
}

// ---- round 1 plan -----------------------------------------------------------

function range(start, end) {
  return Array.from({ length: end - start }, (_, k) => start + k);
}

function tile(note, [a, b]) {
  const blocks = [];
  for (let i = 0; i < note.segments.length; i += a) {
    for (let j = 0; j < note.sections.length; j += b) {
      blocks.push({ segments: range(i, Math.min(i + a, note.segments.length)), sections: range(j, Math.min(j + b, note.sections.length)) });
    }
  }
  return blocks;
}

function tilingChars(note, blocks) {
  return blocks.reduce((sum, block) => sum + stateFor(note, block.segments, block.sections).length, 0);
}

/** The tile shape that sends the least text in total (ties: fewer requests). */
function chooseBlocks(note) {
  return TILE_SHAPES.map((shape) => tile(note, shape))
    .map((blocks) => ({ blocks, chars: tilingChars(note, blocks) }))
    .reduce((best, option) => (option.chars < best.chars || (option.chars === best.chars && option.blocks.length < best.blocks.length) ? option : best))
    .blocks;
}

const cellId = (i, j) => `t${i + 1}_n${j + 1}`;

function cellQuestion(i, j) {
  return { type: "choice", instructions: `Does transcript segment ${segLabel(i)} pertain to note section ${secLabel(j)}?`, criteria: CELL_CRITERIA };
}

function round1Body(note, block) {
  const questions = {};
  for (const i of block.segments) for (const j of block.sections) questions[cellId(i, j)] = cellQuestion(i, j);
  return { model: MODEL_PIN, state: stateFor(note, block.segments, block.sections), questions };
}

/** Every round-1 request body for the note. */
export function planStage3Bodies(note) {
  return chooseBlocks(note).map((block) => round1Body(note, block));
}

// ---- sending ----------------------------------------------------------------

function takeBudget(ctx) {
  if (ctx.used >= STAGE3_MAX_REQUESTS) return false;
  ctx.used += 1;
  return true;
}

async function postOnce(ctx, body, label) {
  if (!takeBudget(ctx)) return null;
  const result = await ctx.client.post(body);
  recordRequest(ctx.recorder, { label, body, key: ctx.key, result });
  return result;
}

/** One request, retried once on a transient failure. Null if the budget is spent. */
async function postWithRetry(ctx, body, label) {
  const first = await postOnce(ctx, body, label);
  if (first === null || !RETRYABLE.has(first.kind)) return first;
  ctx.retries += 1;
  return (await postOnce(ctx, body, `${label} retry`)) ?? first;
}

const WHOLE_RESPONSE_VIOLATIONS = ["not-object", "model-mismatch", "answers-not-object"];

function okJson(result) {
  return result?.kind === "ok" ? parseJson(result.bodyText) : null;
}

/** The answers that passed the contract, per question; none if the response as a whole failed it. */
function validAnswers(json, body) {
  const { violations } = checkResponse(json, { pin: MODEL_PIN, questions: body.questions });
  if (violations.some((v) => WHOLE_RESPONSE_VIOLATIONS.includes(v))) return {};
  const bad = new Set(violations.map((v) => v.split(":")[1]).filter(Boolean));
  return Object.fromEntries(Object.entries(json.answers).filter(([qid]) => body.questions[qid] && !bad.has(qid)));
}

/** The answers usable from one response: per-question, so one bad answer does not void the rest. */
function usableAnswers(result, body) {
  const json = okJson(result);
  return json === null ? { answers: {}, cost: null } : { answers: validAnswers(json, body), cost: costOf(json) };
}

async function sendAll(ctx, bodies, label) {
  const results = await runPool(bodies, CONCURRENCY, (body, k) => postWithRetry(ctx, body, `${label}-${k + 1}`));
  const answers = {};
  results.forEach((result, k) => {
    const usable = usableAnswers(result, bodies[k]);
    Object.assign(answers, usable.answers);
    ctx.cost += usable.cost ?? 0;
    if (result?.kind !== "ok") ctx.failed += 1;
  });
  return answers;
}

// ---- assignments ------------------------------------------------------------

function pertainsOf(cells, i, j) {
  const p = cells[cellId(i, j)]?.probabilities?.pertains;
  return typeof p === "number" ? p : null;
}

function armD(note, cells) {
  return monotonicAssign(note.sections.length, note.segments.length, (j, i) => {
    const p = pertainsOf(cells, i, j);
    return p !== null && p >= D_MIN_PERTAINS ? p : null;
  });
}

function armB(note) {
  const sim = similarityMatrix(
    note.sections.map((s) => `${s.heading} ${s.body}`),
    note.segments.map((s) => s.text),
  );
  const assignment = monotonicAssign(note.sections.length, note.segments.length, (j, i) => (sim[j][i] >= B_MIN_SIMILARITY ? sim[j][i] : null));
  return { assignment, sim };
}

/** Segments the model said "pertains" to section j, weakest first. */
function candidatesFor(note, cells, j) {
  return note.segments
    .map((segment) => segment.index)
    .filter((i) => cells[cellId(i, j)]?.choice === "pertains")
    .sort((a, b) => pertainsOf(cells, a, j) - pertainsOf(cells, b, j));
}

function comparisonQuestion(j, a, b) {
  return {
    type: "choice",
    instructions: `Which transcript segment is the better match for note section ${secLabel(j)}: ${segLabel(a)} (first) or ${segLabel(b)} (second)?`,
    criteria: { first: `${segLabel(a)} is the better match.`, second: `${segLabel(b)} is the better match.` },
  };
}

function comparisonBodies(note, round, matches) {
  const bodies = [];
  for (let k = 0; k < matches.length; k += QUESTIONS_PER_REQUEST) {
    const batch = matches.slice(k, k + QUESTIONS_PER_REQUEST);
    const segments = [...new Set(batch.flatMap((m) => [m.champion, m.challenger]))].sort((x, y) => x - y);
    const questions = Object.fromEntries(batch.map((m) => [`r${round}_n${m.section + 1}`, comparisonQuestion(m.section, m.champion, m.challenger)]));
    bodies.push({ model: MODEL_PIN, state: stateFor(note, segments, batch.map((m) => m.section)), questions });
  }
  return bodies;
}

// "second" means the challenger won; no answer leaves the champion standing.
function applyMatch(bracket, match, choice) {
  if (choice === "second") bracket.champion = match.challenger;
  if (choice === undefined) bracket.unresolved += 1;
}

function applyRound(brackets, matches, answers, round) {
  for (const m of matches) applyMatch(brackets[m.section], m, answers[`r${round}_n${m.section + 1}`]?.choice);
}

function openBrackets(note, cells) {
  return note.sections.map((section) => {
    const queue = candidatesFor(note, cells, section.index);
    return { candidates: [...queue], champion: queue.shift() ?? null, queue, unresolved: 0, cut: false };
  });
}

/** Round 2: every section's knockout, one comparison per section per round. */
async function runKnockout(ctx, note, cells) {
  const brackets = openBrackets(note, cells);
  for (let round = 1; brackets.some((b) => b.queue.length > 0); round++) {
    const matches = brackets.flatMap((b, j) => (b.queue.length > 0 ? [{ section: j, champion: b.champion, challenger: b.queue.shift() }] : []));
    const bodies = comparisonBodies(note, round, matches);
    if (ctx.used + bodies.length > STAGE3_MAX_REQUESTS) return cutShort(brackets, matches);
    applyRound(brackets, matches, await sendAll(ctx, bodies, `round2-r${round}`), round);
    ctx.round2Requests += bodies.length;
  }
  return brackets;
}

/** Out of budget: the sections still racing keep their current champion, marked as cut. */
function cutShort(brackets, matches) {
  for (const m of matches) brackets[m.section].cut = true;
  for (const bracket of brackets) bracket.queue.length = 0;
  return brackets;
}

function armC(note, cells, brackets) {
  return monotonicAssign(note.sections.length, note.segments.length, (j, i) => {
    const bracket = brackets[j];
    if (i === bracket.champion) return WINNER_BONUS + (pertainsOf(cells, i, j) ?? 0);
    return bracket.candidates.includes(i) ? pertainsOf(cells, i, j) : null;
  });
}

// ---- report -----------------------------------------------------------------

function clockOf(note, segment) {
  return segment === null ? "-" : formatClock(note.segments[segment].startSeconds);
}

function bestPertains(note, cells, j) {
  return Math.max(0, ...note.segments.map((s) => pertainsOf(cells, s.index, j) ?? 0));
}

function confidenceText(note, cells, j, dSegment) {
  if (cells === null) return "-";
  if (dSegment === null) return `best p ${bestPertains(note, cells, j).toFixed(2)}`;
  const cell = cells[cellId(dSegment, j)];
  return `p ${cell.probabilities.pertains.toFixed(2)} / conf ${Number(cell.confidence).toFixed(2)}`;
}

function heading(section) {
  const indent = "  ".repeat(Math.max(0, section.level - 2));
  const text = `${indent}${section.heading}`;
  return text.length > 48 ? `${text.slice(0, 47)}…` : text.padEnd(48);
}

function armAt(arm, j) {
  return arm ? arm[j] : null;
}

function cutMark(brackets, j) {
  return brackets && brackets[j].cut ? "*" : " ";
}

function tableRow(note, arms, cells, brackets, j) {
  const col = (segment) => clockOf(note, segment).padEnd(7);
  const d = armAt(arms.D, j);
  const section = note.sections[j];
  return `${secLabel(j).padEnd(4)}${heading(section)} | ${col(section.currentSegment)} | ${col(arms.B[j])} | ${col(armAt(arms.C, j))}${cutMark(brackets, j)}| ${col(d)} | ${confidenceText(note, cells, j, d)}`;
}

function tableLines(note, arms, cells, brackets) {
  const head = `${"#".padEnd(4)}${"section".padEnd(48)} | current | arm B   | arm C   | arm D   | round-1 (arm D cell)`;
  return [head, "-".repeat(head.length), ...note.sections.map((_section, j) => tableRow(note, arms, cells, brackets, j))];
}

function agreement(note, assignment) {
  const linked = note.sections.filter((s) => s.currentSegment !== null);
  const exact = linked.filter((s) => assignment[s.index] === s.currentSegment).length;
  const near = linked.filter((s) => assignment[s.index] !== null && Math.abs(assignment[s.index] - s.currentSegment) <= 1).length;
  const unlinked = assignment.filter((segment) => segment === null).length;
  return `exact ${exact}/${linked.length} | within +/-1 segment ${near}/${linked.length} | unlinked ${unlinked}/${note.sections.length}`;
}

function summaryLines(note, arms) {
  const currentUnlinked = note.sections.filter((s) => s.currentSegment === null).length;
  return [
    `Current pass: ${note.sections.length - currentUnlinked}/${note.sections.length} sections linked`,
    ...Object.entries(arms)
      .filter(([, assignment]) => assignment)
      .map(([arm, assignment]) => `Arm ${arm} vs current: ${agreement(note, assignment)}`),
  ];
}

function overviewLine(note, bodies) {
  return `Note: ${note.sections.length} numbered sections, ${note.segments.length} transcript segments (${formatClock(note.segments[note.segments.length - 1].startSeconds)} last start), ${note.sections.length * note.segments.length} cells, ${bodies.length} round-1 requests`;
}

/** Dry-run preview: arm B and the current pass only. No request, no key. */
export function previewStage3(note, stdout) {
  const arms = { B: armB(note).assignment };
  stdout.write(
    [overviewLine(note, planStage3Bodies(note)), "", ...tableLines(note, arms, null, null), "", ...summaryLines(note, arms), "Arms C and D need round 1: run with --yes."].join("\n") + "\n",
  );
}

// ---- run --------------------------------------------------------------------

function makeContext(deps) {
  return {
    client: deps.client,
    recorder: deps.recorder,
    key: deps.key,
    clock: deps.clock ?? (() => performance.now()),
    used: 0,
    retries: 0,
    failed: 0,
    cost: 0,
    round2Requests: 0,
  };
}

function runLines(note, ctx, { bodies, cells, brackets, arms, times, runDir }) {
  const cutCount = brackets.filter((b) => b.cut).length;
  const cutNote = cutCount > 0 ? [`* knockout cut short by the ${STAGE3_MAX_REQUESTS}-request cap in ${cutCount} sections`] : [];
  return [
    overviewLine(note, bodies),
    "",
    ...tableLines(note, arms, cells, brackets),
    ...cutNote,
    "",
    ...summaryLines(note, arms),
    `Round 1: ${bodies.length} requests, ${Object.keys(cells).length}/${note.sections.length * note.segments.length} cells answered, ${Math.round(times.round1)} ms`,
    `Round 2 (arm C knockout): ${ctx.round2Requests} requests, ${Math.round(times.round2)} ms`,
    `Total: ${ctx.used} requests (cap ${STAGE3_MAX_REQUESTS}; ${ctx.retries} retries, ${ctx.failed} failed) | ${Math.round(times.total)} ms | usage.cost ${ctx.cost.toFixed(6)}`,
    `Full requests and responses (these contain note text): ${runDir ?? "the run directory"}`,
  ];
}

/**
 * @param {object} deps
 * @param {{ post: Function }} deps.client
 * @param {{ record: Function, writeRun: Function, runDir?: string }} deps.recorder
 * @param {{ write: Function }} deps.stdout
 * @param {string} deps.key - only ever handed to the recorder, which redacts it
 * @param {{ note: string }} deps.opts
 * @param {() => number} [deps.clock]
 */
export async function runStage3(deps) {
  const note = loadNote(deps.opts.note);
  const ctx = makeContext(deps);
  const bodies = planStage3Bodies(note);

  const t0 = ctx.clock();
  const cells = await sendAll(ctx, bodies, "round1");
  const t1 = ctx.clock();
  const brackets = await runKnockout(ctx, note, cells);
  const t2 = ctx.clock();
  const arms = { B: armB(note).assignment, C: armC(note, cells, brackets), D: armD(note, cells) };
  const times = { round1: t1 - t0, round2: t2 - t1, total: t2 - t0 };

  deps.stdout.write(runLines(note, ctx, { bodies, cells, brackets, arms, times, runDir: deps.recorder.runDir }).join("\n") + "\n");
  deps.recorder.writeRun({
    stage: "stage3",
    sections: note.sections.map((s, j) => ({ heading: s.heading, current: s.currentSegment, B: arms.B[j], C: arms.C[j], D: arms.D[j] })),
    requests: ctx.used,
    round2Requests: ctx.round2Requests,
    failed: ctx.failed,
    cost: ctx.cost,
    wallClockMs: times,
  });
  return { exitCode: ctx.failed === 0 ? 0 : 1 };
}
