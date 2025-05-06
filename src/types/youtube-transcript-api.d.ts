declare module 'youtube-transcript-api' {
    // Define the structure for a transcript segment from the API
    interface TranscriptItem {
        text: string;
        start: number;
        duration: number;
        // Allow for additional properties that might come from the API
        [key: string]: any;
    }

    interface TranscriptOptions {
        lang?: string;
        country?: string;
        // Any other options the API might accept
        [key: string]: any;
    }

    // Using the class name we found in the actual code
    export default class TranscriptAPI {
        static getTranscript(videoId: string, options?: TranscriptOptions): Promise<TranscriptItem[]>;
    }
} 