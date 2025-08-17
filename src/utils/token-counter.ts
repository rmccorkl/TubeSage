// token-counter.ts
import type { Provider } from "./model-limits-registry";

// Provider-specific tokenizer implementations
export class TokenCounter {
    private static openaiEncoder: any = null;
    private static anthropicTokenizer: any = null;

    /**
     * Initialize OpenAI tokenizer using tiktoken/lite to avoid WASM issues
     * Uses JSON encoders instead of WASM for Obsidian compatibility
     */
    private static async initOpenAITokenizer() {
        if (!this.openaiEncoder) {
            try {
                // Use tiktoken/lite which avoids WASM and uses JSON encoders
                const tiktokenLite = await import('@dqbd/tiktoken/lite');
                const init = (tiktokenLite as any).init || (tiktokenLite as any).default?.init;
                const Tiktoken = (tiktokenLite as any).Tiktoken || (tiktokenLite as any).default?.Tiktoken;
                
                // Try o200k_base first (good for GPT-4o, GPT-5), fallback to cl100k_base
                try {
                    const o200k = await import('@dqbd/tiktoken/encoders/o200k_base.json');
                    await init((imports: any) => Promise.resolve(imports));
                    this.openaiEncoder = new Tiktoken(
                        (o200k as any).bpe_ranks, 
                        (o200k as any).special_tokens, 
                        (o200k as any).pat_str
                    );
                    console.info('Initialized tiktoken with o200k_base encoding');
                } catch {
                    // Fallback to cl100k_base for older models
                    const cl100k = await import('@dqbd/tiktoken/encoders/cl100k_base.json');
                    await init((imports: any) => Promise.resolve(imports));
                    this.openaiEncoder = new Tiktoken(
                        (cl100k as any).bpe_ranks, 
                        (cl100k as any).special_tokens, 
                        (cl100k as any).pat_str
                    );
                    console.info('Initialized tiktoken with cl100k_base encoding (fallback)');
                }
            } catch (error) {
                console.warn('Failed to load tiktoken/lite, falling back to estimation:', error);
                this.openaiEncoder = null;
            }
        }
        return this.openaiEncoder;
    }

    private static async initAnthropicTokenizer() {
        // For now, skip Anthropic tokenizer in favor of estimation
        // This ensures compatibility across Obsidian desktop and mobile
        if (!this.anthropicTokenizer) {
            console.info('Using token estimation instead of Anthropic tokenizer for Obsidian compatibility');
            this.anthropicTokenizer = null;
        }
        return this.anthropicTokenizer;
    }

    /**
     * Count tokens for a given text using provider-specific tokenizer
     */
    static async countTokens(text: string, provider: Provider, model?: string): Promise<number> {
        try {
            switch (provider) {
                case 'openai':
                    return await this.countOpenAITokens(text);
                
                case 'anthropic':
                    return await this.countAnthropicTokens(text);
                
                case 'google':
                    // Google doesn't have a simple client-side tokenizer
                    // Use enhanced estimation with Google-specific adjustments
                    return this.estimateTokens(text, 'google');
                
                case 'ollama':
                    // Ollama uses various models, use Ollama-specific estimation
                    return this.estimateTokens(text, 'ollama');
                
                default:
                    return this.estimateTokens(text);
            }
        } catch (error) {
            console.warn(`Token counting failed for ${provider}, using estimation:`, error);
            return this.estimateTokens(text);
        }
    }

    /**
     * Count tokens using OpenAI's tiktoken (for OpenAI)
     */
    private static async countOpenAITokens(text: string): Promise<number> {
        const encoder = await this.initOpenAITokenizer();
        if (encoder) {
            try {
                const tokens = encoder.encode(text);
                return tokens.length;
            } catch (error) {
                console.warn('tiktoken encoding failed, using estimation');
                return this.estimateTokens(text, 'openai');
            }
        }
        return this.estimateTokens(text, 'openai');
    }

    /**
     * Count tokens using Anthropic's tokenizer
     */
    private static async countAnthropicTokens(text: string): Promise<number> {
        const tokenizer = await this.initAnthropicTokenizer();
        if (tokenizer) {
            try {
                return tokenizer(text);
            } catch (error) {
                console.warn('Anthropic tokenizer failed, using estimation');
                return this.estimateTokens(text, 'anthropic');
            }
        }
        return this.estimateTokens(text, 'anthropic');
    }

    /**
     * Enhanced token estimation with provider-specific adjustments
     * More accurate than simple character counting, accounts for different tokenization patterns
     */
    private static estimateTokens(text: string, provider?: Provider): number {
        if (!text || text.length === 0) return 0;
        
        // Base estimation: words + punctuation + whitespace patterns
        const words = text.split(/\s+/).filter(word => word.length > 0);
        const punctuation = (text.match(/[.,;:!?'"()[\]{}\-]/g) || []).length;
        const numbers = (text.match(/\d+/g) || []).length;
        
        // Different providers have different tokenization characteristics
        let tokenMultiplier = 1.0;
        let characterRatio = 4.0; // Base: 1 token ≈ 4 characters
        
        switch (provider) {
            case 'openai':
                // GPT models tend to split more aggressively
                tokenMultiplier = 1.15;
                characterRatio = 3.8;
                break;
            case 'anthropic':
                // Claude models have similar tokenization to GPT
                tokenMultiplier = 1.1;
                characterRatio = 4.0;
                break;
            case 'google':
                // Gemini tends to be more conservative with tokens
                tokenMultiplier = 1.05;
                characterRatio = 4.2;
                break;
            case 'ollama':
                // Local models vary, use conservative estimate
                tokenMultiplier = 1.2;
                characterRatio = 3.5;
                break;
            default:
                // Safe default
                tokenMultiplier = 1.15;
                characterRatio = 4.0;
        }
        
        // Enhanced estimation considering word boundaries, punctuation, and special tokens
        const wordBasedEstimate = words.length * tokenMultiplier;
        const characterBasedEstimate = text.length / characterRatio;
        const punctuationTokens = punctuation * 0.8; // Most punctuation is separate tokens
        const numberTokens = numbers * 1.2; // Numbers often split into multiple tokens
        
        // Use the higher of word-based or character-based estimate, add punctuation/number adjustments
        const estimate = Math.max(wordBasedEstimate, characterBasedEstimate) + punctuationTokens + numberTokens;
        
        // Add 10% safety margin and round up
        return Math.ceil(estimate * 1.1);
    }

    /**
     * Synchronous token estimation for cases where async isn't practical
     * Use this sparingly - prefer the async countTokens method
     */
    static estimateTokensSync(text: string, provider?: Provider): number {
        return this.estimateTokens(text, provider);
    }

    /**
     * Count tokens in multiple text segments (for chunking calculations)
     */
    static async countTokensInSegments(
        segments: string[], 
        provider: Provider, 
        model?: string
    ): Promise<number[]> {
        const promises = segments.map(segment => this.countTokens(segment, provider, model));
        return await Promise.all(promises);
    }

    /**
     * Calculate total tokens for an array of text segments
     */
    static async getTotalTokens(
        segments: string[], 
        provider: Provider, 
        model?: string
    ): Promise<number> {
        const tokenCounts = await this.countTokensInSegments(segments, provider, model);
        return tokenCounts.reduce((total, count) => total + count, 0);
    }

    /**
     * Clean up tokenizer resources (call when shutting down)
     */
    static cleanup() {
        if (this.openaiEncoder && this.openaiEncoder.free) {
            this.openaiEncoder.free();
        }
        this.openaiEncoder = null;
        this.anthropicTokenizer = null;
    }
}

/**
 * Convenience function for quick token counting
 */
export async function countTokens(text: string, provider: Provider, model?: string): Promise<number> {
    return TokenCounter.countTokens(text, provider, model);
}

/**
 * Convenience function for quick token estimation (synchronous)
 */
export function estimateTokens(text: string, provider?: Provider): number {
    return TokenCounter.estimateTokensSync(text, provider);
}