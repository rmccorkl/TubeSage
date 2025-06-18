import { Notice } from 'obsidian';
/**
 * Validates that a required field has a value
 *
 * @param value The value to check
 * @param fieldName The name of the field (for error message)
 * @returns Validation result
 */
export function validateRequired(value, fieldName = 'field') {
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
export function validateCustom(value, validationFn, errorMessage) {
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
export function displayValidationResult(result, options) {
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
    }
    else {
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
export function validateInputField(value, errorEl, validations) {
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
export function validateYouTubeUrl(url, isYoutubeUrlFn) {
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
export function showNotice(message, timeout = 5000) {
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
export function filterItems(items, searchTerm, getSearchableText) {
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
export function createListKeyHandler(getItems, selectItem, onEnter, onEscape) {
    return (e) => {
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
            if (items.length === 0)
                return;
            // Find currently selected item
            const selectedItem = items.find(item => item.classList.contains('selected'));
            const currentIndex = selectedItem ? items.indexOf(selectedItem) : -1;
            let newIndex;
            if (e.key === 'ArrowDown') {
                newIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
            }
            else {
                newIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
            }
            selectItem(items[newIndex]);
            items[newIndex].scrollIntoView({ block: 'nearest' });
        }
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZm9ybS11dGlscy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImZvcm0tdXRpbHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFPLE1BQU0sRUFBRSxNQUFNLFVBQVUsQ0FBQztBQXVCdkM7Ozs7OztHQU1HO0FBQ0gsTUFBTSxVQUFVLGdCQUFnQixDQUFDLEtBQWEsRUFBRSxZQUFvQixPQUFPO0lBQ3ZFLElBQUksQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1FBQ2hDLE9BQU87WUFDSCxPQUFPLEVBQUUsS0FBSztZQUNkLE9BQU8sRUFBRSxrQkFBa0IsU0FBUyxFQUFFO1NBQ3pDLENBQUM7SUFDTixDQUFDO0lBRUQsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQztBQUM3QixDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sVUFBVSxjQUFjLENBQzFCLEtBQWEsRUFDYixZQUF3QyxFQUN4QyxZQUFvQjtJQUVwQixJQUFJLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDdkIsT0FBTztZQUNILE9BQU8sRUFBRSxLQUFLO1lBQ2QsT0FBTyxFQUFFLFlBQVk7U0FDeEIsQ0FBQztJQUNOLENBQUM7SUFFRCxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxDQUFDO0FBQzdCLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsdUJBQXVCLENBQ25DLE1BQXdCLEVBQ3hCLE9BQTRCO0lBRTVCLE1BQU0sRUFBRSxPQUFPLEVBQUUsVUFBVSxHQUFHLE9BQU8sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUM7SUFFM0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNsQixzREFBc0Q7UUFDdEQsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLE9BQU8sSUFBSSxtQkFBbUIsQ0FBQztRQUN0RCxPQUFPLENB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QUFNLFlBQVksR0FBRyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBRXJFLElBQUksUUFBZ0IsQ0FBQztZQUNyQixJQUFJLENBQUMsQ0FBQyxHQUFHLEtBQUssV0FBVyxFQUFFLENBQUM7Z0JBQ3hCLFFBQVEsR0FBRyxZQUFZLEdBQUcsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN0RSxDQUFDO2lCQUFNLENBQUM7Z0JBQ0osUUFBUSxHQUFHLFlBQVksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1lBQ3RFLENBQUM7WUFFRCxVQUFVLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7WUFDNUIsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxFQUFFLEtBQUssRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDO1FBQ3pELENBQUM7SUFDTCxDQUFDLENBQUM7QUFDTixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXBwLCBOb3RpY2UgfSBmcm9tICdvYnNpZGlhbic7XG5cbi8qKlxuICogRm9ybSB2YWxpZGF0aW9uIGFuZCBVSSB1dGlsaXRpZXMgdG8gcmVkdWNlIGR1cGxpY2F0aW9uIGFjcm9zcyBtb2RhbCBjbGFzc2VzXG4gKi9cblxuLyoqXG4gKiBJbnRlcmZhY2UgZm9yIHZhbGlkYXRpb24gcmVzdWx0c1xuICovXG5leHBvcnQgaW50ZXJmYWNlIFZhbGlkYXRpb25SZXN1bHQge1xuICAgIGlzVmFsaWQ6IGJvb2xlYW47XG4gICAgbWVzc2FnZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBkaXNwbGF5aW5nIGVycm9yIG1lc3NhZ2VzXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXJyb3JEaXNwbGF5T3B0aW9ucyB7XG4gICAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XG4gICAgc3R5bGVDbGFzcz86IHN0cmluZztcbiAgICB0aW1lb3V0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlcyB0aGF0IGEgcmVxdWlyZWQgZmllbGQgaGFzIGEgdmFsdWVcbiAqIFxuICogQHBhcmFtIHZhbHVlIFRoZSB2YWx1ZSB0byBjaGVja1xuICogQHBhcmFtIGZpZWxkTmFtZSBUaGUgbmFtZSBvZiB0aGUgZmllbGQgKGZvciBlcnJvciBtZXNzYWdlKVxuICogQHJldHVybnMgVmFsaWRhdGlvbiByZXN1bHRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlUmVxdWlyZWQodmFsdWU6IHN0cmluZywgZmllbGROYW1lOiBzdHJpbmcgPSAnZmllbGQnKTogVmFsaWRhdGlvblJlc3VsdCB7XG4gICAgaWYgKCF2YWx1ZSB8fCB2YWx1ZS50cmltKCkgPT09ICcnKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpc1ZhbGlkOiBmYWxzZSxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBQbGVhc2UgZW50ZXIgYSAke2ZpZWxkTmFtZX1gXG4gICAgICAgIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB7IGlzVmFsaWQ6IHRydWUgfTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZXMgYSB2YWx1ZSBhZ2FpbnN0IGEgY3VzdG9tIHZhbGlkYXRpb24gZnVuY3Rpb25cbiAqIFxuICogQHBhcmFtIHZhbHVlIFRoZSB2YWx1ZSB0byB2YWxpZGF0ZVxuICogQHBhcmFtIHZhbGlkYXRpb25GbiBUaGUgdmFsaWRhdGlvbiBmdW5jdGlvblxuICogQHBhcmFtIGVycm9yTWVzc2FnZSBNZXNzYWdlIHRvIHNob3cgaWYgdmFsaWRhdGlvbiBmYWlsc1xuICogQHJldHVybnMgVmFsaWRhdGlvbiByZXN1bHRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlQ3VzdG9tKFxuICAgIHZhbHVlOiBzdHJpbmcsIFxuICAgIHZhbGlkYXRpb25GbjogKHZhbHVlOiBzdHJpbmcpID0+IGJvb2xlYW4sIFxuICAgIGVycm9yTWVzc2FnZTogc3RyaW5nXG4pOiBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgICBpZiAoIXZhbGlkYXRpb25Gbih2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlzVmFsaWQ6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3JNZXNzYWdlXG4gICAgICAgIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB7IGlzVmFsaWQ6IHRydWUgfTtcbn1cblxuLyoqXG4gKiBTaG93cyBhbiBlcnJvciBtZXNzYWdlIGluIHRoZSBzcGVjaWZpZWQgZWxlbWVudFxuICogXG4gKiBAcGFyYW0gcmVzdWx0IFRoZSB2YWxpZGF0aW9uIHJlc3VsdFxuICogQHBhcmFtIG9wdGlvbnMgT3B0aW9ucyBmb3IgZGlzcGxheWluZyB0aGUgZXJyb3JcbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIHZhbGlkYXRpb24gcGFzc2VkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaXNwbGF5VmFsaWRhdGlvblJlc3VsdChcbiAgICByZXN1bHQ6IFZhbGlkYXRpb25SZXN1bHQsIFxuICAgIG9wdGlvbnM6IEVycm9yRGlzcGxheU9wdGlvbnNcbik6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHsgZWxlbWVudCwgc3R5bGVDbGFzcyA9ICdlcnJvcicsIHRpbWVvdXQgfSA9IG9wdGlvbnM7XG4gICAgXG4gICAgaWYgKCFyZXN1bHQuaXNWYWxpZCkge1xuICAgICAgICAvLyBTZXQgZXJyb3IgbWVzc2FnZSwgd2l0aCBhIGZhbGxiYWNrIGlmIG5vbmUgcHJvdmlkZWRcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IHJlc3VsdC5tZXNzYWdlIHx8ICdBbiBlcnJvciBvY2N1cnJlZCc7XG4gICAgICAgIGVsZW1lbnQuc2V0VGV4dChtZXNzYWdlKTtcbiAgICAgICAgXG4gICAgICAgIC8vIFNob3cgdGhlIGVycm9yIGVsZW1lbnQgYnkgYWRkaW5nIHZpc2libGUgY2xhc3MgYW5kIHJlbW92aW5nIGhpZGRlbiBjbGFzc1xuICAgICAgICBlbGVtZW50LmFkZENsYXNzKCd0dWJlc2FnZS1lcnJvci12aXNpYmxlJyk7XG4gICAgICAgIGVsZW1lbnQucmVtb3ZlQ2xhc3MoJ3R1YmVzYWdlLWVycm9yLWhpZGRlbicpO1xuICAgICAgICBcbiAgICAgICAgLy8gQXBwbHkgc3R5bGUgY2xhc3MgaWYgcHJvdmlkZWQsIGVuc3VyaW5nIGl0J3MgbmFtZXNwYWNlZFxuICAgICAgICBpZiAoc3R5bGVDbGFzcykge1xuICAgICAgICAgICAgLy8gSWYgc3R5bGVDbGFzcyBhbHJlYWR5IGhhcyB0dWJlc2FnZS0gcHJlZml4LCB1c2UgaXQgYXMgaXNcbiAgICAgICAgICAgIC8vIE90aGVyd2lzZSBhZGQgdGhlIHByZWZpeCB0byBlbnN1cmUgcHJvcGVyIG5hbWVzcGFjaW5nXG4gICAgICAgICAgICBjb25zdCBuYW1lc3BhY2VkQ2xhc3MgPSBzdHlsZUNsYXNzLnN0YXJ0c1dpdGgoJ3R1YmVzYWdlLScpIFxuICAgICAgICAgICAgICAgID8gc3R5bGVDbGFzcyBcbiAgICAgICAgICAgICAgICA6IGB0dWJlc2FnZS0ke3N0eWxlQ2xhc3N9YDtcbiAgICAgICAgICAgIGVsZW1lbnQuYWRkQ2xhc3MobmFtZXNwYWNlZENsYXNzKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gQXV0by1oaWRlIGFmdGVyIHRpbWVvdXQgaWYgcHJvdmlkZWRcbiAgICAgICAgaWYgKHRpbWVvdXQpIHtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIGVsZW1lbnQuYWRkQ2xhc3MoJ3R1YmVzYWdlLWVycm9yLWhpZGRlbicpO1xuICAgICAgICAgICAgICAgIGVsZW1lbnQucmVtb3ZlQ2xhc3MoJ3R1YmVzYWdlLWVycm9yLXZpc2libGUnKTtcbiAgICAgICAgICAgIH0sIHRpbWVvdXQpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gSGlkZSBlcnJvciBlbGVtZW50IGlmIHZhbGlkYXRpb24gcGFzc2VkXG4gICAgICAgIGVsZW1lbnQuYWRkQ2xhc3MoJ3R1YmVzYWdlLWVycm9yLWhpZGRlbicpO1xuICAgICAgICBlbGVtZW50LnJlbW92ZUNsYXNzKCd0dWJlc2FnZS1lcnJvci12aXNpYmxlJyk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuLyoqXG4gKiBWYWxpZGF0ZXMgYW4gaW5wdXQgZmllbGQgYW5kIGRpc3BsYXlzIGVycm9yIGlmIGludmFsaWRcbiAqIFxuICogQHBhcmFtIGlucHV0RWwgVGhlIGlucHV0IGVsZW1lbnQgdG8gdmFsaWRhdGVcbiAqIEBwYXJhbSBlcnJvckVsIFRoZSBlcnJvciBkaXNwbGF5IGVsZW1lbnRcbiAqIEBwYXJhbSB2YWxpZGF0aW9uRm4gVGhlIHZhbGlkYXRpb24gZnVuY3Rpb25cbiAqIEByZXR1cm5zIFdoZXRoZXIgdmFsaWRhdGlvbiBwYXNzZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlSW5wdXRGaWVsZChcbiAgICB2YWx1ZTogc3RyaW5nLFxuICAgIGVycm9yRWw6IEhUTUxFbGVtZW50LFxuICAgIHZhbGlkYXRpb25zOiBWYWxpZGF0aW9uUmVzdWx0W11cbik6IGJvb2xlYW4ge1xuICAgIC8vIENoZWNrIGFsbCB2YWxpZGF0aW9uc1xuICAgIGZvciAoY29uc3QgdmFsaWRhdGlvbiBvZiB2YWxpZGF0aW9ucykge1xuICAgICAgICBpZiAoIXZhbGlkYXRpb24uaXNWYWxpZCkge1xuICAgICAgICAgICAgLy8gRXhwbGljaXRseSB1c2UgdGhlIG5hbWVzcGFjZWQgZXJyb3IgY2xhc3MgZm9yIGNvbnNpc3RlbmN5XG4gICAgICAgICAgICByZXR1cm4gZGlzcGxheVZhbGlkYXRpb25SZXN1bHQodmFsaWRhdGlvbiwgeyBcbiAgICAgICAgICAgICAgICBlbGVtZW50OiBlcnJvckVsLFxuICAgICAgICAgICAgICAgIHN0eWxlQ2xhc3M6ICd0dWJlc2FnZS1lcnJvcidcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIC8vIEFsbCB2YWxpZGF0aW9ucyBwYXNzZWRcbiAgICBlcnJvckVsLmFkZENsYXNzKCd0dWJlc2FnZS1lcnJvci1oaWRkZW4nKTtcbiAgICBlcnJvckVsLnJlbW92ZUNsYXNzKCd0dWJlc2FnZS1lcnJvci12aXNpYmxlJyk7XG4gICAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYSBZb3VUdWJlIFVSTCAodXRpbGl0eSB3cmFwcGVyKVxuICogXG4gKiBAcGFyYW0gdXJsIFRoZSBVUkwgdG8gdmFsaWRhdGVcbiAqIEBwYXJhbSBpc1lvdXR1YmVVcmxGbiBUaGUgWW91VHViZSBVUkwgdmFsaWRhdGlvbiBmdW5jdGlvblxuICogQHJldHVybnMgVmFsaWRhdGlvbiByZXN1bHRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlWW91VHViZVVybChcbiAgICB1cmw6IHN0cmluZywgXG4gICAgaXNZb3V0dWJlVXJsRm46ICh1cmw6IHN0cmluZykgPT4gYm9vbGVhblxuKTogVmFsaWRhdGlvblJlc3VsdCB7XG4gICAgaWYgKCF1cmwpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlzVmFsaWQ6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogJ1BsZWFzZSBlbnRlciBhIFlvdVR1YmUgVVJMJ1xuICAgICAgICB9O1xuICAgIH1cbiAgICBcbiAgICBpZiAoIWlzWW91dHViZVVybEZuKHVybCkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlzVmFsaWQ6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogJ1BsZWFzZSBlbnRlciBhIHZhbGlkIFlvdVR1YmUgdmlkZW8sIHBsYXlsaXN0LCBvciBjaGFubmVsIFVSTCdcbiAgICAgICAgfTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHsgaXNWYWxpZDogdHJ1ZSB9O1xufVxuXG4vKipcbiAqIFNob3dzIGEgbm90aWZpY2F0aW9uIHdpdGggYSB0aW1lb3V0XG4gKiBcbiAqIEBwYXJhbSBtZXNzYWdlIFRoZSBtZXNzYWdlIHRvIGRpc3BsYXlcbiAqIEBwYXJhbSB0aW1lb3V0IER1cmF0aW9uIHRvIHNob3cgdGhlIG5vdGljZSAobXMpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93Tm90aWNlKG1lc3NhZ2U6IHN0cmluZywgdGltZW91dDogbnVtYmVyID0gNTAwMCk6IHZvaWQge1xuICAgIG5ldyBOb3RpY2UobWVzc2FnZSk7XG59XG5cbi8qKlxuICogRmlsdGVyIGEgbGlzdCBvZiBpdGVtcyBieSBhIHNlYXJjaCB0ZXJtXG4gKiBcbiAqIEBwYXJhbSBpdGVtcyBMaXN0IG9mIGl0ZW1zIHRvIGZpbHRlclxuICogQHBhcmFtIHNlYXJjaFRlcm0gU2VhcmNoIHRlcm0gdG8gZmlsdGVyIGJ5XG4gKiBAcGFyYW0gZ2V0U2VhcmNoYWJsZVRleHQgRnVuY3Rpb24gdG8gZXh0cmFjdCBzZWFyY2hhYmxlIHRleHQgZnJvbSBhbiBpdGVtXG4gKiBAcmV0dXJucyBGaWx0ZXJlZCBsaXN0IG9mIGl0ZW1zXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJJdGVtczxUPihcbiAgICBpdGVtczogVFtdLFxuICAgIHNlYXJjaFRlcm06IHN0cmluZyxcbiAgICBnZXRTZWFyY2hhYmxlVGV4dDogKGl0ZW06IFQpID0+IHN0cmluZ1xuKTogVFtdIHtcbiAgICBpZiAoIXNlYXJjaFRlcm0gfHwgc2VhcmNoVGVybS50cmltKCkgPT09ICcnKSB7XG4gICAgICAgIHJldHVybiBpdGVtczsgLy8gUmV0dXJuIGFsbCBpdGVtcyBpZiBubyBzZWFyY2ggdGVybVxuICAgIH1cbiAgICBcbiAgICBjb25zdCBsb3dlclNlYXJjaFRlcm0gPSBzZWFyY2hUZXJtLnRvTG93ZXJDYXNlKCkudHJpbSgpO1xuICAgIFxuICAgIHJldHVybiBpdGVtcy5maWx0ZXIoaXRlbSA9PiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBnZXRTZWFyY2hhYmxlVGV4dChpdGVtKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gdGV4dC5pbmNsdWRlcyhsb3dlclNlYXJjaFRlcm0pO1xuICAgIH0pO1xufVxuXG4vKipcbiAqIENyZWF0ZXMgYSBrZXkgaGFuZGxlciBmb3IgbmF2aWdhdGlvbiBpbiBhIGxpc3Qgd2l0aCBhcnJvdyBrZXlzXG4gKiBcbiAqIEBwYXJhbSBnZXRJdGVtcyBGdW5jdGlvbiB0byBnZXQgYWxsIGl0ZW1zXG4gKiBAcGFyYW0gc2VsZWN0SXRlbSBGdW5jdGlvbiB0byBzZWxlY3QgYW4gaXRlbVxuICogQHBhcmFtIG9uRW50ZXIgRnVuY3Rpb24gdG8gaGFuZGxlIEVudGVyIGtleSBwcmVzc1xuICogQHJldHVybnMgS2V5Ym9hcmRFdmVudCBoYW5kbGVyIGZ1bmN0aW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVMaXN0S2V5SGFuZGxlcihcbiAgICBnZXRJdGVtczogKCkgPT4gSFRNTEVsZW1lbnRbXSxcbiAgICBzZWxlY3RJdGVtOiAoaXRlbTogSFRNTEVsZW1lbnQpID0+IHZvaWQsXG4gICAgb25FbnRlcjogKCkgPT4gdm9pZCxcbiAgICBvbkVzY2FwZT86ICgpID0+IHZvaWRcbik6IChlOiBLZXlib2FyZEV2ZW50KSA9PiB2b2lkIHtcbiAgICByZXR1cm4gKGU6IEtleWJvYXJkRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJyAmJiBvbkVzY2FwZSkge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgb25Fc2NhcGUoKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICBvbkVudGVyKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicgfHwgZS5rZXkgPT09ICdBcnJvd1VwJykge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBpdGVtcyA9IGdldEl0ZW1zKCk7XG4gICAgICAgICAgICBpZiAoaXRlbXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEZpbmQgY3VycmVudGx5IHNlbGVjdGVkIGl0ZW1cbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkSXRlbSA9IGl0ZW1zLmZpbmQoaXRlbSA9PiBpdGVtLmNsYXNzTGlzdC5jb250YWlucygnc2VsZWN0ZWQnKSk7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50SW5kZXggPSBzZWxlY3RlZEl0ZW0gPyBpdGVtcy5pbmRleE9mKHNlbGVjdGVkSXRlbSkgOiAtMTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IG5ld0luZGV4OiBudW1iZXI7XG4gICAgICAgICAgICBpZiAoZS5rZXkgPT09ICdBcnJvd0Rvd24nKSB7XG4gICAgICAgICAgICAgICAgbmV3SW5kZXggPSBjdXJyZW50SW5kZXggPCBpdGVtcy5sZW5ndGggLSAxID8gY3VycmVudEluZGV4ICsgMSA6IDA7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5ld0luZGV4ID0gY3VycmVudEluZGV4ID4gMCA/IGN1cnJlbnRJbmRleCAtIDEgOiBpdGVtcy5sZW5ndGggLSAxO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBzZWxlY3RJdGVtKGl0ZW1zW25ld0luZGV4XSk7XG4gICAgICAgICAgICBpdGVtc1tuZXdJbmRleF0uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogJ25lYXJlc3QnIH0pO1xuICAgICAgICB9XG4gICAgfTtcbn0gIl19