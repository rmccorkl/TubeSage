import { requestUrl } from "obsidian";
import { getSafeErrorMessage } from "./error-utils";
import { getLogger } from "./logger";
import { requestBudgetMs, requestTimeoutMessage } from "./request-budget";

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

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'x-anthropic-api-key',
  'cookie'
]);

const SENSITIVE_QUERY_KEYS = new Set(['key', 'api_key', 'access_token', 'token']);

const redactUrlForLog = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    let mutated = false;
    for (const name of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(name.toLowerCase())) {
        parsed.searchParams.set(name, '[REDACTED]');
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
};

const redactHeadersForLog = (headers: Record<string, string>): Record<string, string> => {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return redacted;
};

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
 * The rejection an aborted request produces.
 *
 * `name` is "AbortError" because that is the only thing callers look at:
 * `openai@5.12.2` classifies by `err.name === 'AbortError'`
 * (internal/errors.js, isAbortError) and reports its own
 * APIConnectionTimeoutError only then — any other name and a timeout reaches
 * the user as an unexplained connection failure. A plain Error rather than a
 * DOMException, which is not guaranteed to exist in every runtime this
 * plugin is loaded into.
 */
function abortError(): Error {
  const error = new Error("The request was aborted before it completed.");
  error.name = "AbortError";
  return error;
}

/**
 * `requestUrl`, bounded (#15). It REJECTS while the underlying call dangles,
 * because `requestUrl` cannot be aborted: on desktop it resolves over a
 * one-shot Electron IPC channel with no renderer-side cancel, so the best
 * available is to stop waiting for it.
 *
 * That is safe here only because the abandoned work is one request whose
 * result nobody is left awaiting — the caller's catch runs, the pass rejects
 * before it reaches its vault write, and the late reply reaches nothing. It is
 * NOT safe at stage level, which is why #13 removed the budget there rather
 * than moving it.
 *
 * It also honours `signal` (#19 part 4). The shim used to accept one and
 * ignore it, which made it a dishonest `fetch` implementation and, once the
 * ChatOpenAI paths were wired through here, turned the OpenAI SDK's own
 * timeout into a dead letter — that SDK implements its timeout purely by
 * aborting the signal it hands to fetch. An abort is handled the same way
 * the budget is: reject, and let the uncancellable `requestUrl` run on
 * unheard. Whichever of the two fires first ends the wait; both firing is
 * harmless.
 *
 * Timers come from `window`, as everywhere else in this plugin, and this one
 * is NOT registered with the plugin (#15 review F7). On unload with requests
 * in flight, each leaves its timer armed for up to the rest of its budget —
 * one per in-flight request, ten minutes at worst. That is deliberate rather
 * than overlooked: the shim is a free function every provider and the
 * transcript extractor call, with no Plugin handle to `registerInterval`
 * with, and threading one through all of them to reclaim a bounded,
 * self-clearing timer would cost more than it saves. When such a timer does
 * fire it rejects into the abandoned call's own catch — which still exists,
 * so it is handled, not an unhandled rejection — and the runner is fenced by
 * then (`stopAll`), so nothing it says can reach a record, a surface or a
 * vault write. What it cannot do is outlive the process.
 */
async function requestWithBudget(options: RequestUrlOptions, signal?: AbortSignal | null): Promise<RequestUrlResponse> {
  const startedAt = Date.now();
  let timer: number | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // A caller that has already given up gets nothing sent on its behalf,
    // which is what `fetch` does and what the SDK's retry paths assume.
    if (signal?.aborted === true) {
      throw abortError();
    }
    // Read per request, so a budget changed in settings applies to the next
    // call rather than at the next restart.
    const budgetMs = requestBudgetMs();
    return await Promise.race([
      requestUrl(options),
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(requestTimeoutMessage(budgetMs)));
        }, budgetMs);
        if (signal !== undefined && signal !== null) {
          onAbort = (): void => { reject(abortError()); };
          signal.addEventListener("abort", onAbort);
        }
      }),
    ]);
  } finally {
    if (signal !== undefined && signal !== null && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    // Whichever side won, the timer goes: a settled request must not leave one
    // armed for the rest of the budget.
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    // Per-call timing, under debugLogging like every other line here. There is
    // no timing data anywhere in this repo, and the budget above should be
    // tuned from real runs rather than guessed at twice.
    logger.debug(`Request to ${redactUrlForLog(options.url)} took ${Date.now() - startedAt} ms`);
  }
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

    // Log the URL for debugging (redact credentials in query string)
    logger.debug(`Fetching URL: ${redactUrlForLog(url)}`);

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
          : init.body.buffer;
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

    // Execute the request (redact credentials before logging)
    logger.debug(`Sending request with options: ${JSON.stringify({
      url: redactUrlForLog(options.url),
      method: options.method,
      headers: redactHeadersForLog(options.headers)
    })}`);
    
    let res: RequestUrlResponse;
    try {
      logger.debug('About to call requestUrl...');
      logger.debug(`URL length: ${options.url.length} characters`);
      logger.debug(`URL starts with: ${redactUrlForLog(options.url).substring(0, 100)}...`);
      res = await requestWithBudget(options, init?.signal);
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
    
    // Enhanced logging for other error types (skip full-object dump — may contain
    // credentials echoed in request headers by some runtimes)
    if (isRecord(error)) {
      logger.error("Error properties:", Object.keys(error));
    }
    
    // For real network/connection errors, throw the original error
    // This allows the calling code to handle 403/429/etc. properly
    throw error;
  }
}
