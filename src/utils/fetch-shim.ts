import { requestUrl } from "obsidian";
import { getSafeErrorMessage } from "./error-utils";
import { getLogger } from "./logger";

// Get logger for fetch shim
const logger = getLogger('FETCH');

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

// Define the response type based on what requestUrl actually returns
interface RequestUrlResponse {
  status: number;
  text: string;
  json?: unknown;
  headers: Record<string, string>;
  arrayBuffer?: ArrayBuffer;
}

interface RequestUrlOptions {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  throw?: boolean;
  arrayBuffer?: ArrayBuffer | ArrayBufferLike;
}

const normalizeHeaders = (headers?: HeadersInit): Record<string, string> => {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }

  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = String(value);
    return acc;
  }, {});
};

/**
 * A fetch API implementation that uses Obsidian's requestUrl method.
 * This allows us to make HTTP requests that work on both desktop and mobile.
 * 
 * @param input URL or Request object
 * @param init Request options
 * @returns A standard Response object
 */
export async function obsidianFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  try {
    // Extract URL using a more robust approach
    let url: string;
    
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else if (input && typeof input === "object" && 'url' in input) {
      // Handle Request objects
      url = String(input.url);
    } else {
      // Final fallback
      url = String(input);
    }

    // Log the URL for debugging
    logger.debug(`Fetching URL: ${url}`);

    // Sanitize and validate the URL
    try {
      // This will throw if the URL is invalid
      const parsedUrl = new URL(url);
      
      // Ensure protocol is http or https
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Invalid protocol: ${parsedUrl.protocol}`);
      }
      
      // Use the validated and normalized URL
      url = parsedUrl.toString();
    } catch (e) {
      logger.error(`Invalid URL: ${url}`, e);
      throw new TypeError(`Invalid URL: ${url}`);
    }

    // Convert fetch API options to requestUrl format
    const options: RequestUrlOptions = {
      url: url,
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      throw: false, // Handle errors manually for better mapping to fetch API
    };

    // Handle different body types
    if (init?.body) {
      if (typeof init.body === "string") {
        options.body = init.body;
      } else if (init.body instanceof FormData) {
        // Handle FormData
        const formData = init.body;
        const boundary = `----FormBoundary${Math.random().toString(36).substring(2)}`;
        let formBody = '';
        
        formData.forEach((value, key) => {
          formBody += `--${boundary}\r\n`;
          formBody += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
          const valueString = typeof value === "string"
            ? value
            : value instanceof File
              ? value.name ?? "[file]"
              : "[binary]";
          formBody += `${valueString}\r\n`;
        });
        
        formBody += `--${boundary}--\r\n`;
        
        options.body = formBody;
        options.headers = {
          ...options.headers,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        };
      } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
        // Handle binary data
        options.arrayBuffer = init.body instanceof ArrayBuffer 
          ? init.body 
          : (init.body as ArrayBufferView).buffer;
      } else {
        // For objects, try to stringify to JSON
        try {
          options.body = JSON.stringify(init.body);
          
          // Set Content-Type if not already set
          if (!options.headers['Content-Type']) {
            options.headers['Content-Type'] = 'application/json';
          }
        } catch (e) {
          logger.error("Could not stringify request body:", e);
        }
      }
    }

    // Execute the request
    logger.debug(`Sending request with options: ${JSON.stringify({
      url: options.url,
      method: options.method,
      headers: options.headers
    })}`);
    
    let res: RequestUrlResponse;
    try {
      logger.debug('About to call requestUrl...');
      logger.debug(`URL length: ${options.url.length} characters`);
      logger.debug(`URL starts with: ${options.url.substring(0, 100)}...`);
      res = await requestUrl(options) as unknown as RequestUrlResponse;
      logger.debug(`requestUrl completed - Status: ${res?.status}, HasText: ${!!res?.text}`);
    } catch (requestError) {
      const requestErrorMessage = getSafeErrorMessage(requestError);
      const requestErrorRecord = isRecord(requestError) ? requestError : null;
      logger.error('requestUrl threw error:', requestError);
      logger.error('requestError type:', typeof requestError);
      logger.error('requestError message:', requestErrorMessage);
      logger.error('requestError status:', requestErrorRecord && typeof requestErrorRecord.status === 'number'
        ? requestErrorRecord.status
        : 'No status');
      logger.error('requestError instanceof Error:', requestError instanceof Error);
      logger.error('requestError name:', requestError instanceof Error ? requestError.name : 'Unknown');
      throw requestError; // Re-throw to be handled by outer catch
    }

    // Create a proper Response object
    const responseInit: ResponseInit = {
      status: res.status,
      statusText: res.status.toString(),
      headers: new Headers(res.headers || {})
    };

    // Handle different response types
    if (res.arrayBuffer) {
      return new Response(res.arrayBuffer, responseInit);
    } else {
      return new Response(res.text, responseInit);
    }
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error("Fetch shim error - Raw error:", error);
    logger.error("Error type:", typeof error);
    logger.error("Error is null/undefined:", error == null);
    
    if (error) {
      const errorMessage = getSafeErrorMessage(error);
      logger.error("Error message:", errorMessage || 'No message');
      logger.error("Error stack:", error instanceof Error && error.stack ? error.stack : 'No stack');
      try {
        logger.error("Error toString:", String(error) || 'Cannot convert to string');
      } catch {
        logger.error("Error toString:", 'Cannot convert to string');
      }
    }
    
    // Check if this is an HTTP error response from requestUrl
    if (isRecord(error) && typeof error.status === 'number') {
      // This is an HTTP error response, preserve the actual status code
      const status = error.status;
      const text = typeof error.text === 'string' ? error.text : '';
      const headers = isRecord(error.headers) ? (error.headers as Record<string, string>) : {};
      logger.error(`HTTP error response - Status: ${status}, Text: ${text.substring(0, 200)}`);
      
      return new Response(text || JSON.stringify({ error: `HTTP ${status}` }), {
        status,
        statusText: status.toString(),
        headers: new Headers(headers)
      });
    }
    
    // Enhanced logging for other error types
    if (isRecord(error)) {
      try {
        logger.error("Error properties:", Object.keys(error));
        logger.error("Full error object:", JSON.stringify(error, null, 2));
      } catch (e) {
        logger.error("Could not stringify error object:", e);
        logger.error("Error has circular references or other issues");
      }
    }
    
    // For real network/connection errors, throw the original error
    // This allows the calling code to handle 403/429/etc. properly
    throw error;
  }
}
