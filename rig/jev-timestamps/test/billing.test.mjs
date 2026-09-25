import { describe, expect, it } from "vitest";
import { decideGate, estimateBody, estimatePlan, formatEstimate } from "../lib/billing.mjs";
import { RATE_USD_PER_M_INPUT, RECORDED_USD_PER_REQUEST } from "../lib/constants.mjs";

describe("estimateBody", () => {
  it("estimates ceil(utf8Bytes(state + JSON.stringify(questions)) / 4)", () => {
    const body = { state: "abcd", questions: { a: 1 } }; // "abcd" (4) + '{"a":1}' (7) = 11 bytes
    expect(estimateBody(body)).toBe(Math.ceil(11 / 4));
  });

  it("counts UTF-8 bytes, not JS string length, for multi-byte characters", () => {
    const body = { state: "é", questions: {} }; // "é" = 2 UTF-8 bytes, "{}" = 2 bytes -> 4 bytes
    expect(estimateBody(body)).toBe(Math.ceil(4 / 4));
  });
});

describe("estimatePlan", () => {
  it("aggregates request count, token estimate, and both USD estimates", () => {
    const bodies = [
      { state: "abcd", questions: {} }, // 4 + 2 = 6 bytes -> ceil(6/4) = 2 tokens
      { state: "abcd", questions: {} },
    ];
    const plan = estimatePlan(bodies);
    expect(plan.requests).toBe(2);
    expect(plan.inputTokensEst).toBe(4);
    expect(plan.usdByRate).toBeCloseTo((4 * RATE_USD_PER_M_INPUT) / 1e6, 12);
    expect(plan.usdByRecorded).toBeCloseTo(2 * RECORDED_USD_PER_REQUEST, 12);
  });

  it("handles an empty plan", () => {
    const plan = estimatePlan([]);
    expect(plan).toEqual({ requests: 0, inputTokensEst: 0, usdByRate: 0, usdByRecorded: 0 });
  });
});

describe("decideGate", () => {
  it("returns dry-run when only dryRun is set", () => {
    expect(decideGate({ dryRun: true, yes: false })).toBe("dry-run");
  });

  it("returns go when only yes is set", () => {
    expect(decideGate({ dryRun: false, yes: true })).toBe("go");
  });

  it("returns refuse when neither is set", () => {
    expect(decideGate({ dryRun: false, yes: false })).toBe("refuse");
  });

  it("throws when both dryRun and yes are set", () => {
    expect(() => decideGate({ dryRun: true, yes: true })).toThrow();
  });
});

describe("formatEstimate", () => {
  it("prints request count, token estimate, and both USD figures", () => {
    const text = formatEstimate({ requests: 3, inputTokensEst: 120, usdByRate: 0.0000504, usdByRecorded: 0.00006 });
    expect(text).toContain("3");
    expect(text).toContain("120");
    expect(text).toMatch(/\$0\.000050/);
    expect(text).toMatch(/\$0\.000060/);
  });
});
