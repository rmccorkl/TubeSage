import { __awaiter } from "tslib";
import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";
const logger = getLogger('OLLAMA');
/**
 * Simplified Ollama API client that works with local Ollama instances
 * Using the bare-bones HTTP API instead of SDKs for maximum compatibility
 */
export class OllamaClient {
    constructor(baseUrl = 'http://localhost:11434') {
        this.baseUrl = baseUrl;
        logger.debug('Ollama client created with base URL:', baseUrl);
    }
    /**
     * Check if Ollama can be used on the current platform
     */
    isAvailable() {
        // Ollama should work on all platforms with the unified fetch shim
        // However, users need to ensure their Ollama server is accessible
        // from their device (typically via localhost on same network)
        return true;
    }
    /**
     * Validate that the Ollama server is accessible
     */
    validateConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield obsidianFetch(`${this.baseUrl}/api/version`);
                if (!response.ok) {
                    logger.error(`Ollama server returned error status: ${response.status}`);
                    return false;
                }
                const data = yield response.json();
                logger.debug('Ollama version check successful:', data);
                return true;
            }
            catch (error) {
                logger.error('Ollama server connection failed:', error);
                return false;
            }
        });
    }
    /**
     * Generate a completion from Ollama
     */
    generateCompletion(model_1, prompt_1) {
        return __awaiter(this, arguments, void 0, function* (model, prompt, options = {}) {
            const { system, temperature = 0.7, max_tokens } = options;
            try {
                const requestBody = {
                    model,
                    prompt,
                    stream: false,
                    options: {
                        temperature
                    }
                };
                // Add optional parameters if provided
                if (system) {
                    requestBody.system = system;
                }
                if (max_tokens) {
                    requestBody.options.num_predict = max_tokens;
                }
                const response = yield obsidianFetch(`${this.baseUrl}/api/generate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                });
                if (!response.ok) {
                    const errorText = yield response.text();
                    logger.error('Ollama API error:', errorText);
                    throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
                }
                const data = yield response.json();
                return data;
            }
            catch (error) {
                logger.error('Error in Ollama generateCompletion:', error);
                throw error;
            }
        });
    }
    /**
     * Create a chat completion - wrapper around generate for more OpenAI-like interface
     */
    createChatCompletion(model_1, messages_1) {
        return __awaiter(this, arguments, void 0, function* (model, messages, options = {}) {
            try {
                // Extract system message if present
                let systemPrompt = options.system || '';
                if (!systemPrompt && messages.length > 0 && messages[0].role === 'system') {
                    systemPrompt = messages[0].content;
                    messages = messages.slice(1);
                }
                // Format the messages into a prompt
                let prompt = '';
                messages.forEach(message => {
                    if (message.role === 'user') {
                        prompt += `\nHuman: ${message.content}`;
                    }
                    else if (message.role === 'assistant') {
                        prompt += `\nAssistant: ${message.content}`;
                    }
                });
                // Add final turn
                prompt += '\nAssistant:';
                // Generate completion
                const result = yield this.generateCompletion(model, prompt, {
                    system: systemPrompt,
                    temperature: options.temperature,
                    max_tokens: options.max_tokens
                });
                // Format the response to match OpenAI structure
                return {
                    id: 'ollama-' + Date.now(),
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: result.response
                            },
                            finish_reason: 'stop'
                        }
                    ],
                    usage: {
                        prompt_tokens: result.prompt_eval_count || 0,
                        completion_tokens: result.eval_count || 0,
                        total_tokens: (result.prompt_eval_count || 0) + (result.eval_count || 0)
                    }
                };
            }
            catch (error) {
                logger.error('Error in Ollama createChatCompletion:', error);
                throw error;
            }
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2xsYW1hLWNsaWVudC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9sbGFtYS1jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUNwRCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFFNUMsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBRW5DOzs7R0FHRztBQUNILE1BQU0sT0FBTyxZQUFZO0lBR3ZCLFlBQVksVUFBa0Isd0JBQXdCO1FBQ3BELElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0NBQXNDLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUVEOztPQUVHO0lBQ0gsV0FBVztRQUNULGtFQUFrRTtRQUNsRSxrRUFBa0U7UUFDbEUsOERBQThEO1FBQzlELE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVEOztPQUVHO0lBQ0csa0JBQWtCOztZQUN0QixJQUFJLENBQUM7Z0JBQ0gsTUFBTSxRQUFRLEdBQUcsTUFBTSxhQUFhLENBQUMsR0FBRyxJQUFJLENBQUMsT0FBTyxjQUFjLENBQUMsQ0FBQztnQkFDcEUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUUsQ0FBQztvQkFDakIsTUFBTSxDQUFDLEtBQUssQ0FBQyx3Q0FBd0MsUUFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7b0JBQ3hFLE9BQU8sS0FBSyxDQUFDO2dCQUNmLENBQUM7Z0JBRUQsTUFBTSxJQUFJLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQ25DLE1BQU0sQ0FBQyxLQUFLLENBQUMsa0NBQWtDLEVBQUUsSUFBSSxDQUFDLENBQUM7Z0JBQ3ZELE9BQU8sSUFBSSxDQUFDO1lBQ2QsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7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SyxDQUFDLENBQUM7Z0JBQzdELE1BQU0sS0FBSyxDQUFDO1lBQ2QsQ0FBQztRQUNILENBQUM7S0FBQTtDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgb2JzaWRpYW5GZXRjaCB9IGZyb20gXCIuLi91dGlscy9mZXRjaC1zaGltXCI7XG5pbXBvcnQgeyBnZXRMb2dnZXIgfSBmcm9tIFwiLi4vdXRpbHMvbG9nZ2VyXCI7XG5cbmNvbnN0IGxvZ2dlciA9IGdldExvZ2dlcignT0xMQU1BJyk7XG5cbi8qKlxuICogU2ltcGxpZmllZCBPbGxhbWEgQVBJIGNsaWVudCB0aGF0IHdvcmtzIHdpdGggbG9jYWwgT2xsYW1hIGluc3RhbmNlc1xuICogVXNpbmcgdGhlIGJhcmUtYm9uZXMgSFRUUCBBUEkgaW5zdGVhZCBvZiBTREtzIGZvciBtYXhpbXVtIGNvbXBhdGliaWxpdHlcbiAqL1xuZXhwb3J0IGNsYXNzIE9sbGFtYUNsaWVudCB7XG4gIHByaXZhdGUgYmFzZVVybDogc3RyaW5nO1xuICBcbiAgY29uc3RydWN0b3IoYmFzZVVybDogc3RyaW5nID0gJ2h0dHA6Ly9sb2NhbGhvc3Q6MTE0MzQnKSB7XG4gICAgdGhpcy5iYXNlVXJsID0gYmFzZVVybDtcbiAgICBsb2dnZXIuZGVidWcoJ09sbGFtYSBjbGllbnQgY3JlYXRlZCB3aXRoIGJhc2UgVVJMOicsIGJhc2VVcmwpO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrIGlmIE9sbGFtYSBjYW4gYmUgdXNlZCBvbiB0aGUgY3VycmVudCBwbGF0Zm9ybVxuICAgKi9cbiAgaXNBdmFpbGFibGUoKTogYm9vbGVhbiB7XG4gICAgLy8gT2xsYW1hIHNob3VsZCB3b3JrIG9uIGFsbCBwbGF0Zm9ybXMgd2l0aCB0aGUgdW5pZmllZCBmZXRjaCBzaGltXG4gICAgLy8gSG93ZXZlciwgdXNlcnMgbmVlZCB0byBlbnN1cmUgdGhlaXIgT2xsYW1hIHNlcnZlciBpcyBhY2Nlc3NpYmxlXG4gICAgLy8gZnJvbSB0aGVpciBkZXZpY2UgKHR5cGljYWxseSB2aWEgbG9jYWxob3N0IG9uIHNhbWUgbmV0d29yaylcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBcbiAgLyoqXG4gICAqIFZhbGlkYXRlIHRoYXQgdGhlIE9sbGFtYSBzZXJ2ZXIgaXMgYWNjZXNzaWJsZVxuICAgKi9cbiAgYXN5bmMgdmFsaWRhdGVDb25uZWN0aW9uKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IG9ic2lkaWFuRmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvdmVyc2lvbmApO1xuICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICBsb2dnZXIuZXJyb3IoYE9sbGFtYSBzZXJ2ZXIgcmV0dXJuZWQgZXJyb3Igc3RhdHVzOiAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgXG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICAgICAgbG9nZ2VyLmRlYnVnKCdPbGxhbWEgdmVyc2lvbiBjaGVjayBzdWNjZXNzZnVsOicsIGRhdGEpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ2dlci5lcnJvcignT2xsYW1hIHNlcnZlciBjb25uZWN0aW9uIGZhaWxlZDonLCBlcnJvcik7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG4gIFxuICAvKipcbiAgICogR2VuZXJhdGUgYSBjb21wbGV0aW9uIGZyb20gT2xsYW1hXG4gICAqL1xuICBhc3luYyBnZW5lcmF0ZUNvbXBsZXRpb24oXG4gICAgbW9kZWw6IHN0cmluZyxcbiAgICBwcm9tcHQ6IHN0cmluZyxcbiAgICBvcHRpb25zOiB7XG4gICAgICBzeXN0ZW0/OiBzdHJpbmc7XG4gICAgICB0ZW1wZXJhdHVyZT86IG51bWJlcjtcbiAgICAgIG1heF90b2tlbnM/OiBudW1iZXI7XG4gICAgfSA9IHt9XG4gICkge1xuICAgIGNvbnN0IHsgc3lzdGVtLCB0ZW1wZXJhdHVyZSA9IDAuNywgbWF4X3Rva2VucyB9ID0gb3B0aW9ucztcbiAgICBcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdEJvZHk6IGFueSA9IHtcbiAgICAgICAgbW9kZWwsXG4gICAgICAgIHByb21wdCxcbiAgICAgICAgc3RyZWFtOiBmYWxzZSxcbiAgICAgICAgb3B0aW9uczoge1xuICAgICAgICAgIHRlbXBlcmF0dXJlXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBcbiAgICAgIC8vIEFkZCBvcHRpb25hbCBwYXJhbWV0ZXJzIGlmIHByb3ZpZGVkXG4gICAgICBpZiAoc3lzdGVtKSB7XG4gICAgICAgIHJlcXVlc3RCb2R5LnN5c3RlbSA9IHN5c3RlbTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgaWYgKG1heF90b2tlbnMpIHtcbiAgICAgICAgcmVxdWVzdEJvZHkub3B0aW9ucy5udW1fcHJlZGljdCA9IG1heF90b2tlbnM7XG4gICAgICB9XG4gICAgICBcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgb2JzaWRpYW5GZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9nZW5lcmF0ZWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcXVlc3RCb2R5KVxuICAgICAgfSk7XG4gICAgICBcbiAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ09sbGFtYSBBUEkgZXJyb3I6JywgZXJyb3JUZXh0KTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBPbGxhbWEgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yVGV4dH1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIHJldHVybiBkYXRhO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0Vycm9yIGluIE9sbGFtYSBnZW5lcmF0ZUNvbXBsZXRpb246JywgZXJyb3IpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG4gIFxuICAvKipcbiAgICogQ3JlYXRlIGEgY2hhdCBjb21wbGV0aW9uIC0gd3JhcHBlciBhcm91bmQgZ2VuZXJhdGUgZm9yIG1vcmUgT3BlbkFJLWxpa2UgaW50ZXJmYWNlXG4gICAqL1xuICBhc3luYyBjcmVhdGVDaGF0Q29tcGxldGlvbihcbiAgICBtb2RlbDogc3RyaW5nLCBcbiAgICBtZXNzYWdlczogQXJyYXk8e3JvbGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nfT4sXG4gICAgb3B0aW9uczoge1xuICAgICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgICBtYXhfdG9rZW5zPzogbnVtYmVyO1xuICAgICAgc3lzdGVtPzogc3RyaW5nO1xuICAgIH0gPSB7fVxuICApIHtcbiAgICB0cnkge1xuICAgICAgLy8gRXh0cmFjdCBzeXN0ZW0gbWVzc2FnZSBpZiBwcmVzZW50XG4gICAgICBsZXQgc3lzdGVtUHJvbXB0ID0gb3B0aW9ucy5zeXN0ZW0gfHwgJyc7XG4gICAgICBpZiAoIXN5c3RlbVByb21wdCAmJiBtZXNzYWdlcy5sZW5ndGggPiAwICYmIG1lc3NhZ2VzWzBdLnJvbGUgPT09ICdzeXN0ZW0nKSB7XG4gICAgICAgIHN5c3RlbVByb21wdCA9IG1lc3NhZ2VzWzBdLmNvbnRlbnQ7XG4gICAgICAgIG1lc3NhZ2VzID0gbWVzc2FnZXMuc2xpY2UoMSk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIEZvcm1hdCB0aGUgbWVzc2FnZXMgaW50byBhIHByb21wdFxuICAgICAgbGV0IHByb21wdCA9ICcnO1xuICAgICAgbWVzc2FnZXMuZm9yRWFjaChtZXNzYWdlID0+IHtcbiAgICAgICAgaWYgKG1lc3NhZ2Uucm9sZSA9PT0gJ3VzZXInKSB7XG4gICAgICAgICAgcHJvbXB0ICs9IGBcXG5IdW1hbjogJHttZXNzYWdlLmNvbnRlbnR9YDtcbiAgICAgICAgfSBlbHNlIGlmIChtZXNzYWdlLnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICAgICAgcHJvbXB0ICs9IGBcXG5Bc3Npc3RhbnQ6ICR7bWVzc2FnZS5jb250ZW50fWA7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgXG4gICAgICAvLyBBZGQgZmluYWwgdHVyblxuICAgICAgcHJvbXB0ICs9ICdcXG5Bc3Npc3RhbnQ6JztcbiAgICAgIFxuICAgICAgLy8gR2VuZXJhdGUgY29tcGxldGlvblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5nZW5lcmF0ZUNvbXBsZXRpb24obW9kZWwsIHByb21wdCwge1xuICAgICAgICBzeXN0ZW06IHN5c3RlbVByb21wdCxcbiAgICAgICAgdGVtcGVyYXR1cmU6IG9wdGlvbnMudGVtcGVyYXR1cmUsXG4gICAgICAgIG1heF90b2tlbnM6IG9wdGlvbnMubWF4X3Rva2Vuc1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIEZvcm1hdCB0aGUgcmVzcG9uc2UgdG8gbWF0Y2ggT3BlbkFJIHN0cnVjdHVyZVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgaWQ6ICdvbGxhbWEtJyArIERhdGUubm93KCksXG4gICAgICAgIG9iamVjdDogJ2NoYXQuY29tcGxldGlvbicsXG4gICAgICAgIGNyZWF0ZWQ6IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuICAgICAgICBtb2RlbCxcbiAgICAgICAgY2hvaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGluZGV4OiAwLFxuICAgICAgICAgICAgbWVzc2FnZToge1xuICAgICAgICAgICAgICByb2xlOiAnYXNzaXN0YW50JyxcbiAgICAgICAgICAgICAgY29udGVudDogcmVzdWx0LnJlc3BvbnNlXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZmluaXNoX3JlYXNvbjogJ3N0b3AnXG4gICAgICAgICAgfVxuICAgICAgICBdLFxuICAgICAgICB1c2FnZToge1xuICAgICAgICAgIHByb21wdF90b2tlbnM6IHJlc3VsdC5wcm9tcHRfZXZhbF9jb3VudCB8fCAwLFxuICAgICAgICAgIGNvbXBsZXRpb25fdG9rZW5zOiByZXN1bHQuZXZhbF9jb3VudCB8fCAwLFxuICAgICAgICAgIHRvdGFsX3Rva2VuczogKHJlc3VsdC5wcm9tcHRfZXZhbF9jb3VudCB8fCAwKSArIChyZXN1bHQuZXZhbF9jb3VudCB8fCAwKVxuICAgICAgICB9XG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0Vycm9yIGluIE9sbGFtYSBjcmVhdGVDaGF0Q29tcGxldGlvbjonLCBlcnJvcik7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbn0gIl19