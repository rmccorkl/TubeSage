// Key handling and env-proxy tripwire. Nothing here ever reads 1Password,
// prints an environment variable, or discloses any part of a key's value.
import { KEY_ENV } from "./constants.mjs";

/**
 * Reads the OpenRouter key from the given env object. Never logs, echoes, or
 * discloses any prefix/length of the value it finds.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, key: string } | { ok: false, message: string }}
 */
export function readKey(env) {
  const key = env?.[KEY_ENV];
  if (!key) {
    return {
      ok: false,
      message: [
        `${KEY_ENV} is not set.`,
        "Export it from 1Password before running this rig, e.g.:",
        `  export ${KEY_ENV}="$(op read 'op://<vault>/<item>/<field>')"`,
        "This rig never reads 1Password itself.",
      ].join("\n"),
    };
  }
  return { ok: true, key };
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
