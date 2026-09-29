import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('LANGCHAIN_FETCHER');

/**
 * Custom fetcher for LangChain that uses our Obsidian fetch shim
 * This makes LangChain models work on both desktop and mobile Obsidian
 */
function createLangChainFetcher() {
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
 * Configuration object for LangChain models that includes our custom fetcher.
 *
 * WHICH MODELS ACTUALLY TAKE IT: `fetch` is returned at the TOP level, which
 * ChatOllama reads (@langchain/ollama chat_models.cjs:545) and ChatOpenAI
 * does not — it builds its client from
 * `{apiKey, organization, dangerouslyAllowBrowser, ...fields.configuration}`
 * (@langchain/openai@0.6.17 chat_models.cjs:625-630), so a top-level `fetch`
 * never reaches the OpenAI SDK and both the OpenAI and OpenRouter paths run
 * on the SDK's own transport. They are not unbounded — `openai@5.12.2`
 * applies its own DEFAULT_TIMEOUT of 600000 ms with `maxRetries: 0` — but
 * they are not on the shim, so they get neither obsidianFetch's mobile
 * transport nor its budget (#15, #19). Moving them means putting `fetch`
 * inside `configuration`, which changes headers, error shapes and the mobile
 * path for the most-used provider: #19, not a change to make in passing.
 */
export function getLangChainConfiguration(options: Record<string, unknown> = {}) {
  return {
    ...options,
    fetch: createLangChainFetcher()
  };
}
