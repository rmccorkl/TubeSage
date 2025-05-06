# Data Flow Diagram - TubeSage

This diagram describes the data flow throughout the TubeSage plugin for Obsidian.

```mermaid
%%{init: {
  'theme': 'dark',
  'themeVariables': {
    'fontSize': '16px',
    'primaryColor': '#7aa2f7',
    'primaryTextColor': '#ffffff',
    'primaryBorderColor': '#7aa2f7', 
    'lineColor': '#7aa2f7',
    'secondaryColor': '#bb9af7',
    'tertiaryColor': '#ff9e64'
  },
  'flowchart': {
    'curve': 'basis',
    'useMaxWidth': false,
    'htmlLabels': true,
    'rankSpacing': 80,
    'nodeSpacing': 60,
    'arrowSize': 1.5,
    'edgeLabelBackground': '#2d333b'
  }
}}%%
flowchart TD
    %% Main components
    YT[YouTube Website] --> |HTML response| TE[Transcript Extractor]
    TE --> |Transcript segments| TP[Transcript Processor]
    TP --> |Processed transcript| LS[LLM Summarizer]
    LS --> |Summary| TSP[Timestamp Processor]
    TSP --> |Enhanced Summary w/ Timestamps| OI[Obsidian Integration]
    
    %% Configurations and API Keys
    Config[Plugin Settings] --> |LLM configuration| LS
    Config --> |Timestamp settings| TSP
    APIKeys[API Keys] --> |Authentication| LS
    
    %% LLM Factory
    LF[LLM Factory] --> |Provides client| LS
    LS --> |Client request| LF
    
    %% LLM Clients
    LF --> OpenAI[OpenAI Client]
    LF --> Anthropic[Anthropic Client]
    LF --> Gemini[Gemini Client]
    LF --> Ollama[Ollama Client]
    LS --> |Uses| LC[LangChain Client]
    
    %% API Connections with Fetch Shim
    FetchShim[Fetch Shim] --> |Cross-platform requests| TE
    FetchShim --> |Cross-platform requests| OpenAI
    FetchShim --> |Cross-platform requests| Anthropic
    FetchShim --> |Cross-platform requests| Gemini
    FetchShim --> |Cross-platform requests| Ollama
    FetchShim --> |Cross-platform requests| YTAPI
    
    %% API Connections
    OpenAI --> |Request| OpenAI_API[OpenAI API]
    Anthropic --> |Request| Anthropic_API[Anthropic API]
    Gemini --> |Request| Gemini_API[Google Gemini API]
    Ollama --> |Request| Ollama_API[Ollama API]
    
    %% API Responses
    OpenAI_API --> |Response| OpenAI
    Anthropic_API --> |Response| Anthropic
    Gemini_API --> |Response| Gemini
    Ollama_API --> |Response| Ollama
    
    %% Templates
    Templates[Templater Templates] --> |Formatting| OI
    
    %% YouTube API for channel/playlist processing
    YTAPI[YouTube Data API] --> |Channel/Playlist data| YT_Processor[YouTube Processor]
    YT_Processor --> |Video URLs| TE
    
    %% Final output
    OI --> |Creates/Updates| Note[Obsidian Note]
    
    %% Performance Monitoring
    PMon[Performance Monitor] --> |Tracks| LS
    PMon --> |Tracks| TE
    PMon --> |Tracks| TSP
    PMon --> |Metrics| Config
    
    %% Smart Model Selection
    SMS[Smart Model Selection] --> |Recommends| LF
    TP --> |Transcript complexity| SMS
    Config --> |User preferences| SMS
    
    %% Error handling
    ErrorUtils[Error Utils] --> |Error handling| TE
    ErrorUtils --> |Error handling| LS
    ErrorUtils --> |Error recovery| TSP
    ErrorUtils --> |Error recovery| FetchShim
    
    %% Subgraph for Transcript Extractor
    subgraph Transcript_Extraction
        TE --> |Parse HTML| YTR[YouTube Response]
        YTR --> |Extract| Tracks[Caption Tracks]
        Tracks --> |Select best| BestTrack[Best Track]
        BestTrack --> |Fetch| JSON[Captions JSON/XML]
        JSON --> |Parse| Events[Transcript Events]
        Events --> |Convert| Segments[Transcript Segments]
        
        %% Mobile fallback path
        TE --> |Mobile fallback| AltExtract[Alternative Extraction]
        AltExtract --> |XML parsing| XMLParse[Parse XML Captions]
        XMLParse --> Segments
    end
    
    %% Subgraph for LLM Processing
    subgraph LLM_Processing
        LS --> |Creates| Prompt[LLM Prompt]
        Prompt --> |System message| System[System Prompt]
        Prompt --> |User message| User[User Prompt]
        Prompt --> |Transcript| Content[Transcript Content]
        Prompt --> |Reference material| RefMat[Reference Material Section]
        
        %% Mode selection
        SummaryMode[Summary Mode] --> |Fast or Extensive| Prompt
        SummaryMode --> |Configures| TokenLimit[Token Limit]
    end
    
    %% Subgraph for Timestamp Processing
    subgraph Timestamp_Processing
        TSP --> |Extract| DocComponents[Document Components]
        DocComponents --> |Frontmatter| FrontMatter[Extract Frontmatter]
        DocComponents --> |Content| ContentChunks[Create Content Chunks]
        ContentChunks --> |Optimized chunks| EnhanceChunks[Enhance with Timestamps]
        EnhanceChunks --> |Timestamp LLM pass| AddLinks[Add Timestamp Links]
        AddLinks --> |Validate| ValidateLinks[Validate Timestamp Links]
        ValidateLinks --> |Reconstruct| ReconstructDoc[Reconstruct Document]
        
        %% Enhanced chunk processing
        ContentChunks --> |Size optimization| ChunkSize[Optimize Chunk Size]
        ChunkSize --> |Boundary detection| ChunkBoundary[Detect Chunk Boundaries]
        ChunkBoundary --> EnhanceChunks
    end
    
    %% Batch Processing
    subgraph Batch_Processing
        YT_Processor --> |Batch config| BatchConfig[Batch Configuration]
        BatchConfig --> |Sequential| SeqProcess[Sequential Processing]
        BatchConfig --> |Parallel| ParProcess[Parallel Processing]
        ParProcess --> |Throttling| ThrottleControl[Throttle Control]
        
        ThrottleControl --> |Quota management| QuotaManager[API Quota Manager]
        SeqProcess --> |Progress tracking| ProgressTracker[Progress Tracker]
        ParProcess --> |Progress tracking| ProgressTracker
    end
    
    %% Styling for specific node types
    style YT fill:#ff9e64,stroke:#ff9e64,color:white,stroke-width:2px
    style OpenAI_API fill:#f7768e,stroke:#f7768e,color:white,stroke-width:2px
    style Anthropic_API fill:#f7768e,stroke:#f7768e,color:white,stroke-width:2px
    style Gemini_API fill:#f7768e,stroke:#f7768e,color:white,stroke-width:2px
    style Ollama_API fill:#f7768e,stroke:#f7768e,color:white,stroke-width:2px
    style YTAPI fill:#f7768e,stroke:#f7768e,color:white,stroke-width:2px
    style LF fill:#73daca,stroke:#73daca,color:#1a1b26,stroke-width:2px
    style FetchShim fill:#73daca,stroke:#73daca,color:#1a1b26,stroke-width:2px
    style PMon fill:#73daca,stroke:#73daca,color:#1a1b26,stroke-width:2px
    style ErrorUtils fill:#73daca,stroke:#73daca,color:#1a1b26,stroke-width:2px
    style SMS fill:#73daca,stroke:#73daca,color:#1a1b26,stroke-width:2px
    style TE fill:#7aa2f7,stroke:#7aa2f7,color:white,stroke-width:2px
    style TP fill:#7aa2f7,stroke:#7aa2f7,color:white,stroke-width:2px
    style LS fill:#7aa2f7,stroke:#7aa2f7,color:white,stroke-width:2px
    style TSP fill:#7aa2f7,stroke:#7aa2f7,color:white,stroke-width:2px
    style OI fill:#7aa2f7,stroke:#7aa2f7,color:white,stroke-width:2px
    style YT_Processor fill:#7aa2f7,stroke:#7aa2f7,color:white,stroke-width:2px
    style Note fill:#9ece6a,stroke:#9ece6a,color:#1a1b26,stroke-width:2px
    style OpenAI fill:#bb9af7,stroke:#bb9af7,color:white,stroke-width:2px
    style Anthropic fill:#bb9af7,stroke:#bb9af7,color:white,stroke-width:2px
    style Gemini fill:#bb9af7,stroke:#bb9af7,color:white,stroke-width:2px
    style Ollama fill:#bb9af7,stroke:#bb9af7,color:white,stroke-width:2px
    style LC fill:#bb9af7,stroke:#bb9af7,color:white,stroke-width:2px
    style Transcript_Extraction fill:#414868,stroke:#7aa2f7,color:white,stroke-width:2px
    style LLM_Processing fill:#414868,stroke:#bb9af7,color:white,stroke-width:2px
    style Timestamp_Processing fill:#414868,stroke:#ff9e64,color:white,stroke-width:2px
    style Batch_Processing fill:#414868,stroke:#f7768e,color:white,stroke-width:2px
```

## Component Descriptions

### Main Components
- **YouTube Website**: Source of video data and transcript information
- **Fetch Shim**: Platform-aware HTTP client for cross-platform compatibility, serving as a unified interface for all network requests
- **Transcript Extractor**: Extracts transcript segments from YouTube videos with enhanced mobile device support and fallback mechanisms
- **Transcript Processor**: Processes raw transcript segments into usable text, analyzing complexity for smart model selection
- **LLM Factory**: Creates and manages different LLM clients through a factory pattern design
- **LLM Summarizer**: Coordinates summarization across different LLM providers with LangChain integration
- **Timestamp Processor**: Adds and validates YouTube timestamp links with improved chunk boundary optimization
- **Performance Monitor**: Comprehensive tracking system for monitoring processing times across all components
- **Error Utils**: Enhanced error recovery system with smart retry and fallback mechanisms
- **Obsidian Integration**: Handles integration with Obsidian notes and templates
- **Smart Model Selection**: New component that analyzes transcript complexity and recommends optimal LLM models

### LLM Clients
- **OpenAI Client**: Interface for OpenAI API (GPT-4, GPT-4o, GPT-3.5, etc.)
- **Anthropic Client**: Interface for Anthropic API (Claude 3 family models)
- **Gemini Client**: Interface for Google's Gemini API
- **Ollama Client**: Interface for local Ollama models
- **LangChain Client**: Unified interface for multiple providers using LangChain with custom fetcher

### External APIs
- **OpenAI API**: OpenAI's cloud API service
- **Anthropic API**: Anthropic's cloud API service
- **Google Gemini API**: Google's AI API service
- **Ollama API**: Local API for running models
- **YouTube Data API**: Google's API for accessing channel and playlist data

### Data Paths
1. **YouTube to Note Creation**:
   - YouTube video HTML → Extract transcript → Process transcript → Summarize with LLM → Add timestamp links → Format with templates → Create/update Obsidian note

2. **Transcript Extraction**:
   - Regular path: HTML parsing → Track selection → JSON fetching → Segment extraction
   - Mobile fallback: Alternative extraction → XML parsing → Segment creation

3. **LLM Processing**:
   - Smart model selection based on transcript complexity and user preferences
   - LLM Factory creates appropriate client
   - Format prompt with system instructions, user prompt, transcript, and reference material
   - Send to selected LLM provider via LangChain or direct API
   - Process response into initial summary
   
4. **Timestamp Processing**:
   - Extract document components (frontmatter, content)
   - Create optimized content chunks with improved boundary detection
   - Enhance chunks with timestamp links
   - Validate links and reconstruct document
   
5. **Cross-Platform Compatibility**:
   - Unified Fetch Shim provides platform-specific HTTP requests for all API communication
   - Mobile-specific extraction fallbacks for device compatibility
   - Enhanced error recovery for platform-specific issues
   
6. **Performance Monitoring**:
   - Track processing times for each component
   - Identify bottlenecks in the pipeline
   - Report metrics for optimization
   - Suggest performance improvements based on collected metrics

7. **Batch Processing**:
   - Sequential or parallel processing of multiple videos
   - Throttling controls to manage API rate limits
   - Progress tracking for better user experience
   - API quota management for YouTube Data API