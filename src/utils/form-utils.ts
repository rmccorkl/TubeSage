import { Notice } from 'obsidian';

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
 * Validates a value against a custom validation function
 * 
 * @param value The value to validate
 * @param validationFn The validation function
 * @param errorMessage Message to show if validation fails
 * @returns Validation result
 */
export function validateCustom(
    value: string, 
    validationFn: (value: string) => boolean, 
    errorMessage: string
): ValidationResult {
    if (!validationFn(value)) {
        return {
            isValid: false,
            message: errorMessage
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
            setTimeout(() => {
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
 * Validates an input field and displays error if invalid
 * 
 * @param inputEl The input element to validate
 * @param errorEl The error display element
 * @param validationFn The validation function
 * @returns Whether validation passed
 */
export function validateInputField(
    value: string,
    errorEl: HTMLElement,
    validations: ValidationResult[]
): boolean {
    // Check all validations
    for (const validation of validations) {
        if (!validation.isValid) {
            // Explicitly use the namespaced error class for consistency
            return displayValidationResult(validation, { 
                element: errorEl,
                styleClass: 'tubesage-error'
            });
        }
    }
    
    // All validations passed
    errorEl.addClass('tubesage-error-hidden');
    errorEl.removeClass('tubesage-error-visible');
    return true;
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

/**
 * Shows a notification with a timeout
 * 
 * @param message The message to display
 * @param timeout Duration to show the notice (ms)
 */
export function showNotice(message: string, timeout: number = 5000): void {
    new Notice(message);
}

/**
 * Filter a list of items by a search term
 * 
 * @param items List of items to filter
 * @param searchTerm Search term to filter by
 * @param getSearchableText Function to extract searchable text from an item
 * @returns Filtered list of items
 */
export function filterItems<T>(
    items: T[],
    searchTerm: string,
    getSearchableText: (item: T) => string
): T[] {
    if (!searchTerm || searchTerm.trim() === '') {
        return items; // Return all items if no search term
    }
    
    const lowerSearchTerm = searchTerm.toLowerCase().trim();
    
    return items.filter(item => {
        const text = getSearchableText(item).toLowerCase();
        return text.includes(lowerSearchTerm);
    });
}

/**
 * Creates a key handler for navigation in a list with arrow keys
 * 
 * @param getItems Function to get all items
 * @param selectItem Function to select an item
 * @param onEnter Function to handle Enter key press
 * @returns KeyboardEvent handler function
 */
export function createListKeyHandler(
    getItems: () => HTMLElement[],
    selectItem: (item: HTMLElement) => void,
    onEnter: () => void,
    onEscape?: () => void
): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent) => {
        if (e.key === 'Escape' && onEscape) {
            e.preventDefault();
            onEscape();
            return;
        }
        
        if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
            return;
        }
        
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            
            const items = getItems();
            if (items.length === 0) return;
            
            // Find currently selected item
            const selectedItem = items.find(item => item.classList.contains('selected'));
            const currentIndex = selectedItem ? items.indexOf(selectedItem) : -1;
            
            let newIndex: number;
            if (e.key === 'ArrowDown') {
                newIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
            } else {
                newIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
            }
            
            selectItem(items[newIndex]);
            items[newIndex].scrollIntoView({ block: 'nearest' });
        }
    };
} 
