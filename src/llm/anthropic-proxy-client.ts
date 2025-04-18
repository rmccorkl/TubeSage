import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('ANTHROPIC_PROXY');

/**
 * A direct implementation of Anthropic's API that doesn't use their SDK
 * This avoids the browser environment check that prevents usage in Obsidian
 */
export class AnthropicProxyClient {
  private apiKey: string;
  private baseUrl: string = "https://api.anthropic.com";
  private apiVersion: string = "2023-06-01";
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
    logger.debug("Created Anthropic proxy client");
  }
  
  /**
   * Send a message to Anthropic's Claude API directly
   */
  async createMessage(params: {
    model: string;
    system?: string;
    messages: { role: string; content: string }[];
    max_tokens?: number;
    temperature?: number;
  }): Promise<any> {
    try {
      const url = `${this.baseUrl}/v1/messages`;
      logger.debug(`Sending request to ${url}`);
      
      const response = await obsidianFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          "anthropic-version": this.apiVersion
        },
        body: JSON.stringify(params)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        logger.error('Anthropic API error:', errorData);
        throw new Error(`Anthropic API error: ${errorData.error?.message || JSON.stringify(errorData)}`);
      }
      
      return response.json();
    } catch (error) {
      logger.error(`Error in AnthropicProxyClient.createMessage:`, error);
      throw error;
    }
  }
  
  /**
   * Generate a completion with Claude
   */
  async generateCompletion(
    systemPrompt: string, 
    userPrompt: string, 
    options: {
      model: string;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<string> {
    try {
      logger.debug(`Generating completion with model ${options.model}`);
      
      const response = await this.createMessage({
        model: options.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: options.maxTokens,
        temperature: options.temperature
      });
      
      if (!response.content || !response.content[0] || !response.content[0].text) {
        throw new Error("Invalid response from Anthropic API");
      }
      
      return response.content[0].text;
    } catch (error) {
      logger.error("Error generating completion:", error);
      throw error;
    }
  }
} 