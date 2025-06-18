import { __awaiter } from "tslib";
import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";
const logger = getLogger('GEMINI');
/**
 * Client for Google's Gemini API
 */
export class GeminiClient {
    constructor(apiKey) {
        this.baseUrl = "https://generativelanguage.googleapis.com";
        this.apiVersion = "v1";
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('Google API key is required');
        }
        this.apiKey = apiKey;
        logger.debug('Creating Gemini client');
    }
    /**
     * Check if the client can be used on the current platform
     */
    isAvailable() {
        // Gemini should work on all platforms through our fetch shim
        return true;
    }
    /**
     * Generate content using a Gemini model
     *
     * @param model The model to use (e.g., "gemini-1.5-pro")
     * @param prompt The text prompt
     * @param options Additional options
     * @returns The generation response
     */
    generateContent(model_1, prompt_1) {
        return __awaiter(this, arguments, void 0, function* (model, prompt, options = {}) {
            var _a;
            try {
                const url = `${this.baseUrl}/${this.apiVersion}/models/${model}:generateContent?key=${this.apiKey}`;
                // Initialize request body
                const requestBody = {
                    contents: [],
                    generationConfig: {
                        temperature: options.temperature !== undefined ? options.temperature : 0.7,
                        maxOutputTokens: options.max_tokens || 1024,
                        topP: options.top_p || 0.95,
                        topK: options.top_k || 40
                    }
                };
                // Handle system prompt - Gemini doesn't support system role directly
                // So we need to prepend it to the user message or use a different approach
                let fullPrompt = prompt;
                if (options.system) {
                    // Prepend system prompt to user prompt
                    fullPrompt = `${options.system}\n\n${prompt}`;
                    logger.debug('Added system prompt to user message for Gemini');
                }
                // Add the message as a user message (Gemini only supports user and model roles)
                requestBody.contents.push({
                    role: "user",
                    parts: [{ text: fullPrompt }]
                });
                const response = yield obsidianFetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody)
                });
                if (!response.ok) {
                    const errorData = yield response.json();
                    logger.error('Gemini API error:', errorData);
                    throw new Error(`Gemini API error: ${((_a = errorData.error) === null || _a === void 0 ? void 0 : _a.message) || JSON.stringify(errorData)}`);
                }
                return response.json();
            }
            catch (error) {
                logger.error('Error in generateContent:', error);
                throw error;
            }
        });
    }
    /**
     * Extract the generated text from a Gemini API response
     *
     * @param response The raw API response
     * @returns The generated text
     */
    extractText(response) {
        try {
            if (!response || !response.candidates || !response.candidates[0]) {
                return '';
            }
            const candidate = response.candidates[0];
            if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                return '';
            }
            return candidate.content.parts[0].text || '';
        }
        catch (error) {
            logger.error('Error extracting text from Gemini response:', error);
            return '';
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VtaW5pLWNsaWVudC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdlbWluaS1jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUNwRCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFFNUMsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBRW5DOztHQUVHO0FBQ0gsTUFBTSxPQUFPLFlBQVk7SUFLdkIsWUFBWSxNQUFjO1FBSGxCLFlBQU8sR0FBRywyQ0FBMkMsQ0FBQztRQUN0RCxlQUFVLEdBQUcsSUFBSSxDQUFDO1FBR3hCLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1lBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQUMsNEJBQTRCLENBQUMsQ0FBQztRQUNoRCxDQUFDO1FBRUQsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7UUFDckIsTUFBTSxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQ3pDLENBQUM7SUFFRDs7T0FFRztJQUNILFdBQVc7UUFDVCw2REFBNkQ7UUFDN0QsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBRUQ7Ozs7Ozs7T0FPRztJQUNHLGVBQWU7NkRBQUMsS0FBYSxFQUFFLE1BQWMsRUFBRSxVQUFlLEVBQUU7O1lBQ3BFLElBQUksQ0FBQztnQkFDSCxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLElBQUksSUFBSSxDQUFDLFVBQVUsV0FBVyxLQUFLLHdCQUF3QixJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7Z0JBRXBHLDBCQUEwQjtnQkFDMUIsTUFBTSxXQUFXLEdBQVE7b0JBQ3ZCLFFBQVEsRUFBRSxFQUFFO29CQUNaLGdCQUFnQixFQUFFO3dCQUNoQixXQUFXLEVBQUUsT0FBTyxDQUFD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c291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgb2JzaWRpYW5GZXRjaCB9IGZyb20gXCIuLi91dGlscy9mZXRjaC1zaGltXCI7XG5pbXBvcnQgeyBnZXRMb2dnZXIgfSBmcm9tIFwiLi4vdXRpbHMvbG9nZ2VyXCI7XG5cbmNvbnN0IGxvZ2dlciA9IGdldExvZ2dlcignR0VNSU5JJyk7XG5cbi8qKlxuICogQ2xpZW50IGZvciBHb29nbGUncyBHZW1pbmkgQVBJXG4gKi9cbmV4cG9ydCBjbGFzcyBHZW1pbmlDbGllbnQge1xuICBwcml2YXRlIGFwaUtleTogc3RyaW5nO1xuICBwcml2YXRlIGJhc2VVcmwgPSBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tXCI7XG4gIHByaXZhdGUgYXBpVmVyc2lvbiA9IFwidjFcIjtcbiAgXG4gIGNvbnN0cnVjdG9yKGFwaUtleTogc3RyaW5nKSB7XG4gICAgaWYgKCFhcGlLZXkgfHwgYXBpS2V5LnRyaW0oKSA9PT0gJycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignR29vZ2xlIEFQSSBrZXkgaXMgcmVxdWlyZWQnKTtcbiAgICB9XG4gICAgXG4gICAgdGhpcy5hcGlLZXkgPSBhcGlLZXk7XG4gICAgbG9nZ2VyLmRlYnVnKCdDcmVhdGluZyBHZW1pbmkgY2xpZW50Jyk7XG4gIH1cblxuICAvKipcbiAgICogQ2hlY2sgaWYgdGhlIGNsaWVudCBjYW4gYmUgdXNlZCBvbiB0aGUgY3VycmVudCBwbGF0Zm9ybVxuICAgKi9cbiAgaXNBdmFpbGFibGUoKTogYm9vbGVhbiB7XG4gICAgLy8gR2VtaW5pIHNob3VsZCB3b3JrIG9uIGFsbCBwbGF0Zm9ybXMgdGhyb3VnaCBvdXIgZmV0Y2ggc2hpbVxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIFxuICAvKipcbiAgICogR2VuZXJhdGUgY29udGVudCB1c2luZyBhIEdlbWluaSBtb2RlbFxuICAgKiBcbiAgICogQHBhcmFtIG1vZGVsIFRoZSBtb2RlbCB0byB1c2UgKGUuZy4sIFwiZ2VtaW5pLTEuNS1wcm9cIilcbiAgICogQHBhcmFtIHByb21wdCBUaGUgdGV4dCBwcm9tcHRcbiAgICogQHBhcmFtIG9wdGlvbnMgQWRkaXRpb25hbCBvcHRpb25zXG4gICAqIEByZXR1cm5zIFRoZSBnZW5lcmF0aW9uIHJlc3BvbnNlXG4gICAqL1xuICBhc3luYyBnZW5lcmF0ZUNvbnRlbnQobW9kZWw6IHN0cmluZywgcHJvbXB0OiBzdHJpbmcsIG9wdGlvbnM6IGFueSA9IHt9KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHVybCA9IGAke3RoaXMuYmFzZVVybH0vJHt0aGlzLmFwaVZlcnNpb259L21vZGVscy8ke21vZGVsfTpnZW5lcmF0ZUNvbnRlbnQ/a2V5PSR7dGhpcy5hcGlLZXl9YDtcbiAgICAgIFxuICAgICAgLy8gSW5pdGlhbGl6ZSByZXF1ZXN0IGJvZHlcbiAgICAgIGNvbnN0IHJlcXVlc3RCb2R5OiBhbnkgPSB7XG4gICAgICAgIGNvbnRlbnRzOiBbXSxcbiAgICAgICAgZ2VuZXJhdGlvbkNvbmZpZzoge1xuICAgICAgICAgIHRlbXBlcmF0dXJlOiBvcHRpb25zLnRlbXBlcmF0dXJlICE9PSB1bmRlZmluZWQgPyBvcHRpb25zLnRlbXBlcmF0dXJlIDogMC43LFxuICAgICAgICAgIG1heE91dHB1dFRva2Vuczogb3B0aW9ucy5tYXhfdG9rZW5zIHx8IDEwMjQsXG4gICAgICAgICAgdG9wUDogb3B0aW9ucy50b3BfcCB8fCAwLjk1LFxuICAgICAgICAgIHRvcEs6IG9wdGlvbnMudG9wX2sgfHwgNDBcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgLy8gSGFuZGxlIHN5c3RlbSBwcm9tcHQgLSBHZW1pbmkgZG9lc24ndCBzdXBwb3J0IHN5c3RlbSByb2xlIGRpcmVjdGx5XG4gICAgICAvLyBTbyB3ZSBuZWVkIHRvIHByZXBlbmQgaXQgdG8gdGhlIHVzZXIgbWVzc2FnZSBvciB1c2UgYSBkaWZmZXJlbnQgYXBwcm9hY2hcbiAgICAgIGxldCBmdWxsUHJvbXB0ID0gcHJvbXB0O1xuICAgICAgaWYgKG9wdGlvbnMuc3lzdGVtKSB7XG4gICAgICAgIC8vIFByZXBlbmQgc3lzdGVtIHByb21wdCB0byB1c2VyIHByb21wdFxuICAgICAgICBmdWxsUHJvbXB0ID0gYCR7b3B0aW9ucy5zeXN0ZW19XFxuXFxuJHtwcm9tcHR9YDtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKCdBZGRlZCBzeXN0ZW0gcHJvbXB0IHRvIHVzZXIgbWVzc2FnZSBmb3IgR2VtaW5pJyk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIEFkZCB0aGUgbWVzc2FnZSBhcyBhIHVzZXIgbWVzc2FnZSAoR2VtaW5pIG9ubHkgc3VwcG9ydHMgdXNlciBhbmQgbW9kZWwgcm9sZXMpXG4gICAgICByZXF1ZXN0Qm9keS5jb250ZW50cy5wdXNoKHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIHBhcnRzOiBbeyB0ZXh0OiBmdWxsUHJvbXB0IH1dXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBvYnNpZGlhbkZldGNoKHVybCwge1xuICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcXVlc3RCb2R5KVxuICAgICAgfSk7XG4gICAgICBcbiAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgY29uc3QgZXJyb3JEYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0dlbWluaSBBUEkgZXJyb3I6JywgZXJyb3JEYXRhKTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBHZW1pbmkgQVBJIGVycm9yOiAke2Vycm9yRGF0YS5lcnJvcj8ubWVzc2FnZSB8fCBKU09OLnN0cmluZ2lmeShlcnJvckRhdGEpfWApO1xuICAgICAgfVxuICAgICAgXG4gICAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0Vycm9yIGluIGdlbmVyYXRlQ29udGVudDonLCBlcnJvcik7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgXG4gIC8qKlxuICAgKiBFeHRyYWN0IHRoZSBnZW5lcmF0ZWQgdGV4dCBmcm9tIGEgR2VtaW5pIEFQSSByZXNwb25zZVxuICAgKiBcbiAgICogQHBhcmFtIHJlc3BvbnNlIFRoZSByYXcgQVBJIHJlc3BvbnNlXG4gICAqIEByZXR1cm5zIFRoZSBnZW5lcmF0ZWQgdGV4dFxuICAgKi9cbiAgZXh0cmFjdFRleHQocmVzcG9uc2U6IGFueSk6IHN0cmluZyB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghcmVzcG9uc2UgfHwgIXJlc3BvbnNlLmNhbmRpZGF0ZXMgfHwgIXJlc3BvbnNlLmNhbmRpZGF0ZXNbMF0pIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgICAgfVxuICAgICAgXG4gICAgICBjb25zdCBjYW5kaWRhdGUgPSByZXNwb25zZS5jYW5kaWRhdGVzWzBdO1xuICAgICAgaWYgKCFjYW5kaWRhdGUuY29udGVudCB8fCAhY2FuZGlkYXRlLmNvbnRlbnQucGFydHMgfHwgIWNhbmRpZGF0ZS5jb250ZW50LnBhcnRzWzBdKSB7XG4gICAgICAgIHJldHVybiAnJztcbiAgICAgIH1cbiAgICAgIFxuICAgICAgcmV0dXJuIGNhbmRpZGF0ZS5jb250ZW50LnBhcnRzWzBdLnRleHQgfHwgJyc7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ2dlci5lcnJvcignRXJyb3IgZXh0cmFjdGluZyB0ZXh0IGZyb20gR2VtaW5pIHJlc3BvbnNlOicsIGVycm9yKTtcbiAgICAgIHJldHVybiAnJztcbiAgICB9XG4gIH1cbn0gIl19