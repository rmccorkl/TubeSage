// Falsification diagnostics for arm D, mirroring the analysis that showed
// arm B (TF-IDF) was not matching: what the matrix says with NO monotonic
// constraint, and whether the model rejects content that cannot match.
import { pertains } from "./matrix.mjs";

// Thresholds chosen here, not derived from data. Printed with every verdict.
export const LOW_MARGIN = 0.03;
export const NEAR_ORDERED_MAX_BACKWARDS_SHARE = 0.1; // of consecutive section pairs
export const NEAR_ORDERED_MAX_LOW_MARGIN_SHARE = 0.2; // of sections
export const DECOY_MAX_PERTAINS_SHARE = 0.05;
export const DECOY_MAX_MEAN_PERTAINS = 0.1;
export const STABLE_MIN_SAME_SHARE = 0.8;

function ranked(cells, j) {
  return cells[j]
    .map((_cell, i) => ({ segment: i, p: pertains(cells, j, i) }))
    .filter((entry) => entry.p !== null)
    .sort((a, b) => b.p - a.p || a.segment - b.segment);
}

/**
 * Raw argmax of P(pertains) for one section, no constraint. Ties go to the
 * earliest segment (and are counted, since a tie's position is arbitrary).
 */
export function rawArgmax(cells, j) {
  const [first, second] = ranked(cells, j);
  if (!first) return { segment: null, top: null, margin: null, tied: false };
  const runnerUp = second ? second.p : 0;
  return { segment: first.segment, top: first.p, margin: first.p - runnerUp, tied: Boolean(second) && second.p === first.p };
}

/** How many times the sequence (skipping nulls) steps to an EARLIER segment. */
export function backwardsSteps(segments) {
  const linked = segments.filter((segment) => segment !== null);
  return linked.slice(1).filter((segment, k) => segment < linked[k]).length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Arm D with the constraint removed, summarised the way arm B was. */
export function unconstrainedSummary(cells) {
  const argmaxes = cells.map((_row, j) => rawArgmax(cells, j));
  const sections = argmaxes.length;
  const backwards = backwardsSteps(argmaxes.map((a) => a.segment));
  const lowMargin = argmaxes.filter((a) => a.margin !== null && a.margin < LOW_MARGIN).length;
  const pairs = Math.max(1, argmaxes.filter((a) => a.segment !== null).length - 1);
  const nearOrdered = backwards / pairs <= NEAR_ORDERED_MAX_BACKWARDS_SHARE && lowMargin / Math.max(1, sections) <= NEAR_ORDERED_MAX_LOW_MARGIN_SHARE;
  return {
    argmaxes,
    backwards,
    pairs,
    lowMargin,
    ties: argmaxes.filter((a) => a.tied).length,
    medianTop: median(argmaxes.map((a) => a.top).filter((p) => p !== null)),
    nearOrdered,
  };
}

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function decoyPasses(summary) {
  return summary.answered > 0 && summary.pertains / summary.answered < DECOY_MAX_PERTAINS_SHARE && summary.meanPertains < DECOY_MAX_MEAN_PERTAINS;
}

/** Choice distribution and P(pertains) over every answered decoy cell. */
export function decoySummary(cells) {
  const answered = cells.flat().filter(Boolean);
  const count = (choice) => answered.filter((cell) => cell.choice === choice).length;
  const ps = answered.map((cell) => cell.probabilities.pertains);
  const summary = {
    cells: cells.flat().length,
    answered: answered.length,
    pertains: count("pertains"),
    doesNotPertain: count("does_not_pertain"),
    insufficientEvidence: count("insufficient_evidence"),
    meanPertains: mean(ps),
    maxPertains: ps.length > 0 ? Math.max(...ps) : null,
    atLeastHalf: ps.filter((p) => p >= 0.5).length,
  };
  return { ...summary, pass: decoyPasses(summary) };
}

/** How many sections land on the same segment in two placements (both unlinked counts as same). */
export function sameCount(a, b) {
  return a.filter((segment, j) => segment === b[j]).length;
}
