import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getLogger } from "../utils/logger";
import { getLangChainConfiguration } from "./langchain-fetcher";
import { AnthropicProxyClient } from "./anthropic-proxy-client";

const logger = getLogger('LANGCHAIN');

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
    
    logger.debug(`Creating LangChain client for ${this.provider} with model ${this.model}`);
  }
  
  /**
   * Generate a completion using the appropriate LangChain model
   */
  async generateCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      // Common configuration with our custom fetcher
      const config = getLangChainConfiguration({
        temperature: this.temperature,
        apiKey: this.apiKey
      });
      
      // Create messages in LangChain format
      const messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt)
      ];
      
      let response;
      
      switch (this.provider) {
        case 'openai': {
          logger.debug(`Using OpenAI with model ${this.model}`);
          // OpenAI uses 'maxTokens'
          const model = new ChatOpenAI({
            ...config,
            modelName: this.model,
            maxTokens: this.maxTokens
          });
          response = await model.invoke(messages);
          return response.content;
        }
          
        case 'anthropic': {
          logger.debug(`Using Anthropic proxy with model ${this.model}`);
          // Use our custom proxy client to bypass browser restrictions
          try {
            const anthropicProxy = new AnthropicProxyClient(this.apiKey);
            
            return await anthropicProxy.generateCompletion(
              systemPrompt,
              userPrompt,
              {
                model: this.model,
                temperature: this.temperature,
                maxTokens: this.maxTokens
              }
            );
          } catch (error) {
            logger.error("Error with Anthropic proxy client:", error);
            throw error;
          }
        }
          
        case 'google': {
          logger.debug(`Using Google Gemini with model ${this.model}`);
          // Google Gemini - use maxTokens as defined in the type definition
          const model = new ChatGoogleGenerativeAI({
            ...config,
            modelName: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens // Using maxTokens directly
          });
          
          response = await model.invoke(messages);
          return response.content;
        }
          
        default:
          throw new Error(`Unsupported LangChain provider: ${this.provider}`);
      }
    } catch (error) {
      logger.error(`Error in LangChain ${this.provider} completion:`, error);
      
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