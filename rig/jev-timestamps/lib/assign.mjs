// Monotonic assignment of note sections to transcript segments, by dynamic
// programming over the (section, segment) weight matrix.
//
// Guarantees, by construction:
//   - each section gets at most one segment
//   - no segment is used by two sections
//   - linked segments strictly increase down the note (time never runs back)
//   - a section is linked only to a cell `weight` calls ELIGIBLE (a number);
//     with no eligible cell it is left UNLINKED, never given the least-bad one
// Among all assignments meeting those, it maximises the total weight.
//
// F[j][i] = best total using sections 0..j-1 and segments 0..i-1:
//   max( F[j-1][i]               section j-1 left unlinked
//        F[j][i-1]               segment i-1 unused
//        F[j-1][i-1] + w(j-1,i-1) if that cell is eligible )

const SKIP_SECTION = 0;
const SKIP_SEGMENT = 1;
const TAKE = 2;

function bestMove(F, j, i, w) {
  const options = [
    { move: TAKE, value: w === null ? -Infinity : F[j - 1][i - 1] + w },
    { move: SKIP_SEGMENT, value: F[j][i - 1] },
    { move: SKIP_SECTION, value: F[j - 1][i] },
  ];
  return options.reduce((best, option) => (option.value > best.value ? option : best));
}

function fillTables(sections, segments, weight) {
  const F = Array.from({ length: sections + 1 }, () => new Float64Array(segments + 1));
  const moves = Array.from({ length: sections + 1 }, () => new Int8Array(segments + 1));
  for (let j = 1; j <= sections; j++) {
    moves[j][0] = SKIP_SECTION;
    for (let i = 1; i <= segments; i++) {
      const best = bestMove(F, j, i, weight(j - 1, i - 1));
      F[j][i] = best.value;
      moves[j][i] = best.move;
    }
  }
  return moves;
}

const STEP = {
  [TAKE]: (j, i, out) => {
    out[j - 1] = i - 1;
    return [j - 1, i - 1];
  },
  [SKIP_SEGMENT]: (j, i) => [j, i - 1],
  [SKIP_SECTION]: (j, i) => [j - 1, i],
};

function backtrack(moves, sections, segments) {
  const out = new Array(sections).fill(null);
  let [j, i] = [sections, segments];
  while (j > 0 && i > 0) [j, i] = STEP[moves[j][i]](j, i, out);
  return out;
}

/**
 * @param {number} sections
 * @param {number} segments
 * @param {(section: number, segment: number) => number | null} weight - null = not eligible
 * @returns {Array<number | null>} the segment index per section, or null for unlinked
 */
export function monotonicAssign(sections, segments, weight) {
  return backtrack(fillTables(sections, segments, weight), sections, segments);
}
