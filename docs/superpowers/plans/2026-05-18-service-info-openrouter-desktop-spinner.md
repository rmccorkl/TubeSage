# Service Info Icons, OpenRouter Refresh, Desktop Spinner Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add service-URL info icons to three settings, add an OpenRouter model-list refresh, and stop the desktop processing spinner from leaving a blank popup.

**Architecture:** Three independent tasks in `main.ts`. Task 1 attaches `createInfoIcon` to the ScrapeCreators/Supadata/OpenRouter settings. Task 2 adds a `fetchOpenRouterModels` method modelled on `fetchGoogleModels`, wires it into the refresh button, and vendor-groups the OpenRouter model dropdown. Task 3 makes the processing modal mobile-only so desktop shows just the status-bar spinner.

**Tech Stack:** TypeScript, Obsidian Plugin API, esbuild, `obsidianFetch` shim. Verification is `npm run build` and `npm run lint`; there is no unit-test framework, so build, lint, and `grep` are the tests.

**Design reference:** `docs/superpowers/specs/2026-05-18-service-info-openrouter-desktop-spinner-design.md`

---

### Task 1: Service-URL info icons

**Files:**
- Modify: `main.ts` — the ScrapeCreators setting (~3975), the Supadata setting (~4003), and `createProviderApiKeyRow`

The plugin's `createInfoIcon(container, tooltipText)` method (in `YouTubeTranscriptSettingTab`) creates an ⓘ icon whose hover tooltip is `tooltipText`. The three settings-section headings already use it. Attach it to three more settings, tooltip = the service URL.

- [ ] **Step 1: ScrapeCreators and Supadata info icons**

The ScrapeCreators API-key setting is built as `new Setting(settingsContainer).setName('Scrape creators API key')...` (~`main.ts:3975`); the Supadata one as `new Setting(settingsContainer).setName('Supa data API key')...` (~4003). Each is currently a bare `new Setting(...)` expression not assigned to a variable.

For each, assign it to a `const` and after the chain attach the info icon by querying its name element — the same way the heading info icons do it:

```ts
const scSetting = new Setting(settingsContainer)
    .setName('Scrape creators API key')
    .setDesc(/* unchanged */)
    .addText(/* unchanged */);
const scNameEl = scSetting.settingEl.querySelector('.setting-item-name');
if (scNameEl && scNameEl.instanceOf(HTMLElement)) {
    this.createInfoIcon(scNameEl, 'https://scrapecreators.com/');
}
```

Do the same for the Supadata setting with `'https://supadata.ai/'`. Leave the `.setName`/`.setDesc`/`.addText` content of both settings exactly as is.

- [ ] **Step 2: OpenRouter info icon**

The OpenRouter API-key row is produced by the helper `createProviderApiKeyRow(provider, displayName, placeholder)` (in `YouTubeTranscriptSettingTab`), which builds a `new Setting(...)` for every provider. Read that helper. After it builds its `Setting`, add a provider-gated info icon: when `provider === 'openrouter'`, query the setting's `.setting-item-name` element and call `this.createInfoIcon(nameEl, 'https://openrouter.ai/')`. Guard the element with `instanceOf(HTMLElement)`, exactly as in Step 1. Only `openrouter` gets the icon; the other providers' rows are unchanged.

- [ ] **Step 3: Build and lint**

Run: `npm run build` — no TypeScript errors.
Run: `npm run lint` — 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add main.ts
git commit -m "feat(settings): add service-URL info icons for ScrapeCreators, Supadata, OpenRouter"
```

---

### Task 2: OpenRouter model refresh

**Files:**
- Modify: `main.ts` — add `fetchOpenRouterModels` near `fetchGoogleModels` (~2581); the refresh button in `createProviderConfigBlock` (~4264-4323); the model dropdown population in `createProviderConfigBlock` (~4207-4212)

- [ ] **Step 1: Add the `fetchOpenRouterModels` method**

Add this method to the `YouTubeTranscriptPlugin` class, next to `fetchGoogleModels` / `fetchAnthropicModels`. It mirrors `fetchGoogleModels` but hits OpenRouter's public models endpoint (no API key) and parses OpenRouter's response shape:

```ts
async fetchOpenRouterModels(): Promise<FetchedModelInfo[]> {
    const url = 'https://openrouter.ai/api/v1/models';
    try {
        this.showNotice("Fetching OpenRouter models...", 3000);
        const response = await obsidianFetch(url, { method: 'GET' });

        if (!response.ok) {
            const errorMessage = `HTTP error ${response.status}`;
            logger.error(`[fetchOpenRouterModels] Failed to fetch OpenRouter models: ${errorMessage}`);
            this.showNotice(`Failed to fetch OpenRouter models: ${errorMessage}`, 5000);
            return [];
        }

        const data = await response.json() as {
            data?: Array<{
                id?: string;
                context_length?: number;
                top_provider?: { max_completion_tokens?: number | null };
            }>;
        };

        if (data && Array.isArray(data.data)) {
            const models: FetchedModelInfo[] = data.data
                .filter((m) => typeof m.id === 'string' && m.id.length > 0)
                .map((m) => {
                    const id = m.id as string;
                    const contextK = m.context_length ? Math.round(m.context_length / 1000) : undefined;
                    const maxOut = m.top_provider?.max_completion_tokens;
                    const maxOutputK = maxOut ? Math.round(maxOut / 1000) : undefined;
                    return { id, contextK, maxOutputK };
                })
                .sort((a, b) => a.id.localeCompare(b.id));

            let updatedCount = 0;
            for (const m of models) {
                if (m.contextK && m.maxOutputK) {
                    this.settings.customModelLimits[`openrouter:${m.id}`] = {
                        contextK: m.contextK,
                        maxOutputK: m.maxOutputK,
                        reservePct: 0.10,
                    };
                    updatedCount++;
                }
            }
            if (updatedCount > 0) {
                logger.info(`[fetchOpenRouterModels] Stored token limits for ${updatedCount} OpenRouter models.`);
            }

            this.settings.fetchedModels = {
                ...this.settings.fetchedModels,
                openrouter: models.map((m) => m.id),
            };
            await this.saveSettings();

            logger.info(`[fetchOpenRouterModels] Successfully fetched ${models.length} OpenRouter models.`);
            this.showNotice("OpenRouter models updated!", 3000);
            return models;
        } else {
            logger.warn("[fetchOpenRouterModels] Unexpected response structure from OpenRouter API.");
            this.showNotice("Could not parse OpenRouter models from API response.", 5000);
            return [];
        }
    } catch (error) {
        const errorMessage = getSafeErrorMessage(error);
        logger.error("[fetchOpenRouterModels] Error fetching or parsing OpenRouter models:", errorMessage);
        this.showNotice(`Error fetching OpenRouter models: ${errorMessage}`, 5000);
        return [];
    }
}
```

Confirm `FetchedModelInfo`, `customModelLimits`, `fetchedModels`, `obsidianFetch`, `getSafeErrorMessage`, and `logger` are the same symbols `fetchGoogleModels` uses (they are — keep the call identical in shape). On a failure path the existing `fetchedModels.openrouter` is left untouched (the method returns `[]` without writing).

- [ ] **Step 2: Wire the refresh button for OpenRouter**

In `createProviderConfigBlock` (~`main.ts:4264`), the refresh `ExtraButton` is added only `if (provider === 'openai' || provider === 'google' || provider === 'anthropic')`. Add `|| provider === 'openrouter'` to that condition.

Inside the button's `onClick`, the current code early-returns when the API key is missing:

```ts
const apiKey = this.plugin.settings.apiKeys[provider];
if (!apiKey || apiKey.trim() === '') {
    this.plugin.showNotice(`${displayName} API key is required to refresh models.`, 5000);
    return;
}
```

Change the guard so it does NOT apply to OpenRouter (its endpoint is public):

```ts
const apiKey = this.plugin.settings.apiKeys[provider];
if (provider !== 'openrouter' && (!apiKey || apiKey.trim() === '')) {
    this.plugin.showNotice(`${displayName} API key is required to refresh models.`, 5000);
    return;
}
```

In the provider `if/else if` chain that picks the fetcher, add an OpenRouter branch (it takes no argument):

```ts
} else if (provider === 'openrouter') {
    fetchedModels = await this.plugin.fetchOpenRouterModels();
}
```

The rest of the `onClick` (selected-model fallback, `getEffectiveMaxTokens`, `saveSettings`, `this.display()`) already works generically and needs no change.

- [ ] **Step 3: Vendor-group the OpenRouter model dropdown**

In `createProviderConfigBlock`, the model dropdown is populated (~`main.ts:4207-4212`) with a flat loop:

```ts
mergedOptions.forEach((model) => {
    dropdown.addOption(model, model);
});
dropdown.addOption('custom', 'Use custom model');
```

`mergedOptions` is already deduplicated and sorted. For OpenRouter the list is 300+ entries with `vendor/model` ids, so render it grouped by vendor. Replace the population so that, when `provider === 'openrouter'`, options are added under `<optgroup>` headers instead of flat:

```ts
if (provider === 'openrouter') {
    // Group by vendor (segment before the first '/'); mergedOptions is sorted,
    // so vendors are already contiguous.
    let currentVendor = '';
    let group: HTMLOptGroupElement | null = null;
    for (const model of mergedOptions) {
        const vendor = model.includes('/') ? model.slice(0, model.indexOf('/')) : 'other';
        if (vendor !== currentVendor) {
            currentVendor = vendor;
            group = dropdown.selectEl.createEl('optgroup', { attr: { label: vendor } });
        }
        (group ?? dropdown.selectEl).createEl('option', { value: model, text: model });
    }
} else {
    mergedOptions.forEach((model) => {
        dropdown.addOption(model, model);
    });
}
dropdown.addOption('custom', 'Use custom model');
```

`DropdownComponent.addOption` is flat, so the `<optgroup>`/`<option>` elements are created directly on `dropdown.selectEl` for the OpenRouter case. The non-OpenRouter branch is unchanged. The `dropdown.setValue(...)` / `onChange` wiring below this block is unchanged and still works (it operates on the `<select>` value).

- [ ] **Step 4: Build, lint, verify**

Run: `npm run build` — no TypeScript errors.
Run: `npm run lint` — 0 errors, 0 warnings.
Confirm `grep -n "fetchOpenRouterModels" main.ts` shows the method definition and the one call site in the refresh button.

- [ ] **Step 5: Commit**

```bash
git add main.ts
git commit -m "feat(llm): add OpenRouter model-list refresh with vendor-grouped dropdown"
```

---

### Task 3: Desktop processing spinner — no blank popup

**Files:**
- Modify: `main.ts` — `beginCollectionProcessing` (~3120-3140) and the single-video processing method (~3443-3460)

Both methods currently keep the create-note modal open and reuse it as a processing popup. On desktop the spinner renders to the status bar, so the modal is left blank.

- [ ] **Step 1: Make the processing modal mobile-only in `beginCollectionProcessing`**

In `beginCollectionProcessing` (~`main.ts:3120`), the current block is:

```ts
            // Show processing UI
            const { contentEl } = this;
            contentEl.empty();
            
            // Adjust modal size to fit the animation using a CSS class
            const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
            if (modalEl && modalEl.instanceOf(HTMLElement)) {
                modalEl.addClass('tubesage-processing-modal');
            }
            
            // Braille-dots processing spinner (status bar on desktop, in-modal on mobile)
            spinner = new ProcessingSpinner(this.plugin, 'Processing collection', contentEl);
            spinner.start();
```

Replace it with:

```ts
            // Processing UI. On mobile the modal stays open and hosts the
            // spinner; on desktop the status bar is the spinner surface, so the
            // modal is closed — no blank popup. ProcessingSpinner routes itself
            // (status bar on desktop, in-modal on mobile).
            const { contentEl } = this;
            if (Platform.isMobile) {
                contentEl.empty();
                const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
                if (modalEl && modalEl.instanceOf(HTMLElement)) {
                    modalEl.addClass('tubesage-processing-modal');
                }
            } else {
                this.close();
            }

            spinner = new ProcessingSpinner(this.plugin, 'Processing collection', contentEl);
            spinner.start();
```

`Platform` is already imported. Closing the modal on desktop is safe: `YouTubeTranscriptModal.onClose()` only calls `contentEl.empty()` and does not touch `isProcessing` or abort the async run.

- [ ] **Step 2: Same change in the single-video processing method**

The single-video processing method (~`main.ts:3443`) has the identical block, differing only in the spinner label `'Processing video'`. Apply the identical mobile/desktop gating there, keeping its `'Processing video'` label:

```ts
            const { contentEl } = this;
            if (Platform.isMobile) {
                contentEl.empty();
                const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
                if (modalEl && modalEl.instanceOf(HTMLElement)) {
                    modalEl.addClass('tubesage-processing-modal');
                }
            } else {
                this.close();
            }

            spinner = new ProcessingSpinner(this.plugin, 'Processing video', contentEl);
            spinner.start();
```

- [ ] **Step 3: Check for desktop use of `contentEl` after processing starts**

After this change, on desktop the modal is closed when processing begins. Search both methods for any later code that writes to `this.contentEl` or the modal DOM (e.g. rendering a result/status into the modal). If any exists, it must be guarded `if (Platform.isMobile)` too, or moved to a Notice. Report what you find. (Progress is reported via the status-bar spinner and `showNotice` calls, which are platform-independent.)

- [ ] **Step 4: Build and lint**

Run: `npm run build` — no TypeScript errors.
Run: `npm run lint` — 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add main.ts
git commit -m "fix(ui): close create-note modal on desktop during processing (no blank popup)"
```

---

## Final verification

- [ ] `npm run build` is green.
- [ ] `npm run lint` reports 0 errors and 0 warnings.
- [ ] `grep -n "createInfoIcon" main.ts` shows the three new call sites (ScrapeCreators, Supadata, OpenRouter) plus the three pre-existing heading ones.
- [ ] `grep -n "fetchOpenRouterModels" main.ts` shows the method and its refresh-button call site.
- [ ] Manual in a dev vault: the ScrapeCreators / Supadata / OpenRouter settings show an ⓘ icon with the service URL on hover; selecting OpenRouter and clicking refresh fetches the full model list, the dropdown is vendor-grouped, and token limits update; on desktop, starting collection and single-video processing closes the modal and shows the status-bar spinner with no blank popup; on mobile the in-modal spinner still works.
