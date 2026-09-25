// Exact values pinned by the SDD brief for this rig. Do not "clean up" or
// derive these from each other (e.g. ENDPOINT from HOST + PATH) — they are
// copied verbatim from global-constraints.md so a diff against that file is
// trivial.
export const ENDPOINT_HOST = "openrouter.ai";
export const ENDPOINT_PATH = "/api/alpha/decisions";
export const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const MODEL_PIN = "typesafe/jev-1.13-20260917";
export const KEY_ENV = "OPENROUTER_API_KEY_JEV";
export const RATE_USD_PER_M_INPUT = 0.042;
export const RECORDED_USD_PER_REQUEST = 0.00002;
export const MAX_BODY_BYTES = 262144;
export const DEFAULT_TIMEOUT_MS = 30000;
export const USER_AGENT = "tubesage-jev-rig/0.1";
