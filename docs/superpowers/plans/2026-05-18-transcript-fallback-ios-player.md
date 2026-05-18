# Transcript Fallback: iOS InnerTube Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four broken free local transcript-extraction methods in `src/youtube-transcript.ts` with a single working method built on YouTube's InnerTube iOS player API.

**Architecture:** The transcript fallback ladder in `YouTubeTranscriptExtractor.fetchTranscript` becomes three rungs — ScrapeCreators paid API, the new iOS InnerTube player method, Supadata paid API. The iOS player response carries both caption tracks and `videoDetails`, so it also replaces the watch-page HTML scrape that `getVideoMetadata` used. All watch-page / ANDROID / MWEB / WEB-`get_transcript` code and its helpers are deleted.

**Tech Stack:** TypeScript (strict), esbuild, the `obsidianFetch` cross-platform HTTP shim. Single file: `src/youtube-transcript.ts`.

---

## Important context for the implementer

- **No unit-test framework exists in this repo**, and `src/youtube-transcript.ts` calls live YouTube endpoints that cannot be exercised in CI. There are therefore **no "write a failing test" steps**. The verification gate for every task is `npm run build` (tsc strict + esbuild) and `npm run lint` (must report `0 errors, 0 warnings`).
- **Hard project rule: never add an `eslint-disable` comment anywhere.** If lint complains, fix the code.
- TypeScript and the project's ESLint config do **not** flag an unused *private class method*. That is why Task 1 can add `fetchViaIosPlayer` before Task 2 wires it in — the build stays green.
- The tasks are ordered so the build compiles cleanly after every commit: Task 1 adds new code, Task 2 switches callers to it, Task 3 deletes the now-unreferenced old code.
- Existing file-level helpers you will reuse: `isRecord(value): value is Record<string, unknown>`, `isString(value): value is string`, the type alias `UnknownRecord = Record<string, unknown>`, the logger `transcriptLogger`, `getSafeErrorMessage`, and the `obsidianFetch` shim.
- Existing methods you will reuse and must NOT change: `pickBestTrack(tracks, requestedLang)` → returns `{ track: CaptionTrack; useTlang: boolean } | null`; `fetchCaptionTrack(baseUrl, tlang?, userAgent?)` → `Promise<TranscriptSegment[]>`.
- Existing interfaces you will reuse: `CaptionTrack` (`languageCode: string; kind?: string; baseUrl?: string; vssId?: string; isTranslatable?: boolean`), `TranscriptOptions`, `TranscriptMetadata` (`title?: string; author?: string`), `TranscriptResult` (`segments: TranscriptSegment[]; metadata: TranscriptMetadata`).

## File Structure

- Modify: `src/youtube-transcript.ts` — the only file changed. It currently holds the whole `YouTubeTranscriptExtractor` class. The plan adds two methods + four module constants + two statics, rewires three call sites, and removes the obsolete methods/helpers. Net effect: the file shrinks substantially.

---

### Task 1: Add the iOS InnerTube player method

**Files:**
- Modify: `src/youtube-transcript.ts`

This task adds new code only. Nothing calls `fetchViaIosPlayer` yet — that is Task 2. The build stays green because TypeScript does not flag unused private methods.

- [ ] **Step 1: Add the four module-level constants**

In `src/youtube-transcript.ts`, the file begins with imports, then `type UnknownRecord = ...`, `isRecord`, and `isString` (the `isString` line is `const isString = (value: unknown): value is string => typeof value === 'string';`). Immediately **after** the `isString` line and **before** the `// Add the CaptionTrack type at file level` comment, insert:

```ts
// YouTube InnerTube iOS player endpoint.
// See docs/superpowers/specs/2026-05-18-transcript-fallback-ios-player-design.md
// The iOS client still returns working caption track URLs without PO tokens,
// while the Android/MWEB/WEB clients stopped doing so in early 2026.
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`;
const IOS_USER_AGENT = 'com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';
const IOS_CLIENT_VERSION = '20.10.38';
```

- [ ] **Step 2: Add the iOS player cache statics**

In the `YouTubeTranscriptExtractor` class, find the existing static field block near the top of the class:

```ts
    private static cookieStore: string = '';
    // Cache YouTube config after first extraction to avoid repeated HTML fetches within the same video request
    private static cachedConfig: YouTubeConfig | null = null;
    private static cachedVideoId: string | null = null;
```

Immediately **after** the `private static cachedVideoId: string | null = null;` line, add:

```ts
    // Cache the iOS player API response per video to avoid a redundant POST within one request
    private static cachedPlayerData: UnknownRecord | null = null;
    private static cachedPlayerVideoId: string | null = null;
```

(Leave `cookieStore`, `cachedConfig`, `cachedVideoId` in place for now — Task 3 removes them.)

- [ ] **Step 3: Add the `fetchIosPlayerData` helper method**

In `src/youtube-transcript.ts`, find the method `fetchViaScrapeCreators` and its closing brace (it ends with `return { segments, metadata };` followed by a line containing only `    }`). Immediately **after** that closing brace, insert this method:

```ts
    /**
     * Perform the YouTube InnerTube iOS player API call and return the parsed JSON.
     * The iOS client currently still exposes working caption track URLs and videoDetails.
     * The response is cached per videoId to avoid a redundant POST within one request.
     */
    private static async fetchIosPlayerData(videoId: string, options: TranscriptOptions): Promise<UnknownRecord> {
        if (this.cachedPlayerData && this.cachedPlayerVideoId === videoId) {
            transcriptLogger.debug('Using cached iOS player data');
            return this.cachedPlayerData;
        }

        const lang = options.lang || 'en';
        const country = options.country || 'US';

        const body = JSON.stringify({
            context: {
                client: {
                    clientName: 'IOS',
                    clientVersion: IOS_CLIENT_VERSION,
                    hl: lang,
                    gl: country
                }
            },
            videoId
        });

        transcriptLogger.debug(`iOS Player API: requesting player data for ${videoId}`);

        const response = await obsidianFetch(INNERTUBE_PLAYER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': IOS_USER_AGENT
            },
            body
        });

        if (!response.ok) {
            throw new Error(`iOS Player API error: HTTP ${response.status}`);
        }

        const data = await response.json() as UnknownRecord;

        const playabilityStatus = data.playabilityStatus;
        if (isRecord(playabilityStatus)) {
            const status = playabilityStatus.status;
            const reason = isString(playabilityStatus.reason) ? playabilityStatus.reason : undefined;
            if (status === 'ERROR') {
                throw new Error(reason || 'Video unavailable');
            }
            if (status === 'LOGIN_REQUIRED') {
                throw new Error('This video requires login to view');
            }
            if (status === 'UNPLAYABLE') {
                throw new Error(reason || 'Video is unplayable');
            }
        }

        this.cachedPlayerData = data;
        this.cachedPlayerVideoId = videoId;
        return data;
    }
```

- [ ] **Step 4: Add the `fetchViaIosPlayer` method**

Immediately **after** the `fetchIosPlayerData` method you just added (after its closing `    }`), insert:

```ts
    /**
     * iOS InnerTube player method: the working local transcript fallback.
     * Fetches the iOS player response, picks a caption track, downloads and parses it.
     */
    private static async fetchViaIosPlayer(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';

        const data = await this.fetchIosPlayerData(videoId, options);

        // Metadata from videoDetails
        const videoDetails = isRecord(data.videoDetails) ? data.videoDetails : undefined;
        const metadata: TranscriptMetadata = {
            title: videoDetails && isString(videoDetails.title) ? videoDetails.title : undefined,
            author: videoDetails && isString(videoDetails.author) ? videoDetails.author : undefined
        };

        // Caption tracks
        const captions = (data as {
            captions?: {
                playerCaptionsTracklistRenderer?: {
                    captionTracks?: Array<{
                        baseUrl?: string;
                        languageCode?: string;
                        kind?: string;
                        vssId?: string;
                        isTranslatable?: boolean;
                    }>;
                };
            };
        }).captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!captions || !Array.isArray(captions) || captions.length === 0) {
            throw new Error('No captions available for this video');
        }

        transcriptLogger.debug(`iOS Player API: found ${captions.length} caption tracks`);

        const tracks: CaptionTrack[] = captions.map(track => ({
            languageCode: track.languageCode || '',
            kind: track.kind,
            baseUrl: track.baseUrl,
            vssId: track.vssId,
            isTranslatable: track.isTranslatable
        }));

        const selection = this.pickBestTrack(tracks, lang);
        if (!selection || !selection.track.baseUrl) {
            throw new Error('No suitable caption track with baseUrl found');
        }

        const { track, useTlang } = selection;
        const trackBaseUrl = track.baseUrl as string; // Guaranteed non-null by the check above
        transcriptLogger.debug(`iOS Player API: selected track lang=${track.languageCode}, kind=${track.kind || 'manual'}, useTlang=${useTlang}`);

        const tlang = useTlang ? lang : undefined;
        const segments = await this.fetchCaptionTrack(trackBaseUrl, tlang, IOS_USER_AGENT);

        transcriptLogger.debug(`iOS Player API: successfully extracted ${segments.length} segments`);
        return { segments, metadata };
    }
```

- [ ] **Step 5: Verify the build is clean**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 6: Verify lint is clean**

Run: `npm run lint`
Expected: `0 errors, 0 warnings`.

- [ ] **Step 7: Commit**

```bash
git add src/youtube-transcript.ts
git commit -m "$(cat <<'EOF'
feat: add iOS InnerTube player transcript method

Add fetchIosPlayerData and fetchViaIosPlayer, built from the YouTube
iOS player approach. Not yet wired into the fallback ladder.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rewire the fallback ladder and metadata lookup to the iOS method

**Files:**
- Modify: `src/youtube-transcript.ts`

This task switches `fetchTranscript` to the new three-rung ladder and re-points `getVideoMetadata` at the iOS player call. After this task the four old methods are still defined but no longer called — that is fine, the build stays green; Task 3 deletes them.

- [ ] **Step 1: Replace the video-ID cache-reset block in `fetchTranscript`**

In `fetchTranscript`, find this block near the start of the method:

```ts
        // Clear cached config when video changes to prevent stale title/metadata from a previous request
        if (this.cachedVideoId !== videoId) {
            this.cachedConfig = null;
            this.cachedVideoId = videoId;
            transcriptLogger.debug(`New video ID detected (${videoId}), cleared config cache`);
        }
```

Replace it with:

```ts
        // Clear cached player data when the video changes to prevent stale metadata
        if (this.cachedPlayerVideoId !== videoId) {
            this.cachedPlayerData = null;
            this.cachedPlayerVideoId = videoId;
            transcriptLogger.debug(`New video ID detected (${videoId}), cleared player cache`);
        }
```

- [ ] **Step 2: Replace the fallback ladder body in `fetchTranscript`**

In `fetchTranscript`, find the `try {` that opens with `const attempts: Array<{ method: string; error: string }> = [];` and runs through the six numbered method blocks (`[1]` ScrapeCreators … `[6]` Supadata) up to and including the `throw new Error(\`All transcript extraction methods failed ...\`);` line. Replace everything from `const attempts:` down to that `throw new Error(...)` line (the entire body inside that `try`, but NOT the `try {` line itself and NOT the `} catch (error) {` that follows) with:

```ts
            const attempts: Array<{ method: string; error: string }> = [];
            let metadata: TranscriptMetadata = {};

            // [1] ScrapeCreators paid API — run first when key is present (most reliable)
            if (options.scrapcreatorsApiKey) {
                try {
                    transcriptLogger.debug('ScrapeCreators API key present — attempting paid API first');
                    const result = await this.fetchViaScrapeCreators(videoId, options);
                    transcriptLogger.debug(`ScrapeCreators API succeeded with ${result.segments.length} segments`);
                    return result;
                } catch (err) {
                    const msg = getSafeErrorMessage(err);
                    transcriptLogger.debug('ScrapeCreators API failed, falling back to local method:', msg);
                    attempts.push({ method: 'ScrapeCreators API', error: msg });
                }
            }

            // [2] iOS InnerTube player API — the working local method
            try {
                transcriptLogger.debug('Attempting local method: iOS InnerTube player API');
                const result = await this.fetchViaIosPlayer(videoId, options);
                transcriptLogger.debug(`iOS player method succeeded with ${result.segments.length} segments`);
                return result;
            } catch (err) {
                const msg = getSafeErrorMessage(err);
                transcriptLogger.debug('iOS player method failed:', msg);
                attempts.push({ method: 'iOS player', error: msg });
                // If the player call itself succeeded but captions were absent, the
                // response (with videoDetails) is cached — recover metadata from it.
                const cached = this.cachedPlayerData;
                if (isRecord(cached) && isRecord(cached.videoDetails)) {
                    metadata = {
                        title: isString(cached.videoDetails.title) ? cached.videoDetails.title : undefined,
                        author: isString(cached.videoDetails.author) ? cached.videoDetails.author : undefined
                    };
                }
            }

            // [3] Supadata paid API fallback (only if key is configured)
            if (options.supadataApiKey) {
                try {
                    transcriptLogger.debug('Local method failed — attempting Supadata paid API');
                    const result = await this.fetchViaSupadata(videoId, options);
                    transcriptLogger.debug(`Supadata API succeeded with ${result.segments.length} segments`);
                    return result;
                } catch (err) {
                    const msg = getSafeErrorMessage(err);
                    transcriptLogger.debug('Supadata API failed:', msg);
                    attempts.push({ method: 'Supadata API', error: msg });
                }
            }

            // All methods failed
            const attemptedMethods = attempts.map(a => a.method).join(', ');
            const lastError = attempts[attempts.length - 1]?.error || 'Unknown error';
            transcriptLogger.error(`All transcript methods failed: ${attemptedMethods}`);

            if (metadata.title || metadata.author) {
                transcriptLogger.debug('Returning metadata despite caption failure');
                return {
                    segments: [{
                        text: `[TRANSCRIPT EXTRACTION FAILED: ${attemptedMethods} methods all failed. ${lastError}]`,
                        start: 0,
                        duration: 0
                    }],
                    metadata
                };
            }

            throw new Error(`All transcript extraction methods failed (${attemptedMethods}). Last error: ${lastError}`);
```

Leave the `} catch (error) {` block that follows (the CORS/network error mapping) exactly as it is.

- [ ] **Step 3: Replace the body of `getVideoMetadata`**

Find the `getVideoMetadata` method. Its current signature line is `static async getVideoMetadata(videoId: string): Promise<TranscriptMetadata> {`. Replace the **entire method** (signature through its closing brace) with:

```ts
    /**
     * Get video metadata (title, author) from the iOS player response.
     * Used by the ScrapeCreators and Supadata paths, which return transcript text only.
     * The iOS player response is cached per videoId, so this reuses a warm cache when present.
     */
    static async getVideoMetadata(videoId: string): Promise<TranscriptMetadata> {
        try {
            const data = await this.fetchIosPlayerData(videoId, {});
            const videoDetails = isRecord(data.videoDetails) ? data.videoDetails : undefined;
            return {
                title: videoDetails && isString(videoDetails.title) ? videoDetails.title : undefined,
                author: videoDetails && isString(videoDetails.author) ? videoDetails.author : undefined
            };
        } catch (error) {
            transcriptLogger.error('Error fetching video metadata:', error);
            return {};
        }
    }
```

- [ ] **Step 4: Verify the build is clean**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. (The four old `fetchVia*` local methods and their helpers are now uncalled but still defined — TypeScript does not flag unused private methods, so this compiles.)

- [ ] **Step 5: Verify lint is clean**

Run: `npm run lint`
Expected: `0 errors, 0 warnings`.

- [ ] **Step 6: Commit**

```bash
git add src/youtube-transcript.ts
git commit -m "$(cat <<'EOF'
feat: route transcript fallback through the iOS player method

fetchTranscript now uses a three-rung ladder (ScrapeCreators, iOS
player, Supadata). getVideoMetadata is sourced from the iOS player
response instead of the watch-page HTML scrape.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Delete the obsolete methods, helpers, and statics

**Files:**
- Modify: `src/youtube-transcript.ts`

Everything removed here is now unreferenced (verified: `parseScrapeCreatorsTranscript` was used only inside `fetchViaWebScrapeCreators`; `getYouTubeConfig`/`fetchWatchPageHtml`/`extractJsonFromHtml` only by the deleted methods after Task 2). The `USER_AGENT` static is **kept** because `fetchCaptionTrackRaw` still uses it.

- [ ] **Step 1: Delete the four obsolete transcript methods**

Delete each of these methods in full (the leading JSDoc comment block through the method's closing brace). Locate them by their signature lines:

1. `private static async fetchViaWatchPage(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {`
2. `private static async fetchViaWebScrapeCreators(videoId: string, _options: TranscriptOptions): Promise<TranscriptResult> {`
3. `private static async fetchViaPlayerApiMWEB(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {`
4. `private static async fetchViaPlayerApiAndroid(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {`

- [ ] **Step 2: Delete the five obsolete helper methods**

Delete each of these methods in full (JSDoc through closing brace), located by signature:

1. `private static async getYouTubeConfig(videoId: string): Promise<YouTubeConfig> {`
2. `private static async fetchWatchPageHtml(watchUrl: string, extraCookie?: string): Promise<string> {`
3. `private static extractJsonFromHtml(html: string, variableName: string): unknown {`
4. `private static extractMetadataFromNextData(nextData: unknown): TranscriptMetadata {`
5. `private static findTranscriptEndpoint(obj: unknown): string | null {`
6. `private static parseScrapeCreatorsTranscript(transcriptData: UnknownRecord): TranscriptSegment[] {`

(That is six methods — delete all six.)

- [ ] **Step 3: Delete the `YouTubeConfig` interface**

Near the top of the file, delete this interface in full (JSDoc comment through closing brace):

```ts
/**
 * YouTube configuration extracted from watch page
 */
interface YouTubeConfig {
    apiKey: string;
    clientVersion: string;
    visitorData: string | null;
    captionTracks: CaptionTrack[];
    metadata: TranscriptMetadata;
}
```

- [ ] **Step 4: Delete the three obsolete class statics**

In the `YouTubeTranscriptExtractor` static field block, delete these three lines:

```ts
    private static cookieStore: string = '';
```
```ts
    // Cache YouTube config after first extraction to avoid repeated HTML fetches within the same video request
    private static cachedConfig: YouTubeConfig | null = null;
    private static cachedVideoId: string | null = null;
```
```ts
    // Fallback client version if extraction fails (updated to current version)
    private static readonly FALLBACK_CLIENT_VERSION = '2.20260128.05.00';
```

Keep `private static readonly USER_AGENT = ...` and the two `cachedPlayerData` / `cachedPlayerVideoId` statics added in Task 1.

- [ ] **Step 5: Remove the dead `cookieStore` header spread in `fetchCaptionTrackRaw`**

In the kept method `fetchCaptionTrackRaw`, the headers object ends with this line:

```ts
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
```

Delete that line. The line above it (`'DNT': '1',`) becomes the last header — make sure the resulting object is still valid (the trailing comma after `'DNT': '1'` is harmless and may stay). Do not change any other header in this method.

- [ ] **Step 6: Verify the build is clean**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. In particular, no "cannot find name" errors — if any appear, a deletion removed something still referenced; re-check Steps 1-5.

- [ ] **Step 7: Verify lint is clean**

Run: `npm run lint`
Expected: `0 errors, 0 warnings`. No `eslint-disable` comments may be added to achieve this.

- [ ] **Step 8: Commit**

```bash
git add src/youtube-transcript.ts
git commit -m "$(cat <<'EOF'
refactor: remove broken watch-page/ANDROID/MWEB/WEB transcript methods

Delete the four obsolete local transcript methods, their six helper
methods, the YouTubeConfig interface, and the now-unused statics. The
iOS player method added earlier is the sole local fallback.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Spec "New fallback ladder" (ScrapeCreators → iOS player → Supadata) → Task 2 Step 2. ✓
- Spec "`fetchIosPlayerData` helper" (constants, POST, playability checks, per-video cache) → Task 1 Steps 1-3. ✓
- Spec "`fetchViaIosPlayer` method" (videoDetails metadata, captionTracks, `pickBestTrack`, `fetchCaptionTrack` with iOS UA + tlang) → Task 1 Step 4. ✓
- Spec "Changed: `getVideoMetadata`" (re-pointed to `fetchIosPlayerData`, try/catch → `{}`, short-circuit removed) → Task 2 Step 3. ✓
- Spec "Deletions" (4 methods, 6 helpers, `YouTubeConfig`, statics `cachedConfig`/`cachedVideoId`/`FALLBACK_CLIENT_VERSION`/`cookieStore`, the `cookieStore` header spread) → Task 3 Steps 1-5. ✓
- Spec "video-ID change clears the player cache" → Task 2 Step 1. ✓
- Spec "Kept unchanged" (ScrapeCreators/Supadata, `pickBestTrack`, caption fetch/parse, `USER_AGENT`) → not touched by any task; Task 3 Step 4 explicitly keeps `USER_AGENT`. ✓
- Spec "Testing" (build + lint clean, no eslint-disable) → every task ends with build + lint steps. ✓
- No spec requirement is unaddressed.

**2. Placeholder scan:** No TBD/TODO/vague steps. Every code step shows complete code; every command shows expected output. ✓

**3. Type consistency:** `fetchIosPlayerData` returns `Promise<UnknownRecord>` and is consumed by `fetchViaIosPlayer` and `getVideoMetadata`, both treating the result via `isRecord`/`isString` guards on `data.videoDetails` / `data.playabilityStatus` / `data.captions`. `fetchViaIosPlayer` returns `Promise<TranscriptResult>` and is called in `fetchTranscript`'s `[2]` block expecting `result.segments`. The cache statics `cachedPlayerData: UnknownRecord | null` / `cachedPlayerVideoId: string | null` are written in `fetchIosPlayerData`, reset in `fetchTranscript` Step 1, and read in `fetchTranscript` Step 2's catch block — names consistent throughout. `CaptionTrack` shape matches the existing interface. ✓
