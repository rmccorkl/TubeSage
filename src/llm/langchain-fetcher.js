import { __awaiter } from "tslib";
import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";
const logger = getLogger('LANGCHAIN_FETCHER');
/**
 * Custom fetcher for LangChain that uses our Obsidian fetch shim
 * This makes LangChain models work on both desktop and mobile Obsidian
 */
export function createLangChainFetcher() {
    return (url, init) => __awaiter(this, void 0, void 0, function* () {
        try {
            // Ensure the URL is properly formatted
            let requestUrl;
            if (typeof url === 'string') {
                requestUrl = url;
            }
            else if (url instanceof URL) {
                requestUrl = url.toString();
            }
            else if (url instanceof Request) {
                requestUrl = url.url;
            }
            else {
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
            }
            catch (e) {
                logger.error(`Invalid URL: ${requestUrl}`, e);
                throw new TypeError(`Invalid URL: ${requestUrl}`);
            }
            // Log request for debugging
            logger.debug(`LangChain fetch: ${requestUrl}`);
            // Additional checks for common API issues
            if (init === null || init === void 0 ? void 0 : init.headers) {
                const headers = init.headers;
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
        }
        catch (error) {
            logger.error("LangChain fetch error:", error);
            throw error;
        }
    });
}
/**
 * Configuration object for LangChain models that includes our custom fetcher
 */
export function getLangChainConfiguration(options = {}) {
    return Object.assign(Object.assign({}, options), { fetch: createLangChainFetcher() });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGFuZ2NoYWluLWZldGNoZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsYW5nY2hhaW4tZmV0Y2hlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUU1QyxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUMsbUJBQW1CLENBQUMsQ0FBQztBQUU5Qzs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsc0JBQXNCO0lBQ3BDLE9BQU8sQ0FBTyxHQUEyQixFQUFFLElBQWtCLEVBQXFCLEVBQUU7UUFDbEYsSUFBSSxDQUFDO1lBQ0gsdUNBQXVDO1lBQ3ZDLElBQUksVUFBa0IsQ0FBQztZQUV2QixJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO2dCQUM1QixVQUFVLEdBQUcsR0FBRyxDQUFDO1lBQ25CLENBQUM7aUJBQU0sSUFBSSxHQUFHLFlBQVksR0FBRyxFQUFFLENBQUM7Z0JBQzlCLFVBQVUsR0FBRyxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDOUIsQ0FBQztpQkFBTSxJQUFJLEdBQUcsWUFBWSxPQUFPLEVBQUUsQ0FBQztnQkFDbEMsVUFBVSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUM7WUFDdkIsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE1BQU0sQ0FBQyxLQUFLLENBQUMsbUJBQW1CLEVBQUUsT0FBTyxHQUFHLENBQUMsQ0FBQztnQkFDOUMsTUFBTSxJQUFJLFNBQVMsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1lBQzFDLENBQUM7WUFFRCxpREFBaUQ7WUFDakQsSUFBSSxDQUFDO2dCQUNILE1BQU0sU0FBUyxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUV0QyxtQ0FBbUM7Z0JBQ25DLElBQUksU0FBUyxDQUFDLFFBQVEsS0FBSyxPQUFPLElBQUksU0FBUyxDQUFDLFFBQVEsS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDdEUsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQkFBcUIsU0FBUyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7Z0JBQzdELENBQUM7Z0JBRUQsNkRBQTZEO2dCQUM3RCwwQ0FBMEM7Z0JBQzFDLElBQUksU0FBUyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQztvQkFDOUMsTUFBTSxDQUFDLEtBQUssQ0FBQywwQ0FBMEMsQ0FBQyxDQUFDO29CQUV6RCx5QkFBeUI7b0JBQ3pCLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxJQUFJLFNBQVMsQ0FBQyxRQUFRLEtBQUssR0FBRyxFQUFFLENBQUM7d0JBQ3RELE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztvQkFDN0MsQ0FBQztvQkFFRCxpQ0FBaUM7b0JBQ2pDLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO3dCQUN6QyxNQUFNLElBQUksS0FBSyxDQUFDLCtCQUErQixDQUFDLENBQUM7b0JBQ25ELENBQUM7Z0JBQ0gsQ0FBQztnQkFFRCx3QkFBd0I7Z0JBQ3hCLFVBQVUsR0FBRyxTQUFTLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDcEMsQ0FBQztZQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ1gsTUFBTSxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsVUFBVSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7Z0JBQzlDLE1BQU0sSUFBSSxTQUFTLENBQUMsZ0JBQWdCLFVBQVUsRUFBRSxDQUFDLENBQUM7WUFDcEQsQ0FBQztZQUVELDRCQUE0QjtZQUM1QixNQUFNLENBQUMsS0FBSyxDQUFDLG9CQUFvQixVQUFVLEVBQUUsQ0FBQyxDQUFDO1lBRS9DLDBDQUEwQztZQUMxQyxJQUFJLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxPQUFPLEVBQUUsQ0FBQztnQkFDbEIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLE9BQWlDLENBQUM7Z0JBRXZELGtEQUFrRDtnQkFDbEQsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLE1BQU0sSUFBSSxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxFQUFFLENBQUM7b0JBQ3BFLE1BQU0sQ0FBQyxLQUFLLENBQUMsNkNBQTZDLENBQUMsQ0FBQztvQkFDNUQsT0FBTyxDQUFDLGNBQWMsQ0FBQyxHQUFHLGtCQUFrQixDQUFDO2dCQUMvQyxDQUFDO2dCQUVELGtFQUFrRTtnQkFDbEUsTUFBTSxDQUFDLEtBQUssQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDOUUsQ0FBQztZQUVELG9EQUFvRDtZQUNwRCxPQUFPLGFBQWEsQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDekMsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDZixNQUFNLENBQUMsS0FBSyxDQUFDLHdCQUF3QixFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQzlDLE1BQU0sS0FBSyxDQUFDO1FBQ2QsQ0FBQztJQUNILENBQUMsQ0FBQSxDQUFDO0FBQ0osQ0FBQztBQUVEOztHQUVHO0FBQ0gsTUFBTSxVQUFVLHlCQUF5QixDQUFDLFVBQStCLEVBQUU7SUFDekUsdUNBQ0ssT0FBTyxLQUNWLEtBQUssRUFBRSxzQkFBc0IsRUFBRSxJQUMvQjtBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBvYnNpZGlhbkZldGNoIH0gZnJvbSBcIi4uL3V0aWxzL2ZldGNoLXNoaW1cIjtcbmltcG9ydCB7IGdldExvZ2dlciB9IGZyb20gXCIuLi91dGlscy9sb2dnZXJcIjtcblxuY29uc3QgbG9nZ2VyID0gZ2V0TG9nZ2VyKCdMQU5HQ0hBSU5fRkVUQ0hFUicpO1xuXG4vKipcbiAqIEN1c3RvbSBmZXRjaGVyIGZvciBMYW5nQ2hhaW4gdGhhdCB1c2VzIG91ciBPYnNpZGlhbiBmZXRjaCBzaGltXG4gKiBUaGlzIG1ha2VzIExhbmdDaGFpbiBtb2RlbHMgd29yayBvbiBib3RoIGRlc2t0b3AgYW5kIG1vYmlsZSBPYnNpZGlhblxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTGFuZ0NoYWluRmV0Y2hlcigpIHtcbiAgcmV0dXJuIGFzeW5jICh1cmw6IHN0cmluZyB8IFVSTCB8IFJlcXVlc3QsIGluaXQ/OiBSZXF1ZXN0SW5pdCk6IFByb21pc2U8UmVzcG9uc2U+ID0+IHtcbiAgICB0cnkge1xuICAgICAgLy8gRW5zdXJlIHRoZSBVUkwgaXMgcHJvcGVybHkgZm9ybWF0dGVkXG4gICAgICBsZXQgcmVxdWVzdFVybDogc3RyaW5nO1xuICAgICAgXG4gICAgICBpZiAodHlwZW9mIHVybCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgcmVxdWVzdFVybCA9IHVybDtcbiAgICAgIH0gZWxzZSBpZiAodXJsIGluc3RhbmNlb2YgVVJMKSB7XG4gICAgICAgIHJlcXVlc3RVcmwgPSB1cmwudG9TdHJpbmcoKTtcbiAgICAgIH0gZWxzZSBpZiAodXJsIGluc3RhbmNlb2YgUmVxdWVzdCkge1xuICAgICAgICByZXF1ZXN0VXJsID0gdXJsLnVybDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcignSW52YWxpZCBVUkwgdHlwZTonLCB0eXBlb2YgdXJsKTtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignSW52YWxpZCBVUkwgdHlwZScpO1xuICAgICAgfVxuICAgICAgXG4gICAgICAvLyBTYW5pdGl6ZSBVUkwgYW5kIGNoZWNrIGZvciBBUEktc3BlY2lmaWMgaXNzdWVzXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJzZWRVcmwgPSBuZXcgVVJMKHJlcXVlc3RVcmwpO1xuICAgICAgICBcbiAgICAgICAgLy8gRW5zdXJlIHByb3RvY29sIGlzIGh0dHAgb3IgaHR0cHNcbiAgICAgICAgaWYgKHBhcnNlZFVybC5wcm90b2NvbCAhPT0gJ2h0dHA6JyAmJiBwYXJzZWRVcmwucHJvdG9jb2wgIT09ICdodHRwczonKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHByb3RvY29sOiAke3BhcnNlZFVybC5wcm90b2NvbH1gKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gU3BlY2lhbCBjYXNlIGZvciBPcGVuQUkgQVBJIC0gZW5zdXJlIHdlIGhhdmUgYSB2YWxpZCBwYXRoIFxuICAgICAgICAvLyAodGhpcyB3YXMgY2F1c2luZyBFUlJfSU5WQUxJRF9BUkdVTUVOVClcbiAgICAgICAgaWYgKHBhcnNlZFVybC5ob3N0bmFtZS5pbmNsdWRlcygnb3BlbmFpLmNvbScpKSB7XG4gICAgICAgICAgbG9nZ2VyLmRlYnVnKCdPcGVuQUkgQVBJIGRldGVjdGVkLCBlbnN1cmluZyB2YWxpZCBwYXRoJyk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gRml4IGNvbW1vbiBwYXRoIGVycm9yc1xuICAgICAgICAgIGlmICghcGFyc2VkVXJsLnBhdGhuYW1lIHx8IHBhcnNlZFVybC5wYXRobmFtZSA9PT0gJy8nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgT3BlbkFJIEFQSSBwYXRoJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIFxuICAgICAgICAgIC8vIEVuc3VyZSBBUEkgdmVyc2lvbiBpcyBpbmNsdWRlZFxuICAgICAgICAgIGlmICghcGFyc2VkVXJsLnBhdGhuYW1lLmluY2x1ZGVzKCcvdjEvJykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlbkFJIEFQSSByZXF1aXJlcyAvdjEvIHBhdGgnKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIFVzZSB0aGUgdmFsaWRhdGVkIFVSTFxuICAgICAgICByZXF1ZXN0VXJsID0gcGFyc2VkVXJsLnRvU3RyaW5nKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgSW52YWxpZCBVUkw6ICR7cmVxdWVzdFVybH1gLCBlKTtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgSW52YWxpZCBVUkw6ICR7cmVxdWVzdFVybH1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gTG9nIHJlcXVlc3QgZm9yIGRlYnVnZ2luZ1xuICAgICAgbG9nZ2VyLmRlYnVnKGBMYW5nQ2hhaW4gZmV0Y2g6ICR7cmVxdWVzdFVybH1gKTtcbiAgICAgIFxuICAgICAgLy8gQWRkaXRpb25hbCBjaGVja3MgZm9yIGNvbW1vbiBBUEkgaXNzdWVzXG4gICAgICBpZiAoaW5pdD8uaGVhZGVycykge1xuICAgICAgICBjb25zdCBoZWFkZXJzID0gaW5pdC5oZWFkZXJzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgICAgIFxuICAgICAgICAvLyBDaGVjayBmb3IgbWlzc2luZyBjb250ZW50LXR5cGUgb24gUE9TVCByZXF1ZXN0c1xuICAgICAgICBpZiAoaW5pdC5tZXRob2QgPT09ICdQT1NUJyAmJiBpbml0LmJvZHkgJiYgIWhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddKSB7XG4gICAgICAgICAgbG9nZ2VyLmRlYnVnKCdBZGRpbmcgQ29udGVudC1UeXBlIGhlYWRlciBmb3IgUE9TVCByZXF1ZXN0Jyk7XG4gICAgICAgICAgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIExvZyBhdXRob3JpemF0aW9uIGhlYWRlciBwcmVzZW5jZSAobm90IHRoZSB2YWx1ZSkgZm9yIGRlYnVnZ2luZ1xuICAgICAgICBsb2dnZXIuZGVidWcoYEF1dGhvcml6YXRpb24gaGVhZGVyIHByZXNlbnQ6ICR7ISFoZWFkZXJzWydBdXRob3JpemF0aW9uJ119YCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIFVzZSBvdXIgb2JzaWRpYW5GZXRjaCBzaGltIGZvciB0aGUgYWN0dWFsIHJlcXVlc3RcbiAgICAgIHJldHVybiBvYnNpZGlhbkZldGNoKHJlcXVlc3RVcmwsIGluaXQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoXCJMYW5nQ2hhaW4gZmV0Y2ggZXJyb3I6XCIsIGVycm9yKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfTtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIG9iamVjdCBmb3IgTGFuZ0NoYWluIG1vZGVscyB0aGF0IGluY2x1ZGVzIG91ciBjdXN0b20gZmV0Y2hlclxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGFuZ0NoYWluQ29uZmlndXJhdGlvbihvcHRpb25zOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge30pIHtcbiAgcmV0dXJuIHtcbiAgICAuLi5vcHRpb25zLFxuICAgIGZldGNoOiBjcmVhdGVMYW5nQ2hhaW5GZXRjaGVyKClcbiAgfTtcbn0gIl19