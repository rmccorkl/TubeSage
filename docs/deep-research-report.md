# Restoring a “local directed” YouTube transcript fetch in a TypeScript/Obsidian codebase

## Executive summary

Your existing “local transcript” method broke because it depends on **private `youtubei` endpoints** (`/player`, `/get_transcript`) that are now returning `HTTP 400 FAILED_PRECONDITION` in your logs, making that path brittle and hard to “patch” reliably without chasing integrity/session requirements. fileciteturn0file0

The most robust local approach is to pivot to what the **watch page already exposes**: parse the `/watch?v=VIDEO_ID` HTML for the `ytInitialPlayerResponse` JSON object and read `captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`. Multiple independent implementations and fixes in the wild rely on this exact technique. citeturn1view2turn4view1turn7view0

Once you have `baseUrl`, fetch captions via YouTube’s timedtext endpoint using **`fmt=json3`** (or `fmt=vtt` if you prefer WebVTT). The `json3` payload is a structured event stream (`wireMagic: "pb3"`, `events[].tStartMs`, `events[].dDurationMs`, `events[].segs[].utf8`) that can be parsed into your `TranscriptSegment[]`. citeturn3search3turn12search5turn4view0

This report provides (a) a concrete implementation plan and (b) a drop‑in patch for `src/youtube-transcript.ts` to make `fetchTranscript()` reliable again, with explicit handling for language selection, translation (`tlang`), format parameter pitfalls (replace, don’t append), rate‑limiting, fallbacks, user‑visible error messaging, and tests.

## What broke and why the old method is brittle

Your project notes show two historic “local” phases: (1) WEB `next → get_transcript` and (2) ANDROID `player → captionTracks[].baseUrl → timedtext`. Both now fail with `FAILED_PRECONDITION` (`"Precondition check failed."`) as of **2026‑03‑05**. fileciteturn0file0

This failure pattern aligns with wider ecosystem evidence that YouTube frequently changes preconditions for internal API clients; for example, downloader and proxy projects report “precondition check failed” issues tied to client versions, A/B tests, or newly required tokens. citeturn11search0turn11search8turn11search2

The implication is pragmatic: treat `youtubei/*` as **experimental** and default to approaches that do not depend on internal request integrity. Your own findings already recommend moving to watch‑page parsing and timedtext downloads (and making internal endpoints opt‑in). fileciteturn0file0

A second operational reality is **throttling**: raw page/API fetches can hit `429 Too Many Requests`, and many tools work around this with deliberate slowing/backoff. citeturn2search2turn10view0

## Watch-page captions extraction design

**Core idea:** fetch the watch HTML, extract `ytInitialPlayerResponse`, read caption tracks, choose a track, then fetch captions from the track’s `baseUrl` in `json3`.

### Example objects you will parse

**`ytInitialPlayerResponse` (minimal sketch):**
```json
{
  "playabilityStatus": { "status": "OK" },
  "captions": {
    "playerCaptionsTracklistRenderer": {
      "captionTracks": [
        {
          "baseUrl": "https://www.youtube.com/api/timedtext?...&lang=en&v=VIDEO_ID&fmt=srv3&...",
          "languageCode": "en",
          "vssId": ".en",
          "kind": "asr",
          "isTranslatable": true
        }
      ]
    }
  }
}
```
The object path `captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl` is widely used as the entry point for downloading captions. citeturn1view2turn4view1turn7view0

Field names like `baseUrl`, `vssId`, `languageCode`, and optional `kind` are consistent with multiple open implementations and type definitions. citeturn4view0turn4view1turn0search22

**`json3` timedtext response shape (minimal sketch):**
```json
{
  "wireMagic": "pb3",
  "events": [
    { "tStartMs": 80, "dDurationMs": 3119, "segs": [ { "utf8": "hey" }, { "utf8": " everybody" } ] }
  ]
}
```
The `wireMagic: "pb3"` marker and `events[].segs[].utf8` text fragments (with per‑event timing`) are documented by real payload examples and consumer code. citeturn3search3turn12search5turn4view0

### Robust extraction from watch HTML

Many “quick scripts” do brittle string splits on `ytInitialPlayerResponse = ...` and terminate on `;var` or `;</script>`. citeturn4view1turn4view2turn7view0

For a plugin you ship, the robust pattern is:

* Locate the marker: `ytInitialPlayerResponse` (handle `var ytInitialPlayerResponse =` and `ytInitialPlayerResponse =` variants). citeturn7view0turn4view1  
* From the first `{` after the marker, extract a **balanced JSON object** using brace counting while respecting strings/escapes (so nested objects don’t break and `}` inside strings is ignored). This is an implementation technique (not YouTube‑specific), but it directly addresses the brittleness shown in split‑based examples. citeturn4view1turn7view0

If you already parse `ytInitialPlayerResponse` for metadata, extend that code to also read `captionTracks`. Your own notes say you already parse it for metadata; this change is a small increment. fileciteturn0file0

### Language selection heuristics that work in practice

Empirically (and in multiple reference scripts/libraries):

* `kind === "asr"` indicates **auto‑generated** captions. citeturn1view1turn12search20turn4view1  
* `vssId` often encodes track type and language; examples show leading `.` for “regular” and `a.` for auto‑generated (`a.en`). citeturn4view0turn4view1  
* If the desired language isn’t available, you can request **machine translation** via `tlang=<targetLanguage>` on the timedtext URL (this is used by practical scripts; treat the result as machine translation quality). citeturn4view1turn9search1

A pragmatic heuristic for a note‑taking plugin:

1. Prefer **manual** captions in requested language (exact match on BCP‑47, then base language match).  
2. Else prefer **manual captions in any language** then use `tlang` to translate to requested base language (e.g., `en` for `en-GB`). citeturn4view1turn9search1  
3. Else prefer **auto** captions in requested language. citeturn1view1turn4view1  
4. Else pick the “best available” track (manual first, then auto) and optionally translate. citeturn4view1turn1view1  

### Query parameters that matter

**`fmt`**: You should request `fmt=json3` if you want structured segment timing and easy parsing. citeturn3search3turn4view1turn4view0  

However, multiple sources warn that you must **replace** an existing `fmt=srv3` rather than append another `&fmt=...` because duplicates may cause the first `fmt` to win. citeturn2search1turn4view0turn1view1  

**`tlang`**: Add `tlang=<lang>` only when you are intentionally requesting a translation. citeturn4view1turn9search1  

**Alternative formats**: timedtext can return WebVTT (useful for compatibility) via `fmt=vtt`, and other formats exist in tooling outputs. citeturn0search1turn2search4turn12search14  

### Signature/cipher handling for caption URLs

In most implementations that read `captionTracks`, the captions URL is provided as a working `baseUrl` you can request directly. citeturn1view2turn4view1turn7view0  

If you encounter a track that provides a cipher string (rare for captions, common for streaming formats), then:
* If the cipher contains an already‑deciphered `sig`/`signature`, you can reconstruct the URL by appending it.  
* If it contains an encrypted `s=` signature, full deciphering requires parsing YouTube player JS (high complexity, brittle; generally outside a “lightweight Obsidian plugin” scope). Evidence from downloader tooling shows signature extraction is a moving target and can fail when preconditions change. citeturn11search8turn2search10turn0search10  

The plan below implements “best effort” support for cipher strings that already include `sig`, and provides clear error surfaces when deciphering would be required.

### Rate limiting and fail-fast policy

Given the repeated evidence of throttling and precondition failures, your plugin should:
* Retry only **transient** failures (timeouts, selected 5xx, and 429 with `Retry-After`). citeturn2search2turn11search12turn10view0  
* Fail fast (no retries) on deterministic failures like `FAILED_PRECONDITION` from internal endpoints. citeturn11search8turn11search0turn0file0  

## Step-by-step implementation plan and drop-in TypeScript patch

### Implementation plan

**Step one: implement a first-class “watch-page captions” method**
1. `fetchWatchHtml(videoId)` to GET `/watch?v=...` with a stable browser UA and `Accept-Language: en-GB`. citeturn4view1turn7view0  
2. If the HTML indicates consent interstitial or missing player JSON, retry once with a `CONSENT=YES+1` cookie (best-effort). citeturn8search1  
3. `extractInitialPlayerResponse(html)` using brace-balanced extraction. (This replaces brittle split tricks.) citeturn7view0turn4view1  
4. Read `captionTracks` and select with `pickTrack(tracks, requestedLang)`. citeturn1view2turn4view1turn0search22  
5. Build a final caption URL:
   * replace existing `fmt` with `json3` (don’t append duplicates). citeturn2search1turn4view0  
   * add `tlang` only if you decided to translate. citeturn4view1turn9search1  
6. `fetchCaptionTrack(url)` and parse `json3` events into segments. citeturn3search3turn12search5  

**Step two: add fallbacks**
1. Timedtext list fallback: call `https://www.youtube.com/api/timedtext?type=list&v=VIDEO_ID` to enumerate tracks if the watch page didn’t expose `captionTracks`. citeturn12search1  
2. `youtubei` fallback behind an explicit **experimental** toggle (default off), fail fast on `FAILED_PRECONDITION`, as your own notes recommend. fileciteturn0file0  
3. Third-party Supadata fallback when configured (unchanged conceptually; just make messaging accurate). fileciteturn0file0  

**Step three: improve UX/error reporting**
Record which methods were attempted and only mention those in user-visible output (your notes call out current inaccurate messaging). fileciteturn0file0  

### Mermaid decision flow for `fetchTranscript`

```mermaid
flowchart TD
  A[fetchTranscript(videoId, lang)] --> B[GET /watch HTML]
  B -->|consent/page incomplete| B2[Retry with CONSENT cookie]
  B --> C[Extract ytInitialPlayerResponse]
  C -->|captionTracks present| D[Pick best caption track]
  C -->|no captionTracks| E[Timedtext type=list fallback]
  D --> F[Build URL: fmt=json3 + optional tlang]
  F --> G[GET timedtext JSON3]
  G --> H[Parse events -> TranscriptSegment[]]
  E -->|track found| F
  E -->|none| I[Optional: experimental youtubei fallback]
  I -->|success| H
  I -->|FAILED_PRECONDITION/blocked| J[Optional: Supadata fallback]
  J -->|success| H
  J -->|fail| K[Surface clear error + attempted methods]
```

### Drop-in TypeScript patch

This patch assumes a typical Obsidian plugin pattern:
* Your network layer is `obsidianFetch(...)` wrapping `requestUrl`. fileciteturn0file0  
* You already have (or can add) a `TranscriptSegment` type and a class/namespace containing `fetchTranscript()`.

You will likely need to adjust imports and return types to match your existing code, but the functions below are intentionally “drop‑in”: `fetchWatchHtml`, `extractInitialPlayerResponse`, `pickTrack`, and `fetchCaptionTrack` are explicitly provided.

```ts
// src/youtube-transcript.ts
// Drop-in patch: prefer watch-page captionTracks -> timedtext json3, with robust parsing and fallbacks.
//
// Notes:
// - Do not append fmt=json3 if fmt already exists; replace it.
// - tlang is optional; use only when you want machine translation.
// - youtubei endpoints should be behind an explicit experimental toggle.

type TranscriptSegment = {
  text: string;
  start: number;     // seconds
  duration: number;  // seconds
};

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string; // e.g. "en", "en-GB"
  vssId?: string;        // e.g. ".en", "a.en"
  kind?: string;         // "asr" means auto-generated
  isTranslatable?: boolean;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
  // Some implementations may also encounter cipher-style fields.
  signatureCipher?: string;
};

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      translationLanguages?: Array<{ languageCode?: string; languageName?: any }>;
    };
  };
};

type FetchTranscriptOptions = {
  lang?: string; // preferred language, e.g. "en-GB"
  enableExperimentalYoutubei?: boolean; // default false
  enableTimedtextListFallback?: boolean; // default true
  enableSupadataFallback?: boolean; // existing behaviour
  debug?: boolean;
};

class YoutubeTranscriptError extends Error {
  public readonly code:
    | "NO_CAPTIONS"
    | "UNPLAYABLE"
    | "CONSENT_REQUIRED"
    | "RATE_LIMITED"
    | "NETWORK"
    | "PARSE"
    | "EXPERIMENTAL_BLOCKED"
    | "UNKNOWN";
  public readonly attempts: string[];

  constructor(code: YoutubeTranscriptError["code"], message: string, attempts: string[] = []) {
    super(message);
    this.code = code;
    this.attempts = attempts;
  }
}

// You already have this in your codebase (per your notes).
// Adjust signature to your fetch shim.
async function obsidianFetchText(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
  // Replace with your actual shim (requestUrl wrapper).
  // Must return: { status: number, headers: Record<string,string>, text: string }
  throw new Error("obsidianFetchText not wired");
}

async function obsidianFetchJson(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
  // Replace with your actual shim.
  throw new Error("obsidianFetchJson not wired");
}

export class YouTubeTranscriptExtractor {
  private static readonly WATCH_BASE = "https://www.youtube.com/watch?v=";
  private static readonly TIMEDTEXT_LIST = "https://www.youtube.com/api/timedtext?type=list&v=";

  // A stable browser UA is used by many extractor fixes.
  private static readonly USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

  public async fetchTranscript(videoIdOrUrl: string, opts: FetchTranscriptOptions = {}): Promise<TranscriptSegment[]> {
    const attempts: string[] = [];
    const requestedLang = (opts.lang ?? "en-GB").trim();

    const videoId = this.extractVideoId(videoIdOrUrl);

    // 1) Prefer watch-page captions (local directed)
    try {
      attempts.push("watch-page");
      const html = await fetchWatchHtml(videoId, { lang: requestedLang, debug: !!opts.debug });

      const player = extractInitialPlayerResponse(html);
      const playStatus = player?.playabilityStatus?.status;

      if (playStatus && playStatus !== "OK") {
        // UNPLAYABLE, LOGIN_REQUIRED, AGE_RESTRICTED, etc.
        throw new YoutubeTranscriptError(
          "UNPLAYABLE",
          `Video is not playable without additional access (playabilityStatus=${playStatus}).`,
          attempts
        );
      }

      const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (!tracks.length) {
        throw new YoutubeTranscriptError("NO_CAPTIONS", "No captionTracks found in ytInitialPlayerResponse.", attempts);
      }

      const trackPick = pickTrack(tracks, requestedLang);

      const finalUrl = buildCaptionUrl(trackPick, requestedLang);

      attempts.push("timedtext-json3");
      const segments = await fetchCaptionTrack(finalUrl, { debug: !!opts.debug });

      if (!segments.length) {
        throw new YoutubeTranscriptError("NO_CAPTIONS", "Caption download succeeded but produced 0 segments.", attempts);
      }
      return segments;
    } catch (err) {
      if (opts.debug) console.warn("watch-page method failed:", err);
      // continue fallbacks
    }

    // 2) Timedtext list fallback (public-ish)
    if (opts.enableTimedtextListFallback !== false) {
      try {
        attempts.push("timedtext-list");
        const tracks = await fetchTimedtextTrackList(videoId);

        if (tracks.length) {
          const trackPick = pickTrack(tracks, requestedLang);
          const finalUrl = buildCaptionUrl(trackPick, requestedLang);

          attempts.push("timedtext-json3");
          const segments = await fetchCaptionTrack(finalUrl, { debug: !!opts.debug });
          if (segments.length) return segments;
        }
      } catch (err) {
        if (opts.debug) console.warn("timedtext-list fallback failed:", err);
      }
    }

    // 3) Experimental youtubei fallback (default off)
    if (opts.enableExperimentalYoutubei) {
      try {
        attempts.push("youtubei-experimental");
        // Wire to your existing youtubei implementation, but fail-fast on FAILED_PRECONDITION.
        // const segments = await this.fetchViaYoutubei(videoId, requestedLang);
        // if (segments.length) return segments;
      } catch (err: any) {
        // If it's FAILED_PRECONDITION, do NOT retry.
        throw new YoutubeTranscriptError(
          "EXPERIMENTAL_BLOCKED",
          "YouTube blocked internal API (FAILED_PRECONDITION). Try watch-page mode or Supadata.",
          attempts
        );
      }
    }

    // 4) Supadata fallback (if configured) – keep existing behaviour
    // attempts.push("supadata");
    // if (opts.enableSupadataFallback) return await this.fetchViaSupadata(...)

    throw new YoutubeTranscriptError(
      "NO_CAPTIONS",
      `Could not obtain captions. Attempted: ${attempts.join(", ")}.`,
      attempts
    );
  }

  private extractVideoId(input: string): string {
    // Keep your existing implementation if you already have one.
    // This is intentionally permissive and mirrors common patterns.
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

    // Try URL parsing first
    try {
      const u = new URL(trimmed);
      if (u.hostname === "youtu.be") {
        const id = u.pathname.replace("/", "");
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
      }
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      // /shorts/ID or /embed/ID
      const m = u.pathname.match(/\/(shorts|embed)\/([a-zA-Z0-9_-]{11})/);
      if (m?.[2]) return m[2];
    } catch {
      // fall through
    }

    // Regex fallback
    const m = trimmed.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:\b|$)/);
    if (m?.[1]) return m[1];

    throw new YoutubeTranscriptError("PARSE", "Unable to extract YouTube video ID from input.", []);
  }
}

// --- watch page fetch + consent handling ---

async function fetchWatchHtml(
  videoId: string,
  opts: { lang: string; debug: boolean }
): Promise<string> {
  const url = `${YouTubeTranscriptExtractor.WATCH_BASE}${videoId}&hl=${encodeURIComponent(opts.lang)}`;

  const headersBase: Record<string, string> = {
    "User-Agent": YouTubeTranscriptExtractor.USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  };

  // First attempt without consent cookie
  const res1 = await obsidianFetchText(url, { headers: headersBase, timeoutMs: 15000 });
  if (res1.status === 429) {
    throw new YoutubeTranscriptError("RATE_LIMITED", "YouTube returned 429 while fetching watch HTML.", ["watch-page"]);
  }
  if (looksLikeConsentPage(res1.text)) {
    // Best-effort retry with a minimal CONSENT cookie.
    // NOTE: This may not work in all regions or in the future.
    const headers2 = { ...headersBase, "Cookie": "CONSENT=YES+1" };
    const res2 = await obsidianFetchText(url, { headers: headers2, timeoutMs: 15000 });
    if (looksLikeConsentPage(res2.text)) {
      throw new YoutubeTranscriptError("CONSENT_REQUIRED", "YouTube consent page blocked transcript extraction.", ["watch-page"]);
    }
    return res2.text;
  }

  return res1.text;
}

function looksLikeConsentPage(html: string): boolean {
  // Heuristics: consent host or typical consent interstitial markers.
  const h = html.toLowerCase();
  return h.includes("consent.youtube.com") || h.includes("before you continue") || h.includes("consent.google.com");
}

// --- ytInitialPlayerResponse extraction (brace-balanced) ---

function extractInitialPlayerResponse(html: string): PlayerResponse {
  // Try a few marker variants seen in the wild.
  const markers = [
    "var ytInitialPlayerResponse =",
    "ytInitialPlayerResponse =",
  ];
  for (const m of markers) {
    const idx = html.indexOf(m);
    if (idx === -1) continue;

    const startBrace = html.indexOf("{", idx);
    if (startBrace === -1) continue;

    const jsonText = extractBalancedJsonObject(html, startBrace);
    try {
      return JSON.parse(jsonText) as PlayerResponse;
    } catch (e: any) {
      throw new YoutubeTranscriptError("PARSE", `Failed to parse ytInitialPlayerResponse JSON (${e?.message ?? "unknown"}).`, ["watch-page"]);
    }
  }

  throw new YoutubeTranscriptError("PARSE", "ytInitialPlayerResponse not found in watch HTML.", ["watch-page"]);
}

function extractBalancedJsonObject(text: string, startIndex: number): string {
  // Brace counting with string/escape awareness.
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  throw new YoutubeTranscriptError("PARSE", "Unterminated JSON object while extracting ytInitialPlayerResponse.", ["watch-page"]);
}

// --- caption track selection ---

function pickTrack(tracks: CaptionTrack[], requestedLang: string): CaptionTrack {
  const normReq = normaliseLangTag(requestedLang);
  const reqBase = normReq.split("-")[0];

  const scored = tracks.map((t) => {
    const lang = normaliseLangTag(t.languageCode ?? "");
    const vss = (t.vssId ?? "").toLowerCase();
    const isAuto = (t.kind ?? "").toLowerCase() === "asr" || vss.startsWith("a.");
    const isManual = !isAuto;

    let score = 0;

    // Exact language match
    if (lang === normReq) score += 100;
    // Base language match (en matches en-GB, etc.)
    if (lang && reqBase && lang.split("-")[0] === reqBase) score += 60;

    // Manual preferred
    if (isManual) score += 30;
    else score += 10;

    // vssId hints: ".en" (manual) vs "a.en" (auto)
    if (vss === `.${reqBase}`) score += 20;
    if (vss === `a.${reqBase}`) score += 10;

    // Prefer translatable tracks if we need fallback translation later
    if (t.isTranslatable) score += 5;

    return { t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.t ?? tracks[0];
}

function normaliseLangTag(tag: string): string {
  // Normalise "en_GB" -> "en-gb" and trim.
  return tag.trim().replace("_", "-").toLowerCase();
}

// --- caption URL construction (fmt/tlang + cipher handling) ---

function buildCaptionUrl(track: CaptionTrack, requestedLang: string): string {
  let baseUrl = track.baseUrl ?? "";

  // Best-effort: handle cipher-style URLs if baseUrl is missing.
  if (!baseUrl && track.signatureCipher) {
    baseUrl = tryBuildUrlFromSignatureCipher(track.signatureCipher);
  }

  if (!baseUrl) {
    throw new YoutubeTranscriptError("PARSE", "Caption track did not contain a usable baseUrl.", ["watch-page"]);
  }

  const u = new URL(baseUrl);

  // fmt must be replaced, not duplicated.
  u.searchParams.delete("fmt");
  u.searchParams.set("fmt", "json3");

  // Translation: only add tlang if we don't have the requested language directly.
  const trackLang = normaliseLangTag(track.languageCode ?? "");
  const reqBase = normaliseLangTag(requestedLang).split("-")[0];
  const trackBase = trackLang.split("-")[0];

  if (reqBase && trackBase && reqBase !== trackBase) {
    // Use base language for tlang to maximise acceptance (pragmatic).
    u.searchParams.set("tlang", reqBase);
  } else {
    u.searchParams.delete("tlang");
  }

  return u.toString();
}

function tryBuildUrlFromSignatureCipher(signatureCipher: string): string {
  // signatureCipher is typically a querystring: "url=...&sp=sig&sig=..."
  const p = new URLSearchParams(signatureCipher);
  const url = p.get("url");
  if (!url) return "";

  const sp = p.get("sp") ?? "signature";
  const sig = p.get("sig") ?? p.get("signature");

  if (sig) {
    const u = new URL(url);
    u.searchParams.set(sp, sig);
    return u.toString();
  }

  // Encrypted 's' would require deciphering player JS. We fail with a clear message.
  if (p.get("s")) {
    throw new YoutubeTranscriptError(
      "PARSE",
      "Caption URL requires signature deciphering (signatureCipher.s present). Not supported in local mode.",
      ["watch-page"]
    );
  }

  return url;
}

// --- timedtext json3 fetch + parse ---

async function fetchCaptionTrack(
  url: string,
  opts: { debug: boolean }
): Promise<TranscriptSegment[]> {
  const headers: Record<string, string> = {
    "User-Agent": YouTubeTranscriptExtractor.USER_AGENT,
    "Accept-Language": "en-GB,en;q=0.9",
  };

  const json = await obsidianFetchJson(url, { headers, timeoutMs: 15000 });

  // Adjust according to your shim: some return {status, json}, some return json only.
  const data = (json as any)?.json ?? json;

  if (!data || data.wireMagic !== "pb3") {
    // Some cases return XML if fmt wasn't applied correctly.
    throw new YoutubeTranscriptError("PARSE", "Unexpected caption payload (expected json3/pb3).", ["timedtext-json3"]);
  }

  const events = Array.isArray(data.events) ? data.events : [];
  const segments: TranscriptSegment[] = [];

  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs) || typeof ev.tStartMs !== "number") continue;

    const textRaw = ev.segs.map((s: any) => (typeof s?.utf8 === "string" ? s.utf8 : "")).join("");
    const text = cleanCaptionText(decodeHtmlEntities(textRaw));

    if (!text) continue;

    const start = ev.tStartMs / 1000;
    const duration = typeof ev.dDurationMs === "number" ? ev.dDurationMs / 1000 : 0;

    segments.push({ text, start, duration });
  }

  return segments;
}

function decodeHtmlEntities(input: string): string {
  // Lightweight decoder (no DOM dependency).
  // Expand as needed.
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function cleanCaptionText(s: string): string {
  // Keep this conservative; callers can do heavier post-processing.
  return s.replace(/\s+/g, " ").trim();
}

// --- timedtext type=list fallback (XML) ---

async function fetchTimedtextTrackList(videoId: string): Promise<CaptionTrack[]> {
  const url = `${YouTubeTranscriptExtractor.TIMEDTEXT_LIST}${videoId}`;
  const res = await obsidianFetchText(url, {
    headers: {
      "User-Agent": YouTubeTranscriptExtractor.USER_AGENT,
      "Accept-Language": "en-GB,en;q=0.9",
    },
    timeoutMs: 15000,
  });

  if (res.status === 429) {
    throw new YoutubeTranscriptError("RATE_LIMITED", "YouTube returned 429 while fetching timedtext track list.", ["timedtext-list"]);
  }
  if (res.status >= 400) {
    throw new YoutubeTranscriptError("NETWORK", `Timedtext tracklist request failed (HTTP ${res.status}).`, ["timedtext-list"]);
  }

  // Parse XML without DOM libs: a minimal regex parse for <track ... /> elements.
  const tracks: CaptionTrack[] = [];
  const re = /<track\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(res.text)) !== null) {
    const attrs = m[1];

    const langCode = matchXmlAttr(attrs, "lang_code");
    const name = matchXmlAttr(attrs, "name");
    const kind = matchXmlAttr(attrs, "kind"); // "asr" appears here for auto captions in many cases

    // Build a timedtext URL similar to what baseUrl would point to.
    // NOTE: name may need URL encoding.
    if (!langCode) continue;

    const timedtextUrl = new URL("https://www.youtube.com/api/timedtext");
    timedtextUrl.searchParams.set("v", videoId);
    timedtextUrl.searchParams.set("lang", langCode);
    if (name) timedtextUrl.searchParams.set("name", name);
    if (kind) timedtextUrl.searchParams.set("kind", kind);

    tracks.push({
      baseUrl: timedtextUrl.toString(),
      languageCode: langCode,
      kind,
      // crude vssId approximation (matches common conventions)
      vssId: (kind === "asr" ? `a.${langCode}` : `.${langCode}`),
      isTranslatable: true,
    });
  }

  return tracks;
}

function matchXmlAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`);
  const m = attrs.match(re);
  return m?.[1];
}
```

Key implementation choices in this patch are grounded in observed behaviour and reference implementations:

* `ytInitialPlayerResponse` is extracted from a script within the watch HTML and used to locate `captionTracks[].baseUrl`. citeturn7view0turn4view1turn1view2  
* Auto-generated tracks are identified via `kind: "asr"` and/or `vssId` conventions such as `a.en`. citeturn1view1turn4view0turn4view1  
* `fmt=json3` is used to get `wireMagic: "pb3"` + `events` and parse segments. citeturn3search3turn12search5turn4view0  
* Existing `fmt` is replaced rather than appended because duplicates can lead to XML output and parsing failures. citeturn2search1turn4view0  
* `type=list` timedtext fallback is a known endpoint used to enumerate caption tracks. citeturn12search1turn12search13  

### Example HTTP requests/responses you can use while debugging

**Fetch watch HTML and confirm `ytInitialPlayerResponse` exists:**
```bash
curl -L \
  -H "User-Agent: Mozilla/5.0" \
  -H "Accept-Language: en-GB,en;q=0.9" \
  "https://www.youtube.com/watch?v=VIDEO_ID&hl=en-GB"
```
The “watch-page captions” approach consists of parsing that HTML for `ytInitialPlayerResponse` and reading `captionTracks[].baseUrl`. citeturn1view2turn7view0turn4view1

**Fetch captions in JSON3 (preferred):**
```bash
curl -L \
  -H "User-Agent: Mozilla/5.0" \
  "https://www.youtube.com/api/timedtext?v=VIDEO_ID&lang=en&fmt=json3"
```
JSON3’s `wireMagic: "pb3"` and `events` structure is documented by real examples and consumer code. citeturn3search3turn12search5turn4view0

**Fetch captions as WebVTT (optional alternative):**
```bash
curl -L \
  "https://www.youtube.com/api/timedtext?v=VIDEO_ID&lang=en&fmt=vtt"
```
Appending `fmt=vtt` to a caption URL (or timedtext URL) is a known way to retrieve WebVTT captions. citeturn0search1turn12search14

**List tracks (fallback):**
```bash
curl -L "https://www.youtube.com/api/timedtext?type=list&v=VIDEO_ID"
```
The `type=list` endpoint is commonly referenced as a way to fetch caption track metadata. citeturn12search1

## Suggested tests and edge cases

The goal is to test your **parser invariants** (HTML extraction, URL rewriting, JSON3 parsing) without relying on live YouTube calls in CI.

### Unit tests

**Balanced JSON extraction**
* Input: a fixture HTML snippet containing `var ytInitialPlayerResponse = { ... };` with nested braces and string escapes.  
* Assert: `extractInitialPlayerResponse()` returns an object, and no truncation occurs when braces appear inside strings. This hardens you against brittle split hacks seen in quick fixes. citeturn4view1turn7view0  

**Track picking**
* Provide fixture `captionTracks` with:
  * manual `en`, manual `fr`, auto `en` (`kind: "asr"`), and `en-GB` variants  
* Assert: `pickTrack(..., "en-GB")` chooses manual `en-GB` if present, otherwise manual `en`, otherwise auto `en`. Conventions used by reference scripts indicate `.en` vs `a.en` distinctions. citeturn4view1turn4view0turn1view1  

**URL rewriting**
* Input URLs:
  * `...&fmt=srv3&...`  
  * `...&fmt=srv3&fmt=vtt&...`  
* Assert: result contains exactly one `fmt=json3`. This guards the known duplicate‑`fmt` pitfall. citeturn2search1turn4view0  

**JSON3 parsing**
* Fixture JSON with `wireMagic: "pb3"`, `events` including:
  * normal segments  
  * events with `segs: [{"utf8":"\n"}]`  
  * events with no `segs`  
* Assert: you skip empties and compute `start/duration` from ms fields. Real JSON3 examples show the timing fields and `segs[].utf8` pattern. citeturn3search3turn12search5  

**Timedtext list XML parsing**
* Fixture XML like:
  * `<track lang_code="en" name="English" />`
  * `<track lang_code="en" kind="asr" />`
* Assert: you produce `CaptionTrack[]` and set `kind` appropriately. The existence of `type=list` and `kind=asr` usage is documented in references. citeturn12search1turn12search6turn12search20  

### Integration tests (recommended as opt-in)

Live internet tests are inherently flaky due to throttling, locale consent gates, and page changes. Evidence from tools shows rate limiting and intermittent failures are normal. citeturn2search2turn10view0  

If you still want integration tests:
* Gate them behind an environment variable (e.g., `RUN_YOUTUBE_LIVE_TESTS=1`).  
* Use a small set of known public video IDs that you periodically refresh manually.  
* Assert only broad invariants: “segments length > 0” and “first segment start is a number”.

### Edge cases to explicitly support or surface as clear errors

* **No captions**: `captionTracks` missing or empty → user-facing “No captions available for this video.” (common). fileciteturn0file0  
* **Unplayable / restricted**: `playabilityStatus.status != "OK"` (e.g., login/age restricted) → explain that local extraction can’t proceed without authentication. fileciteturn0file0  
* **Consent interstitial**: if watch HTML is a consent page, retry with consent cookie; if still blocked, show a consent-specific error. Using a `CONSENT=YES+1` cookie is a known workaround in scraping contexts. citeturn8search1  
* **429 throttling**: surface “rate limited” and advise the user to retry later; do not spin retries. Rate limiting is repeatedly observed in tooling. citeturn2search2turn10view0  
* **fmt duplication**: ensure replacing `fmt` is mandatory; otherwise you can get XML and break JSON parsing. citeturn2search1turn4view0  
* **Machine translation**: if you use `tlang`, consider appending a short note in the UI/metadata that this transcript is machine-translated. Scripts and official APIs both treat `tlang` as machine translation. citeturn9search1turn4view1  

## Migration checklist and method comparison

### Migration checklist

1. Implement the watch‑page `ytInitialPlayerResponse → captionTracks[].baseUrl` path as the default “local directed” route. fileciteturn0file0turn1view2  
2. Replace any `youtubei`-derived caption retrieval as the default; keep it only as an explicit experimental toggle and fail fast on `FAILED_PRECONDITION`. fileciteturn0file0turn11search8  
3. Ensure `fmt` is replaced (not appended) when requesting `json3`. citeturn2search1turn4view0  
4. Add timedtext `type=list` fallback to handle cases where watch HTML does not expose caption tracks. citeturn12search1  
5. Fix user messaging to only list fallbacks that actually ran (your notes call out the current misleading Supadata claim). fileciteturn0file0  
6. Add unit tests for: player response extraction, URL rewriting, JSON3 parsing, and track selection. citeturn3search3turn4view1  

### Comparison table of methods

The “reliability” column below is a practical engineering judgement based on the evidence that (a) internal endpoints are frequently blocked by changing integrity requirements, while (b) timedtext URLs and watch-page parsing are common in working implementations; it is not an official guarantee. citeturn11search0turn11search8turn1view2turn4view1turn12search1  

| Method | Reliability | Complexity | Auth/headers needed | When to use |
|---|---|---|---|---|
| Watch-page parsing (`/watch` → `ytInitialPlayerResponse` → `captionTracks[].baseUrl`) | High (best local default) | Medium (HTML parsing + JSON extraction) | Browser UA; may need consent cookie in some locales citeturn8search1turn7view0 | Default “local directed” transcript acquisition citeturn1view2turn4view1 |
| Timedtext list + download (`/api/timedtext?type=list` → fetch chosen track) | Medium–High (good fallback) | Medium (XML parsing + URL construction) | Usually none beyond UA; can still be blocked/rate-limited citeturn12search1turn2search2 | Fallback when watch HTML lacks captionTracks citeturn12search1 |
| Private internal API (`youtubei/v1/player`, `youtubei/v1/get_transcript`) | Low (brittle) | High (client context/version/integrity) | Special headers; can fail with `FAILED_PRECONDITION` citeturn11search8turn0file0 | Experimental toggle only; diagnostics; last resort fileciteturn0file0 |
| Supadata (third-party) | High if service is up | Low in code, higher in dependencies | API key + network to third-party | Reliable fallback for users willing to use a service fileciteturn0file0 |

### Note on official APIs

The official YouTube Data API *can* list and download caption tracks, but `captions.download` requires OAuth and permission to edit the video, so it is not a general public transcript solution for arbitrary videos. citeturn9search1turn9search11turn9search2