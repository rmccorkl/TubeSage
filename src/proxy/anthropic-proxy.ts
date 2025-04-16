import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ChildProcess, spawn, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getLogger } from '../utils/logger';

// Initialize logger
const logger = getLogger('ANTHROPIC-PROXY');

let proxyServer: ChildProcess | null = null;
let isProxyRunning = false;
let proxyPort = 51889;
let tempDir = '';
let pluginPath = '';

// Track the node executable path
let nodePath = '';

// Set the plugin path - this should be called from the main plugin on initialization
export function setPluginPath(path: string) {
    pluginPath = path;
    logger.debug('Plugin path set to:', pluginPath);
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

/**
 * Searches for a Node.js executable in the system PATH and common installation locations
 * 
 * This plugin requires Node.js to be installed on your system for Claude integration.
 * No bundled Node.js is included - you must have Node.js installed and in your PATH.
 * 
 * @returns Promise that resolves to the path of the Node.js executable or null if not found
 */
async function findNodeExecutable(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'where node' : 'which node';
        
        logger.debug('Searching for Node.js in system PATH...');
        
        require('child_process').exec(command, (error: any, stdout: string) => {
            if (!error && stdout) {
                // Return the first path (there might be multiple on Windows)
                const nodePath = stdout.trim().split(/\r?\n/)[0];
                logger.debug('Node.js found in PATH:', nodePath);
                resolve(nodePath);
                return;
            }
            
            logger.debug('Node.js not found in PATH, checking common installation locations...');
            
            // Check common installation locations as a fallback
            const commonPaths = isWindows 
                ? [
                    'C:\\Program Files\\nodejs\\node.exe', 
                    'C:\\Program Files (x86)\\nodejs\\node.exe',
                    'C:\\nodejs\\node.exe',
                    `${process.env.APPDATA}\\npm\\node.exe`,
                    `${process.env.LOCALAPPDATA}\\npm\\node.exe`
                ]
                : [
                    '/usr/local/bin/node', 
                    '/usr/bin/node', 
                    '/opt/homebrew/bin/node',
                    '/opt/local/bin/node',
                    '/opt/bin/node'
                ];
            
            for (const nodePath of commonPaths) {
                try {
                    if (fs.existsSync(nodePath)) {
                        logger.debug('Node.js found at:', nodePath);
                        resolve(nodePath);
                        return;
                    }
                } catch (e) {
                    logger.error(`Error checking Node.js path ${nodePath}:`, e);
                }
            }
            
            logger.error('Node.js not found in PATH or common locations. Please install Node.js from https://nodejs.org/');
            resolve(null);
        });
    });
}

export function startLocalProxy(apiKey: string, port: number = 51889): Promise<number> {
    // If proxy is already running, return the current port
    if (isProxyRunning && proxyServer) {
        logger.debug(`Proxy already running on port ${proxyPort}`);
        return Promise.resolve(proxyPort);
    }

    proxyPort = port;
    
    return new Promise(async (resolve, reject) => {
        try {
            // Ensure we have a temp directory
            tempDir = ensureTempDir();
            logger.debug(`Using temp directory: ${tempDir}`);
            
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

            // Write the script to our temp directory - normalize the path for cross-platform compatibility
            const scriptPath = path.join(tempDir, 'anthropic-proxy.js');
            
            fs.writeFileSync(scriptPath, proxyScript);
            logger.debug(`Proxy script written to ${scriptPath}`);
            
            logger.debug(`Starting proxy server on port ${port}`);
            
            // Try to find Node.js in system PATH
            try {
                if (!nodePath) {
                    // Only search for Node.js if we haven't found it before
                    const foundNodePath = await findNodeExecutable();
                    
                    if (!foundNodePath) {
                        throw new Error('Node.js not found. Please make sure Node.js is installed and in your PATH.');
                    }
                    
                    nodePath = foundNodePath;
                }
                
                logger.debug(`Using Node.js executable: ${nodePath}`);
                
                // Create a proper environment with path variables normalized for the current platform
                const env = { ...process.env };
                
                // For Windows, ensure proper path separators
                const isWindows = process.platform === 'win32';
                if (isWindows) {
                    // Make sure PATH uses the correct separator
                    if (env.Path) {
                        env.PATH = env.Path;  // Windows often uses 'Path' instead of 'PATH'
                    }
                    
                    // Add the parent directory of the node executable to the PATH
                    // This helps with finding npm and other Node.js utilities
                    const nodeDir = path.dirname(nodePath);
                    if (env.PATH && !env.PATH.includes(nodeDir)) {
                        env.PATH = `${nodeDir}${path.delimiter}${env.PATH}`;
                    }
                }
                
                // Directly spawn Node with the script
                const options = {
                    stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe' | 'inherit')[],
                    env,
                    windowsHide: false, // Make sure the process is visible for Windows users
                    detached: false // Keep the process attached to the parent
                };
                
                // Use the proper path to node and script path
                proxyServer = spawn(nodePath, [scriptPath], options);
                
                if (!proxyServer) {
                    throw new Error('Failed to start proxy server process');
                }
                
                // Safely add event listeners with null checks
                if (proxyServer.stdout) {
                    proxyServer.stdout.on('data', (data) => {
                        const message = data.toString().trim();
                        logger.debug(`Proxy output: ${message}`);
                        
                        // Look for the "server started" message
                        if (message.includes('proxy server started')) {
                            isProxyRunning = true;
                            logger.info(`Server confirmed running on port ${port}`);
                            resolve(port);
                        }
                    });
                }
                
                if (proxyServer.stderr) {
                    proxyServer.stderr.on('data', (data) => {
                        const message = data.toString().trim();
                        logger.error(`Proxy error: ${message}`);
                        
                        // If we detect node not found errors, provide a helpful message
                        if (message.includes('not found') || message.includes('Error: Cannot find module')) {
                            reject(new Error('Node.js dependencies not found. Please make sure Node.js is properly installed.'));
                        }
                    });
                }
                
                proxyServer.on('error', (error) => {
                    logger.error(`Failed to start proxy process: ${error.message}`);
                    reject(error);
                });
                
                proxyServer.on('close', (code) => {
                    logger.debug(`Server process exited with code ${code}`);
                    
                    // If server exits quickly and we haven't set it as running, it's an error
                    if (!isProxyRunning) {
                        isProxyRunning = false;
                        proxyServer = null;
                        reject(new Error(`Proxy server exited with code ${code} before it could start`));
                    }
                });
                
                // Set a timeout to check if server started
                setTimeout(() => {
                    if (!isProxyRunning) {
                        // If server didn't start in time, try to kill it and reject
                        if (proxyServer) {
                            try {
                                proxyServer.kill();
                            } catch (e) {
                                logger.error(`Error killing proxy server: ${e}`);
                            }
                            proxyServer = null;
                        }
                        reject(new Error('Timeout waiting for proxy server to start'));
                    }
                }, 5000);
            } catch (nodeError) {
                logger.error('Could not start proxy server:', nodeError);
                reject(new Error(`Could not start Node.js proxy: ${nodeError.message}`));
            }
            
        } catch (error) {
            logger.error('Error starting proxy server:', error);
            reject(error);
        }
    });
}

export function stopLocalProxy(): Promise<void> {
    return new Promise((resolve) => {
        if (!proxyServer) {
            logger.debug('No proxy server running to stop');
            resolve();
            return;
        }
        
        logger.debug('Stopping proxy server gracefully');
        try {
            // Store the process ID for potential force-kill
            const pid = proxyServer.pid;
            logger.debug(`Proxy server process ID: ${pid}`);
            
            // Flag to track if the process was gracefully terminated
            let cleanlyTerminated = false;
            
            // Function to do final cleanup
            const finalCleanup = () => {
                logger.debug('Final cleanup of proxy resources');
                proxyServer = null;
                isProxyRunning = false;
                resolve();
            };
            
            // Handle different platforms
            const isWindows = process.platform === 'win32';
            
            // First attempt: Send termination signal
            if (isWindows) {
                // Windows doesn't fully support SIGTERM, so just use kill()
                logger.debug('Windows platform detected, using standard kill');
                proxyServer.kill();
            } else {
                // Unix platforms support standard signals
                logger.debug('Unix platform detected, using SIGTERM');
                proxyServer.kill('SIGTERM');
            }
            
            // Add multiple signal handlers to ensure process is killed
            proxyServer.on('exit', (code) => {
                logger.debug(`Proxy server stopped gracefully with code ${code}`);
                cleanlyTerminated = true;
                finalCleanup();
            });
            
            proxyServer.on('close', () => {
                logger.debug('Proxy server process closed');
                cleanlyTerminated = true;
                finalCleanup();
            });
            
            // Shorter timeouts for quicker termination
            // Force kill after 2 seconds if graceful shutdown fails
            setTimeout(() => {
                if (proxyServer && !cleanlyTerminated) {
                    logger.warn('Graceful shutdown timed out, forcing termination');
                    try {
                        if (isWindows) {
                            // Try harder on Windows with taskkill if we have the PID
                            if (pid) {
                                logger.debug(`Using taskkill for PID ${pid}`);
                                try {
                                    // Use the execSync with timeout to prevent hanging
                                    const { execSync } = require('child_process');
                                    execSync(`taskkill /F /PID ${pid}`, { timeout: 1000 });
                                    logger.debug(`taskkill successful for PID ${pid}`);
                                } catch (taskkillError) {
                                    logger.error(`taskkill failed: ${taskkillError}`);
                                    // Still try the standard kill as fallback
                                    proxyServer.kill();
                                }
                            } else {
                                // No PID, use standard kill
                                proxyServer.kill();
                            }
                        } else {
                            // Unix platforms - use SIGKILL for forced termination
                            logger.debug('Sending SIGKILL to force termination');
                            proxyServer.kill('SIGKILL');
                        }
                    } catch (e) {
                        logger.error(`Error during forced termination: ${e}`);
                    }
                    
                    // Ensure cleanup after force kill attempt
                    setTimeout(finalCleanup, 500);
                }
            }, 2000);
        } catch (e) {
            logger.error(`Error stopping proxy server: ${e}`);
            // Emergency cleanup
            proxyServer = null;
            isProxyRunning = false;
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