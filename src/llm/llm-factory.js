import { getLogger } from "../utils/logger";
import { OpenAIWrapper } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { GeminiClient } from "./gemini-client";
import { OllamaClient } from "./ollama-client";
const logger = getLogger('LLM_FACTORY');
/**
 * Factory for creating and managing LLM clients
 */
export class LLMFactory {
    constructor(settings) {
        this.openaiClient = null;
        this.anthropicClient = null;
        this.geminiClient = null;
        this.ollamaClient = null;
        this.settings = settings;
        logger.debug('Created LLM Factory');
    }
    /**
     * Get the selected LLM provider
     * @returns The provider ID
     */
    getBestProvider() {
        return this.settings.selectedLLM;
    }
    /**
     * Get the OpenAI client
     */
    getOpenAIClient() {
        if (!this.openaiClient) {
            const apiKey = this.settings.apiKeys['openai'];
            if (!apiKey) {
                throw new Error('OpenAI API key is not configured');
            }
            this.openaiClient = new OpenAIWrapper(apiKey);
        }
        return this.openaiClient;
    }
    /**
     * Get the Anthropic client
     */
    getAnthropicClient() {
        if (!this.anthropicClient) {
            const apiKey = this.settings.apiKeys['anthropic'];
            if (!apiKey) {
                throw new Error('Anthropic API key is not configured');
            }
            this.anthropicClient = new AnthropicClient(apiKey);
        }
        return this.anthropicClient;
    }
    /**
     * Get the Google Gemini client
     */
    getGeminiClient() {
        if (!this.geminiClient) {
            const apiKey = this.settings.apiKeys['google'];
            if (!apiKey) {
                throw new Error('Google API key is not configured');
            }
            this.geminiClient = new GeminiClient(apiKey);
        }
        return this.geminiClient;
    }
    /**
     * Get the Ollama client
     */
    getOllamaClient() {
        if (!this.ollamaClient) {
            const baseUrl = this.settings.apiKeys['ollama'] || 'http://localhost:11434';
            this.ollamaClient = new OllamaClient(baseUrl);
        }
        return this.ollamaClient;
    }
    /**
     * Get client by provider name
     * @param provider The provider ID
     * @returns The LLM client
     */
    getClient(provider) {
        switch (provider) {
            case 'openai':
                return this.getOpenAIClient();
            case 'anthropic':
                return this.getAnthropicClient();
            case 'google':
                return this.getGeminiClient();
            case 'ollama':
                return this.getOllamaClient();
            default:
                throw new Error(`Unknown LLM provider: ${provider}`);
        }
    }
    /**
     * Update the settings
     * @param settings The new settings
     */
    updateSettings(settings) {
        this.settings = settings;
        // Reset clients so they're recreated with new settings on next access
        this.openaiClient = null;
        this.anthropicClient = null;
        this.geminiClient = null;
        this.ollamaClient = null;
        logger.debug('LLM Factory settings updated');
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGxtLWZhY3RvcnkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsbG0tZmFjdG9yeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDNUMsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ2hELE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUNyRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDL0MsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBRS9DLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQVd4Qzs7R0FFRztBQUNILE1BQU0sT0FBTyxVQUFVO0lBT3JCLFlBQVksUUFBcUI7UUFMekIsaUJBQVksR0FBeUIsSUFBSSxDQUFDO1FBQzFDLG9CQUFlLEdBQTJCLElBQUksQ0FBQztRQUMvQyxpQkFBWSxHQUF3QixJQUFJLENBQUM7UUFDekMsaUJBQVksR0FBd0IsSUFBSSxDQUFDO1FBRy9DLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1FBQ3pCLE1BQU0sQ0FBQyxLQUFLLENBQUMscUJBQXFCLENBQUMsQ0FBQztJQUN0QyxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsZUFBZTtRQUNiLE9BQU8sSUFBSSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUM7SUFDbkMsQ0FBQztJQUVEOztPQUVHO0lBQ0gsZUFBZTtRQUNiLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDdkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDL0MsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO2dCQUNaLE1BQU0sSUFBSSxLQUFLLENBQUMsa0NBQWtDLENBQUMsQ0FBQztZQUN0RCxDQUFDO1lBQ0QsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLGFBQWEsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUNoRCxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUMsWUFBWSxDQUFDO0lBQzNCLENBQUM7SUFFRDs7T0FFRztJQUNILGtCQUFrQjtRQUNoQixJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQzFCLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQ2xELElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDWixNQUFNLElBQUksS0FBSyxDQUFDLHFDQUFxQyxDQUFDLENBQUM7WUFDekQsQ0FBQztZQUNELElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDckQsQ0FBQztRQUNELE9BQU8sSUFBSSxDQUFDLGVBQWUsQ0FBQztJQUM5QixDQUFDO0lBRUQ7O09BRUc7SUFDSCxlQUFlO1FBQ2IsSUFBSSxDQUFDLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUN2QixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUMvQyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7Z0JBQ1osTUFBTSxJQUFJLEtBQUssQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDO1lBQ3RELENBQUM7WUFDRCxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQy9DLENBQUM7UUFDRCxPQUFPLElBQUksQ0FBQyxZQUFZLENBQUM7SUFDM0IsQ0FBQztJQUVEOztPQUVHO0lBQ0gsZUFBZTtRQUNiLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDdkIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLElBQUksd0JBQXdCLENBQUM7WUFDNUUsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNoRCxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUMsWUFBWSxDQUFDO0lBQzNCLENBQUM7SUFFRDs7OztPQUlHO0lBQ0gsU0FBUyxDQUFDLFFBQWdCO1FBQ3hCLFFBQVEsUUFBUSxFQUFFLENBQUM7WUFDakIsS0FBSyxRQUFRO2dCQUNYLE9BQU8sSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ2hDLEtBQUssV0FBVztnQkFDZCxPQUFPLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1lBQ25DLEtBQUssUUFBUTtnQkFDWCxPQUFPLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztZQUNoQyxLQUFLLFFBQVE7Z0JBQ1gsT0FBTyxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7WUFDaEM7Z0JBQ0UsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsUUFBUSxFQUFFLENBQUMsQ0FBQztRQUN6RCxDQUFDO0lBQ0gsQ0FBQztJQUVEOzs7T0FHRztJQUNILGNBQWMsQ0FBQyxRQUFxQjtRQUNsQyxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztRQUV6QixzRUFBc0U7UUFDdEUsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUM7UUFDekIsSUFBSSxDQUFDLGVBQWUsR0FBRyxJQUFJLENBQUM7UUFDNUIsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUM7UUFDekIsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUM7UUFFekIsTUFBTSxDQUFDLEtBQUssQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO0lBQy9DLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGdldExvZ2dlciB9IGZyb20gXCIuLi91dGlscy9sb2dnZXJcIjtcbmltcG9ydCB7IE9wZW5BSVdyYXBwZXIgfSBmcm9tIFwiLi9vcGVuYWktY2xpZW50XCI7XG5pbXBvcnQgeyBBbnRocm9waWNDbGllbnQgfSBmcm9tIFwiLi9hbnRocm9waWMtY2xpZW50XCI7XG5pbXBvcnQgeyBHZW1pbmlDbGllbnQgfSBmcm9tIFwiLi9nZW1pbmktY2xpZW50XCI7XG5pbXBvcnQgeyBPbGxhbWFDbGllbnQgfSBmcm9tIFwiLi9vbGxhbWEtY2xpZW50XCI7XG5cbmNvbnN0IGxvZ2dlciA9IGdldExvZ2dlcignTExNX0ZBQ1RPUlknKTtcblxuLyoqXG4gKiBTZXR0aW5ncyBpbnRlcmZhY2UgbmVlZGVkIGJ5IHRoZSBmYWN0b3J5XG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTExNU2V0dGluZ3Mge1xuICBzZWxlY3RlZExMTTogc3RyaW5nO1xuICBhcGlLZXlzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICBzZWxlY3RlZE1vZGVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuLyoqXG4gKiBGYWN0b3J5IGZvciBjcmVhdGluZyBhbmQgbWFuYWdpbmcgTExNIGNsaWVudHNcbiAqL1xuZXhwb3J0IGNsYXNzIExMTUZhY3Rvcnkge1xuICBwcml2YXRlIHNldHRpbmdzOiBMTE1TZXR0aW5ncztcbiAgcHJpdmF0ZSBvcGVuYWlDbGllbnQ6IE9wZW5BSVdyYXBwZXIgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBhbnRocm9waWNDbGllbnQ6IEFudGhyb3BpY0NsaWVudCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGdlbWluaUNsaWVudDogR2VtaW5pQ2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb2xsYW1hQ2xpZW50OiBPbGxhbWFDbGllbnQgfCBudWxsID0gbnVsbDtcbiAgXG4gIGNvbnN0cnVjdG9yKHNldHRpbmdzOiBMTE1TZXR0aW5ncykge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBzZXR0aW5ncztcbiAgICBsb2dnZXIuZGVidWcoJ0NyZWF0ZWQgTExNIEZhY3RvcnknKTtcbiAgfVxuICBcbiAgLyoqXG4gICAqIEdldCB0aGUgc2VsZWN0ZWQgTExNIHByb3ZpZGVyXG4gICAqIEByZXR1cm5zIFRoZSBwcm92aWRlciBJRFxuICAgKi9cbiAgZ2V0QmVzdFByb3ZpZGVyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuc2V0dGluZ3Muc2VsZWN0ZWRMTE07XG4gIH1cbiAgXG4gIC8qKlxuICAgKiBHZXQgdGhlIE9wZW5BSSBjbGllbnRcbiAgICovXG4gIGdldE9wZW5BSUNsaWVudCgpOiBPcGVuQUlXcmFwcGVyIHtcbiAgICBpZiAoIXRoaXMub3BlbmFpQ2xpZW50KSB7XG4gICAgICBjb25zdCBhcGlLZXkgPSB0aGlzLnNldHRpbmdzLmFwaUtleXNbJ29wZW5haSddO1xuICAgICAgaWYgKCFhcGlLZXkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVuQUkgQVBJIGtleSBpcyBub3QgY29uZmlndXJlZCcpO1xuICAgICAgfVxuICAgICAgdGhpcy5vcGVuYWlDbGllbnQgPSBuZXcgT3BlbkFJV3JhcHBlcihhcGlLZXkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5vcGVuYWlDbGllbnQ7XG4gIH1cbiAgXG4gIC8qKlxuICAgKiBHZXQgdGhlIEFudGhyb3BpYyBjbGllbnRcbiAgICovXG4gIGdldEFudGhyb3BpY0NsaWVudCgpOiBBbnRocm9waWNDbGllbnQge1xuICAgIGlmICghdGhpcy5hbnRocm9waWNDbGllbnQpIHtcbiAgICAgIGNvbnN0IGFwaUtleSA9IHRoaXMuc2V0dGluZ3MuYXBpS2V5c1snYW50aHJvcGljJ107XG4gICAgICBpZiAoIWFwaUtleSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FudGhyb3BpYyBBUEkga2V5IGlzIG5vdCBjb25maWd1cmVkJyk7XG4gICAgICB9XG4gICAgICB0aGlzLmFudGhyb3BpY0NsaWVudCA9IG5ldyBBbnRocm9waWNDbGllbnQoYXBpS2V5KTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuYW50aHJvcGljQ2xpZW50O1xuICB9XG4gIFxuICAvKipcbiAgICogR2V0IHRoZSBHb29nbGUgR2VtaW5pIGNsaWVudFxuICAgKi9cbiAgZ2V0R2VtaW5pQ2xpZW50KCk6IEdlbWluaUNsaWVudCB7XG4gICAgaWYgKCF0aGlzLmdlbWluaUNsaWVudCkge1xuICAgICAgY29uc3QgYXBpS2V5ID0gdGhpcy5zZXR0aW5ncy5hcGlLZXlzWydnb29nbGUnXTtcbiAgICAgIGlmICghYXBpS2V5KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignR29vZ2xlIEFQSSBrZXkgaXMgbm90IGNvbmZpZ3VyZWQnKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuZ2VtaW5pQ2xpZW50ID0gbmV3IEdlbWluaUNsaWVudChhcGlLZXkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5nZW1pbmlDbGllbnQ7XG4gIH1cbiAgXG4gIC8qKlxuICAgKiBHZXQgdGhlIE9sbGFtYSBjbGllbnRcbiAgICovXG4gIGdldE9sbGFtYUNsaWVudCgpOiBPbGxhbWFDbGllbnQge1xuICAgIGlmICghdGhpcy5vbGxhbWFDbGllbnQpIHtcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0aGlzLnNldHRpbmdzLmFwaUtleXNbJ29sbGFtYSddIHx8ICdodHRwOi8vbG9jYWxob3N0OjExNDM0JztcbiAgICAgIHRoaXMub2xsYW1hQ2xpZW50ID0gbmV3IE9sbGFtYUNsaWVudChiYXNlVXJsKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMub2xsYW1hQ2xpZW50O1xuICB9XG4gIFxuICAvKipcbiAgICogR2V0IGNsaWVudCBieSBwcm92aWRlciBuYW1lXG4gICAqIEBwYXJhbSBwcm92aWRlciBUaGUgcHJvdmlkZXIgSURcbiAgICogQHJldHVybnMgVGhlIExMTSBjbGllbnRcbiAgICovXG4gIGdldENsaWVudChwcm92aWRlcjogc3RyaW5nKTogYW55IHtcbiAgICBzd2l0Y2ggKHByb3ZpZGVyKSB7XG4gICAgICBjYXNlICdvcGVuYWknOlxuICAgICAgICByZXR1cm4gdGhpcy5nZXRPcGVuQUlDbGllbnQoKTtcbiAgICAgIGNhc2UgJ2FudGhyb3BpYyc6XG4gICAgICAgIHJldHVybiB0aGlzLmdldEFudGhyb3BpY0NsaWVudCgpO1xuICAgICAgY2FzZSAnZ29vZ2xlJzpcbiAgICAgICAgcmV0dXJuIHRoaXMuZ2V0R2VtaW5pQ2xpZW50KCk7XG4gICAgICBjYXNlICdvbGxhbWEnOlxuICAgICAgICByZXR1cm4gdGhpcy5nZXRPbGxhbWFDbGllbnQoKTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBMTE0gcHJvdmlkZXI6ICR7cHJvdmlkZXJ9YCk7XG4gICAgfVxuICB9XG4gIFxuICAvKipcbiAgICogVXBkYXRlIHRoZSBzZXR0aW5nc1xuICAgKiBAcGFyYW0gc2V0dGluZ3MgVGhlIG5ldyBzZXR0aW5nc1xuICAgKi9cbiAgdXBkYXRlU2V0dGluZ3Moc2V0dGluZ3M6IExMTVNldHRpbmdzKTogdm9pZCB7XG4gICAgdGhpcy5zZXR0aW5ncyA9IHNldHRpbmdzO1xuICAgIFxuICAgIC8vIFJlc2V0IGNsaWVudHMgc28gdGhleSdyZSByZWNyZWF0ZWQgd2l0aCBuZXcgc2V0dGluZ3Mgb24gbmV4dCBhY2Nlc3NcbiAgICB0aGlzLm9wZW5haUNsaWVudCA9IG51bGw7XG4gICAgdGhpcy5hbnRocm9waWNDbGllbnQgPSBudWxsO1xuICAgIHRoaXMuZ2VtaW5pQ2xpZW50ID0gbnVsbDtcbiAgICB0aGlzLm9sbGFtYUNsaWVudCA9IG51bGw7XG4gICAgXG4gICAgbG9nZ2VyLmRlYnVnKCdMTE0gRmFjdG9yeSBzZXR0aW5ncyB1cGRhdGVkJyk7XG4gIH1cbn0gIl19