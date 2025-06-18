import { __awaiter } from "tslib";
import { getLogger } from '../utils/logger';
import { LLMFactory } from './llm-factory';
import { LangChainClient } from './langchain-client';
// Get the logger for LLM operations
const llmLogger = getLogger('LLM');
export class TranscriptSummarizer {
    constructor(config, apiKeys) {
        this.config = config;
        this.apiKeys = apiKeys;
        // Initialize the LLM factory
        this.llmFactory = new LLMFactory({
            selectedLLM: 'openai', // Default, will be overridden in summarize()
            apiKeys: this.apiKeys,
            selectedModels: {
                openai: this.config.model,
                anthropic: this.config.model,
                google: this.config.model,
                ollama: this.config.model
            }
        });
        llmLogger.debug('TranscriptSummarizer initialized with config:', {
            model: config.model,
            temperature: config.temperature,
            maxTokens: config.maxTokens
        });
    }
    summarize(transcript, provider) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                llmLogger.info("Starting summarization with provider:", provider);
                llmLogger.info("Transcript length:", transcript.length);
                llmLogger.info("Model:", this.config.model);
                llmLogger.info("Temperature:", this.config.temperature);
                llmLogger.info("Max tokens:", this.config.maxTokens);
                // Check if the API key exists before proceeding
                if (!this.apiKeys[provider] || this.apiKeys[provider].trim() === '') {
                    llmLogger.error(`API key missing for provider: ${provider}`);
                    throw new Error(`API key for ${provider} is missing or empty.`);
                }
                // Important: Check if the transcript contains reference material section
                // If it does, we need to extract the user prompt and transcript
                let userPrompt = this.config.userPrompt;
                let actualTranscript = transcript;
                // Use a regex pattern without the 's' flag (which is ES2018+)
                // Instead use [\s\S]* to match any character including newlines
                const referencePattern = /-{5,}\s*REFERENCE MATERIAL[\s\S]*?-{5,}\s*END REFERENCE MATERIAL\s*-{5,}/;
                const referenceMatch = transcript.match(referencePattern);
                if (referenceMatch) {
                    llmLogger.debug("Detected reference material in transcript - extracting actual content");
                    // Extract the actual content from the transcript (content before the reference material)
                    const parts = transcript.split(referencePattern);
                    if (parts.length > 0) {
                        // The content before the reference section contains the actual prompt + content
                        const contentParts = parts[0].trim().split("\n\n");
                        // Extract user prompt if it's at the beginning (format matches expected)
                        if (contentParts.length >= 2) {
                            userPrompt = contentParts[0];
                            actualTranscript = contentParts.slice(1).join("\n\n");
                            llmLogger.debug("Extracted user prompt and content from transcript");
                        }
                        else {
                            // Just use everything before reference as the content
                            actualTranscript = parts[0].trim();
                            llmLogger.debug("Using content before reference section as transcript");
                        }
                    }
                }
                // Special handling for Ollama which doesn't use LangChain integration
                if (provider === 'ollama') {
                    return this.summarizeWithOllama(actualTranscript);
                }
                // For all other providers, use LangChain
                return this.summarizeWithLangChain(actualTranscript, provider, userPrompt);
            }
            catch (error) {
                llmLogger.error("Error in summarize:", error);
                throw error;
            }
        });
    }
    /**
     * Use LangChain for summarization with OpenAI, Anthropic, or Google
     */
    summarizeWithLangChain(transcript, provider, userPrompt) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                llmLogger.info(`Using LangChain for ${provider} summarization`);
                const langChainClient = new LangChainClient({
                    provider: provider,
                    model: this.config.model,
                    apiKey: this.apiKeys[provider],
                    temperature: this.config.temperature,
                    maxTokens: this.config.maxTokens
                });
                const promptToUse = userPrompt || this.config.userPrompt;
                const userPromptWithTranscript = `${promptToUse}\n\nTranscript:\n${transcript}`;
                const result = yield langChainClient.generateCompletion(this.config.systemPrompt, userPromptWithTranscript);
                return result;
            }
            catch (error) {
                llmLogger.error(`Error in LangChain summarization with ${provider}:`, error);
                throw error;
            }
        });
    }
    /**
     * Use the Ollama client directly (not supported by LangChain in this implementation)
     */
    summarizeWithOllama(transcript) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = this.llmFactory.getOllamaClient();
            // Check if server is running
            const isRunning = yield client.validateConnection();
            if (!isRunning) {
                throw new Error("Ollama server is not accessible. Please ensure Ollama is running and accessible.");
            }
            // Try the chat completion API first (better for newer models)
            try {
                const response = yield client.createChatCompletion(this.config.model, [
                    { role: "system", content: this.config.systemPrompt },
                    { role: "user", content: this.config.userPrompt + "\n\nTranscript:\n" + transcript }
                ], {
                    temperature: this.config.temperature,
                    max_tokens: this.config.maxTokens
                });
                return response.choices[0].message.content || "";
            }
            catch (chatError) {
                // Fallback to simplified approach
                llmLogger.warn("Ollama chat completion failed:", chatError);
                throw new Error("Ollama chat completion failed. Please check your configuration and ensure Ollama is running.");
            }
        });
    }
    /**
     * Format the prompt based on the provider
     */
    formatPrompt(transcript, provider) {
        // Different providers may need different prompt formats
        const basePrompt = `${this.config.userPrompt}\n\nTranscript:\n${transcript}`;
        switch (provider) {
            case 'anthropic':
                // Claude tends to work better with more explicit instructions
                return `${this.config.systemPrompt}\n\n${basePrompt}\n\nPlease provide a comprehensive and well-structured summary.`;
            case 'ollama':
                // Local models often need more explicit prompting
                return `${this.config.systemPrompt}\n\n${basePrompt}\n\nSummarize the transcript above in a clear, structured format.`;
            default:
                return basePrompt;
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHJhbnNjcmlwdC1zdW1tYXJpemVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidHJhbnNjcmlwdC1zdW1tYXJpemVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDNUMsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLGVBQWUsQ0FBQztBQUMzQyxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sb0JBQW9CLENBQUM7QUFVckQsb0NBQW9DO0FBQ3BDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUVuQyxNQUFNLE9BQU8sb0JBQW9CO0lBSzdCLFlBQVksTUFBaUIsRUFBRSxPQUErQjtRQUMxRCxJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztRQUV2Qiw2QkFBNkI7UUFDN0IsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLFVBQVUsQ0FBQztZQUM3QixXQUFXLEVBQUUsUUFBUSxFQUFFLDZDQUE2QztZQUNwRSxPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU87WUFDckIsY0FBYyxFQUFFO2dCQUNaLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUs7Z0JBQ3pCLFNBQVMsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUs7Z0JBQzVCLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUs7Z0JBQ3pCLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUs7YUFDNUI7U0FDSixDQUFDLENBQUM7UUFFSCxTQUFTLENBQUMsS0FBSyxDQUFDLCtDQUErQyxFQUFFO1lBQzdELEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztZQUNuQixXQUFXLEVBQUUsTUFBTSxDQUFDLFdBQVc7WUFDL0IsU0FBUyxFQUFFLE1BQU0sQ0FBQyxTQUFTO1NBQzlCLENBQUMsQ0FB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UUFDeEQsTUFBTSxVQUFVLEdBQUcsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsb0JBQW9CLFVBQVUsRUFBRSxDQUFDO1FBRTdFLFFBQVEsUUFBUSxFQUFFLENBQUM7WUFDZixLQUFLLFdBQVc7Z0JBQ1osOERBQThEO2dCQUM5RCxPQUFPLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLE9BQU8sVUFBVSxpRUFBaUUsQ0FBQztZQUV6SCxLQUFLLFFBQVE7Z0JBQ1Qsa0RBQWtEO2dCQUNsRCxPQUFPLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLE9BQU8sVUFBVSxtRUFBbUUsQ0FBQztZQUUzSDtnQkFDSSxPQUFPLFVBQVUsQ0FBQztRQUMxQixDQUFDO0lBQ0wsQ0FBQztDQUNKIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZ2V0TG9nZ2VyIH0gZnJvbSAnLi4vdXRpbHMvbG9nZ2VyJztcbmltcG9ydCB7IExMTUZhY3RvcnkgfSBmcm9tICcuL2xsbS1mYWN0b3J5JztcbmltcG9ydCB7IExhbmdDaGFpbkNsaWVudCB9IGZyb20gJy4vbGFuZ2NoYWluLWNsaWVudCc7XG5cbmludGVyZmFjZSBMTE1Db25maWcge1xuICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgdGVtcGVyYXR1cmU6IG51bWJlcjtcbiAgICBtYXhUb2tlbnM6IG51bWJlcjtcbiAgICBzeXN0ZW1Qcm9tcHQ6IHN0cmluZztcbiAgICB1c2VyUHJvbXB0OiBzdHJpbmc7XG59XG5cbi8vIEdldCB0aGUgbG9nZ2VyIGZvciBMTE0gb3BlcmF0aW9uc1xuY29uc3QgbGxtTG9nZ2VyID0gZ2V0TG9nZ2VyKCdMTE0nKTtcblxuZXhwb3J0IGNsYXNzIFRyYW5zY3JpcHRTdW1tYXJpemVyIHtcbiAgICBwcml2YXRlIGNvbmZpZzogTExNQ29uZmlnO1xuICAgIHByaXZhdGUgYXBpS2V5czogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICBwcml2YXRlIGxsbUZhY3Rvcnk6IExMTUZhY3Rvcnk7XG5cbiAgICBjb25zdHJ1Y3Rvcihjb25maWc6IExMTUNvbmZpZywgYXBpS2V5czogUmVjb3JkPHN0cmluZywgc3RyaW5nPikge1xuICAgICAgICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgICAgICAgdGhpcy5hcGlLZXlzID0gYXBpS2V5cztcbiAgICAgICAgXG4gICAgICAgIC8vIEluaXRpYWxpemUgdGhlIExMTSBmYWN0b3J5XG4gICAgICAgIHRoaXMubGxtRmFjdG9yeSA9IG5ldyBMTE1GYWN0b3J5KHtcbiAgICAgICAgICAgIHNlbGVjdGVkTExNOiAnb3BlbmFpJywgLy8gRGVmYXVsdCwgd2lsbCBiZSBvdmVycmlkZGVuIGluIHN1bW1hcml6ZSgpXG4gICAgICAgICAgICBhcGlLZXlzOiB0aGlzLmFwaUtleXMsXG4gICAgICAgICAgICBzZWxlY3RlZE1vZGVsczoge1xuICAgICAgICAgICAgICAgIG9wZW5haTogdGhpcy5jb25maWcubW9kZWwsXG4gICAgICAgICAgICAgICAgYW50aHJvcGljOiB0aGlzLmNvbmZpZy5tb2RlbCxcbiAgICAgICAgICAgICAgICBnb29nbGU6IHRoaXMuY29uZmlnLm1vZGVsLFxuICAgICAgICAgICAgICAgIG9sbGFtYTogdGhpcy5jb25maWcubW9kZWxcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICBsbG1Mb2dnZXIuZGVidWcoJ1RyYW5zY3JpcHRTdW1tYXJpemVyIGluaXRpYWxpemVkIHdpdGggY29uZmlnOicsIHtcbiAgICAgICAgICAgIG1vZGVsOiBjb25maWcubW9kZWwsXG4gICAgICAgICAgICB0ZW1wZXJhdHVyZTogY29uZmlnLnRlbXBlcmF0dXJlLFxuICAgICAgICAgICAgbWF4VG9rZW5zOiBjb25maWcubWF4VG9rZW5zXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGFzeW5jIHN1bW1hcml6ZSh0cmFuc2NyaXB0OiBzdHJpbmcsIHByb3ZpZGVyOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGxtTG9nZ2VyLmluZm8oXCJTdGFydGluZyBzdW1tYXJpemF0aW9uIHdpdGggcHJvdmlkZXI6XCIsIHByb3ZpZGVyKTtcbiAgICAgICAgICAgIGxsbUxvZ2dlci5pbmZvKFwiVHJhbnNjcmlwdCBsZW5ndGg6XCIsIHRyYW5zY3JpcHQubGVuZ3RoKTtcbiAgICAgICAgICAgIGxsbUxvZ2dlci5pbmZvKFwiTW9kZWw6XCIsIHRoaXMuY29uZmlnLm1vZGVsKTtcbiAgICAgICAgICAgIGxsbUxvZ2dlci5pbmZvKFwiVGVtcGVyYXR1cmU6XCIsIHRoaXMuY29uZmlnLnRlbXBlcmF0dXJlKTtcbiAgICAgICAgICAgIGxsbUxvZ2dlci5pbmZvKFwiTWF4IHRva2VuczpcIiwgdGhpcy5jb25maWcubWF4VG9rZW5zKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIEFQSSBrZXkgZXhpc3RzIGJlZm9yZSBwcm9jZWVkaW5nXG4gICAgICAgICAgICBpZiAoIXRoaXMuYXBpS2V5c1twcm92aWRlcl0gfHwgdGhpcy5hcGlLZXlzW3Byb3ZpZGVyXS50cmltKCkgPT09ICcnKSB7XG4gICAgICAgICAgICAgICAgbGxtTG9nZ2VyLmVycm9yKGBBUEkga2V5IG1pc3NpbmcgZm9yIHByb3ZpZGVyOiAke3Byb3ZpZGVyfWApO1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQVBJIGtleSBmb3IgJHtwcm92aWRlcn0gaXMgbWlzc2luZyBvciBlbXB0eS5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gSW1wb3J0YW50OiBDaGVjayBpZiB0aGUgdHJhbnNjcmlwdCBjb250YWlucyByZWZlcmVuY2UgbWF0ZXJpYWwgc2VjdGlvblxuICAgICAgICAgICAgLy8gSWYgaXQgZG9lcywgd2UgbmVlZCB0byBleHRyYWN0IHRoZSB1c2VyIHByb21wdCBhbmQgdHJhbnNjcmlwdFxuICAgICAgICAgICAgbGV0IHVzZXJQcm9tcHQgPSB0aGlzLmNvbmZpZy51c2VyUHJvbXB0O1xuICAgICAgICAgICAgbGV0IGFjdHVhbFRyYW5zY3JpcHQgPSB0cmFuc2NyaXB0O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBVc2UgYSByZWdleCBwYXR0ZXJuIHdpdGhvdXQgdGhlICdzJyBmbGFnICh3aGljaCBpcyBFUzIwMTgrKVxuICAgICAgICAgICAgLy8gSW5zdGVhZCB1c2UgW1xcc1xcU10qIHRvIG1hdGNoIGFueSBjaGFyYWN0ZXIgaW5jbHVkaW5nIG5ld2xpbmVzXG4gICAgICAgICAgICBjb25zdCByZWZlcmVuY2VQYXR0ZXJuID0gLy17NSx9XFxzKlJFRkVSRU5DRSBNQVRFUklBTFtcXHNcXFNdKj8tezUsfVxccypFTkQgUkVGRVJFTkNFIE1BVEVSSUFMXFxzKi17NSx9LztcbiAgICAgICAgICAgIGNvbnN0IHJlZmVyZW5jZU1hdGNoID0gdHJhbnNjcmlwdC5tYXRjaChyZWZlcmVuY2VQYXR0ZXJuKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHJlZmVyZW5jZU1hdGNoKSB7XG4gICAgICAgICAgICAgICAgbGxtTG9nZ2VyLmRlYnVnKFwiRGV0ZWN0ZWQgcmVmZXJlbmNlIG1hdGVyaWFsIGluIHRyYW5zY3JpcHQgLSBleHRyYWN0aW5nIGFjdHVhbCBjb250ZW50XCIpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIEV4dHJhY3QgdGhlIGFjdHVhbCBjb250ZW50IGZyb20gdGhlIHRyYW5zY3JpcHQgKGNvbnRlbnQgYmVmb3JlIHRoZSByZWZlcmVuY2UgbWF0ZXJpYWwpXG4gICAgICAgICAgICAgICAgY29uc3QgcGFydHMgPSB0cmFuc2NyaXB0LnNwbGl0KHJlZmVyZW5jZVBhdHRlcm4pO1xuICAgICAgICAgICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFRoZSBjb250ZW50IGJlZm9yZSB0aGUgcmVmZXJlbmNlIHNlY3Rpb24gY29udGFpbnMgdGhlIGFjdHVhbCBwcm9tcHQgKyBjb250ZW50XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnRQYXJ0cyA9IHBhcnRzWzBdLnRyaW0oKS5zcGxpdChcIlxcblxcblwiKTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIC8vIEV4dHJhY3QgdXNlciBwcm9tcHQgaWYgaXQncyBhdCB0aGUgYmVnaW5uaW5nIChmb3JtYXQgbWF0Y2hlcyBleHBlY3RlZClcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnRQYXJ0cy5sZW5ndGggPj0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdXNlclByb21wdCA9IGNvbnRlbnRQYXJ0c1swXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjdHVhbFRyYW5zY3JpcHQgPSBjb250ZW50UGFydHMuc2xpY2UoMSkuam9pbihcIlxcblxcblwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxsbUxvZ2dlci5kZWJ1ZyhcIkV4dHJhY3RlZCB1c2VyIHByb21wdCBhbmQgY29udGVudCBmcm9tIHRyYW5zY3JpcHRcIik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBKdXN0IHVzZSBldmVyeXRoaW5nIGJlZm9yZSByZWZlcmVuY2UgYXMgdGhlIGNvbnRlbnRcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjdHVhbFRyYW5zY3JpcHQgPSBwYXJ0c1swXS50cmltKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsbG1Mb2dnZXIuZGVidWcoXCJVc2luZyBjb250ZW50IGJlZm9yZSByZWZlcmVuY2Ugc2VjdGlvbiBhcyB0cmFuc2NyaXB0XCIpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBTcGVjaWFsIGhhbmRsaW5nIGZvciBPbGxhbWEgd2hpY2ggZG9lc24ndCB1c2UgTGFuZ0NoYWluIGludGVncmF0aW9uXG4gICAgICAgICAgICBpZiAocHJvdmlkZXIgPT09ICdvbGxhbWEnKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuc3VtbWFyaXplV2l0aE9sbGFtYShhY3R1YWxUcmFuc2NyaXB0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRm9yIGFsbCBvdGhlciBwcm92aWRlcnMsIHVzZSBMYW5nQ2hhaW5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnN1bW1hcml6ZVdpdGhMYW5nQ2hhaW4oYWN0dWFsVHJhbnNjcmlwdCwgcHJvdmlkZXIsIHVzZXJQcm9tcHQpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGxtTG9nZ2VyLmVycm9yKFwiRXJyb3IgaW4gc3VtbWFyaXplOlwiLCBlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBVc2UgTGFuZ0NoYWluIGZvciBzdW1tYXJpemF0aW9uIHdpdGggT3BlbkFJLCBBbnRocm9waWMsIG9yIEdvb2dsZVxuICAgICAqL1xuICAgIHByaXZhdGUgYXN5bmMgc3VtbWFyaXplV2l0aExhbmdDaGFpbih0cmFuc2NyaXB0OiBzdHJpbmcsIHByb3ZpZGVyOiBzdHJpbmcsIHVzZXJQcm9tcHQ/OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGxtTG9nZ2VyLmluZm8oYFVzaW5nIExhbmdDaGFpbiBmb3IgJHtwcm92aWRlcn0gc3VtbWFyaXphdGlvbmApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBsYW5nQ2hhaW5DbGllbnQgPSBuZXcgTGFuZ0NoYWluQ2xpZW50KHtcbiAgICAgICAgICAgICAgICBwcm92aWRlcjogcHJvdmlkZXIsXG4gICAgICAgICAgICAgICAgbW9kZWw6IHRoaXMuY29uZmlnLm1vZGVsLFxuICAgICAgICAgICAgICAgIGFwaUtleTogdGhpcy5hcGlLZXlzW3Byb3ZpZGVyXSxcbiAgICAgICAgICAgICAgICB0ZW1wZXJhdHVyZTogdGhpcy5jb25maWcudGVtcGVyYXR1cmUsXG4gICAgICAgICAgICAgICAgbWF4VG9rZW5zOiB0aGlzLmNvbmZpZy5tYXhUb2tlbnNcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBwcm9tcHRUb1VzZSA9IHVzZXJQcm9tcHQgfHwgdGhpcy5jb25maWcudXNlclByb21wdDtcbiAgICAgICAgICAgIGNvbnN0IHVzZXJQcm9tcHRXaXRoVHJhbnNjcmlwdCA9IGAke3Byb21wdFRvVXNlfVxcblxcblRyYW5zY3JpcHQ6XFxuJHt0cmFuc2NyaXB0fWA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGxhbmdDaGFpbkNsaWVudC5nZW5lcmF0ZUNvbXBsZXRpb24oXG4gICAgICAgICAgICAgICAgdGhpcy5jb25maWcuc3lzdGVtUHJvbXB0LFxuICAgICAgICAgICAgICAgIHVzZXJQcm9tcHRXaXRoVHJhbnNjcmlwdFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxsbUxvZ2dlci5lcnJvcihgRXJyb3IgaW4gTGFuZ0NoYWluIHN1bW1hcml6YXRpb24gd2l0aCAke3Byb3ZpZGVyfTpgLCBlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBVc2UgdGhlIE9sbGFtYSBjbGllbnQgZGlyZWN0bHkgKG5vdCBzdXBwb3J0ZWQgYnkgTGFuZ0NoYWluIGluIHRoaXMgaW1wbGVtZW50YXRpb24pXG4gICAgICovXG4gICAgcHJpdmF0ZSBhc3luYyBzdW1tYXJpemVXaXRoT2xsYW1hKHRyYW5zY3JpcHQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgICAgIGNvbnN0IGNsaWVudCA9IHRoaXMubGxtRmFjdG9yeS5nZXRPbGxhbWFDbGllbnQoKTtcbiAgICAgICAgXG4gICAgICAgIC8vIENoZWNrIGlmIHNlcnZlciBpcyBydW5uaW5nXG4gICAgICAgIGNvbnN0IGlzUnVubmluZyA9IGF3YWl0IGNsaWVudC52YWxpZGF0ZUNvbm5lY3Rpb24oKTtcbiAgICAgICAgaWYgKCFpc1J1bm5pbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIk9sbGFtYSBzZXJ2ZXIgaXMgbm90IGFjY2Vzc2libGUuIFBsZWFzZSBlbnN1cmUgT2xsYW1hIGlzIHJ1bm5pbmcgYW5kIGFjY2Vzc2libGUuXCIpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBUcnkgdGhlIGNoYXQgY29tcGxldGlvbiBBUEkgZmlyc3QgKGJldHRlciBmb3IgbmV3ZXIgbW9kZWxzKVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjbGllbnQuY3JlYXRlQ2hhdENvbXBsZXRpb24oXG4gICAgICAgICAgICAgICAgdGhpcy5jb25maWcubW9kZWwsXG4gICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICB7IHJvbGU6IFwic3lzdGVtXCIsIGNvbnRlbnQ6IHRoaXMuY29uZmlnLnN5c3RlbVByb21wdCB9LFxuICAgICAgICAgICAgICAgICAgICB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiB0aGlzLmNvbmZpZy51c2VyUHJvbXB0ICsgXCJcXG5cXG5UcmFuc2NyaXB0OlxcblwiICsgdHJhbnNjcmlwdCB9XG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIHRlbXBlcmF0dXJlOiB0aGlzLmNvbmZpZy50ZW1wZXJhdHVyZSxcbiAgICAgICAgICAgICAgICAgICAgbWF4X3Rva2VuczogdGhpcy5jb25maWcubWF4VG9rZW5zXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlLmNob2ljZXNbMF0ubWVzc2FnZS5jb250ZW50IHx8IFwiXCI7XG4gICAgICAgIH0gY2F0Y2ggKGNoYXRFcnJvcikge1xuICAgICAgICAgICAgLy8gRmFsbGJhY2sgdG8gc2ltcGxpZmllZCBhcHByb2FjaFxuICAgICAgICAgICAgbGxtTG9nZ2VyLndhcm4oXCJPbGxhbWEgY2hhdCBjb21wbGV0aW9uIGZhaWxlZDpcIiwgY2hhdEVycm9yKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIk9sbGFtYSBjaGF0IGNvbXBsZXRpb24gZmFpbGVkLiBQbGVhc2UgY2hlY2sgeW91ciBjb25maWd1cmF0aW9uIGFuZCBlbnN1cmUgT2xsYW1hIGlzIHJ1bm5pbmcuXCIpO1xuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZvcm1hdCB0aGUgcHJvbXB0IGJhc2VkIG9uIHRoZSBwcm92aWRlclxuICAgICAqL1xuICAgIHByaXZhdGUgZm9ybWF0UHJvbXB0KHRyYW5zY3JpcHQ6IHN0cmluZywgcHJvdmlkZXI6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgICAgIC8vIERpZmZlcmVudCBwcm92aWRlcnMgbWF5IG5lZWQgZGlmZmVyZW50IHByb21wdCBmb3JtYXRzXG4gICAgICAgIGNvbnN0IGJhc2VQcm9tcHQgPSBgJHt0aGlzLmNvbmZpZy51c2VyUHJvbXB0fVxcblxcblRyYW5zY3JpcHQ6XFxuJHt0cmFuc2NyaXB0fWA7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKHByb3ZpZGVyKSB7XG4gICAgICAgICAgICBjYXNlICdhbnRocm9waWMnOlxuICAgICAgICAgICAgICAgIC8vIENsYXVkZSB0ZW5kcyB0byB3b3JrIGJldHRlciB3aXRoIG1vcmUgZXhwbGljaXQgaW5zdHJ1Y3Rpb25zXG4gICAgICAgICAgICAgICAgcmV0dXJuIGAke3RoaXMuY29uZmlnLnN5c3RlbVByb21wdH1cXG5cXG4ke2Jhc2VQcm9tcHR9XFxuXFxuUGxlYXNlIHByb3ZpZGUgYSBjb21wcmVoZW5zaXZlIGFuZCB3ZWxsLXN0cnVjdHVyZWQgc3VtbWFyeS5gO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnb2xsYW1hJzpcbiAgICAgICAgICAgICAgICAvLyBMb2NhbCBtb2RlbHMgb2Z0ZW4gbmVlZCBtb3JlIGV4cGxpY2l0IHByb21wdGluZ1xuICAgICAgICAgICAgICAgIHJldHVybiBgJHt0aGlzLmNvbmZpZy5zeXN0ZW1Qcm9tcHR9XFxuXFxuJHtiYXNlUHJvbXB0fVxcblxcblN1bW1hcml6ZSB0aGUgdHJhbnNjcmlwdCBhYm92ZSBpbiBhIGNsZWFyLCBzdHJ1Y3R1cmVkIGZvcm1hdC5gO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICByZXR1cm4gYmFzZVByb21wdDtcbiAgICAgICAgfVxuICAgIH1cbn0gIl19