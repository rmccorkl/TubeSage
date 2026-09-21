/**
 * Thrown by YouTubeTranscriptExtractor.fetchTranscript in strict mode when the video genuinely has no
 * usable captions (no caption tracks, or a track that is empty in every format) — a permanent outcome
 * for that video, unlike a network failure during the caption fetch.
 *
 * Lives in this leaf module (no imports) so the job adapters under src/runtime can test for it without
 * pulling in the extractor, whose HTTP shim imports `obsidian`.
 */
export class NoCaptionsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NoCaptionsError";
    }
}
