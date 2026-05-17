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
        { enforceCamelCaseLower: true, allowAutoFix: true },
      ],
    },
  },
  // Disable typed linting for JSON (plugin applies typed rules globally — needs override)
  {
    files: ["**/*.json"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
    },
  },
  // manifest.json needs json/json language (plugin only wires package.json)
  {
    files: ["manifest.json"],
    plugins: { json },
    language: "json/json",
    rules: {
      "no-irregular-whitespace": "off",
    },
  }
);
