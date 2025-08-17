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
    summaryMode: SummaryMode = SummaryMode.EXTENSIVE,
    effectiveMaxTokens?: number
): PromptConfig {
    // Log the selected mode
    llmLogger.debug("Creating prompt config for mode:", summaryMode);
    
    // Use provided effective max tokens or fall back to settings value
    const maxTokens = effectiveMaxTokens ?? settings.maxTokens;
    
    if (summaryMode === SummaryMode.FAST) {
        // Fast summary mode - reduced tokens for quicker processing
        const tokenReduction = 0.25; // Use 1/4 of tokens for fast mode
        
        return {
            systemPrompt: settings.systemPrompt,
            userPrompt: settings.userPrompt,
            maxTokens: Math.floor(maxTokens * tokenReduction),
            temperature: settings.temperature
        };
    } else {
        // Extensive summary mode (default) - full token limit
        return {
            systemPrompt: settings.extensiveSystemPrompt,
            userPrompt: settings.extensiveUserPrompt,
            maxTokens: maxTokens,
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
    videoId: string,
    effectiveMaxTokens?: number
): PromptConfig {
    // For timestamp linking, we need a lower temperature for more deterministic output
    const timestampTemperature = 0.2;
    
    // Use specific prompts for timestamp linking with safety checks
    const systemPrompt = settings.timestampSystemPrompt || 'You are a highly precise assistant that adds TimeIndex markers to section headings in a note. You never include any reference material (like video IDs or transcripts) in your output.';
    const userPrompt = (settings.timestampUserPrompt || `TASK: Add TimeIndex markers to each section heading in this document.

CRITICAL: You must output TimeIndex markers in format [TimeIndex:SECONDS] - NOT YouTube Watch URLs!

RULES:
1. NEVER summarize or modify the content unless translation is requested
2. NEVER remove any content
3. ALWAYS return the FULL original content PLUS TimeIndex markers at the end of section headings
4. If processing multiple sections, add TimeIndex markers to ALL headings
5. ONLY process markdown numbered headings 
    a. for subheadings (e.g., "## 1. Topic")
    b. for section headings (e.g., "## 1.1. Sub Topic")

EXACTLY HOW TO DO THIS:
1. Identify ALL section headings in the document that follow the format: # number. text
2. Look at the transcript which has timestamps in format: [HH:MM:SS] [TimeIndex:X] where X is the exact seconds value
3. For each section heading, add the appropriate TimeIndex marker based on the content

Video ID: VIDEO_ID`).replace(/VIDEO_ID/g, videoId);
    
    return {
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        maxTokens: effectiveMaxTokens ?? settings.maxTokens,
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