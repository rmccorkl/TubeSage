import { afterEach, describe, expect, it, vi } from "vitest";

// The HTTP boundary is the only seam mocked: obsidianFetch (src/utils/fetch-shim)
// is what every extraction method calls, and the module itself imports
// `obsidian`, which cannot load outside the app. The extraction method
// (iOS InnerTube player → caption track) runs unchanged above it.
vi.mock("./utils/fetch-shim", () => ({ obsidianFetch: vi.fn() }));

import { obsidianFetch } from "./utils/fetch-shim";
import { NoCaptionsError, YouTubeTranscriptExtractor } from "./youtube-transcript";
import { NoCaptionsError as LeafNoCaptionsError } from "./utils/transcript-errors";

const PLAYER_URL_PREFIX = "https://www.youtube.com/youtubei/v1/player";
const TRACK_URL = "https://www.youtube.com/api/timedtext?v=test&lang=en";

type PlayerResponse = {
  videoDetails: { title: string; author: string };
  playabilityStatus: { status: string };
  captions?: { playerCaptionsTracklistRenderer: { captionTracks: Array<Record<string, unknown>> } };
};

function playerResponse(captionTracks: Array<Record<string, unknown>> | undefined): PlayerResponse {
  const response: PlayerResponse = {
    videoDetails: { title: "Video Title", author: "Author" },
    playabilityStatus: { status: "OK" },
  };
  if (captionTracks !== undefined) {
    response.captions = { playerCaptionsTracklistRenderer: { captionTracks } };
  }
  return response;
}

const EN_TRACK = { baseUrl: TRACK_URL, languageCode: "en", vssId: ".en" };

/**
 * Routes the player POST to a canned response and every caption-track GET to
 * `onTrack`. Returns the URLs requested, in order.
 */
function mockHttp(player: PlayerResponse, onTrack: (url: string) => Promise<Response>): string[] {
  const urls: string[] = [];
  vi.mocked(obsidianFetch).mockImplementation((input: RequestInfo) => {
    // The extractor always passes a URL string (a Request object would be a test bug).
    if (typeof input !== "string") {
      throw new Error("expected a string URL");
    }
    const url = input;
    urls.push(url);
    if (url.startsWith(PLAYER_URL_PREFIX)) {
      return Promise.resolve(new Response(JSON.stringify(player), { status: 200 }));
    }
    return onTrack(url);
  });
  return urls;
}

// The extractor caches the player response per video id (static), so every
// test uses its own id and the mock is reset between tests.
let nextVideo = 0;
function videoId(): string {
  nextVideo += 1;
  return `vid${nextVideo}`;
}

afterEach(() => {
  vi.mocked(obsidianFetch).mockReset();
});

describe("YouTubeTranscriptExtractor.fetchTranscript — strict mode (#3 final review I2)", () => {
  it("(a) player OK + caption fetch network error + strict → rejects with a transient Error that keeps the attempted-methods context (never NoCaptionsError, never the marker)", async () => {
    const urls = mockHttp(playerResponse([EN_TRACK]), () => Promise.reject(new TypeError("fetch failed")));
    const failure = await YouTubeTranscriptExtractor.fetchTranscript(videoId(), { strict: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NoCaptionsError);
    const message = (failure as Error).message;
    expect(message).toContain("Network error while fetching transcript");
    expect(message).toContain("iOS player");
    expect(message).toContain("fetch failed");
    // The player call succeeded (metadata was recoverable) and the caption fetch was really attempted.
    expect(urls[0]).toMatch(PLAYER_URL_PREFIX);
    expect(urls.length).toBeGreaterThan(1);
  });

  it("(a′) the same failure without strict returns the legacy marker segment with the recovered metadata (unchanged)", async () => {
    mockHttp(playerResponse([EN_TRACK]), () => Promise.reject(new TypeError("fetch failed")));
    const result = await YouTubeTranscriptExtractor.fetchTranscript(videoId());
    expect(result.metadata).toEqual({ title: "Video Title", author: "Author" });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({
      text: "[TRANSCRIPT EXTRACTION FAILED: iOS player methods all failed. fetch failed]",
      start: 0,
      duration: 0,
    });
  });

  it("(b) player OK + no caption tracks + strict → NoCaptionsError; without strict → the marker (unchanged)", async () => {
    mockHttp(playerResponse(undefined), () => Promise.reject(new Error("caption fetch must not happen")));
    const strict = await YouTubeTranscriptExtractor.fetchTranscript(videoId(), { strict: true }).catch((error: unknown) => error);
    expect(strict).toBeInstanceOf(NoCaptionsError);
    expect(strict).toBeInstanceOf(Error);
    expect((strict as Error).message).toContain("No captions available for this video");

    mockHttp(playerResponse(undefined), () => Promise.reject(new Error("caption fetch must not happen")));
    const legacy = await YouTubeTranscriptExtractor.fetchTranscript(videoId());
    expect(legacy.segments[0].text).toBe(
      "[TRANSCRIPT EXTRACTION FAILED: iOS player methods all failed. No captions available for this video]",
    );
    expect(legacy.metadata.title).toBe("Video Title");
  });

  it("(b′) player OK + a caption track that is empty in every format + strict → NoCaptionsError (empty captions are a no-captions outcome)", async () => {
    mockHttp(playerResponse([EN_TRACK]), () => Promise.resolve(new Response("", { status: 200 })));
    const failure = await YouTubeTranscriptExtractor.fetchTranscript(videoId(), { strict: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NoCaptionsError);
    expect((failure as Error).message).toContain("Caption track returned empty response for all format attempts");
  });

  it("(b″) player OK + a caption response that cannot be parsed + strict → a plain Error (resumable, never permanent)", async () => {
    mockHttp(playerResponse([EN_TRACK]), () => Promise.resolve(new Response("{not json", { status: 200 })));
    const failure = await YouTubeTranscriptExtractor.fetchTranscript(videoId(), { strict: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NoCaptionsError);
    expect((failure as Error).message).toContain("Caption track response is not valid JSON");
  });

  it("a successful extraction is identical with and without strict", async () => {
    const json3 = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "hello" }] }] });
    mockHttp(playerResponse([EN_TRACK]), () => Promise.resolve(new Response(json3, { status: 200 })));
    const strict = await YouTubeTranscriptExtractor.fetchTranscript(videoId(), { strict: true });
    mockHttp(playerResponse([EN_TRACK]), () => Promise.resolve(new Response(json3, { status: 200 })));
    const legacy = await YouTubeTranscriptExtractor.fetchTranscript(videoId());
    expect(strict).toEqual(legacy);
    expect(strict.segments).toEqual([{ text: "hello", start: 1, duration: 2 }]);
  });

  it("NoCaptionsError is re-exported from the extractor and is the same class the adapter layer imports (no obsidian import needed there)", () => {
    expect(NoCaptionsError).toBe(LeafNoCaptionsError);
    expect(new NoCaptionsError("x")).toBeInstanceOf(Error);
    expect(new NoCaptionsError("x").name).toBe("NoCaptionsError");
  });
});
