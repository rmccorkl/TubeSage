import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ChildProcess, spawn, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let proxyServer: ChildProcess | null = null;
let isProxyRunning = false;
let proxyPort = 51889;
let tempDir = '';
let pluginPath = '';

// Set the plugin path - this should be called from the main plugin on initialization
export function setPluginPath(path: string) {
    pluginPath = path;
    console.log(`[PROXY] Plugin path set to: ${pluginPath}`);
}

// Create the temp directory within the plugin's directory
function ensureTempDir(): string {
    // If plugin path is available, create temp dir inside it
    if (pluginPath && pluginPath !== '/') {
        const tempDirPath = path.join(pluginPath, 'temp');
        try {
            if (!fs.existsSync(tempDirPath)) {
                fs.mkdirSync(tempDirPath, { recursive: true });
            }
            return tempDirPath;
        } catch (e) {
            console.error(`[PROXY] Failed to create temp directory in plugin path: ${e}`);
        }
    } else {
        console.error(`[PROXY] Plugin path not set or invalid: '${pluginPath}'`);
    }
    
    // Debug directory structure
    try {
        if (pluginPath && pluginPath !== '/') {
            console.log(`[PROXY] Checking plugin directory structure for ${pluginPath}`);
            // Log if the plugin directory exists
            const pluginDirExists = fs.existsSync(pluginPath);
            console.log(`[PROXY] Plugin directory exists: ${pluginDirExists}`);
            
            // Try to list the plugin directory contents
            if (pluginDirExists) {
                const contents = fs.readdirSync(pluginPath);
                console.log(`[PROXY] Plugin directory contents: ${contents.join(', ')}`);
            }
        }
    } catch (error) {
        console.error(`[PROXY] Error checking plugin directory: ${error}`);
    }
    
    // Fallback to system temp directory
    return os.tmpdir();
}

// Update findNodeExecutable to only search for system-installed Node.js
/**
 * Searches for a Node.js executable in the system
 * 
 * This plugin requires Node.js to be installed on your system for Claude integration.
 * No bundled Node.js is included - you must have Node.js installed and in your PATH.
 * 
 * @returns Promise that resolves to the path of the Node.js executable
 */
async function findNodeExecutable(): Promise<string> {
    return new Promise((resolve, reject) => {
        // Try common Node.js paths based on platform
        const nodePaths = process.platform === 'win32' 
            ? ['node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'] 
            : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node', '/opt/local/bin/node'];

        // Try to find Node in PATH by running 'which node' or 'where node'
        const command = process.platform === 'win32' ? 'where node' : 'which node';
        
        console.log('[PROXY] Searching for Node.js in system PATH...');
        
        exec(command, (error, stdout) => {
            if (!error && stdout) {
                const path = stdout.trim();
                console.log(`[PROXY] Found Node.js in PATH: ${path}`);
                resolve(path);
                return;
            }
            
            console.log('[PROXY] Node.js not found in PATH, checking common installation locations...');
            
            // If not found in PATH, check common locations
            for (const nodePath of nodePaths) {
                if (fs.existsSync(nodePath)) {
                    console.log(`[PROXY] Found Node.js at: ${nodePath}`);
                    resolve(nodePath);
                    return;
                }
            }
            
            // If Node.js isn't found, provide a helpful error message
            const errorMessage = `Node.js not found. The Claude integration requires Node.js to be installed on your system.
Please install Node.js from https://nodejs.org/ (LTS version recommended) and ensure it's in your PATH.`;
            
            console.error(`[PROXY] ${errorMessage}`);
            reject(new Error(errorMessage));
        });
    });
}

export function startLocalProxy(apiKey: string, port: number = 51889): Promise<number> {
    // If proxy is already running, return the current port
    if (isProxyRunning && proxyServer) {
        console.log(`[PROXY] Proxy already running on port ${proxyPort}`);
        return Promise.resolve(proxyPort);
    }

    proxyPort = port;
    
    return new Promise(async (resolve, reject) => {
        try {
            // Ensure we have a temp directory
            tempDir = ensureTempDir();
            console.log(`[PROXY] Using temp directory: ${tempDir}`);
            
            // Create a simple proxy server as a string
            const proxyScript = `
// Simple proxy server for Anthropic API
const http = require('http');
const https = require('https');
const url = require('url');

const port = ${port};
const apiKey = "${apiKey}";
const targetHost = 'api.anthropic.com';

// Report process information for debugging
console.log(\`[PROXY] Running as process \${process.pid}\`);
console.log(\`[PROXY] Current working directory: \${process.cwd()}\`);
console.log(\`[PROXY] Node.js version: \${process.version}\`);

// Create a server that will forward requests to Anthropic
const server = http.createServer((req, res) => {
    console.log(\`[PROXY] \${req.method} \${req.url}\`);
    
    // Parse the URL
    const parsedUrl = url.parse(req.url || '/');
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, anthropic-version'
        });
        res.end();
        return;
    }
    
    // Handle GET request to /health (health check)
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end('Proxy server is running');
        return;
    }
    
    // Get the request body
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', () => {
        // Set up the request to Anthropic
        const options = {
            hostname: targetHost,
            port: 443,
            path: parsedUrl.path,
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            }
        };
        
        console.log(\`[PROXY] Forwarding request to \${targetHost}\${parsedUrl.path}\`);
        
        // Create the request to Anthropic
        const proxyReq = https.request(options, proxyRes => {
            // Set CORS headers
            res.writeHead(proxyRes.statusCode || 200, {
                ...proxyRes.headers,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, anthropic-version'
            });
            
            // Forward the response from Anthropic
            proxyRes.on('data', chunk => {
                res.write(chunk);
            });
            
            proxyRes.on('end', () => {
                res.end();
            });
        });
        
        // Handle errors
        proxyReq.on('error', error => {
            console.error('[PROXY] Error forwarding request:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Proxy error: ' + error.message }));
        });
        
        // Forward the request body
        if (body) {
            proxyReq.write(body);
        }
        
        proxyReq.end();
    });
});

// Handle server errors
server.on('error', (err) => {
    console.error('[PROXY] Server error:', err);
    if (err.code === 'EADDRINUSE') {
        console.error(\`[PROXY] Port \${port} is already in use. Another instance may be running.\`);
    }
});

// Start the server
server.listen(port, '127.0.0.1', () => {
    console.log(\`Anthropic proxy server started on http://127.0.0.1:\${port}\`);
});

// Handle uncaught errors
process.on('uncaughtException', err => {
    console.error('[PROXY] Uncaught exception:', err);
});

// Add proper signal handling for clean shutdown
process.on('SIGINT', () => {
    console.log('[PROXY] Received SIGINT signal, shutting down proxy server');
    shutdown();
});

process.on('SIGTERM', () => {
    console.log('[PROXY] Received SIGTERM signal, shutting down proxy server');
    shutdown();
});

// Clean shutdown function
function shutdown() {
    console.log('[PROXY] Closing server connections');
    server.close(() => {
        console.log('[PROXY] Server closed successfully');
        process.exit(0);
    });
    
    // Force exit after 1 second if server doesn't close cleanly
    setTimeout(() => {
        console.log('[PROXY] Forcing exit after timeout');
        process.exit(1);
    }, 1000);
}
            `;

            // Write the script to our temp directory
            const scriptPath = path.join(tempDir, 'anthropic-proxy.js');
            
            fs.writeFileSync(scriptPath, proxyScript);
            console.log(`[PROXY] Proxy script written to ${scriptPath}`);
            
            console.log(`[PROXY] Starting proxy server on port ${port}`);
            
            // Try to find Node.js
            try {
                const nodePath = await findNodeExecutable();
                
                // Directly spawn Node with the script
                proxyServer = spawn(nodePath, [scriptPath], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                if (!proxyServer) {
                    throw new Error('Failed to start proxy server');
                }
                
                // Safely add event listeners with null checks
                if (proxyServer.stdout) {
                    proxyServer.stdout.on('data', (data) => {
                        console.log(`[PROXY] ${data.toString().trim()}`);
                        
                        // Look for the "server started" message
                        if (data.toString().includes('proxy server started')) {
                            isProxyRunning = true;
                            console.log(`[PROXY] Server confirmed running on port ${port}`);
                            resolve(port);
                        }
                    });
                }
                
                if (proxyServer.stderr) {
                    proxyServer.stderr.on('data', (data) => {
                        console.error(`[PROXY ERROR] ${data.toString().trim()}`);
                        
                        // If we detect "not found" in stderr, reject with a clear error
                        if (data.toString().includes('not found')) {
                            reject(new Error('Node.js not found. Please make sure Node.js is installed and in your PATH.'));
                        }
                    });
                }
                
                proxyServer.on('error', (error) => {
                    console.error(`[PROXY] Failed to start proxy process: ${error.message}`);
                    reject(error);
                });
                
                proxyServer.on('close', (code) => {
                    console.log(`[PROXY] Server process exited with code ${code}`);
                    isProxyRunning = false;
                    proxyServer = null;
                    
                    // If server exits quickly, it's an error
                    if (!isProxyRunning) {
                        reject(new Error(`Proxy server exited with code ${code}`));
                    }
                });
                
                // Set a timeout to check if server started
                setTimeout(() => {
                    if (!isProxyRunning) {
                        // If server didn't start in time, try to kill it and reject
                        if (proxyServer) {
                            proxyServer.kill();
                            proxyServer = null;
                        }
                        reject(new Error('Timeout waiting for proxy server to start'));
                    }
                }, 5000);
            } catch (nodeError) {
                console.error('[PROXY] Could not find Node.js:', nodeError);
                reject(new Error('Could not find Node.js. Please install Node.js or ensure it is in your PATH.'));
            }
            
        } catch (error) {
            console.error('[PROXY] Error starting proxy server:', error);
            reject(error);
        }
    });
}

export function stopLocalProxy(): Promise<void> {
    return new Promise((resolve) => {
        if (proxyServer) {
            console.log('[PROXY] Stopping proxy server gracefully');
            try {
                // Store the process ID for potential force-kill
                const pid = proxyServer.pid;
                console.log(`[PROXY] Proxy server process ID: ${pid}`);
                
                // Flag to track if the process was gracefully terminated
                let cleanlyTerminated = false;
                
                // Function to do final cleanup
                const finalCleanup = () => {
                    console.log('[PROXY] Final cleanup of proxy resources');
                    proxyServer = null;
                    isProxyRunning = false;
                    resolve();
                };
                
                // First attempt: Send SIGTERM to allow graceful shutdown
                proxyServer.kill('SIGTERM');
                
                // Add multiple signal handlers to ensure process is killed
                proxyServer.on('exit', (code) => {
                    console.log(`[PROXY] Proxy server stopped gracefully with code ${code}`);
                    cleanlyTerminated = true;
                    finalCleanup();
                });
                
                proxyServer.on('close', () => {
                    console.log('[PROXY] Proxy server process closed');
                    cleanlyTerminated = true;
                    finalCleanup();
                });
                
                // Shorter timeouts for quicker termination
                // Force kill after 1.5 seconds if graceful shutdown fails
                setTimeout(() => {
                    if (proxyServer && !cleanlyTerminated) {
                        console.log('[PROXY] Force killing proxy server with SIGKILL');
                        try {
                            proxyServer.kill('SIGKILL');
                        } catch (e) {
                            console.error('[PROXY] Error sending SIGKILL:', e);
                        }
                        
                        // If that didn't work and we have the PID, try a platform-specific approach
                        setTimeout(() => {
                            if (!cleanlyTerminated && pid) {
                                console.log(`[PROXY] Attempting OS-level termination of process ${pid}`);
                                try {
                                    // Use different commands based on platform
                                    if (process.platform === 'win32') {
                                        // Windows - use taskkill with force option
                                        const { execSync } = require('child_process');
                                        execSync(`taskkill /F /PID ${pid}`, { timeout: 1000 });
                                    } else {
                                        // macOS/Linux - use kill -9
                                        const { execSync } = require('child_process');
                                        execSync(`kill -9 ${pid}`, { timeout: 1000 });
                                    }
                                    console.log(`[PROXY] OS-level termination successful for PID ${pid}`);
                                } catch (osKillError) {
                                    console.error(`[PROXY] OS-level termination failed: ${osKillError}`);
                                }
                            }
                            
                            // Clean up regardless of kill success
                            finalCleanup();
                        }, 500);
                    }
                }, 1500);
            } catch (e) {
                console.error('[PROXY] Error stopping proxy server:', e);
                if (proxyServer) {
                    try {
                        console.log('[PROXY] Emergency cleanup - forced kill');
                        proxyServer.kill('SIGKILL');
                    } catch (killError) {
                        console.error('[PROXY] Error force killing proxy server:', killError);
                    }
                }
                proxyServer = null;
                isProxyRunning = false;
                resolve();
            }
        } else {
            console.log('[PROXY] No proxy server running to stop');
            resolve();
        }
    });
}

export function getProxyUrl(): string {
    if (!isProxyRunning) {
        throw new Error('Proxy server is not running');
    }
    return `http://127.0.0.1:${proxyPort}`;
} 