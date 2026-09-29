import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import { GeminiClient } from "./gemini-client";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getLogger } from "../utils/logger";
import { getSafeErrorMessage } from "../utils/error-utils";
import { getLangChainConfiguration, getOpenAiConfiguration } from "./langchain-fetcher";
import { llmCallTimingMessage } from "./call-timing";
import { requestBudgetMs } from "../utils/request-budget";
import type { LlmCallOutcome } from "./call-timing";
import { obsidianFetch } from "../utils/fetch-shim";

const logger = getLogger('LANGCHAIN');

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

/**
 * Helper function to truncate content for debug logging
 */
function truncateForDebug(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.substring(0, maxLength) + '...';
}

const extractContent = (response: unknown): string => {
  if (response && typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    return JSON.stringify(content);
  }
  if (typeof response === 'string') return response;
  if (response === null || response === undefined) return '';
  return JSON.stringify(response);
};

// Detect OpenAI reasoning (o-series) models which require max_completion_tokens
const isReasoningModel = (model: string): boolean => {
  if (!model) return false;
  if (/^o\d/i.test(model)) return true;
  if (model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat')) return true;
  return false;
};


/** What either ChatOpenAI-backed provider needs to build its model. */
export interface OpenAiModelOptions {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * The OpenAI model, built exactly as the provider switch builds it.
 *
 * Exported so a test can construct it and inspect the client it produces.
 * That is not ceremony: the transport reaches the OpenAI SDK as one property
 * on a nested object, and a dependency quietly dropping it is invisible to
 * inspection — it is what happened before #19. Only an assertion on the
 * built client catches the regression.
 */
export function buildOpenAIModel(options: OpenAiModelOptions): ChatOpenAI {
  // Special handling for GPT-5 temperature restrictions
  let effectiveTemperature = options.temperature;
  if (options.model === 'gpt-5') {
    effectiveTemperature = 1; // GPT-5 only supports temperature=1
    logger.debug(`GPT-5 detected: forcing temperature to 1 (was ${options.temperature})`);
  }

  const useMaxCompletionTokens = isReasoningModel(options.model);
  if (useMaxCompletionTokens) {
    logger.debug(`Reasoning model detected; using maxCompletionTokens to comply with OpenAI o-series requirements.`);
  }

  // OpenAI: use maxCompletionTokens for o-series, fall back to maxTokens otherwise
  return new ChatOpenAI({
    // `configuration`, not the top level: see getOpenAiConfiguration, which
    // also records who owns the request timeout now (#19).
    ...getOpenAiConfiguration({ apiKey: options.apiKey }),
    // The SDK gets OUR budget, not its own ten-minute default (#19 F1).
    // openai@5.12.2 implements a timeout by aborting the signal it hands to
    // fetch, and since the shim started honouring signals that abort lands —
    // so leaving this unset silently capped the setting at 600 s no matter
    // what the user configured. Read here, per call, so it tracks the
    // setting. Never 0: openai reads 0 as "abort immediately", not "no
    // limit".
    timeout: requestBudgetMs(),
    modelName: options.model,
    ...(useMaxCompletionTokens
      ? { maxCompletionTokens: options.maxTokens }
      : { maxTokens: options.maxTokens }),
    temperature: effectiveTemperature,
    // LangChain's AsyncCaller otherwise retries up to 6x on any non-4xx error, silently
    // re-billing a completion the provider may already have served; the job runner owns
    // retries explicitly.
    maxRetries: 0
  });
}

/**
 * The OpenRouter model: the same OpenAI SDK pointed at OpenRouter's base URL,
 * carrying the two attribution headers OpenRouter asks for. Exported for the
 * same reason as buildOpenAIModel, plus one of its own — the baseURL and
 * headers travel on the same nested object as the transport, so one test can
 * hold all three to their promises.
 */
export function buildOpenRouterModel(options: OpenAiModelOptions): ChatOpenAI {
  return new ChatOpenAI({
    // The shim travels in `configuration` alongside the baseURL and the two
    // attribution headers (#19); see getOpenAiConfiguration for the timeout
    // ownership that comes with it.
    ...getOpenAiConfiguration({
      apiKey: options.apiKey,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/rmccorkl/TubeSage',
          'X-Title': 'TubeSage'
        }
      }
    }),
    // The SDK gets OUR budget, not its own ten-minute default (#19 F1).
    // openai@5.12.2 implements a timeout by aborting the signal it hands to
    // fetch, and since the shim started honouring signals that abort lands —
    // so leaving this unset silently capped the setting at 600 s no matter
    // what the user configured. Read here, per call, so it tracks the
    // setting. Never 0: openai reads 0 as "abort immediately", not "no
    // limit".
    timeout: requestBudgetMs(),
    modelName: options.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    // LangChain's AsyncCaller otherwise retries up to 6x on any non-4xx error, silently
    // re-billing a completion the provider may already have served; the job runner owns
    // retries explicitly.
    maxRetries: 0
  });
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
    // Per-call timing for EVERY provider path (#16). The shim times one HTTP
    // request, but OpenAI and OpenRouter never reach it (#19) — and they are
    // the paths whose latency most needs measuring. Wrapped around the
    // invocation, all five are equal: the two ChatOpenAI paths, ChatOllama,
    // the Anthropic direct call and GeminiClient. A `finally`, so a call that
    // gave up at the budget is timed exactly like one that answered.
    const startedAt = Date.now();
    let outcome: LlmCallOutcome = "error";
    try {
      const completion = await this.runCompletion(systemPrompt, userPrompt);
      outcome = "ok";
      return completion;
    } finally {
      logger.debug(llmCallTimingMessage(this.provider, this.model, Date.now() - startedAt, outcome));
    }
  }

  /** The provider switch itself. Timed by generateCompletion, which is what everything calls. */
  private async runCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
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
          const model = buildOpenAIModel({
            apiKey: this.apiKey,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
          });
          
          // TODO: Revisit this type casting when LangChain's type definitions are more stable
          // Type cast to any[] is needed because LangChain's type definitions for invoke()
          // expect an array type that's not directly compatible with (SystemMessage | HumanMessage)[]
          const response = await model.invoke(messages);
          return String(extractContent(response));
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
                if ('content' in m) {
                  const c = (m as { content?: unknown }).content;
                  if (typeof c === 'string') return c;
                  try {
                    return JSON.stringify(c);
                  } catch {
                    return String(c);
                  }
                }
                if ('text' in m) {
                  const textVal = (m as { text?: unknown }).text;
                  return typeof textVal === 'string' ? textVal : JSON.stringify(textVal);
                }
                if ('value' in m) {
                  const valueVal = (m as { value?: unknown }).value;
                  return typeof valueVal === 'string' ? valueVal : JSON.stringify(valueVal);
                }
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
            
            const responseData = await response.json() as unknown;
            
            // Debug logging for response - truncated
            const usage = isRecord(responseData) ? responseData.usage : undefined;
            logger.debug(`Anthropic API Response: ${usage ? `Usage: ${JSON.stringify(usage)}` : 'Success'}`);
            
            const content = isRecord(responseData) ? responseData.content : undefined;
            if (!Array.isArray(content) || !content[0] || !isRecord(content[0]) || typeof content[0].text !== 'string') {
              throw new Error('Invalid response format from Anthropic API');
            }
            
            const responseText = content[0].text;
            logger.debug(`Anthropic response text (${responseText.length} chars): ${truncateForDebug(responseText)}`);
            
            return responseText;
          } catch (error) {
            logger.error('Error with direct Anthropic API call:', error);
            throw error;
          }
        }
          
        case 'google': {
          logger.debug(`[GOOGLE] Using GeminiClient (direct obsidianFetch) for model: '${this.model}'`);
          logger.debug(`[GOOGLE] Temperature: ${this.temperature}, MaxTokens: ${this.maxTokens}`);
          logger.debug(`[GOOGLE] API Key present: ${!!this.apiKey}, length: ${this.apiKey?.length || 0}`);

          if (!this.model || typeof this.model !== 'string' || this.model.trim() === '') {
            logger.error(`[GOOGLE] CRITICAL: Invalid model name: '${this.model}'`);
            throw new Error(`Invalid Google model name: '${this.model}'. Expected a valid Gemini model ID.`);
          }

          // Use GeminiClient directly with obsidianFetch — ChatGoogleGenerativeAI ignores the
          // custom fetch override so it breaks on mobile. Direct calls mirror the Anthropic pattern.
          const geminiClient = new GeminiClient(this.apiKey);
          const systemContent = extractContent(messages[0]);
          const userContent = extractContent(messages[1]);

          const geminiResponse = await geminiClient.generateContent(this.model, userContent, {
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            system: systemContent
          });
          return geminiClient.extractText(geminiResponse);
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
          return String(extractContent(response));
        }

        case 'openrouter': {
          logger.debug(`Using OpenRouter with model ${this.model}`);
          const model = buildOpenRouterModel({
            apiKey: this.apiKey,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
          });

          const response = await model.invoke(messages);
          return String(extractContent(response));
        }

        default:
          throw new Error(`Unsupported LangChain provider: ${this.provider}`);
      }
    } catch (error) {
      logger.error(`Error in LangChain ${this.provider} completion:`, error);
      
      // Log comprehensive error details
      logger.error(`Error type: ${typeof error}`);
      const errorMessage = getSafeErrorMessage(error);
      logger.error(`Error message: ${errorMessage}`);
      if (error instanceof Error && error.stack) {
        logger.error(`Error stack: ${error.stack}`);
      }
      
      // Log all error properties
      if (isRecord(error)) {
        const errorKeys = Object.keys(error);
        if (errorKeys.length > 0) {
          logger.error(`Error keys: ${errorKeys.join(', ')}`);
          errorKeys.forEach((key) => {
            logger.error(`Error.${key}:`, error[key]);
          });
        }
        const response = error.response;
        if (isRecord(response)) {
          const status = response.status;
          const data = response.data;
          logger.error(`Status: ${typeof status === 'number' ? status : 'unknown'}, Data:`, data);
        }
      }
      
      if (errorMessage.includes('ERR_INVALID_ARGUMENT')) {
        throw new Error(`Invalid request to ${this.provider} API. Please check your API key and network connection.`);
      }
      
      throw error;
    }
  }
} 
