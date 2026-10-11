// Key handling, --env-file loading and the env-proxy tripwire. Nothing here
// ever prints an environment variable or discloses any part of a value: only
// variable NAMES and the env-file PATH ever appear in a message.
import { readFileSync } from "node:fs";
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
export function loadEnvFile(path, readFile = readFileSync) {
  let text;
  try {
    text = readFile(path, "utf8");
  } catch (err) {
    return { ok: false, message: `--env-file: cannot read ${path} (${err?.code ?? "read error"}). Check the path exists and is readable.` };
  }
  return { ok: true, vars: parseEnvFile(text) };
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
