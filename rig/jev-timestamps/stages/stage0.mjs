// Stage 0: one liveness request against the decisions endpoint. Never prints
// bodyText (upstream prose) or the key; only classified fields and a shape.
import { ENDPOINT, MODEL_PIN, USER_AGENT } from "../lib/constants.mjs";
import { describeShape } from "../lib/shape.mjs";

const STATE =
  "Segment S1: The speaker explains how compound interest grows savings over decades.\n" +
  "Section A: Compound interest and long-term saving.";

const QUESTION = {
  type: "choice",
  instructions: "Does transcript segment S1 pertain to note section A?",
  criteria: {
    pertains: "The segment discusses the topic of the section.",
    does_not_pertain: "The segment discusses something else.",
    insufficient_evidence: "The segment does not contain enough information to decide.",
  },
};

/** The single planned stage 0 request body. */
export function buildStage0Body() {
  return { model: MODEL_PIN, state: STATE, questions: { liveness: QUESTION } };
}

function truncatedModelJson(modelString) {
  const json = JSON.stringify(modelString);
  return json.length > 100 ? json.slice(0, 100) : json;
}

// Ordered rules, first match wins. Keeping this as data (rather than an
// if/else chain) is what keeps verdictFor's own complexity low.
const VERDICT_RULES = [
  { when: (kind, modelMatches) => kind === "ok" && modelMatches === true, verdict: "LIVE" },
  { when: (kind) => kind === "ok", verdict: "LIVE-PIN-CHANGED" },
  { when: (kind) => kind === "model-gone", verdict: "MODEL-GONE" },
  { when: (kind) => kind === "auth", verdict: "AUTH" },
  { when: (kind) => kind === "credits", verdict: "CREDITS" },
  { when: (kind) => typeof kind === "string" && kind.startsWith("network-"), verdict: "ENV-BLOCKED" },
];

function verdictFor(kind, modelMatches) {
  const rule = VERDICT_RULES.find((candidate) => candidate.when(kind, modelMatches));
  return rule ? rule.verdict : "OTHER";
}

function safeParseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractModelInfo(parsedBody) {
  const modelString = parsedBody && typeof parsedBody.model === "string" ? parsedBody.model : null;
  return { modelString, modelMatches: modelString === null ? null : modelString === MODEL_PIN };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object";
}

function hasNumericCost(usage) {
  return isPlainObject(usage) && typeof usage.cost === "number";
}

function extractUsageCost(parsedBody) {
  if (!isPlainObject(parsedBody)) return undefined;
  const usage = parsedBody.usage;
  return hasNumericCost(usage) ? usage.cost : undefined;
}

function parseResult(result) {
  const parsedBody = safeParseJson(result.bodyText);
  const { modelString, modelMatches } = extractModelInfo(parsedBody);
  const usageCost = extractUsageCost(parsedBody);
  return { parsedBody, modelString, modelMatches, usageCost };
}

function recordExchange(recorder, { body, key, result, verdict, usageCost }) {
  recorder.record({
    request: {
      method: "POST",
      url: ENDPOINT,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body,
    },
    response:
      result.status === null
        ? null
        : { status: result.status, headers: result.headers, bodyText: result.bodyText, bodyBytes: result.bodyBytes },
    kind: result.kind,
    errorCode: result.errorCode,
    timings: result.timings,
    socketReused: result.socketReused,
  });
  recorder.writeRun({
    stage: "stage0",
    verdict,
    kind: result.kind,
    status: result.status,
    errorCode: result.errorCode,
    timings: result.timings,
    usageCost,
  });
}

function printReport(stdout, { result, parsedBody, modelString, modelMatches, usageCost, verdict }) {
  stdout.write(`status: ${result.status}\n`);
  stdout.write(`kind: ${result.kind}\n`);
  stdout.write(`errorCode: ${result.errorCode}\n`);
  stdout.write(`timings: ${JSON.stringify(result.timings)}\n`);
  stdout.write(`socketReused: ${result.socketReused}\n`);
  stdout.write(`response bytes: ${result.bodyBytes}\n`);
  stdout.write(`body shape: ${JSON.stringify(describeShape(parsedBody))}\n`);
  if (modelString !== null) {
    stdout.write(`model: ${truncatedModelJson(modelString)} (matches pin: ${modelMatches})\n`);
  }
  if (usageCost !== undefined) {
    stdout.write(`usage.cost: ${usageCost}\n`);
  }
  stdout.write(`verdict: ${verdict}\n`);
}

/**
 * Runs the single stage 0 request, records the exchange, and prints a
 * compact human-readable report. The estimate line is printed by the caller
 * (cli.mjs) before the spend gate is even evaluated; this only prints what
 * happens once a request is actually made.
 *
 * @param {object} deps
 * @param {{ post: (body: object) => Promise<object> }} deps.client
 * @param {{ record: (exchange: object) => void, writeRun: (summary: object) => void }} [deps.recorder]
 * @param {{ write: (chunk: string) => unknown }} deps.stdout
 * @param {string} deps.key - used only to label the recorded exchange's
 *   Authorization header; the recorder redacts it before writing.
 */
export async function runStage0({ client, recorder, stdout, key }) {
  const body = buildStage0Body();
  const result = await client.post(body);
  const { parsedBody, modelString, modelMatches, usageCost } = parseResult(result);
  const verdict = verdictFor(result.kind, modelMatches);

  if (recorder) {
    recordExchange(recorder, { body, key, result, verdict, usageCost });
  }
  printReport(stdout, { result, parsedBody, modelString, modelMatches, usageCost, verdict });

  return { verdict, exitCode: verdict === "LIVE" ? 0 : 1 };
}
