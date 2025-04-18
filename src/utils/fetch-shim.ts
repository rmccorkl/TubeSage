import { requestUrl } from "obsidian";
import { getLogger } from "./logger";

// Get logger for fetch shim
const logger = getLogger('FETCH');

// Define the response type based on what requestUrl actually returns
interface RequestUrlResponse {
  status: number;
  text: string;
  json?: any;
  headers: Record<string, string>;
  arrayBuffer?: ArrayBuffer;
}

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
    const options: any = {
      url: url,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string> || {},
      throw: false, // Handle errors manually for better mapping to fetch API
    };

    // Handle different body types
    if (init?.body) {
      if (typeof init.body === "string") {
        options.body = init.body;
      } else if (init.body instanceof FormData) {
        // Handle FormData
        const formData = init.body as FormData;
        const boundary = `----FormBoundary${Math.random().toString(36).substring(2)}`;
        let formBody = '';
        
        formData.forEach((value, key) => {
          formBody += `--${boundary}\r\n`;
          formBody += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
          formBody += `${value}\r\n`;
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
    
    const res = await requestUrl(options) as unknown as RequestUrlResponse;

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
    // Log error details
    logger.error("Fetch shim error:", error);
    
    // Return a standard error response
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Detect if the current platform is mobile Obsidian
 */
export function isPlatformMobile(): boolean {
  // @ts-ignore - app.isMobile exists but may not be in type definitions
  return (app as any).isMobile === true;
} 