// Fixture (segment, section) cells for stages 1 and 2. Synthetic text with an
// obvious right answer per cell, so a response can be scored and a reply that
// gives every question the same answer stands out. Not ground truth for any
// real note: that is stage 3's job.
import { MODEL_PIN } from "./constants.mjs";

const SECTIONS = {
  A: "Compound interest and long-term saving",
  B: "How photosynthesis turns light into sugar",
  C: "The fall of the Western Roman Empire",
  D: "Learning basic guitar chords",
  E: "Why sleep matters for memory",
};

// Four segments per section, in section order: S1-S4 belong to A, S5-S8 to B...
const SEGMENTS = [
  "Interest earned this year earns interest next year, so savings snowball over decades.",
  "Starting to save at twenty instead of forty can double what you retire with.",
  "The rule of 72 says money at 6 percent doubles in about twelve years.",
  "Fees of one percent a year quietly eat a large share of long-term returns.",
  "Leaves capture sunlight with chlorophyll and use it to split water.",
  "Carbon dioxide from the air is fixed into sugar in the Calvin cycle.",
  "The oxygen we breathe is a by-product of plants splitting water molecules.",
  "Plants grown in dim light make less sugar and grow more slowly.",
  "By the fifth century the western empire could no longer pay its armies.",
  "Germanic groups settled inside the borders and took over whole provinces.",
  "In 476 the last western emperor was deposed and no successor was named.",
  "The eastern half of the empire survived for another thousand years.",
  "A G major chord uses three fingers on the low strings and both open middle strings.",
  "Beginners should practise switching between G, C and D until it is smooth.",
  "Pressing just behind the fret gives a clean note without buzzing.",
  "Barre chords are hard at first because one finger presses every string.",
  "During deep sleep the brain replays what was learned during the day.",
  "People who sleep after studying remember more than those who stay awake.",
  "Cutting sleep to five hours a night measurably weakens recall within a week.",
  "Dreaming sleep seems to help connect new memories to older ones.",
];

const SECTION_KEYS = Object.keys(SECTIONS);

const CRITERIA = {
  pertains: "The segment discusses the topic of the section.",
  does_not_pertain: "The segment discusses something else.",
  insufficient_evidence: "The segment does not contain enough information to decide.",
};

// Odd cells ask about the segment's own section (expected: pertains); even
// cells ask about a section two along (expected: does_not_pertain).
function makeCell(index) {
  const own = Math.floor(index / 4);
  const pertains = index % 2 === 0;
  return {
    qid: `q${index + 1}`,
    segment: `S${index + 1}`,
    section: SECTION_KEYS[pertains ? own : (own + 2) % SECTION_KEYS.length],
    expected: pertains ? "pertains" : "does_not_pertain",
  };
}

/** 20 cells, q1..q20. */
export const CELLS = SEGMENTS.map((_segment, index) => makeCell(index));

/** The shared state: every segment and every section, labelled. */
const SHARED_STATE = [
  "Transcript segments:",
  ...SEGMENTS.map((text, index) => `S${index + 1}: ${text}`),
  "",
  "Note sections:",
  ...SECTION_KEYS.map((key) => `${key}: ${SECTIONS[key]}`),
].join("\n");

function cellQuestion(cell) {
  return {
    type: "choice",
    instructions: `Does transcript segment ${cell.segment} pertain to note section ${cell.section}?`,
    criteria: CRITERIA,
  };
}

/** One request asking every given cell against the shared state. */
export function sharedStateBody(cells) {
  return {
    model: MODEL_PIN,
    state: SHARED_STATE,
    questions: Object.fromEntries(cells.map((cell) => [cell.qid, cellQuestion(cell)])),
  };
}

/** How many answers matched the expected choice, and how many distinct choices came back. */
export function scoreAnswers(answers, cells) {
  const choices = cells.map((cell) => answers?.[cell.qid]?.choice);
  return {
    correct: cells.filter((cell, index) => choices[index] === cell.expected).length,
    distinctChoices: new Set(choices).size,
  };
}
