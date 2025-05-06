/**
 * Centralized logging utility for the YouTube Transcript plugin
 */

/**
 * Log levels
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4  // Used to disable all logging
}

/**
 * Logger configuration
 */
interface LoggerConfig {
    /** Global minimum log level */
    globalLogLevel: LogLevel;
    
    /** Category-specific log levels */
    categoryLevels: Record<string, LogLevel>;
    
    /** Whether to include timestamps in logs */
    includeTimestamp: boolean;
    
    /** Whether to prefix messages with category and level */
    includePrefix: boolean;
}

// Structure for log entries
interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    category: string;
    message: string;
    args: any[];
    formattedMessage: string;
}

// Default configuration
const defaultConfig: LoggerConfig = {
    globalLogLevel: LogLevel.INFO,
    categoryLevels: {},
    includeTimestamp: false,
    includePrefix: true
};

// Current configuration
let config: LoggerConfig = { ...defaultConfig };

// Central buffer to store all log messages
const logBuffer: LogEntry[] = [];

/**
 * Logger class for a specific category
 */
export class Logger {
    /**
     * Creates a new logger for a specific category
     * @param category The logging category (e.g., 'PROXY', 'LLM', 'UI')
     */
    constructor(private category: string) {}
    
    /**
     * Logs a debug message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    debug(message: any, ...args: any[]): void {
        this.log(LogLevel.DEBUG, message, ...args);
    }
    
    /**
     * Logs an info message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    info(message: any, ...args: any[]): void {
        this.log(LogLevel.INFO, message, ...args);
    }
    
    /**
     * Logs a warning message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    warn(message: any, ...args: any[]): void {
        this.log(LogLevel.WARN, message, ...args);
    }
    
    /**
     * Logs an error message
     * @param message Message or object to log
     * @param args Additional arguments to log
     */
    error(message: any, ...args: any[]): void {
        this.log(LogLevel.ERROR, message, ...args);
    }
    
    /**
     * Internal logging method
     * @param level Log level
     * @param message Message to log
     * @param args Additional arguments to log
     */
    private log(level: LogLevel, message: any, ...args: any[]): void {
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
    private shouldLog(level: LogLevel): boolean {
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
export function configureLogger(newConfig: Partial<LoggerConfig>): void {
    config = { ...config, ...newConfig };
}

/**
 * Sets the global minimum log level
 * @param level Minimum log level to display
 */
export function setGlobalLogLevel(level: LogLevel): void {
    config.globalLogLevel = level;
}

/**
 * Sets a category-specific log level
 * @param category Category name
 * @param level Minimum log level to display for this category
 */
export function setCategoryLogLevel(category: string, level: LogLevel): void {
    config.categoryLevels[category] = level;
}

/**
 * Creates or retrieves a logger for a specific category
 * @param category Category name
 * @returns Logger instance for the category
 */
export function getLogger(category: string): Logger {
    return new Logger(category);
}

/**
 * Retrieves all log entries as formatted strings
 * @returns Array of formatted log messages
 */
export function getLogEntries(): string[] {
    return logBuffer.map(entry => entry.formattedMessage);
}

/**
 * Gets all log entries as a single string
 * @param separator Line separator (default: newline)
 * @returns Concatenated log messages
 */
export function getLogsAsString(separator: string = '\n'): string {
    return logBuffer.map(entry => entry.formattedMessage).join(separator);
}

/**
 * Clears the log buffer
 */
export function clearLogs(): void {
    logBuffer.length = 0;
}

// For backward compatibility, also export some common loggers directly
export const pluginLogger = getLogger('PLUGIN');
export const llmLogger = getLogger('LLM');
export const proxyLogger = getLogger('PROXY');
export const transcriptLogger = getLogger('TRANSCRIPT');
export const uiLogger = getLogger('UI'); 