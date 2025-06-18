import { __awaiter } from "tslib";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getLogger } from "../utils/logger";
import { getLangChainConfiguration } from "./langchain-fetcher";
import { obsidianFetch } from "../utils/fetch-shim";
const logger = getLogger('LANGCHAIN');
/**
 * A unified client for multiple LLM providers using LangChain
 */
export class LangChainClient {
    constructor(options) {
        var _a, _b;
        this.provider = options.provider;
        this.model = options.model;
        this.apiKey = options.apiKey;
        this.temperature = (_a = options.temperature) !== null && _a !== void 0 ? _a : 0.7;
        this.maxTokens = (_b = options.maxTokens) !== null && _b !== void 0 ? _b : 1024;
        logger.debug(`Creating LangChain client for ${this.provider} with model ${this.model}`);
    }
    /**
     * Generate a completion using the appropriate LangChain model
     */
    generateCompletion(systemPrompt, userPrompt) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Common configuration with our custom fetcher
                const config = getLangChainConfiguration({
                    temperature: this.temperature,
                    apiKey: this.apiKey
                });
                // Create messages in LangChain format
                const messages = [
                    new SystemMessage(systemPrompt),
                    new HumanMessage(userPrompt)
                ];
                switch (this.provider) {
                    case 'openai': {
                        logger.debug(`Using OpenAI with model ${this.model}`);
                        // OpenAI uses 'maxTokens'
                        const model = new ChatOpenAI(Object.assign(Object.assign({}, config), { modelName: this.model, maxTokens: this.maxTokens }));
                        // TODO: Revisit this type casting when LangChain's type definitions are more stable
                        // Type cast to any[] is needed because LangChain's type definitions for invoke()
                        // expect an array type that's not directly compatible with (SystemMessage | HumanMessage)[]
                        const response = yield model.invoke(messages);
                        return String(response.content);
                    }
                    case 'anthropic': {
                        logger.debug(`Using Anthropic with model ${this.model}`);
                        // Call Anthropic directly with our shim instead of using their SDK
                        // This bypasses their browser environment detection completely
                        try {
                            // Debug what's actually in these message objects
                            logger.debug("Message format debug:", messages.map(m => ({
                                type: m.constructor.name,
                                keys: Object.keys(m),
                                stringified: JSON.stringify(m)
                            })));
                            // Extract original structured content
                            let systemPromptContent = '';
                            let userPromptContent = '';
                            // Get content from messages
                            for (const msg of messages) {
                                const getContent = (m) => {
                                    if (typeof m === 'string')
                                        return m;
                                    if (m === null || typeof m !== 'object')
                                        return String(m);
                                    if ('content' in m)
                                        return String(m.content);
                                    if ('text' in m)
                                        return String(m.text);
                                    if ('value' in m)
                                        return String(m.value);
                                    return JSON.stringify(m);
                                };
                                if (msg instanceof SystemMessage) {
                                    systemPromptContent = getContent(msg);
                                }
                                else if (msg instanceof HumanMessage) {
                                    userPromptContent = getContent(msg);
                                }
                            }
                            // Anthropic requires system as a top-level parameter and user messages in the array
                            // Make sure the user message preserves the structured format
                            const formattedMessages = [
                                { role: "user", content: userPromptContent }
                            ];
                            // Prepare the API request with system message as a top-level parameter
                            const payload = {
                                model: this.model,
                                messages: formattedMessages,
                                max_tokens: this.maxTokens,
                                temperature: this.temperature,
                                system: systemPromptContent // Anthropic requires system as a top-level parameter
                            };
                            // Debug logging for Anthropic - full request details
                            logger.debug(`Anthropic API Request - Model: ${this.model}`);
                            logger.debug(`System prompt (${systemPromptContent.length} chars):\n${systemPromptContent}`);
                            logger.debug(`User messages (${formattedMessages.length}):`);
                            formattedMessages.forEach((msg, i) => {
                                if (msg && msg.content) {
                                    logger.debug(`Message ${i + 1} (${String(msg.content).length} chars): ${msg.role}\n${msg.content}`);
                                }
                                else {
                                    logger.debug(`Message ${i + 1}: [Invalid or null message]`);
                                }
                            });
                            logger.debug(`Full payload: ${JSON.stringify(payload, null, 2)}`);
                            // Make the request directly using our fetch shim
                            const response = yield obsidianFetch('https://api.anthropic.com/v1/messages', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-api-key': this.apiKey,
                                    'anthropic-version': '2023-06-01'
                                },
                                body: JSON.stringify(payload)
                            });
                            // Parse the response
                            if (!response.ok) {
                                const errorText = yield response.text();
                                throw new Error(`Anthropic API error: ${errorText}`);
                            }
                            const responseData = yield response.json();
                            // Debug logging for response
                            logger.debug(`Anthropic API Response: ${JSON.stringify(responseData, null, 2)}`);
                            if (!responseData.content || !responseData.content[0] || !responseData.content[0].text) {
                                throw new Error('Invalid response format from Anthropic API');
                            }
                            const responseText = responseData.content[0].text;
                            logger.debug(`Anthropic response text (${responseText.length} chars):\n${responseText}`);
                            return responseText;
                        }
                        catch (error) {
                            logger.error('Error with direct Anthropic API call:', error);
                            throw error;
                        }
                    }
                    case 'google': {
                        logger.debug(`Using Google Gemini with model ${this.model}`);
                        // Google Gemini - use maxTokens as defined in the type definition
                        const model = new ChatGoogleGenerativeAI(Object.assign(Object.assign({}, config), { modelName: this.model, temperature: this.temperature, maxTokens: this.maxTokens // Using maxTokens directly
                         }));
                        // Type cast needed for compatibility with LangChain's invoke() method
                        const response = yield model.invoke(messages);
                        return String(response.content);
                    }
                    case 'ollama': {
                        logger.debug(`Using Ollama with model ${this.model}`);
                        // For Ollama, the API key is actually the base URL
                        const model = new ChatOllama(Object.assign(Object.assign({}, config), { baseUrl: this.apiKey, model: this.model, temperature: this.temperature }));
                        // Type cast needed for compatibility with LangChain's invoke() method
                        const response = yield model.invoke(messages);
                        return String(response.content);
                    }
                    default:
                        throw new Error(`Unsupported LangChain provider: ${this.provider}`);
                }
            }
            catch (error) {
                logger.error(`Error in LangChain ${this.provider} completion:`, error);
                if (error.response) {
                    logger.error(`Status: ${error.response.status}, Data:`, error.response.data);
                }
                if (error.message && error.message.includes('ERR_INVALID_ARGUMENT')) {
                    throw new Error(`Invalid request to ${this.provider} API. Please check your API key and network connection.`);
                }
                throw error;
            }
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGFuZ2NoYWluLWNsaWVudC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxhbmdjaGFpbi1jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUMvQyxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUNqRSxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDL0MsT0FBTyxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUN2RSxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDNUMsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDaEUsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBRXBELE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUV0Qzs7R0FFRztBQUNILE1BQU0sT0FBTyxlQUFlO0lBTzFCLFlBQVksT0FNWDs7UUFDQyxJQUFJLENBQUMsUUFBUSxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUM7UUFDakMsSUFBSSxDQUFDLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQzNCLElBQUksQ0FBQyxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUM3QixJQUFJLENBQUMsV0FBVyxHQUFHLE1BQUEsT0FBTyxDQUFDLFdBQVcsbUNBQUksR0FBRyxDQUFDO1FBQzlDLElBQUksQ0FBQyxTQUFTLEdBQUcsTUFBQSxPQUFPLENBQUMsU0FBUyxtQ0FBSSxJQUFJLENBQUM7UUFFM0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxpQ0FBaUMsSUFBSSxDQUFDLFFBQVEsZUFBZSxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUMxRixDQUFDO0lBRUQ7O09BRUc7SUFDRyxrQkFB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Q25ELE1BQU0sS0FBSyxHQUFHLElBQUksVUFBVSxpQ0FDdkIsTUFBTSxLQUNULE9BQU8sRUFBRSxJQUFJLENBQUMsTUFBTSxFQUNwQixLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssRUFDakIsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXLElBQzdCLENBQUM7d0JBRUgsc0VBQXNFO3dCQUN0RSxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7d0JBQzlDLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQztvQkFDbEMsQ0FBQztvQkFFRDt3QkFDRSxNQUFNLElBQUksS0FBSyxDQUFDLG1DQUFtQyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztnQkFDeEUsQ0FBQztZQUNILENBQUM7WUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO2dCQUNmLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLElBQUksQ0FBQyxRQUFRLGNBQWMsRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFFdkUsSUFBSSxLQUFLLENBQUMsUUFBUSxFQUFFLENBQUM7b0JBQ25CLE1BQU0sQ0FBQyxLQUFLLENBQUMsV0FBVyxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU0sU0FBUyxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQy9FLENBQUM7Z0JBRUQsSUFBSSxLQUFLLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLHNCQUFzQixDQUFDLEVBQUUsQ0FBQztvQkFDcEUsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsSUFBSSxDQUFDLFFBQVEseURBQXlELENBQUMsQ0FBQztnQkFDaEgsQ0FBQztnQkFFRCxNQUFNLEtBQUssQ0FBQztZQUNkLENBQUM7UUFDSCxDQUFDO0tBQUE7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENoYXRPcGVuQUkgfSBmcm9tIFwiQGxhbmdjaGFpbi9vcGVuYWlcIjtcbmltcG9ydCB7IENoYXRHb29nbGVHZW5lcmF0aXZlQUkgfSBmcm9tIFwiQGxhbmdjaGFpbi9nb29nbGUtZ2VuYWlcIjtcbmltcG9ydCB7IENoYXRPbGxhbWEgfSBmcm9tIFwiQGxhbmdjaGFpbi9vbGxhbWFcIjtcbmltcG9ydCB7IFN5c3RlbU1lc3NhZ2UsIEh1bWFuTWVzc2FnZSB9IGZyb20gXCJAbGFuZ2NoYWluL2NvcmUvbWVzc2FnZXNcIjtcbmltcG9ydCB7IGdldExvZ2dlciB9IGZyb20gXCIuLi91dGlscy9sb2dnZXJcIjtcbmltcG9ydCB7IGdldExhbmdDaGFpbkNvbmZpZ3VyYXRpb24gfSBmcm9tIFwiLi9sYW5nY2hhaW4tZmV0Y2hlclwiO1xuaW1wb3J0IHsgb2JzaWRpYW5GZXRjaCB9IGZyb20gXCIuLi91dGlscy9mZXRjaC1zaGltXCI7XG5cbmNvbnN0IGxvZ2dlciA9IGdldExvZ2dlcignTEFOR0NIQUlOJyk7XG5cbi8qKlxuICogQSB1bmlmaWVkIGNsaWVudCBmb3IgbXVsdGlwbGUgTExNIHByb3ZpZGVycyB1c2luZyBMYW5nQ2hhaW5cbiAqL1xuZXhwb3J0IGNsYXNzIExhbmdDaGFpbkNsaWVudCB7XG4gIHByaXZhdGUgcHJvdmlkZXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtb2RlbDogc3RyaW5nO1xuICBwcml2YXRlIGFwaUtleTogc3RyaW5nO1xuICBwcml2YXRlIHRlbXBlcmF0dXJlOiBudW1iZXI7XG4gIHByaXZhdGUgbWF4VG9rZW5zOiBudW1iZXI7XG4gIFxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiB7XG4gICAgcHJvdmlkZXI6IHN0cmluZztcbiAgICBtb2RlbDogc3RyaW5nO1xuICAgIGFwaUtleTogc3RyaW5nO1xuICAgIHRlbXBlcmF0dXJlPzogbnVtYmVyO1xuICAgIG1heFRva2Vucz86IG51bWJlcjtcbiAgfSkge1xuICAgIHRoaXMucHJvdmlkZXIgPSBvcHRpb25zLnByb3ZpZGVyO1xuICAgIHRoaXMubW9kZWwgPSBvcHRpb25zLm1vZGVsO1xuICAgIHRoaXMuYXBpS2V5ID0gb3B0aW9ucy5hcGlLZXk7XG4gICAgdGhpcy50ZW1wZXJhdHVyZSA9IG9wdGlvbnMudGVtcGVyYXR1cmUgPz8gMC43O1xuICAgIHRoaXMubWF4VG9rZW5zID0gb3B0aW9ucy5tYXhUb2tlbnMgPz8gMTAyNDtcbiAgICBcbiAgICBsb2dnZXIuZGVidWcoYENyZWF0aW5nIExhbmdDaGFpbiBjbGllbnQgZm9yICR7dGhpcy5wcm92aWRlcn0gd2l0aCBtb2RlbCAke3RoaXMubW9kZWx9YCk7XG4gIH1cbiAgXG4gIC8qKlxuICAgKiBHZW5lcmF0ZSBhIGNvbXBsZXRpb24gdXNpbmcgdGhlIGFwcHJvcHJpYXRlIExhbmdDaGFpbiBtb2RlbFxuICAgKi9cbiAgYXN5bmMgZ2VuZXJhdGVDb21wbGV0aW9uKHN5c3RlbVByb21wdDogc3RyaW5nLCB1c2VyUHJvbXB0OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIHRyeSB7XG4gICAgICAvLyBDb21tb24gY29uZmlndXJhdGlvbiB3aXRoIG91ciBjdXN0b20gZmV0Y2hlclxuICAgICAgY29uc3QgY29uZmlnID0gZ2V0TGFuZ0NoYWluQ29uZmlndXJhdGlvbih7XG4gICAgICAgIHRlbXBlcmF0dXJlOiB0aGlzLnRlbXBlcmF0dXJlLFxuICAgICAgICBhcGlLZXk6IHRoaXMuYXBpS2V5XG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gQ3JlYXRlIG1lc3NhZ2VzIGluIExhbmdDaGFpbiBmb3JtYXRcbiAgICAgIGNvbnN0IG1lc3NhZ2VzID0gW1xuICAgICAgICBuZXcgU3lzdGVtTWVzc2FnZShzeXN0ZW1Qcm9tcHQpLFxuICAgICAgICBuZXcgSHVtYW5NZXNzYWdlKHVzZXJQcm9tcHQpXG4gICAgICBdO1xuICAgICAgXG4gICAgICBzd2l0Y2ggKHRoaXMucHJvdmlkZXIpIHtcbiAgICAgICAgY2FzZSAnb3BlbmFpJzoge1xuICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhgVXNpbmcgT3BlbkFJIHdpdGggbW9kZWwgJHt0aGlzLm1vZGVsfWApO1xuICAgICAgICAgIC8vIE9wZW5BSSB1c2VzICdtYXhUb2tlbnMnXG4gICAgICAgICAgY29uc3QgbW9kZWwgPSBuZXcgQ2hhdE9wZW5BSSh7XG4gICAgICAgICAgICAuLi5jb25maWcsXG4gICAgICAgICAgICBtb2RlbE5hbWU6IHRoaXMubW9kZWwsXG4gICAgICAgICAgICBtYXhUb2tlbnM6IHRoaXMubWF4VG9rZW5zXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gVE9ETzogUmV2aXNpdCB0aGlzIHR5cGUgY2FzdGluZyB3aGVuIExhbmdDaGFpbidzIHR5cGUgZGVmaW5pdGlvbnMgYXJlIG1vcmUgc3RhYmxlXG4gICAgICAgICAgLy8gVHlwZSBjYXN0IHRvIGFueVtdIGlzIG5lZWRlZCBiZWNhdXNlIExhbmdDaGFpbidzIHR5cGUgZGVmaW5pdGlvbnMgZm9yIGludm9rZSgpXG4gICAgICAgICAgLy8gZXhwZWN0IGFuIGFycmF5IHR5cGUgdGhhdCdzIG5vdCBkaXJlY3RseSBjb21wYXRpYmxlIHdpdGggKFN5c3RlbU1lc3NhZ2UgfCBIdW1hbk1lc3NhZ2UpW11cbiAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IG1vZGVsLmludm9rZShtZXNzYWdlcyk7XG4gICAgICAgICAgcmV0dXJuIFN0cmluZyhyZXNwb25zZS5jb250ZW50KTtcbiAgICAgICAgfVxuICAgICAgICAgIFxuICAgICAgICBjYXNlICdhbnRocm9waWMnOiB7XG4gICAgICAgICAgbG9nZ2VyLmRlYnVnKGBVc2luZyBBbnRocm9waWMgd2l0aCBtb2RlbCAke3RoaXMubW9kZWx9YCk7XG4gICAgICAgICAgLy8gQ2FsbCBBbnRocm9waWMgZGlyZWN0bHkgd2l0aCBvdXIgc2hpbSBpbnN0ZWFkIG9mIHVzaW5nIHRoZWlyIFNES1xuICAgICAgICAgIC8vIFRoaXMgYnlwYXNzZXMgdGhlaXIgYnJvd3NlciBlbnZpcm9ubWVudCBkZXRlY3Rpb24gY29tcGxldGVseVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBEZWJ1ZyB3aGF0J3MgYWN0dWFsbHkgaW4gdGhlc2UgbWVzc2FnZSBvYmplY3RzXG4gICAgICAgICAgICBsb2dnZXIuZGVidWcoXCJNZXNzYWdlIGZvcm1hdCBkZWJ1ZzpcIiwgXG4gICAgICAgICAgICAgIG1lc3NhZ2VzLm1hcChtID0+ICh7XG4gICAgICAgICAgICAgICAgdHlwZTogbS5jb25zdHJ1Y3Rvci5uYW1lLFxuICAgICAgICAgICAgICAgIGtleXM6IE9iamVjdC5rZXlzKG0pLFxuICAgICAgICAgICAgICAgIHN0cmluZ2lmaWVkOiBKU09OLnN0cmluZ2lmeShtKVxuICAgICAgICAgICAgICB9KSlcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEV4dHJhY3Qgb3JpZ2luYWwgc3RydWN0dXJlZCBjb250ZW50XG4gICAgICAgICAgICBsZXQgc3lzdGVtUHJvbXB0Q29udGVudCA9ICcnO1xuICAgICAgICAgICAgbGV0IHVzZXJQcm9tcHRDb250ZW50ID0gJyc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEdldCBjb250ZW50IGZyb20gbWVzc2FnZXNcbiAgICAgICAgICAgIGZvciAoY29uc3QgbXNnIG9mIG1lc3NhZ2VzKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGdldENvbnRlbnQgPSAobTogU3lzdGVtTWVzc2FnZSB8IEh1bWFuTWVzc2FnZSB8IHN0cmluZyB8IG9iamVjdCB8IG51bGwpOiBzdHJpbmcgPT4ge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgbSA9PT0gJ3N0cmluZycpIHJldHVybiBtO1xuICAgICAgICAgICAgICAgIGlmIChtID09PSBudWxsIHx8IHR5cGVvZiBtICE9PSAnb2JqZWN0JykgcmV0dXJuIFN0cmluZyhtKTtcbiAgICAgICAgICAgICAgICBpZiAoJ2NvbnRlbnQnIGluIG0pIHJldHVybiBTdHJpbmcobS5jb250ZW50KTtcbiAgICAgICAgICAgICAgICBpZiAoJ3RleHQnIGluIG0pIHJldHVybiBTdHJpbmcobS50ZXh0KTsgXG4gICAgICAgICAgICAgICAgaWYgKCd2YWx1ZScgaW4gbSkgcmV0dXJuIFN0cmluZyhtLnZhbHVlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkobSk7XG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgIFxuICAgICAgICAgICAgICBpZiAobXNnIGluc3RhbmNlb2YgU3lzdGVtTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdENvbnRlbnQgPSBnZXRDb250ZW50KG1zZyk7XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAobXNnIGluc3RhbmNlb2YgSHVtYW5NZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgdXNlclByb21wdENvbnRlbnQgPSBnZXRDb250ZW50KG1zZyk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gQW50aHJvcGljIHJlcXVpcmVzIHN5c3RlbSBhcyBhIHRvcC1sZXZlbCBwYXJhbWV0ZXIgYW5kIHVzZXIgbWVzc2FnZXMgaW4gdGhlIGFycmF5XG4gICAgICAgICAgICAvLyBNYWtlIHN1cmUgdGhlIHVzZXIgbWVzc2FnZSBwcmVzZXJ2ZXMgdGhlIHN0cnVjdHVyZWQgZm9ybWF0XG4gICAgICAgICAgICBjb25zdCBmb3JtYXR0ZWRNZXNzYWdlcyA9IFtcbiAgICAgICAgICAgICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogdXNlclByb21wdENvbnRlbnQgfVxuICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gUHJlcGFyZSB0aGUgQVBJIHJlcXVlc3Qgd2l0aCBzeXN0ZW0gbWVzc2FnZSBhcyBhIHRvcC1sZXZlbCBwYXJhbWV0ZXJcbiAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSB7XG4gICAgICAgICAgICAgIG1vZGVsOiB0aGlzLm1vZGVsLFxuICAgICAgICAgICAgICBtZXNzYWdlczogZm9ybWF0dGVkTWVzc2FnZXMsXG4gICAgICAgICAgICAgIG1heF90b2tlbnM6IHRoaXMubWF4VG9rZW5zLFxuICAgICAgICAgICAgICB0ZW1wZXJhdHVyZTogdGhpcy50ZW1wZXJhdHVyZSxcbiAgICAgICAgICAgICAgc3lzdGVtOiBzeXN0ZW1Qcm9tcHRDb250ZW50IC8vIEFudGhyb3BpYyByZXF1aXJlcyBzeXN0ZW0gYXMgYSB0b3AtbGV2ZWwgcGFyYW1ldGVyXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBEZWJ1ZyBsb2dnaW5nIGZvciBBbnRocm9waWMgLSBmdWxsIHJlcXVlc3QgZGV0YWlsc1xuICAgICAgICAgICAgbG9nZ2VyLmRlYnVnKGBBbnRocm9waWMgQVBJIFJlcXVlc3QgLSBNb2RlbDogJHt0aGlzLm1vZGVsfWApO1xuICAgICAgICAgICAgbG9nZ2VyLmRlYnVnKGBTeXN0ZW0gcHJvbXB0ICgke3N5c3RlbVByb21wdENvbnRlbnQubGVuZ3RofSBjaGFycyk6XFxuJHtzeXN0ZW1Qcm9tcHRDb250ZW50fWApO1xuICAgICAgICAgICAgbG9nZ2VyLmRlYnVnKGBVc2VyIG1lc3NhZ2VzICgke2Zvcm1hdHRlZE1lc3NhZ2VzLmxlbmd0aH0pOmApO1xuICAgICAgICAgICAgZm9ybWF0dGVkTWVzc2FnZXMuZm9yRWFjaCgobXNnLCBpKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChtc2cgJiYgbXNnLmNvbnRlbnQpIHtcbiAgICAgICAgICAgICAgICBsb2dnZXIuZGVidWcoYE1lc3NhZ2UgJHtpKzF9ICgke1N0cmluZyhtc2cuY29udGVudCkubGVuZ3RofSBjaGFycyk6ICR7bXNnLnJvbGV9XFxuJHttc2cuY29udGVudH1gKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsb2dnZXIuZGVidWcoYE1lc3NhZ2UgJHtpKzF9OiBbSW52YWxpZCBvciBudWxsIG1lc3NhZ2VdYCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgbG9nZ2VyLmRlYnVnKGBGdWxsIHBheWxvYWQ6ICR7SlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMil9YCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIE1ha2UgdGhlIHJlcXVlc3QgZGlyZWN0bHkgdXNpbmcgb3VyIGZldGNoIHNoaW1cbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgb2JzaWRpYW5GZXRjaCgnaHR0cHM6Ly9hcGkuYW50aHJvcGljLmNvbS92MS9tZXNzYWdlcycsIHtcbiAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICd4LWFwaS1rZXknOiB0aGlzLmFwaUtleSxcbiAgICAgICAgICAgICAgICAnYW50aHJvcGljLXZlcnNpb24nOiAnMjAyMy0wNi0wMSdcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZClcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBQYXJzZSB0aGUgcmVzcG9uc2VcbiAgICAgICAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFudGhyb3BpYyBBUEkgZXJyb3I6ICR7ZXJyb3JUZXh0fWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCByZXNwb25zZURhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIERlYnVnIGxvZ2dpbmcgZm9yIHJlc3BvbnNlXG4gICAgICAgICAgICBsb2dnZXIuZGVidWcoYEFudGhyb3BpYyBBUEkgUmVzcG9uc2U6ICR7SlNPTi5zdHJpbmdpZnkocmVzcG9uc2VEYXRhLCBudWxsLCAyKX1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFyZXNwb25zZURhdGEuY29udGVudCB8fCAhcmVzcG9uc2VEYXRhLmNvbnRlbnRbMF0gfHwgIXJlc3BvbnNlRGF0YS5jb250ZW50WzBdLnRleHQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHJlc3BvbnNlIGZvcm1hdCBmcm9tIEFudGhyb3BpYyBBUEknKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gcmVzcG9uc2VEYXRhLmNvbnRlbnRbMF0udGV4dDtcbiAgICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhgQW50aHJvcGljIHJlc3BvbnNlIHRleHQgKCR7cmVzcG9uc2VUZXh0Lmxlbmd0aH0gY2hhcnMpOlxcbiR7cmVzcG9uc2VUZXh0fWApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2VUZXh0O1xuICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0Vycm9yIHdpdGggZGlyZWN0IEFudGhyb3BpYyBBUEkgY2FsbDonLCBlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgICBcbiAgICAgICAgY2FzZSAnZ29vZ2xlJzoge1xuICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhgVXNpbmcgR29vZ2xlIEdlbWluaSB3aXRoIG1vZGVsICR7dGhpcy5tb2RlbH1gKTtcbiAgICAgICAgICAvLyBHb29nbGUgR2VtaW5pIC0gdXNlIG1heFRva2VucyBhcyBkZWZpbmVkIGluIHRoZSB0eXBlIGRlZmluaXRpb25cbiAgICAgICAgICBjb25zdCBtb2RlbCA9IG5ldyBDaGF0R29vZ2xlR2VuZXJhdGl2ZUFJKHtcbiAgICAgICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgICAgIG1vZGVsTmFtZTogdGhpcy5tb2RlbCxcbiAgICAgICAgICAgIHRlbXBlcmF0dXJlOiB0aGlzLnRlbXBlcmF0dXJlLFxuICAgICAgICAgICAgbWF4VG9rZW5zOiB0aGlzLm1heFRva2VucyAvLyBVc2luZyBtYXhUb2tlbnMgZGlyZWN0bHlcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBUeXBlIGNhc3QgbmVlZGVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggTGFuZ0NoYWluJ3MgaW52b2tlKCkgbWV0aG9kXG4gICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBtb2RlbC5pbnZva2UobWVzc2FnZXMpO1xuICAgICAgICAgIHJldHVybiBTdHJpbmcocmVzcG9uc2UuY29udGVudCk7XG4gICAgICAgIH1cbiAgICAgICAgICAgXG4gICAgICAgIGNhc2UgJ29sbGFtYSc6IHtcbiAgICAgICAgICBsb2dnZXIuZGVidWcoYFVzaW5nIE9sbGFtYSB3aXRoIG1vZGVsICR7dGhpcy5tb2RlbH1gKTtcbiAgICAgICAgICAvLyBGb3IgT2xsYW1hLCB0aGUgQVBJIGtleSBpcyBhY3R1YWxseSB0aGUgYmFzZSBVUkxcbiAgICAgICAgICBjb25zdCBtb2RlbCA9IG5ldyBDaGF0T2xsYW1hKHtcbiAgICAgICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgICAgIGJhc2VVcmw6IHRoaXMuYXBpS2V5LCAvLyBPbGxhbWEgdXNlcyB0aGUgQVBJIGtleSBmaWVsZCB0byBzdG9yZSB0aGUgYmFzZSBVUkxcbiAgICAgICAgICAgIG1vZGVsOiB0aGlzLm1vZGVsLFxuICAgICAgICAgICAgdGVtcGVyYXR1cmU6IHRoaXMudGVtcGVyYXR1cmUsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gVHlwZSBjYXN0IG5lZWRlZCBmb3IgY29tcGF0aWJpbGl0eSB3aXRoIExhbmdDaGFpbidzIGludm9rZSgpIG1ldGhvZFxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgbW9kZWwuaW52b2tlKG1lc3NhZ2VzKTtcbiAgICAgICAgICByZXR1cm4gU3RyaW5nKHJlc3BvbnNlLmNvbnRlbnQpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIExhbmdDaGFpbiBwcm92aWRlcjogJHt0aGlzLnByb3ZpZGVyfWApO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoYEVycm9yIGluIExhbmdDaGFpbiAke3RoaXMucHJvdmlkZXJ9IGNvbXBsZXRpb246YCwgZXJyb3IpO1xuICAgICAgXG4gICAgICBpZiAoZXJyb3IucmVzcG9uc2UpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKGBTdGF0dXM6ICR7ZXJyb3IucmVzcG9uc2Uuc3RhdHVzfSwgRGF0YTpgLCBlcnJvci5yZXNwb25zZS5kYXRhKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgJiYgZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnRVJSX0lOVkFMSURfQVJHVU1FTlQnKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgcmVxdWVzdCB0byAke3RoaXMucHJvdmlkZXJ9IEFQSS4gUGxlYXNlIGNoZWNrIHlvdXIgQVBJIGtleSBhbmQgbmV0d29yayBjb25uZWN0aW9uLmApO1xuICAgICAgfVxuICAgICAgXG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbn0gIl19