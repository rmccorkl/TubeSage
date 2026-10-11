// The round-1 matrix: which questions to ask, how the model sees the
// segments, and how answers become a matrix.
//
// A VIEW is how one run presents a list of segments to the model: the order
// they are listed in and the label each carries (T1, T2...). The plain view
// lists them in video order; a shuffled view lists them in a random order, so
// a label says nothing about position. Segment lines carry NO clock time in
// any view, and question ids use the label the model sees, never the real
// index, so nothing in a request leaks video order except the content.
import { MODEL_PIN } from "./constants.mjs";

export const QUESTIONS_PER_REQUEST = 20;
const SECTION_TEXT_LIMIT = 1500;
// (segments, sections) per request; each multiplies to 20.
const TILE_SHAPES = [[1, 20], [2, 10], [4, 5], [5, 4], [10, 2], [20, 1]];

const CELL_CRITERIA = {
  pertains: "The segment discusses the topic of the section.",
  does_not_pertain: "The segment discusses something else.",
  insufficient_evidence: "The segment does not contain enough information to decide.",
};

// ---- views ------------------------------------------------------------------

function makeView(segments, order) {
  const labelOf = new Array(segments.length);
  order.forEach((segmentIndex, position) => (labelOf[segmentIndex] = `T${position + 1}`));
  return { segments, order, labelOf };
}

/** Segments listed and labelled in video order. */
export function plainView(segments) {
  return makeView(segments, segments.map((_segment, i) => i));
}

// mulberry32: a tiny seeded PRNG, so a shuffled run can be reproduced.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Segments listed and labelled in a seeded random order (Fisher-Yates). */
export function shuffledView(segments, seed) {
  const random = seededRandom(seed);
  const order = segments.map((_segment, i) => i);
  for (let k = order.length - 1; k > 0; k--) {
    const swap = Math.floor(random() * (k + 1));
    [order[k], order[swap]] = [order[swap], order[k]];
  }
  return makeView(segments, order);
}

export const secLabel = (j) => `N${j + 1}`;

/** The question id for one cell, built from the labels the model sees. */
export function cellId(view, i, j) {
  return `${view.labelOf[i].toLowerCase()}_n${j + 1}`;
}

// ---- state and bodies -------------------------------------------------------

function sectionLine(sections, j) {
  const section = sections[j];
  return `${secLabel(j)} "${section.heading}": ${section.body.slice(0, SECTION_TEXT_LIMIT)}`;
}

/** The shared state for a set of segments (in listing order) and sections. */
export function stateFor(view, sections, segmentIndexes, sectionIndexes) {
  const listed = [...segmentIndexes].sort((a, b) => view.order.indexOf(a) - view.order.indexOf(b));
  return [
    "Transcript segments:",
    ...listed.map((i) => `${view.labelOf[i]}: ${view.segments[i].text}`),
    "",
    "Note sections:",
    ...sectionIndexes.map((j) => sectionLine(sections, j)),
  ].join("\n");
}

function range(start, end) {
  return Array.from({ length: end - start }, (_, k) => start + k);
}

// Blocks over LISTING positions, so a request's segments are consecutive labels.
function tile(view, sectionCount, [a, b]) {
  const blocks = [];
  for (let p = 0; p < view.order.length; p += a) {
    for (let j = 0; j < sectionCount; j += b) {
      blocks.push({ segments: view.order.slice(p, p + a), sections: range(j, Math.min(j + b, sectionCount)) });
    }
  }
  return blocks;
}

function tilingChars(view, sections, blocks) {
  return blocks.reduce((sum, block) => sum + stateFor(view, sections, block.segments, block.sections).length, 0);
}

function cheaper(best, option) {
  if (option.chars !== best.chars) return option.chars < best.chars ? option : best;
  return option.blocks.length < best.blocks.length ? option : best;
}

/** The tile shape that sends the least text in total (ties: fewer requests). */
function chooseBlocks(view, sections) {
  return TILE_SHAPES.map((shape) => tile(view, sections.length, shape))
    .map((blocks) => ({ blocks, chars: tilingChars(view, sections, blocks) }))
    .reduce(cheaper).blocks;
}

function cellQuestion(view, i, j) {
  return { type: "choice", instructions: `Does transcript segment ${view.labelOf[i]} pertain to note section ${secLabel(j)}?`, criteria: CELL_CRITERIA };
}

function blockBody(view, sections, block) {
  const questions = {};
  for (const i of block.segments) for (const j of block.sections) questions[cellId(view, i, j)] = cellQuestion(view, i, j);
  return { model: MODEL_PIN, state: stateFor(view, sections, block.segments, block.sections), questions };
}

/** Every request needed to ask every (segment, section) cell once. */
export function planMatrixBodies(view, sections) {
  return chooseBlocks(view, sections).map((block) => blockBody(view, sections, block));
}

// ---- answers -> matrix ------------------------------------------------------

function cellFrom(answer) {
  return answer ? { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence } : null;
}

/** cells[section][segment] = { choice, probabilities, confidence } or null if unanswered. */
export function matrixFrom(view, sectionCount, answers) {
  return range(0, sectionCount).map((j) => view.segments.map((_segment, i) => cellFrom(answers[cellId(view, i, j)])));
}

/** P(pertains) of a cell, or null if unanswered. */
export function pertains(cells, j, i) {
  const p = cells[j][i]?.probabilities?.pertains;
  return typeof p === "number" ? p : null;
}

/** The full matrix as structured JSON, for analysis later without re-spending. */
export function matrixRecord({ variant, notePath, view, sections, cells, extra = {} }) {
  return {
    variant,
    note: notePath,
    ...extra,
    sections: sections.map((s, j) => ({ index: j, label: secLabel(j), heading: s.heading, level: s.level, currentSegment: s.currentSegment ?? null })),
    segments: view.segments.map((s, i) => ({ index: i, label: view.labelOf[i], startSeconds: s.startSeconds ?? null })),
    cells: cells.flatMap((row, j) => row.map((cell, i) => ({ section: j, segment: i, ...(cell ?? { choice: null, probabilities: null, confidence: null }) }))),
  };
}
