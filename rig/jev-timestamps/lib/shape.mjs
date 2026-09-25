// Describes the SHAPE of an upstream body without ever echoing its string
// contents, so an error response can be reported without leaking whatever
// prose it contained.
function describeArrayShape(value) {
  return { array: value.length > 0 ? describeShape(value[0]) : null, length: value.length };
}

function describeObjectShape(value) {
  const object = {};
  for (const [k, v] of Object.entries(value)) {
    object[k] = describeShape(v);
  }
  return { object };
}

/**
 * @param {unknown} value
 * @returns {unknown} a JSON-able type tree: primitives become their
 *   `typeof` name (no content), `null` stays `"null"`, arrays report their
 *   length and the shape of their first element, objects report the shape of
 *   each of their own values keyed by the SAME key names (key names are
 *   structural, not string content, and are needed to describe the shape).
 */
export function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return describeArrayShape(value);
  if (typeof value === "object") return describeObjectShape(value);
  return typeof value;
}
