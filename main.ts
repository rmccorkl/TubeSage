import { App, Plugin, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import { YouTubeTranscriptExtractor } from './src/youtube-transcript';
import { TranscriptSummarizer } from './src/llm/transcript-summarizer';
import { sanitizeFilename } from './src/utils/filename-sanitizer';
import { stopLocalProxy, setPluginPath } from './src/proxy/anthropic-proxy';
// Import the new utility functions
import { isYoutubeUrl, isYoutubeChannelOrPlaylistUrl, extractChannelName, showNotice as showUtilityNotice } from './src/utils/youtube-utils';
// Import error handling utilities
import { handleApiError, getSafeErrorMessage } from './src/utils/error-utils';
// Import logger
import { getLogger, LogLevel, setGlobalLogLevel } from './src/utils/logger';
// Import path utilities
import { normalizePath, ensureFolder, joinPaths, sanitizePathComponent } from './src/utils/path-utils';
// Import form utilities
import { validateRequired, validateYouTubeUrl, validateInputField, ValidationResult, displayValidationResult } from './src/utils/form-utils';
// Import prompt utilities
import { getPromptConfig, cleanTranscript, SummaryMode, PromptConfig, getTimestampLinkConfig } from './src/utils/prompt-utils';
// Import timestamp utilities
import { 
    extractDocumentComponents, 
    reconstructDocument, 
    validateEnhancedContent, 
    createOptimizedChunks,
    countTimestampLinks,
    ensureTrailingNewline,
    hasProperHeading,
    hasTimestampLinks,
    convertTimestampToSeconds
} from './src/utils/timestamp-utils';
import path from 'path';
import fs from 'fs';


// Initialize logger
const logger = getLogger('PLUGIN');
const transcriptLogger = getLogger('TRANSCRIPT');
const llmLogger = getLogger('LLM');

// Define a minimal folder item interface
interface FolderItem {
    path: string;
    name: string;
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
        ollama: 'llama3'
    },
    temperature: 0.7,
    maxTokens: 1000,
    
    // Short (Fast) Summary prompt
    systemPrompt: `You are a helpful assistant that summarizes YouTube transcripts clearly and concisely using Markdown.`,
    userPrompt: `Please summarize the following YouTube transcript. Extract key points, main ideas, and important details. 
FORMAT USING PROPER MARKDOWN HEADINGS with # syntax (not bold text).
Specifically: 
1. Use "# " for main headings
2. Use "## " for subheadings 
3. Use "### " for section headings with numbers (e.g., "### 1. Introduction")
4. Do NOT use bold text (**text**) for headings
5. Use bullet points for lists
This document will be processed as Markdown for Obsidian, so proper heading syntax is essential.
Provide only the summary notes.
Do not explain what you're doing or include any introductory sentence.
Start the output with the actual summary content only, no headers or preamble.
At the beginning, include a summary without heading or title just the text that synthesizes the on the main themes of the transcript
At the end, list any books, people, or resources mentioned, along with a short explanation of their relevance.`,
    
    // Extensive Summary prompt
    extensiveSystemPrompt: 'You are a highly analytical assistant that produces comprehensive, structured, and insightful notes from transcripts in proper Obsidian Markdown format. You specialize in creating deep, paragraph-level breakdowns of complex material with clarity and nuance. Your notes help readers understand both what is said and the reasoning or implications behind it. The objective is to extract all meaningful content, ideas, and knowledge from the transcript so that a reader can fully understand and review the material through structured notes without needing to watch or re-watch the video. IMPORTANT: Always use proper Markdown heading syntax with # characters (not bold text) for all headings and section titles.',
    extensiveUserPrompt: `From the transcript below, create detailed and structured notes for someone who wants to understand the material in depth.
Organize the content into clearly numbered sections based on major topic or theme changes. 
Please summarize the following YouTube transcript. Extract key points, main ideas, and important details. 
FORMAT USING PROPER MARKDOWN HEADINGS with # syntax (not bold text).
Specifically:
1. Use "# " for main headings
2. Use "## " for subheadings
3. Use "### " for section headings with numbers (e.g., "### 1. Introduction")
4. Do NOT use bold text (**text**) for headings
5. Use bullet points for lists

This document will be processed as Markdown for Obsidian, so proper heading syntax is essential. Treat this as a document for training future analysts in this field.
Provide only the summary notes.
Do not explain what you're doing or include any introductory sentence.
Start the output with the actual summary content only, no headers or preamble.

For each section:
- Use the exact heading format "### 1. Title" (not "### Section 1: Title"). Number sections sequentially (1, 2, 3, etc.). IMPORTANT: Use actual Obsidian Markdown heading syntax with # symbols, not bold text.
- Write multiple detailed paragraphs, that explain the content and any theory, technical terms or definitions, models and frameworks thoroughly and in great detail drawn from the transcript.
- Include below the paragraphs key concepts, terms, taxonomy, ontology , or ideas, and explain them clearly with examples where relevant.
- Incorporate and explain important quotations direct from subject (person) , analogies, or references.
- Explore the reasoning, implications, or broader significance behind the ideas.
- Explicitly identify and analyze any contrasts, tensions, contradictions, or shifts in perspective throughout the discussion. Pay special attention to dialectical relationships between concepts.

At the beginning, include a summary without heading or title just the text that synthesizes the on the main themes of the transcript.

At the end, list any books, people, or resources mentioned, along with a short explanation of their relevance.`,
    
    // Second pass - timestamp linking prompt
    timestampSystemPrompt: 'You are a highly precise assistant that adds YouTube timestamp links to section headings in a note and can translate content into other languages when requested.',
    timestampUserPrompt: `TASK: Add YouTube timestamp links to each section heading in this document.

RULES:
1. NEVER summarize or modify the content unless translation is requested
2. NEVER remove any content
3. ALWAYS return the FULL original content PLUS timestamp links at the end of section headings
4. If processing multiple sections, add timestamps to ALL headings
5. ONLY process headings that follow the format: # number. text (e.g., # 1. Introduction)
6. DO NOT process headings without numbers or dots
7. DO NOT process horizontal rules (single #)

EXACTLY HOW TO DO THIS:
1. Identify ALL section headings in the document that follow the format: # number. text
2. Look at the transcript which has timestamps in format: [HH:MM:SS] [TimeIndex:X] where X is the exact seconds value
3. For each section heading, CAREFULLY ANALYZE THE CONTENT OF THAT SECTION first to understand its main topic
4. Then find where in the transcript this topic is BEST SUBSTANTIVELY DISCUSSED
5. When matching the best section heading to the transcript segments:
   - Focus on semantic meaning of the section (topic), not just keyword matching
   - Simply use the TimeIndex value from the relevant transcript section
   - Example: If you find the relevant transcript section has [TimeIndex:175], use t=175 in the link
   - DO NOT calculate seconds manually - just use the TimeIndex value directly
   - IMPORTANT: Only use TimeIndex values that actually appear in the transcript
   - ENSURE the TimeIndex value does not exceed the length of the video
6. Add the timestamp link in the format: [Watch](https://www.youtube.com/watch?v=VIDEO_ID&t=TimeIndex)
7. Place the link at the end of the heading line, after the heading text

EXAMPLE:
Original heading: # 1. Introduction
Relevant transcript: [00:01:15] [TimeIndex:75] This is the introduction...
Modified heading: # 1. Introduction [Watch](https://www.youtube.com/watch?v=VIDEO_ID&t=75)

Original heading: ## 2. Main Topic
Relevant transcript: [00:03:00] [TimeIndex:180] Here we discuss the main topic...
Modified heading: ## 2. Main Topic [Watch](https://www.youtube.com/watch?v=VIDEO_ID&t=180)`,
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
};

// Add this new function to check Node.js availability
export async function checkNodeAvailability(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'where node' : 'which node';
        
        require('child_process').exec(command, (error: any, stdout: string) => {
            if (!error && stdout) {
                // Node.js found in PATH
                console.log(`Node.js found in PATH: ${stdout.trim()}`);
                resolve(true);
                return;
            }
            
            // Check common installation locations as a fallback
            const commonPaths = isWindows 
                ? [
                    'C:\\Program Files\\nodejs\\node.exe', 
                    'C:\\Program Files (x86)\\nodejs\\node.exe',
                    'C:\\nodejs\\node.exe',
                    `${process.env.APPDATA}\\npm\\node.exe`,
                    `${process.env.LOCALAPPDATA}\\npm\\node.exe`
                ]
                : [
                    '/usr/local/bin/node', 
                    '/usr/bin/node', 
                    '/opt/homebrew/bin/node',
                    '/opt/local/bin/node',
                    '/opt/bin/node'
                ];
            
            console.log(`Checking for Node.js in common locations: ${JSON.stringify(commonPaths)}`);
            
            // Try to find node.js executable in common paths
            for (const nodePath of commonPaths) {
                try {
                    if (require('fs').existsSync(nodePath)) {
                        // Node.js found in common location
                        console.log(`Node.js found at: ${nodePath}`);
                        resolve(true);
                        return;
                    }
                } catch (e) {
                    console.error(`Error checking path ${nodePath}:`, e);
                }
            }
            
            // Node.js not found
            console.log("Node.js not found in PATH or common locations");
            resolve(false);
        });
    });
}

export default class YouTubeTranscriptPlugin extends Plugin {
    settings: YouTubeTranscriptSettings;
    private summarizer: TranscriptSummarizer;
    private fileWatcher: any;

    // Replace the duplicated showNotice method with a wrapper that calls the shared utility
    showNotice(message: string, timeout: number = 5000): void {
        showUtilityNotice(message, timeout);
    }

    async onload() {
        await this.loadSettings();
        
        // Set appropriate max tokens based on provider when plugin first loads
        if (this.settings.selectedLLM === 'google') {
            this.settings.maxTokens = 8192;
        } else {
            this.settings.maxTokens = 4096;
        }
        await this.saveSettings();
        
        // Set log level based on settings
        if (this.settings.debugLogging) {
            setGlobalLogLevel(LogLevel.DEBUG);
        } else {
            setGlobalLogLevel(LogLevel.INFO);
        }

        this.initializeSummarizer();
        
        // Variables for plugin path
        let pluginBasePath = '';
        
        // @ts-ignore - Plugin does have manifest property but it's not in the type definition
        const pluginId = this.manifest?.id || 'tubesage';
        
        // Simplified plugin path detection
        try {
            const vaultPath = this.app.vault.adapter.getBasePath();
            
            // The standard Obsidian plugin path
            pluginBasePath = path.join(vaultPath, '.obsidian', 'plugins', pluginId);
            
            logger.info('Setting plugin path:', pluginBasePath);
            setPluginPath(pluginBasePath);
        } catch (error) {
            logger.error('Error setting plugin path:', error);
        }

        this.addSettingTab(new YouTubeTranscriptSettingTab(this.app, this));
        this.checkDependencies();

        // Add CSS for the modal
        const styleEl = document.createElement('style');
        styleEl.id = 'youtube-transcript-styles';
        styleEl.textContent = `
            .youtube-transcript-modal-container,
            .youtube-transcript-form {
                width: 100%;
                padding: 20px;
            }
            
            .youtube-transcript-form .form-group {
                margin-bottom: 15px;
            }
            
            .youtube-transcript-form label {
                display: block;
                margin-bottom: 5px;
                font-weight: 500;
            }
            
            .youtube-transcript-form input {
                width: 100%;
                padding: 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
            }
            
            .youtube-transcript-form .error {
                color: var(--text-error);
                margin-bottom: 15px;
                padding: 8px;
                background: var(--background-modifier-error);
                border-radius: 4px;
            }
            
            .folder-search-input {
                width: 100%;
                padding: 8px;
                margin-bottom: 15px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background-color: var(--background-secondary);
                color: var(--text-normal);
                font-size: 14px;
            }
            
            .folder-picker-subtitle {
                margin-top: -10px;
                margin-bottom: 15px;
                color: var(--text-muted);
                font-size: 0.9em;
                text-align: center;
            }
            
            .folder-list {
                max-height: 300px;
                overflow-y: auto;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                margin-bottom: 15px;
                background-color: var(--background-primary);
            }
            
            .folder-item {
                display: flex;
                align-items: center;
                padding: 5px 10px;
                cursor: pointer;
                border-bottom: 1px solid var(--background-modifier-border);
                font-family: var(--font-interface);
                transition: background-color 0.1s ease;
            }
            
            .folder-item:hover {
                background-color: var(--background-modifier-hover);
            }
            
            .folder-item.selected {
                background-color: var(--background-modifier-hover);
                font-weight: 500;
            }
            
            .folder-icon {
                margin-right: 8px;
                font-size: 16px;
                color: var(--text-accent);
                opacity: 0.8;
            }
            
            .folder-path {
                flex: 1;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-size: 14px;
            }
            
            .empty-state {
                padding: 20px;
                text-align: center;
                color: var(--text-muted);
            }
            
            .instruction-text {
                text-align: center;
                color: var(--text-muted);
                font-size: 0.9em;
                margin-top: 10px;
                margin-bottom: 10px;
            }
            
            .status-container {
                text-align: center;
                padding: 20px;
            }
            
            .status-text {
                margin-bottom: 20px;
                color: var(--text-normal);
            }
            
            .close-button, 
            .back-button {
                display: block;
                width: 100%;
                padding: 8px;
                margin-top: 15px;
                background-color: var(--interactive-accent);
                color: var(--text-on-accent);
                border: none;
                border-radius: 4px;
                cursor: pointer;
            }
            
            .back-button {
                background-color: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .error-message {
                color: var(--text-error);
                margin: 15px 0;
                padding: 8px;
                background: var(--background-modifier-error);
                border-radius: 4px;
            }
            
            /* Toggle switch for summary mode */
            .toggle-container {
                display: flex;
                align-items: center;
                margin: 15px 0;
                padding: 10px;
                background: var(--background-secondary);
                border-radius: 5px;
            }
            
            .toggle-label {
                flex: 1;
                font-size: 14px;
                margin-right: 10px;
            }
            
            .toggle-switch {
                position: relative;
                display: inline-block;
                width: 50px;
                height: 24px;
            }
            
            .toggle-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            
            .toggle-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: var(--background-modifier-border);
                transition: .4s;
                border-radius: 24px;
            }
            
            .toggle-slider:before {
                position: absolute;
                content: "";
                height: 18px;
                width: 18px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .4s;
                border-radius: 50%;
            }
            
            input:checked + .toggle-slider {
                background-color: var(--interactive-accent);
            }
            
            input:checked + .toggle-slider:before {
                transform: translateX(26px);
            }
            
            .summary-info {
                font-size: 12px;
                color: var(--text-muted);
                margin-top: 5px;
                font-style: italic;
            }
            
            /* Pulse animation styles */
            .pulse-container {
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 30px 0;
                height: 40px;
                /* Remove any box-like styling */
                border: none;
                background: none;
                box-shadow: none;
            }
            
            .pulse-bar {
                width: 8px;
                height: 30px;
                margin: 0 3px;
                border-radius: 4px;
                background-color: var(--interactive-accent);
                animation: pulse 1.5s ease-in-out infinite;
                display: inline-block;
            }
            
            .pulse-bar:nth-child(1) { 
                animation-delay: 0s; 
            }
            
            .pulse-bar:nth-child(2) { 
                animation-delay: 0.2s; 
            }
            
            .pulse-bar:nth-child(3) { 
                animation-delay: 0.4s; 
            }
            
            .pulse-bar:nth-child(4) { 
                animation-delay: 0.6s; 
            }
            
            .pulse-bar:nth-child(5) { 
                animation-delay: 0.8s; 
            }
            
            @keyframes pulse {
                0%, 100% { 
                    height: 10px; 
                    opacity: 0.3;
                }
                50% { 
                    height: 30px; 
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(styleEl);

        // Add ribbon icon
        this.addRibbonIcon('youtube', 'Extract YouTube Transcript', () => {
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
                new Notice(`YouTube Transcript Plugin: No API key configured for ${selectedLlm}. Please add your API key in the plugin settings.`);
                return;
            }
            
            // If license is accepted and API key is set, proceed with the usual workflow
            new YouTubeTranscriptModal(this.app, this).open();
        });

        // Add command
        this.addCommand({
            id: 'extract-youtube-transcript',
            name: 'Extract YouTube Transcript',
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
                    new Notice(`YouTube Transcript Plugin: No API key configured for ${selectedLlm}. Please add your API key in the plugin settings.`);
                    return;
                }
                
                // If license is accepted and API key is set, proceed with the usual workflow
                new YouTubeTranscriptModal(this.app, this).open();
            }
        });

        // Set up file watcher for plugin directory
        this.fileWatcher = this.app.vault.adapter.watch(pluginBasePath, async () => {
            // Reload settings when changes are detected
            await this.loadSettings();
            this.initializeSummarizer();
            // Refresh the settings tab if it's open
            // @ts-ignore - setting exists but TypeScript doesn't know about it
            const settingsTab = this.app.setting.activeTab;
            if (settingsTab && settingsTab.id === pluginId) {
                settingsTab.display();
            }
        });
    }

    async onunload() {
        logger.info("Plugin unloading - starting cleanup");
        
        // Set a timeout to ensure Obsidian doesn't hang during unload
        const unloadTimeout = setTimeout(() => {
            logger.error("Cleanup timed out - forcing exit");
        }, 5000); // 5 seconds timeout
        
        try {
            // Clean up file watcher when plugin is unloaded
            if (this.fileWatcher) {
                logger.info("Removing file watcher");
                this.app.vault.adapter.unwatch(this.fileWatcher);
            }
            
            // Remove the stylesheet
            const styleEl = document.getElementById('youtube-transcript-styles');
            if (styleEl) {
                styleEl.remove();
            }
            
            // Stop the local proxy server only if Anthropic was the last used provider
            if (this.settings.selectedLLM === 'anthropic') {
                try {
                    logger.info("Stopping Anthropic proxy server");
                    await Promise.race([
                        stopLocalProxy(),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error("Proxy shutdown timed out")), 3000)
                        )
                    ]);
                    logger.info("Anthropic proxy server stopped");
                } catch (error) {
                    logger.error("Error stopping Anthropic proxy server:", error);
                }
            }
        } catch (error) {
            logger.error("Error during plugin cleanup:", error);
        } finally {
            // Clear the timeout to prevent unnecessary warnings
            clearTimeout(unloadTimeout);
            logger.info("Plugin cleanup completed");
        }
    }

    private initializeSummarizer() {
        this.summarizer = new TranscriptSummarizer({
            model: this.getModelForProvider(this.settings.selectedLLM),
            temperature: this.settings.temperature,
            maxTokens: this.settings.maxTokens,
            systemPrompt: this.settings.systemPrompt,
            userPrompt: this.settings.userPrompt
        }, this.settings.apiKeys);
    }

    private getModelForProvider(provider: string): string {
        if (this.settings.selectedModels[provider]) {
            return this.settings.selectedModels[provider];
        }
        
        // Fallback to defaults if no selection exists
        switch (provider) {
            case 'openai':
                return 'gpt-4-turbo';
            case 'anthropic':
                return 'claude-3-sonnet-20240229';
            case 'google':
                return 'gemini-1.5-pro';
            case 'ollama':
                return 'llama3';
            default:
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initializeSummarizer();
    }

    async extractTranscript(videoUrl: string): Promise<string> {
        try {
            // Extract video ID from URL
            let videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
            
            transcriptLogger.debug("Starting transcript extraction for URL:", videoUrl);
            
            if (!videoId) {
                throw new Error('Invalid YouTube URL. Could not extract video ID.');
            }
            
            // Get transcript segments with language and country settings
            const transcriptSegments = await YouTubeTranscriptExtractor.fetchTranscript(videoId, {
                lang: this.settings.translateLanguage,
                country: this.settings.translateCountry
            });
            
            // Format transcript with timestamps
            const formattedTranscript = this.formatTranscriptForYaml(transcriptSegments);
            return formattedTranscript;
        } catch (error) {
            // Use the new error handling utility with 'YouTube API' as the service name
            throw handleApiError(error, 'YouTube API', 'Transcript Extraction');
        }
    }

    // Helper method to format transcript segments for YAML frontmatter
    private formatTranscriptForYaml(segments: any[]): string {
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
                    segmentText = segment.segs.map((s: any) => s.utf8 || '').join('').trim();
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
                // Escape any YAML special characters (colons are most important)
                const escapedText = chunk.text.replace(/:/g, "\\:");
                
                // Add chunk with proper indentation for YAML frontmatter
                // Add four spaces at the beginning of each line for YAML block format
                formattedTranscript += `    [${chunk.time}] ${escapedText}\n`;
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
            
            // Get the prompt configuration
            const promptConfig = getPromptConfig(this.settings, summaryMode);
            
            llmLogger.debug("Using token limit:", promptConfig.maxTokens);
            
            // Create a summarizer with the prompt configuration
            const tempSummarizer = new TranscriptSummarizer({
                model: this.getModelForProvider(this.settings.selectedLLM),
                temperature: promptConfig.temperature,
                maxTokens: promptConfig.maxTokens,
                systemPrompt: promptConfig.systemPrompt,
                userPrompt: promptConfig.userPrompt
            }, this.settings.apiKeys);
            
            const summary = await tempSummarizer.summarize(cleanedTranscript, this.settings.selectedLLM);
            return summary;
        } catch (error) {
            // Use the error handling utility
            throw handleApiError(error, this.settings.selectedLLM, 'Summarization');
        } finally {
            // If using Anthropic provider and fast summary mode or not adding timestamp links,
            // stop the proxy server since no further LLM calls will be made
            if (this.settings.selectedLLM === 'anthropic' && 
                (this.settings.useFastSummary || !this.settings.addTimestampLinks)) {
                try {
                    llmLogger.info('[summarizeTranscript] Stopping Anthropic proxy server (fast summary or no timestamp links)');
                    await stopLocalProxy();
                } catch (error) {
                    llmLogger.error('Error stopping Anthropic proxy server:', error);
                }
            }
        }
    }

    async applyTemplate(title: string, videoUrl: string, transcript: string, summary: string, folder?: string, contentType?: string): Promise<void> {
        // Check if Templater plugin is available
        // @ts-ignore - Templater API isn't typed in Obsidian's types
        const templaterPlugin = this.app.plugins?.plugins?.['templater-obsidian'];
        
        if (!templaterPlugin) {
            this.showNotice('Error: Templater plugin is required but not installed or enabled', 5000);
            throw new Error('Templater plugin is required but not installed or enabled.');
        }
        
        try {
            // Get the Templater instance
            // @ts-ignore - Accessing internal Templater API
            const templater = templaterPlugin.templater;
            
            // If Templater has never run, do a dummy parse to initialize.
            if (!templater.current_functions_object) {
                // We'll initialize with the actual template processing below
            }
            
            // Sanitize the title for use as a filename
            const sanitizedTitle = sanitizeFilename(title);
            
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
            
            // Add content type to file name prefix if provided
            const contentTypePrefix = contentType ? `${contentType} - ` : '';
            
            // REDO THE TRANSCRIPT FORMATTING FOR YAML
            // We'll re-process the transcript no matter what format it's in
            console.log("[DEBUG] Processing transcript for YAML format");
            
            // Format the transcript with original timestamps preserved
            let formattedTranscript = "";
            
            // Check if the transcript already has timestamps in format [HH:MM:SS]
            if (transcript.includes('[00:') || transcript.includes('[01:') || transcript.match(/\[\d{2}:\d{2}:\d{2}\]/)) {
                console.log("[DEBUG] Transcript contains timestamps, organizing into ≥60 second blocks");
                
                // Split the transcript into lines
                const originalLines = transcript.split('\n').filter(line => line.trim().length > 0);
                
                // Parse each line with its timestamp
                const parsedLines: {timestamp: string, seconds: number, text: string}[] = [];
                
                originalLines.forEach(line => {
                    // Look for timestamp pattern [HH:MM:SS]
                    const timestampMatch = line.match(/^\s*\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
                    
                    if (timestampMatch) {
                        const timestamp = timestampMatch[1];
                        const text = timestampMatch[2].trim();
                        
                        // Convert timestamp to seconds for comparison
                        const parts = timestamp.split(':').map(Number);
                        const seconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
                        
                        parsedLines.push({
                            timestamp,
                            seconds,
                            text
                        });
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
                
                console.log(`[DEBUG] Organized ${originalLines.length} lines into ${segments.length} ≥60-second blocks`);
                
                // Format segments for YAML frontmatter
                segments.forEach(segment => {
                    // Escape colons and other YAML-sensitive characters
                    let escapedText = segment.text.replace(/:/g, "\\:");
                    
                    // Convert timestamp to seconds using our custom function
                    const timeIndex = convertTimestampToSeconds(segment.timestamp);
                    
                    // Add formatted line with 4-space indentation for YAML block
                    // Include both original timestamp and calculated timeIndex
                    formattedTranscript += `    [${segment.timestamp}] [TimeIndex:${timeIndex}] ${escapedText}\n`;
                });
            } else {
                console.log("[DEBUG] Transcript does not contain timestamps");
                
                // Provide a warning message in the transcript text
                formattedTranscript = "    [ERROR] No timestamps found in transcript. Please ensure the YouTube transcript contains timestamps.";
                
                // Show an error notice
                this.showNotice("Warning: No timestamps found in transcript. Timestamps are required for proper processing.", 5000);
            }
            
            // Now use this properly formatted transcript
            transcript = formattedTranscript;
            
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
            if (!templateFile) {
                throw new Error(`Template file not found: ${this.settings.templaterTemplateFile}`);
            }
            
            // 1. Initialize Templater if needed (force a one-time run)
            if (!templater.current_functions_object) {
                // We'll initialize with the actual template processing below
            }
            
            // 2. Create a running config for the actual template
            // @ts-ignore - Accessing internal Templater API and working around TypeScript errors
            const config = templater.create_running_config(
                templateFile,
                templateFile, // Use the template file itself as target to avoid null path errors
                0    // Numeric value for "CreateNewFromTemplate"
            );
            
            // 3. Generate the Templater context (tp object)
            // @ts-ignore - Accessing internal Templater API
            const ctx = await templater.functions_generator.generate_object(config);
            
            // 4. Inject our custom data into ctx.user as functions
            if (!ctx.user) {
                ctx.user = {};
            }
            
            // Set up our data as functions in ctx.user
            ctx.user.title = sanitizedTitle;
            ctx.user.videoUrl = videoUrl;
            ctx.user.transcript = transcript;
            ctx.user.summary = summary;
            
            // Add LLM provider and model info
            const llmProvider = this.settings.selectedLLM;
            const llmModel = this.settings.selectedModels[llmProvider];
            ctx.user.llmProvider = llmProvider;
            ctx.user.llmModel = llmModel;
            
            // Add tags for LLM provider and model
            const llmTags = `llm/${llmProvider} model/${llmModel.replace(/[:\.]/g, "-")}`;
            ctx.user.llmTags = llmTags;
            
            // Add debug info to help troubleshoot transcript formatting issues
            // We'll include this in the note so it's visible
            ctx.user.debugInfo = `
Transcript info:
- Length: ${transcript ? transcript.length : 'unknown'} characters
- Contains timestamps: ${transcript ? transcript.includes('[00:') : 'unknown'}
- LLM Provider: ${llmProvider}
- LLM Model: ${llmModel}
`;
            
            // 5. Read and parse the template with our custom context
            const templateContent = await this.app.vault.read(templateFile);
            
            // @ts-ignore - Accessing internal Templater API
            const parsedContent = await templater.parser.parse_commands(templateContent, ctx);
            
            // 6. Create the new file with parsed content
            const fileName = `${datePrefix}${sanitizedTitle}.md`;
            const filePath = normalizedFolder ? joinPaths(normalizedFolder, fileName) : fileName;
            
            // @ts-ignore - Using Obsidian API
            const newFile = await this.app.vault.create(filePath, parsedContent);
            
            // 7. Open the new file
            // @ts-ignore - Using Obsidian API
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(newFile);
            
            this.showNotice(`Created note: ${datePrefix}${sanitizedTitle}`, 5000);
        } catch (error) {
            console.error("[DEBUG] Error applying template:", error);
            this.showNotice(`Error creating note: ${error.message}`, 5000);
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
        // @ts-ignore - Templater API isn't typed in Obsidian's types
        const templater = this.app.plugins?.plugins?.['templater-obsidian'];
        
        if (!templater) {
            // Show a notice with instructions on how to install Templater
            setTimeout(() => {
                this.showNotice('YouTube Transcript plugin requires the Templater plugin. Please install and enable it.', 5000);
            }, 3000); // Delay to ensure it's seen after initial plugin load
        }
        
        // Check for LLM API key
        const selectedLlm = this.settings.selectedLLM;
        if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
            setTimeout(() => {
                this.showNotice(`YouTube Transcript Plugin: No API key configured for ${selectedLlm}. Please add your API key in settings.`, 5000);
            }, 4500);
        }
    }

    // Use imported utility method
    private isYoutubeUrl(url: string): boolean {
        return isYoutubeUrl(url);
    }
    
    // Use imported utility method
    private isYoutubeChannelOrPlaylistUrl(url: string): boolean {
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
                throw new Error('YouTube API key is required. Please set it in the plugin settings.');
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
                        const playlistResponse = await fetch(
                            `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${sourceId}&key=${API_KEY}`
                        );
                        
                        if (!playlistResponse.ok) {
                            throw new Error(`Failed to fetch playlist data: HTTP status ${playlistResponse.status}`);
                        }
                        
                        const playlistData = await playlistResponse.json();
                        
                        if (!playlistData.items || playlistData.items.length === 0) {
                            throw new Error('Playlist not found');
                        }
                        
                        // Get playlist name for display
                        sourceTitle = playlistData.items[0].snippet.title;
                        
                        // Fetch videos from playlist
                        const videosResponse = await fetch(
                            `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${limit || 50}&playlistId=${sourceId}&key=${API_KEY}`
                        );
                        
                        if (!videosResponse.ok) {
                            throw new Error(`Failed to fetch playlist videos: HTTP status ${videosResponse.status}`);
                        }
                        
                        const videosData = await videosResponse.json();
                        
                        if (!videosData.items || videosData.items.length === 0) {
                            throw new Error('No videos found in this playlist');
                        }
                        
                        // Extract video information
                        videoResults = videosData.items
                            .filter((item: any) => 
                                item.snippet && 
                                item.snippet.title && 
                                item.snippet.resourceId && 
                                item.snippet.resourceId.videoId)
                            .map((item: any) => ({
                                title: item.snippet.title,
                                url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
                            }));
                    } else {
                        throw new Error('Could not extract playlist ID from URL');
                    }
                } else {
                    throw new Error('Invalid playlist URL format');
                }
            } else {
                // Handle channel URL as before
                sourceId = await this.getChannelIdFromInput(sourceUrl, API_KEY);
                
                if (!sourceId) {
                    throw new Error('Could not extract channel ID from URL');
                }
                
                // Get channel details
                const channelResponse = await fetch(
                    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${sourceId}&key=${API_KEY}`
                );
                
                if (!channelResponse.ok) {
                    throw new Error(`Failed to fetch channel data: HTTP status ${channelResponse.status}`);
                }
                
                const channelData = await channelResponse.json();
                
                if (!channelData.items || channelData.items.length === 0) {
                    throw new Error('Channel not found');
                }
                
                // Get channel name for display
                sourceTitle = channelData.items[0].snippet.title;
                
                // Get the uploads playlist ID
                const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;
                
                // Get videos from the uploads playlist
                // We may need to make multiple requests to get all videos if there are more than the max allowed per request
                let allVideos: any[] = [];
                let nextPageToken: string | null = null;
                let maxResults = limit > 0 ? limit : 50;
                
                do {
                    // Build URL with page token if we have one
                    let videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${maxResults}&playlistId=${uploadsPlaylistId}&key=${API_KEY}`;
                    if (nextPageToken) {
                        videosUrl += `&pageToken=${nextPageToken}`;
                    }
                    
                    this.showNotice(`Fetching videos${nextPageToken ? ' (continued)' : ''}...`, 3000);
                    
                    const videosResponse = await fetch(videosUrl);
                    
                    if (!videosResponse.ok) {
                        throw new Error(`Failed to fetch videos: HTTP status ${videosResponse.status}`);
                    }
                    
                    const videosData = await videosResponse.json();
                    
                    if (!videosData.items || videosData.items.length === 0) {
                        // If we have no videos and this is the first request, error out
                        if (allVideos.length === 0) {
                            throw new Error('No videos found in this channel');
                        }
                        // Otherwise just break the loop
                        break;
                    }
                    
                    // Add these items to our collection
                    allVideos = allVideos.concat(videosData.items);
                    
                    // Get next page token if available and if we need more videos
                    nextPageToken = videosData.nextPageToken || null;
                    
                    // If we've reached our limit, stop paginating
                    if (limit > 0 && allVideos.length >= limit) {
                        break;
                    }
                    
                } while (nextPageToken);
                
                // Map response to simple video objects, filtering out any with missing data
                videoResults = allVideos
                    .filter((item: any) => 
                        item.snippet && 
                        item.snippet.title && 
                        item.snippet.resourceId && 
                        item.snippet.resourceId.videoId
                    )
                    .map((item: any) => ({
                        title: item.snippet.title,
                        url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
                    }));
            }
            
            // Show what we found
            this.showNotice(`Found ${sourceTitle}: ${videoResults.length} videos`, 3000);
            
            // Limit if needed
            if (limit > 0 && videoResults.length > limit) {
                return videoResults.slice(0, limit);
            }
            
            return videoResults;
        } catch (error) {
            console.error('Error fetching collection videos:', error);
            throw new Error(`Failed to fetch videos: ${error.message || 'Unknown error'}`);
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
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch channel ID: HTTP status ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.items || data.items.length === 0) {
            throw new Error(`No channel found for handle: ${handle}`);
        }
        
        return data.items[0].id;
    }

    // Add timestamp links to section headings in an existing note using LLM
    async addSectionLinksToNote(filePath: string, videoUrl: string): Promise<void> {
        try {
            // Extract video ID from URL
            const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
            if (!videoId) {
                throw new Error('Could not extract video ID from URL');
            }

            // Read the note content
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!file) {
                throw new Error('Could not find note file');
            }

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
                try {
                    logger.info('[addSectionLinksToNote] Stopping Anthropic proxy server');
                    await stopLocalProxy();
                } catch (error) {
                    logger.error('Error stopping Anthropic proxy server:', error);
                }
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
            const timestampConfig = getTimestampLinkConfig(this.settings, videoId);
            
            // Create specialized summarizer for timestamp linking
            const timestampLinkSummarizer = new TranscriptSummarizer({
                model: this.getModelForProvider(this.settings.selectedLLM),
                temperature: timestampConfig.temperature,
                maxTokens: this.getMaxTokensForTimestampPass(),
                systemPrompt: timestampConfig.systemPrompt,
                userPrompt: timestampConfig.userPrompt
            }, this.settings.apiKeys);
            
            // Format the prompt - send ONLY the content, not frontmatter
            let formattedPrompt = `${timestampConfig.userPrompt}${contentWithoutFrontmatter}\n\nThe YouTube video ID is: ${videoId}`;
            
            // If we have transcript, include it
            if (transcript) {
                formattedPrompt += `\n\nTRANSCRIPT EXCERPTS (for reference):\n${transcript}`;
            }
            
            // Send to LLM for processing
            this.showNotice("Adding timestamp links with LLM...", 5000);
            logger.debug("[addTimestampLinksSinglePass] Sending content to LLM (without frontmatter)...");
            
            let enhancedContent;
            try {
                enhancedContent = await timestampLinkSummarizer.summarize(formattedPrompt, this.settings.selectedLLM);
                logger.debug("[addTimestampLinksSinglePass] Received LLM response, length:", enhancedContent ? enhancedContent.length : 0);
            } catch (e) {
                logger.error("[addTimestampLinksSinglePass] Error during LLM call:", e);
                
                // In case of token limit errors, reduce the maxTokens and try again
                if (e.message && (e.message.includes("max_tokens") || e.message.includes("token limit"))) {
                    logger.debug("[addTimestampLinksSinglePass] Token limit error detected, retrying with reduced token limit");
                    this.showNotice("Retrying with reduced token limit...", 5000);
                    
                    // Reduce token limit by half and try again
                    const reducedTokens = Math.floor(this.getMaxTokensForTimestampPass() / 2);
                    
                    // Create a new summarizer with reduced tokens but same config otherwise
                    const reducedTokensSummarizer = new TranscriptSummarizer({
                        model: this.getModelForProvider(this.settings.selectedLLM),
                        temperature: timestampConfig.temperature,
                        maxTokens: reducedTokens,
                        systemPrompt: timestampConfig.systemPrompt,
                        userPrompt: timestampConfig.userPrompt
                    }, this.settings.apiKeys);
                    
                    try {
                        enhancedContent = await reducedTokensSummarizer.summarize(formattedPrompt, this.settings.selectedLLM);
                        logger.debug("[addTimestampLinksSinglePass] Second attempt successful with reduced tokens:", reducedTokens);
                    } catch (retryError) {
                        logger.error("[addTimestampLinksSinglePass] Error on second attempt:", retryError);
                        this.showNotice(`Failed to add timestamp links: ${retryError.message}`, 5000);
                        return null;
                    }
                } else {
                    this.showNotice(`Error adding timestamp links: ${e.message}`, 5000);
                    return null;
                }
            }
            
            if (!enhancedContent) {
                logger.error("[addTimestampLinksSinglePass] Failed to add timestamp links (empty response from LLM)");
                this.showNotice("Failed to add timestamp links (empty response from LLM)", 5000);
                return null;
            }
            
            // Reconstruct the document with original frontmatter and enhanced content
            let enhancedNote = reconstructDocument(frontmatter, enhancedContent);
            
            // Validate the enhanced content using our utility
            if (validateEnhancedContent(enhancedContent, contentWithoutFrontmatter, headings, videoId)) {
                // Update the note file with the LLM-enhanced content
                await this.app.vault.modify(
                    this.app.vault.getAbstractFileByPath(filePath) as any,
                    enhancedNote
                );
                
                // Count number of section headings with links
                const linkCount = countTimestampLinks(enhancedContent);
                this.showNotice(`Added timestamp links to ${linkCount} section headings`, 5000);
                
                // Return the enhanced content for potential translation
                return enhancedContent;
            }
            
            return null;
        } catch (error) {
            logger.error("[addTimestampLinksSinglePass] Error:", error);
            this.showNotice(`Error adding timestamp links: ${error.message}`, 5000);
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
            const { frontmatter } = extractDocumentComponents(await this.app.vault.read(this.app.vault.getAbstractFileByPath(filePath) as any));
            
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
                this.showNotice(`Translation error: ${e.message}`, 5000);
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
            await this.app.vault.modify(
                this.app.vault.getAbstractFileByPath(filePath) as any,
                translatedNote
            );
            
            this.showNotice(`Successfully translated content to ${targetLang.toUpperCase()}-${targetCountry}`, 5000);
            
        } catch (error) {
            logger.error("[translateContent] Error:", error);
            this.showNotice(`Error translating content: ${error.message}`, 5000);
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
            
            // Create optimized chunks based on heading positions
            const maxTokenLimit = this.getMaxTokensForTimestampPass();
            const chunks = createOptimizedChunks(contentWithoutFrontmatter, maxTokenLimit);
            
            logger.debug(`[addTimestampLinksInChunks] Split content into ${chunks.length} optimized chunks`);
            
            // Process each chunk separately
            let processedChunks: string[] = [];
            
            // We're still in the second LLM pass, just breaking it into smaller chunks
            // The first LLM pass already created the note content, now we're adding timestamp links
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                
                // Skip chunks without proper heading (including template header)
                if (!hasProperHeading(chunk)) {
                    logger.debug(`[addTimestampLinksInChunks] Preserving non-section chunk ${i+1} unchanged`);
                    // Ensure chunk ends with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                    continue;
                }
                
                logger.debug(`[addTimestampLinksInChunks] Processing chunk ${i+1} of ${chunks.length}, length: ${chunk.length}`);
                this.showNotice(`Processing section ${i+1} of ${chunks.length}...`, 2000);
                
                // Get timestamp link configuration
                const timestampConfig = getTimestampLinkConfig(this.settings, videoId);
                
                // Create specialized prompt for this chunk using the timestamp utility
                const chunkPrompt = `${timestampConfig.userPrompt}${chunk}\n\nThe YouTube video ID is: ${videoId}\n\nTRANSCRIPT EXCERPTS (for reference):\n${transcript.length > 0 ? transcript : "No transcript available, use default timestamps starting at 0 seconds."}`;
                
                try {
                    // Create chunk-specific summarizer with base config
                    const maxTokens = Math.floor(this.getMaxTokensForTimestampPass() * 0.9); // Use 90% of the limit to provide headroom
                    logger.debug(`[addTimestampLinksInChunks] Using ${maxTokens} tokens (90% of ${this.getMaxTokensForTimestampPass()})`);
                    
                    const chunkSummarizer = new TranscriptSummarizer({
                        model: this.getModelForProvider(this.settings.selectedLLM),
                        temperature: timestampConfig.temperature,
                        maxTokens: maxTokens,
                        systemPrompt: timestampConfig.systemPrompt,
                        userPrompt: timestampConfig.userPrompt // Use the base prompt, not the complete chunk prompt
                    }, this.settings.apiKeys);
                    
                    // Process the chunk
                    const processedChunk = await chunkSummarizer.summarize(chunkPrompt, this.settings.selectedLLM);
                    
                    if (processedChunk) {
                        // Validate processed chunk has timestamp link
                        const hasLink = hasTimestampLinks(processedChunk, videoId);
                        
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
                    // Push original chunk with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                }
            }
            
            // Reconstruct document: frontmatter + processed content
            const combinedContent = processedChunks.join("");
            const combinedNote = reconstructDocument(frontmatter, combinedContent);
            
            // Verify we have some timestamp links
            const linkCount = countTimestampLinks(combinedContent);
            
            if (linkCount > 0) {
                // Update the note file with the combined content
                await this.app.vault.modify(
                    this.app.vault.getAbstractFileByPath(filePath) as any,
                    combinedNote
                );
                
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
            this.showNotice(`Error in chunked processing: ${error.message}`, 5000);
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
        const selectedLLM = this.settings.selectedLLM;
        const selectedModel = this.settings.selectedModels[selectedLLM];
        
        // Set token limits based on model capabilities
        if (selectedLLM === 'openai') {
            // OpenAI models
            if (selectedModel.includes('gpt-4')) {
                return 4096; // GPT-4 models typically support 4K completion tokens
            } else if (selectedModel.includes('gpt-3.5')) {
                return 3072; // GPT-3.5 typically supports 4K tokens but being conservative
            } else if (selectedModel.includes('o1') || selectedModel.includes('o3')) {
                return 4096; // OpenAI o1/o3 models
            }
            return 3072; // Default for OpenAI models
        } else if (selectedLLM === 'anthropic') {
            // Anthropic models support higher token counts but API has a 4K limit for completion
            if (selectedModel.includes('claude-3') || selectedModel.includes('claude-3.5') || selectedModel.includes('claude-3.7')) {
                return 4096; // Claude-3 models API limit is 4K for completion tokens
            }
            return 4096; // Conservative default for other Claude models
        } else if (selectedLLM === 'google') {
            // Gemini models
            if (selectedModel.includes('gemini-1.5')) {
                return 8192; // Gemini 1.5 models can handle larger outputs
            }
            return 4096; // Default for Google models
        } else if (selectedLLM === 'ollama') {
            // Local models through Ollama
            return 4096; // Conservative default for local models
        }
        
        // Fallback default - be conservative with token limit
        return 4096;
    }

    private sanitizePathComponent(text: string): string {
        // Use the utility function instead of duplicating code
        return sanitizePathComponent(text);
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
        showUtilityNotice(message, timeout);
    }
    
    // Use imported utility method
    private isYoutubeUrl(url: string): boolean {
        return isYoutubeUrl(url);
    }
    
    // Use imported utility method
    private isYoutubeChannelOrPlaylistUrl(url: string): boolean {
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
            this.errorEl.style.display = 'none';
        }
    }
    
    onOpen() {
        // Initialize
        this.showNotice('YouTube Transcript Extractor ready', 10000);
        
        // Clear content and create container
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: 'Extract YouTube Transcript' });
        
        // Build the input stage UI
        this.buildInputStage();
    }
    
    private buildInputStage() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: 'Extract YouTube Transcript' });
        
        // Create the form container - revert to original style
        const formEl = contentEl.createEl('div', { cls: 'youtube-transcript-form' });
        
        // URL input group - first input
        const urlGroup = formEl.createEl('div', { cls: 'form-group' });
        urlGroup.createEl('label', { text: 'YouTube URL', attr: { for: 'url' } });
        this.urlInputEl = urlGroup.createEl('input', { 
            type: 'text',
            attr: { id: 'url', placeholder: 'https://www.youtube.com/watch?v=...' } 
        });
        
        // Create a URL validation message element
        const urlValidationEl = urlGroup.createEl('div', { 
            cls: 'validation-message',
            attr: { style: 'margin-top: 5px; font-size: 12px;' }
        });
        urlValidationEl.style.display = 'none';
        
        // Add channel selection container (initially hidden)
        const channelOptionsContainer = formEl.createEl('div', { 
            cls: 'channel-options',
            attr: { style: 'display: none; margin-top: 15px; background: var(--background-secondary); padding: 15px; border-radius: 5px;' }
        });
        
        // Add channel message
        channelOptionsContainer.createEl('div', { 
            text: 'This is a YouTube channel or playlist URL. How many videos would you like to process?',
            attr: { style: 'margin-bottom: 10px; font-weight: 500;' }
        });
        
        // Create a single container for all input controls in one line
        const controlsContainer = channelOptionsContainer.createEl('div', {
            attr: { 
                style: 'display: flex; align-items: center; flex-wrap: nowrap; gap: 15px; margin-bottom: 15px; width: 100%;' 
            }
        });
        
        // Radio button for "All Videos"
        const allVideosContainer = controlsContainer.createEl('div', {
            attr: { style: 'display: flex; align-items: center; white-space: nowrap;' }
        });
        
        const allVideosRadio = allVideosContainer.createEl('input', {
            type: 'radio',
            attr: { 
                id: 'all-videos-radio',
                name: 'video-count-option',
                checked: 'checked',
                style: 'margin-right: 5px;'
            }
        });
        
        allVideosContainer.createEl('label', {
            text: 'All Videos',
            attr: { 
                for: 'all-videos-radio',
                style: 'cursor: pointer;'
            }
        });
        
        // Radio button for "Limited Number"
        const limitedVideosContainer = controlsContainer.createEl('div', {
            attr: { style: 'display: flex; align-items: center; white-space: nowrap;' }
        });
        
        const limitedVideosRadio = limitedVideosContainer.createEl('input', {
            type: 'radio',
            attr: { 
                id: 'limited-videos-radio',
                name: 'video-count-option',
                style: 'margin-right: 5px;'
            }
        });
        
        limitedVideosContainer.createEl('label', {
            text: 'Limited Number:',
            attr: { 
                for: 'limited-videos-radio',
                style: 'cursor: pointer;'
            }
        });
        
        // Dropdown for selecting number of videos - directly in the main container
        const videoCountDropdown = controlsContainer.createEl('select', {
            attr: {
                id: 'video-count-dropdown',
                style: 'padding: 5px; border-radius: 4px; width: 60px;'
            }
        });
        
        // Add options 1-20
        for (let i = 1; i <= 20; i++) {
            videoCountDropdown.createEl('option', {
                text: i.toString(),
                attr: { value: i.toString() }
            });
        }
        
        // Set default to 1
        videoCountDropdown.value = '1';
        
        // Process button - directly in the main container
        const processBtn = controlsContainer.createEl('button', {
            text: 'Process',
            attr: { 
                style: 'padding: 6px 15px; background: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer; margin-left: auto;'
            }
        });
        
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
        titleGroup.createEl('label', { text: 'Custom Note Title (Optional)', attr: { for: 'title' } });
        this.titleInputEl = titleGroup.createEl('input', { 
            type: 'text',
            attr: { id: 'title', placeholder: 'Leave empty to use YouTube title' } 
        });
        
        // Add toggle switch for summary mode
        const toggleContainer = formEl.createEl('div', { cls: 'toggle-container' });
        
        // Label for the toggle
        const toggleLabel = toggleContainer.createEl('div', { cls: 'toggle-label' });
        toggleLabel.createEl('div', { text: 'Fast Summary Mode' });
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
        this.fastSummaryToggleEl.addEventListener('change', async () => {
            this.plugin.settings.useFastSummary = this.fastSummaryToggleEl.checked;
            await this.plugin.saveSettings();
        });
        
        // Error message container
        this.errorEl = formEl.createEl('div', { cls: 'error' });
        this.errorEl.style.display = 'none';
        this.errorEl.style.color = 'var(--text-normal)';
        this.errorEl.style.marginTop = '10px';
        this.errorEl.style.padding = '10px';
        this.errorEl.style.borderRadius = '4px';
        this.errorEl.style.backgroundColor = 'var(--background-modifier-error)';
        this.errorEl.style.border = '1px solid var(--background-modifier-error-hover)';
        
        // Add real-time validation on URL change
        this.urlInputEl.addEventListener('input', () => {
            const url = this.urlInputEl.value.trim();
            
            // First check if it's a valid URL
            if (url && !this.isYoutubeUrl(url)) {
                urlValidationEl.setText('Not a valid YouTube URL. Only video, playlist, and channel URLs are supported.');
                urlValidationEl.style.color = 'var(--text-error)';
                urlValidationEl.style.display = 'block';
                return;
            }
            
            // Check if it's a channel URL
            if (url && this.isYoutubeChannelOrPlaylistUrl(url)) {
                urlValidationEl.setText('YouTube channel or playlist URL detected');
                urlValidationEl.style.color = 'var(--text-accent)';
                urlValidationEl.style.display = 'block';
                
                // Show channel options, hide title input
                channelOptionsContainer.style.display = 'block';
                titleGroup.style.display = 'none';
            } else if (url) {
                urlValidationEl.setText('YouTube video URL detected');
                urlValidationEl.style.color = 'var(--text-success)';
                urlValidationEl.style.display = 'block';
                
                // Hide channel options, show title input
                channelOptionsContainer.style.display = 'none';
                titleGroup.style.display = 'block';
            } else {
                urlValidationEl.style.display = 'none';
                channelOptionsContainer.style.display = 'none';
                titleGroup.style.display = 'block';
            }
        });
        
        // Add event listeners for Enter key
        this.urlInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const url = this.urlInputEl.value.trim();
                
                if (url && this.isYoutubeUrl(url)) {
                    if (this.isYoutubeChannelOrPlaylistUrl(url)) {
                        // If it's a channel URL, don't focus title - show channel options
                        channelOptionsContainer.style.display = 'block';
                        titleGroup.style.display = 'none';
                    } else if (this.titleInputEl.style.display !== 'none') {
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
    
    private handleInputSubmit() {
        // Clear any previous errors
        this.hideError();
        
        // Get values from inputs
        const title = this.titleInputEl.value.trim();
        const url = this.urlInputEl.value.trim();
        
        // Create validation rules
        const validations: ValidationResult[] = [
            // URL is required
            validateRequired(url, 'YouTube URL'),
            
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
            // Check if YouTube API key is set
            if (!this.plugin.settings.youtubeApiKey || this.plugin.settings.youtubeApiKey.trim() === '') {
                this.showError(
                    'YouTube API key is required to process channels or playlists. ' +
                    'Please set your YouTube Data API key in the plugin settings first. ' +
                    'See the README section "Creating a YouTube API Key" for instructions.'
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
    
    // Method to handle processing YouTube channel or playlist videos
    private processCollectionVideos(sourceUrl: string, videoCount: number) {
        // Validate the URL once more
        if (!sourceUrl || !this.isYoutubeUrl(sourceUrl) || !this.isYoutubeChannelOrPlaylistUrl(sourceUrl)) {
            this.showError('Invalid YouTube channel or playlist URL');
            return;
        }
        
        // Check if YouTube API key is set
        if (!this.plugin.settings.youtubeApiKey || this.plugin.settings.youtubeApiKey.trim() === '') {
            this.showError(
                'YouTube API key is required to process channels or playlists. ' +
                'Please set your YouTube Data API key in the plugin settings first. ' +
                'See the README section "Creating a YouTube API Key" for instructions.'
            );
            return;
        }
        
        // Create a proxy object that has the required settings property
        const pluginProxy = {
            settings: this.plugin.settings
        };
        
        // Show folder picker - we'll process videos after folder selection
        const folderSelectionModal = new FolderPickerModal(
            this.app,
            pluginProxy as YouTubeTranscriptPlugin,
            (folderPath) => {
                this.selectedFolder = folderPath;
                this.beginCollectionProcessing(sourceUrl, videoCount);
            }
        );
        folderSelectionModal.open();
    }
    
    // Method to start the collection processing workflow
    private async beginCollectionProcessing(sourceUrl: string, videoCount: number) {
        if (this.isProcessing) return;
        
        try {
            this.isProcessing = true;
            
            // Show processing UI
            const { contentEl } = this;
            contentEl.empty();
            
            // Create a minimal container just for centering the pulse bars
            const pulseContainerEl = contentEl.createEl('div', { 
                cls: 'pulse-container',
                attr: { style: 'display: flex; justify-content: center; margin-top: 30px;' }
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
                            const response = await fetch(
                                `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`
                            );
                            
                            if (response.ok) {
                                const data = await response.json();
                                if (data.items && data.items.length > 0) {
                                    sourceName = data.items[0].snippet.title;
                                    this.showNotice(`Found playlist: ${sourceName}`, 5000);
                                }
                            }
                        } catch (error) {
                            console.error("Error getting playlist name:", error);
                            // Use a generic name if we can't get the real name
                            sourceName = `Playlist-${playlistId}`;
                        }
                    }
                }
                
                // If we still don't have a name, use a fallback
                if (!sourceName) {
                    sourceName = "YouTube-Playlist";
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
            
            // Process each video
            let processedCount = 0;
            let skippedCount = 0;
            let errorCount = 0;
            
            for (const video of collectionVideos) {
                try {
                    // Update processing message
                    this.showNotice(`Processing video ${processedCount + skippedCount + errorCount + 1}/${collectionVideos.length}: ${video.title}`, 5000);
                    
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
                                await this.plugin.addSectionLinksToNote(notePath, video.url);
                                this.showNotice(`✓ Timestamp links added to ${video.title}`, 2000);
                            } catch (timestampError) {
                                console.error(`Error adding timestamp links to ${isPlaylist ? 'playlist' : 'channel'} video (${video.title}):`, timestampError);
                                this.showNotice(`Note created but timestamps could not be added to "${video.title}"`, 3000);
                            }
                        }
                        
                        processedCount++;
                        this.showNotice(`✓ Processed video ${processedCount + skippedCount + errorCount}/${collectionVideos.length}`, 3000);
                    } catch (transcriptError) {
                        this.showNotice(`⚠️ Skipping video "${video.title}" - ${transcriptError.message}`, 5000);
                        skippedCount++;
                    }
                } catch (videoError) {
                    console.error('Error processing video:', video, videoError);
                    this.showNotice(`❌ Error processing video "${video.title}": ${videoError.message}`, 5000);
                    errorCount++;
                }
            }
            
            // Final success notice
            this.showNotice(`Channel processing complete: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors`, 7000);
            
            // Close the modal
            this.close();
            
        } catch (err) {
            console.error('Error in channel processing workflow:', err);
            
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
                    await stopLocalProxy();
                } catch (error) {
                    console.error('Error stopping Anthropic proxy server:', error);
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
                this.processTranscript();
            }
        );
        folderSelectionModal.open();
    }
    
    private async processTranscript() {
        if (this.isProcessing) return;
        
        // Get URL from the input
        const url = this.urlInputEl.value.trim();
        
        // Validate URL using form utilities
        const urlValidations: ValidationResult[] = [
            validateRequired(url, 'YouTube URL'),
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
            
            // Create a minimal container just for centering the pulse bars
            const pulseContainerEl = contentEl.createEl('div', { 
                cls: 'pulse-container',
                attr: { style: 'display: flex; justify-content: center; margin-top: 30px;' }
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
                throw new Error('Failed to extract video ID from URL');
            }
            
            // If no custom title was provided, fetch the YouTube title
            if (!title) {
                this.showNotice('Fetching video title from YouTube...', 5000);
                try {
                    const metadata = await YouTubeTranscriptExtractor.getVideoMetadata(videoId);
                    if (metadata && metadata.title) {
                        // Sanitize the YouTube title before using it
                        title = sanitizeFilename(metadata.title);
                        this.showNotice(`Using YouTube title: ${title}`, 3000);
                    } else {
                        title = `YouTube Video ${videoId}`;
                        this.showNotice('Could not retrieve YouTube title, using fallback', 3000);
                    }
                } catch (titleError) {
                    console.error('Error fetching video title:', titleError);
                    title = `YouTube Video ${videoId}`;
                    this.showNotice('Could not retrieve YouTube title, using fallback', 3000);
                }
            }
            
            // Extract transcript 
            this.showNotice('Extracting transcript from YouTube...', 5000);
            const transcript = await this.plugin.extractTranscript(url);
            
            if (!transcript) {
                throw new Error('Failed to extract transcript (empty result)');
            }
            this.showNotice('Transcript extracted successfully', 5000);
            
            // Summarize transcript
            this.showNotice('Summarizing transcript with AI...', 5000);
            const summary = await this.plugin.summarizeTranscript(transcript);
            
            if (!summary) {
                throw new Error('Failed to generate summary (empty result)');
            }
            this.showNotice('Summary generated', 5000);
            
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
                ? `${this.selectedFolder}/${datePrefix}${sanitizeFilename(title)}.md` 
                : `${datePrefix}${sanitizeFilename(title)}.md`;
            
            // Add section links in a second pass if enabled and not in fast summary mode
            if (this.plugin.settings.addTimestampLinks && !this.plugin.settings.useFastSummary) {
                this.showNotice('Adding section timestamp links...', 3000);
                await this.plugin.addSectionLinksToNote(notePath, url);
            }
            
            // Final success notice
            this.showNotice('Transcript note created successfully!', 5000);
            
            // Success - just close the modal
            this.close();
            
        } catch (err) {
            console.error('Error in transcript workflow:', err);
            
            // Use the getSafeErrorMessage utility instead of duplicating error handling logic
            const errorMessage = getSafeErrorMessage(err);
            
            // Show error notice
            this.showNotice(`Error: ${errorMessage}`, 5000);
            
            // Close the modal on error
            this.close();
        } finally {
            // Only stop the proxy server if it was started (only for Anthropic provider)
            if (this.plugin.settings.selectedLLM === 'anthropic') {
                try {
                    await stopLocalProxy();
                } catch (error) {
                    console.error('Error stopping Anthropic proxy server:', error);
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
        
        // Create custom styled title that's larger and bolder than the subsections
        const titleEl = containerEl.createEl('div', { 
            attr: { 
                style: 'font-size: 24px; font-weight: 700; margin-bottom: 16px; color: var(--text-normal); text-align: center;'
            }
        });
        titleEl.setText('YouTube Transcript LLM Settings');
        
        // Buy Me a Coffee section at the top
        const supportContainer = containerEl.createEl('div', {
            attr: { 
                style: 'display: flex; flex-direction: column; align-items: center; margin-top: 10px; margin-bottom: 30px;'
            }
        });
        
        // Support Development section with styled heading
        supportContainer.createEl('h3', { 
            text: 'Support Development',
            attr: { style: 'margin-bottom: 8px;' } 
        });
        
        // Support message in styled format
        const supportDesc = supportContainer.createEl('div', {
            text: 'If you find this plugin useful, consider supporting its development:',
            attr: { 
                style: 'margin-bottom: 12px; color: var(--text-muted); font-size: 13px;'
            }
        });
        
        // Buy Me a Coffee button in a container
        const bmcContainer = supportContainer.createEl('div', {
            attr: { style: 'margin-bottom: 20px;' }
        });
        
        // Create the link
        const bmcLink = bmcContainer.createEl('a', {
            href: 'https://www.buymeacoffee.com/RMcCorkle',
            attr: {
                target: '_blank',
                rel: 'noopener'
            }
        });
        
        // Add the image
        bmcLink.createEl('img', {
            attr: {
                src: 'https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png',
                alt: 'Buy Me A Coffee',
                style: 'height: 40px; width: 145px;'
            }
        });
        
        // Create a horizontal container for the remaining buttons
        const buttonsContainer = supportContainer.createEl('div', {
            attr: { 
                style: 'display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 10px; margin-bottom: 15px;'
            }
        });
        
        // License button - in the middle
        const licenseButtonContainer = buttonsContainer.createEl('div', {
            attr: { style: 'display: flex; justify-content: center; align-items: center; flex: 1;' }
        });
        
        // License text
        licenseButtonContainer.createEl('span', { 
            text: 'License & Disclaimer', 
            attr: { style: 'font-size: 14px; margin-right: 8px;' }
        });
        
        // Eye icon button for viewing license
        const licenseIconButton = licenseButtonContainer.createEl('button', {
            attr: {
                style: 'background: transparent; border: none; cursor: pointer; padding: 4px; border-radius: 4px; color: var(--text-normal); display: flex; align-items: center; justify-content: center;'
            }
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
            licenseIconButton.style.background = 'var(--background-modifier-hover)';
        });
        
        licenseIconButton.addEventListener('mouseleave', () => {
            licenseIconButton.style.background = 'transparent';
        });
        
        // Add click event to open license modal
        licenseIconButton.addEventListener('click', () => {
            new LicenseModal(this.app).open();
        });
        
        // License acceptance toggle - on the right
        const toggleContainer = buttonsContainer.createEl('div', {
            attr: { style: 'display: flex; align-items: center; justify-content: center; flex: 1;' }
        });
        
        toggleContainer.createEl('span', { 
            text: 'Accept License & Disclaimer', 
            attr: { style: 'margin-right: 8px; font-size: 14px;' }
        });
        
        // Create the toggle switch
        const toggleWrapper = toggleContainer.createEl('div', {
            attr: { style: 'position: relative; display: inline-block; width: 40px; height: 20px;' }
        });
        
        // Toggle input
        const toggleInput = toggleWrapper.createEl('input', {
            attr: {
                type: 'checkbox',
                style: 'opacity: 0; width: 0; height: 0;',
                id: 'license-toggle'
            }
        });
        
        // Set initial state
        toggleInput.checked = this.plugin.settings.licenseAccepted;
        
        // Create the toggle slider - using CSS that actually works in Obsidian
        const toggleSlider = toggleWrapper.createEl('span', {
            attr: {
                style: 'position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--background-modifier-border); transition: .4s; border-radius: 20px;'
            }
        });
        
        // Create the slider knob
        const sliderKnob = toggleSlider.createEl('span', {
            attr: {
                style: `position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; 
                       background-color: white; transition: .4s; border-radius: 50%;`
            }
        });
        
        // Initial toggle styling based on state
        if (toggleInput.checked) {
            toggleSlider.style.backgroundColor = 'var(--interactive-accent)';
            sliderKnob.style.left = '22px';
        }
        
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
            attr: { style: 'display: flex; justify-content: center; align-items: center; flex: 1;' }
        });
        
        // README text
        readmeButtonContainer.createEl('span', { 
            text: 'README', 
            attr: { style: 'font-size: 14px; margin-right: 8px;' }
        });
        
        // Eye icon button for viewing README
        const readmeButton = readmeButtonContainer.createEl('button', {
            attr: {
                style: 'background: transparent; border: none; cursor: pointer; padding: 4px; border-radius: 4px; color: var(--text-normal); display: flex; align-items: center; justify-content: center;'
            }
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
            readmeButton.style.background = 'var(--background-modifier-hover)';
        });
        
        readmeButton.addEventListener('mouseleave', () => {
            readmeButton.style.background = 'transparent';
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
                settingsContainer.style.opacity = '';
                settingsContainer.style.pointerEvents = '';
                settingsContainer.style.userSelect = '';
                settingsContainer.style.filter = '';
                toggleSlider.style.backgroundColor = 'var(--interactive-accent)';
                sliderKnob.style.left = '22px';
            } else {
                settingsContainer.style.opacity = '0.5';
                settingsContainer.style.pointerEvents = 'none';
                settingsContainer.style.userSelect = 'none';
                settingsContainer.style.filter = 'grayscale(30%)';
                toggleSlider.style.backgroundColor = 'var(--background-modifier-border)';
                sliderKnob.style.left = '2px';
            }
        };
        
        // Initial state
        updateSettingsState();
        
        // Add change listener to toggle
        toggleInput.addEventListener('change', async () => {
            this.plugin.settings.licenseAccepted = toggleInput.checked;
            await this.plugin.saveSettings();
            updateSettingsState();
        });
        
        // ALL SETTINGS SECTIONS GO IN settingsContainer FROM HERE ON
        
        // Template section
        settingsContainer.createEl('h3', { text: 'Template Plugin Settings' });
        
        const templaterSetting = new Setting(settingsContainer)
            .setName('Templater Plugin Template File')
            .setDesc('Path to the Templater template file to use')
            .addText(text => text
                .setPlaceholder('templates/YouTubeTranscript.md')
                .setValue(this.plugin.settings.templaterTemplateFile)
                .onChange(async (value: string) => {
                    this.plugin.settings.templaterTemplateFile = value;
                    await this.plugin.saveSettings();
                }));
                
        // Add Browse button
        templaterSetting.addExtraButton(button => {
                button
                    .setIcon('folder')
                    .setTooltip('Browse for template file')
                    .onClick(async () => {
                        // Show a file picker modal
                        const filePickerModal = new TemplateFilePickerModal(this.app, (selectedPath) => {
                            if (selectedPath) {
                                this.plugin.settings.templaterTemplateFile = selectedPath;
                                this.plugin.saveSettings();
                                this.display();
                            }
                        });
                        filePickerModal.open();
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
        
        // Transcript section
        const transcriptHeadingContainer = settingsContainer.createEl('div', {
            attr: { style: 'display: flex; align-items: center; gap: 8px;' }
        });
        
        transcriptHeadingContainer.createEl('h3', { text: 'Transcript Settings' });
        
        // Add info icon
        const infoIcon = transcriptHeadingContainer.createEl('span', {
            attr: { 
                style: 'cursor: help; color: var(--text-muted); font-size: 16px; display: flex; align-items: center; justify-content: center;',
                'aria-label': 'Information about transcript extraction settings'
            }
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
        
        // Add tooltip on hover
        infoIcon.addEventListener('mouseenter', (e) => {
            const tooltip = document.createElement('div');
            tooltip.className = 'transcript-settings-tooltip';
            tooltip.textContent = 'Configure settings for YouTube transcript extraction. These settings control how transcripts are fetched, processed, and organized in your vault.';
            tooltip.style.position = 'absolute';
            tooltip.style.zIndex = '1000';
            tooltip.style.backgroundColor = 'var(--background-secondary)';
            tooltip.style.color = 'var(--text-normal)';
            tooltip.style.padding = '8px 12px';
            tooltip.style.borderRadius = '4px';
            tooltip.style.fontSize = '14px';
            tooltip.style.maxWidth = '300px';
            tooltip.style.boxShadow = '0 2px 5px rgba(0, 0, 0, 0.2)';
            tooltip.style.top = `${e.clientY + 10}px`;
            tooltip.style.left = `${e.clientX + 10}px`;
            
            document.body.appendChild(tooltip);
            
            const removeTooltip = () => {
                document.body.removeChild(tooltip);
                infoIcon.removeEventListener('mouseleave', removeTooltip);
                infoIcon.removeEventListener('click', removeTooltip);
            };
            
            infoIcon.addEventListener('mouseleave', removeTooltip);
            infoIcon.addEventListener('click', removeTooltip);
        });
        
        new Setting(settingsContainer)
            .setName('Transcript Root Folder')
            .setDesc('The root folder where transcript subfolders will be organized (e.g., Inbox, Notes, etc.)')
            .addText(text => text
                .setPlaceholder('Inbox')
                .setValue(this.plugin.settings.transcriptRootFolder)
                .onChange(async (value: string) => {
                    this.plugin.settings.transcriptRootFolder = value;
                    await this.plugin.saveSettings();
                }));
        
        // Removed "Use YouTube Data API v3" setting and CORS issue notice
        
        new Setting(settingsContainer)
            .setName('YouTube Data API Key')
            .setDesc('Your Google Cloud Console API key for accessing public YouTube transcripts (not an OAuth token). Required for downloading channels and playlists.')
            .addText(text => text
                .setPlaceholder('AIza...')
                .setValue(this.plugin.settings.youtubeApiKey)
                .onChange(async (value: string) => {
                    this.plugin.settings.youtubeApiKey = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(settingsContainer)
            .setName('Translate Language')
            .setDesc('Target language code for translation (e.g., en, es, fr, de). Use "en" to keep content in English.')
            .addText(text => text
                .setPlaceholder('en')
                .setValue(this.plugin.settings.translateLanguage)
                .onChange(async (value: string) => {
                    this.plugin.settings.translateLanguage = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(settingsContainer)
            .setName('Translate Country')
            .setDesc('Target country/region code for translation (e.g., US, GB, CA). Used for region-specific language variants.')
            .addText(text => text
                .setPlaceholder('US')
                .setValue(this.plugin.settings.translateCountry)
                .onChange(async (value: string) => {
                    this.plugin.settings.translateCountry = value;
                    await this.plugin.saveSettings();
                }));
        
        // LLM section
        const llmHeadingContainer = settingsContainer.createEl('div', {
            attr: { style: 'display: flex; align-items: center; gap: 8px;' }
        });
        
        llmHeadingContainer.createEl('h3', { text: 'LLM Settings' });
        
        // Add info icon
        const llmInfoIcon = this.createInfoIcon(
            llmHeadingContainer,
            'Recommended by author: Google provider with gemini-2.0-flash model provides the best balance of quality and speed for most transcripts. Google offers a generous free quota that will suffice for most users\' needs.'
        );
        
        new Setting(settingsContainer)
            .setName('Select LLM')
            .setDesc('Choose which LLM to use for summarization')
            .addDropdown(dropdown => {
                // Add OpenAI option
                dropdown.addOption('openai', 'OpenAI (ChatGPT)');
                
                // Only add Anthropic option on desktop
                if (!(this.app as any).isMobile) {
                    dropdown.addOption('anthropic', 'Anthropic (Claude)');
                }
                
                // Always add Google and Ollama options
                dropdown.addOption('google', 'Google (Gemini)');
                dropdown.addOption('ollama', 'Ollama (Local Models)');
                
                // If current value is Anthropic but we're on mobile, switch to OpenAI
                let currentValue = this.plugin.settings.selectedLLM;
                if ((this.app as any).isMobile && currentValue === 'anthropic') {
                    currentValue = 'openai';
                    // Also update the settings
                    this.plugin.settings.selectedLLM = 'openai';
                    this.plugin.saveSettings();
                }
                
                // Set the current value
                dropdown.setValue(currentValue);
                
                // Add change handler
                dropdown.onChange(async (value: string) => {
                    // Check for Node.js availability when selecting Anthropic
                    if (value === 'anthropic') {
                        const nodeAvailable = await checkNodeAvailability();
                        if (!nodeAvailable) {
                            // Show error message
                            new Notice('Node.js is not installed or not found in your system PATH. Anthropic (Claude) requires Node.js to function. Please install Node.js from https://nodejs.org/ and ensure it is added to your PATH.');
                            
                            // Reset to default LLM
                            dropdown.setValue('openai');
                            this.plugin.settings.selectedLLM = 'openai';
                            await this.plugin.saveSettings();
                            return;
                        }
                    }
                    
                    // Set appropriate max token value based on provider
                    if (value === 'google') {
                        this.plugin.settings.maxTokens = 8192;
                        new Notice('Max tokens set to 8192 for Google provider');
                    } else {
                        this.plugin.settings.maxTokens = 4096;
                        new Notice('Max tokens set to 4096');
                    }
                    
                    // Normal flow if not Anthropic or if Node.js is available
                    this.plugin.settings.selectedLLM = value;
                    await this.plugin.saveSettings();
                    
                    // Refresh the display to update the max tokens field
                    this.display();
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
                .addText(text => text
                    .setPlaceholder(placeholder)
                    .setValue(this.plugin.settings.apiKeys[provider])
                    .onChange(async (value: string) => {
                        this.plugin.settings.apiKeys[provider] = value;
                        await this.plugin.saveSettings();
                    }));
            
            // Reference for dropdown to update later
            let modelDropdown: any;
            
            // Add dropdown for preset models
            setting.addDropdown(dropdown => {
                // Store reference
                modelDropdown = dropdown;
                
                // Add all models to dropdown
                modelOptions.forEach(model => dropdown.addOption(model, model));
                
                // Add "Custom" option
                dropdown.addOption('custom', '-- Custom Model --');
                
                // Determine the current selection
                const currentModel = this.plugin.settings.selectedModels[provider];
                let validSelection = modelOptions.includes(currentModel) ? currentModel : 'custom';
                
                // Set current selection
                dropdown.setValue(validSelection)
                    .onChange(async (value: string) => {
                        if (value !== 'custom') {
                            // Update model with dropdown selection
                            this.plugin.settings.selectedModels[provider] = value;
                            // Clear custom field
                            customField.setValue('');
                            await this.plugin.saveSettings();
                        }
                    });
                
                return dropdown;
            });
            
            // Reference to store custom field
            let customField: any;
            
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
                    .onChange(async (value: string) => {
                        if (value && value.trim() !== '') {
                            // Update model with custom value
                            this.plugin.settings.selectedModels[provider] = value;
                            // Set dropdown to custom
                            modelDropdown.setValue('custom');
                            await this.plugin.saveSettings();
                        } else if (modelDropdown.getValue() === 'custom') {
                            // If custom field is cleared and dropdown is on custom, reset to default
                            modelDropdown.setValue(defaultModelValue);
                            this.plugin.settings.selectedModels[provider] = defaultModelValue;
                            await this.plugin.saveSettings();
                        }
                    });
                
                return text;
            });
            
            return setting;
        };
        
        // Create settings for each provider with their specific options
        createProviderSetting(
            'openai',                      // provider
            'OpenAI',                      // display name
            'sk-...',                      // API key placeholder
            [                              // model options
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
        
        // Handle Anthropic settings based on platform
        if (!(this.app as any).isMobile) {
            // On desktop: Show normal Anthropic settings
            createProviderSetting(
                'anthropic',
                'Anthropic',
                'sk-ant-...',
                [
                    'claude-3-7-sonnet-20250219',
                    'claude-3-5-sonnet-20241022',
                    'claude-3-opus-20240229',
                    'claude-3-haiku-20240307'
                ],
                'claude-3-sonnet-20240229'
            );
        } else {
            // On mobile: Just show a notice about Anthropic unavailability
            const noticeEl = settingsContainer.createEl('div', {
                cls: 'anthropic-unavailable-notice',
                attr: { 
                    style: 'background: var(--background-secondary); padding: 10px; border-radius: 5px; margin-bottom: 15px;'
                }
            });
            
            noticeEl.createEl('div', {
                text: 'Anthropic (Claude)',
                attr: { style: 'font-weight: bold; margin-bottom: 5px;' }
            });
            
            noticeEl.createEl('div', {
                text: 'Anthropic is not available on mobile devices since it requires Node.js.',
                attr: { style: 'color: var(--text-error);' }
            });
        }
        
        // Google provider settings (always shown on all platforms)
        createProviderSetting(
            'google',
            'Google',
            'AIza...',
            [
                'gemini-ultra (beta)',
                'gemini-1.5-pro',
                'gemini-1.5-flash',
                'gemini-pro',
                'gemini-pro-vision',
                'gemini-1.0-pro'
            ],
            'gemini-1.5-pro'
        );
        
        // Ollama provider settings (always shown on all platforms)
        createProviderSetting(
            'ollama',
            'Ollama',
            'http://localhost:11434',
            [
                'llama3',
                'llama3:8b',
                'llama3:70b',
                'mistral',
                'mixtral',
                'gemma',
                'codellama',
                'phi',
                'wizardcoder',
                'solar'
            ],
            'llama3'
        );
        
        // LLM Parameters
        new Setting(settingsContainer)
            .setName('Temperature')
            .setDesc(`Controls randomness of output (0-1). Lower is more focused, higher is more creative. Current value: ${this.plugin.settings.temperature}`)
            .addSlider(slider => slider
                .setLimits(0, 1, 0.1)
                .setValue(this.plugin.settings.temperature)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.temperature = value;
                    // Update the description text to show the current value
                    this.display();
                    await this.plugin.saveSettings();
                }));
        
        new Setting(settingsContainer)
            .setName('Max Tokens')
            .setDesc('Maximum length of summary output')
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(String(this.plugin.settings.maxTokens))
                .onChange(async (value: string) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue)) {
                        this.plugin.settings.maxTokens = numValue;
                        await this.plugin.saveSettings();
                    }
                }))
            .addExtraButton(button => {
                button
                    .setIcon('alert-triangle')
                    .setTooltip('Max tokens should NOT be confused with the size of the context window. This setting reflects the maximum output returned by the model and is quite sensitive - exceeding this limit will cause the LLM to fail. 4096 is a standard limit (as of 2025), though this may increase in the future. If you use custom models, always ensure this parameter is aligned with your model\'s capabilities.');
            });
        
        // After the Transcript section (before the LLM section)
        settingsContainer.createEl('h3', { text: 'Note Format Settings' });
        
        new Setting(settingsContainer)
            .setName('Prepend Date to Note Title')
            .setDesc('Automatically add date to the beginning of note filenames')
            .addDropdown((dropdown: any) => dropdown
                .addOption('true', 'Enabled')
                .addOption('false', 'Disabled')
                .setValue(this.plugin.settings.prependDate ? 'true' : 'false')
                .onChange(async (value: string) => {
                    this.plugin.settings.prependDate = value === 'true';
                    await this.plugin.saveSettings();
                }));

        new Setting(settingsContainer)
            .setName('Date Format')
            .setDesc('Format for date prepended to note titles')
            .addDropdown((dropdown: any) => dropdown
                .addOption('YYYY-MM-DD', 'YYYY-MM-DD (2023-12-31)')
                .addOption('MM-DD-YYYY', 'MM-DD-YYYY (12-31-2023)') 
                .addOption('DD-MM-YYYY', 'DD-MM-YYYY (31-12-2023)')
                .setValue(this.plugin.settings.dateFormat)
                .onChange(async (value: string) => {
                    this.plugin.settings.dateFormat = value;
                    await this.plugin.saveSettings();
                }));

        // After the LLM Settings, add Prompt Settings
        settingsContainer.createEl('h3', { text: 'Prompt Settings' });

        // Create a sub-heading for Fast Summary prompts
        settingsContainer.createEl('h4', { text: 'Fast Summary Prompts', attr: { style: 'margin-bottom: 10px;' } });
        
        new Setting(settingsContainer)
            .setName('System Prompt (Fast Summary)')
            .setDesc('Instructions for the LLM\'s behavior when generating fast summaries')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('You are a helpful assistant...')
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value: string) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.plugin.saveSettings();
                    });
                
                // Access the DOM element and set its style
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.width = '400px';
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.minHeight = '100px';
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(async () => {
                        this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });
        
        new Setting(settingsContainer)
            .setName('User Prompt (Fast Summary)')
            .setDesc('Specific instructions for summarizing the transcript quickly and concisely')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('Please summarize the following YouTube transcript...')
                    .setValue(this.plugin.settings.userPrompt)
                    .onChange(async (value: string) => {
                        this.plugin.settings.userPrompt = value;
                        await this.plugin.saveSettings();
                    });
                
                // Access the DOM element and set its style
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.width = '400px';
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.minHeight = '100px';
                
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
        settingsContainer.createEl('h4', { text: 'Extensive Summary Prompts', attr: { style: 'margin-top: 20px; margin-bottom: 10px;' } });
        
        new Setting(settingsContainer)
            .setName('System Prompt (Extensive Summary)')
            .setDesc('Instructions for the LLM\'s behavior when generating detailed, comprehensive summaries')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('You are an analytical assistant...')
                    .setValue(this.plugin.settings.extensiveSystemPrompt)
                    .onChange(async (value: string) => {
                        this.plugin.settings.extensiveSystemPrompt = value;
                        await this.plugin.saveSettings();
                    });
                
                // Access the DOM element and set its style
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.width = '400px';
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.minHeight = '100px';
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(async () => {
                        this.plugin.settings.extensiveSystemPrompt = DEFAULT_SETTINGS.extensiveSystemPrompt;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });
        
        new Setting(settingsContainer)
            .setName('User Prompt (Extensive Summary)')
            .setDesc('Specific instructions for creating detailed and structured notes from the transcript')
            .addTextArea(text => {
                const textComponent = text
                    .setPlaceholder('From the transcript below, create detailed and structured notes...')
                    .setValue(this.plugin.settings.extensiveUserPrompt)
                    .onChange(async (value: string) => {
                        this.plugin.settings.extensiveUserPrompt = value;
                        await this.plugin.saveSettings();
                    });
                
                // Access the DOM element and set its style
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.width = '400px';
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                textComponent.inputEl.style.minHeight = '100px';
                
                return textComponent;
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip('Reset to default')
                    .onClick(async () => {
                        this.plugin.settings.extensiveUserPrompt = DEFAULT_SETTINGS.extensiveUserPrompt;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });
        
        // Default Summary Mode Setting
        new Setting(settingsContainer)
            .setName('Default Summary Mode')
            .setDesc('Choose the default summary mode to use when the plugin starts. Fast Summary mode skips timestamp links for quicker processing.')
            .addDropdown((dropdown: any) => dropdown
                .addOption('false', 'Extensive Summary (Detailed)')
                .addOption('true', 'Fast Summary (Brief)')
                .setValue(this.plugin.settings.useFastSummary ? 'true' : 'false')
                .onChange(async (value: string) => {
                    this.plugin.settings.useFastSummary = value === 'true';
                    await this.plugin.saveSettings();
                }));
                
        // Add timestamp links setting
        new Setting(settingsContainer)
            .setName('Add YouTube Timestamp Links')
            .setDesc('Add links to each numbered section heading that jump to the corresponding timestamp in the YouTube video (Note: Disabled in Fast Summary Mode)')
            .addDropdown(dropdown => dropdown
                .addOption('true', 'Enabled')
                .addOption('false', 'Disabled')
                .setValue(this.plugin.settings.addTimestampLinks ? 'true' : 'false')
                .onChange(async (value: string) => {
                    this.plugin.settings.addTimestampLinks = value === 'true';
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(button => {
                button
                    .setIcon('info')
                    .setTooltip('When enabled, reduces first pass tokens by 12% to make room for links. Automatically disabled in Fast Summary Mode.');
            });
            
        // Advanced Settings
        settingsContainer.createEl('h3', { text: 'Advanced Settings' });
        
        // Debug logging toggle
        new Setting(settingsContainer)
            .setName('Enable Debug Logging')
            .setDesc('Enable detailed debug logs in the console. Useful for troubleshooting but may affect performance.')
            .addDropdown(dropdown => dropdown
                .addOption('true', 'Enabled')
                .addOption('false', 'Disabled')
                .setValue(this.plugin.settings.debugLogging ? 'true' : 'false')
                .onChange(async (value: string) => {
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
                }))
            .addExtraButton((button: any) => {
                button
                    .setIcon('info')
                    .setTooltip('When enabled, additional debug information will be logged to the developer console (Ctrl+Shift+I)');
            });
    }

    // Helper function to create info icons with tooltips
    private createInfoIcon(container: HTMLElement, tooltipText: string): HTMLElement {
        // Add info icon
        const infoIcon = container.createEl('span', {
            attr: { 
                style: 'cursor: help; color: var(--text-muted); font-size: 16px; display: flex; align-items: center; justify-content: center;',
                'aria-label': 'Information'
            }
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
        
        // Add tooltip on hover
        infoIcon.addEventListener('mouseenter', (e) => {
            const tooltip = document.createElement('div');
            tooltip.className = 'settings-tooltip';
            tooltip.textContent = tooltipText;
            tooltip.style.position = 'absolute';
            tooltip.style.zIndex = '1000';
            tooltip.style.backgroundColor = 'var(--background-secondary)';
            tooltip.style.color = 'var(--text-normal)';
            tooltip.style.padding = '8px 12px';
            tooltip.style.borderRadius = '4px';
            tooltip.style.fontSize = '14px';
            tooltip.style.maxWidth = '300px';
            tooltip.style.boxShadow = '0 2px 5px rgba(0, 0, 0, 0.2)';
            tooltip.style.top = `${e.clientY + 10}px`;
            tooltip.style.left = `${e.clientX + 10}px`;
            
            document.body.appendChild(tooltip);
            
            const removeTooltip = () => {
                document.body.removeChild(tooltip);
                infoIcon.removeEventListener('mouseleave', removeTooltip);
                infoIcon.removeEventListener('click', removeTooltip);
            };
            
            infoIcon.addEventListener('mouseleave', removeTooltip);
            infoIcon.addEventListener('click', removeTooltip);
        });
        
        return infoIcon;
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
        // @ts-ignore - Templater API isn't typed
        const templater = this.app.plugins?.plugins?.['templater-obsidian'];
        if (templater && templater.settings && templater.settings.templates_folder) {
            this.templatesFolder = templater.settings.templates_folder;
            
            // Normalize templatesFolder using path utility
            this.templatesFolder = normalizePath(this.templatesFolder);
        }
        
        console.log("[DEBUG] Template picker initialized with templates folder:", this.templatesFolder);
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Select Template File' });
        
        // Get all markdown files in the vault
        // @ts-ignore - Using Obsidian API types
        const allFiles = this.app.vault.getMarkdownFiles();
        console.log("[DEBUG] Total markdown files in vault:", allFiles.length);
        
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
                    console.log("[DEBUG] Found template file:", file.path);
                }
                
                return isTemplate;
            })
            // @ts-ignore - Using Obsidian API types
            .map(file => ({ path: file.path }));
        
        console.log("[DEBUG] Found", this.templates.length, "template files");
        
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

        // Create template list container
        const templateListEl = contentEl.createEl('div', { cls: 'template-list' });
        templateListEl.style.maxHeight = '300px';
        templateListEl.style.overflow = 'auto';
        templateListEl.style.marginTop = '10px';
        
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
            const item = templateListEl.createEl('div', { cls: 'template-item' });
            item.style.padding = '5px';
            item.style.cursor = 'pointer';
            item.style.borderBottom = '1px solid var(--background-modifier-border)';
            
            item.createEl('span', { text: template.path });
            
            item.addEventListener('click', () => {
                console.log("[DEBUG] Selected template file:", template.path);
                this.result(template.path);
                this.close();
            });
            
            item.addEventListener('mouseenter', () => {
                item.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            
            item.addEventListener('mouseleave', () => {
                item.style.backgroundColor = '';
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
    
    async onOpen() {
        await this.loadFolders();
        this.renderFolderPicker();
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
                // @ts-ignore - Using Obsidian API
                if (!this.app.vault.getAbstractFileByPath(rootFolderPath)) {
                    // @ts-ignore - Using Obsidian API
                    await ensureFolder(this.app.vault, rootFolderPath);
                    console.log(`[DEBUG] Created ${rootFolderPath} folder`);
                }
            } catch (e) {
                console.error('Error ensuring root folder exists:', e);
            }
            
            // Get all files in the vault
            // @ts-ignore - Using Obsidian API
            const files = this.app.vault.getAllLoadedFiles();
            
            // First, find the root folder object
            // @ts-ignore - Using Obsidian API
            const rootFolderObj = files.find(f => {
                const path = f.path || '';
                return path === rootFolder || path === normalizedRootFolder;
            });
            
            // Add root folder first
            this.folders.push({ 
                path: normalizedRootFolder, 
                name: rootFolder
            });
            uniquePaths.add(normalizedRootFolder);
            
            // If we found the root folder, check its children
            if (rootFolderObj && 'children' in rootFolderObj) {
                // @ts-ignore - Using Obsidian API
                for (const child of rootFolderObj.children) {
                    
                    if (child.type === 'folder') {
                        const normalizedPath = normalizePath(child.path, false); // Keep leading slash for display
                        if (!uniquePaths.has(normalizedPath)) {
                            this.folders.push({
                                path: normalizedPath,
                                name: child.path
                            });
                            uniquePaths.add(normalizedPath);
                        }
                    }
                }
            }
            
            // Also check all files for any that might be under root folder
            const rootFolderPrefix = rootFolder + '/';
            const normalizedRootFolderPrefix = normalizedRootFolder + '/';
            
            for (const file of files) {
                // Check if it's a folder
                // @ts-ignore - Using Obsidian API
                if (file && file.type === 'folder') {
                    const path = file.path || '';
                    
                    // Check if it's under our root folder
                    if (path.startsWith(rootFolderPrefix) || path.startsWith(normalizedRootFolderPrefix)) {
                        const normalizedPath = normalizePath(path, false); // Keep leading slash for display
                        if (!uniquePaths.has(normalizedPath)) {
                            this.folders.push({
                                path: normalizedPath,
                                name: path
                            });
                            uniquePaths.add(normalizedPath);
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
            
        } catch (err) {
            console.error('Error loading folders:', err);
        }
    }
    
    private renderFolderPicker() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Get the root folder name for display
        const rootFolder = this.plugin.settings.transcriptRootFolder || 'Inbox';
        const normalizedRootFolder = normalizePath(rootFolder, false); // Keep leading slash for display
        
        // Simple title only
        contentEl.createEl('h2', { text: 'Select Folder Location' });
        
        // Debug info about folder count
        const rootSubfolderCount = this.folders.length - 1; // Subtract root folder itself
        if (rootSubfolderCount <= 0) {
            contentEl.createEl('div', {
                text: `No subfolders found under ${rootFolder}`,
                attr: { style: 'font-size: 12px; color: var(--text-error); text-align: center; margin-bottom: 10px;' }
            });
        } else {
            contentEl.createEl('div', {
                text: `Found ${rootSubfolderCount} subfolder${rootSubfolderCount === 1 ? '' : 's'}`,
                attr: { style: 'font-size: 12px; color: var(--text-muted); text-align: center; margin-bottom: 10px;' }
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
            
            console.log(`Displaying ${foldersToShow.length} folders`);
            
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
                iconEl.innerHTML = '📁';
                
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
        console.log("[DEBUG] Selected folder path:", folderPath);
        console.log("[DEBUG] Normalized folder path:", normalizedPath);
        this.onSelectFolder(normalizedPath);
        this.close();
    }
}

// Add the LicenseModal class
class LicenseModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    async onOpen() {
        const { contentEl } = this;
        
        // Set wider width for the modal using direct DOM manipulation
        const modalEl = (this as any).modalEl as HTMLElement;
        if (modalEl) {
            modalEl.style.width = "700px";
            modalEl.style.maxWidth = "80vw";
        }
        
        contentEl.createEl('h2', { text: 'YouTube Transcript Plugin License' });

        try {
            // Get the plugin folder path
            // @ts-ignore - As we're accessing internal API
            const pluginId = this.app.plugins.manifest?.["tubesage"]?.id || "tubesage";
            
            // Try to read the license file - from multiple possible locations
            let licenseContent = '';
            let licenseFound = false;
            
            // List of possible file paths to try - use platform-independent paths with forward slashes
            const possiblePaths = [
                // Plugin directory paths
                `.obsidian/plugins/${pluginId}/MIT-license-tubesage.md`,
                `.obsidian/plugins/${pluginId}/LICENSE.md`,
                `.obsidian/plugins/${pluginId}/license.md`,
                
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
                    console.log(`Trying to find license file at: ${normalizedPath}`);
                    licenseContent = await this.app.vault.adapter.read(normalizedPath);
                    console.log(`License file found at: ${normalizedPath}`);
                    licenseFound = true;
                    break;
                } catch (e) {
                    console.log(`Failed to read license file at ${filePath}:`, e);
                    // Continue to next path
                }
            }
            
            if (!licenseFound) {
                throw new Error('Could not find license file in any of the expected locations.');
            }
            
            // Create a div for the license content with scrollable style
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
                    licenseContainer.createEl('h3', { 
                        text: line.substring(2),
                        attr: { style: 'margin-top: 16px; margin-bottom: 12px; font-weight: 600; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 8px;' }
                    });
                }
                // Handle list items
                else if (line.match(/^\d+\.\s+\*\*.*\*\*/)) {
                    inList = true;
                    const listItem = licenseContainer.createEl('div', {
                        attr: { style: 'margin-bottom: 8px;' }
                    });
                    
                    // Extract and format the list item
                    const match = line.match(/^(\d+)\.\s+\*\*(.*?)\*\*:\s+(.*)/);
                    if (match) {
                        const [, number, title, content] = match;
                        
                        listItem.createEl('span', {
                            text: `${number}. `,
                            attr: { style: 'font-weight: bold;' }
                        });
                        
                        listItem.createEl('span', {
                            text: `${title}: `,
                            attr: { style: 'font-weight: bold;' }
                        });
                        
                        listItem.createSpan({ text: content });
                    } else {
                        listItem.innerHTML = line;
                    }
                }
                // Handle list sub-items
                else if (inList && line.match(/^\s+-\s+/)) {
                    const subItem = licenseContainer.createEl('div', {
                        attr: { style: 'margin-left: 20px; margin-bottom: 4px;' }
                    });
                    subItem.innerHTML = line.replace(/^\s+-\s+/, '• ');
                }
                // Handle normal paragraphs
                else if (line.trim() !== '') {
                    inList = false;
                    licenseContainer.createEl('p', { 
                        text: line,
                        attr: { style: 'margin-bottom: 8px; max-width: 100%; word-break: normal; overflow-wrap: normal; white-space: pre-wrap;' }
                    });
                }
                // Handle empty lines
                else {
                    licenseContainer.createEl('div', { 
                        attr: { style: 'height: 8px;' }
                    });
                }
            }
        } catch (error) {
            // Handle error if license file can't be read
            console.error('Error loading license file:', error);
            contentEl.createEl('p', { 
                text: 'Could not load license file. Please check that a license file (LICENSE.md or MIT-license-tubesage.md) exists in your plugin directory.',
                attr: { style: 'color: var(--text-error);' }
            });
        }
        
        // Add close button
        const footerEl = contentEl.createEl('div', {
            attr: { style: 'margin-top: 20px; text-align: center;' }
        });
        
        const closeButton = footerEl.createEl('button', {
            text: 'Close',
            attr: { 
                style: 'padding: 8px 16px; background-color: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer;'
            }
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

// Add the LicenseRequiredModal class
class LicenseRequiredModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Set a suitable width for the modal
        const modalEl = (this as any).modalEl as HTMLElement;
        if (modalEl) {
            modalEl.style.width = "500px";
        }
        
        // Add title
        contentEl.createEl('h2', { 
            text: 'License Acceptance Required', 
            attr: { style: 'text-align: center; color: var(--text-error);' }
        });
        
        // Add warning icon
        const iconContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: center; margin: 20px 0;' }
        });
        
        iconContainer.createEl('span', { 
            attr: { 
                style: 'font-size: 48px; color: var(--text-warning);',
                'aria-hidden': 'true'
            },
            text: '⚠️'
        });
        
        // Add message
        const messageDiv = contentEl.createEl('div', {
            attr: { style: 'margin-bottom: 20px; text-align: center; line-height: 1.5;' }
        });
        
        messageDiv.createEl('p', {
            text: 'You must accept the plugin license before using this feature.',
            attr: { style: 'font-weight: bold; margin-bottom: 10px;' }
        });
        
        messageDiv.createEl('p', {
            text: 'Please go to the plugin settings and accept the license terms to continue.'
        });
        
        // Add instructions with steps
        const stepsDiv = contentEl.createEl('div', {
            attr: { style: 'background-color: var(--background-secondary); padding: 15px; border-radius: 8px; margin-bottom: 20px;' }
        });
        
        stepsDiv.createEl('p', {
            text: 'How to accept the license:',
            attr: { style: 'font-weight: bold; margin-bottom: 8px;' }
        });
        
        const steps = [
            'Open Obsidian Settings',
            'Scroll down to the "Plugins" section in the sidebar',
            'Find "YouTube Transcript" in the Community Plugins list',
            'Click the "YouTube Transcript" plugin settings',
            'Toggle "Accept License" to enable the plugin'
        ];
        
        const stepsList = stepsDiv.createEl('ol', {
            attr: { style: 'margin-left: 15px; margin-top: 0;' }
        });
        
        steps.forEach(step => {
            stepsList.createEl('li', {
                text: step,
                attr: { style: 'margin-bottom: 5px;' }
            });
        });
        
        // Add buttons
        const buttonContainer = contentEl.createEl('div', {
            attr: { style: 'display: flex; justify-content: space-between; margin-top: 20px;' }
        });
        
        // Open settings button
        const openSettingsButton = buttonContainer.createEl('button', {
            text: 'Open Plugin Settings',
            attr: {
                style: 'padding: 8px 12px; background-color: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer; flex: 1; margin-right: 10px;'
            }
        });
        
        // Close button
        const closeButton = buttonContainer.createEl('button', {
            text: 'Close',
            attr: {
                style: 'padding: 8px 12px; background-color: var(--background-modifier-border); color: var(--text-normal); border: none; border-radius: 4px; cursor: pointer; flex: 1; margin-left: 10px;'
            }
        });
        
        // Add event listeners
        openSettingsButton.addEventListener('click', () => {
            this.close();
            // @ts-ignore - App has this method but TypeScript definition doesn't include it
            this.app.setting.open('tubesage');
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

    async onOpen() {
        const { contentEl } = this;
        
        // Set wider width for the modal using direct DOM manipulation
        const modalEl = (this as any).modalEl as HTMLElement;
        if (modalEl) {
            modalEl.style.width = "800px";
            modalEl.style.maxWidth = "85vw";
        }
        
        contentEl.createEl('h2', { text: 'YouTube Transcript Plugin Documentation' });

        try {
            // Get the plugin folder path
            // @ts-ignore - As we're accessing internal API
            const pluginId = this.app.plugins.manifest?.["tubesage"]?.id || "tubesage";
            
            // Try to read the README file from multiple possible locations
            let readmeContent = '';
            let readmeFound = false;
            
            // List of possible file paths to try - use platform-independent paths with forward slashes
            const possiblePaths = [
                // Plugin directory paths
                `.obsidian/plugins/${pluginId}/README.md`,
                `.obsidian/plugins/${pluginId}/readme.md`,
                
                // Root directory paths
                `README.md`,
                `readme.md`
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    // Always normalize path before reading to ensure consistent slashes
                    const normalizedPath = normalizePath(filePath);
                    console.log(`Trying to find README file at: ${normalizedPath}`);
                    readmeContent = await this.app.vault.adapter.read(normalizedPath);
                    console.log(`README file found at: ${normalizedPath}`);
                    readmeFound = true;
                    break;
                } catch (e) {
                    console.log(`Failed to read README file at ${filePath}:`, e);
                    // Continue to next path
                }
            }
            
            if (!readmeFound) {
                throw new Error('Could not find README file in any of the expected locations.');
            }
            
            // Create a div for the README content with scrollable style
            const readmeContainer = contentEl.createEl('div', {
                attr: {
                    style: 'max-height: 550px; overflow-y: auto; padding: 20px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-top: 10px; white-space: pre-wrap; font-family: var(--font-interface); line-height: 1.6;'
                }
            });
            
            // Process the README markdown content
            const lines = readmeContent.split('\n');
            let inList = false;
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
                            attr: { 
                                style: 'background: var(--background-secondary); border-radius: 4px; padding: 8px; margin: 10px 0; overflow-x: auto;' 
                            },
                            cls: 'code-block-container'
                        });
                        
                        // Add language tag if specified
                        if (codeLanguage) {
                            codeContainer.createEl('div', {
                                text: codeLanguage,
                                attr: { 
                                    style: 'font-size: 12px; color: var(--text-muted); margin-bottom: 4px; font-family: var(--font-monospace);' 
                                }
                            });
                        }
                        
                        // Create pre>code element for the code
                        const pre = codeContainer.createEl('pre', {
                            attr: { style: 'margin: 0; overflow-x: auto;' }
                        });
                        pre.createEl('code', {
                            attr: { 
                                style: 'font-family: var(--font-monospace); display: block;',
                                class: codeLanguage ? `language-${codeLanguage}` : ''
                            }
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
                    inList = false;
                    readmeContainer.createEl('h1', { 
                        text: line.substring(2),
                        attr: { style: 'margin-top: 16px; margin-bottom: 12px; font-weight: 700; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 8px; font-size: 1.8em;' }
                    });
                } else if (line.startsWith('## ')) {
                    inList = false;
                    readmeContainer.createEl('h2', { 
                        text: line.substring(3),
                        attr: { style: 'margin-top: 16px; margin-bottom: 10px; font-weight: 600; font-size: 1.5em;' }
                    });
                } else if (line.startsWith('### ')) {
                    inList = false;
                    readmeContainer.createEl('h3', { 
                        text: line.substring(4),
                        attr: { style: 'margin-top: 14px; margin-bottom: 8px; font-weight: 600; font-size: 1.2em;' }
                    });
                }
                // Handle list items
                else if (line.match(/^[*\-\+]\s/)) {
                    inList = true;
                    const listItem = readmeContainer.createEl('div', {
                        attr: { 
                            style: 'margin: 4px 0 4px 20px; display: flex;'
                        }
                    });
                    
                    // Bullet
                    listItem.createEl('span', {
                        text: '• ',
                        attr: { style: 'margin-right: 6px;' }
                    });
                    
                    // Content
                    const content = line.replace(/^[*\-\+]\s/, '');
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
                                        style: 'color: var(--text-accent); text-decoration: none;',
                                        target: '_blank'
                                    }
                                });
                            } else {
                                contentSpan.createSpan({ text: part.text });
                            }
                        });
                    } else {
                        listItem.createSpan({ text: content });
                    }
                }
                // Handle normal paragraphs
                else if (line.trim() !== '') {
                    inList = false;
                    const para = readmeContainer.createEl('p', { 
                        attr: { style: 'margin-bottom: 12px; max-width: 100%; line-height: 1.6;' }
                    });
                    
                    // Check for links
                    if (line.includes('[') && line.includes('](')) {
                        const parts = this.splitMarkdownLink(line);
                        
                        parts.forEach(part => {
                            if (part.isLink) {
                                para.createEl('a', {
                                    text: part.text,
                                    attr: {
                                        href: part.url || '#',
                                        style: 'color: var(--text-accent); text-decoration: none;',
                                        target: '_blank'
                                    }
                                });
                            } else {
                                para.createSpan({ text: part.text });
                            }
                        });
                    } else {
                        para.setText(line);
                    }
                }
                // Handle empty lines with more spacing between sections
                else {
                    readmeContainer.createEl('div', { 
                        attr: { style: 'height: 8px;' }
                    });
                }
            }
        } catch (error) {
            // Handle error if README file can't be read
            console.error('Error loading README file:', error);
            contentEl.createEl('p', { 
                text: 'Could not load README file. Please check that README.md exists in your plugin directory.',
                attr: { style: 'color: var(--text-error);' }
            });
        }
        
        // Add close button
        const footerEl = contentEl.createEl('div', {
            attr: { style: 'margin-top: 20px; text-align: center;' }
        });
        
        const closeButton = footerEl.createEl('button', {
            text: 'Close',
            attr: { 
                style: 'padding: 8px 16px; background-color: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer;'
            }
        });
        
        closeButton.addEventListener('click', () => {
            this.close();
        });
    }
    
    // Helper to handle markdown links
    private splitMarkdownLink(text: string): Array<{text: string, url?: string, isLink: boolean}> {
        const parts: Array<{text: string, url?: string, isLink: boolean}> = [];
        let remaining = text;
        let currentIndex = 0;
        
        while (currentIndex < remaining.length) {
            // Find opening bracket
            const openBracketIndex = remaining.indexOf('[', currentIndex);
            if (openBracketIndex === -1) {
                // No more links, add the rest as plain text
                parts.push({
                    text: remaining.substring(currentIndex),
                    isLink: false
                });
                break;
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

    async onOpen() {
        const { contentEl } = this;
        
        // Set wider width for the modal using direct DOM manipulation
        const modalEl = (this as any).modalEl as HTMLElement;
        if (modalEl) {
            modalEl.style.width = "700px";
            modalEl.style.maxWidth = "80vw";
        }
        
        contentEl.createEl('h2', { 
            text: 'Example Template: Copy and place in your Templater Plugin Specified Template directory',
            attr: { style: 'font-size: 18px; line-height: 1.4;' }
        });

        try {
            // Get the plugin folder path
            // @ts-ignore - As we're accessing internal API
            const pluginId = this.app.plugins.manifest?.["tubesage"]?.id || "tubesage";
            
            // Try to read the template file from multiple possible locations
            let templateContent = '';
            let templateFound = false;
            
            // List of possible file paths to try
            const possiblePaths = [
                // Plugin directory paths
                normalizePath(`.obsidian/plugins/${pluginId}/templates/YouTubeTranscript.md`),
                normalizePath(`.obsidian/plugins/${pluginId}/templates/youtubeTranscript.md`),
                
                // Standard templates directory paths
                normalizePath('templates/YouTubeTranscript.md'),
                normalizePath('templates/youtubeTranscript.md'),
                normalizePath('Templates/YouTubeTranscript.md'),
                normalizePath('Templates/youtubeTranscript.md')
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    console.log(`Trying to find template file at: ${filePath}`);
                    templateContent = await this.app.vault.adapter.read(filePath);
                    console.log(`Template file found at: ${filePath}`);
                    templateFound = true;
                    break;
                } catch (e) {
                    // Continue to next path
                }
            }
            
            if (!templateFound) {
                throw new Error('Could not find template file in any of the expected locations.');
            }
            
            // Create a div for the template content with scrollable style
            const templateContainer = contentEl.createEl('div', {
                attr: {
                    style: 'max-height: 500px; overflow-y: auto; padding: 20px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-top: 10px; white-space: pre-wrap; font-family: var(--font-monospace); line-height: 1.5;'
                }
            });
            
            // Create a container for the copy button
            const copyContainer = contentEl.createEl('div', {
                attr: {
                    style: 'display: flex; justify-content: flex-end; margin-top: 8px; margin-bottom: 8px;'
                }
            });
            
            // Add copy text
            copyContainer.createEl('span', { 
                text: 'Copy Template', 
                attr: { style: 'font-size: 14px; margin-right: 8px; cursor: pointer;' }
            });
            
            // Copy icon button
            const copyButton = copyContainer.createEl('button', {
                attr: {
                    style: 'background: transparent; border: none; cursor: pointer; padding: 4px; border-radius: 4px; color: var(--text-normal); display: flex; align-items: center; justify-content: center;'
                }
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
                copyButton.style.background = 'var(--background-modifier-hover)';
            });
            
            copyButton.addEventListener('mouseleave', () => {
                copyButton.style.background = 'transparent';
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
                            copyTextElement.textContent = '✓ Copied!';
                            setTimeout(() => {
                                copyTextElement.textContent = originalText;
                            }, 2000);
                        }
                    })
                    .catch(err => {
                        console.error('Failed to copy template:', err);
                        // Show error state
                        if (copyTextElement) {
                            copyTextElement.textContent = '✗ Failed to copy';
                            setTimeout(() => {
                                copyTextElement.textContent = 'Copy Template';
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
                text: 'This is the example Templater template used for YouTube transcript notes. You can customize this template for your own needs.',
                attr: {
                    style: 'margin-top: 15px; font-style: italic; color: var(--text-muted);'
                }
            });
            
            // Add Templater variables explanation
            const variablesContainer = contentEl.createEl('div', {
                attr: {
                    style: 'margin-top: 15px; border: 1px solid var(--background-modifier-border); padding: 15px; border-radius: 4px;'
                }
            });
            
            variablesContainer.createEl('h3', {text: 'Available Template Variables:'});
            
            const variables = [
                {name: 'tp.user.title', desc: 'The title of the YouTube video'},
                {name: 'tp.user.videoUrl', desc: 'The URL of the YouTube video'},
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
            console.error('Error loading template file:', error);
            contentEl.createEl('p', { 
                text: 'Could not load template file. Please check that the template exists in your plugin directory or vault templates folder.',
                attr: { style: 'color: var(--text-error);' }
            });
        }
        
        // Add close button
        const footerEl = contentEl.createEl('div', {
            attr: { style: 'margin-top: 20px; text-align: center;' }
        });
        
        const closeButton = footerEl.createEl('button', {
            text: 'Close',
            attr: { 
                style: 'padding: 8px 16px; background-color: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer;'
            }
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