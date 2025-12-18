declare module 'hh-mm-ss' {
    /**
     * Converts time in format HH:MM:SS to milliseconds
     * @param time Time string in format HH:MM:SS
     * @param format Format string (default: 'mm:ss')
     * @returns Number of milliseconds
     */
    export function toMs(time: string, format?: string): number;
    
    /**
     * Converts time in format HH:MM:SS to seconds
     * @param time Time string in format HH:MM:SS
     * @param format Format string (default: 'mm:ss')
     * @returns Number of seconds
     */
    export function toS(time: string, format?: string): number;
    
    /**
     * Converts milliseconds to time string in format HH:MM:SS
     * @param ms Number of milliseconds
     * @param format Format string (default: 'mm:ss')
     * @returns Formatted time string
     */
    export function fromMs(ms: number, format?: string): string;
    
    /**
     * Converts seconds to time string in format HH:MM:SS
     * @param s Number of seconds
     * @param format Format string (default: 'mm:ss')
     * @returns Formatted time string
     */
    export function fromS(s: number, format?: string): string;
} 