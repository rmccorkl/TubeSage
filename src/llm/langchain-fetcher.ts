import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('LANGCHAIN_FETCHER');

/**
 * Custom fetcher for LangChain that uses our Obsidian fetch shim
 * This makes LangChain models work on both desktop and mobile Obsidian
 */
export function createLangChainFetcher() {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    try {
      // Ensure the URL is properly formatted
      let requestUrl: string;
      
      if (typeof url === 'string') {
        requestUrl = url;
      } else if (url instanceof URL) {
        requestUrl = url.toString();
      } else if (url instanceof Request) {
        requestUrl = url.url;
      } else {
        logger.error('Invalid URL type:', typeof url);
        throw new TypeError('Invalid URL type');
      }
      
      // Sanitize URL and check for API-specific issues
      try {
        const parsedUrl = new URL(requestUrl);
        
        // Ensure protocol is http or https
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error(`Invalid protocol: ${parsedUrl.protocol}`);
        }
        
        // Special case for OpenAI API - ensure we have a valid path 
        // (this was causing ERR_INVALID_ARGUMENT)
        if (parsedUrl.hostname.includes('openai.com')) {
          logger.debug('OpenAI API detected, ensuring valid path');
          
          // Fix common path errors
          if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
            throw new Error('Invalid OpenAI API path');
          }
          
          // Ensure API version is included
          if (!parsedUrl.pathname.includes('/v1/')) {
            throw new Error('OpenAI API requires /v1/ path');
          }
        }
        
        // Use the validated URL
        requestUrl = parsedUrl.toString();
      } catch (e) {
        logger.error(`Invalid URL: ${requestUrl}`, e);
        throw new TypeError(`Invalid URL: ${requestUrl}`);
      }
      
      // Log request for debugging
      logger.debug(`LangChain fetch: ${requestUrl}`);
      
      // Additional checks for common API issues
      if (init?.headers) {
        const headers = init.headers as Record<string, string>;
        
        // Check for missing content-type on POST requests
        if (init.method === 'POST' && init.body && !headers['Content-Type']) {
          logger.debug('Adding Content-Type header for POST request');
          headers['Content-Type'] = 'application/json';
        }
        
        // Log authorization header presence (not the value) for debugging
        logger.debug(`Authorization header present: ${!!headers['Authorization']}`);
      }
      
      // Use our obsidianFetch shim for the actual request
      return obsidianFetch(requestUrl, init);
    } catch (error) {
      logger.error("LangChain fetch error:", error);
      throw error;
    }
  };
}

/**
 * Configuration object for LangChain models that includes our custom fetcher
 */
export function getLangChainConfiguration(options: Record<string, unknown> = {}) {
  return {
    ...options,
    fetch: createLangChainFetcher()
  };
}
