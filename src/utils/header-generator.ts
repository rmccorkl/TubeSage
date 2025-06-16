/**
 * YouTube-optimized header generation with randomization
 * Provides realistic browser headers that help avoid bot detection
 */

import { getLogger } from './logger';

const headerLogger = getLogger('HEADERS');

// Arrays for header randomization
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

const ACCEPT_LANGUAGES = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.8',
    'en-US,en;q=0.9,es;q=0.8',
    'en-US,en;q=0.7,es;q=0.3'
];

// Cache randomized headers for session consistency
let cachedPageHeaders: Record<string, string> | null = null;
let cachedCaptionHeaders: Record<string, string> | null = null;
let lastGenerated = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Get random element from array
 */
function getRandom<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
}

/**
 * Generate YouTube-optimized headers for main page requests
 * @param forceRefresh Force generation of new headers
 * @returns HTTP headers object
 */
export function generatePageHeaders(forceRefresh = false): Record<string, string> {
    const now = Date.now();
    
    // Use cached headers if still valid and not forcing refresh
    if (!forceRefresh && cachedPageHeaders && (now - lastGenerated) < CACHE_DURATION) {
        headerLogger.debug('Using cached page headers');
        return { ...cachedPageHeaders };
    }
    
    // Generate randomized headers
    const userAgent = getRandom(USER_AGENTS);
    const acceptLanguage = getRandom(ACCEPT_LANGUAGES);
    
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    };
    
    // Cache the generated headers
    cachedPageHeaders = { ...headers };
    lastGenerated = now;
    
    headerLogger.debug(`Generated fresh page headers with UA: ${userAgent}`);
    return headers;
}

/**
 * Generate YouTube-optimized headers for caption requests
 * @param referer The referer URL (watch page)
 * @param forceRefresh Force generation of new headers
 * @returns HTTP headers object
 */
export function generateCaptionHeaders(referer: string, forceRefresh = false): Record<string, string> {
    const now = Date.now();
    
    // Use cached headers if still valid and not forcing refresh
    if (!forceRefresh && cachedCaptionHeaders && (now - lastGenerated) < CACHE_DURATION) {
        const headers = { ...cachedCaptionHeaders, 'Referer': referer };
        headerLogger.debug('Using cached caption headers');
        return headers;
    }
    
    // Generate randomized headers for captions
    const userAgent = getRandom(USER_AGENTS);
    const acceptLanguage = getRandom(ACCEPT_LANGUAGES);
    
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept': 'application/xml,text/xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'Referer': referer
    };
    
    // Cache caption headers (without referer for reuse)
    const { Referer, ...cacheableHeaders } = headers;
    cachedCaptionHeaders = { ...cacheableHeaders };
    
    headerLogger.debug(`Generated fresh caption headers with UA: ${userAgent}`);
    return headers;
}

/**
 * Force refresh of cached headers (useful when requests start failing)
 */
export function refreshHeaders(): void {
    cachedPageHeaders = null;
    cachedCaptionHeaders = null;
    lastGenerated = 0;
    headerLogger.debug('Forced refresh of cached headers');
}

/**
 * Get header cache status for debugging
 */
export function getHeaderCacheStatus(): { hasPageHeaders: boolean; hasCaptionHeaders: boolean; age: number } {
    return {
        hasPageHeaders: !!cachedPageHeaders,
        hasCaptionHeaders: !!cachedCaptionHeaders,
        age: Date.now() - lastGenerated
    };
}