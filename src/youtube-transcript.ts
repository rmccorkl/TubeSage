/**
 * YouTube Transcript Extractor
 * Uses a direct approach to extract transcripts from YouTube videos
 */

// Import for HTTP requests in Obsidian
import { requestUrl } from 'obsidian';

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

export class YouTubeTranscriptExtractor {
    /**
     * Extracts a transcript from a YouTube video
     * @param videoId YouTube video ID
     * @param options Optional language and country settings
     * @returns Promise with transcript segments
     */
    static async fetchTranscript(videoId: string, options: TranscriptOptions = {}): Promise<TranscriptSegment[]> {
        try {
            // Fetch captions using the player response approach
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            
            // Use Obsidian's requestUrl API instead of fetch to avoid some CORS issues
            const response = await requestUrl(watchUrl);
            
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Failed to fetch watch page: HTTP ${response.status}`);
            }
            
            const body = response.text;
            
            // Extract the ytInitialPlayerResponse from the HTML
            const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+(?:meta|head)|<\/script|\n)/;
            const match = body.match(playerResponseRegex);
            
            if (!match) {
                throw new Error("Unable to locate ytInitialPlayerResponse in watch page HTML.");
            }
            
            const playerResponse = JSON.parse(match[1]);
            const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            
            if (!tracks.length) {
                throw new Error("No caption tracks available for this video.");
            }
            
            // Sort tracks to prefer English and manual captions over auto-generated ones
            tracks.sort((t1: any, t2: any) => {
                // Prefer the language requested in options first
                if (options.lang) {
                    if (t1.languageCode === options.lang && t2.languageCode !== options.lang) return -1;
                    if (t1.languageCode !== options.lang && t2.languageCode === options.lang) return 1;
                }
                
                // Then prefer English if no specific language requested
                if (t1.languageCode === "en" && t2.languageCode !== "en") return -1;
                if (t1.languageCode !== "en" && t2.languageCode === "en") return 1;
                
                // Prefer manual captions over auto-generated ones ('asr' means auto-generated)
                if (t1.kind !== "asr" && t2.kind === "asr") return -1;
                if (t1.kind === "asr" && t2.kind !== "asr") return 1;
                
                return 0;
            });
            
            const chosenTrack = tracks[0];
            if (!chosenTrack?.baseUrl) {
                throw new Error("Chosen track does not have a baseUrl.");
            }
            
            // Fetch the caption data in JSON format
            const captionsJsonUrl = chosenTrack.baseUrl + "&fmt=json3";
            const captionsResponse = await requestUrl(captionsJsonUrl);
            
            if (captionsResponse.status < 200 || captionsResponse.status >= 300) {
                throw new Error(`Failed to fetch track: HTTP ${captionsResponse.status}`);
            }
            
            const transcriptJson = JSON.parse(captionsResponse.text);
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
            
        } catch (error) {
            console.error('Error fetching transcript from YouTube:', error);
            
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
            const response = await requestUrl(watchUrl);
            
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Failed to fetch watch page: HTTP ${response.status}`);
            }
            
            const body = response.text;
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
            console.error('Error fetching video metadata:', error);
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
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
            /youtube\.com\/embed\/([^?&\n/]+)/,
            /youtube\.com\/v\/([^?&\n/]+)/,
            /youtube\.com\/shorts\/([^?&\n/]+)/,
            /music\.youtube\.com\/watch\?v=([^&\n?#]+)/
        ];
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }
        
        return null;
    }

}
