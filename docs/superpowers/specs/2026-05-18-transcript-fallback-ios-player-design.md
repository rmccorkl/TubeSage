# Transcript fallback: replace broken local methods with the iOS InnerTube player — design

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan

## Goal

The free local transcript-extraction fallbacks in `src/youtube-transcript.ts` no longer work. Replace all of them with a single local method built from the YouTube iOS InnerTube player approach documented in `youtube-transcript-fetch-spec.md` (cloned from `lstrzepek/obsidian-yt-transcript`). The two paid-service paths (ScrapeCreators, Supadata) are unchanged. The result is a shorter, more reliable transcript module with one working local fallback.

## Background

`YouTubeTranscriptExtractor.fetchTranscript` (`src/youtube-transcript.ts`) currently runs a six-rung ladder:

1. ScrapeCreators paid API (when `scrapcreatorsApiKey` is set)
2. Watch-page captions — scrapes `ytInitialPlayerResponse.captionTracks` out of the watch-page HTML
3. ANDROID Player API
4. MWEB Player API
5. WEB `youtubei/v1/next` → `youtubei/v1/get_transcript`
6. Supadata paid API (when `supadataApiKey` is set)

Rungs 2–5 are the free local methods. They have all stopped working: the spec records that the Android client stopped returning captions in early 2026, and the WEB `get_transcript` route is brittle (`FAILED_PRECONDITION`, session/visitor binding). The user has confirmed all four free local methods fail.

The spec describes a method that still works: a single `POST` to YouTube's InnerTube `youtubei/v1/player` endpoint using the **iOS** client identity. The iOS player response still exposes `captionTracks[].baseUrl` values that can be downloaded directly without PO tokens, and it also carries `videoDetails` (title, author).

The ScrapeCreators and Supadata paths return only transcript text, so they call `getVideoMetadata(videoId)` separately for the note's title/author. Today `getVideoMetadata` is backed by the watch-page HTML scrape (`getYouTubeConfig` → `fetchWatchPageHtml`). Since the iOS player response already contains `videoDetails`, `getVideoMetadata` is re-pointed at the iOS player call, which removes the watch-page HTML mechanism entirely.

## Change

### New fallback ladder

`fetchTranscript` runs a three-rung ladder:

1. **ScrapeCreators paid API** — when `scrapcreatorsApiKey` is set. Unchanged (`fetchViaScrapeCreators`).
2. **iOS InnerTube player** — new method `fetchViaIosPlayer`. Always attempted (no key required).
3. **Supadata paid API** — when `supadataApiKey` is set. Unchanged (`fetchViaSupadata`).

The surrounding control flow is unchanged in shape: each method's failure is recorded in the `attempts` array; if every method fails, the existing CORS/network error-message mapping and the "return metadata despite caption failure" partial-result behavior still apply.

### New: `fetchIosPlayerData(videoId, options)` helper

A private static method that performs the iOS InnerTube player call and returns the parsed JSON response.

- Constants (module-level `const`s in the file):
  - `INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"` — YouTube's public InnerTube key, from the spec.
  - `INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?key=" + INNERTUBE_API_KEY`
  - `IOS_USER_AGENT = "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)"`
  - `IOS_CLIENT_VERSION = "20.10.38"`
- Request: `POST` via `obsidianFetch` to `INNERTUBE_PLAYER_URL` with
  - headers `Content-Type: application/json`, `User-Agent: IOS_USER_AGENT`
  - body `JSON.stringify({ context: { client: { clientName: "IOS", clientVersion: IOS_CLIENT_VERSION, hl: options.lang || "en", gl: options.country || "US" } }, videoId })`
- On a non-OK HTTP response, throw `Error("iOS Player API error: HTTP <status>")`.
- Parse the response body as JSON.
- Playability checks (from the spec) on `data.playabilityStatus`:
  - `status === "ERROR"` → throw `Error(reason || "Video unavailable")`
  - `status === "LOGIN_REQUIRED"` → throw `Error("This video requires login to view")`
  - `status === "UNPLAYABLE"` → throw `Error(reason || "Video is unplayable")`
- **Caching:** the parsed response is cached in a single-entry per-video cache (`cachedPlayerData` + `cachedPlayerVideoId` statics), mirroring how `cachedConfig`/`cachedVideoId` work today. A subsequent call for the same `videoId` returns the cached object without a second POST. `fetchTranscript` clears the cache when the `videoId` changes (the existing cache-reset block is repurposed to clear `cachedPlayerData`/`cachedPlayerVideoId`).

### New: `fetchViaIosPlayer(videoId, options)` method

A private static method returning `TranscriptResult`.

- Calls `fetchIosPlayerData(videoId, options)`.
- Metadata: read `data.videoDetails` → `{ title, author }` (each used only when it is a string), producing a `TranscriptMetadata`.
- Caption tracks: read `data.captions?.playerCaptionsTracklistRenderer?.captionTracks`. If missing or empty, throw `Error("No captions available for this video")`.
- Map the raw tracks to the existing `CaptionTrack` interface (`languageCode`, `kind`, `baseUrl`, `vssId`, `isTranslatable`).
- Select a track with the **existing** `pickBestTrack(tracks, options.lang || "en")`. If it returns null or the track has no `baseUrl`, throw `Error("No suitable caption track with baseUrl found")`.
- Download and parse with the **existing** `fetchCaptionTrack(baseUrl, tlang, IOS_USER_AGENT)` — passing `IOS_USER_AGENT` so the caption fetch keeps a consistent client identity, and `tlang` set to the requested language only when `pickBestTrack` reported `useTlang`.
- Return `{ segments, metadata }`.

### Changed: `getVideoMetadata(videoId)`

Re-pointed from the watch-page HTML scrape to the iOS player call:

- Calls `fetchIosPlayerData(videoId, {})` and returns `{ title, author }` from `data.videoDetails` (string fields only).
- Keeps its existing `try/catch` that returns `{}` on any failure — metadata extraction remains non-fatal, so a ScrapeCreators or Supadata transcript still succeeds even if the iOS metadata call fails.
- The current cached-metadata short-circuit at the top of `getVideoMetadata` (which reads `cachedConfig.metadata`) is removed: `fetchIosPlayerData` is itself cached per `videoId`, so calling it directly already avoids a redundant POST. The method body becomes just the `fetchIosPlayerData` call wrapped in the existing `try/catch`.

### Deletions

Remove the following from `src/youtube-transcript.ts`, along with any imports/types that become unused:

- Methods: `fetchViaWatchPage`, `fetchViaPlayerApiAndroid`, `fetchViaPlayerApiMWEB`, `fetchViaWebScrapeCreators`.
- Helpers used only by those methods: `getYouTubeConfig`, `fetchWatchPageHtml`, `extractJsonFromHtml`, `extractMetadataFromNextData`, `findTranscriptEndpoint`, `parseScrapeCreatorsTranscript`.
- The `YouTubeConfig` interface.
- Statics that become unused: `cachedConfig`, `cachedVideoId`, `FALLBACK_CLIENT_VERSION`, and `cookieStore` (`cookieStore` is already never assigned anywhere in the file, so the `...(cookieStore && { Cookie })` spreads it feeds are already dead — they are removed with it).

### Kept unchanged

`fetchViaScrapeCreators`, `fetchViaSupadata`, `pickBestTrack`, `fetchCaptionTrack`, `fetchCaptionTrackWithFormat`, `fetchCaptionTrackRaw`, `parseCaptionTrackResponse`, `parseXmlCaptions`, `makeAbsoluteUrl`, `extractVideoId`, `isValidVideoId`, the `CaptionTrack` / `TranscriptSegment` / `TranscriptOptions` / `TranscriptMetadata` / `TranscriptResult` interfaces, and the outer error handling in `fetchTranscript` (CORS/network mapping, partial-metadata fallback segment).

Note: `fetchCaptionTrackRaw` currently includes a `...(cookieStore && { Cookie })` header spread. With `cookieStore` removed, that spread is deleted; the rest of `fetchCaptionTrackRaw` (User-Agent, Accept, Origin, Referer, DNT headers) is unchanged.

## Data flow

- Transcript request → `fetchTranscript(videoId, options)`.
- If `scrapcreatorsApiKey`: try `fetchViaScrapeCreators` → on success it calls `getVideoMetadata` (one iOS player POST) and returns.
- Else / on ScrapeCreators failure: try `fetchViaIosPlayer` → one iOS player POST (cached), select track, download caption track, return segments + metadata (no extra metadata call — `videoDetails` is in the same response).
- On iOS failure, if `supadataApiKey`: try `fetchViaSupadata` → on success it calls `getVideoMetadata` (one iOS player POST, cache reused if warm) and returns.
- All fail → existing aggregate error / partial-metadata behavior.

## Error handling and edge cases

- iOS player non-OK HTTP → throw with the status; recorded in `attempts`.
- `playabilityStatus` ERROR / LOGIN_REQUIRED / UNPLAYABLE → throw the spec's messages; recorded in `attempts`.
- No `captionTracks` in the iOS response → throw `"No captions available for this video"`.
- Caption-track download empty for all formats → the existing `fetchCaptionTrack` already throws `"Caption track returned empty response for all format attempts"`.
- `getVideoMetadata` failure stays non-fatal (`try/catch` → `{}`).
- Video-ID change mid-session clears the player cache, exactly as the config cache is cleared today.

## Out of scope

- No change to ScrapeCreators or Supadata request/response handling.
- No change to caption parsing (`json3`/`srv3`/XML) or `pickBestTrack`.
- No change to settings, UI, or the info icons added in the 1.3.4 batch.
- The `youtube-transcript-fetch-spec.md` file itself is not copied into the repo; only the method is implemented.

## Testing

This repo has no unit-test framework, and `src/youtube-transcript.ts` hits live YouTube endpoints. Verification:

- `npm run build` clean (tsc strict + esbuild) — in particular, confirm no dangling references to the deleted methods/helpers/interface and no unused-symbol errors.
- `npm run lint` clean (`0 errors, 0 warnings`). No `eslint-disable` comments may be added.
- Manual run in a dev vault, on both desktop and mobile:
  - With no ScrapeCreators/Supadata key configured: extracting a transcript from a normal captioned video succeeds via the iOS player method.
  - A video with no captions reports "No captions available for this video".
  - With a ScrapeCreators key configured: ScrapeCreators still runs first and the resulting note still has the correct title/author (metadata now sourced from the iOS player call).
