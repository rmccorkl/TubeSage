import { getLogger } from './logger';
import * as TimeFormat from 'hh-mm-ss';
// Initialize logger
const logger = getLogger('TIMESTAMP');
/**
 * Extract the frontmatter, content, and transcript from a document
 *
 * @param originalContent The full document content
 * @returns The extracted components
 */
export function extractDocumentComponents(originalContent) {
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
            }
            else {
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
export function reconstructDocument(frontmatter, enhancedContent) {
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
export function validateEnhancedContent(enhancedContent, originalContent, headings, videoId) {
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
export function findContentHeadings(content) {
    const headings = [];
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
export function createOptimizedChunks(content, maxTokenLimit) {
    const headings = findContentHeadings(content);
    const chunks = [];
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
        }
        else {
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
export function ensureTrailingNewline(chunk) {
    return chunk.endsWith("\n") ? chunk : chunk + "\n";
}
/**
 * Count timestamp links in enhanced content
 *
 * @param content The enhanced content
 * @returns The number of headings with timestamp links
 */
export function countTimestampLinks(content) {
    const headingsWithLinks = content.match(/^#+\s+\d+(?:\.\d+)?\.?\s+[^\n]*\[Watch\]/gm);
    return headingsWithLinks ? headingsWithLinks.length : 0;
}
/**
 * Check if a chunk contains a proper section heading
 *
 * @param chunk The content chunk
 * @returns Whether the chunk contains a proper section heading
 */
export function hasProperHeading(chunk) {
    return !!chunk.match(/^#+\s+\d+(?:\.\d+)?\.?\s+/m);
}
/**
 * Check if a chunk has valid timestamp links
 *
 * @param chunk The content chunk
 * @param videoId The YouTube video ID
 * @returns Whether the chunk has valid timestamp links
 */
export function hasTimestampLinks(chunk, videoId) {
    const timestampLinkPattern = new RegExp(`\\[Watch\\]\\(https://www\\.youtube\\.com/watch\\?v=${videoId}&t=\\d+\\)`);
    const hasLinks = timestampLinkPattern.test(chunk);
    if (!hasLinks) {
        // Log the first few hundred characters to see what's coming back
        logger.debug(`No timestamp links found in chunk. First 200 chars: ${chunk.substring(0, 200)}...`);
        // Check if we have any headings with proper format
        const headings = chunk.match(/^#+\s+\d+(?:\.\d+)?\.?\s+/gm);
        if (headings) {
            logger.debug(`Found ${headings.length} numbered headings but no timestamp links`);
        }
        else {
            logger.debug(`No numbered headings found in chunk`);
        }
    }
    else {
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
export function convertTimestampToSeconds(timestamp) {
    try {
        // Use the library's toS function exactly as documented in npm
        // TimeFormat.toS('02:00:00', 'hh:mm:ss') => 7200
        return TimeFormat.toS(timestamp, 'hh:mm:ss');
    }
    catch (error) {
        logger.error(`Error converting timestamp ${timestamp} to seconds: ${error}`);
        return 0;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGltZXN0YW1wLXV0aWxzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGltZXN0YW1wLXV0aWxzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDckMsT0FBTyxLQUFLLFVBQVUsTUFBTSxVQUFVLENBQUM7QUFFdkMsb0JBQW9CO0FBQ3BCLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQVd0Qzs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSx5QkFBeUIsQ0FBQyxlQUF1QjtJQUM3RCxJQUFJLFdBQVcsR0FBRyxFQUFFLENBQUM7SUFDckIsSUFBSSx5QkFBeUIsR0FBRyxlQUFlLENBQUM7SUFDaEQsSUFBSSxVQUFVLEdBQUcsRUFBRSxDQUFDO0lBRXBCLElBQUksZUFBZSxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sY0FBYyxHQUFHLGVBQWUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3pELElBQUksY0FBYyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3JCLHlEQUF5RDtZQUN6RCxXQUFXLEdBQUcsZUFBZSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsY0FBYyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRS9ELG1DQUFtQztZQUNuQyx5QkFBeUIsR0FBRyxlQUFlLENBQUMsU0FBUyxDQUFDLGNBQWMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUVqRixrREFBa0Q7WUFDbEQsTUFBTSxrQkFBa0IsR0FBRyxlQUFlLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxjQUFjLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUUvRSw4Q0FBOEM7WUFDOUMsTUFBTSxlQUFlLEdBQUcsa0JBQWtCLENBQUMsS0FBSyxDQUFDLDJDQUEyQyxDQUFDLENBQUM7WUFDOUYsSUFBSSxl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LDhEQUE4RDtRQUM5RCxpREFBaUQ7UUFDakQsT0FBTyxVQUFVLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxVQUFVLENBQUMsQ0FBQztJQUNqRCxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLE1BQU0sQ0FBQyxLQUFLLENBQUMsOEJBQThCLFNBQVMsZ0JBQWdCLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDN0UsT0FBTyxDQUFDLENBQUM7SUFDYixDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEFwcCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IGdldExvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCAqIGFzIFRpbWVGb3JtYXQgZnJvbSAnaGgtbW0tc3MnO1xuXG4vLyBJbml0aWFsaXplIGxvZ2dlclxuY29uc3QgbG9nZ2VyID0gZ2V0TG9nZ2VyKCdUSU1FU1RBTVAnKTtcblxuLyoqXG4gKiBJbnRlcmZhY2UgZm9yIGV4dHJhY3RlZCBkb2N1bWVudCBjb21wb25lbnRzXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRG9jdW1lbnRDb21wb25lbnRzIHtcbiAgICBmcm9udG1hdHRlcjogc3RyaW5nO1xuICAgIGNvbnRlbnRXaXRob3V0RnJvbnRtYXR0ZXI6IHN0cmluZztcbiAgICB0cmFuc2NyaXB0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgZnJvbnRtYXR0ZXIsIGNvbnRlbnQsIGFuZCB0cmFuc2NyaXB0IGZyb20gYSBkb2N1bWVudFxuICogXG4gKiBAcGFyYW0gb3JpZ2luYWxDb250ZW50IFRoZSBmdWxsIGRvY3VtZW50IGNvbnRlbnRcbiAqIEByZXR1cm5zIFRoZSBleHRyYWN0ZWQgY29tcG9uZW50c1xuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdERvY3VtZW50Q29tcG9uZW50cyhvcmlnaW5hbENvbnRlbnQ6IHN0cmluZyk6IERvY3VtZW50Q29tcG9uZW50cyB7XG4gICAgbGV0IGZyb250bWF0dGVyID0gXCJcIjtcbiAgICBsZXQgY29udGVudFdpdGhvdXRGcm9udG1hdHRlciA9IG9yaWdpbmFsQ29udGVudDtcbiAgICBsZXQgdHJhbnNjcmlwdCA9IFwiXCI7XG4gICAgXG4gICAgaWYgKG9yaWdpbmFsQ29udGVudC5zdGFydHNXaXRoKFwiLS0tXCIpKSB7XG4gICAgICAgIGNvbnN0IGVuZEZyb250bWF0dGVyID0gb3JpZ2luYWxDb250ZW50LmluZGV4T2YoXCItLS1cIiwgMyk7XG4gICAgICAgIGlmIChlbmRGcm9udG1hdHRlciA+IDApIHtcbiAgICAgICAgICAgIC8vIEV4dHJhY3QgY29tcGxldGUgZnJvbnRtYXR0ZXIgaW5jbHVkaW5nIHRoZSBjbG9zaW5nIC0tLVxuICAgICAgICAgICAgZnJvbnRtYXR0ZXIgPSBvcmlnaW5hbENvbnRlbnQuc3Vic3RyaW5nKDAsIGVuZEZyb250bWF0dGVyICsgMyk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIENvbnRlbnQgc3RhcnRzIGFmdGVyIGZyb250bWF0dGVyXG4gICAgICAgICAgICBjb250ZW50V2l0aG91dEZyb250bWF0dGVyID0gb3JpZ2luYWxDb250ZW50LnN1YnN0cmluZyhlbmRGcm9udG1hdHRlciArIDMpLnRyaW0oKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRXh0cmFjdCB0cmFuc2NyaXB0IGZyb20gZnJvbnRtYXR0ZXIgZm9yIGNvbnRleHRcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyQ29udGVudCA9IG9yaWdpbmFsQ29udGVudC5zdWJzdHJpbmcoMywgZW5kRnJvbnRtYXR0ZXIpLnRyaW0oKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gTG9vayBmb3IgdHJhbnNjcmlwdCBwcm9wZXJ0eSBpbiBmcm9udG1hdHRlclxuICAgICAgICAgICAgY29uc3QgdHJhbnNjcmlwdE1hdGNoID0gZnJvbnRtYXR0ZXJDb250ZW50Lm1hdGNoKC90cmFuc2NyaXB0OlxccypcXHxcXHMqXFxuKFtcXHNcXFNdKz8pKD86XFxuXFx3fCQpLyk7XG4gICAgICAgICAgICBpZiAodHJhbnNjcmlwdE1hdGNoICYmIHRyYW5zY3JpcHRNYXRjaFsxXSkge1xuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHQgPSB0cmFuc2NyaXB0TWF0Y2hbMV0udHJpbSgpO1xuICAgICAgICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhcIlN1Y2Nlc3NmdWxseSBleHRyYWN0ZWQgdHJhbnNjcmlwdCBmcm9tIGZyb250bWF0dGVyXCIpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsb2dnZXIuZGVidWcoXCJDb3VsZCBub3QgZmluZCB0cmFuc2NyaXB0IGluIGZyb250bWF0dGVyXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB7XG4gICAgICAgIGZyb250bWF0dGVyLFxuICAgICAgICBjb250ZW50V2l0aG91dEZyb250bWF0dGVyLFxuICAgICAgICB0cmFuc2NyaXB0XG4gICAgfTtcbn1cblxuLyoqXG4gKiBSZWNvbnN0cnVjdCB0aGUgZG9jdW1lbnQgd2l0aCBmcm9udG1hdHRlciBhbmQgZW5oYW5jZWQgY29udGVudFxuICogXG4gKiBAcGFyYW0gZnJvbnRtYXR0ZXIgVGhlIG9yaWdpbmFsIGZyb250bWF0dGVyXG4gKiBAcGFyYW0gZW5oYW5jZWRDb250ZW50IFRoZSBMTE0tZW5oYW5jZWQgY29udGVudFxuICogQHJldHVybnMgVGhlIHJlY29uc3RydWN0ZWQgZG9jdW1lbnRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29uc3RydWN0RG9jdW1lbnQoZnJvbnRtYXR0ZXI6IHN0cmluZywgZW5oYW5jZWRDb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGxldCBlbmhhbmNlZE5vdGUgPSBmcm9udG1hdHRlciArIFwiXFxuXCIgKyBlbmhhbmNlZENvbnRlbnQ7XG4gICAgXG4gICAgLy8gUmVtb3ZlIGFueSB1bndhbnRlZCBjb2RlIGJsb2NrcyB0aGF0IG1pZ2h0IGFwcGVhciBhZnRlciBmcm9udG1hdHRlclxuICAgIGlmIChlbmhhbmNlZE5vdGUuaW5jbHVkZXMoXCItLS1cXG5gYGBcIikgfHwgZW5oYW5jZWROb3RlLmluY2x1ZGVzKFwiLS0tXFxyXFxuYGBgXCIpKSB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcIlJlbW92aW5nIHVud2FudGVkIGNvZGUgYmxvY2tzIGFmdGVyIGZyb250bWF0dGVyXCIpO1xuICAgICAgICBlbmhhbmNlZE5vdGUgPSBlbmhhbmNlZE5vdGUucmVwbGFjZSgvLS0tW1xcclxcbl0rYGBgL2csIFwiLS0tXCIpO1xuICAgICAgICBlbmhhbmNlZE5vdGUgPSBlbmhhbmNlZE5vdGUucmVwbGFjZSgvYGBgW1xcclxcbl0rKD8hYCkvZywgXCJcIik7IC8vIFJlbW92ZSBjbG9zaW5nIGJhY2t0aWNrc1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gZW5oYW5jZWROb3RlO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGVuaGFuY2VkIGNvbnRlbnQgYmVmb3JlIHVwZGF0aW5nIHRoZSBkb2N1bWVudFxuICogXG4gKiBAcGFyYW0gZW5oYW5jZWRDb250ZW50IFRoZSBMTE0tZW5oYW5jZWQgY29udGVudFxuICogQHBhcmFtIG9yaWdpbmFsQ29udGVudCBUaGUgb3JpZ2luYWwgY29udGVudFxuICogQHBhcmFtIGhlYWRpbmdzIFRoZSBleHRyYWN0ZWQgaGVhZGluZ3NcbiAqIEBwYXJhbSB2aWRlb0lkIFRoZSBZb3VUdWJlIHZpZGVvIElEXG4gKiBAcmV0dXJucyBXaGV0aGVyIHRoZSBjb250ZW50IGlzIHZhbGlkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUVuaGFuY2VkQ29udGVudChcbiAgICBlbmhhbmNlZENvbnRlbnQ6IHN0cmluZywgXG4gICAgb3JpZ2luYWxDb250ZW50OiBzdHJpbmcsIFxuICAgIGhlYWRpbmdzOiBzdHJpbmdbXSxcbiAgICB2aWRlb0lkOiBzdHJpbmdcbik6IGJvb2xlYW4ge1xuICAgIC8vIENoZWNrIGlmIHJlc3BvbnNlIGhhcyBwcm9wZXIgTWFya2Rvd24gZm9ybWF0dGluZ1xuICAgIGlmICghZW5oYW5jZWRDb250ZW50LmluY2x1ZGVzKCcjJykpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFwiTExNIHJlc3BvbnNlIGRvZXNuJ3QgY29udGFpbiBhbnkgbWFya2Rvd24gaGVhZGluZ3NcIik7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgXG4gICAgLy8gVmFsaWRhdGUgdGhhdCB0aGUgbW9kaWZpZWQgY29udGVudCBoYXNuJ3QgbG9zdCBzaWduaWZpY2FudCBjb250ZW50XG4gICAgaWYgKGVuaGFuY2VkQ29udGVudC5sZW5ndGggPCBvcmlnaW5hbENvbnRlbnQubGVuZ3RoICogMC45KSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcihcIkxMTSBvdXRwdXQgaXMgc3VzcGljaW91c2x5IHNob3J0LCBtaWdodCBoYXZlIGxvc3QgY29udGVudFwiKTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBcbiAgICAvLyBWZXJpZnkgdGhlIG91dHB1dCBoYXMgdGltZXN0YW1wIGxpbmtzXG4gICAgY29uc3QgdGltZXN0YW1wTGlua1BhdHRlcm4gPSBuZXcgUmVnRXhwKGBcXFxcW1dhdGNoXFxcXF1cXFxcKGh0dHBzOi8vd3d3XFxcXC55b3V0dWJlXFxcXC5jb20vd2F0Y2hcXFxcP3Y9JHt2aWRlb0lkfSZ0PVxcXFxkK1xcXFwpYCk7XG4gICAgY29uc3QgaGFzTGlua3MgPSB0aW1lc3RhbXBMaW5rUGF0dGVybi50ZXN0KGVuaGFuY2VkQ29udGVudCk7XG4gICAgXG4gICAgaWYgKCFoYXNMaW5rcykge1xuICAgICAgICBsb2dnZXIud2FybihcIk5vIHRpbWVzdGFtcCBsaW5rcyBmb3VuZCBpbiBMTE0gb3V0cHV0XCIpO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIEZpbmQgaGVhZGluZ3MgaW4gY29udGVudFxuICogXG4gKiBAcGFyYW0gY29udGVudCBUaGUgZG9jdW1lbnQgY29udGVudFxuICogQHJldHVybnMgQXJyYXkgb2YgaGVhZGluZ3Mgd2l0aCB0aGVpciB0ZXh0IGFuZCBwb3NpdGlvbnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRDb250ZW50SGVhZGluZ3MoY29udGVudDogc3RyaW5nKTogeyB0ZXh0OiBzdHJpbmc7IHBvc2l0aW9uOiBudW1iZXIgfVtdIHtcbiAgICBjb25zdCBoZWFkaW5nczogeyB0ZXh0OiBzdHJpbmc7IHBvc2l0aW9uOiBudW1iZXIgfVtdID0gW107XG4gICAgXG4gICAgLy8gRmluZCBhbGwgaGVhZGluZ3MgaW4gdGhlIGNvbnRlbnQgdGhhdCBtYXRjaCBvdXIgZXhwZWN0ZWQgZm9ybWF0XG4gICAgLy8gVGhpcyB3aWxsIG1hdGNoOlxuICAgIC8vIC0gIyMjIDEuMS4gSGVhZGluZyAoc2VjdGlvbiBoZWFkaW5nKVxuICAgIC8vIC0gIyMgMS4gSGVhZGluZyAoc3ViaGVhZGluZylcbiAgICAvLyAtICMgMS4gSGVhZGluZyAobWFpbiBoZWFkaW5nKVxuICAgIC8vIEJ1dCBub3Q6XG4gICAgLy8gLSAjIEhlYWRpbmcgKHdpdGhvdXQgbnVtYmVyKVxuICAgIC8vIC0gIyMgSGVhZGluZyAod2l0aG91dCBudW1iZXIpXG4gICAgLy8gLSAjIChob3Jpem9udGFsIHJ1bGUpXG4gICAgY29uc3QgaGVhZGluZ1JlZ2V4ID0gL14oIytcXHMrXFxkKyg/OlxcLlxcZCspP1xcLj9cXHMrLio/KSQvZ207XG4gICAgbGV0IG1hdGNoO1xuICAgIFxuICAgIHdoaWxlICgobWF0Y2ggPSBoZWFkaW5nUmVnZXguZXhlYyhjb250ZW50KSkgIT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgaGVhZGluZ1RleHQgPSBtYXRjaFswXTtcbiAgICAgICAgaGVhZGluZ3MucHVzaCh7XG4gICAgICAgICAgICB0ZXh0OiBoZWFkaW5nVGV4dCxcbiAgICAgICAgICAgIHBvc2l0aW9uOiBtYXRjaC5pbmRleFxuICAgICAgICB9KTtcbiAgICB9XG4gICAgXG4gICAgbG9nZ2VyLmRlYnVnKGBGb3VuZCAke2hlYWRpbmdzLmxlbmd0aH0gaGVhZGluZ3MgaW4gY29udGVudDogJHtoZWFkaW5ncy5tYXAoaCA9PiBoLnRleHQpLmpvaW4oJywgJyl9YCk7XG4gICAgXG4gICAgcmV0dXJuIGhlYWRpbmdzO1xufVxuXG4vKipcbiAqIENyZWF0ZSBvcHRpbWl6ZWQgY2h1bmtzIGZyb20gY29udGVudCBiYXNlZCBvbiBoZWFkaW5nc1xuICogXG4gKiBAcGFyYW0gY29udGVudCBUaGUgZG9jdW1lbnQgY29udGVudFxuICogQHBhcmFtIG1heFRva2VuTGltaXQgTWF4aW11bSB0b2tlbiBsaW1pdFxuICogQHJldHVybnMgQXJyYXkgb2YgY29udGVudCBjaHVua3NcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU9wdGltaXplZENodW5rcyhcbiAgICBjb250ZW50OiBzdHJpbmcsXG4gICAgbWF4VG9rZW5MaW1pdDogbnVtYmVyXG4pOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgaGVhZGluZ3MgPSBmaW5kQ29udGVudEhlYWRpbmdzKGNvbnRlbnQpO1xuICAgIGNvbnN0IGNodW5rczogc3RyaW5nW10gPSBbXTtcbiAgICBcbiAgICBsb2dnZXIuZGVidWcoYEZvdW5kICR7aGVhZGluZ3MubGVuZ3RofSBoZWFkaW5ncyBpbiBjb250ZW50YCk7XG4gICAgXG4gICAgaWYgKGhlYWRpbmdzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBObyBoZWFkaW5ncyBmb3VuZCwgcHJvY2VzcyBjb250ZW50IGFzIGEgc2luZ2xlIGNodW5rXG4gICAgICAgIGNodW5rcy5wdXNoKGNvbnRlbnQpO1xuICAgICAgICByZXR1cm4gY2h1bmtzO1xuICAgIH1cbiAgICBcbiAgICAvLyBDaGVjayBpZiB0aGVyZSdzIGNvbnRlbnQgYmVmb3JlIHRoZSBmaXJzdCBoZWFkaW5nICh0ZW1wbGF0ZSBoZWFkZXIpXG4gICAgaWYgKGhlYWRpbmdzWzBdLnBvc2l0aW9uID4gMCkge1xuICAgICAgICAvLyBBZGQgdGhlIHRlbXBsYXRlIGhlYWRlciBhcyBpdHMgb3duIGNodW5rICh3b24ndCBiZSBtb2RpZmllZCwganVzdCBwcmVzZXJ2ZWQpXG4gICAgICAgIGNvbnN0IHRlbXBsYXRlSGVhZGVyID0gY29udGVudC5zdWJzdHJpbmcoMCwgaGVhZGluZ3NbMF0ucG9zaXRpb24pO1xuICAgICAgICBjaHVua3MucHVzaCh0ZW1wbGF0ZUhlYWRlcik7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcIkFkZGVkIHRlbXBsYXRlIGhlYWRlciBhcyBzZXBhcmF0ZSBjaHVua1wiKTtcbiAgICB9XG4gICAgXG4gICAgLy8gT3B0aW1pemUgY2h1bmtpbmcgYnkgY29tYmluaW5nIG11bHRpcGxlIHNlY3Rpb25zIHRvIHJlZHVjZSBMTE0gY2FsbHNcbiAgICBjb25zdCBtYXhDaHVua1Rva2VucyA9IG1heFRva2VuTGltaXQgKiAwLjc7IC8vIFVzZSA3MCUgb2YgbW9kZWwncyBtYXggdG9rZW5zXG4gICAgY29uc3QgYXZnVG9rZW5zUGVyQ2hhciA9IDAuMjU7IC8vIENvbnNlcnZhdGl2ZSBlc3RpbWF0ZTogfjQgY2hhcnMgcGVyIHRva2VuXG4gICAgbGV0IGN1cnJlbnRDaHVuayA9IFwiXCI7XG4gICAgbGV0IGN1cnJlbnRIZWFkaW5nQ291bnQgPSAwO1xuICAgIGxldCBwcm9jZXNzZWRIZWFkaW5ncyA9IDA7XG4gICAgXG4gICAgLy8gUHJvY2VzcyBlYWNoIGhlYWRpbmcgdG8gY3JlYXRlIG9wdGltaXplZCBjaHVua3NcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGhlYWRpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHN0YXJ0UG9zID0gaGVhZGluZ3NbaV0ucG9zaXRpb247XG4gICAgICAgIGNvbnN0IGVuZFBvcyA9IGkgPCBoZWFkaW5ncy5sZW5ndGggLSAxID8gXG4gICAgICAgICAgICBoZWFkaW5nc1tpICsgMV0ucG9zaXRpb24gOiBcbiAgICAgICAgICAgIGNvbnRlbnQubGVuZ3RoO1xuICAgICAgICBcbiAgICAgICAgY29uc3Qgc2VjdGlvbiA9IGNvbnRlbnQuc3Vic3RyaW5nKHN0YXJ0UG9zLCBlbmRQb3MpO1xuICAgICAgICBjb25zdCBzZWN0aW9uVG9rZW5zID0gc2VjdGlvbi5sZW5ndGggKiBhdmdUb2tlbnNQZXJDaGFyO1xuICAgICAgICBcbiAgICAgICAgLy8gSWYgYWRkaW5nIHRoaXMgc2VjdGlvbiB3b3VsZCBleGNlZWQgdG9rZW4gbGltaXQsIGNyZWF0ZSBhIG5ldyBjaHVua1xuICAgICAgICBpZiAoY3VycmVudENodW5rICYmIChjdXJyZW50Q2h1bmsubGVuZ3RoICogYXZnVG9rZW5zUGVyQ2hhciArIHNlY3Rpb25Ub2tlbnMpID4gbWF4Q2h1bmtUb2tlbnMpIHtcbiAgICAgICAgICAgIGNodW5rcy5wdXNoKGN1cnJlbnRDaHVuayk7XG4gICAgICAgICAgICBsb2dnZXIuZGVidWcoYEFkZGVkIG9wdGltaXplZCBjaHVuayB3aXRoICR7Y3VycmVudEhlYWRpbmdDb3VudH0gaGVhZGluZ3MgKCR7cHJvY2Vzc2VkSGVhZGluZ3MgKyAxfS0ke3Byb2Nlc3NlZEhlYWRpbmdzICsgY3VycmVudEhlYWRpbmdDb3VudH0pYCk7XG4gICAgICAgICAgICBjdXJyZW50Q2h1bmsgPSBzZWN0aW9uO1xuICAgICAgICAgICAgY3VycmVudEhlYWRpbmdDb3VudCA9IDE7XG4gICAgICAgICAgICBwcm9jZXNzZWRIZWFkaW5ncyArPSBjdXJyZW50SGVhZGluZ0NvdW50O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gQWRkIHNlY3Rpb24gdG8gY3VycmVudCBjaHVua1xuICAgICAgICAgICAgY3VycmVudENodW5rICs9IHNlY3Rpb247XG4gICAgICAgICAgICBjdXJyZW50SGVhZGluZ0NvdW50Kys7XG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgLy8gQWRkIHRoZSBmaW5hbCBjaHVuayBpZiBub3QgZW1wdHlcbiAgICBpZiAoY3VycmVudENodW5rKSB7XG4gICAgICAgIGNodW5rcy5wdXNoKGN1cnJlbnRDaHVuayk7XG4gICAgICAgIHByb2Nlc3NlZEhlYWRpbmdzICs9IGN1cnJlbnRIZWFkaW5nQ291bnQ7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhgQWRkZWQgZmluYWwgb3B0aW1pemVkIGNodW5rIHdpdGggJHtjdXJyZW50SGVhZGluZ0NvdW50fSBoZWFkaW5ncyAoJHtwcm9jZXNzZWRIZWFkaW5ncyAtIGN1cnJlbnRIZWFkaW5nQ291bnQgKyAxfS0ke3Byb2Nlc3NlZEhlYWRpbmdzfSlgKTtcbiAgICB9XG4gICAgXG4gICAgLy8gVmVyaWZ5IGFsbCBoZWFkaW5ncyB3ZXJlIHByb2Nlc3NlZFxuICAgIGlmIChwcm9jZXNzZWRIZWFkaW5ncyAhPT0gaGVhZGluZ3MubGVuZ3RoKSB7XG4gICAgICAgIGxvZ2dlci53YXJuKGBXYXJuaW5nOiBQcm9jZXNzZWQgJHtwcm9jZXNzZWRIZWFkaW5nc30gaGVhZGluZ3MgYnV0IGZvdW5kICR7aGVhZGluZ3MubGVuZ3RofSB0b3RhbCBoZWFkaW5nc2ApO1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gY2h1bmtzO1xufVxuXG4vKipcbiAqIEVuc3VyZSBhIGNodW5rIGVuZHMgd2l0aCBhIG5ld2xpbmVcbiAqIFxuICogQHBhcmFtIGNodW5rIFRoZSBjb250ZW50IGNodW5rXG4gKiBAcmV0dXJucyBUaGUgY2h1bmsgd2l0aCBhIHRyYWlsaW5nIG5ld2xpbmVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVRyYWlsaW5nTmV3bGluZShjaHVuazogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gY2h1bmsuZW5kc1dpdGgoXCJcXG5cIikgPyBjaHVuayA6IGNodW5rICsgXCJcXG5cIjtcbn1cblxuLyoqXG4gKiBDb3VudCB0aW1lc3RhbXAgbGlua3MgaW4gZW5oYW5jZWQgY29udGVudFxuICogXG4gKiBAcGFyYW0gY29udGVudCBUaGUgZW5oYW5jZWQgY29udGVudFxuICogQHJldHVybnMgVGhlIG51bWJlciBvZiBoZWFkaW5ncyB3aXRoIHRpbWVzdGFtcCBsaW5rc1xuICovXG5leHBvcnQgZnVuY3Rpb24gY291bnRUaW1lc3RhbXBMaW5rcyhjb250ZW50OiBzdHJpbmcpOiBudW1iZXIge1xuICAgIGNvbnN0IGhlYWRpbmdzV2l0aExpbmtzID0gY29udGVudC5tYXRjaCgvXiMrXFxzK1xcZCsoPzpcXC5cXGQrKT9cXC4/XFxzK1teXFxuXSpcXFtXYXRjaFxcXS9nbSk7XG4gICAgcmV0dXJuIGhlYWRpbmdzV2l0aExpbmtzID8gaGVhZGluZ3NXaXRoTGlua3MubGVuZ3RoIDogMDtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIGNodW5rIGNvbnRhaW5zIGEgcHJvcGVyIHNlY3Rpb24gaGVhZGluZ1xuICogXG4gKiBAcGFyYW0gY2h1bmsgVGhlIGNvbnRlbnQgY2h1bmtcbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIGNodW5rIGNvbnRhaW5zIGEgcHJvcGVyIHNlY3Rpb24gaGVhZGluZ1xuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzUHJvcGVySGVhZGluZyhjaHVuazogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICEhY2h1bmsubWF0Y2goL14jK1xccytcXGQrKD86XFwuXFxkKyk/XFwuP1xccysvbSk7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBjaHVuayBoYXMgdmFsaWQgdGltZXN0YW1wIGxpbmtzXG4gKiBcbiAqIEBwYXJhbSBjaHVuayBUaGUgY29udGVudCBjaHVua1xuICogQHBhcmFtIHZpZGVvSWQgVGhlIFlvdVR1YmUgdmlkZW8gSURcbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIGNodW5rIGhhcyB2YWxpZCB0aW1lc3RhbXAgbGlua3NcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc1RpbWVzdGFtcExpbmtzKGNodW5rOiBzdHJpbmcsIHZpZGVvSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHRpbWVzdGFtcExpbmtQYXR0ZXJuID0gbmV3IFJlZ0V4cChgXFxcXFtXYXRjaFxcXFxdXFxcXChodHRwczovL3d3d1xcXFwueW91dHViZVxcXFwuY29tL3dhdGNoXFxcXD92PSR7dmlkZW9JZH0mdD1cXFxcZCtcXFxcKWApO1xuICAgIGNvbnN0IGhhc0xpbmtzID0gdGltZXN0YW1wTGlua1BhdHRlcm4udGVzdChjaHVuayk7XG4gICAgXG4gICAgaWYgKCFoYXNMaW5rcykge1xuICAgICAgICAvLyBMb2cgdGhlIGZpcnN0IGZldyBodW5kcmVkIGNoYXJhY3RlcnMgdG8gc2VlIHdoYXQncyBjb21pbmcgYmFja1xuICAgICAgICBsb2dnZXIuZGVidWcoYE5vIHRpbWVzdGFtcCBsaW5rcyBmb3VuZCBpbiBjaHVuay4gRmlyc3QgMjAwIGNoYXJzOiAke2NodW5rLnN1YnN0cmluZygwLCAyMDApfS4uLmApO1xuICAgICAgICBcbiAgICAgICAgLy8gQ2hlY2sgaWYgd2UgaGF2ZSBhbnkgaGVhZGluZ3Mgd2l0aCBwcm9wZXIgZm9ybWF0XG4gICAgICAgIGNvbnN0IGhlYWRpbmdzID0gY2h1bmsubWF0Y2goL14jK1xccytcXGQrKD86XFwuXFxkKyk/XFwuP1xccysvZ20pO1xuICAgICAgICBpZiAoaGVhZGluZ3MpIHtcbiAgICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhgRm91bmQgJHtoZWFkaW5ncy5sZW5ndGh9IG51bWJlcmVkIGhlYWRpbmdzIGJ1dCBubyB0aW1lc3RhbXAgbGlua3NgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhgTm8gbnVtYmVyZWQgaGVhZGluZ3MgZm91bmQgaW4gY2h1bmtgKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGxpbmtzID0gY2h1bmsubWF0Y2godGltZXN0YW1wTGlua1BhdHRlcm4pO1xuICAgICAgICBsb2dnZXIuZGVidWcoYEZvdW5kICR7bGlua3MgPyBsaW5rcy5sZW5ndGggOiAwfSB0aW1lc3RhbXAgbGlua3MgaW4gY2h1bmtgKTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIGhhc0xpbmtzO1xufVxuXG4vKipcbiAqIENvbnZlcnRzIGEgdGltZXN0YW1wIGluIEhIOk1NOlNTIGZvcm1hdCB0byBzZWNvbmRzXG4gKiBAcGFyYW0gdGltZXN0YW1wIFRoZSB0aW1lc3RhbXAgaW4gSEg6TU06U1MgZm9ybWF0XG4gKiBAcmV0dXJucyBUb3RhbCBzZWNvbmRzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb252ZXJ0VGltZXN0YW1wVG9TZWNvbmRzKHRpbWVzdGFtcDogc3RyaW5nKTogbnVtYmVyIHtcbiAgICB0cnkge1xuICAgICAgICAvLyBVc2UgdGhlIGxpYnJhcnkncyB0b1MgZnVuY3Rpb24gZXhhY3RseSBhcyBkb2N1bWVudGVkIGluIG5wbVxuICAgICAgICAvLyBUaW1lRm9ybWF0LnRvUygnMDI6MDA6MDAnLCAnaGg6bW06c3MnKSA9PiA3MjAwXG4gICAgICAgIHJldHVybiBUaW1lRm9ybWF0LnRvUyh0aW1lc3RhbXAsICdoaDptbTpzcycpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgRXJyb3IgY29udmVydGluZyB0aW1lc3RhbXAgJHt0aW1lc3RhbXB9IHRvIHNlY29uZHM6ICR7ZXJyb3J9YCk7XG4gICAgICAgIHJldHVybiAwO1xuICAgIH1cbn0gIl19