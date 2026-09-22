// The plugin settings shape and its defaults. Pure and Obsidian-free so the
// declarative settings-tab builder (setting-definitions.ts) and its tests can
// load them without a runtime `obsidian` module. Moved verbatim from main.ts
// (issue #5); main.ts imports them from here.

export interface YouTubeTranscriptSettings {
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

    // Fetched model IDs per provider — populated by the per-provider refresh
    // button (fetchOpenAIModels / fetchGoogleModels / fetchAnthropicModels).
    // Decoupled from customModelLimits so providers whose API doesn't return
    // token limits (OpenAI) still survive a settings re-render with their
    // discovered model list intact.
    fetchedModels: Record<string, string[]>;

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
    supadataApiKey: string;
    scrapcreatorsApiKey: string;

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

export const DEFAULT_SETTINGS: YouTubeTranscriptSettings = {
    templaterTemplateFile: 'Templates/YouTubeTranscript.md',
    selectedLLM: 'openai',
    apiKeys: {
        openai: '',
        anthropic: '',
        google: '',
        ollama: 'http://localhost:11434',
        openrouter: ''
    },
    selectedModels: {
        openai: 'gpt-4-turbo',
        anthropic: 'claude-3-sonnet-20240229',
        google: 'gemini-1.5-pro',
        ollama: 'llama3.1',
        openrouter: 'openai/gpt-4o'
    },
    temperature: 0.7,
    maxTokens: 1000,
    
    // Custom model parameters (for models not in registry)
    customModelLimits: {},

    // Fetched model IDs per provider — populated by the refresh button
    fetchedModels: {
        openai: [],
        anthropic: [],
        google: [],
        ollama: [],
        openrouter: [],
    },


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
Begin with a short opening summary paragraph (2–4 sentences, no heading) that captures the main themes, no headers, no preamble, no postamble. Then produce the numbered sections below.
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
Begin with a short opening summary paragraph (2–4 sentences, no heading) that captures the main themes, no headers, no preamble, no postamble. Then produce the numbered sections below.

For each section:
- Number sections sequentially (1, 2, 3, etc.). IMPORTANT: Use actual Obsidian Markdown heading syntax with # symbols, not bold text.
- Write multiple detailed paragraphs, that explain the content and any theory, technical terms or definitions, models and frameworks thoroughly and in great detail drawn from the transcript.
- Include below the paragraphs key concepts, terms, taxonomy, ontology , or ideas, and explain them clearly with examples where relevant.
- Incorporate and explain important quotations direct from subject (person) , analogies, or references.
- Explore the reasoning, implications, or broader significance behind the ideas.
- Explicitly identify and analyze any contrasts, tensions, contradictions, or shifts in perspective throughout the discussion. Pay special attention to dialectical relationships between concepts.

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
    supadataApiKey: '',
    scrapcreatorsApiKey: '',
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
