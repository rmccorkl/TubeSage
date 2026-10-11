#!/usr/bin/env node
// Entry point for the jev-timestamps rig. Everything that can run WITHOUT a
// key or a network call (usage, dry-run, refuse) runs before readKey() is
// ever called, matching the order of operations in the task brief exactly.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoEnvProxy, loadEnvFile, resolveKey } from "./lib/env.mjs";
import { createClient } from "./lib/client.mjs";
import { createRecorder } from "./lib/recorder.mjs";
import { estimatePlan, formatEstimate, decideGate } from "./lib/billing.mjs";
import { buildStage0Body, runStage0 } from "./stages/stage0.mjs";
import { planStage1Bodies, runStage1, STAGE1_MAX_REQUESTS } from "./stages/stage1.mjs";
import { planStage2Bodies, runStage2, STAGE2_MAX_REQUESTS } from "./stages/stage2.mjs";
import { loadNote, planStage3Bodies, previewStage3, runStage3, STAGE3_MAX_REQUESTS } from "./stages/stage3.mjs";
import { ENDPOINT, USER_AGENT, DEFAULT_TIMEOUT_MS } from "./lib/constants.mjs";

const USAGE = "Usage: node rig/jev-timestamps/cli.mjs <stage0|stage1|stage2|stage3> [--dry-run | --yes] [--note PATH] [--samples N] [--timeout-ms N] [--env-file PATH] [--op-token-file PATH] [--op-ref op://...]";

// Each stage: plan(opts) -> the bodies its estimate is priced on (an upper
// bound where the stage can stop early; throws with a printable message when
// it cannot plan), note(bodies) printed with the estimate, an optional
// no-network preview for --dry-run, and the runner.
const STAGES = {
  stage0: { plan: () => [buildStage0Body()], note: () => "One liveness request.", run: runStage0 },
  stage1: {
    plan: planStage1Bodies,
    note: () => `Upper bound (cap ${STAGE1_MAX_REQUESTS}): 2 single-question requests, then the multi-question probe at N=2, 5, 20, stopping at the first N that fails.`,
    run: runStage1,
  },
  stage2: {
    plan: planStage2Bodies,
    note: () => `Upper bound: a hard budget of ${STAGE2_MAX_REQUESTS} requests, retries included (6 keep-alive + 4 + 5 + 10 + 25 concurrency = 50, the rest for 429 retries).`,
    run: runStage2,
  },
  stage3: {
    plan: planStage3FromOpts,
    note: (bodies) =>
      `Round 1: ${bodies.length} requests (up to 20 questions each, concurrency 10); the estimate above prices round 1. ` +
      `Round 2 (arm C knockout) adds at most ${STAGE3_MAX_REQUESTS - bodies.length} more: hard cap ${STAGE3_MAX_REQUESTS} requests in total.`,
    preview: (opts, stdout) => previewStage3(loadNote(opts.note), stdout),
    run: runStage3,
  },
};

function planStage3FromOpts(opts) {
  if (!opts.note) throw new Error("stage3 needs --note PATH (keep real notes in rig/jev-timestamps/fixtures/, which is gitignored).");
  const bodies = planStage3Bodies(loadNote(opts.note));
  if (bodies.length > STAGE3_MAX_REQUESTS) {
    throw new Error(`stage3: this note needs ${bodies.length} round-1 requests, over the ${STAGE3_MAX_REQUESTS}-request cap.`);
  }
  return bodies;
}

// The exact command to spend, carrying over any credential flags given.
function spendCommand(opts) {
  const flags = [
    ["--note", opts.note],
    ["--env-file", opts.envFile],
    ["--op-token-file", opts.opTokenFile],
    ["--op-ref", opts.opRef],
  ].filter(([, value]) => value);
  const extra = flags.map(([flag, value]) => ` ${flag} ${JSON.stringify(value)}`).join("");
  return `node rig/jev-timestamps/cli.mjs ${opts.stage} --yes${extra}`;
}

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
  "--note": (opts, rest, i, errors) => takeValue(opts, "note", "--note", rest[i + 1], errors),
  "--env-file": (opts, rest, i, errors) => takeValue(opts, "envFile", "--env-file", rest[i + 1], errors),
  "--op-token-file": (opts, rest, i, errors) => takeValue(opts, "opTokenFile", "--op-token-file", rest[i + 1], errors),
  "--op-ref": (opts, rest, i, errors) => takeValue(opts, "opRef", "--op-ref", rest[i + 1], errors),
};

// A flag that takes the next token as its value. Returns how many extra tokens it consumed.
function takeValue(opts, field, flag, value, errors) {
  if (!value || value.startsWith("--")) {
    errors.push(`${flag} needs a value`);
    return 0;
  }
  opts[field] = value;
  return 1;
}

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

// Full bodies go to the run directory; the console gets one line per request.
function runDryRun({ bodies, stage, now, baseDir, stdout, command, preview }) {
  const recorder = createRecorder({ baseDir, stage, now, key: null });
  bodies.forEach((body, index) => {
    recorder.record(buildPlannedExchange(body));
    const bytes = Buffer.byteLength(JSON.stringify(body));
    stdout.write(`planned request: #${index + 1} questions=${Object.keys(body.questions).length} bytes=${bytes}\n`);
  });
  recorder.writeRun({ stage, dryRun: true, requests: bodies.length });
  stdout.write(`Planned bodies written to ${recorder.runDir}\n`);
  preview();
  stdout.write(`To spend, run: ${command}\n`);
  return 0;
}

// Where the key came from: a variable NAME or an op:// reference, never any part of a value.
function keySourceText(keyResult, envFile) {
  const where = {
    environment: "environment",
    "env-file": `--env-file ${envFile}`,
    "1password": `1Password, service-account token from ${keyResult.tokenSource}`,
  };
  return `using key from ${keyResult.name} (${where[keyResult.source]})`;
}

async function runGo({ stage, opts, env, fileVars, envFile, op, spawn, home, requestFn, timeoutMs, now, baseDir, stdout, stderr }) {
  stdout.write("Resolving the OpenRouter key...\n");
  const keyResult = await resolveKey({ env, fileVars, envFile, op, deps: { spawn, home } });
  if (!keyResult.ok) {
    stderr.write(`${keyResult.message}\n`);
    return 1;
  }
  stdout.write(`${keySourceText(keyResult, envFile)}\n`);

  const client = createClient({ key: keyResult.key, requestFn, timeoutMs, env });
  const recorder = createRecorder({ baseDir, stage, now, key: keyResult.key });
  const { exitCode } = await STAGES[stage].run({ client, recorder, stdout, key: keyResult.key, opts });
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
  if (!Object.hasOwn(STAGES, opts.stage ?? "")) {
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
    ctx.stdout.write(`Re-run with --yes to spend, or --dry-run to preview\nTo spend, run: ${ctx.command}\n`);
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
// short-circuit with a plain exit code: the proxy tripwire, an unreadable
// --env-file, and a stage that cannot plan. Returns `{ exit }` or
// `{ fileVars, bodies }`.
function preflight(opts, env, execArgv, stderr) {
  const proxyCheck = tryOrMessage(() => assertNoEnvProxy(env, execArgv));
  if (!proxyCheck.ok) {
    stderr.write(`${proxyCheck.message}\n`);
    return { exit: 1 };
  }
  const envFile = loadEnvFileOrExit(opts.envFile, stderr);
  if (envFile.exit !== undefined) return envFile;
  return { ...envFile, ...planOrExit(opts, stderr) };
}

// The stage's planned bodies, or an exit when it cannot plan (e.g. no --note).
function planOrExit(opts, stderr) {
  const planned = tryOrMessage(() => STAGES[opts.stage].plan(opts));
  if (planned.ok) return { bodies: planned.value };
  stderr.write(`${planned.message}\n`);
  return { exit: 1 };
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
 * @param {typeof import("node:child_process").spawn} [deps.spawn] - runs `op read` (injected in tests)
 * @param {string} [deps.home] - home directory for the default --op-token-file
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
    spawn,
    home,
  } = deps;

  const resolved = resolveArgsOrExit(argv, stdout, stderr);
  if (resolved.exit !== undefined) return resolved.exit;
  const { opts } = resolved;

  const checked = preflight(opts, env, execArgv, stderr);
  if (checked.exit !== undefined) return checked.exit;

  const stage = STAGES[opts.stage];
  const { bodies } = checked;
  stdout.write(`${formatEstimate(estimatePlan(bodies))}\n${stage.note(bodies)}\n`);

  const gateCheck = tryOrMessage(() => decideGate({ dryRun: opts.dryRun, yes: opts.yes }));
  if (!gateCheck.ok) {
    stderr.write(`${gateCheck.message}\n`);
    return 1;
  }

  const command = spendCommand(opts);
  return dispatchGate(gateCheck.value, {
    stdout,
    command,
    dryRunArgs: { bodies, stage: opts.stage, now, baseDir, stdout, command, preview: () => stage.preview?.(opts, stdout) },
    goArgs: { stage: opts.stage, opts, env, fileVars: checked.fileVars, envFile: opts.envFile, op: { ref: opts.opRef, tokenFile: opts.opTokenFile }, spawn, home, requestFn, timeoutMs: opts.timeoutMs, now, baseDir, stdout, stderr },
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
