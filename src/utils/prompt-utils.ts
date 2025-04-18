import { getLogger } from './logger';

// Initialize logger
const llmLogger = getLogger('LLM');

/**
 * Summary mode type definition
 */
export enum SummaryMode {
    FAST = 'fast',
    EXTENSIVE = 'extensive'
}

/**
 * Interface for prompt configuration
 */
export interface PromptConfig {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
}

/**
 * Interface for all available prompts and settings
 */
export interface PromptSettings {
    // Fast summary prompts
    systemPrompt: string;
    userPrompt: string;
    
    // Extensive summary prompts
    extensiveSystemPrompt: string;
    extensiveUserPrompt: string;
    
    // Timestamp links prompts
    timestampSystemPrompt: string;
    timestampUserPrompt: string;
    
    // General settings
    maxTokens: number;
    temperature: number;
}

/**
 * Get the appropriate prompt configuration based on the summary mode
 * 
 * @param settings Prompt settings from the plugin
 * @param summaryMode The summary mode (fast or extensive)
 * @returns Complete prompt configuration
 */
export function getPromptConfig(
    settings: PromptSettings, 
    summaryMode: SummaryMode = SummaryMode.EXTENSIVE
): PromptConfig {
    // Log the selected mode
    llmLogger.debug("Creating prompt config for mode:", summaryMode);
    
    if (summaryMode === SummaryMode.FAST) {
        // Fast summary mode - reduced tokens for quicker processing
        const tokenReduction = 0.25; // Use 1/4 of tokens for fast mode
        
        return {
            systemPrompt: settings.systemPrompt,
            userPrompt: settings.userPrompt,
            maxTokens: Math.floor(settings.maxTokens * tokenReduction),
            temperature: settings.temperature
        };
    } else {
        // Extensive summary mode (default) - full token limit
        return {
            systemPrompt: settings.extensiveSystemPrompt,
            userPrompt: settings.extensiveUserPrompt,
            maxTokens: settings.maxTokens,
            temperature: settings.temperature
        };
    }
}

/**
 * Get a prompt configuration for timestamp linking
 * 
 * @param settings Prompt settings from the plugin
 * @param videoId YouTube video ID to include in the prompt
 * @returns Prompt configuration for timestamp linking
 */
export function getTimestampLinkConfig(
    settings: PromptSettings, 
    videoId: string
): PromptConfig {
    // For timestamp linking, we need a lower temperature for more deterministic output
    const timestampTemperature = 0.2;
    
    // Use specific prompts for timestamp linking
    return {
        systemPrompt: settings.timestampSystemPrompt,
        userPrompt: settings.timestampUserPrompt.replace(/VIDEO_ID/g, videoId),
        maxTokens: settings.maxTokens,
        temperature: timestampTemperature
    };
}

/**
 * Cleans a transcript by removing timestamps and formatting
 * 
 * @param transcript Raw transcript text
 * @returns Cleaned transcript suitable for LLM processing
 */
export function cleanTranscript(transcript: string): string {
    // Split by lines and clean each line
    return transcript
        .split('\n')
        .map(line => {
            // Remove YAML indentation and timestamps
            return line.trim().replace(/^\s*\[\d{2}:\d{2}:\d{2}\]\s*/, '');
        })
        .join(' '); // Join with spaces to form a single text block
} 