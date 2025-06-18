import { __awaiter } from "tslib";
/**
 * Standardized path utilities for consistent folder and path management
 */
/**
 * Normalizes a path by:
 * 1. Trimming whitespace
 * 2. Optionally removing leading slash (default: true)
 * 3. Removing trailing slash
 *
 * @param path The path to normalize
 * @param removeLeadingSlash Whether to remove leading slash (default: true)
 * @returns Normalized path
 */
export function normalizePath(path, removeLeadingSlash = true) {
    if (!path)
        return '';
    let normalized = path.trim();
    // Remove leading slash if specified
    if (removeLeadingSlash && normalized.startsWith('/')) {
        normalized = normalized.substring(1);
    }
    // Remove trailing slash
    if (normalized.endsWith('/')) {
        normalized = normalized.substring(0, normalized.length - 1);
    }
    return normalized;
}
/**
 * Ensures a folder exists, creating it if necessary
 * Gracefully handles "already exists" errors
 *
 * @param vault Obsidian vault instance via app.vault
 * @param folderPath Path to ensure exists
 * @returns Promise resolving when complete
 */
export function ensureFolder(vault, folderPath) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (!folderPath || folderPath.trim() === '')
            return;
        // Normalize the path first
        const normalizedPath = normalizePath(folderPath);
        try {
            yield vault.createFolder(normalizedPath);
        }
        catch (error) {
            // Only ignore "already exists" errors
            if (!((_a = error.message) === null || _a === void 0 ? void 0 : _a.includes("already exists"))) {
                throw error;
            }
            // Folder already exists, which is fine
        }
    });
}
/**
 * Joins path segments together, ensuring proper normalization
 *
 * @param segments Path segments to join
 * @returns Joined path
 */
export function joinPaths(...segments) {
    if (segments.length === 0)
        return '';
    // Filter out empty segments
    const filteredSegments = segments.filter(segment => segment != null && segment !== '');
    if (filteredSegments.length === 0)
        return '';
    // Join with / and normalize
    return normalizePath(filteredSegments.join('/'));
}
/**
 * Sanitizes a string for use in file/folder paths
 * Removes characters that are problematic in file systems
 *
 * @param text Text to sanitize
 * @returns Sanitized text
 */
export function sanitizePathComponent(text) {
    if (!text)
        return '';
    return text
        .replace(/[\\/:*?"<>|]/g, '-') // Replace problematic chars with dash
        .replace(/\s+/g, '-') // Replace spaces with dash
        .replace(/-+/g, '-') // Replace multiple dashes with single dash
        .trim(); // Remove leading/trailing whitespace
}
/**
 * Gets the parent folder path of a given path
 *
 * @param path The path to get the parent of
 * @returns The parent path
 */
export function getParentFolder(path) {
    const normalized = normalizePath(path);
    const lastSlashIndex = normalized.lastIndexOf('/');
    if (lastSlashIndex === -1) {
        return ''; // No parent folder
    }
    return normalized.substring(0, lastSlashIndex);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC11dGlscy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBhdGgtdXRpbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUVBOztHQUVHO0FBRUg7Ozs7Ozs7OztHQVNHO0FBQ0gsTUFBTSxVQUFVLGFBQWEsQ0FBQyxJQUFZLEVBQUUscUJBQThCLElBQUk7SUFDMUUsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUVyQixJQUFJLFVBQVUsR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7SUFFN0Isb0NBQW9DO0lBQ3BDLElBQUksa0JBQWtCLElBQUksVUFBVSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ25ELFVBQVUsR0FBRyxVQUFVLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3pDLENBQUM7SUFFRCx3QkFBd0I7SUFDeEIsSUFBSSxVQUFVLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDM0IsVUFBVSxHQUFHLFVBQVUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLFVBQVUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUVELE9BQU8sVUFBVSxDQUFDO0FBQ3RCLENBQUM7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsTUFBTSxVQUFnQixZQUFZLENBQUMsS0FBVSxFQUFFLFVBQWtCOzs7UUFDN0QsSUFBSSxDQUFDLFVBQVUsSUFBSSxVQUFVLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZQUFFLE9BQU87UUFFcEQsMkJBQTJCO1FBQzNCLE1BQU0sY0FBYyxHQUFHLGFBQWEsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUVqRCxJQUFJLENBQUM7WUFDRCxNQUFNLEtBQUssQ0FBQyxZQUFZLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDN0MsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDYixzQ0FBc0M7WUFDdEMsSUFBSSxDQUFDLENBQUEsTUFBQSxLQUFLLENBQUMsT0FBTywwQ0FBRSxRQUFRLENBQUMsZ0JBQWdCLENBQUMsQ0FBQSxFQUFFLENBQUM7Z0JBQzdDLE1BQU0sS0FBSyxDQUFDO1lBQ2hCLENBQUM7WUFDRCx1Q0FBdUM7UUFDM0MsQ0FBQztJQUNMLENBQUM7Q0FBQTtBQUVEOzs7OztHQUtHO0FBQ0gsTUFBTSxVQUFVLFNBQVMsQ0FBQyxHQUFHLFFBQWtCO0lBQzNDLElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFFckMsNEJBQTRCO0lBQzVCLE1BQU0sZ0JBQWdCLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sSUFBSSxJQUFJLElBQUksT0FBTyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBRXZGLElBQUksZ0JBQWdCLENBQUMsTUFBTSxLQUFLLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUU3Qyw0QkFBNEI7SUFDNUIsT0FBTyxhQUFhLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDckQsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxJQUFZO0lBQzlDLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFFckIsT0FBTyxJQUFJO1NBQ04sT0FBTyxDQUFDLGVBQWUsRUFBRSxHQUFHLENBQUMsQ0FBQyxzQ0FBc0M7U0FDcEUsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBVSwyQkFBMkI7U0FDekQsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBVywyQ0FBMkM7U0FDekUsSUFBSSxFQUFFLENBQUMsQ0FBd0IscUNBQXFDO0FBQzdFLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQUMsSUFBWTtJQUN4QyxNQUFNLFVBQVUsR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdkMsTUFBTSxjQUFjLEdBQUcsVUFBVSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUVuRCxJQUFJLGNBQWMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sRUFBRSxDQUFDLENBQUMsbUJBQW1CO0lBQ2xDLENBQUM7SUFFRCxPQUFPLFVBQVUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLGNBQWMsQ0FBQyxDQUFDO0FBQ25ELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBcHAgfSBmcm9tICdvYnNpZGlhbic7XG5cbi8qKlxuICogU3RhbmRhcmRpemVkIHBhdGggdXRpbGl0aWVzIGZvciBjb25zaXN0ZW50IGZvbGRlciBhbmQgcGF0aCBtYW5hZ2VtZW50XG4gKi9cblxuLyoqXG4gKiBOb3JtYWxpemVzIGEgcGF0aCBieTpcbiAqIDEuIFRyaW1taW5nIHdoaXRlc3BhY2VcbiAqIDIuIE9wdGlvbmFsbHkgcmVtb3ZpbmcgbGVhZGluZyBzbGFzaCAoZGVmYXVsdDogdHJ1ZSlcbiAqIDMuIFJlbW92aW5nIHRyYWlsaW5nIHNsYXNoXG4gKiBcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIG5vcm1hbGl6ZVxuICogQHBhcmFtIHJlbW92ZUxlYWRpbmdTbGFzaCBXaGV0aGVyIHRvIHJlbW92ZSBsZWFkaW5nIHNsYXNoIChkZWZhdWx0OiB0cnVlKVxuICogQHJldHVybnMgTm9ybWFsaXplZCBwYXRoXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVQYXRoKHBhdGg6IHN0cmluZywgcmVtb3ZlTGVhZGluZ1NsYXNoOiBib29sZWFuID0gdHJ1ZSk6IHN0cmluZyB7XG4gICAgaWYgKCFwYXRoKSByZXR1cm4gJyc7XG4gICAgXG4gICAgbGV0IG5vcm1hbGl6ZWQgPSBwYXRoLnRyaW0oKTtcbiAgICBcbiAgICAvLyBSZW1vdmUgbGVhZGluZyBzbGFzaCBpZiBzcGVjaWZpZWRcbiAgICBpZiAocmVtb3ZlTGVhZGluZ1NsYXNoICYmIG5vcm1hbGl6ZWQuc3RhcnRzV2l0aCgnLycpKSB7XG4gICAgICAgIG5vcm1hbGl6ZWQgPSBub3JtYWxpemVkLnN1YnN0cmluZygxKTtcbiAgICB9XG4gICAgXG4gICAgLy8gUmVtb3ZlIHRyYWlsaW5nIHNsYXNoXG4gICAgaWYgKG5vcm1hbGl6ZWQuZW5kc1dpdGgoJy8nKSkge1xuICAgICAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zdWJzdHJpbmcoMCwgbm9ybWFsaXplZC5sZW5ndGggLSAxKTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbi8qKlxuICogRW5zdXJlcyBhIGZvbGRlciBleGlzdHMsIGNyZWF0aW5nIGl0IGlmIG5lY2Vzc2FyeVxuICogR3JhY2VmdWxseSBoYW5kbGVzIFwiYWxyZWFkeSBleGlzdHNcIiBlcnJvcnNcbiAqIFxuICogQHBhcmFtIHZhdWx0IE9ic2lkaWFuIHZhdWx0IGluc3RhbmNlIHZpYSBhcHAudmF1bHRcbiAqIEBwYXJhbSBmb2xkZXJQYXRoIFBhdGggdG8gZW5zdXJlIGV4aXN0c1xuICogQHJldHVybnMgUHJvbWlzZSByZXNvbHZpbmcgd2hlbiBjb21wbGV0ZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlRm9sZGVyKHZhdWx0OiBhbnksIGZvbGRlclBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghZm9sZGVyUGF0aCB8fCBmb2xkZXJQYXRoLnRyaW0oKSA9PT0gJycpIHJldHVybjtcbiAgICBcbiAgICAvLyBOb3JtYWxpemUgdGhlIHBhdGggZmlyc3RcbiAgICBjb25zdCBub3JtYWxpemVkUGF0aCA9IG5vcm1hbGl6ZVBhdGgoZm9sZGVyUGF0aCk7XG4gICAgXG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdmF1bHQuY3JlYXRlRm9sZGVyKG5vcm1hbGl6ZWRQYXRoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAvLyBPbmx5IGlnbm9yZSBcImFscmVhZHkgZXhpc3RzXCIgZXJyb3JzXG4gICAgICAgIGlmICghZXJyb3IubWVzc2FnZT8uaW5jbHVkZXMoXCJhbHJlYWR5IGV4aXN0c1wiKSkge1xuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRm9sZGVyIGFscmVhZHkgZXhpc3RzLCB3aGljaCBpcyBmaW5lXG4gICAgfVxufVxuXG4vKipcbiAqIEpvaW5zIHBhdGggc2VnbWVudHMgdG9nZXRoZXIsIGVuc3VyaW5nIHByb3BlciBub3JtYWxpemF0aW9uXG4gKiBcbiAqIEBwYXJhbSBzZWdtZW50cyBQYXRoIHNlZ21lbnRzIHRvIGpvaW5cbiAqIEByZXR1cm5zIEpvaW5lZCBwYXRoXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBqb2luUGF0aHMoLi4uc2VnbWVudHM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gJyc7XG4gICAgXG4gICAgLy8gRmlsdGVyIG91dCBlbXB0eSBzZWdtZW50c1xuICAgIGNvbnN0IGZpbHRlcmVkU2VnbWVudHMgPSBzZWdtZW50cy5maWx0ZXIoc2VnbWVudCA9PiBzZWdtZW50ICE9IG51bGwgJiYgc2VnbWVudCAhPT0gJycpO1xuICAgIFxuICAgIGlmIChmaWx0ZXJlZFNlZ21lbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICcnO1xuICAgIFxuICAgIC8vIEpvaW4gd2l0aCAvIGFuZCBub3JtYWxpemVcbiAgICByZXR1cm4gbm9ybWFsaXplUGF0aChmaWx0ZXJlZFNlZ21lbnRzLmpvaW4oJy8nKSk7XG59XG5cbi8qKlxuICogU2FuaXRpemVzIGEgc3RyaW5nIGZvciB1c2UgaW4gZmlsZS9mb2xkZXIgcGF0aHNcbiAqIFJlbW92ZXMgY2hhcmFjdGVycyB0aGF0IGFyZSBwcm9ibGVtYXRpYyBpbiBmaWxlIHN5c3RlbXNcbiAqIFxuICogQHBhcmFtIHRleHQgVGV4dCB0byBzYW5pdGl6ZVxuICogQHJldHVybnMgU2FuaXRpemVkIHRleHRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhbml0aXplUGF0aENvbXBvbmVudCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghdGV4dCkgcmV0dXJuICcnO1xuICAgIFxuICAgIHJldHVybiB0ZXh0XG4gICAgICAgIC5yZXBsYWNlKC9bXFxcXC86Kj9cIjw+fF0vZywgJy0nKSAvLyBSZXBsYWNlIHByb2JsZW1hdGljIGNoYXJzIHdpdGggZGFzaFxuICAgICAgICAucmVwbGFjZSgvXFxzKy9nLCAnLScpICAgICAgICAgIC8vIFJlcGxhY2Ugc3BhY2VzIHdpdGggZGFzaFxuICAgICAgICAucmVwbGFjZSgvLSsvZywgJy0nKSAgICAgICAgICAgLy8gUmVwbGFjZSBtdWx0aXBsZSBkYXNoZXMgd2l0aCBzaW5nbGUgZGFzaFxuICAgICAgICAudHJpbSgpOyAgICAgICAgICAgICAgICAgICAgICAgIC8vIFJlbW92ZSBsZWFkaW5nL3RyYWlsaW5nIHdoaXRlc3BhY2Vcbn1cblxuLyoqXG4gKiBHZXRzIHRoZSBwYXJlbnQgZm9sZGVyIHBhdGggb2YgYSBnaXZlbiBwYXRoXG4gKiBcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIGdldCB0aGUgcGFyZW50IG9mXG4gKiBAcmV0dXJucyBUaGUgcGFyZW50IHBhdGhcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFBhcmVudEZvbGRlcihwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHBhdGgpO1xuICAgIGNvbnN0IGxhc3RTbGFzaEluZGV4ID0gbm9ybWFsaXplZC5sYXN0SW5kZXhPZignLycpO1xuICAgIFxuICAgIGlmIChsYXN0U2xhc2hJbmRleCA9PT0gLTEpIHtcbiAgICAgICAgcmV0dXJuICcnOyAvLyBObyBwYXJlbnQgZm9sZGVyXG4gICAgfVxuICAgIFxuICAgIHJldHVybiBub3JtYWxpemVkLnN1YnN0cmluZygwLCBsYXN0U2xhc2hJbmRleCk7XG59ICJdfQ==