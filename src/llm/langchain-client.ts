import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getLogger } from "../utils/logger";
import { getLangChainConfiguration } from "./langchain-fetcher";
import { obsidianFetch } from "../utils/fetch-shim";

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
      
      switch (this.provider) {
        case 'openai': {
          logger.debug(`Using OpenAI with model ${this.model}`);
          // OpenAI uses 'maxTokens'
          const model = new ChatOpenAI({
            ...config,
            modelName: this.model,
            maxTokens: this.maxTokens
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
            // Debug what's actually in these message objects
            logger.debug("Message format debug:", 
              messages.map(m => ({
                type: m.constructor.name,
                keys: Object.keys(m),
                stringified: JSON.stringify(m)
              }))
            );
            
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
            
            // Debug logging for Anthropic - full request details
            logger.debug(`Anthropic API Request - Model: ${this.model}`);
            logger.debug(`System prompt (${systemPromptContent.length} chars):\n${systemPromptContent}`);
            logger.debug(`User messages (${formattedMessages.length}):`);
            formattedMessages.forEach((msg, i) => {
              if (msg && msg.content) {
                logger.debug(`Message ${i+1} (${String(msg.content).length} chars): ${msg.role}\n${msg.content}`);
              } else {
                logger.debug(`Message ${i+1}: [Invalid or null message]`);
              }
            });
            logger.debug(`Full payload: ${JSON.stringify(payload, null, 2)}`);
            
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
            
            // Debug logging for response
            logger.debug(`Anthropic API Response: ${JSON.stringify(responseData, null, 2)}`);
            
            if (!responseData.content || !responseData.content[0] || !responseData.content[0].text) {
              throw new Error('Invalid response format from Anthropic API');
            }
            
            const responseText = responseData.content[0].text;
            logger.debug(`Anthropic response text (${responseText.length} chars):\n${responseText}`);
            
            return responseText;
          } catch (error) {
            logger.error('Error with direct Anthropic API call:', error);
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