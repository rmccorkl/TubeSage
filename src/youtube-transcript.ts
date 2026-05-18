/**
 * YouTube Transcript Extractor
 * Uses a direct approach to extract transcripts from YouTube videos
 */

// Import HTTP fetch shim - IMPORTANT: Always use obsidianFetch instead of direct requestUrl
// to ensure consistent behavior across desktop and mobile platforms
import { obsidianFetch } from "src/utils/fetch-shim";
import { getLogger } from "src/utils/logger";
import { getSafeErrorMessage } from "src/utils/error-utils";
const transcriptLogger = getLogger("TRANSCRIPT");

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => {
    return typeof value === 'object' && value !== null;
};

const isString = (value: unknown): value is string => typeof value === 'string';

// YouTube InnerTube iOS player endpoint.
// See docs/superpowers/specs/2026-05-18-transcript-fallback-ios-player-design.md
// The iOS client still returns working caption track URLs without PO tokens,
// while the Android/MWEB/WEB clients stopped doing so in early 2026.
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`;
const IOS_USER_AGENT = 'com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';
const IOS_CLIENT_VERSION = '20.10.38';

// Add the CaptionTrack type at file level, outside of any method
/**
 * Interface for YouTube caption tracks
 */
interface CaptionTrack {
    languageCode: string;
    kind?: string;           // "asr" for auto-generated
    baseUrl?: string;
    vssId?: string;          // ".en" (manual) or "a.en" (auto)
    isTranslatable?: boolean;
}

export interface TranscriptSegment {
    text: string;
    start: number;
    duration: number;
}

export interface TranscriptOptions {
    lang?: string;
    country?: string;
    supadataApiKey?: string;
    scrapcreatorsApiKey?: string;
}

export interface TranscriptMetadata {
    title?: string;
    author?: string;
}

export interface TranscriptResult {
    segments: TranscriptSegment[];
    metadata: TranscriptMetadata;
}


export class YouTubeTranscriptExtractor {
    private static readonly USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    // Cache the iOS player API response per video to avoid a redundant POST within one request
    private static cachedPlayerData: UnknownRecord | null = null;
    private static cachedPlayerVideoId: string | null = null;
    
    
    /**
     * Helper function to convert relative YouTube URLs to absolute URLs
     * YouTube API sometimes returns relative URLs that need to be converted
     * to absolute URLs before using with obsidianFetch
     * 
     * @param url The potentially relative URL
     * @returns An absolute URL
     */
    private static makeAbsoluteUrl(url: string): string {
        if (url.startsWith('/')) {
            const absoluteUrl = 'https://www.youtube.com' + url;
            transcriptLogger.debug(`Fixed relative URL to absolute: ${url} → ${absoluteUrl}`);
            return absoluteUrl;
        }
        return url;
    }
    
    /**
     * Extracts a transcript from a YouTube video
     * @param videoId YouTube video ID
     * @param options Optional language and country settings
     * @returns Promise with transcript segments and metadata
     */
    static async fetchTranscript(videoId: string, options: TranscriptOptions = {}): Promise<TranscriptResult> {
        transcriptLogger.debug(`Fetching YouTube transcript for video: ${videoId}`);

        // Clear cached player data when the video changes to prevent stale metadata
        if (this.cachedPlayerVideoId !== videoId) {
            this.cachedPlayerData = null;
            this.cachedPlayerVideoId = videoId;
            transcriptLogger.debug(`New video ID detected (${videoId}), cleared player cache`);
        }

        try {
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

        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            transcriptLogger.error('Error fetching transcript from YouTube:', errorMessage);

            if (errorMessage.includes('CORS') ||
                errorMessage.includes('Cross-Origin') ||
                errorMessage.includes('Access-Control-Allow-Origin')
            ) {
                throw new Error('CORS policy blocked the request. Please try a different video or check your internet connection.');
            }

            if (errorMessage.includes('network') ||
                errorMessage.includes('fetch') ||
                errorMessage.includes('connect') ||
                errorMessage.includes('timeout')
            ) {
                throw new Error('Network error while fetching transcript. Please check your internet connection.');
            }

            throw error;
        }
    }
    
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
    
    /**
     * Extracts video ID from a YouTube URL
     * @param url YouTube video URL
     * @returns Video ID or null if not found
     */
    static extractVideoId(url: string): string | null {
        // Clean up the URL - trim and ensure it's properly formed
        url = url.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('www.')) {
            url = 'https://' + url;
        }
        
        try {
            // Parse the URL to handle various formats more reliably
            const urlObj = new URL(url);
            const hostname = urlObj.hostname;
            const pathname = urlObj.pathname;
            
            let videoId: string | null = null;
            
            // youtube.com/watch?v=VIDEO_ID
            if (hostname.includes('youtube.com') && pathname === '/watch') {
                videoId = urlObj.searchParams.get('v');
            }
            // youtu.be/VIDEO_ID
            else if (hostname === 'youtu.be') {
                // The pathname includes the leading slash, so we remove it and strip query params
                videoId = pathname.substring(1).split('?')[0];
            }
            // youtube.com/embed/VIDEO_ID
            else if (hostname.includes('youtube.com') && pathname.startsWith('/embed/')) {
                videoId = pathname.split('/')[2];
            }
            // youtube.com/v/VIDEO_ID
            else if (hostname.includes('youtube.com') && pathname.startsWith('/v/')) {
                videoId = pathname.split('/')[2];
            }
            // youtube.com/shorts/VIDEO_ID
            else if (hostname.includes('youtube.com') && pathname.startsWith('/shorts/')) {
                videoId = pathname.split('/')[2];
            }
            // youtube.com/live/VIDEO_ID - Add support for live URLs
            else if (hostname.includes('youtube.com') && pathname.startsWith('/live/')) {
                videoId = pathname.split('/')[2].split('?')[0]; // Handle potential query params
            }
            // music.youtube.com/watch?v=VIDEO_ID
            else if (hostname.includes('music.youtube.com') && pathname === '/watch') {
                videoId = urlObj.searchParams.get('v');
            }
            
            // Validate the extracted video ID
            if (videoId && this.isValidVideoId(videoId)) {
                return videoId;
            } else if (videoId) {
                transcriptLogger.error(`Invalid video ID extracted: '${videoId}' from URL: '${url}'`);
                return null;
            }
        } catch (error) {
            transcriptLogger.error("Error parsing YouTube URL:", error);
            
            // Fallback to regex patterns for compatibility
            const patterns = [
                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
                /youtube\.com\/embed\/([^?&\n/]+)/,
                /youtube\.com\/v\/([^?&\n/]+)/,
                /youtube\.com\/shorts\/([^?&\n/]+)/,
                /youtube\.com\/live\/([^?&\n/]+)/,  // Add pattern for live URLs
                /music\.youtube\.com\/watch\?v=([^&\n?#]+)/
            ];
            
            for (const pattern of patterns) {
                const match = url.match(pattern);
                if (match && match[1]) {
                    const videoId = match[1];
                    // Validate the extracted video ID
                    if (this.isValidVideoId(videoId)) {
                        return videoId;
                    } else {
                        transcriptLogger.error(`Invalid video ID extracted: '${videoId}' from URL: '${url}'`);
                        return null;
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Validates if a string is a valid YouTube video ID
     * @param videoId The video ID to validate
     * @returns True if valid, false otherwise
     */
    static isValidVideoId(videoId: string): boolean {
        if (!videoId || typeof videoId !== 'string') {
            return false;
        }
        
        // YouTube video IDs are typically 11 characters long and contain only alphanumeric characters, hyphens, and underscores
        // They should not contain quotes, spaces, or other special characters
        const validPattern = /^[a-zA-Z0-9_-]{11}$/;
        const isValid = validPattern.test(videoId);
        
        if (!isValid) {
            transcriptLogger.debug(`Video ID validation failed: '${videoId}' (length: ${videoId.length}, pattern match: ${validPattern.test(videoId)})`);
        }
        
        return isValid;
    }

    /**
     * Select the best caption track for a requested language.
     * Priority: manual+exact → manual+base → auto+exact → auto+base
     *         → translatable manual (with tlang) → translatable auto → first available
     */
    private static pickBestTrack(
        tracks: CaptionTrack[],
        requestedLang: string
    ): { track: CaptionTrack; useTlang: boolean } | null {
        if (tracks.length === 0) return null;

        const baseLang = requestedLang.split('-')[0]; // "en-US" → "en"

        const isManual = (t: CaptionTrack) => t.kind !== 'asr';
        const isAuto = (t: CaptionTrack) => t.kind === 'asr';
        const exactLang = (t: CaptionTrack) => t.languageCode === requestedLang;
        const baseLangMatch = (t: CaptionTrack) => t.languageCode.split('-')[0] === baseLang;

        // 1. Manual + exact language
        const manualExact = tracks.find(t => isManual(t) && exactLang(t));
        if (manualExact) return { track: manualExact, useTlang: false };

        // 2. Manual + base language
        const manualBase = tracks.find(t => isManual(t) && baseLangMatch(t));
        if (manualBase) return { track: manualBase, useTlang: false };

        // 3. Auto + exact language
        const autoExact = tracks.find(t => isAuto(t) && exactLang(t));
        if (autoExact) return { track: autoExact, useTlang: false };

        // 4. Auto + base language
        const autoBase = tracks.find(t => isAuto(t) && baseLangMatch(t));
        if (autoBase) return { track: autoBase, useTlang: false };

        // 5. Translatable manual track (use tlang for translation)
        const translatableManual = tracks.find(t => isManual(t) && t.isTranslatable);
        if (translatableManual) return { track: translatableManual, useTlang: true };

        // 6. Translatable auto track
        const translatableAuto = tracks.find(t => isAuto(t) && t.isTranslatable);
        if (translatableAuto) return { track: translatableAuto, useTlang: true };

        // 7. First available
        return { track: tracks[0], useTlang: false };
    }

    /**
     * Supadata API fallback: Uses Supadata's transcript API as a third fallback.
     * Requires an API key from supadata.ai.
     */
    private static async fetchViaSupadata(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';
        const apiKey = options.supadataApiKey;

        if (!apiKey) {
            throw new Error('Supadata API key not configured');
        }

        const videoUrl = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
        const supadataUrl = `https://api.supadata.ai/v1/transcript?url=${videoUrl}&lang=${lang}&text=false&mode=auto`;

        transcriptLogger.debug(`Supadata: fetching transcript for ${videoId}`);

        const response = await obsidianFetch(supadataUrl, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            let errorDetail = '';
            try { errorDetail = await response.text(); } catch { /* ignore */ }
            transcriptLogger.error(`Supadata API error: HTTP ${response.status}: ${errorDetail.substring(0, 500)}`);
            throw new Error(`Supadata API error: HTTP ${response.status}`);
        }

        const data = await response.json() as {
            content?: Array<{
                text: string;
                offset: number;
                duration: number;
                lang?: string;
            }>;
            lang?: string;
            availableLangs?: string[];
        };

        if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
            throw new Error('Supadata returned no transcript content');
        }

        const segments: TranscriptSegment[] = data.content.map(item => ({
            text: item.text.trim(),
            start: item.offset / 1000,    // Convert ms to seconds
            duration: item.duration / 1000  // Convert ms to seconds
        })).filter(segment => !!segment.text);

        transcriptLogger.debug(`Supadata: successfully extracted ${segments.length} segments`);
        const metadata: TranscriptMetadata = await this.getVideoMetadata(videoId);
        transcriptLogger.debug(`Supadata: fetched metadata — title="${metadata.title}", author="${metadata.author}"`);
        return { segments, metadata };
    }

    /**
     * ScrapeCreators paid API: Uses ScrapeCreators transcript API as an external service.
     * Requires an API key from app.scrapecreators.com.
     */
    private static async fetchViaScrapeCreators(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';
        const apiKey = options.scrapcreatorsApiKey;

        if (!apiKey) {
            throw new Error('ScrapeCreators API key not configured');
        }

        const videoUrl = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
        const scrapcreatorsUrl = `https://api.scrapecreators.com/v1/youtube/video/transcript?url=${videoUrl}&language=${lang}`;

        transcriptLogger.debug(`ScrapeCreators: fetching transcript for ${videoId}`);

        const response = await obsidianFetch(scrapcreatorsUrl, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            let errorDetail = '';
            try { errorDetail = await response.text(); } catch { /* ignore */ }
            transcriptLogger.error(`ScrapeCreators API error: HTTP ${response.status}: ${errorDetail.substring(0, 500)}`);
            throw new Error(`ScrapeCreators API error: HTTP ${response.status}`);
        }

        const data = await response.json() as {
            transcript?: Array<{
                text: string;
                startMs: string;
                endMs: string;
            }>;
        };

        if (!data.transcript || !Array.isArray(data.transcript) || data.transcript.length === 0) {
            throw new Error('ScrapeCreators returned no transcript content');
        }

        const segments: TranscriptSegment[] = data.transcript.map(item => ({
            text: item.text.trim(),
            start: parseInt(item.startMs) / 1000,
            duration: (parseInt(item.endMs) - parseInt(item.startMs)) / 1000
        })).filter(segment => !!segment.text);

        transcriptLogger.debug(`ScrapeCreators: successfully extracted ${segments.length} segments`);
        const metadata: TranscriptMetadata = await this.getVideoMetadata(videoId);
        transcriptLogger.debug(`ScrapeCreators: fetched metadata — title="${metadata.title}", author="${metadata.author}"`);
        return { segments, metadata };
    }

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

    /**
     * Fetch and parse captions from a caption track baseUrl using json3 format
     */
    private static async fetchCaptionTrack(baseUrl: string, tlang?: string, userAgent?: string): Promise<TranscriptSegment[]> {
        // Ensure absolute URL
        let url = this.makeAbsoluteUrl(baseUrl);

        // Strip ip=0.0.0.0 and ipbits=0 parameters — YouTube embeds these in
        // ytInitialPlayerResponse but they cause empty responses when the request
        // comes from a non-browser context (Obsidian's requestUrl)
        url = url.replace(/[&?]ip=0\.0\.0\.0/g, '&').replace(/[&?]ipbits=0/g, '&');
        // Clean up any resulting double-ampersands or trailing ampersands
        url = url.replace(/&&+/g, '&').replace(/\?&/, '?').replace(/&$/, '');

        // Add or replace tlang parameter for translation
        if (tlang) {
            if (url.includes('tlang=')) {
                url = url.replace(/tlang=[^&]+/g, `tlang=${tlang}`);
            } else {
                url = `${url}&tlang=${tlang}`;
            }
        }

        // Try json3 format first, fall back to default (XML/srv3) if empty
        const responseText = await this.fetchCaptionTrackWithFormat(url, 'json3', userAgent);
        if (responseText.length > 0) {
            transcriptLogger.debug(`Caption track json3 response length: ${responseText.length}`);
            return this.parseCaptionTrackResponse(responseText);
        }

        // json3 returned empty — retry with srv3 (XML) format
        transcriptLogger.debug('json3 format returned empty response, retrying with srv3 (XML)');
        const xmlText = await this.fetchCaptionTrackWithFormat(url, 'srv3', userAgent);
        if (xmlText.length > 0) {
            transcriptLogger.debug(`Caption track srv3 response length: ${xmlText.length}`);
            return this.parseCaptionTrackResponse(xmlText);
        }

        // Both formats returned empty — try the original URL without format override
        transcriptLogger.debug('srv3 also empty, trying original URL without fmt override');
        const originalText = await this.fetchCaptionTrackRaw(url, userAgent);
        if (originalText.length > 0) {
            transcriptLogger.debug(`Caption track original response length: ${originalText.length}`);
            return this.parseCaptionTrackResponse(originalText);
        }

        throw new Error('Caption track returned empty response for all format attempts');
    }

    /**
     * Fetch caption track with a specific format parameter.
     */
    private static async fetchCaptionTrackWithFormat(baseUrl: string, fmt: string, userAgent?: string): Promise<string> {
        let url = baseUrl;
        if (url.includes('fmt=')) {
            url = url.replace(/fmt=[^&]+/g, `fmt=${fmt}`);
        } else {
            url = `${url}&fmt=${fmt}`;
        }
        return this.fetchCaptionTrackRaw(url, userAgent);
    }

    /**
     * Raw fetch for a caption track URL, returning the response text.
     * @param userAgent Optional UA override — pass the same UA used for the player API call
     *                  so YouTube sees a consistent client identity end-to-end.
     */
    private static async fetchCaptionTrackRaw(url: string, userAgent?: string): Promise<string> {
        transcriptLogger.debug(`Fetching caption track from: ${url.substring(0, 100)}...`);

        const response = await obsidianFetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': userAgent ?? YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.youtube.com',
                'Referer': 'https://www.youtube.com/',
                'DNT': '1',
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch caption track: HTTP ${response.status}`);
        }

        return await response.text();
    }

    /**
     * Parse a caption track response (auto-detects JSON vs XML).
     */
    private static parseCaptionTrackResponse(responseText: string): TranscriptSegment[] {
        transcriptLogger.debug(`Caption track response length: ${responseText.length}, starts with: ${responseText.substring(0, 100)}`);

        // Check if response is XML (starts with < or <?xml)
        if (responseText.trim().startsWith('<')) {
            transcriptLogger.debug('Response is XML format, parsing as XML');
            return this.parseXmlCaptions(responseText, 'caption-track');
        }

        // Try to parse as JSON
        type CaptionTrackData = {
            events?: Array<{
                tStartMs?: number;
                dDurationMs?: number;
                segs?: Array<{ utf8?: string }>;
            }>;
        };

        let data: CaptionTrackData;

        try {
            data = JSON.parse(responseText) as CaptionTrackData;
        } catch {
            transcriptLogger.error(`Failed to parse caption response as JSON: ${responseText.substring(0, 200)}`);
            throw new Error(`Caption track response is not valid JSON`);
        }

        if (!data.events || !Array.isArray(data.events)) {
            transcriptLogger.error(`Caption track response missing events array. Keys: ${Object.keys(data).join(', ')}`);
            throw new Error('Caption track response missing events');
        }

        transcriptLogger.debug(`Parsing ${data.events.length} events from JSON caption track`);

        const segments: TranscriptSegment[] = [];
        for (const event of data.events) {
            const text = (event.segs || [])
                .map(seg => seg.utf8 || '')
                .join('')
                .trim();

            if (!text) continue;

            const start = (event.tStartMs || 0) / 1000;
            const duration = (event.dDurationMs || 0) / 1000;

            segments.push({
                text,
                start,
                duration
            });
        }

        if (segments.length === 0) {
            throw new Error('No transcript segments parsed from caption track');
        }

        transcriptLogger.debug(`Successfully parsed ${segments.length} segments from caption track`);
        return segments;
    }

    /**
     * Parses YouTube captions in XML format
     * @param xmlText The XML content of captions
     * @param videoId Video ID for reference
     * @returns Parsed transcript segments
     */
    static parseXmlCaptions(xmlText: string, videoId: string): TranscriptSegment[] {
        transcriptLogger.debug(`Parsing XML captions for video ${videoId}`);
        
        try {
            // Simple regex-based parsing of the transcript XML
            // Format is typically: <text start="startTime" dur="duration">Caption text</text>
            const segments: TranscriptSegment[] = [];
            const textRegex = /<text\s+start="([^"]+)"\s+dur="([^"]+)"(?:[^>]*)>([\s\S]*?)<\/text>/g;
            
            let match;
            while ((match = textRegex.exec(xmlText)) !== null) {
                const startTime = parseFloat(match[1]);
                const duration = parseFloat(match[2]);
                // Decode HTML entities in the text
                let text = match[3].replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&nbsp;/g, ' ')
                    .replace(/<[^>]*>/g, ''); // Remove any HTML tags
                
                text = text.trim();
                
                if (text) {
                    segments.push({
                        text,
                        start: startTime,
                        duration
                    });
                }
            }
            
            if (segments.length === 0) {
                transcriptLogger.error("No segments extracted from XML");
                throw new Error("Failed to parse XML captions: No text segments found");
            }
            
            return segments;
            
        } catch (e) {
            const errorMessage = getSafeErrorMessage(e);
            transcriptLogger.error("Error parsing XML captions:", errorMessage);
            
            // Return a basic error segment
            return [
                {
                    text: `Failed to parse YouTube captions for video ${videoId}. Error: ${errorMessage}`,
                    start: 0,
                    duration: 0
                }
            ];
        }
    }

}
