# Secret Storage for API Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move TubeSage's OpenAI/Anthropic/Google/OpenRouter API keys out of the plaintext `data.json` into Obsidian's `app.secretStorage`, with a one-time migration that scrubs existing keys.

**Architecture:** `settings.apiKeys` stays as a runtime object but its 4 cloud-provider entries are never persisted — they are populated from `secretStorage` on load and stripped before every save. Existing read sites are untouched; only load, save, and the API-key settings UI change. Spec: `docs/superpowers/specs/2026-05-16-secret-storage-api-keys-design.md`.

**Tech Stack:** TypeScript, esbuild, Obsidian plugin API (`app.secretStorage`, `@since 1.11.4`).

**Note on testing:** The project has no automated test harness (`npm test` is not defined). Verification for every task is `npm run build` (runs `tsc -noEmit -skipLibCheck` + esbuild) plus the manual checks in Task 6.

---

## File structure

| File | Change |
|---|---|
| `main.ts` | Add module constants; add `persist()` helper; route saves through it; extend `loadSettings()` with migration + population; update `createProviderApiKeyRow` onChange |
| `manifest.json` | `minAppVersion` `1.2.0` → `1.11.4` |
| `package.json` | obsidian devDependency `^1.8.7` → `^1.11.4` |

No new files. `transcript-summarizer.ts` and `llm-factory.ts` are not touched.

---

## Task 1: Add module constants for cloud providers and secret IDs

**Files:**
- Modify: `main.ts` (immediately after the `DEFAULT_SETTINGS` object, which ends near line 460)

- [ ] **Step 1: Add the constants**

After the `DEFAULT_SETTINGS` declaration (find the line `};` that closes `const DEFAULT_SETTINGS`), add:

```typescript
// Cloud LLM providers whose API keys are secrets stored in Obsidian's
// secret storage. 'ollama' is intentionally excluded — its apiKeys entry
// is a server URL, not a secret, and stays in data.json.
const CLOUD_PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter'] as const;

// Secret-storage IDs, one per cloud provider. IDs must be lowercase
// alphanumeric with optional dashes (required by SecretStorage.setSecret).
const SECRET_IDS: Record<string, string> = {
    openai: 'tubesage-openai-key',
    anthropic: 'tubesage-anthropic-key',
    google: 'tubesage-google-key',
    openrouter: 'tubesage-openrouter-key',
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds (the constants are unused so far — that is fine; `tsc` does not error on unused module-level `const`).

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "feat: add cloud-provider and secret-id constants"
```

## Task 2: Add a `persist()` helper that strips cloud keys before saving

The plugin currently writes settings via `this.saveData(this.settings)` in two places — `saveSettings()` and the `customModelLimits` migration inside `loadSettings()`. Both must go through a helper that removes the 4 cloud keys so `data.json` never contains them.

**Files:**
- Modify: `main.ts` — `saveSettings()` (near line 676) and the `customModelLimits` migration save (near line 672)

- [ ] **Step 1: Add the `persist()` method**

Directly above the existing `async saveSettings()` method, add:

```typescript
    /**
     * Persist settings to data.json with cloud-provider API keys stripped out.
     * Cloud keys live in Obsidian secret storage, never in data.json.
     */
    private async persist(): Promise<void> {
        const sanitizedApiKeys: Record<string, string> = {
            ollama: this.settings.apiKeys.ollama ?? DEFAULT_SETTINGS.apiKeys.ollama,
        };
        const toSave = { ...this.settings, apiKeys: sanitizedApiKeys };
        await this.saveData(toSave);
    }
```

- [ ] **Step 2: Route `saveSettings()` through `persist()`**

Replace the body of `saveSettings()`:

```typescript
    async saveSettings() {
        await this.saveData(this.settings);
        this.initializeSummarizer();
    }
```

with:

```typescript
    async saveSettings() {
        await this.persist();
        this.initializeSummarizer();
    }
```

- [ ] **Step 3: Route the `customModelLimits` migration save through `persist()`**

Inside `loadSettings()`, in the `customModelLimits` cleanup block, find:

```typescript
            await this.saveData(this.settings);
```

(it is the line right after the `for (const key of polluted)` delete loop). Replace it with:

```typescript
            await this.persist();
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add main.ts
git commit -m "feat: strip cloud API keys from persisted settings via persist() helper"
```

## Task 3: Migrate and populate cloud keys in `loadSettings()`

On load: migrate any cloud keys still in `data.json` into secret storage, then populate the runtime `settings.apiKeys` cloud entries from secret storage. If `data.json` contained any cloud keys, persist once to scrub them.

**Files:**
- Modify: `main.ts` — `loadSettings()`, after the `customModelLimits` migration block, before the method's closing brace

- [ ] **Step 1: Add the migration + population block**

In `loadSettings()`, after the entire `customModelLimits` cleanup `if (polluted.length > 0) { ... }` block and before the closing `}` of `loadSettings()`, add:

```typescript
        // --- API key secret-storage migration ---------------------------------
        // Cloud-provider keys live in Obsidian secret storage, not data.json.
        // 1. Migrate any key still present in data.json into secret storage.
        // 2. Populate the runtime settings.apiKeys cloud entries from storage.
        // 3. If data.json held any cloud key, persist once to scrub it out.
        const dataApiKeys: Record<string, string> =
            isRecord(loadedSettings.apiKeys) ? (loadedSettings.apiKeys as Record<string, string>) : {};
        let hadCloudKeysInData = false;
        for (const provider of CLOUD_PROVIDERS) {
            const fromData = dataApiKeys[provider];
            if (typeof fromData === 'string' && fromData.trim() !== '') {
                hadCloudKeysInData = true;
                if (!this.app.secretStorage.getSecret(SECRET_IDS[provider])) {
                    this.app.secretStorage.setSecret(SECRET_IDS[provider], fromData);
                }
            }
        }
        for (const provider of CLOUD_PROVIDERS) {
            this.settings.apiKeys[provider] =
                this.app.secretStorage.getSecret(SECRET_IDS[provider]) ?? '';
        }
        if (hadCloudKeysInData) {
            logger.info('[migration] Moved cloud API keys to secret storage; scrubbing data.json');
            await this.persist();
        }
        // ----------------------------------------------------------------------
```

Note: `isRecord` and `logger` are already defined/imported in `main.ts` (used elsewhere in `loadSettings()`).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "feat: migrate and load cloud API keys from secret storage"
```

## Task 4: Write cloud keys to secret storage from the settings UI

The API-key text field's `onChange` currently writes only to `settings.apiKeys[provider]`. For cloud providers it must also write secret storage. The field's description text is updated to be accurate.

**Files:**
- Modify: `main.ts` — `createProviderApiKeyRow` (near lines 4283-4309)

- [ ] **Step 1: Update the description text**

In `createProviderApiKeyRow`, replace:

```typescript
                .setDesc('Stored in plugin data; available to all summarisation flows.')
```

with:

```typescript
                .setDesc(
                    provider === 'ollama'
                        ? 'Server URL, stored in plugin data.'
                        : 'Stored in Obsidian secret storage, not in plugin data.'
                )
```

- [ ] **Step 2: Update the `onChange` handler**

Replace:

```typescript
                        .onChange((value: string) => {
                            void (async () => {
                                this.plugin.settings.apiKeys[provider] = value;
                                await this.plugin.saveSettings();
                            })();
                        });
```

with:

```typescript
                        .onChange((value: string) => {
                            void (async () => {
                                this.plugin.settings.apiKeys[provider] = value;
                                if (CLOUD_PROVIDERS.includes(provider as typeof CLOUD_PROVIDERS[number])) {
                                    this.plugin.app.secretStorage.setSecret(SECRET_IDS[provider], value);
                                }
                                await this.plugin.saveSettings();
                            })();
                        });
```

The `setValue(this.plugin.settings.apiKeys[provider])` call above it is unchanged — the in-memory value was populated from secret storage in `loadSettings()`.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add main.ts
git commit -m "feat: write cloud API keys to secret storage from settings UI"
```

## Task 5: Bump `minAppVersion` and the obsidian devDependency

`app.secretStorage` is `@since 1.11.4`, so the plugin can no longer support older Obsidian.

**Files:**
- Modify: `manifest.json`, `package.json`

- [ ] **Step 1: Bump `manifest.json`**

Change `"minAppVersion": "1.2.0"` to `"minAppVersion": "1.11.4"`.

- [ ] **Step 2: Bump `package.json`**

In `devDependencies`, change `"obsidian": "^1.8.7"` to `"obsidian": "^1.11.4"`.

- [ ] **Step 3: Verify build**

Run: `npm install && npm run build`
Expected: `npm install` updates the lockfile if needed; build succeeds (the installed obsidian types are already 1.12.3, which contains `SecretStorage`).

- [ ] **Step 4: Commit**

```bash
git add manifest.json package.json package-lock.json
git commit -m "chore: require Obsidian 1.11.4 for secret storage API"
```

## Task 6: Manual verification

No code changes — this is the acceptance check. Build, deploy to a test vault, and confirm behavior.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 2: Fresh-key check**

Load the plugin in an Obsidian 1.11.4+ vault. In settings, enter an OpenAI API key. Confirm:
- `data.json` (`.obsidian/plugins/tubesage/data.json`) does NOT contain the key — its `apiKeys` object should hold only `ollama`.
- The key resolves after an Obsidian restart (still shown in settings, summaries still authenticate).

- [ ] **Step 3: Migration check**

Start from a `data.json` whose `apiKeys` contains a non-empty `openai` key (simulating an upgrade). Load the plugin. Confirm:
- After load, `data.json`'s `apiKeys` no longer contains the `openai` key (only `ollama` remains).
- The key still works (settings shows it; a summary authenticates).

- [ ] **Step 4: Ollama untouched**

Confirm the Ollama server URL still saves to and loads from `data.json` as before.

- [ ] **Step 5: Run a summary** with a cloud provider to confirm end-to-end auth works.

---

## Self-review

- **Spec coverage:** Secret IDs → Task 1. Runtime `apiKeys` + load/save behavior → Tasks 2, 3. Migration → Task 3. Settings UI → Task 4. Version bumps → Task 5. Edge cases (`getSecret` null → `''`) → handled by `?? ''` in Task 3 and the in-memory value in Task 4. All spec sections covered.
- **Placeholder scan:** none — every step has concrete code and exact commands.
- **Type consistency:** `CLOUD_PROVIDERS` and `SECRET_IDS` (Task 1) are referenced consistently in Tasks 3 and 4. `persist()` (Task 2) is called in Tasks 2 and 3. `SECRET_IDS` is typed `Record<string, string>` so `SECRET_IDS[provider]` indexing in Tasks 3-4 type-checks.
