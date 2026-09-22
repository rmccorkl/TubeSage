# TubeSage

TubeSage is an Obsidian plugin that converts YouTube videos into structured notes using large language models. It extracts transcripts, generates summaries, and can add timestamped links back to specific moments in the video.

**Demo** — click the image to watch the walkthrough video:

[![Watch the TubeSage walkthrough](https://raw.githubusercontent.com/rmccorkl/TubeSage/main/docs/TubeSage-poster.png)](https://github.com/user-attachments/assets/2b48c94f-d626-4e16-864e-f52c20de55d6)

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
- [Obsidian](https://obsidian.md/) v1.13.0+ (TubeSage uses the declarative settings API introduced in 1.13.0; it also stores cloud API keys using Obsidian's secret storage, available since 1.11.4)
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
- Recoverable jobs on mobile — interrupted processing can be resumed with the Show active jobs command

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

**Where API keys are stored:** cloud-provider keys (OpenAI, Anthropic, Google, OpenRouter) are saved in Obsidian's native secret storage, not in the plugin's `data.json`. Type a key into its provider field and it is written to the secret store automatically — there is no separate setting to enable this, and it is not optional. The Ollama field holds a server URL rather than a secret, so it remains in plugin data.

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

## Mobile: switching apps and job recovery

TubeSage keeps processing while Obsidian is in the foreground. If you switch to another app, the OS may suspend or terminate Obsidian, and there is no supported way for a plugin to keep JavaScript or network requests running through that — the host controls it, and its behavior is not documented for plugins. TubeSage does not promise execution through suspension.

A job lives and dies with the Obsidian instance that started it. If Obsidian closes or is killed while a job is running, that job is over: an AI summary that was in flight is lost (and may still have been billed), and you submit the video again. When Obsidian next starts you are told which jobs were interrupted; each one stays listed under **Show active jobs**, where you can open the note if one was created, or discard the record.

### How recovery works
Before each network or AI call, TubeSage records a small job entry: the video URL, target folder, title, current stage, timestamps, and attempt counts — never the transcript, the summary, or any API key. When Obsidian returns from the background (the same instance, still running), TubeSage checks these records and either continues automatically (only when that cannot re-bill you) or asks what to do.

Recovery is triggered two ways:
- automatically when the app becomes visible again (best effort — not guaranteed by the platform);
- manually, via the command **Show active jobs**.

Starting Obsidian does not resume anything: it closes the jobs the previous instance left unfinished and reports them.

### What you may be asked
If an AI request was in flight when the interruption happened, TubeSage cannot know whether the provider already charged for it, so **Resume** is labeled "may re-bill" and is never triggered automatically.

A job that is still running offers one action:
- **Cancel**

An interrupted job (same instance) offers:
- **Resume** (may re-bill)
- **Finish without timestamps** (when the note already exists)
- **Discard**

A job that died with a previous instance offers:
- **Open note** (when a note was created)
- **Discard**

Each stage is attempted at most 3 times.

If you have configured a transcript service key (ScrapeCreators or Supadata), re-fetching a transcript on resume may incur another charge — TubeSage asks before doing that too.

### Several devices
Jobs are tagged with the installation that started them: a per-device id kept in that device's local storage, not in the plugin's data file. Each device only lists, recovers and closes its own jobs. A job started on another device is ignored here — never listed, resumed, closed or discarded — it belongs to the device that started it. A record left by a version of TubeSage before this tagging cannot be matched to any device, so it is removed once on the next start instead.

### Behaviour changes on desktop
Single-video notes go through the same job pipeline on desktop, which changes two things from earlier versions:
- A successful note no longer has the "Debug Information" callout appended to it.
- A failed transcript no longer creates a placeholder note. The failed job is listed under **Show active jobs**; with debug logging on, an error note carrying the captured logs is written instead.

### Guarantees
- Recovery never overwrites a note you have edited: timestamp and translation writes are atomic and are skipped if the note changed.
- Recovery never creates a duplicate of a note it already created.
- Recovery never deletes notes — Discard only forgets the job record.

### Batch jobs
Playlists and channels (batch processing) are not yet covered by job recovery; they run as before.

### Known limitation
Automated tests and build checks pass for this feature. Interactive Obsidian desktop sessions and physical iOS/Android scenarios have not been exercised and remain unverified until someone actually runs them. If you hit an issue, please report device behavior (OS and version, Obsidian version, provider, and the stage at which it failed) on [GitHub issue #3](https://github.com/rmccorkl/TubeSage/issues/3).

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
- [Workflow Diagram](https://github.com/rmccorkl/TubeSage/blob/main/docs/workflow-diagram.md)
- [Data Flow Diagram](https://github.com/rmccorkl/TubeSage/blob/main/docs/data-flow-diagram.md)

## Privacy & Security

### API keys
Cloud-provider API keys (OpenAI, Anthropic, Google, OpenRouter) are stored in Obsidian's native secret storage, never written to the plugin's `data.json`. Keys saved by versions older than 1.3.0 are migrated into secret storage automatically the first time you open the plugin after upgrading.

### Network requests
All requests use HTTPS. TubeSage contacts:

- **YouTube**, to fetch video metadata and transcripts.
- **Your configured LLM provider** (OpenAI, Anthropic, Google, or OpenRouter), to generate summaries. If you use Ollama, requests go only to your local Ollama server and nothing leaves your machine.
- **ScrapeCreators** (`api.scrapecreators.com`) and **Supadata** (`api.supadata.ai`) — contacted only if you choose to configure an API key for one of them. These are optional paid transcript services used as alternatives or fallbacks to direct YouTube extraction; with no key set, neither is contacted.

That is the complete list. LangChain's bundled tiktoken helper, which would otherwise fetch tokenizer data from a third-party CDN, is replaced with a network-free stub at build time, so TubeSage contacts no other hosts.

No user data is stored on servers operated by the plugin author.

The plugin also bundles `langsmith` as a transitive dependency of `@langchain/core`. `langsmith` is LangChain's optional tracing library and contains a background cache-refresh timer. TubeSage never enables LangSmith tracing and never sets a LangSmith API key, so this code stays dormant and performs no background network transmission.

Static analysis of the bundled `main.js` shows a few `atob()`/`btoa()` (base64) calls. These all originate in bundled libraries, not in TubeSage's own code, and are all routine: decoding embedding vectors and image data URLs, reading a JWT header, and encoding Mermaid diagram syntax for rendering. None of them obscure code, API keys, or URLs.

### Vault and system access
- **Vault files**: TubeSage lists the folders and Markdown files in your vault so you can choose where notes are saved and pick template files. It reads and writes only the note and template files involved in processing.
- **Clipboard**: write-only. The "Copy template" button in the template viewer writes template text from within Obsidian to your system clipboard. TubeSage never reads the clipboard, so it cannot access or expose anything copied from outside Obsidian.

## Troubleshooting

- **API key errors**: verify keys are configured correctly in settings.
- **Mobile processing issues**: ensure a stable connection, or use Ollama for offline processing.
- **Timestamp link failures**: check video availability and URL format.
- **Batch processing limits**: monitor YouTube API quota usage.

## License

This project is licensed under the MIT License — see the [LICENSE](https://github.com/rmccorkl/TubeSage/blob/main/LICENSE) file. A YouTube content-usage disclaimer is included in [MIT-license-tubesage.md](https://github.com/rmccorkl/TubeSage/blob/main/MIT-license-tubesage.md).

## Support & Contribution

- **GitHub Issues**: bug reports and feature requests.
- **Code contributions**: fork the repository and open a pull request.

---

**GitHub Repository**: [https://github.com/rmccorkl/TubeSage](https://github.com/rmccorkl/TubeSage)
