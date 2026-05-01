// Local fix for eslint-plugin-obsidianmd's `prefer-active-doc` rule.
// Upstream bug: REPLACEMENTS[node.name] follows the prototype chain, so any
// Identifier whose name matches an Object.prototype key (constructor, toString,
// hasOwnProperty, ...) is falsely flagged. Guarding with Object.hasOwn fixes it.

const REPLACEMENTS = Object.freeze({
  document: "activeDocument",
  window: "activeWindow",
});
const BANNED_GLOBALS = new Set(["global", "globalThis"]);

function findVariable(scope, name) {
  let current = scope;
  while (current) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) return variable;
    current = current.upper;
  }
  return null;
}

function isSkippableParent(node) {
  const p = node.parent;
  if (!p) return false;
  if (p.type === "MemberExpression" && p.property === node) return true;
  if (p.type === "Property" && p.key === node) return true;
  if (p.type === "VariableDeclarator" && p.id === node) return true;
  if (p.type === "UnaryExpression" && p.operator === "typeof") return true;
  return false;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `activeDocument` and `activeWindow` over `document` and `window` for popout window compatibility.",
    },
    schema: [],
    fixable: "code",
    messages: {
      preferActive:
        "Use '{{replacement}}' instead of '{{original}}' for popout window compatibility.",
      avoidGlobal:
        "Avoid using '{{name}}'. Use 'activeWindow' or 'activeDocument' for popout window compatibility.",
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (BANNED_GLOBALS.has(node.name)) {
          if (isSkippableParent(node)) return;
          const scope = context.sourceCode.getScope(node);
          if (findVariable(scope, node.name)?.defs.length) return;
          context.report({
            node,
            messageId: "avoidGlobal",
            data: { name: node.name },
          });
          return;
        }

        if (!Object.hasOwn(REPLACEMENTS, node.name)) return;
        if (isSkippableParent(node)) return;

        const scope = context.sourceCode.getScope(node);
        if (findVariable(scope, node.name)?.defs.length) return;

        const replacement = REPLACEMENTS[node.name];
        context.report({
          node,
          messageId: "preferActive",
          data: { original: node.name, replacement },
          fix(fixer) {
            return fixer.replaceText(node, replacement);
          },
        });
      },
    };
  },
};
