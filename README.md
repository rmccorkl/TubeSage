# TubeSage

TubeSage is an Obsidian plugin that converts YouTube videos into structured notes using large language models. It extracts transcripts, generates summaries, and can add timestamped links back to specific moments in the video.

## Quick Start

### Installation

**Community Plugins:** Install through Obsidian's Settings → Community plugins browser once TubeSage is listed in the directory.

**Manual install from a GitHub release:**
1. Open the [latest release](https://github.com/rmccorkl/TubeSage/releases/latest) page.
2. From the **Assets** section, download `main.js`, `manifest.json`, and `styles.css`.
   *Do not* download "Source code (zip)" or "Source code (tar.gz)" — those are source archives and will not load as a plugin.
3. In your vault, create the folder `.obsidian/plugins/tubesage/`.
4. Move the three downloaded files into that `tubesage/` folder.
5. In Obsidian, go to Settings → Community plugins, toggle off "Restricted mode" if needed, refresh the installed-plugins list, and enable **TubeSage**.
6. Accept the license terms in TubeSage's settings panel.
7. Configure API keys for your preferred LLM provider.
8. (For YouTube notes) Install the [Templater plugin](https://github.com/SilentVoid13/Templater) for template-driven formatting.

### Requirements
- [Obsidian](https://obsidian.md/) v1.2.0+
- [Templater plugin](https://github.com/SilentVoid13/Templater) (required for template functionality)
- An API key for at least one LLM provider:
  - OpenAI
  - Anthropic
  - Google (Gemini)
  - OpenRouter
  - Ollama (local models)
- A YouTube Data API key (optional — required only for channel/playlist processing)

## Features

- Transcript extraction from YouTube videos with fallback methods
- Summary generation using a configurable LLM provider
- Optional timestamp links added to section headings, linking to the moment in the video
- Works on desktop and mobile Obsidian
- Batch processing of YouTube channels and playlists
- Multi-provider support: OpenAI, Anthropic, Google Gemini, OpenRouter, and Ollama
- A cross-platform fetch shim so all providers work on mobile without Node.js dependencies

## Configuration

### 1. License acceptance
Accept the MIT license terms in the settings panel before using the plugin. Use the "View License" button to read the full text.

### 2. LLM provider setup
Choose and configure a provider in settings:

- **OpenAI** — models such as GPT-4o, GPT-4, GPT-3.5-Turbo.
- **Anthropic** — Claude 3 family models.
- **Google Gemini** — Gemini Pro models.
- **OpenRouter** — gateway access to models from multiple vendors.
- **Ollama** — local open-source models; runs offline, requires Ollama installed and running.

### 3. Other settings
- **Summary modes**: Fast (brief) or Extensive (detailed).
- **Timestamp processing**: enable or disable automatic timestamp links.
- **Batch processing**: sequential or parallel processing for collections.
- **Performance monitoring**: optional logging of processing times.

## Usage

### Basic workflow
1. Click the YouTube icon in the ribbon, or use the Command Palette.
2. Paste a YouTube video URL.
3. Choose a summary mode and folder location.
4. Run processing.
5. The resulting note appears in the chosen folder.

### Batch processing (channels/playlists)
1. Configure a YouTube Data API key in settings.
2. Paste a channel or playlist URL.
3. Set the number of videos to process.
4. Choose sequential or parallel processing.

### Timestamp navigation
When enabled, each section heading includes a link that opens the YouTube video at the corresponding moment.

## Technical Architecture

- **Main plugin** (`main.ts`): coordinator and UI.
- **Transcript extractor** (`src/youtube-transcript.ts`): multi-method extraction with mobile fallbacks.
- **LLM factory** (`src/llm/llm-factory.ts`): constructs the provider client.
- **Transcript summarizer** (`src/llm/transcript-summarizer.ts`): orchestrates summarization.
- **LangChain client** (`src/llm/langchain-client.ts`): unified interface for cloud providers.
- **Fetch shim** (`src/utils/fetch-shim.ts`): cross-platform HTTP via Obsidian's `requestUrl`.
- **Timestamp processor** (`src/utils/timestamp-utils.ts`): timestamp link generation.
- **Error utilities** (`src/utils/error-utils.ts`): error categorization and retry logic.

Architecture diagrams are in the `docs/` directory:
- [Workflow Diagram](docs/workflow-diagram.md)
- [Data Flow Diagram](docs/data-flow-diagram.md)

## Privacy & Security

- API calls to LLM providers and YouTube use HTTPS.
- No user data is stored on servers operated by the plugin author.
- Ollama can be used for fully local, offline processing.
- The plugin bundles `langsmith` as a transitive dependency of `@langchain/core`. `langsmith` is LangChain's optional tracing library and contains a background cache-refresh timer. TubeSage never enables LangSmith tracing and never sets a LangSmith API key, so this code stays dormant and performs no background network transmission. The only network requests TubeSage makes are to the LLM provider you configure and to YouTube.

## Troubleshooting

- **API key errors**: verify keys are configured correctly in settings.
- **Mobile processing issues**: ensure a stable connection, or use Ollama for offline processing.
- **Timestamp link failures**: check video availability and URL format.
- **Batch processing limits**: monitor YouTube API quota usage.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file. A YouTube content-usage disclaimer is included in [MIT-license-tubesage.md](MIT-license-tubesage.md).

## Support & Contribution

- **GitHub Issues**: bug reports and feature requests.
- **Code contributions**: fork the repository and open a pull request.

---

**GitHub Repository**: [https://github.com/rmccorkl/TubeSage](https://github.com/rmccorkl/TubeSage)
