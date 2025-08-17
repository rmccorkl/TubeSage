/**
 * YouTube Transcript Extractor
 * Uses a direct approach to extract transcripts from YouTube videos
 */

// Import HTTP fetch shim - IMPORTANT: Always use obsidianFetch instead of direct requestUrl
// to ensure consistent behavior across desktop and mobile platforms
import { obsidianFetch } from "src/utils/fetch-shim";
import { getLogger } from "src/utils/logger";
const transcriptLogger = getLogger("TRANSCRIPT");

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


export class YouTubeTranscriptExtractor {
    private static readonly USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    private static cookieStore: string = '';
    
    
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
        let metadata: TranscriptMetadata = {};
        
        try {
            transcriptLogger.debug(`Fetching YouTube transcript for video: ${videoId}`);
            
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            
            try {
                // Using direct ScrapeCreators method - optimized to extract metadata from the same API call
                
                // Direct method: ScrapeCreators two-step approach
                // Step 1: Get transcript parameters from YouTube's internal API
                transcriptLogger.debug(`Using ScrapeCreators method: fetching transcript parameters via YouTubei API`);
                
                const nextApiUrl = `https://www.youtube.com/youtubei/v1/next?prettyPrint=false`;
                
                // Step 1: Request to get transcript parameters
                const nextRequestBody = {
                    context: {
                        client: {
                            clientName: "WEB",
                            clientVersion: "2.20241205.01.00"
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
                        'DNT': '1',
                        ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
                    },
                    body: JSON.stringify(nextRequestBody)
                });
                
                if (!nextResponse.ok) {
                    throw new Error(`Failed to fetch next API data: HTTP ${nextResponse.status}`);
                }
                
                const nextData = await nextResponse.json();
                transcriptLogger.debug(`Step 1 completed: received ${JSON.stringify(nextData).length} characters of next API data`);
                
                // Extract metadata from nextData response to eliminate redundant first fetch
                const extractMetadataFromNextData = (nextData: any): TranscriptMetadata => {
                    const metadata: TranscriptMetadata = {};
                    
                    try {
                        // Method 1: From playerOverlays (most reliable)
                        const playerOverlayDetails = nextData?.playerOverlays?.playerOverlayRenderer?.videoDetails?.playerOverlayVideoDetailsRenderer;
                        if (playerOverlayDetails) {
                            metadata.title = playerOverlayDetails.title?.simpleText;
                            metadata.author = playerOverlayDetails.subtitle?.runs?.[0]?.text;
                            transcriptLogger.debug(`Extracted metadata from playerOverlays: title="${metadata.title}", author="${metadata.author}"`);
                        }
                        
                        // Method 2: From contents (fallback)
                        if (!metadata.title || !metadata.author) {
                            const contents = nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
                            if (Array.isArray(contents)) {
                                // Look for title in videoPrimaryInfoRenderer
                                const primaryInfo = contents.find((c: any) => c.videoPrimaryInfoRenderer);
                                if (primaryInfo && !metadata.title) {
                                    metadata.title = primaryInfo.videoPrimaryInfoRenderer.title?.runs?.[0]?.text;
                                    transcriptLogger.debug(`Extracted title from videoPrimaryInfoRenderer: "${metadata.title}"`);
                                }
                                
                                // Look for author in videoSecondaryInfoRenderer
                                const secondaryInfo = contents.find((c: any) => c.videoSecondaryInfoRenderer);
                                if (secondaryInfo && !metadata.author) {
                                    metadata.author = secondaryInfo.videoSecondaryInfoRenderer.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text;
                                    transcriptLogger.debug(`Extracted author from videoSecondaryInfoRenderer: "${metadata.author}"`);
                                }
                            }
                        }
                        
                        // Method 3: Search for videoDetails in microformat (additional fallback)
                        if (!metadata.title || !metadata.author) {
                            const microformat = nextData?.microformat?.playerMicroformatRenderer;
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
                        transcriptLogger.debug(`Error extracting metadata from nextData: ${error.message}`);
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
                
                // Extract transcript endpoint parameters
                let transcriptParams = null;
                try {
                    // Look for getTranscriptEndpoint in the response
                    const findTranscriptEndpoint = (obj: any): any => {
                        if (obj && typeof obj === 'object') {
                            if (obj.getTranscriptEndpoint?.params) {
                                return obj.getTranscriptEndpoint.params;
                            }
                            for (const key in obj) {
                                const result = findTranscriptEndpoint(obj[key]);
                                if (result) return result;
                            }
                        }
                        return null;
                    };
                    
                    transcriptParams = findTranscriptEndpoint(nextData);
                    
                    if (!transcriptParams) {
                        transcriptLogger.error(`No getTranscriptEndpoint.params found in next API response`);
                        transcriptLogger.debug(`Next API response keys: ${Object.keys(nextData).join(', ')}`);
                        throw new Error(`No transcript parameters found in YouTube API response for video ${videoId}`);
                    }
                    
                    transcriptLogger.debug(`Found transcript parameters: ${transcriptParams.substring(0, 100)}...`);
                } catch (parseError) {
                    transcriptLogger.error(`Error parsing next API response: ${parseError.message}`);
                    throw new Error(`Failed to extract transcript parameters from YouTube API response`);
                }
                
                // Step 2: Request the actual transcript using the parameters
                const getTranscriptUrl = `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false`;
                
                const transcriptRequestBody = {
                    context: {
                        client: {
                            clientName: "WEB",
                            clientVersion: "2.20241205.01.00"
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
                        'DNT': '1',
                        ...(YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })
                    },
                    body: JSON.stringify(transcriptRequestBody)
                });
                
                if (!transcriptResponse.ok) {
                    throw new Error(`Failed to fetch transcript: HTTP ${transcriptResponse.status}`);
                }
                
                const transcriptData = await transcriptResponse.json();
                transcriptLogger.debug(`Step 2 completed: received transcript data with ${JSON.stringify(transcriptData).length} characters`);
                
                // Parse the transcript data
                try {
                    // Look for transcript text in the response with enhanced search
                    const findTranscriptText = (obj: any, depth = 0, path = 'root'): any => {
                        if (depth > 10) return null; // Prevent infinite recursion
                        
                        if (obj && typeof obj === 'object') {
                            // Check for the main transcript structure
                            if (obj.transcriptBody?.transcriptBodyRenderer?.cueGroups) {
                                transcriptLogger.debug(`Found cueGroups at path: ${path}.transcriptBody.transcriptBodyRenderer.cueGroups`);
                                return obj.transcriptBody.transcriptBodyRenderer.cueGroups;
                            }
                            
                            // Check for alternative transcript structures
                            if (obj.cueGroups && Array.isArray(obj.cueGroups)) {
                                transcriptLogger.debug(`Found cueGroups directly at path: ${path}.cueGroups`);
                                return obj.cueGroups;
                            }
                            
                            // Check for updateEngagementPanelAction structure
                            if (obj.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments) {
                                transcriptLogger.debug(`Found segments in updateEngagementPanelAction at path: ${path}`);
                                return obj.updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments;
                            }
                            
                            // Search through actions array
                            if (obj.actions && Array.isArray(obj.actions)) {
                                for (let i = 0; i < obj.actions.length; i++) {
                                    const result = findTranscriptText(obj.actions[i], depth + 1, `${path}.actions[${i}]`);
                                    if (result) return result;
                                }
                            }
                            
                            // Search through all object properties
                            for (const key in obj) {
                                if (typeof obj[key] === 'object') {
                                    const result = findTranscriptText(obj[key], depth + 1, `${path}.${key}`);
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
                        if (transcriptData.actions && Array.isArray(transcriptData.actions)) {
                            transcriptLogger.debug(`Found ${transcriptData.actions.length} actions, examining structure...`);
                            transcriptData.actions.forEach((action: any, i: number) => {
                                if (action && typeof action === 'object') {
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
                    const segments = cueGroups.map((cueGroup: any, index: number) => {
                        // Traditional cueGroup format
                        const cue = cueGroup.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
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
                        const segmentRenderer = cueGroup.transcriptSegmentRenderer;
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
                            transcriptLogger.debug(`Unknown cueGroup format at index ${index}: ${Object.keys(cueGroup).join(', ')}`);
                        }
                        
                        return null;
                    }).filter((segment: any): segment is TranscriptSegment => segment !== null && segment.text);
                    
                    transcriptLogger.debug(`Parsed ${segments.length} transcript segments`);
                    
                    if (segments.length === 0) {
                        throw new Error(`No valid transcript segments found in YouTube API response`);
                    }
                    
                    transcriptLogger.debug(`ScrapeCreators method succeeded with ${segments.length} segments`);
                    return { segments, metadata };
                    
                } catch (parseError) {
                    transcriptLogger.error(`Error parsing transcript response: ${parseError.message}`);
                    throw new Error(`Failed to parse transcript data from YouTube API response`);
                }
                
            } catch (error) {
                transcriptLogger.error('Error fetching transcript:', error?.message || error);
                
                // If we successfully extracted metadata but caption fetching failed,
                // we should still return the metadata with an error transcript
                if (metadata && (metadata.title || metadata.author)) {
                    transcriptLogger.debug('Returning metadata despite caption failure');
                    return {
                        segments: [{
                            text: `[TRANSCRIPT EXTRACTION FAILED: ${error?.message || error}]`,
                            start: 0,
                            duration: 0
                        }],
                        metadata
                    };
                }
                
                throw error;
            }
            
        } catch (error) {
            transcriptLogger.error('Error fetching transcript from YouTube:', error?.message || error);
            
            // Detect if this is a CORS error
            if (error.message && (
                error.message.includes('CORS') || 
                error.message.includes('Cross-Origin') || 
                error.message.includes('Access-Control-Allow-Origin')
            )) {
                throw new Error('CORS policy blocked the request. Please try a different video or check your internet connection.');
            }
            
            // Check for network errors
            if (error.message && (
                error.message.includes('network') || 
                error.message.includes('fetch') || 
                error.message.includes('connect') ||
                error.message.includes('timeout')
            )) {
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
            
            const playerResponse = JSON.parse(match[1]);
            
            return {
                title: playerResponse?.videoDetails?.title,
                author: playerResponse?.videoDetails?.author
            };
            
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
            transcriptLogger.error("Error parsing XML captions:", e);
            
            // Return a basic error segment
            return [
                {
                    text: `Failed to parse YouTube captions for video ${videoId}. Error: ${e.message}`,
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
            const transcriptJson = JSON.parse(jsonText);
            const events = transcriptJson.events || [];
            
            // Convert events to our TranscriptSegment format
            const segments: TranscriptSegment[] = [];
            
            events
                .filter((e: any) => e.segs && Array.isArray(e.segs)) // Filter events with text segments
                .forEach((e: any) => {
                    const startMs = e.tStartMs ? parseInt(e.tStartMs) : 0;
                    const durationMs = e.dDurationMs ? parseInt(e.dDurationMs) : 0;
                    
                    // Combine all segments in this event
                    const text = e.segs
                        .map((seg: any) => seg.utf8 || '')
                        .join('')
                        .replace(/[\u200B-\u200D\uFEFF]/g, ''); // Remove special chars
                    
                    if (text.trim()) {
                        segments.push({
                            text: text.trim(),
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
            transcriptLogger.error("Error parsing JSON captions:", e);
            
            // Return a basic error segment
            return [
                {
                    text: `Failed to parse YouTube JSON captions for video ${videoId}. Error: ${e.message}`,
                    start: 0,
                    duration: 0
                }
            ];
        }
    }

}
