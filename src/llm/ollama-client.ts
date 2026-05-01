import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('OLLAMA');

interface OllamaGenerateResponse {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Simplified Ollama API client that works with local Ollama instances
 * Using the bare-bones HTTP API instead of SDKs for maximum compatibility
 */
export class OllamaClient {
  private baseUrl: string;
  
  constructor(baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    logger.debug('Ollama client created with base URL:', baseUrl);
  }

  /**
   * Check if Ollama can be used on the current platform
   */
  isAvailable(): boolean {
    // Ollama should work on all platforms with the unified fetch shim
    // However, users need to ensure their Ollama server is accessible
    // from their device (typically via localhost on same network)
    return true;
  }
  
  /**
   * Validate that the Ollama server is accessible
   */
  async validateConnection(): Promise<boolean> {
    try {
      const response = await obsidianFetch(`${this.baseUrl}/api/version`);
      if (!response.ok) {
        logger.error(`Ollama server returned error status: ${response.status}`);
        return false;
      }
      
      const data = await response.json() as unknown;
      logger.debug('Ollama version check successful:', data);
      return true;
    } catch (error) {
      logger.error('Ollama server connection failed:', error);
      return false;
    }
  }
  
  /**
   * Generate a completion from Ollama
   */
  async generateCompletion(
    model: string,
    prompt: string,
    options: {
      system?: string;
      temperature?: number;
      max_tokens?: number;
    } = {}
  ): Promise<OllamaGenerateResponse> {
    const { system, temperature = 0.7, max_tokens } = options;
    
    try {
      const requestBody: {
        model: string;
        prompt: string;
        stream: boolean;
        system?: string;
        options: {
          temperature: number;
          num_predict?: number;
        };
      } = {
        model,
        prompt,
        stream: false,
        options: {
          temperature
        }
      };
      
      // Add optional parameters if provided
      if (system) {
        requestBody.system = system;
      }
      
      if (max_tokens) {
        requestBody.options.num_predict = max_tokens;
      }
      
      const response = await obsidianFetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Ollama API error:', errorText);
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json() as OllamaGenerateResponse;
      return data;
    } catch (error) {
      logger.error('Error in Ollama generateCompletion:', error);
      throw error;
    }
  }
  
  /**
   * Create a chat completion - wrapper around generate for more OpenAI-like interface
   */
  async createChatCompletion(
    model: string, 
    messages: Array<{role: string; content: string}>,
    options: {
      temperature?: number;
      max_tokens?: number;
      system?: string;
    } = {}
  ): Promise<OllamaChatCompletion> {
    try {
      // Extract system message if present
      let systemPrompt = options.system || '';
      if (!systemPrompt && messages.length > 0 && messages[0].role === 'system') {
        systemPrompt = messages[0].content;
        messages = messages.slice(1);
      }
      
      // Format the messages into a prompt
      let prompt = '';
      messages.forEach(message => {
        if (message.role === 'user') {
          prompt += `\nHuman: ${message.content}`;
        } else if (message.role === 'assistant') {
          prompt += `\nAssistant: ${message.content}`;
        }
      });
      
      // Add final turn
      prompt += '\nAssistant:';
      
      // Generate completion
      const result = await this.generateCompletion(model, prompt, {
        system: systemPrompt,
        temperature: options.temperature,
        max_tokens: options.max_tokens
      });
      
      // Format the response to match OpenAI structure
      return {
        id: 'ollama-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.response ?? ''
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: result.prompt_eval_count ?? 0,
          completion_tokens: result.eval_count ?? 0,
          total_tokens: (result.prompt_eval_count ?? 0) + (result.eval_count ?? 0)
        }
      };
    } catch (error) {
      logger.error('Error in Ollama createChatCompletion:', error);
      throw error;
    }
  }
} 
