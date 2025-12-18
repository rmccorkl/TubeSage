import OpenAI from "openai";
import { obsidianFetch } from "../utils/fetch-shim";
import { getLogger } from "../utils/logger";

const logger = getLogger('OPENAI');
type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionOptions = Partial<Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, 'model' | 'messages'>> & {
  max_completion_tokens?: number;
};

/**
 * Creates an OpenAI client configured to work in Obsidian on any platform.
 * 
 * @param apiKey The OpenAI API key
 * @returns An initialized OpenAI client
 */
export function createOpenAIClient(apiKey: string) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('OpenAI API key is required');
  }
  
  logger.debug('Creating OpenAI client');
  
  // Use a custom fetch implementation that works with Obsidian
  const customFetch = async (url: string | URL | Request, init?: RequestInit) => {
    try {
      // Ensure the URL is properly formatted
      let requestUrl: string;
      
      if (typeof url === 'string') {
        requestUrl = url;
      } else if (url instanceof URL) {
        requestUrl = url.toString();
      } else if (url instanceof Request) {
        requestUrl = url.url;
      } else {
        logger.error('Invalid URL type:', typeof url);
        throw new TypeError('Invalid URL type');
      }
      
      // Make sure the URL doesn't have any invalid characters
      try {
        const parsedUrl = new URL(requestUrl);
        requestUrl = parsedUrl.toString();
      } catch {
        logger.error('Invalid URL format:', requestUrl);
        throw new Error(`Invalid URL format: ${requestUrl}`);
      }
      
      // Log detailed request info for debugging
      logger.debug(`OpenAI fetch: ${requestUrl}`);
      
      // Make the request using our shim
      return obsidianFetch(requestUrl, init);
    } catch (error) {
      logger.error('Error in OpenAI fetch:', error);
      throw error;
    }
  };
  
  try {
    return new OpenAI({ 
      apiKey: apiKey,
      baseURL: 'https://api.openai.com/v1',
      fetch: customFetch,
      dangerouslyAllowBrowser: true // Required for browser/WebView environments
    });
  } catch (error) {
    logger.error('Failed to create OpenAI client:', error);
    throw new Error(`Failed to initialize OpenAI client: ${error.message}`);
  }
}

/**
 * Simple wrapper around the OpenAI client for chat completions
 */
export class OpenAIWrapper {
  private client: OpenAI;
  
  constructor(apiKey: string) {
    this.client = createOpenAIClient(apiKey);
  }
  
  /**
   * Generate a chat completion
   * 
   * @param model The model to use (e.g., "gpt-4", "gpt-3.5-turbo")
   * @param messages The chat messages
   * @param options Additional options
   * @returns The completion response
   */
  async createChatCompletion(
    model: string,
    messages: ChatCompletionMessageParam[],
    options: ChatCompletionOptions = {}
  ) {
    try {
      // Normalize deprecated max_tokens to max_completion_tokens (OpenAI recommendation)
      const normalizedOptions: ChatCompletionOptions = { ...options };
      const normalizeTokenValue = (value: number | null | undefined): number | undefined =>
        typeof value === 'number' ? value : undefined;

      if (options.max_tokens !== undefined) {
        logger.warn('Received deprecated max_tokens; mapping to max_completion_tokens for compatibility.');
      }

      const completionTokens = normalizeTokenValue(
        normalizedOptions.max_completion_tokens ?? normalizedOptions.max_tokens
      );

      // Always remove deprecated field before sending to OpenAI
      delete (normalizedOptions as { max_tokens?: number | null }).max_tokens;

      if (completionTokens !== undefined) {
        normalizedOptions.max_completion_tokens = completionTokens;
      } else {
        delete (normalizedOptions as { max_completion_tokens?: number | null }).max_completion_tokens;
      }
      
      logger.debug(`Creating chat completion with model: ${model}, messages: ${messages.length}, options: ${JSON.stringify({
        temperature: normalizedOptions.temperature,
        max_completion_tokens: completionTokens
      })}`);
      
      // Create a safe copy of options to prevent mutations or reference issues
      const safeOptions: ChatCompletionOptions = { ...normalizedOptions };
      
      // Validate messages format - each message must have role and content
      const validMessages: ChatCompletionMessageParam[] = messages.map(msg => {
        if (!msg.role || !msg.content) {
          logger.warn('Invalid message format, fixing:', msg);
          const role = msg.role ?? 'user';
          const content = typeof msg.content === 'string' ? msg.content : '';
          let fixedMessage: ChatCompletionMessageParam;
          if (role === 'function') {
            fixedMessage = {
              role,
              content,
              name: (msg as { name?: string }).name ?? 'function'
            };
          } else if (role === 'tool') {
            fixedMessage = {
              role,
              content,
              tool_call_id: (msg as { tool_call_id?: string }).tool_call_id ?? 'unknown'
            };
          } else {
            fixedMessage = { role, content };
          }
          return fixedMessage;
        }
        return msg;
      });
      
      const response = await this.client.chat.completions.create({
        model: model,
        messages: validMessages,
        ...safeOptions
      });
      
      logger.debug('Chat completion successful');
      return response;
    } catch (error) {
      logger.error('Error in chat completion:', error);
      
      // Enhanced error reporting
      if (error.response) {
        logger.error(`Status: ${error.response.status}, Data:`, error.response.data);
      }
      
      // Check for common errors and provide better messages
      if (error.message && error.message.includes('ERR_INVALID_ARGUMENT')) {
        throw new Error('Invalid API request. Please check your API key and network connection.');
      }
      
      throw error;
    }
  }
} 
