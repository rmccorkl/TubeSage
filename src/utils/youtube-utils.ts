import { Notice } from 'obsidian';

/**
 * Helper method to validate YouTube URLs
 * @param url URL to check
 * @returns true if URL is a valid YouTube URL (video, playlist, or channel)
 */
export function isYoutubeUrl(url: string): boolean {
    try {
        // First check if it's a potentially valid YouTube domain
        if (!url.match(/^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)/i)) {
            return false;
        }
        
        // Parse the URL to further validate structure
        const urlObj = new URL(url);
        
        // Check for video URLs
        if (urlObj.hostname.includes('youtu.be') || 
            (urlObj.hostname.includes('youtube.com') && 
             (urlObj.pathname.includes('/watch') || 
              urlObj.pathname.includes('/shorts') || 
              urlObj.pathname.includes('/live') ||
              urlObj.pathname.includes('/embed') || 
              urlObj.pathname.includes('/v/')))) {
            return true;
        }
        
        // Check for playlist URLs
        if (urlObj.hostname.includes('youtube.com') && 
            (urlObj.pathname.includes('/playlist') || 
             (urlObj.pathname.includes('/watch') && urlObj.searchParams.has('list')))) {
            return true;
        }
        
        // Check for channel URLs
        if (urlObj.hostname.includes('youtube.com') && 
            (urlObj.pathname.includes('/@') || 
             urlObj.pathname.includes('/channel/') || 
             urlObj.pathname.includes('/c/') || 
             urlObj.pathname.includes('/user/'))) {
            return true;
        }
        
        // If we got here, it's a YouTube domain but not a valid video, playlist, or channel URL
        return false;
    } catch {
        // If URL parsing fails, it's not a valid URL
        return false;
    }
}

/**
 * Helper method to check if a URL points to a YouTube channel or playlist
 * @param url URL to check
 * @returns true if URL is a YouTube channel or playlist URL
 */
export function isYoutubeChannelOrPlaylistUrl(url: string): boolean {
    // Channel URL patterns: /@username, /channel/ID, /c/customname, /user/username
    // Playlist URL patterns: /playlist?list=ID
    
    // Parse the URL to get path and query parameters
    let urlObj;
    try {
        urlObj = new URL(url);
    } catch {
        // Invalid URL
        return false;
    }
    
    // Check if it's a channel URL
    if (urlObj.pathname.includes('/@') || 
        urlObj.pathname.includes('/channel/') || 
        urlObj.pathname.includes('/c/') || 
        urlObj.pathname.includes('/user/')) {
        return true;
    }
    
    // Check if it's an explicit playlist URL
    if (urlObj.pathname.includes('/playlist')) {
        return true;
    }
    
    // Special case: if URL has both watch?v= and list=, it's a video being viewed from a list, not a playlist URL
    if (urlObj.pathname.includes('/watch') && urlObj.searchParams.has('v')) {
        // If it has a video ID, it's a single video (even if viewed from a list)
        return false;
    }
    
    // Otherwise, check if list= is in the URL but not as part of a watch URL
    return urlObj.searchParams.has('list');
}

/**
 * Helper method to extract channel name from a YouTube URL
 * @param url Channel URL
 * @returns Extracted channel name or a fallback
 */
export function extractChannelName(url: string): string {
    try {
        const urlObj = new URL(url);
        
        // Handle /@username format
        if (urlObj.pathname.includes('/@')) {
            return urlObj.pathname.split('/@')[1].split('/')[0];
        }
        
        // Handle /channel/ID format
        if (urlObj.pathname.includes('/channel/')) {
            return urlObj.pathname.split('/channel/')[1].split('/')[0];
        }
        
        // Handle /c/customname format
        if (urlObj.pathname.includes('/c/')) {
            return urlObj.pathname.split('/c/')[1].split('/')[0];
        }
        
        // Handle /user/username format
        if (urlObj.pathname.includes('/user/')) {
            return urlObj.pathname.split('/user/')[1].split('/')[0];
        }
        
        return 'YouTube-Channel'; // Fallback name
    } catch (error) {
        console.error('Error extracting channel name:', error);
        return 'YouTube-Channel';
    }
}

/**
 * Shows a notice with additional debug information
 * @param message Message to display
 * @param timeout Display duration in milliseconds
 */
export function showNotice(message: string, timeout: number = 5000): void {
    try {
        // Get stack trace to find caller info
        const stack = new Error().stack || '';
        const callerLine = stack.split('\n')[2]; // Skip Error and showNotice lines
        const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
        
        let debugInfo = '';
        if (callerMatch) {
            const [, file, line] = callerMatch;
            const fileName = file.split('/').pop() || file;
            debugInfo = ` [${fileName}:${line}]`;
        }
        
        // Try with timeout parameter (may work in newer Obsidian versions)
        // @ts-ignore - Ignoring TypeScript error for potentially unsupported parameter
        new Notice(message + debugInfo, timeout);
    } catch {
        // Fallback to standard Notice if timeout parameter isn't supported
        new Notice(message);
    }
}
