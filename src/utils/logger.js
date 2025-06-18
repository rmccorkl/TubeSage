/**
 * Centralized logging utility for the YouTube Transcript plugin
 */
/**
 * Log levels
 */
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
    LogLevel[LogLevel["NONE"] = 4] = "NONE"; // Used to disable all logging
})(LogLevel || (LogLevel = {}));
// Default configuration
const defaultConfig = {
    globalLogLevel: LogLevel.INFO,
    categoryLevels: {},
    includeTimestamp: false,
    includePrefix: true
};
// Current configuration
let config = Object.assign({}, defaultConfig);
// Central buffer to store all log messages
const logBuffer = [];
/**
 * Logger class for a specific category
 */
export class Logger {
    /**
     * Creates a new logger for a specific category
     * @param category The logging category (e.g., 'PROXY', 'LLM', 'UI')
     */
    constructor(category) {
        this.category = category;
    }
    /**
     * Logs a debug message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    debug(message, ...args) {
        this.log(LogLevel.DEBUG, message, ...args);
    }
    /**
     * Logs an info message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    info(message, ...args) {
        this.log(LogLevel.INFO, message, ...args);
    }
    /**
     * Logs a warning message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    warn(message, ...args) {
        this.log(LogLevel.WARN, message, ...args);
    }
    /**
     * Logs an error message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    error(message, ...args) {
        this.log(LogLevel.ERROR, message, ...args);
    }
    /**
     * Internal logging method
     * @param level Log level
     * @param message Message to log
     * @param args Additional arguments to log
     */
    log(level, message, ...args) {
        // Check if we should log this message based on level
        if (!this.shouldLog(level)) {
            return;
        }
        // Format message with timestamp and category if configured
        let formattedMessage = message;
        if (config.includePrefix) {
            const levelName = LogLevel[level];
            formattedMessage = `[${this.category}] [${levelName}] ${message}`;
        }
        // Create a log entry
        const timestamp = new Date();
        let displayMessage = formattedMessage;
        if (config.includeTimestamp) {
            displayMessage = `${timestamp.toISOString()} ${formattedMessage}`;
        }
        // Add to log buffer instead of console
        logBuffer.push({
            timestamp,
            level,
            category: this.category,
            message: message.toString(),
            args,
            formattedMessage: displayMessage
        });
    }
    /**
     * Determines if a message should be logged based on configured levels
     * @param level The message log level
     * @returns Whether the message should be logged
     */
    shouldLog(level) {
        // Check if category has a specific level
        const categoryLevel = config.categoryLevels[this.category];
        if (categoryLevel !== undefined) {
            return level >= categoryLevel;
        }
        // Otherwise use global level
        return level >= config.globalLogLevel;
    }
}
/**
 * Updates logger configuration
 * @param newConfig Configuration to apply
 */
export function configureLogger(newConfig) {
    config = Object.assign(Object.assign({}, config), newConfig);
}
/**
 * Sets the global minimum log level
 * @param level Minimum log level to display
 */
export function setGlobalLogLevel(level) {
    config.globalLogLevel = level;
}
/**
 * Sets a category-specific log level
 * @param category Category name
 * @param level Minimum log level to display for this category
 */
export function setCategoryLogLevel(category, level) {
    config.categoryLevels[category] = level;
}
/**
 * Creates or retrieves a logger for a specific category
 * @param category Category name
 * @returns Logger instance for the category
 */
export function getLogger(category) {
    return new Logger(category);
}
/**
 * Retrieves all log entries as formatted strings
 * @returns Array of formatted log messages
 */
export function getLogEntries() {
    return logBuffer.map(entry => entry.formattedMessage);
}
/**
 * Gets all log entries as a single string
 * @param separator Line separator (default: newline)
 * @returns Concatenated log messages
 */
export function getLogsAsString(separator = '\n') {
    return logBuffer.map(entry => entry.formattedMessage).join(separator);
}
/**
 * Gets all log entries formatted for Obsidian callouts
 * Each log entry is properly formatted to maintain callout structure
 * @returns Formatted log messages for callout display
 */
export function getLogsForCallout() {
    const MAX_LINE_LENGTH = 120; // Prevent very long lines from breaking callouts
    return logBuffer.map(entry => {
        // Each log entry might contain multiple lines, so we need to add ">" prefix to each line
        const lines = entry.formattedMessage.split('\n');
        return lines.map(line => {
            // Clean the line to prevent callout breaking (keep URLs as-is for debugging)
            let cleanedLine = line
                .replace(/\r/g, '') // Remove carriage returns
                .replace(/\t/g, '    ') // Convert tabs to spaces
                .replace(/[^\x20-\x7E\n]/g, ''); // Remove non-printable chars except newlines
            // Note: Removed HTML entity escaping to show actual URLs in logs
            // Wrap very long lines to prevent callout breaking
            if (cleanedLine.length > MAX_LINE_LENGTH) {
                const wrappedLines = [];
                while (cleanedLine.length > MAX_LINE_LENGTH) {
                    // Find a good break point (space, comma, etc.)
                    let breakPoint = MAX_LINE_LENGTH;
                    const goodBreaks = [' ', ',', '&', '=', '?'];
                    for (let i = MAX_LINE_LENGTH - 1; i > MAX_LINE_LENGTH - 20 && i > 0; i--) {
                        if (goodBreaks.includes(cleanedLine[i])) {
                            breakPoint = i + 1;
                            break;
                        }
                    }
                    wrappedLines.push('> ' + cleanedLine.substring(0, breakPoint));
                    cleanedLine = '  ' + cleanedLine.substring(breakPoint); // Indent continuation
                }
                if (cleanedLine.trim()) {
                    wrappedLines.push('> ' + cleanedLine);
                }
                return wrappedLines.join('\n');
            }
            else {
                return '> ' + cleanedLine;
            }
        }).join('\n');
    }).join('\n');
}
/**
 * Clears the log buffer
 */
export function clearLogs() {
    logBuffer.length = 0;
}
// For backward compatibility, also export some common loggers directly
export const pluginLogger = getLogger('PLUGIN');
export const llmLogger = getLogger('LLM');
export const proxyLogger = getLogger('PROXY');
export const transcriptLogger = getLogger('TRANSCRIPT');
export const uiLogger = getLogger('UI');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9nZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOztHQUVHO0FBRUg7O0dBRUc7QUFDSCxNQUFNLENBQU4sSUFBWSxRQU1YO0FBTkQsV0FBWSxRQUFRO0lBQ2hCLHlDQUFTLENBQUE7SUFDVCx1Q0FBUSxDQUFBO0lBQ1IsdUNBQVEsQ0FBQTtJQUNSLHlDQUFTLENBQUE7SUFDVCx1Q0FBUSxDQUFBLENBQUUsOEJBQThCO0FBQzVDLENBQUMsRUFOVyxRQUFRLEtBQVIsUUFBUSxRQU1uQjtBQTZCRCx3QkFBd0I7QUFDeEIsTUFBTSxhQUFhLEdBQWlCO0lBQ2hDLGNBQWMsRUFBRSxRQUFRLENBQUMsSUFBSTtJQUM3QixjQUFjLEVBQUUsRUFBRTtJQUNsQixnQkFBZ0IsRUFBRSxLQUFLO0lBQ3ZCLGFBQWEsRUFBRSxJQUFJO0NBQ3RCLENBQUM7QUFFRix3QkFBd0I7QUFDeEIsSUFBSSxNQUFNLHFCQUFzQixhQUFhLENBQUUsQ0FBQztBQUVoRCwyQ0FBMkM7QUFDM0MsTUFBTSxTQUFTLEdBQWUsRUFBRSxDQUFDO0FBRWpDOztHQUVHO0FBQ0gsTUFBTSxPQUFPLE1BQU07SUFDZjs7O09BR0c7SUFDSCxZQUFvQixRQUFnQjtRQUFoQixhQUFRLEdBQVIsUUFBUSxDQUFRO0lBQUcsQ0FBQztJQUV4Qzs7OztPQUlHO0lBQ0gsS0FBSyxDQUFDLE9BQVksRUFBRSxHQUFHLElBQVc7UUFDOUIsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsS0FBSyxFQUFFLE9BQU8sRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQy9DLENBQUM7SUFFRDs7OztPQUlHO0lBQ0gsSUFBSSxDQUFDLE9BQVksRUFBRSxHQUFHLElBQVc7UUFDN0IsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzlDLENBQUM7SUFFRDs7OztP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Q0FBQyxDQUFDO0FBQzFDLE1BQU0sQ0FBQyxNQUFNLFdBQVcsR0FBRyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDOUMsTUFBTSxDQUFDLE1BQU0sZ0JBQWdCLEdBQUcsU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBQ3hELE1BQU0sQ0FBQyxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENlbnRyYWxpemVkIGxvZ2dpbmcgdXRpbGl0eSBmb3IgdGhlIFlvdVR1YmUgVHJhbnNjcmlwdCBwbHVnaW5cbiAqL1xuXG4vKipcbiAqIExvZyBsZXZlbHNcbiAqL1xuZXhwb3J0IGVudW0gTG9nTGV2ZWwge1xuICAgIERFQlVHID0gMCxcbiAgICBJTkZPID0gMSxcbiAgICBXQVJOID0gMixcbiAgICBFUlJPUiA9IDMsXG4gICAgTk9ORSA9IDQgIC8vIFVzZWQgdG8gZGlzYWJsZSBhbGwgbG9nZ2luZ1xufVxuXG4vKipcbiAqIExvZ2dlciBjb25maWd1cmF0aW9uXG4gKi9cbmludGVyZmFjZSBMb2dnZXJDb25maWcge1xuICAgIC8qKiBHbG9iYWwgbWluaW11bSBsb2cgbGV2ZWwgKi9cbiAgICBnbG9iYWxMb2dMZXZlbDogTG9nTGV2ZWw7XG4gICAgXG4gICAgLyoqIENhdGVnb3J5LXNwZWNpZmljIGxvZyBsZXZlbHMgKi9cbiAgICBjYXRlZ29yeUxldmVsczogUmVjb3JkPHN0cmluZywgTG9nTGV2ZWw+O1xuICAgIFxuICAgIC8qKiBXaGV0aGVyIHRvIGluY2x1ZGUgdGltZXN0YW1wcyBpbiBsb2dzICovXG4gICAgaW5jbHVkZVRpbWVzdGFtcDogYm9vbGVhbjtcbiAgICBcbiAgICAvKiogV2hldGhlciB0byBwcmVmaXggbWVzc2FnZXMgd2l0aCBjYXRlZ29yeSBhbmQgbGV2ZWwgKi9cbiAgICBpbmNsdWRlUHJlZml4OiBib29sZWFuO1xufVxuXG4vLyBTdHJ1Y3R1cmUgZm9yIGxvZyBlbnRyaWVzXG5pbnRlcmZhY2UgTG9nRW50cnkge1xuICAgIHRpbWVzdGFtcDogRGF0ZTtcbiAgICBsZXZlbDogTG9nTGV2ZWw7XG4gICAgY2F0ZWdvcnk6IHN0cmluZztcbiAgICBtZXNzYWdlOiBzdHJpbmc7XG4gICAgYXJnczogYW55W107XG4gICAgZm9ybWF0dGVkTWVzc2FnZTogc3RyaW5nO1xufVxuXG4vLyBEZWZhdWx0IGNvbmZpZ3VyYXRpb25cbmNvbnN0IGRlZmF1bHRDb25maWc6IExvZ2dlckNvbmZpZyA9IHtcbiAgICBnbG9iYWxMb2dMZXZlbDogTG9nTGV2ZWwuSU5GTyxcbiAgICBjYXRlZ29yeUxldmVsczoge30sXG4gICAgaW5jbHVkZVRpbWVzdGFtcDogZmFsc2UsXG4gICAgaW5jbHVkZVByZWZpeDogdHJ1ZVxufTtcblxuLy8gQ3VycmVudCBjb25maWd1cmF0aW9uXG5sZXQgY29uZmlnOiBMb2dnZXJDb25maWcgPSB7IC4uLmRlZmF1bHRDb25maWcgfTtcblxuLy8gQ2VudHJhbCBidWZmZXIgdG8gc3RvcmUgYWxsIGxvZyBtZXNzYWdlc1xuY29uc3QgbG9nQnVmZmVyOiBMb2dFbnRyeVtdID0gW107XG5cbi8qKlxuICogTG9nZ2VyIGNsYXNzIGZvciBhIHNwZWNpZmljIGNhdGVnb3J5XG4gKi9cbmV4cG9ydCBjbGFzcyBMb2dnZXIge1xuICAgIC8qKlxuICAgICAqIENyZWF0ZXMgYSBuZXcgbG9nZ2VyIGZvciBhIHNwZWNpZmljIGNhdGVnb3J5XG4gICAgICogQHBhcmFtIGNhdGVnb3J5IFRoZSBsb2dnaW5nIGNhdGVnb3J5IChlLmcuLCAnUFJPWFknLCAnTExNJywgJ1VJJylcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihwcml2YXRlIGNhdGVnb3J5OiBzdHJpbmcpIHt9XG4gICAgXG4gICAgLyoqXG4gICAgICogTG9ncyBhIGRlYnVnIG1lc3NhZ2VcbiAgICAgKiBAcGFyYW0gbWVzc2FnZSBNZXNzYWdlIG9yIG9iamVjdCB0byBsb2dcbiAgICAgKiBAcGFyYW0gYXJncyBBZGRpdGlvbmFsIGFyZ3VtZW50cyB0byBsb2dcbiAgICAgKi9cbiAgICBkZWJ1ZyhtZXNzYWdlOiBhbnksIC4uLmFyZ3M6IGFueVtdKTogdm9pZCB7XG4gICAgICAgIHRoaXMubG9nKExvZ0xldmVsLkRFQlVHLCBtZXNzYWdlLCAuLi5hcmdzKTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogTG9ncyBhbiBpbmZvIG1lc3NhZ2VcbiAgICAgKiBAcGFyYW0gbWVzc2FnZSBNZXNzYWdlIG9yIG9iamVjdCB0byBsb2dcbiAgICAgKiBAcGFyYW0gYXJncyBBZGRpdGlvbmFsIGFyZ3VtZW50cyB0byBsb2dcbiAgICAgKi9cbiAgICBpbmZvKG1lc3NhZ2U6IGFueSwgLi4uYXJnczogYW55W10pOiB2b2lkIHtcbiAgICAgICAgdGhpcy5sb2coTG9nTGV2ZWwuSU5GTywgbWVzc2FnZSwgLi4uYXJncyk7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIExvZ3MgYSB3YXJuaW5nIG1lc3NhZ2VcbiAgICAgKiBAcGFyYW0gbWVzc2FnZSBNZXNzYWdlIG9yIG9iamVjdCB0byBsb2dcbiAgICAgKiBAcGFyYW0gYXJncyBBZGRpdGlvbmFsIGFyZ3VtZW50cyB0byBsb2dcbiAgICAgKi9cbiAgICB3YXJuKG1lc3NhZ2U6IGFueSwgLi4uYXJnczogYW55W10pOiB2b2lkIHtcbiAgICAgICAgdGhpcy5sb2coTG9nTGV2ZWwuV0FSTiwgbWVzc2FnZSwgLi4uYXJncyk7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIExvZ3MgYW4gZXJyb3IgbWVzc2FnZVxuICAgICAqIEBwYXJhbSBtZXNzYWdlIE1lc3NhZ2Ugb3Igb2JqZWN0IHRvIGxvZ1xuICAgICAqIEBwYXJhbSBhcmdzIEFkZGl0aW9uYWwgYXJndW1lbnRzIHRvIGxvZ1xuICAgICAqL1xuICAgIGVycm9yKG1lc3NhZ2U6IGFueSwgLi4uYXJnczogYW55W10pOiB2b2lkIHtcbiAgICAgICAgdGhpcy5sb2coTG9nTGV2ZWwuRVJST1IsIG1lc3NhZ2UsIC4uLmFyZ3MpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBJbnRlcm5hbCBsb2dnaW5nIG1ldGhvZFxuICAgICAqIEBwYXJhbSBsZXZlbCBMb2cgbGV2ZWxcbiAgICAgKiBAcGFyYW0gbWVzc2FnZSBNZXNzYWdlIHRvIGxvZ1xuICAgICAqIEBwYXJhbSBhcmdzIEFkZGl0aW9uYWwgYXJndW1lbnRzIHRvIGxvZ1xuICAgICAqL1xuICAgIHByaXZhdGUgbG9nKGxldmVsOiBMb2dMZXZlbCwgbWVzc2FnZTogYW55LCAuLi5hcmdzOiBhbnlbXSk6IHZvaWQge1xuICAgICAgICAvLyBDaGVjayBpZiB3ZSBzaG91bGQgbG9nIHRoaXMgbWVzc2FnZSBiYXNlZCBvbiBsZXZlbFxuICAgICAgICBpZiAoIXRoaXMuc2hvdWxkTG9nKGxldmVsKSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBGb3JtYXQgbWVzc2FnZSB3aXRoIHRpbWVzdGFtcCBhbmQgY2F0ZWdvcnkgaWYgY29uZmlndXJlZFxuICAgICAgICBsZXQgZm9ybWF0dGVkTWVzc2FnZSA9IG1lc3NhZ2U7XG4gICAgICAgIFxuICAgICAgICBpZiAoY29uZmlnLmluY2x1ZGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGNvbnN0IGxldmVsTmFtZSA9IExvZ0xldmVsW2xldmVsXTtcbiAgICAgICAgICAgIGZvcm1hdHRlZE1lc3NhZ2UgPSBgWyR7dGhpcy5jYXRlZ29yeX1dIFske2xldmVsTmFtZX1dICR7bWVzc2FnZX1gO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBDcmVhdGUgYSBsb2cgZW50cnlcbiAgICAgICAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKTtcbiAgICAgICAgbGV0IGRpc3BsYXlNZXNzYWdlID0gZm9ybWF0dGVkTWVzc2FnZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChjb25maWcuaW5jbHVkZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgZGlzcGxheU1lc3NhZ2UgPSBgJHt0aW1lc3RhbXAudG9JU09TdHJpbmcoKX0gJHtmb3JtYXR0ZWRNZXNzYWdlfWA7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIEFkZCB0byBsb2cgYnVmZmVyIGluc3RlYWQgb2YgY29uc29sZVxuICAgICAgICBsb2dCdWZmZXIucHVzaCh7XG4gICAgICAgICAgICB0aW1lc3RhbXAsXG4gICAgICAgICAgICBsZXZlbCxcbiAgICAgICAgICAgIGNhdGVnb3J5OiB0aGlzLmNhdGVnb3J5LFxuICAgICAgICAgICAgbWVzc2FnZTogbWVzc2FnZS50b1N0cmluZygpLFxuICAgICAgICAgICAgYXJncyxcbiAgICAgICAgICAgIGZvcm1hdHRlZE1lc3NhZ2U6IGRpc3BsYXlNZXNzYWdlXG4gICAgICAgIH0pO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBEZXRlcm1pbmVzIGlmIGEgbWVzc2FnZSBzaG91bGQgYmUgbG9nZ2VkIGJhc2VkIG9uIGNvbmZpZ3VyZWQgbGV2ZWxzXG4gICAgICogQHBhcmFtIGxldmVsIFRoZSBtZXNzYWdlIGxvZyBsZXZlbFxuICAgICAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIG1lc3NhZ2Ugc2hvdWxkIGJlIGxvZ2dlZFxuICAgICAqL1xuICAgIHByaXZhdGUgc2hvdWxkTG9nKGxldmVsOiBMb2dMZXZlbCk6IGJvb2xlYW4ge1xuICAgICAgICAvLyBDaGVjayBpZiBjYXRlZ29yeSBoYXMgYSBzcGVjaWZpYyBsZXZlbFxuICAgICAgICBjb25zdCBjYXRlZ29yeUxldmVsID0gY29uZmlnLmNhdGVnb3J5TGV2ZWxzW3RoaXMuY2F0ZWdvcnldO1xuICAgICAgICBcbiAgICAgICAgaWYgKGNhdGVnb3J5TGV2ZWwgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIGxldmVsID49IGNhdGVnb3J5TGV2ZWw7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIE90aGVyd2lzZSB1c2UgZ2xvYmFsIGxldmVsXG4gICAgICAgIHJldHVybiBsZXZlbCA+PSBjb25maWcuZ2xvYmFsTG9nTGV2ZWw7XG4gICAgfVxufVxuXG4vKipcbiAqIFVwZGF0ZXMgbG9nZ2VyIGNvbmZpZ3VyYXRpb25cbiAqIEBwYXJhbSBuZXdDb25maWcgQ29uZmlndXJhdGlvbiB0byBhcHBseVxuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmlndXJlTG9nZ2VyKG5ld0NvbmZpZzogUGFydGlhbDxMb2dnZXJDb25maWc+KTogdm9pZCB7XG4gICAgY29uZmlnID0geyAuLi5jb25maWcsIC4uLm5ld0NvbmZpZyB9O1xufVxuXG4vKipcbiAqIFNldHMgdGhlIGdsb2JhbCBtaW5pbXVtIGxvZyBsZXZlbFxuICogQHBhcmFtIGxldmVsIE1pbmltdW0gbG9nIGxldmVsIHRvIGRpc3BsYXlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEdsb2JhbExvZ0xldmVsKGxldmVsOiBMb2dMZXZlbCk6IHZvaWQge1xuICAgIGNvbmZpZy5nbG9iYWxMb2dMZXZlbCA9IGxldmVsO1xufVxuXG4vKipcbiAqIFNldHMgYSBjYXRlZ29yeS1zcGVjaWZpYyBsb2cgbGV2ZWxcbiAqIEBwYXJhbSBjYXRlZ29yeSBDYXRlZ29yeSBuYW1lXG4gKiBAcGFyYW0gbGV2ZWwgTWluaW11bSBsb2cgbGV2ZWwgdG8gZGlzcGxheSBmb3IgdGhpcyBjYXRlZ29yeVxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0Q2F0ZWdvcnlMb2dMZXZlbChjYXRlZ29yeTogc3RyaW5nLCBsZXZlbDogTG9nTGV2ZWwpOiB2b2lkIHtcbiAgICBjb25maWcuY2F0ZWdvcnlMZXZlbHNbY2F0ZWdvcnldID0gbGV2ZWw7XG59XG5cbi8qKlxuICogQ3JlYXRlcyBvciByZXRyaWV2ZXMgYSBsb2dnZXIgZm9yIGEgc3BlY2lmaWMgY2F0ZWdvcnlcbiAqIEBwYXJhbSBjYXRlZ29yeSBDYXRlZ29yeSBuYW1lXG4gKiBAcmV0dXJucyBMb2dnZXIgaW5zdGFuY2UgZm9yIHRoZSBjYXRlZ29yeVxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TG9nZ2VyKGNhdGVnb3J5OiBzdHJpbmcpOiBMb2dnZXIge1xuICAgIHJldHVybiBuZXcgTG9nZ2VyKGNhdGVnb3J5KTtcbn1cblxuLyoqXG4gKiBSZXRyaWV2ZXMgYWxsIGxvZyBlbnRyaWVzIGFzIGZvcm1hdHRlZCBzdHJpbmdzXG4gKiBAcmV0dXJucyBBcnJheSBvZiBmb3JtYXR0ZWQgbG9nIG1lc3NhZ2VzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRMb2dFbnRyaWVzKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gbG9nQnVmZmVyLm1hcChlbnRyeSA9PiBlbnRyeS5mb3JtYXR0ZWRNZXNzYWdlKTtcbn1cblxuLyoqXG4gKiBHZXRzIGFsbCBsb2cgZW50cmllcyBhcyBhIHNpbmdsZSBzdHJpbmdcbiAqIEBwYXJhbSBzZXBhcmF0b3IgTGluZSBzZXBhcmF0b3IgKGRlZmF1bHQ6IG5ld2xpbmUpXG4gKiBAcmV0dXJucyBDb25jYXRlbmF0ZWQgbG9nIG1lc3NhZ2VzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRMb2dzQXNTdHJpbmcoc2VwYXJhdG9yOiBzdHJpbmcgPSAnXFxuJyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGxvZ0J1ZmZlci5tYXAoZW50cnkgPT4gZW50cnkuZm9ybWF0dGVkTWVzc2FnZSkuam9pbihzZXBhcmF0b3IpO1xufVxuXG4vKipcbiAqIEdldHMgYWxsIGxvZyBlbnRyaWVzIGZvcm1hdHRlZCBmb3IgT2JzaWRpYW4gY2FsbG91dHNcbiAqIEVhY2ggbG9nIGVudHJ5IGlzIHByb3Blcmx5IGZvcm1hdHRlZCB0byBtYWludGFpbiBjYWxsb3V0IHN0cnVjdHVyZVxuICogQHJldHVybnMgRm9ybWF0dGVkIGxvZyBtZXNzYWdlcyBmb3IgY2FsbG91dCBkaXNwbGF5XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRMb2dzRm9yQ2FsbG91dCgpOiBzdHJpbmcge1xuICAgIGNvbnN0IE1BWF9MSU5FX0xFTkdUSCA9IDEyMDsgLy8gUHJldmVudCB2ZXJ5IGxvbmcgbGluZXMgZnJvbSBicmVha2luZyBjYWxsb3V0c1xuICAgIFxuICAgIHJldHVybiBsb2dCdWZmZXIubWFwKGVudHJ5ID0+IHtcbiAgICAgICAgLy8gRWFjaCBsb2cgZW50cnkgbWlnaHQgY29udGFpbiBtdWx0aXBsZSBsaW5lcywgc28gd2UgbmVlZCB0byBhZGQgXCI+XCIgcHJlZml4IHRvIGVhY2ggbGluZVxuICAgICAgICBjb25zdCBsaW5lcyA9IGVudHJ5LmZvcm1hdHRlZE1lc3NhZ2Uuc3BsaXQoJ1xcbicpO1xuICAgICAgICByZXR1cm4gbGluZXMubWFwKGxpbmUgPT4ge1xuICAgICAgICAgICAgLy8gQ2xlYW4gdGhlIGxpbmUgdG8gcHJldmVudCBjYWxsb3V0IGJyZWFraW5nIChrZWVwIFVSTHMgYXMtaXMgZm9yIGRlYnVnZ2luZylcbiAgICAgICAgICAgIGxldCBjbGVhbmVkTGluZSA9IGxpbmVcbiAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxyL2csICcnKSAvLyBSZW1vdmUgY2FycmlhZ2UgcmV0dXJuc1xuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHQvZywgJyAgICAnKSAvLyBDb252ZXJ0IHRhYnMgdG8gc3BhY2VzXG4gICAgICAgICAgICAgICAgLnJlcGxhY2UoL1teXFx4MjAtXFx4N0VcXG5dL2csICcnKTsgLy8gUmVtb3ZlIG5vbi1wcmludGFibGUgY2hhcnMgZXhjZXB0IG5ld2xpbmVzXG4gICAgICAgICAgICAgICAgLy8gTm90ZTogUmVtb3ZlZCBIVE1MIGVudGl0eSBlc2NhcGluZyB0byBzaG93IGFjdHVhbCBVUkxzIGluIGxvZ3NcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gV3JhcCB2ZXJ5IGxvbmcgbGluZXMgdG8gcHJldmVudCBjYWxsb3V0IGJyZWFraW5nXG4gICAgICAgICAgICBpZiAoY2xlYW5lZExpbmUubGVuZ3RoID4gTUFYX0xJTkVfTEVOR1RIKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgd3JhcHBlZExpbmVzID0gW107XG4gICAgICAgICAgICAgICAgd2hpbGUgKGNsZWFuZWRMaW5lLmxlbmd0aCA+IE1BWF9MSU5FX0xFTkdUSCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBGaW5kIGEgZ29vZCBicmVhayBwb2ludCAoc3BhY2UsIGNvbW1hLCBldGMuKVxuICAgICAgICAgICAgICAgICAgICBsZXQgYnJlYWtQb2ludCA9IE1BWF9MSU5FX0xFTkdUSDtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZ29vZEJyZWFrcyA9IFsnICcsICcsJywgJyYnLCAnPScsICc/J107XG4gICAgICAgICAgICAgICAgICAgIGZvciAobGV0IGkgPSBNQVhfTElORV9MRU5HVEggLSAxOyBpID4gTUFYX0xJTkVfTEVOR1RIIC0gMjAgJiYgaSA+IDA7IGktLSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGdvb2RCcmVha3MuaW5jbHVkZXMoY2xlYW5lZExpbmVbaV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWtQb2ludCA9IGkgKyAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB3cmFwcGVkTGluZXMucHVzaCgnPiAnICsgY2xlYW5lZExpbmUuc3Vic3RyaW5nKDAsIGJyZWFrUG9pbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgY2xlYW5lZExpbmUgPSAnICAnICsgY2xlYW5lZExpbmUuc3Vic3RyaW5nKGJyZWFrUG9pbnQpOyAvLyBJbmRlbnQgY29udGludWF0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChjbGVhbmVkTGluZS50cmltKCkpIHtcbiAgICAgICAgICAgICAgICAgICAgd3JhcHBlZExpbmVzLnB1c2goJz4gJyArIGNsZWFuZWRMaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHdyYXBwZWRMaW5lcy5qb2luKCdcXG4nKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICc+ICcgKyBjbGVhbmVkTGluZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkuam9pbignXFxuJyk7XG4gICAgfSkuam9pbignXFxuJyk7XG59XG5cbi8qKlxuICogQ2xlYXJzIHRoZSBsb2cgYnVmZmVyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGVhckxvZ3MoKTogdm9pZCB7XG4gICAgbG9nQnVmZmVyLmxlbmd0aCA9IDA7XG59XG5cbi8vIEZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5LCBhbHNvIGV4cG9ydCBzb21lIGNvbW1vbiBsb2dnZXJzIGRpcmVjdGx5XG5leHBvcnQgY29uc3QgcGx1Z2luTG9nZ2VyID0gZ2V0TG9nZ2VyKCdQTFVHSU4nKTtcbmV4cG9ydCBjb25zdCBsbG1Mb2dnZXIgPSBnZXRMb2dnZXIoJ0xMTScpO1xuZXhwb3J0IGNvbnN0IHByb3h5TG9nZ2VyID0gZ2V0TG9nZ2VyKCdQUk9YWScpO1xuZXhwb3J0IGNvbnN0IHRyYW5zY3JpcHRMb2dnZXIgPSBnZXRMb2dnZXIoJ1RSQU5TQ1JJUFQnKTtcbmV4cG9ydCBjb25zdCB1aUxvZ2dlciA9IGdldExvZ2dlcignVUknKTsgIl19