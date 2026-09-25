// The jev-timestamps test rig (rig/jev-timestamps/) must never be reachable
// from main.js. Nothing today imports it from main.ts, but nothing stops a
// future edit from doing so by accident — an esbuild plugin that fails the
// build the moment it happens is a stronger guarantee than code review alone.
//
// The check is on the *loaded file's path*, not on import specifiers: it
// catches a rig module reached through any chain of imports, however deep,
// not just a direct "import ... from 'rig/...'" in main.ts.
import { relative, sep } from "node:path";

/**
 * esbuild plugin: fails the build for any loaded file whose path, relative to
 * `rootDir`, has "rig" as its first path segment.
 *
 * The onLoad filter is intentionally loose (any path containing a "rig" path
 * segment, so it also matches nested paths such as `.../rig/lib/x.mjs`) — it
 * exists only to avoid running the precise check against every loaded file.
 * The precise check is the `relative(...).split(sep)[0] === "rig"` test below,
 * which is what actually decides pass/fail. That split is why
 * `node_modules/pkg/rig/y.mjs` is left alone: its first segment relative to
 * `rootDir` is `node_modules`, not `rig`.
 */
export function rigGuardPlugin(rootDir) {
    return {
        name: "rig-guard",
        setup(build) {
            build.onLoad({ filter: /[\\/]rig[\\/]/ }, (args) => {
                const rel = relative(rootDir, args.path);
                const firstSegment = rel.split(sep)[0];
                if (firstSegment === "rig") {
                    return {
                        errors: [
                            {
                                text: `rig-guard: ${rel} is test-rig code and must never enter main.js`,
                            },
                        ],
                    };
                }
                // Not actually under a leading rig/ segment (e.g. it only
                // matched the loose filter above) — let later onLoad
                // callbacks, or esbuild's own default loader, handle it.
                return undefined;
            });
        },
    };
}
