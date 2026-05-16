# Obsidian Community Portal Review Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the Obsidian Community Portal review warnings for TubeSage so a new release (v1.2.28) passes the automated scan.

**Architecture:** The review (commit `9338b51`, v1.2.27) produced 8 categories of findings. They split into three workstreams by risk and verifiability: **Phase 1** — mechanical fixes that are concretely planned here and ship in one v1.2.28 release; **Phase 2** — the CSS `!important` / `:has()` refactor, which can only be verified by visually loading the plugin in Obsidian, so it is documented as a procedure, not pre-baked code; **Phase 3** — the `setInterval` finding, already investigated and resolved (it is a disclosure, folded into Phase 1 Task 5).

**Tech Stack:** TypeScript, esbuild, GitHub Actions, Obsidian plugin API.

---

## Investigation findings (resolved before planning)

- **langsmith ×3 advisories** — already fixed on `main`. `npm ls langsmith` resolves `langsmith@0.6.3` via the `package.json` override `"langsmith": ">=0.6.0"`. 0.6.3 ≥ all three advisory thresholds (0.4.6 / 0.5.18 / 0.5.19). The warning is stale because the review scanned `9338b51` (the 1.2.27 release commit), which predates the override bump. **Cutting v1.2.28 from current `main` clears it — no code change.**
- **Build verification mismatch** — a fresh `npm ci && npm run build` from commit `9338b51` produces a `main.js` that is **byte-identical** to the released 1.2.27 asset (1,712,967 bytes, `cmp` confirms IDENTICAL). The build *is* reproducible from the committed lockfile. The portal's mismatch is because `release.yml` uses `npm install` (unpinned) rather than `npm ci` (locked). Fix: switch to `npm ci` — Task 4.
- **setInterval + network** — two `setInterval` calls exist only in bundled dependencies, none in TubeSage source: (1) `p-queue`'s concurrency timer (no network); (2) `langsmith`'s cache-refresh loop. `langsmith` is LangChain's optional tracing library, pulled in transitively via `@langchain/core`. It is dormant unless LangSmith tracing is explicitly enabled (env vars / API key) — TubeSage never does this. Fix: disclosure paragraph in README — Task 5.

---

# PHASE 1 — Mechanical fixes (one v1.2.28 release)

## Task 1: Add a GitHub-recognizable LICENSE file

The repo has `MIT-license-tubesage.md`, but GitHub's license detector needs a standard filename (`LICENSE`) containing only recognized license text. The existing file also bundles a "YouTube Content Usage Disclaimer" which breaks detection. Keep `MIT-license-tubesage.md` (the plugin displays it in-app); add a clean `LICENSE`.

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create the LICENSE file**

Create `LICENSE` with exactly this content (standard MIT, no markdown headers, no extra sections):

```
MIT License

Copyright (c) 2024-2026 Richard McCorkle

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Verify**

Run: `head -1 LICENSE`
Expected: `MIT License`

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "chore: add standard LICENSE file for GitHub license detection"
```

## Task 2: Remove unnecessary type assertion in fetch-shim.ts

`src/utils/fetch-shim.ts:174` has `(init.body as ArrayBufferView).buffer`. In the ternary's false branch, `init.body` is already narrowed to `ArrayBufferView` by the enclosing `ArrayBuffer.isView()` guard, so the assertion is redundant (flagged by `@typescript-eslint/no-unnecessary-type-assertion`).

**Files:**
- Modify: `src/utils/fetch-shim.ts:170-174`

- [ ] **Step 1: Verify the lint warning reproduces locally**

Run: `npm run lint 2>&1 | grep -A1 fetch-shim`
Expected: a `no-unnecessary-type-assertion` warning at line 174.

- [ ] **Step 2: Remove the assertion**

In `src/utils/fetch-shim.ts`, change this block:

```typescript
      } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
        // Handle binary data
        options.arrayBuffer = init.body instanceof ArrayBuffer 
          ? init.body 
          : (init.body as ArrayBufferView).buffer;
```

to:

```typescript
      } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
        // Handle binary data
        options.arrayBuffer = init.body instanceof ArrayBuffer 
          ? init.body 
          : init.body.buffer;
```

- [ ] **Step 3: Verify build + lint both pass**

Run: `npm run build && npm run lint 2>&1 | grep fetch-shim || echo "fetch-shim clean"`
Expected: build succeeds (tsc + esbuild), and `fetch-shim clean` prints.

- [ ] **Step 4: Commit**

```bash
git add src/utils/fetch-shim.ts
git commit -m "fix: remove unnecessary type assertion in fetch-shim"
```

## Task 3: Fix CSS-lint quick wins (duplicate selectors + shorthand)

Three duplicate selectors and one redundant shorthand. These are safe edits — they merge declarations into the canonical block.

**Files:**
- Modify: `styles.css` (lines 361-395, 504+, 653+, 1016-1022, 1048)

- [ ] **Step 1: Merge `.tubesage-settings-info-icon-with-tooltip::after`**

In the block at line 361, change `white-space: nowrap;` to `white-space: normal;` and add `width: max-content;` after it. Then delete the duplicate block (the `/* Handle long tooltips by allowing wrapping */` comment plus its rule, lines 390-395):

Delete:
```css
/* Handle long tooltips by allowing wrapping */
.tubesage-settings-info-icon-with-tooltip::after {
    white-space: normal;
    width: max-content;
    max-width: 300px;
}
```

The line-380 declaration inside the 361 block changes from:
```css
    white-space: nowrap;
```
to:
```css
    white-space: normal;
    width: max-content;
```

- [ ] **Step 2: Merge `.tubesage-license-container`**

Add `font-family: var(--font-monospace);` as the last declaration of the canonical block at line 504. Then delete the duplicate at lines 1016-1018:

Delete:
```css
.tubesage-license-container {
    font-family: var(--font-monospace);
}
```

- [ ] **Step 3: Merge `.tubesage-readme-container`**

Add `font-family: var(--font-interface);` as the last declaration of the canonical block at line 653. Then delete the duplicate at lines 1020-1022:

Delete:
```css
.tubesage-readme-container {
    font-family: var(--font-interface);
}
```

- [ ] **Step 4: Fix redundant margin shorthand**

At line 1048 (`.tubesage-custom-params-header`), change:
```css
    margin: 0 0 15px 0;
```
to:
```css
    margin: 0 0 15px;
```

- [ ] **Step 5: Verify no duplicate selectors remain (for these three)**

Run: `grep -nc "tubesage-license-container {" styles.css; grep -nc "tubesage-readme-container {" styles.css`
Expected: each selector now appears exactly once.

- [ ] **Step 6: Commit**

```bash
git add styles.css
git commit -m "fix: dedupe CSS selectors and redundant margin shorthand"
```

## Task 4: Make release builds reproducible + add artifact attestation

`release.yml` uses `npm install` (unpinned) and creates releases without provenance attestation. Switch to `npm ci` (verified to reproduce the artifact byte-for-byte), add `actions/attest-build-provenance`, and modernize the action versions.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace `.github/workflows/release.yml` with this content**

```yaml
name: Release Obsidian plugin

on:
  push:
    tags:
      - "*"

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20.x"

      - name: Build plugin
        run: |
          npm ci
          npm run build

      - name: Generate artifact attestation
        uses: actions/attest-build-provenance@v2
        with:
          subject-path: |
            main.js
            styles.css
            manifest.json

      - name: Create release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"

          if gh release view "$tag" >/dev/null 2>&1; then
            echo "Release $tag already exists, skipping draft creation"
            exit 0
          fi

          gh release create "$tag" \
            --title="$tag" \
            --draft \
            main.js styles.css manifest.json README.md LICENSE MIT-license-tubesage.md templates/YouTubeTranscript.md
```

Changes: `checkout@v3→v4`, `setup-node@v3→v4`, `node 18.x→20.x`, `npm install→npm ci`, added attestation step + `id-token`/`attestations` permissions, added `LICENSE` to release assets.

- [ ] **Step 2: Verify YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: use npm ci for reproducible builds and add artifact attestation"
```

## Task 5: De-promote the README + fix license link + disclose setInterval

The portal flagged "excessive promotional language." Rewrite README.md factually: drop superlatives ("powerful", "cutting-edge", "state-of-the-art", "intelligent", "seamlessly", "Smart", "Advanced"), drop emoji section headers, drop the stale "Recent Updates (v1.0.6)" section and the closing marketing line. Fix the license link (`MIT-license-tubesage.md` → `LICENSE`). Add a factual disclosure paragraph about the bundled `langsmith` background timer.

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Replace README.md with the de-promoted version**

Replace the entire file with this content:

````markdown
# TubeSage

TubeSage is an Obsidian plugin that converts YouTube videos into structured notes using large language models. It extracts transcripts, generates summaries, and can add timestamped links back to specific moments in the video.

## Quick Start

### Installation

**Community Plugins:** Install through Obsidian's Settings → Community plugins browser once TubeSage is listed in the directory.

**Manual install from a GitHub release:**
1. Open the [latest release](https://github.com/rmccorkl/TubeSage/releases/latest) page.
2. From the **Assets** section, download `main.js`, `manifest.json`, and `styles.css`.
   *Do not* download "Source code (zip)" or "Source code (tar.gz)" — those are source archives and will not load as a plugin.
3. In your vault, create the folder `.obsidian/plugins/tubesage/`.
4. Move the three downloaded files into that `tubesage/` folder.
5. In Obsidian, go to Settings → Community plugins, toggle off "Restricted mode" if needed, refresh the installed-plugins list, and enable **TubeSage**.
6. Accept the license terms in TubeSage's settings panel.
7. Configure API keys for your preferred LLM provider.
8. (For YouTube notes) Install the [Templater plugin](https://github.com/SilentVoid13/Templater) for template-driven formatting.

### Requirements
- [Obsidian](https://obsidian.md/) v1.2.0+
- [Templater plugin](https://github.com/SilentVoid13/Templater) (required for template functionality)
- An API key for at least one LLM provider:
  - OpenAI
  - Anthropic
  - Google (Gemini)
  - OpenRouter
  - Ollama (local models)
- A YouTube Data API key (optional — required only for channel/playlist processing)

## Features

- Transcript extraction from YouTube videos with fallback methods
- Summary generation using a configurable LLM provider
- Optional timestamp links added to section headings, linking to the moment in the video
- Works on desktop and mobile Obsidian
- Batch processing of YouTube channels and playlists
- Multi-provider support: OpenAI, Anthropic, Google Gemini, OpenRouter, and Ollama
- A cross-platform fetch shim so all providers work on mobile without Node.js dependencies

## Configuration

### 1. License acceptance
Accept the MIT license terms in the settings panel before using the plugin. Use the "View License" button to read the full text.

### 2. LLM provider setup
Choose and configure a provider in settings:

- **OpenAI** — models such as GPT-4o, GPT-4, GPT-3.5-Turbo.
- **Anthropic** — Claude 3 family models.
- **Google Gemini** — Gemini Pro models.
- **OpenRouter** — gateway access to models from multiple vendors.
- **Ollama** — local open-source models; runs offline, requires Ollama installed and running.

### 3. Other settings
- **Summary modes**: Fast (brief) or Extensive (detailed).
- **Timestamp processing**: enable or disable automatic timestamp links.
- **Batch processing**: sequential or parallel processing for collections.
- **Performance monitoring**: optional logging of processing times.

## Usage

### Basic workflow
1. Click the YouTube icon in the ribbon, or use the Command Palette.
2. Paste a YouTube video URL.
3. Choose a summary mode and folder location.
4. Run processing.
5. The resulting note appears in the chosen folder.

### Batch processing (channels/playlists)
1. Configure a YouTube Data API key in settings.
2. Paste a channel or playlist URL.
3. Set the number of videos to process.
4. Choose sequential or parallel processing.

### Timestamp navigation
When enabled, each section heading includes a link that opens the YouTube video at the corresponding moment.

## Technical Architecture

- **Main plugin** (`main.ts`): coordinator and UI.
- **Transcript extractor** (`src/youtube-transcript.ts`): multi-method extraction with mobile fallbacks.
- **LLM factory** (`src/llm/llm-factory.ts`): constructs the provider client.
- **Transcript summarizer** (`src/llm/transcript-summarizer.ts`): orchestrates summarization.
- **LangChain client** (`src/llm/langchain-client.ts`): unified interface for cloud providers.
- **Fetch shim** (`src/utils/fetch-shim.ts`): cross-platform HTTP via Obsidian's `requestUrl`.
- **Timestamp processor** (`src/utils/timestamp-utils.ts`): timestamp link generation.
- **Error utilities** (`src/utils/error-utils.ts`): error categorization and retry logic.

Architecture diagrams are in the `docs/` directory:
- [Workflow Diagram](docs/workflow-diagram.md)
- [Data Flow Diagram](docs/data-flow-diagram.md)

## Privacy & Security

- API calls to LLM providers and YouTube use HTTPS.
- No user data is stored on servers operated by the plugin author.
- Ollama can be used for fully local, offline processing.
- The plugin bundles `langsmith` as a transitive dependency of `@langchain/core`. `langsmith` is LangChain's optional tracing library and contains a background cache-refresh timer. TubeSage never enables LangSmith tracing and never sets a LangSmith API key, so this code stays dormant and performs no background network transmission. The only network requests TubeSage makes are to the LLM provider you configure and to YouTube.

## Troubleshooting

- **API key errors**: verify keys are configured correctly in settings.
- **Mobile processing issues**: ensure a stable connection, or use Ollama for offline processing.
- **Timestamp link failures**: check video availability and URL format.
- **Batch processing limits**: monitor YouTube API quota usage.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file. A YouTube content-usage disclaimer is included in [MIT-license-tubesage.md](MIT-license-tubesage.md).

## Support & Contribution

- **GitHub Issues**: bug reports and feature requests.
- **Code contributions**: fork the repository and open a pull request.

---

**GitHub Repository**: [https://github.com/rmccorkl/TubeSage](https://github.com/rmccorkl/TubeSage)
````

- [ ] **Step 2: Verify the license link and no leftover emoji headers**

Run: `grep -n "MIT-license-tubesage.md)" README.md; grep -cE '^#+ .*[🚀✨🤖📱⚡🔧📋🏗🎯📚💼🎓📖🔄🔐🎨🆘📄🤝]' README.md`
Expected: the license-link grep shows the disclaimer reference line only; the emoji-header count is `0`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: de-promote README, fix license link, disclose bundled langsmith timer"
```

## Task 6: Bump version to 1.2.28

**Files:**
- Modify: `manifest.json`, `package.json`

- [ ] **Step 1: Bump `manifest.json`**

Change `"version": "1.2.27"` to `"version": "1.2.28"`.

- [ ] **Step 2: Bump `package.json`**

Change `"version": "1.2.27"` to `"version": "1.2.28"`.

- [ ] **Step 3: Verify a clean reproducible build**

Run: `npm ci && npm run build && echo "build OK"`
Expected: `build OK`. (`postbuild` runs `npm run audit:fallow` — if fallow flags anything, address separately; the build itself must succeed.)

- [ ] **Step 4: Commit**

```bash
git add manifest.json package.json
git commit -m "chore: bump version to 1.2.28"
```

## Task 7: Tag and release v1.2.28

This follows the user's established release flow (see memory `feedback_release_workflow.md`): push commits, push tag, the CI workflow builds and drafts the release, then publish it.

- [ ] **Step 1: Push commits and tag**

```bash
git push origin main
git tag 1.2.28
git push origin 1.2.28
```

- [ ] **Step 2: Wait for the release workflow, then publish**

The `release.yml` workflow builds with `npm ci`, generates attestation, and creates a **draft** release. Verify it succeeded:

Run: `gh run list --workflow="Release Obsidian plugin" --limit 1`
Then publish the draft:
```bash
gh release edit 1.2.28 --draft=false
```

- [ ] **Step 3: Verify the published release has the required assets**

Run: `gh release view 1.2.28 --json assets -q '.assets[].name'`
Expected: includes `main.js`, `manifest.json`, `styles.css`.

---

# PHASE 2 — CSS `!important` + `:has()` refactor (approach, not pre-baked code)

**Why this is separate:** the review flagged ~100 lines using `!important` and 6 uses of `:has()`. Removing `!important` is only correct if the rule still wins against Obsidian's theme styles after removal — and that can only be confirmed by loading the plugin in Obsidian and visually inspecting the settings panel and modals. Pre-writing 100 line-by-line replacements would be fake planning. **This phase cannot be auto-verified; it requires manual visual testing in Obsidian.**

**Procedure:**

1. **Create an isolated worktree** for this work (`superpowers:using-git-worktrees`).
2. **`:has()` first — eliminate it via a class.** The 6 `:has(.tubesage-prompt-textarea)` rules style a `.setting-item` based on a child. Instead, find where the prompt-textarea settings are constructed in `main.ts` and call `setting.settingEl.addClass('tubesage-prompt-setting')` (or equivalent) at construction. Then rewrite the 6 selectors from `.setting-item:has(.tubesage-prompt-textarea)` to `.setting-item.tubesage-prompt-setting`. This is deterministic and removes the `:has()` performance warning entirely.
3. **`!important` — remove then re-qualify.** Delete every `!important`, rebuild, load the plugin in Obsidian, and inspect: settings panel headings, provider rows, prompt textareas, and the license/readme/template modals. For each rule that now loses to the theme, raise specificity deliberately — stack the plugin's own class (`.tubesage-x.tubesage-x`) or add a parent scope (`.workspace-leaf-content .tubesage-x`) — rather than restoring `!important`. Many rules (e.g. `.tubesage-readme-modal-size.modal`) already have enough specificity and only need the `!important` deleted.
4. **Verify visually** in Obsidian desktop *and* mobile (or the mobile emulator), since several `!important` rules live inside the `@media (max-width: 768px)` block.
5. Ship in a follow-up release (v1.2.29) — do not block Phase 1 / v1.2.28 on it.

**Risk:** medium-high. The settings UI is the user-facing surface; a botched specificity change is visible. Worktree isolation + visual testing is mandatory.

---

# PHASE 3 — setInterval finding (RESOLVED)

No code task. Investigation complete (see "Investigation findings" above). The disclosure is delivered by Phase 1 Task 5's README Privacy section. If the portal still flags it after v1.2.28, the fallback is to respond on the portal dashboard citing the disclosure — `langsmith` cannot be removed without dropping `@langchain/core`, which the architecture mandate requires.

---

## Self-review

- **Spec coverage:** License ✓ (T1); type assertion ✓ (T2); duplicate selectors + shorthand ✓ (T3); build verification + attestation ✓ (T4); README promo language ✓ (T5); langsmith ✓ (resolved, ships via T6/T7 release); setInterval ✓ (T5 disclosure + Phase 3); `!important` + `:has()` → Phase 2. All 8 review categories accounted for.
- **Placeholder scan:** none — every step has concrete content. Phase 2 is deliberately an approach (justified inline), not placeholder tasks.
- **Type consistency:** Task 2's edit keeps `options.arrayBuffer`'s assignment type-correct (verified by the Step 3 build gate). No cross-task symbol mismatches.
