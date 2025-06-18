/**
 * Sanitizes a string to be used as a filename by:
 * 1. Removing all non-alphanumeric characters (including emojis and special characters)
 * 2. Replacing spaces with hyphens
 * 3. Removing leading/trailing spaces and dots
 * 4. Ensuring the filename isn't too long
 * 5. Handling special cases for Obsidian
 */
export function sanitizeFilename(title) {
    if (!title || title.trim() === '') {
        return 'untitled-note'; // Use a hyphenated default name
    }
    // First, normalize Unicode characters and remove anything non-alphanumeric
    let sanitized = title
        .normalize('NFD') // Decompose Unicode characters
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
        .replace(/[^\p{L}\p{N}\s-]/gu, '') // Only allow letters, numbers, spaces and hyphens
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .trim() // Remove leading/trailing spaces
        .replace(/^\.+|-+\.+$/g, '') // Remove leading/trailing dots and hyphens
        .replace(/^\.*$/g, 'untitled') // Replace dot-only filenames 
        .replace(/^\/*$/g, 'untitled') // Replace slash-only filenames
        .replace(/-+/g, '-'); // Replace multiple hyphens with a single hyphen
    // Remove trailing hyphens, periods, underscores and other common separators
    sanitized = sanitized.replace(/[-_.]+$/g, '');
    // Ensure the filename isn't too long (max 255 characters)
    if (sanitized.length > 255) {
        sanitized = sanitized.substring(0, 252) + '...';
    }
    // If the sanitized string is empty after all processing, use a default name
    if (!sanitized || /^\s*$/.test(sanitized)) {
        sanitized = 'untitled-note';
    }
    // Ensure the filename doesn't start with a number (Obsidian requirement)
    if (/^\d/.test(sanitized)) {
        sanitized = 'note-' + sanitized;
    }
    // Final check for trailing separators that might have been added in other steps
    sanitized = sanitized.replace(/[-_.]+$/g, '');
    return sanitized;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmlsZW5hbWUtc2FuaXRpemVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZmlsZW5hbWUtc2FuaXRpemVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLFVBQVUsZ0JBQWdCLENBQUMsS0FBYTtJQUMxQyxJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsQ0FBQztRQUNoQyxPQUFPLGVBQWUsQ0FBQyxDQUFFLGdDQUFnQztJQUM3RCxDQUFDO0lBRUQsMkVBQTJFO0lBQzNFLElBQUksU0FBUyxHQUFHLEtBQUs7U0FDaEIsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFtQiwrQkFBK0I7U0FDbEUsT0FBTyxDQUFDLGtCQUFrQixFQUFFLEVBQUUsQ0FBQyxDQUFJLG9CQUFvQjtTQUN2RCxPQUFPLENBQUMsb0JBQW9CLEVBQUUsRUFBRSxDQUFDLENBQUUsa0RBQWtEO1NBQ3JGLE9BQU8sQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLENBQWUsOEJBQThCO1NBQ2pFLElBQUksRUFBRSxDQUE2QixpQ0FBaUM7U0FDcEUsT0FBTyxDQUFDLGNBQWMsRUFBRSxFQUFFLENBQUMsQ0FBUSwyQ0FBMkM7U0FDOUUsT0FBTyxDQUFDLFFBQVEsRUFBRSxVQUFVLENBQUMsQ0FBTSw4QkFBOEI7U0FDakUsT0FBTyxDQUFDLFFBQVEsRUFBRSxVQUFVLENBQUMsQ0FBTSwrQkFBK0I7U0FDbEUsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFlLGdEQUFnRDtJQUV4Riw0RUFBNEU7SUFDNUUsU0FBUyxHQUFHLFNBQVMsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBRTlDLDBEQUEwRDtJQUMxRCxJQUFJLFNBQVMsQ0FBQyxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUM7UUFDekIsU0FBUyxHQUFHLFNBQVMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxHQUFHLEtBQUssQ0FBQztJQUNwRCxDQUFDO0lBRUQsNEVBQTRFO0lBQzVFLElBQUksQ0FBQyxTQUFTLElBQUksT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1FBQ3hDLFNBQVMsR0FBRyxlQUFlLENBQUM7SUFDaEMsQ0FBQztJQUVELHlFQUF5RTtJQUN6RSxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztRQUN4QixTQUFTLEdBQUcsT0FBTyxHQUFHLFNBQVMsQ0FBQztJQUNwQyxDQUFDO0lBRUQsZ0ZBQWdGO0lBQ2hGLFNBQVMsR0FBRyxTQUFTLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUU5QyxPQUFPLFNBQVMsQ0FBQztBQUNyQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTYW5pdGl6ZXMgYSBzdHJpbmcgdG8gYmUgdXNlZCBhcyBhIGZpbGVuYW1lIGJ5OlxuICogMS4gUmVtb3ZpbmcgYWxsIG5vbi1hbHBoYW51bWVyaWMgY2hhcmFjdGVycyAoaW5jbHVkaW5nIGVtb2ppcyBhbmQgc3BlY2lhbCBjaGFyYWN0ZXJzKVxuICogMi4gUmVwbGFjaW5nIHNwYWNlcyB3aXRoIGh5cGhlbnNcbiAqIDMuIFJlbW92aW5nIGxlYWRpbmcvdHJhaWxpbmcgc3BhY2VzIGFuZCBkb3RzXG4gKiA0LiBFbnN1cmluZyB0aGUgZmlsZW5hbWUgaXNuJ3QgdG9vIGxvbmdcbiAqIDUuIEhhbmRsaW5nIHNwZWNpYWwgY2FzZXMgZm9yIE9ic2lkaWFuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW5pdGl6ZUZpbGVuYW1lKHRpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghdGl0bGUgfHwgdGl0bGUudHJpbSgpID09PSAnJykge1xuICAgICAgICByZXR1cm4gJ3VudGl0bGVkLW5vdGUnOyAgLy8gVXNlIGEgaHlwaGVuYXRlZCBkZWZhdWx0IG5hbWVcbiAgICB9XG4gICAgXG4gICAgLy8gRmlyc3QsIG5vcm1hbGl6ZSBVbmljb2RlIGNoYXJhY3RlcnMgYW5kIHJlbW92ZSBhbnl0aGluZyBub24tYWxwaGFudW1lcmljXG4gICAgbGV0IHNhbml0aXplZCA9IHRpdGxlXG4gICAgICAgIC5ub3JtYWxpemUoJ05GRCcpICAgICAgICAgICAgICAgICAgIC8vIERlY29tcG9zZSBVbmljb2RlIGNoYXJhY3RlcnNcbiAgICAgICAgLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csICcnKSAgICAvLyBSZW1vdmUgZGlhY3JpdGljc1xuICAgICAgICAucmVwbGFjZSgvW15cXHB7TH1cXHB7Tn1cXHMtXS9ndSwgJycpICAvLyBPbmx5IGFsbG93IGxldHRlcnMsIG51bWJlcnMsIHNwYWNlcyBhbmQgaHlwaGVuc1xuICAgICAgICAucmVwbGFjZSgvXFxzKy9nLCAnLScpICAgICAgICAgICAgICAgLy8gUmVwbGFjZSBzcGFjZXMgd2l0aCBoeXBoZW5zXG4gICAgICAgIC50cmltKCkgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFJlbW92ZSBsZWFkaW5nL3RyYWlsaW5nIHNwYWNlc1xuICAgICAgICAucmVwbGFjZSgvXlxcLit8LStcXC4rJC9nLCAnJykgICAgICAgIC8vIFJlbW92ZSBsZWFkaW5nL3RyYWlsaW5nIGRvdHMgYW5kIGh5cGhlbnNcbiAgICAgICAgLnJlcGxhY2UoL15cXC4qJC9nLCAndW50aXRsZWQnKSAgICAgIC8vIFJlcGxhY2UgZG90LW9ubHkgZmlsZW5hbWVzIFxuICAgICAgICAucmVwbGFjZSgvXlxcLyokL2csICd1bnRpdGxlZCcpICAgICAgLy8gUmVwbGFjZSBzbGFzaC1vbmx5IGZpbGVuYW1lc1xuICAgICAgICAucmVwbGFjZSgvLSsvZywgJy0nKTsgICAgICAgICAgICAgICAvLyBSZXBsYWNlIG11bHRpcGxlIGh5cGhlbnMgd2l0aCBhIHNpbmdsZSBoeXBoZW5cbiAgICBcbiAgICAvLyBSZW1vdmUgdHJhaWxpbmcgaHlwaGVucywgcGVyaW9kcywgdW5kZXJzY29yZXMgYW5kIG90aGVyIGNvbW1vbiBzZXBhcmF0b3JzXG4gICAgc2FuaXRpemVkID0gc2FuaXRpemVkLnJlcGxhY2UoL1stXy5dKyQvZywgJycpO1xuICAgIFxuICAgIC8vIEVuc3VyZSB0aGUgZmlsZW5hbWUgaXNuJ3QgdG9vIGxvbmcgKG1heCAyNTUgY2hhcmFjdGVycylcbiAgICBpZiAoc2FuaXRpemVkLmxlbmd0aCA+IDI1NSkge1xuICAgICAgICBzYW5pdGl6ZWQgPSBzYW5pdGl6ZWQuc3Vic3RyaW5nKDAsIDI1MikgKyAnLi4uJztcbiAgICB9XG5cbiAgICAvLyBJZiB0aGUgc2FuaXRpemVkIHN0cmluZyBpcyBlbXB0eSBhZnRlciBhbGwgcHJvY2Vzc2luZywgdXNlIGEgZGVmYXVsdCBuYW1lXG4gICAgaWYgKCFzYW5pdGl6ZWQgfHwgL15cXHMqJC8udGVzdChzYW5pdGl6ZWQpKSB7XG4gICAgICAgIHNhbml0aXplZCA9ICd1bnRpdGxlZC1ub3RlJztcbiAgICB9XG5cbiAgICAvLyBFbnN1cmUgdGhlIGZpbGVuYW1lIGRvZXNuJ3Qgc3RhcnQgd2l0aCBhIG51bWJlciAoT2JzaWRpYW4gcmVxdWlyZW1lbnQpXG4gICAgaWYgKC9eXFxkLy50ZXN0KHNhbml0aXplZCkpIHtcbiAgICAgICAgc2FuaXRpemVkID0gJ25vdGUtJyArIHNhbml0aXplZDtcbiAgICB9XG4gICAgXG4gICAgLy8gRmluYWwgY2hlY2sgZm9yIHRyYWlsaW5nIHNlcGFyYXRvcnMgdGhhdCBtaWdodCBoYXZlIGJlZW4gYWRkZWQgaW4gb3RoZXIgc3RlcHNcbiAgICBzYW5pdGl6ZWQgPSBzYW5pdGl6ZWQucmVwbGFjZSgvWy1fLl0rJC9nLCAnJyk7XG5cbiAgICByZXR1cm4gc2FuaXRpemVkO1xufSAiXX0=