import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('GEMINI');

/**
 * Client for Google's Gemini API
 */
export class GeminiClient {
  private apiKey: string;
  private baseUrl = "https://generativelanguage.googleapis.com";
  private apiVersion = "v1";
  
  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('Google API key is required');
    }
    
    this.apiKey = apiKey;
    logger.debug('Creating Gemini client');
  }

  /**
   * Check if the client can be used on the current platform
   */
  isAvailable(): boolean {
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
  async generateContent(model: string, prompt: string, options: any = {}) {
    try {
      const url = `${this.baseUrl}/${this.apiVersion}/models/${model}:generateContent?key=${this.apiKey}`;
      
      // Initialize request body
      const requestBody: any = {
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
      
      const response = await obsidianFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        logger.error('Gemini API error:', errorData);
        throw new Error(`Gemini API error: ${errorData.error?.message || JSON.stringify(errorData)}`);
      }
      
      return response.json();
    } catch (error) {
      logger.error('Error in generateContent:', error);
      throw error;
    }
  }
  
  /**
   * Extract the generated text from a Gemini API response
   * 
   * @param response The raw API response
   * @returns The generated text
   */
  extractText(response: any): string {
    try {
      if (!response || !response.candidates || !response.candidates[0]) {
        return '';
      }
      
      const candidate = response.candidates[0];
      if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
        return '';
      }
      
      return candidate.content.parts[0].text || '';
    } catch (error) {
      logger.error('Error extracting text from Gemini response:', error);
      return '';
    }
  }
} 