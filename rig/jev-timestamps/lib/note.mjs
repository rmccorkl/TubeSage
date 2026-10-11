// Parses ONE real TubeSage note into what stage 3 matches:
//   segments - the frontmatter transcript, one per formatTranscriptForYaml
//              line: "[HH:MM:SS] [TimeIndex:N] text" (colons in the text are
//              escaped as \:). startSeconds is N when present, else HH:MM:SS.
//   sections - numbered headings ("## 1.", "### 1.1.", "#### 1.1.1.") with
//              the body text up to the next heading of any kind.
//   current  - the second (timestamp) pass's existing link on a heading:
//              [Watch](...&t=N), or an unconverted [TimeIndex:N].
// Copied in spirit from the plugin's extractDocumentComponents, not imported:
// the rig never imports plugin source. Frontmatter is found by LINE (a "---"
// line), so a "---" inside transcript text cannot cut it short.

const SEGMENT_LINE = /^\s*\[(\d{1,2}):(\d{2}):(\d{2})\]\s*(?:\[TimeIndex:(\d+)\]\s*)?(.*)$/;
const NUMBERED_HEADING = /^(#{1,6})\s+(\d+(?:\.\d+)*)\.?\s+(.+?)\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const WATCH_LINK = /\[Watch\]\(https:\/\/www\.youtube\.com\/watch\?v=[^)\s]*?[?&]t=(\d+)[^)\s]*\)/;
const TIME_INDEX = /\[TimeIndex:(\d+)\]/;

function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  return end > 0 ? { frontmatter: lines.slice(1, end), body: lines.slice(end + 1) } : { frontmatter: [], body: lines };
}

function toSegment(match) {
  const [, h, m, s, timeIndex, text] = match;
  const clock = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return { startSeconds: timeIndex === undefined ? clock : Number(timeIndex), text: text.replace(/\\:/g, ":").trim() };
}

function parseSegments(frontmatterLines) {
  return frontmatterLines
    .map((line) => SEGMENT_LINE.exec(line))
    .filter(Boolean)
    .map(toSegment)
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((segment, index) => ({ ...segment, index }));
}

function currentSecondsOf(headingLine) {
  const match = WATCH_LINK.exec(headingLine) ?? TIME_INDEX.exec(headingLine);
  return match ? Number(match[1]) : null;
}

function cleanHeading(text) {
  return text.replace(WATCH_LINK, "").replace(TIME_INDEX, "").trim();
}

function startSection(match, line) {
  const [, hashes, number, text] = match;
  return { level: hashes.length, number, heading: `${number}. ${cleanHeading(text)}`, currentSeconds: currentSecondsOf(line), bodyLines: [] };
}

function parseSections(bodyLines) {
  const sections = [];
  let open = null;
  for (const line of bodyLines) {
    const match = NUMBERED_HEADING.exec(line);
    if (match) sections.push((open = startSection(match, line)));
    else if (ANY_HEADING.test(line)) open = null;
    else open?.bodyLines.push(line);
  }
  return sections.map(({ bodyLines: lines, ...section }, index) => ({ ...section, index, body: lines.join(" ").replace(/\s+/g, " ").trim() }));
}

/** The segment a current-pass link points into: the last one starting at or before it. */
function segmentIndexAt(segments, seconds) {
  if (seconds === null) return null;
  const at = segments.filter((segment) => segment.startSeconds <= seconds);
  return at.length > 0 ? at[at.length - 1].index : 0;
}

/**
 * @param {string} text - the whole note file
 * @returns {{ segments: Array<{ index: number, startSeconds: number, text: string }>,
 *   sections: Array<{ index: number, level: number, number: string, heading: string, body: string,
 *   currentSeconds: number | null, currentSegment: number | null }> }}
 */
export function parseNote(text) {
  const { frontmatter, body } = splitFrontmatter(text);
  const segments = parseSegments(frontmatter);
  const sections = parseSections(body).map((section) => ({ ...section, currentSegment: segmentIndexAt(segments, section.currentSeconds) }));
  return { segments, sections };
}

/** 0:00 / 12:05 / 1:02:03 */
export function formatClock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
