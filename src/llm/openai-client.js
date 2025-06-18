import { __awaiter } from "tslib";
import OpenAI from "openai";
import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";
const logger = getLogger('OPENAI');
/**
 * Creates an OpenAI client configured to work in Obsidian on any platform.
 *
 * @param apiKey The OpenAI API key
 * @returns An initialized OpenAI client
 */
export function createOpenAIClient(apiKey) {
    if (!apiKey || apiKey.trim() === '') {
        throw new Error('OpenAI API key is required');
    }
    logger.debug('Creating OpenAI client');
    // Use a custom fetch implementation that works with Obsidian
    const customFetch = (url, init) => __awaiter(this, void 0, void 0, function* () {
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
            // Make sure the URL doesn't have any invalid characters
            try {
                const parsedUrl = new URL(requestUrl);
                requestUrl = parsedUrl.toString();
            }
            catch (e) {
                logger.error('Invalid URL format:', requestUrl);
                throw new Error(`Invalid URL format: ${requestUrl}`);
            }
            // Log detailed request info for debugging
            logger.debug(`OpenAI fetch: ${requestUrl}`);
            // Make the request using our shim
            return obsidianFetch(requestUrl, init);
        }
        catch (error) {
            logger.error('Error in OpenAI fetch:', error);
            throw error;
        }
    });
    try {
        return new OpenAI({
            apiKey: apiKey,
            baseURL: 'https://api.openai.com/v1',
            fetch: customFetch,
            dangerouslyAllowBrowser: true // Required for browser/WebView environments
        });
    }
    catch (error) {
        logger.error('Failed to create OpenAI client:', error);
        throw new Error(`Failed to initialize OpenAI client: ${error.message}`);
    }
}
/**
 * Simple wrapper around the OpenAI client for chat completions
 */
export class OpenAIWrapper {
    constructor(apiKey) {
        this.client = createOpenAIClient(apiKey);
    }
    /**
     * Generate a chat completion
     *
     * @param model The model to use (e.g., "gpt-4", "gpt-3.5-turbo")
     * @param messages The chat messages
     * @param options Additional options
     * @returns The completion response
     */
    createChatCompletion(model_1, messages_1) {
        return __awaiter(this, arguments, void 0, function* (model, messages, options = {}) {
            try {
                logger.debug(`Creating chat completion with model: ${model}, messages: ${messages.length}, options: ${JSON.stringify({
                    temperature: options.temperature,
                    max_tokens: options.max_tokens
                })}`);
                // Create a safe copy of options to prevent mutations or reference issues
                const safeOptions = Object.assign({}, options);
                // Validate messages format - each message must have role and content
                const validMessages = messages.map(msg => {
                    if (!msg.role || !msg.content) {
                        logger.warn('Invalid message format, fixing:', msg);
                        return {
                            role: msg.role || 'user',
                            content: msg.content || ''
                        };
                    }
                    return msg;
                });
                const response = yield this.client.chat.completions.create(Object.assign({ model: model, messages: validMessages }, safeOptions));
                logger.debug('Chat completion successful');
                return response;
            }
            catch (error) {
                logger.error('Error in chat completion:', error);
                // Enhanced error reporting
                if (error.response) {
                    logger.error(`Status: ${error.response.status}, Data:`, error.response.data);
                }
                // Check for common errors and provide better messages
                if (error.message && error.message.includes('ERR_INVALID_ARGUMENT')) {
                    throw new Error('Invalid API request. Please check your API key and network connection.');
                }
                throw error;
            }
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3BlbmFpLWNsaWVudC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9wZW5haS1jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sTUFBTSxNQUFNLFFBQVEsQ0FBQztBQUM1QixPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDcEQsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBRTVDLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUVuQzs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSxrQkFBa0IsQ0FBQyxNQUFjO0lBQy9DLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQUMsNEJBQTRCLENBQUMsQ0FBQztJQUNoRCxDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBRXZDLDZEQUE2RDtJQUM3RCxNQUFNLFdBQVcsR0FBRyxDQUFPLEdBQTJCLEVBQUUsSUFBa0IsRUFBRSxFQUFFO1FBQzVFLElBQUksQ0FBQztZQUNILHVDQUF1QztZQUN2QyxJQUFJLFVBQWtCLENBQUM7WUFFdkIsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztnQkFDNUIsVUFBVSxHQUFHLEdBQUcsQ0FBQztZQUNuQixDQUFDO2lCQUFNLElBQUksR0FBRyxZQUFZLEdBQUcsRUFBRSxDQUFDO2dCQUM5QixVQUFVLEdBQUcsR0FBRyxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQzlCLENBQUM7aUJBQU0sSUFBSSxHQUFHLFlBQVksT0FBTyxFQUFFLENBQUM7Z0JBQ2xDLFVBQVUsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDO1lBQ3ZCLENBQUM7aUJBQU0sQ0FBQztnQkFDTixNQUFNLENBQUMsS0FBSyxDQUFDLG1CQUFtQixFQUFFLE9B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Q1osUUFBUSxFQUFFLGFBQWEsSUFDcEIsV0FBVyxFQUNkLENBQUM7Z0JBRUgsTUFBTSxDQUFDLEtBQUssQ0FBQyw0QkFBNEIsQ0FBQyxDQUFDO2dCQUMzQyxPQUFPLFFBQVEsQ0FBQztZQUNsQixDQUFDO1lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztnQkFDZixNQUFNLENBQUMsS0FBSyxDQUFDLDJCQUEyQixFQUFFLEtBQUssQ0FBQyxDQUFDO2dCQUVqRCwyQkFBMkI7Z0JBQzNCLElBQUksS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO29CQUNuQixNQUFNLENBQUMsS0FBSyxDQUFDLFdBQVcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLFNBQVMsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUMvRSxDQUFDO2dCQUVELHNEQUFzRDtnQkFDdEQsSUFBSSxLQUFLLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLHNCQUFzQixDQUFDLEVBQUUsQ0FBQztvQkFDcEUsTUFBTSxJQUFJLEtBQUssQ0FBQyx3RUFBd0UsQ0FBQyxDQUFDO2dCQUM1RixDQUFDO2dCQUVELE1BQU0sS0FBSyxDQUFDO1lBQ2QsQ0FBQztRQUNILENBQUM7S0FBQTtDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IE9wZW5BSSBmcm9tIFwib3BlbmFpXCI7XG5pbXBvcnQgeyBvYnNpZGlhbkZldGNoIH0gZnJvbSBcIi4uL3V0aWxzL2ZldGNoLXNoaW1cIjtcbmltcG9ydCB7IGdldExvZ2dlciB9IGZyb20gXCIuLi91dGlscy9sb2dnZXJcIjtcblxuY29uc3QgbG9nZ2VyID0gZ2V0TG9nZ2VyKCdPUEVOQUknKTtcblxuLyoqXG4gKiBDcmVhdGVzIGFuIE9wZW5BSSBjbGllbnQgY29uZmlndXJlZCB0byB3b3JrIGluIE9ic2lkaWFuIG9uIGFueSBwbGF0Zm9ybS5cbiAqIFxuICogQHBhcmFtIGFwaUtleSBUaGUgT3BlbkFJIEFQSSBrZXlcbiAqIEByZXR1cm5zIEFuIGluaXRpYWxpemVkIE9wZW5BSSBjbGllbnRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU9wZW5BSUNsaWVudChhcGlLZXk6IHN0cmluZykge1xuICBpZiAoIWFwaUtleSB8fCBhcGlLZXkudHJpbSgpID09PSAnJykge1xuICAgIHRocm93IG5ldyBFcnJvcignT3BlbkFJIEFQSSBrZXkgaXMgcmVxdWlyZWQnKTtcbiAgfVxuICBcbiAgbG9nZ2VyLmRlYnVnKCdDcmVhdGluZyBPcGVuQUkgY2xpZW50Jyk7XG4gIFxuICAvLyBVc2UgYSBjdXN0b20gZmV0Y2ggaW1wbGVtZW50YXRpb24gdGhhdCB3b3JrcyB3aXRoIE9ic2lkaWFuXG4gIGNvbnN0IGN1c3RvbUZldGNoID0gYXN5bmMgKHVybDogc3RyaW5nIHwgVVJMIHwgUmVxdWVzdCwgaW5pdD86IFJlcXVlc3RJbml0KSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIEVuc3VyZSB0aGUgVVJMIGlzIHByb3Blcmx5IGZvcm1hdHRlZFxuICAgICAgbGV0IHJlcXVlc3RVcmw6IHN0cmluZztcbiAgICAgIFxuICAgICAgaWYgKHR5cGVvZiB1cmwgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVlc3RVcmwgPSB1cmw7XG4gICAgICB9IGVsc2UgaWYgKHVybCBpbnN0YW5jZW9mIFVSTCkge1xuICAgICAgICByZXF1ZXN0VXJsID0gdXJsLnRvU3RyaW5nKCk7XG4gICAgICB9IGVsc2UgaWYgKHVybCBpbnN0YW5jZW9mIFJlcXVlc3QpIHtcbiAgICAgICAgcmVxdWVzdFVybCA9IHVybC51cmw7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0ludmFsaWQgVVJMIHR5cGU6JywgdHlwZW9mIHVybCk7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0ludmFsaWQgVVJMIHR5cGUnKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gTWFrZSBzdXJlIHRoZSBVUkwgZG9lc24ndCBoYXZlIGFueSBpbnZhbGlkIGNoYXJhY3RlcnNcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBhcnNlZFVybCA9IG5ldyBVUkwocmVxdWVzdFVybCk7XG4gICAgICAgIHJlcXVlc3RVcmwgPSBwYXJzZWRVcmwudG9TdHJpbmcoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdJbnZhbGlkIFVSTCBmb3JtYXQ6JywgcmVxdWVzdFVybCk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBVUkwgZm9ybWF0OiAke3JlcXVlc3RVcmx9YCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIExvZyBkZXRhaWxlZCByZXF1ZXN0IGluZm8gZm9yIGRlYnVnZ2luZ1xuICAgICAgbG9nZ2VyLmRlYnVnKGBPcGVuQUkgZmV0Y2g6ICR7cmVxdWVzdFVybH1gKTtcbiAgICAgIFxuICAgICAgLy8gTWFrZSB0aGUgcmVxdWVzdCB1c2luZyBvdXIgc2hpbVxuICAgICAgcmV0dXJuIG9ic2lkaWFuRmV0Y2gocmVxdWVzdFVybCwgaW5pdCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ2dlci5lcnJvcignRXJyb3IgaW4gT3BlbkFJIGZldGNoOicsIGVycm9yKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfTtcbiAgXG4gIHRyeSB7XG4gICAgcmV0dXJuIG5ldyBPcGVuQUkoeyBcbiAgICAgIGFwaUtleTogYXBpS2V5LFxuICAgICAgYmFzZVVSTDogJ2h0dHBzOi8vYXBpLm9wZW5haS5jb20vdjEnLFxuICAgICAgZmV0Y2g6IGN1c3RvbUZldGNoLFxuICAgICAgZGFuZ2Vyb3VzbHlBbGxvd0Jyb3dzZXI6IHRydWUgLy8gUmVxdWlyZWQgZm9yIGJyb3dzZXIvV2ViVmlldyBlbnZpcm9ubWVudHNcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2dnZXIuZXJyb3IoJ0ZhaWxlZCB0byBjcmVhdGUgT3BlbkFJIGNsaWVudDonLCBlcnJvcik7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gaW5pdGlhbGl6ZSBPcGVuQUkgY2xpZW50OiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBTaW1wbGUgd3JhcHBlciBhcm91bmQgdGhlIE9wZW5BSSBjbGllbnQgZm9yIGNoYXQgY29tcGxldGlvbnNcbiAqL1xuZXhwb3J0IGNsYXNzIE9wZW5BSVdyYXBwZXIge1xuICBwcml2YXRlIGNsaWVudDogT3BlbkFJO1xuICBcbiAgY29uc3RydWN0b3IoYXBpS2V5OiBzdHJpbmcpIHtcbiAgICB0aGlzLmNsaWVudCA9IGNyZWF0ZU9wZW5BSUNsaWVudChhcGlLZXkpO1xuICB9XG4gIFxuICAvKipcbiAgICogR2VuZXJhdGUgYSBjaGF0IGNvbXBsZXRpb25cbiAgICogXG4gICAqIEBwYXJhbSBtb2RlbCBUaGUgbW9kZWwgdG8gdXNlIChlLmcuLCBcImdwdC00XCIsIFwiZ3B0LTMuNS10dXJib1wiKVxuICAgKiBAcGFyYW0gbWVzc2FnZXMgVGhlIGNoYXQgbWVzc2FnZXNcbiAgICogQHBhcmFtIG9wdGlvbnMgQWRkaXRpb25hbCBvcHRpb25zXG4gICAqIEByZXR1cm5zIFRoZSBjb21wbGV0aW9uIHJlc3BvbnNlXG4gICAqL1xuICBhc3luYyBjcmVhdGVDaGF0Q29tcGxldGlvbihtb2RlbDogc3RyaW5nLCBtZXNzYWdlczogYW55W10sIG9wdGlvbnM6IGFueSA9IHt9KSB7XG4gICAgdHJ5IHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgQ3JlYXRpbmcgY2hhdCBjb21wbGV0aW9uIHdpdGggbW9kZWw6ICR7bW9kZWx9LCBtZXNzYWdlczogJHttZXNzYWdlcy5sZW5ndGh9LCBvcHRpb25zOiAke0pTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgdGVtcGVyYXR1cmU6IG9wdGlvbnMudGVtcGVyYXR1cmUsXG4gICAgICAgIG1heF90b2tlbnM6IG9wdGlvbnMubWF4X3Rva2Vuc1xuICAgICAgfSl9YCk7XG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBhIHNhZmUgY29weSBvZiBvcHRpb25zIHRvIHByZXZlbnQgbXV0YXRpb25zIG9yIHJlZmVyZW5jZSBpc3N1ZXNcbiAgICAgIGNvbnN0IHNhZmVPcHRpb25zID0geyAuLi5vcHRpb25zIH07XG4gICAgICBcbiAgICAgIC8vIFZhbGlkYXRlIG1lc3NhZ2VzIGZvcm1hdCAtIGVhY2ggbWVzc2FnZSBtdXN0IGhhdmUgcm9sZSBhbmQgY29udGVudFxuICAgICAgY29uc3QgdmFsaWRNZXNzYWdlcyA9IG1lc3NhZ2VzLm1hcChtc2cgPT4ge1xuICAgICAgICBpZiAoIW1zZy5yb2xlIHx8ICFtc2cuY29udGVudCkge1xuICAgICAgICAgIGxvZ2dlci53YXJuKCdJbnZhbGlkIG1lc3NhZ2UgZm9ybWF0LCBmaXhpbmc6JywgbXNnKTtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcm9sZTogbXNnLnJvbGUgfHwgJ3VzZXInLFxuICAgICAgICAgICAgY29udGVudDogbXNnLmNvbnRlbnQgfHwgJydcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBtc2c7XG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmNsaWVudC5jaGF0LmNvbXBsZXRpb25zLmNyZWF0ZSh7XG4gICAgICAgIG1vZGVsOiBtb2RlbCxcbiAgICAgICAgbWVzc2FnZXM6IHZhbGlkTWVzc2FnZXMsXG4gICAgICAgIC4uLnNhZmVPcHRpb25zXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgbG9nZ2VyLmRlYnVnKCdDaGF0IGNvbXBsZXRpb24gc3VjY2Vzc2Z1bCcpO1xuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0Vycm9yIGluIGNoYXQgY29tcGxldGlvbjonLCBlcnJvcik7XG4gICAgICBcbiAgICAgIC8vIEVuaGFuY2VkIGVycm9yIHJlcG9ydGluZ1xuICAgICAgaWYgKGVycm9yLnJlc3BvbnNlKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgU3RhdHVzOiAke2Vycm9yLnJlc3BvbnNlLnN0YXR1c30sIERhdGE6YCwgZXJyb3IucmVzcG9uc2UuZGF0YSk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIENoZWNrIGZvciBjb21tb24gZXJyb3JzIGFuZCBwcm92aWRlIGJldHRlciBtZXNzYWdlc1xuICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgJiYgZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnRVJSX0lOVkFMSURfQVJHVU1FTlQnKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgQVBJIHJlcXVlc3QuIFBsZWFzZSBjaGVjayB5b3VyIEFQSSBrZXkgYW5kIG5ldHdvcmsgY29ubmVjdGlvbi4nKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG59ICJdfQ==