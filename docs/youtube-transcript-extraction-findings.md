# YouTube Transcript Extraction (TubeSage) — Findings & Next Steps

## TL;DR

TubeSage’s “local transcript” extraction relied on YouTube’s **private** `youtubei` endpoints.

- **Phase 1 (WEB / ScrapeCreators method):** call `youtubei/v1/next` to discover transcript params, then call `youtubei/v1/get_transcript`.
- **Phase 2 (ANDROID spoof):** call `youtubei/v1/player` as an Android client to obtain `captionTracks[].baseUrl`, then download captions via that URL.
- **Current state (as of 2026-03-05):** both `youtubei/v1/player` (ANDROID) and `youtubei/v1/get_transcript` (WEB) are failing with `HTTP 400` `FAILED_PRECONDITION` (“Precondition check failed.”). This appears to be YouTube tightening request integrity/session requirements, making the private API approach brittle.

This document captures what we implemented, how it evolved, what’s failing now, and the recommended path forward.

---

## Context

TubeSage extracts transcripts to:

- create timestamped notes in Obsidian
- feed the transcript into LLM summarization
- support multiple fallbacks when YouTube transcript retrieval fails

All network requests go through Obsidian’s `requestUrl` via the shim:

- `src/utils/fetch-shim.ts`

The transcript code lives in:

- `src/youtube-transcript.ts`

---

## Phase 1 — WEB transcript extraction (ScrapeCreators two-step approach)

Reference article (conceptual basis, not copied here):

- https://scrapecreators.com/blog/how-to-scrape-youtube-transcripts-with-node-js-in-2025

### How it works (TubeSage implementation)

1. **Fetch the watch page** (`/watch?v=VIDEO_ID`) to extract dynamic config:
   - `INNERTUBE_API_KEY`
   - `INNERTUBE_CLIENT_VERSION`
   - `VISITOR_DATA`

   Implemented in `YouTubeTranscriptExtractor.getYouTubeConfig()`:

   - `src/youtube-transcript.ts`

2. **Call `youtubei/v1/next`** to get transcript “params”:
   - POST `https://www.youtube.com/youtubei/v1/next?prettyPrint=false`
   - body includes `{ context: { client: { clientName: "WEB", clientVersion, visitorData } }, videoId }`
   - then recursively search the JSON for `getTranscriptEndpoint.params`

3. **Call `youtubei/v1/get_transcript`** with those params:
   - POST `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false`
   - body includes `{ context: { client: { clientName: "WEB", clientVersion, visitorData } }, params }`
   - parse transcript segments from the returned structure (`cueGroups`, `initialSegments`, etc.)

### Why we moved away from this approach

This is a private API and historically has been prone to returning `HTTP 400` responses (even when `next` succeeds). The code comments already acknowledge this brittleness:

- “WEB client with ScrapeCreators method … often fails with HTTP 400”

---

## Phase 2 — ANDROID client spoof (Player API → captionTracks → timedtext download)

### Why this was added

When the WEB `get_transcript` flow became unreliable, we added a more reliable path:

- call `youtubei/v1/player` **as an ANDROID client**
- extract `captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`
- download captions directly from that `baseUrl` (forcing `fmt=json3`)

This avoids `get_transcript` entirely and leverages the caption track URL YouTube returns to clients.

### How it works (TubeSage implementation)

1. **Call `youtubei/v1/player`** with Android client context:
   - POST `https://www.youtube.com/youtubei/v1/player?key=<INNERTUBE_API_KEY>&prettyPrint=false`
   - `context.client.clientName = "ANDROID"`
   - Android UA + `X-Youtube-Client-Name: 3`

   Implemented in:

   - `YouTubeTranscriptExtractor.fetchViaPlayerApiAndroid()` (`src/youtube-transcript.ts`)

2. **Pick a caption track** (prefer matching `lang`, else first track).

3. **Fetch captions** from `captionTracks[].baseUrl`:
   - add/replace `fmt=json3`
   - parse JSON3 (or XML variants) into `TranscriptSegment[]`

   Implemented in:

   - `YouTubeTranscriptExtractor.fetchCaptionTrack()` (`src/youtube-transcript.ts`)

---

## Current failure (2026-03-05): `FAILED_PRECONDITION` on both paths

### Observed behavior

Recent logs show:

- `youtubei/v1/player` (ANDROID) → `HTTP 400` `FAILED_PRECONDITION`
- `youtubei/v1/next` (WEB) → `HTTP 200` (still succeeds)
- `youtubei/v1/get_transcript` (WEB) → `HTTP 400` `FAILED_PRECONDITION`

The error shape returned by YouTube looks like:

```json
{
  "error": {
    "code": 400,
    "message": "Precondition check failed.",
    "status": "FAILED_PRECONDITION"
  }
}
```

### What this likely means

This isn’t an LLM/provider issue; transcript extraction is failing upstream.

`FAILED_PRECONDITION` from `youtubei` generally indicates YouTube is rejecting requests that don’t meet newer **integrity**, **session binding**, or **anti-automation** requirements. Because `youtubei` is private/unsupported, changes like this can (and do) happen without warning.

---

## Impact on TubeSage

When all extraction paths fail, TubeSage:

- may still return metadata (title/author) if it was successfully extracted
- writes a placeholder transcript line indicating extraction failure

Note: the placeholder message currently says “ANDROID, WEB, and Supadata methods all failed” even when Supadata wasn’t configured (Supadata only runs when an API key is provided). This is just messaging accuracy, not the root cause.

---

## Recommended next steps (more robust, less “signature chasing”)

### 1) Prefer watch-page captions over `youtubei` (recommended)

Instead of calling private `youtubei` endpoints, fetch the watch HTML and parse:

- `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`

TubeSage already parses `ytInitialPlayerResponse` for metadata in:

- `YouTubeTranscriptExtractor.getVideoMetadata()` (`src/youtube-transcript.ts`)

Extending that to retrieve caption tracks and download captions via `baseUrl` should be more resilient than continuing to chase `youtubei` preconditions.

### 2) Add a public captions fallback (`/api/timedtext`)

When `captionTracks` aren’t present in `ytInitialPlayerResponse`, attempt the public caption endpoints (language list + download) as a best-effort fallback.

### 3) Keep `youtubei` paths as “experimental”

If we keep ANDROID spoof / `get_transcript`:

- hide behind a toggle (default off)
- fail fast on `FAILED_PRECONDITION` (don’t loop/retry)
- make the user-facing error explicit (“YouTube blocked internal API; try alternate extraction mode or a transcript service”)

### 4) Optional: third-party transcript service

TubeSage already includes a Supadata fallback when configured. This can remain a reliable alternative when YouTube blocks local extraction.

---

## Appendix — Code map

- Main orchestrator / fallbacks: `YouTubeTranscriptExtractor.fetchTranscript()` (`src/youtube-transcript.ts`)
- Config extraction from watch HTML: `YouTubeTranscriptExtractor.getYouTubeConfig()` (`src/youtube-transcript.ts`)
- WEB two-step (ScrapeCreators-style): `youtubei/v1/next` → `youtubei/v1/get_transcript` (within `fetchTranscript()`)
- ANDROID spoof via `youtubei/v1/player`: `YouTubeTranscriptExtractor.fetchViaPlayerApiAndroid()` (`src/youtube-transcript.ts`)
- Caption download + parsing: `YouTubeTranscriptExtractor.fetchCaptionTrack()` (`src/youtube-transcript.ts`)
- HTTP shim used everywhere: `obsidianFetch()` (`src/utils/fetch-shim.ts`)

