# Service info icons, OpenRouter model refresh, desktop spinner fix — design

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan

## Goal

Three independent improvements to the TubeSage plugin, batched for the 1.3.4 release:

1. Add info (ⓘ) hover icons showing the service URL on the ScrapeCreators, Supadata, and OpenRouter settings.
2. Add an OpenRouter model-list refresh, paralleling the existing OpenAI/Google/Anthropic refresh, that pulls the full live model list and updates per-model token limits.
3. Fix a desktop bug where the processing spinner leaves a blank popup; on desktop the status bar is the spinner surface and no popup should appear.

## Background

- **Item 1.** The plugin has a `createInfoIcon(container, tooltipText)` helper (native `setTooltip` on hover), used today on three settings section headings. The ScrapeCreators API-key setting (`main.ts` ~3977) and Supadata API-key setting (~4005) have no info icon; neither does the OpenRouter provider/key setting. Their service URLs are `https://scrapecreators.com/`, `https://supadata.ai/`, `https://openrouter.ai/`.
- **Item 2.** The plugin has `fetchOpenAIModels`, `fetchGoogleModels`, `fetchAnthropicModels` and a per-provider refresh button in `createProviderConfigBlock` (~`main.ts:4268`) whose `onClick` switches on the provider. There is **no** `fetchOpenRouterModels` and no `openrouter` case in that switch; `settings.fetchedModels.openrouter` is always `[]`, so the OpenRouter model dropdown only has a minimal default. `fetchGoogleModels`/`fetchAnthropicModels` also store per-model token limits into the model-limits registry. OpenRouter publishes its full model list at `https://openrouter.ai/api/v1/models` — a public endpoint requiring no API key — with per-model `id`, `name`, `context_length`, and `top_provider` (which includes a max-output-tokens figure).
- **Item 3.** `beginCollectionProcessing` (`main.ts:3120`) and the single-video processing method (~3445) keep the create-note modal (`YouTubeTranscriptModal`) open and reuse it as a processing popup: they `contentEl.empty()`, add the `tubesage-processing-modal` class to `modalEl`, and create a `ProcessingSpinner`. `ProcessingSpinner.start()` renders to the **status bar on desktop** and to an **in-modal element on mobile**. So on desktop the modal is left blank — a popup with no content. `YouTubeTranscriptModal.onClose()` only calls `contentEl.empty()`; it does not touch `isProcessing` or abort anything, so closing the modal does not interrupt the async processing run.

## Changes

### Item 1 — Service info icons

For each of the three settings, after the `Setting` is built, get its name element (`setting.settingEl.querySelector('.setting-item-name')`, guard it is an `HTMLElement`) and call `createInfoIcon(nameEl, url)` with:
- ScrapeCreators API-key setting → `https://scrapecreators.com/`
- Supadata API-key setting → `https://supadata.ai/`
- OpenRouter setting → `https://openrouter.ai/`

This matches exactly how the three existing section-heading info icons are attached. The tooltip shows the URL as plain hover text (a `setTooltip` tooltip is not clickable; that is acceptable and what was requested).

### Item 2 — OpenRouter model refresh

Add a `fetchOpenRouterModels()` method on the plugin, modelled on `fetchGoogleModels`:
- Fetch `https://openrouter.ai/api/v1/models` via the cross-platform `obsidianFetch` shim. No API key is sent or required (the endpoint is public).
- Parse the response: each entry has `id` (e.g. `openai/gpt-4o`), `context_length`, and `top_provider.max_completion_tokens` (max output tokens; may be absent for some models).
- Store the model id list into `settings.fetchedModels.openrouter` and persist settings.
- For each model with usable limits, update the model-limits registry via the same `upsertModel` path `fetchGoogleModels`/`fetchAnthropicModels` use, recording the context window and max output tokens.
- Show the same user-facing notices the other fetchers show ("Fetching OpenRouter models...", success count, error message on failure).

Wire it into the refresh button: add an `openrouter` case to the provider switch in `createProviderConfigBlock` (~`main.ts:4280`) that calls `fetchOpenRouterModels()`. Unlike the other providers, the OpenRouter refresh does not require the API key to be present (the models endpoint is public) — the case must not early-return on a missing key.

Dropdown population: the OpenRouter model dropdown is rendered with the **full** fetched list, **sorted by vendor then model id**, and **grouped under `<optgroup>` headers per vendor** (the segment before the `/` in the model id — `openai`, `anthropic`, `google`, `meta-llama`, …). Because Obsidian's `DropdownComponent.addOption` is flat, the `<optgroup>` elements are appended directly to the component's `.selectEl`. The currently-selected model stays selected after a refresh if it is still in the list.

### Item 3 — Desktop spinner: no blank popup

In both `beginCollectionProcessing` and the single-video processing method, gate the modal-as-popup behavior on platform:
- **Desktop** (`!Platform.isMobile`): close the create-note modal at the start of processing (`this.close()`), before/around creating the `ProcessingSpinner`. The status-bar spinner and Notices are the desktop UX; no popup. Closing the modal is safe — `onClose()` only empties `contentEl` and does not abort the async run.
- **Mobile** (`Platform.isMobile`): keep the current behavior — empty `contentEl`, add the `tubesage-processing-modal` class, render the in-modal spinner.

`ProcessingSpinner` is still created and started in both cases; it already routes itself to the status bar on desktop and to the in-modal element on mobile. The `tubesage-processing-modal` class and the `contentEl.empty()` only apply on mobile now.

## Error handling and edge cases

- `fetchOpenRouterModels`: on network/parse failure, show an error Notice and leave `fetchedModels.openrouter` unchanged (do not wipe an existing list). Mirror the existing fetchers' try/catch.
- Models lacking `top_provider.max_completion_tokens`: still list the model; just skip the max-output registry entry for it (record context length if present).
- Item 3: if `this.close()` is called on desktop, the async processing continues; the spinner (status bar) and Notices report progress. Confirm no later code path assumes the modal's `contentEl` is still mounted on desktop during processing.

## Out of scope

- No change to the OpenAI/Google/Anthropic fetchers or their refresh behavior.
- No change to the mobile processing modal.
- The deferred UI items (#1 MarkdownRenderer, #3 FuzzySuggestModal pickers) remain deferred.

## Testing

No unit-test framework exists; verification is:
- `npm run build` clean (tsc + esbuild), `npm run lint` clean (0/0).
- Manual in a dev vault:
  - The ScrapeCreators, Supadata, and OpenRouter settings show an info icon; hovering shows the respective URL.
  - With OpenRouter selected, the refresh button fetches the live model list; the dropdown shows the full list grouped by vendor; token limits update.
  - On desktop, starting collection/single-video processing closes the create-note modal — no blank popup — and the status-bar spinner animates with Notices.
  - On mobile, the in-modal spinner still appears and works.
