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

# 2a. Live liveness check (one billable request, ~$0.00002), with the
#     standard variable already in your shell:
node rig/jev-timestamps/cli.mjs stage0 --yes

# 2b. Or, with no setup at all, point at a .env that already holds the key:
node rig/jev-timestamps/cli.mjs stage0 --yes --env-file /path/to/project/.env
```

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
| 1 contract | **not built** | `stage1` currently prints "not built yet" and exits 1. Planned: check a real response against the wire format in issue #12 (model equals the pin, answer keys, criteria keys, probabilities summing to 1 ± 0.01, confidence in [0,1], `usage.cost`), measure cold and warm latency over a few requests, and probe once whether `questions` accepts more than one entry. |
| 2–5 | **not built** | Concurrency ceiling, comparator stability, ground truth, scoring arms A–D, adversarial. Not started, pending stage 0/1 results. |

## Billing safety

- Every stage prints the request count and estimated cost **before** anything
  is spent. Two figures: tokens × $0.042/M, and requests × $0.00002 (the
  recorded average).
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
