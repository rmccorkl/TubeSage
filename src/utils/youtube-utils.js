import { Notice } from 'obsidian';
/**
 * Helper method to validate YouTube URLs
 * @param url URL to check
 * @returns true if URL is a valid YouTube URL (video, playlist, or channel)
 */
export function isYoutubeUrl(url) {
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
    }
    catch (e) {
        // If URL parsing fails, it's not a valid URL
        return false;
    }
}
/**
 * Helper method to check if a URL points to a YouTube channel or playlist
 * @param url URL to check
 * @returns true if URL is a YouTube channel or playlist URL
 */
export function isYoutubeChannelOrPlaylistUrl(url) {
    // Channel URL patterns: /@username, /channel/ID, /c/customname, /user/username
    // Playlist URL patterns: /playlist?list=ID
    // Parse the URL to get path and query parameters
    let urlObj;
    try {
        urlObj = new URL(url);
    }
    catch (e) {
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
export function extractChannelName(url) {
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
    }
    catch (error) {
        console.error('Error extracting channel name:', error);
        return 'YouTube-Channel';
    }
}
/**
 * Shows a notice with additional debug information
 * @param message Message to display
 * @param timeout Display duration in milliseconds
 */
export function showNotice(message, timeout = 5000) {
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
    }
    catch (e) {
        // Fallback to standard Notice if timeout parameter isn't supported
        new Notice(message);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoieW91dHViZS11dGlscy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInlvdXR1YmUtdXRpbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLFVBQVUsQ0FBQztBQUVsQzs7OztHQUlHO0FBQ0gsTUFBTSxVQUFVLFlBQVksQ0FBQyxHQUFXO0lBQ3BDLElBQUksQ0FBQztRQUNELHlEQUF5RDtRQUN6RCxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxzREFBc0QsQ0FBQyxFQUFFLENBQUM7WUFDckUsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQztRQUVELDhDQUE4QztRQUM5QyxNQUFNLE1BQU0sR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUU1Qix1QkFBdUI7UUFDdkIsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUM7WUFDcEMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUM7Z0JBQ3ZDLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDO29CQUNsQyxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUM7b0JBQ25DLE1BQU0sQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQztvQkFDakMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDO29CQUNsQyxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUN0QyxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDO1FBRUQsMEJBQTBCO1FBQzFCLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDO1lBQ3ZDLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDO2dCQUNy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LFdBQVcsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLDBDQUEwQyxDQUFDLENBQUM7UUFFakYsSUFBSSxTQUFTLEdBQUcsRUFBRSxDQUFDO1FBQ25CLElBQUksV0FBVyxFQUFFLENBQUM7WUFDZCxNQUFNLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLEdBQUcsV0FBVyxDQUFDO1lBQ25DLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUksSUFBSSxDQUFDO1lBQy9DLFNBQVMsR0FBRyxLQUFLLFFBQVEsSUFBSSxJQUFJLEdBQUcsQ0FBQztRQUN6QyxDQUFDO1FBRUQsbUVBQW1FO1FBQ25FLCtFQUErRTtRQUMvRSxJQUFJLE1BQU0sQ0FBQyxPQUFPLEdBQUcsU0FBUyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQzdDLENBQUM7SUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1FBQ1QsbUVBQW1FO1FBQ25FLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3hCLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgTm90aWNlIH0gZnJvbSAnb2JzaWRpYW4nO1xuXG4vKipcbiAqIEhlbHBlciBtZXRob2QgdG8gdmFsaWRhdGUgWW91VHViZSBVUkxzXG4gKiBAcGFyYW0gdXJsIFVSTCB0byBjaGVja1xuICogQHJldHVybnMgdHJ1ZSBpZiBVUkwgaXMgYSB2YWxpZCBZb3VUdWJlIFVSTCAodmlkZW8sIHBsYXlsaXN0LCBvciBjaGFubmVsKVxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNZb3V0dWJlVXJsKHVybDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gRmlyc3QgY2hlY2sgaWYgaXQncyBhIHBvdGVudGlhbGx5IHZhbGlkIFlvdVR1YmUgZG9tYWluXG4gICAgICAgIGlmICghdXJsLm1hdGNoKC9eKGh0dHBzPzpcXC9cXC8pPyh3d3dcXC58bVxcLik/KHlvdXR1YmVcXC5jb218eW91dHVcXC5iZSkvaSkpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gUGFyc2UgdGhlIFVSTCB0byBmdXJ0aGVyIHZhbGlkYXRlIHN0cnVjdHVyZVxuICAgICAgICBjb25zdCB1cmxPYmogPSBuZXcgVVJMKHVybCk7XG4gICAgICAgIFxuICAgICAgICAvLyBDaGVjayBmb3IgdmlkZW8gVVJMc1xuICAgICAgICBpZiAodXJsT2JqLmhvc3RuYW1lLmluY2x1ZGVzKCd5b3V0dS5iZScpIHx8IFxuICAgICAgICAgICAgKHVybE9iai5ob3N0bmFtZS5pbmNsdWRlcygneW91dHViZS5jb20nKSAmJiBcbiAgICAgICAgICAgICAodXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvd2F0Y2gnKSB8fCBcbiAgICAgICAgICAgICAgdXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvc2hvcnRzJykgfHwgXG4gICAgICAgICAgICAgIHVybE9iai5wYXRobmFtZS5pbmNsdWRlcygnL2xpdmUnKSB8fFxuICAgICAgICAgICAgICB1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy9lbWJlZCcpIHx8IFxuICAgICAgICAgICAgICB1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy92LycpKSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBDaGVjayBmb3IgcGxheWxpc3QgVVJMc1xuICAgICAgICBpZiAodXJsT2JqLmhvc3RuYW1lLmluY2x1ZGVzKCd5b3V0dWJlLmNvbScpICYmIFxuICAgICAgICAgICAgKHVybE9iai5wYXRobmFtZS5pbmNsdWRlcygnL3BsYXlsaXN0JykgfHwgXG4gICAgICAgICAgICAgKHVybE9iai5wYXRobmFtZS5pbmNsdWRlcygnL3dhdGNoJykgJiYgdXJsT2JqLnNlYXJjaFBhcmFtcy5oYXMoJ2xpc3QnKSkpKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gQ2hlY2sgZm9yIGNoYW5uZWwgVVJMc1xuICAgICAgICBpZiAodXJsT2JqLmhvc3RuYW1lLmluY2x1ZGVzKCd5b3V0dWJlLmNvbScpICYmIFxuICAgICAgICAgICAgKHVybE9iai5wYXRobmFtZS5pbmNsdWRlcygnL0AnKSB8fCBcbiAgICAgICAgICAgICB1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy9jaGFubmVsLycpIHx8IFxuICAgICAgICAgICAgIHVybE9iai5wYXRobmFtZS5pbmNsdWRlcygnL2MvJykgfHwgXG4gICAgICAgICAgICAgdXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvdXNlci8nKSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBJZiB3ZSBnb3QgaGVyZSwgaXQncyBhIFlvdVR1YmUgZG9tYWluIGJ1dCBub3QgYSB2YWxpZCB2aWRlbywgcGxheWxpc3QsIG9yIGNoYW5uZWwgVVJMXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIElmIFVSTCBwYXJzaW5nIGZhaWxzLCBpdCdzIG5vdCBhIHZhbGlkIFVSTFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxufVxuXG4vKipcbiAqIEhlbHBlciBtZXRob2QgdG8gY2hlY2sgaWYgYSBVUkwgcG9pbnRzIHRvIGEgWW91VHViZSBjaGFubmVsIG9yIHBsYXlsaXN0XG4gKiBAcGFyYW0gdXJsIFVSTCB0byBjaGVja1xuICogQHJldHVybnMgdHJ1ZSBpZiBVUkwgaXMgYSBZb3VUdWJlIGNoYW5uZWwgb3IgcGxheWxpc3QgVVJMXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1lvdXR1YmVDaGFubmVsT3JQbGF5bGlzdFVybCh1cmw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIC8vIENoYW5uZWwgVVJMIHBhdHRlcm5zOiAvQHVzZXJuYW1lLCAvY2hhbm5lbC9JRCwgL2MvY3VzdG9tbmFtZSwgL3VzZXIvdXNlcm5hbWVcbiAgICAvLyBQbGF5bGlzdCBVUkwgcGF0dGVybnM6IC9wbGF5bGlzdD9saXN0PUlEXG4gICAgXG4gICAgLy8gUGFyc2UgdGhlIFVSTCB0byBnZXQgcGF0aCBhbmQgcXVlcnkgcGFyYW1ldGVyc1xuICAgIGxldCB1cmxPYmo7XG4gICAgdHJ5IHtcbiAgICAgICAgdXJsT2JqID0gbmV3IFVSTCh1cmwpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gSW52YWxpZCBVUkxcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBcbiAgICAvLyBDaGVjayBpZiBpdCdzIGEgY2hhbm5lbCBVUkxcbiAgICBpZiAodXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvQCcpIHx8IFxuICAgICAgICB1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy9jaGFubmVsLycpIHx8IFxuICAgICAgICB1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy9jLycpIHx8IFxuICAgICAgICB1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy91c2VyLycpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBcbiAgICAvLyBDaGVjayBpZiBpdCdzIGFuIGV4cGxpY2l0IHBsYXlsaXN0IFVSTFxuICAgIGlmICh1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy9wbGF5bGlzdCcpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBcbiAgICAvLyBTcGVjaWFsIGNhc2U6IGlmIFVSTCBoYXMgYm90aCB3YXRjaD92PSBhbmQgbGlzdD0sIGl0J3MgYSB2aWRlbyBiZWluZyB2aWV3ZWQgZnJvbSBhIGxpc3QsIG5vdCBhIHBsYXlsaXN0IFVSTFxuICAgIGlmICh1cmxPYmoucGF0aG5hbWUuaW5jbHVkZXMoJy93YXRjaCcpICYmIHVybE9iai5zZWFyY2hQYXJhbXMuaGFzKCd2JykpIHtcbiAgICAgICAgLy8gSWYgaXQgaGFzIGEgdmlkZW8gSUQsIGl0J3MgYSBzaW5nbGUgdmlkZW8gKGV2ZW4gaWYgdmlld2VkIGZyb20gYSBsaXN0KVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIFxuICAgIC8vIE90aGVyd2lzZSwgY2hlY2sgaWYgbGlzdD0gaXMgaW4gdGhlIFVSTCBidXQgbm90IGFzIHBhcnQgb2YgYSB3YXRjaCBVUkxcbiAgICByZXR1cm4gdXJsT2JqLnNlYXJjaFBhcmFtcy5oYXMoJ2xpc3QnKTtcbn1cblxuLyoqXG4gKiBIZWxwZXIgbWV0aG9kIHRvIGV4dHJhY3QgY2hhbm5lbCBuYW1lIGZyb20gYSBZb3VUdWJlIFVSTFxuICogQHBhcmFtIHVybCBDaGFubmVsIFVSTFxuICogQHJldHVybnMgRXh0cmFjdGVkIGNoYW5uZWwgbmFtZSBvciBhIGZhbGxiYWNrXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0Q2hhbm5lbE5hbWUodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybE9iaiA9IG5ldyBVUkwodXJsKTtcbiAgICAgICAgXG4gICAgICAgIC8vIEhhbmRsZSAvQHVzZXJuYW1lIGZvcm1hdFxuICAgICAgICBpZiAodXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvQCcpKSB7XG4gICAgICAgICAgICByZXR1cm4gdXJsT2JqLnBhdGhuYW1lLnNwbGl0KCcvQCcpWzFdLnNwbGl0KCcvJylbMF07XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIEhhbmRsZSAvY2hhbm5lbC9JRCBmb3JtYXRcbiAgICAgICAgaWYgKHVybE9iai5wYXRobmFtZS5pbmNsdWRlcygnL2NoYW5uZWwvJykpIHtcbiAgICAgICAgICAgIHJldHVybiB1cmxPYmoucGF0aG5hbWUuc3BsaXQoJy9jaGFubmVsLycpWzFdLnNwbGl0KCcvJylbMF07XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIEhhbmRsZSAvYy9jdXN0b21uYW1lIGZvcm1hdFxuICAgICAgICBpZiAodXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvYy8nKSkge1xuICAgICAgICAgICAgcmV0dXJuIHVybE9iai5wYXRobmFtZS5zcGxpdCgnL2MvJylbMV0uc3BsaXQoJy8nKVswXTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gSGFuZGxlIC91c2VyL3VzZXJuYW1lIGZvcm1hdFxuICAgICAgICBpZiAodXJsT2JqLnBhdGhuYW1lLmluY2x1ZGVzKCcvdXNlci8nKSkge1xuICAgICAgICAgICAgcmV0dXJuIHVybE9iai5wYXRobmFtZS5zcGxpdCgnL3VzZXIvJylbMV0uc3BsaXQoJy8nKVswXTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuICdZb3VUdWJlLUNoYW5uZWwnOyAvLyBGYWxsYmFjayBuYW1lXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgZXh0cmFjdGluZyBjaGFubmVsIG5hbWU6JywgZXJyb3IpO1xuICAgICAgICByZXR1cm4gJ1lvdVR1YmUtQ2hhbm5lbCc7XG4gICAgfVxufVxuXG4vKipcbiAqIFNob3dzIGEgbm90aWNlIHdpdGggYWRkaXRpb25hbCBkZWJ1ZyBpbmZvcm1hdGlvblxuICogQHBhcmFtIG1lc3NhZ2UgTWVzc2FnZSB0byBkaXNwbGF5XG4gKiBAcGFyYW0gdGltZW91dCBEaXNwbGF5IGR1cmF0aW9uIGluIG1pbGxpc2Vjb25kc1xuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd05vdGljZShtZXNzYWdlOiBzdHJpbmcsIHRpbWVvdXQ6IG51bWJlciA9IDUwMDApOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgICAvLyBHZXQgc3RhY2sgdHJhY2UgdG8gZmluZCBjYWxsZXIgaW5mb1xuICAgICAgICBjb25zdCBzdGFjayA9IG5ldyBFcnJvcigpLnN0YWNrIHx8ICcnO1xuICAgICAgICBjb25zdCBjYWxsZXJMaW5lID0gc3RhY2suc3BsaXQoJ1xcbicpWzJdOyAvLyBTa2lwIEVycm9yIGFuZCBzaG93Tm90aWNlIGxpbmVzXG4gICAgICAgIGNvbnN0IGNhbGxlck1hdGNoID0gY2FsbGVyTGluZS5tYXRjaCgvYXRcXHMrKD86LipcXHMrKT9cXCg/KFteOl0rKTooXFxkKyk6KFxcZCspXFwpPy8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGRlYnVnSW5mbyA9ICcnO1xuICAgICAgICBpZiAoY2FsbGVyTWF0Y2gpIHtcbiAgICAgICAgICAgIGNvbnN0IFssIGZpbGUsIGxpbmVdID0gY2FsbGVyTWF0Y2g7XG4gICAgICAgICAgICBjb25zdCBmaWxlTmFtZSA9IGZpbGUuc3BsaXQoJy8nKS5wb3AoKSB8fCBmaWxlO1xuICAgICAgICAgICAgZGVidWdJbmZvID0gYCBbJHtmaWxlTmFtZX06JHtsaW5lfV1gO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBUcnkgd2l0aCB0aW1lb3V0IHBhcmFtZXRlciAobWF5IHdvcmsgaW4gbmV3ZXIgT2JzaWRpYW4gdmVyc2lvbnMpXG4gICAgICAgIC8vIEB0cy1pZ25vcmUgLSBJZ25vcmluZyBUeXBlU2NyaXB0IGVycm9yIGZvciBwb3RlbnRpYWxseSB1bnN1cHBvcnRlZCBwYXJhbWV0ZXJcbiAgICAgICAgbmV3IE5vdGljZShtZXNzYWdlICsgZGVidWdJbmZvLCB0aW1lb3V0KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHN0YW5kYXJkIE5vdGljZSBpZiB0aW1lb3V0IHBhcmFtZXRlciBpc24ndCBzdXBwb3J0ZWRcbiAgICAgICAgbmV3IE5vdGljZShtZXNzYWdlKTtcbiAgICB9XG59Il19