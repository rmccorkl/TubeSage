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

// Add the CaptionTrack type at file level, outside of any method
/**
 * Interface for YouTube caption tracks
 */
export interface CaptionTrack {
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

export class YouTubeTranscriptExtractor {
    private static readonly USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    private static cookieStore: string = '';
    // Cache YouTube config after first extraction to avoid repeated HTML fetches
    private static cachedConfig: YouTubeConfig | null = null;
    // Fallback client version if extraction fails (updated to current version)
    private static readonly FALLBACK_CLIENT_VERSION = '2.20260128.05.00';
    
    
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

        try {
            // Always try local methods first, then fall back to paid APIs
            const attempts: Array<{ method: string; error: string }> = [];
            let metadata: TranscriptMetadata = {};

            // [1] Watch-page captions (0 extra HTTP requests, reuses cached HTML)
            try {
                transcriptLogger.debug('Attempting primary local method: Watch-page captions');
                const result = await this.fetchViaWatchPage(videoId, options);
                transcriptLogger.debug(`Watch-page method succeeded with ${result.segments.length} segments`);
                return result;
            } catch (err) {
                const msg = getSafeErrorMessage(err);
                transcriptLogger.error('Watch-page method failed:', msg);
                attempts.push({ method: 'Watch-page', error: msg });
                if (this.cachedConfig?.metadata) {
                    metadata = { ...this.cachedConfig.metadata };
                }
            }

            // [2] ANDROID Player API fallback
            try {
                transcriptLogger.debug('Attempting fallback: ANDROID client via Player API');
                const result = await this.fetchViaPlayerApiAndroid(videoId, options);
                transcriptLogger.debug(`ANDROID method succeeded with ${result.segments.length} segments`);
                return result;
            } catch (err) {
                const msg = getSafeErrorMessage(err);
                transcriptLogger.error('ANDROID client failed:', msg);
                attempts.push({ method: 'ANDROID', error: msg });
                if (msg.includes('400')) {
                    this.cachedConfig = null;
                    transcriptLogger.debug('Cleared YouTube config cache due to HTTP 400');
                }
            }

            // [3] TVHTML5 Player API fallback
            try {
                transcriptLogger.debug('Attempting fallback: TVHTML5 client via Player API');
                const result = await this.fetchViaPlayerApiTV(videoId, options);
                transcriptLogger.debug(`TVHTML5 method succeeded with ${result.segments.length} segments`);
                return result;
            } catch (err) {
                const msg = getSafeErrorMessage(err);
                transcriptLogger.error('TVHTML5 client failed:', msg);
                attempts.push({ method: 'TVHTML5', error: msg });
            }

            // [4] WEB ScrapeCreators fallback (local innertube, not the paid API)
            try {
                transcriptLogger.debug('Attempting fallback: WEB ScrapeCreators');
                const result = await this.fetchViaWebScrapeCreators(videoId, options);
                transcriptLogger.debug(`WEB ScrapeCreators method succeeded with ${result.segments.length} segments`);
                return result;
            } catch (err) {
                const msg = getSafeErrorMessage(err);
                transcriptLogger.error('WEB ScrapeCreators failed:', msg);
                attempts.push({ method: 'WEB ScrapeCreators', error: msg });
                if (this.cachedConfig?.metadata && !metadata.title) {
                    metadata = { ...this.cachedConfig.metadata };
                }
            }

            // [5] ScrapeCreators paid API fallback (only if key is configured)
            if (options.scrapcreatorsApiKey) {
                try {
                    transcriptLogger.debug('All local methods failed — attempting ScrapeCreators paid API');
                    const result = await this.fetchViaScrapeCreators(videoId, options);
                    transcriptLogger.debug(`ScrapeCreators API succeeded with ${result.segments.length} segments`);
                    return result;
                } catch (err) {
                    const msg = getSafeErrorMessage(err);
                    transcriptLogger.error('ScrapeCreators API failed:', msg);
                    attempts.push({ method: 'ScrapeCreators API', error: msg });
                }
            }

            // [6] Supadata paid API fallback (only if key is configured)
            if (options.supadataApiKey) {
                try {
                    transcriptLogger.debug('All local methods failed — attempting Supadata paid API');
                    const result = await this.fetchViaSupadata(videoId, options);
                    transcriptLogger.debug(`Supadata API succeeded with ${result.segments.length} segments`);
                    return result;
                } catch (err) {
                    const msg = getSafeErrorMessage(err);
                    transcriptLogger.error('Supadata API failed:', msg);
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
     * Extracts only transcript segments from a YouTube video (backward compatibility)
     * @param videoId YouTube video ID
     * @param options Optional language and country settings
     * @returns Promise with transcript segments only
     */
    static async fetchTranscriptSegments(videoId: string, options: TranscriptOptions = {}): Promise<TranscriptSegment[]> {
        const result = await this.fetchTranscript(videoId, options);
        return result.segments;
    }


    /**
     * Get video metadata from the player response
     * @param videoId YouTube video ID
     * @returns Promise with metadata
     */

    static async getVideoMetadata(videoId: string): Promise<TranscriptMetadata> {
        // Check cached config first to avoid a redundant watch page fetch
        if (this.cachedConfig?.metadata && (this.cachedConfig.metadata.title || this.cachedConfig.metadata.author)) {
            transcriptLogger.debug('Returning cached metadata from config');
            return this.cachedConfig.metadata;
        }

        try {
            // getYouTubeConfig fetches the watch page and extracts metadata as a side-effect
            const config = await this.getYouTubeConfig(videoId);
            if (config.metadata.title || config.metadata.author) {
                return config.metadata;
            }

            // Fallback: if config extraction didn't get metadata, try parsing HTML directly
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const body = await this.fetchWatchPageHtml(watchUrl);
            const playerResponse = this.extractJsonFromHtml(body, 'ytInitialPlayerResponse');
            const videoDetails = isRecord(playerResponse) ? playerResponse.videoDetails : undefined;
            const title = isRecord(videoDetails) && typeof videoDetails.title === 'string'
                ? videoDetails.title
                : undefined;
            const author = isRecord(videoDetails) && typeof videoDetails.author === 'string'
                ? videoDetails.author
                : undefined;

            return { title, author };

        } catch (error) {
            transcriptLogger.error('Error fetching video metadata:', error);
            return {};
        }
    }
    
    /**
     * Combines transcript segments into a single text
     * @param segments Array of transcript segments
     * @returns Combined transcript text
     */
    static combineTranscript(segments: TranscriptSegment[]): string {
        return segments.map(segment => segment.text).join(' ');
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
     * Extract a JSON object assigned to a JavaScript variable in HTML.
     * Uses brace-balanced counting (respecting string escapes) instead of fragile regex.
     * @param html The HTML source to search
     * @param variableName The JS variable name (e.g. "ytInitialPlayerResponse")
     * @returns Parsed JSON object or null if not found
     */
    private static extractJsonFromHtml(html: string, variableName: string): unknown {
        const searchPattern = `${variableName}\\s*=\\s*\\{`;
        const match = html.match(new RegExp(searchPattern));
        if (!match || match.index === undefined) {
            return null;
        }

        // Find the opening brace position
        const startIdx = html.indexOf('{', match.index);
        if (startIdx === -1) return null;

        let depth = 0;
        let inString = false;
        let stringChar = '';
        let escaped = false;

        for (let i = startIdx; i < html.length; i++) {
            const ch = html[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (ch === '\\' && inString) {
                escaped = true;
                continue;
            }

            if (inString) {
                if (ch === stringChar) {
                    inString = false;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                inString = true;
                stringChar = ch;
                continue;
            }

            if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    const jsonStr = html.substring(startIdx, i + 1);
                    try {
                        return JSON.parse(jsonStr);
                    } catch {
                        transcriptLogger.debug(`extractJsonFromHtml: failed to parse ${variableName} JSON (${jsonStr.length} chars)`);
                        return null;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Fetch YouTube configuration (API key, client version) from the watch page HTML.
     * Results are cached to avoid repeated HTML fetches.
     * Reference: https://scrapecreators.com/blog/how-to-scrape-youtube-transcripts-with-node-js-in-2025
     */
    private static async getYouTubeConfig(videoId: string): Promise<YouTubeConfig> {
        if (this.cachedConfig) {
            transcriptLogger.debug(`Using cached YouTube config (clientVersion: ${this.cachedConfig.clientVersion})`);
            return this.cachedConfig;
        }

        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        try {
            let html = await this.fetchWatchPageHtml(watchUrl);

            // Consent page detection: if we got a consent page instead of the real watch page,
            // retry with CONSENT cookie to bypass
            const hasPlayerResponse = html.includes('ytInitialPlayerResponse');
            const isConsentPage = html.includes('consent.youtube.com') || html.includes('CONSENT');
            if (!hasPlayerResponse && isConsentPage) {
                transcriptLogger.debug('Detected consent page, retrying with CONSENT cookie');
                html = await this.fetchWatchPageHtml(watchUrl, 'CONSENT=YES+1');
            }

            // Extract INNERTUBE_API_KEY
            const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
            if (!keyMatch || !keyMatch[1]) {
                throw new Error('INNERTUBE_API_KEY not found in watch page');
            }
            const apiKey = keyMatch[1];

            // Extract INNERTUBE_CLIENT_VERSION (dynamically get current YouTube version)
            const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
            const clientVersion = versionMatch && versionMatch[1]
                ? versionMatch[1]
                : this.FALLBACK_CLIENT_VERSION;

            // Extract VISITOR_DATA (required for session binding in API calls)
            const visitorMatch = html.match(/"VISITOR_DATA":"([^"]+)"/);
            const visitorData = visitorMatch && visitorMatch[1] ? visitorMatch[1] : null;

            // Extract captionTracks and metadata from ytInitialPlayerResponse
            let captionTracks: CaptionTrack[] = [];
            let metadata: TranscriptMetadata = {};

            const playerResponse = this.extractJsonFromHtml(html, 'ytInitialPlayerResponse');
            if (isRecord(playerResponse)) {
                // Extract caption tracks
                const captions = (playerResponse as {
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

                if (captions && Array.isArray(captions)) {
                    captionTracks = captions.map(track => ({
                        languageCode: track.languageCode || '',
                        kind: track.kind,
                        baseUrl: track.baseUrl,
                        vssId: track.vssId,
                        isTranslatable: track.isTranslatable
                    }));
                    transcriptLogger.debug(`Extracted ${captionTracks.length} caption tracks from watch page`);
                }

                // Extract metadata from videoDetails
                const videoDetails = (playerResponse as {
                    videoDetails?: { title?: string; author?: string };
                }).videoDetails;
                if (videoDetails) {
                    metadata = {
                        title: typeof videoDetails.title === 'string' ? videoDetails.title : undefined,
                        author: typeof videoDetails.author === 'string' ? videoDetails.author : undefined
                    };
                    transcriptLogger.debug(`Extracted metadata from watch page: title="${metadata.title}", author="${metadata.author}"`);
                }
            } else {
                transcriptLogger.debug('ytInitialPlayerResponse not found or failed to parse from watch page');
            }

            this.cachedConfig = {
                apiKey,
                clientVersion,
                visitorData,
                captionTracks,
                metadata
            };

            transcriptLogger.debug(`Extracted YouTube config - clientVersion: ${clientVersion}, visitorData: ${visitorData ? 'present' : 'not found'}, captionTracks: ${captionTracks.length}`);
            return this.cachedConfig;

        } catch (err) {
            const errorMessage = getSafeErrorMessage(err);
            transcriptLogger.warn(`Failed to extract YouTube config dynamically: ${errorMessage}`);

            // Return fallback config without API key - caller should handle this
            throw new Error(`Unable to extract YouTube configuration from watch page: ${errorMessage}`);
        }
    }

    /**
     * Fetch the watch page HTML with standard headers.
     */
    private static async fetchWatchPageHtml(watchUrl: string, extraCookie?: string): Promise<string> {
        const cookies = [
            YouTubeTranscriptExtractor.cookieStore,
            extraCookie
        ].filter(Boolean).join('; ');

        const response = await obsidianFetch(watchUrl, {
            method: 'GET',
            headers: {
                'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'DNT': '1',
                ...(cookies && { 'Cookie': cookies })
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return response.text();
    }

    /**
     * Clear the cached YouTube config (useful for testing or after errors)
     */
    static clearConfigCache(): void {
        this.cachedConfig = null;
        transcriptLogger.debug('YouTube config cache cleared');
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
     * Primary method: Extract transcript from watch-page captionTracks.
     * Reuses the cached HTML from getYouTubeConfig — zero additional HTTP cost for config.
     */
    private static async fetchViaWatchPage(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';

        const pageData = await this.getYouTubeConfig(videoId);

        if (!pageData.captionTracks || pageData.captionTracks.length === 0) {
            throw new Error('No caption tracks found in watch page');
        }

        transcriptLogger.debug(`Watch-page: ${pageData.captionTracks.length} caption tracks available`);

        const selection = this.pickBestTrack(pageData.captionTracks, lang);
        if (!selection || !selection.track.baseUrl) {
            throw new Error('No suitable caption track with baseUrl found');
        }

        const { track, useTlang } = selection;
        const trackBaseUrl = track.baseUrl as string; // Guaranteed non-null by check above
        transcriptLogger.debug(`Watch-page: selected track lang=${track.languageCode}, kind=${track.kind || 'manual'}, useTlang=${useTlang}`);

        const tlang = useTlang ? lang : undefined;
        const segments = await this.fetchCaptionTrack(trackBaseUrl, tlang);

        transcriptLogger.debug(`Watch-page method succeeded with ${segments.length} segments`);
        return { segments, metadata: pageData.metadata };
    }

    /**
     * WEB ScrapeCreators method: Two-step approach using /next + /get_transcript internal APIs.
     * Reference: https://scrapecreators.com/blog/how-to-scrape-youtube-transcripts-with-node-js-in-2025
     */
    private static async fetchViaWebScrapeCreators(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const ytConfig = await this.getYouTubeConfig(videoId);
        transcriptLogger.debug(`WEB ScrapeCreators: using clientVersion ${ytConfig.clientVersion}`);

        // Step 1: Get transcript parameters from YouTube's internal /next API
        const nextApiUrl = `https://www.youtube.com/youtubei/v1/next?prettyPrint=false`;
        const nextRequestBody = {
            context: {
                client: {
                    clientName: "WEB",
                    clientVersion: ytConfig.clientVersion,
                    ...(ytConfig.visitorData && { visitorData: ytConfig.visitorData })
                }
            },
            videoId: videoId
        };

        transcriptLogger.debug(`WEB ScrapeCreators Step 1: Requesting transcript parameters from ${nextApiUrl}`);

        const nextResponse = await obsidianFetch(nextApiUrl, {
            method: 'POST',
            headers: {
                'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'Referer': watchUrl,
                'Origin': 'https://www.youtube.com',
                'x-youtube-client-name': '1',
                'x-youtube-client-version': ytConfig.clientVersion,
                ...(ytConfig.visitorData && { 'x-goog-visitor-id': ytConfig.visitorData }),
                'DNT': '1',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
            },
            body: JSON.stringify(nextRequestBody)
        });

        if (!nextResponse.ok) {
            throw new Error(`Failed to fetch next API data: HTTP ${nextResponse.status}`);
        }

        const nextData = await nextResponse.json() as unknown;
        transcriptLogger.debug(`WEB ScrapeCreators Step 1 completed: received ${JSON.stringify(nextData).length} characters`);

        // Extract metadata from nextData response
        const metadata = this.extractMetadataFromNextData(nextData);
        transcriptLogger.debug(`WEB ScrapeCreators metadata: title="${metadata.title || 'N/A'}", author="${metadata.author || 'N/A'}"`);

        // Find transcript endpoint parameters
        const transcriptParams = this.findTranscriptEndpoint(nextData);
        if (!transcriptParams) {
            if (isRecord(nextData)) {
                transcriptLogger.debug(`Next API response keys: ${Object.keys(nextData).join(', ')}`);
            }
            throw new Error(`No transcript parameters found in YouTube API response for video ${videoId}`);
        }

        transcriptLogger.debug(`WEB ScrapeCreators: Found transcript parameters: ${transcriptParams.substring(0, 100)}...`);

        // Step 2: Request the actual transcript using the parameters
        const getTranscriptUrl = `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false`;
        const transcriptRequestBody = {
            context: {
                client: {
                    clientName: "WEB",
                    clientVersion: ytConfig.clientVersion,
                    ...(ytConfig.visitorData && { visitorData: ytConfig.visitorData })
                }
            },
            params: transcriptParams
        };

        transcriptLogger.debug(`WEB ScrapeCreators Step 2: Requesting transcript from ${getTranscriptUrl}`);

        const transcriptResponse = await obsidianFetch(getTranscriptUrl, {
            method: 'POST',
            headers: {
                'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'Referer': watchUrl,
                'Origin': 'https://www.youtube.com',
                'x-youtube-client-name': '1',
                'x-youtube-client-version': ytConfig.clientVersion,
                ...(ytConfig.visitorData && { 'x-goog-visitor-id': ytConfig.visitorData }),
                'DNT': '1',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
            },
            body: JSON.stringify(transcriptRequestBody)
        });

        if (!transcriptResponse.ok) {
            let errorDetail = '';
            try { errorDetail = (await transcriptResponse.text()).substring(0, 500); } catch { /* ignore */ }
            transcriptLogger.error(`get_transcript failed with HTTP ${transcriptResponse.status}: ${errorDetail}`);
            throw new Error(`Failed to fetch transcript: HTTP ${transcriptResponse.status}`);
        }

        const transcriptData = await transcriptResponse.json() as UnknownRecord;
        transcriptLogger.debug(`WEB ScrapeCreators Step 2 completed: received ${JSON.stringify(transcriptData).length} characters`);

        const segments = this.parseScrapeCreatorsTranscript(transcriptData);
        transcriptLogger.debug(`WEB ScrapeCreators method succeeded with ${segments.length} segments`);
        return { segments, metadata };
    }

    /**
     * Extract metadata from a /next API response.
     */
    private static extractMetadataFromNextData(nextData: unknown): TranscriptMetadata {
        const metadata: TranscriptMetadata = {};
        if (!isRecord(nextData)) return metadata;

        const typedNextData = nextData as {
            playerOverlays?: {
                playerOverlayRenderer?: {
                    videoDetails?: {
                        playerOverlayVideoDetailsRenderer?: {
                            title?: { simpleText?: string };
                            subtitle?: { runs?: Array<{ text?: string }> };
                        };
                    };
                };
            };
            contents?: {
                twoColumnWatchNextResults?: {
                    results?: {
                        results?: {
                            contents?: Array<{
                                videoPrimaryInfoRenderer?: { title?: { runs?: Array<{ text?: string }> } };
                                videoSecondaryInfoRenderer?: { owner?: { videoOwnerRenderer?: { title?: { runs?: Array<{ text?: string }> } } } };
                            }>;
                        };
                    };
                };
            };
            microformat?: {
                playerMicroformatRenderer?: {
                    title?: { simpleText?: string };
                    ownerChannelName?: string;
                };
            };
        };

        try {
            // Method 1: From playerOverlays (most reliable)
            const playerOverlayDetails = typedNextData.playerOverlays?.playerOverlayRenderer?.videoDetails?.playerOverlayVideoDetailsRenderer;
            if (playerOverlayDetails) {
                metadata.title = playerOverlayDetails.title?.simpleText;
                metadata.author = playerOverlayDetails.subtitle?.runs?.[0]?.text;
            }

            // Method 2: From contents (fallback)
            if (!metadata.title || !metadata.author) {
                const contents = typedNextData.contents?.twoColumnWatchNextResults?.results?.results?.contents;
                if (Array.isArray(contents)) {
                    const primaryInfo = contents.find((c) => c.videoPrimaryInfoRenderer);
                    if (primaryInfo && !metadata.title) {
                        metadata.title = primaryInfo.videoPrimaryInfoRenderer?.title?.runs?.[0]?.text;
                    }
                    const secondaryInfo = contents.find((c) => c.videoSecondaryInfoRenderer);
                    if (secondaryInfo && !metadata.author) {
                        metadata.author = secondaryInfo.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text;
                    }
                }
            }

            // Method 3: From microformat (additional fallback)
            if (!metadata.title || !metadata.author) {
                const microformat = typedNextData.microformat?.playerMicroformatRenderer;
                if (microformat) {
                    if (!metadata.title && microformat.title?.simpleText) metadata.title = microformat.title.simpleText;
                    if (!metadata.author && microformat.ownerChannelName) metadata.author = microformat.ownerChannelName;
                }
            }
        } catch (error) {
            transcriptLogger.debug(`Error extracting metadata from nextData: ${getSafeErrorMessage(error)}`);
        }

        return metadata;
    }

    /**
     * Recursively search for getTranscriptEndpoint.params in a /next API response.
     */
    private static findTranscriptEndpoint(obj: unknown): string | null {
        if (!isRecord(obj)) return null;

        // Check direct getTranscriptEndpoint
        const endpoint = obj.getTranscriptEndpoint as { params?: unknown } | undefined;
        if (endpoint && isString(endpoint.params)) return endpoint.params;

        // Check continuationEndpoint.getTranscriptEndpoint
        const contEndpoint = (obj.continuationEndpoint as {
            getTranscriptEndpoint?: { params?: unknown }
        } | undefined)?.getTranscriptEndpoint;
        if (contEndpoint && isString(contEndpoint.params)) return contEndpoint.params;

        for (const value of Object.values(obj)) {
            const result = this.findTranscriptEndpoint(value);
            if (result) return result;
        }
        return null;
    }

    /**
     * Parse transcript data from /get_transcript API response into segments.
     */
    private static parseScrapeCreatorsTranscript(transcriptData: UnknownRecord): TranscriptSegment[] {
        // Look for transcript text in the response with enhanced search
        const findTranscriptText = (obj: unknown, depth = 0): unknown => {
            if (depth > 10) return null;

            if (isRecord(obj)) {
                // Check for the main transcript structure
                const transcriptBody = (obj['transcriptBody'] as { transcriptBodyRenderer?: { cueGroups?: unknown } } | undefined)?.transcriptBodyRenderer?.cueGroups;
                if (transcriptBody) return transcriptBody;

                // Check for alternative transcript structures
                const directCueGroups = obj['cueGroups'];
                if (directCueGroups && Array.isArray(directCueGroups)) return directCueGroups;

                // Check for updateEngagementPanelAction structure
                const initialSegments = (obj['updateEngagementPanelAction'] as {
                    content?: {
                        transcriptRenderer?: {
                            content?: {
                                transcriptSearchPanelRenderer?: {
                                    body?: {
                                        transcriptSegmentListRenderer?: {
                                            initialSegments?: unknown;
                                        };
                                    };
                                };
                            };
                        };
                    };
                } | undefined)?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
                if (initialSegments) return initialSegments;

                // Search through actions array
                const actions = obj['actions'];
                if (actions && Array.isArray(actions)) {
                    for (let i = 0; i < actions.length; i++) {
                        const result = findTranscriptText(actions[i], depth + 1);
                        if (result) return result;
                    }
                }

                // Search through all object properties
                for (const [, value] of Object.entries(obj)) {
                    if (typeof value === 'object') {
                        const result = findTranscriptText(value, depth + 1);
                        if (result) return result;
                    }
                }
            }
            return null;
        };

        const cueGroups = findTranscriptText(transcriptData);

        if (!cueGroups || !Array.isArray(cueGroups)) {
            transcriptLogger.error(`No cueGroups found in transcript response`);
            transcriptLogger.debug(`Transcript response keys: ${Object.keys(transcriptData).join(', ')}`);

            const transcriptActions = transcriptData.actions;
            if (Array.isArray(transcriptActions)) {
                transcriptLogger.debug(`Found ${transcriptActions.length} actions, examining structure...`);
                transcriptActions.forEach((action, i: number) => {
                    if (isRecord(action)) {
                        transcriptLogger.debug(`Action ${i} keys: ${Object.keys(action).join(', ')}`);
                    }
                });
            }

            throw new Error(`No transcript cueGroups found in YouTube API response`);
        }

        transcriptLogger.debug(`Found ${cueGroups.length} cue groups in transcript`);

        // Convert cue groups to segments - handle multiple formats
        const segments = cueGroups.map<TranscriptSegment | null>((cueGroup: unknown, index: number) => {
            // Traditional cueGroup format
            const cue = (cueGroup as {
                transcriptCueGroupRenderer?: {
                    cues?: Array<{
                        transcriptCueRenderer?: {
                            cue?: { simpleText?: string };
                            startOffsetMs?: string;
                            durationMs?: string;
                        };
                    }>;
                };
            }).transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
            if (cue) {
                return {
                    text: (cue.cue?.simpleText || '').trim(),
                    start: parseInt(cue.startOffsetMs || '0') / 1000,
                    duration: parseInt(cue.durationMs || '0') / 1000
                };
            }

            // Alternative format: transcriptSegmentRenderer (from initialSegments)
            const segmentRenderer = (cueGroup as {
                transcriptSegmentRenderer?: {
                    snippet?: { runs?: Array<{ text?: string }> };
                    startMs?: string;
                    endMs?: string;
                };
            }).transcriptSegmentRenderer;
            if (segmentRenderer) {
                const startMs = parseInt(segmentRenderer.startMs || '0');
                const endMs = parseInt(segmentRenderer.endMs || '0');
                return {
                    text: (segmentRenderer.snippet?.runs?.[0]?.text || '').trim(),
                    start: startMs / 1000,
                    duration: (endMs - startMs) / 1000
                };
            }

            if (index < 3) {
                const info = isRecord(cueGroup) ? Object.keys(cueGroup).join(', ') : 'non-object';
                transcriptLogger.debug(`Unknown cueGroup format at index ${index}: ${info}`);
            }
            return null;
        }).filter((segment): segment is TranscriptSegment => segment !== null && !!segment.text);

        if (segments.length === 0) {
            throw new Error(`No valid transcript segments found in YouTube API response`);
        }

        return segments;
    }

    /**
     * ANDROID client fallback: Uses ANDROID client which bypasses WEB restrictions.
     * Reference: https://github.com/LuanRT/YouTube.js and ScrapeCreators research
     */
    private static async fetchViaPlayerApiAndroid(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';
        const country = options.country || 'US';

        // Get API key from config
        const ytConfig = await this.getYouTubeConfig(videoId);
        transcriptLogger.debug('Player API (ANDROID): attempting with ANDROID client');

        // ANDROID client configuration - bypasses WEB restrictions
        // Version 20.10.38 from youtube-transcript-api (actively maintained Python library)
        const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${ytConfig.apiKey}`;
        const playerBody = {
            context: {
                client: {
                    clientName: 'ANDROID',
                    clientVersion: '20.10.38',
                    androidSdkVersion: 30,
                    hl: lang,
                    gl: country
                }
            },
            videoId
        };

        transcriptLogger.debug(`Player API (ANDROID): requesting caption tracks for ${videoId}`);

        const playerResponse = await obsidianFetch(playerUrl, {
            method: 'POST',
            headers: {
                'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'Origin': 'https://www.youtube.com',
                'X-Youtube-Client-Name': '3',  // 3 = ANDROID
                'X-Youtube-Client-Version': '20.10.38',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
            },
            body: JSON.stringify(playerBody)
        });

        if (!playerResponse.ok) {
            throw new Error(`Player API (ANDROID) error: HTTP ${playerResponse.status}`);
        }

        const playerData = await playerResponse.json() as UnknownRecord;

        const videoDetails = (playerData as {
            videoDetails?: { title?: string; author?: string };
        }).videoDetails;

        const metadata: TranscriptMetadata = {
            title: videoDetails?.title,
            author: videoDetails?.author
        };

        const captions = (playerData as {
            captions?: {
                playerCaptionsTracklistRenderer?: {
                    captionTracks?: Array<{ baseUrl?: string; languageCode?: string }>;
                };
            };
        }).captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!captions || !Array.isArray(captions) || captions.length === 0) {
            throw new Error('No caption tracks available from Player API (ANDROID)');
        }

        transcriptLogger.debug(`Player API (ANDROID): found ${captions.length} caption tracks`);

        // Prefer matching language, otherwise first track
        const preferredTrack = captions.find(track => track.languageCode?.startsWith(lang)) || captions[0];
        if (!preferredTrack?.baseUrl) {
            throw new Error('Caption track missing baseUrl');
        }

        const segments = await this.fetchCaptionTrack(preferredTrack.baseUrl);
        transcriptLogger.debug(`Player API (ANDROID): successfully extracted ${segments.length} segments`);
        return { segments, metadata };
    }

    /**
     * TVHTML5 client fallback: Uses TVHTML5 (smart-TV) client which may bypass WEB restrictions.
     */
    private static async fetchViaPlayerApiTV(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';
        const country = options.country || 'US';

        // Get API key from config
        const ytConfig = await this.getYouTubeConfig(videoId);
        transcriptLogger.debug('Player API (TV): attempting with TVHTML5 client');

        // TVHTML5 client configuration — smart-TV / Cobalt-based YouTube app
        const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${ytConfig.apiKey}`;
        const playerBody = {
            context: {
                client: {
                    clientName: 'TVHTML5',
                    clientVersion: '7.20250312.16.00',
                    hl: lang,
                    gl: country
                }
            },
            videoId
        };

        transcriptLogger.debug(`Player API (TV): requesting caption tracks for ${videoId}`);

        const playerResponse = await obsidianFetch(playerUrl, {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'Origin': 'https://www.youtube.com',
                'X-Youtube-Client-Name': '7',  // 7 = TVHTML5
                'X-Youtube-Client-Version': '7.20250312.16.00',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
            },
            body: JSON.stringify(playerBody)
        });

        if (!playerResponse.ok) {
            throw new Error(`Player API (TV) error: HTTP ${playerResponse.status}`);
        }

        const playerData = await playerResponse.json() as UnknownRecord;

        const videoDetails = (playerData as {
            videoDetails?: { title?: string; author?: string };
        }).videoDetails;

        const metadata: TranscriptMetadata = {
            title: videoDetails?.title,
            author: videoDetails?.author
        };

        const captions = (playerData as {
            captions?: {
                playerCaptionsTracklistRenderer?: {
                    captionTracks?: Array<{ baseUrl?: string; languageCode?: string }>;
                };
            };
        }).captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!captions || !Array.isArray(captions) || captions.length === 0) {
            throw new Error('No caption tracks available from Player API (TV)');
        }

        transcriptLogger.debug(`Player API (TV): found ${captions.length} caption tracks`);

        // Prefer matching language, otherwise first track
        const preferredTrack = captions.find(track => track.languageCode?.startsWith(lang)) || captions[0];
        if (!preferredTrack?.baseUrl) {
            throw new Error('Caption track missing baseUrl');
        }

        const segments = await this.fetchCaptionTrack(preferredTrack.baseUrl);
        transcriptLogger.debug(`Player API (TV): successfully extracted ${segments.length} segments`);
        return { segments, metadata };
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
        const metadata: TranscriptMetadata = this.cachedConfig?.metadata ?? {};
        transcriptLogger.debug(`Supadata: using cached metadata — title="${metadata.title}", author="${metadata.author}"`);
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
        const metadata: TranscriptMetadata = this.cachedConfig?.metadata ?? {};
        transcriptLogger.debug(`ScrapeCreators: using cached metadata — title="${metadata.title}", author="${metadata.author}"`);
        return { segments, metadata };
    }

    /**
     * Fetch and parse captions from a caption track baseUrl using json3 format
     */
    private static async fetchCaptionTrack(baseUrl: string, tlang?: string): Promise<TranscriptSegment[]> {
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
        const responseText = await this.fetchCaptionTrackWithFormat(url, 'json3');
        if (responseText.length > 0) {
            transcriptLogger.debug(`Caption track json3 response length: ${responseText.length}`);
            return this.parseCaptionTrackResponse(responseText);
        }

        // json3 returned empty — retry with srv3 (XML) format
        transcriptLogger.debug('json3 format returned empty response, retrying with srv3 (XML)');
        const xmlText = await this.fetchCaptionTrackWithFormat(url, 'srv3');
        if (xmlText.length > 0) {
            transcriptLogger.debug(`Caption track srv3 response length: ${xmlText.length}`);
            return this.parseCaptionTrackResponse(xmlText);
        }

        // Both formats returned empty — try the original URL without format override
        transcriptLogger.debug('srv3 also empty, trying original URL without fmt override');
        const originalText = await this.fetchCaptionTrackRaw(url);
        if (originalText.length > 0) {
            transcriptLogger.debug(`Caption track original response length: ${originalText.length}`);
            return this.parseCaptionTrackResponse(originalText);
        }

        throw new Error('Caption track returned empty response for all format attempts');
    }

    /**
     * Fetch caption track with a specific format parameter.
     */
    private static async fetchCaptionTrackWithFormat(baseUrl: string, fmt: string): Promise<string> {
        let url = baseUrl;
        if (url.includes('fmt=')) {
            url = url.replace(/fmt=[^&]+/g, `fmt=${fmt}`);
        } else {
            url = `${url}&fmt=${fmt}`;
        }
        return this.fetchCaptionTrackRaw(url);
    }

    /**
     * Raw fetch for a caption track URL, returning the response text.
     */
    private static async fetchCaptionTrackRaw(url: string): Promise<string> {
        transcriptLogger.debug(`Fetching caption track from: ${url.substring(0, 100)}...`);

        const response = await obsidianFetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.youtube.com',
                'Referer': 'https://www.youtube.com/',
                'DNT': '1',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
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

    /**
     * Parses YouTube captions in JSON format
     * @param jsonText The JSON content of captions
     * @param videoId Video ID for reference
     * @returns Parsed transcript segments
     */
    static parseJsonCaptions(jsonText: string, videoId: string): TranscriptSegment[] {
        transcriptLogger.debug(`Parsing JSON captions for video ${videoId}`);
        
        try {
            const transcriptJson = JSON.parse(jsonText) as { events?: unknown[] };
            const events = Array.isArray(transcriptJson.events) ? transcriptJson.events : [];
            
            // Convert events to our TranscriptSegment format
            const segments: TranscriptSegment[] = [];
            
            events
                .filter((event): event is { segs?: Array<{ utf8?: string }>; tStartMs?: string; dDurationMs?: string } => {
                    return isRecord(event) && Array.isArray(event.segs);
                })
                .forEach((event) => {
                    const startMs = event.tStartMs ? parseInt(event.tStartMs) : 0;
                    const durationMs = event.dDurationMs ? parseInt(event.dDurationMs) : 0;
                    
                    // Combine all segments in this event
                    const text = (event.segs ?? [])
                        .map((seg) => seg.utf8 || '')
                        .join('')
                        .replace(/[\u200B-\u200D\uFEFF]/g, ''); // Remove special chars
                    
                    const trimmedText = text.trim();
                    if (trimmedText) {
                        segments.push({
                            text: trimmedText,
                            start: startMs / 1000, // Convert to seconds
                            duration: durationMs / 1000 // Convert to seconds
                        });
                    }
                });
            
            if (segments.length === 0) {
                throw new Error(`No transcript segments found in JSON data. Video ID: ${videoId}`);
            }
            
            return segments;
            
        } catch (e) {
            const errorMessage = getSafeErrorMessage(e);
            transcriptLogger.error("Error parsing JSON captions:", errorMessage);
            
            // Return a basic error segment
            return [
                {
                    text: `Failed to parse YouTube JSON captions for video ${videoId}. Error: ${errorMessage}`,
                    start: 0,
                    duration: 0
                }
            ];
        }
    }

}
