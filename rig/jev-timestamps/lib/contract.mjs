// The response contract, as observed live in stage 0 (2026-10-11):
//   { model, answers: { <qid>: { type, choice, probabilities, confidence } },
//     usage: { input_tokens, output_tokens, cost }, id, provider }
// Unknown top-level keys (id, provider) are TOLERATED and reported as
// observations; a wrong model is a violation. Every problem is collected,
// not just the first. The checks mirror hermes-carapace's judge adapter
// (probabilities sum to 1 +/-0.01, criteria keys exactly as sent, model ==
// pin), but nothing here throws.

const KNOWN_TOP_LEVEL = ["model", "answers", "usage"];
const KNOWN_ANSWER_KEYS = ["type", "choice", "probabilities", "confidence"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnit(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameKeys(object, expected) {
  const actual = Object.keys(object).sort();
  const wanted = Object.keys(expected).sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** @returns {unknown | null} the parsed body, or null if it is not JSON. */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hasCriteriaKeys(probabilities, criteria) {
  return isObject(probabilities) && sameKeys(probabilities, criteria);
}

function sumViolations(qid, probabilities) {
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  return Math.abs(sum - 1) > 0.01 ? [`probabilities-sum:${qid}`] : [];
}

function checkProbabilities(qid, probabilities, criteria) {
  if (!hasCriteriaKeys(probabilities, criteria)) return [`probabilities-keys-mismatch:${qid}`];
  const notUnit = Object.keys(probabilities).filter((key) => !isUnit(probabilities[key]));
  if (notUnit.length > 0) return notUnit.map((key) => `probability-not-unit:${qid}:${key}`);
  return sumViolations(qid, probabilities);
}

const ANSWER_RULES = [
  (qid, answer, question) => (answer.type === question.type ? [] : [`type-mismatch:${qid}`]),
  (qid, answer, question) => checkProbabilities(qid, answer.probabilities, question.criteria),
  (qid, answer, question) => (Object.hasOwn(question.criteria, answer.choice) ? [] : [`choice-not-in-criteria:${qid}`]),
  (qid, answer) => (isUnit(answer.confidence) ? [] : [`confidence-not-unit:${qid}`]),
];

function checkAnswer(qid, answer, question) {
  if (!isObject(answer)) return [`answer-not-object:${qid}`];
  return ANSWER_RULES.flatMap((rule) => rule(qid, answer, question));
}

function checkAnswers(answers, questions) {
  if (!isObject(answers)) return ["answers-not-object"];
  const keys = sameKeys(answers, questions) ? [] : ["answers-keys-mismatch"];
  const perAnswer = Object.keys(questions)
    .filter((qid) => Object.hasOwn(answers, qid))
    .flatMap((qid) => checkAnswer(qid, answers[qid], questions[qid]));
  return [...keys, ...perAnswer];
}

const TOP_LEVEL_RULES = [
  (json, { pin }) => (json.model === pin ? [] : ["model-mismatch"]),
  (json, { questions }) => checkAnswers(json.answers, questions),
  (json) => (isObject(json.usage) && typeof json.usage.cost === "number" ? [] : ["usage-cost-missing"]),
];

function argmax(probabilities) {
  return Object.keys(probabilities).reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best));
}

function hasProbabilities(answer) {
  return isObject(answer) && isObject(answer.probabilities) && Object.keys(answer.probabilities).length > 0;
}

function extraAnswerKeys(qid, answer) {
  const extra = Object.keys(answer).filter((key) => !KNOWN_ANSWER_KEYS.includes(key));
  return extra.length > 0 ? [`extra answer keys in ${qid}: ${extra.join(", ")}`] : [];
}

function observeAnswer(qid, answer) {
  if (!hasProbabilities(answer)) return [];
  const argmaxNote = argmax(answer.probabilities) === answer.choice ? [] : [`choice is not the argmax in ${qid}`];
  return [...extraAnswerKeys(qid, answer), ...argmaxNote];
}

function observe(json) {
  const extraTop = Object.keys(json).filter((key) => !KNOWN_TOP_LEVEL.includes(key));
  const answers = isObject(json.answers) ? Object.entries(json.answers) : [];
  return [
    ...(extraTop.length > 0 ? [`extra top-level keys (tolerated): ${extraTop.join(", ")}`] : []),
    ...(isObject(json.usage) ? [`usage keys: ${Object.keys(json.usage).join(", ")}`] : []),
    ...answers.flatMap(([qid, answer]) => observeAnswer(qid, answer)),
  ];
}

/**
 * @param {unknown} json - the parsed response body
 * @param {{ pin: string, questions: Record<string, { type: string, criteria: Record<string, string> }> }} sent
 * @returns {{ violations: string[], observations: string[] }}
 */
export function checkResponse(json, sent) {
  if (!isObject(json)) return { violations: ["not-object"], observations: [] };
  return { violations: TOP_LEVEL_RULES.flatMap((rule) => rule(json, sent)), observations: observe(json) };
}
