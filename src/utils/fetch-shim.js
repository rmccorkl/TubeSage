import { __awaiter } from "tslib";
import { requestUrl } from "obsidian";
import { getLogger } from "./logger";
// Get logger for fetch shim
const logger = getLogger('FETCH');
/**
 * A fetch API implementation that uses Obsidian's requestUrl method.
 * This allows us to make HTTP requests that work on both desktop and mobile.
 *
 * @param input URL or Request object
 * @param init Request options
 * @returns A standard Response object
 */
export function obsidianFetch(input, init) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        try {
            // Extract URL using a more robust approach
            let url;
            if (typeof input === "string") {
                url = input;
            }
            else if (input instanceof URL) {
                url = input.toString();
            }
            else if (input && typeof input === "object" && 'url' in input) {
                // Handle Request objects
                url = String(input.url);
            }
            else {
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
            }
            catch (e) {
                logger.error(`Invalid URL: ${url}`, e);
                throw new TypeError(`Invalid URL: ${url}`);
            }
            // Convert fetch API options to requestUrl format
            const options = {
                url: url,
                method: (_a = init === null || init === void 0 ? void 0 : init.method) !== null && _a !== void 0 ? _a : "GET",
                headers: (init === null || init === void 0 ? void 0 : init.headers) || {},
                throw: false, // Handle errors manually for better mapping to fetch API
            };
            // Handle different body types
            if (init === null || init === void 0 ? void 0 : init.body) {
                if (typeof init.body === "string") {
                    options.body = init.body;
                }
                else if (init.body instanceof FormData) {
                    // Handle FormData
                    const formData = init.body;
                    const boundary = `----FormBoundary${Math.random().toString(36).substring(2)}`;
                    let formBody = '';
                    formData.forEach((value, key) => {
                        formBody += `--${boundary}\r\n`;
                        formBody += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
                        formBody += `${value}\r\n`;
                    });
                    formBody += `--${boundary}--\r\n`;
                    options.body = formBody;
                    options.headers = Object.assign(Object.assign({}, options.headers), { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
                }
                else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
                    // Handle binary data
                    options.arrayBuffer = init.body instanceof ArrayBuffer
                        ? init.body
                        : init.body.buffer;
                }
                else {
                    // For objects, try to stringify to JSON
                    try {
                        options.body = JSON.stringify(init.body);
                        // Set Content-Type if not already set
                        if (!options.headers['Content-Type']) {
                            options.headers['Content-Type'] = 'application/json';
                        }
                    }
                    catch (e) {
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
            let res;
            try {
                logger.debug('About to call requestUrl...');
                logger.debug(`URL length: ${options.url.length} characters`);
                logger.debug(`URL starts with: ${options.url.substring(0, 100)}...`);
                res = (yield requestUrl(options));
                logger.debug(`requestUrl completed - Status: ${res === null || res === void 0 ? void 0 : res.status}, HasText: ${!!(res === null || res === void 0 ? void 0 : res.text)}`);
            }
            catch (requestError) {
                logger.error('requestUrl threw error:', requestError);
                logger.error('requestError type:', typeof requestError);
                logger.error('requestError message:', requestError === null || requestError === void 0 ? void 0 : requestError.message);
                logger.error('requestError status:', requestError === null || requestError === void 0 ? void 0 : requestError.status);
                logger.error('requestError instanceof Error:', requestError instanceof Error);
                logger.error('requestError constructor:', (_b = requestError === null || requestError === void 0 ? void 0 : requestError.constructor) === null || _b === void 0 ? void 0 : _b.name);
                throw requestError; // Re-throw to be handled by outer catch
            }
            // Create a proper Response object
            const responseInit = {
                status: res.status,
                statusText: res.status.toString(),
                headers: new Headers(res.headers || {})
            };
            // Handle different response types
            if (res.arrayBuffer) {
                return new Response(res.arrayBuffer, responseInit);
            }
            else {
                return new Response(res.text, responseInit);
            }
        }
        catch (error) {
            // Enhanced error logging for debugging
            logger.error("Fetch shim error - Raw error:", error);
            logger.error("Error type:", typeof error);
            logger.error("Error is null/undefined:", error == null);
            if (error) {
                logger.error("Error message:", (error === null || error === void 0 ? void 0 : error.message) || 'No message');
                logger.error("Error stack:", (error === null || error === void 0 ? void 0 : error.stack) || 'No stack');
                logger.error("Error toString:", (error === null || error === void 0 ? void 0 : error.toString()) || 'Cannot convert to string');
            }
            // Check if this is an HTTP error response from requestUrl
            if (error && typeof error === 'object' && 'status' in error) {
                // This is an HTTP error response, preserve the actual status code
                const httpError = error;
                logger.error(`HTTP error response - Status: ${httpError.status}, Text: ${(_c = httpError.text) === null || _c === void 0 ? void 0 : _c.substring(0, 200)}`);
                return new Response(httpError.text || JSON.stringify({ error: `HTTP ${httpError.status}` }), {
                    status: httpError.status,
                    statusText: httpError.status.toString(),
                    headers: new Headers(httpError.headers || {})
                });
            }
            // Enhanced logging for other error types
            if (error && typeof error === 'object') {
                try {
                    logger.error("Error properties:", Object.keys(error));
                    logger.error("Full error object:", JSON.stringify(error, null, 2));
                }
                catch (e) {
                    logger.error("Could not stringify error object:", e);
                    logger.error("Error has circular references or other issues");
                }
            }
            // For real network/connection errors, throw the original error
            // This allows the calling code to handle 403/429/etc. properly
            throw error;
        }
    });
}
/**
 * Detect if the current platform is mobile Obsidian
 */
export function isPlatformMobile() {
    var _a;
    // Use Platform.isMobileApp (official Obsidian API) when available
    // TypeScript may not recognize it due to outdated type definitions
    if (typeof window !== "undefined") {
        const Platform = window.Platform;
        if (Platform && typeof Platform.isMobileApp === 'boolean') {
            return Platform.isMobileApp;
        }
        // Fallback for compatibility
        return typeof window.app !== "undefined" &&
            ((_a = window.app) === null || _a === void 0 ? void 0 : _a.isMobile) === true;
    }
    return false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmV0Y2gtc2hpbS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImZldGNoLXNoaW0udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDdEMsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLFVBQVUsQ0FBQztBQUVyQyw0QkFBNEI7QUFDNUIsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBV2xDOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLFVBQWdCLGFBQWEsQ0FBQyxLQUFrQixFQUFFLElBQWtCOzs7UUFDeEUsSUFBSSxDQUFDO1lBQ0gsMkNBQTJDO1lBQzNDLElBQUksR0FBVyxDQUFDO1lBRWhCLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQzlCLEdBQUcsR0FBRyxLQUFLLENBQUM7WUFDZCxDQUFDO2lCQUFNLElBQUksS0FBSyxZQUFZLEdBQUcsRUFBRSxDQUFDO2dCQUNoQyxHQUFHLEdBQUcsS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ3pCLENBQUM7aUJBQU0sSUFBSSxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssSUFBSSxLQUFLLEVBQUUsQ0FBQztnQkFDaEUseUJBQXlCO2dCQUN6QixHQUFHLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUMxQixDQUFDO2lCQUFNLENBQUM7Z0JBQ04saUJBQWlCO2dCQUNqQixHQUFHLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3RCLENBQUM7WUFFRCw0QkFBNEI7WUFDNUIsTUFBTSxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsR0FBRyxFQUFFLENBQUMsQ0FBQztZQUVyQyxnQ0FBZ0M7WUFDaEMsSUFBSSxDQUFDO2dCQUNILHdDQUF3QztnQkFDeEMsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBRS9CLG1DQUFtQztnQkFDbkMsSUFBSSxTQUFTLENBQUMsUUFBUSxLQUFLLE9BQU8sSUFBSSxTQUFTLENBQUMsUUFBUSxLQUFLLFFBQVEsRUFBRSxDQUFDO29CQUN0RSxNQUFNLElBQUksS0FBSyxDQUFDLHFCQUFxQixTQUFTLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztnQkFDN0QsQ0FBQztnQkFFRCx1Q0FBdUM7Z0JBQ3ZDLEdBQUcsR0FBRyxTQUFTLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDN0IsQ0FBQztZQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ1gsTUFBTSxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsR0FBRyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7Z0JBQ3ZDLE1BQU0sSUFBSSxTQUFTLENBQUMsZ0JBQWdCLEdBQUcsRUFBRSxDQUFDLENBQUM7WUFDN0MsQ0FBQztZQUVELGlEQUFpRDtZQUNqRCxNQUFNLE9BQU8sR0FBUTtnQkFDbkIsR0FBRyxFQUFFLEdBQUc7Z0JBQ1IsTUFBTSxFQUFFLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE1BQU0sbUNBQUksS0FBSztnQkFDN0IsT0FBTyxFQUFFLENBQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE9BQWlDLEtBQUksRUFBRTtnQkFDdEQsS0FBSyxFQUFFLEtBQUssRUFBRSx5REFBeUQ7YUFDeEUsQ0FBQztZQUVGLDhCQUE4QjtZQUM5QixJQUFJLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxJQUFJLEVBQUUsQ0FBQztnQkFDZixJQUFJLE9BQU8sSUFBSSxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDbEMsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO2dCQUMzQixDQUFDO3FCQUFNLElBQUksSUFBSSxDQUFDLElBQUksWUFBWSxRQUFRLEVBQUUsQ0FBQztvQkFDekMsa0JBQWtCO29CQUNsQixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsSUFBZ0IsQ0FBQztvQkFDdkMsTUFBTSxRQUFRLEdBQUcsbUJBQW1CLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7b0JBQzlFLElBQUksUUFBUSxHQUFHLEVBQUUsQ0FBQztvQkFFbEIsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsRUFBRTt3QkFDOUIsUUFBUSxJQUFJLEtBQUssUUFBUSxNQUFNLENBQUM7d0JBQ2hDLFFBQVEsSUFBSSx5Q0FBeUMsR0FBRyxXQUFXLENBQUM7d0JBQ3BFLFFBQVEsSUFBSSxHQUFHLEtBQUssTUFBTSxDQUFDO29CQUM3QixDQUFDLENBQUMsQ0FBQztvQkFFSCxRQUFRLElBQUksS0FBSyxRQUFRLFFBQVEsQ0FBQztvQkFFbEMsT0FBTyxDQUFDLElBQUksR0FBRyxRQUFRLENBQUM7b0JBQ3hCLE9BQU8sQ0FBQyxPQUFPLG1DQUNWLE9BQU8sQ0FBQyxPQUFPLEtBQ2xCLGNBQWMsRUFBRSxpQ0FBaUMsUUFBUSxFQUFFLEdBQzVELENBQUM7Z0JBQ0osQ0FBQztxQkFBTSxJQUFJLElBQUksQ0FBQyxJQUFJLFlBQVksV0FBVyxJQUFJLFdBQVcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7b0JBQzdFLHFCQUFxQjtvQkFDckIsT0FBTyxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxZQUFZLFdBQVc7d0JBQ3BELENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSTt3QkFDWCxDQUFDLENBQUUsSUFBSSxDQUFDLElBQXdCLENBQUMsTUFBTSxDQUFDO2dCQUM1QyxDQUFDO3FCQUFNLENBQUM7b0JBQ04sd0NBQXdDO29CQUN4QyxJQUFJLENBQUM7d0JBQ0gsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQzt3QkFFekMsc0NBQXNDO3dCQUN0QyxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUMsRUFBRSxDQUFDOzRCQUNyQyxPQUFPLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxHQUFHLGtCQUFrQixDQUFDO3dCQUN2RCxDQUFDO29CQUNILENBQUM7b0JBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQzt3QkFDWCxNQUFNLENBQUMsS0FBSyxDQUFDLG1DQUFtQyxFQUFFLENBQUMsQ0FBQyxDQUFDO29CQUN2RCxDQUFDO2dCQUNILENBQUM7WUFDSCxDQUFDO1lBRUQsc0JBQXNCO1lBQ3RCLE1BQU0sQ0FBQyxLQUFLLENBQUMsaUNBQWlDLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQzNELEdBQUcsRUFBRSxPQUFPLENBQUMsR0FBRztnQkFDaEIsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNO2dCQUN0QixPQUFPLEVBQUUsT0FBTyxDQUFDLE9BQU87YUFDekIsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUVOLElBQUksR0FBdUIsQ0FBQztZQUM1QixJQUFJLENBQUM7Z0JBQ0gsTUFBTSxDQUFDLEtBQUssQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO2dCQUM1QyxNQUFNLENBQUMsS0FBSyxDQUFDLGVBQWUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLGFBQWEsQ0FBQyxDQUFDO2dCQUM3RCxNQUFNLENBQUMsS0FBSyxDQUFDLG9CQUFvQixPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUNyRSxHQUFHLElBQUcsTUFBTSxVQUFVLENBQUMsT0FBTyxDQUFrQyxDQUFBLENBQUM7Z0JBQ2pFLE1BQU0sQ0FBQyxLQUFLLENBQUMsa0NBQWtDLEdBQUcsYUFBSCxHQUFHLHVCQUFILEdBQUcsQ0FBRSxNQUFNLGNBQWMsQ0FBQyxDQUFDLENBQUEsR0FBRyxhQUFILEdBQUcsdUJBQUgsR0FBRyxDQUFFLElBQUksQ0FBQSxFQUFFLENBQUMsQ0FBQztZQUN6RixDQUFDO1lBQUMsT0FBTyxZQUFZLEVBQUUsQ0FBQztnQkFDdEIsTUFBTSxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsRUFBRSxZQUFZLENBQUMsQ0FBQztnQkFDdEQsTUFBTSxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsRUFBRSxPQUFPLFlBQVksQ0FBQyxDQUFDO2dCQUN4RCxNQUFNLENBQUMsS0FBSyxDQUFDLHVCQUF1QixFQUFFLFlBQVksYUFBWixZQUFZLHVCQUFaLFlBQVksQ0FBRSxPQUFPLENBQUMsQ0FBQztnQkFDN0QsTUFBTSxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsRUFBRyxZQUFvQixhQUFwQixZQUFZLHVCQUFaLFlBQVksQ0FBVSxNQUFNLENBQUMsQ0FBQztnQkFDcEUsTUFBTSxDQUFDLEtBQUssQ0FBQyxnQ0FBZ0MsRUFBRSxZQUFZLFlBQVksS0FBSyxDQUFDLENBQUM7Z0JBQzlFLE1BQU0sQ0FBQyxLQUFLLENBQUMsMkJBQTJCLEVBQUUsTUFBQSxZQUFZLGFBQVosWUFBWSx1QkFBWixZQUFZLENBQUUsV0FBVywwQ0FBRSxJQUFJLENBQUMsQ0FBQztnQkFDM0UsTUFBTSxZQUFZLENBQUMsQ0FBQyx3Q0FBd0M7WUFDOUQsQ0FBQztZQUVELGtDQUFrQztZQUNsQyxNQUFNLFlBQVksR0FBaUI7Z0JBQ2pDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTTtnQkFDbEIsVUFBVSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFO2dCQUNqQyxPQUFPLEVBQUUsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUM7YUFDeEMsQ0FBQztZQUVGLGtDQUFrQztZQUNsQyxJQUFJLEdBQUcsQ0FBQyxXQUFXLEVBQUUsQ0FBQztnQkFDcEIsT0FBTyxJQUFJLFFBQVEsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQ3JELENBQUM7aUJBQU0sQ0FBQztnQkFDTixPQUFPLElBQUksUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUMsQ0FBQztRQUNILENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2YsdUNBQXVDO1lBQ3ZDLE1BQU0sQ0FBQyxLQUFLLENBQUMsK0JBQStCLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDckQsTUFBTSxDQUFDLEtBQUssQ0FBQyxhQUFhLEVBQUUsT0FBTyxLQUFLLENBQUMsQ0FBQztZQUMxQyxNQUFNLENBQUMsS0FBSyxDQUFDLDBCQUEwQixFQUFFLEtBQUssSUFBSSxJQUFJLENBQUMsQ0FBQztZQUV4RCxJQUFJLEtBQUssRUFBRSxDQUFDO2dCQUNWLE1BQU0sQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsT0FBTyxLQUFJLFlBQVksQ0FBQyxDQUFDO2dCQUMvRCxNQUFNLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxLQUFLLEtBQUksVUFBVSxDQUFDLENBQUM7Z0JBQ3pELE1BQU0sQ0FBQyxLQUFLLENBQUMsaUJBQWlCLEVBQUUsQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsUUFBUSxFQUFFLEtBQUksMEJBQTBCLENBQUMsQ0FBQztZQUNuRixDQUFDO1lBRUQsMERBQTBEO1lBQzFELElBQUksS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxRQUFRLElBQUksS0FBSyxFQUFFLENBQUM7Z0JBQzVELGtFQUFrRTtnQkFDbEUsTUFBTSxTQUFTLEdBQUcsS0FBMkIsQ0FBQztnQkFDOUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxpQ0FBaUMsU0FBUyxDQUFDLE1BQU0sV0FBVyxNQUFBLFNBQVMsQ0FBQyxJQUFJLDBDQUFFLFNBQVMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUU5RyxPQUFPLElBQUksUUFBUSxDQUFDLFNBQVMsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxRQUFRLFNBQVMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLEVBQUU7b0JBQzNGLE1BQU0sRUFBRSxTQUFTLENBQUMsTUFBTTtvQkFDeEIsVUFBVSxFQUFFLFNBQVMsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFO29CQUN2QyxPQUFPLEVBQUUsSUFBSSxPQUFPLENBQUMsU0FBUyxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUM7aUJBQzlDLENBQUMsQ0FBQztZQUNMLENBQUM7WUFFRCx5Q0FBeUM7WUFDekMsSUFBSSxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ3ZDLElBQUksQ0FBQztvQkFDSCxNQUFNLENBQUMsS0FBSyxDQUFDLG1CQUFtQixFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztvQkFDdEQsTUFBTSxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDckUsQ0FBQztnQkFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO29CQUNYLE1BQU0sQ0FBQyxLQUFLLENBQUMsbUNBQW1DLEVBQUUsQ0FBQyxDQUFDLENBQUM7b0JBQ3JELE1BQU0sQ0FBQyxLQUFLLENBQUMsK0NBQStDLENBQUMsQ0FBQztnQkFDaEUsQ0FBQztZQUNILENBQUM7WUFFRCwrREFBK0Q7WUFDL0QsK0RBQStEO1lBQy9ELE1BQU0sS0FBSyxDQUFDO1FBQ2QsQ0FBQztJQUNILENBQUM7Q0FBQTtBQUVEOztHQUVHO0FBQ0gsTUFBTSxVQUFVLGdCQUFnQjs7SUFDNUIsa0VBQWtFO0lBQ2xFLG1FQUFtRTtJQUNuRSxJQUFJLE9BQU8sTUFBTSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ2hDLE1BQU0sUUFBUSxHQUFJLE1BQWMsQ0FBQyxRQUFRLENBQUM7UUFDMUMsSUFBSSxRQUFRLElBQUksT0FBTyxRQUFRLENBQUMsV0FBVyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3hELE9BQU8sUUFBUSxDQUFDLFdBQVcsQ0FBQztRQUNoQyxDQUFDO1FBRUQsNkJBQTZCO1FBQzdCLE9BQU8sT0FBUSxNQUEyQyxDQUFDLEdBQUcsS0FBSyxXQUFXO1lBQzFFLENBQUEsTUFBQyxNQUEyQyxDQUFDLEdBQUcsMENBQUUsUUFBUSxNQUFLLElBQUksQ0FBQztJQUM1RSxDQUFDO0lBRUQsT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVlc3RVcmwgfSBmcm9tIFwib2JzaWRpYW5cIjtcbmltcG9ydCB7IGdldExvZ2dlciB9IGZyb20gXCIuL2xvZ2dlclwiO1xuXG4vLyBHZXQgbG9nZ2VyIGZvciBmZXRjaCBzaGltXG5jb25zdCBsb2dnZXIgPSBnZXRMb2dnZXIoJ0ZFVENIJyk7XG5cbi8vIERlZmluZSB0aGUgcmVzcG9uc2UgdHlwZSBiYXNlZCBvbiB3aGF0IHJlcXVlc3RVcmwgYWN0dWFsbHkgcmV0dXJuc1xuaW50ZXJmYWNlIFJlcXVlc3RVcmxSZXNwb25zZSB7XG4gIHN0YXR1czogbnVtYmVyO1xuICB0ZXh0OiBzdHJpbmc7XG4gIGpzb24/OiBhbnk7XG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIGFycmF5QnVmZmVyPzogQXJyYXlCdWZmZXI7XG59XG5cbi8qKlxuICogQSBmZXRjaCBBUEkgaW1wbGVtZW50YXRpb24gdGhhdCB1c2VzIE9ic2lkaWFuJ3MgcmVxdWVzdFVybCBtZXRob2QuXG4gKiBUaGlzIGFsbG93cyB1cyB0byBtYWtlIEhUVFAgcmVxdWVzdHMgdGhhdCB3b3JrIG9uIGJvdGggZGVza3RvcCBhbmQgbW9iaWxlLlxuICogXG4gKiBAcGFyYW0gaW5wdXQgVVJMIG9yIFJlcXVlc3Qgb2JqZWN0XG4gKiBAcGFyYW0gaW5pdCBSZXF1ZXN0IG9wdGlvbnNcbiAqIEByZXR1cm5zIEEgc3RhbmRhcmQgUmVzcG9uc2Ugb2JqZWN0XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBvYnNpZGlhbkZldGNoKGlucHV0OiBSZXF1ZXN0SW5mbywgaW5pdD86IFJlcXVlc3RJbml0KTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICB0cnkge1xuICAgIC8vIEV4dHJhY3QgVVJMIHVzaW5nIGEgbW9yZSByb2J1c3QgYXBwcm9hY2hcbiAgICBsZXQgdXJsOiBzdHJpbmc7XG4gICAgXG4gICAgaWYgKHR5cGVvZiBpbnB1dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgdXJsID0gaW5wdXQ7XG4gICAgfSBlbHNlIGlmIChpbnB1dCBpbnN0YW5jZW9mIFVSTCkge1xuICAgICAgdXJsID0gaW5wdXQudG9TdHJpbmcoKTtcbiAgICB9IGVsc2UgaWYgKGlucHV0ICYmIHR5cGVvZiBpbnB1dCA9PT0gXCJvYmplY3RcIiAmJiAndXJsJyBpbiBpbnB1dCkge1xuICAgICAgLy8gSGFuZGxlIFJlcXVlc3Qgb2JqZWN0c1xuICAgICAgdXJsID0gU3RyaW5nKGlucHV0LnVybCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEZpbmFsIGZhbGxiYWNrXG4gICAgICB1cmwgPSBTdHJpbmcoaW5wdXQpO1xuICAgIH1cblxuICAgIC8vIExvZyB0aGUgVVJMIGZvciBkZWJ1Z2dpbmdcbiAgICBsb2dnZXIuZGVidWcoYEZldGNoaW5nIFVSTDogJHt1cmx9YCk7XG5cbiAgICAvLyBTYW5pdGl6ZSBhbmQgdmFsaWRhdGUgdGhlIFVSTFxuICAgIHRyeSB7XG4gICAgICAvLyBUaGlzIHdpbGwgdGhyb3cgaWYgdGhlIFVSTCBpcyBpbnZhbGlkXG4gICAgICBjb25zdCBwYXJzZWRVcmwgPSBuZXcgVVJMKHVybCk7XG4gICAgICBcbiAgICAgIC8vIEVuc3VyZSBwcm90b2NvbCBpcyBodHRwIG9yIGh0dHBzXG4gICAgICBpZiAocGFyc2VkVXJsLnByb3RvY29sICE9PSAnaHR0cDonICYmIHBhcnNlZFVybC5wcm90b2NvbCAhPT0gJ2h0dHBzOicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHByb3RvY29sOiAke3BhcnNlZFVybC5wcm90b2NvbH1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gVXNlIHRoZSB2YWxpZGF0ZWQgYW5kIG5vcm1hbGl6ZWQgVVJMXG4gICAgICB1cmwgPSBwYXJzZWRVcmwudG9TdHJpbmcoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoYEludmFsaWQgVVJMOiAke3VybH1gLCBlKTtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYEludmFsaWQgVVJMOiAke3VybH1gKTtcbiAgICB9XG5cbiAgICAvLyBDb252ZXJ0IGZldGNoIEFQSSBvcHRpb25zIHRvIHJlcXVlc3RVcmwgZm9ybWF0XG4gICAgY29uc3Qgb3B0aW9uczogYW55ID0ge1xuICAgICAgdXJsOiB1cmwsXG4gICAgICBtZXRob2Q6IGluaXQ/Lm1ldGhvZCA/PyBcIkdFVFwiLFxuICAgICAgaGVhZGVyczogaW5pdD8uaGVhZGVycyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHx8IHt9LFxuICAgICAgdGhyb3c6IGZhbHNlLCAvLyBIYW5kbGUgZXJyb3JzIG1hbnVhbGx5IGZvciBiZXR0ZXIgbWFwcGluZyB0byBmZXRjaCBBUElcbiAgICB9O1xuXG4gICAgLy8gSGFuZGxlIGRpZmZlcmVudCBib2R5IHR5cGVzXG4gICAgaWYgKGluaXQ/LmJvZHkpIHtcbiAgICAgIGlmICh0eXBlb2YgaW5pdC5ib2R5ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIG9wdGlvbnMuYm9keSA9IGluaXQuYm9keTtcbiAgICAgIH0gZWxzZSBpZiAoaW5pdC5ib2R5IGluc3RhbmNlb2YgRm9ybURhdGEpIHtcbiAgICAgICAgLy8gSGFuZGxlIEZvcm1EYXRhXG4gICAgICAgIGNvbnN0IGZvcm1EYXRhID0gaW5pdC5ib2R5IGFzIEZvcm1EYXRhO1xuICAgICAgICBjb25zdCBib3VuZGFyeSA9IGAtLS0tRm9ybUJvdW5kYXJ5JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoMil9YDtcbiAgICAgICAgbGV0IGZvcm1Cb2R5ID0gJyc7XG4gICAgICAgIFxuICAgICAgICBmb3JtRGF0YS5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgZm9ybUJvZHkgKz0gYC0tJHtib3VuZGFyeX1cXHJcXG5gO1xuICAgICAgICAgIGZvcm1Cb2R5ICs9IGBDb250ZW50LURpc3Bvc2l0aW9uOiBmb3JtLWRhdGE7IG5hbWU9XCIke2tleX1cIlxcclxcblxcclxcbmA7XG4gICAgICAgICAgZm9ybUJvZHkgKz0gYCR7dmFsdWV9XFxyXFxuYDtcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICBmb3JtQm9keSArPSBgLS0ke2JvdW5kYXJ5fS0tXFxyXFxuYDtcbiAgICAgICAgXG4gICAgICAgIG9wdGlvbnMuYm9keSA9IGZvcm1Cb2R5O1xuICAgICAgICBvcHRpb25zLmhlYWRlcnMgPSB7XG4gICAgICAgICAgLi4ub3B0aW9ucy5oZWFkZXJzLFxuICAgICAgICAgICdDb250ZW50LVR5cGUnOiBgbXVsdGlwYXJ0L2Zvcm0tZGF0YTsgYm91bmRhcnk9JHtib3VuZGFyeX1gXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKGluaXQuYm9keSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyIHx8IEFycmF5QnVmZmVyLmlzVmlldyhpbml0LmJvZHkpKSB7XG4gICAgICAgIC8vIEhhbmRsZSBiaW5hcnkgZGF0YVxuICAgICAgICBvcHRpb25zLmFycmF5QnVmZmVyID0gaW5pdC5ib2R5IGluc3RhbmNlb2YgQXJyYXlCdWZmZXIgXG4gICAgICAgICAgPyBpbml0LmJvZHkgXG4gICAgICAgICAgOiAoaW5pdC5ib2R5IGFzIEFycmF5QnVmZmVyVmlldykuYnVmZmVyO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gRm9yIG9iamVjdHMsIHRyeSB0byBzdHJpbmdpZnkgdG8gSlNPTlxuICAgICAgICB0cnkge1xuICAgICAgICAgIG9wdGlvbnMuYm9keSA9IEpTT04uc3RyaW5naWZ5KGluaXQuYm9keSk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gU2V0IENvbnRlbnQtVHlwZSBpZiBub3QgYWxyZWFkeSBzZXRcbiAgICAgICAgICBpZiAoIW9wdGlvbnMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10pIHtcbiAgICAgICAgICAgIG9wdGlvbnMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKFwiQ291bGQgbm90IHN0cmluZ2lmeSByZXF1ZXN0IGJvZHk6XCIsIGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRXhlY3V0ZSB0aGUgcmVxdWVzdFxuICAgIGxvZ2dlci5kZWJ1ZyhgU2VuZGluZyByZXF1ZXN0IHdpdGggb3B0aW9uczogJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICB1cmw6IG9wdGlvbnMudXJsLFxuICAgICAgbWV0aG9kOiBvcHRpb25zLm1ldGhvZCxcbiAgICAgIGhlYWRlcnM6IG9wdGlvbnMuaGVhZGVyc1xuICAgIH0pfWApO1xuICAgIFxuICAgIGxldCByZXM6IFJlcXVlc3RVcmxSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdBYm91dCB0byBjYWxsIHJlcXVlc3RVcmwuLi4nKTtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgVVJMIGxlbmd0aDogJHtvcHRpb25zLnVybC5sZW5ndGh9IGNoYXJhY3RlcnNgKTtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgVVJMIHN0YXJ0cyB3aXRoOiAke29wdGlvbnMudXJsLnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuICAgICAgcmVzID0gYXdhaXQgcmVxdWVzdFVybChvcHRpb25zKSBhcyB1bmtub3duIGFzIFJlcXVlc3RVcmxSZXNwb25zZTtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgcmVxdWVzdFVybCBjb21wbGV0ZWQgLSBTdGF0dXM6ICR7cmVzPy5zdGF0dXN9LCBIYXNUZXh0OiAkeyEhcmVzPy50ZXh0fWApO1xuICAgIH0gY2F0Y2ggKHJlcXVlc3RFcnJvcikge1xuICAgICAgbG9nZ2VyLmVycm9yKCdyZXF1ZXN0VXJsIHRocmV3IGVycm9yOicsIHJlcXVlc3RFcnJvcik7XG4gICAgICBsb2dnZXIuZXJyb3IoJ3JlcXVlc3RFcnJvciB0eXBlOicsIHR5cGVvZiByZXF1ZXN0RXJyb3IpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdyZXF1ZXN0RXJyb3IgbWVzc2FnZTonLCByZXF1ZXN0RXJyb3I/Lm1lc3NhZ2UpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdyZXF1ZXN0RXJyb3Igc3RhdHVzOicsIChyZXF1ZXN0RXJyb3IgYXMgYW55KT8uc3RhdHVzKTtcbiAgICAgIGxvZ2dlci5lcnJvcigncmVxdWVzdEVycm9yIGluc3RhbmNlb2YgRXJyb3I6JywgcmVxdWVzdEVycm9yIGluc3RhbmNlb2YgRXJyb3IpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdyZXF1ZXN0RXJyb3IgY29uc3RydWN0b3I6JywgcmVxdWVzdEVycm9yPy5jb25zdHJ1Y3Rvcj8ubmFtZSk7XG4gICAgICB0aHJvdyByZXF1ZXN0RXJyb3I7IC8vIFJlLXRocm93IHRvIGJlIGhhbmRsZWQgYnkgb3V0ZXIgY2F0Y2hcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgYSBwcm9wZXIgUmVzcG9uc2Ugb2JqZWN0XG4gICAgY29uc3QgcmVzcG9uc2VJbml0OiBSZXNwb25zZUluaXQgPSB7XG4gICAgICBzdGF0dXM6IHJlcy5zdGF0dXMsXG4gICAgICBzdGF0dXNUZXh0OiByZXMuc3RhdHVzLnRvU3RyaW5nKCksXG4gICAgICBoZWFkZXJzOiBuZXcgSGVhZGVycyhyZXMuaGVhZGVycyB8fCB7fSlcbiAgICB9O1xuXG4gICAgLy8gSGFuZGxlIGRpZmZlcmVudCByZXNwb25zZSB0eXBlc1xuICAgIGlmIChyZXMuYXJyYXlCdWZmZXIpIHtcbiAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UocmVzLmFycmF5QnVmZmVyLCByZXNwb25zZUluaXQpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKHJlcy50ZXh0LCByZXNwb25zZUluaXQpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBFbmhhbmNlZCBlcnJvciBsb2dnaW5nIGZvciBkZWJ1Z2dpbmdcbiAgICBsb2dnZXIuZXJyb3IoXCJGZXRjaCBzaGltIGVycm9yIC0gUmF3IGVycm9yOlwiLCBlcnJvcik7XG4gICAgbG9nZ2VyLmVycm9yKFwiRXJyb3IgdHlwZTpcIiwgdHlwZW9mIGVycm9yKTtcbiAgICBsb2dnZXIuZXJyb3IoXCJFcnJvciBpcyBudWxsL3VuZGVmaW5lZDpcIiwgZXJyb3IgPT0gbnVsbCk7XG4gICAgXG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoXCJFcnJvciBtZXNzYWdlOlwiLCBlcnJvcj8ubWVzc2FnZSB8fCAnTm8gbWVzc2FnZScpO1xuICAgICAgbG9nZ2VyLmVycm9yKFwiRXJyb3Igc3RhY2s6XCIsIGVycm9yPy5zdGFjayB8fCAnTm8gc3RhY2snKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcIkVycm9yIHRvU3RyaW5nOlwiLCBlcnJvcj8udG9TdHJpbmcoKSB8fCAnQ2Fubm90IGNvbnZlcnQgdG8gc3RyaW5nJyk7XG4gICAgfVxuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYW4gSFRUUCBlcnJvciByZXNwb25zZSBmcm9tIHJlcXVlc3RVcmxcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0JyAmJiAnc3RhdHVzJyBpbiBlcnJvcikge1xuICAgICAgLy8gVGhpcyBpcyBhbiBIVFRQIGVycm9yIHJlc3BvbnNlLCBwcmVzZXJ2ZSB0aGUgYWN0dWFsIHN0YXR1cyBjb2RlXG4gICAgICBjb25zdCBodHRwRXJyb3IgPSBlcnJvciBhcyBSZXF1ZXN0VXJsUmVzcG9uc2U7XG4gICAgICBsb2dnZXIuZXJyb3IoYEhUVFAgZXJyb3IgcmVzcG9uc2UgLSBTdGF0dXM6ICR7aHR0cEVycm9yLnN0YXR1c30sIFRleHQ6ICR7aHR0cEVycm9yLnRleHQ/LnN1YnN0cmluZygwLCAyMDApfWApO1xuICAgICAgXG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKGh0dHBFcnJvci50ZXh0IHx8IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGBIVFRQICR7aHR0cEVycm9yLnN0YXR1c31gIH0pLCB7XG4gICAgICAgIHN0YXR1czogaHR0cEVycm9yLnN0YXR1cyxcbiAgICAgICAgc3RhdHVzVGV4dDogaHR0cEVycm9yLnN0YXR1cy50b1N0cmluZygpLFxuICAgICAgICBoZWFkZXJzOiBuZXcgSGVhZGVycyhodHRwRXJyb3IuaGVhZGVycyB8fCB7fSlcbiAgICAgIH0pO1xuICAgIH1cbiAgICBcbiAgICAvLyBFbmhhbmNlZCBsb2dnaW5nIGZvciBvdGhlciBlcnJvciB0eXBlc1xuICAgIGlmIChlcnJvciAmJiB0eXBlb2YgZXJyb3IgPT09ICdvYmplY3QnKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoXCJFcnJvciBwcm9wZXJ0aWVzOlwiLCBPYmplY3Qua2V5cyhlcnJvcikpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoXCJGdWxsIGVycm9yIG9iamVjdDpcIiwgSlNPTi5zdHJpbmdpZnkoZXJyb3IsIG51bGwsIDIpKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFwiQ291bGQgbm90IHN0cmluZ2lmeSBlcnJvciBvYmplY3Q6XCIsIGUpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoXCJFcnJvciBoYXMgY2lyY3VsYXIgcmVmZXJlbmNlcyBvciBvdGhlciBpc3N1ZXNcIik7XG4gICAgICB9XG4gICAgfVxuICAgIFxuICAgIC8vIEZvciByZWFsIG5ldHdvcmsvY29ubmVjdGlvbiBlcnJvcnMsIHRocm93IHRoZSBvcmlnaW5hbCBlcnJvclxuICAgIC8vIFRoaXMgYWxsb3dzIHRoZSBjYWxsaW5nIGNvZGUgdG8gaGFuZGxlIDQwMy80MjkvZXRjLiBwcm9wZXJseVxuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKlxuICogRGV0ZWN0IGlmIHRoZSBjdXJyZW50IHBsYXRmb3JtIGlzIG1vYmlsZSBPYnNpZGlhblxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNQbGF0Zm9ybU1vYmlsZSgpOiBib29sZWFuIHtcbiAgICAvLyBVc2UgUGxhdGZvcm0uaXNNb2JpbGVBcHAgKG9mZmljaWFsIE9ic2lkaWFuIEFQSSkgd2hlbiBhdmFpbGFibGVcbiAgICAvLyBUeXBlU2NyaXB0IG1heSBub3QgcmVjb2duaXplIGl0IGR1ZSB0byBvdXRkYXRlZCB0eXBlIGRlZmluaXRpb25zXG4gICAgaWYgKHR5cGVvZiB3aW5kb3cgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICAgICAgY29uc3QgUGxhdGZvcm0gPSAod2luZG93IGFzIGFueSkuUGxhdGZvcm07XG4gICAgICAgIGlmIChQbGF0Zm9ybSAmJiB0eXBlb2YgUGxhdGZvcm0uaXNNb2JpbGVBcHAgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIFBsYXRmb3JtLmlzTW9iaWxlQXBwO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBGYWxsYmFjayBmb3IgY29tcGF0aWJpbGl0eVxuICAgICAgICByZXR1cm4gdHlwZW9mICh3aW5kb3cgYXMgeyBhcHA/OiB7IGlzTW9iaWxlPzogYm9vbGVhbiB9IH0pLmFwcCAhPT0gXCJ1bmRlZmluZWRcIiAmJlxuICAgICAgICAgICAgKHdpbmRvdyBhcyB7IGFwcD86IHsgaXNNb2JpbGU/OiBib29sZWFuIH0gfSkuYXBwPy5pc01vYmlsZSA9PT0gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIGZhbHNlO1xufSAiXX0=