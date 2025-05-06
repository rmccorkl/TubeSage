import { App } from 'obsidian';
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
            const transcriptMatch = frontmatterContent.match(/transcript:\s*\|\s*\n([\s\S]+?)(?:\n\w|$)/);
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
    
    // Validate that the modified content hasn't lost significant content
    if (enhancedContent.length < originalContent.length * 0.9) {
        logger.error("LLM output is suspiciously short, might have lost content");
        return false;
    }
    
    // Verify the output has timestamp links
    const timestampLinkPattern = new RegExp(`\\[Watch\\]\\(https://www\\.youtube\\.com/watch\\?v=${videoId}&t=\\d+\\)`);
    const hasLinks = timestampLinkPattern.test(enhancedContent);
    
    if (!hasLinks) {
        logger.warn("No timestamp links found in LLM output");
        return false;
    }
    
    return true;
}

/**
 * Find headings in content
 * 
 * @param content The document content
 * @returns Array of headings with their text and positions
 */
export function findContentHeadings(content: string): { text: string; position: number }[] {
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
 * Check if a chunk has valid timestamp links
 * 
 * @param chunk The content chunk
 * @param videoId The YouTube video ID
 * @returns Whether the chunk has valid timestamp links
 */
export function hasTimestampLinks(chunk: string, videoId: string): boolean {
    const timestampLinkPattern = new RegExp(`\\[Watch\\]\\(https://www\\.youtube\\.com/watch\\?v=${videoId}&t=\\d+\\)`);
    const hasLinks = timestampLinkPattern.test(chunk);
    
    if (!hasLinks) {
        // Log the first few hundred characters to see what's coming back
        logger.debug(`No timestamp links found in chunk. First 200 chars: ${chunk.substring(0, 200)}...`);
        
        // Check if we have any headings with proper format
        const headings = chunk.match(/^#+\s+\d+(?:\.\d+)?\.?\s+/gm);
        if (headings) {
            logger.debug(`Found ${headings.length} numbered headings but no timestamp links`);
        } else {
            logger.debug(`No numbered headings found in chunk`);
        }
    } else {
        const links = chunk.match(timestampLinkPattern);
        logger.debug(`Found ${links ? links.length : 0} timestamp links in chunk`);
    }
    
    return hasLinks;
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