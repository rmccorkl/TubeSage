# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Development with watch mode
npm run dev

# Type checking and production build
npm run build

# Deploy to production
npm run deploy
```

## Project Architecture

TubeSage is an Obsidian plugin that extracts YouTube transcripts and generates structured notes using LLMs. Built with TypeScript and esbuild for cross-platform compatibility (desktop and mobile).

### Core Architecture Patterns

**Main Plugin Orchestration** (`main.ts`):
- Extends Obsidian's Plugin class
- Settings-driven configuration with comprehensive defaults
- Dependency injection pattern for component initialization
- Modal-based UI workflows for different processing types

**LLM Factory Pattern** (`src/llm/llm-factory.ts`):
- Creates appropriate LLM clients (OpenAI, Anthropic, Google, Ollama)
- Lazy loading with settings invalidation
- Unified interface across different AI providers

**Cross-Platform HTTP** (`src/utils/fetch-shim.ts`):
- Critical component that abstracts Obsidian's `requestUrl` as standard fetch API
- Enables all LLM providers to work on both desktop and mobile
- All HTTP requests MUST use `obsidianFetch` instead of standard fetch

**Transcript Processing** (`src/youtube-transcript.ts`):
- Static utility class for YouTube transcript extraction
- Handles multiple YouTube URL formats and caption types
- Robust error recovery with format fallbacks

### Key Components

- **Transcript Extraction**: `src/youtube-transcript.ts` - YouTube API interaction
- **AI Integration**: `src/llm/` directory contains all LLM provider clients
- **Utilities**: `src/utils/` - Cross-platform helpers, logging, validation
- **Types**: `src/types/` - TypeScript definitions for external libraries

### Settings Architecture

The plugin uses a comprehensive settings system (`YouTubeTranscriptPluginSettings`) that drives all functionality:
- LLM provider selection and API keys
- Prompt customization (system and user prompts)
- Processing parameters (temperature, max tokens)
- File organization (folders, templates)
- Debug and performance monitoring options

### Processing Workflow

1. **URL Validation** → **Video ID Extraction** → **Metadata Fetching**
2. **Transcript Extraction** → **AI Summarization** → **Template Application**
3. **Optional Timestamp Linking** → **File Creation**

### Error Handling Strategy

- Centralized error utilities with user-friendly messages
- Provider-specific error handling in LLM clients
- Graceful fallbacks for network and API failures
- Debug logging throughout for troubleshooting

## Critical Development Directives

### **PRIMARY REQUIREMENTS - ALWAYS RESPECT:**

1. **LLM Provider Abstraction**: ALL LLM providers MUST use LangChain for consistent provider abstraction
   - Never bypass LangChain by calling provider APIs directly  
   - Use `ChatOpenAI`, `ChatGoogleGenerativeAI`, `ChatOllama` classes from respective LangChain packages
   - This ensures consistent interface, error handling, and maintainability across all providers
   - All LLM calls must go through `src/llm/langchain-client.ts` using LangChain abstractions
   - **NO DIRECT API CALLS TO LLM PROVIDERS - USE LANGCHAIN ONLY**
   
   **EXCEPTION - Anthropic**: Uses direct API calls with `obsidianFetch` instead of LangChain
   - Anthropic's SDK has browser environment detection that conflicts with Obsidian's execution environment
   - Direct API calls bypass this detection and ensure reliable operation in both desktop and mobile
   - Must continue using direct HTTP calls to `https://api.anthropic.com/v1/messages` with custom headers

2. **HTTP Abstraction Layer**: Use `obsidianFetch` from `src/utils/fetch-shim.ts` for cross-platform compatibility
   - This is critical for cross-platform compatibility (desktop and mobile)
   - Apply via `getLangChainConfiguration()` for providers that support custom fetch (OpenAI, Anthropic, Ollama)
   - Some providers (Google) don't support custom fetch in constructor - use their default HTTP mechanism
   - Never use standard fetch directly - always prefer the shim where possible

3. **YouTube Scraping Method**: ALWAYS use the existing transcript extraction in `src/youtube-transcript.ts`
   - Uses proven ScrapeCreators method via YouTube Internal API
   - Handles multiple caption formats and error recovery
   - Never replace with external libraries or alternative scraping methods
   - Maintain the robust fallback mechanisms

## Important Development Notes

- **LLM Integration**: New providers should follow the factory pattern in `src/llm/llm-factory.ts`
- **Cross-Platform**: Code must work on both Obsidian desktop and mobile
- **Settings**: All configurable behavior should be driven by the settings system
- **TypeScript**: Strict type checking is enabled - maintain type safety

## Build System

- **esbuild** for bundling with CommonJS output
- **TypeScript** compilation with strict settings
- External dependencies include Obsidian API and various LLM SDKs
- Production builds exclude sourcemaps and enable tree shaking

## Development Guidelines Reference

For comprehensive Obsidian plugin development best practices, see: [`docs/obsidian-plugin-guidelines.md`](docs/obsidian-plugin-guidelines.md)

This complete reference contains all official Obsidian development guidelines including:
- Core development principles and security
- File system operations and data management  
- Network requests and async operations
- Workspace and view management
- Performance optimization techniques
- Modern JavaScript/TypeScript practices
- CSS styling guidelines and anti-patterns
- Plugin release and deployment procedures