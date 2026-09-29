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
 * The ChatOpenAI-shaped configuration: the shim goes INSIDE `configuration`.
 *
 * ChatOpenAI builds its client from
 * `{apiKey, organization, dangerouslyAllowBrowser, ...fields.configuration}`
 * (@langchain/openai@0.6.17 chat_models.cjs:625-630), so this is the only
 * position a `fetch` survives from. The top-level shape below is what
 * ChatOllama reads (@langchain/ollama chat_models.cjs:545); the two are
 * genuinely different and neither works in the other's place, which is how
 * OpenAI and OpenRouter spent several releases silently on globalThis.fetch.
 *
 * WHO OWNS THE REQUEST TIMEOUT, now that this is wired (#19 part 2 — read
 * this before assuming two bounds apply):
 *
 *   `openai@5.12.2` implements its timeout ONLY by aborting the signal it
 *   hands to fetch (client.js:324-332): it calls `controller.abort()` and
 *   waits for the fetch implementation to react. As of this commit the shim
 *   does not read `signal` at all, so that abort fires into nothing and the
 *   SDK's DEFAULT_TIMEOUT of 600000 ms is a dead letter on these two paths.
 *   It was the only thing bounding them before this change.
 *
 *   The effective bound on every one of the five provider paths is now OURS:
 *   `REQUEST_TIMEOUT_MS` / the request-budget setting (request-budget.ts).
 *   One number, one place — which is the point — but it means that raising
 *   the budget raises it for real, with nothing else underneath to catch a
 *   wedged request. Do not assume the SDK is still holding a net.
 */
export function getOpenAiConfiguration(
  options: { apiKey: string; configuration?: Record<string, unknown> },
): { apiKey: string; configuration: Record<string, unknown> } {
  return {
    apiKey: options.apiKey,
    configuration: {
      ...options.configuration,
      fetch: createLangChainFetcher(),
    },
  };
}

/**
 * Configuration object for LangChain models that includes our custom fetcher.
 *
 * WHICH MODELS TAKE THIS SHAPE: `fetch` is returned at the TOP level, which
 * is what ChatOllama reads (@langchain/ollama chat_models.cjs:545). ChatOpenAI
 * does NOT read it there, and used to be handed this shape — which is how
 * OpenAI and OpenRouter ran on globalThis.fetch until #19. Those two now use
 * `getOpenAiConfiguration` above; anything ChatOpenAI-backed must.
 */
export function getLangChainConfiguration(options: Record<string, unknown> = {}) {
  return {
    ...options,
    fetch: createLangChainFetcher()
  };
}
