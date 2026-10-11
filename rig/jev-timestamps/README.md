# Jev timestamp rig

Standalone feasibility rig for GitHub issue #12: can TubeSage's second
generative timestamp pass be replaced by typed classification (Jev,
`typesafe/jev-1.13-20260917`, `POST https://openrouter.ai/api/alpha/decisions`)?

Plain Node 22, no dependencies, no Obsidian. It never ships:
`scripts/rig-guard.mjs` fails the esbuild build if any `rig/` file is loaded,
and `scripts/rig-containment.test.mjs` checks that on every `npm test`.

## Run it (maintainer)

Use the OpenRouter key you already have. You don't need a new key, and you
don't need 1Password.

```sh
# 1. Preview. No key needed, no network call.
node rig/jev-timestamps/cli.mjs stage0 --dry-run

# 2a. Live run, with the standard variable already in your shell:
node rig/jev-timestamps/cli.mjs stage0 --yes     # 1 request,      ~$0.000016
node rig/jev-timestamps/cli.mjs stage1 --yes     # up to 5 (cap 10), ~$0.00025
node rig/jev-timestamps/cli.mjs stage2 --yes     # up to 60,       ~$0.001-0.002

# 2b. Or, with no setup at all, point at a .env that already holds the key:
node rig/jev-timestamps/cli.mjs stage1 --yes --env-file /path/to/project/.env
```

Every dry run and every refusal ends with the exact `--yes` command to run.

Run from the repo root. Optional flag: `--timeout-ms N` (default 30000,
a total wall-clock deadline).

### Where the key comes from

The rig uses the first of these names that is set:

1. `OPENROUTER_API_KEY_JEV` (still accepted, so existing setups keep working)
2. `OPENROUTER_API_KEY` (the standard name; the normal path)

It never falls back to another provider's key, such as `OPENAI_API_KEY`.

`--env-file PATH` reads simple `KEY=VALUE` lines from an existing file. It
skips blank lines and `#` comments and strips surrounding quotes. Other lines
are ignored; `export KEY=...` lines are not read. For each name above, the
real environment wins: a value in the file never overrides a variable
already set in your shell. A missing or unreadable file fails with an error
naming the path.

Node 22 quirk (observed on v22.22.3): Node checks an `--env-file` argument
itself, even when it comes after the script path. A missing or unreadable
path stops it before the rig starts: `node: <path>: not found` (or
`invalid format` for a directory), exit 9. That message also names only the
path. A readable file is passed through untouched; Node does not load it.
The rig parses it as described above.

The rig only ever prints variable **names** and the file path: never a
value, never a prefix of one, in errors or in saved runs. On success it
prints `using key from <NAME> (environment | --env-file PATH)`.

## Stages

| stage | status | what it does |
|---|---|---|
| 0 liveness | **built** | One request with a 3-way `choice` question (`pertains` / `does_not_pertain` / `insufficient_evidence`). Prints the status, a classified kind, timings (connect, TLS, TTFB, total), response size, the body's *shape* (no upstream text), the returned `model` and whether it equals the pin, and `usage.cost`. It ends with a verdict: `LIVE`, `LIVE-PIN-CHANGED`, `MODEL-GONE`, `AUTH`, `CREDITS`, `ENV-BLOCKED` (DNS/TLS/refused/blocked: your network, not OpenRouter) or `OTHER`. Exits 0 only on `LIVE`. |
| 1 contract | **built** | Two single-question requests (cold, then warm), then the **multi-question probe**: the same shared `state` with N = 2, 5, then 20 entries in the `questions` map, stopping at the first N that fails (at most 5 requests; cap 10). Each response is checked against the contract observed live in stage 0: model equals the pin, answer keys equal the question ids, criteria keys exactly as sent, probabilities in [0,1] summing to 1 ± 0.01, choice among the criteria, confidence in [0,1], `usage.cost` present. Unknown top-level keys (`id`, `provider`) are tolerated and listed. For each request it prints connect / TLS / TTFB / total, socketReused, size, cost, and how many answers matched the fixture's expected choice. Verdicts: `Contract: OK / DIFFERS` and `MULTI-QUESTION: SUPPORTED up to N=… / accepted up to N=…; failed at N=…`. Exits 0 when the single-question contract holds. |
| 2 keep-alive + concurrency | **built** | **A.** 6 sequential requests on one keep-alive agent, with socketReused and timings for each, then `KEEP-ALIVE: REUSED / PARTIAL / NOT REUSED`. **B.** Concurrency 1 (4 sequential requests), 5, 10, 25 (one wave each): median and p95 total, reused sockets, 429s. **C.** A 429 is retried with backoff (Retry-After, else 1 s then 2 s; at most 3 attempts). A request still rate-limited after that stops the climb; `SAFE CONCURRENCY CEILING` is the highest level where every request succeeded. A hard budget of 60 requests covers every attempt. |
| 3–5 | **not built** | Ground truth, scoring arms A–D, adversarial. Out of scope for now. |

The stage 1 and 2 fixture (`lib/cells.mjs`) is 20 synthetic segments across 5
note sections, each question with an obvious expected answer. It checks that
answers are sane, and catches a reply that gives every question the same
answer. It is **not** ground truth for real notes.

## Billing safety

- Every stage prints the request count (an upper bound when it can stop
  early) and estimated cost **before** anything is spent. Two figures:
  tokens × $0.042/M, and requests × $0.000016044. Both come from stage 0's
  live request, which billed 382 input tokens × $0.042/M; output tokens were
  not billed. Each request's token estimate adds the ~269 tokens the endpoint
  added on top of that request's own text. That is one observation, and it
  may grow with the number of questions.
- With no flag it refuses (exit 2). `--dry-run` records and prints the planned
  requests with no network call and no key (exit 0). `--yes` is required to
  spend. Passing both flags is an error.
- Every request and response is saved under `rig/jev-timestamps/runs/<UTC
  stamp>-<stage>/` (gitignored), so a run can be re-analysed without spending
  again. The Authorization header is stored as `Bearer [REDACTED]`, the key is
  scrubbed from every written byte, `set-cookie` is dropped, and other response
  headers are redacted except content-type/length, date, retry-after and
  `x-ratelimit-*`.

## Client defences (from hermes-carapace's judge adapter)

- Plain `node:https` with its own Agent. It never follows redirects (a 3xx
  is reported as `redirect-refused`).
- It refuses to run if Node's env-proxy is enabled (`NODE_USE_ENV_PROXY`,
  `--use-env-proxy`, or the same flag in `NODE_OPTIONS`).
- The response body is capped at 256 KiB. Upstream error text never reaches the
  console: only kind, HTTP status and Node error code are shown.

## Evidence so far (unbilled)

2026-09-25, from the dev machine, POSTing `{}` with **no** credentials:

- `POST https://openrouter.ai/api/alpha/decisions` → **401**
  `{"error":{"message":"No cookie auth credentials found","code":401}}`
- `POST https://openrouter.ai/api/alpha/zz-no-such-route-rig-check` → **404**
  `{"error":{"message":"Not Found","code":404}}`

So the `/api/alpha/decisions` route still resolves; an unknown alpha route
gives 404. This does **not** show the dated pin still serves. Only an
authenticated stage 0 can.
