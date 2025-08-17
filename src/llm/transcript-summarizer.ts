import { getLogger } from '../utils/logger';
import { LLMFactory } from './llm-factory';
import { LangChainClient } from './langchain-client';

interface LLMConfig {
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
    userPrompt: string;
}

// Get the logger for LLM operations
const llmLogger = getLogger('LLM');

export class TranscriptSummarizer {
    private config: LLMConfig;
    private apiKeys: Record<string, string>;
    private llmFactory: LLMFactory;

    constructor(config: LLMConfig, apiKeys: Record<string, string>) {
        // Validate config
        if (!config) {
            llmLogger.error('TranscriptSummarizer: config is null or undefined');
            throw new Error('TranscriptSummarizer: config is required');
        }
        
        // Add safety checks for config properties
        this.config = {
            model: config.model || 'gemini-1.5-pro',
            temperature: config.temperature !== undefined ? config.temperature : 0.7,
            maxTokens: config.maxTokens || 4096,
            systemPrompt: config.systemPrompt || 'You are a helpful assistant.',
            userPrompt: config.userPrompt || 'Please process the following content:'
        };
        
        this.apiKeys = apiKeys;
        
        // Validate that essential config properties are present
        if (!this.config.model) {
            llmLogger.error('TranscriptSummarizer: model is missing from config');
        }
        if (this.config.maxTokens === undefined || this.config.maxTokens === null) {
            llmLogger.error('TranscriptSummarizer: maxTokens is missing from config');
        }
        
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
            model: this.config.model,
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            hasSystemPrompt: !!this.config.systemPrompt,
            hasUserPrompt: !!this.config.userPrompt
        });
    }

    async summarize(transcript: string, provider: string): Promise<string> {
        try {
            // Validate inputs
            if (!provider || provider.trim() === '') {
                llmLogger.error('TranscriptSummarizer.summarize: provider is empty or undefined');
                throw new Error('Provider is required for summarization');
            }
            
            if (!transcript || transcript.trim() === '') {
                llmLogger.error('TranscriptSummarizer.summarize: transcript is empty or undefined');
                throw new Error('Transcript is required for summarization');
            }
            
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
                    } else {
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
        } catch (error) {
            llmLogger.error("Error in summarize:", error);
            throw error;
        }
    }
    
    /**
     * Use LangChain for summarization with OpenAI, Anthropic, or Google
     */
    private async summarizeWithLangChain(transcript: string, provider: string, userPrompt?: string): Promise<string> {
        try {
            llmLogger.info(`Using LangChain for ${provider} summarization`);
            
            // Enhanced debugging for Google provider tracking
            llmLogger.debug(`[summarizeWithLangChain] Provider: '${provider}'`);
            llmLogger.debug(`[summarizeWithLangChain] Model from config: '${this.config.model}'`);
            llmLogger.debug(`[summarizeWithLangChain] Model type: ${typeof this.config.model}`);
            llmLogger.debug(`[summarizeWithLangChain] API Key present for ${provider}: ${!!this.apiKeys[provider]}`);
            llmLogger.debug(`[summarizeWithLangChain] Temperature: ${this.config.temperature}, MaxTokens: ${this.config.maxTokens}`);
            llmLogger.debug(`[summarizeWithLangChain] Full config object:`, JSON.stringify(this.config, null, 2));
            
            const langChainClient = new LangChainClient({
                provider: provider,
                model: this.config.model,
                apiKey: this.apiKeys[provider],
                temperature: this.config.temperature,
                maxTokens: this.config.maxTokens
            });
            
            const promptToUse = userPrompt || this.config.userPrompt;
            const userPromptWithTranscript = `${promptToUse}\n\nTranscript:\n${transcript}`;
            
            const result = await langChainClient.generateCompletion(
                this.config.systemPrompt,
                userPromptWithTranscript
            );
            
            return result;
        } catch (error) {
            llmLogger.error(`Error in LangChain summarization with ${provider}:`, error);
            throw error;
        }
    }
    
    /**
     * Use the Ollama client directly (not supported by LangChain in this implementation)
     */
    private async summarizeWithOllama(transcript: string): Promise<string> {
        const client = this.llmFactory.getOllamaClient();
        
        // Check if server is running
        const isRunning = await client.validateConnection();
        if (!isRunning) {
            throw new Error("Ollama server is not accessible. Please ensure Ollama is running and accessible.");
        }
        
        // Try the chat completion API first (better for newer models)
        try {
            const response = await client.createChatCompletion(
                this.config.model,
                [
                    { role: "system", content: this.config.systemPrompt },
                    { role: "user", content: this.config.userPrompt + "\n\nTranscript:\n" + transcript }
                ],
                {
                    temperature: this.config.temperature,
                    max_tokens: this.config.maxTokens
                }
            );
            
            return response.choices[0].message.content || "";
        } catch (chatError) {
            // Fallback to simplified approach
            llmLogger.warn("Ollama chat completion failed:", chatError);
            throw new Error("Ollama chat completion failed. Please check your configuration and ensure Ollama is running.");
        }
    }
    
    /**
     * Format the prompt based on the provider
     */
    private formatPrompt(transcript: string, provider: string): string {
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