/**
 * Sanitizes a string to be used as a filename by:
 * 1. Removing all non-alphanumeric characters (including emojis and special characters)
 * 2. Replacing spaces with hyphens
 * 3. Removing leading/trailing spaces and dots
 * 4. Ensuring the filename isn't too long
 * 5. Handling special cases for Obsidian
 */
export function sanitizeFilename(title: string): string {
    if (!title || title.trim() === '') {
        return 'untitled-note';  // Use a hyphenated default name
    }
    
    // First, normalize Unicode characters and remove anything non-alphanumeric
    let sanitized = title
        .normalize('NFD')                   // Decompose Unicode characters
        .replace(/[\u0300-\u036f]/g, '')    // Remove diacritics
        .replace(/[^\p{L}\p{N}\s-]/gu, '')  // Only allow letters, numbers, spaces and hyphens
        .replace(/\s+/g, '-')               // Replace spaces with hyphens
        .trim()                             // Remove leading/trailing spaces
        .replace(/^\.+|-+\.+$/g, '')        // Remove leading/trailing dots and hyphens
        .replace(/^\.*$/g, 'untitled')      // Replace dot-only filenames 
        .replace(/^\/*$/g, 'untitled')      // Replace slash-only filenames
        .replace(/-+/g, '-');               // Replace multiple hyphens with a single hyphen
    
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