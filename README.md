# TubeSage: YouTube Transcript AI for Obsidian

TubeSage is a powerful Obsidian plugin that transforms YouTube videos into comprehensive, structured notes using cutting-edge large language models (LLMs). Extract transcripts, generate intelligent summaries, and create timestamped notes that link directly back to specific moments in videos—perfect for researchers, students, and lifelong learners building knowledge in Obsidian.

## 🚀 Quick Start

### Installation
1. Download the latest release from GitHub
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins` folder
3. Enable the plugin in Obsidian's Community Plugins settings
4. Accept the license terms in the plugin settings
5. Configure your API keys for your preferred LLM provider
6. Install the [Templater plugin](https://github.com/SilentVoid13/Templater) for enhanced note formatting

### Requirements
- [Obsidian](https://obsidian.md/) v1.2.0+
- [Templater plugin](https://github.com/SilentVoid13/Templater) (required for template functionality)
- API key for at least one LLM provider:
  - OpenAI (GPT-4, GPT-4o, etc.)
  - Anthropic (Claude 3 family)
  - Google (Gemini Pro)
  - Ollama (local models - free)
- YouTube Data API key (optional - required only for channel/playlist processing)

## ✨ Key Features

### 🎯 Core Functionality
- **Smart Transcript Extraction**: Advanced extraction from YouTube videos with multiple fallback methods
- **AI-Powered Summarization**: Generate structured summaries using state-of-the-art LLMs
- **Intelligent Timestamp Links**: Automatically add clickable links to video timestamps in section headings
- **Cross-Platform Compatibility**: Works seamlessly on desktop and mobile Obsidian
- **Batch Processing**: Process entire YouTube channels and playlists efficiently

### 🤖 Advanced LLM Integration
- **Multi-Provider Support**: OpenAI, Anthropic, Google Gemini, and Ollama
- **Smart Model Selection**: Automatically recommend optimal models based on content complexity
- **LangChain Integration**: Unified interface across all cloud providers
- **Custom Fetch Shim**: Cross-platform networking that works on mobile without Node.js dependencies
- **Performance Monitoring**: Real-time tracking of processing times and bottlenecks

### 📱 Mobile-First Design
- **Mobile Optimized**: Full functionality on iOS and Android
- **Adaptive Processing**: Smart adjustments for mobile platform limitations
- **Enhanced Error Recovery**: Robust fallback systems for mobile network conditions
- **Platform Detection**: Automatic optimization based on device capabilities

### ⚡ Performance & Reliability
- **Smart Recovery System**: Intelligent error handling with automatic retries
- **Optimized Chunking**: Efficient content processing for large transcripts
- **API Quota Management**: Intelligent handling of rate limits and quotas
- **Performance Metrics**: Detailed analytics for optimization suggestions

## 🔧 Configuration

### 1. License Acceptance
- Accept the MIT license terms before using the plugin
- View license details using the "View License" button
- Required for plugin activation

### 2. LLM Provider Setup
Choose and configure your preferred LLM provider:

#### OpenAI
- **Best for**: General-purpose summaries, structured content
- **Models**: GPT-4o (recommended), GPT-4, GPT-3.5-Turbo
- **Strengths**: Consistent formatting, excellent instruction following

#### Anthropic
- **Best for**: Nuanced analysis, complex topics, longer content
- **Models**: Claude 3 Opus (highest quality), Claude 3 Haiku (speed)
- **Strengths**: Deep understanding, contextual awareness

#### Google Gemini
- **Best for**: Factual summaries, technical content
- **Models**: Gemini Pro
- **Strengths**: Strong with data analysis, balanced performance

#### Ollama (Local)
- **Best for**: Privacy-focused users, offline processing
- **Models**: Various open-source models (Llama, Mistral, etc.)
- **Strengths**: Complete privacy, no API costs, works offline
- **Requirements**: Ollama installed and running locally

### 3. Advanced Settings
- **Summary Modes**: Fast (brief) vs. Extensive (detailed)
- **Timestamp Processing**: Enable/disable automatic timestamp link generation
- **Performance Monitoring**: Track and optimize processing performance
- **Batch Processing**: Configure sequential vs. parallel processing for collections
- **Mobile Optimization**: Adaptive settings for mobile devices

## 📋 Usage Guide

### Basic Workflow
1. **Access Plugin**: Click the YouTube icon in the ribbon or use Command Palette
2. **Enter Video URL**: Paste any YouTube video URL
3. **Configure Options**: Choose summary mode and folder location
4. **Process**: Click "Process Video" and wait for completion
5. **Review**: Your structured note will appear in the specified folder

### Batch Processing (Channels/Playlists)
1. **Setup YouTube API**: Configure YouTube Data API key in settings
2. **Enter Collection URL**: Paste channel or playlist URL
3. **Set Limits**: Choose number of videos to process
4. **Configure Processing**: Select sequential or parallel processing
5. **Monitor Progress**: Real-time updates on processing status

### Timestamp Navigation
- Each section heading includes a "[Watch]" link
- Links jump to the exact moment in the YouTube video
- Perfect for reviewing specific topics or taking detailed notes

## 🏗 Technical Architecture

TubeSage features a modern, modular architecture designed for scalability and cross-platform compatibility:

### Core Components
- **Main Plugin** (`main.ts`): Central coordinator and UI management
- **Transcript Extractor** (`src/youtube-transcript.ts`): Multi-method extraction with mobile fallbacks
- **LLM Factory** (`src/llm/llm-factory.ts`): Factory pattern for managing LLM clients
- **Transcript Summarizer** (`src/llm/transcript-summarizer.ts`): Orchestrates AI summarization
- **Timestamp Processor** (`src/utils/timestamp-utils.ts`): Intelligent timestamp link generation

### LLM Integration Layer
- **LangChain Client** (`src/llm/langchain-client.ts`): Unified interface for cloud providers
- **Provider-Specific Clients**: Optimized implementations for each LLM provider
- **Custom Fetch Shim** (`src/utils/fetch-shim.ts`): Cross-platform HTTP handling

### Utility Systems
- **Smart Recovery** (`src/utils/error-utils.ts`): Advanced error handling and retry logic
- **Performance Monitor** (`src/utils/logger.ts`): Comprehensive metrics and optimization
- **YouTube Integration** (`src/utils/youtube-utils.ts`): Video metadata and batch processing
- **Cross-Platform Utils**: Mobile-aware path handling, form validation, and more

### Architecture Diagrams
Comprehensive diagrams are available in the `/docs` directory:
- **[Workflow Diagram](docs/workflow-diagram.md)**: Complete user and system workflow
- **[Data Flow Diagram](docs/data-flow-diagram.md)**: Data movement through the system

## 🎯 Use Cases

### 📚 Academic Research
- Convert lecture videos into structured notes
- Extract key concepts with timestamp references
- Build interconnected knowledge graphs in Obsidian

### 💼 Professional Development
- Process conference talks and webinars
- Create searchable technical documentation
- Build training material libraries

### 🎓 Learning & Education
- Transform educational content into study guides
- Create timestamped reference materials
- Build comprehensive course notes

### 📖 Content Creation
- Research and outline video content
- Extract quotes and references with citations
- Build content libraries for writing projects

## 🔄 Recent Updates (v1.0.6)

### Enhanced Cross-Platform Support
- **Unified Fetch Implementation**: All LLM providers now work seamlessly on mobile
- **Improved Mobile Processing**: Better handling of iOS/Android limitations
- **Enhanced Error Recovery**: Smarter retry mechanisms for failed operations

### Performance & Reliability
- **Smart Model Selection**: AI-driven recommendations based on content complexity
- **Advanced Performance Monitoring**: Real-time metrics and optimization suggestions
- **Optimized Batch Processing**: Improved handling of channels and playlists
- **Better API Quota Management**: Intelligent rate limiting and quota tracking

### User Experience Improvements
- **Enhanced Error Messages**: More helpful diagnostics and solution suggestions
- **Improved Validation**: Better input validation with helpful feedback
- **Streamlined Configuration**: Simplified setup process for new users
- **Better Mobile UI**: Optimized interface for mobile Obsidian

## 🔐 Privacy & Security

TubeSage is designed with privacy in mind:
- **Local Processing**: Transcripts are processed locally when possible
- **Secure API Communication**: All external API calls use HTTPS
- **No Data Storage**: No user data is stored on external servers
- **Ollama Support**: Complete offline processing with local models
- **Open Source**: Full transparency with open-source codebase

## 🎨 Recommended Setup

### Obsidian Plugins
- **Templater**: Essential for note formatting (required)
- **Iconize**: Enhanced note organization with custom icons
- **Icon Shortcodes**: Support for icon shortcodes in notes

### Obsidian Settings
- Disable "Show inline title" for cleaner note appearance
- Disable "Properties view" for better performance with large notes
- Enable "Use tabs" for better navigation of multiple notes

## 🆘 Troubleshooting

### Common Issues
- **API Key Errors**: Verify API keys are correctly configured in settings
- **Mobile Processing Issues**: Ensure stable internet connection, consider using Ollama for offline processing
- **Timestamp Link Failures**: Check video availability and URL format
- **Batch Processing Limits**: Monitor YouTube API quota usage

### Performance Optimization
- Use appropriate LLM models for content length
- Enable performance monitoring to identify bottlenecks
- Consider local Ollama models for frequent processing
- Adjust chunk sizes for very long videos

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](MIT-license-tubesage.md) file for details.

## 🤝 Support & Contribution

### Getting Help
- **GitHub Issues**: Report bugs and request features
- **Documentation**: Comprehensive guides in the `/docs` directory
- **Community**: Share tips and tricks with other users

### Support Development
If TubeSage enhances your learning and research workflow, consider supporting its development:
- ⭐ Star the repository on GitHub
- 🐛 Report bugs and suggest improvements
- ☕ [Buy me a coffee](https://www.buymeacoffee.com/RMcCorkle)

### Contribution Policy
- **Issues Welcome**: Bug reports and feature requests are encouraged
- **Code Contributions**: Please fork the repository for code changes
- **Documentation**: Help improve guides and examples

---

**GitHub Repository**: [https://github.com/rmccorkl/TubeSage](https://github.com/rmccorkl/TubeSage)

Transform your YouTube learning experience with TubeSage - where video content becomes structured knowledge.