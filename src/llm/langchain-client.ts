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
import { t } from "../i18n";
import { PLACEHOLDER_API_KEY, parseExtraParams } from "./openai-compatible";
import { effortLogLine, effortToSend, ollamaEffortLogLine } from "./reasoning-effort";
import type { ReasoningEffort } from "./reasoning-effort";
import { parseBaseUrl, resolveBaseUrl } from "./base-url";

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
  /** The user's base URL for this provider; blank or absent means its default (#29). */
  baseURL?: string;
  /** How hard a reasoning model thinks (#43); `default` or absent sends nothing. */
  reasoningEffort?: ReasoningEffort;
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

  const effort = effortToSend(options.reasoningEffort);
  // useMaxCompletionTokens is our copy of the model gate LangChain applies to
  // `reasoning` below, so the line can say when the level never went out.
  logger.debug(effort && !useMaxCompletionTokens
    ? `Reasoning effort: ${effort} (dropped: model is not an OpenAI reasoning model)`
    : effortLogLine(effort, 'reasoning.effort'));

  // OpenAI: use maxCompletionTokens for o-series, fall back to maxTokens otherwise
  return new ChatOpenAI({
    // `configuration`, not the top level: see getOpenAiConfiguration, which
    // also records who owns the request timeout now (#19). The baseURL is the
    // user's override or OpenAI's own default (#29).
    ...getOpenAiConfiguration({
      apiKey: options.apiKey,
      configuration: { baseURL: resolveBaseUrl('openai', options.baseURL) }
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
    ...(useMaxCompletionTokens
      ? { maxCompletionTokens: options.maxTokens }
      : { maxTokens: options.maxTokens }),
    temperature: effectiveTemperature,
    // #43: LangChain's own option. It goes out as `reasoning_effort` only for
    // what LangChain counts as an OpenAI reasoning model (o-series, gpt-5), so
    // a model that does not reason is never sent a field it would refuse.
    // `none` is what gpt-5.1 and later accept; it goes out as it is, and older
    // models refuse it, which the setting's description says.
    reasoning: effort ? { effort } : undefined,
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
  const effort = effortToSend(options.reasoningEffort);
  logger.debug(effortLogLine(effort, 'reasoning.effort via modelKwargs'));
  return new ChatOpenAI({
    // The shim travels in `configuration` alongside the baseURL and the two
    // attribution headers (#19); see getOpenAiConfiguration for the timeout
    // ownership that comes with it.
    ...getOpenAiConfiguration({
      apiKey: options.apiKey,
      configuration: {
        baseURL: resolveBaseUrl('openrouter', options.baseURL),
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
    // #43: OpenRouter's own `reasoning` object, sent through modelKwargs
    // because LangChain's `reasoning` option is dropped for any model id it
    // does not recognise, and OpenRouter ids (deepseek/deepseek-r1) never are.
    // OpenRouter documents `effort: "none"` as turning reasoning off.
    modelKwargs: effort ? { reasoning: { effort } } : {},
    // LangChain's AsyncCaller otherwise retries up to 6x on any non-4xx error, silently
    // re-billing a completion the provider may already have served; the job runner owns
    // retries explicitly.
    maxRetries: 0
  });
}

/** The custom endpoint's address is not an override: there is no default to fall back to. */
interface OpenAiCompatibleModelOptions extends OpenAiModelOptions {
  baseURL: string;
  /** Extra request fields as the user typed them, a JSON object or blank (#43). */
  extraParams?: string;
}

/**
 * A self-hosted OpenAI-compatible server (#25): LM Studio, vLLM, llama.cpp
 * server, LocalAI. Built as buildOpenRouterModel is — same SDK, transport,
 * budget and retry policy, for the reasons given there — but at the user's
 * base URL and without OpenRouter's attribution headers, which are OpenRouter's
 * to ask for and no one else's. A blank key sends PLACEHOLDER_API_KEY. The
 * address is judged again here, not only in the settings tab, because a
 * hand-edited data.json can hold one the tab never saw.
 */
export function buildOpenAiCompatibleModel(options: OpenAiCompatibleModelOptions): ChatOpenAI {
  const baseURL = parseBaseUrl(options.baseURL);
  if (baseURL === null) {
    throw new Error(t('notice.openaiCompatible.invalidUrl'));
  }
  const extraParams = parseExtraParams(options.extraParams);
  if (extraParams === null) {
    throw new Error(t('notice.openaiCompatible.extraParamsUnreadable'));
  }
  const effort = effortToSend(options.reasoningEffort);
  const extraKeys = Object.keys(extraParams);
  // The user's fields win (below), so a reasoning_effort among them is what goes out.
  logger.debug(extraKeys.includes('reasoning_effort')
    ? `Reasoning effort: ${effort ?? 'default'} (overridden by extra request parameters)`
    : effortLogLine(effort, 'reasoning_effort via modelKwargs'));
  // Key names only: the values are the user's own and may hold anything.
  logger.debug(`Extra request parameters: ${extraKeys.length > 0 ? `keys=${extraKeys.join(', ')}` : 'none'}`);
  return new ChatOpenAI({
    ...getOpenAiConfiguration({
      // `?? ''`: a hand-edited or pre-release data.json can leave the key out.
      apiKey: (options.apiKey ?? '').trim() || PLACEHOLDER_API_KEY,
      configuration: { baseURL }
    }),
    timeout: requestBudgetMs(),
    modelName: options.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    // #43: `reasoning_effort` as it is, through modelKwargs for the reason
    // given in buildOpenRouterModel; a generic server has no standard "off".
    // The user's own fields go last, so they win: they are the more specific
    // instruction, and the way to send what a server needs (chat_template_kwargs).
    modelKwargs: { ...(effort ? { reasoning_effort: effort } : {}), ...extraParams },
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
  private baseURL: string;
  private reasoningEffort: ReasoningEffort | undefined;
  private openaiCompatibleExtraParams: string | undefined;

  constructor(options: {
    provider: string;
    model: string;
    apiKey: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * This provider's base URL as the user set it (#29): blank means the
     * provider's default. Required for the OpenAI-compatible server; unused
     * by Ollama, whose address is its apiKeys entry.
     */
    baseURL: string;
    /** How hard a reasoning model thinks (#43); absent is `default`, which sends nothing. */
    reasoningEffort?: ReasoningEffort;
    /** The OpenAI-compatible server's extra request fields, a JSON object or blank (#43). */
    openaiCompatibleExtraParams?: string;
  }) {
    this.provider = options.provider;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 1024;
    this.baseURL = options.baseURL;
    this.reasoningEffort = options.reasoningEffort;
    this.openaiCompatibleExtraParams = options.openaiCompatibleExtraParams;
    
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

  /**
   * The three providers that are ChatOpenAI underneath, each from its own
   * exported builder: the same options, including this provider's base URL
   * (#29), which only the OpenAI-compatible server requires.
   */
  private buildChatOpenAiModel(): ChatOpenAI {
    const options = {
      apiKey: this.apiKey,
      model: this.model,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      baseURL: this.baseURL,
      reasoningEffort: this.reasoningEffort,
      extraParams: this.openaiCompatibleExtraParams,
    };
    if (this.provider === 'openai') return buildOpenAIModel(options);
    if (this.provider === 'openrouter') return buildOpenRouterModel(options);
    return buildOpenAiCompatibleModel(options);
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
        case 'openai':
        case 'openrouter':
        case 'openai-compatible': {
          logger.debug(`Using ${this.provider} with model ${this.model}`);
          const response = await this.buildChatOpenAiModel().invoke(messages);
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
            if (effortToSend(this.reasoningEffort)) logger.debug('Reasoning effort: ignored by this provider');
            
            // Make the request directly using our fetch shim, at the user's
            // base URL or Anthropic's own (#29)
            const response = await obsidianFetch(`${resolveBaseUrl('anthropic', this.baseURL)}/v1/messages`, {
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
          if (effortToSend(this.reasoningEffort)) logger.debug('Reasoning effort: ignored by this provider');
          logger.debug(`[GOOGLE] API Key present: ${!!this.apiKey}, length: ${this.apiKey?.length || 0}`);

          if (!this.model || typeof this.model !== 'string' || this.model.trim() === '') {
            logger.error(`[GOOGLE] CRITICAL: Invalid model name: '${this.model}'`);
            throw new Error(`Invalid Google model name: '${this.model}'. Expected a valid Gemini model ID.`);
          }

          // Use GeminiClient directly with obsidianFetch — ChatGoogleGenerativeAI ignores the
          // custom fetch override so it breaks on mobile. Direct calls mirror the Anthropic pattern.
          const geminiClient = new GeminiClient(this.apiKey, resolveBaseUrl('google', this.baseURL));
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
          logger.debug(ollamaEffortLogLine(this.reasoningEffort));
          // For Ollama, the API key is actually the base URL
          const model = new ChatOllama({
            ...config,
            baseUrl: this.apiKey, // Ollama uses the API key field to store the base URL
            model: this.model,
            temperature: this.temperature,
            // #43: @langchain/ollama 0.2.4 only has the boolean, so `none`
            // turns thinking off and every other level sends nothing.
            ...(effortToSend(this.reasoningEffort) === 'none' ? { think: false } : {}),
          });

          // Type cast needed for compatibility with LangChain's invoke() method
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
