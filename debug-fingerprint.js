// Simple script to check current fingerprint status and log buffer
// This script can be run in the Obsidian console to check fingerprint information

console.log("=== TubeSage Fingerprint Debug ===");

// Try to access the fingerprint generator if it's available
try {
    // First check if we can access the logger
    if (typeof window !== 'undefined' && window.require) {
        const { getLogger, getLogsAsString } = window.require('src/utils/logger');
        const { getFingerprintStatus } = window.require('src/utils/fingerprint-generator');
        
        console.log("Current fingerprint status:");
        console.log(getFingerprintStatus());
        
        console.log("\nAll logs related to fingerprints:");
        const allLogs = getLogsAsString();
        const fingerprintLogs = allLogs.split('\n').filter(line => 
            line.includes('FINGERPRINT') || 
            line.includes('User-Agent') || 
            line.includes('fingerprint') ||
            line.includes('Chrome/')
        );
        
        fingerprintLogs.forEach(log => console.log(log));
        
    } else {
        console.log("Not in Obsidian environment or require not available");
    }
} catch (error) {
    console.log("Error accessing fingerprint info:", error.message);
}

// Basic environment check
console.log("\n=== Environment Info ===");
console.log("User Agent:", navigator.userAgent);
console.log("Platform:", navigator.platform);
console.log("Is Obsidian Mobile:", typeof window !== "undefined" && 
    typeof window.app !== "undefined" && window.app?.isMobile === true);