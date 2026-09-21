import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// tsconfig.json sets `baseUrl: "."`, so shipped modules import each other as
// `src/utils/...`. esbuild honours that; Vite does not, so tests that load
// such a module (e.g. src/youtube-transcript.ts) need the same root mapping.
const srcDir = fileURLToPath(new URL("./src/", import.meta.url));

export default defineConfig({
  // Git worktrees live under .worktrees/; never collect their test copies.
  test: { exclude: ["**/node_modules/**", "**/.worktrees/**"] },
  resolve: {
    alias: [{ find: /^src\//, replacement: srcDir }],
  },
});
