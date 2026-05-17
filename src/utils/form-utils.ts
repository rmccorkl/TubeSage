/**
 * Form validation and UI utilities to reduce duplication across modal classes
 */

/**
 * Interface for validation results
 */
export interface ValidationResult {
    isValid: boolean;
    message?: string;
}

/**
 * Options for displaying error messages
 */
export interface ErrorDisplayOptions {
    element: HTMLElement;
    styleClass?: string;
    timeout?: number;
}

/**
 * Validates that a required field has a value
 * 
 * @param value The value to check
 * @param fieldName The name of the field (for error message)
 * @returns Validation result
 */
export function validateRequired(value: string, fieldName: string = 'field'): ValidationResult {
    if (!value || value.trim() === '') {
        return {
            isValid: false,
            message: `Please enter a ${fieldName}`
        };
    }
    
    return { isValid: true };
}

/**
 * Shows an error message in the specified element
 * 
 * @param result The validation result
 * @param options Options for displaying the error
 * @returns Whether the validation passed
 */
export function displayValidationResult(
    result: ValidationResult, 
    options: ErrorDisplayOptions
): boolean {
    const { element, styleClass = 'error', timeout } = options;
    
    if (!result.isValid) {
        // Set error message, with a fallback if none provided
        const message = result.message || 'An error occurred';
        element.setText(message);
        
        // Show the error element by adding visible class and removing hidden class
        element.addClass('tubesage-error-visible');
        element.removeClass('tubesage-error-hidden');
        
        // Apply style class if provided, ensuring it's namespaced
        if (styleClass) {
            // If styleClass already has tubesage- prefix, use it as is
            // Otherwise add the prefix to ensure proper namespacing
            const namespacedClass = styleClass.startsWith('tubesage-') 
                ? styleClass 
                : `tubesage-${styleClass}`;
            element.addClass(namespacedClass);
        }
        
        // Auto-hide after timeout if provided
        if (timeout) {
            window.setTimeout(() => {
                element.addClass('tubesage-error-hidden');
                element.removeClass('tubesage-error-visible');
            }, timeout);
        }
        
        return false;
    } else {
        // Hide error element if validation passed
        element.addClass('tubesage-error-hidden');
        element.removeClass('tubesage-error-visible');
        return true;
    }
}

/**
 * Validate a YouTube URL (utility wrapper)
 * 
 * @param url The URL to validate
 * @param isYoutubeUrlFn The YouTube URL validation function
 * @returns Validation result
 */
export function validateYouTubeUrl(
    url: string, 
    isYoutubeUrlFn: (url: string) => boolean
): ValidationResult {
    if (!url) {
        return {
            isValid: false,
            message: 'Please enter a YouTube URL'
        };
    }
    
    if (!isYoutubeUrlFn(url)) {
        return {
            isValid: false,
            message: 'Please enter a valid YouTube video, playlist, or channel URL'
        };
    }
    
    return { isValid: true };
}

