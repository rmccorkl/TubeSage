// model-limits-registry.ts
export type Provider = "openai" | "anthropic" | "google" | "ollama";

export type ModelLimits = {
  context: number;            // total context window (input+output)
  maxOutput: number;          // vendor max output cap
  inputMax?: number;          // optional explicit vendor cap on input (if published)
  reserveOutputPct?: number;  // 0.10 for 10%, 0.15 for 15%, etc.
};

export type EffectiveLimits = ModelLimits & {
  maxOutputEff: number;       // floor(maxOutput * (1 - reserveOutputPct))
  inputMaxEff: number;        // context - maxOutputEff (unless inputMax provided; we take min)
};

type Registry = Record<Provider, Record<string, ModelLimits>>;

// ---------------------------
// Enhanced model registry with massive context windows
// ---------------------------
export const BASE_MODELS: Registry = {
  openai: {
    // GPT-5 series - massive context windows
    "gpt-5": { 
      context: 400_000, 
      maxOutput: 128_000, 
      reserveOutputPct: 0.10 
    },
    // GPT-4o series 
    "gpt-4o": { 
      context: 128_000, 
      maxOutput: 16_384, 
      reserveOutputPct: 0.10 
    },
    "gpt-4o-mini": { 
      context: 128_000, 
      maxOutput: 16_384, 
      reserveOutputPct: 0.10 
    },
    // Legacy models (maintain backward compatibility)
    "gpt-4-turbo": { 
      context: 128_000, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.10 
    },
    "gpt-4": { 
      context: 8_192, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.10 
    },
    "gpt-3.5-turbo": { 
      context: 16_384, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.10 
    }
  },
  
  anthropic: {
    // Claude 4 series - new models
    "claude-opus-4-0": { 
      context: 400_000, 
      maxOutput: 32_000, 
      reserveOutputPct: 0.10 
    },
    "claude-opus-4-1": { 
      context: 400_000, 
      maxOutput: 32_000, 
      reserveOutputPct: 0.10 
    },
    "claude-sonnet-4-0": { 
      context: 400_000, 
      maxOutput: 16_000, 
      reserveOutputPct: 0.10 
    },
    // Claude 3.5 series
    "claude-3-5-sonnet-20241022": { 
      context: 200_000, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.10 
    },
    "claude-3-5-haiku-20241022": { 
      context: 200_000, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.10 
    },
    // Legacy Claude 3
    "claude-3-sonnet-20240229": { 
      context: 200_000, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.10 
    },
    "claude-3-opus-20240229": { 
      context: 200_000, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.10 
    },
    "claude-3-haiku-20240307": { 
      context: 200_000, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.10 
    }
  },
  
  google: {
    // Gemini 2.5 series - new model
    "gemini-2.5-flash": { 
      context: 2_000_000, 
      maxOutput: 16_384, 
      reserveOutputPct: 0.10 
    },
    // Gemini 2.0 series
    "gemini-2.0-flash-exp": { 
      context: 1_000_000, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.10 
    },
    // Gemini 1.5 series
    "gemini-1.5-pro": { 
      context: 2_000_000, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.10 
    },
    "gemini-1.5-flash": { 
      context: 1_000_000, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.10 
    },
    "gemini-1.5-flash-8b": { 
      context: 1_000_000, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.10 
    }
  },
  
  ollama: {
    // Local models - higher reserve due to local constraints
    "llama3.1": { 
      context: 32_768, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.15 
    },
    "llama3.1:70b": { 
      context: 32_768, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.15 
    },
    "llama3.1:8b": { 
      context: 32_768, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.15 
    },
    "qwen2.5": { 
      context: 32_768, 
      maxOutput: 8_192, 
      reserveOutputPct: 0.15 
    },
    "mistral": { 
      context: 32_768, 
      maxOutput: 4_096, 
      reserveOutputPct: 0.15 
    }
  }
};

// ---------------------------
// Mutable registry (base + future custom models)
// ---------------------------
const registry: Registry = structuredClone(BASE_MODELS);

// Add or override a model under a provider (for future custom model support)
export function upsertModel(
  provider: Provider,
  modelId: string,
  limits: ModelLimits
) {
  registry[provider] ??= {};
  registry[provider][modelId] = limits;
}

// Read raw limits (throws if missing)
export function getRawLimits(provider: Provider, modelId: string): ModelLimits {
  const prov = registry[provider];
  if (!prov || !prov[modelId]) {
    throw new Error(`No limits registered for ${provider}:${modelId}`);
  }
  return prov[modelId];
}

// Compute effective limits (apply reserve pct and derive inputMaxEff)
export function getEffectiveLimits(provider: Provider, modelId: string): EffectiveLimits {
  const raw = getRawLimits(provider, modelId);
  const reserve = raw.reserveOutputPct ?? 0; // default: no reserve unless specified
  const maxOutputEff = Math.max(0, Math.floor(raw.maxOutput * (1 - reserve)));

  // If vendor publishes an inputMax, respect it; otherwise derive from context
  const derivedInputMax = Math.max(0, raw.context - maxOutputEff);
  const inputMaxEff = raw.inputMax != null
    ? Math.min(raw.inputMax, derivedInputMax)
    : derivedInputMax;

  return { ...raw, maxOutputEff, inputMaxEff };
}

// Get provider from model string (helper for dynamic detection)
export function getProviderFromModel(modelId: string): Provider | null {
  for (const [provider, models] of Object.entries(registry)) {
    if (models[modelId]) {
      return provider as Provider;
    }
  }
  return null;
}

// Check if model is supported
export function isModelSupported(provider: Provider, modelId: string): boolean {
  return !!(registry[provider]?.[modelId]);
}

// Get all models for a provider
export function getModelsForProvider(provider: Provider): string[] {
  return Object.keys(registry[provider] || {});
}

// Legacy compatibility - get old-style max tokens limit for backwards compatibility
export function getLegacyMaxTokens(provider: Provider, modelId: string): number {
  try {
    const limits = getEffectiveLimits(provider, modelId);
    return limits.maxOutputEff;
  } catch {
    // Fallback to legacy hardcoded limits if model not in registry
    const LEGACY_LIMITS: Record<string, number> = {
      'openai': 4096,
      'anthropic': 4096,
      'google': 8192,
      'ollama': 4096,
      'default': 4096
    };
    return LEGACY_LIMITS[provider] || LEGACY_LIMITS['default'];
  }
}