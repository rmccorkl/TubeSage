// token-calculator.ts
import type { Provider } from "./model-limits-registry";
import { getEffectiveLimits } from "./model-limits-registry";
import { TokenCounter } from "./token-counter";

/**
 * Compute a safe max_tokens given the current prompt size and desired output (high-water mark).
 * Respects provider/model effective limits (after reserve%) and leaves a safety margin.
 */
export function computeSafeMaxTokens(opts: {
  provider: Provider;
  model: string;
  promptTokens: number;          // system + user + history + chunk
  desiredOutputTokens: number;   // your target ceiling per call
  safetyMarginTokens?: number;   // extra cushion (default: ~5% of context)
}) {
  const eff = getEffectiveLimits(opts.provider, opts.model);
  const margin = opts.safetyMarginTokens ?? Math.floor(eff.context * 0.05);

  const room = eff.context - opts.promptTokens - margin;
  const maxTokens = Math.max(
    0,
    Math.min(opts.desiredOutputTokens, eff.maxOutputEff, room)
  );

  const ok = opts.promptTokens + maxTokens + margin <= eff.context;
  return { maxTokens, margin, limits: eff, ok };
}

/**
 * Given instruction tokens and a desired output size, how many document tokens
 * can we stuff per request (biggest safe chunk)?
 */
export function maxDocTokensPerRequest(opts: {
  provider: Provider;
  model: string;
  instructionsTokens: number;    // system + header that wraps each chunk
  desiredOutputTokens: number;
  safetyMarginTokens?: number;
}) {
  const eff = getEffectiveLimits(opts.provider, opts.model);
  const margin = opts.safetyMarginTokens ?? Math.floor(eff.context * 0.05);
  const reservedOutput = Math.min(opts.desiredOutputTokens, eff.maxOutputEff);
  return Math.max(0, eff.context - opts.instructionsTokens - reservedOutput - margin);
}

/**
 * Estimate optimal chunk count for a document given model constraints
 */
export function estimateOptimalChunks(opts: {
  provider: Provider;
  model: string;
  totalDocumentTokens: number;
  instructionsTokens: number;
  desiredOutputTokens: number;
  safetyMarginTokens?: number;
}): { 
  estimatedChunks: number; 
  tokensPerChunk: number; 
  totalRequestsNeeded: number 
} {
  const tokensPerChunk = maxDocTokensPerRequest(opts);
  
  if (tokensPerChunk <= 0) {
    return {
      estimatedChunks: 0,
      tokensPerChunk: 0,
      totalRequestsNeeded: 0
    };
  }

  const estimatedChunks = Math.max(1, Math.ceil(opts.totalDocumentTokens / tokensPerChunk));
  
  return {
    estimatedChunks,
    tokensPerChunk,
    totalRequestsNeeded: estimatedChunks
  };
}

/**
 * Calculate context utilization percentage for monitoring
 */
export function calculateContextUtilization(opts: {
  provider: Provider;
  model: string;
  promptTokens: number;
  outputTokens: number;
}): {
  utilizationPct: number;
  remainingTokens: number;
  isNearLimit: boolean;
} {
  const eff = getEffectiveLimits(opts.provider, opts.model);
  const usedTokens = opts.promptTokens + opts.outputTokens;
  const utilizationPct = (usedTokens / eff.context) * 100;
  const remainingTokens = eff.context - usedTokens;
  const isNearLimit = utilizationPct > 85; // Flag when >85% utilized

  return {
    utilizationPct: Math.round(utilizationPct * 100) / 100,
    remainingTokens,
    isNearLimit
  };
}

/**
 * Dynamic max tokens calculation that replaces hardcoded limits
 * This is the main function to replace PROVIDER_MAX_LIMITS usage
 */
export function getDynamicMaxTokens(opts: {
  provider: Provider;
  model: string;
  isMobile?: boolean;           // Mobile platform constraints
  configuredMaxTokens?: number; // User's configured preference
  promptTokens?: number;        // Current prompt size (for context-aware calculation)
}): number {
  try {
    const eff = getEffectiveLimits(opts.provider, opts.model);
    
    // Start with effective model limit
    let dynamicLimit = eff.maxOutputEff;
    
    // Apply user preference if it's lower than model capability
    if (opts.configuredMaxTokens && opts.configuredMaxTokens < dynamicLimit) {
      dynamicLimit = opts.configuredMaxTokens;
    }
    
    // Apply mobile constraints (85% of calculated limit)
    if (opts.isMobile) {
      dynamicLimit = Math.floor(dynamicLimit * 0.85);
    }
    
    // Context-aware adjustment if prompt tokens provided
    if (opts.promptTokens) {
      const safeMaxTokens = computeSafeMaxTokens({
        provider: opts.provider,
        model: opts.model,
        promptTokens: opts.promptTokens,
        desiredOutputTokens: dynamicLimit
      });
      dynamicLimit = safeMaxTokens.maxTokens;
    }
    
    return Math.max(100, dynamicLimit); // Ensure minimum viable limit
    
  } catch (error) {
    // Fallback to legacy limits if model not in registry
    const LEGACY_LIMITS: Record<string, number> = {
      'openai': 4096,
      'anthropic': 4096,
      'google': 8192,
      'ollama': 4096
    };
    
    let fallbackLimit = LEGACY_LIMITS[opts.provider] || 4096;
    
    if (opts.isMobile) {
      fallbackLimit = Math.floor(fallbackLimit * 0.85);
    }
    
    return fallbackLimit;
  }
}

/**
 * Calculate context-aware max tokens by counting actual prompt tokens
 * This is the enhanced version that uses real tokenizers as specified in requirements
 */
export async function calculateContextAwareMaxTokens(opts: {
  provider: Provider;
  model: string;
  promptText: string;              // The actual prompt text to count tokens for
  desiredOutputTokens: number;     // Target output size
  isMobile?: boolean;
  configuredMaxTokens?: number;
  safetyMarginTokens?: number;
}): Promise<{
  maxTokens: number;
  promptTokens: number;
  limits: any;
  utilizationPct: number;
  isValid: boolean;
  error?: string;
}> {
  try {
    // Count actual prompt tokens using provider-specific tokenizer
    const promptTokens = await TokenCounter.countTokens(opts.promptText, opts.provider, opts.model);
    
    const eff = getEffectiveLimits(opts.provider, opts.model);
    const margin = opts.safetyMarginTokens ?? Math.floor(eff.context * 0.05);
    
    // Calculate available space for output
    const availableForOutput = eff.context - promptTokens - margin;
    
    // Start with desired output tokens, but constrain by model and context limits
    let maxTokens = Math.min(
      opts.desiredOutputTokens,
      eff.maxOutputEff,
      availableForOutput
    );
    
    // Apply user preference if configured and lower
    if (opts.configuredMaxTokens && opts.configuredMaxTokens < maxTokens) {
      maxTokens = opts.configuredMaxTokens;
    }
    
    // Apply mobile constraints
    if (opts.isMobile) {
      maxTokens = Math.floor(maxTokens * 0.85);
    }
    
    // Ensure minimum viable output
    maxTokens = Math.max(100, maxTokens);
    
    // Calculate utilization
    const totalUsage = promptTokens + maxTokens + margin;
    const utilizationPct = (totalUsage / eff.context) * 100;
    
    // Validate the configuration
    const isValid = totalUsage <= eff.context && maxTokens <= eff.maxOutputEff;
    
    return {
      maxTokens,
      promptTokens,
      limits: eff,
      utilizationPct: Math.round(utilizationPct * 100) / 100,
      isValid,
      error: isValid ? undefined : `Token limit exceeded: ${totalUsage} > ${eff.context}`
    };
    
  } catch (error) {
    // Fallback to estimation if token counting fails
    const estimatedTokens = TokenCounter.estimateTokensSync(opts.promptText, opts.provider);
    const eff = getEffectiveLimits(opts.provider, opts.model);
    const margin = opts.safetyMarginTokens ?? Math.floor(eff.context * 0.05);
    
    const availableForOutput = eff.context - estimatedTokens - margin;
    let maxTokens = Math.min(opts.desiredOutputTokens, eff.maxOutputEff, availableForOutput);
    
    if (opts.configuredMaxTokens && opts.configuredMaxTokens < maxTokens) {
      maxTokens = opts.configuredMaxTokens;
    }
    
    if (opts.isMobile) {
      maxTokens = Math.floor(maxTokens * 0.85);
    }
    
    maxTokens = Math.max(100, maxTokens);
    
    return {
      maxTokens,
      promptTokens: estimatedTokens,
      limits: eff,
      utilizationPct: ((estimatedTokens + maxTokens + margin) / eff.context) * 100,
      isValid: true, // Assume valid when using fallback
      error: `Token counting failed, using estimation: ${error}`
    };
  }
}

/**
 * Check if current token usage would exceed model limits
 */
export function validateTokenLimits(opts: {
  provider: Provider;
  model: string;
  promptTokens: number;
  maxTokens: number;
  safetyMarginTokens?: number;
}): {
  isValid: boolean;
  error?: string;
  suggestions?: string[];
} {
  try {
    const eff = getEffectiveLimits(opts.provider, opts.model);
    const margin = opts.safetyMarginTokens ?? Math.floor(eff.context * 0.05);
    const totalTokens = opts.promptTokens + opts.maxTokens + margin;
    
    if (totalTokens > eff.context) {
      return {
        isValid: false,
        error: `Token limit exceeded: ${totalTokens} > ${eff.context}`,
        suggestions: [
          `Reduce prompt size (current: ${opts.promptTokens})`,
          `Reduce max_tokens (current: ${opts.maxTokens})`,
          `Use a model with larger context window`
        ]
      };
    }
    
    if (opts.maxTokens > eff.maxOutputEff) {
      return {
        isValid: false,
        error: `Output limit exceeded: ${opts.maxTokens} > ${eff.maxOutputEff}`,
        suggestions: [
          `Reduce max_tokens to ${eff.maxOutputEff} or lower`,
          `Use a model with higher output limit`
        ]
      };
    }
    
    return { isValid: true };
    
  } catch (error) {
    return {
      isValid: false,
      error: `Model not found in registry: ${opts.provider}:${opts.model}`,
      suggestions: [`Add model to registry or use a supported model`]
    };
  }
}