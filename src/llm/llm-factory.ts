import { getLogger } from "../utils/logger";
import { OpenAIWrapper } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { GeminiClient } from "./gemini-client";
import { OllamaClient } from "./ollama-client";

const logger = getLogger('LLM_FACTORY');

/**
 * Settings interface needed by the factory
 */
export interface LLMSettings {
  selectedLLM: string;
  apiKeys: Record<string, string>;
  selectedModels: Record<string, string>;
}

/**
 * Factory for creating and managing LLM clients
 */
export class LLMFactory {
  private settings: LLMSettings;
  private openaiClient: OpenAIWrapper | null = null;
  private anthropicClient: AnthropicClient | null = null;
  private geminiClient: GeminiClient | null = null;
  private ollamaClient: OllamaClient | null = null;
  
  constructor(settings: LLMSettings) {
    this.settings = settings;
    logger.debug('Created LLM Factory');
  }
  
  /**
   * Get the selected LLM provider
   * @returns The provider ID
   */
  getBestProvider(): string {
    return this.settings.selectedLLM;
  }
  
  /**
   * Get the OpenAI client
   */
  getOpenAIClient(): OpenAIWrapper {
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
  getAnthropicClient(): AnthropicClient {
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
  getGeminiClient(): GeminiClient {
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
  getOllamaClient(): OllamaClient {
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
  getClient(provider: string): OpenAIWrapper | AnthropicClient | GeminiClient | OllamaClient {
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
  updateSettings(settings: LLMSettings): void {
    this.settings = settings;
    
    // Reset clients so they're recreated with new settings on next access
    this.openaiClient = null;
    this.anthropicClient = null;
    this.geminiClient = null;
    this.ollamaClient = null;
    
    logger.debug('LLM Factory settings updated');
  }
} 
