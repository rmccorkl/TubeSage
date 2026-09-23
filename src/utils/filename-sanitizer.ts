/**
 * Sanitizes a string to be used as a filename by:
 * 1. Removing all non-alphanumeric, non-mark characters (including emojis and special characters),
 *    while keeping Latin diacritics stripped (café -> cafe) and non-Latin combining marks
 *    (e.g. Japanese voiced sound marks, Thai vowel signs) intact
 * 2. Replacing spaces with hyphens
 * 3. Removing leading/trailing spaces and dots
 * 4. Ensuring the filename isn't too long
 * 5. Handling special cases for Obsidian
 * 6. Recomposing to NFC so the result is already normalized like Obsidian's vault index
 */
export function sanitizeFilename(title: string): string {
    if (!title || title.trim() === '') {
        return 'untitled-note';  // Use a hyphenated default name
    }
    
    // First, normalize Unicode characters and remove anything non-alphanumeric
    let sanitized = title
        .normalize('NFD')                   // Decompose Unicode characters
        .replace(/[\u0300-\u036f]/g, '')    // Remove Latin diacritics (while decomposed)
        .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')  // Only allow letters, numbers, marks, spaces and hyphens
        .replace(/\s+/g, '-')               // Replace spaces with hyphens
        .trim()                             // Remove leading/trailing spaces
        .replace(/^\.+|-+\.+$/g, '')        // Remove leading/trailing dots and hyphens
        .replace(/-+/g, '-');               // Replace multiple hyphens with a single hyphen
    
    // Remove trailing hyphens, periods, underscores and other common separators
    sanitized = sanitized.replace(/[-_.]+$/g, '');

    // If the sanitized string is empty after all processing, use a default name.
    // This is the ONLY empty-input default: a title made entirely of characters
    // the filter drops ('...', '///', '###') reaches here as '' and takes it,
    // exactly as a genuinely empty title does. Two earlier `.replace()` calls
    // used to substitute 'untitled' for dot-only and slash-only input, which
    // made those cases disagree with every other fully-stripped title for no
    // reason a caller could predict — and they ran after the character filter
    // had already deleted every dot and slash, so they only ever matched the
    // empty string anyway.
    if (!sanitized || /^\s*$/.test(sanitized)) {
        sanitized = 'untitled-note';
    }

    // Ensure the filename doesn't start with a number (Obsidian requirement)
    if (/^\d/.test(sanitized)) {
        sanitized = 'note-' + sanitized;
    }

    // Cap the length LAST, after the `note-` prefix, so the prefix cannot push
    // the name back over the limit — applied before it, a 300-character title
    // beginning with a digit came out at 257.
    //
    // Truncated cleanly, with no ellipsis. An ellipsis would be three trailing
    // dots, the very class the strip below removes deliberately: Windows drops
    // trailing dots from a filename, so a name ending in '...' is not the name
    // that reaches disk. The cap is the requirement; the marker was decoration
    // that never survived anyway.
    if (sanitized.length > 255) {
        sanitized = sanitized.substring(0, 255);
    }

    // Final check for trailing separators that might have been added in other
    // steps, or exposed by the truncation above.
    sanitized = sanitized.replace(/[-_.]+$/g, '');

    // Recompose combining marks kept above (e.g. Japanese voiced sound marks,
    // Hangul jamo) back into their precomposed form, so the sanitizer's own
    // output is already NFC — matching Obsidian's NFC-normalized vault index.
    return sanitized.normalize('NFC');
} 