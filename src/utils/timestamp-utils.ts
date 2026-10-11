import { getLogger } from './logger';
import * as TimeFormat from 'hh-mm-ss';

// Initialize logger
const logger = getLogger('TIMESTAMP');

/**
 * Interface for extracted document components
 */
export interface DocumentComponents {
    frontmatter: string;
    contentWithoutFrontmatter: string;
    transcript: string;
}

/**
 * Extract the frontmatter, content, and transcript from a document
 * 
 * @param originalContent The full document content
 * @returns The extracted components
 */
export function extractDocumentComponents(originalContent: string): DocumentComponents {
    let frontmatter = "";
    let contentWithoutFrontmatter = originalContent;
    let transcript = "";
    
    if (originalContent.startsWith("---")) {
        const endFrontmatter = originalContent.indexOf("---", 3);
        if (endFrontmatter > 0) {
            // Extract complete frontmatter including the closing ---
            frontmatter = originalContent.substring(0, endFrontmatter + 3);
            
            // Content starts after frontmatter
            contentWithoutFrontmatter = originalContent.substring(endFrontmatter + 3).trim();
            
            // Extract transcript from frontmatter for context
            const frontmatterContent = originalContent.substring(3, endFrontmatter).trim();
            
            // Look for transcript property in frontmatter
            // Extract everything after "transcript: |" until the closing --- or another YAML property
            const transcriptMatch = frontmatterContent.match(/transcript:\s*\|\s*\n([\s\S]+?)(?:\n(?:\w+:)|$)/);
            if (transcriptMatch && transcriptMatch[1]) {
                transcript = transcriptMatch[1].trim();
                logger.debug("Successfully extracted transcript from frontmatter");
            } else {
                logger.debug("Could not find transcript in frontmatter");
            }
        }
    }
    
    return {
        frontmatter,
        contentWithoutFrontmatter,
        transcript
    };
}

/**
 * Reconstruct the document with frontmatter and enhanced content
 * 
 * @param frontmatter The original frontmatter
 * @param enhancedContent The LLM-enhanced content
 * @returns The reconstructed document
 */
export function reconstructDocument(frontmatter: string, enhancedContent: string): string {
    let enhancedNote = frontmatter + "\n" + enhancedContent;
    
    // Remove any unwanted code blocks that might appear after frontmatter
    if (enhancedNote.includes("---\n```") || enhancedNote.includes("---\r\n```")) {
        logger.debug("Removing unwanted code blocks after frontmatter");
        enhancedNote = enhancedNote.replace(/---[\r\n]+```/g, "---");
        enhancedNote = enhancedNote.replace(/```[\r\n]+(?!`)/g, ""); // Remove closing backticks
    }
    
    return enhancedNote;
}

/**
 * Validate enhanced content before updating the document
 * 
 * @param enhancedContent The LLM-enhanced content
 * @param originalContent The original content
 * @param headings The extracted headings
 * @param videoId The YouTube video ID
 * @returns Whether the content is valid
 */
export function validateEnhancedContent(
    enhancedContent: string,
    originalContent: string,
    headings: string[],
    videoId: string
): boolean {
    // Check if response has proper Markdown formatting
    if (!enhancedContent.includes('#')) {
        logger.error("LLM response doesn't contain any markdown headings");
        return false;
    }

    // Validate that the modified content hasn't lost significant content.
    // Both sides are measured without the markers/links the pass adds, so
    // the links themselves cannot make up for lost text.
    if (withoutAddedLinks(enhancedContent).length < withoutAddedLinks(originalContent).length * 0.9) {
        logger.error("LLM output is suspiciously short, might have lost content");
        return false;
    }

    // Every heading the LLM was given must still be there (it may have
    // gained a marker or a Watch link)
    const returnedHeadings = new Set(headingTexts(enhancedContent).map(withoutAddedLinks));
    const missingHeadings = headings.filter((heading) => !returnedHeadings.has(withoutAddedLinks(heading)));
    if (missingHeadings.length > 0) {
        logger.error(`LLM output is missing ${missingHeadings.length} of ${headings.length} headings`);
        return false;
    }

    // Verify the output has timestamp links in headings (after conversion from TimeIndex markers)
    const timestampLinkPattern = new RegExp(`^#+\\s+.*?\\[Watch\\]\\(https://www\\.youtube\\.com/watch\\?v=${videoId}&t=\\d+\\)`, 'm');
    const hasLinks = timestampLinkPattern.test(enhancedContent);
    
    if (!hasLinks) {
        logger.warn("No timestamp links found in headings in final output");
        logger.debug("Enhanced content sample:", enhancedContent.substring(0, 500));
        return false;
    }

    return true;
}

/**
 * The single-pass result: the note to write (the original frontmatter plus the
 * LLM's body, with heading TimeIndex markers converted to Watch links) and
 * whether it passed validation. Lives here rather than in main.ts so the
 * check can be unit-tested.
 *
 * @param frontmatter The original note's frontmatter
 * @param enhancedContent The LLM's response (the note body with markers)
 * @param originalBody The body that was sent to the LLM
 * @param headings The headings of the original note
 * @param videoId The YouTube video ID
 * @param offered The TimeIndex values the model was shown; any other value is dropped (#23)
 */
export function buildSinglePassNote(
    frontmatter: string,
    enhancedContent: string,
    originalBody: string,
    headings: string[],
    videoId: string,
    offered: Set<number> | null = null
): { note: string; valid: boolean } {
    let note = reconstructDocument(frontmatter, dropUnofferedTimeIndices(enhancedContent, offered));
    const { frontmatter: extractedFrontmatter, contentWithoutFrontmatter: extractedContent } = extractDocumentComponents(note);
    const convertedContent = convertTimeIndexToWatchUrls(extractedContent, videoId);
    note = reconstructDocument(extractedFrontmatter, convertedContent);
    // Body against body: the rebuilt note's frontmatter carries the whole
    // transcript, so measuring the note would make the length guard
    // unfailable (#21).
    return { note, valid: validateEnhancedContent(convertedContent, originalBody, headings, videoId) };
}

/**
 * Whether the chunked pass may use the LLM's response for one chunk. When it
 * may not, main.ts keeps the chunk's original text.
 *
 * The response must keep the chunk's length (same tolerance as the single
 * pass), still contain every heading the chunk was sent with, carry markers
 * only on heading lines, and link at least one heading.
 *
 * @param processedChunk The LLM's response for the chunk
 * @param originalChunk The chunk text that was sent to the LLM
 * @param videoId The YouTube video ID
 */
export function isChunkAcceptable(processedChunk: string, originalChunk: string, videoId: string): boolean {
    if (!hasMarkersOnlyOnHeadingLines(processedChunk)) {
        logger.warn("Chunk has TimeIndex markers outside heading lines");
        return false;
    }
    const converted = convertTimeIndexToWatchUrls(processedChunk, videoId);
    return validateEnhancedContent(converted, originalChunk, headingTexts(originalChunk), videoId);
}

const TIME_INDEX_MARKER = /\[TimeIndex:\d+\]/;
const HEADING_LINE = /^#{1,6}\s/;

function hasMarkersOnlyOnHeadingLines(content: string): boolean {
    return content.split('\n').every((line) => !TIME_INDEX_MARKER.test(line) || HEADING_LINE.test(line));
}

/** The text of every markdown heading, extracted the same way main.ts does before the pass. */
function headingTexts(content: string): string[] {
    const texts: string[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
        texts.push(match[2].trim());
    }
    return texts;
}

/** The text with the TimeIndex markers and Watch links the pass adds removed. */
function withoutAddedLinks(text: string): string {
    return text
        .replace(/\s*\[TimeIndex:\d+\]/g, '')
        .replace(/\s*\[Watch\]\(https:\/\/www\.youtube\.com\/watch\?v=[^)\s]*\)/g, '')
        .trim();
}

/**
 * Find headings in content
 * 
 * @param content The document content
 * @returns Array of headings with their text and positions
 */
function findContentHeadings(content: string): { text: string; position: number }[] {
    const headings: { text: string; position: number }[] = [];
    
    // Find all headings in the content that match our expected format
    // This will match:
    // - ### 1.1. Heading (section heading)
    // - ## 1. Heading (subheading)
    // - # 1. Heading (main heading)
    // But not:
    // - # Heading (without number)
    // - ## Heading (without number)
    // - # (horizontal rule)
    const headingRegex = /^(#+\s+\d+(?:\.\d+)?\.?\s+.*?)$/gm;
    let match;
    
    while ((match = headingRegex.exec(content)) !== null) {
        const headingText = match[0];
        headings.push({
            text: headingText,
            position: match.index
        });
    }
    
    logger.debug(`Found ${headings.length} headings in content: ${headings.map(h => h.text).join(', ')}`);
    
    return headings;
}

/**
 * Create optimized chunks from content based on headings
 * 
 * @param content The document content
 * @param maxTokenLimit Maximum token limit
 * @returns Array of content chunks
 */
export function createOptimizedChunks(
    content: string,
    maxTokenLimit: number
): string[] {
    const headings = findContentHeadings(content);
    const chunks: string[] = [];
    
    logger.debug(`Found ${headings.length} headings in content`);
    
    if (headings.length === 0) {
        // No headings found, process content as a single chunk
        chunks.push(content);
        return chunks;
    }
    
    // Check if there's content before the first heading (template header)
    if (headings[0].position > 0) {
        // Add the template header as its own chunk (won't be modified, just preserved)
        const templateHeader = content.substring(0, headings[0].position);
        chunks.push(templateHeader);
        logger.debug("Added template header as separate chunk");
    }
    
    // Optimize chunking by combining multiple sections to reduce LLM calls
    const maxChunkTokens = maxTokenLimit * 0.7; // Use 70% of model's max tokens
    const avgTokensPerChar = 0.25; // Conservative estimate: ~4 chars per token
    let currentChunk = "";
    let currentHeadingCount = 0;
    let processedHeadings = 0;
    
    // Process each heading to create optimized chunks
    for (let i = 0; i < headings.length; i++) {
        const startPos = headings[i].position;
        const endPos = i < headings.length - 1 ? 
            headings[i + 1].position : 
            content.length;
        
        const section = content.substring(startPos, endPos);
        const sectionTokens = section.length * avgTokensPerChar;
        
        // If adding this section would exceed token limit, create a new chunk
        if (currentChunk && (currentChunk.length * avgTokensPerChar + sectionTokens) > maxChunkTokens) {
            chunks.push(currentChunk);
            logger.debug(`Added optimized chunk with ${currentHeadingCount} headings (${processedHeadings + 1}-${processedHeadings + currentHeadingCount})`);
            currentChunk = section;
            currentHeadingCount = 1;
            processedHeadings += currentHeadingCount;
        } else {
            // Add section to current chunk
            currentChunk += section;
            currentHeadingCount++;
        }
    }
    
    // Add the final chunk if not empty
    if (currentChunk) {
        chunks.push(currentChunk);
        processedHeadings += currentHeadingCount;
        logger.debug(`Added final optimized chunk with ${currentHeadingCount} headings (${processedHeadings - currentHeadingCount + 1}-${processedHeadings})`);
    }
    
    // Verify all headings were processed
    if (processedHeadings !== headings.length) {
        logger.warn(`Warning: Processed ${processedHeadings} headings but found ${headings.length} total headings`);
    }
    
    return chunks;
}

/**
 * Ensure a chunk ends with a newline
 * 
 * @param chunk The content chunk
 * @returns The chunk with a trailing newline
 */
export function ensureTrailingNewline(chunk: string): string {
    return chunk.endsWith("\n") ? chunk : chunk + "\n";
}

/**
 * Count timestamp links in enhanced content
 * 
 * @param content The enhanced content
 * @returns The number of headings with timestamp links
 */
export function countTimestampLinks(content: string): number {
    const headingsWithLinks = content.match(/^#+\s+\d+(?:\.\d+)?\.?\s+[^\n]*\[Watch\]/gm);
    return headingsWithLinks ? headingsWithLinks.length : 0;
}

/**
 * Check if a chunk contains a proper section heading
 * 
 * @param chunk The content chunk
 * @returns Whether the chunk contains a proper section heading
 */
export function hasProperHeading(chunk: string): boolean {
    return !!chunk.match(/^#+\s+\d+(?:\.\d+)?\.?\s+/m);
}

/**
 * Converts a timestamp in HH:MM:SS format to seconds
 * @param timestamp The timestamp in HH:MM:SS format
 * @returns Total seconds
 */
export function convertTimestampToSeconds(timestamp: string): number {
    try {
        // Use the library's toS function exactly as documented in npm
        // TimeFormat.toS('02:00:00', 'hh:mm:ss') => 7200
        return TimeFormat.toS(timestamp, 'hh:mm:ss');
    } catch (error) {
        logger.error(`Error converting timestamp ${timestamp} to seconds: ${error}`);
        return 0;
    }
}

/** Transcript character budget for the single timestamp pass. */
export const SINGLE_PASS_TRANSCRIPT_BUDGET = 10000;
/** Transcript character budget per chunk call on mobile. */
export const MOBILE_CHUNK_TRANSCRIPT_BUDGET = 5000;

// One formatTranscriptForYaml line: "[HH:MM:SS] [TimeIndex:N] text" (TimeIndex
// absent on older notes). Group 1 is the timestamp prefix, group 2 the text.
const TRANSCRIPT_LINE = /^\s*(\[\d{1,2}:\d{2}:\d{2}\]\s*(?:\[TimeIndex:\d+\]\s*)?)(.*)$/;
const CONDENSED_NOTICE = "[Transcript condensed to fit: every timestamp kept, segment text shortened]";
const TRUNCATED_NOTICE = "[Transcript truncated to fit]";
// Below this much text per segment, segments are merged into coarser buckets instead.
const MIN_SEGMENT_TEXT = 40;

interface TranscriptEntry {
    prefix: string;
    text: string;
}

function parseTranscriptEntries(transcript: string): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const line of transcript.split('\n')) {
        const match = TRANSCRIPT_LINE.exec(line);
        if (match) {
            entries.push({ prefix: `${match[1].replace(/\s+/g, ' ').trim()} `, text: match[2].trim() });
        } else if (entries.length > 0 && line.trim()) {
            entries[entries.length - 1].text += ` ${line.trim()}`;
        }
    }
    return entries;
}

/** Consecutive entries merged k at a time: the group keeps its first timestamp. */
function mergeEntries(entries: TranscriptEntry[], k: number): TranscriptEntry[] {
    const merged: TranscriptEntry[] = [];
    for (let i = 0; i < entries.length; i += k) {
        const group = entries.slice(i, i + k);
        merged.push({ prefix: group[0].prefix, text: group.map((entry) => entry.text).join(' ') });
    }
    return merged;
}

/** Characters taken by the timestamps and line breaks alone. */
function fixedLength(entries: TranscriptEntry[]): number {
    return entries.reduce((sum, entry) => sum + entry.prefix.length, 0) + entries.length - 1;
}

/** The smallest merge factor leaving at least MIN_SEGMENT_TEXT characters of text per line. */
function chooseMergeFactor(entries: TranscriptEntry[], available: number): number {
    let k = 1;
    while (k < entries.length) {
        const merged = mergeEntries(entries, k);
        if (fixedLength(merged) + merged.length * MIN_SEGMENT_TEXT <= available) break;
        k++;
    }
    return k;
}

/** The largest per-line text cap c with sum(min(length, c)) <= budget (short lines donate what they do not use). */
function textCap(lengths: number[], budget: number): number {
    let [low, high] = [0, Math.max(0, ...lengths)];
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const used = lengths.reduce((sum, length) => sum + Math.min(length, mid), 0);
        if (used <= budget) low = mid;
        else high = mid - 1;
    }
    return low;
}

/** The text cut to at most `cap` characters, at a word boundary where one is near, marked with an ellipsis. */
function shorten(text: string, cap: number): string {
    if (text.length <= cap) return text;
    if (cap <= 1) return '';
    const cut = text.slice(0, cap - 1);
    const space = cut.lastIndexOf(' ');
    return `${space > cap * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * The transcript as shown to the timestamp pass, within a character budget,
 * WITHOUT losing coverage (#23). Cutting the transcript to its first N
 * characters hid everything after the opening minutes, so every link landed
 * there. Instead every segment's timestamp is kept and the budget is spent
 * on segment text: each segment's text is shortened to an equal cap (short
 * segments give their unused share to the rest). Only if even the
 * timestamps cannot fit with a little text each are consecutive segments
 * merged into coarser buckets, which still span the whole video.
 * Deterministic, and never longer than `budget`.
 *
 * @param transcript The transcript from the note's frontmatter
 * @param budget The character budget
 */
export function fitTranscriptToBudget(transcript: string, budget: number): string {
    if (transcript.length <= budget) return transcript;
    const entries = parseTranscriptEntries(transcript);
    if (entries.length === 0) {
        // Not a timestamped transcript: nothing to preserve, so cut it.
        return `${transcript.slice(0, Math.max(0, budget - TRUNCATED_NOTICE.length - 1))}\n${TRUNCATED_NOTICE}`;
    }
    const available = budget - CONDENSED_NOTICE.length - 1;
    const lines = mergeEntries(entries, chooseMergeFactor(entries, available));
    const cap = textCap(lines.map((line) => line.text.length), Math.max(0, available - fixedLength(lines)));
    return [...lines.map((line) => line.prefix + shorten(line.text, cap)), CONDENSED_NOTICE].join('\n');
}

/**
 * The TimeIndex values the model was actually offered: every [TimeIndex:N]
 * in the transcript it was shown or, for older notes without them, each
 * line's [HH:MM:SS] in seconds. Null when it was offered no timestamps at all.
 */
export function offeredTimeIndices(transcriptShown: string): Set<number> | null {
    const indexed = [...transcriptShown.matchAll(/\[TimeIndex:(\d+)\]/g)].map((match) => Number(match[1]));
    if (indexed.length > 0) return new Set(indexed);
    const clocks = [...transcriptShown.matchAll(/^\s*\[(\d{1,2}):(\d{2}):(\d{2})\]/gm)].map(
        (match) => Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    );
    return clocks.length > 0 ? new Set(clocks) : null;
}

/**
 * Removes every [TimeIndex:N] marker whose N was never offered, so a value
 * the model made up is not written into the note (#23). With no offered set
 * (no timestamps were shown) nothing is filtered.
 */
export function dropUnofferedTimeIndices(content: string, offered: Set<number> | null): string {
    if (!offered) return content;
    return content.replace(/ ?\[TimeIndex:(\d+)\]/g, (marker, seconds: string) => (offered.has(Number(seconds)) ? marker : ''));
}

/**
 * Converts TimeIndex markers to Watch URLs ONLY in markdown headings
 * 
 * @param content The content containing TimeIndex markers
 * @param videoId The YouTube video ID
 * @returns Content with TimeIndex markers in headings replaced with Watch URLs
 */
export function convertTimeIndexToWatchUrls(content: string, videoId: string): string {
    logger.debug(`Converting TimeIndex markers to Watch URLs for video: ${videoId} (headings only)`);
    
    // Split content into lines for processing
    const lines = content.split('\n');
    let convertedCount = 0;
    
    // Process each line, only converting TimeIndex markers in markdown headings
    const processedLines = lines.map(line => {
        // Check if this line is a markdown heading (starts with #)
        const headingMatch = line.match(/^(#+\s+.*?)(\[TimeIndex:(\d+)\])(.*?)$/);
        
        if (headingMatch) {
            const headingStart = headingMatch[1]; // "## 1. Topic Title "
            const timeIndexMarker = headingMatch[2]; // "[TimeIndex:123]"
            const seconds = headingMatch[3]; // "123"
            const headingEnd = headingMatch[4]; // any text after TimeIndex marker
            
            const watchUrl = `[Watch](https://www.youtube.com/watch?v=${videoId}&t=${seconds})`;
            convertedCount++;
            
            logger.debug(`Converting heading TimeIndex: ${timeIndexMarker} to ${watchUrl}`);
            return `${headingStart}${watchUrl}${headingEnd}`;
        }
        
        // For non-heading lines, return unchanged (preserving TimeIndex markers)
        return line;
    });
    
    logger.debug(`Successfully converted ${convertedCount} TimeIndex markers in headings to Watch URLs`);
    
    // Count remaining TimeIndex markers (should be preserved in transcript content)
    const remainingContent = processedLines.join('\n');
    const remainingTimeIndex = remainingContent.match(/\[TimeIndex:\d+\]/g);
    const remainingCount = remainingTimeIndex ? remainingTimeIndex.length : 0;
    logger.debug(`Preserved ${remainingCount} TimeIndex markers in non-heading content`);
    
    return remainingContent;
} 
