# TubeSage : YouTube Transcript LLM for Obsidian

 TubeSage is a plugin that extracts YouTube video transcripts and uses large language models (LLMs) to generate comprehensive, structured notes—ideal for personal learning and educational study. The Notes generated then act as reference point back to orginal material and form a basis from which to then link and build on within obsidian. It leverages the Templater plugin to help generate Notes.

## Quick Start
### Installation
1. Download the latest release
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins` folder
3. Enable the plugin in Obsidian's Community Plugins settings
4. Accept the license terms in the plugin settings
5. Configure your API keys in the plugin settings
6. Install Templater plugin and copy example template to the Template folder locations

### Requirements
- [Obsidian](https://obsidian.md/) v1.2.0+
- [Templater plugin](https://github.com/SilentVoid13/Templater) installed and enabled
- API key for your chosen LLM provider (OpenAI, Anthropic, or Google)
- YouTube API key (required for channel/playlist features)

## Recommended Plugins and Settings

For the best experience with TubeSage, we recommend the following:

#### Recommended Plugins
- **Iconize**: Enhances note organization with customizable icons
- **Icon Shortcodes**: Adds support for icon shortcodes in your notes

#### Recommended Obsidian Settings
In Obsidian's Appearance settings:
- Disable "Show inline title" for a cleaner note view
- In Core Plugins settings:
  - Disable "Properties view" for better performance with large notes

These settings and plugins complement TubeSage's functionality and help maintain a clean, efficient workspace.

## Configuration

1. License Acceptance
   - You must accept the license before using the plugin
   - View the license terms using the "View License" button
   - Toggle "Accept License" to enable the plugin

2. Template Settings
   - Specify the path to your Templater template

3. Transcript Settings
   - Configure transcript language and country
     - Note: Transcripts are always initially retrieved in English (en-US)
     - Changing these settings will translate the final note into your target language, which requires an additional LLM processing pass
   - Enter YouTube API key for channel/playlist features (required for processing channels/playlists - [see instructions](#creating-a-youtube-api-key))
   - Specify the root folder for transcript notes

4. LLM Settings
   - Choose between OpenAI, Anthropic, Google, or Ollama
   - Enter your API keys
   - Select specific models for each provider
   - Adjust temperature and max tokens
     - Note: Default values are optimized for current models and set to get the maximum quality response for your notes
     - Exceeding preset limits may cause LLM API calls to fail
     - Only change these settings if you understand the specific model and its limitations

5. Note Format Settings
   - Configure date format and prepending options
   - Enable/disable timestamp links

6. Prompt Settings
   - Choose between Fast or Extensive summary mode
   - Customize system and user prompts for better summaries

7. Advanced Settings
   - Enable debug logging for troubleshooting
   - Configure performance monitoring options
   - Set batch processing parameters
   - Adjust mobile compatibility options

### Basic Usage
1. Click on the YouTube icon in the ribbon or use the command "Extract YouTube Transcript"
2. Enter a title for your note (optional - plugin will use the YouTube title if empty)
3. Paste the YouTube video URL
4. Select a folder for your note
5. Choose summary mode (Fast or Extensive)
6. Click "Process Video"
7. The plugin will:
   - Extract the transcript
   - Summarize it with your selected LLM
   - Add timestamp links to section headings
   - Create a new note using your Templater template

## Video Demonstration

[![TubeSage Demo Video](https://img.shields.io/badge/▶-Watch%20Demo%20Video-blue?style=for-the-badge)](https://rmccorkl.github.io/TubeSage/video.html)

Watch the video tutorial above to see how TubeSage works in practice. The video demonstrates the plugin's main features and walks through a complete workflow from extracting a YouTube transcript to generating a summarized note with timestamp links.

## LLM Provider Selection Guide

### When to use each LLM provider:

#### OpenAI
- **Best for**: General-purpose summaries, structured outlines, content categorization
- **Strengths**: Well-structured responses, follows instructions precisely, good with timestamps
- **Models**: GPT-4o recommended for best quality, GPT-3.5-Turbo for faster processing

#### Anthropic
- **Best for**: Nuanced discussions, complex topics, longer videos
- **Strengths**: More nuanced understanding of content, better with abstract concepts
- **Models**: Claude 3 Opus for highest quality, Claude 3 Haiku for speed

#### Google
- **Best for**: Factual summaries, technical content
- **Strengths**: Strong with factual data, good balance of speed and quality
- **Models**: Gemini Pro for best results

#### Ollama
- **Best for**: Privacy-focused users, offline work, faster local processing
- **Strengths**: Complete privacy, no data sharing, works offline
- **Requirements**: Ollama must be installed and running locally
- **Models**: Various options depending on your local setup

## License

This plugin is licensed under the MIT License with additional YouTube Content Usage Disclaimer. You must accept the license terms before using the plugin.

## Support Development

If you find this plugin useful, consider supporting its development:
- [Buy Me a Coffee](https://www.buymeacoffee.com/RMcCorkle)

## GitHub Repository

For issues, feature requests, or contributions, please visit the [GitHub repository](https://github.com/rmccorkl/TubeSage).


#### Creating a YouTube API Key
To process YouTube playlists and channels within limits, you need a YouTube Data API v3 key. This aligns with Google's quotas and best practices to prevent service abuse. Follow these steps:

1. Create a Google Account (skip if you already have one)
   - Go to [Google Account creation page](https://accounts.google.com/signup)
   - Follow the instructions to create your account

2. Access Google Cloud Console
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Sign in with your Google account

3. Create a New Project
   - Click on the project dropdown at the top of the page
   - Click on "New Project"
   - Enter a name for your project (e.g., "YouTube Transcript Plugin")
   - Click "Create"

4. Enable the YouTube Data API v3
   - Select your new project from the project dropdown
   - Navigate to "APIs & Services" > "Library" in the left sidebar
   - Search for "YouTube Data API v3"
   - Click on it and then click "Enable"

5. Create an API Key
   - Navigate to "APIs & Services" > "Credentials" in the left sidebar
   - Click "Create Credentials" at the top of the page
   - Select "API key" from the dropdown menu
   - Your new API key will be displayed

6. Restrict the API Key (Recommended)
   - In the API key details page, click "Edit API key"
   - Under "API restrictions", select "Restrict key" and choose "YouTube Data API v3"
   - Click "Save"

7. Add the API Key to the Plugin
   - Copy your new API key
   - In Obsidian, go to Settings > TubeSage
   - Paste your API key in the "YouTube Data API Key" field

Note about Quotas: The YouTube Data API has daily quotas (by default, 10,000 units per day). Fetching a channel or playlist typically uses 1-100 units depending on the size. If you exceed your quota, you'll need to wait until it resets the next day or request a quota increase from Google.


## Features

- Extract transcripts from YouTube videos
- Extract and process YouTube channels and playlists within limits
- Summarize transcripts using various LLMs:
  - OpenAI (GPT-4, GPT-4o, etc.)
  - Anthropic (Claude 3 family)
  - Google (Gemini)
  - Ollama (local models)
- Generate notes using Templater templates
- Add timestamp links to sections for easy video navigation
- Two summary modes: Fast and Extensive
- Customize summarization parameters and prompts
- Cross-platform support for both desktop and mobile Obsidian
- Performance monitoring for optimizing processing

## Advanced Usage

### Channel and Playlist Processing
You can also process entire YouTube channels or playlists:
1. Enter a YouTube channel or playlist URL
2. Choose how many videos to process
3. Configure batch processing settings (sequential or parallel)
4. The plugin will create notes for each video in the collection

### Timestamp Links
The timestamp links feature adds clickable links to section headings in your notes:
1. Each section heading is analyzed to identify its key topic
2. The timestamp most relevant to that topic is identified in the transcript
3. A "[Watch]" link is added to the end of the heading
4. Clicking the link opens YouTube at the exact timestamp for that section

### Performance Optimization
For best performance:
1. Choose an LLM model appropriate for your content length
2. Use Fast summary mode for quick overviews, Extensive for detailed analysis
3. For long videos, consider adjusting chunk sizes in advanced settings
4. On mobile, use smaller models or local Ollama models for better performance


## Technical Architecture

TubeSage uses a modular, factory-based architecture for maximum flexibility and cross-platform compatibility.

### Architecture Diagrams
Two comprehensive diagrams in the `/docs` directory explain the plugin's architecture:

#### [Data Flow Diagram](/docs/data-flow-diagram.md)
This diagram illustrates how data moves through the system:
- Transcript extraction from YouTube with platform-specific optimizations
- LLM Factory pattern for client management
- Integration with multiple LLM providers
- Timestamp processing system for enhanced navigation
- YouTube API integration for channel/playlist processing
- Performance monitoring and error recovery subsystems
- Cross-platform fetch handling
- Template application and note creation

#### [Workflow Diagram](/docs/workflow-diagram.md)
This diagram details the user and system workflow:
- Plugin setup and configuration process
- User interaction paths (single video, channel, playlist)
- Platform detection and adaptation (mobile vs desktop)
- Error handling with smart recovery system
- LLM provider selection and processing
- Timestamp linking generation process
- Performance monitoring lifecycle
- Batch processing with parallelization options

### Key Components

- **Main Module** (`main.ts`): Core plugin file that initializes and coordinates the plugin
- **Transcript Extractor** (`src/youtube-transcript.ts`): YouTube transcript extraction with mobile fallbacks
- **LLM Factory** (`src/llm/llm-factory.ts`): Factory pattern for creating and managing LLM clients
- **Transcript Summarizer** (`src/llm/transcript-summarizer.ts`): Coordinates transcript summarization with LLMs
- **LLM Clients**: Specialized clients for each provider:
  - `src/llm/openai-client.ts`: OpenAI API integration
  - `src/llm/anthropic-client.ts`: Anthropic API integration
  - `src/llm/gemini-client.ts`: Google Gemini API integration
  - `src/llm/ollama-client.ts`: Local Ollama integration
- **LangChain Integration** (`src/llm/langchain-client.ts`): Unified interface for LLM providers
- **Timestamp Processing** (`src/utils/timestamp-utils.ts`): Processing for adding and validating timestamp links
- **Fetch Shim** (`src/utils/fetch-shim.ts`): Cross-platform HTTP requests
- **Utilities**:
  - `src/utils/logger.ts`: Centralized logging system
  - `src/utils/error-utils.ts`: Standardized error handling
  - `src/utils/youtube-utils.ts`: YouTube-specific utilities
  - `src/utils/prompt-utils.ts`: Prompt template management
  - `src/utils/form-utils.ts`: Form validation

## Recent Updates

### New Features (April 2025)

### LLM Fetch Shim
- Implemented a unified fetch shim for all LLM providers
- Deprecated Node.js requirement for Anthropic API integration
- Added robust error handling and URL validation
- Cross-platform compatibility for all providers (desktop and mobile)

### Performance Monitoring System
- Added comprehensive performance monitoring to track LLM response times
- Identifies processing bottlenecks to improve overall performance
- Provides optimization suggestions based on your hardware and LLM choices

### Smart Model Selection
- Automatically selects the optimal LLM model based on transcript length and complexity
- Balances processing speed and output quality for different video types
- Respects user preferences while providing intelligent defaults

### Enhanced Batch Processing
- Improved channel and playlist processing with optimized batching
- Added configurable parallel processing for faster multi-video processing
- Better handling of YouTube API quota limits

### Improved Error Recovery
- Added smart retry mechanisms for failed transcript extractions
- Enhanced error diagnostics with solution suggestions
- More detailed logging for troubleshooting

### Optimized Timestamp Processing
- Improved chunk boundary handling for more accurate timestamp linking
- Enhanced validation of generated timestamp links
- Smart retry system for failed timestamp generation

### Mobile Support Enhancements
- Added fallback extraction methods optimized for mobile platforms
- Improved error handling for mobile-specific limitations
- Adaptive processing for iOS and Android

### Documentation Updates
- Updated workflow diagrams in the `/docs` folder
- Enhanced data flow documentation with detailed diagrams
- Added component interaction visualizations
- Included video tutorial to demonstrate the plugin in action

## Cross-Platform API Access

TubeSage uses a custom-built fetch shim to ensure all LLM providers work seamlessly across both desktop and mobile Obsidian:

- **Unified Interface**: All LLM providers (OpenAI, Anthropic, Google) use the same fetch implementation
- **Mobile Compatibility**: Works on iOS and Android without requiring Node.js
- **Error Handling**: Robust error recovery and detailed logging
- **LangChain Integration**: Uses LangChain with our custom fetcher for standardized LLM interactions

## Timestamp Processing System

The timestamp processing system enhances video notes with navigation links:

- **Document Component Extraction**: Parses frontmatter and content
- **Chunk Optimization**: Creates optimized chunks to stay within LLM token limits
- **Heading Detection**: Identifies and processes section headings
- **Timestamp Linking**: Adds YouTube timestamp links to relevant sections
- **Validation**: Validates generated links to ensure proper formatting and accuracy

## Performance Monitoring

The integrated performance monitoring system helps optimize plugin operation:

- **Metric Collection**: Tracks processing times for transcript extraction, LLM generation, and timestamp linking
- **Bottleneck Identification**: Identifies performance bottlenecks in the processing pipeline
- **Optimization Suggestions**: Provides recommendations for improving performance
- **Adaptive Processing**: Adjusts processing parameters based on performance metrics

## Contribution Policy

Thank you for your interest!

This project is provided as-is under the MIT license.

**I am happy to accept issues** for bug reports, feature suggestions, or general feedback.  
However, **I am not accepting pull requests or external code contributions at this time.**

If you’d like to make code changes or improvements, please fork the repository and work within your own fork.

Thank you for your understanding and support!