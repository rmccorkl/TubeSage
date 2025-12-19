import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('ANTHROPIC');

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

interface AnthropicCompletionOptions {
  system?: string;
  temperature?: number;
  max_tokens?: number;
}

/**
 * Simple Anthropic API client that doesn't rely on their Node.js SDK.
 * This works on both desktop and mobile Obsidian.
 */
export class AnthropicClient {
  private apiKey: string;
  private baseUrl = "https://api.anthropic.com/v1";
  private apiVersion = "2023-06-01";
  
  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('Anthropic API key is required');
    }
    
    this.apiKey = apiKey;
    logger.debug('Creating Anthropic client');
  }

  /**
   * Check if the client can be used on the current platform
   */
  isAvailable(): boolean {
    // Anthropic should work on all platforms through our fetch shim
    return true;
  }
  
  /**
   * Create a message using Anthropic's API
   * 
   * @param params The message parameters including system, messages, and model
   * @returns The Claude API response
   */
  async createMessage(params: {
    model: string,
    system?: string,
    messages: {role: string, content: string}[],
    max_tokens?: number,
    temperature?: number
  }): Promise<unknown> {
    try {
      const response = await obsidianFetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          "anthropic-version": this.apiVersion
        },
        body: JSON.stringify(params)
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => null) as unknown;
        logger.error('Anthropic API error:', errorData);
        let errorMessage = `HTTP ${response.status}`;
        if (isRecord(errorData)) {
          const nestedError = errorData.error;
          if (isRecord(nestedError) && typeof nestedError.message === 'string') {
            errorMessage = nestedError.message;
          } else if (typeof errorData.message === 'string') {
            errorMessage = errorData.message;
          }
        }
        throw new Error(`Anthropic API error: ${errorMessage}`);
      }
      
      return await response.json() as unknown;
    } catch (error) {
      logger.error('Error in createMessage:', error);
      throw error;
    }
  }
  
  /**
   * Simplified method to generate a completion with Claude
   * 
   * @param model The Claude model to use
   * @param prompt The prompt to send
   * @param options Additional options
   * @returns The completion response
   */
  async createCompletion(model: string, prompt: string, options: AnthropicCompletionOptions = {}): Promise<unknown> {
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
  }
} 
