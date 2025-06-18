/**
 * YouTube Transcript Extractor
 * Uses a direct approach to extract transcripts from YouTube videos
 */
import { __awaiter } from "tslib";
// Import HTTP fetch shim - IMPORTANT: Always use obsidianFetch instead of direct requestUrl
// to ensure consistent behavior across desktop and mobile platforms
import { obsidianFetch } from "src/utils/fetch-shim";
import { getLogger } from "src/utils/logger";
const transcriptLogger = getLogger("TRANSCRIPT");
export class YouTubeTranscriptExtractor {
    /**
     * Helper function to convert relative YouTube URLs to absolute URLs
     * YouTube API sometimes returns relative URLs that need to be converted
     * to absolute URLs before using with obsidianFetch
     *
     * @param url The potentially relative URL
     * @returns An absolute URL
     */
    static makeAbsoluteUrl(url) {
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
    static fetchTranscript(videoId_1) {
        return __awaiter(this, arguments, void 0, function* (videoId, options = {}) {
            let metadata = {};
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
                    const nextResponse = yield obsidianFetch(nextApiUrl, {
                        method: 'POST',
                        headers: Object.assign({ 'User-Agent': YouTubeTranscriptExtractor.USER_AGENT, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'Content-Type': 'application/json', 'Referer': watchUrl, 'Origin': 'https://www.youtube.com', 'DNT': '1' }, (YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })),
                        body: JSON.stringify(nextRequestBody)
                    });
                    if (!nextResponse.ok) {
                        throw new Error(`Failed to fetch next API data: HTTP ${nextResponse.status}`);
                    }
                    const nextData = yield nextResponse.json();
                    transcriptLogger.debug(`Step 1 completed: received ${JSON.stringify(nextData).length} characters of next API data`);
                    // Extract metadata from nextData response to eliminate redundant first fetch
                    const extractMetadataFromNextData = (nextData) => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w;
                        const metadata = {};
                        try {
                            // Method 1: From playerOverlays (most reliable)
                            const playerOverlayDetails = (_c = (_b = (_a = nextData === null || nextData === void 0 ? void 0 : nextData.playerOverlays) === null || _a === void 0 ? void 0 : _a.playerOverlayRenderer) === null || _b === void 0 ? void 0 : _b.videoDetails) === null || _c === void 0 ? void 0 : _c.playerOverlayVideoDetailsRenderer;
                            if (playerOverlayDetails) {
                                metadata.title = (_d = playerOverlayDetails.title) === null || _d === void 0 ? void 0 : _d.simpleText;
                                metadata.author = (_g = (_f = (_e = playerOverlayDetails.subtitle) === null || _e === void 0 ? void 0 : _e.runs) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.text;
                                transcriptLogger.debug(`Extracted metadata from playerOverlays: title="${metadata.title}", author="${metadata.author}"`);
                            }
                            // Method 2: From contents (fallback)
                            if (!metadata.title || !metadata.author) {
                                const contents = (_l = (_k = (_j = (_h = nextData === null || nextData === void 0 ? void 0 : nextData.contents) === null || _h === void 0 ? void 0 : _h.twoColumnWatchNextResults) === null || _j === void 0 ? void 0 : _j.results) === null || _k === void 0 ? void 0 : _k.results) === null || _l === void 0 ? void 0 : _l.contents;
                                if (Array.isArray(contents)) {
                                    // Look for title in videoPrimaryInfoRenderer
                                    const primaryInfo = contents.find((c) => c.videoPrimaryInfoRenderer);
                                    if (primaryInfo && !metadata.title) {
                                        metadata.title = (_p = (_o = (_m = primaryInfo.videoPrimaryInfoRenderer.title) === null || _m === void 0 ? void 0 : _m.runs) === null || _o === void 0 ? void 0 : _o[0]) === null || _p === void 0 ? void 0 : _p.text;
                                        transcriptLogger.debug(`Extracted title from videoPrimaryInfoRenderer: "${metadata.title}"`);
                                    }
                                    // Look for author in videoSecondaryInfoRenderer
                                    const secondaryInfo = contents.find((c) => c.videoSecondaryInfoRenderer);
                                    if (secondaryInfo && !metadata.author) {
                                        metadata.author = (_u = (_t = (_s = (_r = (_q = secondaryInfo.videoSecondaryInfoRenderer.owner) === null || _q === void 0 ? void 0 : _q.videoOwnerRenderer) === null || _r === void 0 ? void 0 : _r.title) === null || _s === void 0 ? void 0 : _s.runs) === null || _t === void 0 ? void 0 : _t[0]) === null || _u === void 0 ? void 0 : _u.text;
                                        transcriptLogger.debug(`Extracted author from videoSecondaryInfoRenderer: "${metadata.author}"`);
                                    }
                                }
                            }
                            // Method 3: Search for videoDetails in microformat (additional fallback)
                            if (!metadata.title || !metadata.author) {
                                const microformat = (_v = nextData === null || nextData === void 0 ? void 0 : nextData.microformat) === null || _v === void 0 ? void 0 : _v.playerMicroformatRenderer;
                                if (microformat) {
                                    if (!metadata.title && ((_w = microformat.title) === null || _w === void 0 ? void 0 : _w.simpleText)) {
                                        metadata.title = microformat.title.simpleText;
                                        transcriptLogger.debug(`Extracted title from microformat: "${metadata.title}"`);
                                    }
                                    if (!metadata.author && microformat.ownerChannelName) {
                                        metadata.author = microformat.ownerChannelName;
                                        transcriptLogger.debug(`Extracted author from microformat: "${metadata.author}"`);
                                    }
                                }
                            }
                        }
                        catch (error) {
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
                        const findTranscriptEndpoint = (obj) => {
                            var _a;
                            if (obj && typeof obj === 'object') {
                                if ((_a = obj.getTranscriptEndpoint) === null || _a === void 0 ? void 0 : _a.params) {
                                    return obj.getTranscriptEndpoint.params;
                                }
                                for (const key in obj) {
                                    const result = findTranscriptEndpoint(obj[key]);
                                    if (result)
                                        return result;
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
                    }
                    catch (parseError) {
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
                    const transcriptResponse = yield obsidianFetch(getTranscriptUrl, {
                        method: 'POST',
                        headers: Object.assign({ 'User-Agent': YouTubeTranscriptExtractor.USER_AGENT, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'Content-Type': 'application/json', 'Referer': watchUrl, 'Origin': 'https://www.youtube.com', 'DNT': '1' }, (YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })),
                        body: JSON.stringify(transcriptRequestBody)
                    });
                    if (!transcriptResponse.ok) {
                        throw new Error(`Failed to fetch transcript: HTTP ${transcriptResponse.status}`);
                    }
                    const transcriptData = yield transcriptResponse.json();
                    transcriptLogger.debug(`Step 2 completed: received transcript data with ${JSON.stringify(transcriptData).length} characters`);
                    // Parse the transcript data
                    try {
                        // Look for transcript text in the response with enhanced search
                        const findTranscriptText = (obj, depth = 0, path = 'root') => {
                            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                            if (depth > 10)
                                return null; // Prevent infinite recursion
                            if (obj && typeof obj === 'object') {
                                // Check for the main transcript structure
                                if ((_b = (_a = obj.transcriptBody) === null || _a === void 0 ? void 0 : _a.transcriptBodyRenderer) === null || _b === void 0 ? void 0 : _b.cueGroups) {
                                    transcriptLogger.debug(`Found cueGroups at path: ${path}.transcriptBody.transcriptBodyRenderer.cueGroups`);
                                    return obj.transcriptBody.transcriptBodyRenderer.cueGroups;
                                }
                                // Check for alternative transcript structures
                                if (obj.cueGroups && Array.isArray(obj.cueGroups)) {
                                    transcriptLogger.debug(`Found cueGroups directly at path: ${path}.cueGroups`);
                                    return obj.cueGroups;
                                }
                                // Check for updateEngagementPanelAction structure
                                if ((_j = (_h = (_g = (_f = (_e = (_d = (_c = obj.updateEngagementPanelAction) === null || _c === void 0 ? void 0 : _c.content) === null || _d === void 0 ? void 0 : _d.transcriptRenderer) === null || _e === void 0 ? void 0 : _e.content) === null || _f === void 0 ? void 0 : _f.transcriptSearchPanelRenderer) === null || _g === void 0 ? void 0 : _g.body) === null || _h === void 0 ? void 0 : _h.transcriptSegmentListRenderer) === null || _j === void 0 ? void 0 : _j.initialSegments) {
                                    transcriptLogger.debug(`Found segments in updateEngagementPanelAction at path: ${path}`);
                                    return obj.updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments;
                                }
                                // Search through actions array
                                if (obj.actions && Array.isArray(obj.actions)) {
                                    for (let i = 0; i < obj.actions.length; i++) {
                                        const result = findTranscriptText(obj.actions[i], depth + 1, `${path}.actions[${i}]`);
                                        if (result)
                                            return result;
                                    }
                                }
                                // Search through all object properties
                                for (const key in obj) {
                                    if (typeof obj[key] === 'object') {
                                        const result = findTranscriptText(obj[key], depth + 1, `${path}.${key}`);
                                        if (result)
                                            return result;
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
                                transcriptData.actions.forEach((action, i) => {
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
                        const segments = cueGroups.map((cueGroup, index) => {
                            var _a, _b, _c, _d, _e, _f, _g;
                            // Traditional cueGroup format
                            const cue = (_c = (_b = (_a = cueGroup.transcriptCueGroupRenderer) === null || _a === void 0 ? void 0 : _a.cues) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.transcriptCueRenderer;
                            if (cue) {
                                const text = ((_d = cue.cue) === null || _d === void 0 ? void 0 : _d.simpleText) || '';
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
                                const text = ((_g = (_f = (_e = segmentRenderer.snippet) === null || _e === void 0 ? void 0 : _e.runs) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.text) || '';
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
                        }).filter((segment) => segment !== null && segment.text);
                        transcriptLogger.debug(`Parsed ${segments.length} transcript segments`);
                        if (segments.length === 0) {
                            throw new Error(`No valid transcript segments found in YouTube API response`);
                        }
                        transcriptLogger.debug(`ScrapeCreators method succeeded with ${segments.length} segments`);
                        return { segments, metadata };
                    }
                    catch (parseError) {
                        transcriptLogger.error(`Error parsing transcript response: ${parseError.message}`);
                        throw new Error(`Failed to parse transcript data from YouTube API response`);
                    }
                }
                catch (error) {
                    transcriptLogger.error('Error fetching transcript:', (error === null || error === void 0 ? void 0 : error.message) || error);
                    // If we successfully extracted metadata but caption fetching failed,
                    // we should still return the metadata with an error transcript
                    if (metadata && (metadata.title || metadata.author)) {
                        transcriptLogger.debug('Returning metadata despite caption failure');
                        return {
                            segments: [{
                                    text: `[TRANSCRIPT EXTRACTION FAILED: ${(error === null || error === void 0 ? void 0 : error.message) || error}]`,
                                    start: 0,
                                    duration: 0
                                }],
                            metadata
                        };
                    }
                    throw error;
                }
            }
            catch (error) {
                transcriptLogger.error('Error fetching transcript from YouTube:', (error === null || error === void 0 ? void 0 : error.message) || error);
                // Detect if this is a CORS error
                if (error.message && (error.message.includes('CORS') ||
                    error.message.includes('Cross-Origin') ||
                    error.message.includes('Access-Control-Allow-Origin'))) {
                    throw new Error('CORS policy blocked the request. Please try a different video or check your internet connection.');
                }
                // Check for network errors
                if (error.message && (error.message.includes('network') ||
                    error.message.includes('fetch') ||
                    error.message.includes('connect') ||
                    error.message.includes('timeout'))) {
                    throw new Error('Network error while fetching transcript. Please check your internet connection.');
                }
                throw error;
            }
        });
    }
    /**
     * Extracts only transcript segments from a YouTube video (backward compatibility)
     * @param videoId YouTube video ID
     * @param options Optional language and country settings
     * @returns Promise with transcript segments only
     */
    static fetchTranscriptSegments(videoId_1) {
        return __awaiter(this, arguments, void 0, function* (videoId, options = {}) {
            const result = yield this.fetchTranscript(videoId, options);
            return result.segments;
        });
    }
    /**
     * Get video metadata from the player response
     * @param videoId YouTube video ID
     * @returns Promise with metadata
     */
    static getVideoMetadata(videoId) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
                // Request with User-Agent to ensure we get the full page
                const response = yield obsidianFetch(watchUrl, {
                    headers: Object.assign({ 'User-Agent': YouTubeTranscriptExtractor.USER_AGENT }, (YouTubeTranscriptExtractor.cookieStore && { 'Cookie': YouTubeTranscriptExtractor.cookieStore })),
                });
                if (!response.ok) {
                    throw new Error(`Failed to fetch watch page: HTTP ${response.status}`);
                }
                const body = yield response.text();
                const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+(?:meta|head)|<\/script|\n)/;
                const match = body.match(playerResponseRegex);
                if (!match) {
                    throw new Error("Unable to locate ytInitialPlayerResponse in watch page HTML.");
                }
                const playerResponse = JSON.parse(match[1]);
                return {
                    title: (_a = playerResponse === null || playerResponse === void 0 ? void 0 : playerResponse.videoDetails) === null || _a === void 0 ? void 0 : _a.title,
                    author: (_b = playerResponse === null || playerResponse === void 0 ? void 0 : playerResponse.videoDetails) === null || _b === void 0 ? void 0 : _b.author
                };
            }
            catch (error) {
                transcriptLogger.error('Error fetching video metadata:', error);
                return {};
            }
        });
    }
    /**
     * Combines transcript segments into a single text
     * @param segments Array of transcript segments
     * @returns Combined transcript text
     */
    static combineTranscript(segments) {
        return segments.map(segment => segment.text).join(' ');
    }
    /**
     * Extracts video ID from a YouTube URL
     * @param url YouTube video URL
     * @returns Video ID or null if not found
     */
    static extractVideoId(url) {
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
                // The pathname includes the leading slash, so we remove it and strip query params
                return pathname.substring(1).split('?')[0];
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
        }
        catch (error) {
            transcriptLogger.error("Error parsing YouTube URL:", error);
            // Fallback to regex patterns for compatibility
            const patterns = [
                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
                /youtube\.com\/embed\/([^?&\n/]+)/,
                /youtube\.com\/v\/([^?&\n/]+)/,
                /youtube\.com\/shorts\/([^?&\n/]+)/,
                /youtube\.com\/live\/([^?&\n/]+)/, // Add pattern for live URLs
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
     * Parses YouTube captions in XML format
     * @param xmlText The XML content of captions
     * @param videoId Video ID for reference
     * @returns Parsed transcript segments
     */
    static parseXmlCaptions(xmlText, videoId) {
        transcriptLogger.debug(`Parsing XML captions for video ${videoId}`);
        try {
            // Simple regex-based parsing of the transcript XML
            // Format is typically: <text start="startTime" dur="duration">Caption text</text>
            const segments = [];
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
        }
        catch (e) {
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
    static parseJsonCaptions(jsonText, videoId) {
        transcriptLogger.debug(`Parsing JSON captions for video ${videoId}`);
        try {
            const transcriptJson = JSON.parse(jsonText);
            const events = transcriptJson.events || [];
            // Convert events to our TranscriptSegment format
            const segments = [];
            events
                .filter((e) => e.segs && Array.isArray(e.segs)) // Filter events with text segments
                .forEach((e) => {
                const startMs = e.tStartMs ? parseInt(e.tStartMs) : 0;
                const durationMs = e.dDurationMs ? parseInt(e.dDurationMs) : 0;
                // Combine all segments in this event
                const text = e.segs
                    .map((seg) => seg.utf8 || '')
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
        }
        catch (e) {
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
YouTubeTranscriptExtractor.USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
YouTubeTranscriptExtractor.cookieStore = '';
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoieW91dHViZS10cmFuc2NyaXB0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsieW91dHViZS10cmFuc2NyaXB0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7R0FHRzs7QUFFSCw0RkFBNEY7QUFDNUYsb0VBQW9FO0FBQ3BFLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNyRCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDN0MsTUFBTSxnQkFBZ0IsR0FBRyxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUM7QUFrQ2pELE1BQU0sT0FBTywwQkFBMEI7SUFLbkM7Ozs7Ozs7T0FPRztJQUNLLE1BQU0sQ0FBQyxlQUFlLENBQUMsR0FBVztRQUN0QyxJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUN0QixNQUFNLFdBQVcsR0FBRyx5QkFBeUIsR0FBRyxHQUFHLENBQUM7WUFDcEQsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLG1DQUFtQyxHQUFHLE1BQU0sV0FBVyxFQUFFLENBQUMsQ0FBQztZQUNsRixPQUFPLFdBQVcsQ0FBQztRQUN2QixDQUFDO1FBQ0QsT0FBTyxHQUFHLENBQUM7SUFDZixDQUFDO0lBRUQ7Ozs7O09BS0c7SUFDSCxNQUFNLENBQU8sZUFBZTs2REFBQyxPQUFlLEVBQUUsVUFBNkIsRUFBRTtZQUN6RSxJQUFJLFFBQVEsR0FBdUIsRUFBRSxDQUFDO1lBRXRDLElBQUksQ0FBQztnQkFDRCxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsMENBQTBDLE9BQU8sRUFBRSxDQUFDLENBQUM7Z0JBRTVFLE1BQU0sUUFBUSxHQUFHLG1DQUFtQyxPQUFPLEVBQUUsQ0FBQztnQkFFOUQsSUFBSSxDQUFDO29CQUNELDRGQUE0RjtvQkFFNUYsa0RBQWtEO29CQUNsRCxnRUFBZ0U7b0JBQ2hFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyw4RUFBOEUsQ0FBQyxDQUFDO29CQUV2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LElBQUksQ0FBQyxFQUFFLENBQUM7cUJBQ1IsT0FBTyxDQUFDLHdCQUF3QixFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsdUJBQXVCO2dCQUVuRSxJQUFJLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDO29CQUNkLFFBQVEsQ0FBQyxJQUFJLENBQUM7d0JBQ1YsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUU7d0JBQ2pCLEtBQUssRUFBRSxPQUFPLEdBQUcsSUFBSSxFQUFFLHFCQUFxQjt3QkFDNUMsUUFBUSxFQUFFLFVBQVUsR0FBRyxJQUFJLENBQUMscUJBQXFCO3FCQUNwRCxDQUFDLENBQUM7Z0JBQ1AsQ0FBQztZQUNMLENBQUMsQ0FBQyxDQUFDO1lBRVAsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUN4QixNQUFNLElBQUksS0FBSyxDQUFDLHdEQUF3RCxPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQ3ZGLENBQUM7WUFFRCxPQUFPLFFBQVEsQ0FBQztRQUVwQixDQUFDO1FBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNULGdCQUFnQixDQUFDLEtBQUssQ0FBQyw4QkFBOEIsRUFBRSxDQUFDLENBQUMsQ0FBQztZQUUxRCwrQkFBK0I7WUFDL0IsT0FBTztnQkFDSDtvQkFDSSxJQUFJLEVBQUUsbURBQW1ELE9BQU8sWUFBWSxDQUFDLENBQUMsT0FBTyxFQUFFO29CQUN2RixLQUFLLEVBQUUsQ0FBQztvQkFDUixRQUFRLEVBQUUsQ0FBQztpQkFDZDthQUNKLENBQUM7UUFDTixDQUFDO0lBQ0wsQ0FBQzs7QUE5bkJ1QixxQ0FBVSxHQUFHLGlIQUFpSCxDQUFDO0FBQ3hJLHNDQUFXLEdBQVcsRUFBRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBZb3VUdWJlIFRyYW5zY3JpcHQgRXh0cmFjdG9yXG4gKiBVc2VzIGEgZGlyZWN0IGFwcHJvYWNoIHRvIGV4dHJhY3QgdHJhbnNjcmlwdHMgZnJvbSBZb3VUdWJlIHZpZGVvc1xuICovXG5cbi8vIEltcG9ydCBIVFRQIGZldGNoIHNoaW0gLSBJTVBPUlRBTlQ6IEFsd2F5cyB1c2Ugb2JzaWRpYW5GZXRjaCBpbnN0ZWFkIG9mIGRpcmVjdCByZXF1ZXN0VXJsXG4vLyB0byBlbnN1cmUgY29uc2lzdGVudCBiZWhhdmlvciBhY3Jvc3MgZGVza3RvcCBhbmQgbW9iaWxlIHBsYXRmb3Jtc1xuaW1wb3J0IHsgb2JzaWRpYW5GZXRjaCB9IGZyb20gXCJzcmMvdXRpbHMvZmV0Y2gtc2hpbVwiO1xuaW1wb3J0IHsgZ2V0TG9nZ2VyIH0gZnJvbSBcInNyYy91dGlscy9sb2dnZXJcIjtcbmNvbnN0IHRyYW5zY3JpcHRMb2dnZXIgPSBnZXRMb2dnZXIoXCJUUkFOU0NSSVBUXCIpO1xuXG4vLyBBZGQgdGhlIENhcHRpb25UcmFjayB0eXBlIGF0IGZpbGUgbGV2ZWwsIG91dHNpZGUgb2YgYW55IG1ldGhvZFxuLyoqXG4gKiBJbnRlcmZhY2UgZm9yIFlvdVR1YmUgY2FwdGlvbiB0cmFja3NcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDYXB0aW9uVHJhY2sge1xuICAgIGxhbmd1YWdlQ29kZTogc3RyaW5nO1xuICAgIGtpbmQ/OiBzdHJpbmc7IFxuICAgIGJhc2VVcmw/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNjcmlwdFNlZ21lbnQge1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBzdGFydDogbnVtYmVyO1xuICAgIGR1cmF0aW9uOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNjcmlwdE9wdGlvbnMge1xuICAgIGxhbmc/OiBzdHJpbmc7XG4gICAgY291bnRyeT86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmFuc2NyaXB0TWV0YWRhdGEge1xuICAgIHRpdGxlPzogc3RyaW5nO1xuICAgIGF1dGhvcj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmFuc2NyaXB0UmVzdWx0IHtcbiAgICBzZWdtZW50czogVHJhbnNjcmlwdFNlZ21lbnRbXTtcbiAgICBtZXRhZGF0YTogVHJhbnNjcmlwdE1ldGFkYXRhO1xufVxuXG5cbmV4cG9ydCBjbGFzcyBZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3RvciB7XG4gICAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgVVNFUl9BR0VOVCA9ICdNb3ppbGxhLzUuMCAoV2luZG93cyBOVCAxMC4wOyBXaW42NDsgeDY0KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUvMTIwLjAuMC4wIFNhZmFyaS81MzcuMzYnO1xuICAgIHByaXZhdGUgc3RhdGljIGNvb2tpZVN0b3JlOiBzdHJpbmcgPSAnJztcbiAgICBcbiAgICBcbiAgICAvKipcbiAgICAgKiBIZWxwZXIgZnVuY3Rpb24gdG8gY29udmVydCByZWxhdGl2ZSBZb3VUdWJlIFVSTHMgdG8gYWJzb2x1dGUgVVJMc1xuICAgICAqIFlvdVR1YmUgQVBJIHNvbWV0aW1lcyByZXR1cm5zIHJlbGF0aXZlIFVSTHMgdGhhdCBuZWVkIHRvIGJlIGNvbnZlcnRlZFxuICAgICAqIHRvIGFic29sdXRlIFVSTHMgYmVmb3JlIHVzaW5nIHdpdGggb2JzaWRpYW5GZXRjaFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB1cmwgVGhlIHBvdGVudGlhbGx5IHJlbGF0aXZlIFVSTFxuICAgICAqIEByZXR1cm5zIEFuIGFic29sdXRlIFVSTFxuICAgICAqL1xuICAgIHByaXZhdGUgc3RhdGljIG1ha2VBYnNvbHV0ZVVybCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgICAgIGlmICh1cmwuc3RhcnRzV2l0aCgnLycpKSB7XG4gICAgICAgICAgICBjb25zdCBhYnNvbHV0ZVVybCA9ICdodHRwczovL3d3dy55b3V0dWJlLmNvbScgKyB1cmw7XG4gICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmRlYnVnKGBGaXhlZCByZWxhdGl2ZSBVUkwgdG8gYWJzb2x1dGU6ICR7dXJsfSDihpIgJHthYnNvbHV0ZVVybH1gKTtcbiAgICAgICAgICAgIHJldHVybiBhYnNvbHV0ZVVybDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdXJsO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBFeHRyYWN0cyBhIHRyYW5zY3JpcHQgZnJvbSBhIFlvdVR1YmUgdmlkZW9cbiAgICAgKiBAcGFyYW0gdmlkZW9JZCBZb3VUdWJlIHZpZGVvIElEXG4gICAgICogQHBhcmFtIG9wdGlvbnMgT3B0aW9uYWwgbGFuZ3VhZ2UgYW5kIGNvdW50cnkgc2V0dGluZ3NcbiAgICAgKiBAcmV0dXJucyBQcm9taXNlIHdpdGggdHJhbnNjcmlwdCBzZWdtZW50cyBhbmQgbWV0YWRhdGFcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmV0Y2hUcmFuc2NyaXB0KHZpZGVvSWQ6IHN0cmluZywgb3B0aW9uczogVHJhbnNjcmlwdE9wdGlvbnMgPSB7fSk6IFByb21pc2U8VHJhbnNjcmlwdFJlc3VsdD4ge1xuICAgICAgICBsZXQgbWV0YWRhdGE6IFRyYW5zY3JpcHRNZXRhZGF0YSA9IHt9O1xuICAgICAgICBcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEZldGNoaW5nIFlvdVR1YmUgdHJhbnNjcmlwdCBmb3IgdmlkZW86ICR7dmlkZW9JZH1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3Qgd2F0Y2hVcmwgPSBgaHR0cHM6Ly93d3cueW91dHViZS5jb20vd2F0Y2g/dj0ke3ZpZGVvSWR9YDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAvLyBVc2luZyBkaXJlY3QgU2NyYXBlQ3JlYXRvcnMgbWV0aG9kIC0gb3B0aW1pemVkIHRvIGV4dHJhY3QgbWV0YWRhdGEgZnJvbSB0aGUgc2FtZSBBUEkgY2FsbFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIERpcmVjdCBtZXRob2Q6IFNjcmFwZUNyZWF0b3JzIHR3by1zdGVwIGFwcHJvYWNoXG4gICAgICAgICAgICAgICAgLy8gU3RlcCAxOiBHZXQgdHJhbnNjcmlwdCBwYXJhbWV0ZXJzIGZyb20gWW91VHViZSdzIGludGVybmFsIEFQSVxuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFVzaW5nIFNjcmFwZUNyZWF0b3JzIG1ldGhvZDogZmV0Y2hpbmcgdHJhbnNjcmlwdCBwYXJhbWV0ZXJzIHZpYSBZb3VUdWJlaSBBUElgKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb25zdCBuZXh0QXBpVXJsID0gYGh0dHBzOi8vd3d3LnlvdXR1YmUuY29tL3lvdXR1YmVpL3YxL25leHQ/cHJldHR5UHJpbnQ9ZmFsc2VgO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIFN0ZXAgMTogUmVxdWVzdCB0byBnZXQgdHJhbnNjcmlwdCBwYXJhbWV0ZXJzXG4gICAgICAgICAgICAgICAgY29uc3QgbmV4dFJlcXVlc3RCb2R5ID0ge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbGllbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGllbnROYW1lOiBcIldFQlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsaWVudFZlcnNpb246IFwiMi4yMDI0MTIwNS4wMS4wMFwiXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIHZpZGVvSWQ6IHZpZGVvSWRcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFN0ZXAgMTogUmVxdWVzdGluZyB0cmFuc2NyaXB0IHBhcmFtZXRlcnMgZnJvbSAke25leHRBcGlVcmx9YCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29uc3QgbmV4dFJlc3BvbnNlID0gYXdhaXQgb2JzaWRpYW5GZXRjaChuZXh0QXBpVXJsLCB7XG4gICAgICAgICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnVXNlci1BZ2VudCc6IFlvdVR1YmVUcmFuc2NyaXB0RXh0cmFjdG9yLlVTRVJfQUdFTlQsXG4gICAgICAgICAgICAgICAgICAgICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ0FjY2VwdC1MYW5ndWFnZSc6ICdlbi1VUyxlbjtxPTAuOScsXG4gICAgICAgICAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1JlZmVyZXInOiB3YXRjaFVybCxcbiAgICAgICAgICAgICAgICAgICAgICAgICdPcmlnaW4nOiAnaHR0cHM6Ly93d3cueW91dHViZS5jb20nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ0ROVCc6ICcxJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLihZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3Rvci5jb29raWVTdG9yZSAmJiB7ICdDb29raWUnOiBZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3Rvci5jb29raWVTdG9yZSB9KVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShuZXh0UmVxdWVzdEJvZHkpXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKCFuZXh0UmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZmV0Y2ggbmV4dCBBUEkgZGF0YTogSFRUUCAke25leHRSZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnN0IG5leHREYXRhID0gYXdhaXQgbmV4dFJlc3BvbnNlLmpzb24oKTtcbiAgICAgICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmRlYnVnKGBTdGVwIDEgY29tcGxldGVkOiByZWNlaXZlZCAke0pTT04uc3RyaW5naWZ5KG5leHREYXRhKS5sZW5ndGh9IGNoYXJhY3RlcnMgb2YgbmV4dCBBUEkgZGF0YWApO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIEV4dHJhY3QgbWV0YWRhdGEgZnJvbSBuZXh0RGF0YSByZXNwb25zZSB0byBlbGltaW5hdGUgcmVkdW5kYW50IGZpcnN0IGZldGNoXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0cmFjdE1ldGFkYXRhRnJvbU5leHREYXRhID0gKG5leHREYXRhOiBhbnkpOiBUcmFuc2NyaXB0TWV0YWRhdGEgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtZXRhZGF0YTogVHJhbnNjcmlwdE1ldGFkYXRhID0ge307XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gTWV0aG9kIDE6IEZyb20gcGxheWVyT3ZlcmxheXMgKG1vc3QgcmVsaWFibGUpXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBwbGF5ZXJPdmVybGF5RGV0YWlscyA9IG5leHREYXRhPy5wbGF5ZXJPdmVybGF5cz8ucGxheWVyT3ZlcmxheVJlbmRlcmVyPy52aWRlb0RldGFpbHM/LnBsYXllck92ZXJsYXlWaWRlb0RldGFpbHNSZW5kZXJlcjtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwbGF5ZXJPdmVybGF5RGV0YWlscykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGFkYXRhLnRpdGxlID0gcGxheWVyT3ZlcmxheURldGFpbHMudGl0bGU/LnNpbXBsZVRleHQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWV0YWRhdGEuYXV0aG9yID0gcGxheWVyT3ZlcmxheURldGFpbHMuc3VidGl0bGU/LnJ1bnM/LlswXT8udGV4dDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmRlYnVnKGBFeHRyYWN0ZWQgbWV0YWRhdGEgZnJvbSBwbGF5ZXJPdmVybGF5czogdGl0bGU9XCIke21ldGFkYXRhLnRpdGxlfVwiLCBhdXRob3I9XCIke21ldGFkYXRhLmF1dGhvcn1cImApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBNZXRob2QgMjogRnJvbSBjb250ZW50cyAoZmFsbGJhY2spXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIW1ldGFkYXRhLnRpdGxlIHx8ICFtZXRhZGF0YS5hdXRob3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50cyA9IG5leHREYXRhPy5jb250ZW50cz8udHdvQ29sdW1uV2F0Y2hOZXh0UmVzdWx0cz8ucmVzdWx0cz8ucmVzdWx0cz8uY29udGVudHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29udGVudHMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIExvb2sgZm9yIHRpdGxlIGluIHZpZGVvUHJpbWFyeUluZm9SZW5kZXJlclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmltYXJ5SW5mbyA9IGNvbnRlbnRzLmZpbmQoKGM6IGFueSkgPT4gYy52aWRlb1ByaW1hcnlJbmZvUmVuZGVyZXIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocHJpbWFyeUluZm8gJiYgIW1ldGFkYXRhLnRpdGxlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRhZGF0YS50aXRsZSA9IHByaW1hcnlJbmZvLnZpZGVvUHJpbWFyeUluZm9SZW5kZXJlci50aXRsZT8ucnVucz8uWzBdPy50ZXh0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgRXh0cmFjdGVkIHRpdGxlIGZyb20gdmlkZW9QcmltYXJ5SW5mb1JlbmRlcmVyOiBcIiR7bWV0YWRhdGEudGl0bGV9XCJgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gTG9vayBmb3IgYXV0aG9yIGluIHZpZGVvU2Vjb25kYXJ5SW5mb1JlbmRlcmVyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNlY29uZGFyeUluZm8gPSBjb250ZW50cy5maW5kKChjOiBhbnkpID0+IGMudmlkZW9TZWNvbmRhcnlJbmZvUmVuZGVyZXIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoc2Vjb25kYXJ5SW5mbyAmJiAhbWV0YWRhdGEuYXV0aG9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRhZGF0YS5hdXRob3IgPSBzZWNvbmRhcnlJbmZvLnZpZGVvU2Vjb25kYXJ5SW5mb1JlbmRlcmVyLm93bmVyPy52aWRlb093bmVyUmVuZGVyZXI/LnRpdGxlPy5ydW5zPy5bMF0/LnRleHQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmRlYnVnKGBFeHRyYWN0ZWQgYXV0aG9yIGZyb20gdmlkZW9TZWNvbmRhcnlJbmZvUmVuZGVyZXI6IFwiJHttZXRhZGF0YS5hdXRob3J9XCJgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gTWV0aG9kIDM6IFNlYXJjaCBmb3IgdmlkZW9EZXRhaWxzIGluIG1pY3JvZm9ybWF0IChhZGRpdGlvbmFsIGZhbGxiYWNrKVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFtZXRhZGF0YS50aXRsZSB8fCAhbWV0YWRhdGEuYXV0aG9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWljcm9mb3JtYXQgPSBuZXh0RGF0YT8ubWljcm9mb3JtYXQ/LnBsYXllck1pY3JvZm9ybWF0UmVuZGVyZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG1pY3JvZm9ybWF0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghbWV0YWRhdGEudGl0bGUgJiYgbWljcm9mb3JtYXQudGl0bGU/LnNpbXBsZVRleHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGFkYXRhLnRpdGxlID0gbWljcm9mb3JtYXQudGl0bGUuc2ltcGxlVGV4dDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEV4dHJhY3RlZCB0aXRsZSBmcm9tIG1pY3JvZm9ybWF0OiBcIiR7bWV0YWRhdGEudGl0bGV9XCJgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIW1ldGFkYXRhLmF1dGhvciAmJiBtaWNyb2Zvcm1hdC5vd25lckNoYW5uZWxOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRhZGF0YS5hdXRob3IgPSBtaWNyb2Zvcm1hdC5vd25lckNoYW5uZWxOYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgRXh0cmFjdGVkIGF1dGhvciBmcm9tIG1pY3JvZm9ybWF0OiBcIiR7bWV0YWRhdGEuYXV0aG9yfVwiYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEVycm9yIGV4dHJhY3RpbmcgbWV0YWRhdGEgZnJvbSBuZXh0RGF0YTogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbWV0YWRhdGE7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBFeHRyYWN0IG1ldGFkYXRhIGZyb20gdGhlIG5leHREYXRhIHJlc3BvbnNlXG4gICAgICAgICAgICAgICAgbWV0YWRhdGEgPSBleHRyYWN0TWV0YWRhdGFGcm9tTmV4dERhdGEobmV4dERhdGEpO1xuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEZpbmFsIGV4dHJhY3RlZCBtZXRhZGF0YTogdGl0bGU9XCIke21ldGFkYXRhLnRpdGxlIHx8ICdOb3QgZm91bmQnfVwiLCBhdXRob3I9XCIke21ldGFkYXRhLmF1dGhvciB8fCAnTm90IGZvdW5kJ31cImApO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIExvZyBpZiB3ZSBzdWNjZXNzZnVsbHkgZXh0cmFjdGVkIG1ldGFkYXRhXG4gICAgICAgICAgICAgICAgaWYgKG1ldGFkYXRhLnRpdGxlKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFZpZGVvIHRpdGxlOiAke21ldGFkYXRhLnRpdGxlfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAobWV0YWRhdGEuYXV0aG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFZpZGVvIGF1dGhvcjogJHttZXRhZGF0YS5hdXRob3J9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIEV4dHJhY3QgdHJhbnNjcmlwdCBlbmRwb2ludCBwYXJhbWV0ZXJzXG4gICAgICAgICAgICAgICAgbGV0IHRyYW5zY3JpcHRQYXJhbXMgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIExvb2sgZm9yIGdldFRyYW5zY3JpcHRFbmRwb2ludCBpbiB0aGUgcmVzcG9uc2VcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZmluZFRyYW5zY3JpcHRFbmRwb2ludCA9IChvYmo6IGFueSk6IGFueSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAob2JqICYmIHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9iai5nZXRUcmFuc2NyaXB0RW5kcG9pbnQ/LnBhcmFtcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2JqLmdldFRyYW5zY3JpcHRFbmRwb2ludC5wYXJhbXM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IGluIG9iaikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBmaW5kVHJhbnNjcmlwdEVuZHBvaW50KG9ialtrZXldKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRQYXJhbXMgPSBmaW5kVHJhbnNjcmlwdEVuZHBvaW50KG5leHREYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmICghdHJhbnNjcmlwdFBhcmFtcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5lcnJvcihgTm8gZ2V0VHJhbnNjcmlwdEVuZHBvaW50LnBhcmFtcyBmb3VuZCBpbiBuZXh0IEFQSSByZXNwb25zZWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgTmV4dCBBUEkgcmVzcG9uc2Uga2V5czogJHtPYmplY3Qua2V5cyhuZXh0RGF0YSkuam9pbignLCAnKX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTm8gdHJhbnNjcmlwdCBwYXJhbWV0ZXJzIGZvdW5kIGluIFlvdVR1YmUgQVBJIHJlc3BvbnNlIGZvciB2aWRlbyAke3ZpZGVvSWR9YCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEZvdW5kIHRyYW5zY3JpcHQgcGFyYW1ldGVyczogJHt0cmFuc2NyaXB0UGFyYW1zLnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKHBhcnNlRXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5lcnJvcihgRXJyb3IgcGFyc2luZyBuZXh0IEFQSSByZXNwb25zZTogJHtwYXJzZUVycm9yLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGV4dHJhY3QgdHJhbnNjcmlwdCBwYXJhbWV0ZXJzIGZyb20gWW91VHViZSBBUEkgcmVzcG9uc2VgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gU3RlcCAyOiBSZXF1ZXN0IHRoZSBhY3R1YWwgdHJhbnNjcmlwdCB1c2luZyB0aGUgcGFyYW1ldGVyc1xuICAgICAgICAgICAgICAgIGNvbnN0IGdldFRyYW5zY3JpcHRVcmwgPSBgaHR0cHM6Ly93d3cueW91dHViZS5jb20veW91dHViZWkvdjEvZ2V0X3RyYW5zY3JpcHQ/cHJldHR5UHJpbnQ9ZmFsc2VgO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnN0IHRyYW5zY3JpcHRSZXF1ZXN0Qm9keSA9IHtcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xpZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xpZW50TmFtZTogXCJXRUJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGllbnRWZXJzaW9uOiBcIjIuMjAyNDEyMDUuMDEuMDBcIlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IHRyYW5zY3JpcHRQYXJhbXNcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFN0ZXAgMjogUmVxdWVzdGluZyB0cmFuc2NyaXB0IGZyb20gJHtnZXRUcmFuc2NyaXB0VXJsfWApO1xuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFN0ZXAgMjogVXNpbmcgcGFyYW1zOiAke3RyYW5zY3JpcHRQYXJhbXMuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29uc3QgdHJhbnNjcmlwdFJlc3BvbnNlID0gYXdhaXQgb2JzaWRpYW5GZXRjaChnZXRUcmFuc2NyaXB0VXJsLCB7XG4gICAgICAgICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnVXNlci1BZ2VudCc6IFlvdVR1YmVUcmFuc2NyaXB0RXh0cmFjdG9yLlVTRVJfQUdFTlQsXG4gICAgICAgICAgICAgICAgICAgICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ0FjY2VwdC1MYW5ndWFnZSc6ICdlbi1VUyxlbjtxPTAuOScsXG4gICAgICAgICAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1JlZmVyZXInOiB3YXRjaFVybCxcbiAgICAgICAgICAgICAgICAgICAgICAgICdPcmlnaW4nOiAnaHR0cHM6Ly93d3cueW91dHViZS5jb20nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ0ROVCc6ICcxJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLihZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3Rvci5jb29raWVTdG9yZSAmJiB7ICdDb29raWUnOiBZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3Rvci5jb29raWVTdG9yZSB9KVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh0cmFuc2NyaXB0UmVxdWVzdEJvZHkpXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKCF0cmFuc2NyaXB0UmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZmV0Y2ggdHJhbnNjcmlwdDogSFRUUCAke3RyYW5zY3JpcHRSZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnN0IHRyYW5zY3JpcHREYXRhID0gYXdhaXQgdHJhbnNjcmlwdFJlc3BvbnNlLmpzb24oKTtcbiAgICAgICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmRlYnVnKGBTdGVwIDIgY29tcGxldGVkOiByZWNlaXZlZCB0cmFuc2NyaXB0IGRhdGEgd2l0aCAke0pTT04uc3RyaW5naWZ5KHRyYW5zY3JpcHREYXRhKS5sZW5ndGh9IGNoYXJhY3RlcnNgKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBQYXJzZSB0aGUgdHJhbnNjcmlwdCBkYXRhXG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgLy8gTG9vayBmb3IgdHJhbnNjcmlwdCB0ZXh0IGluIHRoZSByZXNwb25zZSB3aXRoIGVuaGFuY2VkIHNlYXJjaFxuICAgICAgICAgICAgICAgICAgICBjb25zdCBmaW5kVHJhbnNjcmlwdFRleHQgPSAob2JqOiBhbnksIGRlcHRoID0gMCwgcGF0aCA9ICdyb290Jyk6IGFueSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGVwdGggPiAxMCkgcmV0dXJuIG51bGw7IC8vIFByZXZlbnQgaW5maW5pdGUgcmVjdXJzaW9uXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvYmogJiYgdHlwZW9mIG9iaiA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDaGVjayBmb3IgdGhlIG1haW4gdHJhbnNjcmlwdCBzdHJ1Y3R1cmVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAob2JqLnRyYW5zY3JpcHRCb2R5Py50cmFuc2NyaXB0Qm9keVJlbmRlcmVyPy5jdWVHcm91cHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgRm91bmQgY3VlR3JvdXBzIGF0IHBhdGg6ICR7cGF0aH0udHJhbnNjcmlwdEJvZHkudHJhbnNjcmlwdEJvZHlSZW5kZXJlci5jdWVHcm91cHNgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9iai50cmFuc2NyaXB0Qm9keS50cmFuc2NyaXB0Qm9keVJlbmRlcmVyLmN1ZUdyb3VwcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2hlY2sgZm9yIGFsdGVybmF0aXZlIHRyYW5zY3JpcHQgc3RydWN0dXJlc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvYmouY3VlR3JvdXBzICYmIEFycmF5LmlzQXJyYXkob2JqLmN1ZUdyb3VwcykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgRm91bmQgY3VlR3JvdXBzIGRpcmVjdGx5IGF0IHBhdGg6ICR7cGF0aH0uY3VlR3JvdXBzYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvYmouY3VlR3JvdXBzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDaGVjayBmb3IgdXBkYXRlRW5nYWdlbWVudFBhbmVsQWN0aW9uIHN0cnVjdHVyZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvYmoudXBkYXRlRW5nYWdlbWVudFBhbmVsQWN0aW9uPy5jb250ZW50Py50cmFuc2NyaXB0UmVuZGVyZXI/LmNvbnRlbnQ/LnRyYW5zY3JpcHRTZWFyY2hQYW5lbFJlbmRlcmVyPy5ib2R5Py50cmFuc2NyaXB0U2VnbWVudExpc3RSZW5kZXJlcj8uaW5pdGlhbFNlZ21lbnRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEZvdW5kIHNlZ21lbnRzIGluIHVwZGF0ZUVuZ2FnZW1lbnRQYW5lbEFjdGlvbiBhdCBwYXRoOiAke3BhdGh9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvYmoudXBkYXRlRW5nYWdlbWVudFBhbmVsQWN0aW9uLmNvbnRlbnQudHJhbnNjcmlwdFJlbmRlcmVyLmNvbnRlbnQudHJhbnNjcmlwdFNlYXJjaFBhbmVsUmVuZGVyZXIuYm9keS50cmFuc2NyaXB0U2VnbWVudExpc3RSZW5kZXJlci5pbml0aWFsU2VnbWVudHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFNlYXJjaCB0aHJvdWdoIGFjdGlvbnMgYXJyYXlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAob2JqLmFjdGlvbnMgJiYgQXJyYXkuaXNBcnJheShvYmouYWN0aW9ucykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvYmouYWN0aW9ucy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gZmluZFRyYW5zY3JpcHRUZXh0KG9iai5hY3Rpb25zW2ldLCBkZXB0aCArIDEsIGAke3BhdGh9LmFjdGlvbnNbJHtpfV1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gU2VhcmNoIHRocm91Z2ggYWxsIG9iamVjdCBwcm9wZXJ0aWVzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgaW4gb2JqKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2Ygb2JqW2tleV0gPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBmaW5kVHJhbnNjcmlwdFRleHQob2JqW2tleV0sIGRlcHRoICsgMSwgYCR7cGF0aH0uJHtrZXl9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjdWVHcm91cHMgPSBmaW5kVHJhbnNjcmlwdFRleHQodHJhbnNjcmlwdERhdGEpO1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjdWVHcm91cHMgfHwgIUFycmF5LmlzQXJyYXkoY3VlR3JvdXBzKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5lcnJvcihgTm8gY3VlR3JvdXBzIGZvdW5kIGluIHRyYW5zY3JpcHQgcmVzcG9uc2VgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYFRyYW5zY3JpcHQgcmVzcG9uc2Uga2V5czogJHtPYmplY3Qua2V5cyh0cmFuc2NyaXB0RGF0YSkuam9pbignLCAnKX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gSWYgd2UgaGF2ZSBhY3Rpb25zLCBsZXQncyBleGFtaW5lIHRoZWlyIHN0cnVjdHVyZVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRyYW5zY3JpcHREYXRhLmFjdGlvbnMgJiYgQXJyYXkuaXNBcnJheSh0cmFuc2NyaXB0RGF0YS5hY3Rpb25zKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEZvdW5kICR7dHJhbnNjcmlwdERhdGEuYWN0aW9ucy5sZW5ndGh9IGFjdGlvbnMsIGV4YW1pbmluZyBzdHJ1Y3R1cmUuLi5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0RGF0YS5hY3Rpb25zLmZvckVhY2goKGFjdGlvbjogYW55LCBpOiBudW1iZXIpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFjdGlvbiAmJiB0eXBlb2YgYWN0aW9uID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgQWN0aW9uICR7aX0ga2V5czogJHtPYmplY3Qua2V5cyhhY3Rpb24pLmpvaW4oJywgJyl9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoYWN0aW9uLnVwZGF0ZUVuZ2FnZW1lbnRQYW5lbEFjdGlvbikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEFjdGlvbiAke2l9IGhhcyB1cGRhdGVFbmdhZ2VtZW50UGFuZWxBY3Rpb25gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE5vIHRyYW5zY3JpcHQgY3VlR3JvdXBzIGZvdW5kIGluIFlvdVR1YmUgQVBJIHJlc3BvbnNlYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoYEZvdW5kICR7Y3VlR3JvdXBzLmxlbmd0aH0gY3VlIGdyb3VwcyBpbiB0cmFuc2NyaXB0YCk7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAvLyBDb252ZXJ0IGN1ZSBncm91cHMgdG8gc2VnbWVudHMgLSBoYW5kbGUgbXVsdGlwbGUgZm9ybWF0c1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBzZWdtZW50cyA9IGN1ZUdyb3Vwcy5tYXAoKGN1ZUdyb3VwOiBhbnksIGluZGV4OiBudW1iZXIpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRyYWRpdGlvbmFsIGN1ZUdyb3VwIGZvcm1hdFxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY3VlID0gY3VlR3JvdXAudHJhbnNjcmlwdEN1ZUdyb3VwUmVuZGVyZXI/LmN1ZXM/LlswXT8udHJhbnNjcmlwdEN1ZVJlbmRlcmVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGN1ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHRleHQgPSBjdWUuY3VlPy5zaW1wbGVUZXh0IHx8ICcnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YXJ0TXMgPSBwYXJzZUludChjdWUuc3RhcnRPZmZzZXRNcyB8fCAnMCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGR1cmF0aW9uTXMgPSBwYXJzZUludChjdWUuZHVyYXRpb25NcyB8fCAnMCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRleHQ6IHRleHQudHJpbSgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFydDogc3RhcnRNcyAvIDEwMDAsIC8vIENvbnZlcnQgdG8gc2Vjb25kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkdXJhdGlvbjogZHVyYXRpb25NcyAvIDEwMDAgLy8gQ29udmVydCB0byBzZWNvbmRzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gQWx0ZXJuYXRpdmUgZm9ybWF0OiB0cmFuc2NyaXB0U2VnbWVudFJlbmRlcmVyIChmcm9tIGluaXRpYWxTZWdtZW50cylcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNlZ21lbnRSZW5kZXJlciA9IGN1ZUdyb3VwLnRyYW5zY3JpcHRTZWdtZW50UmVuZGVyZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoc2VnbWVudFJlbmRlcmVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IHNlZ21lbnRSZW5kZXJlci5zbmlwcGV0Py5ydW5zPy5bMF0/LnRleHQgfHwgJyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3RhcnRNcyA9IHBhcnNlSW50KHNlZ21lbnRSZW5kZXJlci5zdGFydE1zIHx8ICcwJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZW5kTXMgPSBwYXJzZUludChzZWdtZW50UmVuZGVyZXIuZW5kTXMgfHwgJzAnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkdXJhdGlvbk1zID0gZW5kTXMgLSBzdGFydE1zO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRleHQ6IHRleHQudHJpbSgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFydDogc3RhcnRNcyAvIDEwMDAsIC8vIENvbnZlcnQgdG8gc2Vjb25kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkdXJhdGlvbjogZHVyYXRpb25NcyAvIDEwMDAgLy8gQ29udmVydCB0byBzZWNvbmRzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gSWYgbmVpdGhlciBmb3JtYXQgd29ya3MsIGxvZyBmb3IgZGVidWdnaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5kZXggPCAzKSB7IC8vIE9ubHkgbG9nIGZpcnN0IGZldyBmb3IgZGVidWdnaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgVW5rbm93biBjdWVHcm91cCBmb3JtYXQgYXQgaW5kZXggJHtpbmRleH06ICR7T2JqZWN0LmtleXMoY3VlR3JvdXApLmpvaW4oJywgJyl9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9KS5maWx0ZXIoKHNlZ21lbnQ6IGFueSk6IHNlZ21lbnQgaXMgVHJhbnNjcmlwdFNlZ21lbnQgPT4gc2VnbWVudCAhPT0gbnVsbCAmJiBzZWdtZW50LnRleHQpO1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgUGFyc2VkICR7c2VnbWVudHMubGVuZ3RofSB0cmFuc2NyaXB0IHNlZ21lbnRzYCk7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE5vIHZhbGlkIHRyYW5zY3JpcHQgc2VnbWVudHMgZm91bmQgaW4gWW91VHViZSBBUEkgcmVzcG9uc2VgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgU2NyYXBlQ3JlYXRvcnMgbWV0aG9kIHN1Y2NlZWRlZCB3aXRoICR7c2VnbWVudHMubGVuZ3RofSBzZWdtZW50c2ApO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4geyBzZWdtZW50cywgbWV0YWRhdGEgfTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAocGFyc2VFcnJvcikge1xuICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmVycm9yKGBFcnJvciBwYXJzaW5nIHRyYW5zY3JpcHQgcmVzcG9uc2U6ICR7cGFyc2VFcnJvci5tZXNzYWdlfWApO1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBwYXJzZSB0cmFuc2NyaXB0IGRhdGEgZnJvbSBZb3VUdWJlIEFQSSByZXNwb25zZWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5lcnJvcignRXJyb3IgZmV0Y2hpbmcgdHJhbnNjcmlwdDonLCBlcnJvcj8ubWVzc2FnZSB8fCBlcnJvcik7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gSWYgd2Ugc3VjY2Vzc2Z1bGx5IGV4dHJhY3RlZCBtZXRhZGF0YSBidXQgY2FwdGlvbiBmZXRjaGluZyBmYWlsZWQsXG4gICAgICAgICAgICAgICAgLy8gd2Ugc2hvdWxkIHN0aWxsIHJldHVybiB0aGUgbWV0YWRhdGEgd2l0aCBhbiBlcnJvciB0cmFuc2NyaXB0XG4gICAgICAgICAgICAgICAgaWYgKG1ldGFkYXRhICYmIChtZXRhZGF0YS50aXRsZSB8fCBtZXRhZGF0YS5hdXRob3IpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZGVidWcoJ1JldHVybmluZyBtZXRhZGF0YSBkZXNwaXRlIGNhcHRpb24gZmFpbHVyZScpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2VnbWVudHM6IFt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogYFtUUkFOU0NSSVBUIEVYVFJBQ1RJT04gRkFJTEVEOiAke2Vycm9yPy5tZXNzYWdlIHx8IGVycm9yfV1gLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0YXJ0OiAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGR1cmF0aW9uOiAwXG4gICAgICAgICAgICAgICAgICAgICAgICB9XSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1ldGFkYXRhXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmVycm9yKCdFcnJvciBmZXRjaGluZyB0cmFuc2NyaXB0IGZyb20gWW91VHViZTonLCBlcnJvcj8ubWVzc2FnZSB8fCBlcnJvcik7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIERldGVjdCBpZiB0aGlzIGlzIGEgQ09SUyBlcnJvclxuICAgICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgJiYgKFxuICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ0NPUlMnKSB8fCBcbiAgICAgICAgICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdDcm9zcy1PcmlnaW4nKSB8fCBcbiAgICAgICAgICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nKVxuICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ09SUyBwb2xpY3kgYmxvY2tlZCB0aGUgcmVxdWVzdC4gUGxlYXNlIHRyeSBhIGRpZmZlcmVudCB2aWRlbyBvciBjaGVjayB5b3VyIGludGVybmV0IGNvbm5lY3Rpb24uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIENoZWNrIGZvciBuZXR3b3JrIGVycm9yc1xuICAgICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgJiYgKFxuICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ25ldHdvcmsnKSB8fCBcbiAgICAgICAgICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdmZXRjaCcpIHx8IFxuICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ2Nvbm5lY3QnKSB8fFxuICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ3RpbWVvdXQnKVxuICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTmV0d29yayBlcnJvciB3aGlsZSBmZXRjaGluZyB0cmFuc2NyaXB0LiBQbGVhc2UgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBFeHRyYWN0cyBvbmx5IHRyYW5zY3JpcHQgc2VnbWVudHMgZnJvbSBhIFlvdVR1YmUgdmlkZW8gKGJhY2t3YXJkIGNvbXBhdGliaWxpdHkpXG4gICAgICogQHBhcmFtIHZpZGVvSWQgWW91VHViZSB2aWRlbyBJRFxuICAgICAqIEBwYXJhbSBvcHRpb25zIE9wdGlvbmFsIGxhbmd1YWdlIGFuZCBjb3VudHJ5IHNldHRpbmdzXG4gICAgICogQHJldHVybnMgUHJvbWlzZSB3aXRoIHRyYW5zY3JpcHQgc2VnbWVudHMgb25seVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmZXRjaFRyYW5zY3JpcHRTZWdtZW50cyh2aWRlb0lkOiBzdHJpbmcsIG9wdGlvbnM6IFRyYW5zY3JpcHRPcHRpb25zID0ge30pOiBQcm9taXNlPFRyYW5zY3JpcHRTZWdtZW50W10+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5mZXRjaFRyYW5zY3JpcHQodmlkZW9JZCwgb3B0aW9ucyk7XG4gICAgICAgIHJldHVybiByZXN1bHQuc2VnbWVudHM7XG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmlkZW8gbWV0YWRhdGEgZnJvbSB0aGUgcGxheWVyIHJlc3BvbnNlXG4gICAgICogQHBhcmFtIHZpZGVvSWQgWW91VHViZSB2aWRlbyBJRFxuICAgICAqIEByZXR1cm5zIFByb21pc2Ugd2l0aCBtZXRhZGF0YVxuICAgICAqL1xuXG4gICAgc3RhdGljIGFzeW5jIGdldFZpZGVvTWV0YWRhdGEodmlkZW9JZDogc3RyaW5nKTogUHJvbWlzZTxUcmFuc2NyaXB0TWV0YWRhdGE+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHdhdGNoVXJsID0gYGh0dHBzOi8vd3d3LnlvdXR1YmUuY29tL3dhdGNoP3Y9JHt2aWRlb0lkfWA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFJlcXVlc3Qgd2l0aCBVc2VyLUFnZW50IHRvIGVuc3VyZSB3ZSBnZXQgdGhlIGZ1bGwgcGFnZVxuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBvYnNpZGlhbkZldGNoKHdhdGNoVXJsLCB7XG4gICAgICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgICAgICAnVXNlci1BZ2VudCc6IFlvdVR1YmVUcmFuc2NyaXB0RXh0cmFjdG9yLlVTRVJfQUdFTlQsXG4gICAgICAgICAgICAgICAgICAgIC4uLihZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3Rvci5jb29raWVTdG9yZSAmJiB7ICdDb29raWUnOiBZb3VUdWJlVHJhbnNjcmlwdEV4dHJhY3Rvci5jb29raWVTdG9yZSB9KVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGZldGNoIHdhdGNoIHBhZ2U6IEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICBjb25zdCBwbGF5ZXJSZXNwb25zZVJlZ2V4ID0gL3l0SW5pdGlhbFBsYXllclJlc3BvbnNlXFxzKj1cXHMqKHsuKz99KVxccyo7XFxzKig/OnZhclxccysoPzptZXRhfGhlYWQpfDxcXC9zY3JpcHR8XFxuKS87XG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGJvZHkubWF0Y2gocGxheWVyUmVzcG9uc2VSZWdleCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghbWF0Y2gpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmFibGUgdG8gbG9jYXRlIHl0SW5pdGlhbFBsYXllclJlc3BvbnNlIGluIHdhdGNoIHBhZ2UgSFRNTC5cIik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IHBsYXllclJlc3BvbnNlID0gSlNPTi5wYXJzZShtYXRjaFsxXSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgdGl0bGU6IHBsYXllclJlc3BvbnNlPy52aWRlb0RldGFpbHM/LnRpdGxlLFxuICAgICAgICAgICAgICAgIGF1dGhvcjogcGxheWVyUmVzcG9uc2U/LnZpZGVvRGV0YWlscz8uYXV0aG9yXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmVycm9yKCdFcnJvciBmZXRjaGluZyB2aWRlbyBtZXRhZGF0YTonLCBlcnJvcik7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogQ29tYmluZXMgdHJhbnNjcmlwdCBzZWdtZW50cyBpbnRvIGEgc2luZ2xlIHRleHRcbiAgICAgKiBAcGFyYW0gc2VnbWVudHMgQXJyYXkgb2YgdHJhbnNjcmlwdCBzZWdtZW50c1xuICAgICAqIEByZXR1cm5zIENvbWJpbmVkIHRyYW5zY3JpcHQgdGV4dFxuICAgICAqL1xuICAgIHN0YXRpYyBjb21iaW5lVHJhbnNjcmlwdChzZWdtZW50czogVHJhbnNjcmlwdFNlZ21lbnRbXSk6IHN0cmluZyB7XG4gICAgICAgIHJldHVybiBzZWdtZW50cy5tYXAoc2VnbWVudCA9PiBzZWdtZW50LnRleHQpLmpvaW4oJyAnKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0cyB2aWRlbyBJRCBmcm9tIGEgWW91VHViZSBVUkxcbiAgICAgKiBAcGFyYW0gdXJsIFlvdVR1YmUgdmlkZW8gVVJMXG4gICAgICogQHJldHVybnMgVmlkZW8gSUQgb3IgbnVsbCBpZiBub3QgZm91bmRcbiAgICAgKi9cbiAgICBzdGF0aWMgZXh0cmFjdFZpZGVvSWQodXJsOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICAgICAgLy8gQ2xlYW4gdXAgdGhlIFVSTCAtIHRyaW0gYW5kIGVuc3VyZSBpdCdzIHByb3Blcmx5IGZvcm1lZFxuICAgICAgICB1cmwgPSB1cmwudHJpbSgpO1xuICAgICAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdodHRwOi8vJykgJiYgIXVybC5zdGFydHNXaXRoKCdodHRwczovLycpICYmICF1cmwuc3RhcnRzV2l0aCgnd3d3LicpKSB7XG4gICAgICAgICAgICB1cmwgPSAnaHR0cHM6Ly8nICsgdXJsO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gUGFyc2UgdGhlIFVSTCB0byBoYW5kbGUgdmFyaW91cyBmb3JtYXRzIG1vcmUgcmVsaWFibHlcbiAgICAgICAgICAgIGNvbnN0IHVybE9iaiA9IG5ldyBVUkwodXJsKTtcbiAgICAgICAgICAgIGNvbnN0IGhvc3RuYW1lID0gdXJsT2JqLmhvc3RuYW1lO1xuICAgICAgICAgICAgY29uc3QgcGF0aG5hbWUgPSB1cmxPYmoucGF0aG5hbWU7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIHlvdXR1YmUuY29tL3dhdGNoP3Y9VklERU9fSURcbiAgICAgICAgICAgIGlmIChob3N0bmFtZS5pbmNsdWRlcygneW91dHViZS5jb20nKSAmJiBwYXRobmFtZSA9PT0gJy93YXRjaCcpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdXJsT2JqLnNlYXJjaFBhcmFtcy5nZXQoJ3YnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8geW91dHUuYmUvVklERU9fSURcbiAgICAgICAgICAgIGlmIChob3N0bmFtZSA9PT0gJ3lvdXR1LmJlJykge1xuICAgICAgICAgICAgICAgIC8vIFRoZSBwYXRobmFtZSBpbmNsdWRlcyB0aGUgbGVhZGluZyBzbGFzaCwgc28gd2UgcmVtb3ZlIGl0IGFuZCBzdHJpcCBxdWVyeSBwYXJhbXNcbiAgICAgICAgICAgICAgICByZXR1cm4gcGF0aG5hbWUuc3Vic3RyaW5nKDEpLnNwbGl0KCc/JylbMF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIHlvdXR1YmUuY29tL2VtYmVkL1ZJREVPX0lEXG4gICAgICAgICAgICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoJ3lvdXR1YmUuY29tJykgJiYgcGF0aG5hbWUuc3RhcnRzV2l0aCgnL2VtYmVkLycpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBhdGhuYW1lLnNwbGl0KCcvJylbMl07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIHlvdXR1YmUuY29tL3YvVklERU9fSURcbiAgICAgICAgICAgIGlmIChob3N0bmFtZS5pbmNsdWRlcygneW91dHViZS5jb20nKSAmJiBwYXRobmFtZS5zdGFydHNXaXRoKCcvdi8nKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBwYXRobmFtZS5zcGxpdCgnLycpWzJdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyB5b3V0dWJlLmNvbS9zaG9ydHMvVklERU9fSURcbiAgICAgICAgICAgIGlmIChob3N0bmFtZS5pbmNsdWRlcygneW91dHViZS5jb20nKSAmJiBwYXRobmFtZS5zdGFydHNXaXRoKCcvc2hvcnRzLycpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBhdGhuYW1lLnNwbGl0KCcvJylbMl07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIHlvdXR1YmUuY29tL2xpdmUvVklERU9fSUQgLSBBZGQgc3VwcG9ydCBmb3IgbGl2ZSBVUkxzXG4gICAgICAgICAgICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoJ3lvdXR1YmUuY29tJykgJiYgcGF0aG5hbWUuc3RhcnRzV2l0aCgnL2xpdmUvJykpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGF0aG5hbWUuc3BsaXQoJy8nKVsyXS5zcGxpdCgnPycpWzBdOyAvLyBIYW5kbGUgcG90ZW50aWFsIHF1ZXJ5IHBhcmFtc1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBtdXNpYy55b3V0dWJlLmNvbS93YXRjaD92PVZJREVPX0lEXG4gICAgICAgICAgICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoJ211c2ljLnlvdXR1YmUuY29tJykgJiYgcGF0aG5hbWUgPT09ICcvd2F0Y2gnKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVybE9iai5zZWFyY2hQYXJhbXMuZ2V0KCd2Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmVycm9yKFwiRXJyb3IgcGFyc2luZyBZb3VUdWJlIFVSTDpcIiwgZXJyb3IpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBGYWxsYmFjayB0byByZWdleCBwYXR0ZXJucyBmb3IgY29tcGF0aWJpbGl0eVxuICAgICAgICAgICAgY29uc3QgcGF0dGVybnMgPSBbXG4gICAgICAgICAgICAgICAgLyg/OnlvdXR1YmVcXC5jb21cXC93YXRjaFxcP3Y9fHlvdXR1XFwuYmVcXC8pKFteJlxcbj8jXSspLyxcbiAgICAgICAgICAgICAgICAveW91dHViZVxcLmNvbVxcL2VtYmVkXFwvKFtePyZcXG4vXSspLyxcbiAgICAgICAgICAgICAgICAveW91dHViZVxcLmNvbVxcL3ZcXC8oW14/Jlxcbi9dKykvLFxuICAgICAgICAgICAgICAgIC95b3V0dWJlXFwuY29tXFwvc2hvcnRzXFwvKFtePyZcXG4vXSspLyxcbiAgICAgICAgICAgICAgICAveW91dHViZVxcLmNvbVxcL2xpdmVcXC8oW14/Jlxcbi9dKykvLCAgLy8gQWRkIHBhdHRlcm4gZm9yIGxpdmUgVVJMc1xuICAgICAgICAgICAgICAgIC9tdXNpY1xcLnlvdXR1YmVcXC5jb21cXC93YXRjaFxcP3Y9KFteJlxcbj8jXSspL1xuICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSB1cmwubWF0Y2gocGF0dGVybik7XG4gICAgICAgICAgICAgICAgaWYgKG1hdGNoICYmIG1hdGNoWzFdKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBtYXRjaFsxXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBhcnNlcyBZb3VUdWJlIGNhcHRpb25zIGluIFhNTCBmb3JtYXRcbiAgICAgKiBAcGFyYW0geG1sVGV4dCBUaGUgWE1MIGNvbnRlbnQgb2YgY2FwdGlvbnNcbiAgICAgKiBAcGFyYW0gdmlkZW9JZCBWaWRlbyBJRCBmb3IgcmVmZXJlbmNlXG4gICAgICogQHJldHVybnMgUGFyc2VkIHRyYW5zY3JpcHQgc2VnbWVudHNcbiAgICAgKi9cbiAgICBzdGF0aWMgcGFyc2VYbWxDYXB0aW9ucyh4bWxUZXh0OiBzdHJpbmcsIHZpZGVvSWQ6IHN0cmluZyk6IFRyYW5zY3JpcHRTZWdtZW50W10ge1xuICAgICAgICB0cmFuc2NyaXB0TG9nZ2VyLmRlYnVnKGBQYXJzaW5nIFhNTCBjYXB0aW9ucyBmb3IgdmlkZW8gJHt2aWRlb0lkfWApO1xuICAgICAgICBcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFNpbXBsZSByZWdleC1iYXNlZCBwYXJzaW5nIG9mIHRoZSB0cmFuc2NyaXB0IFhNTFxuICAgICAgICAgICAgLy8gRm9ybWF0IGlzIHR5cGljYWxseTogPHRleHQgc3RhcnQ9XCJzdGFydFRpbWVcIiBkdXI9XCJkdXJhdGlvblwiPkNhcHRpb24gdGV4dDwvdGV4dD5cbiAgICAgICAgICAgIGNvbnN0IHNlZ21lbnRzOiBUcmFuc2NyaXB0U2VnbWVudFtdID0gW107XG4gICAgICAgICAgICBjb25zdCB0ZXh0UmVnZXggPSAvPHRleHRcXHMrc3RhcnQ9XCIoW15cIl0rKVwiXFxzK2R1cj1cIihbXlwiXSspXCIoPzpbXj5dKik+KFtcXHNcXFNdKj8pPFxcL3RleHQ+L2c7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBtYXRjaDtcbiAgICAgICAgICAgIHdoaWxlICgobWF0Y2ggPSB0ZXh0UmVnZXguZXhlYyh4bWxUZXh0KSkgIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzdGFydFRpbWUgPSBwYXJzZUZsb2F0KG1hdGNoWzFdKTtcbiAgICAgICAgICAgICAgICBjb25zdCBkdXJhdGlvbiA9IHBhcnNlRmxvYXQobWF0Y2hbMl0pO1xuICAgICAgICAgICAgICAgIC8vIERlY29kZSBIVE1MIGVudGl0aWVzIGluIHRoZSB0ZXh0XG4gICAgICAgICAgICAgICAgbGV0IHRleHQgPSBtYXRjaFszXS5yZXBsYWNlKC8mYW1wOy9nLCAnJicpXG4gICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8mbHQ7L2csICc8JylcbiAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLyZndDsvZywgJz4nKVxuICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvJnF1b3Q7L2csICdcIicpXG4gICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8mIzM5Oy9nLCBcIidcIilcbiAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLyZuYnNwOy9nLCAnICcpXG4gICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC88W14+XSo+L2csICcnKTsgLy8gUmVtb3ZlIGFueSBIVE1MIHRhZ3NcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0ZXh0ID0gdGV4dC50cmltKCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHRleHQpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VnbWVudHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgc3RhcnQ6IHN0YXJ0VGltZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGR1cmF0aW9uXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZXJyb3IoXCJObyBzZWdtZW50cyBleHRyYWN0ZWQgZnJvbSBYTUxcIik7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIHBhcnNlIFhNTCBjYXB0aW9uczogTm8gdGV4dCBzZWdtZW50cyBmb3VuZFwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHNlZ21lbnRzO1xuICAgICAgICAgICAgXG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHRyYW5zY3JpcHRMb2dnZXIuZXJyb3IoXCJFcnJvciBwYXJzaW5nIFhNTCBjYXB0aW9uczpcIiwgZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFJldHVybiBhIGJhc2ljIGVycm9yIHNlZ21lbnRcbiAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0ZXh0OiBgRmFpbGVkIHRvIHBhcnNlIFlvdVR1YmUgY2FwdGlvbnMgZm9yIHZpZGVvICR7dmlkZW9JZH0uIEVycm9yOiAke2UubWVzc2FnZX1gLFxuICAgICAgICAgICAgICAgICAgICBzdGFydDogMCxcbiAgICAgICAgICAgICAgICAgICAgZHVyYXRpb246IDBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGFyc2VzIFlvdVR1YmUgY2FwdGlvbnMgaW4gSlNPTiBmb3JtYXRcbiAgICAgKiBAcGFyYW0ganNvblRleHQgVGhlIEpTT04gY29udGVudCBvZiBjYXB0aW9uc1xuICAgICAqIEBwYXJhbSB2aWRlb0lkIFZpZGVvIElEIGZvciByZWZlcmVuY2VcbiAgICAgKiBAcmV0dXJucyBQYXJzZWQgdHJhbnNjcmlwdCBzZWdtZW50c1xuICAgICAqL1xuICAgIHN0YXRpYyBwYXJzZUpzb25DYXB0aW9ucyhqc29uVGV4dDogc3RyaW5nLCB2aWRlb0lkOiBzdHJpbmcpOiBUcmFuc2NyaXB0U2VnbWVudFtdIHtcbiAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5kZWJ1ZyhgUGFyc2luZyBKU09OIGNhcHRpb25zIGZvciB2aWRlbyAke3ZpZGVvSWR9YCk7XG4gICAgICAgIFxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgdHJhbnNjcmlwdEpzb24gPSBKU09OLnBhcnNlKGpzb25UZXh0KTtcbiAgICAgICAgICAgIGNvbnN0IGV2ZW50cyA9IHRyYW5zY3JpcHRKc29uLmV2ZW50cyB8fCBbXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gQ29udmVydCBldmVudHMgdG8gb3VyIFRyYW5zY3JpcHRTZWdtZW50IGZvcm1hdFxuICAgICAgICAgICAgY29uc3Qgc2VnbWVudHM6IFRyYW5zY3JpcHRTZWdtZW50W10gPSBbXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZXZlbnRzXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoZTogYW55KSA9PiBlLnNlZ3MgJiYgQXJyYXkuaXNBcnJheShlLnNlZ3MpKSAvLyBGaWx0ZXIgZXZlbnRzIHdpdGggdGV4dCBzZWdtZW50c1xuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChlOiBhbnkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3RhcnRNcyA9IGUudFN0YXJ0TXMgPyBwYXJzZUludChlLnRTdGFydE1zKSA6IDA7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGR1cmF0aW9uTXMgPSBlLmREdXJhdGlvbk1zID8gcGFyc2VJbnQoZS5kRHVyYXRpb25NcykgOiAwO1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgLy8gQ29tYmluZSBhbGwgc2VnbWVudHMgaW4gdGhpcyBldmVudFxuICAgICAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gZS5zZWdzXG4gICAgICAgICAgICAgICAgICAgICAgICAubWFwKChzZWc6IGFueSkgPT4gc2VnLnV0ZjggfHwgJycpXG4gICAgICAgICAgICAgICAgICAgICAgICAuam9pbignJylcbiAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9bXFx1MjAwQi1cXHUyMDBEXFx1RkVGRl0vZywgJycpOyAvLyBSZW1vdmUgc3BlY2lhbCBjaGFyc1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRleHQudHJpbSgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzZWdtZW50cy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiB0ZXh0LnRyaW0oKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFydDogc3RhcnRNcyAvIDEwMDAsIC8vIENvbnZlcnQgdG8gc2Vjb25kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGR1cmF0aW9uOiBkdXJhdGlvbk1zIC8gMTAwMCAvLyBDb252ZXJ0IHRvIHNlY29uZHNcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE5vIHRyYW5zY3JpcHQgc2VnbWVudHMgZm91bmQgaW4gSlNPTiBkYXRhLiBWaWRlbyBJRDogJHt2aWRlb0lkfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gc2VnbWVudHM7XG4gICAgICAgICAgICBcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgdHJhbnNjcmlwdExvZ2dlci5lcnJvcihcIkVycm9yIHBhcnNpbmcgSlNPTiBjYXB0aW9uczpcIiwgZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFJldHVybiBhIGJhc2ljIGVycm9yIHNlZ21lbnRcbiAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0ZXh0OiBgRmFpbGVkIHRvIHBhcnNlIFlvdVR1YmUgSlNPTiBjYXB0aW9ucyBmb3IgdmlkZW8gJHt2aWRlb0lkfS4gRXJyb3I6ICR7ZS5tZXNzYWdlfWAsXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0OiAwLFxuICAgICAgICAgICAgICAgICAgICBkdXJhdGlvbjogMFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF07XG4gICAgICAgIH1cbiAgICB9XG5cbn1cbiJdfQ==