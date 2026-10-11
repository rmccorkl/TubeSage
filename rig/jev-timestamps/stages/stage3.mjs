// Stage 3: the pairwise matrix on real notes, made falsifiable.
//
// Per note (--note, repeatable):
//   round 1   every (segment, section) cell: pertains / does_not_pertain /
//             insufficient_evidence, 20 questions per request, concurrency 10.
//             The whole matrix is persisted to the run directory.
//   arm D     round-1 P(pertains) into the monotonic assignment, reported
//             side by side with the SAME matrix UNCONSTRAINED: raw argmax per
//             section, top-2 margin, backward steps, low-margin count. If the
//             raw argmax scatters, the constraint is doing the work.
//   arm C     the maintainer design (pairwise knockout + monotonic repair).
//   decoy     this note's sections against UNRELATED segments (--decoy-note,
//             or synthetic ones, said so). A real matcher says ~no pertains.
//   shuffle   (--shuffle-segments) round 1 again with the segments listed
//             and labelled in a seeded random order; placements compared.
// Requests never carry clock times or index-based ids (see lib/matrix.mjs).
//
// PRIVACY: stdout gets headings, clock times and numbers only. Note and
// transcript text go only to the API and to the gitignored runs/.
import { readFileSync } from "node:fs";
import { monotonicAssign } from "../lib/assign.mjs";
import { MODEL_PIN } from "../lib/constants.mjs";
import { checkResponse, parseJson } from "../lib/contract.mjs";
import { syntheticDecoySegments } from "../lib/decoy.mjs";
import {
  DECOY_MAX_MEAN_PERTAINS,
  DECOY_MAX_PERTAINS_SHARE,
  LOW_MARGIN,
  NEAR_ORDERED_MAX_BACKWARDS_SHARE,
  NEAR_ORDERED_MAX_LOW_MARGIN_SHARE,
  STABLE_MIN_SAME_SHARE,
  decoySummary,
  sameCount,
  unconstrainedSummary,
} from "../lib/diagnostics.mjs";
import {
  QUESTIONS_PER_REQUEST,
  matrixFrom,
  matrixRecord,
  pertains,
  plainView,
  planMatrixBodies,
  secLabel,
  shuffledView,
  stateFor,
} from "../lib/matrix.mjs";
import { costOf, recordRequest, runPool } from "../lib/measure.mjs";
import { formatClock, parseNote } from "../lib/note.mjs";

export const STAGE3_MAX_REQUESTS_PER_NOTE = 250;
const DEFAULT_SEED = 1;
const CONCURRENCY = 10;
const D_MIN_PERTAINS = 0.5;
const WINNER_BONUS = 1;
const RETRYABLE = new Set(["rate-limited", "unavailable", "timeout", "network-other"]);

// ---- loading ----------------------------------------------------------------

function readNoteText(path, readFile) {
  try {
    return readFile(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path} (${err?.code ?? "read error"}).`);
  }
}

/** A note to match: needs transcript segments and numbered sections. Errors name only the path. */
export function loadNote(path, readFile = readFileSync) {
  const note = parseNote(readNoteText(path, readFile));
  if (note.segments.length === 0) throw new Error(`--note: no transcript segments found in the frontmatter of ${path}.`);
  if (note.sections.length === 0) throw new Error(`--note: no numbered headings (e.g. "## 1. ...") found in ${path}.`);
  return note;
}

function loadDecoySegments(path) {
  const { segments } = parseNote(readNoteText(path, readFileSync));
  if (segments.length === 0) throw new Error(`--decoy-note: no transcript segments found in the frontmatter of ${path}.`);
  return segments;
}

function decoySource(opts) {
  return opts.decoyNote
    ? { synthetic: false, path: opts.decoyNote, segments: loadDecoySegments(opts.decoyNote) }
    : { synthetic: true, path: null, segments: syntheticDecoySegments() };
}

// ---- planning ---------------------------------------------------------------

function seedOf(opts) {
  return opts.seed ?? DEFAULT_SEED;
}

function notePlan(path, opts, decoy) {
  const note = loadNote(path);
  const views = {
    main: plainView(note.segments),
    decoy: plainView(decoy.segments),
    shuffled: opts.shuffleSegments ? shuffledView(note.segments, seedOf(opts)) : null,
  };
  const bodies = {
    main: planMatrixBodies(views.main, note.sections),
    decoy: planMatrixBodies(views.decoy, note.sections),
    shuffled: views.shuffled ? planMatrixBodies(views.shuffled, note.sections) : [],
  };
  return { path, note, views, bodies };
}

/** Every request a note's plan makes before the knockout. */
export function fixedBodies(plan) {
  return [...plan.bodies.main, ...plan.bodies.decoy, ...plan.bodies.shuffled];
}

function assertWithinCap(plan) {
  const needed = fixedBodies(plan).length;
  if (needed > STAGE3_MAX_REQUESTS_PER_NOTE) {
    throw new Error(`stage3: ${plan.path} needs ${needed} requests before the knockout, over the ${STAGE3_MAX_REQUESTS_PER_NOTE}-per-note cap.`);
  }
}

/** Loads every note and plans its requests. Throws a printable message when it cannot. */
export function planStage3(opts) {
  if (!opts.notes || opts.notes.length === 0) {
    throw new Error("stage3 needs --note PATH, once per note (keep real notes in rig/jev-timestamps/fixtures/, which is gitignored).");
  }
  const decoy = decoySource(opts);
  const plans = opts.notes.map((path) => notePlan(path, opts, decoy));
  plans.forEach(assertWithinCap);
  return { decoy, plans, seed: seedOf(opts) };
}

// ---- sending ----------------------------------------------------------------

function takeBudget(ctx) {
  if (ctx.used >= STAGE3_MAX_REQUESTS_PER_NOTE) return false;
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

async function askMatrix(ctx, view, sections, bodies, label) {
  const answers = await sendAll(ctx, bodies, label);
  ctx.requests[label] = bodies.length;
  return matrixFrom(view, sections.length, answers);
}

// ---- arms -------------------------------------------------------------------

function armD(cells, segmentCount) {
  return monotonicAssign(cells.length, segmentCount, (j, i) => {
    const p = pertains(cells, j, i);
    return p !== null && p >= D_MIN_PERTAINS ? p : null;
  });
}

/** Segments the model said "pertains" to section j, weakest first. */
function candidatesFor(cells, j) {
  return cells[j]
    .map((cell, i) => ({ cell, i }))
    .filter(({ cell }) => cell?.choice === "pertains")
    .map(({ i }) => i)
    .sort((a, b) => pertains(cells, j, a) - pertains(cells, j, b));
}

function comparisonQuestion(view, j, a, b) {
  const [la, lb] = [view.labelOf[a], view.labelOf[b]];
  return {
    type: "choice",
    instructions: `Which transcript segment is the better match for note section ${secLabel(j)}: ${la} (first) or ${lb} (second)?`,
    criteria: { first: `${la} is the better match.`, second: `${lb} is the better match.` },
  };
}

function comparisonBodies(view, sections, round, matches) {
  const bodies = [];
  for (let k = 0; k < matches.length; k += QUESTIONS_PER_REQUEST) {
    const batch = matches.slice(k, k + QUESTIONS_PER_REQUEST);
    const segments = [...new Set(batch.flatMap((m) => [m.champion, m.challenger]))];
    const questions = Object.fromEntries(batch.map((m) => [`r${round}_n${m.section + 1}`, comparisonQuestion(view, m.section, m.champion, m.challenger)]));
    bodies.push({ model: MODEL_PIN, state: stateFor(view, sections, segments, batch.map((m) => m.section)), questions });
  }
  return bodies;
}

// "second" means the challenger won; no answer leaves the champion standing.
function applyMatch(bracket, match, choice) {
  if (choice === "second") bracket.champion = match.challenger;
}

function openBrackets(cells) {
  return cells.map((_row, j) => {
    const queue = candidatesFor(cells, j);
    return { candidates: [...queue], champion: queue.shift() ?? null, queue, cut: false };
  });
}

/** Out of budget: the sections still racing keep their current champion, marked as cut. */
function cutShort(brackets, matches) {
  for (const m of matches) brackets[m.section].cut = true;
  for (const bracket of brackets) bracket.queue.length = 0;
}

/** This round's comparison for every section that still has challengers. */
function nextMatches(brackets) {
  return brackets.flatMap((b, j) => (b.queue.length > 0 ? [{ section: j, champion: b.champion, challenger: b.queue.shift() }] : []));
}

/** Plays one round; false when the cap would be exceeded (the round is then cut short). */
async function playRound(ctx, { view, sections, brackets }, round, matches) {
  const bodies = comparisonBodies(view, sections, round, matches);
  if (ctx.used + bodies.length > STAGE3_MAX_REQUESTS_PER_NOTE) {
    cutShort(brackets, matches);
    return false;
  }
  applyAnswers(brackets, matches, await sendAll(ctx, bodies, `knockout-r${round}`), round);
  ctx.requests.knockout = (ctx.requests.knockout ?? 0) + bodies.length;
  return true;
}

function applyAnswers(brackets, matches, answers, round) {
  for (const m of matches) applyMatch(brackets[m.section], m, answers[`r${round}_n${m.section + 1}`]?.choice);
}

/** Arm C's round 2: one comparison per section per round, a round's comparisons batched. */
async function runKnockout(ctx, view, sections, cells) {
  const game = { view, sections, brackets: openBrackets(cells) };
  let round = 1;
  while (game.brackets.some((b) => b.queue.length > 0) && (await playRound(ctx, game, round, nextMatches(game.brackets)))) round++;
  return game.brackets;
}

function armC(cells, brackets, segmentCount) {
  return monotonicAssign(cells.length, segmentCount, (j, i) => {
    const bracket = brackets[j];
    if (i === bracket.champion) return WINNER_BONUS + (pertains(cells, j, i) ?? 0);
    return bracket.candidates.includes(i) ? pertains(cells, j, i) : null;
  });
}

// ---- report -----------------------------------------------------------------

const pct = (n, d) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);
const num = (value, digits = 2) => (value === null ? "-" : value.toFixed(digits));

function clockOf(segments, segment) {
  return segment === null ? "-" : formatClock(segments[segment].startSeconds);
}

function headingCell(section) {
  const text = `${"  ".repeat(Math.max(0, section.level - 2))}${section.heading}`;
  return text.length > 44 ? `${text.slice(0, 43)}…` : text.padEnd(44);
}

const TABLE_HEAD = `${"#".padEnd(4)}${"section".padEnd(44)} | current | D raw   | D mono  | arm C   | margin | top p`;

function tableRow(note, result, j) {
  const col = (segment) => clockOf(note.segments, segment).padEnd(7);
  const raw = result.unconstrained.argmaxes[j];
  const cut = result.brackets[j].cut ? "*" : " ";
  return (
    `${secLabel(j).padEnd(4)}${headingCell(note.sections[j])} | ${col(note.sections[j].currentSegment)} | ${col(raw.segment)}${raw.tied ? "=" : " "}` +
    `| ${col(result.D[j])} | ${col(result.C[j])}${cut}| ${num(raw.margin).padEnd(6)} | ${num(raw.top)}`
  );
}

function agreementText(note, assignment) {
  const linked = note.sections.filter((s) => s.currentSegment !== null);
  const exact = linked.filter((s) => assignment[s.index] === s.currentSegment).length;
  const near = linked.filter((s) => assignment[s.index] !== null && Math.abs(assignment[s.index] - s.currentSegment) <= 1).length;
  const linkedByArm = assignment.filter((segment) => segment !== null).length;
  return `linked ${linkedByArm}/${assignment.length} | vs current: exact ${exact}/${linked.length}, within +/-1 ${near}/${linked.length}`;
}

function unconstrainedLines(u, sections) {
  const verdict = u.nearOrdered
    ? "NEAR-ORDERED: the raw argmax already follows the note, so the matching comes from the model, not from the constraint."
    : "SCATTERED: the raw argmax does not follow the note; the monotonic constraint is doing the work, not the model.";
  return [
    `Arm D UNCONSTRAINED (raw argmax, no monotonic constraint): steps backwards ${u.backwards} times over ${u.pairs} consecutive pairs;` +
      ` ${u.lowMargin}/${sections} sections with top-2 margin < ${LOW_MARGIN} (${u.ties} exact ties, shown "=", resolved to the earliest segment);` +
      ` median top P(pertains) ${num(u.medianTop, 3)}`,
    `  -> ${verdict}`,
    `     (near-ordered = backwards in <= ${NEAR_ORDERED_MAX_BACKWARDS_SHARE * 100}% of pairs AND margin < ${LOW_MARGIN} in <= ${NEAR_ORDERED_MAX_LOW_MARGIN_SHARE * 100}% of sections; thresholds chosen for this rig, not derived)`,
  ];
}

function decoySourceText(decoy) {
  return decoy.synthetic ? "SYNTHETIC unrelated segments (not a real transcript)" : `decoy note ${decoy.path}`;
}

function decoyLines(d, decoy) {
  const verdict = d.pass
    ? "PASS: unrelated content is rejected."
    : "FAIL: Jev says pertains to unrelated content; on this evidence the signal cannot be trusted.";
  return [
    `Decoy - this note's sections vs ${decoySourceText(decoy)}: ${d.answered}/${d.cells} cells answered |` +
      ` pertains ${d.pertains} (${pct(d.pertains, d.answered)}) | does_not_pertain ${d.doesNotPertain} | insufficient_evidence ${d.insufficientEvidence} |` +
      ` mean P(pertains) ${num(d.meanPertains, 3)} | max ${num(d.maxPertains, 3)} | cells with P >= 0.5: ${d.atLeastHalf}`,
    "  EXPECTATION: near-zero pertains. A real matcher must reject unrelated content.",
    `  -> ${verdict} (pass = pertains < ${DECOY_MAX_PERTAINS_SHARE * 100}% of cells AND mean P(pertains) < ${DECOY_MAX_MEAN_PERTAINS}; thresholds chosen for this rig)`,
  ];
}

function isStable(shuffle, sections) {
  return shuffle.rawSame / sections >= STABLE_MIN_SAME_SHARE && shuffle.dSame / sections >= STABLE_MIN_SAME_SHARE;
}

function shuffleLines(shuffle, sections, seed) {
  if (!shuffle) return ["Shuffle: not run (add --shuffle-segments)."];
  const verdict = isStable(shuffle, sections)
    ? "STABLE: placements survive relabelling, so they are content-driven."
    : "UNSTABLE: placements change when only the labels and listing order change; the labels were carrying signal.";
  return [
    `Shuffle (seed ${seed}; segments listed and labelled in random order): raw argmax on the same segment ${shuffle.rawSame}/${sections} | arm D on the same segment ${shuffle.dSame}/${sections}`,
    `  -> ${verdict} (stable = both >= ${STABLE_MIN_SAME_SHARE * 100}%; threshold chosen for this rig)`,
  ];
}

function requestText(ctx) {
  const parts = Object.entries(ctx.requests).map(([label, n]) => `${label} ${n}`);
  return `Requests: ${parts.join(", ")} = ${ctx.used} (cap ${STAGE3_MAX_REQUESTS_PER_NOTE} per note; ${ctx.retries} retries, ${ctx.failed} failed) | ${Math.round(ctx.ms)} ms | usage.cost ${ctx.cost.toFixed(6)}`;
}

function noteLines(plan, result, k, total, run) {
  const { note } = plan;
  const sections = note.sections.length;
  return [
    `=== Note ${k + 1} of ${total}: ${plan.path} ===`,
    `${sections} numbered sections, ${note.segments.length} transcript segments (last starts ${formatClock(note.segments[note.segments.length - 1].startSeconds)}), ${sections * note.segments.length} cells`,
    "",
    TABLE_HEAD,
    "-".repeat(TABLE_HEAD.length),
    ...note.sections.map((_section, j) => tableRow(note, result, j)),
    "",
    ...unconstrainedLines(result.unconstrained, sections),
    `Arm D CONSTRAINED (monotonic DP, P(pertains) >= ${D_MIN_PERTAINS}): ${agreementText(note, result.D)}`,
    `Arm C (knockout + monotonic repair): ${agreementText(note, result.C)}${result.brackets.some((b) => b.cut) ? " (* knockout cut short by the cap)" : ""}`,
    ...decoyLines(result.decoy, run.decoy),
    ...shuffleLines(result.shuffle, sections, run.seed),
    requestText(result.ctx),
    "",
  ];
}

function sumOf(results, pick) {
  return results.reduce((sum, result) => sum + pick(result), 0);
}

function aggregateLines(plans, results) {
  const sections = sumOf(plans, (p) => p.note.sections.length);
  const u = { backwards: sumOf(results, (r) => r.unconstrained.backwards), pairs: sumOf(results, (r) => r.unconstrained.pairs), low: sumOf(results, (r) => r.unconstrained.lowMargin) };
  const d = { pertains: sumOf(results, (r) => r.decoy.pertains), answered: sumOf(results, (r) => r.decoy.answered), pSum: sumOf(results, (r) => (r.decoy.meanPertains ?? 0) * r.decoy.answered) };
  const shuffled = results.filter((r) => r.shuffle);
  const shuffleText = shuffled.length > 0
    ? `raw argmax same ${sumOf(shuffled, (r) => r.shuffle.rawSame)}/${sumOf(shuffled, (r) => r.cells.length)}, arm D same ${sumOf(shuffled, (r) => r.shuffle.dSame)}/${sumOf(shuffled, (r) => r.cells.length)}`
    : "not run";
  return [
    `=== Aggregate over ${plans.length} notes (${sections} sections) ===`,
    `Arm D unconstrained: backwards ${u.backwards} over ${u.pairs} pairs (${pct(u.backwards, u.pairs)}); margin < ${LOW_MARGIN} in ${u.low}/${sections} sections (${pct(u.low, sections)})`,
    `Decoy: pertains ${d.pertains}/${d.answered} (${pct(d.pertains, d.answered)}), mean P(pertains) ${num(d.answered ? d.pSum / d.answered : null, 3)}`,
    `Shuffle: ${shuffleText}`,
    `Requests ${sumOf(results, (r) => r.ctx.used)} | ${Math.round(sumOf(results, (r) => r.ctx.ms))} ms | usage.cost ${sumOf(results, (r) => r.ctx.cost).toFixed(6)}`,
  ];
}

function closingLines(plans, results, runDir) {
  const aggregate = plans.length > 1 ? aggregateLines(plans, results) : [];
  return [...aggregate, `Matrices (matrix-note<k>-<variant>.json) and full requests, which contain note text: ${runDir ?? "the run directory"}`];
}

// ---- run --------------------------------------------------------------------

function persistMatrix(recorder, k, variant, plan, cells, extra) {
  recorder.writeJson?.(
    `matrix-note${k + 1}-${variant}.json`,
    matrixRecord({ variant, notePath: plan.path, view: plan.views[variant], sections: plan.note.sections, cells, extra }),
  );
}

async function runShuffle(ctx, recorder, plan, k, main, seed) {
  if (!plan.views.shuffled) return null;
  const cells = await askMatrix(ctx, plan.views.shuffled, plan.note.sections, plan.bodies.shuffled, "shuffled");
  persistMatrix(recorder, k, "shuffled", plan, cells, { seed, listingOrder: plan.views.shuffled.order });
  const raw = unconstrainedSummary(cells).argmaxes.map((a) => a.segment);
  return {
    rawSame: sameCount(raw, main.unconstrained.argmaxes.map((a) => a.segment)),
    dSame: sameCount(armD(cells, plan.note.segments.length), main.D),
  };
}

function newContext(deps) {
  return { client: deps.client, recorder: deps.recorder, key: deps.key, used: 0, retries: 0, failed: 0, cost: 0, ms: 0, requests: {} };
}

async function runNote(deps, run, plan, k) {
  const clock = deps.clock ?? (() => performance.now());
  const ctx = newContext(deps);
  const t0 = clock();
  const { note, views, bodies } = plan;

  const cells = await askMatrix(ctx, views.main, note.sections, bodies.main, "round1");
  persistMatrix(deps.recorder, k, "main", plan, cells);
  const brackets = await runKnockout(ctx, views.main, note.sections, cells);
  const result = { cells, brackets, unconstrained: unconstrainedSummary(cells), D: armD(cells, note.segments.length), C: armC(cells, brackets, note.segments.length) };

  const decoyCells = await askMatrix(ctx, views.decoy, note.sections, bodies.decoy, "decoy");
  persistMatrix(deps.recorder, k, "decoy", plan, decoyCells, { synthetic: run.decoy.synthetic, decoyNote: run.decoy.path });
  result.decoy = decoySummary(decoyCells);
  result.shuffle = await runShuffle(ctx, deps.recorder, plan, k, result, run.seed);

  ctx.ms = clock() - t0;
  return { ...result, ctx };
}

function summaryRecord(plans, results) {
  return results.map((result, k) => ({
    note: plans[k].path,
    sections: plans[k].note.sections.map((s, j) => ({
      heading: s.heading,
      current: s.currentSegment,
      rawArgmax: result.unconstrained.argmaxes[j].segment,
      margin: result.unconstrained.argmaxes[j].margin,
      D: result.D[j],
      C: result.C[j],
    })),
    unconstrained: { backwards: result.unconstrained.backwards, pairs: result.unconstrained.pairs, lowMargin: result.unconstrained.lowMargin, ties: result.unconstrained.ties, medianTop: result.unconstrained.medianTop },
    decoy: result.decoy,
    shuffle: result.shuffle,
    requests: result.ctx.requests,
    cost: result.ctx.cost,
    ms: result.ctx.ms,
  }));
}

/**
 * @param {object} deps
 * @param {{ post: Function }} deps.client
 * @param {{ record: Function, writeRun: Function, writeJson?: Function, runDir?: string }} deps.recorder
 * @param {{ write: Function }} deps.stdout
 * @param {string} deps.key - only ever handed to the recorder, which redacts it
 * @param {{ notes: string[], decoyNote?: string, shuffleSegments?: boolean, seed?: number }} deps.opts
 * @param {() => number} [deps.clock]
 */
export async function runStage3(deps) {
  const run = planStage3(deps.opts);
  const results = [];
  for (const [k, plan] of run.plans.entries()) {
    results.push(await runNote(deps, run, plan, k));
    deps.stdout.write(noteLines(plan, results[k], k, run.plans.length, run).join("\n") + "\n");
  }
  deps.stdout.write(closingLines(run.plans, results, deps.recorder.runDir).join("\n") + "\n");
  deps.recorder.writeRun({ stage: "stage3", seed: run.seed, decoy: { synthetic: run.decoy.synthetic, path: run.decoy.path }, notes: summaryRecord(run.plans, results) });
  return { exitCode: results.every((r) => r.ctx.failed === 0) ? 0 : 1 };
}

/** Dry-run preview: the plan per note and the current pass's links. No request, no key. */
export function previewStage3(opts, stdout) {
  const run = planStage3(opts);
  const lines = run.plans.flatMap((plan, k) => [
    `=== Note ${k + 1} of ${run.plans.length}: ${plan.path} ===`,
    `${plan.note.sections.length} sections x ${plan.note.segments.length} segments | requests: round 1 ${plan.bodies.main.length}, decoy ${plan.bodies.decoy.length} (${decoySourceText(run.decoy)}), shuffle ${plan.bodies.shuffled.length}, knockout up to ${STAGE3_MAX_REQUESTS_PER_NOTE - fixedBodies(plan).length}`,
    ...plan.note.sections.map((s, j) => `${secLabel(j).padEnd(4)}${headingCell(s)} | current ${clockOf(plan.note.segments, s.currentSegment)}`),
    "",
  ]);
  stdout.write(lines.join("\n") + "\n");
}
