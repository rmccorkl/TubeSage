#!/usr/bin/env node
// Entry point for the jev-timestamps rig. Everything that can run WITHOUT a
// key or a network call (usage, dry-run, refuse) runs before readKey() is
// ever called, matching the order of operations in the task brief exactly.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoEnvProxy, loadEnvFile, readKey } from "./lib/env.mjs";
import { createClient } from "./lib/client.mjs";
import { createRecorder } from "./lib/recorder.mjs";
import { estimatePlan, formatEstimate, decideGate } from "./lib/billing.mjs";
import { buildStage0Body, runStage0 } from "./stages/stage0.mjs";
import { ENDPOINT, USER_AGENT, DEFAULT_TIMEOUT_MS } from "./lib/constants.mjs";

const USAGE = "Usage: node rig/jev-timestamps/cli.mjs <stage0|stage1> [--dry-run | --yes] [--samples N] [--timeout-ms N] [--env-file PATH]";

function parsePositiveInt(text, label, errors) {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${label} must be a positive integer, got: ${text}`);
    return undefined;
  }
  return n;
}

// Each flag owns exactly how it mutates `opts` (and, for the two that take a
// value, how it advances the arg cursor). Keeping this as a lookup rather
// than an if/else-if chain is what keeps parseArgs itself simple.
const FLAG_HANDLERS = {
  "--dry-run": (opts) => {
    opts.dryRun = true;
  },
  "--yes": (opts) => {
    opts.yes = true;
  },
  "--help": (opts) => {
    opts.help = true;
  },
  "--samples": (opts, rest, i, errors) => {
    const value = parsePositiveInt(rest[i + 1], "--samples", errors);
    if (value !== undefined) opts.samples = value;
    return 1; // consumed one extra token
  },
  "--timeout-ms": (opts, rest, i, errors) => {
    const value = parsePositiveInt(rest[i + 1], "--timeout-ms", errors);
    if (value !== undefined) opts.timeoutMs = value;
    return 1;
  },
  "--env-file": (opts, rest, i, errors) => {
    const path = rest[i + 1];
    if (!path || path.startsWith("--")) {
      errors.push("--env-file needs a path");
      return 0;
    }
    opts.envFile = path;
    return 1;
  },
};

function parseArgs(argv) {
  const [stage, ...rest] = argv;
  const opts = { stage, dryRun: false, yes: false, samples: 1, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  const errors = [];
  for (let i = 0; i < rest.length; i++) {
    const handler = FLAG_HANDLERS[rest[i]];
    if (!handler) {
      errors.push(`Unknown argument: ${rest[i]}`);
      continue;
    }
    i += handler(opts, rest, i, errors) ?? 0;
  }
  return { opts, errors };
}

function wantsUsage(opts) {
  return !opts.stage || opts.stage === "--help" || opts.help;
}

function buildPlannedExchange(body) {
  return {
    request: {
      method: "POST",
      url: ENDPOINT,
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body,
    },
    response: null,
    dryRun: true,
  };
}

function runDryRun({ bodies, stage, now, baseDir, stdout }) {
  const recorder = createRecorder({ baseDir, stage, now, key: null });
  for (const body of bodies) {
    const planned = buildPlannedExchange(body);
    recorder.record(planned);
    stdout.write(`planned request: ${JSON.stringify(planned)}\n`);
  }
  recorder.writeRun({ stage, dryRun: true, requests: bodies.length });
  return 0;
}

async function runGo({ stage, env, fileVars, envFile, requestFn, timeoutMs, now, baseDir, stdout, stderr }) {
  const keyResult = readKey(env, fileVars, envFile);
  if (!keyResult.ok) {
    stderr.write(`${keyResult.message}\n`);
    return 1;
  }
  // The variable NAME and where it came from — never any part of its value.
  stdout.write(`using key from ${keyResult.name} (${keyResult.source === "env-file" ? `--env-file ${envFile}` : "environment"})\n`);

  const client = createClient({ key: keyResult.key, requestFn, timeoutMs, env });
  const recorder = createRecorder({ baseDir, stage, now, key: keyResult.key });
  const { exitCode } = await runStage0({ client, recorder, stdout, key: keyResult.key });
  return exitCode;
}

// Wraps a throwing call so a single `if (!outcome.ok)` replaces a try/catch
// at each call site, keeping run()'s own branch count small.
function tryOrMessage(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function validateStage(opts, errors) {
  if (opts.stage !== "stage0" && opts.stage !== "stage1") {
    errors.unshift(`Unknown stage: ${opts.stage}`);
  }
}

// Parses argv and handles every exit that doesn't need a live gate decision:
// bare/--help usage, and any argument error (including an unrecognised
// stage). Returns either `{ exit }` or `{ opts }`.
function resolveArgsOrExit(argv, stdout, stderr) {
  const { opts, errors } = parseArgs(argv);
  if (wantsUsage(opts)) {
    stdout.write(USAGE + "\n");
    return { exit: 0 };
  }
  validateStage(opts, errors);
  if (errors.length > 0) {
    stderr.write(errors.join("\n") + "\n" + USAGE + "\n");
    return { exit: 1 };
  }
  return { opts };
}

// Handles the three-way gate outcome. Isolated from run() so run() only
// carries the "did the gate decision itself fail" branch.
function dispatchGate(gate, ctx) {
  if (gate === "dry-run") {
    return runDryRun(ctx.dryRunArgs);
  }
  if (gate === "refuse") {
    ctx.stdout.write("Re-run with --yes to spend, or --dry-run to preview\n");
    return 2;
  }
  return runGo(ctx.goArgs);
}

// Loaded (and a bad path reported) before the gate, so a dry run catches a
// wrong --env-file too. Its values are only ever handed to readKey; only the
// path can appear in a message.
function loadEnvFileOrExit(envFile, stderr) {
  if (!envFile) return { fileVars: {} };
  const loaded = loadEnvFile(envFile);
  if (!loaded.ok) {
    stderr.write(`${loaded.message}\n`);
    return { exit: 1 };
  }
  return { fileVars: loaded.vars };
}

// Everything between the parsed args and the spend gate that can still
// short-circuit with a plain exit code: the proxy tripwire, the stage1 stub,
// and an unreadable --env-file. Returns `{ exit }` or `{ fileVars }`.
function preflight(opts, env, execArgv, stdout, stderr) {
  const proxyCheck = tryOrMessage(() => assertNoEnvProxy(env, execArgv));
  if (!proxyCheck.ok) {
    stderr.write(`${proxyCheck.message}\n`);
    return { exit: 1 };
  }
  if (opts.stage === "stage1") {
    stdout.write("stage1: not built yet\n");
    return { exit: 1 };
  }
  return loadEnvFileOrExit(opts.envFile, stderr);
}

/**
 * @param {string[]} [argv]
 * @param {object} [deps]
 * @param {typeof import("node:https").request} [deps.requestFn]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {string} [deps.baseDir]
 * @param {{ write: (chunk: string) => unknown }} [deps.stdout]
 * @param {{ write: (chunk: string) => unknown }} [deps.stderr]
 * @param {string[]} [deps.execArgv]
 * @returns {Promise<number>} the process exit code.
 */
export async function run(argv = process.argv.slice(2), deps = {}) {
  const {
    requestFn,
    env = process.env,
    now = () => new Date(),
    baseDir,
    stdout = process.stdout,
    stderr = process.stderr,
    execArgv = process.execArgv,
  } = deps;

  const resolved = resolveArgsOrExit(argv, stdout, stderr);
  if (resolved.exit !== undefined) return resolved.exit;
  const { opts } = resolved;

  const checked = preflight(opts, env, execArgv, stdout, stderr);
  if (checked.exit !== undefined) return checked.exit;

  const bodies = [buildStage0Body()];
  stdout.write(formatEstimate(estimatePlan(bodies)) + "\n");

  const gateCheck = tryOrMessage(() => decideGate({ dryRun: opts.dryRun, yes: opts.yes }));
  if (!gateCheck.ok) {
    stderr.write(`${gateCheck.message}\n`);
    return 1;
  }

  return dispatchGate(gateCheck.value, {
    stdout,
    dryRunArgs: { bodies, stage: opts.stage, now, baseDir, stdout },
    goArgs: { stage: opts.stage, env, fileVars: checked.fileVars, envFile: opts.envFile, requestFn, timeoutMs: opts.timeoutMs, now, baseDir, stdout, stderr },
  });
}

// Ruling R1: compare import.meta.url with pathToFileURL(process.argv[1]).
// Both sides are realpath-resolved first so a symlink anywhere in the
// invocation path (common under macOS's /tmp -> /private/tmp, or a worktree
// reached through a symlinked ancestor) doesn't make this silently false and
// turn `node cli.mjs` into a no-op that exits 0 having done nothing.
function isMainModule() {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    const invokedUrl = pathToFileURL(realpathSync(invoked)).href;
    const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return invokedUrl === selfUrl;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await run();
  process.exit(code);
}
