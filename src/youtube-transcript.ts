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
    kind?: string; 
    baseUrl?: string;
}

export interface TranscriptSegment {
    text: string;
    start: number;
    duration: number;
}

export interface TranscriptOptions {
    lang?: string;
    country?: string;
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
        // Primary method: ANDROID client via Player API (most reliable)
        // Fallback: WEB client with ScrapeCreators method (requires visitorData, often fails with HTTP 400)

        let metadata: TranscriptMetadata = {};

        try {
            transcriptLogger.debug(`Fetching YouTube transcript for video: ${videoId}`);

            // Primary: Try ANDROID client first (most reliable)
            try {
                transcriptLogger.debug('Attempting primary method: ANDROID client via Player API');
                const androidResult = await this.fetchViaPlayerApiAndroid(videoId, options);
                transcriptLogger.debug(`ANDROID method succeeded with ${androidResult.segments.length} segments`);
                return androidResult;
            } catch (androidError) {
                const androidErrorMessage = getSafeErrorMessage(androidError);
                transcriptLogger.error('ANDROID client failed:', androidErrorMessage);
                transcriptLogger.debug('Attempting fallback with WEB client');
            }

            // Fallback: WEB client with ScrapeCreators method
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

            try {
                // Using direct ScrapeCreators method - optimized to extract metadata from the same API call
                // Reference: https://scrapecreators.com/blog/how-to-scrape-youtube-transcripts-with-node-js-in-2025

                // First, get YouTube config (API key, client version, visitor data) from watch page
                const ytConfig = await this.getYouTubeConfig(videoId);
                transcriptLogger.debug(`Using WEB fallback with clientVersion: ${ytConfig.clientVersion}`);

                // Direct method: ScrapeCreators two-step approach
                // Step 1: Get transcript parameters from YouTube's internal API
                transcriptLogger.debug(`Using ScrapeCreators method: fetching transcript parameters via YouTubei API`);

                const nextApiUrl = `https://www.youtube.com/youtubei/v1/next?prettyPrint=false`;

                // Step 1: Request to get transcript parameters (with dynamic client version and visitorData)
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

                transcriptLogger.debug(`Step 1: Requesting transcript parameters from ${nextApiUrl}`);

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
                transcriptLogger.debug(`Step 1 completed: received ${JSON.stringify(nextData).length} characters of next API data`);
                
                // Extract metadata from nextData response to eliminate redundant first fetch
                const extractMetadataFromNextData = (nextData: unknown): TranscriptMetadata => {
                    const metadata: TranscriptMetadata = {};
                    if (!isRecord(nextData)) {
                        return metadata;
                    }
                    
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
                            transcriptLogger.debug(`Extracted metadata from playerOverlays: title="${metadata.title}", author="${metadata.author}"`);
                        }
                        
                        // Method 2: From contents (fallback)
                        if (!metadata.title || !metadata.author) {
                            const contents = typedNextData.contents?.twoColumnWatchNextResults?.results?.results?.contents;
                            if (Array.isArray(contents)) {
                                // Look for title in videoPrimaryInfoRenderer
                                const primaryInfo = contents.find((c) => c.videoPrimaryInfoRenderer);
                                if (primaryInfo && !metadata.title) {
                                    metadata.title = primaryInfo.videoPrimaryInfoRenderer?.title?.runs?.[0]?.text;
                                    transcriptLogger.debug(`Extracted title from videoPrimaryInfoRenderer: "${metadata.title}"`);
                                }
                                
                                // Look for author in videoSecondaryInfoRenderer
                                const secondaryInfo = contents.find((c) => c.videoSecondaryInfoRenderer);
                                if (secondaryInfo && !metadata.author) {
                                    metadata.author = secondaryInfo.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text;
                                    transcriptLogger.debug(`Extracted author from videoSecondaryInfoRenderer: "${metadata.author}"`);
                                }
                            }
                        }
                        
                        // Method 3: Search for videoDetails in microformat (additional fallback)
                        if (!metadata.title || !metadata.author) {
                            const microformat = typedNextData.microformat?.playerMicroformatRenderer;
                            if (microformat) {
                                if (!metadata.title && microformat.title?.simpleText) {
                                    metadata.title = microformat.title.simpleText;
                                    transcriptLogger.debug(`Extracted title from microformat: "${metadata.title}"`);
                                }
                                if (!metadata.author && microformat.ownerChannelName) {
                                    metadata.author = microformat.ownerChannelName;
                                    transcriptLogger.debug(`Extracted author from microformat: "${metadata.author}"`);
                                }
                            }
                        }
                        
                    } catch (error) {
                        const errorMessage = getSafeErrorMessage(error);
                        transcriptLogger.debug(`Error extracting metadata from nextData: ${errorMessage}`);
                    }
                    
                    return metadata;
                };
                
                // Extract metadata from the nextData response
                metadata = extractMetadataFromNextData(nextData);
                transcriptLogger.debug(`Final extracted metadata: title="${metadata.title || 'Not found'}", author="${metadata.author || 'Not found'}"`);
                
                // Log if we successfully extracted metadata
                if (metadata.title) {
                    transcriptLogger.debug(`Video title: ${metadata.title}`);
                }
                if (metadata.author) {
                    transcriptLogger.debug(`Video author: ${metadata.author}`);
                }

                // Extract transcript endpoint parameters and call /get_transcript API
                let transcriptParams: string | null = null;
                try {
                    // Look for getTranscriptEndpoint in the response (including in continuationItemRenderer)
                    const findTranscriptEndpoint = (obj: unknown): string | null => {
                        if (!isRecord(obj)) {
                            return null;
                        }

                        // Check direct getTranscriptEndpoint
                        const endpoint = obj.getTranscriptEndpoint as { params?: unknown } | undefined;
                        if (endpoint && isString(endpoint.params)) {
                            return endpoint.params;
                        }

                        // Check continuationEndpoint.getTranscriptEndpoint (new location)
                        const contEndpoint = (obj.continuationEndpoint as {
                            getTranscriptEndpoint?: { params?: unknown }
                        } | undefined)?.getTranscriptEndpoint;
                        if (contEndpoint && isString(contEndpoint.params)) {
                            return contEndpoint.params;
                        }

                        for (const value of Object.values(obj)) {
                            const result = findTranscriptEndpoint(value);
                            if (result) return result;
                        }
                        return null;
                    };

                    transcriptParams = findTranscriptEndpoint(nextData);

                    if (!transcriptParams) {
                        transcriptLogger.error(`No getTranscriptEndpoint.params found in next API response`);
                        if (isRecord(nextData)) {
                            transcriptLogger.debug(`Next API response keys: ${Object.keys(nextData).join(', ')}`);
                        }
                        throw new Error(`No transcript parameters found in YouTube API response for video ${videoId}`);
                    }

                    transcriptLogger.debug(`Found transcript parameters: ${transcriptParams.substring(0, 100)}...`);
                } catch (parseError) {
                    const errorMessage = getSafeErrorMessage(parseError);
                    transcriptLogger.error(`Error parsing next API response: ${errorMessage}`);
                    throw new Error(`Failed to extract transcript parameters from YouTube API response`);
                }
                
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

                transcriptLogger.debug(`Step 2: Requesting transcript from ${getTranscriptUrl}`);
                transcriptLogger.debug(`Step 2: Using params: ${transcriptParams.substring(0, 100)}...`);

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
                    // Log the error response body for debugging
                    try {
                        const errorBody = await transcriptResponse.text();
                        transcriptLogger.error(`get_transcript failed with HTTP ${transcriptResponse.status}: ${errorBody.substring(0, 500)}`);
                    } catch {
                        transcriptLogger.error(`get_transcript failed with HTTP ${transcriptResponse.status}`);
                    }
                    throw new Error(`Failed to fetch transcript: HTTP ${transcriptResponse.status}`);
                }
                
                const transcriptData = await transcriptResponse.json() as UnknownRecord;
                transcriptLogger.debug(`Step 2 completed: received transcript data with ${JSON.stringify(transcriptData).length} characters`);
                
                // Parse the transcript data
                try {
                    // Look for transcript text in the response with enhanced search
                    const findTranscriptText = (obj: unknown, depth = 0, path = 'root'): unknown => {
                        if (depth > 10) return null; // Prevent infinite recursion
                        
                        if (isRecord(obj)) {
                            // Check for the main transcript structure
                            const transcriptBody = (obj['transcriptBody'] as { transcriptBodyRenderer?: { cueGroups?: unknown } } | undefined)?.transcriptBodyRenderer?.cueGroups;
                            if (transcriptBody) {
                                transcriptLogger.debug(`Found cueGroups at path: ${path}.transcriptBody.transcriptBodyRenderer.cueGroups`);
                                return transcriptBody;
                            }
                            
                            // Check for alternative transcript structures
                            const directCueGroups = obj['cueGroups'];
                            if (directCueGroups && Array.isArray(directCueGroups)) {
                                transcriptLogger.debug(`Found cueGroups directly at path: ${path}.cueGroups`);
                                return directCueGroups;
                            }
                            
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
                            if (initialSegments) {
                                transcriptLogger.debug(`Found segments in updateEngagementPanelAction at path: ${path}`);
                                return initialSegments;
                            }
                            
                            // Search through actions array
                            const actions = obj['actions'];
                            if (actions && Array.isArray(actions)) {
                                for (let i = 0; i < actions.length; i++) {
                                    const result = findTranscriptText(actions[i], depth + 1, `${path}.actions[${i}]`);
                                    if (result) return result;
                                }
                            }
                            
                            // Search through all object properties
                            for (const [key, value] of Object.entries(obj)) {
                                if (typeof value === 'object') {
                                    const result = findTranscriptText(value, depth + 1, `${path}.${key}`);
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
                        
                        // If we have actions, let's examine their structure
                        const transcriptActions = transcriptData.actions;
                        if (Array.isArray(transcriptActions)) {
                            transcriptLogger.debug(`Found ${transcriptActions.length} actions, examining structure...`);
                            transcriptActions.forEach((action, i: number) => {
                                if (isRecord(action)) {
                                    transcriptLogger.debug(`Action ${i} keys: ${Object.keys(action).join(', ')}`);
                                    if (action.updateEngagementPanelAction) {
                                        transcriptLogger.debug(`Action ${i} has updateEngagementPanelAction`);
                                    }
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
                            const text = cue.cue?.simpleText || '';
                            const startMs = parseInt(cue.startOffsetMs || '0');
                            const durationMs = parseInt(cue.durationMs || '0');
                            
                            return {
                                text: text.trim(),
                                start: startMs / 1000, // Convert to seconds
                                duration: durationMs / 1000 // Convert to seconds
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
                            const text = segmentRenderer.snippet?.runs?.[0]?.text || '';
                            const startMs = parseInt(segmentRenderer.startMs || '0');
                            const endMs = parseInt(segmentRenderer.endMs || '0');
                            const durationMs = endMs - startMs;
                            
                            return {
                                text: text.trim(),
                                start: startMs / 1000, // Convert to seconds
                                duration: durationMs / 1000 // Convert to seconds
                            };
                        }
                        
                        // If neither format works, log for debugging
                        if (index < 3) { // Only log first few for debugging
                            const cueGroupInfo = isRecord(cueGroup) ? Object.keys(cueGroup).join(', ') : 'non-object cue group';
                            transcriptLogger.debug(`Unknown cueGroup format at index ${index}: ${cueGroupInfo}`);
                        }
                        
                        return null;
                    }).filter((segment): segment is TranscriptSegment => segment !== null && !!segment.text);
                    
                    transcriptLogger.debug(`Parsed ${segments.length} transcript segments`);
                    
                    if (segments.length === 0) {
                        throw new Error(`No valid transcript segments found in YouTube API response`);
                    }
                    
                    transcriptLogger.debug(`ScrapeCreators method succeeded with ${segments.length} segments`);
                    return { segments, metadata };
                    
                } catch (parseError) {
                    const errorMessage = getSafeErrorMessage(parseError);
                    transcriptLogger.error(`Error parsing transcript response: ${errorMessage}`);
                    throw new Error(`Failed to parse transcript data from YouTube API response`);
                }
                
            } catch (error) {
                const errorMessage = getSafeErrorMessage(error);
                transcriptLogger.error('WEB fallback also failed:', errorMessage);

                // If we successfully extracted metadata but caption fetching failed,
                // we should still return the metadata with an error transcript
                if (metadata && (metadata.title || metadata.author)) {
                    transcriptLogger.debug('Returning metadata despite caption failure');
                    return {
                        segments: [{
                            text: `[TRANSCRIPT EXTRACTION FAILED: Both ANDROID and WEB methods failed. ${errorMessage}]`,
                            start: 0,
                            duration: 0
                        }],
                        metadata
                    };
                }

                throw error;
            }

        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            transcriptLogger.error('Error fetching transcript from YouTube:', errorMessage);
            
            // Detect if this is a CORS error
            if (errorMessage.includes('CORS') || 
                errorMessage.includes('Cross-Origin') || 
                errorMessage.includes('Access-Control-Allow-Origin')
            ) {
                throw new Error('CORS policy blocked the request. Please try a different video or check your internet connection.');
            }
            
            // Check for network errors
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
        try {
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            
            // Request with User-Agent to ensure we get the full page
            const response = await obsidianFetch(watchUrl, {
                headers: {
                    'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                    ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
                },
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch watch page: HTTP ${response.status}`);
            }
            
            const body = await response.text();
            const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+(?:meta|head)|<\/script|\n)/;
            const match = body.match(playerResponseRegex);
            
            if (!match) {
                throw new Error("Unable to locate ytInitialPlayerResponse in watch page HTML.");
            }
            
            const playerResponse = JSON.parse(match[1]) as unknown;
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
            const response = await obsidianFetch(watchUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'DNT': '1',
                    ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();

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

            this.cachedConfig = {
                apiKey,
                clientVersion,
                visitorData
            };

            transcriptLogger.debug(`Extracted YouTube config - clientVersion: ${clientVersion}, visitorData: ${visitorData ? 'present' : 'not found'}`);
            return this.cachedConfig;

        } catch (err) {
            const errorMessage = getSafeErrorMessage(err);
            transcriptLogger.warn(`Failed to extract YouTube config dynamically: ${errorMessage}`);

            // Return fallback config without API key - caller should handle this
            throw new Error(`Unable to extract YouTube configuration from watch page: ${errorMessage}`);
        }
    }

    /**
     * Get just the Innertube API key (convenience method, uses cached config)
     */
    private static async getInnertubeApiKey(videoId: string): Promise<string> {
        const config = await this.getYouTubeConfig(videoId);
        return config.apiKey;
    }

    /**
     * Clear the cached YouTube config (useful for testing or after errors)
     */
    static clearConfigCache(): void {
        this.cachedConfig = null;
        transcriptLogger.debug('YouTube config cache cleared');
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
        const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${ytConfig.apiKey}`;
        const playerBody = {
            context: {
                client: {
                    clientName: 'ANDROID',
                    clientVersion: '19.09.37',  // Stable ANDROID version
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
                'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'Origin': 'https://www.youtube.com',
                'X-Youtube-Client-Name': '3',  // 3 = ANDROID
                'X-Youtube-Client-Version': '19.09.37',
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
     * Modern player API approach: call youtubei player endpoint, extract captionTracks baseUrl, and fetch captions directly.
     */
    private static async fetchViaPlayerApi(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
        const lang = options.lang || 'en';
        const country = options.country || 'US';

        // Get dynamic YouTube config
        const ytConfig = await this.getYouTubeConfig(videoId);
        transcriptLogger.debug(`Player API: using clientVersion ${ytConfig.clientVersion}`);

        const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${ytConfig.apiKey}`;
        const playerBody = {
            context: {
                client: {
                    clientName: 'WEB',
                    clientVersion: ytConfig.clientVersion,
                    hl: lang,
                    gl: country
                }
            },
            videoId
        };

        transcriptLogger.debug(`Player API: requesting caption tracks for ${videoId}`);

        const playerResponse = await obsidianFetch(playerUrl, {
            method: 'POST',
            headers: {
                'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'Origin': 'https://www.youtube.com',
                'Referer': `https://www.youtube.com/watch?v=${videoId}`,
                'X-Youtube-Client-Name': '1',
                'X-Youtube-Client-Version': ytConfig.clientVersion,
                'DNT': '1',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
            },
            body: JSON.stringify(playerBody)
        });
        
        if (!playerResponse.ok) {
            throw new Error(`Player API error: HTTP ${playerResponse.status}`);
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
            throw new Error('No caption tracks available from player API');
        }
        
        // Prefer matching language, otherwise first track
        const preferredTrack = captions.find(track => track.languageCode?.startsWith(lang)) || captions[0];
        if (!preferredTrack?.baseUrl) {
            throw new Error('Caption track missing baseUrl');
        }
        
        const segments = await this.fetchCaptionTrack(preferredTrack.baseUrl);
        return { segments, metadata };
    }

    /**
     * Fetch and parse captions from a caption track baseUrl using json3 format
     */
    private static async fetchCaptionTrack(baseUrl: string): Promise<TranscriptSegment[]> {
        // Remove any existing fmt= parameter and add fmt=json3
        // YouTube URLs can have fmt=srv3 which returns XML - we need JSON
        let url = baseUrl;
        if (url.includes('fmt=')) {
            // Replace existing fmt parameter with json3
            url = url.replace(/fmt=[^&]+/g, 'fmt=json3');
        } else {
            url = `${url}&fmt=json3`;
        }

        transcriptLogger.debug(`Fetching caption track from: ${url.substring(0, 100)}...`);

        const response = await obsidianFetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': YouTubeTranscriptExtractor.USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'DNT': '1',
                ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch caption track: HTTP ${response.status}`);
        }

        // Get response as text first to inspect it
        const responseText = await response.text();
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
