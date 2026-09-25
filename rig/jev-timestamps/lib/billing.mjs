// Cost estimation and the spend gate. Nothing here makes a request; it only
// computes numbers to print BEFORE any request is allowed to happen.
import { RATE_USD_PER_M_INPUT, RECORDED_USD_PER_REQUEST } from "./constants.mjs";

function utf8Bytes(str) {
  return Buffer.byteLength(str, "utf8");
}

/**
 * @param {{ state: string, questions: unknown }} body
 * @returns {number} estimated input tokens for one planned request body.
 */
export function estimateBody(body) {
  const text = body.state + JSON.stringify(body.questions);
  return Math.ceil(utf8Bytes(text) / 4);
}

/**
 * @param {Array<{ state: string, questions: unknown }>} bodies
 */
export function estimatePlan(bodies) {
  const requests = bodies.length;
  const inputTokensEst = bodies.reduce((sum, body) => sum + estimateBody(body), 0);
  return {
    requests,
    inputTokensEst,
    usdByRate: (inputTokensEst * RATE_USD_PER_M_INPUT) / 1e6,
    usdByRecorded: requests * RECORDED_USD_PER_REQUEST,
  };
}

/**
 * @param {{ dryRun?: boolean, yes?: boolean }} flags
 * @returns {"dry-run" | "go" | "refuse"}
 */
export function decideGate({ dryRun, yes }) {
  if (dryRun) {
    if (yes) {
      throw new Error("--dry-run and --yes were both given; pass at most one.");
    }
    return "dry-run";
  }
  return yes ? "go" : "refuse";
}

export function formatEstimate(plan) {
  return [
    `Planned requests: ${plan.requests}`,
    `Estimated input tokens: ${plan.inputTokensEst}`,
    `Estimated cost (by published rate): $${plan.usdByRate.toFixed(6)}`,
    `Estimated cost (by recorded per-request avg): $${plan.usdByRecorded.toFixed(6)}`,
  ].join("\n");
}
