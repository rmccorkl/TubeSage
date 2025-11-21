import type { Vault } from 'obsidian';

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
export function normalizePath(path: string, removeLeadingSlash: boolean = true): string {
    if (!path) return '';
    
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
export async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
    if (!folderPath || folderPath.trim() === '') return;
    
    // Normalize the path first
    const normalizedPath = normalizePath(folderPath);
    
    try {
        await vault.createFolder(normalizedPath);
    } catch (error) {
        // Only ignore "already exists" errors
        if (!(error instanceof Error) || !error.message.includes("already exists")) {
            throw error;
        }
        // Folder already exists, which is fine
    }
}

/**
 * Joins path segments together, ensuring proper normalization
 * 
 * @param segments Path segments to join
 * @returns Joined path
 */
export function joinPaths(...segments: string[]): string {
    if (segments.length === 0) return '';
    
    // Filter out empty segments
    const filteredSegments = segments.filter(segment => segment != null && segment !== '');
    
    if (filteredSegments.length === 0) return '';
    
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
export function sanitizePathComponent(text: string): string {
    if (!text) return '';
    
    return text
        .replace(/[\\/:*?"<>|]/g, '-') // Replace problematic chars with dash
        .replace(/\s+/g, '-')          // Replace spaces with dash
        .replace(/-+/g, '-')           // Replace multiple dashes with single dash
        .trim();                        // Remove leading/trailing whitespace
}

/**
 * Gets the parent folder path of a given path
 * 
 * @param path The path to get the parent of
 * @returns The parent path
 */
export function getParentFolder(path: string): string {
    const normalized = normalizePath(path);
    const lastSlashIndex = normalized.lastIndexOf('/');
    
    if (lastSlashIndex === -1) {
        return ''; // No parent folder
    }
    
    return normalized.substring(0, lastSlashIndex);
} 
