import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  { ignores: ["main.js"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        ...globals.browser,
        ...globals.node,
        createDiv: "readonly",
        createSpan: "readonly",
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "error",
        { enforceCamelCaseLower: true, allowAutoFix: true },
      ],
    },
  },
]);
