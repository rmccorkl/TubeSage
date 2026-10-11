// Stage 1: the response contract, single-request timing, and the
// multi-question probe.
//
//   1-2  one question per request, cold then warm: contract check plus
//        connect / tls / ttfb / total and socketReused for each
//   3-5  the SAME shared state with N = 2, 5, then 20 questions in one
//        request (the `questions` map). Escalation stops at the first N that
//        fails, so this is at most 5 requests (cap: 10).
//
// Every exchange is recorded in full (headers redacted, key scrubbed).
// Upstream error text is never printed; read it from the run directory.
import { MODEL_PIN } from "../lib/constants.mjs";
import { CELLS, scoreAnswers, sharedStateBody } from "../lib/cells.mjs";
import { checkResponse, parseJson } from "../lib/contract.mjs";
import { costOf, formatTimings, recordRequest } from "../lib/measure.mjs";

export const STAGE1_MAX_REQUESTS = 10;

const SINGLE_STEPS = [
  { label: "single-1 (cold)", cells: CELLS.slice(0, 1) },
  { label: "single-2 (warm)", cells: CELLS.slice(1, 2) },
];
const MULTI_SIZES = [2, 5, 20];

function multiStep(n) {
  return { label: `multi-${n}`, cells: CELLS.slice(0, n), multi: true };
}

/** Every request stage 1 could make: the upper bound the estimate is priced on. */
export function planStage1Bodies() {
  return [...SINGLE_STEPS, ...MULTI_SIZES.map(multiStep)].map((step) => sharedStateBody(step.cells));
}

function evaluate(result, questions) {
  const json = result.kind === "ok" ? parseJson(result.bodyText) : null;
  return { json, check: json === null ? null : checkResponse(json, { pin: MODEL_PIN, questions }) };
}

function isAccepted(check) {
  return check !== null && check.violations.length === 0;
}

async function runStep({ client, recorder, key }, step) {
  const body = sharedStateBody(step.cells);
  const result = await client.post(body);
  const { json, check } = evaluate(result, body.questions);
  const row = {
    ...step,
    questions: step.cells.length,
    result,
    check,
    cost: costOf(json),
    score: scoreAnswers(json?.answers, step.cells),
    accepted: isAccepted(check),
  };
  recordRequest(recorder, { label: step.label, body, key, result, extra: { check, score: row.score } });
  return row;
}

async function runSingles(ctx) {
  const rows = [];
  for (const step of SINGLE_STEPS) rows.push(await runStep(ctx, step));
  return rows;
}

async function runMultiProbe(ctx) {
  const rows = [];
  for (const n of MULTI_SIZES) {
    const row = await runStep(ctx, multiStep(n));
    rows.push(row);
    if (!row.accepted) break;
  }
  return rows;
}

function violationsText(row) {
  if (row.check === null) return row.result.kind === "ok" ? "body is not JSON" : `no contract check (${row.result.kind})`;
  return row.check.violations.length === 0 ? "none" : row.check.violations.join(", ");
}

function formatRow(row) {
  const r = row.result;
  return [
    `${row.label} [${row.questions} question${row.questions === 1 ? "" : "s"}]`,
    `  status ${r.status} (${r.kind}${r.errorCode ? `, ${r.errorCode}` : ""}) | ${formatTimings(r.timings)} | socketReused ${r.socketReused}`,
    `  ${r.bodyBytes} response bytes | cost ${row.cost ?? "-"} | correct ${row.score.correct}/${row.questions} | distinct choices ${row.score.distinctChoices} | violations: ${violationsText(row)}`,
  ].join("\n");
}

function contractLines(rows) {
  const first = rows[0];
  const observations = [...new Set(rows.flatMap((row) => row.check?.observations ?? []))];
  return [
    `Contract (${first.label}): ${first.accepted ? "OK" : `DIFFERS: ${violationsText(first)}`}`,
    ...observations.map((note) => `  observed: ${note}`),
  ];
}

function multiVerdict(multiRows) {
  const accepted = multiRows.filter((row) => row.accepted);
  const failed = multiRows.find((row) => !row.accepted);
  const largest = accepted.length > 0 ? accepted[accepted.length - 1].questions : 1;
  if (!failed) return `MULTI-QUESTION: SUPPORTED up to N=${largest} (largest probed)`;
  const how = failed.result.kind === "ok" ? `2xx but ${violationsText(failed)}` : `status ${failed.result.status} (${failed.result.kind})`;
  return `MULTI-QUESTION: accepted up to N=${largest}; failed at N=${failed.questions}: ${how}`;
}

function totalCost(rows) {
  return rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
}

function summary(rows) {
  return rows.map((row) => ({
    label: row.label,
    questions: row.questions,
    kind: row.result.kind,
    status: row.result.status,
    timings: row.result.timings,
    socketReused: row.result.socketReused,
    cost: row.cost,
    score: row.score,
    violations: row.check?.violations ?? null,
  }));
}

/**
 * @param {object} ctx
 * @param {{ post: (body: object) => Promise<object> }} ctx.client
 * @param {{ record: Function, writeRun: Function, runDir?: string }} ctx.recorder
 * @param {{ write: (chunk: string) => unknown }} ctx.stdout
 * @param {string} ctx.key - only ever handed to the recorder, which redacts it
 * @returns {Promise<{ exitCode: number }>} 0 when the single-question contract holds
 */
export async function runStage1(ctx) {
  const singles = await runSingles(ctx);
  const multis = await runMultiProbe(ctx);
  const rows = [...singles, ...multis];

  const lines = [
    ...rows.map(formatRow),
    "",
    ...contractLines(rows),
    multiVerdict(multis),
    `Requests made: ${rows.length} (cap ${STAGE1_MAX_REQUESTS}) | total usage.cost: ${totalCost(rows).toFixed(9)}`,
    `Full responses (error bodies included): ${ctx.recorder.runDir ?? "the run directory"}`,
  ];
  ctx.stdout.write(lines.join("\n") + "\n");
  ctx.recorder.writeRun({ stage: "stage1", rows: summary(rows), multiVerdict: multiVerdict(multis) });
  return { exitCode: singles[0].accepted ? 0 : 1 };
}
