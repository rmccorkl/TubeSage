import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getLogger } from "../utils/logger";
import { getLangChainConfiguration } from "./langchain-fetcher";
import { obsidianFetch } from "../utils/fetch-shim";

const logger = getLogger('LANGCHAIN');

/**
 * Helper function to truncate content for debug logging
 */
function truncateForDebug(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.substring(0, maxLength) + '...';
}


/**
 * A unified client for multiple LLM providers using LangChain
 */
export class LangChainClient {
  private provider: string;
  private model: string;
  private apiKey: string;
  private temperature: number;
  private maxTokens: number;
  
  constructor(options: {
    provider: string;
    model: string;
    apiKey: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.provider = options.provider;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 1024;
    
    // Enhanced debugging for Google provider
    logger.debug(`[CONSTRUCTOR] Creating LangChain client for provider: '${this.provider}' with model: '${this.model}'`);
    logger.debug(`[CONSTRUCTOR] Full options object:`, JSON.stringify(options, null, 2));
    logger.debug(`[CONSTRUCTOR] Model type: ${typeof this.model}, Model value: ${this.model}`);
    logger.debug(`[CONSTRUCTOR] API Key present: ${!!this.apiKey}, API Key length: ${this.apiKey?.length || 0}`);
    
    // Special validation for Google provider
    if (this.provider === 'google') {
      logger.debug(`[GOOGLE] Model validation - is undefined: ${this.model === undefined}, is null: ${this.model === null}, is empty string: ${this.model === ''}`);
      if (!this.model || this.model === 'undefined' || this.model === 'null') {
        logger.error(`[GOOGLE] CRITICAL: Model is invalid for Google provider: '${this.model}'`);
        throw new Error(`Invalid model for Google provider: '${this.model}'. Expected a valid Gemini model ID like 'gemini-1.5-pro'`);
      }
    }
  }
  
  /**
   * Generate a completion using the appropriate LangChain model
   */
  async generateCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      // Common configuration with our custom fetcher
      const config = getLangChainConfiguration({
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
          
          // Special handling for GPT-5 temperature restrictions
          let effectiveTemperature = this.temperature;
          if (this.model === 'gpt-5') {
            effectiveTemperature = 1; // GPT-5 only supports temperature=1
            logger.debug(`GPT-5 detected: forcing temperature to 1 (was ${this.temperature})`);
          }
          
          // OpenAI uses 'maxTokens'
          const model = new ChatOpenAI({
            ...config,
            modelName: this.model,
            maxTokens: this.maxTokens,
            temperature: effectiveTemperature
          });
          
          // TODO: Revisit this type casting when LangChain's type definitions are more stable
          // Type cast to any[] is needed because LangChain's type definitions for invoke()
          // expect an array type that's not directly compatible with (SystemMessage | HumanMessage)[]
          const response = await model.invoke(messages);
          return String(response.content);
        }
          
        case 'anthropic': {
          logger.debug(`Using Anthropic with model ${this.model}`);
          // Call Anthropic directly with our shim instead of using their SDK
          // This bypasses their browser environment detection completely
          try {
            
            // Extract original structured content
            let systemPromptContent = '';
            let userPromptContent = '';
            
            // Get content from messages
            for (const msg of messages) {
              const getContent = (m: SystemMessage | HumanMessage | string | object | null): string => {
                if (typeof m === 'string') return m;
                if (m === null || typeof m !== 'object') return String(m);
                if ('content' in m) return String(m.content);
                if ('text' in m) return String(m.text); 
                if ('value' in m) return String(m.value);
                return JSON.stringify(m);
              };
              
              if (msg instanceof SystemMessage) {
                systemPromptContent = getContent(msg);
              } else if (msg instanceof HumanMessage) {
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
            
            // Debug logging for Anthropic - aligned with other providers
            logger.debug(`Anthropic API Request - Model: ${this.model}`);
            logger.debug(`System prompt (${systemPromptContent.length} chars): ${truncateForDebug(systemPromptContent)}`);
            logger.debug(`User messages (${formattedMessages.length}): ${truncateForDebug(userPromptContent)}`);
            logger.debug(`Temperature: ${this.temperature}, MaxTokens: ${this.maxTokens}`);
            
            // Make the request directly using our fetch shim
            const response = await obsidianFetch('https://api.anthropic.com/v1/messages', {
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
              const errorText = await response.text();
              throw new Error(`Anthropic API error: ${errorText}`);
            }
            
            const responseData = await response.json();
            
            // Debug logging for response - truncated
            logger.debug(`Anthropic API Response: ${responseData.usage ? `Usage: ${JSON.stringify(responseData.usage)}` : 'Success'}`);
            
            if (!responseData.content || !responseData.content[0] || !responseData.content[0].text) {
              throw new Error('Invalid response format from Anthropic API');
            }
            
            const responseText = responseData.content[0].text;
            logger.debug(`Anthropic response text (${responseText.length} chars): ${truncateForDebug(responseText)}`);
            
            return responseText;
          } catch (error) {
            logger.error('Error with direct Anthropic API call:', error);
            throw error;
          }
        }
          
        case 'google': {
          logger.debug(`[GOOGLE] Using Google Gemini with model: '${this.model}'`);
          logger.debug(`[GOOGLE] Model name type: ${typeof this.model}, value: '${this.model}'`);
          logger.debug(`[GOOGLE] Temperature: ${this.temperature}, MaxTokens: ${this.maxTokens}`);
          logger.debug(`[GOOGLE] API Key present: ${!!this.apiKey}, length: ${this.apiKey?.length || 0}`);
          logger.debug(`[GOOGLE] Config object:`, JSON.stringify(config, null, 2));
          
          // Pre-validate model before passing to ChatGoogleGenerativeAI
          if (!this.model || typeof this.model !== 'string' || this.model.trim() === '') {
            logger.error(`[GOOGLE] CRITICAL: Invalid model name: '${this.model}' (type: ${typeof this.model})`);
            throw new Error(`Invalid Google model name: '${this.model}'. Expected a valid Gemini model ID.`);
          }
          
          const modelConfig = {
            ...config,
            model: this.model,                 // Correct parameter name for ChatGoogleGenerativeAI
            temperature: this.temperature,
            maxTokens: this.maxTokens
          };
          
          logger.debug(`[GOOGLE] About to create ChatGoogleGenerativeAI with config:`, JSON.stringify(modelConfig, null, 2));
          
          // Google Gemini - use maxTokens as defined in the type definition
          const model = new ChatGoogleGenerativeAI(modelConfig);
          
          // Type cast needed for compatibility with LangChain's invoke() method
          const response = await model.invoke(messages);
          return String(response.content);
        }
           
        case 'ollama': {
          logger.debug(`Using Ollama with model ${this.model}`);
          // For Ollama, the API key is actually the base URL
          const model = new ChatOllama({
            ...config,
            baseUrl: this.apiKey, // Ollama uses the API key field to store the base URL
            model: this.model,
            temperature: this.temperature,
          });
          
          // Type cast needed for compatibility with LangChain's invoke() method
          const response = await model.invoke(messages);
          return String(response.content);
        }

        default:
          throw new Error(`Unsupported LangChain provider: ${this.provider}`);
      }
    } catch (error) {
      logger.error(`Error in LangChain ${this.provider} completion:`, error);
      
      // Log comprehensive error details
      logger.error(`Error type: ${typeof error}`);
      logger.error(`Error constructor: ${error?.constructor?.name}`);
      logger.error(`Error message: ${error?.message}`);
      logger.error(`Error stack: ${error?.stack}`);
      
      // Log all error properties
      if (error && typeof error === 'object') {
        logger.error(`Error keys: ${Object.keys(error)}`);
        Object.keys(error).forEach(key => {
          logger.error(`Error.${key}:`, error[key]);
        });
      }
      
      if (error.response) {
        logger.error(`Status: ${error.response.status}, Data:`, error.response.data);
      }
      
      if (error.message && error.message.includes('ERR_INVALID_ARGUMENT')) {
        throw new Error(`Invalid request to ${this.provider} API. Please check your API key and network connection.`);
      }
      
      throw error;
    }
  }
} 