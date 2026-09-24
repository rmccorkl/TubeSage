/**
 * Form validation and UI utilities to reduce duplication across modal classes
 *
 * THE `t` IMPORT DOES NOT MAKE THIS MODULE OBSIDIAN-DEPENDENT. `../i18n`
 * imports only `./locales`, which is static JSON, and reads the interface
 * language through a resolver `main.ts` installs at runtime — `getLanguage`
 * is imported in main.ts and nowhere else. `src/settings/setting-definitions.ts`
 * and `src/runtime/job-progress-notice.ts` both import `t` exactly this way to
 * stay unit-testable without an Obsidian runtime; this module follows them.
 */
import { t } from '../i18n';

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
 * `fieldName` is REQUIRED rather than defaulting to `'field'`: the default was
 * an English literal a caller could inherit without noticing, which is the
 * trap this file was localised to remove. Callers pass an already-translated
 * label — `t('modal.create.urlLabel')` — so the name the sentence quotes is
 * the one the dialog actually renders above the input.
 *
 * @param value The value to check
 * @param fieldName The translated label of the field (quoted in the message)
 * @returns Validation result
 */
export function validateRequired(value: string, fieldName: string): ValidationResult {
    if (!value || value.trim() === '') {
        return {
            isValid: false,
            message: t('common.validation.required', { field: fieldName })
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
        const message = result.message || t('common.validation.genericError');
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
        // The same sentence validateRequired builds, with the same label: this
        // branch and an empty-value validateRequired describe one condition.
        return {
            isValid: false,
            message: t('common.validation.required', { field: t('modal.create.urlLabel') })
        };
    }
    
    if (!isYoutubeUrlFn(url)) {
        // Reused rather than coined: `modal.create.urlInvalid` is the line the
        // SAME dialog already shows while the user types (main.ts:3429), and it
        // asserts the same fact about the same three accepted forms. Two
        // different sentences for one condition in one dialog is the drift the
        // reuse-before-coining rule exists to prevent.
        return {
            isValid: false,
            message: t('modal.create.urlInvalid')
        };
    }
    
    return { isValid: true };
}

