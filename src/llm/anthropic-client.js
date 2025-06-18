import { __awaiter } from "tslib";
import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";
const logger = getLogger('ANTHROPIC');
/**
 * Simple Anthropic API client that doesn't rely on their Node.js SDK.
 * This works on both desktop and mobile Obsidian.
 */
export class AnthropicClient {
    constructor(apiKey) {
        this.baseUrl = "https://api.anthropic.com/v1";
        this.apiVersion = "2023-06-01";
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('Anthropic API key is required');
        }
        this.apiKey = apiKey;
        logger.debug('Creating Anthropic client');
    }
    /**
     * Check if the client can be used on the current platform
     */
    isAvailable() {
        // Anthropic should work on all platforms through our fetch shim
        return true;
    }
    /**
     * Create a message using Anthropic's API
     *
     * @param params The message parameters including system, messages, and model
     * @returns The Claude API response
     */
    createMessage(params) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const response = yield obsidianFetch(`${this.baseUrl}/messages`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": this.apiKey,
                        "anthropic-version": this.apiVersion
                    },
                    body: JSON.stringify(params)
                });
                if (!response.ok) {
                    const errorData = yield response.json();
                    logger.error('Anthropic API error:', errorData);
                    throw new Error(`Anthropic API error: ${((_a = errorData.error) === null || _a === void 0 ? void 0 : _a.message) || JSON.stringify(errorData)}`);
                }
                return response.json();
            }
            catch (error) {
                logger.error('Error in createMessage:', error);
                throw error;
            }
        });
    }
    /**
     * Simplified method to generate a completion with Claude
     *
     * @param model The Claude model to use
     * @param prompt The prompt to send
     * @param options Additional options
     * @returns The completion response
     */
    createCompletion(model_1, prompt_1) {
        return __awaiter(this, arguments, void 0, function* (model, prompt, options = {}) {
            const systemPrompt = options.system || '';
            const temperature = options.temperature !== undefined ? options.temperature : 0.7;
            const maxTokens = options.max_tokens || 1024;
            return this.createMessage({
                model: model,
                system: systemPrompt,
                messages: [{ role: "user", content: prompt }],
                max_tokens: maxTokens,
                temperature: temperature
            });
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW50aHJvcGljLWNsaWVudC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFudGhyb3BpYy1jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFBRSxhQUFhLEVBQW9CLE1BQU0scUJBQXFCLENBQUM7QUFDdEUsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBRTVDLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUV0Qzs7O0dBR0c7QUFDSCxNQUFNLE9BQU8sZUFBZTtJQUsxQixZQUFZLE1BQWM7UUFIbEIsWUFBTyxHQUFHLDhCQUE4QixDQUFDO1FBQ3pDLGVBQVUsR0FBRyxZQUFZLENBQUM7UUFHaEMsSUFBSSxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUM7WUFDcEMsTUFBTSxJQUFJLEtBQUssQ0FBQywrQkFBK0IsQ0FBQyxDQUFDO1FBQ25ELENBQUM7UUFFRCxJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixNQUFNLENBQUMsS0FBSyxDQUFDLDJCQUEyQixDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUVEOztPQUVHO0lBQ0gsV0FBVztRQUNULGdFQUFnRTtRQUNoRSxPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFFRDs7Ozs7T0FLRztJQUNHLGFBQWEsQ0FBQyxNQU1uQjs7O1lBQ0MsSUFBSSxDQUFDO2dCQUNILE1BQU0sUUFBUSxHQUFHLE1BQU0sYUFBYSxDQUFDLEdBQUcsSUFBSSxDQUFDLE9BQU8sV0FBVyxFQUFFO29CQUMvRCxNQUFNLEVBQUUsTUFBTTtvQkFDZCxPQUFPLEVBQUU7d0JBQ1AsY0FBYyxFQUFFLGtCQUFrQjt3QkFDbEMsV0FBVyxFQUFFLElBQUksQ0FBQyxNQUFNO3dCQUN4QixtQkFBbUIsRUFBRSxJQUFJLENBQUMsVUFBVTtxQkFDckM7b0JBQ0QsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDO2lCQUM3QixDQUFDLENBQUM7Z0JBRUgsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUUsQ0FBQztvQkFDakIsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7b0JBQ3hDLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLEVBQUUsU0FBUyxDQUFDLENBQUM7b0JBQ2hELE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUEsTUFBQSxTQUFTLENBQUMsS0FBSywwQ0FBRSxPQUFPLEtBQUksSUFBSSxDQUFDLFNBQVMsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ25HLENBQUM7Z0JBRUQsT0FBTyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDekIsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2YsTUFBTSxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFDL0MsTUFBTSxLQUFLLENBQUM7WUFDZCxDQUFDO1FBQ0gsQ0FBQztLQUFBO0lBRUQ7Ozs7Ozs7T0FPRztJQUNHLGdCQUFnQjs2REFBQyxLQUFhLEVBQUUsTUFBYyxFQUFFLFVBQWUsRUFBRTtZQUNyRSxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQztZQUMxQyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsV0FBVyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO1lBQ2xGLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxVQUFVLElBQUksSUFBSSxDQUFDO1lBRTdDLE9BQU8sSUFBSSxDQUFDLGFBQWEsQ0FBQztnQkFDeEIsS0FBSyxFQUFFLEtBQUs7Z0JBQ1osTUFBTSxFQUFFLFlBQVk7Z0JBQ3BCLFFBQVEsRUFBRSxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLENBQUM7Z0JBQzdDLFVBQVUsRUFBRSxTQUFTO2dCQUNyQixXQUFXLEVBQUUsV0FBVzthQUN6QixDQUFDLENBQUM7UUFDTCxDQUFDO0tBQUE7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IG9ic2lkaWFuRmV0Y2gsIGlzUGxhdGZvcm1Nb2JpbGUgfSBmcm9tIFwiLi4vdXRpbHMvZmV0Y2gtc2hpbVwiO1xuaW1wb3J0IHsgZ2V0TG9nZ2VyIH0gZnJvbSBcIi4uL3V0aWxzL2xvZ2dlclwiO1xuXG5jb25zdCBsb2dnZXIgPSBnZXRMb2dnZXIoJ0FOVEhST1BJQycpO1xuXG4vKipcbiAqIFNpbXBsZSBBbnRocm9waWMgQVBJIGNsaWVudCB0aGF0IGRvZXNuJ3QgcmVseSBvbiB0aGVpciBOb2RlLmpzIFNESy5cbiAqIFRoaXMgd29ya3Mgb24gYm90aCBkZXNrdG9wIGFuZCBtb2JpbGUgT2JzaWRpYW4uXG4gKi9cbmV4cG9ydCBjbGFzcyBBbnRocm9waWNDbGllbnQge1xuICBwcml2YXRlIGFwaUtleTogc3RyaW5nO1xuICBwcml2YXRlIGJhc2VVcmwgPSBcImh0dHBzOi8vYXBpLmFudGhyb3BpYy5jb20vdjFcIjtcbiAgcHJpdmF0ZSBhcGlWZXJzaW9uID0gXCIyMDIzLTA2LTAxXCI7XG4gIFxuICBjb25zdHJ1Y3RvcihhcGlLZXk6IHN0cmluZykge1xuICAgIGlmICghYXBpS2V5IHx8IGFwaUtleS50cmltKCkgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FudGhyb3BpYyBBUEkga2V5IGlzIHJlcXVpcmVkJyk7XG4gICAgfVxuICAgIFxuICAgIHRoaXMuYXBpS2V5ID0gYXBpS2V5O1xuICAgIGxvZ2dlci5kZWJ1ZygnQ3JlYXRpbmcgQW50aHJvcGljIGNsaWVudCcpO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrIGlmIHRoZSBjbGllbnQgY2FuIGJlIHVzZWQgb24gdGhlIGN1cnJlbnQgcGxhdGZvcm1cbiAgICovXG4gIGlzQXZhaWxhYmxlKCk6IGJvb2xlYW4ge1xuICAgIC8vIEFudGhyb3BpYyBzaG91bGQgd29yayBvbiBhbGwgcGxhdGZvcm1zIHRocm91Z2ggb3VyIGZldGNoIHNoaW1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBcbiAgLyoqXG4gICAqIENyZWF0ZSBhIG1lc3NhZ2UgdXNpbmcgQW50aHJvcGljJ3MgQVBJXG4gICAqIFxuICAgKiBAcGFyYW0gcGFyYW1zIFRoZSBtZXNzYWdlIHBhcmFtZXRlcnMgaW5jbHVkaW5nIHN5c3RlbSwgbWVzc2FnZXMsIGFuZCBtb2RlbFxuICAgKiBAcmV0dXJucyBUaGUgQ2xhdWRlIEFQSSByZXNwb25zZVxuICAgKi9cbiAgYXN5bmMgY3JlYXRlTWVzc2FnZShwYXJhbXM6IHtcbiAgICBtb2RlbDogc3RyaW5nLFxuICAgIHN5c3RlbT86IHN0cmluZyxcbiAgICBtZXNzYWdlczoge3JvbGU6IHN0cmluZywgY29udGVudDogc3RyaW5nfVtdLFxuICAgIG1heF90b2tlbnM/OiBudW1iZXIsXG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXJcbiAgfSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IG9ic2lkaWFuRmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9tZXNzYWdlc2AsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICAgIFwiWC1BUEktS2V5XCI6IHRoaXMuYXBpS2V5LFxuICAgICAgICAgIFwiYW50aHJvcGljLXZlcnNpb25cIjogdGhpcy5hcGlWZXJzaW9uXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBhcmFtcylcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgIGNvbnN0IGVycm9yRGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdBbnRocm9waWMgQVBJIGVycm9yOicsIGVycm9yRGF0YSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQW50aHJvcGljIEFQSSBlcnJvcjogJHtlcnJvckRhdGEuZXJyb3I/Lm1lc3NhZ2UgfHwgSlNPTi5zdHJpbmdpZnkoZXJyb3JEYXRhKX1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbG9nZ2VyLmVycm9yKCdFcnJvciBpbiBjcmVhdGVNZXNzYWdlOicsIGVycm9yKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICBcbiAgLyoqXG4gICAqIFNpbXBsaWZpZWQgbWV0aG9kIHRvIGdlbmVyYXRlIGEgY29tcGxldGlvbiB3aXRoIENsYXVkZVxuICAgKiBcbiAgICogQHBhcmFtIG1vZGVsIFRoZSBDbGF1ZGUgbW9kZWwgdG8gdXNlXG4gICAqIEBwYXJhbSBwcm9tcHQgVGhlIHByb21wdCB0byBzZW5kXG4gICAqIEBwYXJhbSBvcHRpb25zIEFkZGl0aW9uYWwgb3B0aW9uc1xuICAgKiBAcmV0dXJucyBUaGUgY29tcGxldGlvbiByZXNwb25zZVxuICAgKi9cbiAgYXN5bmMgY3JlYXRlQ29tcGxldGlvbihtb2RlbDogc3RyaW5nLCBwcm9tcHQ6IHN0cmluZywgb3B0aW9uczogYW55ID0ge30pIHtcbiAgICBjb25zdCBzeXN0ZW1Qcm9tcHQgPSBvcHRpb25zLnN5c3RlbSB8fCAnJztcbiAgICBjb25zdCB0ZW1wZXJhdHVyZSA9IG9wdGlvbnMudGVtcGVyYXR1cmUgIT09IHVuZGVmaW5lZCA/IG9wdGlvbnMudGVtcGVyYXR1cmUgOiAwLjc7XG4gICAgY29uc3QgbWF4VG9rZW5zID0gb3B0aW9ucy5tYXhfdG9rZW5zIHx8IDEwMjQ7XG4gICAgXG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlTWVzc2FnZSh7XG4gICAgICBtb2RlbDogbW9kZWwsXG4gICAgICBzeXN0ZW06IHN5c3RlbVByb21wdCxcbiAgICAgIG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogcHJvbXB0IH1dLFxuICAgICAgbWF4X3Rva2VuczogbWF4VG9rZW5zLFxuICAgICAgdGVtcGVyYXR1cmU6IHRlbXBlcmF0dXJlXG4gICAgfSk7XG4gIH1cbn0gIl19