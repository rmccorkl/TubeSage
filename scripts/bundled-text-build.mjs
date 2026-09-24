#!/usr/bin/env node
// Generate `src/bundled/*.generated.ts` from the repo files the informational
// modals show. `scripts/bundled-text-lib.mjs` holds the table and the reasons;
// this script is just the writer.
//
// Wired into `npm run build` (ahead of `tsc`, so the type check sees what the
// bundle will carry), which is what the release workflow runs — a stale
// generated file therefore cannot ship. Idempotent: running it twice writes
// the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_TEXTS, renderModule } from "./bundled-text-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const written = [];
for (const entry of BUNDLED_TEXTS) {
    const text = readFileSync(join(root, entry.source), "utf8");
    const modulePath = join(root, entry.module);
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, renderModule(entry, text));
    written.push(`${entry.source} -> ${entry.module}`);
}

console.log(`bundled-text:build — ${written.length} file(s): ${written.join(", ")}`);
