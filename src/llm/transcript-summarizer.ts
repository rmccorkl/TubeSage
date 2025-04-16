import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RunnableSequence } from '@langchain/core/runnables';
import { ChatOllama } from '@langchain/community/chat_models/ollama';
import { startLocalProxy, stopLocalProxy, getProxyUrl } from '../proxy/anthropic-proxy';
import { getLogger } from '../utils/logger';

interface LLMConfig {
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
    userPrompt: string;
}

interface LLMResponse {
    content: string;
}

// Get the logger for LLM operations
const llmLogger = getLogger('LLM');

export class TranscriptSummarizer {
    private config: LLMConfig;
    private apiKeys: Record<string, string>;
    private proxyStarted: boolean = false;

    constructor(config: LLMConfig, apiKeys: Record<string, string>) {
        this.config = config;
        this.apiKeys = apiKeys;
    }

    private getLLM(provider: string) {
        const baseConfig = {
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            apiKey: this.apiKeys[provider]
        };

        switch (provider) {
            case 'openai':
                return new ChatOpenAI({
                    ...baseConfig,
                    modelName: this.config.model
                });
            case 'anthropic':
                // For Anthropic, we'll use a local proxy
                // Return null as we'll handle it separately
                return null;
            case 'google':
                return new ChatGoogleGenerativeAI({
                    ...baseConfig,
                    modelName: this.config.model
                });
            case 'ollama':
                return new ChatOllama({
                    temperature: this.config.temperature,
                    baseUrl: this.apiKeys.ollama,
                    model: this.config.model,
                    numPredict: this.config.maxTokens
                });
            default:
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }
    }

    private createPrompt() {
        return ChatPromptTemplate.fromMessages([
            new SystemMessage(this.config.systemPrompt),
            new MessagesPlaceholder('transcript'),
            new HumanMessage(this.config.userPrompt)
        ]);
    }

    private async callAnthropicViaProxy(transcript: string): Promise<string> {
        const apiKey = this.apiKeys.anthropic;
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('Anthropic API key is missing or empty.');
        }

        try {
            // Start the proxy server if not already running
            if (!this.proxyStarted) {
                llmLogger.info("Starting Anthropic proxy server");
                try {
                    await startLocalProxy(apiKey);
                    this.proxyStarted = true;
                } catch (proxyError) {
                    llmLogger.error("Failed to start proxy server:", proxyError);
                    throw new Error(`Failed to start Anthropic proxy server: ${proxyError.message}. Make sure Node.js is installed and accessible.`);
                }
            }

            const proxyUrl = getProxyUrl();
            llmLogger.info(`Using proxy server at ${proxyUrl}`);
            
            // Make the request to our local proxy
            try {
                const response = await fetch(`${proxyUrl}/v1/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: this.config.model,
                        max_tokens: this.config.maxTokens,
                        temperature: this.config.temperature,
                        messages: [
                            {
                                role: "user",
                                content: `${this.config.systemPrompt}\n\n${this.config.userPrompt}\n\nTranscript:\n${transcript}`
                            }
                        ]
                    })
                });

                if (!response.ok) {
                    let errorMessage = 'Anthropic API error';
                    try {
                        const errorData = await response.json();
                        llmLogger.error("[DEBUG-LLM] API response error:", errorData);
                        errorMessage = `Anthropic API error: ${errorData.error?.message || JSON.stringify(errorData)}`;
                    } catch (e) {
                        errorMessage = `Anthropic API error: ${response.status} ${response.statusText}`;
                    }
                    throw new Error(errorMessage);
                }

                const data = await response.json();
                llmLogger.info("[DEBUG-LLM] Received response from Anthropic API via proxy");
                
                const content = data.content[0];
                if (content && content.type === 'text') {
                    return content.text;
                } else {
                    throw new Error('Unexpected response format from Anthropic API');
                }
            } catch (fetchError) {
                if (fetchError.message.includes('Failed to fetch') || 
                    fetchError.message.includes('NetworkError') ||
                    fetchError.message.includes('ECONNREFUSED')) {
                    llmLogger.error("[DEBUG-LLM] Network error:", fetchError.message);
                    
                    // Try to restart the proxy server
                    try {
                        await stopLocalProxy();
                        this.proxyStarted = false;
                        await startLocalProxy(apiKey);
                        this.proxyStarted = true;
                        throw new Error(`Network error connecting to Anthropic API proxy. Proxy server has been restarted. Please try again.`);
                    } catch (restartError) {
                        llmLogger.error("[DEBUG-LLM] Failed to restart proxy:", restartError);
                        throw new Error(`Proxy server connection error. Please ensure Node.js is available and can be found in a relative path from Obsidian.`);
                    }
                }
                throw fetchError;
            }
        } catch (error: any) {
            llmLogger.error("[DEBUG-LLM] Anthropic API error:", error);
            throw error;
        }
    }

    async summarize(transcript: string, provider: string): Promise<string> {
        try {
            // Start proxy server if using Anthropic and not already started
            if (provider === 'anthropic' && !this.proxyStarted) {
                const apiKey = this.apiKeys.anthropic;
                if (!apiKey || apiKey.trim() === '') {
                    throw new Error('Anthropic API key is missing or empty.');
                }

                try {
                    llmLogger.info("Starting Anthropic proxy server");
                    await startLocalProxy(apiKey);
                    this.proxyStarted = true;
                } catch (proxyError) {
                    llmLogger.error("Failed to start proxy server:", proxyError);
                    throw new Error(`Failed to start Anthropic proxy server: ${proxyError.message}. Make sure Node.js is installed and accessible.`);
                }
            }

            llmLogger.info("Starting summarization with provider:", provider);
            llmLogger.info("Transcript length:", transcript.length);
            llmLogger.info("Model:", this.config.model);
            llmLogger.info("Temperature:", this.config.temperature);
            llmLogger.info("Max tokens:", this.config.maxTokens);
            
            // Check if the API key/URL exists
            if (provider === 'ollama') {
                if (!this.apiKeys[provider] || this.apiKeys[provider].trim() === '') {
                    llmLogger.error("[DEBUG-LLM] Ollama base URL is missing");
                    throw new Error(`Ollama base URL is missing or empty. Please configure it in settings.`);
                }
            } else {
                if (!this.apiKeys[provider] || this.apiKeys[provider].trim() === '') {
                    llmLogger.error("[DEBUG-LLM] API key is missing for provider:", provider);
                    throw new Error(`API key for ${provider} is missing or empty.`);
                }
            }
            
            llmLogger.info("[DEBUG-LLM] API key/URL check passed");
            
            if (provider === 'anthropic') {
                return await this.callAnthropicViaProxy(transcript);
            } else {
                const llm = this.getLLM(provider);
                llmLogger.info("[DEBUG-LLM] LLM instance created");
                
                const prompt = this.createPrompt();
                
                const chain = RunnableSequence.from([
                    prompt,
                    llm
                ]);
                llmLogger.info("[DEBUG-LLM] Chain created, preparing to invoke");
                
                try {
                    llmLogger.info("[DEBUG-LLM] Calling LLM with transcript of length:", transcript.length);
                    const response = await chain.invoke({
                        transcript
                    });
                    
                    llmLogger.info("[DEBUG-LLM] Received response from LLM");
                    if (response) {
                        llmLogger.info("[DEBUG-LLM] Response type:", typeof response);
                        llmLogger.info("[DEBUG-LLM] Response has content:", (response as any).content ? "yes" : "no");
                        const content = (response as LLMResponse).content || "";
                        llmLogger.info("[DEBUG-LLM] Response content length:", content.length);
                        llmLogger.info("[DEBUG-LLM] --- End of LLM response ---");
                    } else {
                        llmLogger.error("[DEBUG-LLM] Response is null or undefined");
                    }
                    
                    return (response as LLMResponse).content;
                } catch (error) {
                    llmLogger.error("[DEBUG-LLM] Error in LLM chain:", error);
                    throw error;
                }
            }
        } catch (error) {
            llmLogger.error("[DEBUG-LLM] Error in summarize:", error);
            throw error;
        }
    }
} 