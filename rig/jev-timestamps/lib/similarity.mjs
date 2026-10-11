// Arm B: a local text-similarity matrix, no API call. TF-IDF over words of
// three or more letters (common English stopwords dropped), cosine
// similarity between each section (heading + body) and each segment.

const STOPWORDS = new Set(
  (
    "the and for are but not you all any can had her was one our out has him his how its may new now old see two way who " +
    "did get let put say she too use that with have this will your from they know want been good much some time very when " +
    "come here just like long make many over such take than them well were what into more only also back after first then " +
    "there their these those would could should which about other because being where while going really thing things yeah " +
    "okay right gonna something actually basically kind sort lot lots"
  ).split(" "),
);

function tokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOPWORDS.has(word));
}

function termCounts(words) {
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function documentFrequency(documents) {
  return termCounts(documents.flatMap((counts) => [...counts.keys()]));
}

function inverseDocumentFrequency(documents) {
  const df = documentFrequency(documents);
  const idf = new Map();
  for (const [word, n] of df) idf.set(word, Math.log((documents.length + 1) / (n + 1)) + 1);
  return idf;
}

function weighted(counts, idf) {
  const vector = new Map();
  let norm = 0;
  for (const [word, count] of counts) {
    const value = count * idf.get(word);
    vector.set(word, value);
    norm += value * value;
  }
  return { vector, norm: Math.sqrt(norm) };
}

function dot(a, b) {
  let sum = 0;
  for (const [word, value] of a.vector) sum += value * (b.vector.get(word) ?? 0);
  return sum;
}

function cosine(a, b) {
  const norms = a.norm * b.norm;
  return norms === 0 ? 0 : dot(a, b) / norms;
}

/**
 * @param {string[]} sectionTexts
 * @param {string[]} segmentTexts
 * @returns {number[][]} similarity[section][segment], each in [0, 1]
 */
export function similarityMatrix(sectionTexts, segmentTexts) {
  const counts = [...sectionTexts, ...segmentTexts].map((text) => termCounts(tokens(text)));
  const idf = inverseDocumentFrequency(counts);
  const vectors = counts.map((c) => weighted(c, idf));
  const sections = vectors.slice(0, sectionTexts.length);
  const segments = vectors.slice(sectionTexts.length);
  return sections.map((section) => segments.map((segment) => cosine(section, segment)));
}
