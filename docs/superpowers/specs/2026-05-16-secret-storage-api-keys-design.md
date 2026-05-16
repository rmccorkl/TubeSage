# API Keys via Obsidian Secret Storage — Design

**Date:** 2026-05-16
**Status:** Approved (Option A — pure secret storage)

## Goal

Move TubeSage's cloud-provider API keys out of the plugin's `data.json` and into
Obsidian's native `app.secretStorage`. This removes plaintext API keys from a
file that syncs via iCloud, and offloads the responsibility of securing secrets
from TubeSage to Obsidian itself.

## Background

Today, all provider credentials live in `settings.apiKeys: Record<string, string>`,
persisted to `.obsidian/plugins/tubesage/data.json`. That file is inside the vault,
so it syncs (iCloud Drive / Obsidian Sync) as plaintext.

Obsidian 1.11.4 introduced `app.secretStorage`:

- `setSecret(id: string, secret: string): void` — synchronous
- `getSecret(id: string): string | null` — synchronous
- `listSecrets(): string[]`
- No delete method.
- Secrets are stored in Obsidian's application **localStorage**, keyed to the vault.
  This is **device-local and per-vault** — it does NOT sync between devices, and it
  is NOT the OS keychain.

## Decisions (from brainstorming)

- **Option A — pure secret storage.** No hybrid/fallback. `minAppVersion` is raised
  to `1.11.4`; users on older Obsidian are not supported.
- **Keys do not sync.** Accepted: the user re-enters each provider key once per
  vault/device. The security gain (keys out of synced plaintext) is the point.
- **Ollama is excluded.** `apiKeys['ollama']` holds the Ollama *server URL*
  (`http://localhost:11434`), not a secret. It stays in plugin settings.

## Scope

In scope — move to secret storage: **OpenAI, Anthropic, Google, OpenRouter** keys.
Out of scope: Ollama (URL, not a secret); the YouTube Data API key is not part of
`settings.apiKeys` and is unchanged by this work.

## Design

### 1. Secret IDs

Fixed, deterministic, one per cloud provider. IDs are lowercase alphanumeric with
dashes (required by `setSecret`):

| Provider   | Secret ID                  |
|------------|----------------------------|
| openai     | `tubesage-openai-key`      |
| anthropic  | `tubesage-anthropic-key`   |
| google     | `tubesage-google-key`      |
| openrouter | `tubesage-openrouter-key`  |

A single source-of-truth map (e.g. `SECRET_IDS: Record<CloudProvider, string>`)
defines these. No secret IDs are stored in `data.json` — they are derived from the
provider name.

### 2. Settings model change

- `settings.apiKeys: Record<string, string>` is **removed**.
- The Ollama URL becomes its own field: `settings.ollamaUrl: string`
  (default `'http://localhost:11434'`). This is clearer than an "apiKey" that is
  really a URL.
- `DEFAULT_SETTINGS` updated accordingly.

### 3. Access layer

Add two methods on the plugin class:

- `getApiKey(provider: string): string`
  - cloud provider → `this.app.secretStorage.getSecret(SECRET_IDS[provider]) ?? ''`
  - `ollama` → `this.settings.ollamaUrl`
- `setApiKey(provider: string, value: string): void`
  - cloud provider → `this.app.secretStorage.setSecret(SECRET_IDS[provider], value)`
  - `ollama` → assign `this.settings.ollamaUrl` and `saveSettings()`

Because the secret-storage API is synchronous, every existing site that reads
`this.settings.apiKeys[provider]` (~25 in `main.ts`, plus `transcript-summarizer.ts`
and `llm-factory.ts`) becomes `this.getApiKey(provider)` with **no async refactor**.

### 4. Keeping the change localized

`transcript-summarizer.ts` and `llm-factory.ts` currently receive an
`apiKeys: Record<string, string>` object built in `main.ts`. They continue to do so —
`main.ts` builds that object by calling `getApiKey()` for each provider before
constructing the summarizer/factory. Those two files never call `secretStorage`
directly, so the change is concentrated in `main.ts`.

### 5. Settings UI

The 4 cloud-provider key fields keep their current plain text-input UX (the existing
`.addText()` controls). They are NOT converted to Obsidian's `SecretComponent` — that
component is designed for selecting/sharing named secrets across plugins, which is
heavier than TubeSage needs.

- On render: `setValue(getApiKey(provider))`
- On change: `setApiKey(provider, value)` (writes straight to secret storage)
- No key value is ever written to `settings`/`data.json`.

The Ollama field continues to read/write `settings.ollamaUrl` as a normal setting.

### 6. Migration

One-time, in `onload()` after settings are loaded. For each cloud provider:

```
if data.json still has a non-empty apiKeys[provider]
   and secretStorage.getSecret(SECRET_IDS[provider]) is null/empty:
       secretStorage.setSecret(SECRET_IDS[provider], oldKey)
delete the cloud-provider entries from the loaded settings object
persist settings (saveSettings) so data.json no longer contains the keys
```

This copies any pre-existing keys into secret storage and scrubs them from the
plaintext `data.json`. It is idempotent — on later loads there is nothing to migrate.
The Ollama value is migrated from `apiKeys['ollama']` into `settings.ollamaUrl` in the
same pass.

### 7. Version bumps

- `manifest.json`: `minAppVersion` `1.2.0` → `1.11.4`
- `package.json`: obsidian devDependency `^1.8.7` → `^1.11.4`
  (the installed types are already 1.12.3 and contain `SecretStorage` / `secretStorage`,
  so no behavioral install change — this just makes the floor explicit)

## Error handling / edge cases

- `getSecret` returns `null` when a key was never set → `getApiKey` returns `''`,
  treated everywhere as "no key configured" (same as today's empty string).
- No delete API — "clearing" a key is `setSecret(id, '')`. An empty string is the
  canonical "unset" value.
- If `app.secretStorage` is somehow unavailable at runtime (should not happen given
  `minAppVersion` 1.11.4), `getApiKey` returns `''` rather than throwing.
- Mobile: `secretStorage` is part of the 1.11.4 API on all platforms; localStorage
  exists in the mobile webview. No platform branching needed.

## Testing

No automated test harness exists in the project. Verification is build + manual:

1. `npm run build` succeeds (TypeScript + esbuild).
2. Fresh install: enter an OpenAI key in settings → confirm it appears via
   `secretStorage` and is absent from `data.json`.
3. Restart Obsidian → the key still resolves (persisted).
4. Run a summary with that provider → authentication succeeds.
5. Upgrade path: start from a `data.json` containing `apiKeys` with a key →
   after load, the key is in secret storage and gone from `data.json`; Ollama URL
   moved to `settings.ollamaUrl`.

## Out of scope / non-goals

- No hybrid/fallback for Obsidian < 1.11.4.
- No change to the Ollama URL handling beyond the field rename.
- No `SecretComponent` UI.
- No change to the YouTube Data API key.
