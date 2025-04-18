import { obsidianFetch, isPlatformMobile } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('OLLAMA');

/**
 * Client for interacting with local Ollama LLMs
 * Note: This will only work on desktop as it requires access to localhost
 */
export class OllamaClient {
  private baseUrl: string;
  
  constructor(baseUrl: string = "http://localhost:11434") {
    this.baseUrl = baseUrl;
    logger.debug('Creating Ollama client with base URL:', baseUrl);
  }

  /**
   * Check if Ollama can be used on the current platform
   * @returns true if Ollama can be used (desktop only)
   */
  isAvailable(): boolean {
    // Only available on desktop since mobile can't access localhost
    const available = !isPlatformMobile();
    
    if (!available) {
      logger.debug('Ollama is not available on mobile platforms');
    }
    
    return available;
  }
  
  /**
   * Check if the Ollama server is running
   * @returns true if the server is up and running
   */
  async isServerRunning(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    
    try {
      const response = await obsidianFetch(`${this.baseUrl}/api/tags`, {
        method: "GET"
      });
      
      return response.ok;
    } catch (error) {
      logger.error('Error checking Ollama server:', error);
      return false;
    }
  }
  
  /**
   * Get a list of all available models
   */
  async listModels() {
    if (!this.isAvailable()) {
      throw new Error('Ollama is not available on mobile platforms');
    }
    
    try {
      const response = await obsidianFetch(`${this.baseUrl}/api/tags`, {
        method: "GET"
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${errorText}`);
      }
      
      return response.json();
    } catch (error) {
      logger.error('Error listing Ollama models:', error);
      throw error;
    }
  }
  
  /**
   * Generate a completion from a prompt
   * 
   * @param model The model to use (e.g., "llama3")
   * @param prompt The prompt text
   * @param options Additional options
   * @returns The generation response
   */
  async generate(model: string, prompt: string, options: any = {}) {
    if (!this.isAvailable()) {
      throw new Error('Ollama is not available on mobile platforms');
    }
    
    try {
      const systemPrompt = options.system || '';
      
      const requestBody = {
        model: model,
        prompt: prompt,
        system: systemPrompt,
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        num_predict: options.max_tokens || 1024,
        // Add any other Ollama-specific options
        ...options
      };
      
      logger.debug(`Generating with model ${model}`);
      
      const response = await obsidianFetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${errorText}`);
      }
      
      try {
        // Get the text response first
        const responseText = await response.text();
        
        // Handle streaming responses (multiple JSON objects separated by newlines)
        if (responseText.includes('\n')) {
          logger.debug('Detected streaming response format from Ollama');
          
          // Try to combine the streaming response
          try {
            // Split by newlines and parse each line as JSON
            const jsonLines = responseText.trim().split('\n');
            let combinedContent = '';
            
            // Process each line
            for (const line of jsonLines) {
              if (line.trim()) {
                try {
                  const jsonObj = JSON.parse(line);
                  // Extract and add response content from each line
                  if (jsonObj.response) {
                    combinedContent += jsonObj.response;
                  }
                } catch (lineError) {
                  logger.debug(`Skipping invalid JSON line: ${line}`);
                }
              }
            }
            
            // Return a properly formatted response
            return {
              response: combinedContent,
              error: false
            };
          } catch (streamError) {
            logger.error('Error processing streaming response:', streamError);
            // Fallback to treating as raw text
            return {
              response: responseText.trim(),
              error: false,
              rawResponse: responseText
            };
          }
        }
        
        // If not a streaming response, try to parse as single JSON object
        try {
          return JSON.parse(responseText);
        } catch (jsonError) {
          logger.error('Failed to parse Ollama response as JSON:', jsonError);
          logger.debug('Raw response:', responseText);
          
          // Return a properly formatted response object
          return {
            response: responseText.trim(),
            error: false,
            rawResponse: responseText
          };
        }
      } catch (textError) {
        logger.error('Error reading Ollama response as text:', textError);
        throw textError;
      }
    } catch (error) {
      logger.error('Error in Ollama generate:', error);
      throw error;
    }
  }
  
  /**
   * Create a chat completion (simpler interface)
   * 
   * @param model The model to use
   * @param messages The chat messages
   * @param options Additional options
   * @returns The chat completion response
   */
  async createChatCompletion(model: string, messages: any[], options: any = {}) {
    if (!this.isAvailable()) {
      throw new Error('Ollama is not available on mobile platforms');
    }
    
    try {
      const requestBody = {
        model: model,
        messages: messages,
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        num_predict: options.max_tokens || 1024,
        // Add any other Ollama-specific options
        ...options
      };
      
      logger.debug(`Chat completion with model ${model}`);
      
      const response = await obsidianFetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${errorText}`);
      }
      
      try {
        // Get the text response first
        const responseText = await response.text();
        
        // Handle streaming responses (multiple JSON objects separated by newlines)
        if (responseText.includes('\n')) {
          logger.debug('Detected streaming response format from Ollama');
          
          // Try to combine the streaming response
          try {
            // Split by newlines and parse each line as JSON
            const jsonLines = responseText.trim().split('\n');
            let combinedContent = '';
            
            // Process each line
            for (const line of jsonLines) {
              if (line.trim()) {
                try {
                  const jsonObj = JSON.parse(line);
                  // Extract and add content from each token
                  if (jsonObj.message && jsonObj.message.content) {
                    combinedContent += jsonObj.message.content;
                  }
                } catch (lineError) {
                  logger.debug(`Skipping invalid JSON line: ${line}`);
                }
              }
            }
            
            // Return a properly formatted response
            return {
              message: {
                content: combinedContent,
                role: "assistant"
              }
            };
          } catch (streamError) {
            logger.error('Error processing streaming response:', streamError);
            
            // Fallback - treat as raw text
            return {
              message: {
                content: responseText.trim(),
                role: "assistant"
              },
              rawResponse: responseText
            };
          }
        }
        
        // If not a streaming response, try to parse as a single JSON object
        try {
          return JSON.parse(responseText);
        } catch (jsonError) {
          logger.error('Failed to parse Ollama chat response as JSON:', jsonError);
          logger.debug('Raw response:', responseText);
          
          // Extract the content and return a properly formatted response object
          const content = responseText.trim();
          return {
            message: {
              content: content,
              role: "assistant"
            },
            rawResponse: responseText
          };
        }
      } catch (textError) {
        logger.error('Error reading Ollama chat response as text:', textError);
        throw textError;
      }
    } catch (error) {
      logger.error('Error in Ollama chat completion:', error);
      throw error;
    }
  }
} 