import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, Platform, DropdownComponent, TextComponent, ExtraButtonComponent, TFile } from 'obsidian';
import { YouTubeTranscriptExtractor, TranscriptSegment } from './src/youtube-transcript';
import { TranscriptSummarizer } from './src/llm/transcript-summarizer';
import { sanitizeFilename } from './src/utils/filename-sanitizer';
import { handleApiError, getSafeErrorMessage } from './src/utils/error-utils';
import { getLogger, LogLevel, setGlobalLogLevel, clearLogs, getLogsForCallout } from './src/utils/logger';
import { normalizePath, ensureFolder, joinPaths, sanitizePathComponent } from './src/utils/path-utils';
import { validateRequired, validateYouTubeUrl, ValidationResult, displayValidationResult } from './src/utils/form-utils';
import { getPromptConfig, cleanTranscript, SummaryMode, getTimestampLinkConfig } from './src/utils/prompt-utils';
import { showNotice, isYoutubeUrl, isYoutubeChannelOrPlaylistUrl, extractChannelName } from './src/utils/youtube-utils';
import { obsidianFetch } from './src/utils/fetch-shim';
import { 
    extractDocumentComponents, 
    reconstructDocument, 
    validateEnhancedContent, 
    createOptimizedChunks,
    countTimestampLinks,
    ensureTrailingNewline,
    hasProperHeading,
    hasTimestampLinks,
    convertTimestampToSeconds,
    convertTimeIndexToWatchUrls
} from './src/utils/timestamp-utils';
import type { Provider } from './src/utils/model-limits-registry';
import { getEffectiveLimits, isModelSupported, upsertModel } from './src/utils/model-limits-registry';

// Initialize logger here
const logger = getLogger('PLUGIN');
const transcriptLogger = getLogger('TRANSCRIPT');
const llmLogger = getLogger('LLM');

function truncateForLogs(text: string, maxLength: number = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...[truncated]';
}

// Define a minimal folder item interface
interface FolderItem {
    path: string;
    name: string;
}

interface Closeable {
    close: () => void;
}

type TranscriptInputSegment = TranscriptSegment & {
    tStartMs?: string;
    segs?: Array<{ utf8?: string }>;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null;

type AppWithPlugins = App & {
    plugins?: {
        plugins?: Record<string, unknown>;
        manifest?: Record<string, { id?: string }>;
    };
};

type TemplaterContext = {
    user?: Record<string, unknown>;
};

type TemplaterApi = {
    current_functions_object?: unknown;
    create_running_config: (templateFile: TFile, targetFile: TFile, mode: number) => unknown;
    functions_generator: {
        generate_object: (config: unknown) => Promise<TemplaterContext>;
    };
    parser: {
        parse_commands: (content: string, ctx: TemplaterContext) => Promise<string>;
    };
};

type TemplaterSettings = {
    templates_folder?: string;
};

type TemplaterPlugin = {
    templater: TemplaterApi;
    settings?: TemplaterSettings;
};

const getPluginRegistry = (app: App): Record<string, unknown> | null => {
    const plugins = (app as AppWithPlugins).plugins?.plugins;
    if (!plugins || typeof plugins !== 'object') {
        return null;
    }
    return plugins;
};

const getTemplaterPlugin = (app: App): TemplaterPlugin | null => {
    const registry = getPluginRegistry(app);
    const candidate = registry?.['templater-obsidian'];
    if (!isRecord(candidate)) {
        return null;
    }
    const templater = candidate['templater'];
    if (!isRecord(templater)) {
        return null;
    }
    return candidate as TemplaterPlugin;
};

const getTemplaterSettings = (app: App): TemplaterSettings | null => {
    const registry = getPluginRegistry(app);
    const candidate = registry?.['templater-obsidian'];
    if (!isRecord(candidate)) {
        return null;
    }
    const settings = candidate['settings'];
    if (!isRecord(settings)) {
        return null;
    }
    return settings as TemplaterSettings;
};

const getPluginIdFromManifest = (app: App, fallback: string): string => {
    const manifest = (app as AppWithPlugins).plugins?.manifest;
    if (!manifest || typeof manifest !== 'object') {
        return fallback;
    }
    const entry = manifest[fallback];
    if (!isRecord(entry)) {
        return fallback;
    }
    const id = entry['id'];
    return typeof id === 'string' && id.trim() ? id : fallback;
};

interface YouTubePlaylistItem {
    snippet?: {
        title?: string;
        resourceId?: {
            videoId?: string;
        };
    };
}

interface PlaylistItemsResponse {
    items?: YouTubePlaylistItem[];
    nextPageToken?: string;
}

interface PlaylistResponse {
    items?: Array<{
        snippet?: {
            title?: string;
        };
    }>;
}

interface ChannelResponse {
    items?: Array<{
        snippet?: {
            title?: string;
        };
        contentDetails?: {
            relatedPlaylists?: {
                uploads?: string;
            };
        };
    }>;
}

interface ChannelIdResponse {
    items?: Array<{
        id?: string;
    }>;
}

interface YouTubeTranscriptSettings {
    // Template settings
    templaterTemplateFile: string;
    
    // LLM Settings
    selectedLLM: string;
    apiKeys: Record<string, string>;
    selectedModels: Record<string, string>;
    temperature: number;
    maxTokens: number;
    
    // Custom model parameters (for models not in registry)
    customModelLimits: Record<string, {
        contextK: number;      // Context window in thousands (e.g., 400 for 400K)
        maxOutputK: number;    // Max output in thousands (e.g., 128 for 128K)
        inputMaxK?: number;    // Optional explicit input cap in thousands
        reservePct?: number;   // Optional reserve percentage (default: 0.10 for cloud, 0.15 for local)
    }>;
    
    // Prompt settings
    systemPrompt: string;
    userPrompt: string;
    // Extensive prompt settings
    extensiveSystemPrompt: string;
    extensiveUserPrompt: string;
    // Summary mode
    useFastSummary: boolean;
    // Second pass - timestamp linking prompt
    timestampSystemPrompt: string;
    timestampUserPrompt: string;
    // Timestamp links
    addTimestampLinks: boolean;

    // Transcript settings
    translateLanguage: string;
    translateCountry: string;
    youtubeApiKey: string;
    
    // Folder settings
    transcriptRootFolder: string;
    
    // Date format settings
    dateFormat: string;
    prependDate: boolean;
    
    // Debug settings
    debugLogging: boolean;
    
    // License settings
    licenseAccepted: boolean;
    
    // Cookie management settings
    youtubeCookies?: {
        desktop?: string;
        mobile?: string;
        lastBootstrap?: number;
        timestamp?: number;
    };
    
}

const DEFAULT_SETTINGS: YouTubeTranscriptSettings = {
    templaterTemplateFile: 'Templates/YouTubeTranscript.md',
    selectedLLM: 'openai',
    apiKeys: {
        openai: '',
        anthropic: '',
        google: '',
        ollama: 'http://localhost:11434'
    },
    selectedModels: {
        openai: 'gpt-4-turbo',
        anthropic: 'claude-3-sonnet-20240229',
        google: 'gemini-1.5-pro',
        ollama: 'llama3.1'
    },
    temperature: 0.7,
    maxTokens: 1000,
    
    // Custom model parameters (for models not in registry)
    customModelLimits: {},
    
    // Short (Fast) Summary prompt
    systemPrompt: `You are a helpful assistant that summarizes YouTube transcripts clearly and concisely using Markdown.
When you reply output plain Markdown only.
Do NOT wrap responses in \`\`\` markdown code fences.
Use code fences ONLY for code snippets that should appear as code.
Do not label any fence with "markdown"`,
    userPrompt: `Extract structured notes from the transcript below without explanation or preface. Extract key points, main ideas, and important details. 
FORMAT USING PROPER MARKDOWN HEADINGS with # syntax (not bold text).
Specifically: 
2. Use markdown numbered subheadings (e.g., "## 1. Topic")
3. Use markdown numbered section headings (e.g., "### 1.1. Sub Topic")
4. Do NOT use bold text (**text**) for headings
5. Use bullet points for lists
This document will be processed as Markdown for Obsidian, so proper heading syntax is essential.
Provide only the summary notes.
Do not explain what you're doing or include any introductory sentence.
Your output should be clean Markdown content only. Do not introduce, explain, or narrate anything about the task. Begin directly with content.
Start the output with the actual summary content only, no headers, no preamble, no postamble.
Respond only with the raw answer, no intro or outro text.
Start the response immediately with a short paragraph summarizing the main themes. Do not label it or describe it.
At the end, have a conclusion section and list any books, people, or resources mentioned, along with a short explanation of their relevance.`,
    // Extensive Summary prompt
    extensiveSystemPrompt: `You are a highly analytical assistant that produces comprehensive, structured, and insightful notes from transcripts in proper Obsidian Markdown format. 
You specialize in creating deep, paragraph-level breakdowns of complex material with clarity and nuance. 
Your notes help readers understand both what is said and the reasoning or implications behind it. 
The objective is to extract all meaningful content, ideas, and knowledge from the transcript 
so that a reader can fully understand and review the material through structured notes without needing to watch or re-watch the video. 
IMPORTANT: Always use proper Markdown heading syntax with # characters (not bold text) for all headings and section titles.
When you reply output plain Markdown only.
Do NOT wrap responses in \`\`\` markdown code fences.
Use code fences ONLY for code snippets that should appear as code.
Do not label any fence with "markdown"`,
    extensiveUserPrompt: `From the transcript below, create detailed and structured notes for someone who wants to understand the material in depth.
Organize the content into clearly numbered sections based on major topic or theme changes. 
Extract structured notes from the transcript below without explanation or preface, extract key points, main ideas, and important details. 
FORMAT USING PROPER MARKDOWN HEADINGS with # syntax (not bold text).
Specifically:
2. Use markdown numbered subheadings (e.g., "## 1. Topic")
3. Use markdown numbered section headings (e.g., "### 1.1. Sub Topic")
4. Do NOT use bold text (**text**) for headings
5. Use bullet points for lists

This document will be processed as Markdown for Obsidian, so proper heading syntax is essential. Treat this as a document for training future analysts in this field.
Provide only the summary notes.
Do not explain what you're doing or include any introductory sentence.
Your output should be clean Markdown content only. Do not introduce, explain, or narrate anything about the task. Begin directly with content.
Start the output with the actual summary content only, no headers, no preamble, no postamble.
Respond only with the raw answer, no intro or outro text.

For each section:
- Number sections sequentially (1, 2, 3, etc.). IMPORTANT: Use actual Obsidian Markdown heading syntax with # symbols, not bold text.
- Write multiple detailed paragraphs, that explain the content and any theory, technical terms or definitions, models and frameworks thoroughly and in great detail drawn from the transcript.
- Include below the paragraphs key concepts, terms, taxonomy, ontology , or ideas, and explain them clearly with examples where relevant.
- Incorporate and explain important quotations direct from subject (person) , analogies, or references.
- Explore the reasoning, implications, or broader significance behind the ideas.
- Explicitly identify and analyze any contrasts, tensions, contradictions, or shifts in perspective throughout the discussion. Pay special attention to dialectical relationships between concepts.

Start the response immediately with a short paragraph summarizing the main themes. Do not label it or describe it.
At the end, have a conclusion section and list any books, people, or resources mentioned, along with a short explanation of their relevance.`,
    // Second pass - timestamp linking prompt
    timestampSystemPrompt: 'You are a highly analytical assistant that adds TimeIndex markers to section headings by deeply analyzing the content under each heading. Your expertise is in content analysis - reading the detailed content of each section and matching it to where that specific content is substantially discussed in the transcript. You focus on semantic content matching, not superficial title matching. You never include any reference material (like video IDs or transcripts) in your output.',
    timestampUserPrompt: `TASK: Add TimeIndex markers to each section heading in this document.

CRITICAL: You must output TimeIndex markers in format [TimeIndex:SECONDS] - NOT YouTube Watch URLs!

RULES:
1. NEVER summarize or modify the content unless translation is requested
2. NEVER remove any content
3. ALWAYS return the FULL original content PLUS TimeIndex markers at the end of section headings
4. If processing multiple sections, add TimeIndex markers to ALL headings
5. ONLY process markdown numbered headings 
    a. for subheadings (e.g., "## 1. Topic")
    b. for section headings (e.g., "## 1.1. Sub Topic")
6. DO NOT process headings without numbers or dots
7. DO NOT process horizontal rules (single #)
8. Do NOT add a preamble or postamble or headers or titles, ONLY ADD TimeIndex markers to headings
9. Respond only with the raw answer, no intro or outro text.
10. NEVER include any reference material marked by ----- REFERENCE MATERIAL ----- blocks in your response.

EXACTLY HOW TO DO THIS:
1. Identify ALL section headings in the document that follow the markedown format
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
   - Simply use the TimeIndex value from the relevant transcript section
   - Example: If you find the relevant transcript section has [TimeIndex:175], add [TimeIndex:175] to the heading
   - DO NOT calculate seconds manually - just use the TimeIndex value directly
   - IMPORTANT: Only use TimeIndex values that actually appear in the transcript
   - ENSURE the TimeIndex value does not exceed the length of the video
6. Add the TimeIndex marker in the format: [TimeIndex:SECONDS] where SECONDS is the number of seconds
   - Example: If transcript shows [TimeIndex:175], add [TimeIndex:175] to the heading
   - Always use the exact seconds value from the transcript's TimeIndex
   - Transform heading "## 1. Introduction" to "## 1. Introduction [TimeIndex:175]"
   - Another example: "### 3.1. The Scam of Government Bonds [TimeIndex:338]"
7. Place the TimeIndex marker at the end of the heading line, after the heading text`,
    // Default to Extensive Summary
    useFastSummary: false,
    
    translateLanguage: 'en',
    translateCountry: 'US',
    youtubeApiKey: '',
    transcriptRootFolder: 'Inbox',  // Default to Inbox for backward compatibility
    dateFormat: 'YYYY-MM-DD',
    prependDate: true,
    addTimestampLinks: true,
    debugLogging: false,
    
    // License settings
    licenseAccepted: false,
    
    // Cookie management - undefined means no cookies stored yet
    youtubeCookies: undefined,
    
};

// Define a simple interface for the model object from OpenAI API
interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
    // Add other relevant properties if needed in the future
}

// Define a simple interface for the model object from Google Generative AI API
interface GoogleModel {
    name: string; // e.g., "models/gemini-1.5-pro-latest"
    displayName?: string; // e.g., "Gemini 1.5 Pro"
    version?: string;
    description?: string;
    supportedGenerationMethods?: string[];
    // Add other relevant properties if needed
}

interface ApiErrorResponse {
    error?: {
        message?: string;
    };
    message?: string;
}

interface OpenAIModelsResponse {
    data?: OpenAIModel[];
}

interface GoogleModelsResponse {
    models?: GoogleModel[];
}

export default class YouTubeTranscriptPlugin extends Plugin {
    settings: YouTubeTranscriptSettings;
    private summarizer: TranscriptSummarizer;
    private fileWatcher: Closeable | null = null;

    // Replace the duplicated showNotice method with a wrapper that calls the shared utility
    showNotice(message: string, timeout: number = 5000): void {
        showNotice(message, timeout);
    }

    // Get plugin version from manifest
    getVersion(): string {
        return this.manifest.version || 'Unknown';
    }

    async onload() {
        await this.loadSettings();
        
        // Set appropriate max tokens based on current provider and model using registry
        const effectiveMaxTokens = this.getEffectiveMaxTokens();
        
        // Only update if the current setting is a legacy hardcoded value
        if (this.settings.maxTokens === 4096 || this.settings.maxTokens === 8192 || this.settings.maxTokens === 1000) {
            this.settings.maxTokens = effectiveMaxTokens;
            await this.saveSettings();
            
            if (this.settings.debugLogging) {
                logger.debug(`[onload] Updated maxTokens from legacy value to ${effectiveMaxTokens} for ${this.settings.selectedLLM}:${this.settings.selectedModels[this.settings.selectedLLM]}`);
            }
        }
        
        // Set log level based on settings
        if (this.settings.debugLogging) {
            setGlobalLogLevel(LogLevel.DEBUG);
        } else {
            setGlobalLogLevel(LogLevel.INFO);
        }

        this.initializeSummarizer();
        
        
        this.addSettingTab(new YouTubeTranscriptSettingTab(this.app, this));
        this.checkDependencies();

        // Add ribbon icon
        this.addRibbonIcon('youtube', 'Tubesage: create note from YouTube transcript', () => {
            // Check if license has been accepted
            if (!this.settings.licenseAccepted) {
                // Show license required modal if not accepted
                new LicenseRequiredModal(this.app).open();
                return;
            }
            
            // Check if API key is set for the selected LLM provider
            const selectedLlm = this.settings.selectedLLM;
            if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
                // Show error notice
                new Notice(`Youtube Transcript Plugin: No API key configured for ${selectedLlm}. Please add your API key in the plugin settings.`);
                return;
            }
            
            // If license is accepted and API key is set, proceed with the usual workflow
            new YouTubeTranscriptModal(this.app, this).open();
        });

        // Add command
        this.addCommand({
            id: 'extract-youtube-transcript',
            name: 'Extract YouTube transcript',
            callback: () => {
                // Check if license has been accepted
                if (!this.settings.licenseAccepted) {
                    // Show license required modal if not accepted
                    new LicenseRequiredModal(this.app).open();
                    return;
                }
                
                // Check if API key is set for the selected LLM provider
                const selectedLlm = this.settings.selectedLLM;
                if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
                    // Show error notice
                    new Notice(`Youtube transcript plugin: No API key configured for ${selectedLlm}. Please add your API key in the plugin settings.`);
                    return;
                }
                
                // If license is accepted and API key is set, proceed with the usual workflow
                new YouTubeTranscriptModal(this.app, this).open();
            }
        });

        // Note: The file watcher setup has been removed as it was dependent on the anthropic proxy

    }

    onunload() {
        logger.debug('Unloading youtube transcript plugin');
        
        // Clean up file watcher if it exists
        if (this.fileWatcher) {
            try {
                this.fileWatcher.close();
                this.fileWatcher = null;
                logger.debug('Closed file watcher');
            } catch (error) {
                logger.error('Error closing file watcher:', error);
            }
        }
        
        
        // Any other cleanup needed
        logger.info('Youtube transcript plugin unloaded');
    }

    private initializeSummarizer() {
        const selectedProvider = this.settings.selectedLLM;
        const selectedModel = this.getModelForProvider(selectedProvider);
        
        logger.debug(`[initializeSummarizer] Selected provider: '${selectedProvider}'`);
        logger.debug(`[initializeSummarizer] Selected model: '${selectedModel}'`);
        logger.debug(`[initializeSummarizer] Temperature: ${this.settings.temperature}, MaxTokens: ${this.settings.maxTokens}`);
        logger.debug(`[initializeSummarizer] API Keys present:`, Object.keys(this.settings.apiKeys).reduce((acc, key) => {
            acc[key] = !!this.settings.apiKeys[key];
            return acc;
        }, {} as Record<string, boolean>));
        
        this.summarizer = new TranscriptSummarizer({
            model: selectedModel,
            temperature: this.settings.temperature,
            maxTokens: this.getEffectiveMaxTokens(), // Use dynamic calculation for all models
            systemPrompt: this.settings.systemPrompt,
            userPrompt: this.settings.userPrompt
        }, this.settings.apiKeys);
    }

    private getModelForProvider(provider: string): string {
        logger.debug(`[getModelForProvider] Getting model for provider: '${provider}'`);
        logger.debug(`[getModelForProvider] selectedModels object:`, JSON.stringify(this.settings.selectedModels, null, 2));
        
        if (this.settings.selectedModels[provider]) {
            const selectedModel = this.settings.selectedModels[provider];
            logger.debug(`[getModelForProvider] Found selected model for ${provider}: '${selectedModel}'`);
            return selectedModel;
        }
        
        // Fallback to defaults if no selection exists
        logger.debug(`[getModelForProvider] No selected model found for ${provider}, using fallback`);
        switch (provider) {
            case 'openai':
                logger.debug(`[getModelForProvider] Using OpenAI fallback: 'gpt-4-turbo'`);
                return 'gpt-4-turbo';
            case 'anthropic':
                logger.debug(`[getModelForProvider] Using Anthropic fallback: 'claude-3-sonnet-20240229'`);
                return 'claude-3-sonnet-20240229';
            case 'google':
                logger.debug(`[getModelForProvider] Using Google fallback: 'gemini-1.5-pro'`);
                return 'gemini-1.5-pro';
            case 'ollama':
                return 'llama3.1';
            default:
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }
    }

    async loadSettings() {
        const loadedData: unknown = await this.loadData();
        logger.debug('[SETTINGS DEBUG] Loaded data from storage:', loadedData);
        logger.debug('[SETTINGS DEBUG] DEFAULT_SETTINGS.selectedLLM:', DEFAULT_SETTINGS.selectedLLM);

        const loadedSettings: Partial<YouTubeTranscriptSettings> = isRecord(loadedData)
            ? (loadedData as Partial<YouTubeTranscriptSettings>)
            : {};

        this.settings = { ...DEFAULT_SETTINGS, ...loadedSettings };
        
        logger.debug('[SETTINGS DEBUG] Final settings.selectedLLM:', this.settings.selectedLLM);
        logger.debug('[SETTINGS DEBUG] All settings keys:', Object.keys(this.settings));
        // --- Fix legacy string booleans (mobile settings files might contain "true"/"false" strings) ---
        const coerceBool = (val: unknown, defaultVal: boolean): boolean => {
            if (typeof val === 'boolean') return val;
            if (typeof val === 'string') return val.toLowerCase() === 'true';
            return defaultVal;
        };

        // Ensure all boolean flags are actual booleans
        this.settings.debugLogging    = coerceBool(this.settings.debugLogging, DEFAULT_SETTINGS.debugLogging);
        this.settings.prependDate     = coerceBool(this.settings.prependDate, DEFAULT_SETTINGS.prependDate);
        this.settings.addTimestampLinks = coerceBool(this.settings.addTimestampLinks, DEFAULT_SETTINGS.addTimestampLinks);
        this.settings.useFastSummary  = coerceBool(this.settings.useFastSummary, DEFAULT_SETTINGS.useFastSummary);
        this.settings.licenseAccepted = coerceBool(this.settings.licenseAccepted, DEFAULT_SETTINGS.licenseAccepted);
        // ---------------------------------------------------------------------------
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initializeSummarizer();
    }

    async extractTranscript(videoUrl: string): Promise<string> {
        const result = await this.extractTranscriptWithMetadata(videoUrl);
        return result.transcript;
    }
    
    async extractTranscriptWithMetadata(videoUrl: string): Promise<{transcript: string, metadata: {title?: string, author?: string}}> {
        return await this.extractTranscriptsWithMetadata([videoUrl]).then(results => results[0]);
    }
    
    async extractTranscriptsWithMetadata(videoUrls: string[]): Promise<Array<{transcript: string, metadata: {title?: string, author?: string}}>> {
        try {
            transcriptLogger.debug(`Starting transcript extraction for ${videoUrls.length} URLs`);
            
            const results: Array<{transcript: string, metadata: {title?: string, author?: string}}> = [];
            
            // Process each URL
            for (let i = 0; i < videoUrls.length; i++) {
                const videoUrl = videoUrls[i];
                try {
                    transcriptLogger.debug(`Processing video ${i + 1}/${videoUrls.length}: ${videoUrl}`);
                    
                    // Extract video ID from URL
                    const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
                    
                    if (!videoId) {
            throw new Error(`Invalid youtube URL: '${videoUrl}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
                    }
                    
                    // Get transcript segments and metadata using direct ScrapeCreators method
                    const result = await YouTubeTranscriptExtractor.fetchTranscript(videoId, {
                        lang: this.settings.translateLanguage,
                        country: this.settings.translateCountry
                    });
                    
                    // Format transcript with timestamps
                    const formattedTranscript = this.formatTranscriptForYaml(result.segments);
                    results.push({
                        transcript: formattedTranscript,
                        metadata: result.metadata
                    });
                    
                } catch (error) {
                    transcriptLogger.error(`Failed to extract transcript for video ${i + 1}/${videoUrls.length}:`, error);
                    const errorMessage = getSafeErrorMessage(error);
                    // Continue with other videos, but include error result
                    results.push({
                        transcript: `[TRANSCRIPT EXTRACTION FAILED: ${errorMessage}]`,
                        metadata: { title: `Error extracting from URL: ${videoUrl}`, author: 'Unknown' }
                    });
                }
            }
            
            return results;
            
        } catch {
            // Use the new error handling utility
            throw handleApiError('Unknown error', 'Youtube API', 'Transcript extraction');
        }
    }

    // Helper method to format transcript segments for YAML frontmatter
    private formatTranscriptForYaml(segments: TranscriptInputSegment[]): string {
        // Process segments into formatted text with timestamps
        let formattedTranscript = '';
        
        transcriptLogger.debug("Formatting transcript segments:", 
            (Array.isArray(segments) ? `${segments.length} segments` : 'not an array'));
        
        if (Array.isArray(segments)) {
            // Create exactly 1-minute chunks based on actual timestamps
            const ONE_MINUTE_SECONDS = 60; // 1 minute in seconds
            let chunks: {time: string, text: string, seconds: number}[] = [];
            
            // Track the current chunk being built
            let currentChunk = {
                time: '',
                text: '',
                seconds: 0,
                startSeconds: 0
            };
            
            let isFirstSegment = true;
            
            // Function to parse and convert timestamp to seconds
            const timestampToSeconds = (time: number | string): number => {
                // If time is already a number (seconds), return it
                if (typeof time === 'number') {
                    return time;
                }
                
                // Handle milliseconds (convert to seconds)
                if (typeof time === 'string' && time.includes('ms')) {
                    return parseInt(time) / 1000;
                }
                
                // If we don't recognize the format, return 0
                return 0;
            };
            
            // Sort segments by timestamp if needed
            const sortedSegments = [...segments].sort((a, b) => {
                const aTime = timestampToSeconds(a.start || (a.tStartMs ? parseInt(a.tStartMs) / 1000 : 0));
                const bTime = timestampToSeconds(b.start || (b.tStartMs ? parseInt(b.tStartMs) / 1000 : 0));
                return aTime - bTime;
            });
            
            // Process and group segments into chunks based on actual timestamps
            sortedSegments.forEach((segment, index) => {
                // Get segment start time in seconds
                let segmentTimeSeconds = 0;
                if (typeof segment.start === 'number') {
                    segmentTimeSeconds = segment.start;
                } else if (segment.tStartMs) {
                    segmentTimeSeconds = parseInt(segment.tStartMs) / 1000;
                }
                
                // Format segment time as HH:MM:SS
                const segmentTimeFormatted = this.formatTimestamp(segmentTimeSeconds);
                
                // Extract text from segment
                let segmentText = '';
                if (segment.text) {
                    segmentText = segment.text.trim();
                } else if (segment.segs && Array.isArray(segment.segs)) {
                    segmentText = segment.segs.map((s) => s.utf8 || '').join('').trim();
                }
                
                // Skip empty segments
                if (!segmentText) return;
                
                // If this is the first segment or we've reached/exceeded a minute boundary
                if (isFirstSegment || 
                    (segmentTimeSeconds - currentChunk.startSeconds >= ONE_MINUTE_SECONDS)) {
                    
                    // Add the previous chunk if it exists and isn't the first segment
                    if (!isFirstSegment && currentChunk.text) {
                        chunks.push({
                            time: this.formatTimestamp(currentChunk.startSeconds),
                            text: currentChunk.text,
                            seconds: currentChunk.startSeconds
                        });
                    }
                    
                    // Start a new chunk
                    currentChunk = {
                        time: segmentTimeFormatted,
                        text: segmentText,
                        seconds: segmentTimeSeconds,
                        startSeconds: segmentTimeSeconds
                    };
                    
                    isFirstSegment = false;
                } else {
                    // Add to current chunk with a space
                    currentChunk.text += ' ' + segmentText;
                }
            });
            
            // Add the last chunk if it has content
            if (currentChunk.text) {
                chunks.push({
                    time: this.formatTimestamp(currentChunk.startSeconds),
                    text: currentChunk.text,
                    seconds: currentChunk.startSeconds
                });
            }

            transcriptLogger.debug(`Created ${chunks.length} exactly time-based chunks`);
            
            // Format chunks for YAML frontmatter
            // Start with a newline to ensure proper YAML block format
            formattedTranscript = "\n";
            
            chunks.forEach((chunk) => {
                // Create the TimeIndex marker with unescaped colon
                const timeIndexMarker = `[TimeIndex:${Math.round(chunk.seconds)}]`;
                
                // Handle escaping of colons in the text portion only
                let textContent = chunk.text;
                
                // Remove any existing TimeIndex markers from the text
                const timeIndexRegex = /\[TimeIndex:(\d+)\]/g;
                textContent = textContent.replace(timeIndexRegex, '');
                
                // Now escape colons only in the text
                const escapedText = textContent.replace(/:/g, "\\:");
                
                // Position the TimeIndex marker right after the timestamp
                formattedTranscript += `    [${chunk.time}] ${timeIndexMarker} ${escapedText}\n`;
            });
        } else {
            // Fallback if segments is not an array
            formattedTranscript = "\n    Unable to format transcript properly";
        }
        
        return formattedTranscript;
    }
    
    // Format seconds into HH:MM:SS format
    private formatTimestamp(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        
        return [
            h.toString().padStart(2, '0'),
            m.toString().padStart(2, '0'),
            s.toString().padStart(2, '0')
        ].join(':');
    }

    async summarizeTranscript(transcript: string): Promise<string> {
        try {
            // Clean the transcript using our utility function
            const cleanedTranscript = cleanTranscript(transcript);
            
            // Determine which prompt to use based on settings
            const summaryMode = this.settings.useFastSummary ? SummaryMode.FAST : SummaryMode.EXTENSIVE;
            
            // Get the prompt configuration with dynamic max tokens
            const promptConfig = getPromptConfig(this.settings, summaryMode, this.getEffectiveMaxTokens());
            
            // --- Add logging for the summarization step ---
            llmLogger.debug(`[summarizeTranscript] Starting ${summaryMode} summary.`);
            llmLogger.debug(`[summarizeTranscript] Using model: ${this.settings.selectedLLM} - ${this.getModelForProvider(this.settings.selectedLLM)}`);
            llmLogger.debug(`[summarizeTranscript] Max Tokens: ${promptConfig.maxTokens}, Temperature: ${promptConfig.temperature}`);
            if (this.settings.debugLogging) { // Only log prompts/transcript in debug mode
                llmLogger.debug("--- System Prompt ---");
                llmLogger.debug(truncateForLogs(promptConfig.systemPrompt, 200));
                llmLogger.debug("--- User Prompt ---");
                llmLogger.debug(truncateForLogs(promptConfig.userPrompt, 200));
                // Log truncated transcript to avoid excessive length
                llmLogger.debug("--- Cleaned Transcript (Excerpt) ---");
                llmLogger.debug(truncateForLogs(cleanedTranscript, 300));
                llmLogger.debug("---------------------------------");
            }
            // --- End added logging ---
            
            llmLogger.debug("Using token limit:", promptConfig.maxTokens); // Keep existing token log
            
            // Store provider value before any potential context corruption
            const selectedProvider = this.settings.selectedLLM;
            
            // Debug the config being passed to TranscriptSummarizer
            const model = this.getModelForProvider(selectedProvider);
            llmLogger.debug(`[DEBUG] Model: ${model}`);
            llmLogger.debug(`[DEBUG] Temperature: ${promptConfig.temperature}`);
            llmLogger.debug(`[DEBUG] MaxTokens: ${promptConfig.maxTokens}`);
            llmLogger.debug(`[DEBUG] SystemPrompt length: ${promptConfig.systemPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[DEBUG] UserPrompt length: ${promptConfig.userPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[DEBUG] SelectedLLM: ${selectedProvider}`);
            
            // Safety check for settings and API keys
            llmLogger.debug(`[DEBUG] Checking settings - exists: ${!!this.settings}`);
            if (!this.settings) {
                throw new Error('Plugin settings are not loaded');
            }
            
            llmLogger.debug(`[DEBUG] Checking apiKeys - exists: ${!!this.settings.apiKeys}`);
            llmLogger.debug(`[DEBUG] ApiKeys type: ${typeof this.settings.apiKeys}`);
            const apiKeyKeys = this.settings.apiKeys ? Object.keys(this.settings.apiKeys) : [];
            llmLogger.debug(`[DEBUG] ApiKeys keys: ${apiKeyKeys.length ? apiKeyKeys.join(', ') : 'none'}`);
            
            if (!this.settings.apiKeys) {
                throw new Error('API keys are not configured in settings');
            }
            
            // Create a summarizer with the prompt configuration
            llmLogger.debug(`[DEBUG] About to create TranscriptSummarizer...`);
            const tempSummarizer = new TranscriptSummarizer({
                model: model,
                temperature: promptConfig.temperature,
                maxTokens: promptConfig.maxTokens,
                systemPrompt: promptConfig.systemPrompt,
                userPrompt: promptConfig.userPrompt
            }, this.settings.apiKeys);
            llmLogger.debug(`[DEBUG] TranscriptSummarizer created successfully`);
            
            llmLogger.debug(`[DEBUG] About to call summarize with provider: '${selectedProvider}'`);
            llmLogger.debug(`[DEBUG] this object type:`, typeof this, this.constructor.name);
            llmLogger.debug(`[DEBUG] this.settings exists:`, !!this.settings);
            llmLogger.debug(`[DEBUG] Full settings.selectedLLM value:`, this.settings?.selectedLLM);
            llmLogger.debug(`[DEBUG] Settings object keys:`, this.settings ? Object.keys(this.settings) : 'settings is null/undefined');
            const summary = await tempSummarizer.summarize(cleanedTranscript, selectedProvider);
            
            // Add the creator support message at the beginning of the summary 
        const supportMessage = "Support content creators: If you found this content valuable, please consider supporting the Youtube creator by liking 👍 the video and subscribing to their channel. ";
            
            // Sanitize the beginning of the summary to ensure clean paragraph flow
            let sanitizedSummary = summary;
            
            // Remove leading newlines, spaces, and markdown formatting from the summary
            sanitizedSummary = sanitizedSummary.replace(/^[\s\n\r]*/, '');
            
            // If the summary starts with list markers or headers, we need a line break
            if (/^(#|-|\*|\d+\.)/.test(sanitizedSummary)) {
                // Summary starts with Markdown formatting, need to keep them separated
                return supportMessage + "\n\n" + sanitizedSummary;
            } else {
                // Get the first paragraph from the summary (up to first double newline)
                const firstParagraphMatch = sanitizedSummary.match(/^([^\n]+(?:\n[^\n]+)*)/);
                if (firstParagraphMatch) {
                    const firstParagraph = firstParagraphMatch[0];
                    // Replace any single newlines with spaces in the first paragraph
                    const cleanFirstParagraph = firstParagraph.replace(/\n/g, ' ');
                    // Rest of the summary after the first paragraph
                    const restOfSummary = sanitizedSummary.substring(firstParagraph.length);
                    // Combine: support message + clean first paragraph + rest of summary
                    return supportMessage + cleanFirstParagraph + restOfSummary;
                }
                
                // Fallback if we can't match a first paragraph
                return supportMessage + sanitizedSummary;
            }
        } catch (error) {
            // Use the error handling utility
            throw handleApiError(error, this.settings.selectedLLM, 'Summarization');
        } finally {
            // If using Anthropic provider and fast summary mode or not adding timestamp links,
            // log information about completion
            if (this.settings.selectedLLM === 'anthropic' && 
                (this.settings.useFastSummary || !this.settings.addTimestampLinks)) {
                llmLogger.info('[summarizeTranscript] Completed Anthropic processing (fast summary or no timestamp links)');
            }
        }
    }

    async applyTemplate(title: string, videoUrl: string, transcript: string, summary: string, folder?: string, contentType?: string): Promise<void> {
        // Check if Templater plugin is available
        const templaterPlugin = getTemplaterPlugin(this.app);
        
        if (!templaterPlugin) {
            this.showNotice('Error: Templater plugin is required but not installed or enabled', 5000);
            throw new Error('Templater plugin is required but not installed or enabled.');
        }
        
        try {
            // Get the Templater instance
            const templater = templaterPlugin.templater;
            
            // If Templater has never run, do a dummy parse to initialize.
            if (!templater.current_functions_object) {
                // We'll initialize with the actual template processing below
            }
            
            // Sanitize the title for use as a filename
            const sanitizedTitle = sanitizeFilename(title);

            // Normalize video URL data for templating (e.g., shorts/playlist URLs)
            const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
            const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : videoUrl;
            const thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '';
            
            // Format date according to settings
            let datePrefix = '';
            if (this.settings.prependDate) {
                const now = new Date();
                
                // Format date based on the selected format
                switch (this.settings.dateFormat) {
                    case 'YYYY-MM-DD':
                        datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                        break;
                    case 'MM-DD-YYYY':
                        datePrefix = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()} `;
                        break;
                    case 'DD-MM-YYYY':
                        datePrefix = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()} `;
                        break;
                    default:
                        datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                }
            }
            
            // REDO THE TRANSCRIPT FORMATTING FOR YAML
            // We'll re-process the transcript no matter what format it's in
            logger.debug("Processing transcript for YAML format");
            
            // Format the transcript with original timestamps preserved
            let formattedTranscript = "";
            
            // Check if the transcript already has timestamps in format [HH:MM:SS]
            if (transcript.includes('[00:') || transcript.includes('[01:') || transcript.match(/\[\d{2}:\d{2}:\d{2}\]/)) {
                logger.debug("Transcript contains timestamps, organizing into ≥60 second blocks");
                
                // Split the transcript into lines
                const originalLines = transcript.split('\n').filter(line => line.trim().length > 0);
                
                // Parse each line with its timestamp
                const parsedLines: {timestamp: string, seconds: number, text: string}[] = [];
                
                originalLines.forEach(line => {
                    // Look for timestamp pattern [HH:MM:SS]
                    const timestampMatch = line.match(/^\s*\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
                    
                    if (timestampMatch) {
                        const timestamp = timestampMatch[1];
                        let text = timestampMatch[2].trim();
                        
                        // Remove any escaped backslashes from TimeIndex markers
                        text = text.replace(/\[TimeIndex\\?:(\d+)\]/g, '[TimeIndex:$1]');
                        
                        // Convert timestamp to seconds for comparison
                        const parts = timestamp.split(':').map(Number);
                        const seconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
                        
                        parsedLines.push({
                            timestamp,
                            seconds,
                            text
                        });
                    } else if (line.trim().length > 0) {
                        // Handle lines without timestamps - append to the last segment if it exists
                        if (parsedLines.length > 0) {
                            // Add this content to the last parsed line
                            parsedLines[parsedLines.length - 1].text += ' ' + line.trim();
                        } else {
                            // If no timestamps yet, create a placeholder entry for time 0
                            parsedLines.push({
                                timestamp: '00:00:00',
                                seconds: 0,
                                text: line.trim()
                            });
                        }
                    }
                });
                
                // Group lines into blocks of ≥60 seconds
                const segments: {timestamp: string, text: string}[] = [];
                
                // Process lines into segments
                if (parsedLines.length > 0) {
                    // Sort parsed lines by seconds to ensure chronological order
                    parsedLines.sort((a, b) => a.seconds - b.seconds);
                    
                    // Initialize with the first line
                    let segmentTimestamp = parsedLines[0].timestamp;
                    let segmentStartSeconds = parsedLines[0].seconds;
                    let segmentLines: string[] = [parsedLines[0].text];
                    
                    // Process remaining lines
                    for (let i = 1; i < parsedLines.length; i++) {
                        const line = parsedLines[i];
                        
                        // If this line is at least 60 seconds from the start of current segment,
                        // finalize the current segment and start a new one
                        if (line.seconds - segmentStartSeconds >= 60) {
                            // Add completed segment
                            segments.push({
                                timestamp: segmentTimestamp,
                                text: segmentLines.join(' ')
                            });
                            
                            // Start a new segment - ALWAYS use the actual timestamp from the current line
                            segmentTimestamp = line.timestamp;
                            segmentStartSeconds = line.seconds;
                            segmentLines = [line.text];
                        } else {
                            // Add to current segment
                            segmentLines.push(line.text);
                        }
                    }
                    
                    // Add the final segment if it has any content
                    if (segmentLines.length > 0) {
                        segments.push({
                            timestamp: segmentTimestamp,
                            text: segmentLines.join(' ')
                        });
                    }
                }
                
                logger.debug(`Organized ${originalLines.length} lines into ${segments.length} ≥60-second blocks`);
                
                // Format segments for YAML frontmatter
                segments.forEach(segment => {
                    // Convert timestamp to seconds using our custom function
                    const timeIndex = convertTimestampToSeconds(segment.timestamp);
                    
                    // Create the TimeIndex marker with unescaped colon
                    const timeIndexMarker = `[TimeIndex:${timeIndex}]`;
                    
                    // Handle text content 
                    let textContent = segment.text;
                    
                    // Remove any existing TimeIndex markers from the text
                    const timeIndexRegex = /\[TimeIndex:(\d+)\]/g;
                    textContent = textContent.replace(timeIndexRegex, '');
                    
                    // Only escape colons in the text content
                    const escapedText = textContent.replace(/:/g, "\\:");
                    
                    // Position the TimeIndex marker right after the timestamp
                    formattedTranscript += `    [${segment.timestamp}] ${timeIndexMarker} ${escapedText}\n`;
                });
            } else {
                logger.debug("Transcript does not contain timestamps");
                
                // Provide a warning message in the transcript text
            formattedTranscript = "    [ERROR] No timestamps found in transcript. Please ensure the Youtube transcript contains timestamps.";
                
                // Show an error notice
                this.showNotice("Warning: No timestamps found in transcript. Timestamps are required for proper processing.", 5000);
            }
            
            // Now use this properly formatted transcript
            transcript = formattedTranscript;
            
            // Final cleanup - ensure all TimeIndex markers are unescaped
            transcript = transcript.replace(/\[TimeIndex\\:(\d+)\]/g, '[TimeIndex:$1]');
            
            // Normalize the folder path
            const normalizedFolder = normalizePath(folder || '');
            
            // Create folder if needed
            if (normalizedFolder) {
                await ensureFolder(this.app.vault, normalizedFolder);
            }
            
            // Normalize the template path
            const normalizedTemplatePath = normalizePath(this.settings.templaterTemplateFile);
            
            // Get template file and verify it exists
            const templateFile = this.app.vault.getAbstractFileByPath(normalizedTemplatePath);
            if (!(templateFile instanceof TFile)) {
                throw new Error(`Template file not found: ${this.settings.templaterTemplateFile}`);
            }
            
            // 1. Initialize Templater if needed (force a one-time run)
            if (!templater.current_functions_object) {
                // We'll initialize with the actual template processing below
            }
            
            // 2. Create a running config for the actual template
            const config = templater.create_running_config(
                templateFile,
                templateFile, // Use the template file itself as target to avoid null path errors
                0    // Numeric value for "CreateNewFromTemplate"
            );
            
            // 3. Generate the Templater context (tp object)
            const ctx = await templater.functions_generator.generate_object(config);
            
            // 4. Inject our custom data into ctx.user as functions
            const user = ctx.user ?? {};
            ctx.user = user;
            
            // Set up our data as functions in ctx.user
            user.title = sanitizedTitle;
            // Use a normalized watch URL so template parsing doesn't break on shorts/live URLs
            user.videoUrl = watchUrl || videoUrl;
            user.originalVideoUrl = videoUrl;
            user.videoId = videoId || '';
            user.watchUrl = watchUrl || videoUrl;
            user.thumbnailUrl = thumbnailUrl;
            user.transcript = transcript;
            user.summary = summary;
            
            // Add LLM provider and model info
            const llmProvider = this.settings.selectedLLM;
            const llmModel = this.settings.selectedModels[llmProvider];
            user.llmProvider = llmProvider;
            user.llmModel = llmModel;
            
            // Add tags for LLM provider and model in proper YAML array format
            const baseTags = ["youtube", "transcript"];
            const llmProviderTag = `llm/${llmProvider}`;
            const llmModelTag = `model/${llmModel.replace(/[:.]/g, "-")}`;
            const allTags = [...baseTags, llmProviderTag, llmModelTag];
            const llmTags = `[${allTags.join(", ")}]`;
            user.llmTags = llmTags;
            
            // Add plugin version for frontmatter tracking
            user.version = this.getVersion();
            
            // Debug info is only logged, not included in notes
            if (this.settings.debugLogging) {
                logger.debug(`Transcript info: 
                - Length: ${transcript ? transcript.length : 'unknown'} characters
                - Contains timestamps: ${transcript ? transcript.includes('[00:') : 'unknown'}
                - LLM Provider: ${llmProvider}
                - LLM Model: ${llmModel}`);
            }
            
            // 5. Read and parse the template with our custom context
            const templateContent = await this.app.vault.read(templateFile);
            
            // Debug logging to check template content and tags
            if (this.settings.debugLogging) {
                logger.debug(`Template content (first 500 chars): ${templateContent.substring(0, 500)}`);
                logger.debug(`ctx.user.llmTags value: ${llmTags}`);
            }
            
            const parsedContent = await templater.parser.parse_commands(templateContent, ctx);
            
            // Debug logging to check parsed content
            if (this.settings.debugLogging) {
                const frontmatterEnd = parsedContent.indexOf('---', 3);
                if (frontmatterEnd !== -1) {
                    const frontmatter = parsedContent.substring(0, frontmatterEnd + 3);
                    logger.debug(`Parsed frontmatter: ${frontmatter}`);
                }
            }
            
            // 6. Create the new file with parsed content
            let finalContent = parsedContent;
            
            // The support message is now added directly to the summary in summarizeTranscript method
            // So we don't need to insert it here anymore
            
            const fileName = `${datePrefix}${sanitizedTitle}.md`;
            const filePath = normalizedFolder ? joinPaths(normalizedFolder, fileName) : fileName;
            
            // @ts-ignore - Using Obsidian API
            const newFile = await this.app.vault.create(filePath, finalContent);
            
            // 7. Open the new file
            // @ts-ignore - Using Obsidian API
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(newFile);
            
            this.showNotice(`Created note: ${datePrefix}${sanitizedTitle}`, 5000);
        } catch (error) {
            logger.error("Error applying template:", error);
            const errorMessage = getSafeErrorMessage(error);
            this.showNotice(`Error creating note: ${errorMessage}`, 5000);
            // Clear logs on error too
            clearLogs();
            throw error;
        }
    }

    // Simplified method to ensure a folder exists - wrapper for the utility
    private async ensureFolderExists(folderPath: string): Promise<void> {
        await ensureFolder(this.app.vault, folderPath);
    }

    // Add a debugging method to help troubleshoot
    debugSettings() {
        logger.debug('=== DEBUG SETTINGS ===');
        logger.info('Selected LLM:', this.settings.selectedLLM);
        logger.debug('Selected Models:', JSON.stringify(this.settings.selectedModels));
        
        const apiKeyStatus = Object.entries(this.settings.apiKeys).map(([provider, key]) => {
            return `${provider}: ${key ? '✓' : '✗'}`;
        }).join(', ');
        
        logger.info('API Keys configured:', apiKeyStatus);
        
        if (!this.settings.apiKeys[this.settings.selectedLLM]) {
            logger.warn(`No API key configured for selected LLM: ${this.settings.selectedLLM}`);
        }
        
        logger.debug('=====================');
    }

    // Check for required dependencies
    private checkDependencies(): void {
        // Check for Templater plugin
        const templater = getTemplaterPlugin(this.app);
        
        if (!templater) {
            // Show a notice with instructions on how to install Templater
            setTimeout(() => {
        this.showNotice('Youtube transcript plugin requires the Templater plugin. Please install and enable it.', 5000);
            }, 3000); // Delay to ensure it's seen after initial plugin load
        }
        
        // Check for LLM API key
        const selectedLlm = this.settings.selectedLLM;
        if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
            setTimeout(() => {
                this.showNotice(`Youtube transcript plugin: no API key configured for ${selectedLlm}. Please add your API key in settings.`, 5000);
            }, 4500);
        }
    }

    // Use imported utility method
    private isYoutubeUrl(this: void, url: string): boolean {
        return isYoutubeUrl(url);
    }
    
    // Use imported utility method
    private isYoutubeChannelOrPlaylistUrl(this: void, url: string): boolean {
        return isYoutubeChannelOrPlaylistUrl(url);
    }
    
    // Use imported utility method
    private extractChannelName(url: string): string {
        return extractChannelName(url);
    }

    // Method to fetch videos from a YouTube channel or playlist
    async fetchCollectionVideos(sourceUrl: string, limit: number = 0): Promise<{ title: string, url: string }[]> {
        try {
            // Use the main YouTube API key
            const API_KEY = this.settings.youtubeApiKey;
            
            if (!API_KEY) {
            throw new Error('Youtube API key is required. Please set it in the plugin settings.');
            }
            
            this.showNotice('Fetching collection information...', 5000);
            
            // Determine if it's a playlist or channel and get appropriate ID
            let isPlaylist = sourceUrl.includes('/playlist') || sourceUrl.includes('list=');
            let sourceId;
            let sourceTitle = '';
            let videoResults: Array<{title: string, url: string}> = [];
            
            if (isPlaylist) {
                // Extract playlist ID
                if (sourceUrl.includes('list=')) {
                    const match = sourceUrl.match(/list=([^&]+)/);
                    if (match && match[1]) {
                        sourceId = match[1];
                        this.showNotice(`Fetching playlist with ID: ${sourceId}`, 3000);
                        
                        // Get playlist details
                        const playlistResponse = await obsidianFetch(
                            `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${sourceId}&key=${API_KEY}`
                        );
                        
                        if (!playlistResponse.ok) {
                            throw new Error(`Failed to fetch playlist data: HTTP status ${playlistResponse.status}`);
                        }
                        
                        const playlistData = await playlistResponse.json() as PlaylistResponse;
                        
                        if (!playlistData.items || playlistData.items.length === 0) {
                            throw new Error('Playlist not found');
                        }
                        
                        // Get playlist name for display
                        sourceTitle = playlistData.items[0].snippet?.title ?? '';
                        
                        // Fetch videos from playlist with pagination support
                        let nextPageToken: string | null = null;
                        let videosCount = 0;
                        const MAX_RESULTS_PER_PAGE = 50; // YouTube API limit
                        const SAFETY_LIMIT = 50; // Safety limit to prevent excessive API calls
                        
                        do {
                            // Build URL with page token if we have one
                            let videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${MAX_RESULTS_PER_PAGE}&playlistId=${sourceId}&key=${API_KEY}`;
                            if (nextPageToken) {
                                videosUrl += `&pageToken=${nextPageToken}`;
                            }
                            
                            this.showNotice(`Fetching playlist videos${nextPageToken ? ' (continued)' : ''}...`, 3000);
                            
                            const videosResponse = await obsidianFetch(videosUrl);
                            
                            if (!videosResponse.ok) {
                                throw new Error(`Failed to fetch playlist videos: HTTP status ${videosResponse.status}`);
                            }
                            
                            const videosData = await videosResponse.json() as PlaylistItemsResponse;
                            
                            if (!videosData.items || videosData.items.length === 0) {
                                break;
                            }
                            
                            // Extract video information and add to results
                            const pageVideos = videosData.items
                                .filter((item: YouTubePlaylistItem) => 
                                    !!item.snippet?.title && 
                                    !!item.snippet?.resourceId?.videoId)
                                .map((item: YouTubePlaylistItem) => ({
                                    title: item.snippet?.title ?? '',
                                    url: `https://www.youtube.com/watch?v=${item.snippet?.resourceId?.videoId ?? ''}`
                                }));
                                
                            videoResults = videoResults.concat(pageVideos);
                            videosCount += pageVideos.length;
                            
                            // Get next page token if available
                            nextPageToken = videosData.nextPageToken || null;
                            
                            // If we've reached our limit or safety limit, stop paginating
                            if ((limit > 0 && videosCount >= limit) || 
                                (limit === 0 && videosCount >= SAFETY_LIMIT)) {
                                // If we hit the safety limit, show a notice
                                if (limit === 0 && videosCount >= SAFETY_LIMIT) {
                                    this.showNotice(`Reached safety limit of ${SAFETY_LIMIT} videos. Processing the first ${SAFETY_LIMIT} videos.`, 5000);
                                }
                                break;
                            }
                            
                        } while (nextPageToken);
                    } else {
                        throw new Error('Could not extract playlist ID from URL');
                    }
                } else {
                    throw new Error('Invalid playlist URL format');
                }
            } else {
                // Handle channel URL
                sourceId = await this.getChannelIdFromInput(sourceUrl, API_KEY);
                
                if (!sourceId) {
                    throw new Error('Could not extract channel ID from URL');
                }
                
                // Get channel details
                const channelResponse = await obsidianFetch(
                    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${sourceId}&key=${API_KEY}`
                );
                
                if (!channelResponse.ok) {
                    throw new Error(`Failed to fetch channel data: HTTP status ${channelResponse.status}`);
                }
                
                const channelData = await channelResponse.json() as ChannelResponse;
                
                if (!channelData.items || channelData.items.length === 0) {
                    throw new Error('Channel not found');
                }
                
                // Get channel name for display
                sourceTitle = channelData.items[0].snippet?.title ?? '';
                
                // Get the uploads playlist ID
                const uploadsPlaylistId = channelData.items[0].contentDetails?.relatedPlaylists?.uploads ?? '';
                if (!uploadsPlaylistId) {
                    throw new Error('Channel uploads playlist not found');
                }
                
                // Get videos from the uploads playlist with pagination
                let nextPageToken: string | null = null;
                let videosCount = 0;
                const MAX_RESULTS_PER_PAGE = 50; // YouTube API limit
                const SAFETY_LIMIT = 50; // Safety limit to prevent excessive API calls
                
                do {
                    // Build URL with page token if we have one
                    let videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${MAX_RESULTS_PER_PAGE}&playlistId=${uploadsPlaylistId}&key=${API_KEY}`;
                    if (nextPageToken) {
                        videosUrl += `&pageToken=${nextPageToken}`;
                    }
                    
                    this.showNotice(`Fetching channel videos${nextPageToken ? ' (continued)' : ''}...`, 3000);
                    
                    const videosResponse = await obsidianFetch(videosUrl);
                    
                    if (!videosResponse.ok) {
                        throw new Error(`Failed to fetch videos: HTTP status ${videosResponse.status}`);
                    }
                    
                    const videosData = await videosResponse.json() as PlaylistItemsResponse;
                    
                    if (!videosData.items || videosData.items.length === 0) {
                        break;
                    }
                    
                    // Extract video information and add to results
                    const pageVideos = videosData.items
                        .filter((item: YouTubePlaylistItem) => 
                            !!item.snippet?.title && 
                            !!item.snippet?.resourceId?.videoId)
                        .map((item: YouTubePlaylistItem) => ({
                            title: item.snippet?.title ?? '',
                            url: `https://www.youtube.com/watch?v=${item.snippet?.resourceId?.videoId ?? ''}`
                        }));
                        
                    videoResults = videoResults.concat(pageVideos);
                    videosCount += pageVideos.length;
                    
                    // Get next page token if available
                    nextPageToken = videosData.nextPageToken || null;
                    
                    // If we've reached our limit or safety limit, stop paginating
                    if ((limit > 0 && videosCount >= limit) || 
                        (limit === 0 && videosCount >= SAFETY_LIMIT)) {
                        // If we hit the safety limit, show a notice
                        if (limit === 0 && videosCount >= SAFETY_LIMIT) {
                            this.showNotice(`Reached safety limit of ${SAFETY_LIMIT} videos. Processing the first ${SAFETY_LIMIT} videos.`, 5000);
                        }
                        break;
                    }
                    
                } while (nextPageToken);
            }
            
            // Show what we found
            this.showNotice(`Found ${sourceTitle}: ${videoResults.length} videos`, 3000);
            
            // Limit if needed (for specific requested limits)
            if (limit > 0 && videoResults.length > limit) {
                return videoResults.slice(0, limit);
            }
            
            return videoResults;
        } catch (error) {
            logger.error('Error fetching collection videos:', error);
            const errorMessage = getSafeErrorMessage(error);
            throw new Error(`Failed to fetch videos: ${errorMessage || 'Unknown error'}`);
        }
    }

    // Helper method to get channel ID from URL
    private async getChannelIdFromInput(channelUrl: string, apiKey: string): Promise<string> {
        // If it's already a channel ID format (UC...)
        if (channelUrl.includes('/channel/')) {
            const match = channelUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                return match[1];
            }
        }
        
        // Handle @handle format
        if (channelUrl.includes('/@')) {
            const match = channelUrl.match(/\/@([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                return await this.getChannelIdFromHandle(match[1], apiKey);
            }
        }
        
        // Handle /c/ format
        if (channelUrl.includes('/c/')) {
            const match = channelUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                throw new Error('Custom URL slugs (/c/) cannot be directly converted to channel IDs. Please use a channel URL with /channel/ or @handle format.');
            }
        }
        
        throw new Error('Could not extract channel identifier from URL');
    }
    
    // Helper method to get channel ID from handle
    private async getChannelIdFromHandle(handle: string, apiKey: string): Promise<string> {
        const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${apiKey}`;
        
        const response = await obsidianFetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch channel ID: HTTP status ${response.status}`);
        }
        
        const data = await response.json() as ChannelIdResponse;
        
        if (!data.items || data.items.length === 0) {
            throw new Error(`No channel found for handle: ${handle}`);
        }
        
        const channelId = data.items[0].id;
        if (!channelId) {
            throw new Error(`No channel ID found for handle: ${handle}`);
        }
        return channelId;
    }

    // Add timestamp links to section headings in an existing note using LLM
    async addSectionLinksToNote(filePath: string, videoUrl: string): Promise<void> {
        try {
            // Extract video ID from URL
            const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
            if (!videoId) {
                logger.error(`Could not extract video ID from URL: ${videoUrl}`);
            throw new Error(`Invalid Youtube URL: '${videoUrl}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
            }

            // Read the note content
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) {
                logger.error(`Could not find note file: ${filePath}`);
                // Try to check if any similar files exist
                const folder = filePath.substring(0, filePath.lastIndexOf('/'));
                try {
                    // @ts-ignore - Using internal Obsidian API
                    const folderContents = (this.app.vault.getMarkdownFiles() as Array<{ path: string }>)
                        .filter((f) => f.path.startsWith(folder))
                        .map((f) => f.path);
                    if (folderContents.length > 0) {
                        // Only show a limited number of files to avoid excessive logging
                        const MAX_FILES_TO_LOG = 3;
                        if (folderContents.length <= MAX_FILES_TO_LOG) {
                            logger.debug(`Files in the same folder: ${folderContents.join(', ')}`);
                        } else {
                            const shownFiles = folderContents.slice(0, MAX_FILES_TO_LOG);
                            logger.debug(`Files in the same folder (${folderContents.length} total): ${shownFiles.join(', ')}... and ${folderContents.length - MAX_FILES_TO_LOG} more`);
                        }
                    } else {
                        logger.debug(`No files found in folder: ${folder}`);
                    }
                } catch (folderError) {
                    const errorMessage = getSafeErrorMessage(folderError);
                    logger.error(`Error checking folder contents: ${errorMessage}`);
                }
                throw new Error('Could not find note file');
            }

            // Log file info but don't do instanceof checks
            logger.debug(`File found: ${filePath}`);
            
            // Read the content using our custom interface
            const content = await this.app.vault.read(file);
            
            // Extract headings from the content
            const headings: string[] = [];
            const headingPositions: number[] = [];
            
            // Use a regex to find all headings (lines starting with #)
            const headingRegex = /^(#{1,6})\s+(.+)$/gm;
            let match;
            while ((match = headingRegex.exec(content)) !== null) {
                headings.push(match[2].trim());
                headingPositions.push(match.index);
            }

            if (headings.length === 0) {
                logger.debug('[addSectionLinksToNote] No headings found in note');
                return;
            }

            logger.debug(`[addSectionLinksToNote] Found ${headings.length} headings`);

            // Check if translation is needed
            const needsTranslation = this.settings.translateLanguage !== 'en' || this.settings.translateCountry !== 'US';
            
            // If we have more than 5 headings, use chunked processing
            let contentWithLinks;
            if (headings.length > 5) {
                contentWithLinks = await this.addTimestampLinksInChunks(
                    filePath,
                    videoId,
                    content,
                    headings,
                    headingPositions
                );
            } else {
                contentWithLinks = await this.addTimestampLinksSinglePass(
                    filePath,
                    videoId,
                    content,
                    headings
                );
            }
            
            // If translation is needed and we have content with links
            if (needsTranslation && contentWithLinks) {
                // Do a second pass for translation
                await this.translateContent(
                    filePath, 
                    contentWithLinks, 
                    this.settings.translateLanguage, 
                    this.settings.translateCountry
                );
            }
        } catch (error) {
            logger.error('[addSectionLinksToNote] Error:', error);
            throw error;
        } finally {
            // Stop the Anthropic proxy server if it was used
            if (this.settings.selectedLLM === 'anthropic') {
                logger.info('[addSectionLinksToNote] Completed Anthropic processing');
            }
        }
    }
    
    // Process document in a single pass to add timestamp links
    private async addTimestampLinksSinglePass(
        filePath: string, 
        videoId: string, 
        originalContent: string,
        headings: string[]
    ): Promise<string | null> {
        try {
            // Extract document components using the utility
            const { frontmatter, contentWithoutFrontmatter, transcript } = 
                extractDocumentComponents(originalContent);
            
            // Get the timestamp link configuration
            const timestampConfig = getTimestampLinkConfig(this.settings, videoId, this.getEffectiveMaxTokens());
            
            // Get the safely calculated max tokens from our updated method
            const maxTokens = this.getMaxTokensForTimestampPass();
            
            if (this.settings.debugLogging) {
                llmLogger.debug("[addTimestampLinksSinglePass] Using max tokens: " + maxTokens);
            }
            
            // Truncate transcript for very large transcripts to avoid token overflow
            let processedTranscript = transcript;
            if (transcript && transcript.length > 10000) {
                // For very large transcripts, truncate to a reasonable size
                processedTranscript = transcript.substring(0, 10000) + 
                    "\n[Transcript truncated to prevent token overflow]";
                
                if (this.settings.debugLogging) {
                    llmLogger.debug(`[addTimestampLinksSinglePass] Truncated transcript from ${transcript.length} to 10000 characters`);
                }
            }
            
            // Debug the timestamp config being passed
            const timestampModel = this.getModelForProvider(this.settings.selectedLLM);
            llmLogger.debug(`[TIMESTAMP DEBUG] Model: ${timestampModel}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] Temperature: ${timestampConfig.temperature}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] MaxTokens: ${maxTokens}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] SystemPrompt length: ${timestampConfig.systemPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] UserPrompt length: ${timestampConfig.userPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] SelectedLLM: ${this.settings.selectedLLM}`);
            
            // Create specialized summarizer for timestamp linking
            const timestampLinkSummarizer = new TranscriptSummarizer({
                model: timestampModel,
                temperature: timestampConfig.temperature,
                maxTokens: maxTokens,
                systemPrompt: timestampConfig.systemPrompt,
                userPrompt: timestampConfig.userPrompt
            }, this.settings.apiKeys);
            
            // Add debug logging
            if (this.settings.debugLogging) {
                const maxTokens = this.getMaxTokensForTimestampPass();
                llmLogger.debug(`[addTimestampLinksSinglePass] Using ${maxTokens} tokens for timestamp linking`);
            }
            
            // Restructure the prompt with clear section labels for all providers
            const restructuredPrompt = 
                "INSTRUCTIONS:\n" + timestampConfig.userPrompt + "\n\n" +
                "INSTRUCTION INPUT DATA - TIMESTAMPS TRANSCRIPT:\n" + 
                (processedTranscript ? processedTranscript : "No transcript available") + "\n\n" +
                "INPUT NOTE TO BE MODIFIED WITH TIMESTAMPS:\n" + contentWithoutFrontmatter;
            
            // Send to LLM for processing
            this.showNotice("Adding timestamp links with LLM...", 5000);
            
            // Log detailed information when debug logging is enabled
            if (this.settings.debugLogging) {
                llmLogger.debug("==================== TIMESTAMP LINKING DEBUG ====================");
                llmLogger.debug(`Processing file: ${filePath}`);
                llmLogger.debug(`Video ID: ${videoId}`);
                llmLogger.debug(`System Prompt: ${timestampConfig.systemPrompt}`);
                llmLogger.debug(`User Prompt (first 500 chars): ${timestampConfig.userPrompt.substring(0, 500)}...`);
                llmLogger.debug(`Restructured Prompt (first 500 chars): ${restructuredPrompt.substring(0, 500)}...`);
                
                // Check if transcript contains TimeIndex markers
                if (processedTranscript) {
                    const timeIndexInTranscript = processedTranscript.match(/\[TimeIndex:\d+\]/g);
                    if (timeIndexInTranscript) {
                        llmLogger.debug(`✅ Transcript contains ${timeIndexInTranscript.length} TimeIndex markers`);
                        llmLogger.debug(`First few TimeIndex markers: ${timeIndexInTranscript.slice(0, 5).join(', ')}`);
                    } else {
                        llmLogger.debug("❌ No TimeIndex markers found in transcript");
                    }
                } else {
                    llmLogger.debug("❌ No transcript provided to LLM");
                }
                llmLogger.debug(`Number of headings found: ${headings.length}`);
                llmLogger.debug(`First few headings: ${headings.slice(0, 3).join(', ')}${headings.length > 3 ? '...' : ''}`);
                llmLogger.debug(`LLM Provider: ${this.settings.selectedLLM}`);
                llmLogger.debug(`Model: ${this.settings.selectedModels[this.settings.selectedLLM]}`);
                llmLogger.debug(`Max tokens: ${maxTokens}`);
                llmLogger.debug(`Temperature: ${timestampConfig.temperature}`);
                
                // Estimate tokens for log
                const contentTokens = Math.ceil(contentWithoutFrontmatter.length / 4);
                const transcriptTokens = Math.ceil((processedTranscript?.length || 0) / 4);
                llmLogger.debug(`Estimated content tokens: ${contentTokens}`);
                llmLogger.debug(`Estimated transcript tokens: ${transcriptTokens}`);
                llmLogger.debug(`Estimated total input tokens: ${contentTokens + transcriptTokens}`);
                
                // Log the system prompt
                llmLogger.debug("SYSTEM PROMPT:");
                llmLogger.debug("----------------------------------------");
                llmLogger.debug(truncateForLogs(timestampConfig.systemPrompt, 200));
                llmLogger.debug("----------------------------------------");
                
                // Log the user prompt
                llmLogger.debug("USER PROMPT:");
                llmLogger.debug("----------------------------------------");
                llmLogger.debug(truncateForLogs(timestampConfig.userPrompt, 200));
                llmLogger.debug("----------------------------------------");
                
                // Log content being processed
                llmLogger.debug("CONTENT BEING PROCESSED:");
                llmLogger.debug("----------------------------------------");
                llmLogger.debug(truncateForLogs(contentWithoutFrontmatter, 500));
                llmLogger.debug("----------------------------------------");
                
                // Log transcript excerpt
                if (processedTranscript) {
                    llmLogger.debug("TRANSCRIPT EXCERPT:");
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(truncateForLogs(processedTranscript, 300));
                    llmLogger.debug("----------------------------------------");
                } else {
                    llmLogger.debug("NO TRANSCRIPT FOUND IN FRONTMATTER");
                }
                
                // Log the complete formatted prompt
                llmLogger.debug("COMPLETE FORMATTED PROMPT BEING SENT TO LLM:");
                llmLogger.debug("========================================");
                llmLogger.debug(truncateForLogs(restructuredPrompt, 400));
                llmLogger.debug("========================================");
            }
            
            logger.debug("[addTimestampLinksSinglePass] Sending content to LLM (without frontmatter)...");
            
            let enhancedContent;
            try {
                llmLogger.debug(`[TIMESTAMP DEBUG] About to call summarize with provider: '${this.settings.selectedLLM}'`);
                llmLogger.debug(`[TIMESTAMP DEBUG] Full settings.selectedLLM value:`, this.settings.selectedLLM);
                enhancedContent = await timestampLinkSummarizer.summarize(
                    restructuredPrompt, 
                    this.settings.selectedLLM
                );
                
                // Debug log the entire response if debug logging is enabled
                if (this.settings.debugLogging) {
                    llmLogger.debug("LLM RESPONSE:");
                    llmLogger.debug("========================================");
                    llmLogger.debug(truncateForLogs(enhancedContent || "Empty response from LLM", 400));
                    llmLogger.debug("========================================");
                    
                    // Check for TimeIndex markers in the response
                    const timeIndexMatches = enhancedContent ? enhancedContent.match(/\[TimeIndex:\d+\]/g) : null;
                    if (timeIndexMatches) {
                        llmLogger.debug(`✅ Found ${timeIndexMatches.length} TimeIndex markers: ${timeIndexMatches.join(', ')}`);
                    } else {
                        llmLogger.debug("❌ No TimeIndex markers found in LLM response");
                    }
                    
                    // Check for Watch URLs in the response (shouldn't be there with new prompt)
                    const watchMatches = enhancedContent ? enhancedContent.match(/\[Watch\]\(https:\/\/www\.youtube\.com\/watch\?v=[^)]+\)/g) : null;
                    if (watchMatches) {
                        llmLogger.debug(`⚠️ Found ${watchMatches.length} Watch URLs (old format): ${watchMatches.slice(0, 3).join(', ')}`);
                    }
                }
                
                logger.debug("[addTimestampLinksSinglePass] Received LLM response, length:", enhancedContent ? enhancedContent.length : 0);
            } catch (e) {
                logger.error("[addTimestampLinksSinglePass] Error during LLM call:", e);
                const errorMessage = getSafeErrorMessage(e);
                
                // In case of token limit errors, reduce the maxTokens and try again
                if (errorMessage.includes("max_tokens") || errorMessage.includes("token limit")) {
                    logger.debug("[addTimestampLinksSinglePass] Token limit error detected, retrying with reduced token limit");
                    this.showNotice("Retrying with reduced token limit...", 5000);
                    
                    // Significantly reduce token limit for retry (50% of previous)
                    const reducedTokens = Math.floor(maxTokens * 0.5);
                    
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`Retrying with reduced token limit: ${reducedTokens}`);
                    }
                    
                    // Create a new summarizer with reduced tokens but same config otherwise
                    const reducedTokensSummarizer = new TranscriptSummarizer({
                        model: this.getModelForProvider(this.settings.selectedLLM),
                        temperature: timestampConfig.temperature,
                        maxTokens: reducedTokens,
                        systemPrompt: timestampConfig.systemPrompt,
                        userPrompt: timestampConfig.userPrompt
                    }, this.settings.apiKeys);
                    
                    try {
                        enhancedContent = await reducedTokensSummarizer.summarize(
                            restructuredPrompt, 
                            this.settings.selectedLLM
                        );
                        
                        // Debug log the entire response after retry if debug logging is enabled
                        if (this.settings.debugLogging) {
                            llmLogger.debug("LLM RESPONSE AFTER RETRY:");
                            llmLogger.debug("========================================");
                            llmLogger.debug(truncateForLogs(enhancedContent || "Empty response from LLM", 800));
                            llmLogger.debug("========================================");
                        }
                        
                        logger.debug("[addTimestampLinksSinglePass] Second attempt successful with reduced tokens:", reducedTokens);
                    } catch (retryError) {
                        logger.error("[addTimestampLinksSinglePass] Error on second attempt:", retryError);
                        const retryMessage = getSafeErrorMessage(retryError);
                        this.showNotice(`Failed to add timestamp links: ${retryMessage}`, 5000);
                        return null;
                    }
                } else {
                    this.showNotice(`Error adding timestamp links: ${errorMessage}`, 5000);
                    return null;
                }
            }
            
            if (!enhancedContent) {
                logger.error("[addTimestampLinksSinglePass] Failed to add timestamp links (empty response from LLM)");
                this.showNotice("Failed to add timestamp links (empty response from LLM)", 5000);
                return null;
            }
            
            // First validate that we received TimeIndex markers from the LLM
            if (!enhancedContent.includes('[TimeIndex:')) {
                logger.error("[addTimestampLinksSinglePass] No TimeIndex markers found in LLM response");
                this.showNotice("LLM did not add TimeIndex markers to headings", 5000);
                return null;
            }
            
            // Reconstruct the document with original frontmatter and enhanced content
            let enhancedNote = reconstructDocument(frontmatter, enhancedContent);
            
            // Convert TimeIndex markers to Watch URLs ONLY in content, preserving frontmatter transcript
            const { frontmatter: extractedFrontmatter, contentWithoutFrontmatter: extractedContent } = extractDocumentComponents(enhancedNote);
            const convertedContent = convertTimeIndexToWatchUrls(extractedContent, videoId);
            enhancedNote = reconstructDocument(extractedFrontmatter, convertedContent);
            
            // Validate the final enhanced note with Watch URLs
            if (validateEnhancedContent(enhancedNote, contentWithoutFrontmatter, headings, videoId)) {
                // Update the note file with the LLM-enhanced content
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    await this.app.vault.modify(file, enhancedNote);
                } else {
                    logger.error(`[addTimestampLinksSinglePass] File not found: ${filePath}`);
                    this.showNotice(`Error: File not found: ${filePath}`, 5000);
                    return null;
                }
                
                // Count number of section headings with links (use final converted note)
                const linkCount = countTimestampLinks(enhancedNote);
                this.showNotice(`Added timestamp links to ${linkCount} section headings`, 5000);
                
                // Log the final output if debug logging is enabled
                if (this.settings.debugLogging) {
                    llmLogger.debug("TIMESTAMP LINKING SUCCESSFUL");
                    llmLogger.debug(`Added ${linkCount} timestamp links`);
                    llmLogger.debug("========================================");
                }
                
                // Return the enhanced content for potential translation
                return enhancedContent;
            }
            
            // Log validation failure if debug logging is enabled
            if (this.settings.debugLogging) {
                llmLogger.debug("TIMESTAMP LINKING VALIDATION FAILED");
                llmLogger.debug("Validation of enhanced content against original content failed");
                llmLogger.debug("========================================");
            }
            
            return null;
        } catch (error) {
            logger.error("[addTimestampLinksSinglePass] Error:", error);
            const errorMessage = getSafeErrorMessage(error);
            this.showNotice(`Error adding timestamp links: ${errorMessage}`, 5000);
            return null;
        }
    }
    
    // New method to translate content
    private async translateContent(
        filePath: string,
        contentToTranslate: string,
        targetLang: string,
        targetCountry: string
    ): Promise<void> {
        try {
            this.showNotice(`Translating content to ${targetLang.toUpperCase()}-${targetCountry}...`, 5000);
            logger.debug("[translateContent] Starting translation process");
            
            // Extract document components using the utility
            const noteFile = this.app.vault.getAbstractFileByPath(filePath);
            if (!(noteFile instanceof TFile)) {
                logger.error(`[translateContent] File not found: ${filePath}`);
                this.showNotice(`Error: File not found: ${filePath}`, 5000);
                return;
            }
            const fileContent = await this.app.vault.read(noteFile);
            const { frontmatter } = extractDocumentComponents(fileContent);
            
            // Create a specialized summarizer for translation
            const translationSummarizer = new TranscriptSummarizer({
                model: this.getModelForProvider(this.settings.selectedLLM),
                temperature: 0.3, // Lower temperature for more accurate translations
                maxTokens: this.getMaxTokensForTimestampPass(),
                systemPrompt: "You are a highly accurate translator who preserves all formatting, links, and structure when translating content.",
                userPrompt: "Translate the following content while preserving all Markdown formatting, links, and structure:"
            }, this.settings.apiKeys);
            
            // Create the translation prompt
            const translationPrompt = `
TRANSLATION TASK: Translate the following content into ${targetLang.toUpperCase()}-${targetCountry}.

RULES:
1. Preserve all Markdown formatting, especially section headings with # syntax
2. Keep all links intact, especially YouTube timestamp [Watch] links
3. Maintain the same overall structure and organization
4. Translate everything else, including headings, paragraphs, and lists
5. Keep technical terms, proper names, and specific terminology in their original form when appropriate
6. Ensure the translation sounds natural in the target language

CONTENT TO TRANSLATE:

${contentToTranslate}
`;
            
            // Send to LLM for translation
            let translatedContent;
            try {
                translatedContent = await translationSummarizer.summarize(translationPrompt, this.settings.selectedLLM);
                logger.debug("[translateContent] Received translated content, length:", translatedContent ? translatedContent.length : 0);
            } catch (e) {
                logger.error("[translateContent] Error during translation:", e);
                const errorMessage = getSafeErrorMessage(e);
                this.showNotice(`Translation error: ${errorMessage}`, 5000);
                return;
            }
            
            if (!translatedContent) {
                logger.error("[translateContent] Failed to translate content (empty response)");
                this.showNotice("Failed to translate content (empty response from LLM)", 5000);
                return;
            }
            
            // Reconstruct the document with original frontmatter and translated content
            const translatedNote = reconstructDocument(frontmatter, translatedContent);
            
            // Update the note file with the translated content
            await this.app.vault.modify(noteFile, translatedNote);
            this.showNotice(`Successfully translated content to ${targetLang.toUpperCase()}-${targetCountry}`, 5000);
            
        } catch (error) {
            logger.error("[translateContent] Error:", error);
            const errorMessage = getSafeErrorMessage(error);
            this.showNotice(`Error translating content: ${errorMessage}`, 5000);
        }
    }

    // Validate just the enhanced content without checking frontmatter
    private validateEnhancedContentOnly(enhancedContent: string, originalContent: string, headings: string[]): boolean {
        // This method has been replaced by the validateEnhancedContent utility
        return validateEnhancedContent(enhancedContent, originalContent, headings, "");
    }

    // Process document in chunks based on section headings
    private async addTimestampLinksInChunks(
        filePath: string, 
        videoId: string, 
        originalContent: string, 
        headings: string[],
        headingPositions: number[]
    ): Promise<string | null> {
        try {
            logger.debug("[addTimestampLinksInChunks] Processing document in chunks");
            
            // Extract document components using the utility
            const { frontmatter, contentWithoutFrontmatter, transcript } = 
                extractDocumentComponents(originalContent);
            
            // Log debug info about chunking if enabled
            if (this.settings.debugLogging) {
                llmLogger.debug("==================== CHUNKED TIMESTAMP LINKING DEBUG ====================");
                llmLogger.debug(`Processing file: ${filePath} in chunks`);
                llmLogger.debug(`Video ID: ${videoId}`);
                llmLogger.debug(`Number of headings found: ${headings.length}`);
                llmLogger.debug(`Original content length: ${contentWithoutFrontmatter.length} characters`);
                llmLogger.debug(`Transcript length: ${transcript ? transcript.length : 0} characters`);
            }
            
            // Create optimized chunks based on heading positions
            const maxTokenLimit = this.getMaxTokensForTimestampPass();
            const chunks = createOptimizedChunks(contentWithoutFrontmatter, maxTokenLimit);
            
            if (this.settings.debugLogging) {
                llmLogger.debug(`Split content into ${chunks.length} optimized chunks`);
                llmLogger.debug(`Chunk sizes: ${chunks.map(c => c.length).join(', ')} characters`);
            }
            
            logger.debug(`[addTimestampLinksInChunks] Split content into ${chunks.length} optimized chunks`);
            
            // Process each chunk separately
            let processedChunks: string[] = [];
            
            // We're still in the second LLM pass, just breaking it into smaller chunks
            // The first LLM pass already created the note content, now we're adding timestamp links
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                
                // Skip chunks without proper heading (including template header)
                if (!hasProperHeading(chunk)) {
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`Chunk ${i+1}: No proper headings found, preserving unchanged`);
                    }
                    
                    logger.debug(`[addTimestampLinksInChunks] Preserving non-section chunk ${i+1} unchanged`);
                    // Ensure chunk ends with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                    continue;
                }
                
                if (this.settings.debugLogging) {
                    llmLogger.debug(`\n===== PROCESSING CHUNK ${i+1} of ${chunks.length} =====`);
                    llmLogger.debug(`Chunk size: ${chunk.length} characters`);
                    
                    // Extract and show headings in this chunk
                    const chunkHeadings: string[] = [];
                    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
                    let match;
                    while ((match = headingRegex.exec(chunk)) !== null) {
                        chunkHeadings.push(match[2].trim());
                    }
                    
                    llmLogger.debug(`Headings in chunk ${i+1}: ${chunkHeadings.join(', ')}`);
                }
                
                logger.debug(`[addTimestampLinksInChunks] Processing chunk ${i+1} of ${chunks.length}, length: ${chunk.length}`);
                this.showNotice(`Processing section ${i+1} of ${chunks.length}...`, 2000);
                
                // Get timestamp link configuration
                const timestampConfig = getTimestampLinkConfig(this.settings, videoId, this.getEffectiveMaxTokens());
                
                // Construct reference section with clear instructions not to include in output
                // Reduce transcript size on mobile to prevent token overflow
                let transcriptContent = "";
                if (Platform.isMobile && transcript.length > 5000) {
                    // On mobile with large transcripts, keep only a portion to save tokens
                    transcriptContent = transcript.substring(0, 5000) + "\n[Transcript truncated for mobile processing]";
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`Truncated transcript on mobile from ${transcript.length} to 5000 characters`);
                    }
                } else {
                    transcriptContent = transcript.length > 0 ? 
                        transcript : 
                        "No transcript available, use default timestamps starting at 0 seconds.";
                }
                
                // Restructure the prompt with clear section labels for all providers
                const restructuredPrompt = 
                    "INSTRUCTIONS:\n" + timestampConfig.userPrompt + "\n\n" +
                    "INSTRUCTION INPUT DATA - TIMESTAMPS TRANSCRIPT:\n" + transcriptContent + "\n\n" +
                    "INPUT NOTE TO BE MODIFIED WITH TIMESTAMPS:\n" + chunk;
                
                if (this.settings.debugLogging) {
                    llmLogger.debug(`CHUNK ${i+1} PROMPT:`);
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(truncateForLogs(timestampConfig.userPrompt, 400));
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(`CHUNK ${i+1} CONTENT:`);
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(truncateForLogs(chunk, 400));
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(`CHUNK ${i+1} COMPLETE FORMATTED PROMPT:`);
                    llmLogger.debug("========================================");
                    llmLogger.debug(truncateForLogs(restructuredPrompt, 400));
                    llmLogger.debug("========================================");
                }
                
                try {
                    // Get tokens from our simplified method
                    const maxTokens = this.getMaxTokensForTimestampPass();
                    
                    // For debugging, log content and transcript info
                    if (this.settings.debugLogging) {
                        // Estimate token counts for logs only
                        const contentLength = chunk.length;
                        const transcriptLength = transcriptContent.length;
                        const estimatedContentTokens = Math.ceil(contentLength / 4);
                        const estimatedTranscriptTokens = Math.ceil(transcriptLength / 4);
                        
                        llmLogger.debug(`[addTimestampLinksInChunks] Content length: ${contentLength} chars (est. ${estimatedContentTokens} tokens)`);
                        llmLogger.debug(`[addTimestampLinksInChunks] Transcript length: ${transcriptLength} chars (est. ${estimatedTranscriptTokens} tokens)`);
                        llmLogger.debug(`[addTimestampLinksInChunks] Using max tokens: ${maxTokens}`);
                    }
                    
                    logger.debug(`[addTimestampLinksInChunks] Using ${maxTokens} tokens for chunk ${i+1}`);
                    
                    // Safety check - if tokens are invalid, skip processing this chunk
                    if (maxTokens <= 0) {
                        logger.warn(`[addTimestampLinksInChunks] Invalid token value for chunk ${i+1}, skipping processing`);
                        processedChunks.push(ensureTrailingNewline(chunk));
                        continue;
                    }
                    
                    const chunkSummarizer = new TranscriptSummarizer({
                        model: this.getModelForProvider(this.settings.selectedLLM),
                        temperature: timestampConfig.temperature,
                        maxTokens: maxTokens,
                        systemPrompt: timestampConfig.systemPrompt,
                        userPrompt: timestampConfig.userPrompt // Use the base prompt, not the complete chunk prompt
                    }, this.settings.apiKeys);
                    
                    // Process the chunk
                    const processedChunk = await chunkSummarizer.summarize(
                        restructuredPrompt, 
                        this.settings.selectedLLM
                    );
                    
                    // Log LLM response for this chunk if debug is enabled
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`CHUNK ${i+1} LLM RESPONSE:`);
                        llmLogger.debug("========================================");
                        llmLogger.debug(truncateForLogs(processedChunk || "Empty response from LLM", 400));
                        llmLogger.debug("========================================");
                    }
                    
                    if (processedChunk) {
                        // Validate processed chunk has timestamp link
                        const hasLink = hasTimestampLinks(processedChunk, videoId);
                        
                        // Log link validation result if debug is enabled
                        if (this.settings.debugLogging) {
                            llmLogger.debug(`CHUNK ${i+1} has timestamp links: ${hasLink}`);
                            
                            if (hasLink) {
                                const linkCount = countTimestampLinks(processedChunk);
                                llmLogger.debug(`CHUNK ${i+1} contains ${linkCount} timestamp links`);
                            }
                        }
                        
                        // Ensure chunk ends with a newline to prevent wrapping
                        let finalChunk = ensureTrailingNewline(processedChunk);
                        
                        if (hasLink) {
                            processedChunks.push(finalChunk);
                        } else {
                            logger.warn("[addTimestampLinksInChunks] No timestamp link added to chunk", i+1);
                            // Push original chunk with newline
                            processedChunks.push(ensureTrailingNewline(chunk));
                        }
                    } else {
                        logger.warn("[addTimestampLinksInChunks] Empty response for chunk", i+1);
                        // Push original chunk with newline
                        processedChunks.push(ensureTrailingNewline(chunk));
                    }
                } catch (e) {
                    logger.error(`[addTimestampLinksInChunks] Error processing chunk ${i+1}:`, e);
                    
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`ERROR PROCESSING CHUNK ${i+1}:`);
                        llmLogger.debug(getSafeErrorMessage(e));
                        llmLogger.debug(`Using original chunk content instead`);
                    }
                    
                    // Push original chunk with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                }
            }
            
            // Reconstruct document: frontmatter + processed content
            const combinedContent = processedChunks.join("");
            let combinedNote = reconstructDocument(frontmatter, combinedContent);
            
            // Convert TimeIndex markers to Watch URLs ONLY in content, preserving frontmatter transcript
            const { frontmatter: extractedFrontmatter, contentWithoutFrontmatter: extractedContent } = extractDocumentComponents(combinedNote);
            const convertedContent = convertTimeIndexToWatchUrls(extractedContent, videoId);
            combinedNote = reconstructDocument(extractedFrontmatter, convertedContent);
            
            // Verify we have some timestamp links (count from the converted note)
            const linkCount = countTimestampLinks(combinedNote);
            
            if (this.settings.debugLogging) {
                llmLogger.debug("CHUNKED PROCESSING COMPLETE");
                llmLogger.debug(`Total timestamp links found: ${linkCount}`);
                
                if (linkCount > 0) {
                    llmLogger.debug("CHUNKED PROCESSING SUCCESSFUL");
                } else {
                    llmLogger.debug("CHUNKED PROCESSING FAILED - No timestamp links added");
                }
                
                llmLogger.debug("========================================");
            }
            
            if (linkCount > 0) {
                // Update the note file with the combined content
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    await this.app.vault.modify(file, combinedNote);
                } else {
                    logger.error(`[addTimestampLinksInChunks] File not found: ${filePath}`);
                    this.showNotice(`Error: File not found: ${filePath}`, 5000);
                    return null;
                }
                
                this.showNotice(`Added ${linkCount} timestamp links using chunked processing`, 5000);
                
                // Return the combined content for potential translation
                return combinedContent;
            } else {
                logger.error("[addTimestampLinksInChunks] No timestamp links were added in any chunk");
                this.showNotice("Failed to add any timestamp links", 5000);
                return null;
            }
        } catch (error) {
            logger.error("[addTimestampLinksInChunks] Error:", error);
            const errorMessage = getSafeErrorMessage(error);
            this.showNotice(`Error in chunked processing: ${errorMessage}`, 5000);
            return null;
        }
    }

    // Validate the enhanced note meets all quality checks
    private validateEnhancedNote(enhancedNote: string, originalContent: string, headings: string[]): boolean {
        // This method has been replaced by the validateEnhancedContent utility
        return validateEnhancedContent(enhancedNote, originalContent, headings, "");
    }

    // Method to get appropriate max tokens for the timestamp linking pass based on the model
    private getMaxTokensForTimestampPass(): number {
        // Get the user's configured maxTokens setting
        const configuredMaxTokens = this.settings.maxTokens;
        
        // Get the selected LLM provider and model
        const selectedProvider = this.settings.selectedLLM as Provider;
        const selectedModel = this.settings.selectedModels[selectedProvider] || 'gpt-4o'; // fallback to gpt-4o if not set
        
        try {
            // Use effective max tokens calculation (same as main summarization, respects custom model params)
            const effectiveMaxTokens = this.getEffectiveMaxTokens();
            
            // Apply 85% multiplier for timestamp linking (conservative approach)
            let tokensToUse = Math.floor(effectiveMaxTokens * 0.85);
            
            if (this.settings.debugLogging) {
                logger.debug(`[getMaxTokensForTimestampPass] Using ${tokensToUse} tokens (85% of effective limit ${effectiveMaxTokens}, configured: ${configuredMaxTokens}, model: ${selectedProvider}:${selectedModel}, platform: ${Platform.isMobile ? 'mobile' : 'desktop'})`);
            }
            
            return tokensToUse;
            
        } catch (error) {
            // Fallback to legacy calculation if dynamic calculation fails
            if (this.settings.debugLogging) {
                logger.debug(`[getMaxTokensForTimestampPass] Dynamic calculation failed, using legacy fallback: ${error}`);
            }
            
            // Legacy hard limits for fallback
            const LEGACY_LIMITS: Record<string, number> = {
                'openai': 4096,
                'anthropic': 4096,
                'google': 8192,
                'ollama': 4096,
                'default': 4096
            };
            
            const providerHardLimit = LEGACY_LIMITS[selectedProvider] || LEGACY_LIMITS.default;
            let tokensToUse = Math.floor(configuredMaxTokens * 0.85);
            tokensToUse = Math.min(tokensToUse, providerHardLimit - 100);
            
            return tokensToUse;
        }
    }

    private sanitizePathComponent(text: string): string {
        // Use the utility function instead of duplicating code
        return sanitizePathComponent(text);
    }

    /**
     * Get the effective maxTokens for the current provider and model
     * Uses registry values for known models, custom model limits for user-defined models, 
     * or falls back to current setting
     */
    public getEffectiveMaxTokens(): number {
        const provider = this.settings.selectedLLM as Provider;
        const model = this.settings.selectedModels[provider];
        
        try {
            // Check if this is a known model in our registry
            if (isModelSupported(provider, model)) {
                const limits = getEffectiveLimits(provider, model);
                return limits.maxOutputEff;
            } else {
                // Check if user has defined custom limits for this model
                const customKey = `${provider}:${model}`;
                const customLimits = this.settings.customModelLimits[customKey];
                
                if (customLimits) {
                    // Calculate effective limits for custom model
                    const defaultReserve = provider === 'ollama' ? 0.15 : 0.10;
                    const reserve = customLimits.reservePct ?? defaultReserve;
                    const maxOutput = customLimits.maxOutputK * 1000; // Convert K to actual tokens
                    return Math.floor(maxOutput * (1 - reserve));
                } else {
                    // No custom limits defined - use current user setting
                    return this.settings.maxTokens;
                }
            }
        } catch {
            // Fallback to current setting if anything goes wrong
            return this.settings.maxTokens;
        }
    }

    /**
     * Register a custom model with the dynamic registry
     */
    public registerCustomModel(provider: Provider, modelId: string, limits: {
        contextK: number;
        maxOutputK: number;
        inputMaxK?: number;
        reservePct?: number;
    }): void {
        // Convert K values to actual tokens and register with the dynamic registry
        upsertModel(provider, modelId, {
            context: limits.contextK * 1000,
            maxOutput: limits.maxOutputK * 1000,
            inputMax: limits.inputMaxK ? limits.inputMaxK * 1000 : undefined,
            reserveOutputPct: limits.reservePct ?? (provider === 'ollama' ? 0.15 : 0.10)
        });
    }

    async fetchOpenAIModels(apiKey: string): Promise<string[]> {
        if (!apiKey || apiKey.trim() === "") {
            this.showNotice("OpenAI API key is missing. Cannot fetch models.", 5000);
            logger.warn("[fetchOpenAIModels] OpenAI API key is missing.");
            return []; // Return empty array or a default list
        }

        const url = "https://api.openai.com/v1/models";
        try {
            this.showNotice("Fetching OpenAI models...", 3000);
            const response = await obsidianFetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText })) as ApiErrorResponse;
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchOpenAIModels] Failed to fetch OpenAI models: ${errorMessage}`);
                this.showNotice(`Failed to fetch OpenAI models: ${errorMessage}`, 5000);
                return []; // Or a default list
            }

            const data = await response.json() as OpenAIModelsResponse;
            if (data && Array.isArray(data.data)) {
                const modelIds = data.data
                    .map((model: OpenAIModel) => model.id)
                    .filter((id: string) => 
                        id.includes('gpt') || 
                        id.includes('text-davinci') // Include some older models if user wants
                        // Add other filters if needed, e.g., based on capabilities
                    )
                    .sort(); // Sort them alphabetically
                
                logger.info(`[fetchOpenAIModels] Successfully fetched ${modelIds.length} OpenAI models.`);
                this.showNotice("OpenAI models updated!", 3000);
                return modelIds;
            } else {
                logger.warn("[fetchOpenAIModels] Unexpected response structure from OpenAI API.");
                this.showNotice("Could not parse OpenAI models from API response.", 5000);
                return [];
            }
        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            logger.error("[fetchOpenAIModels] Error fetching or parsing OpenAI models:", errorMessage);
            this.showNotice(`Error fetching OpenAI models: ${errorMessage}`, 5000);
            return []; // Or a default list
        }
    }

    async fetchGoogleModels(apiKey: string): Promise<string[]> {
        if (!apiKey || apiKey.trim() === "") {
            this.showNotice("Google API key is missing. Cannot fetch models.", 5000);
            logger.warn("[fetchGoogleModels] Google API key is missing.");
            return [];
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        try {
            this.showNotice("Fetching Google models...", 3000);
            const response = await obsidianFetch(url, { method: 'GET' });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText })) as ApiErrorResponse;
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchGoogleModels] Failed to fetch Google models: ${errorMessage}`);
                this.showNotice(`Failed to fetch Google models: ${errorMessage}`, 5000);
                return [];
            }

            const data = await response.json() as GoogleModelsResponse;
            if (data && Array.isArray(data.models)) {
                const modelIds = data.models
                    .filter((model: GoogleModel) => 
                        model.name && 
                        !model.name.includes('embed') && 
                        model.supportedGenerationMethods?.includes('generateContent')
                    )
                    .map((model: GoogleModel) => model.name.startsWith('models/') ? model.name.substring('models/'.length) : model.name) // Strip "models/" prefix
                    .sort();
                
                logger.info(`[fetchGoogleModels] Successfully fetched ${modelIds.length} Google models (names stripped).`);
                this.showNotice("Google models updated!", 3000);
                return modelIds;
            } else {
                logger.warn("[fetchGoogleModels] Unexpected response structure from Google API.");
                this.showNotice("Could not parse Google models from API response.", 5000);
                return [];
            }
        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            logger.error("[fetchGoogleModels] Error fetching or parsing Google models:", errorMessage);
            this.showNotice(`Error fetching Google models: ${errorMessage}`, 5000);
            return [];
        }
    }
}

class YouTubeTranscriptModal extends Modal {
    plugin: YouTubeTranscriptPlugin;
    private titleInputEl: HTMLInputElement;
    private urlInputEl: HTMLInputElement;
    private errorEl: HTMLElement;
    private isProcessing: boolean = false;
    private selectedFolder: string = '';
    private fastSummaryToggleEl: HTMLInputElement;
    
    constructor(app: App, plugin: YouTubeTranscriptPlugin) {
        super(app);
        this.plugin = plugin;
    }
    
    // Create a wrapper for Notice that uses the shared utility
    showNotice(message: string, timeout: number = 5000): void {
        showNotice(message, timeout);
    }
    
    // Use imported utility method
    private isYoutubeUrl(this: void, url: string): boolean {
        return isYoutubeUrl(url);
    }
    
    // Use imported utility method
    private isYoutubeChannelOrPlaylistUrl(this: void, url: string): boolean {
        return isYoutubeChannelOrPlaylistUrl(url);
    }
    
    // Use imported utility method
    private extractChannelName(url: string): string {
        return extractChannelName(url);
    }
    
    // Helper method to show error message
    private showError(message: string): void {
        if (this.errorEl) {
            displayValidationResult(
                { isValid: false, message: message },
                { element: this.errorEl }
            );
        }
    }
    
    // Helper method to hide error message
    private hideError(): void {
        if (this.errorEl) {
            // Use class toggling for consistency with displayValidationResult
            this.errorEl.addClass('tubesage-error-hidden');
            this.errorEl.removeClass('tubesage-error-visible');
        }
    }
    
    onOpen() {
        // Initialize
        this.showNotice('Youtube transcript extractor ready', 3000);
        
        // Clear content and create container
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: 'Tubesage: create note from YouTube transcript' });
        
        // Build the input stage UI
        this.buildInputStage();
    }
    
    private buildInputStage() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: 'Tubesage: create note from YouTube transcript' });
        
        // Check if we're on mobile
        const isMobile = Platform.isMobile;
        
        // Create the form container - revert to original appearance
        const formEl = contentEl.createEl('div', { cls: 'tubesage-transcript-form' });
        
        // URL input group - first input
        const urlGroup = formEl.createEl('div', { cls: 'form-group' });
        urlGroup.createEl('label', { text: 'YouTube URL', attr: { for: 'url' } });
        this.urlInputEl = urlGroup.createEl('input', { 
            type: 'text',
            attr: { id: 'url', placeholder: 'https://www.youtube.com/watch?v=...' } 
        });
        
        // Create a URL validation message element
        const urlValidationEl = urlGroup.createEl('div', { 
            cls: ['validation-message', 'tubesage-validation-hidden']
        });
        
        // Add channel selection container (initially hidden)
        const channelOptionsContainer = formEl.createEl('div', { 
            cls: ['channel-options', 'tubesage-display-none']
        });
        
        // Add channel message
        channelOptionsContainer.createEl('div', { 
            text: 'How many videos would you like to process? Max hard limit is 50.',
            cls: 'channel-message'
        });
        
        // Create a container for controls with different layout based on device
        const controlsContainer = channelOptionsContainer.createEl('div', {
            cls: ['tubesage-modal-controls-container', isMobile ? 'tubesage-modal-controls-container-mobile' : 'tubesage-modal-controls-container-desktop'],
            attr: { style: 'display:flex; flex-direction:row; align-items:center; gap:15px; flex-wrap:nowrap; width:100%;' }
        });
        
        // Radio button for "All Videos"
        const allVideosContainer = controlsContainer.createEl('div', {
            cls: ['tubesage-modal-radio-option', isMobile ? 'tubesage-modal-radio-option-mobile' : '' ],
            attr: { style: isMobile ? 'display:flex; align-items:center; white-space:nowrap; justify-content:flex-start;' : 'display:flex; align-items:center; white-space:nowrap;' }
        });
        
        // Create label first
        allVideosContainer.createEl('label', {
            text: 'All videos',
            cls: 'tubesage-modal-radio-label',
            attr: { for: 'all-videos-radio' }
        });
        
        // Then add the radio button
        const allVideosRadio = allVideosContainer.createEl('input', {
            type: 'radio',
            attr: { 
                id: 'all-videos-radio',
                name: 'video-count-option',
                checked: 'checked'
            }
        });
        
        // Create container for limited videos option (radio + dropdown together)
        const limitedOptionContainer = controlsContainer.createEl('div', {
            cls: ['tubesage-modal-limited-option-container', isMobile ? 'tubesage-modal-limited-option-container-mobile' : ''],
            attr: { style: isMobile ? 'display:flex; align-items:center; gap:10px; justify-content:flex-start; width:100%;' : 'display:flex; align-items:center; gap:10px;' }
        });
        
        // Radio button for "Limited Number"
        const limitedVideosContainer = limitedOptionContainer.createEl('div', {
            cls: 'tubesage-modal-radio-option',
            attr: { style: 'display:flex; align-items:center; white-space:nowrap;' }
        });
        
        // Create label first
        limitedVideosContainer.createEl('label', {
            text: 'Limited number:',
            cls: 'tubesage-modal-radio-label',
            attr: { for: 'limited-videos-radio' }
        });
        
        // Then add the radio button
        limitedVideosContainer.createEl('input', {
            type: 'radio',
            attr: { 
                id: 'limited-videos-radio',
                name: 'video-count-option'
            }
        });
        
        // Dropdown for selecting number of videos - add to the limitedOptionContainer
        const videoCountDropdown = limitedOptionContainer.createEl('select', {
            cls: 'video-count-dropdown',
            attr: {
                id: 'video-count-dropdown'
            }
        });
        
        // Add options 1-50
        for (let i = 1; i <= 50; i++) {
            videoCountDropdown.createEl('option', {
                text: i.toString(),
                attr: { value: i.toString() }
            });
        }
        
        // Set default to 1
        videoCountDropdown.value = '1';
        
        // Process button in its own container for mobile layout
        const processBtnContainer = controlsContainer.createEl('div', {
            cls: ['tubesage-modal-process-btn-container', isMobile ? 'tubesage-modal-process-btn-container-mobile' : ''],
            attr: { style: isMobile ? 'width:100%; display:flex; justify-content:flex-start; margin-top:5px;' : 'margin-left:auto;' }
        });
        
        const processBtn = processBtnContainer.createEl('button', {
            text: 'Process',
            cls: 'tubesage-process-btn', // Keep class for other appearance like padding, border-radius etc.
            // Inline appearance removed, background-color is in .tubesage-process-btn
            // Conditional width is handled by adding/not adding tubesage-process-btn-mobile
        });
        if (isMobile) {
            processBtn.addClass('tubesage-process-btn-mobile');
        }
        
        // Add event listener for process button
        processBtn.addEventListener('click', () => {
            const url = this.urlInputEl.value.trim();
            
            if (allVideosRadio.checked) {
                // Process all videos
                this.processCollectionVideos(url, 0);
            } else {
                // Process limited number of videos
                const count = parseInt(videoCountDropdown.value) || 10;
                this.processCollectionVideos(url, count);
            }
        });
        
        // Title input group - second input (for single video mode)
        const titleGroup = formEl.createEl('div', { cls: 'form-group' });
        titleGroup.createEl('label', { text: 'Custom note title (optional)', attr: { for: 'title' } });
        this.titleInputEl = titleGroup.createEl('input', { 
            type: 'text',
            attr: { id: 'title', placeholder: 'Leave empty to use YouTube title' } 
        });
        
        // Add toggle switch for summary mode
        const toggleContainer = formEl.createEl('div', { cls: 'toggle-container' });
        
        // Label for the toggle
        const toggleLabel = toggleContainer.createEl('div', { cls: 'toggle-label' });
        toggleLabel.createEl('div', { text: 'Fast summary mode' });
        toggleLabel.createEl('div', { 
            text: 'Enable for shorter, quicker summaries (skips timestamp links)', 
            cls: 'summary-info' 
        });
        
        // Create the toggle switch
        const toggleSwitch = toggleContainer.createEl('label', { cls: 'toggle-switch' });
        this.fastSummaryToggleEl = toggleSwitch.createEl('input', { 
            type: 'checkbox',
            attr: { id: 'fast-summary-toggle' }
        });
        // Set initial state from settings
        this.fastSummaryToggleEl.checked = this.plugin.settings.useFastSummary;
        
        // Add the toggle slider
        toggleSwitch.createEl('span', { cls: 'toggle-slider' });
        
        // Add change listener to save toggle state to settings
        this.fastSummaryToggleEl.addEventListener('change', () => {
            this.plugin.settings.useFastSummary = this.fastSummaryToggleEl.checked;
            void this.plugin.saveSettings();
        });
        
        // Error message container
        this.errorEl = formEl.createEl('div', { cls: ['tubesage-error', 'tubesage-error-hidden'] });
        
        // Add real-time validation on URL change
        this.urlInputEl.addEventListener('input', () => {
            const url = this.urlInputEl.value.trim();
            
            // First check if it's a valid URL
            if (url && !this.isYoutubeUrl(url)) {
                urlValidationEl.setText('Not a valid YouTube URL. Only video, playlist, and channel urls are supported.');
                urlValidationEl.removeClass('tubesage-validation-success', 'tubesage-validation-accent');
                urlValidationEl.addClass('tubesage-validation-error', 'tubesage-validation-visible');
                urlValidationEl.removeClass('tubesage-validation-hidden');
                return;
            }
            
            // Check if it's a channel URL
            if (url && this.isYoutubeChannelOrPlaylistUrl(url)) {
                urlValidationEl.setText('YouTube channel or playlist URL detected');
                urlValidationEl.removeClass('tubesage-validation-error', 'tubesage-validation-success');
                urlValidationEl.addClass('tubesage-validation-accent', 'tubesage-validation-visible');
                urlValidationEl.removeClass('tubesage-validation-hidden');
                
                // Show channel options, hide title input
                channelOptionsContainer.addClass('tubesage-display-block');
                channelOptionsContainer.removeClass('tubesage-display-none');
                titleGroup.addClass('tubesage-display-none');
                titleGroup.removeClass('tubesage-display-block');
            } else if (url) {
                urlValidationEl.setText('YouTube video URL detected');
                urlValidationEl.removeClass('tubesage-validation-error', 'tubesage-validation-accent');
                urlValidationEl.addClass('tubesage-validation-success', 'tubesage-validation-visible');
                urlValidationEl.removeClass('tubesage-validation-hidden');
                
                // Hide channel options, show title input
                channelOptionsContainer.addClass('tubesage-display-none');
                channelOptionsContainer.removeClass('tubesage-display-block');
                titleGroup.addClass('tubesage-display-block');
                titleGroup.removeClass('tubesage-display-none');
            } else {
                urlValidationEl.addClass('tubesage-validation-hidden');
                urlValidationEl.removeClass('tubesage-validation-visible');
                channelOptionsContainer.addClass('tubesage-display-none');
                channelOptionsContainer.removeClass('tubesage-display-block');
                titleGroup.addClass('tubesage-display-block');
                titleGroup.removeClass('tubesage-display-none');
            }
        });
        
        // Add event listeners for Enter key
        this.urlInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const url = this.urlInputEl.value.trim();
                
                if (url && this.isYoutubeUrl(url)) {
                    if (this.isYoutubeChannelOrPlaylistUrl(url)) {
                        // If it's a channel or playlist URL, show channel options and hide the title input
                        channelOptionsContainer.addClass('tubesage-display-block');
                        channelOptionsContainer.removeClass('tubesage-display-none');
                        titleGroup.addClass('tubesage-display-none');
                        titleGroup.removeClass('tubesage-display-block');
                    } else if (!titleGroup.hasClass('tubesage-display-none')) {
                        // Only focus title if it's visible (single video mode)
                        this.titleInputEl.focus();
                    }
                }
            }
        });
        
        this.titleInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleInputSubmit();
            }
        });
        
        // Focus the URL input by default
        this.urlInputEl.focus();
    }
    
    private handleInputSubmit = () => {
        // Clear any previous errors
        this.hideError();
        
        // Get values from inputs
        const url = this.urlInputEl.value.trim();
        
        // Create validation rules
        const validations: ValidationResult[] = [
            // URL is required
            validateRequired(url, 'Youtube URL'),
            
            // URL must be a valid YouTube URL
            validateYouTubeUrl(url, this.isYoutubeUrl)
        ];
        
        // Check if any validation fails
        for (const validation of validations) {
            if (!validation.isValid) {
                displayValidationResult(validation, { element: this.errorEl });
            this.urlInputEl.focus();
            return;
            }
        }
        
        // Check if it's a channel URL
        if (this.isYoutubeChannelOrPlaylistUrl(url)) {
            // Check if Youtube API key is set
            if (!this.plugin.settings.youtubeApiKey || this.plugin.settings.youtubeApiKey.trim() === '') {
                this.showError(
                    'Youtube API key is required to process channels or playlists. ' +
                    'Please set your Youtube data API key in the plugin settings first. ' +
                    'See the README section "Creating a Youtube API key" for instructions.'
                );
                return;
            }
            
            // For channels, we handle this through the channel options UI
            this.showError('Please use the channel options to process this URL');
            return;
        }
        
        // Title is now optional
        // Show folder picker directly, we'll get title later if needed
        this.showFolderPicker();
    }
    
        // Method to handle processing Youtube channel or playlist videos
        private processCollectionVideos(sourceUrl: string, videoCount: number) {
            // Validate the URL once more
            if (!sourceUrl || !this.isYoutubeUrl(sourceUrl) || !this.isYoutubeChannelOrPlaylistUrl(sourceUrl)) {
                this.showError('Invalid Youtube channel or playlist URL');
                return;
            }
            
            // Check if Youtube API key is set
            if (!this.plugin.settings.youtubeApiKey || this.plugin.settings.youtubeApiKey.trim() === '') {
                this.showError(
                    'Youtube API key is required to process channels or playlists. ' +
                    'Please set your Youtube data API key in the plugin settings first. ' +
                    'See the README section "Creating a Youtube API key" for instructions.'
                );
                return;
            }
        
        // Show folder picker - we'll process videos after folder selection
        const folderSelectionModal = new FolderPickerModal(
            this.app,
            this.plugin, // Revert to this.plugin
            (folderPath) => {
                this.selectedFolder = folderPath;
                void this.beginCollectionProcessing(sourceUrl, videoCount);
            }
        );
        void folderSelectionModal.open();
    }
    
    // Method to start the collection processing workflow
    private async beginCollectionProcessing(sourceUrl: string, videoCount: number) {
        if (this.isProcessing) return;
        
        try {
            this.isProcessing = true;
            
            // Show processing UI
            const { contentEl } = this;
            contentEl.empty();
            
            // Adjust modal size to fit the animation using a CSS class
            const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
            if (modalEl && modalEl instanceof HTMLElement) {
                modalEl.addClass('tubesage-processing-modal');
            }
            
            // Create a minimal container just for centering the pulse bars
            const pulseContainerEl = contentEl.createEl('div', { 
                cls: 'pulse-container'
            });
            
            // Just create the pulse bars
            for (let i = 0; i < 5; i++) {
                pulseContainerEl.createEl('div', { cls: 'pulse-bar' });
            }
            
            // Determine if this is a playlist or channel
            const isPlaylist = sourceUrl.includes('/playlist') || sourceUrl.includes('list=');
            const contentType = isPlaylist ? 'Playlist' : 'Channel';
            
            // Extract name for folder creation (different method depending on type)
            let sourceName = '';
            
            if (isPlaylist) {
                // For playlists, we'll extract the name from the API
                if (sourceUrl.includes('list=')) {
                    const match = sourceUrl.match(/list=([^&]+)/);
                    if (match && match[1]) {
                        const playlistId = match[1];
                        this.showNotice(`Extracting playlist name...`, 5000);
                        
                        try {
                            // Get the playlist name from the API
                            const API_KEY = this.plugin.settings.youtubeApiKey;
                            const response = await obsidianFetch(
                                `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`
                            );
                            
                            if (response.ok) {
                                const data = await response.json() as PlaylistResponse;
                                if (data.items && data.items.length > 0) {
                                    sourceName = data.items[0].snippet?.title ?? '';
                                    this.showNotice(`Found playlist: ${sourceName}`, 5000);
                                }
                            }
                        } catch (error) {
                            logger.error("Error getting playlist name:", error);
                            // Use a generic name if we can't get the real name
                            sourceName = `Playlist-${playlistId}`;
                        }
                    }
                }
                
                // If we still don't have a name, use a fallback
                if (!sourceName) {
            sourceName = "Youtube-Playlist";
                }
            } else {
                // For channels, use the existing method
                sourceName = this.extractChannelName(sourceUrl);
            }
            
            const sanitizedName = this.sanitizePathComponent(sourceName);
            
            // Show starting notice
            this.showNotice(`Starting to process YouTube ${contentType.toLowerCase()}: ${sourceName}`, 5000);
            
            // Create the subfolder with content type prefix
            const formattedSourceName = `${contentType} - ${sanitizedName}`;
            const sourceSubfolder = this.selectedFolder 
                ? joinPaths(this.selectedFolder, formattedSourceName)
                : formattedSourceName;
            
            // Ensure the subfolder exists
            await ensureFolder(this.app.vault, sourceSubfolder);
                this.showNotice(`Created ${contentType.toLowerCase()} folder: ${formattedSourceName}`, 5000);
            
            // Fetch videos from the source using the source URL
            this.showNotice(`Fetching videos from ${contentType.toLowerCase()}: ${sourceName}`, 5000);
            
            // Use the plugin's fetchCollectionVideos method
            // @ts-ignore - This is a mistake in our code structure
            const collectionVideos = await this.plugin.fetchCollectionVideos(sourceUrl, videoCount);
            
            if (!collectionVideos || collectionVideos.length === 0) {
                throw new Error(`No videos found in this ${contentType.toLowerCase()}`);
            }
            
            this.showNotice(`Found ${collectionVideos.length} videos to process`, 5000);
            
            // Get the actual number of videos to process - respect ALL vs Limited options
            const videosToProcess = videoCount === 0 ? collectionVideos : collectionVideos.slice(0, videoCount);
            
            // Process each video
            let processedCount = 0;
            let skippedCount = 0;
            let errorCount = 0;
            
            for (const video of videosToProcess) {
                try {
                    clearLogs(); // Clear logs for each video processed in the collection
                    
                    // Update processing message
                    this.showNotice(`Processing video ${processedCount + skippedCount + errorCount + 1}/${videosToProcess.length}: ${video.title}`, 5000);
                    
                    // Extract and summarize transcript
                    try {
                        const transcript = await this.plugin.extractTranscript(video.url);
                        
                        if (!transcript) {
                            this.showNotice(`Skipping video ${video.title} - No transcript available`, 5000);
                            skippedCount++;
                            continue;
                        }
                        
                        const summary = await this.plugin.summarizeTranscript(transcript);
                        
                        // Create note with video title as the note title
                        await this.plugin.applyTemplate(
                            video.title, 
                            video.url, 
                            transcript, 
                            summary, 
                            sourceSubfolder,
                            contentType  // Pass the content type (Channel or Playlist)
                        );
                        
                        // Add timestamp links if enabled and not in fast summary mode
                        if (this.plugin.settings.addTimestampLinks && !this.plugin.settings.useFastSummary) {
                            // Calculate datePrefix for filename (should match logic in applyTemplate)
                            let datePrefix = '';
                            if (this.plugin.settings.prependDate) {
                                const now = new Date();
                                // Format date based on selected format
                                switch (this.plugin.settings.dateFormat) {
                                    case 'YYYY-MM-DD':
                                        datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                                        break;
                                    case 'MM-DD-YYYY':
                                        datePrefix = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()} `;
                                        break;
                                    case 'DD-MM-YYYY':
                                        datePrefix = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()} `;
                                        break;
                                    default:
                                        datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                                }
                            }
                            
                            // Calculate the path of the created note
                            const notePath = joinPaths(sourceSubfolder, `${datePrefix}${sanitizeFilename(video.title)}.md`);
                            
                            // Add timestamp links to the note - with specific notification for channel vs playlist
                            this.showNotice(`Adding timestamp links to ${isPlaylist ? 'playlist' : 'channel'} video: ${video.title}`, 3000);
                            try {
                                // Simple, small delay to allow file creation to complete
                                await new Promise(resolve => setTimeout(resolve, 300));
                                logger.debug(`Adding timestamps to file: ${notePath}`);
                                
                                await this.plugin.addSectionLinksToNote(notePath, video.url);
                                this.showNotice(`✓ Timestamp links added to ${video.title}`, 2000);
                            } catch (timestampError) {
                                logger.error(`Error adding timestamp links to ${isPlaylist ? 'playlist' : 'channel'} video (${video.title}):`, timestampError);
                                this.showNotice(`Note created but timestamps could not be added to "${video.title}"`, 3000);
                            }
                        }
                        
                        processedCount++;
                        this.showNotice(`✓ Processed video ${processedCount + skippedCount + errorCount}/${videosToProcess.length}`, 3000);
                        
                        // === NEW LOGGING LOGIC START (for collection items) ===
                        if (this.plugin.settings.debugLogging) {
                            const finalLogs = getLogsForCallout();
                            if (finalLogs && finalLogs.trim() !== "") { // Only append if there are non-empty logs
                                // Simplest approach to create debug section 
                                const debugHeader = "\n\n> [!info]- Debug Information (hidden)\n> ```";
                                const debugFooter = "\n> ```";
                                
                                const debugSection = debugHeader + "\n" + finalLogs + debugFooter;
                                
                                try {
                                    // Recalculate notePath here as it's needed for appending
                                    let datePrefix = '';
                                    if (this.plugin.settings.prependDate) {
                                        const now = new Date();
                                        // Format date based on selected format
                                        switch (this.plugin.settings.dateFormat) {
                                            case 'YYYY-MM-DD':
                                                datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                                                break;
                                            case 'MM-DD-YYYY':
                                                datePrefix = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()} `;
                                                break;
                                            case 'DD-MM-YYYY':
                                                datePrefix = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()} `;
                                                break;
                                            default:
                                                datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                                        }
                                    }
                                    const notePathForLog = joinPaths(sourceSubfolder, `${datePrefix}${sanitizeFilename(video.title)}.md`);
                                    
                                    const file = this.app.vault.getAbstractFileByPath(notePathForLog);
                                    if (file instanceof TFile) {
                                        const currentContent = await this.app.vault.read(file);
                                        await this.app.vault.modify(file, currentContent + debugSection);
                                        logger.debug("Appended debug logs to note:", notePathForLog);
                                    } else {
                                        logger.warn("Could not find file to append debug logs:", notePathForLog);
                                    }
                                } catch (logAppendError) {
                                    logger.error("Error appending debug logs to note:", logAppendError);
                                }
                            }
                        }
                        // === NEW LOGGING LOGIC END ===
                        
                    } catch (transcriptError) {
                    const transcriptErrorMessage = getSafeErrorMessage(transcriptError);
                    this.showNotice(`⚠️ Skipping video "${video.title}" - ${transcriptErrorMessage}`, 5000);
                        skippedCount++;
                        // Clear logs even on skip, so next video starts fresh
                        clearLogs(); 
                    }
                } catch (videoError) {
                    logger.error('Error processing video:', video, videoError);
                    const videoErrorMessage = getSafeErrorMessage(videoError);
                    this.showNotice(`❌ Error processing video "${video.title}": ${videoErrorMessage}`, 5000);
                    errorCount++;
                    // Clear logs on error, so next video starts fresh
                    clearLogs(); 
                }
            }
            
            // Final success notice
            this.showNotice(`Channel processing complete: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors`, 7000);
            
            // Close the modal
            this.close();
            
        } catch (err) {
            logger.error('Error in channel processing workflow:', err);
            
            // Use the getSafeErrorMessage utility instead of duplicating error handling logic
            const errorMessage = getSafeErrorMessage(err);
            
            // Show error notice
            this.showNotice(`Error: ${errorMessage}`, 5000);
            
            // Close the modal on error
            this.close();
        } finally {
            // Only stop the proxy server if currently using Anthropic
            if (this.plugin.settings.selectedLLM === 'anthropic') {
                try {
                    logger.info('[beginCollectionProcessing] Completed Anthropic processing');
                } catch (error) {
                    logger.error('Error during Anthropic processing:', error);
                }
            }
            this.isProcessing = false;
        }
    }
    
    // Helper method to sanitize file/folder names
    private sanitizePathComponent(text: string): string {
        // Use the utility function instead of duplicating code
        return sanitizePathComponent(text);
    }
    
    private showFolderPicker() {
        // Open folder picker modal
        const folderSelectionModal = new FolderPickerModal(
            this.app,
            this.plugin, // Use plugin instance
            (folderPath) => {
                this.selectedFolder = folderPath;
                void this.processTranscript();
            }
        );
        void folderSelectionModal.open();
    }
    
    private processTranscript = async () => {
        if (this.isProcessing) return;
        
        // Get URL from the input
        const url = this.urlInputEl.value.trim();
        
        // Validate URL using form utilities
        const urlValidations: ValidationResult[] = [
            validateRequired(url, 'Youtube URL'),
            validateYouTubeUrl(url, this.isYoutubeUrl)
        ];
        
        // Check URL validations
        for (const validation of urlValidations) {
            if (!validation.isValid) {
                displayValidationResult(validation, { element: this.errorEl });
            return;
            }
        }
        
        // Check if it's a channel URL - redirect to channel processing
        if (this.isYoutubeChannelOrPlaylistUrl(url)) {
            this.showError('This is a channel or playlist URL. Please use the channel options to process it.');
            return;
        }
        
        // Ensure a folder has been selected
        if (!this.selectedFolder) {
            this.showError('Please select a folder for the note');
            // Go back to folder selection
            this.handleInputSubmit();
            return;
        }
        
        try {
            this.isProcessing = true;
            
            // Show processing UI
            const { contentEl } = this;
            contentEl.empty();
            
            // Adjust modal size to fit the animation using a CSS class
            const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
            if (modalEl && modalEl instanceof HTMLElement) {
                modalEl.addClass('tubesage-processing-modal');
            }
            
            // Create a minimal container just for centering the pulse bars
            const pulseContainerEl = contentEl.createEl('div', { 
                cls: 'pulse-container'
            });
            
            // Just create the pulse bars
            for (let i = 0; i < 5; i++) {
                pulseContainerEl.createEl('div', { cls: 'pulse-bar' });
            }
            
            // Get custom title if provided
            let title = this.titleInputEl.value.trim();
            
            // Show starting notice
            this.showNotice('Starting transcript extraction workflow...', 5000);
            
            // Extract video ID
            const videoId = YouTubeTranscriptExtractor.extractVideoId(url);
            if (!videoId) {
            throw new Error(`Invalid Youtube URL: '${url}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
            }
            
            // Extract transcript and metadata in one request
            this.showNotice('Extracting transcript from Youtube...', 5000);
            let transcript: string;
            let transcriptFailed = false;
            let extractedMetadata: {title?: string, author?: string} = {};
            
            try {
                const result = await this.plugin.extractTranscriptWithMetadata(url);
                transcript = result.transcript;
                extractedMetadata = result.metadata;
                
                // If no custom title was provided, use the extracted title
                if (!title && extractedMetadata.title) {
                    title = sanitizeFilename(extractedMetadata.title);
                    this.showNotice(`Using YouTube title: ${title}`, 3000);
                } else if (!title) {
                    title = `YouTube Video ${videoId}`;
                    this.showNotice('Could not retrieve Youtube title, using fallback', 3000);
                }
                
                if (!transcript) {
                    transcriptFailed = true;
                    transcript = '[TRANSCRIPT EXTRACTION FAILED: Empty result returned]';
                    this.showNotice('Transcript extraction failed (empty result), continuing with debug note creation...', 5000);
                } else if (transcript.includes('[TRANSCRIPT EXTRACTION FAILED')) {
                    // Check if transcript contains failure message from error handling
                    transcriptFailed = true;
                    this.showNotice('Transcript extraction failed, continuing with debug note creation...', 5000);
                } else {
                    this.showNotice('Transcript extracted successfully', 5000);
                }
            } catch (transcriptError) {
                transcriptFailed = true;
                transcript = `[TRANSCRIPT EXTRACTION FAILED: ${getSafeErrorMessage(transcriptError)}]`;
                this.showNotice('Transcript extraction failed, continuing with debug note creation...', 5000);
                logger.error('Transcript extraction failed:', transcriptError);
                
                // Still set fallback title if not provided
                if (!title) {
                    title = `YouTube Video ${videoId}`;
                    this.showNotice('Using fallback title due to extraction failure', 3000);
                }
            }
            
            // Summarize transcript (skip if extraction failed)
            let summary: string;
            if (transcriptFailed) {
                summary = '[SUMMARY SKIPPED: Transcript extraction failed - see debug information below]';
                this.showNotice('Skipping AI summarization due to transcript failure...', 3000);
            } else {
                this.showNotice('Summarizing transcript with AI...', 5000);
                try {
                    summary = await this.plugin.summarizeTranscript(transcript);
                    if (!summary) {
                        summary = '[SUMMARY FAILED: Empty result returned from AI]';
                        this.showNotice('AI summarization failed (empty result), continuing with note creation...', 5000);
                    } else {
                        this.showNotice('Summary generated successfully', 5000);
                    }
                } catch (summaryError) {
                    summary = `[SUMMARY FAILED: ${getSafeErrorMessage(summaryError)}]`;
                    this.showNotice('AI summarization failed, continuing with note creation...', 5000);
                    logger.error('Summary generation failed:', summaryError);
                }
            }
            
            // Create note
            this.showNotice('Creating note with template...', 5000);
            await this.plugin.applyTemplate(
                title, 
                url, 
                transcript, 
                summary, 
                this.selectedFolder
            );
            
            // Calculate datePrefix for filename
            let datePrefix = '';
            if (this.plugin.settings.prependDate) {
                const now = new Date();
                // Format date based on selected format
                switch (this.plugin.settings.dateFormat) {
                    case 'YYYY-MM-DD':
                        datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                        break;
                    case 'MM-DD-YYYY':
                        datePrefix = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()} `;
                        break;
                    case 'DD-MM-YYYY':
                        datePrefix = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()} `;
                        break;
                    default:
                        datePrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
                }
            }
            
            // Get the path of the created note
            const notePath = this.selectedFolder 
                ? joinPaths(this.selectedFolder, `${datePrefix}${sanitizeFilename(title)}.md`)
                : `${datePrefix}${sanitizeFilename(title)}.md`;
            
            // Add section links in a second pass if enabled and not in fast summary mode and transcript extraction succeeded
            if (this.plugin.settings.addTimestampLinks && !this.plugin.settings.useFastSummary && !transcriptFailed) {
                this.showNotice('Adding section timestamp links...', 3000);
                try {
                    // Simple, small delay to allow file creation to complete
                    await new Promise(resolve => setTimeout(resolve, 300));
                    logger.debug(`Adding timestamps to file: ${notePath}`);
                    
                    await this.plugin.addSectionLinksToNote(notePath, url);
                    this.showNotice('Timestamp links added successfully', 3000);
                } catch (timestampError) {
                    const timestampErrorMessage = getSafeErrorMessage(timestampError);
                    logger.error(`Error adding timestamp links: ${timestampErrorMessage}`, timestampError);
                    this.showNotice(`Note created but timestamps could not be added: ${timestampErrorMessage}`, 5000);
                }
            } else if (transcriptFailed) {
                this.showNotice('Timestamp links skipped - no transcript available', 3000);
            }

            // === NEW LOGGING LOGIC START ===
            // Append debug logs if enabled, AFTER all processing is done
            if (this.plugin.settings.debugLogging) {
                const finalLogs = getLogsForCallout();
                if (finalLogs && finalLogs.trim() !== "") { // Only append if there are non-empty logs
                    // Simplest approach to create debug section 
                    const debugHeader = "\n\n> [!info]- Debug Information (hidden)\n> ```";
                    const debugFooter = "\n> ```";
                    
                    const debugSection = debugHeader + "\n" + finalLogs + debugFooter;
                    
                    try {
                        const file = this.app.vault.getAbstractFileByPath(notePath);
                        if (file instanceof TFile) {
                            const currentContent = await this.app.vault.read(file);
                            await this.app.vault.modify(file, currentContent + debugSection);
                            logger.debug("Appended debug logs to note:", notePath);
                        } else {
                            logger.warn("Could not find file to append debug logs:", notePath);
                        }
                    } catch (logAppendError) {
                        logger.error("Error appending debug logs to note:", logAppendError);
                    }
                }
            }
            // === NEW LOGGING LOGIC END ===

            // Final success notice
            this.showNotice('Transcript note created successfully!', 5000);
            
            // Success - just close the modal
            this.close();
            
        } catch (err) {
            logger.error('Error in transcript workflow:', err);
            
            // Use the getSafeErrorMessage utility instead of duplicating error handling logic
            const errorMessage = getSafeErrorMessage(err);
            
            // Create an error note with debug information if debug logging is enabled
            if (this.plugin.settings.debugLogging) {
                try {
                    const url = this.urlInputEl.value.trim();
                    const noteTitle = this.titleInputEl?.value.trim() || 'Failed Youtube transcript';
                    
                    // Create error content with debug logs
                    const finalLogs = getLogsForCallout();
                    let errorContent = `# ${noteTitle}\n\n`;
                    errorContent += `**Error occurred during processing:**\n\n`;
                    errorContent += `> [!error] Processing Failed\n`;
                    errorContent += `> ${errorMessage}\n\n`;
                    errorContent += `**URL:** ${url}\n\n`;
                    
                    if (finalLogs && finalLogs.trim() !== "") {
                        // Use the exact same format as successful notes
                        const debugHeader = "\n\n> [!info]- Debug Information (hidden)\n> ```";
                        const debugFooter = "\n> ```";
                        
                        const debugSection = debugHeader + "\n" + finalLogs + debugFooter;
                        errorContent += debugSection;
                    }
                    
                    // Create the error note
                    const fileName = sanitizeFilename(noteTitle) + '.md';
                    const notePath = normalizePath(joinPaths(this.selectedFolder, fileName));
                    
                    await this.app.vault.create(notePath, errorContent);
                    this.showNotice(`Error note created with debug information: ${fileName}`, 8000);
                    
                } catch (noteError) {
                    logger.error('Failed to create error note:', noteError);
                    this.showNotice(`Error: ${errorMessage} (Also failed to create debug note)`, 5000);
                }
            } else {
                // Show error notice
                this.showNotice(`Error: ${errorMessage}`, 5000);
            }
            
            // Close the modal on error
            this.close();
        } finally {
            // Only stop the proxy server if it was started (only for Anthropic provider)
            if (this.plugin.settings.selectedLLM === 'anthropic') {
                try {
                    logger.info('[processTranscript] Completed Anthropic processing');
                } catch (error) {
                    logger.error('Error during Anthropic processing:', error);
                }
            }
            this.isProcessing = false;
        }
    }
    
    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

}

class YouTubeTranscriptSettingTab extends PluginSettingTab {
    plugin: YouTubeTranscriptPlugin;
    
    constructor(app: App, plugin: YouTubeTranscriptPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        // Buy Me a Coffee section at the top
        const supportContainer = containerEl.createEl('div', {
            cls: 'tubesage-settings-support-container' // Apply new class
        });
        
        // Support section
        const supportHeading = new Setting(supportContainer)
            .setName('Support development')
            .setHeading();
        supportHeading.settingEl.addClass('tubesage-heading');
        
        // Support message in appearance format
        supportContainer.createEl('div', {
            text: 'If you find this plugin useful, consider supporting its development:',
            cls: 'tubesage-settings-support-desc' // Apply new class
        });

        // Add italicized mission statement
        supportContainer.createEl('div', {
            text: '…and help seed a bigger vision: technology that serves people and planet..',
            cls: ['tubesage-settings-support-desc', 'tubesage-mission-italic'],
            // attr: { style: 'font-style: italic;' } // Removed inline style
        });
        
        // Spacer before Buy-Me-a-Coffee button
        supportContainer.createEl('div', { attr: { style: 'height:10px;' } });
        
        // Buy Me a Coffee button in a container
        const bmcContainer = supportContainer.createEl('div', {
            cls: 'tubesage-settings-bmc-container' // Apply new class
        });
        
        // Spacer after Buy-Me-a-Coffee button
        supportContainer.createEl('div', { attr: { style: 'height:10px;' } });
        
        // Create the link
        const bmcLink = bmcContainer.createEl('a', {
            href: 'https://www.buymeacoffee.com/RMcCorkle',
            attr: {
                target: '_blank',
                rel: 'noopener'
            }
        });
        
        // Add the image (bundled as base64 to avoid external dependencies)
        bmcLink.createEl('img', {
            cls: 'tubesage-settings-bmc-img', // Apply existing class
            attr: {
                src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAiEAAACZCAMAAADOzxqEAAAAhFBMVEX/3QD//////////e//+9//+c//97//9r//9K//8p//8I//7oD/7n//7HD/6mD/6FD/5kD/4zD/4SD/3xDw0ALhwwTStgfStgbDqQmznAukjw2Vgg+GdRKGdRF3ZxR3ZxNoWhZoWhVZTRhZTRdKQBo6MxwrJh8rJh4cGSEcGSANDCMNDCJzVeEVAAAAAnRSTlP/AOW3MEoAABB4SURBVHja7Jzreps4EIa1m6RNs22aJsgeScgYezhJ939/WzBEBnEwTZ/Gjeb955gQ8um1DiMM+2fI7cPjD0YEyMvTt/sbzwfWf3nz8ExJBc33L3OG3D5SQsTzl0lDvr5QPETtyOdRQ+5o9kF0fLvxDbmnDoRw/LgdGvKFQiHOebnrDCFBiElFnCH3FAgx5PnGGXJHcxDC54czhFYxxBhfO0O+UhbEKHcnQ25pjCHGeToZQqV2YorPtSE3lAMxxVNtyAPlQExy+9MQ2u4npvn2D7ulFIi5mgijQYaY45bRSoaY455RPZWYg8qpxCw0xhALPFEEBBlCkCEEGUL87YZEAEKfIwG2lC8ZwhgX+oiVnQCPWnCKOVxDRFrYZYpURhR1gIZEurKXUqXkSHCGbCu7hkpQ2mEZwiu7EqC4gzIktedkmGqtwCG11og9iwqKOyhD0LZUGiI2Cag0sy20+g3TEItaTjkCQm0Zi7RtUJR3SIZo26dCxFR3JIhY2IbkdUhKKe+QDIkyeyGcsa2tQco7JENYdFyxhrENlHdgNVVIK3sB/HXWQvX38PZlRIJ2gYT9JKGKSMB7u1uhU0Trg5hqsT2ZZGs0BR6iIQ4Oju3gLVrMkCHzVM2KmLbvgjFkq7UGvrrAdqS5ahiGQOFuEJKwXR59ZFLZEwXNRQIwRNohGWKitZYw2LvTiOgdS0PNRzeEV/ZNJBT7Bzcktb8OFc5CMMRaS50IGTIN2JpKgkoyuwJMtEJbk1HuH9oQZWtEq4vURyzsHBWiVt3KuKAdvI9vSNo0O+sDALoGO9L6lQDgA71of+bjG1K85VYPuPRms80edzSj7eAqBtZDxjK6VkPeNNmEC/dneGmMKZsMoCZiIbOp09ixMzJjTBZdpyHwGwxBtkRsakDuc3Mikyxc0NQwhzQ16joN2dqa4hf9PV5oyM54ZBsWKrmp8T5A8ppHGVskCjhbBQdV2AtHGTQ+ZbCKmAYvHrhSQ47WUWCqJQCbZQtSJ5hZh1xjiKPkLEg2pgb/GkNgouiBia5RACDcVyKqsYPZIpkZY8+CBDxDTMPH3ZcRbBHTku0kAKhOGM5CRJmaw9Ub4kjsm5AXj7w73g/JKBYisamJh8NOeb2GuK9BrKdKOVsmGmbC9q6nDY69S8Mbdq7NEEcEKsHCruTI14y8yp+tBVwOEewVefWGOHizTplTpUBMdHcTYsQuA/y5evCGwHDY2V+3IT5QI3SLgBrWIdZ9cVf4hvzRxUwEwHwihcaUB2C/AV5Xi/N4+n3mMOOGeL+8ac654yOX/D6GcKX5xZGvMyT2Vi6iV0WUsYrOwsY995p2mQ3vgi3rpYJkHTJrbOSsjyzNiR2bJJIHRFT80ppx5l1UjD+pLyCXcwUz35Bo5yqL/iW/13PMqu263Zx1hvg9LXdTt6y3yZe3HpUuoAU2ebv3FZsWjE5JY5e09NacLYJNILoWiSO2gWmPMtORi15MOFL+4fMlVf+cZeTvXYh3MCRrpp6rDNHrZu/eD7LziZrovSXcBkbeT25vcsl8yvZjuDevZJFL2msDYRwlG6N/roNTbOw4hxM6OhiH6yXA+5v5iCEHXy1pHPk7GLLqdjG17iFE2J+WcjTng8yu18mW7SvXin51FibrlDtzBg6SziPXeqU5Qyw2vFPMR4xo0Lo5gE+WVJ1anQ2ewbx3yfDnDcEFQ54fHz7V/Pf99YlF8EuGiC75fGz1B6ZBuCY6+MntJmpypTA9JJNe6421fjw9NC4c57qAUpoGNS6Iu+54oejuC2w2I5f8XoZwNsrL492/r3xa/XSI/NTSG5Ax+p9c08B77RK57kT5ne9hauenDbbE1sEu6bx0TroSnsl4PBn3xvgI5tNJuBkMFmh8cvcf7ry/NHJO1WoGbvpyiOJ3MWS+W3h+uGnUcIbgqnIIMz5ubgq9xju4V+DUGbSsnL8DZR+xTXnKszue93ty1Qrk5i8TyplyByr/v73zbYsbhaI4GW3Xav1ThSwhmKZTgrH7/b/fPu4kHOCGTFx9MjPKeVXrSAj8crkcCDMWzFnyg3oEWoaJcLurgm7dvTTTlqqlZTa+T6BR5YMSUjGi24sNFBDCXkMIlZUTC1kWuZmmLVfTnqJTE4OfAZQJ0OrC/9fJyNAJhy2YDiTcfAOhAMOEYmZ3PxxX3G+6l67M0hFiUcCBCFGT05O7y/NNrCvGlq3644YTUmSZQniDuaGumk32lPQmh4g2gE/Tq/SOFZVMLoQfoJr0Sm3r7jIYLNVwF3K4kE5bqoaW6W4LVXZVU6sTggns2cXV7d2Lbq++YnSZIMQs3xCRknTPswwHdUQeRQtqZq9Rx3mAIIQo1wMclwtU4eIoS86uskif3n5gE4SYseZ23lJFzKpGViyq7FgpD+CY/TMYIpt9umbiDYSYF/VI3cJMvsVPJZ0EurSCSiAbjBKTlnZD43pAJfyQbVBWj1oRuXGPD1AAsJ6PhFRDBQyZ25LEBNdz/LWBTaRR5VUJQVz4stmju9caZnqEQ0seuY0qfPSYRcRVpFvEnBcQTwM1Qgi6XEeOLu/BEEtmxAL5DZFA9ZvdsATQW/QxIYREoTou0zjSKvchjiofipCOsa/vT4i7T2qrhomqIL5BN2Fh8TlCeIxlOBjgGe1JTgBVQVkqtiCkHx9Rfe0WlGxkY/QgZIHpLsdGKF1F2R9S5fUJ6Yb5ycVmjx6GeY9iC9VMxUVud50QxNiaZLBbEkJmoz0+L5ENkwXVAR1hUolvg7JApoSd1ZdhUqmnQpD1PlDvgphGugIhEYvKlPCXOaoM7NclBDPYq80evcFSpZFFBs/EFn1BZ4VbGClpQlTshXOfrtI3ILbBoFWqMhX4+7EkhBSbTDNxgdafN4kOhExaqoJMbjqsFSSrvBoh2NEslxDy6x0J6bz24QgSIITku8YtjBm0EI9HII0PgxeUBDWuI9vpLRwlUmAEmHlCaNJjR+ZUgpCk3y9nq7weIQgMNxuiNxpmyK0mCPHbR6EvyGY9bkEI9gzE/HRB8YgDOkmIQWRHpA9oa6Lxy+KvEjmW8gGTQW9XHeghpjvuFFK0yq1X5XJ1QhS7209I9z8sVT3tVgfD8hadBhObrLUZLyqUESE6JqT0S+7oYmzr14aj06g9qv1fNskYgr+QdCHf0oW32t0UdrpAvQJzcZUtqrwCIbDM9hLybZj2PL2BEHSTPywLH4FoqVRFT32JXvAJkQEhyI+DBG9LN/xIND0KC2O+8lEtk4QAZoWYQFTHe0gMiIEwjLbJKq9OyE9imb2TpSrZ1HPWY7aIvtDoU7igkAEgXXrFZhs0fE9yxz/GNAoBbQq3cFuGZPhrO5mURjA3JCpAEtsKd9rGu9J6Y3TpSnBVrkiVVyMERuk+QmC/LpOc2WTXSnDA/V2Y0p+48HhjkOqnQ0aX2vzpcAN7ZHGlI0YpKoprtSgIfWcJIMF/cjtJiLLRfo+yDe4S6miVNaq8EiGIDOebWd2+1jCr6BuYcoRBgBD45MZv05pJ3Y+47H7tgNGxg9HGjVrFhIC9Mk4WEVHwcdGhU4F7j1CFdCm5mRTBEVtYOK+aPtwRVNa4VtT5TbLK6xGC0/z3mqp3rPo/lir3+DDo/tLF2BKNyN3wHMgOTpQFSSRkJFwGEOLYU2jtPo4DZozqcerA7dQqGw4QkjY+/wKA9KbRFf+zVBNRqSJVXo8QWGb7CcFWktcQ0jdy935DY4OsfNfAwz3PqhMs/JknjUlibmOO6dhr0drkeawTO55EF4UQzNCVELi1usdMRJogOyXlkvs2LXBAZVJVXp8Qzq7e01JFn1Bpb5282QuI4Uymjx8JwzCsy2guI7zKlGS6mdgn2tldHVXTT7gflvZ5xbTLN22Ui8Z3VSJOjVRVkTEICVLlFQnB5tO9hPxe/oXM6J2pdqT8tF7XVCbAKWosCxoQMuL/aBHHps/J4spGvNHPd7ydO/ZE0ViHBJdGvHDcVFHz9Jo7f7jljAndk6JR5XUJQWi43szpHMPRawkhTUEauOP4sfaJaAVjZRdGFGjqJRTV+xSVUWAneYZKVrrlTJCu9tWGZdc7QhFagvryMLGKm0f5T01vOpRKq1yxtQlRsMze1VJt6Ghraz4V0HsRmSKytS8NVQuMvegGX/VE2JVlAtOOzj4VrbW/mVYTQBKI2BF8xk2EDVCG2piQnuNDYc6bqPKqhMilhCw/zd15ToaLxgyNuK1LGqVxPKLc0peXI0BaPj2j3s6bMujjkgx4VEJpreFpIhZQye2umDYoR3XjBWse1aOrh7sRboty4BA2dNyiVT4UIb/Yw2ZOlzBOlorjaRYsEozFvuF7TqlFe1HpHh41NAFir3FNDGF7VXW72McSmjxGWEitaykoqe2YqDRY2m0xUIJI1DiqMj/I6RCLTNUrR9K7iVdaa9LAUx7sW7bPyNYY06rdZTCpsY1Y/NWhJXuzKufF9QMQu1rEi9kVzibmLFHltQnB6HE2u48ZluqK2gau+7tIvHCpysMcYub+VeKsHRGt5tR4bkiVD0TI0xLL7I6pdQmhC57shKWj1yxrEMK6hXd3OELMIkJgmK0krK+q7qMQ4oBoyl3kwHNwvITACbvczOgehKw9xtTMfhRCXDZqpDe3P3pCHpeYqjglYDVJZ1vjeTtVaRj+OiZE4HdHTUi1jJDVDw/sR29Tnz4hjBACR14eMSEVLLM5w+x5TULgmNd4Be0jEcJPiRC5hBDYJuueYWwRoj8UISzOQ8TREoJ9iPebtC4YX5sQHEVk0LynKok4YWJC1LFnqogOCyzVnyu3Kd6uNx+DEJdU2fAl8P74CXlaRMjjynF5S465O01xeKr+IUWdg+dIHbPlltkNTspcSSY630l+gC+5s24lUTiHhGOn5LETwkHIwS1VcIFdQicsnIoxvrbtbms8dac8YkLwxva3OUJ+HoQQjnPNTlv0fN6eHKh5hIQsN1URaNb+OpYWz9hJy8ZbyrRPiDpqQlyKcX08lio2bWJh9+MEER3vw+zYURPiJrL3M3YI63BS5ipS5ADrE1eLnWLkpE9xAoTMn2V2t76lyvvwofs4iLTYh4k3PI6bEP7PsGz7cJbcpFphD+L6YbllH0KyNX/sVgbfPWV7U3N27ISw57H7H6aiyNm120SiVm1Q6yJI1oEJ+Y2v0P1xdXXx1dPl1c2De6nmmbNVVbXGmEbkDj4sIa7/A0/9b+aJP+5+/ys39SclhD0NiDz9lDTY1+M3Nz/z3NSfjhCc7g4ZX/4vZG7pz0kIxpl5qdzQn5gQJp/38PGcI8gnJQTZ6PMcH485B/m0hEDVr26aj98q85EJwYvM6tFXLbMfkQnJyoRkZUKysjIhWZmQrExI1iF0y37kRsia0Xd2kxsha0YX7DI3QtaMztl5boSstH4UrLjPzZCV1HXBijzMZKV1XrDiLDdDVkp3RcGKIs9mslL66z9Czh9yS2SlQsgLIcX33BRZk/oyEFJkXzVrSt+LkZAveZzJmvJCHCHFRW6OrFj3Zx4hxbfcIFmhHr4UAyEZkaw0ICCkuMi5SBb047wAIYO+5BlN1qjrswKEQN9zGMl60f1fBcQKT+fZgM9i99+KIiYEOrvMmwE+t27BBwgJdX55kzOST6mHu+uLM8LDv3oR6iw5DvC5AAAAAElFTkSuQmCC',
                alt: 'Buy Me A Coffee'
            }
        });
        
        // Create a horizontal container for the remaining buttons
        const buttonsContainer = supportContainer.createEl('div', {
            cls: 'tubesage-settings-action-buttons-container' // Apply new class
        });
        
        // License button - in the middle
        const licenseButtonContainer = buttonsContainer.createEl('div', {
            cls: 'tubesage-settings-action-button-item-container' // Apply new class (reused)
        });
        
        // License text
        licenseButtonContainer.createEl('span', { 
            text: 'License & disclaimer', 
            cls: 'tubesage-settings-action-button-label' // Apply new class (reused)
        });
        
        // Eye icon button for viewing license
        const licenseIconButton = licenseButtonContainer.createEl('button', {
            cls: 'tubesage-icon-button' // Apply base class
        });
        
        // Create an SVG for the eye icon
        const svgNamespace = "http://www.w3.org/2000/svg";
        const eyeSvg = document.createElementNS(svgNamespace, "svg");
        eyeSvg.setAttrs({
            viewBox: "0 0 24 24",
            width: "16",
            height: "16",
            stroke: "currentColor",
            fill: "none",
            'stroke-width': "2",
            'stroke-linecap': "round",
            'stroke-linejoin': "round"
        });
        
        // Create the eye icon paths
        const eyeCircle = document.createElementNS(svgNamespace, "circle");
        eyeCircle.setAttrs({ cx: "12", cy: "12", r: "3" });
        eyeSvg.appendChild(eyeCircle);
        
        const eyePath = document.createElementNS(svgNamespace, "path");
        eyePath.setAttr("d", "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z");
        eyeSvg.appendChild(eyePath);
        
        // Add the SVG to the button
        licenseIconButton.appendChild(eyeSvg);
        
        // Add hover effect
        licenseIconButton.addEventListener('mouseenter', () => {
            licenseIconButton.addClass('tubesage-icon-button-hover');
        });
        
        licenseIconButton.addEventListener('mouseleave', () => {
            licenseIconButton.removeClass('tubesage-icon-button-hover');
        });
        
        // Add click event to open license modal
        licenseIconButton.addEventListener('click', () => {
            new LicenseModal(this.app).open();
        });
        
        // License acceptance toggle - on the right
        const toggleContainer = buttonsContainer.createEl('div', {
            cls: 'tubesage-settings-action-button-item-container' // Reuse class
        });
        
        toggleContainer.createEl('span', { 
            text: 'Accept license & disclaimer', 
            cls: 'tubesage-settings-action-button-label' // Reuse class
        });
        
        // Create the toggle switch
        const toggleWrapper = toggleContainer.createEl('div', {
            cls: 'tubesage-license-toggle-wrapper' // Apply new class
        });
        
        // Toggle input
        const toggleInput = toggleWrapper.createEl('input', {
            cls: 'tubesage-license-toggle-input', // Apply new class
            attr: {
                type: 'checkbox',
                id: 'license-toggle'
            }
        });
        
        // Set initial state
        toggleInput.checked = this.plugin.settings.licenseAccepted;
        
        // Create the toggle slider - using CSS that actually works in Obsidian
        const toggleSlider = toggleWrapper.createEl('span', {
            cls: 'tubesage-license-toggle-slider' // Apply new class
        });
        
        // Create the slider knob
        toggleSlider.createEl('span', {
            cls: 'tubesage-license-toggle-knob' // Apply new class
        });
        
        // Initial toggle styling is now handled by CSS via :checked pseudo-selector
        
        // Make the toggle slider respond to clicks directly
        toggleSlider.addEventListener('click', (e) => {
            // Prevent the default action
            e.preventDefault();
            
            // Toggle the checkbox state
            toggleInput.checked = !toggleInput.checked;
            
            // Dispatch change event to trigger the existing handler
            const changeEvent = new Event('change');
            toggleInput.dispatchEvent(changeEvent);
        });
        
        // Also make the "Accept License" text respond to clicks
        const licenseTextElement = toggleContainer.querySelector('span');
        if (licenseTextElement) {
            licenseTextElement.addEventListener('click', (e) => {
                // Prevent the default action
                e.preventDefault();
                
                // Toggle the checkbox state
                toggleInput.checked = !toggleInput.checked;
                
                // Dispatch change event to trigger the existing handler
                const changeEvent = new Event('change');
                toggleInput.dispatchEvent(changeEvent);
            });
        }
        
        // README button - after the license toggle
        const readmeButtonContainer = buttonsContainer.createEl('div', {
            cls: 'tubesage-settings-action-button-item-container' // Reuse class
        });
        
        // README text
        readmeButtonContainer.createEl('span', { 
            text: 'README', 
            cls: 'tubesage-settings-action-button-label' // Reuse class
        });
        
        // Eye icon button for viewing README
        const readmeButton = readmeButtonContainer.createEl('button', {
            cls: 'tubesage-icon-button' // Apply base class
        });
        
        // Create an SVG for the eye icon
        const readmeSvgNamespace = "http://www.w3.org/2000/svg";
        const readmeEyeSvg = document.createElementNS(readmeSvgNamespace, "svg");
        readmeEyeSvg.setAttrs({
            viewBox: "0 0 24 24",
            width: "16",
            height: "16",
            stroke: "currentColor",
            fill: "none",
            'stroke-width': "2",
            'stroke-linecap': "round",
            'stroke-linejoin': "round"
        });
        
        // Create the eye icon paths
        const readmeEyeCircle = document.createElementNS(readmeSvgNamespace, "circle");
        readmeEyeCircle.setAttrs({ cx: "12", cy: "12", r: "3" });
        readmeEyeSvg.appendChild(readmeEyeCircle);
        
        const readmeEyePath = document.createElementNS(readmeSvgNamespace, "path");
        readmeEyePath.setAttr("d", "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z");
        readmeEyeSvg.appendChild(readmeEyePath);
        
        // Add the SVG to the button
        readmeButton.appendChild(readmeEyeSvg);
        
        // Add hover effect
        readmeButton.addEventListener('mouseenter', () => {
            readmeButton.addClass('tubesage-icon-button-hover');
        });
        
        readmeButton.addEventListener('mouseleave', () => {
            readmeButton.removeClass('tubesage-icon-button-hover');
        });
        
        // Add click event to open README modal
        readmeButton.addEventListener('click', () => {
            new READMEModal(this.app).open();
        });
        
        // Create remaining settings container that will be disabled if license not accepted
        const settingsContainer = containerEl.createEl('div', {
            cls: 'settings-container'
        });
        
        // Function to update settings container based on license acceptance
        const updateSettingsState = () => {
            if (this.plugin.settings.licenseAccepted) {
                settingsContainer.removeClass('tubesage-settings-container-disabled');
                // Visual state of toggle now handled by CSS :checked
            } else {
                settingsContainer.addClass('tubesage-settings-container-disabled');
                // Visual state of toggle now handled by CSS
            }
        };
        
        // Initial state
        updateSettingsState();
        
        // Add change listener to toggle
        toggleInput.addEventListener('change', () => {
            this.plugin.settings.licenseAccepted = toggleInput.checked;
            void this.plugin.saveSettings().then(updateSettingsState);
        });
        
        // ALL SETTINGS SECTIONS GO IN settingsContainer FROM HERE ON
        
        // Template section  
        const templatesHeading = new Setting(settingsContainer)
            .setName('Templates')
            .setHeading();
        templatesHeading.settingEl.addClass('tubesage-heading');
        
        const templaterSetting = new Setting(settingsContainer)
            .setName('Templater plugin template file')
            .setDesc('Path to the templater plugin template file to use')
            .addText(text => text
                .setPlaceholder('templates/YouTubeTranscript.md')
                .setValue(this.plugin.settings.templaterTemplateFile)
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.templaterTemplateFile = value;
                        await this.plugin.saveSettings();
                    })();
                }));
                
        // Add Browse button
        templaterSetting.addExtraButton(button => {
                button
                    .setIcon('folder')
                    .setTooltip('Browse for template file')
                    .onClick(() => {
                        // Show a file picker modal
                        const filePickerModal = new TemplateFilePickerModal(this.app, (selectedPath) => {
                            if (selectedPath) {
                                this.plugin.settings.templaterTemplateFile = selectedPath;
                                void this.plugin.saveSettings();
                                this.display();
                            }
                        });
                        void filePickerModal.open();
                    });
            });
        
        // Create a special container for the Example button with text
        const exampleContainer = createDiv();
        settingsContainer.appendChild(exampleContainer);
        
        // Add a setting with empty name
        const exampleSetting = new Setting(exampleContainer)
            .setName(''); 
        
        // Get the control element using DOM query after setting is created
        // The setting-item-control is the right side where buttons go
        setTimeout(() => {
            const controlEl = exampleContainer.querySelector('.setting-item-control');
            if (controlEl) {
                // Add the text right before the button
                const textSpan = createSpan({ text: "Example " });
                controlEl.prepend(textSpan);
            }
        }, 0);
        
        // Add the eye button
        exampleSetting.addExtraButton(button => {
            button
                .setIcon('eye')
                .setTooltip('View example template')
                .onClick(() => {
                    new TemplateViewModal(this.app).open();
                });
        });
        
        // Transcript section with info icon
        const transcriptHeading = new Setting(settingsContainer)
            .setName('Transcripts')
            .setHeading();
        transcriptHeading.settingEl.addClass('tubesage-heading');
        
        // Add info icon directly to the heading name element (adjacent to text)
        const transcriptHeadingNameEl = transcriptHeading.settingEl.querySelector('.setting-item-name');
        if (transcriptHeadingNameEl instanceof HTMLElement) {
            this.createInfoIcon(
                transcriptHeadingNameEl,
                'Transcript settings control how and where your extracted notes are saved, which youtube data API key to use (required for channel/playlist processing), and optional language-translation parameters.'
            );
        }
        
        
        new Setting(settingsContainer)
            .setName('Transcript root folder')
            .setDesc('The root folder where transcript subfolders will be organized (e.g., inbox, notes, etc.)')
            .addText(text => text
                .setPlaceholder('Inbox')
                .setValue(this.plugin.settings.transcriptRootFolder)
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.transcriptRootFolder = value;
                        await this.plugin.saveSettings();
                    })();
                }));
        
        // Removed "Use YouTube Data API v3" setting and CORS issue notice
        
        new Setting(settingsContainer)
            .setName('YouTube data API key')
            .setDesc('Your google cloud console API key for accessing public YouTube transcripts (not an OAUTH token). Required for downloading channels and playlists.')
            .addText(text => {
                const textComponent = text
                    .setPlaceholder('Enter API key (starts with aiza)')
                    .setValue(this.plugin.settings.youtubeApiKey)
                    .onChange((value: string) => {
                        void (async () => {
                            this.plugin.settings.youtubeApiKey = value;
                            await this.plugin.saveSettings();
                        })();
                    });
                
                // Access the DOM element directly to change its type
                const inputEl = textComponent.inputEl;
                if (inputEl) {
                    // Set to password type to hide with dots
                    inputEl.type = 'password';
                    
                    // Show text when focused
                    inputEl.addEventListener('focus', () => {
                        inputEl.type = 'text';
                    });
                    
                    // Hide again when focus is lost
                    inputEl.addEventListener('blur', () => {
                        inputEl.type = 'password';
                    });
                }
                
                return textComponent;
            });
        
        new Setting(settingsContainer)
            .setName('Translate language')
            .setDesc('Target language code for translation (e.g., en, es, fr, de). Use "en" to keep content in english.')
            .addText(text => text
                .setPlaceholder('Enter language code')
                .setValue(this.plugin.settings.translateLanguage)
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.translateLanguage = value;
                        await this.plugin.saveSettings();
                    })();
                }));
        
        new Setting(settingsContainer)
            .setName('Translate country')
            .setDesc('Target country/region code for translation (e.g., US, GB, CA). Used for region-specific language variants.')
            .addText(text => text
                .setPlaceholder('US')
                .setValue(this.plugin.settings.translateCountry)
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.translateCountry = value;
                        await this.plugin.saveSettings();
                    })();
                }));
        
        // LLM section with info icon
        const llmHeading = new Setting(settingsContainer)
            .setName('LLM')
            .setHeading();
        llmHeading.settingEl.addClass('tubesage-heading');
        
        // Add info icon directly to the heading name element (adjacent to text)
        const llmHeadingNameEl = llmHeading.settingEl.querySelector('.setting-item-name');
        if (llmHeadingNameEl instanceof HTMLElement) {
                this.createInfoIcon(
                    llmHeadingNameEl,
                    'LLM settings let you choose an AI provider, enter its api key, and pick a model. Temperature controls creativity; max tokens caps output length. The authors suggestion for most users: google provider with the gemini-2.5-flash model—fast, inexpensive, and high-quality.'
                );
            }
        
        new Setting(settingsContainer)
            .setName('Select llm')
            .setDesc('Choose which llm to use for summarization')
            .addDropdown(dropdown => {
                // Add OpenAI option
                dropdown.addOption('openai', 'Openai');
                
                // Always add Anthropic, Google and Ollama options since they all work on any platform now
                dropdown.addOption('anthropic', 'Anthropic');
                dropdown.addOption('google', 'Google');
                dropdown.addOption('ollama', 'Ollama');
                
                // Set the current value
                let currentValue = this.plugin.settings.selectedLLM;
                
                // Set the current value
                dropdown.setValue(currentValue);
                
                // Add change handler
                dropdown.onChange((value: string) => {
                    void (async () => {
                        // Update provider first
                        this.plugin.settings.selectedLLM = value;
                        
                        // Set appropriate max token value using registry for known models
                        const effectiveMaxTokens = this.plugin.getEffectiveMaxTokens();
                        this.plugin.settings.maxTokens = effectiveMaxTokens;
                        
                        // Show notice with effective token limit
                        new Notice(`Max tokens set to ${effectiveMaxTokens} for ${value} provider`);
                        
                        // Update settings
                        await this.plugin.saveSettings();
                        
                        // Refresh the display to update the max tokens field
                        this.display();
                    })();
                });
                
                return dropdown;
            });
        
        // Generic function for creating LLM provider settings
        const createProviderSetting = (
            provider: string,          // API key identifier (e.g., 'openai')
            displayName: string,       // Display name (e.g., 'OpenAI')
            placeholder: string,       // API key placeholder (e.g., 'sk-...')
            modelOptions: string[],    // List of model options
            defaultModelValue: string  // Default model if selection is invalid
        ) => {
            // Create the setting container
            const setting = new Setting(settingsContainer)
                .setName(`${displayName} Settings`)
                .setDesc('Your API key and model selection')
                .addText(text => {
                    // Get the input element
                    const textComponent = text
                        .setPlaceholder(placeholder)
                        .setValue(this.plugin.settings.apiKeys[provider])
                        .onChange((value: string) => {
                            void (async () => {
                                this.plugin.settings.apiKeys[provider] = value;
                                await this.plugin.saveSettings();
                            })();
                        });
                    
                    // Access the DOM element directly to change its type
                    const inputEl = textComponent.inputEl;
                    if (inputEl) {
                        // Set to password type to hide with dots
                        inputEl.type = 'password';
                        
                        // Show text when focused
                        inputEl.addEventListener('focus', () => {
                            inputEl.type = 'text';
                        });
                        
                        // Hide again when focus is lost
                        inputEl.addEventListener('blur', () => {
                            inputEl.type = 'password';
                        });
                    }
                    
                    return textComponent;
                });
            
            // Reference for dropdown to update later
            let modelDropdown: DropdownComponent | null = null;
            
            // Add dropdown for preset models
            setting.addDropdown(dropdown => {
                modelDropdown = dropdown;
                modelOptions.forEach((model) => {
                    dropdown.addOption(model, model);
                });
                dropdown.addOption('custom', 'Use custom model');
                const currentModel = this.plugin.settings.selectedModels[provider];
                let validSelection = modelOptions.includes(currentModel) ? currentModel : 'custom';
                dropdown.setValue(validSelection)
                    .onChange((value: string) => {
                        void (async () => {
                            if (value !== 'custom') {
                                this.plugin.settings.selectedModels[provider] = value;
                                customField?.setValue(''); // Clear custom if a preset is chosen
                                
                                // Update maxTokens for the new model
                                const effectiveMaxTokens = this.plugin.getEffectiveMaxTokens();
                                this.plugin.settings.maxTokens = effectiveMaxTokens;
                                
                                await this.plugin.saveSettings();
                                
                                // Show notice about the token limit change
                                new Notice(`Model changed to ${value}. Max tokens updated to ${effectiveMaxTokens}`);
                            } else {
                                // Custom model selected - initialize custom model limits if they don't exist
                                const currentModel = this.plugin.settings.selectedModels[provider];
                                if (currentModel && currentModel !== '') {
                                    const customKey = `${provider}:${currentModel}`;
                                    
                                    // Initialize custom limits if they don't exist
                                    if (!this.plugin.settings.customModelLimits[customKey]) {
                                        this.plugin.settings.customModelLimits[customKey] = {
                                            contextK: 128,
                                            maxOutputK: 16,
                                            inputMaxK: undefined,
                                            reservePct: 0.1
                                        };
                                        
                                        // Update maxTokens setting based on new custom limits
                                        this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                                        await this.plugin.saveSettings();
                                        
                                        // Refresh display to show custom parameters
                                        this.display();
                                    }
                                }
                            }
                        })();
                    });
                return dropdown;
            });

            // Add refresh button ONLY for OpenAI OR Google provider
            if (provider === 'openai' || provider === 'google') {
                setting.addExtraButton(button => {
                    button
                        .setIcon('refresh-cw') // Refresh icon
                        .setTooltip(`Refresh ${displayName} model list`)
                        .onClick(() => {
                            void (async () => {
                            if (!modelDropdown) {
                                this.plugin.showNotice(`Unable to refresh ${displayName} models: dropdown not initialized.`, 5000);
                                return;
                            }
                            const dropdown = modelDropdown;
                            
                            const apiKey = this.plugin.settings.apiKeys[provider];
                            if (!apiKey || apiKey.trim() === '') {
                                this.plugin.showNotice(`${displayName} API key is required to refresh models.`, 5000);
                                return;
                            }

                            let fetchedModels: string[] = [];
                            if (provider === 'openai') {
                                fetchedModels = await this.plugin.fetchOpenAIModels(apiKey);
                            } else if (provider === 'google') {
                                fetchedModels = await this.plugin.fetchGoogleModels(apiKey);
                            }

                            if (fetchedModels.length > 0) {
                                const currentSelectedModel = this.plugin.settings.selectedModels[provider];
                                // @ts-ignore - selectEl is part of the dropdown
                                const options = dropdown.selectEl.options;
                                for (let i = options.length - 1; i >= 0; i--) {
                                    if (options[i].value !== 'custom') {
                                        dropdown.selectEl.remove(i);
                                    }
                                }
                                fetchedModels.forEach((modelId) => {
                                    dropdown.addOption(modelId, modelId);
                                });
                                // @ts-ignore - selectEl is part of the dropdown
                                dropdown.selectEl.appendChild(dropdown.selectEl.querySelector('option[value="custom"]'));

                                if (fetchedModels.includes(currentSelectedModel)) {
                                    dropdown.setValue(currentSelectedModel);
                                } else if (fetchedModels.includes(defaultModelValue)) {
                                    dropdown.setValue(defaultModelValue);
                                    this.plugin.settings.selectedModels[provider] = defaultModelValue;
                                    await this.plugin.saveSettings();
                                } else if (fetchedModels.length > 0) {
                                    dropdown.setValue(fetchedModels[0]);
                                    this.plugin.settings.selectedModels[provider] = fetchedModels[0];
                                    await this.plugin.saveSettings();
                                } else {
                                    dropdown.setValue('custom');
                                    
                                    // Initialize custom model limits if they don't exist and we have a custom model set
                                    const currentModel = this.plugin.settings.selectedModels[provider];
                                    if (currentModel && currentModel !== '') {
                                        const customKey = `${provider}:${currentModel}`;
                                        
                                        if (!this.plugin.settings.customModelLimits[customKey]) {
                                            this.plugin.settings.customModelLimits[customKey] = {
                                                contextK: 128,
                                                maxOutputK: 16,
                                                inputMaxK: undefined,
                                                reservePct: 0.1
                                            };
                                            
                                            // Update maxTokens setting based on new custom limits
                                            this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                                            await this.plugin.saveSettings();
                                        }
                                    }
                                    
                                    // Refresh display to show custom model settings
                                    this.display();
                                }
                                this.plugin.showNotice(`${displayName} model list refreshed.`, 3000);
                            } else {
                                this.plugin.showNotice(`Could not refresh ${displayName} models. Using existing list.`, 4000);
                            }
                            })();
                        });
                });
            }
            
            // Reference to store custom field
            let customField: TextComponent | null = null;
            
            // Add custom model field
            setting.addText(text => {
                // Store reference
                customField = text;
                
                // Configure text field
                text.setPlaceholder('Custom model name')
                    .setValue(
                        // Show current model in custom field if not in dropdown list
                        !modelOptions.includes(this.plugin.settings.selectedModels[provider])
                            ? this.plugin.settings.selectedModels[provider] 
                            : ''
                    )
                    .onChange((value: string) => {
                        void (async () => {
                            if (value && value.trim() !== '') {
                                // Update model with custom value
                                this.plugin.settings.selectedModels[provider] = value;
                                // Set dropdown to custom (prevent double-triggering by checking current value)
                                if (modelDropdown && modelDropdown.getValue() !== 'custom') {
                                    modelDropdown.setValue('custom');
                                }
                                
                                // Initialize custom model limits if they don't exist
                                const customKey = `${provider}:${value}`;
                                if (!this.plugin.settings.customModelLimits[customKey]) {
                                    this.plugin.settings.customModelLimits[customKey] = {
                                        contextK: 128,
                                        maxOutputK: 16,
                                        inputMaxK: undefined,
                                        reservePct: 0.1
                                    };
                                    
                                    // Update maxTokens setting based on new custom limits
                                    this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                                }
                                
                                await this.plugin.saveSettings();
                            } else if (modelDropdown && modelDropdown.getValue() === 'custom') {
                                // If custom field is cleared and dropdown is on custom, reset to default
                                modelDropdown.setValue(defaultModelValue);
                                this.plugin.settings.selectedModels[provider] = defaultModelValue;
                                await this.plugin.saveSettings();
                            }
                        })();
                    });
                
                return text;
            });
            
            // Add custom model parameters section (initially hidden)
            if (customField && modelDropdown) {
                this.addCustomModelParametersSection(settingsContainer, provider, customField, modelDropdown);
            }
            
            return setting;
        };
        
        // Create settings for each provider with their specific options
        createProviderSetting(
            'openai',                      // provider
            'OpenAI',                      // display name
            'sk-...',                      // API key placeholder
            [                              // model options
                'gpt-5',                   // ✅ NEW: 400K context, 128K output
                'gpt-4.5',
                'gpt-4o',
                'gpt-4o-mini',
                'gpt-4-turbo',
                'gpt-4',
                'gpt-3.5-turbo',
                'o1',
                'o1-pro',
                'o3-mini',
                'o3-mini-high'
            ],
            'gpt-4-turbo'                  // default model
        );
        
        // Handle Anthropic settings for all platforms (now works everywhere)
        createProviderSetting(
            'anthropic',
            'Anthropic',
            'sk-ant-...',
            [
                'claude-opus-4-0',              // ✅ NEW: 400K context, 32K output
                'claude-opus-4-1',              // ✅ NEW: 400K context, 32K output
                'claude-sonnet-4-0',            // ✅ NEW: 400K context, 16K output
                'claude-3-7-sonnet-20250219',
                'claude-3-5-sonnet-20241022',
                'claude-3-5-haiku-20241022',   // ✅ Added from registry
                'claude-3-opus-20240229',
                'claude-3-sonnet-20240229',    // ✅ Added from registry
                'claude-3-haiku-20240307'
            ],
            'claude-3-sonnet-20240229'
        );
        
        // Google provider settings (always shown on all platforms)
        createProviderSetting(
            'google',
            'Google',
            'AIza...',
            [
                'gemini-2.5-flash',            // ✅ NEW: 2M context, 16K output
                'gemini-2.5-pro-exp-03-25',
                'gemini-2.0-flash-exp',        // ✅ Added from registry
                'gemini-2.0-pro-exp-02-05',
                'gemini-2.0-flash',
                'gemini-2.0-flash-lite',
                'gemini-1.5-pro',
                'gemini-1.5-flash',
                'gemini-1.5-flash-8b',
                'gemini-nano',
                'gemini-ultra (beta)',
                'gemini-pro',
                'gemini-pro-vision'
            ],
            'gemini-1.5-pro'
        );
        
        // Ollama provider settings (always shown on all platforms)
        createProviderSetting(
            'ollama',
            'Ollama',
            'http://localhost:11434',
            [
                'llama3.1',
                'llama3.1:8b',
                'llama3.1:70b',
                'mistral',
                'mixtral',
                'gemma',
                'codellama',
                'phi',
                'wizardcoder',
                'solar'
            ],
            'llama3.1'
        );
        
        // LLM Parameters
        new Setting(settingsContainer)
            .setName('Temperature')
            .setDesc(`Controls randomness of output (0-1). Lower is more focused, higher is more creative. Current value: ${this.plugin.settings.temperature}`)
            .addSlider(slider => slider
                .setLimits(0, 1, 0.1)
                .setValue(this.plugin.settings.temperature)
                .setDynamicTooltip()
                .onChange((value: number) => {
                    void (async () => {
                        this.plugin.settings.temperature = value;
                        // Update the description text to show the current value
                        this.display();
                        await this.plugin.saveSettings();
                    })();
                }));
        
        // Only show Max Tokens setting for custom models - known models use dynamic calculation
        const provider = this.plugin.settings.selectedLLM as Provider;
        const model = this.plugin.settings.selectedModels[provider];
        const isCustomModel = !isModelSupported(provider, model);
        
        if (isCustomModel) {
            new Setting(settingsContainer)
                .setName('Max tokens')
                .setDesc('Maximum length of summary output for custom model')
                .addText(text => text
                    .setPlaceholder('1000')
                    .setValue(String(this.plugin.settings.maxTokens))
                    .onChange((value: string) => {
                        void (async () => {
                            const numValue = parseInt(value);
                            if (!isNaN(numValue)) {
                                this.plugin.settings.maxTokens = numValue;
                                await this.plugin.saveSettings();
                            }
                        })();
                    }))
                .addExtraButton(button => {
                    button
                        .setIcon('alert-triangle')
                        .setTooltip('Max tokens should not be confused with the size of the context window. This setting reflects the maximum output returned by the model and is quite sensitive - exceeding this limit will cause the llm to fail. For custom models, ensure this parameter is aligned with your models capabilities.');
                });
        }
        // Note: Known models automatically calculate optimal max tokens using getEffectiveMaxTokens()
        
        // Note format section
        const noteFormatHeading = new Setting(settingsContainer)
            .setName('Note format')
            .setHeading();
        noteFormatHeading.settingEl.addClass('tubesage-heading');
        
        new Setting(settingsContainer)
            .setName('Prepend date to note title')
            .setDesc('Automatically add date to the beginning of note filenames')
            .addDropdown((dropdown) => dropdown
                .addOption('true', 'Enabled')
                .addOption('false', 'Disabled')
                .setValue(this.plugin.settings.prependDate ? 'true' : 'false')
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.prependDate = value === 'true';
                        await this.plugin.saveSettings();
                    })();
                }));

        new Setting(settingsContainer)
            .setName('Date format')
            .setDesc('Format for date prepended to note titles')
            .addDropdown((dropdown) => dropdown
                .addOption('YYYY-MM-DD', 'Yyyy-mm-dd')
                .addOption('MM-DD-YYYY', 'Mm-dd-yyyy')
                .addOption('DD-MM-YYYY', 'Dd-mm-yyyy')
                .setValue(this.plugin.settings.dateFormat)
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.dateFormat = value;
                        await this.plugin.saveSettings();
                    })();
                }));


        // Prompt section
        const promptsHeading = new Setting(settingsContainer)
            .setName('Prompts')
            .setHeading();
        promptsHeading.settingEl.addClass('tubesage-heading');

        // Create a sub-heading for Fast Summary prompts
        const fastSummaryHeading = new Setting(settingsContainer)
            .setName('Fast summary prompts')
            .setHeading();
        fastSummaryHeading.settingEl.addClass('tubesage-settings-prompt-subheader');
        
        new Setting(settingsContainer)
            .setName('System prompt (fast summary)')
            .setDesc('Instructions for the llms behavior when generating fast summaries')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('You are a helpful assistant...')
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange((value: string) => {
                        void (async () => {
                            this.plugin.settings.systemPrompt = value;
                            await this.plugin.saveSettings();
                        })();
                    });
                
                // Access the DOM element and set its appearance
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.addClass('tubesage-prompt-textarea');
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(() => {
                        void (async () => {
                            this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    });
            });
        
        new Setting(settingsContainer)
            .setName('User prompt (fast summary)')
            .setDesc('Specific instructions for summarizing the transcript quickly and concisely')
            .addTextArea(text => {
                const textComponent = text
                .setPlaceholder('Please summarize the following YouTube transcript...')
                    .setValue(this.plugin.settings.userPrompt)
                    .onChange((value: string) => {
                        void (async () => {
                            this.plugin.settings.userPrompt = value;
                            await this.plugin.saveSettings();
                        })();
                    });
                
                // Access the DOM element and set its appearance
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.addClass('tubesage-prompt-textarea');
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(async () => {
                        this.plugin.settings.userPrompt = DEFAULT_SETTINGS.userPrompt;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });
        
        // Create a sub-heading for Extensive Summary prompts
        const extensiveSummaryHeading = new Setting(settingsContainer)
            .setName('Extensive summary prompts')
            .setHeading();
        extensiveSummaryHeading.settingEl.addClass('tubesage-settings-prompt-subheader');
        extensiveSummaryHeading.settingEl.addClass('tubesage-settings-prompt-subheader-extensive');
        
        new Setting(settingsContainer)
            .setName('System prompt (extensive summary)')
            .setDesc('Instructions for the llms behavior when generating detailed, comprehensive summaries')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('You are an analytical assistant...')
                    .setValue(this.plugin.settings.extensiveSystemPrompt)
                    .onChange((value: string) => {
                        void (async () => {
                            this.plugin.settings.extensiveSystemPrompt = value;
                            await this.plugin.saveSettings();
                        })();
                    });
                
                // Access the DOM element and set its appearance
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.addClass('tubesage-prompt-textarea');
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(() => {
                        void (async () => {
                            this.plugin.settings.extensiveSystemPrompt = DEFAULT_SETTINGS.extensiveSystemPrompt;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    });
            });
        
        new Setting(settingsContainer)
            .setName('User prompt (extensive summary)')
            .setDesc('Specific instructions for creating detailed and structured notes from the transcript')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('From the transcript below, create detailed and structured notes...')
                    .setValue(this.plugin.settings.extensiveUserPrompt)
                    .onChange((value: string) => {
                        void (async () => {
                            this.plugin.settings.extensiveUserPrompt = value;
                            await this.plugin.saveSettings();
                        })();
                    });
                
                // Access the DOM element and set its appearance
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.addClass('tubesage-prompt-textarea');
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(() => {
                        void (async () => {
                            this.plugin.settings.extensiveUserPrompt = DEFAULT_SETTINGS.extensiveUserPrompt;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    });
            });
        
        // Default Summary Mode Setting
        new Setting(settingsContainer)
            .setName('Default summary mode')
            .setDesc('Choose the default summary mode to use when the plugin starts. Fast summary mode skips timestamp links for quicker processing.')
            .addDropdown((dropdown) => dropdown
                .addOption('false', 'Extensive summary (detailed)')
                .addOption('true', 'Fast summary (brief)')
                .setValue(this.plugin.settings.useFastSummary ? 'true' : 'false')
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.useFastSummary = value === 'true';
                        await this.plugin.saveSettings();
                    })();
                }));
        
        // Add timestamp links setting
        new Setting(settingsContainer)
            .setName('Add YouTube timestamp links')
            .setDesc('Add links to each numbered section heading that jump to the corresponding timestamp in the YouTube video (note: disabled in fast summary mode)')
            .addDropdown(dropdown => dropdown
                .addOption('true', 'Enabled')
                .addOption('false', 'Disabled')
                .setValue(this.plugin.settings.addTimestampLinks ? 'true' : 'false')
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.addTimestampLinks = value === 'true';
                        await this.plugin.saveSettings();
                    })();
                }))
            .addExtraButton(button => {
                button
                    .setIcon('info')
                        .setTooltip('When enabled, reduces first pass tokens by 12% to make room for links. Automatically disabled in fast summary mode.');
            });
            
        // Advanced section with info icon  
        const advancedHeading = new Setting(settingsContainer)
            .setName('Advanced')
            .setHeading();
        advancedHeading.settingEl.addClass('tubesage-heading');
        
        // Add info icon directly to the heading name element (adjacent to text)
        const advancedHeadingNameEl = advancedHeading.settingEl.querySelector('.setting-item-name');
        if (advancedHeadingNameEl instanceof HTMLElement) {
            this.createInfoIcon(
                advancedHeadingNameEl,
                'Advanced settings for debugging and troubleshooting. Enable debug logging to get detailed information appended to each note for technical support.'
            );
        }
        
        // Debug logging toggle
        new Setting(settingsContainer)
            .setName('Enable debug logging')
            .setDesc('Enable detailed debug logs. When enabled, debug information will be appended to each note as a hidden callout for troubleshooting.')
            .addDropdown(dropdown => dropdown
                .addOption('true', 'Enabled')
                .addOption('false', 'Disabled')
                .setValue(this.plugin.settings.debugLogging ? 'true' : 'false')
                .onChange((value: string) => {
                    void (async () => {
                        this.plugin.settings.debugLogging = value === 'true';
                        // Update log level immediately
                        if (this.plugin.settings.debugLogging) {
                            setGlobalLogLevel(LogLevel.DEBUG);
                            logger.debug('Debug logging enabled from settings');
                        } else {
                            setGlobalLogLevel(LogLevel.INFO);
                            logger.info('Debug logging disabled from settings');
                        }
                        await this.plugin.saveSettings();
                    })();
                }))
            .addExtraButton((button: ExtraButtonComponent) => {
                button
                    .setIcon('info')
                    .setTooltip('When enabled, debug information will be collected and added to notes as a hidden callout instead of being logged to the console.');
            });
    }

    // Helper function to create info icons with tooltips
    private createInfoIcon(container: HTMLElement, tooltipText: string): HTMLElement {
        // Add info icon
        const infoIcon = container.createEl('span', {
            cls: 'tubesage-settings-info-icon', // Apply new class
            attr: { 'aria-label': 'Information' } // Keep aria-label
        });
        
        // Create SVG icon for info
        const infoSvgNamespace = "http://www.w3.org/2000/svg";
        const infoSvg = document.createElementNS(infoSvgNamespace, "svg");
        infoSvg.setAttrs({
            viewBox: "0 0 24 24",
            width: "16",
            height: "16",
            stroke: "currentColor",
            fill: "none",
            'stroke-width': "2",
            'stroke-linecap': "round",
            'stroke-linejoin': "round"
        });
        
        // Create circle for info icon
        const circle = document.createElementNS(infoSvgNamespace, "circle");
        circle.setAttrs({ cx: "12", cy: "12", r: "10" });
        infoSvg.appendChild(circle);
        
        // Create the i vertical line
        const line = document.createElementNS(infoSvgNamespace, "line");
        line.setAttrs({ x1: "12", y1: "16", x2: "12", y2: "12" });
        infoSvg.appendChild(line);
        
        // Create the i dot
        const dot = document.createElementNS(infoSvgNamespace, "line");
        dot.setAttrs({ x1: "12", y1: "8", x2: "12.01", y2: "8" });
        infoSvg.appendChild(dot);
        
        // Add the SVG to the icon container
        infoIcon.appendChild(infoSvg);
        
        // Add tooltip using pure CSS approach
        infoIcon.setAttribute('data-tooltip', tooltipText);
        infoIcon.addClass('tubesage-settings-info-icon-with-tooltip');
        
        // Provide native tooltip fallback
        infoIcon.setAttr('title', tooltipText);
        
        return infoIcon;
    }

    /**
     * Add custom model parameters section that appears when custom model is selected
     */
    private addCustomModelParametersSection(container: HTMLElement, provider: string, customField: TextComponent, modelDropdown: DropdownComponent): void {
        // Create container for custom model parameters
        const customParamsContainer = container.createEl('div', {
            cls: 'tubesage-custom-model-params tubesage-display-none'
        });
        
        // Add header
        const customParamsHeading = new Setting(customParamsContainer)
            .setName(`Custom model parameters (${provider.toUpperCase()})`)
            .setHeading();
        customParamsHeading.settingEl.addClass('tubesage-custom-params-header');
        
        // Get current custom limits for this provider:model combination
        const getCurrentCustomLimits = () => {
            const model = this.plugin.settings.selectedModels[provider];
            const customKey = `${provider}:${model}`;
            return this.plugin.settings.customModelLimits[customKey] || {
                contextK: 128,
                maxOutputK: 16,
                inputMaxK: undefined,
                reservePct: provider === 'ollama' ? 0.15 : 0.10
            };
        };
        
        // Context window field
        new Setting(customParamsContainer)
            .setName('Context window (k tokens)')
            .setDesc('Total context window in thousands of tokens (e.g., 400 for 400k tokens)')
            .addText(text => {
                text.setValue(getCurrentCustomLimits().contextK.toString())
                    .onChange((value: string) => {
                        void (async () => {
                            const numValue = parseInt(value) || 128;
                            const model = this.plugin.settings.selectedModels[provider];
                            const customKey = `${provider}:${model}`;
                            
                            if (!this.plugin.settings.customModelLimits[customKey]) {
                                this.plugin.settings.customModelLimits[customKey] = getCurrentCustomLimits();
                            }
                            
                            this.plugin.settings.customModelLimits[customKey].contextK = numValue;
                            await this.plugin.saveSettings();
                            
                            // Update maxTokens setting based on new context window
                            this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                            await this.plugin.saveSettings();
                        })();
                    });
            });
        
        // Max output field
        new Setting(customParamsContainer)
            .setName('Max output (k tokens)')
            .setDesc('Maximum output tokens in thousands (e.g., 128 for 128k tokens)')
            .addText(text => {
                text.setValue(getCurrentCustomLimits().maxOutputK.toString())
                    .onChange((value: string) => {
                        void (async () => {
                            const numValue = parseInt(value) || 16;
                            const model = this.plugin.settings.selectedModels[provider];
                            const customKey = `${provider}:${model}`;
                            
                            if (!this.plugin.settings.customModelLimits[customKey]) {
                                this.plugin.settings.customModelLimits[customKey] = getCurrentCustomLimits();
                            }
                            
                            this.plugin.settings.customModelLimits[customKey].maxOutputK = numValue;
                            await this.plugin.saveSettings();
                            
                            // Update maxTokens setting
                            this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                            await this.plugin.saveSettings();
                            
                        })();
                    });
            });
        
        // Input max field (optional)
        new Setting(customParamsContainer)
            .setName('Input max (k tokens) - optional')
            .setDesc('Explicit input cap if vendor publishes one (leave empty to auto calculate)')
            .addText(text => {
                const currentLimits = getCurrentCustomLimits();
                text.setValue(currentLimits.inputMaxK ? currentLimits.inputMaxK.toString() : '')
                    .onChange((value: string) => {
                        void (async () => {
                            const numValue = value.trim() ? parseInt(value) || undefined : undefined;
                            const model = this.plugin.settings.selectedModels[provider];
                            const customKey = `${provider}:${model}`;
                            
                            if (!this.plugin.settings.customModelLimits[customKey]) {
                                this.plugin.settings.customModelLimits[customKey] = getCurrentCustomLimits();
                            }
                            
                            this.plugin.settings.customModelLimits[customKey].inputMaxK = numValue;
                            await this.plugin.saveSettings();
                            
                            // Update maxTokens setting based on new input max
                            this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                            await this.plugin.saveSettings();
                            
                        })();
                    });
            });
        
        // Reserve percentage field
        new Setting(customParamsContainer)
            .setName('Reserve percentage')
            .setDesc(`Safety reserve for output tokens (0.10 = 10%, default: ${provider === 'ollama' ? '15%' : '10%'})`)
            .addText(text => {
                text.setValue(getCurrentCustomLimits().reservePct?.toString() || (provider === 'ollama' ? '0.15' : '0.10'))
                    .onChange((value: string) => {
                        void (async () => {
                            const numValue = parseFloat(value) || (provider === 'ollama' ? 0.15 : 0.10);
                            const model = this.plugin.settings.selectedModels[provider];
                            const customKey = `${provider}:${model}`;
                            
                            if (!this.plugin.settings.customModelLimits[customKey]) {
                                this.plugin.settings.customModelLimits[customKey] = getCurrentCustomLimits();
                            }
                            
                            this.plugin.settings.customModelLimits[customKey].reservePct = Math.max(0, Math.min(1, numValue));
                            await this.plugin.saveSettings();
                            
                            // Update maxTokens setting
                            this.plugin.settings.maxTokens = this.plugin.getEffectiveMaxTokens();
                            await this.plugin.saveSettings();
                            
                        })();
                    });
            });
        
        // Function to show/hide custom parameters based on selection
        const updateCustomParamsVisibility = () => {
            const dropdownValue = modelDropdown.getValue();

            // Show custom parameters when dropdown is set to 'custom' (regardless of field content)
            const isCustomSelected = dropdownValue === 'custom';
            
            // Simple, reliable display logic using CSS classes
            if (isCustomSelected) {
                customParamsContainer.removeClass('tubesage-display-none');
                customParamsContainer.addClass('tubesage-display-block');
            } else {
                customParamsContainer.removeClass('tubesage-display-block');
                customParamsContainer.addClass('tubesage-display-none');
            }
            
            // Debug logging removed - was too spammy due to 500ms polling interval
        };
        
        // Use both polling AND event listeners for maximum reliability
        const visibilityInterval = setInterval(updateCustomParamsVisibility, 500);
        
        // Add direct event listeners to UI elements
        modelDropdown.selectEl?.addEventListener('change', () => {
            setTimeout(updateCustomParamsVisibility, 100);
        });
        
        // Note: Removed 'input' event listener as visibility no longer depends on field content
        // Only check on blur to avoid focus issues while typing
        customField.inputEl?.addEventListener('blur', () => {
            setTimeout(updateCustomParamsVisibility, 100);
        });
        
        // Clean up interval when settings are closed
        setTimeout(() => clearInterval(visibilityInterval), 60000);
        
        // Initial visibility check
        updateCustomParamsVisibility();
    }
}

class TemplateFilePickerModal extends Modal {
    private result: (path: string) => void;
    private templates: { path: string }[] = [];
    private templatesFolder: string = "Templates"; // Default fallback

    constructor(app: App, callback: (path: string) => void) {
        super(app);
        this.result = callback;
        
        // Try to get template folder from Templater plugin settings if available
        const templaterSettings = getTemplaterSettings(this.app);
        if (templaterSettings?.templates_folder) {
            this.templatesFolder = normalizePath(templaterSettings.templates_folder);
        }
        
        logger.debug("Template picker initialized with templates folder:", this.templatesFolder);
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Select template file' });
        
        // Get all markdown files in the vault
        // @ts-ignore - Using Obsidian API types
        const allFiles = this.app.vault.getMarkdownFiles();
        logger.debug("Total markdown files in vault:", allFiles.length);
        
        // Filter to only include files from the templates folder
        this.templates = allFiles
            // @ts-ignore - Using Obsidian API types
            .filter(file => {
                // Check if the file path starts with the templates folder
                // or if it's in a subfolder of the templates folder
                const path = file.path.toLowerCase();
                const templatesFolder = this.templatesFolder.toLowerCase();
                
                const isTemplate = path.startsWith(templatesFolder + '/') || 
                       path === templatesFolder ||
                       path.includes('/' + templatesFolder + '/');
                       
                if (isTemplate) {
                    logger.debug("Found template file:", file.path);
                }
                
                return isTemplate;
            })
            // @ts-ignore - Using Obsidian API types
            .map(file => ({ path: file.path }));
        
        logger.debug(`Found ${this.templates.length} template files`);
        
        // Display a message if no template files were found
        if (this.templates.length === 0) {
            contentEl.createEl('div', { 
                text: `No template files found in "${this.templatesFolder}" folder. ` +
                      `Make sure your template folder is correctly configured in Templater settings.`,
                cls: 'setting-item-description'
            });
        }

        // Create search input
        const searchEl = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Type to search templates...'
        });
        searchEl.addEventListener('input', () => {
            const query = searchEl.value.toLowerCase();
            this.updateTemplateList(query);
        });

        // Create template list container – reuse folder-list styling for consistency
        const templateListEl = contentEl.createEl('div', { cls: ['template-list', 'folder-list'] });
        
        // Populate initial list
        this.updateTemplateList('', templateListEl);
    }

    updateTemplateList(query: string, listEl?: HTMLElement) {
        const templateListEl = listEl || document.querySelector('.template-list') as HTMLElement;
        if (!templateListEl) return;
        
        templateListEl.empty();
        
        const filteredTemplates = this.templates.filter(t => 
            t.path.toLowerCase().includes(query)
        );
        
        for (const template of filteredTemplates) {
            const item = templateListEl.createEl('div', { cls: ['template-item', 'folder-item'] });
            
            // Reuse icon appearance
            const iconEl = item.createEl('span', { cls: 'folder-icon' });
            iconEl.setText('📄');
            
            // Path span – mimic folder picker
            item.createEl('span', { text: template.path, cls: 'folder-path' });
            
            item.addEventListener('click', () => {
                logger.debug("Selected template file:", template.path);
                this.result(template.path);
                this.close();
            });
        }
        
        if (filteredTemplates.length === 0) {
            templateListEl.createEl('div', { text: 'No matching templates found.' });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Simple folder picker modal using Obsidian's Modal class
class FolderPickerModal extends Modal {
    private onSelectFolder: (folderPath: string) => void;
    private folders: FolderItem[] = [];
    private plugin: YouTubeTranscriptPlugin;
    
    constructor(app: App, plugin: YouTubeTranscriptPlugin, onSelectFolder: (folderPath: string) => void) {
        super(app);
        this.onSelectFolder = onSelectFolder;
        this.plugin = plugin;
    }
    
    onOpen() {
        // Run async setup without returning a promise to Modal
        void (async () => {
            await this.loadFolders();
            this.renderFolderPicker();
        })();
    }
    
    private async loadFolders() {
        try {
            // Reset folders array
            this.folders = [];
            
            // Track unique paths to prevent duplicates
            const uniquePaths = new Set<string>();
            
            // Get the root folder from settings
            const rootFolder = this.plugin.settings.transcriptRootFolder || 'Inbox';
            const normalizedRootFolder = normalizePath(rootFolder, false); // Keep leading slash
            
            // Ensure root folder exists
            try {
                // Create root folder from settings if it doesn't exist
                const rootFolderPath = normalizePath(rootFolder);
                if (!this.app.vault.getAbstractFileByPath(rootFolderPath)) {
                    await ensureFolder(this.app.vault, rootFolderPath);
                    logger.debug(`[DEBUG] Created ${rootFolderPath} folder`);
                }
            } catch (e) {
                logger.error('Error ensuring root folder exists:', e);
            }
            
            // Cross-platform implementation: get all files using Obsidian API
            // This works on both desktop and mobile
            const files = this.app.vault.getAllLoadedFiles();
            
            // Add root folder first
            this.folders.push({ 
                path: normalizedRootFolder, 
                name: rootFolder
            });
            uniquePaths.add(normalizedRootFolder);
            
            // Collection of folders for summarized logging
            const foundFolders: string[] = [];
            
            // Process all folders from the vault
            for (const file of files) {
                // Check if it's a folder by testing its instance type
                // This approach works on both desktop and mobile
                if (file && 'children' in file) {
                    const path = file.path || '';
                    
                    // Add all folders that are inside the root folder
                    if (path !== rootFolder && (
                        path.startsWith(rootFolder + '/') || 
                        path.startsWith(normalizedRootFolder + '/'))) {
                        
                        const normalizedPath = normalizePath(path, false); // Keep leading slash for display
                        if (!uniquePaths.has(normalizedPath)) {
                            this.folders.push({
                                path: normalizedPath,
                                name: path
                            });
                            uniquePaths.add(normalizedPath);
                            // Add to our collection for logging
                            foundFolders.push(path);
                        }
                    }
                }
            }
            
            // Sort folders by path for hierarchical order
            this.folders.sort((a, b) => {
                if (a.path === normalizedRootFolder) return -1;
                if (b.path === normalizedRootFolder) return 1;
                return a.path.localeCompare(b.path);
            });
            
            // Log a summary of folders found - only show first MAX_FOLDERS_TO_LOG folders
            const MAX_FOLDERS_TO_LOG = 5;
            if (foundFolders.length > 0) {
                if (foundFolders.length <= MAX_FOLDERS_TO_LOG) {
                    logger.debug(`[DEBUG] Found folders (${foundFolders.length} total): ${foundFolders.join(', ')}`);
                } else {
                    const shownFolders = foundFolders.slice(0, MAX_FOLDERS_TO_LOG);
                    logger.debug(`[DEBUG] Found folders (${foundFolders.length} total): ${shownFolders.join(', ')}... and ${foundFolders.length - MAX_FOLDERS_TO_LOG} more`);
                }
            }
            
            logger.debug(`[DEBUG] Found ${this.folders.length} folders total, ${this.folders.length - 1} subfolders`);
        } catch (err) {
            logger.error('Error loading folders:', err);
        }
    }
    
    private renderFolderPicker() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Get the root folder name for display
        const rootFolder = this.plugin.settings.transcriptRootFolder || 'Inbox';
        const normalizedRootFolder = normalizePath(rootFolder, false); // Keep leading slash for display
        
        // Simple title only
        contentEl.createEl('h2', { text: 'Select folder location' });
        
        // Debug info about folder count
        const rootSubfolderCount = this.folders.length - 1; // Subtract root folder itself
        if (rootSubfolderCount <= 0) {
            contentEl.createEl('div', {
                text: `No subfolders found under ${rootFolder}`,
                cls: 'tubesage-folder-picker-status-error' // Apply new class
            });
        } else {
            contentEl.createEl('div', {
                text: `Found ${rootSubfolderCount} subfolder${rootSubfolderCount === 1 ? '' : 's'}`,
                cls: 'tubesage-folder-picker-status-info' // Apply new class
            });
        }
        
        // Create search input
        const searchEl = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Filter folders...',
            cls: 'folder-search-input'
        });
        searchEl.focus();
        
        // Create folder list container
        const folderListEl = contentEl.createEl('div', { cls: 'folder-list' });
        
        // Track the currently selected folder item
        let selectedItem: HTMLElement | null = null;
        
        // Function to select a folder item
        const selectFolderItem = (item: HTMLElement) => {
            if (selectedItem) {
                selectedItem.classList.remove('selected');
            }
            item.classList.add('selected');
            selectedItem = item;
        };
        
        // Function to render folders with filter
        const renderFolders = (filter: string = '') => {
            folderListEl.empty();
            
            // Use native JS filter to work directly with folder objects
            const lowerFilter = filter.toLowerCase().trim();
            
            // Filter if needed, otherwise show all
            const foldersToShow = !lowerFilter ? this.folders : 
                this.folders.filter(f => f.path.toLowerCase().includes(lowerFilter));
            
            logger.debug(`Displaying ${foldersToShow.length} folders`);
            
            if (foldersToShow.length === 0) {
                folderListEl.createEl('div', {
                    text: 'No matching folders',
                    cls: 'empty-state'
                });
                return;
            }
            
            // Create HTML elements for each folder
            foldersToShow.forEach((folder, index) => {
                const folderEl = folderListEl.createEl('div', {
                    cls: 'folder-item',
                    attr: {
                        'data-path': folder.path,
                        'tabindex': '0'
                    }
                });
                
                // Auto-select the first item
                if (index === 0) {
                    selectFolderItem(folderEl);
                }
                
                // Add folder icon
                const iconEl = folderEl.createEl('span', { cls: 'folder-icon' });
                iconEl.setText('📁');
                
                // For the root folder
                if (folder.path === normalizedRootFolder) {
                    folderEl.createEl('span', {
                        text: rootFolder,
                        cls: 'folder-path'
                    });
                }
                // For subfolders under root folder
                else {
                    // Get the full path without the leading slash using our utility
                    const displayPath = normalizePath(folder.path);
                    
                    // Create the display span with the full path
                    const textSpan = folderEl.createEl('span', {
                        cls: 'folder-path'
                    });
                    
                    // Set the text with the full path
                    textSpan.textContent = displayPath;
                }
                
                // Add click handler
                folderEl.addEventListener('click', () => {
                    selectFolderItem(folderEl);
                    this.selectFolder(folder.path);
                });
            });
        };
        
        // Initial render
        renderFolders('');
        
        // Filter as user types
        searchEl.addEventListener('input', () => {
            renderFolders(searchEl.value);
        });
        
        // Handle keyboard navigation
        searchEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.close();
            } else if (e.key === 'Enter') {
                if (selectedItem) {
                    selectedItem.click();
                } else {
                    const firstFolder = folderListEl.querySelector('.folder-item');
                    if (firstFolder) {
                        (firstFolder as HTMLElement).click();
                    } else {
                        // Close the modal if no folders are found
                        this.close();
                    }
                }
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                
                const items = Array.from(folderListEl.querySelectorAll('.folder-item'));
                if (items.length === 0) return;
                
                const curIndex = selectedItem ? items.indexOf(selectedItem) : -1;
                
                let newIndex;
                if (e.key === 'ArrowDown') {
                    newIndex = curIndex < items.length - 1 ? curIndex + 1 : 0;
                } else {
                    newIndex = curIndex > 0 ? curIndex - 1 : items.length - 1;
                }
                
                selectFolderItem(items[newIndex] as HTMLElement);
                items[newIndex].scrollIntoView({ block: 'nearest' });
            }
        });
    }
    
    private selectFolder(folderPath: string) {
        // Normalize the folder path - store WITHOUT leading slash for consistency
        const normalizedPath = normalizePath(folderPath);
        logger.debug("[DEBUG] Selected folder path:", folderPath);
        logger.debug("[DEBUG] Normalized folder path:", normalizedPath);
        this.onSelectFolder(normalizedPath);
        this.close();
    }
}

// Add the LicenseModal class
class LicenseModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.addClass('tubesage-license-modal-size');
        }
        
        contentEl.createEl('h2', { text: 'Tubesage YouTube transcript plugin license' });

        // Run async work without returning a promise to Modal
        void (async () => {
        try {
            // Get the plugin folder path
            const pluginId = getPluginIdFromManifest(this.app, 'tubesage');
            
            // Try to read the license file - from multiple possible locations
            let licenseContent = '';
            let licenseFound = false;
            
            // List of possible file paths to try - use platform-independent paths with forward slashes
            const possiblePaths = [
                // Plugin directory paths
                `${this.app.vault.configDir}/plugins/${pluginId}/MIT-license-tubesage.md`,
                `${this.app.vault.configDir}/plugins/${pluginId}/LICENSE.md`,
                `${this.app.vault.configDir}/plugins/${pluginId}/license.md`,
                
                // Root directory paths
                `MIT-license-tubesage.md`,
                `LICENSE.md`,
                `license.md`
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    // Always normalize path before reading to ensure consistent slashes
                    const normalizedPath = normalizePath(filePath);
                    logger.debug(`Trying to find license file at: ${normalizedPath}`);
                    licenseContent = await this.app.vault.adapter.read(normalizedPath);
                    logger.debug(`License file found at: ${normalizedPath}`);
                    licenseFound = true;
                    break;
                } catch (e) {
                    logger.debug(`Failed to read license file at ${filePath}:`, e);
                    // Continue to next path
                }
            }
            
            if (!licenseFound) {
                throw new Error('Could not find license file in any of the expected locations.');
            }
            
            // Create a div for the license content with scrollable style (original inline style)
            const licenseContainer = contentEl.createEl('div', {
                attr: {
                    style: 'max-height: 500px; overflow-y: auto; padding: 20px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-top: 10px; white-space: pre-wrap; font-family: var(--font-monospace); line-height: 1.5;'
                }
            });
            
            // Process the license markdown content
            const lines = licenseContent.split('\n');
            let inList = false;
            
            for (const line of lines) {
                // Handle headers
                if (line.startsWith('# ')) {
                    inList = false;
                    licenseContainer.createEl('h3', { text: line.substring(2), cls: 'tubesage-license-h3' });
                }
                // Handle list items
                else if (line.match(/^\d+\.\s+\*\*.*\*\*/)) {
                    inList = true;
                    const listItem = licenseContainer.createEl('div', { cls: 'tubesage-license-list-item' });
                    
                    // Extract and format the list item
                    const match = line.match(/^(\d+)\.\s+\*\*(.*?)\*\*:\s+(.*)/);
                    if (match) {
                        const [, number, title, content] = match;
                        
                        listItem.createEl('span', { text: `${number}. `, cls: 'tubesage-license-list-item-title-segment' });
                        
                        listItem.createEl('span', { text: `${title}: `, cls: 'tubesage-license-list-item-title-segment' });
                        
                        listItem.createSpan({ text: content });
                    } else {
                        listItem.setText(line);
                    }
                }
                // Handle list sub-items
                else if (inList && line.match(/^\s+-\s+/)) {
                    const subItem = licenseContainer.createEl('div', { cls: 'tubesage-license-sub-item' });
                    subItem.setText(line.replace(/^\s+-\s+/, '• '));
                }
                // Handle normal paragraphs
                else if (line.trim() !== '') {
                    inList = false;
                    licenseContainer.createEl('p', { text: line, cls: 'tubesage-license-paragraph' });
                }
                // Handle empty lines
                else {
                    licenseContainer.createEl('div', { cls: 'tubesage-license-spacer' });
                }
            }
        } catch (error) {
            // Handle error if license file can't be read
            logger.error('Error loading license file:', error);
            contentEl.createEl('p', { 
                text: 'Could not load license file. Please check that a license file exists in your plugin directory.',
                cls: 'tubesage-license-load-error' // Apply new class
            });
        }
        
        // Add close button
        const footerEl = contentEl.createEl('div', {
            cls: 'tubesage-license-footer' // Apply new class
        });
        
        const closeButton = footerEl.createEl('button', {
            text: 'Close',
            cls: 'tubesage-license-close-button' // Apply new class
        });
        
        closeButton.addEventListener('click', () => {
            this.close();
        });
        })();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the LicenseRequiredModal class
class LicenseRequiredModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.addClass('tubesage-license-required-modal-size');
        }
        
        // Add title
        contentEl.createEl('h2', { 
            text: 'License acceptance required', 
            cls: 'tubesage-license-required-title' // Apply new class
        });
        
        // Add warning icon
        const iconContainer = contentEl.createEl('div', { 
            cls: 'tubesage-license-required-icon-container' // Apply new class
        });
        
        iconContainer.createEl('span', { 
            cls: 'tubesage-license-required-icon', // Apply new class
            attr: { 'aria-hidden': 'true' },
            text: '⚠️'
        });
        
        // Add message
        const messageDiv = contentEl.createEl('div', {
            cls: 'tubesage-license-required-message-container' // Apply new class
        });
        
        messageDiv.createEl('p', {
            text: 'You must accept the plugin license before using this feature.',
            cls: 'tubesage-license-required-message-bold' // Apply new class
        });
        
        messageDiv.createEl('p', {
            text: 'Please go to the plugin settings and accept the license terms to continue.'
        });
        
        // Add instructions with steps
        const stepsDiv = contentEl.createEl('div', {
            cls: 'tubesage-license-required-steps-container' // Apply new class
        });
        
        stepsDiv.createEl('p', {
            text: 'How to accept the license:',
            cls: 'tubesage-license-required-steps-title' // Apply new class
        });
        
        const steps = [
            'Open Obsidian Settings',
            'Scroll down to the "Community Plugins" section in the sidebar',
            'Find "Tubesage" in the Community Plugins list',
            'Click the "Tubesage" plugin settings',
            'Toggle "Accept License" to enable the plugin'
        ];
        
        const stepsList = stepsDiv.createEl('ol', {
            cls: 'tubesage-license-required-steps-list' // Apply new class
        });
        
        steps.forEach(step => {
            stepsList.createEl('li', {
                text: step,
                cls: 'tubesage-license-required-step-item' // Apply new class
            });
        });
        
        // Add buttons
        const buttonContainer = contentEl.createEl('div', {
            cls: 'tubesage-license-required-button-container' // Apply new class
        });
        
        // Open settings button
        const openSettingsButton = buttonContainer.createEl('button', {
            text: 'Open plugin settings',
            cls: 'tubesage-license-required-button-primary' // Apply new class
        });
        
        // Close button
        const closeButton = buttonContainer.createEl('button', {
            text: 'Close',
            cls: 'tubesage-license-required-button-secondary' // Apply new class
        });
        
        // Add event listeners
        openSettingsButton.addEventListener('click', () => {
            this.close();
            const appWithSettings = this.app as App & { setting?: { open?: (id: string) => void } };
            appWithSettings.setting?.open?.('tubesage');
        });
        
        closeButton.addEventListener('click', () => {
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the READMEModal class
class READMEModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.addClass('tubesage-readme-modal-size');
        }
        
        contentEl.createEl('h2', { text: 'Tubesage YouTube transcript plugin documentation' });

        // Run async work without returning a promise to Modal
        void (async () => {
        try {
            // Get the plugin folder path
            const pluginId = getPluginIdFromManifest(this.app, 'tubesage');
            
            // Try to read the README file from multiple possible locations
            let readmeContent = '';
            let readmeFound = false;
            
            // List of possible file paths to try - use platform-independent paths with forward slashes
            const possiblePaths = [
                // Plugin directory paths
                `${this.app.vault.configDir}/plugins/${pluginId}/README.md`,
                `${this.app.vault.configDir}/plugins/${pluginId}/readme.md`,
                
                // Root directory paths
                `README.md`,
                `readme.md`
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    // Always normalize path before reading to ensure consistent slashes
                    const normalizedPath = normalizePath(filePath);
                    logger.debug(`Trying to find README file at: ${normalizedPath}`);
                    readmeContent = await this.app.vault.adapter.read(normalizedPath);
                    logger.debug(`README file found at: ${normalizedPath}`);
                    readmeFound = true;
                    break;
                } catch (e) {
                    logger.debug(`Failed to read README file at ${filePath}:`, e);
                    // Continue to next path
                }
            }
            
            if (!readmeFound) {
                throw new Error('Could not find readme file in any of the expected locations.');
            }
            
            // Create a div for the README content with scrollable style (original inline style)
            const readmeContainer = contentEl.createEl('div', {
                attr: {
                    style: 'max-height: 550px; overflow-y: auto; padding: 20px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-top: 10px; white-space: pre-wrap; font-family: var(--font-interface); line-height: 1.6;'
                }
            });
            
            // Process the README markdown content
            const lines = readmeContent.split('\n');
            let inCodeBlock = false;
            let codeLanguage = '';
            
            for (const line of lines) {
                // Handle code blocks
                if (line.startsWith('```')) {
                    if (!inCodeBlock) {
                        // Start of code block
                        inCodeBlock = true;
                        codeLanguage = line.substring(3).trim();
                        
                        // Create code block container
                        const codeContainer = readmeContainer.createEl('div', {
                            cls: 'code-block-container' // Style now in CSS
                        });
                        
                        // Add language tag if specified
                        if (codeLanguage) {
                            codeContainer.createEl('div', {
                                text: codeLanguage,
                                cls: 'tubesage-readme-code-lang' // Apply new class
                            });
                        }
                        
                        // Create pre>code element for the code
                        const pre = codeContainer.createEl('pre', {
                            cls: 'tubesage-readme-code-pre' // Apply new class
                        });
                        pre.createEl('code', {
                            cls: `tubesage-readme-code-inline ${codeLanguage ? 'language-' + codeLanguage : ''}`.trim() // Apply new class and existing language class
                        });
                    } else {
                        // End of code block
                        inCodeBlock = false;
                        codeLanguage = '';
                    }
                    continue;
                }
                
                // Add lines to code block
                if (inCodeBlock) {
                    const codeContainer = readmeContainer.querySelector('.code-block-container:last-child');
                    if (codeContainer) {
                        const code = codeContainer.querySelector('code');
                        if (code) {
                            const textNode = document.createTextNode(line + '\n');
                            code.appendChild(textNode);
                        }
                    }
                    continue;
                }
                
                // Handle headers
                if (line.startsWith('# ')) {
                    readmeContainer.createEl('h1', { text: line.substring(2), cls: 'tubesage-readme-h1' });
                } else if (line.startsWith('## ')) {
                    readmeContainer.createEl('h2', { text: line.substring(3), cls: 'tubesage-readme-h2' });
                } else if (line.startsWith('### ')) {
                    readmeContainer.createEl('h3', { text: line.substring(4), cls: 'tubesage-readme-h3' });
                } else if (line.startsWith('#### ')) {
                    readmeContainer.createEl('h4', { text: line.substring(5), cls: 'tubesage-readme-h4' });
                }
                // Handle list items
                else if (line.match(/^[*+-]\s/)) {
                    const listItem = readmeContainer.createEl('div', { cls: 'tubesage-readme-list-item' });
                    
                    // Bullet
                    listItem.createEl('span', { text: '• ', cls: 'tubesage-readme-list-bullet' });
                    
                    // Content
                    const content = line.replace(/^[*+-]\s/, '');
                    if (content.includes('[') && content.includes('](')) {
                        // Handle links in list items
                        const parts = this.splitMarkdownLink(content);
                        const contentSpan = listItem.createEl('span');
                        
                        parts.forEach(part => {
                            if (part.isLink) {
                                contentSpan.createEl('a', {
                                    text: part.text,
                                    attr: {
                                        href: part.url || '#',
                                        cls: 'tubesage-readme-link' // Apply new class
                                    }
                                });
                            } else {
                                // Process bold text in list items
                                this.renderTextWithBold(contentSpan, part.text);
                            }
                        });
                    } else {
                        // Process bold text in list items
                        this.renderTextWithBold(listItem, content);
                    }
                }
                // Handle normal paragraphs
                else if (line.trim() !== '') {
                    const para = readmeContainer.createEl('p', { cls: 'tubesage-readme-paragraph' });
                    
                    // Check for links
                    if (line.includes('[') && line.includes('](')) {
                        const parts = this.splitMarkdownLink(line);
                        
                        parts.forEach(part => {
                            if (part.isLink) {
                                para.createEl('a', {
                                    text: part.text,
                                    attr: {
                                        href: part.url || '#',
                                        cls: 'tubesage-readme-link' // Apply new class
                                    }
                                });
                            } else {
                                // Process bold text in paragraphs
                                this.renderTextWithBold(para, part.text);
                            }
                        });
                    } else {
                        // Process bold text in paragraphs
                        this.renderTextWithBold(para, line);
                    }
                }
                // Handle empty lines with more spacing between sections
                else {
                    readmeContainer.createEl('div', { cls: 'tubesage-readme-spacer' });
                }
            }
        } catch (error) {
            // Handle error if README file can't be read
            logger.error('Error loading README file:', error);
            contentEl.createEl('p', { 
                text: 'Could not load readme file. Please check that readme.md exists in your plugin directory.',
                cls: 'tubesage-license-load-error' // Assumes this class is defined and appropriate
            });
        }
        
        // Add close button
        const footerEl = contentEl.createEl('div', {
            cls: 'tubesage-license-footer' // Reuse existing class
        });
        
        const closeButton = footerEl.createEl('button', {
            text: 'Close',
            cls: 'tubesage-readme-close-button' // Apply new class for README modal specifically
        });
        
        closeButton.addEventListener('click', () => {
            this.close();
        });
        })();
    }
    
    // Helper to handle markdown links
    private splitMarkdownLink(text: string): Array<{text: string, url?: string, isLink: boolean}> {
        const parts: Array<{text: string, url?: string, isLink: boolean}> = [];
        let remaining = text;
        let currentIndex = 0;
        
        // First check for image links inside regular links - pattern: [![alt](image-url)](link-url)
        const imageInsideLinkRegex = /\[!\[(.*?)\]\((.*?)\)\]\((.*?)\)/g;
        let match;

        // Process all image+link combinations first
        while ((match = imageInsideLinkRegex.exec(remaining)) !== null) {
            // Add text before the image+link
            if (match.index > currentIndex) {
                parts.push({
                    text: remaining.substring(currentIndex, match.index),
                    isLink: false
                });
            }
            
            // Extract the link components: alt text, image URL, and target URL
            const [fullMatch, altText, , targetUrl] = match;
            
            // Add as a link (we'll ignore the image and just use the alt text)
            parts.push({
                text: altText || "Link",
                url: targetUrl,
                isLink: true
            });
            
            // Update the current index
            currentIndex = match.index + fullMatch.length;
        }
        
        // If we processed any image+link combinations, update remaining text
        if (currentIndex > 0) {
            remaining = remaining.substring(currentIndex);
            currentIndex = 0;
        }
        
        // Now process regular links as before
        while (currentIndex < remaining.length) {
            // Skip image links - they're not clickable by themselves
            const imageMatch = remaining.indexOf('![', currentIndex);
            if (imageMatch !== -1 && (imageMatch === currentIndex || remaining.charAt(imageMatch-1) !== '\\')) {
                // Find the closing parenthesis for the image
                const closingParen = remaining.indexOf(')', imageMatch);
                if (closingParen !== -1) {
                    // Add text before the image
                    if (imageMatch > currentIndex) {
                        parts.push({
                            text: remaining.substring(currentIndex, imageMatch),
                            isLink: false
                        });
                    }
                    
                    // Skip the image and continue parsing after it
                    currentIndex = closingParen + 1;
                    continue;
                }
            }
            
            // Find opening bracket for regular links
            const openBracketIndex = remaining.indexOf('[', currentIndex);
            
            // No more links, add the rest as plain text
            if (openBracketIndex === -1) {
                parts.push({
                    text: remaining.substring(currentIndex),
                    isLink: false
                });
                break;
            }
            
            // Make sure this is not an escaped bracket or part of an image
            const isEscaped = openBracketIndex > 0 && remaining.charAt(openBracketIndex - 1) === '\\';
            const isImage = openBracketIndex > 0 && remaining.charAt(openBracketIndex - 1) === '!';
            
            if (isEscaped || isImage) {
                // Add text up to and including this bracket, then continue
                parts.push({
                    text: remaining.substring(currentIndex, openBracketIndex + 1),
                    isLink: false
                });
                currentIndex = openBracketIndex + 1;
                continue;
            }
            
            // Add text before the link
            if (openBracketIndex > currentIndex) {
                parts.push({
                    text: remaining.substring(currentIndex, openBracketIndex),
                    isLink: false
                });
            }
            
            // Find closing bracket and opening parenthesis
            const closeBracketIndex = remaining.indexOf(']', openBracketIndex);
            if (closeBracketIndex === -1) {
                // Malformed link, treat as text
                parts.push({
                    text: remaining.substring(openBracketIndex),
                    isLink: false
                });
                break;
            }
            
            // Check for opening parenthesis immediately after closing bracket
            if (remaining.charAt(closeBracketIndex + 1) !== '(') {
                // Not a link, just brackets
                parts.push({
                    text: remaining.substring(openBracketIndex, closeBracketIndex + 1),
                    isLink: false
                });
                currentIndex = closeBracketIndex + 1;
                continue;
            }
            
            // Find closing parenthesis
            const closeParenIndex = remaining.indexOf(')', closeBracketIndex);
            if (closeParenIndex === -1) {
                // Malformed link, treat as text
                parts.push({
                    text: remaining.substring(openBracketIndex),
                    isLink: false
                });
                break;
            }
            
            // Extract link text and URL
            const linkText = remaining.substring(openBracketIndex + 1, closeBracketIndex);
            const linkUrl = remaining.substring(closeBracketIndex + 2, closeParenIndex);
            
            parts.push({
                text: linkText,
                url: linkUrl,
                isLink: true
            });
            
            currentIndex = closeParenIndex + 1;
        }
        
        return parts;
    }
    
    // Helper to render text with bold formatting
    private renderTextWithBold(container: HTMLElement, text: string): void {
        // Split by bold markers
        const parts = text.split(/(\*\*.*?\*\*)/g);
        
        for (const part of parts) {
            // Check if this part is bold (surrounded by **)
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                // Extract the text between ** markers and create a bold element
                const boldText = part.substring(2, part.length - 2);
                container.createEl('strong', { text: boldText });
            } else if (part.trim() !== '') {
                // Regular text
                container.createSpan({ text: part });
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the TemplateViewModal class
class TemplateViewModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.addClass('tubesage-template-view-modal-size');
        }
        
            contentEl.createEl('h2', { 
                text: 'Example template: copy and place in your templater plugin specified template directory',
            cls: 'tubesage-template-view-title'
        });

        // Run async work without returning a promise to Modal
        void (async () => {
        try {
            // Get the plugin folder path
            const pluginId = getPluginIdFromManifest(this.app, 'tubesage');
            
            // Try to read the template file from multiple possible locations
            let templateContent = '';
            let templateFound = false;
            
            // List of possible file paths to try
            const possiblePaths = [
                // Plugin directory paths
                normalizePath(`${this.app.vault.configDir}/plugins/${pluginId}/templates/YouTubeTranscript.md`),
                normalizePath(`${this.app.vault.configDir}/plugins/${pluginId}/templates/youtubeTranscript.md`),
                
                // Standard templates directory paths
                normalizePath('templates/YouTubeTranscript.md'),
                normalizePath('templates/youtubeTranscript.md'),
                normalizePath('Templates/YouTubeTranscript.md'),
                normalizePath('Templates/youtubeTranscript.md')
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    logger.debug(`Trying to find template file at: ${filePath}`);
                    templateContent = await this.app.vault.adapter.read(filePath);
                    logger.debug(`Template file found at: ${filePath}`);
                    templateFound = true;
                    break;
                } catch (error) {
                    logger.debug(`Failed to read template file at ${filePath}:`, error);
                    // Continue to next path
                }
            }
            
            if (!templateFound) {
                throw new Error('Could not find template file in any of the expected locations.');
            }
            
            // Create a div for the template content with scrollable style (original inline style)
            const templateContainer = contentEl.createEl('div', {
                attr: {
                    style: 'max-height: 250px; overflow-y: auto; padding: 20px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-top: 10px; white-space: pre-wrap; font-family: var(--font-monospace); line-height: 1.5;'
                }
            });
            
            // Add a subtle separator line for spacing
            contentEl.createEl('div', {
                attr: { style: 'height:1px; background: var(--background-modifier-border); margin: 12px 0;' }
            });
            
            // Create a container for the copy button
            const copyContainer = contentEl.createEl('div', {
                cls: 'tubesage-template-view-copy-container',
                attr: { style: 'display:flex; justify-content:flex-end; width:100%; margin-left:auto;' }
            });
            
            // Add copy text
            copyContainer.createEl('span', { 
                text: 'Copy template',
                cls: 'tubesage-template-view-copy-text'
            });
            
            // Copy icon button
            const copyButton = copyContainer.createEl('button', {
                cls: 'tubesage-icon-button' // Reuse existing class
            });
            
            // Create an SVG for the copy icon
            const svgNamespace = "http://www.w3.org/2000/svg";
            const copySvg = document.createElementNS(svgNamespace, "svg");
            copySvg.setAttrs({
                viewBox: "0 0 24 24",
                width: "16",
                height: "16",
                stroke: "currentColor",
                fill: "none",
                'stroke-width': "2",
                'stroke-linecap': "round",
                'stroke-linejoin': "round"
            });
            
            // Create the copy icon paths
            const copyRect = document.createElementNS(svgNamespace, "rect");
            copyRect.setAttrs({ x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" });
            copySvg.appendChild(copyRect);
            
            const copyPath = document.createElementNS(svgNamespace, "path");
            copyPath.setAttr("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
            copySvg.appendChild(copyPath);
            
            // Add the SVG to the button
            copyButton.appendChild(copySvg);
            
            // Add hover effect
            copyButton.addEventListener('mouseenter', () => {
                copyButton.addClass('tubesage-icon-button-hover'); // Reuse hover class logic
            });
            
            copyButton.addEventListener('mouseleave', () => {
                copyButton.removeClass('tubesage-icon-button-hover'); // Reuse hover class logic
            });
            
            // Make the text also clickable
            const copyTextElement = copyContainer.querySelector('span');
            
            // Function to handle copy
            const handleCopy = () => {
                navigator.clipboard.writeText(templateContent)
                    .then(() => {
                        // Show success state
                        if (copyTextElement) {
                            const originalText = copyTextElement.textContent;
                            copyTextElement.textContent = 'Copied';
                            setTimeout(() => {
                                copyTextElement.textContent = originalText;
                            }, 2000);
                        }
                    })
                    .catch(err => {
                        logger.error('Failed to copy template:', err);
                        // Show error state
                        if (copyTextElement) {
                            copyTextElement.textContent = 'Failed to copy';
                            setTimeout(() => {
                                copyTextElement.textContent = 'Copy template';
                            }, 2000);
                        }
                    });
            };
            
            // Add click handlers to both text and button
            copyButton.addEventListener('click', handleCopy);
            if (copyTextElement) {
                copyTextElement.addEventListener('click', handleCopy);
            }
            
            // Display the content with syntax highlighting
            templateContainer.createEl('pre', {
                cls: 'language-markdown',
                text: templateContent
            });
            
            // Add explanation
            contentEl.createEl('div', {
                text: 'This is the example templater plugin template used for YouTube transcript notes. You can customize this template for your own needs.',
                cls: 'tubesage-template-view-explanation'
            });
            
            // Add Templater variables explanation
            const variablesContainer = contentEl.createEl('div', {
                cls: 'tubesage-template-view-variables-container'
            });
            
            variablesContainer.createEl('h3', {text: 'Available template variables:'});
            
            const variables = [
                {name: 'tp.user.title', desc: 'The title of the Youtube video'},
                {name: 'tp.user.videoUrl', desc: 'The URL of the Youtube video'},
                {name: 'tp.user.transcript', desc: 'The full transcript with timestamps'},
                {name: 'tp.user.summary', desc: 'The LLM-generated summary of the video'},
                {name: 'tp.user.llmProvider', desc: 'The LLM provider used (e.g., openai, anthropic)'},
                {name: 'tp.user.llmModel', desc: 'The specific model used (e.g., gpt-4, claude-3-opus)'},
                {name: 'tp.user.llmTags', desc: 'Tags generated from the LLM provider and model'}
            ];
            
            const varList = variablesContainer.createEl('ul');
            variables.forEach(v => {
                const item = varList.createEl('li');
                item.createEl('code', {text: v.name});
                item.createSpan({text: ` - ${v.desc}`});
            });
        } catch (error) {
            // Handle error if template file can't be read
            logger.error('Error loading template file:', error);
            contentEl.createEl('p', { 
                text: 'Could not load template file. Please check that the template exists in your plugin directory or vault templates folder.',
                cls: 'tubesage-license-load-error' // Reuse existing class for error messages
            });
        }
        
        // Add close button
        const footerEl = contentEl.createEl('div', {
            cls: 'tubesage-license-footer', // Reuse existing class
            attr: { style: 'display:flex; justify-content:flex-end; width:100%;' }
        });
        
        const closeButton = footerEl.createEl('button', {
            text: 'Close',
            cls: 'tubesage-license-close-button' // Reuse existing class
        });
        
        closeButton.addEventListener('click', () => {
            this.close();
        });
        })();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add this interface at the top of the file after the existing imports
