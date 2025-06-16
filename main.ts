import { App, Plugin, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import manifestData from './manifest.json';
import { YouTubeTranscriptExtractor } from './src/youtube-transcript';
import { TranscriptSummarizer } from './src/llm/transcript-summarizer';
import { sanitizeFilename } from './src/utils/filename-sanitizer';
import { handleApiError, getSafeErrorMessage } from './src/utils/error-utils';
import { getLogger, LogLevel, setGlobalLogLevel, clearLogs, getLogsAsString, getLogsForCallout } from './src/utils/logger';
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
    convertTimestampToSeconds
} from './src/utils/timestamp-utils';

// Initialize logger
const logger = getLogger('PLUGIN');
const transcriptLogger = getLogger('TRANSCRIPT');
const llmLogger = getLogger('LLM');

// Helper function to truncate long logs to a reasonable length
function truncateForLogs(text: string, maxLength: number = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...[truncated]';
}

// Define a minimal interface for file access that avoids TFile references
interface ObsidianFile {
    path: string;
}

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
    timestampSystemPrompt: 'You are a highly precise assistant that amends YouTube links to add timestamps to section headings in a note. You never include any reference material (like video IDs or transcripts) in your output.',
    timestampUserPrompt: `TASK: Add YouTube timestamp links to each section heading in this document.

RULES:
1. NEVER summarize or modify the content unless translation is requested
2. NEVER remove any content
3. ALWAYS return the FULL original content PLUS timestamp links at the end of section headings
4. If processing multiple sections, add timestamps to ALL headings
5. ONLY process markdown numbered headings 
    a. for subheadings (e.g., "## 1. Topic")
    b. for section headings (e.g., "## 1.1. Sub Topic")
6. DO NOT process headings without numbers or dots
7. DO NOT process horizontal rules (single #)
8. Do NOT add a preamble or postamble or headers or titles, ONLY AMEND the links to add the seconds timestamp
9. Respond only with the raw answer, no intro or outro text.
10. NEVER include any reference material marked by ----- REFERENCE MATERIAL ----- blocks in your response.

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
7. Place the link at the end of the heading line, after the heading text`,
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

export default class YouTubeTranscriptPlugin extends Plugin {
    settings: YouTubeTranscriptSettings;
    private summarizer: TranscriptSummarizer;
    private fileWatcher: any;

    // Replace the duplicated showNotice method with a wrapper that calls the shared utility
    showNotice(message: string, timeout: number = 5000): void {
        showNotice(message, timeout);
    }

    // Get plugin version from manifest
    getVersion(): string {
        return manifestData.version || 'Unknown';
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
        
        
        this.addSettingTab(new YouTubeTranscriptSettingTab(this.app, this));
        this.checkDependencies();

        // Add CSS for the modal
        const styleEl = document.createElement('style');
        styleEl.id = 'youtube-transcript-styles';
        styleEl.textContent = `
            /* Runtime helper classes — must be inline so they exist even
               if the external stylesheet fails to load */

            .tubesage-display-block { display: block; }
            .tubesage-display-none  { display: none;  }

            .tubesage-validation-visible  { display: block; }
            .tubesage-validation-hidden   { display: none;  }
            .tubesage-validation-error    { color: var(--text-error); }
            .tubesage-validation-success  { color: var(--text-success); }
            .tubesage-validation-accent   { color: var(--text-accent);  }

            /* Basic form layout (added inline to guarantee availability even if external CSS fails to load) */
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
                display: block;
                width: 100%;
                padding: 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
            }
            
            /* Fast Summary Mode boxed toggle styles */
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
            
            .summary-info {
                font-size: 12px;
                color: var(--text-muted);
                margin-top: 5px;
                font-style: italic;
            }

            /* Folder-picker modal styles (kept inline to guarantee availability) */
            .folder-search-input {
                display: block;
                width: 100%;
                padding: 8px;
                margin-bottom: 15px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background-color: var(--background-secondary);
                color: var(--text-normal);
                font-size: 14px;
            }
            
            .folder-list {
                max-height: 240px; /* ≈8 items before scroll */
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
            
            /* Pulse loader (runtime critical styles) */
            .pulse-container {
                display: inline-flex;
                justify-content: center;
                height: 60px; /* Taller to accommodate full animation */
                background: none;
                border: none;
                padding: 0;
                align-items: center; /* Center bars vertically */
            }
            
            .pulse-bar {
                width: 8px;
                height: 30px; /* Default height at rest */
                margin: 0 3px;
                border-radius: 4px;
                background-color: var(--interactive-accent);
                animation: pulse 1.5s ease-in-out infinite;
                display: inline-block;
                transform-origin: center; /* Grow from middle */
            }
            
            .pulse-bar:nth-child(1) { animation-delay: 0s;   }
            .pulse-bar:nth-child(2) { animation-delay: 0.2s; }
            .pulse-bar:nth-child(3) { animation-delay: 0.4s; }
            .pulse-bar:nth-child(4) { animation-delay: 0.6s; }
            .pulse-bar:nth-child(5) { animation-delay: 0.8s; }

            @keyframes pulse {
                0%, 100% { height: 10px; opacity: 0.3; transform: scaleY(0.25); }
                50%      { height: 30px; opacity: 1;   transform: scaleY(1); }
            }

            /* Processing modal container */
            .tubesage-processing-modal {
                width: 150px !important;
                max-width: 150px !important;
                height: 80px !important; /* Fixed height to prevent resizing */
                display: flex !important;
                justify-content: center !important;
                align-items: center !important;
                padding: 10px 0 !important;
            }
            
            /* Toggle switch styles (kept inline for guaranteed rendering) */
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

            .summary-info {
                font-size: 12px;
                color: var(--text-muted);
                margin-top: 5px;
                font-style: italic;
            }
            
            .toggle-switch {
                position: relative;
                display: inline-block;
                width: 50px; /* Width of the toggle */
                height: 24px; /* Height of the toggle */
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
                background-color: var(--background-modifier-border); /* Off state color */
                transition: .4s;
                border-radius: 24px; /* Round edges */
            }
            
            .toggle-slider:before {
                position: absolute;
                content: "";
                height: 18px; /* Knob height */
                width: 18px;  /* Knob width */
                left: 3px;    /* Position from left */
                bottom: 3px;  /* Position from bottom */
                background-color: white;
                transition: .4s;
                border-radius: 50%; /* Circular knob */
            }
            
            input:checked + .toggle-slider {
                background-color: var(--interactive-accent); /* On state color */
            }
            
            input:checked + .toggle-slider:before {
                transform: translateX(26px); /* Move knob to the right */
            }
            
            /* Channel options message spacing */
            .channel-message {
                margin-bottom: 15px; /* Add space below the message */
                font-weight: 500; /* Keep original font-weight */
            }

            /* -------------------------  Settings-tab layout helpers  ------------------------- */
            .tubesage-settings-support-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                text-align: center;
                margin-top: 10px;
                margin-bottom: 30px;
            }
            .tubesage-settings-bmc-img {
                height: 40px !important;
                width: 145px !important;
                max-width: 145px;
                display: block;
            }
            .tubesage-settings-action-buttons-container {
                display: flex;
                flex-wrap: nowrap;
                justify-content: center;
                align-items: center;
                gap: 20px;
                width: 100%;
                margin-bottom: 15px;
            }
            .tubesage-settings-action-button-item-container {
                display: flex;
                justify-content: center;
                align-items: center;
                flex: 0 0 auto;
            }
            .tubesage-settings-action-button-label {
                font-size: 14px;
                margin-right: 8px;
            }
            /* License toggle in settings */
            .tubesage-license-toggle-wrapper {
                position: relative;
                display: inline-block;
                width: 40px;
                height: 20px;
            }
            .tubesage-license-toggle-input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .tubesage-license-toggle-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: var(--background-modifier-border);
                transition: .4s;
                border-radius: 20px;
            }
            .tubesage-license-toggle-knob {
                position: absolute;
                height: 16px;
                width: 16px;
                left: 2px;
                bottom: 2px;
                background-color: white;
                transition: .4s;
                border-radius: 50%;
            }
            .tubesage-license-toggle-input:checked + .tubesage-license-toggle-slider {
                background-color: var(--interactive-accent);
            }
            .tubesage-license-toggle-input:checked + .tubesage-license-toggle-slider .tubesage-license-toggle-knob {
                transform: translateX(20px);
            }

            /* ... existing code ... */
            .tubesage-settings-container-disabled {
                opacity: 0.5;
                pointer-events: none;
                user-select: none;
                filter: grayscale(30%);
            }
            /* ... existing code ... */

            /* ... existing code within runtime style block after heading helpers ... */
            .tubesage-settings-heading-container h3 {
                margin: 0;
                flex: 0 0 auto;
            }
            .tubesage-settings-heading-container .tubesage-settings-info-icon {
                flex: 0 0 auto;
            }
            /* Tooltip and heading alignment */
            .tubesage-settings-heading-container {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .tubesage-settings-heading-container h3 {
                margin: 0;
                flex: 0 0 auto;
                white-space: nowrap;
            }
            .tubesage-settings-heading-container .tubesage-settings-info-icon {
                cursor: help;
                flex: 0 0 auto;
            }
            /* Basic tooltip appearance (inline to guarantee) */
            .tubesage-settings-tooltip {
                position: absolute;
                z-index: 1000;
                background-color: var(--background-secondary);
                color: var(--text-normal);
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 14px;
                max-width: 300px;
                box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
            }
            /* Wider prompt textareas */
            .tubesage-prompt-textarea {
                width: 66.666%;  /* take roughly two-thirds of the settings row */
                min-width: 300px;
                max-width: 600px;
            }
            .tubesage-mission-italic { font-style: italic; }
            // ... existing code before end of runtime style block ...
            .tubesage-license-container,
            .tubesage-readme-container {
                max-height: 300px !important; /* about 18 lines */
                overflow-y: auto;
            }
            .tubesage-license-modal-size.modal,
            .tubesage-readme-modal-size.modal {
                max-height: 90vh !important;
            }
            
            /* License Required Modal Styles */
            .tubesage-license-required-title {
                color: var(--text-normal);
                margin-bottom: 15px;
                font-size: 1.1em;
                font-weight: 500;
            }
            
            .tubesage-license-required-icon-container {
                display: none;
            }
            
            .tubesage-license-required-message-container {
                margin-bottom: 15px;
                font-size: 14px;
            }
            
            .tubesage-license-required-message-bold {
                font-weight: 500;
                color: var(--text-normal);
                margin-bottom: 6px !important;
                font-size: 14px;
            }
            
            .tubesage-license-required-steps-container {
                margin-bottom: 20px;
                font-size: 13px;
            }
            
            .tubesage-license-required-steps-title {
                font-weight: 500;
                margin-bottom: 8px;
                color: var(--text-normal);
                font-size: 13px;
            }
            
            .tubesage-license-required-steps-list {
                padding-left: 18px;
                line-height: 1.4;
                font-size: 13px;
            }
            
            .tubesage-license-required-step-item {
                margin-bottom: 4px;
                color: var(--text-muted);
                font-size: 13px;
            }
            
            .tubesage-license-required-button-container {
                display: flex;
                justify-content: space-between;
                gap: 10px;
                padding-top: 15px;
                border-top: 1px solid var(--background-modifier-border);
            }
            
            .tubesage-license-required-button-primary {
                flex: 1;
                padding: 8px 16px;
                background-color: var(--interactive-accent);
                color: var(--text-on-accent);
                border: none;
                border-radius: 4px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: background-color 0.2s ease;
            }
            
            .tubesage-license-required-button-primary:hover {
                background-color: var(--interactive-accent-hover);
            }
            
            .tubesage-license-required-button-secondary {
                flex: 1;
                padding: 8px 16px;
                background-color: var(--background-secondary);
                color: var(--text-normal);
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: background-color 0.2s ease;
            }
            
            .tubesage-license-required-button-secondary:hover {
                background-color: var(--background-modifier-hover);
            }
            
            // ... existing code ...
        `;
        document.head.appendChild(styleEl);

        // Add ribbon icon
        this.addRibbonIcon('youtube', 'TubeSage: Youtube Note Creator', () => {
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

        // Note: The file watcher setup has been removed as it was dependent on the anthropic proxy

    }

    async onunload() {
        logger.debug('Unloading YouTube Transcript Plugin');
        
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
        logger.info('YouTube Transcript Plugin unloaded');
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
                return 'llama3.1';
            default:
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
                        throw new Error('Invalid YouTube URL. Could not extract video ID.');
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
                    console.log(`Plugin: Failed to extract transcript for video ${i + 1}/${videoUrls.length}:`, error.message);
                    transcriptLogger.error(`Failed to extract transcript for video ${i + 1}/${videoUrls.length}:`, error);
                    // Continue with other videos, but include error result
                    results.push({
                        transcript: `[TRANSCRIPT EXTRACTION FAILED: ${error.message}]`,
                        metadata: { title: 'Failed to extract', author: 'Unknown' }
                    });
                }
            }
            
            return results;
            
        } catch (error) {
            // Use the new error handling utility
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
            
            // Get the prompt configuration
            const promptConfig = getPromptConfig(this.settings, summaryMode);
            
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
            
            // Create a summarizer with the prompt configuration
            const tempSummarizer = new TranscriptSummarizer({
                model: this.getModelForProvider(this.settings.selectedLLM),
                temperature: promptConfig.temperature,
                maxTokens: promptConfig.maxTokens,
                systemPrompt: promptConfig.systemPrompt,
                userPrompt: promptConfig.userPrompt
            }, this.settings.apiKeys);
            
            const summary = await tempSummarizer.summarize(cleanedTranscript, this.settings.selectedLLM);
            
            // Add the creator support message at the beginning of the summary 
            const supportMessage = "Support Content Creators: If you found this content valuable, please consider supporting the YouTube creator by liking 👍 the video and subscribing to their channel. ";
            
            // Sanitize the beginning of the summary to ensure clean paragraph flow
            let sanitizedSummary = summary;
            
            // Remove leading newlines, spaces, and markdown formatting from the summary
            sanitizedSummary = sanitizedSummary.replace(/^[\s\n\r]*/, '');
            
            // If the summary starts with list markers or headers, we need a line break
            if (/^(#|\-|\*|\d+\.)/.test(sanitizedSummary)) {
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
                formattedTranscript = "    [ERROR] No timestamps found in transcript. Please ensure the YouTube transcript contains timestamps.";
                
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
            const templateFile = this.app.vault.getAbstractFileByPath(normalizedTemplatePath) as ObsidianFile;
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
            
            // Debug info is only logged, not included in notes
            if (this.settings.debugLogging) {
                logger.debug(`Transcript info: 
                - Length: ${transcript ? transcript.length : 'unknown'} characters
                - Contains timestamps: ${transcript ? transcript.includes('[00:') : 'unknown'}
                - LLM Provider: ${llmProvider}
                - LLM Model: ${llmModel}`);
            }
            
            // 5. Read and parse the template with our custom context
            const templateContent = await this.app.vault.read(templateFile as unknown);
            
            // @ts-ignore - Accessing internal Templater API
            const parsedContent = await templater.parser.parse_commands(templateContent, ctx);
            
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
            this.showNotice(`Error creating note: ${error.message}`, 5000);
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
                        const playlistResponse = await obsidianFetch(
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
                            
                            const videosData = await videosResponse.json();
                            
                            if (!videosData.items || videosData.items.length === 0) {
                                break;
                            }
                            
                            // Extract video information and add to results
                            const pageVideos = videosData.items
                                .filter((item: any) => 
                                    item.snippet && 
                                    item.snippet.title && 
                                    item.snippet.resourceId && 
                                    item.snippet.resourceId.videoId)
                                .map((item: any) => ({
                                    title: item.snippet.title,
                                    url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
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
                
                const channelData = await channelResponse.json();
                
                if (!channelData.items || channelData.items.length === 0) {
                    throw new Error('Channel not found');
                }
                
                // Get channel name for display
                sourceTitle = channelData.items[0].snippet.title;
                
                // Get the uploads playlist ID
                const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;
                
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
                    
                    const videosData = await videosResponse.json();
                    
                    if (!videosData.items || videosData.items.length === 0) {
                        break;
                    }
                    
                    // Extract video information and add to results
                    const pageVideos = videosData.items
                        .filter((item: any) => 
                            item.snippet && 
                            item.snippet.title && 
                            item.snippet.resourceId && 
                            item.snippet.resourceId.videoId)
                        .map((item: any) => ({
                            title: item.snippet.title,
                            url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
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
        
        const response = await obsidianFetch(url);
        
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
                logger.error(`Could not extract video ID from URL: ${videoUrl}`);
                throw new Error('Could not extract video ID from URL');
            }

            // Read the note content
            const file = this.app.vault.getAbstractFileByPath(filePath) as ObsidianFile;
            if (!file) {
                logger.error(`Could not find note file: ${filePath}`);
                // Try to check if any similar files exist
                const folder = filePath.substring(0, filePath.lastIndexOf('/'));
                try {
                    // @ts-ignore - Using internal Obsidian API
                    const folderContents = this.app.vault.getMarkdownFiles()
                        .filter((f: any) => f.path.startsWith(folder))
                        .map((f: any) => f.path);
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
                    logger.error(`Error checking folder contents: ${folderError.message}`);
                }
                throw new Error('Could not find note file');
            }

            // Log file info but don't do instanceof checks
            logger.debug(`File found: ${filePath}`);
            
            // Read the content using our custom interface
            const content = await this.app.vault.read(file as unknown);
            
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
            const timestampConfig = getTimestampLinkConfig(this.settings, videoId);
            
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
            
            // Create specialized summarizer for timestamp linking
            const timestampLinkSummarizer = new TranscriptSummarizer({
                model: this.getModelForProvider(this.settings.selectedLLM),
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
                }
                
                logger.debug("[addTimestampLinksSinglePass] Received LLM response, length:", enhancedContent ? enhancedContent.length : 0);
            } catch (e) {
                logger.error("[addTimestampLinksSinglePass] Error during LLM call:", e);
                
                // In case of token limit errors, reduce the maxTokens and try again
                if (e.message && (e.message.includes("max_tokens") || e.message.includes("token limit"))) {
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
                const file = this.app.vault.getAbstractFileByPath(filePath) as ObsidianFile;
                if (file) {
                    await this.app.vault.modify(file as unknown, enhancedNote);
                } else {
                    logger.error(`[addTimestampLinksSinglePass] File not found: ${filePath}`);
                    this.showNotice(`Error: File not found: ${filePath}`, 5000);
                    return null;
                }
                
                // Count number of section headings with links
                const linkCount = countTimestampLinks(enhancedContent);
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
            const noteFile = this.app.vault.getAbstractFileByPath(filePath) as ObsidianFile;
            if (!noteFile) {
                logger.error(`[translateContent] File not found: ${filePath}`);
                this.showNotice(`Error: File not found: ${filePath}`, 5000);
                return;
            }
            const fileContent = await this.app.vault.read(noteFile as unknown);
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
            if (noteFile) {
                await this.app.vault.modify(noteFile as unknown, translatedNote);
                this.showNotice(`Successfully translated content to ${targetLang.toUpperCase()}-${targetCountry}`, 5000);
            } else {
                logger.error(`[translateContent] File not found: ${filePath}`);
                this.showNotice(`Error: File not found: ${filePath}`, 5000);
                return;
            }
            
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
            
            // Check if we're running on mobile for additional caution
            const isMobile = this.isMobileDevice();
            
            if (this.settings.debugLogging) {
                llmLogger.debug(`Split content into ${chunks.length} optimized chunks`);
                llmLogger.debug(`Chunk sizes: ${chunks.map(c => c.length).join(', ')} characters`);
                if (isMobile) {
                    llmLogger.debug(`Running on mobile device, using more conservative processing`);
                }
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
                const timestampConfig = getTimestampLinkConfig(this.settings, videoId);
                
                // Construct reference section with clear instructions not to include in output
                // Reduce transcript size on mobile to prevent token overflow
                let transcriptContent = "";
                if (isMobile && transcript.length > 5000) {
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
                        llmLogger.debug(e.message || "Unknown error");
                        llmLogger.debug(`Using original chunk content instead`);
                    }
                    
                    // Push original chunk with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                }
            }
            
            // Reconstruct document: frontmatter + processed content
            const combinedContent = processedChunks.join("");
            const combinedNote = reconstructDocument(frontmatter, combinedContent);
            
            // Verify we have some timestamp links
            const linkCount = countTimestampLinks(combinedContent);
            
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
                const file = this.app.vault.getAbstractFileByPath(filePath) as ObsidianFile;
                if (file) {
                    await this.app.vault.modify(file as unknown, combinedNote);
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
        // Get the user's configured maxTokens setting
        const configuredMaxTokens = this.settings.maxTokens;
        
        // Simple hard limits for each provider to prevent errors
        const PROVIDER_MAX_LIMITS: Record<string, number> = {
            'openai': 4096,     // OpenAI's max completion tokens limit
            'anthropic': 4096,  // Anthropic's max completion tokens limit
            'google': 8192,     // Google's max completion tokens limit
            'ollama': 4096,     // Default Ollama limit
            'default': 4096     // Default fallback
        };
        
        // Get the selected LLM provider
        const selectedProvider = this.settings.selectedLLM;
        
        // Get the hard limit for the selected provider
        const providerHardLimit = PROVIDER_MAX_LIMITS[selectedProvider] || PROVIDER_MAX_LIMITS.default;
        
        // Apply 85% multiplier to configured maxTokens
        let tokensToUse = Math.floor(configuredMaxTokens * 0.85);
        
        // Never exceed provider's hard limit (minus a small buffer for safety)
        tokensToUse = Math.min(tokensToUse, providerHardLimit - 100);
        
        // Additional safety check - if on mobile, be more conservative
        if (this.isMobileDevice()) {
            tokensToUse = Math.min(tokensToUse, 2000); // Cap at 2000 on mobile
            
            if (this.settings.debugLogging) {
                logger.debug(`[getMaxTokensForTimestampPass] Running on mobile, capping tokens at 2000`);
            }
        }
        
        if (this.settings.debugLogging) {
            logger.debug(`[getMaxTokensForTimestampPass] Using ${tokensToUse} tokens (85% of configured ${configuredMaxTokens}, provider limit: ${providerHardLimit})`);
        }
        
        return tokensToUse;
    }

    private sanitizePathComponent(text: string): string {
        // Use the utility function instead of duplicating code
        return sanitizePathComponent(text);
    }

    // Utility method to detect if we're running on a mobile device
    private isMobileDevice(): boolean {
        // Check if the app's isMobile property is true first (most reliable in Obsidian)
        if ((window as ObsidianAppWindow).app?.isMobile === true) {
            return true;
        }
        
        // Fallback to checking the userAgent string
        const userAgent = navigator.userAgent || navigator.vendor || (window as ObsidianAppWindow).opera || '';
        return (
            /android/i.test(userAgent) ||
            /iPad|iPhone|iPod/.test(userAgent) ||
            /windows phone/i.test(userAgent) ||
            /(tablet|ipad|playbook|silk)|(android(?!.*mobile))/i.test(userAgent) ||
            /Mobile|Android|iP(hone|od|ad)/.test(userAgent)
        );
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
                const errorData = await response.json().catch(() => ({ message: response.statusText }));
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchOpenAIModels] Failed to fetch OpenAI models: ${errorMessage}`);
                this.showNotice(`Failed to fetch OpenAI models: ${errorMessage}`, 5000);
                return []; // Or a default list
            }

            const data = await response.json();
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
                const errorData = await response.json().catch(() => ({ message: response.statusText }));
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchGoogleModels] Failed to fetch Google models: ${errorMessage}`);
                this.showNotice(`Failed to fetch Google models: ${errorMessage}`, 5000);
                return [];
            }

            const data = await response.json();
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
            // Use class toggling for consistency with displayValidationResult
            this.errorEl.addClass('tubesage-error-hidden');
            this.errorEl.removeClass('tubesage-error-visible');
        }
    }
    
    onOpen() {
        // Initialize
        this.showNotice('YouTube Transcript Extractor ready', 10000);
        
        // Clear content and create container
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: 'TubeSage: Create Note from YouTube Transcript' });
        
        // Build the input stage UI
        this.buildInputStage();
    }
    
    private buildInputStage() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: 'TubeSage: Create Note from YouTube Transcript' });
        
        // Check if we're on mobile
        const isMobile = this.isMobile();
        
        // Create the form container - revert to original appearance
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
            text: 'All Videos',
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
            text: 'Limited Number:',
            cls: 'tubesage-modal-radio-label',
            attr: { for: 'limited-videos-radio' }
        });
        
        // Then add the radio button
        const limitedVideosRadio = limitedVideosContainer.createEl('input', {
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
        this.errorEl = formEl.createEl('div', { cls: ['tubesage-error', 'tubesage-error-hidden'] });
        
        // Add real-time validation on URL change
        this.urlInputEl.addEventListener('input', () => {
            const url = this.urlInputEl.value.trim();
            
            // First check if it's a valid URL
            if (url && !this.isYoutubeUrl(url)) {
                urlValidationEl.setText('Not a valid YouTube URL. Only video, playlist, and channel URLs are supported.');
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
            this.plugin, // Revert to this.plugin
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
                                const data = await response.json();
                                if (data.items && data.items.length > 0) {
                                    sourceName = data.items[0].snippet.title;
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
                                    
                                    const file = this.app.vault.getAbstractFileByPath(notePathForLog) as ObsidianFile;
                                    if (file) {
                                        const currentContent = await this.app.vault.read(file as unknown);
                                        await this.app.vault.modify(file as unknown, currentContent + debugSection);
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
                        this.showNotice(`⚠️ Skipping video "${video.title}" - ${transcriptError.message}`, 5000);
                        skippedCount++;
                        // Clear logs even on skip, so next video starts fresh
                        clearLogs(); 
                    }
                } catch (videoError) {
                    logger.error('Error processing video:', video, videoError);
                    this.showNotice(`❌ Error processing video "${video.title}": ${videoError.message}`, 5000);
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
                throw new Error('Failed to extract video ID from URL');
            }
            
            // Extract transcript and metadata in one request
            this.showNotice('Extracting transcript from YouTube...', 5000);
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
                    this.showNotice('Could not retrieve YouTube title, using fallback', 3000);
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
                    logger.error(`Error adding timestamp links: ${timestampError.message}`, timestampError);
                    this.showNotice(`Note created but timestamps could not be added: ${timestampError.message}`, 5000);
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
                        const file = this.app.vault.getAbstractFileByPath(notePath) as ObsidianFile;
                        if (file) {
                            const currentContent = await this.app.vault.read(file as unknown);
                            await this.app.vault.modify(file as unknown, currentContent + debugSection);
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
                    const noteTitle = this.titleInputEl?.value.trim() || 'Failed YouTube Transcript';
                    
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

    // Simple helper to detect mobile devices
    private isMobile(): boolean {
        return (window as ObsidianAppWindow).app?.isMobile === true;
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
        
        // Create custom appearance title that's larger and bolder than the subsections
        const titleEl = containerEl.createEl('h1', { 
            cls: 'tubesage-settings-main-title', // Apply new class
            attr: { style: 'text-align:center; width:100%; margin:0 auto 10px auto;' }
        });
        titleEl.setText('TubeSage Note Creation Settings');
        
        // Add version display under the title
        const versionEl = containerEl.createEl('div', {
            attr: { style: 'text-align:center; color:var(--text-muted); font-size:0.9em; margin-bottom:20px;' }
        });
        versionEl.setText(`Version ${this.plugin.getVersion()}`);
        
        // Buy Me a Coffee section at the top
        const supportContainer = containerEl.createEl('div', {
            cls: 'tubesage-settings-support-container' // Apply new class
        });
        
        // Support Development section with appearance heading
        supportContainer.createEl('h3', { 
            text: 'Support Development',
            cls: 'tubesage-settings-support-heading' // Apply new class
        });
        
        // Support message in appearance format
        const supportDesc = supportContainer.createEl('div', {
            text: 'If you find this plugin useful, consider supporting its development:',
            cls: 'tubesage-settings-support-desc' // Apply new class
        });

        // Add italicized mission statement
        const missionDesc = supportContainer.createEl('div', {
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
        
        // Add the image
        bmcLink.createEl('img', {
            cls: 'tubesage-settings-bmc-img', // Apply existing class
            attr: {
                src: 'https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png',
                alt: 'Buy Me A Coffee'
                // appearence: 'height: 40px; width: 145px;' // This line should be removed
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
            text: 'License & Disclaimer', 
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
            text: 'Accept License & Disclaimer', 
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
        const sliderKnob = toggleSlider.createEl('span', {
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
            cls: 'tubesage-settings-heading-container' // Apply new class
        });
        
        transcriptHeadingContainer.createEl('h3', { text: 'Transcript Settings' });
        
        // Add info icon
        const infoIcon = transcriptHeadingContainer.createEl('span', {
            cls: 'tubesage-settings-info-icon', // Apply new class
            attr: { 'aria-label': 'Information about transcript extraction settings' } // Keep aria-label
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
            tooltip.className = 'tubesage-settings-tooltip'; // Apply new class
            tooltip.textContent = 'Transcript Settings control how and where your extracted notes are saved, which YouTube Data API key to use (required for channel/playlist processing), and optional language-translation parameters.';
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
            .addText(text => {
                const textComponent = text
                    .setPlaceholder('AIza...')
                    .setValue(this.plugin.settings.youtubeApiKey)
                    .onChange(async (value: string) => {
                        this.plugin.settings.youtubeApiKey = value;
                        await this.plugin.saveSettings();
                    });
                
                // Access the DOM element directly to change its type
                // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                const inputEl = textComponent.inputEl as HTMLInputElement;
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
            cls: 'tubesage-settings-heading-container' // Apply new class
        });
        
        llmHeadingContainer.createEl('h3', { text: 'LLM Settings' });
        
        // Add info icon
        const llmInfoIcon = this.createInfoIcon(
            llmHeadingContainer,
            'LLM Settings let you choose an AI provider, enter its API key, and pick a model. Temperature controls creativity; Max Tokens caps output length. The author\'s suggestion for most users: Google provider with the gemini-2.0-flash model—fast, inexpensive, and high-quality.'
        );
        
        new Setting(settingsContainer)
            .setName('Select LLM')
            .setDesc('Choose which LLM to use for summarization')
            .addDropdown(dropdown => {
                // Add OpenAI option
                dropdown.addOption('openai', 'OpenAI (ChatGPT)');
                
                // Always add Anthropic, Google and Ollama options since they all work on any platform now
                dropdown.addOption('anthropic', 'Anthropic (Claude)');
                dropdown.addOption('google', 'Google (Gemini)');
                dropdown.addOption('ollama', 'Ollama (Local Models)');
                
                // Set the current value
                let currentValue = this.plugin.settings.selectedLLM;
                
                // Set the current value
                dropdown.setValue(currentValue);
                
                // Add change handler
                dropdown.onChange(async (value: string) => {
                    // Set appropriate max token value based on provider
                    if (value === 'google') {
                        this.plugin.settings.maxTokens = 8192;
                        new Notice('Max tokens set to 8192 for Google provider');
                    } else {
                        this.plugin.settings.maxTokens = 4096;
                        new Notice('Max tokens set to 4096');
                    }
                    
                    // Update settings
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
                .addText(text => {
                    // Get the input element
                    const textComponent = text
                        .setPlaceholder(placeholder)
                        .setValue(this.plugin.settings.apiKeys[provider])
                        .onChange(async (value: string) => {
                            this.plugin.settings.apiKeys[provider] = value;
                            await this.plugin.saveSettings();
                        });
                    
                    // Access the DOM element directly to change its type
                    // @ts-ignore - inputEl exists but TypeScript doesn't know about it
                    const inputEl = textComponent.inputEl as HTMLInputElement;
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
            let modelDropdown: any;
            
            // Add dropdown for preset models
            setting.addDropdown(dropdown => {
                modelDropdown = dropdown;
                modelOptions.forEach(model => dropdown.addOption(model, model));
                dropdown.addOption('custom', '-- Custom Model --');
                const currentModel = this.plugin.settings.selectedModels[provider];
                let validSelection = modelOptions.includes(currentModel) ? currentModel : 'custom';
                dropdown.setValue(validSelection)
                    .onChange(async (value: string) => {
                        if (value !== 'custom') {
                            this.plugin.settings.selectedModels[provider] = value;
                            customField.setValue(''); // Clear custom if a preset is chosen
                            await this.plugin.saveSettings();
                        }
                    });
                return dropdown;
            });

            // Add refresh button ONLY for OpenAI OR Google provider
            if (provider === 'openai' || provider === 'google') {
                setting.addExtraButton(button => {
                    button
                        .setIcon('refresh-cw') // Refresh icon
                        .setTooltip(`Refresh ${displayName} model list`)
                        .onClick(async () => {
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
                                const options = modelDropdown.selectEl.options;
                                for (let i = options.length - 1; i >= 0; i--) {
                                    if (options[i].value !== 'custom') {
                                        modelDropdown.selectEl.remove(i);
                                    }
                                }
                                fetchedModels.forEach(modelId => modelDropdown.addOption(modelId, modelId));
                                // @ts-ignore - selectEl is part of the dropdown
                                modelDropdown.selectEl.appendChild(modelDropdown.selectEl.querySelector('option[value="custom"]'));

                                if (fetchedModels.includes(currentSelectedModel)) {
                                    modelDropdown.setValue(currentSelectedModel);
                                } else if (fetchedModels.includes(defaultModelValue)) {
                                    modelDropdown.setValue(defaultModelValue);
                                    this.plugin.settings.selectedModels[provider] = defaultModelValue;
                                    await this.plugin.saveSettings();
                                } else if (fetchedModels.length > 0) {
                                    modelDropdown.setValue(fetchedModels[0]);
                                    this.plugin.settings.selectedModels[provider] = fetchedModels[0];
                                    await this.plugin.saveSettings();
                                } else {
                                    modelDropdown.setValue('custom');
                                }
                                this.plugin.showNotice(`${displayName} model list refreshed.`, 3000);
                            } else {
                                this.plugin.showNotice(`Could not refresh ${displayName} models. Using existing list.`, 4000);
                            }
                        });
                });
            }
            
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
        
        // Handle Anthropic settings for all platforms (now works everywhere)
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
        
        // Google provider settings (always shown on all platforms)
        createProviderSetting(
            'google',
            'Google',
            'AIza...',
            [
                'gemini-2.5-pro-exp-03-25',
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
        settingsContainer.createEl('h4', { text: 'Fast Summary Prompts', cls: 'tubesage-settings-prompt-subheader' });
        
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
        settingsContainer.createEl('h4', { text: 'Extensive Summary Prompts', cls: 'tubesage-settings-prompt-subheader tubesage-settings-prompt-subheader-extensive' });
        
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
            .setDesc('Enable detailed debug logs. When enabled, debug information will be appended to each note as a hidden callout for troubleshooting.')
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
        
        // Add tooltip on hover
        infoIcon.addEventListener('mouseenter', (e) => {
            const tooltip = document.createElement('div');
            tooltip.className = 'tubesage-settings-tooltip'; // Apply new consistent class
            tooltip.textContent = tooltipText;
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
        
        // Provide native tooltip fallback
        infoIcon.setAttr('title', tooltipText);
        
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
        
        logger.debug("Template picker initialized with templates folder:", this.templatesFolder);
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Select Template File' });
        
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
        contentEl.createEl('h2', { text: 'Select Folder Location' });
        
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

    async onOpen() {
        const { contentEl } = this;
        
        // Set wider width for the modal using direct DOM manipulation (original working method)
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.style.width = "700px";
            modalEl.style.maxWidth = "80vw";
        }
        
        contentEl.createEl('h2', { text: 'TubeSage - YouTube Transcript Plugin License' });

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
                text: 'Could not load license file. Please check that a license file (LICENSE.md or MIT-license-tubesage.md) exists in your plugin directory.',
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
        
        // Set a suitable width for the modal (original working method)
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.style.width = "500px";
        }
        
        // Add title
        contentEl.createEl('h2', { 
            text: 'License Acceptance Required', 
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
            'Find "TubeSage" in the Community Plugins list',
            'Click the "TubeSage" plugin settings',
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
            text: 'Open Plugin Settings',
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
        
        // Set wider width for the modal using direct DOM manipulation (original working method)
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.style.width = "800px";
            modalEl.style.maxWidth = "85vw";
        }
        
        contentEl.createEl('h2', { text: 'TubeSage - YouTube Transcript Plugin Documentation' });

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
                throw new Error('Could not find README file in any of the expected locations.');
            }
            
            // Create a div for the README content with scrollable style (original inline style)
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
                    inList = false;
                    readmeContainer.createEl('h1', { text: line.substring(2), cls: 'tubesage-readme-h1' });
                } else if (line.startsWith('## ')) {
                    inList = false;
                    readmeContainer.createEl('h2', { text: line.substring(3), cls: 'tubesage-readme-h2' });
                } else if (line.startsWith('### ')) {
                    inList = false;
                    readmeContainer.createEl('h3', { text: line.substring(4), cls: 'tubesage-readme-h3' });
                } else if (line.startsWith('#### ')) {
                    inList = false;
                    readmeContainer.createEl('h4', { text: line.substring(5), cls: 'tubesage-readme-h4' });
                }
                // Handle list items
                else if (line.match(/^[*\-\+]\s/)) {
                    inList = true;
                    const listItem = readmeContainer.createEl('div', { cls: 'tubesage-readme-list-item' });
                    
                    // Bullet
                    listItem.createEl('span', { text: '• ', cls: 'tubesage-readme-list-bullet' });
                    
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
                    inList = false;
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
                text: 'Could not load README file. Please check that README.md exists in your plugin directory.',
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
            const [fullMatch, altText, imageUrl, targetUrl] = match;
            
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

    async onOpen() {
        const { contentEl } = this;
        
        // Set wider width for the modal using direct DOM manipulation (original working method)
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl instanceof HTMLElement) {
            modalEl.style.width = "700px";
            modalEl.style.maxWidth = "80vw";
        }
        
        contentEl.createEl('h2', { 
            text: 'Example Template: Copy and place in your Templater Plugin Specified Template directory',
            cls: 'tubesage-template-view-title'
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
                } catch (e) {
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
                text: 'Copy Template', 
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
                            copyTextElement.textContent = '✓ Copied!';
                            setTimeout(() => {
                                copyTextElement.textContent = originalText;
                            }, 2000);
                        }
                    })
                    .catch(err => {
                        logger.error('Failed to copy template:', err);
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
                cls: 'tubesage-template-view-explanation'
            });
            
            // Add Templater variables explanation
            const variablesContainer = contentEl.createEl('div', {
                cls: 'tubesage-template-view-variables-container'
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
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add this interface at the top of the file after the existing imports
interface ObsidianAppWindow extends Window {
    app?: {
        isMobile?: boolean;
        plugins?: Record<string, unknown>;
        vault?: Record<string, unknown>;
        workspace?: Record<string, unknown>;
        setting?: Record<string, unknown>;
    };
    opera?: string;
}
