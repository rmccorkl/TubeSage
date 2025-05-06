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

interface TranscriptSegment {
    text: string;
    start: number;
    duration: number;
}

interface TranscriptOptions {
    lang?: string;
    country?: string;
}

interface TranscriptMetadata {
    title?: string;
    author?: string;
}

// Type-safe helper to check if running in Obsidian mobile
function isObsidianMobile(): boolean {
    return typeof window !== "undefined" &&
        typeof (window as { app?: { isMobile?: boolean } }).app !== "undefined" &&
        (window as { app?: { isMobile?: boolean } }).app?.isMobile === true;
}

export class YouTubeTranscriptExtractor {
    /**
     * Helper function to convert relative YouTube URLs to absolute URLs
     * YouTube API sometimes returns relative URLs that need to be converted
     * to absolute URLs before using with obsidianFetch
     * 
     * @param url The potentially relative URL
     * @param isMobile Whether to use mobile YouTube domain
     * @returns An absolute URL
     */
    private static makeAbsoluteUrl(url: string, isMobile: boolean = false): string {
        if (url.startsWith('/')) {
            const domain = isMobile ? 'https://m.youtube.com' : 'https://www.youtube.com';
            const absoluteUrl = domain + url;
            transcriptLogger.debug(`Fixed relative URL to absolute: ${url} → ${absoluteUrl}`);
            return absoluteUrl;
        }
        return url;
    }
    
    /**
     * Extracts a transcript from a YouTube video
     * @param videoId YouTube video ID
     * @param options Optional language and country settings
     * @returns Promise with transcript segments
     */
    static async fetchTranscript(videoId: string, options: TranscriptOptions = {}): Promise<TranscriptSegment[]> {
        try {
            // Check if we're on mobile
            const isMobile = isObsidianMobile();
            
            // Fetch captions using the player response approach
            // For mobile, try to use the mobile YouTube URL variant which might be better supported
            // Also add language params to the URL since we can't use headers with requestUrl
            const watchUrl = isMobile 
                ? `https://m.youtube.com/watch?v=${videoId}&hl=${options.lang || 'en'}&gl=${options.country || 'US'}`
                : `https://www.youtube.com/watch?v=${videoId}`;
            
            transcriptLogger.debug(`Fetching YouTube transcript with URL: ${watchUrl} (isMobile: ${isMobile})`);
            
            // Note: We would prefer to use options with requestUrl, but it only accepts a string in this version
            // This means we can't set custom headers or other options that might help with mobile compatibility
            
            try {
                // Use the obsidianFetch shim to ensure compatibility with the rest of the codebase
                const response = await obsidianFetch(watchUrl);
                
                if (!response.ok) {
                    transcriptLogger.error(`Failed to fetch watch page: HTTP ${response.status}`);
                    throw new Error(`Failed to fetch watch page: HTTP ${response.status}`);
                }
                
                const body = await response.text();
                
                // Extract the ytInitialPlayerResponse from the HTML
                const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+(?:meta|head)|<\/script|\n)/;
                const match = body.match(playerResponseRegex);
                
                if (!match) {
                    transcriptLogger.error("Unable to locate ytInitialPlayerResponse in watch page HTML.");
                    throw new Error("Unable to locate ytInitialPlayerResponse in watch page HTML.");
                }
                
                const playerResponse = JSON.parse(match[1]);
                const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                
                if (!tracks.length) {
                    transcriptLogger.error("No caption tracks available for this video.");
                    throw new Error("No caption tracks available for this video.");
                }
                
                // Sort and select caption track similar to the main method
                tracks.sort((t1: CaptionTrack, t2: CaptionTrack) => {
                    if (options.lang) {
                        if (t1.languageCode === options.lang && t2.languageCode !== options.lang) return -1;
                        if (t1.languageCode !== options.lang && t2.languageCode === options.lang) return 1;
                    }
                    
                    if (t1.languageCode === "en" && t2.languageCode !== "en") return -1;
                    if (t1.languageCode !== "en" && t2.languageCode === "en") return 1;
                    
                    if (t1.kind !== "asr" && t2.kind === "asr") return -1;
                    if (t1.kind === "asr" && t2.kind !== "asr") return 1;
                    
                    return 0;
                });
                
                const chosenTrack = tracks[0];
                if (!chosenTrack?.baseUrl) {
                    throw new Error("Chosen track does not have a baseUrl.");
                }
                
                // Fetch the caption data in JSON format
                // On mobile, the fmt=json3 parameter might not work, so we need to be ready to handle XML format too
                let captionsJsonUrl = chosenTrack.baseUrl + "&fmt=json3";
                
                // Ensure we have an absolute URL for the captions
                captionsJsonUrl = this.makeAbsoluteUrl(captionsJsonUrl, isMobile);
                
                let captionsResponse;
                let responseText;
                
                try {
                    captionsResponse = await obsidianFetch(captionsJsonUrl);
                    
                    if (!captionsResponse.ok) {
                        // JSON format failed, try without format specifier (default XML format)
                        transcriptLogger.debug("JSON format failed, trying default format");
                        
                        // Get the base URL with absolute URL handling
                        const baseUrl = this.makeAbsoluteUrl(chosenTrack.baseUrl, isMobile);
                        
                        captionsResponse = await obsidianFetch(baseUrl);
                        
                        if (!captionsResponse.ok) {
                            throw new Error(`Failed to fetch track: HTTP ${captionsResponse.status}`);
                        }
                        
                        responseText = await captionsResponse.text();
                        
                        // If we got here with XML format, we need to parse it differently
                        if (responseText.trim().startsWith('<')) {
                            transcriptLogger.debug("Detected XML response, parsing XML format");
                            return this.parseXmlCaptions(responseText, videoId);
                        }
                    } else {
                        responseText = await captionsResponse.text();
                    }
                } catch (captionError) {
                    if (isMobile) {
                        transcriptLogger.debug("Error fetching captions, trying alternative method");
                        return await this.fetchTranscriptAlternative(videoId, options);
                    }
                    throw captionError;
                }
                
                const transcriptJson = JSON.parse(responseText);
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
                    throw new Error('No transcript segments found.');
                }
                
                return segments;
                
            } catch (fetchError) {
                transcriptLogger.error('Error fetching YouTube page:', fetchError);
                
                // Try an alternative fetch approach if the standard one fails on mobile
                if (isMobile) {
                    transcriptLogger.debug("Trying alternative mobile approach...");
                    // Try an alternative mobile-friendly URL format as backup
                    return await this.fetchTranscriptAlternative(videoId, options);
                }
                
                throw fetchError;
            }
            
        } catch (error) {
            transcriptLogger.error('Error fetching transcript from YouTube:', error);
            
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
     * Get video metadata from the player response
     * @param videoId YouTube video ID
     * @returns Promise with metadata
     */
    static async getVideoMetadata(videoId: string): Promise<TranscriptMetadata> {
        try {
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const response = await obsidianFetch(watchUrl);
            
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
            
            // youtube.com/watch?v=VIDEO_ID
            if (hostname.includes('youtube.com') && pathname === '/watch') {
                return urlObj.searchParams.get('v');
            }
            
            // youtu.be/VIDEO_ID
            if (hostname === 'youtu.be') {
                // The pathname includes the leading slash, so we remove it
                return pathname.substring(1);
            }
            
            // youtube.com/embed/VIDEO_ID
            if (hostname.includes('youtube.com') && pathname.startsWith('/embed/')) {
                return pathname.split('/')[2];
            }
            
            // youtube.com/v/VIDEO_ID
            if (hostname.includes('youtube.com') && pathname.startsWith('/v/')) {
                return pathname.split('/')[2];
            }
            
            // youtube.com/shorts/VIDEO_ID
            if (hostname.includes('youtube.com') && pathname.startsWith('/shorts/')) {
                return pathname.split('/')[2];
            }
            
            // youtube.com/live/VIDEO_ID - Add support for live URLs
            if (hostname.includes('youtube.com') && pathname.startsWith('/live/')) {
                return pathname.split('/')[2].split('?')[0]; // Handle potential query params
            }
            
            // music.youtube.com/watch?v=VIDEO_ID
            if (hostname.includes('music.youtube.com') && pathname === '/watch') {
                return urlObj.searchParams.get('v');
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
                    return match[1];
                }
            }
        }
        
        return null;
    }

    /**
     * Alternative method to fetch transcripts on mobile platforms
     * Uses a different approach that may be more compatible with mobile restrictions
     * @param videoId YouTube video ID
     * @param options Optional language and country settings
     * @returns Promise with transcript segments
     */
    static async fetchTranscriptAlternative(videoId: string, options: TranscriptOptions = {}): Promise<TranscriptSegment[]> {
        try {
            // Try to use the mobile version of YouTube which might be better supported on mobile
            // Add language and country parameters to the URL
            const mobileWatchUrl = `https://m.youtube.com/watch?v=${videoId}&hl=${options.lang || 'en'}&gl=${options.country || 'US'}`;
            
            transcriptLogger.debug(`Using alternative mobile approach with URL: ${mobileWatchUrl}`);
            
            // Use the obsidianFetch shim for consistent HTTP handling
            const response = await obsidianFetch(mobileWatchUrl);
            
            if (!response.ok) {
                transcriptLogger.error(`Mobile approach failed with HTTP ${response.status}`);
                throw new Error(`Mobile approach failed: HTTP ${response.status}`);
            }
            
            const body = await response.text();
            
            // YouTube mobile might have a slightly different player response format
            const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;/;
            const match = body.match(playerResponseRegex);
            
            if (!match) {
                transcriptLogger.error("Unable to locate player response in mobile HTML");
                
                // As a last resort, try to extract any visible text from the video page
                // This might not be as structured but better than nothing
                transcriptLogger.debug("Attempting to extract visible text as fallback");
                return this.createFallbackTranscript(body, videoId);
            }
            
            const playerResponse = JSON.parse(match[1]);
            const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            
            if (!tracks.length) {
                transcriptLogger.error("No caption tracks in mobile response");
                // Try fallback text extraction
                return this.createFallbackTranscript(body, videoId);
            }
            
            // Sort and select caption track similar to the main method
            tracks.sort((t1: CaptionTrack, t2: CaptionTrack) => {
                if (options.lang) {
                    if (t1.languageCode === options.lang && t2.languageCode !== options.lang) return -1;
                    if (t1.languageCode !== options.lang && t2.languageCode === options.lang) return 1;
                }
                
                if (t1.languageCode === "en" && t2.languageCode !== "en") return -1;
                if (t1.languageCode !== "en" && t2.languageCode === "en") return 1;
                
                if (t1.kind !== "asr" && t2.kind === "asr") return -1;
                if (t1.kind === "asr" && t2.kind !== "asr") return 1;
                
                return 0;
            });
            
            const chosenTrack = tracks[0];
            if (!chosenTrack?.baseUrl) {
                transcriptLogger.error("No baseUrl for chosen track in mobile response");
                return this.createFallbackTranscript(body, videoId); 
            }
            
            // Try a different caption format that might be more compatible with mobile
            let captionsXmlUrl = chosenTrack.baseUrl;
            transcriptLogger.debug(`Fetching captions from: ${captionsXmlUrl}`);
            
            // Ensure we have an absolute URL for the captions
            captionsXmlUrl = this.makeAbsoluteUrl(captionsXmlUrl, true);
            
            const captionsResponse = await obsidianFetch(captionsXmlUrl);
            
            if (!captionsResponse.ok) {
                transcriptLogger.error(`Failed to fetch captions XML: HTTP ${captionsResponse.status}`);
                return this.createFallbackTranscript(body, videoId);
            }
            
            // Parse the XML response (YouTube captions are in XML format by default)
            const xmlText = await captionsResponse.text();
            
            // Simple regex-based parsing of the transcript XML
            // Format is typically: <text start="startTime" dur="duration">Caption text</text>
            const segments: TranscriptSegment[] = [];
            const textRegex = /<text\s+start="([^"]+)"\s+dur="([^"]+)"(?:[^>]*)>([\s\S]*?)<\/text>/g;
            
            let match2;
            while ((match2 = textRegex.exec(xmlText)) !== null) {
                const startTime = parseFloat(match2[1]);
                const duration = parseFloat(match2[2]);
                // Decode HTML entities in the text
                let text = match2[3].replace(/&amp;/g, '&')
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
                return this.createFallbackTranscript(body, videoId);
            }
            
            return segments;
            
        } catch (error) {
            transcriptLogger.error('Error in alternative transcript fetch:', error);
            
            // If everything else fails, create a simple fallback transcript
            return [
                {
                    text: `Transcript extraction failed on mobile. Please try again on desktop or use a different video. Error: ${error.message}`,
                    start: 0,
                    duration: 0
                }
            ];
        }
    }
    
    /**
     * Creates a fallback transcript by extracting any visible text from the video page
     * Used as last resort when normal extraction methods fail
     * @param html HTML content of the video page
     * @param videoId Video ID for reference
     * @returns A basic transcript segments array
     */
    static createFallbackTranscript(html: string, videoId: string): Promise<TranscriptSegment[]> {
        transcriptLogger.debug(`Creating fallback transcript for video ${videoId}`);
        
        try {
            // Try to extract text that might be captions shown on the page
            // This is a very basic approach as a last resort
            const segments: TranscriptSegment[] = [];
            
            // Create a notification segment
            segments.push({
                text: "MOBILE COMPATIBILITY NOTICE: Using simplified transcript format due to mobile platform limitations.",
                start: 0,
                duration: 0
            });
            
            // Try to extract video title for context
            const titleMatch = html.match(/<title>(.*?)<\/title>/);
            const title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : `Video ${videoId}`;
            
            segments.push({
                text: `Title: ${title}`,
                start: 1,
                duration: 0
            });
            
            // Extract text from various sections of the page
            // This is imperfect but gives the user something rather than nothing
            const descriptionMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
            if (descriptionMatch) {
                segments.push({
                    text: `Description: ${descriptionMatch[1].trim()}`,
                    start: 2,
                    duration: 0
                });
            }
            
            // Add information about the error
            segments.push({
                text: "Note: Full transcript with timestamps couldn't be extracted on this mobile device. For best results, try using a desktop browser or a different video.",
                start: 3,
                duration: 0
            });
            
            return Promise.resolve(segments);
            
        } catch (e) {
            transcriptLogger.error("Error creating fallback transcript:", e);
            
            // If all else fails, return a simple error message
            return Promise.resolve([
                {
                    text: `Transcript extraction failed on mobile for video ${videoId}. Please try on desktop or with a different video.`,
                    start: 0,
                    duration: 0
                }
            ]);
        }
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

}
