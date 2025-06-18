/**
 * Utilities for standardized error handling across the plugin
 */
/**
 * Safely extracts error message from any type of error object
 * @param error The error object
 * @param defaultMessage Default message if extraction fails
 * @returns A safe error message string
 */
export function getSafeErrorMessage(error, defaultMessage = 'Unknown error occurred') {
    try {
        return (error === null || error === void 0 ? void 0 : error.message) || String(error) || defaultMessage;
    }
    catch (_a) {
        return defaultMessage;
    }
}
/**
 * Categories of common errors
 */
export var ErrorCategory;
(function (ErrorCategory) {
    ErrorCategory["Network"] = "network";
    ErrorCategory["ApiKey"] = "api_key";
    ErrorCategory["RateLimit"] = "rate_limit";
    ErrorCategory["TokenLimit"] = "token_limit";
    ErrorCategory["CORS"] = "cors";
    ErrorCategory["Timeout"] = "timeout";
    ErrorCategory["NotFound"] = "not_found";
    ErrorCategory["Unknown"] = "unknown";
})(ErrorCategory || (ErrorCategory = {}));
/**
 * Detects error category based on error message content
 * @param error The error object
 * @returns The detected error category
 */
export function detectErrorCategory(error) {
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
export function createApiError(error, apiName) {
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
export function handleApiError(error, apiName, context) {
    // Log detailed error for debugging
    console.error(`[${apiName}]${context ? ' [' + context + ']' : ''} Error:`, error);
    // Return a user-friendly error
    return createApiError(error, apiName);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXJyb3ItdXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlcnJvci11dGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7R0FFRztBQUVIOzs7OztHQUtHO0FBQ0gsTUFBTSxVQUFVLG1CQUFtQixDQUFDLEtBQVUsRUFBRSxjQUFjLEdBQUcsd0JBQXdCO0lBQ3JGLElBQUksQ0FBQztRQUNELE9BQU8sQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsT0FBTyxLQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxjQUFjLENBQUM7SUFDN0QsQ0FBQztJQUFDLFdBQU0sQ0FBQztRQUNMLE9BQU8sY0FBYyxDQUFDO0lBQzFCLENBQUM7QUFDTCxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxNQUFNLENBQU4sSUFBWSxhQVNYO0FBVEQsV0FBWSxhQUFhO0lBQ3JCLG9DQUFtQixDQUFBO0lBQ25CLG1DQUFrQixDQUFBO0lBQ2xCLHlDQUF3QixDQUFBO0lBQ3hCLDJDQUEwQixDQUFBO0lBQzFCLDhCQUFhLENBQUE7SUFDYixvQ0FBbUIsQ0FBQTtJQUNuQix1Q0FBc0IsQ0FBQTtJQUN0QixvQ0FBbUIsQ0FBQTtBQUN2QixDQUFDLEVBVFcsYUFBYSxLQUFiLGFBQWEsUUFTeEI7QUFFRDs7OztHQUlHO0FBQ0gsTUFBTSxVQUFVLG1CQUFtQixDQUFDLEtBQVU7SUFDMUMsTUFBTSxPQUFPLEdBQUcsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7SUFFM0MsaUJBQWlCO0lBQ2pCLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUM7UUFDM0IsT0FBTyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUM7UUFDekIsT0FBTyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUM7UUFDM0IsT0FBTyxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUM7UUFDaEMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUM7UUFDaEMsT0FBTyxDQUFDLFFBQVEs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LGFBQWEsQ0FBQyxRQUFRO1lBQ3ZCLE9BQU8sSUFBSSxLQUFLLENBQUMsSUFBSSxPQUFPLDREQUE0RCxDQUFDLENBQUM7UUFFOUY7WUFDSSxrREFBa0Q7WUFDbEQsT0FBTyxJQUFJLEtBQUssQ0FBQyxJQUFJLE9BQU8sS0FBSyxlQUFlLEVBQUUsQ0FBQyxDQUFDO0lBQzVELENBQUM7QUFDTCxDQUFDO0FBRUQ7Ozs7OztHQU1HO0FBQ0gsTUFBTSxVQUFVLGNBQWMsQ0FBQyxLQUFVLEVBQUUsT0FBZSxFQUFFLE9BQWdCO0lBQ3hFLG1DQUFtQztJQUNuQyxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxHQUFHLE9BQU8sR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBRWxGLCtCQUErQjtJQUMvQixPQUFPLGNBQWMsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDMUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVXRpbGl0aWVzIGZvciBzdGFuZGFyZGl6ZWQgZXJyb3IgaGFuZGxpbmcgYWNyb3NzIHRoZSBwbHVnaW5cbiAqL1xuXG4vKipcbiAqIFNhZmVseSBleHRyYWN0cyBlcnJvciBtZXNzYWdlIGZyb20gYW55IHR5cGUgb2YgZXJyb3Igb2JqZWN0XG4gKiBAcGFyYW0gZXJyb3IgVGhlIGVycm9yIG9iamVjdFxuICogQHBhcmFtIGRlZmF1bHRNZXNzYWdlIERlZmF1bHQgbWVzc2FnZSBpZiBleHRyYWN0aW9uIGZhaWxzXG4gKiBAcmV0dXJucyBBIHNhZmUgZXJyb3IgbWVzc2FnZSBzdHJpbmdcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNhZmVFcnJvck1lc3NhZ2UoZXJyb3I6IGFueSwgZGVmYXVsdE1lc3NhZ2UgPSAnVW5rbm93biBlcnJvciBvY2N1cnJlZCcpOiBzdHJpbmcge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBlcnJvcj8ubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpIHx8IGRlZmF1bHRNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gZGVmYXVsdE1lc3NhZ2U7XG4gICAgfVxufVxuXG4vKipcbiAqIENhdGVnb3JpZXMgb2YgY29tbW9uIGVycm9yc1xuICovXG5leHBvcnQgZW51bSBFcnJvckNhdGVnb3J5IHtcbiAgICBOZXR3b3JrID0gJ25ldHdvcmsnLFxuICAgIEFwaUtleSA9ICdhcGlfa2V5JyxcbiAgICBSYXRlTGltaXQgPSAncmF0ZV9saW1pdCcsXG4gICAgVG9rZW5MaW1pdCA9ICd0b2tlbl9saW1pdCcsXG4gICAgQ09SUyA9ICdjb3JzJyxcbiAgICBUaW1lb3V0ID0gJ3RpbWVvdXQnLFxuICAgIE5vdEZvdW5kID0gJ25vdF9mb3VuZCcsXG4gICAgVW5rbm93biA9ICd1bmtub3duJ1xufVxuXG4vKipcbiAqIERldGVjdHMgZXJyb3IgY2F0ZWdvcnkgYmFzZWQgb24gZXJyb3IgbWVzc2FnZSBjb250ZW50XG4gKiBAcGFyYW0gZXJyb3IgVGhlIGVycm9yIG9iamVjdFxuICogQHJldHVybnMgVGhlIGRldGVjdGVkIGVycm9yIGNhdGVnb3J5XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RFcnJvckNhdGVnb3J5KGVycm9yOiBhbnkpOiBFcnJvckNhdGVnb3J5IHtcbiAgICBjb25zdCBtZXNzYWdlID0gZ2V0U2FmZUVycm9yTWVzc2FnZShlcnJvcik7XG4gICAgXG4gICAgLy8gTmV0d29yayBlcnJvcnNcbiAgICBpZiAobWVzc2FnZS5pbmNsdWRlcygnbmV0d29yaycpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCdmZXRjaCcpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCdjb25uZWN0JykgfHxcbiAgICAgICAgbWVzc2FnZS5pbmNsdWRlcygnRUNPTk5SRUZVU0VEJykgfHxcbiAgICAgICAgbWVzc2FnZS5pbmNsdWRlcygnTmV0d29ya0Vycm9yJykgfHxcbiAgICAgICAgbWVzc2FnZS5pbmNsdWRlcygnRmFpbGVkIHRvIGZldGNoJykpIHtcbiAgICAgICAgcmV0dXJuIEVycm9yQ2F0ZWdvcnkuTmV0d29yaztcbiAgICB9XG4gICAgXG4gICAgLy8gQ09SUyBlcnJvcnNcbiAgICBpZiAobWVzc2FnZS5pbmNsdWRlcygnQ09SUycpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCdDcm9zcy1PcmlnaW4nKSB8fCBcbiAgICAgICAgbWVzc2FnZS5pbmNsdWRlcygnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJykpIHtcbiAgICAgICAgcmV0dXJuIEVycm9yQ2F0ZWdvcnkuQ09SUztcbiAgICB9XG4gICAgXG4gICAgLy8gQVBJIGtleSBlcnJvcnNcbiAgICBpZiAobWVzc2FnZS5pbmNsdWRlcygnQVBJIGtleScpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCdhdXRoZW50aWNhdGlvbicpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCdhdXRoJykgfHwgXG4gICAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoJ3VuYXV0aG9yaXplZCcpKSB7XG4gICAgICAgIHJldHVybiBFcnJvckNhdGVnb3J5LkFwaUtleTtcbiAgICB9XG4gICAgXG4gICAgLy8gUmF0ZSBsaW1pdCBlcnJvcnNcbiAgICBpZiAobWVzc2FnZS5pbmNsdWRlcygncmF0ZSBsaW1pdCcpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCdxdW90YScpIHx8IFxuICAgICAgICBtZXNzYWdlLmluY2x1ZGVzKCd0b28gbWFueSByZXF1ZXN0cycpKSB7XG4gICAgICAgIHJldHVybiBFcnJvckNhdGVnb3J5LlJhdGVMaW1pdDtcbiAgICB9XG4gICAgXG4gICAgLy8gVG9rZW4gbGltaXQgZXJyb3JzXG4gICAgaWYgKG1lc3NhZ2UuaW5jbHVkZXMoJ2NvbnRleHQgbGVuZ3RoJykgfHwgXG4gICAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoJ3Rva2VuIGxpbWl0JykgfHwgXG4gICAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoJ21heF90b2tlbnMnKSkge1xuICAgICAgICByZXR1cm4gRXJyb3JDYXRlZ29yeS5Ub2tlbkxpbWl0O1xuICAgIH1cbiAgICBcbiAgICAvLyBUaW1lb3V0IGVycm9yc1xuICAgIGlmIChtZXNzYWdlLmluY2x1ZGVzKCd0aW1lb3V0JykgfHwgXG4gICAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoJ3RpbWVkIG91dCcpKSB7XG4gICAgICAgIHJldHVybiBFcnJvckNhdGVnb3J5LlRpbWVvdXQ7XG4gICAgfVxuICAgIFxuICAgIC8vIE5vdCBmb3VuZCBlcnJvcnNcbiAgICBpZiAobWVzc2FnZS5pbmNsdWRlcygnbm90IGZvdW5kJykgfHwgXG4gICAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoJzQwNCcpKSB7XG4gICAgICAgIHJldHVybiBFcnJvckNhdGVnb3J5Lk5vdEZvdW5kO1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gRXJyb3JDYXRlZ29yeS5Vbmtub3duO1xufVxuXG4vKipcbiAqIENyZWF0ZXMgYSBmcmllbmRseSBlcnJvciBtZXNzYWdlIGZvciBhIHNwZWNpZmljIEFQSVxuICogQHBhcmFtIGVycm9yIFRoZSBvcmlnaW5hbCBlcnJvclxuICogQHBhcmFtIGFwaU5hbWUgTmFtZSBvZiB0aGUgQVBJIHRvIHByZWZpeCBlcnJvciB3aXRoXG4gKiBAcmV0dXJucyBGb3JtYXR0ZWQgZXJyb3Igd2l0aCBhcHByb3ByaWF0ZSBtZXNzYWdlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVBcGlFcnJvcihlcnJvcjogYW55LCBhcGlOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gICAgY29uc3QgY2F0ZWdvcnkgPSBkZXRlY3RFcnJvckNhdGVnb3J5KGVycm9yKTtcbiAgICBjb25zdCBvcmlnaW5hbE1lc3NhZ2UgPSBnZXRTYWZlRXJyb3JNZXNzYWdlKGVycm9yKTtcbiAgICBcbiAgICBzd2l0Y2ggKGNhdGVnb3J5KSB7XG4gICAgICAgIGNhc2UgRXJyb3JDYXRlZ29yeS5OZXR3b3JrOlxuICAgICAgICAgICAgcmV0dXJuIG5ldyBFcnJvcihgWyR7YXBpTmFtZX1dIE5ldHdvcmsgZXJyb3Igd2hpbGUgY29ubmVjdGluZyB0byBzZXJ2aWNlLiBQbGVhc2UgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uLmApO1xuICAgICAgICAgICAgXG4gICAgICAgIGNhc2UgRXJyb3JDYXRlZ29yeS5DT1JTOlxuICAgICAgICAgICAgcmV0dXJuIG5ldyBFcnJvcihgWyR7YXBpTmFtZX1dIENPUlMgcG9saWN5IGJsb2NrZWQgdGhlIHJlcXVlc3QuIFBsZWFzZSBjaGVjayB5b3VyIGNvbm5lY3Rpb24gb3IgdHJ5IGEgZGlmZmVyZW50IHJlcXVlc3QuYCk7XG4gICAgICAgICAgICBcbiAgICAgICAgY2FzZSBFcnJvckNhdGVnb3J5LkFwaUtleTpcbiAgICAgICAgICAgIHJldHVybiBuZXcgRXJyb3IoYFske2FwaU5hbWV9XSBJbnZhbGlkIEFQSSBrZXkgb3IgYXV0aGVudGljYXRpb24gZXJyb3IuIFBsZWFzZSBjaGVjayB5b3VyIHNldHRpbmdzLmApO1xuICAgICAgICAgICAgXG4gICAgICAgIGNhc2UgRXJyb3JDYXRlZ29yeS5SYXRlTGltaXQ6XG4gICAgICAgICAgICByZXR1cm4gbmV3IEVycm9yKGBbJHthcGlOYW1lfV0gUmF0ZSBsaW1pdCByZWFjaGVkIG9yIHF1b3RhIGV4Y2VlZGVkLiBQbGVhc2UgdHJ5IGFnYWluIGxhdGVyLmApO1xuICAgICAgICAgICAgXG4gICAgICAgIGNhc2UgRXJyb3JDYXRlZ29yeS5Ub2tlbkxpbWl0OlxuICAgICAgICAgICAgcmV0dXJuIG5ldyBFcnJvcihgWyR7YXBpTmFtZX1dIElucHV0IHRvbyBsb25nIGZvciBtb2RlbCdzIGNvbnRleHQgd2luZG93LmApO1xuICAgICAgICAgICAgXG4gICAgICAgIGNhc2UgRXJyb3JDYXRlZ29yeS5UaW1lb3V0OlxuICAgICAgICAgICAgcmV0dXJuIG5ldyBFcnJvcihgWyR7YXBpTmFtZX1dIFJlcXVlc3QgdGltZWQgb3V0LiBQbGVhc2UgdHJ5IGFnYWluLmApO1xuICAgICAgICAgICAgXG4gICAgICAgIGNhc2UgRXJyb3JDYXRlZ29yeS5Ob3RGb3VuZDpcbiAgICAgICAgICAgIHJldHVybiBuZXcgRXJyb3IoYFske2FwaU5hbWV9XSBSZXNvdXJjZSBub3QgZm91bmQuIFBsZWFzZSBjaGVjayB0aGUgcmVxdWVzdCBwYXJhbWV0ZXJzLmApO1xuICAgICAgICAgICAgXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAvLyBGb3IgdW5rbm93biBlcnJvcnMsIGFwcGVuZCB0aGUgb3JpZ2luYWwgbWVzc2FnZVxuICAgICAgICAgICAgcmV0dXJuIG5ldyBFcnJvcihgWyR7YXBpTmFtZX1dICR7b3JpZ2luYWxNZXNzYWdlfWApO1xuICAgIH1cbn1cblxuLyoqXG4gKiBMb2dzIGFuIGVycm9yIHdpdGggc3RhbmRhcmRpemVkIGZvcm1hdHRpbmcgYW5kIHJldHVybnMgYSB1c2VyLWZyaWVuZGx5IGVycm9yXG4gKiBAcGFyYW0gZXJyb3IgVGhlIG9yaWdpbmFsIGVycm9yXG4gKiBAcGFyYW0gYXBpTmFtZSBOYW1lIG9mIHRoZSBBUEkgdG8gcHJlZml4IGVycm9yIHdpdGhcbiAqIEBwYXJhbSBjb250ZXh0IEFkZGl0aW9uYWwgY29udGV4dCBmb3IgZGVidWdnaW5nXG4gKiBAcmV0dXJucyBGb3JtYXR0ZWQgZXJyb3Igd2l0aCBhcHByb3ByaWF0ZSBtZXNzYWdlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVBcGlFcnJvcihlcnJvcjogYW55LCBhcGlOYW1lOiBzdHJpbmcsIGNvbnRleHQ/OiBzdHJpbmcpOiBFcnJvciB7XG4gICAgLy8gTG9nIGRldGFpbGVkIGVycm9yIGZvciBkZWJ1Z2dpbmdcbiAgICBjb25zb2xlLmVycm9yKGBbJHthcGlOYW1lfV0ke2NvbnRleHQgPyAnIFsnICsgY29udGV4dCArICddJyA6ICcnfSBFcnJvcjpgLCBlcnJvcik7XG4gICAgXG4gICAgLy8gUmV0dXJuIGEgdXNlci1mcmllbmRseSBlcnJvclxuICAgIHJldHVybiBjcmVhdGVBcGlFcnJvcihlcnJvciwgYXBpTmFtZSk7XG59ICJdfQ==