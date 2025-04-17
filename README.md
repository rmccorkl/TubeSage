#  TubeSage : YouTube Transcript LLM for Obsidian

TubeSage An Obsidian plugin to extract YouTube transcripts, summarize them with LLMs, and create notes using Templater.

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

## Requirements

- [Obsidian](https://obsidian.md/) v0.15.0+
- [Templater plugin](https://github.com/SilentVoid13/Templater) installed and enabled
- API key for your chosen LLM provider (OpenAI, Anthropic, or Google)
- YouTube API key (required for channel/playlist features) - see [instructions below](#creating-a-youtube-api-key)
- Optional: Node.js (required when using Anthropic as your LLM provider) - see [Node.js Requirements](#nodejs-requirements-for-anthropic-api)

## Installation

1. Download the latest release
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins` folder
3. Enable the plugin in Obsidian's Community Plugins settings
4. Accept the license terms in the plugin settings
5. Configure your API keys in the plugin settings
6. Install Templater plugin and copy example template to the Template folder locations 

## Recent Updates

### New Features (April 2025)

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

### Anthropic API Improvements
- Added proxy server health monitoring
- Better Node.js detection and error handling
- More robust error recovery for network issues

### Documentation Updates
- Updated workflow diagrams in the `/docs` folder
- Enhanced data flow documentation with detailed diagrams
- Added component interaction visualizations

For detailed technical documentation, see the updated diagrams in the `/docs` directory.

## Creating a YouTube API Key

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
   - In Obsidian, go to Settings > YouTube Transcript Plugin
   - Paste your API key in the "YouTube Data API Key" field

Note about Quotas: The YouTube Data API has daily quotas (by default, 10,000 units per day). Fetching a channel or playlist typically uses 1-100 units depending on the size. If you exceed your quota, you'll need to wait until it resets the next day or request a quota increase from Google.

## Usage

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

### Channel and Playlist Processing

You can also process entire YouTube channels or playlists:
1. Enter a YouTube channel or playlist URL
2. Choose how many videos to process
3. The plugin will create notes for each video in the collection

## Configuration

1. License Acceptance
   - You must accept the license before using the plugin
   - View the license terms using the "View License" button
   - Toggle "Accept License" to enable the plugin

2. Template Settings
   - Specify the path to your Templater template

3. Transcript Settings
   - Configure transcript language and country
   - Enter YouTube API key for channel/playlist features (required for processing channels/playlists - [see instructions](#creating-a-youtube-api-key))
   - Specify the root folder for transcript notes

4. LLM Settings
   - Choose between OpenAI, Anthropic, Google, or Ollama
   - Enter your API keys
   - Select specific models for each provider
   - Adjust temperature and max tokens

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

## License

This plugin is licensed under the MIT License with additional YouTube Content Usage Disclaimer. You must accept the license terms before using the plugin.

## Support Development

If you find this plugin useful, consider supporting its development:
- [Buy Me a Coffee](https://www.buymeacoffee.com/RMcCorkle)

## GitHub Repository

For issues, feature requests, or contributions, please visit the [GitHub repository](https://github.com/yourusername/youtube-transcript-llm).

## Architecture

This plugin uses a clean, framework-free approach utilizing the native Obsidian API.

Key components:
- `main.ts` - Main plugin file
- `src/youtube-transcript.ts` - YouTube transcript extraction
- `src/llm/transcript-summarizer.ts` - LLM integrations for summarization
- `src/utils/youtube-utils.ts` - Shared utility functions for YouTube URL handling
- `src/utils/error-utils.ts` - Standardized error handling utilities
- `src/utils/logger.ts` - Centralized logging system
- `src/utils/performance-monitor.ts` - Performance tracking and optimization

The UI is implemented using Obsidian's native Modal component, making it lightweight and consistent with Obsidian's user interface patterns.

### Node.js Requirements for Anthropic API

The plugin uses a local proxy for Anthropic API calls, which requires Node.js. When using Anthropic as your LLM provider, please note:

### System-installed Node.js is required
- The plugin looks for Node.js in your system PATH

### Installation required
- If Node.js is not found, you'll need to install it manually

To install Node.js:
1. Download the installer from [nodejs.org](https://nodejs.org/)
2. Follow the installation instructions for your platform
3. Ensure Node.js is added to your system PATH during installation
4. Restart Obsidian after installing Node.js

Supported platforms:
- Windows
- macOS (Intel and Apple Silicon)
- Linux

If Node.js is not found, the plugin will display a helpful error message with installation instructions when you try to use Anthropic models.

