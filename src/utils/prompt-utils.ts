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
    const systemPrompt = settings.timestampSystemPrompt || 'You are a highly analytical assistant that adds TimeIndex markers to section headings by deeply analyzing the content under each heading. Your expertise is in content analysis - reading the detailed content of each section and matching it to where that specific content is substantially discussed in the transcript. You focus on semantic content matching, not superficial title matching. You never include any reference material (like video IDs or transcripts) in your output.';
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
3. For each section heading, THOROUGHLY READ AND ANALYZE THE ENTIRE CONTENT UNDER THAT HEADING:
   - Read every paragraph, bullet point, and detail in that section
   - Identify the key concepts, specific examples, and main arguments discussed
   - Note specific terminology, names, numbers, or unique phrases used
   - The heading title alone is NOT sufficient - you must understand what the section actually covers
4. Then find where in the transcript this SPECIFIC CONTENT is BEST and MOST COMPREHENSIVELY DISCUSSED:
   - Look for transcript segments that contain the same specific details, examples, and concepts
   - Find where the speaker begins to substantively address the topics covered in that section
   - The goal is to link to where the content actually starts being discussed, not just mentioned
5. When matching section content to transcript timestamps:
   - Match based on CONTENT SUBSTANCE, not just heading titles or keyword mentions
   - A section about "Investment Strategies" should link to where investment strategies are actually explained, not just where the phrase appears
   - Look for where the speaker begins the detailed discussion that led to the content in that section
   - Add the appropriate TimeIndex marker based on this content analysis

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