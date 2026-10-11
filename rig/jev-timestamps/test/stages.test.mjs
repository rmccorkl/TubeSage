// Stages 1 and 2 and the contract they check, driven through a fake client:
// no request ever leaves the process.
import { describe, expect, it } from "vitest";
import { CELLS } from "../lib/cells.mjs";
import { MODEL_PIN } from "../lib/constants.mjs";
import { checkResponse } from "../lib/contract.mjs";
import { runStage1, STAGE1_MAX_REQUESTS } from "../stages/stage1.mjs";
import { backoffMs, runStage2, STAGE2_MAX_REQUESTS } from "../stages/stage2.mjs";

const CRITERIA = { pertains: "a", does_not_pertain: "b", insufficient_evidence: "c" };
const QUESTIONS = { liveness: { type: "choice", instructions: "x", criteria: CRITERIA } };

// The body stage 0 received live on 2026-10-11, verbatim.
const LIVE_STAGE0_BODY = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    liveness: { type: "choice", choice: "pertains", probabilities: { pertains: 1, does_not_pertain: 0, insufficient_evidence: 0 }, confidence: 1 },
  },
  usage: { input_tokens: 382, output_tokens: 52, cost: 0.000016044 },
  id: "gen-dec-1791735225-8NSnd99yVinsUZ1uSmjo",
  provider: "TypeSafe",
};

const SENT = { pin: MODEL_PIN, questions: QUESTIONS };

describe("checkResponse", () => {
  it("accepts the real stage 0 response and tolerates its extra id/provider keys", () => {
    const { violations, observations } = checkResponse(LIVE_STAGE0_BODY, SENT);
    expect(violations).toEqual([]);
    expect(observations).toContain("extra top-level keys (tolerated): id, provider");
  });

  it("rejects a wrong model even though unknown keys are tolerated", () => {
    expect(checkResponse({ ...LIVE_STAGE0_BODY, model: "typesafe/jev-other" }, SENT).violations).toEqual(["model-mismatch"]);
  });

  it("collects every answer-level violation rather than stopping at the first", () => {
    const bad = {
      ...LIVE_STAGE0_BODY,
      answers: { liveness: { type: "score", choice: "maybe", probabilities: { pertains: 0.5, does_not_pertain: 0.2, insufficient_evidence: 0.1 }, confidence: 2 } },
      usage: {},
    };
    expect(checkResponse(bad, SENT).violations).toEqual([
      "type-mismatch:liveness",
      "probabilities-sum:liveness",
      "choice-not-in-criteria:liveness",
      "confidence-not-unit:liveness",
      "usage-cost-missing",
    ]);
  });

  it("rejects answers whose keys or criteria differ from what was sent", () => {
    const extraAnswer = { ...LIVE_STAGE0_BODY, answers: { ...LIVE_STAGE0_BODY.answers, other: {} } };
    expect(checkResponse(extraAnswer, SENT).violations).toContain("answers-keys-mismatch");
    const renamed = { ...LIVE_STAGE0_BODY, answers: { liveness: { ...LIVE_STAGE0_BODY.answers.liveness, probabilities: { yes: 1, no: 0, unsure: 0 } } } };
    expect(checkResponse(renamed, SENT).violations).toContain("probabilities-keys-mismatch:liveness");
  });

  it("rejects a body that is not an object", () => {
    expect(checkResponse(null, SENT).violations).toEqual(["not-object"]);
  });
});

/** A successful result whose answers match each question's expected choice. */
function okResult(body, { reused = false } = {}) {
  const expected = Object.fromEntries(CELLS.map((cell) => [cell.qid, cell.expected]));
  const answers = Object.fromEntries(
    Object.keys(body.questions).map((qid) => {
      const choice = expected[qid] ?? "pertains";
      return [qid, { type: "choice", choice, probabilities: { ...{ pertains: 0, does_not_pertain: 0, insufficient_evidence: 0 }, [choice]: 1 }, confidence: 1 }];
    }),
  );
  const text = JSON.stringify({ model: MODEL_PIN, answers, usage: { cost: 0.000016 }, id: "x", provider: "TypeSafe" });
  return result("ok", 200, text, reused);
}

function result(kind, status, bodyText = "", reused = false, headers = {}) {
  return {
    kind,
    status,
    headers,
    bodyText,
    bodyBytes: bodyText.length,
    timings: reused ? { connectMs: null, tlsMs: null, ttfbMs: 540, totalMs: 550 } : { connectMs: 3600, tlsMs: 3650, ttfbMs: 4190, totalMs: 4200 },
    socketReused: reused,
    errorCode: null,
  };
}

/** A fake client: `respond(body, callIndex)` decides each result. */
function fakeClient(respond) {
  const bodies = [];
  return {
    bodies,
    post: async (body) => {
      bodies.push(body);
      return respond(body, bodies.length - 1);
    },
  };
}

function fakeRecorder() {
  const records = [];
  return { records, runDir: "/tmp/run", record: (exchange) => records.push(exchange), writeRun: (summary) => (records.summary = summary) };
}

function sink() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), text: () => chunks.join("") };
}

describe("runStage1", () => {
  it("probes N=2, 5, 20 when every multi-question request is accepted, within the cap", async () => {
    const client = fakeClient((body, index) => okResult(body, { reused: index > 0 }));
    const stdout = sink();
    const { exitCode } = await runStage1({ client, recorder: fakeRecorder(), stdout, key: "k" });

    expect(exitCode).toBe(0);
    expect(client.bodies.map((body) => Object.keys(body.questions).length)).toEqual([1, 1, 2, 5, 20]);
    expect(client.bodies.length).toBeLessThanOrEqual(STAGE1_MAX_REQUESTS);
    expect(stdout.text()).toContain("MULTI-QUESTION: SUPPORTED up to N=20");
    expect(stdout.text()).toContain("Contract (single-1 (cold)): OK");
    expect(stdout.text()).toContain("connect 3600 | tls 3650 | ttfb 4190 | total 4200 ms | socketReused false");
  });

  it("stops escalating at the first N that fails and reports how", async () => {
    const client = fakeClient((body) => (Object.keys(body.questions).length === 5 ? result("schema", 400, '{"error":{"message":"secret upstream text"}}') : okResult(body)));
    const stdout = sink();
    await runStage1({ client, recorder: fakeRecorder(), stdout, key: "k" });

    expect(client.bodies.map((body) => Object.keys(body.questions).length)).toEqual([1, 1, 2, 5]);
    expect(stdout.text()).toContain("MULTI-QUESTION: accepted up to N=2; failed at N=5: status 400 (schema)");
    expect(stdout.text()).not.toContain("secret upstream text");
  });
});

describe("runStage2", () => {
  it("reports keep-alive reuse and every concurrency level within the 60-request budget", async () => {
    const client = fakeClient((body, index) => okResult(body, { reused: index > 0 }));
    const stdout = sink();
    const { exitCode } = await runStage2({ client, recorder: fakeRecorder(), stdout, key: "k", sleep: async () => {} });

    expect(exitCode).toBe(0);
    expect(client.bodies).toHaveLength(6 + 4 + 5 + 10 + 25);
    expect(stdout.text()).toContain("KEEP-ALIVE: REUSED on all 5 follow-up requests");
    expect(stdout.text()).toContain("concurrency 25: 25/25 ok | median 550 ms | p95 550 ms");
    expect(stdout.text()).toContain("SAFE CONCURRENCY CEILING: 25");
  });

  it("reports when sockets are NOT reused", async () => {
    const client = fakeClient((body) => okResult(body, { reused: false }));
    const stdout = sink();
    await runStage2({ client, recorder: fakeRecorder(), stdout, key: "k", sleep: async () => {} });
    expect(stdout.text()).toContain("KEEP-ALIVE: NOT REUSED (0 of 5)");
  });

  it("backs off on 429, then stops climbing at the first sustained rate limit", async () => {
    // Everything after the first 10 requests (keep-alive + level 1) is rate-limited.
    const client = fakeClient((body, index) => (index < 10 ? okResult(body, { reused: true }) : result("rate-limited", 429, "", true, { "retry-after": "2" })));
    const waits = [];
    const stdout = sink();
    await runStage2({ client, recorder: fakeRecorder(), stdout, key: "k", sleep: async (ms) => waits.push(ms) });

    // Level 5: 5 requests x 3 attempts, then no level 10 or 25.
    expect(client.bodies).toHaveLength(10 + 15);
    expect(waits).toEqual(Array(10).fill(2000));
    expect(stdout.text()).toContain("concurrency 5: 0/5 ok");
    expect(stdout.text()).toContain("sustained 429 5");
    expect(stdout.text()).toContain("SAFE CONCURRENCY CEILING: 1");
    expect(stdout.text()).not.toContain("concurrency 10:");
  });

  it("never exceeds the 60-request budget, retries included", async () => {
    // Level 25 retries enough to run the budget out mid-level.
    const client = fakeClient((body, index) => (index < 25 ? okResult(body, { reused: true }) : result("rate-limited", 429, "", true)));
    await runStage2({ client, recorder: fakeRecorder(), stdout: sink(), key: "k", sleep: async () => {} });
    expect(client.bodies.length).toBeLessThanOrEqual(STAGE2_MAX_REQUESTS);
  });

  it("uses Retry-After when given and doubles from 1 s otherwise, capped at 30 s", () => {
    expect(backoffMs(1, { "retry-after": "3" })).toBe(3000);
    expect(backoffMs(1, {})).toBe(1000);
    expect(backoffMs(2, {})).toBe(2000);
    expect(backoffMs(1, { "retry-after": "999" })).toBe(30_000);
  });
});
