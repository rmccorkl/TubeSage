// Key handling (environment, --env-file, 1Password via a service-account
// token), --env-file loading and the env-proxy tripwire. Nothing here ever
// prints an environment variable or discloses any part of a value: only
// variable NAMES, file PATHS, op:// references and op's exit status ever
// appear in a message.
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";
import { KEY_ENV_NAMES } from "./constants.mjs";

// One name, looked up in the real environment before the env-file — so the
// env-file never overrides a variable the environment already has.
function lookupName(name, env, fileVars) {
  if (env[name]) return { ok: true, key: env[name], name, source: "environment" };
  if (fileVars[name]) return { ok: true, key: fileVars[name], name, source: "env-file" };
  return null;
}

function notFoundMessage(envFilePath) {
  const searched = envFilePath ? [`None of them is set in the environment or in --env-file ${envFilePath}.`] : [];
  return [
    `No OpenRouter key found. Accepted variables, in order: ${KEY_ENV_NAMES.join(", ")}.`,
    ...searched,
    "Export one of them, or point the rig at an existing .env file:",
    "  node rig/jev-timestamps/cli.mjs stage0 --yes --env-file /path/to/.env",
    "--env-file never overrides a variable already set in the environment, and no value from it is ever printed.",
    "Otherwise the rig reads the key from 1Password with a service-account token (--op-token-file, --op-ref).",
  ].join("\n");
}

/**
 * Finds the OpenRouter key: the first name in KEY_ENV_NAMES that is set (see
 * lookupName for environment vs env-file precedence). Never logs, echoes, or
 * discloses any prefix/length of a value; the failure message names only
 * variables and the env-file path.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, string>} [fileVars] - parsed --env-file contents
 * @param {string} [envFilePath] - named in the failure message when given
 * @returns {{ ok: true, key: string, name: string, source: "environment" | "env-file" }
 *   | { ok: false, message: string }}
 */
export function readKey(env = {}, fileVars = {}, envFilePath = undefined) {
  for (const name of KEY_ENV_NAMES) {
    const found = lookupName(name, env, fileVars);
    if (found) return found;
  }
  return { ok: false, message: notFoundMessage(envFilePath) };
}

// NAME=value with NAME a shell-style identifier. A blank line, a `#` comment
// or anything else simply does not match.
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const QUOTED = /^(["'])(.*)\1$/;

function stripMatchingQuotes(value) {
  const match = QUOTED.exec(value);
  return match ? match[2] : value;
}

function parseEnvLine(rawLine) {
  const match = ENV_LINE.exec(rawLine.trim());
  return match ? [match[1], stripMatchingQuotes(match[2].trim())] : null;
}

/**
 * Parses simple KEY=VALUE lines. Blank lines and `#` comments are skipped,
 * surrounding single/double quotes are stripped, and any other line is
 * ignored silently — a malformed line is never echoed, since it may hold a
 * value.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const vars = Object.create(null);
  for (const entry of text.split(/\r?\n/).map(parseEnvLine)) {
    if (entry) vars[entry[0]] = entry[1];
  }
  return vars;
}

/**
 * Reads and parses an env file. A missing or unreadable file is reported by
 * PATH and Node error code only.
 *
 * @param {string} path
 * @param {typeof readFileSync} [readFile]
 * @returns {{ ok: true, vars: Record<string, string> } | { ok: false, message: string }}
 */
export function loadEnvFile(path, readFile = readFileSync, label = "--env-file") {
  let text;
  try {
    text = readFile(path, "utf8");
  } catch (err) {
    return { ok: false, message: `${label}: cannot read ${path} (${err?.code ?? "read error"}). Check the path exists and is readable.` };
  }
  return { ok: true, vars: parseEnvFile(text) };
}

// ---------------------------------------------------------------------------
// 1Password: the Hermes service-account method. A service-account token
// (OP_SERVICE_ACCOUNT_TOKEN from the environment, else from a dotenv token
// file) is handed to ONE spawned `op read <reference>` through that child's
// environment map: never argv (world-readable in ps), never this process's
// own environment, never disk. The child's stdout is the key. Its stderr is
// read only to tell "not found" from "auth failed" and is never printed. Only
// variable names, the op:// reference and op's exit status reach a message.
// ---------------------------------------------------------------------------

export const DEFAULT_OP_REF = "op://HermesAutomationVault/OpenRouter API Key/API_Key_JevOpenrouter";
const OP_TOKEN_VAR = "OP_SERVICE_ACCOUNT_TOKEN";
const OP_TIMEOUT_MS = 30_000;
const MAX_OP_OUTPUT_BYTES = 65_536;
// Heuristic: op's wording for a missing vault/item/field is not a documented
// contract. Anything that does not match is reported as a probable auth
// failure, and that message names the reference too.
const OP_NOT_FOUND = /isn't an item|isn't a vault|isn't a field|not found|no item|could not find|doesn't exist/i;

/** The Hermes profile's dotenv file that holds the service-account token. */
function defaultOpTokenFile(home = homedir()) {
  return join(home, ".hermes", "profiles", "tvmacro-bot", ".env");
}

/**
 * The service-account token: OP_SERVICE_ACCOUNT_TOKEN from the environment if
 * set, else parsed out of the token file.
 *
 * @returns {{ ok: true, token: string, source: string } | { ok: false, message: string }}
 */
function resolveOpToken({ env = {}, tokenFile, readFile = readFileSync }) {
  if (env[OP_TOKEN_VAR]) return { ok: true, token: env[OP_TOKEN_VAR], source: `${OP_TOKEN_VAR} in the environment` };
  const loaded = loadEnvFile(tokenFile, readFile, "--op-token-file");
  if (!loaded.ok) return { ok: false, message: `1Password: no ${OP_TOKEN_VAR} in the environment. ${loaded.message}` };
  const token = loaded.vars[OP_TOKEN_VAR];
  return token
    ? { ok: true, token, source: `token file ${tokenFile}` }
    : { ok: false, message: `1Password: ${tokenFile} has no ${OP_TOKEN_VAR} line.` };
}

function staleTokenHint(tokenSource) {
  return tokenSource.endsWith("in the environment")
    ? ` An ${OP_TOKEN_VAR} inherited from your shell can be a stale or deleted token: unset it so the token file is used, or pass --op-token-file.`
    : "";
}

/** One actionable line per way `op read` can fail. Never includes a token, a key or op's own output. */
function opFailureMessage(outcome, ref, tokenSource) {
  if (outcome.spawnErrorCode === "ENOENT") {
    return "1Password: the op CLI is not on PATH. Install the 1Password CLI, or set OPENROUTER_API_KEY instead.";
  }
  if (outcome.spawnErrorCode) return `1Password: could not start op (${outcome.spawnErrorCode}).`;
  if (outcome.timedOut) return `1Password: op read ${ref} did not finish within ${OP_TIMEOUT_MS / 1000} s and was stopped.`;
  return opExitMessage(outcome, ref, tokenSource);
}

function opExitMessage(outcome, ref, tokenSource) {
  if (outcome.exitCode === 0) return `1Password: op read ${ref} succeeded but returned an empty value.`;
  if (OP_NOT_FOUND.test(outcome.stderrText)) {
    return `1Password: reference not found: ${ref} (op exit ${outcome.exitCode}). Check the vault, item and field names, or pass --op-ref.`;
  }
  return (
    `1Password: op read ${ref} failed (op exit ${outcome.exitCode}). Most likely the service-account token ` +
    `(${tokenSource}) is invalid, deleted, or cannot see that vault.${staleTokenHint(tokenSource)}`
  );
}

function collect(stream, sink) {
  stream?.on("data", (chunk) => {
    sink.bytes += chunk.length;
    if (sink.bytes <= MAX_OP_OUTPUT_BYTES) sink.chunks.push(chunk);
  });
}

function textOf(sink) {
  return Buffer.concat(sink.chunks).toString("utf8");
}

/**
 * Runs `op read <ref>` with the token in the CHILD's environment map only.
 * Resolves (never rejects) to { exitCode, stdoutText, stderrText } or
 * { spawnErrorCode } or { timedOut }.
 */
function spawnOpRead({ ref, token, env, spawn, timeoutMs }) {
  return new Promise((resolve) => {
    const out = { chunks: [], bytes: 0 };
    const err = { chunks: [], bytes: 0 };
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timer);
      resolve(outcome);
    };
    const child = spawn("op", ["read", ref], { env: { ...env, [OP_TOKEN_VAR]: token }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = scheduleTimeout(() => {
      child.kill();
      settle({ timedOut: true });
    }, timeoutMs);
    collect(child.stdout, out);
    collect(child.stderr, err);
    child.on("error", (error) => settle(spawnErrorOutcome(error)));
    child.on("close", (exitCode) => settle({ exitCode, stdoutText: textOf(out), stderrText: textOf(err) }));
  });
}

/** `op read` prints the value followed by one newline. */
function secretFrom(outcome) {
  return outcome.exitCode === 0 ? (outcome.stdoutText ?? "").replace(/\r?\n$/, "") : "";
}

/**
 * Reads the key from 1Password.
 *
 * @returns {Promise<{ ok: true, key: string } | { ok: false, message: string }>}
 */
function spawnErrorOutcome(error) {
  return { spawnErrorCode: error?.code ?? "spawn error" };
}

export async function readKeyFromOnePassword({ ref, token, tokenSource, env, spawn = nodeSpawn, timeoutMs = OP_TIMEOUT_MS }) {
  // A spawn that throws synchronously rejects the promise; it is reported like a spawn error.
  const outcome = await spawnOpRead({ ref, token, env, spawn, timeoutMs }).catch(spawnErrorOutcome);
  const key = secretFrom(outcome);
  return key ? { ok: true, key } : { ok: false, message: opFailureMessage(outcome, ref, tokenSource) };
}

function onePasswordSkipped(env, deps) {
  // Never reach the real op (or the real token file) from the test runner.
  return Boolean(env.VITEST) && !deps.spawn;
}

/**
 * The OpenRouter key, first hit wins:
 *   1. OPENROUTER_API_KEY_JEV / OPENROUTER_API_KEY in the environment
 *   2. the same names in --env-file
 *   3. 1Password: `op read <ref>` with a service-account token
 *
 * @param {object} args
 * @param {Record<string, string | undefined>} args.env
 * @param {Record<string, string>} [args.fileVars]
 * @param {string} [args.envFile]
 * @param {{ ref?: string, tokenFile?: string }} [args.op]
 * @param {{ spawn?: Function, home?: string, readFile?: Function }} [args.deps]
 * @returns {Promise<{ ok: true, key: string, name: string, source: string, tokenSource?: string }
 *   | { ok: false, message: string }>}
 */
// --op-ref / --op-token-file, or the Hermes defaults.
function opSettings(op, deps) {
  return { ref: op.ref ?? DEFAULT_OP_REF, tokenFile: op.tokenFile ?? defaultOpTokenFile(deps.home) };
}

async function resolveFromOnePassword(env, op, deps) {
  const { ref, tokenFile } = opSettings(op, deps);
  const token = resolveOpToken({ env, tokenFile, readFile: deps.readFile });
  if (!token.ok) return token;
  const read = await readKeyFromOnePassword({ ref, token: token.token, tokenSource: token.source, env, spawn: deps.spawn });
  return read.ok ? { ok: true, key: read.key, name: ref, source: "1password", tokenSource: token.source } : read;
}

export async function resolveKey({ env = {}, fileVars = {}, envFile, op = {}, deps = {} }) {
  const local = readKey(env, fileVars, envFile);
  if (local.ok) return local;
  const remote = onePasswordSkipped(env, deps)
    ? { ok: false, message: "1Password: skipped under the test runner." }
    : await resolveFromOnePassword(env, op, deps);
  return remote.ok ? remote : { ok: false, message: `${local.message}\n${remote.message}` };
}

// Each entry is independent: a predicate over (env, execArgv) and the label
// to name in the thrown message when it trips. Never inspects or names a
// VALUE, only the setting itself.
const PROXY_TRIPWIRES = [
  { label: "NODE_USE_ENV_PROXY is set in the environment", active: (env) => Boolean(env?.NODE_USE_ENV_PROXY) },
  {
    label: "--use-env-proxy is present in execArgv",
    active: (_env, execArgv) => Array.isArray(execArgv) && execArgv.includes("--use-env-proxy"),
  },
  {
    label: "NODE_OPTIONS contains --use-env-proxy",
    active: (env) => typeof env?.NODE_OPTIONS === "string" && env.NODE_OPTIONS.includes("--use-env-proxy"),
  },
];

/**
 * Throws when Node's experimental env-configured proxy is active, in any of
 * the three ways it can be turned on. The thrown message names the setting
 * that tripped, never its value.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string[]} execArgv
 */
export function assertNoEnvProxy(env, execArgv) {
  const tripped = PROXY_TRIPWIRES.find((tripwire) => tripwire.active(env, execArgv));
  if (tripped) {
    throw new Error(`${tripped.label}; refusing to run with an env-configured proxy in play.`);
  }
}
