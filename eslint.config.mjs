import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import globals from "globals";
import json from "@eslint/json";
import preferActiveDocFixed from "./eslint-rules/prefer-active-doc-fixed.mjs";

// Swap obsidianmd's `prefer-active-doc` for a local implementation. Upstream's
// rule (as of v0.3.0) only flags `document`; this project also wants
// `window` -> `activeWindow` for popout compatibility. The local rule carves out
// `window.<timer>` calls so it does not contradict `prefer-window-timers`.
// Patched in-place on the plugin object before it gets registered.
if (obsidianmd.rules) {
  obsidianmd.rules["prefer-active-doc"] = preferActiveDocFixed;
}

export default tseslint.config(
  {
    ignores: [
      "main.js",
      "node_modules",
      // Worktrees live INSIDE the repo, so every tree-walking tool finds them
      // and lints a second, third... copy of the whole project — including one
      // stale copy's `eslint-rules/`, which the root-relative `eslint-rules/**`
      // below does not match. vitest.config.mjs carves them out for the same
      // reason.
      ".worktrees/**",
      "*.config.mjs",
      "*.config.js",
      "esbuild.config.mjs",
      "eslint-rules/**",
      "package-lock.json",
      "tsconfig*.json",
      ".claude/**",
      "graphify-out/**",
      ".fallowrc.json",
      ".mcp.json",
      ".fallow/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.eslint.json" },
      globals: {
        ...globals.browser,
        ...globals.node,
        createDiv: "readonly",
        createSpan: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          enforceCamelCaseLower: true,
          allowAutoFix: true,
          // "OpenRouter" is a brand name with intentional internal capitals.
          // It is not in the rule's built-in brand list, and `ignoreWords` is
          // bypassed for single-word strings, so the exact label is whitelisted
          // by regex to preserve official casing.
          ignoreRegex: ["^OpenRouter$"],
        },
      ],
    },
  },
  // Plain-JS tooling scripts: lint them, but WITHOUT type-aware rules.
  //
  // `obsidianmd.configs.recommended` turns its rules on in a block with no
  // `files` restriction, so they apply to every file ESLint visits — while the
  // blocks that install @typescript-eslint/parser are scoped to `**/*.js`,
  // `**/*.jsx`, `**/*.ts` and `**/*.tsx`. A `.mjs` file matches NEITHER parser
  // block, so it is parsed by espree, has no parser services, and the first
  // type-aware rule to run (`no-plugin-as-component`) throws — taking the whole
  // `eslint .` run down with it, not just that file.
  //
  // Adding `.mjs` to tsconfig would not help: `tsconfig.eslint.json` already
  // includes `**/*.mjs`. The mismatch is the PARSER, not the project. And these
  // are build/i18n helper scripts, not plugin code — the Obsidian API rules have
  // nothing to say about them. So the honest fix is to scope the type-aware
  // rules away from them, and keep every rule that does not need types.
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
    },
  },
  // `scripts/` is Node tooling — build steps, i18n generators and their tests.
  // It runs under Node during development and is never bundled into main.js, so
  // the plugin's mobile-runtime compatibility rules do not apply to it.
  // `regex-lookbehind` guards against iOS < 16.4, which cannot reach this code.
  // Scoped to `scripts/**` rather than to all .mjs on purpose: an .mjs that DID
  // ship would still be held to the mobile rules.
  {
    files: ["scripts/**"],
    rules: {
      "obsidianmd/regex-lookbehind": "off",
    },
  },
  // JSON is parsed as JSON, not as JavaScript.
  //
  // Only `manifest.json` used to get the json language, so every other .json
  // file was handed to the JS parser and failed with "Unexpected token :". That
  // never showed up because the type-aware crash above killed the run first —
  // fixing one fault uncovered the other. The typed obsidianmd rules are still
  // switched off here for the same reason as the .mjs block.
  {
    files: ["**/*.json"],
    plugins: { json },
    language: "json/json",
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
      // A core JS rule reaching for `sourceCode.getAllComments()`, which the
      // JSON language does not provide. `manifest.json` already carried this
      // carve-out — that is precisely why it was the one .json file that
      // linted. Now that every .json uses the json language, the carve-out
      // belongs here, and the manifest-only block it came from is gone.
      "no-irregular-whitespace": "off",
    },
  }
);
