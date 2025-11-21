/**
 * Utilities for standardized error handling across the plugin
 */

/**
 * Safely extracts error message from any type of error object
 * @param error The error object
 * @param defaultMessage Default message if extraction fails
 * @returns A safe error message string
 */
export function getSafeErrorMessage(error: unknown, defaultMessage = 'Unknown error occurred'): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    try {
        return String(error) || defaultMessage;
    } catch {
        return defaultMessage;
    }
}

/**
 * Categories of common errors
 */
export enum ErrorCategory {
    Network = 'network',
    ApiKey = 'api_key',
    RateLimit = 'rate_limit',
    TokenLimit = 'token_limit',
    CORS = 'cors',
    Timeout = 'timeout',
    NotFound = 'not_found',
    Unknown = 'unknown'
}

/**
 * Detects error category based on error message content
 * @param error The error object
 * @returns The detected error category
 */
export function detectErrorCategory(error: unknown): ErrorCategory {
    const message = getSafeErrorMessage(error);
    
    // Network errors
    if (message.includes('network') || 
        message.includes('fetch') || 
        message.includes('connect') ||
        message.includes('ECONNREFUSED') ||
        message.includes('NetworkError') ||
        message.includes('Failed to fetch')) {
        return ErrorCategory.Network;
    }
    
    // CORS errors
    if (message.includes('CORS') || 
        message.includes('Cross-Origin') || 
        message.includes('Access-Control-Allow-Origin')) {
        return ErrorCategory.CORS;
    }
    
    // API key errors
    if (message.includes('API key') || 
        message.includes('authentication') || 
        message.includes('auth') || 
        message.includes('unauthorized')) {
        return ErrorCategory.ApiKey;
    }
    
    // Rate limit errors
    if (message.includes('rate limit') || 
        message.includes('quota') || 
        message.includes('too many requests')) {
        return ErrorCategory.RateLimit;
    }
    
    // Token limit errors
    if (message.includes('context length') || 
        message.includes('token limit') || 
        message.includes('max_tokens')) {
        return ErrorCategory.TokenLimit;
    }
    
    // Timeout errors
    if (message.includes('timeout') || 
        message.includes('timed out')) {
        return ErrorCategory.Timeout;
    }
    
    // Not found errors
    if (message.includes('not found') || 
        message.includes('404')) {
        return ErrorCategory.NotFound;
    }
    
    return ErrorCategory.Unknown;
}

/**
 * Creates a friendly error message for a specific API
 * @param error The original error
 * @param apiName Name of the API to prefix error with
 * @returns Formatted error with appropriate message
 */
export function createApiError(error: unknown, apiName: string): Error {
    const category = detectErrorCategory(error);
    const originalMessage = getSafeErrorMessage(error);
    
    switch (category) {
        case ErrorCategory.Network:
            return new Error(`[${apiName}] Network error while connecting to service. Please check your internet connection.`);
            
        case ErrorCategory.CORS:
            return new Error(`[${apiName}] CORS policy blocked the request. Please check your connection or try a different request.`);
            
        case ErrorCategory.ApiKey:
            return new Error(`[${apiName}] Invalid API key or authentication error. Please check your settings.`);
            
        case ErrorCategory.RateLimit:
            return new Error(`[${apiName}] Rate limit reached or quota exceeded. Please try again later.`);
            
        case ErrorCategory.TokenLimit:
            return new Error(`[${apiName}] Input too long for model's context window.`);
            
        case ErrorCategory.Timeout:
            return new Error(`[${apiName}] Request timed out. Please try again.`);
            
        case ErrorCategory.NotFound:
            return new Error(`[${apiName}] Resource not found. Please check the request parameters.`);
            
        default:
            // For unknown errors, append the original message
            return new Error(`[${apiName}] ${originalMessage}`);
    }
}

/**
 * Logs an error with standardized formatting and returns a user-friendly error
 * @param error The original error
 * @param apiName Name of the API to prefix error with
 * @param context Additional context for debugging
 * @returns Formatted error with appropriate message
 */
export function handleApiError(error: unknown, apiName: string, context?: string): Error {
    // Log detailed error for debugging
    console.error(`[${apiName}]${context ? ' [' + context + ']' : ''} Error:`, error);
    
    // Return a user-friendly error
    return createApiError(error, apiName);
} 
