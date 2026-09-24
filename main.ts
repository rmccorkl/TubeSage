import { App, Plugin, PluginSettingTab, Modal, SettingDefinitionItem, Notice, Platform, DropdownComponent, TextComponent, ExtraButtonComponent, ButtonComponent, TFile, ToggleComponent, addIcon, removeIcon, setTooltip, setIcon, getLanguage, normalizePath as obsidianNormalizePath } from 'obsidian';
import { setLanguageResolver, t } from './src/i18n';
import { loadRuntimeLocale } from './src/i18n/locale-loader';
import { YouTubeTranscriptExtractor, TranscriptSegment } from './src/youtube-transcript';
import { TranscriptSummarizer } from './src/llm/transcript-summarizer';
import { sanitizeFilename } from './src/utils/filename-sanitizer';
import { handleApiError, getSafeErrorMessage } from './src/utils/error-utils';
import { getLogger, LogLevel, setGlobalLogLevel, clearLogs, getLogsForCallout } from './src/utils/logger';
import { normalizePath, ensureFolder, joinPaths, sanitizePathComponent, collectUnder } from './src/utils/path-utils';
import { validateRequired, validateYouTubeUrl, ValidationResult, displayValidationResult } from './src/utils/form-utils';
import { getPromptConfig, cleanTranscript, SummaryMode, getTimestampLinkConfig } from './src/utils/prompt-utils';
import { showNotice, isYoutubeUrl, isYoutubeChannelOrPlaylistUrl, extractChannelName, YOUTUBE_URL_PLACEHOLDER } from './src/utils/youtube-utils';
import { obsidianFetch } from './src/utils/fetch-shim';
import { 
    extractDocumentComponents, 
    reconstructDocument, 
    validateEnhancedContent, 
    createOptimizedChunks,
    countTimestampLinks,
    ensureTrailingNewline,
    hasProperHeading,
    hasTimestampLinks,
    convertTimestampToSeconds,
    convertTimeIndexToWatchUrls
} from './src/utils/timestamp-utils';
import type { Provider } from './src/utils/model-limits-registry';
import { getEffectiveLimits, isModelSupported, upsertModel } from './src/utils/model-limits-registry';
import { effectiveTitle, formatDatePrefix } from './src/jobs/job-record';
import type { NotePathSettings, NoteJobRecord } from './src/jobs/job-record';
import { JobStore, hydrate } from './src/jobs/job-store';
import { JobRunner, NoteChangedError, isTerminal } from './src/jobs/job-runner';
import type { JobEvent, SubmitInput, SubmitResult } from './src/jobs/job-runner';
import { CollectionNotices } from './src/runtime/collection-notice';
import { CollectionRunner } from './src/runtime/collection-runner';
import { aggregateProgress } from './src/jobs/collection-record';
import type { CollectionVideo } from './src/jobs/collection-record';
import { writeIfUnchanged } from './src/runtime/guarded-write';
import { createRunnerDeps, generateOpaqueId } from './src/runtime/job-adapters';
import type { RenderedNote, VaultLike } from './src/runtime/job-adapters';
import { settingsForPersist } from './src/runtime/settings-persist';
import { DEFAULT_SETTINGS } from './src/settings/settings-defaults';
import { buildSettingDefinitions, readSettingValue, writeSettingValue } from './src/settings/setting-definitions';
import type { FetchedModelInfo, SettingsHost } from './src/settings/setting-definitions';
import type { YouTubeTranscriptSettings } from './src/settings/settings-defaults';
import { timestampPassFailure } from './src/runtime/timestamp-pass-policy';
import type { TimestampPassOptions } from './src/runtime/timestamp-pass-policy';
import { buildRecoveryRow, coldStartNoticeText, doneNoticeText, formatJobAge, recoveryNoticeText, shouldOpenRecoveryModal } from './src/runtime/recovery-ui-model';
import { JobProgressNotices } from './src/runtime/job-progress-notice';
import type { RecoveryAction, RecoveryRowModel, RecoveryTrigger } from './src/runtime/recovery-ui-model';

// Initialize logger here
const logger = getLogger('PLUGIN');
const transcriptLogger = getLogger('TRANSCRIPT');
const llmLogger = getLogger('LLM');
const i18nLogger = getLogger('I18N');

// Per-vault localStorage key for this installation's id (spec I3). Vault-scoped
// and device-local by construction (App.loadLocalStorage/saveLocalStorage,
// public since 1.8.7): the device's own id is never a data.json setting, so a
// synced data.json cannot make two devices share one id. Job records carry the
// id of the installation that created (or took over) them, which is how a cold
// start tells its own dead runs from another device's possibly-live ones.
const INSTALLATION_ID_STORAGE_KEY = 'tubesage-installation-id';

// Messages carried by NoteChangedError from the guarded note writes (F5). The
// legacy catch (timestampError) handlers show them verbatim (the translation
// pass runs AFTER the timestamps were written, so a fixed "timestamps could
// not be added" prefix would be wrong there).
const NOTE_EDITED_DURING_TIMESTAMPS = 'The note was edited while timestamps were being added, so the timestamps were not applied';
const NOTE_EDITED_DURING_TRANSLATION = 'The note was edited while it was being translated, so the translation was not applied';

const TUBESAGE_RIBBON_ICON_ID = 'tubesage-video-sage';
const TUBESAGE_RIBBON_ICON_SVG = `
    <rect x="7" y="18" width="86" height="64" rx="15" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M35 35 C49 37 63 44 72 50 C63 59 49 66 35 68 C39 57 39 46 35 35 Z" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M39 52 H67" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
`;

function truncateForLogs(text: string, maxLength: number = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...[truncated]';
}

// Define a minimal folder item interface
interface FolderItem {
    path: string;
    name: string;
}

// Recovery entry points (spec §6). The visibility edge is best effort and
// debounced so a burst of app-switch events runs one pass, not several.
const VISIBILITY_RECOVERY_DEBOUNCE_MS = 2000;
// How many finished jobs the recovery modal keeps listing for status visibility.
const RECENT_TERMINAL_JOBS_SHOWN = 5;

/** One row of the recovery modal: the pure UI model plus the epoch its age is computed from. */
interface RecoveryRowEntry {
    row: RecoveryRowModel;
    updatedAt: number;
}

type JobEventListener = (event: JobEvent) => void;

interface Closeable {
    close: () => void;
}

type TranscriptInputSegment = TranscriptSegment & {
    tStartMs?: string;
    segs?: Array<{ utf8?: string }>;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null;

type AppWithPlugins = App & {
    plugins?: {
        plugins?: Record<string, unknown>;
        manifest?: Record<string, { id?: string }>;
    };
};

type TemplaterContext = {
    user?: Record<string, unknown>;
};

type TemplaterApi = {
    current_functions_object?: unknown;
    create_running_config: (templateFile: TFile, targetFile: TFile, mode: number) => unknown;
    functions_generator: {
        generate_object: (config: unknown) => Promise<TemplaterContext>;
    };
    parser: {
        parse_commands: (content: string, ctx: TemplaterContext) => Promise<string>;
    };
};

type TemplaterSettings = {
    templates_folder?: string;
};

type TemplaterPlugin = {
    templater: TemplaterApi;
    settings?: TemplaterSettings;
};

const getPluginRegistry = (app: App): Record<string, unknown> | null => {
    const plugins = (app as AppWithPlugins).plugins?.plugins;
    if (!plugins || typeof plugins !== 'object') {
        return null;
    }
    return plugins;
};

const getTemplaterPlugin = (app: App): TemplaterPlugin | null => {
    const registry = getPluginRegistry(app);
    const candidate = registry?.['templater-obsidian'];
    if (!isRecord(candidate)) {
        return null;
    }
    const templater = candidate['templater'];
    if (!isRecord(templater)) {
        return null;
    }
    return candidate as TemplaterPlugin;
};

const getTemplaterSettings = (app: App): TemplaterSettings | null => {
    const registry = getPluginRegistry(app);
    const candidate = registry?.['templater-obsidian'];
    if (!isRecord(candidate)) {
        return null;
    }
    const settings = candidate['settings'];
    if (!isRecord(settings)) {
        return null;
    }
    return settings;
};

const getPluginIdFromManifest = (app: App, fallback: string): string => {
    const manifest = (app as AppWithPlugins).plugins?.manifest;
    if (!manifest || typeof manifest !== 'object') {
        return fallback;
    }
    const entry = manifest[fallback];
    if (!isRecord(entry)) {
        return fallback;
    }
    const id = entry['id'];
    return typeof id === 'string' && id.trim() ? id : fallback;
};

interface YouTubePlaylistItem {
    snippet?: {
        title?: string;
        resourceId?: {
            videoId?: string;
        };
    };
}

interface PlaylistItemsResponse {
    items?: YouTubePlaylistItem[];
    nextPageToken?: string;
}

interface PlaylistResponse {
    items?: Array<{
        snippet?: {
            title?: string;
        };
    }>;
}

interface ChannelResponse {
    items?: Array<{
        snippet?: {
            title?: string;
        };
        contentDetails?: {
            relatedPlaylists?: {
                uploads?: string;
            };
        };
    }>;
}

interface ChannelIdResponse {
    items?: Array<{
        id?: string;
    }>;
}

// Cloud LLM providers whose API keys are secrets stored in Obsidian's
// secret storage. 'ollama' is intentionally excluded — its apiKeys entry
// is a server URL, not a secret, and stays in data.json.
const CLOUD_PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter'] as const;

// Secret-storage IDs, one per cloud provider. IDs must be lowercase
// alphanumeric with optional dashes (required by SecretStorage.setSecret).
const SECRET_IDS: Record<string, string> = {
    openai: 'tubesage-openai-key',
    anthropic: 'tubesage-anthropic-key',
    google: 'tubesage-google-key',
    openrouter: 'tubesage-openrouter-key',
};

// Define a simple interface for the model object from OpenAI API
interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
    // Add other relevant properties if needed in the future
}

// Define a simple interface for the model object from Google Generative AI API
interface GoogleModel {
    name: string; // e.g., "models/gemini-1.5-pro-latest"
    displayName?: string;
    version?: string;
    description?: string;
    supportedGenerationMethods?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
}

interface ApiErrorResponse {
    error?: {
        message?: string;
    };
    message?: string;
}

interface OpenAIModelsResponse {
    data?: OpenAIModel[];
}

interface GoogleModelsResponse {
    models?: GoogleModel[];
}

export default class YouTubeTranscriptPlugin extends Plugin {
    settings: YouTubeTranscriptSettings;
    private summarizer: TranscriptSummarizer;
    private fileWatcher: Closeable | null = null;
    // Owns every data.json write (settings AND job records) through one
    // serialized writer; constructed in loadSettings() before any persist().
    private jobStore: JobStore;
    // The single-video modal submits to it; the recovery modal, the
    // `show-active-jobs` command and the three recovery entry points
    // (cold start, visibility edge, manual) act on it.
    jobRunner: JobRunner;
    // Jobs submitted by THIS process: only these may auto-open their note on
    // `done` (spec §5 F5 — recovered jobs never do).
    private readonly sessionJobIds = new Set<string>();
    // Fan-out of runner events to UI subscribers (the recovery modal).
    private readonly jobEventListeners = new Set<JobEventListener>();
    // The single progress surface for single-video jobs, on both platforms
    // (#7): one floating notice per job, created on its first `progress`
    // event and hidden on its terminal one. The submitting modal closes as
    // soon as the job starts, so the plugin owns these exactly as it owned
    // the status-bar spinners they replace.
    private readonly progressNotices = new JobProgressNotices(
        (message) => new Notice(message, 0)
    );
    // A channel/playlist gets ONE notice for the whole run (#9), not one per
    // video: `JobProgressNotices` keys by job id, so a 40-video playlist would
    // otherwise stack 40 notices. While a run is live it owns its children's
    // ids and their individual notices are suppressed.
    private readonly collectionNotices = new CollectionNotices(
        (message) => new Notice(message, 0),
        (progress, parent) => t('notice.collection.progress', {
            name: parent.sourceName,
            done: progress.done,
            total: progress.total,
        })
    );
    // Public for the same reason `jobRunner` is: the create-note modal hands a
    // channel/playlist to it once the folder is chosen.
    collectionRunner: CollectionRunner | null = null;
    // Cold start (onLayoutReady) must be the FIRST recovery pass; until it
    // has run, visibility edges are ignored.
    private layoutReady = false;
    private visibilityRecoveryTimer: number | null = null;
    private recoveryModal: JobRecoveryModal | null = null;

    // Replace the duplicated showNotice method with a wrapper that calls the shared utility
    showNotice(message: string, timeout: number = 5000): void {
        showNotice(message, timeout);
    }

    // Get plugin version from manifest
    getVersion(): string {
        return this.manifest.version || 'Unknown';
    }

    async onload() {
        // TubeSage's interface language follows Obsidian's own: getLanguage()
        // reports Settings -> General -> Language. There is no plugin language
        // setting, and the code is read on every lookup rather than cached,
        // because the 1.13 API carries no language-change event to react to.
        // (translateLanguage / translateCountry in the settings are a different
        // feature: the language the generated NOTE is written in.)
        setLanguageResolver(() => getLanguage());

        // Every locale is bundled, because Obsidian's installer downloads only
        // main.js, manifest.json and styles.css from a release — so a shipped
        // locale FILE would reach nobody who installed from the catalogue.
        // This call is the OVERRIDE path: a <code>.json dropped into the
        // plugin folder by hand wins over the bundled table for that language.
        // AWAITED ON PURPOSE — `addSettingTab` below only registers the tab;
        // the tab is built when the user opens Settings, which is necessarily
        // after `onload` resolves, so awaiting one small JSON read means an
        // override is in force before anything renders.
        // `loadRuntimeLocale` never rejects and never outlives its own
        // timeout, so a missing, unreadable, malformed or slow override file —
        // or a `manifest.dir` Obsidian did not set — costs the bundled
        // translation, not a stalled load. No override present is the normal
        // case and is silent; it speaks at most one line, once, per load.
        await loadRuntimeLocale(getLanguage(), {
            dir: this.manifest.dir,
            read: (path: string) => this.app.vault.adapter.read(path),
            normalizePath: (path: string) => obsidianNormalizePath(path),
            setTimer: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
            clearTimer: (handle: unknown) => window.clearTimeout(handle as number),
            log: (message: string) => i18nLogger.warn(message),
        });

        // loadSettings() must run first: it hydrates the job records out of
        // data.json and builds the serialized store that every later
        // persist() — including the legacy maxTokens migration write just
        // below — goes through. Writing before that would drop `_jobs`.
        await this.loadSettings();

        this.jobRunner = new JobRunner(
            createRunnerDeps(this, this.jobStore, (event) => this.onJobEvent(event), {
                vault: this.runnerVault(),
                // Obsidian's normalizePath (NFC, NBSP, slashes): the ONE normalizer
                // every stored or compared note path goes through, the same one
                // renderNoteContent applies to the rendered path.
                normalizePath: (path) => obsidianNormalizePath(path),
                installationId: () => this.installationId(),
            })
        );

        // Collections run ON the job runner: each video is submitted through
        // the same `submit()` a single video uses, so a child is not merely
        // shaped like an ordinary job — it is one, duplicate detection and all.
        this.collectionRunner = new CollectionRunner({
            generateId: () => generateOpaqueId(),
            now: () => Date.now(),
            installationId: () => this.installationId(),
            submitChild: async (video: CollectionVideo, folder: string) => {
                const result = await this.submitJob({
                    url: video.url,
                    videoId: video.videoId,
                    folder,
                    customTitle: '',
                    useFastSummary: this.settings.useFastSummary,
                    addTimestampLinks: this.settings.addTimestampLinks,
                });
                // `recovery` hands back a record rather than a bare id: the
                // video already has a job, which is the duplicate case this
                // path exists to inherit rather than re-implement.
                if (result.kind === 'started' || result.kind === 'already-running') return result.id;
                if (result.kind === 'recovery') return result.record.id;
                return undefined;
            },
            cancelChild: (id: string) => this.jobRunner.cancel(id),
            isActive: (id: string) => this.jobRunner.isActive(id),
            getChild: (id: string) => this.jobStore.get(id),
            saveCollection: (record) => this.jobStore.upsertCollection(record, Date.now()),
            listCollections: () => this.jobStore.listCollections(),
            notices: this.collectionNotices,
        });

        // Recovery entry points (spec §6). Cold start FIRST: onLayoutReady runs
        // the pass that closes every job the previous process left unfinished
        // (a job dies with its instance); `layoutReady` gates the visibility
        // edge until then.
        this.app.workspace.onLayoutReady(() => {
            void this.recoverJobs('startup');
        });
        this.registerDomEvent(activeDocument, 'visibilitychange', () => {
            if (activeDocument.visibilityState === 'visible') {
                this.scheduleVisibilityRecovery();
            }
        });
        this.addCommand({
            id: 'show-active-jobs',
            // Localised, and the three shipped rows that QUOTE it were
            // retranslated in the same commit so that each locale's sentence
            // names the command that locale's palette actually lists
            // (notice.progress.message, notice.job.interrupted,
            // notice.job.saveFailed, plus the two recovery-dialog rows that
            // used to hardcode it). `QUOTED_LABELS` in scripts/i18n-lib.mjs
            // now enforces that pairing the same way it enforces the licence
            // step quoting its own accept toggle, so the two cannot drift
            // apart again without the gate saying so.
            name: t('common.command.showActiveJobs'),
            callback: () => {
                void this.recoverJobs('manual');
            }
        });
        
        // Set appropriate max tokens based on current provider and model using registry
        const effectiveMaxTokens = this.getEffectiveMaxTokens();
        
        // Only update if the current setting is a legacy hardcoded value
        if (this.settings.maxTokens === 4096 || this.settings.maxTokens === 8192 || this.settings.maxTokens === 1000) {
            this.settings.maxTokens = effectiveMaxTokens;
            await this.saveSettings();
            
            if (this.settings.debugLogging) {
                logger.debug(`[onload] Updated maxTokens from legacy value to ${effectiveMaxTokens} for ${this.settings.selectedLLM}:${this.settings.selectedModels[this.settings.selectedLLM]}`);
            }
        }
        
        // Set log level based on settings
        if (this.settings.debugLogging) {
            setGlobalLogLevel(LogLevel.DEBUG);
        } else {
            setGlobalLogLevel(LogLevel.INFO);
        }

        this.initializeSummarizer();
        
        
        this.addSettingTab(new YouTubeTranscriptSettingTab(this.app, this));
        this.checkDependencies();

        // Register a plugin-owned SVG so the ribbon does not depend on Obsidian's built-in icon set.
        addIcon(TUBESAGE_RIBBON_ICON_ID, TUBESAGE_RIBBON_ICON_SVG);
        this.register(() => removeIcon(TUBESAGE_RIBBON_ICON_ID));

        // Add ribbon icon
        this.addRibbonIcon(TUBESAGE_RIBBON_ICON_ID, t('modal.create.title'), () => {
            // Check if license has been accepted
            if (!this.settings.licenseAccepted) {
                // Show license required modal if not accepted
                new LicenseRequiredModal(this.app).open();
                return;
            }
            
            // Check if API key is set for the selected LLM provider
            const selectedLlm = this.settings.selectedLLM;
            if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
                // Show error notice
                showNotice(t('notice.apiKey.missing', { provider: selectedLlm }), 7000);
                return;
            }

            // If license is accepted and API key is set, proceed with the usual workflow
            new YouTubeTranscriptModal(this.app, this).open();
        });

        // Add command
        this.addCommand({
            id: 'extract-youtube-transcript',
            name: t('common.command.extract'),
            callback: () => {
                // Check if license has been accepted
                if (!this.settings.licenseAccepted) {
                    // Show license required modal if not accepted
                    new LicenseRequiredModal(this.app).open();
                    return;
                }

                // Check if API key is set for the selected LLM provider
                const selectedLlm = this.settings.selectedLLM;
                if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
                    // Show error notice
                    showNotice(t('notice.apiKey.missing', { provider: selectedLlm }), 7000);
                    return;
                }
                
                // If license is accepted and API key is set, proceed with the usual workflow
                new YouTubeTranscriptModal(this.app, this).open();
            }
        });

        // Note: The file watcher setup has been removed as it was dependent on the anthropic proxy

    }

    onunload() {
        logger.debug('Unloading youtube transcript plugin');
        
        // Stop every runner timer and fence in-process runs; persisted
        // status is untouched, the next cold start closes them (app-closed).
        // (Optional chaining: onload may have failed before the runner existed.)
        this.jobRunner?.stopAll();
        if (this.visibilityRecoveryTimer !== null) {
            window.clearTimeout(this.visibilityRecoveryTimer);
            this.visibilityRecoveryTimer = null;
        }
        // No progress notice may outlive the plugin: a floating notice has no
        // owner once the events driving it have stopped.
        this.progressNotices.dismissAll();
        // A stale recovery modal could still reach resume/cancel/discard
        // (their store writes precede the runner's fence): close it.
        this.recoveryModal?.close();
        this.recoveryModal = null;
        this.jobEventListeners.clear();

        // Clean up file watcher if it exists
        if (this.fileWatcher) {
            try {
                this.fileWatcher.close();
                this.fileWatcher = null;
                logger.debug('Closed file watcher');
            } catch (error) {
                logger.error('Error closing file watcher:', error);
            }
        }
        
        
        // Any other cleanup needed
        logger.info('Youtube transcript plugin unloaded');
    }

    private initializeSummarizer() {
        const selectedProvider = this.settings.selectedLLM;
        const selectedModel = this.getModelForProvider(selectedProvider);
        
        logger.debug(`[initializeSummarizer] Selected provider: '${selectedProvider}'`);
        logger.debug(`[initializeSummarizer] Selected model: '${selectedModel}'`);
        logger.debug(`[initializeSummarizer] Temperature: ${this.settings.temperature}, MaxTokens: ${this.settings.maxTokens}`);
        logger.debug(`[initializeSummarizer] API Keys present:`, Object.keys(this.settings.apiKeys).reduce((acc, key) => {
            acc[key] = !!this.settings.apiKeys[key];
            return acc;
        }, {} as Record<string, boolean>));
        
        this.summarizer = new TranscriptSummarizer({
            model: selectedModel,
            temperature: this.settings.temperature,
            maxTokens: this.getEffectiveMaxTokens(), // Use dynamic calculation for all models
            systemPrompt: this.settings.systemPrompt,
            userPrompt: this.settings.userPrompt
        }, this.settings.apiKeys);
    }

    private getModelForProvider(provider: string): string {
        logger.debug(`[getModelForProvider] Getting model for provider: '${provider}'`);
        logger.debug(`[getModelForProvider] selectedModels object:`, JSON.stringify(this.settings.selectedModels, null, 2));
        
        if (this.settings.selectedModels[provider]) {
            const selectedModel = this.settings.selectedModels[provider];
            logger.debug(`[getModelForProvider] Found selected model for ${provider}: '${selectedModel}'`);
            return selectedModel;
        }
        
        // Fallback to defaults if no selection exists
        logger.debug(`[getModelForProvider] No selected model found for ${provider}, using fallback`);
        switch (provider) {
            case 'openai':
                logger.debug(`[getModelForProvider] Using OpenAI fallback: 'gpt-4-turbo'`);
                return 'gpt-4-turbo';
            case 'anthropic':
                logger.debug(`[getModelForProvider] Using Anthropic fallback: 'claude-3-sonnet-20240229'`);
                return 'claude-3-sonnet-20240229';
            case 'google':
                logger.debug(`[getModelForProvider] Using Google fallback: 'gemini-1.5-pro'`);
                return 'gemini-1.5-pro';
            case 'ollama':
                return 'llama3.1';
            case 'openrouter':
                logger.debug(`[getModelForProvider] Using OpenRouter fallback: 'openai/gpt-4o'`);
                return 'openai/gpt-4o';
            default:
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }
    }

    async loadSettings() {
        const loadedData: unknown = await this.loadData();
        logger.debug('[SETTINGS DEBUG] Loaded data from storage:', loadedData);
        logger.debug('[SETTINGS DEBUG] DEFAULT_SETTINGS.selectedLLM:', DEFAULT_SETTINGS.selectedLLM);

        // hydrate() splits the reserved `_jobs` key out of data.json; what is
        // left is the settings payload (never carrying `_jobs`).
        const { settings: hydratedSettings, jobs, dropped } = hydrate(loadedData);
        const loadedSettings: Partial<YouTubeTranscriptSettings> = hydratedSettings;

        this.settings = { ...DEFAULT_SETTINGS, ...loadedSettings };

        // The store must exist before the first persist() below (the two
        // migrations in this method write, and so does onload's maxTokens
        // migration): every settings write is a store flush from here on.
        this.jobStore = new JobStore(
            { loadData: () => this.loadData(), saveData: (data) => this.saveData(data) },
            () => this.settingsForPersist()
        );
        this.jobStore.load(jobs);
        if (dropped > 0) {
            logger.warn(`[jobs] Dropped ${dropped} invalid job record(s) from data.json`);
        }
        
        logger.debug('[SETTINGS DEBUG] Final settings.selectedLLM:', this.settings.selectedLLM);
        logger.debug('[SETTINGS DEBUG] All settings keys:', Object.keys(this.settings));
        // --- Fix legacy string booleans (mobile settings files might contain "true"/"false" strings) ---
        const coerceBool = (val: unknown, defaultVal: boolean): boolean => {
            if (typeof val === 'boolean') return val;
            if (typeof val === 'string') return val.toLowerCase() === 'true';
            return defaultVal;
        };

        // Ensure all boolean flags are actual booleans
        this.settings.debugLogging    = coerceBool(this.settings.debugLogging, DEFAULT_SETTINGS.debugLogging);
        this.settings.prependDate     = coerceBool(this.settings.prependDate, DEFAULT_SETTINGS.prependDate);
        this.settings.addTimestampLinks = coerceBool(this.settings.addTimestampLinks, DEFAULT_SETTINGS.addTimestampLinks);
        this.settings.useFastSummary  = coerceBool(this.settings.useFastSummary, DEFAULT_SETTINGS.useFastSummary);
        this.settings.licenseAccepted = coerceBool(this.settings.licenseAccepted, DEFAULT_SETTINGS.licenseAccepted);
        // ---------------------------------------------------------------------------

        // One-time migration: wipe polluted customModelLimits entries left by
        // the 1.2.15-1.2.17 auto-populate / per-keystroke bugs.  Those bugs
        // wrote one entry per keystroke in the custom-name field and one
        // entry per fetched-but-unknown model, all with the fingerprint
        // {contextK: 128, maxOutputK: 16, reservePct: 0.10} for non-Ollama
        // providers (Ollama legitimately uses 128/16 as its preset default
        // since model sizes vary too widely to ship a registry).  We delete
        // only the exact-match fingerprint entries to avoid wiping legitimate
        // user overrides that happen to coincide with the fallback shape.
        const polluted: string[] = [];
        for (const [key, val] of Object.entries(this.settings.customModelLimits ?? {})) {
            if (!val || typeof val !== 'object') continue;
            const isFingerprint =
                val.contextK === 128 &&
                val.maxOutputK === 16 &&
                val.reservePct === 0.10 &&
                val.inputMaxK === undefined;
            // Skip Ollama: 128/16/0.10 might be a legitimate user choice there.
            // (Ollama's default reservePct is 0.15, not 0.10, so any 0.10
            //  entry is suspicious anyway — but keep them just in case.)
            if (isFingerprint && !key.startsWith('ollama:')) {
                polluted.push(key);
            }
        }
        if (polluted.length > 0) {
            logger.info(`[migration] Removing ${polluted.length} polluted customModelLimits entries: ${polluted.join(', ')}`);
            for (const key of polluted) {
                delete this.settings.customModelLimits[key];
            }
            await this.persist();
        }

        // --- API key secret-storage migration ---------------------------------
        // Cloud-provider keys live in Obsidian secret storage, not data.json.
        // 1. Migrate any key still present in data.json into secret storage.
        // 2. Populate the runtime settings.apiKeys cloud entries from storage.
        // 3. If data.json held any cloud key, persist once to scrub it out.
        const dataApiKeys: Record<string, string> =
            isRecord(loadedSettings.apiKeys) ? loadedSettings.apiKeys : {};
        let hadCloudKeysInData = false;
        for (const provider of CLOUD_PROVIDERS) {
            const fromData = dataApiKeys[provider];
            if (typeof fromData === 'string' && fromData.trim() !== '') {
                hadCloudKeysInData = true;
                if (!this.app.secretStorage.getSecret(SECRET_IDS[provider])) {
                    this.app.secretStorage.setSecret(SECRET_IDS[provider], fromData);
                }
            }
        }
        for (const provider of CLOUD_PROVIDERS) {
            this.settings.apiKeys[provider] =
                this.app.secretStorage.getSecret(SECRET_IDS[provider]) ?? '';
        }
        if (hadCloudKeysInData) {
            logger.info('[migration] Moved cloud API keys to secret storage; scrubbing data.json');
            await this.persist();
        }
        // ----------------------------------------------------------------------
    }

    /**
     * The settings payload for data.json with cloud-provider API keys stripped out.
     * Cloud keys live in Obsidian secret storage, never in data.json. The job
     * store calls this at flush time and adds the `_jobs` key itself. The
     * stripping is the pure, tested `settingsForPersist` (src/runtime).
     */
    private settingsForPersist(): Record<string, unknown> {
        return settingsForPersist(this.settings, DEFAULT_SETTINGS.apiKeys.ollama);
    }

    /** Persist settings (and job records) to data.json through the store's serialized writer. */
    private async persist(): Promise<void> {
        await this.jobStore.flush();
    }

    // The three Vault calls the runner may make, with the TFile check kept
    // here so src/runtime never imports `obsidian`.
    private runnerVault(): VaultLike<TFile> {
        return {
            getFile: (path) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                return file instanceof TFile ? file : null;
            },
            read: (file) => this.app.vault.read(file),
            create: (path, content) => this.app.vault.create(path, content),
        };
    }

    // The stable id of this device + vault, created once and kept in the
    // vault's localStorage (never in data.json). Only this installation's
    // jobs are listed, recovered or closed here; a synced record from another
    // installation is ignored (it is that device's job).
    private cachedInstallationId: string | null = null;

    private installationId(): string {
        if (this.cachedInstallationId !== null) {
            return this.cachedInstallationId;
        }
        const stored: unknown = this.app.loadLocalStorage(INSTALLATION_ID_STORAGE_KEY);
        if (typeof stored === 'string' && stored !== '') {
            this.cachedInstallationId = stored;
            return stored;
        }
        const generated = generateOpaqueId();
        this.app.saveLocalStorage(INSTALLATION_ID_STORAGE_KEY, generated);
        this.cachedInstallationId = generated;
        return generated;
    }

    /** Is the note template renderable right now: Templater loaded and the configured template file present. */
    canRenderNote(): boolean {
        if (getTemplaterPlugin(this.app) === null) {
            return false;
        }
        const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templaterTemplateFile));
        return templateFile instanceof TFile;
    }

    // ---- jobs: submit, events, recovery ------------------------------------

    /**
     * Submits a single-video job and remembers it as this session's, which is what allows its note to
     * auto-open on `done`. Rejects only when the store failed to flush the new record: the run has
     * already started by then (runner contract), so callers must not assume nothing is running.
     */
    async submitJob(input: SubmitInput): Promise<SubmitResult> {
        const result = await this.jobRunner.submit(input);
        if (result.kind === 'started') {
            this.sessionJobIds.add(result.id);
        }
        return result;
    }

    /**
     * The channel/playlist runs this installation currently has going, for the
     * jobs modal's stop control. Another installation's run is not listed: it
     * may be live on that device, exactly as for single jobs.
     */
    runningCollections(): { id: string; sourceName: string; done: number; total: number }[] {
        const installation = this.installationId();
        return this.jobStore.listCollections()
            .filter((parent) => parent.status === 'running' && parent.installationId === installation)
            .map((parent) => {
                const children = parent.childIds
                    .map((id) => this.jobStore.get(id))
                    .filter((child): child is NoteJobRecord => child !== undefined);
                const progress = aggregateProgress(parent, children);
                return { id: parent.id, sourceName: parent.sourceName, done: progress.done, total: progress.total };
            });
    }

    /** Subscribes to runner events; returns the unsubscribe function. */
    subscribeToJobEvents(listener: JobEventListener): () => void {
        this.jobEventListeners.add(listener);
        return () => {
            this.jobEventListeners.delete(listener);
        };
    }

    // Runner events: the plugin's own policy first (the progress notice,
    // completion notices, note opening, the debug note), then the UI
    // subscribers. The progress notice is driven from ONE place — every
    // event type reaches it, so a job's notice appears on its first progress
    // event and is hidden by whichever terminal event ends it.
    private onJobEvent(event: JobEvent): void {
        // A child of a live collection is reported by that run's single notice,
        // so its own per-job notice and per-job completion notices are
        // suppressed. Logging, the debug note and the UI subscribers below are
        // unaffected — only the notice surface changes.
        const inCollection = this.collectionRunner?.owns(event.id) ?? false;
        if (!inCollection) {
            this.progressNotices.handle(event);
        }
        // ADVANCE THE RUN. Without this a collection submits its first video
        // and stops: every module was green while a 3-video playlist produced
        // one note and a notice that never closed. The routing itself lives in
        // CollectionRunner.handleJobEvent, where it is covered by tests.
        void this.collectionRunner?.handleJobEvent(event);
        switch (event.type) {
            case 'progress':
                logger.debug(`[jobs] ${event.id} ${event.stage}: ${event.message}`);
                break;
            case 'done':
                logger.info(`[jobs] ${event.id} done: ${event.notePath}`);
                if (!inCollection) {
                    this.showNotice(doneNoticeText(event), 5000);
                }
                // Auto-open ONLY for a job submitted in this session while the
                // app is visible; a recovered job never opens its note (F5).
                // Never for a collection child: a 40-video playlist would throw
                // 40 notes open.
                if (!inCollection && this.sessionJobIds.has(event.id) && activeDocument.visibilityState === 'visible') {
                    void this.openNote(event.notePath);
                }
                this.sessionJobIds.delete(event.id);
                break;
            case 'failed':
                logger.error(`[jobs] ${event.id} failed: ${event.error}`);
                this.sessionJobIds.delete(event.id);
                if (!inCollection) { this.showNotice(t('notice.job.failed', { error: event.error }), 5000); }
                if (this.settings.debugLogging) {
                    const record = this.jobStore.get(event.id);
                    if (record !== undefined) {
                        void this.writeErrorDebugNote(
                            effectiveTitle(record) ?? 'Failed Youtube transcript',
                            record.url,
                            record.folder,
                            event.error
                        );
                    }
                }
                break;
            case 'cancelled':
                logger.info(`[jobs] ${event.id} cancelled`);
                this.sessionJobIds.delete(event.id);
                if (!inCollection) { this.showNotice(t('notice.job.cancelled'), 3000); }
                break;
            case 'interrupted':
                logger.warn(`[jobs] ${event.id} interrupted`, event.prompt);
                // From here on the job is a recovered one even if it was
                // submitted in this session: a later resume must not auto-open.
                this.sessionJobIds.delete(event.id);
                if (!inCollection) { this.showNotice(t('notice.job.interrupted'), 6000); }
                break;
        }
        for (const listener of Array.from(this.jobEventListeners)) {
            try {
                listener(event);
            } catch (error) {
                logger.error('[jobs] event listener failed:', error);
            }
        }
    }

    async openNote(notePath: string): Promise<void> {
        try {
            const file = this.app.vault.getAbstractFileByPath(notePath);
            if (!(file instanceof TFile)) {
                logger.warn(`[jobs] Note not found for opening: ${notePath}`);
                return;
            }
            await this.app.workspace.getLeaf(true).openFile(file);
        } catch (error) {
            logger.error('[jobs] Could not open the note:', error);
        }
    }

    /**
     * Legacy debug-on-failure behaviour (extracted from the old modal's catch): when debug logging is
     * on, a failed run leaves an error note carrying the captured logs so the failure can be diagnosed.
     */
    private async writeErrorDebugNote(title: string, url: string, folder: string, message: string): Promise<void> {
        try {
            const finalLogs = getLogsForCallout();
            let errorContent = `# ${title}\n\n`;
            errorContent += `**Error occurred during processing:**\n\n`;
            errorContent += `> [!error] Processing Failed\n`;
            errorContent += `> ${message}\n\n`;
            errorContent += `**URL:** ${url}\n\n`;
            if (finalLogs && finalLogs.trim() !== "") {
                // Use the exact same format as successful notes
                const debugHeader = "\n\n> [!info]- Debug Information (hidden)\n> ```";
                const debugFooter = "\n> ```";
                errorContent += debugHeader + "\n" + finalLogs + debugFooter;
            }
            const fileName = sanitizeFilename(title) + '.md';
            const notePath = normalizePath(joinPaths(folder, fileName));
            await this.app.vault.create(notePath, errorContent);
            this.showNotice(t('notice.debugNote.created', { file: fileName }), 8000);
        } catch (noteError) {
            logger.error('Failed to create error note:', noteError);
            this.showNotice(t('notice.debugNote.failed', { error: message }), 5000);
        }
    }

    // Visibility edge (best effort, spec §6): debounced, and ignored until the
    // cold-start pass has run so it can never be the first pass.
    private scheduleVisibilityRecovery(): void {
        if (!this.layoutReady) {
            return;
        }
        if (this.visibilityRecoveryTimer !== null) {
            window.clearTimeout(this.visibilityRecoveryTimer);
        }
        this.visibilityRecoveryTimer = window.setTimeout(() => {
            this.visibilityRecoveryTimer = null;
            void this.recoverJobs('visible');
        }, VISIBILITY_RECOVERY_DEBOUNCE_MS);
    }

    /**
     * One recovery pass. `startup` is the cold-start pass: the jobs the previous process left
     * unfinished are closed (a job dies with its instance) and reported in ONE Notice, never a modal;
     * the other triggers classify only. The Notice/modal policy is the pure `shouldOpenRecoveryModal`:
     * a visibility edge never pops a modal over whatever the user was doing.
     */
    private async recoverJobs(trigger: RecoveryTrigger): Promise<void> {
        let promptCount: number;
        try {
            const prompts = await this.jobRunner.recoverAll(trigger === 'startup' ? { coldStart: true } : {});
            promptCount = prompts.length;
        } catch (error) {
            logger.error(`[jobs] Recovery pass (${trigger}) failed:`, error);
            this.showNotice(t('notice.recovery.checkFailed', { error: getSafeErrorMessage(error) }), 6000);
            return;
        } finally {
            // In `finally`, not after the try/catch: a pass that throws partway through still closes
            // some records before it fails (closeOwnRuns persists each closure as it happens), and
            // those closures deserve their Notice regardless (#3 batch G item 5).
            if (trigger === 'startup') {
                this.layoutReady = true;
                const closedNotice = coldStartNoticeText(this.jobRunner.drainClosedOnColdStart());
                if (closedNotice !== undefined) {
                    this.showNotice(closedNotice, 8000);
                }
                // The same rule for collections (#9): a run dies with the
                // instance that began it, so one left `running` by a killed
                // instance is closed here and reported. Children are ordinary
                // jobs and were already closed by the pass above — closing the
                // parent must not, and does not, restart any of them.
                void this.collectionRunner?.closeAbandoned().then((closed) => {
                    if (closed > 0) {
                        this.showNotice(t('notice.collection.closedOnStart', { count: closed }), 8000);
                    }
                }).catch((error: unknown) => {
                    logger.error('[collections] cold-start closure failed:', error);
                });
            }
        }
        const notice = recoveryNoticeText(promptCount);
        if (notice !== undefined) {
            this.showNotice(notice, 8000);
        }
        if (shouldOpenRecoveryModal(trigger, promptCount)) {
            this.openRecoveryModal();
        }
    }

    /**
     * Opens the recovery modal, or refreshes the one already open (startup + command must not stack
     * two). `highlightId` marks and scrolls to one job's row (a submit that hit an existing job).
     */
    openRecoveryModal(highlightId?: string): void {
        if (this.recoveryModal !== null) {
            this.recoveryModal.highlight(highlightId);
            void this.recoveryModal.refresh();
            return;
        }
        const modal = new JobRecoveryModal(this.app, this, () => {
            if (this.recoveryModal === modal) {
                this.recoveryModal = null;
            }
        });
        modal.highlight(highlightId);
        this.recoveryModal = modal;
        modal.open();
    }

    /**
     * Rows for the recovery modal: every non-terminal record plus the most recent finished ones, each
     * rendered from the pure UI model and the runner's read-only prompt. Wording and button sets are
     * never derived here.
     */
    async recoveryRows(): Promise<RecoveryRowEntry[]> {
        const records = this.jobStore.list();
        const active = records.filter((record) => !isTerminal(record));
        const recent = records
            .filter((record) => isTerminal(record))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, RECENT_TERMINAL_JOBS_SHOWN);
        const entries: RecoveryRowEntry[] = [];
        for (const record of [...active, ...recent]) {
            const prompt = await this.jobRunner.promptFor(record.id);
            if (prompt === undefined) {
                continue; // discarded while we were probing
            }
            const noteExists =
                record.notePath !== undefined && this.app.vault.getAbstractFileByPath(record.notePath) instanceof TFile;
            // Wording only (#3 batch G item 7), never proof: a note-creating-window job never learned
            // whether its claimed path landed, so this never gates Open note (noteExists does that).
            const noteMayExist =
                record.notePath === undefined &&
                record.claimedNotePath !== undefined &&
                this.app.vault.getAbstractFileByPath(record.claimedNotePath) instanceof TFile;
            entries.push({ row: buildRecoveryRow(record, prompt, noteExists, noteMayExist), updatedAt: record.updatedAt });
        }
        return entries;
    }

    async saveSettings() {
        await this.persist();
        this.initializeSummarizer();
    }

    async extractTranscript(videoUrl: string): Promise<string> {
        const result = await this.extractTranscriptWithMetadata(videoUrl);
        return result.transcript;
    }
    
    async extractTranscriptWithMetadata(videoUrl: string): Promise<{transcript: string, metadata: {title?: string, author?: string}}> {
        return await this.extractTranscriptsWithMetadata([videoUrl]).then(results => results[0]);
    }
    
    /**
     * Strict single-URL extraction for the job runner: the same fetch + YAML formatting as the batch
     * path, but NOTHING is swallowed — a network error, a timeout or an invalid URL rejects as-is so
     * the runner can classify it (transient → interrupted, resumable) instead of reading a folded
     * `[TRANSCRIPT EXTRACTION FAILED: …]` marker as a permanent no-captions outcome.
     */
    async extractTranscriptStrict(videoUrl: string): Promise<{transcript: string, metadata: {title?: string, author?: string}}> {
        const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
        if (!videoId) {
            throw new Error(`Invalid youtube URL: '${videoUrl}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
        }
        const result = await YouTubeTranscriptExtractor.fetchTranscript(videoId, {
            lang: this.settings.translateLanguage,
            country: this.settings.translateCountry,
            supadataApiKey: this.settings.supadataApiKey || undefined,
            scrapcreatorsApiKey: this.settings.scrapcreatorsApiKey || undefined,
            // Never the folded marker: no captions → NoCaptionsError, a
            // caption-fetch network failure → a plain Error (I2).
            strict: true
        });
        return { transcript: this.formatTranscriptForYaml(result.segments), metadata: result.metadata };
    }

    async extractTranscriptsWithMetadata(videoUrls: string[]): Promise<Array<{transcript: string, metadata: {title?: string, author?: string}}>> {
        try {
            transcriptLogger.debug(`Starting transcript extraction for ${videoUrls.length} URLs`);
            
            const results: Array<{transcript: string, metadata: {title?: string, author?: string}}> = [];
            
            // Process each URL
            for (let i = 0; i < videoUrls.length; i++) {
                const videoUrl = videoUrls[i];
                try {
                    transcriptLogger.debug(`Processing video ${i + 1}/${videoUrls.length}: ${videoUrl}`);
                    
                    // Extract video ID from URL
                    const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
                    
                    if (!videoId) {
            throw new Error(`Invalid youtube URL: '${videoUrl}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
                    }
                    
                    // Get transcript segments and metadata using direct ScrapeCreators method
                    const result = await YouTubeTranscriptExtractor.fetchTranscript(videoId, {
                        lang: this.settings.translateLanguage,
                        country: this.settings.translateCountry,
                        supadataApiKey: this.settings.supadataApiKey || undefined,
                        scrapcreatorsApiKey: this.settings.scrapcreatorsApiKey || undefined
                    });
                    
                    // Format transcript with timestamps
                    const formattedTranscript = this.formatTranscriptForYaml(result.segments);
                    results.push({
                        transcript: formattedTranscript,
                        metadata: result.metadata
                    });
                    
                } catch (error) {
                    transcriptLogger.error(`Failed to extract transcript for video ${i + 1}/${videoUrls.length}:`, error);
                    const errorMessage = getSafeErrorMessage(error);
                    // Continue with other videos, but include error result
                    results.push({
                        transcript: `[TRANSCRIPT EXTRACTION FAILED: ${errorMessage}]`,
                        metadata: { title: `Error extracting from URL: ${videoUrl}`, author: 'Unknown' }
                    });
                }
            }
            
            return results;
            
        } catch (error) {
            throw handleApiError(error, 'Youtube API', 'Transcript extraction');
        }
    }

    // Helper method to format transcript segments for YAML frontmatter
    private formatTranscriptForYaml(segments: TranscriptInputSegment[]): string {
        // Process segments into formatted text with timestamps
        let formattedTranscript = '';
        
        transcriptLogger.debug("Formatting transcript segments:", 
            (Array.isArray(segments) ? `${segments.length} segments` : 'not an array'));
        
        if (Array.isArray(segments)) {
            // Create exactly 1-minute chunks based on actual timestamps
            const ONE_MINUTE_SECONDS = 60; // 1 minute in seconds
            let chunks: {time: string, text: string, seconds: number}[] = [];
            
            // Track the current chunk being built
            let currentChunk = {
                time: '',
                text: '',
                seconds: 0,
                startSeconds: 0
            };
            
            let isFirstSegment = true;
            
            // Function to parse and convert timestamp to seconds
            const timestampToSeconds = (time: number | string): number => {
                // If time is already a number (seconds), return it
                if (typeof time === 'number') {
                    return time;
                }
                
                // Handle milliseconds (convert to seconds)
                if (typeof time === 'string' && time.includes('ms')) {
                    return parseInt(time) / 1000;
                }
                
                // If we don't recognize the format, return 0
                return 0;
            };
            
            // Sort segments by timestamp if needed
            const sortedSegments = [...segments].sort((a, b) => {
                const aTime = timestampToSeconds(a.start || (a.tStartMs ? parseInt(a.tStartMs) / 1000 : 0));
                const bTime = timestampToSeconds(b.start || (b.tStartMs ? parseInt(b.tStartMs) / 1000 : 0));
                return aTime - bTime;
            });
            
            // Process and group segments into chunks based on actual timestamps
            sortedSegments.forEach((segment, _index) => {
                // Get segment start time in seconds
                let segmentTimeSeconds = 0;
                if (typeof segment.start === 'number') {
                    segmentTimeSeconds = segment.start;
                } else if (segment.tStartMs) {
                    segmentTimeSeconds = parseInt(segment.tStartMs) / 1000;
                }
                
                // Format segment time as HH:MM:SS
                const segmentTimeFormatted = this.formatTimestamp(segmentTimeSeconds);
                
                // Extract text from segment
                let segmentText = '';
                if (segment.text) {
                    segmentText = segment.text.trim();
                } else if (segment.segs && Array.isArray(segment.segs)) {
                    segmentText = segment.segs.map((s) => s.utf8 || '').join('').trim();
                }
                
                // Skip empty segments
                if (!segmentText) return;
                
                // If this is the first segment or we've reached/exceeded a minute boundary
                if (isFirstSegment || 
                    (segmentTimeSeconds - currentChunk.startSeconds >= ONE_MINUTE_SECONDS)) {
                    
                    // Add the previous chunk if it exists and isn't the first segment
                    if (!isFirstSegment && currentChunk.text) {
                        chunks.push({
                            time: this.formatTimestamp(currentChunk.startSeconds),
                            text: currentChunk.text,
                            seconds: currentChunk.startSeconds
                        });
                    }
                    
                    // Start a new chunk
                    currentChunk = {
                        time: segmentTimeFormatted,
                        text: segmentText,
                        seconds: segmentTimeSeconds,
                        startSeconds: segmentTimeSeconds
                    };
                    
                    isFirstSegment = false;
                } else {
                    // Add to current chunk with a space
                    currentChunk.text += ' ' + segmentText;
                }
            });
            
            // Add the last chunk if it has content
            if (currentChunk.text) {
                chunks.push({
                    time: this.formatTimestamp(currentChunk.startSeconds),
                    text: currentChunk.text,
                    seconds: currentChunk.startSeconds
                });
            }

            transcriptLogger.debug(`Created ${chunks.length} exactly time-based chunks`);
            
            // Format chunks for YAML frontmatter
            // Start with a newline to ensure proper YAML block format
            formattedTranscript = "\n";
            
            chunks.forEach((chunk) => {
                // Create the TimeIndex marker with unescaped colon
                const timeIndexMarker = `[TimeIndex:${Math.round(chunk.seconds)}]`;
                
                // Handle escaping of colons in the text portion only
                let textContent = chunk.text;
                
                // Remove any existing TimeIndex markers from the text
                const timeIndexRegex = /\[TimeIndex:(\d+)\]/g;
                textContent = textContent.replace(timeIndexRegex, '');
                
                // Now escape colons only in the text
                const escapedText = textContent.replace(/:/g, "\\:");
                
                // Position the TimeIndex marker right after the timestamp
                formattedTranscript += `    [${chunk.time}] ${timeIndexMarker} ${escapedText}\n`;
            });
        } else {
            // Fallback if segments is not an array
            formattedTranscript = "\n    Unable to format transcript properly";
        }
        
        return formattedTranscript;
    }
    
    // Format seconds into HH:MM:SS format
    private formatTimestamp(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        
        return [
            h.toString().padStart(2, '0'),
            m.toString().padStart(2, '0'),
            s.toString().padStart(2, '0')
        ].join(':');
    }

    /**
     * `useFastSummary` is the job record's frozen flag when called by the runner; legacy callers
     * (collections) omit it and get the live setting.
     */
    async summarizeTranscript(transcript: string, useFastSummary: boolean = this.settings.useFastSummary): Promise<string> {
        try {
            // Clean the transcript using our utility function
            const cleanedTranscript = cleanTranscript(transcript);
            
            // Determine which prompt to use: the caller's mode (record-scoped for jobs)
            const summaryMode = useFastSummary ? SummaryMode.FAST : SummaryMode.EXTENSIVE;
            
            // Get the prompt configuration with dynamic max tokens
            const promptConfig = getPromptConfig(this.settings, summaryMode, this.getEffectiveMaxTokens());
            
            // --- Add logging for the summarization step ---
            llmLogger.debug(`[summarizeTranscript] Starting ${summaryMode} summary.`);
            llmLogger.debug(`[summarizeTranscript] Using model: ${this.settings.selectedLLM} - ${this.getModelForProvider(this.settings.selectedLLM)}`);
            llmLogger.debug(`[summarizeTranscript] Max Tokens: ${promptConfig.maxTokens}, Temperature: ${promptConfig.temperature}`);
            if (this.settings.debugLogging) { // Only log prompts/transcript in debug mode
                llmLogger.debug("--- System Prompt ---");
                llmLogger.debug(truncateForLogs(promptConfig.systemPrompt, 200));
                llmLogger.debug("--- User Prompt ---");
                llmLogger.debug(truncateForLogs(promptConfig.userPrompt, 200));
                // Log truncated transcript to avoid excessive length
                llmLogger.debug("--- Cleaned Transcript (Excerpt) ---");
                llmLogger.debug(truncateForLogs(cleanedTranscript, 300));
                llmLogger.debug("---------------------------------");
            }
            // --- End added logging ---
            
            llmLogger.debug("Using token limit:", promptConfig.maxTokens); // Keep existing token log
            
            // Store provider value before any potential context corruption
            const selectedProvider = this.settings.selectedLLM;
            
            // Debug the config being passed to TranscriptSummarizer
            const model = this.getModelForProvider(selectedProvider);
            llmLogger.debug(`[DEBUG] Model: ${model}`);
            llmLogger.debug(`[DEBUG] Temperature: ${promptConfig.temperature}`);
            llmLogger.debug(`[DEBUG] MaxTokens: ${promptConfig.maxTokens}`);
            llmLogger.debug(`[DEBUG] SystemPrompt length: ${promptConfig.systemPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[DEBUG] UserPrompt length: ${promptConfig.userPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[DEBUG] SelectedLLM: ${selectedProvider}`);
            
            // Safety check for settings and API keys
            llmLogger.debug(`[DEBUG] Checking settings - exists: ${!!this.settings}`);
            if (!this.settings) {
                throw new Error('Plugin settings are not loaded');
            }
            
            llmLogger.debug(`[DEBUG] Checking apiKeys - exists: ${!!this.settings.apiKeys}`);
            llmLogger.debug(`[DEBUG] ApiKeys type: ${typeof this.settings.apiKeys}`);
            const apiKeyKeys = this.settings.apiKeys ? Object.keys(this.settings.apiKeys) : [];
            llmLogger.debug(`[DEBUG] ApiKeys keys: ${apiKeyKeys.length ? apiKeyKeys.join(', ') : 'none'}`);
            
            if (!this.settings.apiKeys) {
                throw new Error('API keys are not configured in settings');
            }
            
            // Create a summarizer with the prompt configuration
            llmLogger.debug(`[DEBUG] About to create TranscriptSummarizer...`);
            const tempSummarizer = new TranscriptSummarizer({
                model: model,
                temperature: promptConfig.temperature,
                maxTokens: promptConfig.maxTokens,
                systemPrompt: promptConfig.systemPrompt,
                userPrompt: promptConfig.userPrompt
            }, this.settings.apiKeys);
            llmLogger.debug(`[DEBUG] TranscriptSummarizer created successfully`);
            
            llmLogger.debug(`[DEBUG] About to call summarize with provider: '${selectedProvider}'`);
            llmLogger.debug(`[DEBUG] this object type:`, typeof this, this.constructor.name);
            llmLogger.debug(`[DEBUG] this.settings exists:`, !!this.settings);
            llmLogger.debug(`[DEBUG] Full settings.selectedLLM value:`, this.settings?.selectedLLM);
            llmLogger.debug(`[DEBUG] Settings object keys:`, this.settings ? Object.keys(this.settings) : 'settings is null/undefined');
            const summary = await tempSummarizer.summarize(cleanedTranscript, selectedProvider);
            
            // Add the creator support message at the beginning of the summary 
        const supportMessage = "Support content creators: If you found this content valuable, please consider supporting the Youtube creator by liking 👍 the video and subscribing to their channel. ";
            
            // Sanitize the beginning of the summary to ensure clean paragraph flow
            let sanitizedSummary = summary;
            
            // Remove leading newlines, spaces, and markdown formatting from the summary
            sanitizedSummary = sanitizedSummary.replace(/^[\s\n\r]*/, '');
            
            // If the summary starts with list markers or headers, we need a line break
            if (/^(#|-|\*|\d+\.)/.test(sanitizedSummary)) {
                // Summary starts with Markdown formatting, need to keep them separated
                return supportMessage + "\n\n" + sanitizedSummary;
            } else {
                // Get the first paragraph from the summary (up to first double newline)
                const firstParagraphMatch = sanitizedSummary.match(/^([^\n]+(?:\n[^\n]+)*)/);
                if (firstParagraphMatch) {
                    const firstParagraph = firstParagraphMatch[0];
                    // Replace any single newlines with spaces in the first paragraph
                    const cleanFirstParagraph = firstParagraph.replace(/\n/g, ' ');
                    // Rest of the summary after the first paragraph
                    const restOfSummary = sanitizedSummary.substring(firstParagraph.length);
                    // Combine: support message + clean first paragraph + rest of summary
                    return supportMessage + cleanFirstParagraph + restOfSummary;
                }
                
                // Fallback if we can't match a first paragraph
                return supportMessage + sanitizedSummary;
            }
        } catch (error) {
            // Use the error handling utility
            throw handleApiError(error, this.settings.selectedLLM, 'Summarization');
        } finally {
            // If using Anthropic provider and fast summary mode or not adding timestamp links,
            // log information about completion
            if (this.settings.selectedLLM === 'anthropic' && 
                (useFastSummary || !this.settings.addTimestampLinks)) {
                llmLogger.info('[summarizeTranscript] Completed Anthropic processing (fast summary or no timestamp links)');
            }
        }
    }

    /**
     * Renders the note (Templater lookup through parsed content) and derives its path, creating the
     * folder if needed — but writes nothing. `createdAt` is the SOLE source of the date prefix
     * (`formatDatePrefix`), so callers that later need the path again must pass the same epoch.
     * Throws when Templater is unavailable or the template file is missing.
     */
    async renderNoteContent(title: string, videoUrl: string, transcript: string, summary: string, folder: string, createdAt: number, notePathSettings?: NotePathSettings): Promise<RenderedNote> {
        const templaterPlugin = getTemplaterPlugin(this.app);
        if (!templaterPlugin) {
            throw new Error('Templater plugin is required but not installed or enabled.');
        }

        // Get the Templater instance
        const templater = templaterPlugin.templater;

        // Sanitize the title for use as a filename
        const sanitizedTitle = sanitizeFilename(title);

        // Normalize video URL data for templating (e.g., shorts/playlist URLs)
        const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
        const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : videoUrl;
        const thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '';

        // Date prefix from the captured epoch, never from the clock here, and
        // from the job's FROZEN settings when the runner passes them (F1/F4):
        // a toggle flipped mid-job must not move the note. Legacy callers
        // (collections) omit them and get the live settings.
        const datePrefix = formatDatePrefix(createdAt, notePathSettings ?? this.settings);
        // REDO THE TRANSCRIPT FORMATTING FOR YAML
        // We'll re-process the transcript no matter what format it's in
        logger.debug("Processing transcript for YAML format");
        
        // Format the transcript with original timestamps preserved
        let formattedTranscript = "";
        
        // Check if the transcript already has timestamps in format [HH:MM:SS]
        if (transcript.includes('[00:') || transcript.includes('[01:') || transcript.match(/\[\d{2}:\d{2}:\d{2}\]/)) {
            logger.debug("Transcript contains timestamps, organizing into ≥60 second blocks");
            
            // Split the transcript into lines
            const originalLines = transcript.split('\n').filter(line => line.trim().length > 0);
            
            // Parse each line with its timestamp
            const parsedLines: {timestamp: string, seconds: number, text: string}[] = [];
            
            originalLines.forEach(line => {
                // Look for timestamp pattern [HH:MM:SS]
                const timestampMatch = line.match(/^\s*\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
                
                if (timestampMatch) {
                    const timestamp = timestampMatch[1];
                    let text = timestampMatch[2].trim();
                    
                    // Remove any escaped backslashes from TimeIndex markers
                    text = text.replace(/\[TimeIndex\\?:(\d+)\]/g, '[TimeIndex:$1]');
                    
                    // Convert timestamp to seconds for comparison
                    const parts = timestamp.split(':').map(Number);
                    const seconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
                    
                    parsedLines.push({
                        timestamp,
                        seconds,
                        text
                    });
                } else if (line.trim().length > 0) {
                    // Handle lines without timestamps - append to the last segment if it exists
                    if (parsedLines.length > 0) {
                        // Add this content to the last parsed line
                        parsedLines[parsedLines.length - 1].text += ' ' + line.trim();
                    } else {
                        // If no timestamps yet, create a placeholder entry for time 0
                        parsedLines.push({
                            timestamp: '00:00:00',
                            seconds: 0,
                            text: line.trim()
                        });
                    }
                }
            });
            
            // Group lines into blocks of ≥60 seconds
            const segments: {timestamp: string, text: string}[] = [];
            
            // Process lines into segments
            if (parsedLines.length > 0) {
                // Sort parsed lines by seconds to ensure chronological order
                parsedLines.sort((a, b) => a.seconds - b.seconds);
                
                // Initialize with the first line
                let segmentTimestamp = parsedLines[0].timestamp;
                let segmentStartSeconds = parsedLines[0].seconds;
                let segmentLines: string[] = [parsedLines[0].text];
                
                // Process remaining lines
                for (let i = 1; i < parsedLines.length; i++) {
                    const line = parsedLines[i];
                    
                    // If this line is at least 60 seconds from the start of current segment,
                    // finalize the current segment and start a new one
                    if (line.seconds - segmentStartSeconds >= 60) {
                        // Add completed segment
                        segments.push({
                            timestamp: segmentTimestamp,
                            text: segmentLines.join(' ')
                        });
                        
                        // Start a new segment - ALWAYS use the actual timestamp from the current line
                        segmentTimestamp = line.timestamp;
                        segmentStartSeconds = line.seconds;
                        segmentLines = [line.text];
                    } else {
                        // Add to current segment
                        segmentLines.push(line.text);
                    }
                }
                
                // Add the final segment if it has any content
                if (segmentLines.length > 0) {
                    segments.push({
                        timestamp: segmentTimestamp,
                        text: segmentLines.join(' ')
                    });
                }
            }
            
            logger.debug(`Organized ${originalLines.length} lines into ${segments.length} ≥60-second blocks`);
            
            // Format segments for YAML frontmatter
            segments.forEach(segment => {
                // Convert timestamp to seconds using our custom function
                const timeIndex = convertTimestampToSeconds(segment.timestamp);
                
                // Create the TimeIndex marker with unescaped colon
                const timeIndexMarker = `[TimeIndex:${timeIndex}]`;
                
                // Handle text content 
                let textContent = segment.text;
                
                // Remove any existing TimeIndex markers from the text
                const timeIndexRegex = /\[TimeIndex:(\d+)\]/g;
                textContent = textContent.replace(timeIndexRegex, '');
                
                // Only escape colons in the text content
                const escapedText = textContent.replace(/:/g, "\\:");
                
                // Position the TimeIndex marker right after the timestamp
                formattedTranscript += `    [${segment.timestamp}] ${timeIndexMarker} ${escapedText}\n`;
            });
        } else {
            logger.debug("Transcript does not contain timestamps");
            
            // Provide a warning message in the transcript text
        formattedTranscript = "    [ERROR] No timestamps found in transcript. Please ensure the Youtube transcript contains timestamps.";
            
            // Show an error notice
            this.showNotice(t('notice.transcript.noTimestamps'), 5000);
        }
        
        // Now use this properly formatted transcript
        transcript = formattedTranscript;
        
        // Final cleanup - ensure all TimeIndex markers are unescaped
        transcript = transcript.replace(/\[TimeIndex\\:(\d+)\]/g, '[TimeIndex:$1]');
        
        // Normalize the folder path
        const normalizedFolder = normalizePath(folder || '');
        
        // Create folder if needed
        if (normalizedFolder) {
            await ensureFolder(this.app.vault, normalizedFolder);
        }
        
        // Normalize the template path
        const normalizedTemplatePath = normalizePath(this.settings.templaterTemplateFile);
        
        // Get template file and verify it exists
        const templateFile = this.app.vault.getAbstractFileByPath(normalizedTemplatePath);
        if (!(templateFile instanceof TFile)) {
            throw new Error(`Template file not found: ${this.settings.templaterTemplateFile}`);
        }
        
        // 1. Initialize Templater if needed (force a one-time run)
        if (!templater.current_functions_object) {
            // We'll initialize with the actual template processing below
        }
        
        // 2. Create a running config for the actual template
        const config = templater.create_running_config(
            templateFile,
            templateFile, // Use the template file itself as target to avoid null path errors
            0    // Numeric value for "CreateNewFromTemplate"
        );
        
        // 3. Generate the Templater context (tp object)
        const ctx = await templater.functions_generator.generate_object(config);
        
        // 4. Inject our custom data into ctx.user as functions
        const user = ctx.user ?? {};
        ctx.user = user;
        
        // Set up our data as functions in ctx.user
        user.title = sanitizedTitle;
        // Use a normalized watch URL so template parsing doesn't break on shorts/live URLs
        user.videoUrl = watchUrl || videoUrl;
        user.originalVideoUrl = videoUrl;
        user.videoId = videoId || '';
        user.watchUrl = watchUrl || videoUrl;
        user.thumbnailUrl = thumbnailUrl;
        user.transcript = transcript;
        user.summary = summary;
        
        // Add LLM provider and model info
        const llmProvider = this.settings.selectedLLM;
        const llmModel = this.settings.selectedModels[llmProvider];
        user.llmProvider = llmProvider;
        user.llmModel = llmModel;
        
        // Add tags for LLM provider and model in proper YAML array format
        const baseTags = ["youtube", "transcript"];
        const llmProviderTag = `llm/${llmProvider}`;
        const llmModelTag = `model/${llmModel.replace(/[:.]/g, "-")}`;
        const allTags = [...baseTags, llmProviderTag, llmModelTag];
        const llmTags = `[${allTags.join(", ")}]`;
        user.llmTags = llmTags;
        
        // Add plugin version for frontmatter tracking
        user.version = this.getVersion();
        
        // Debug info is only logged, not included in notes
        if (this.settings.debugLogging) {
            logger.debug(`Transcript info: 
            - Length: ${transcript ? transcript.length : 'unknown'} characters
            - Contains timestamps: ${transcript ? transcript.includes('[00:') : 'unknown'}
            - LLM Provider: ${llmProvider}
            - LLM Model: ${llmModel}`);
        }
        
        // 5. Read and parse the template with our custom context
        const templateContent = await this.app.vault.read(templateFile);
        
        // Debug logging to check template content and tags
        if (this.settings.debugLogging) {
            logger.debug(`Template content (first 500 chars): ${templateContent.substring(0, 500)}`);
            logger.debug(`ctx.user.llmTags value: ${llmTags}`);
        }
        
        const parsedContent = await templater.parser.parse_commands(templateContent, ctx);
        
        // Debug logging to check parsed content
        if (this.settings.debugLogging) {
            const frontmatterEnd = parsedContent.indexOf('---', 3);
            if (frontmatterEnd !== -1) {
                const frontmatter = parsedContent.substring(0, frontmatterEnd + 3);
                // Truncate: the frontmatter embeds the full `transcript: |` field
                // (tens of thousands of chars). The debug value is confirming that
                // Templater substituted the fields — the first ~500 chars show that;
                // the transcript body is noise that historically flooded the log.
                logger.debug(`Parsed frontmatter: ${truncateForLogs(frontmatter, 500)}`);
            }
        }
        
        // 6. The final content and the path the note will live at
        // (the support message is added to the summary in summarizeTranscript)
        // Through Obsidian's normalizePath (NFC): sanitizeFilename leaves some
        // scripts (Hangul) in NFD, while Vault.create writes and indexes the
        // NFC form — this is the path the runner freezes, claims and looks
        // up, so it must be the path the vault will actually know.
        const fileName = `${datePrefix}${sanitizedTitle}.md`;
        const filePath = obsidianNormalizePath(normalizedFolder ? joinPaths(normalizedFolder, fileName) : fileName);
        return { filePath, content: parsedContent, folder: normalizedFolder };
    }

    async applyTemplate(title: string, videoUrl: string, transcript: string, summary: string, folder?: string, _contentType?: string, createdAt: number = Date.now()): Promise<void> {
        // Check if Templater plugin is available
        if (!getTemplaterPlugin(this.app)) {
            this.showNotice(t('notice.templater.required'), 5000);
            throw new Error('Templater plugin is required but not installed or enabled.');
        }
        
        try {
            const { filePath, content } = await this.renderNoteContent(title, videoUrl, transcript, summary, folder || '', createdAt);
            
            const newFile = await this.app.vault.create(filePath, content);
            
            // Open the new file
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(newFile);
            
            this.showNotice(t('notice.note.created', { name: `${formatDatePrefix(createdAt, this.settings)}${sanitizeFilename(title)}` }), 5000);
        } catch (error) {
            logger.error("Error applying template:", error);
            const errorMessage = getSafeErrorMessage(error);
            this.showNotice(t('notice.note.createFailed', { error: errorMessage }), 5000);
            // Clear logs on error too
            clearLogs();
            throw error;
        }
    }

    // Simplified method to ensure a folder exists - wrapper for the utility (also the runner's createNote precondition)
    async ensureFolder(folderPath: string): Promise<void> {
        await ensureFolder(this.app.vault, folderPath);
    }

    // Add a debugging method to help troubleshoot
    debugSettings() {
        logger.debug('=== DEBUG SETTINGS ===');
        logger.info('Selected LLM:', this.settings.selectedLLM);
        logger.debug('Selected Models:', JSON.stringify(this.settings.selectedModels));
        
        const apiKeyStatus = Object.entries(this.settings.apiKeys).map(([provider, key]) => {
            return `${provider}: ${key ? '✓' : '✗'}`;
        }).join(', ');
        
        logger.info('API Keys configured:', apiKeyStatus);
        
        if (!this.settings.apiKeys[this.settings.selectedLLM]) {
            logger.warn(`No API key configured for selected LLM: ${this.settings.selectedLLM}`);
        }
        
        logger.debug('=====================');
    }

    // Check for required dependencies
    private checkDependencies(): void {
        // Check for Templater plugin
        const templater = getTemplaterPlugin(this.app);
        
        if (!templater) {
            // Show a notice with instructions on how to install Templater
            window.setTimeout(() => {
        this.showNotice(t('notice.templater.missing'), 5000);
            }, 3000); // Delay to ensure it's seen after initial plugin load
        }

        // Check for LLM API key
        const selectedLlm = this.settings.selectedLLM;
        if (!this.settings.apiKeys[selectedLlm] || this.settings.apiKeys[selectedLlm].trim() === '') {
            window.setTimeout(() => {
                this.showNotice(t('notice.apiKey.missing', { provider: selectedLlm }), 5000);
            }, 4500);
        }
    }

    // Use imported utility method
    private isYoutubeUrl(this: void, url: string): boolean {
        return isYoutubeUrl(url);
    }
    
    // Use imported utility method
    private isYoutubeChannelOrPlaylistUrl(this: void, url: string): boolean {
        return isYoutubeChannelOrPlaylistUrl(url);
    }
    
    // Use imported utility method
    private extractChannelName(url: string): string {
        return extractChannelName(url);
    }

    // Method to fetch videos from a YouTube channel or playlist
    async fetchCollectionVideos(sourceUrl: string, limit: number = 0): Promise<{ title: string, url: string }[]> {
        try {
            // Use the main YouTube API key
            const API_KEY = this.settings.youtubeApiKey;
            
            if (!API_KEY) {
            throw new Error('Youtube API key is required. Please set it in the plugin settings.');
            }
            
            this.showNotice(t('notice.collection.fetchingInfo'), 5000);
            
            // Determine if it's a playlist or channel and get appropriate ID
            let isPlaylist = sourceUrl.includes('/playlist') || sourceUrl.includes('list=');
            let sourceId;
            let sourceTitle = '';
            let videoResults: Array<{title: string, url: string}> = [];
            
            if (isPlaylist) {
                // Extract playlist ID
                if (sourceUrl.includes('list=')) {
                    const match = sourceUrl.match(/list=([^&]+)/);
                    if (match && match[1]) {
                        sourceId = match[1];
                        this.showNotice(t('notice.collection.fetchingPlaylist', { id: sourceId }), 3000);
                        
                        // Get playlist details
                        const playlistResponse = await obsidianFetch(
                            `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${sourceId}&key=${API_KEY}`
                        );
                        
                        if (!playlistResponse.ok) {
                            throw new Error(`Failed to fetch playlist data: HTTP status ${playlistResponse.status}`);
                        }
                        
                        const playlistData = await playlistResponse.json() as PlaylistResponse;
                        
                        if (!playlistData.items || playlistData.items.length === 0) {
                            throw new Error('Playlist not found');
                        }
                        
                        // Get playlist name for display
                        sourceTitle = playlistData.items[0].snippet?.title ?? '';
                        
                        // Fetch videos from playlist with pagination support
                        let nextPageToken: string | null = null;
                        let videosCount = 0;
                        const MAX_RESULTS_PER_PAGE = 50; // YouTube API limit
                        const SAFETY_LIMIT = 50; // Safety limit to prevent excessive API calls
                        
                        do {
                            // Build URL with page token if we have one
                            let videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${MAX_RESULTS_PER_PAGE}&playlistId=${sourceId}&key=${API_KEY}`;
                            if (nextPageToken) {
                                videosUrl += `&pageToken=${nextPageToken}`;
                            }
                            
                            this.showNotice(nextPageToken ? t('notice.collection.fetchingPlaylistVideosMore') : t('notice.collection.fetchingPlaylistVideos'), 3000);
                            
                            const videosResponse = await obsidianFetch(videosUrl);
                            
                            if (!videosResponse.ok) {
                                throw new Error(`Failed to fetch playlist videos: HTTP status ${videosResponse.status}`);
                            }
                            
                            const videosData = await videosResponse.json() as PlaylistItemsResponse;
                            
                            if (!videosData.items || videosData.items.length === 0) {
                                break;
                            }
                            
                            // Extract video information and add to results
                            const pageVideos = videosData.items
                                .filter((item: YouTubePlaylistItem) => 
                                    !!item.snippet?.title && 
                                    !!item.snippet?.resourceId?.videoId)
                                .map((item: YouTubePlaylistItem) => ({
                                    title: item.snippet?.title ?? '',
                                    url: `https://www.youtube.com/watch?v=${item.snippet?.resourceId?.videoId ?? ''}`
                                }));
                                
                            videoResults = videoResults.concat(pageVideos);
                            videosCount += pageVideos.length;
                            
                            // Get next page token if available
                            nextPageToken = videosData.nextPageToken || null;
                            
                            // If we've reached our limit or safety limit, stop paginating
                            if ((limit > 0 && videosCount >= limit) || 
                                (limit === 0 && videosCount >= SAFETY_LIMIT)) {
                                // If we hit the safety limit, show a notice
                                if (limit === 0 && videosCount >= SAFETY_LIMIT) {
                                    this.showNotice(t('notice.collection.safetyLimit', { limit: SAFETY_LIMIT }), 5000);
                                }
                                break;
                            }
                            
                        } while (nextPageToken);
                    } else {
                        throw new Error('Could not extract playlist ID from URL');
                    }
                } else {
                    throw new Error('Invalid playlist URL format');
                }
            } else {
                // Handle channel URL
                sourceId = await this.getChannelIdFromInput(sourceUrl, API_KEY);
                
                if (!sourceId) {
                    throw new Error('Could not extract channel ID from URL');
                }
                
                // Get channel details
                const channelResponse = await obsidianFetch(
                    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${sourceId}&key=${API_KEY}`
                );
                
                if (!channelResponse.ok) {
                    throw new Error(`Failed to fetch channel data: HTTP status ${channelResponse.status}`);
                }
                
                const channelData = await channelResponse.json() as ChannelResponse;
                
                if (!channelData.items || channelData.items.length === 0) {
                    throw new Error('Channel not found');
                }
                
                // Get channel name for display
                sourceTitle = channelData.items[0].snippet?.title ?? '';
                
                // Get the uploads playlist ID
                const uploadsPlaylistId = channelData.items[0].contentDetails?.relatedPlaylists?.uploads ?? '';
                if (!uploadsPlaylistId) {
                    throw new Error('Channel uploads playlist not found');
                }
                
                // Get videos from the uploads playlist with pagination
                let nextPageToken: string | null = null;
                let videosCount = 0;
                const MAX_RESULTS_PER_PAGE = 50; // YouTube API limit
                const SAFETY_LIMIT = 50; // Safety limit to prevent excessive API calls
                
                do {
                    // Build URL with page token if we have one
                    let videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${MAX_RESULTS_PER_PAGE}&playlistId=${uploadsPlaylistId}&key=${API_KEY}`;
                    if (nextPageToken) {
                        videosUrl += `&pageToken=${nextPageToken}`;
                    }
                    
                    this.showNotice(nextPageToken ? t('notice.collection.fetchingChannelVideosMore') : t('notice.collection.fetchingChannelVideos'), 3000);
                    
                    const videosResponse = await obsidianFetch(videosUrl);
                    
                    if (!videosResponse.ok) {
                        throw new Error(`Failed to fetch videos: HTTP status ${videosResponse.status}`);
                    }
                    
                    const videosData = await videosResponse.json() as PlaylistItemsResponse;
                    
                    if (!videosData.items || videosData.items.length === 0) {
                        break;
                    }
                    
                    // Extract video information and add to results
                    const pageVideos = videosData.items
                        .filter((item: YouTubePlaylistItem) => 
                            !!item.snippet?.title && 
                            !!item.snippet?.resourceId?.videoId)
                        .map((item: YouTubePlaylistItem) => ({
                            title: item.snippet?.title ?? '',
                            url: `https://www.youtube.com/watch?v=${item.snippet?.resourceId?.videoId ?? ''}`
                        }));
                        
                    videoResults = videoResults.concat(pageVideos);
                    videosCount += pageVideos.length;
                    
                    // Get next page token if available
                    nextPageToken = videosData.nextPageToken || null;
                    
                    // If we've reached our limit or safety limit, stop paginating
                    if ((limit > 0 && videosCount >= limit) || 
                        (limit === 0 && videosCount >= SAFETY_LIMIT)) {
                        // If we hit the safety limit, show a notice
                        if (limit === 0 && videosCount >= SAFETY_LIMIT) {
                            this.showNotice(t('notice.collection.safetyLimit', { limit: SAFETY_LIMIT }), 5000);
                        }
                        break;
                    }
                    
                } while (nextPageToken);
            }
            
            // Show what we found
            this.showNotice(t('notice.collection.found', { title: sourceTitle, count: videoResults.length }), 3000);
            
            // Limit if needed (for specific requested limits)
            if (limit > 0 && videoResults.length > limit) {
                return videoResults.slice(0, limit);
            }
            
            return videoResults;
        } catch (error) {
            logger.error('Error fetching collection videos:', error);
            const errorMessage = getSafeErrorMessage(error);
            throw new Error(`Failed to fetch videos: ${errorMessage || 'Unknown error'}`);
        }
    }

    // Helper method to get channel ID from URL
    private async getChannelIdFromInput(channelUrl: string, apiKey: string): Promise<string> {
        // If it's already a channel ID format (UC...)
        if (channelUrl.includes('/channel/')) {
            const match = channelUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                return match[1];
            }
        }
        
        // Handle @handle format
        if (channelUrl.includes('/@')) {
            const match = channelUrl.match(/\/@([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                return await this.getChannelIdFromHandle(match[1], apiKey);
            }
        }
        
        // Handle /c/ format
        if (channelUrl.includes('/c/')) {
            const match = channelUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                throw new Error('Custom URL slugs (/c/) cannot be directly converted to channel IDs. Please use a channel URL with /channel/ or @handle format.');
            }
        }
        
        throw new Error('Could not extract channel identifier from URL');
    }
    
    // Helper method to get channel ID from handle
    private async getChannelIdFromHandle(handle: string, apiKey: string): Promise<string> {
        const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${apiKey}`;
        
        const response = await obsidianFetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch channel ID: HTTP status ${response.status}`);
        }
        
        const data = await response.json() as ChannelIdResponse;
        
        if (!data.items || data.items.length === 0) {
            throw new Error(`No channel found for handle: ${handle}`);
        }
        
        const channelId = data.items[0].id;
        if (!channelId) {
            throw new Error(`No channel ID found for handle: ${handle}`);
        }
        return channelId;
    }

    // Add timestamp links to section headings in an existing note using LLM.
    // `options.strict` (the job runner's path, #3 final review I1): every
    // failure inside the passes throws instead of being shown as a Notice
    // and swallowed, so the runner never finishes a job as "done" without
    // its timestamps. The strict pass also never translates: translation is
    // the runner's own checkpointed stage (translateNoteStrict). Legacy
    // callers (the collection path) pass nothing and keep the swallowing
    // behaviour, translation included, unchanged.
    async addSectionLinksToNote(filePath: string, videoUrl: string, options?: TimestampPassOptions): Promise<void> {
        try {
            // Extract video ID from URL
            const videoId = YouTubeTranscriptExtractor.extractVideoId(videoUrl);
            if (!videoId) {
                logger.error(`Could not extract video ID from URL: ${videoUrl}`);
            throw new Error(`Invalid Youtube URL: '${videoUrl}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
            }

            // Read the note content
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) {
                logger.error(`Could not find note file: ${filePath}`);
                throw new Error('Could not find note file');
            }

            // Log file info but don't do instanceof checks
            logger.debug(`File found: ${filePath}`);
            
            // Read the content using our custom interface
            const content = await this.app.vault.read(file);
            
            // Extract headings from the content
            const headings: string[] = [];
            const headingPositions: number[] = [];
            
            // Use a regex to find all headings (lines starting with #)
            const headingRegex = /^(#{1,6})\s+(.+)$/gm;
            let match;
            while ((match = headingRegex.exec(content)) !== null) {
                headings.push(match[2].trim());
                headingPositions.push(match.index);
            }

            if (headings.length === 0) {
                logger.debug('[addSectionLinksToNote] No headings found in note');
                return;
            }

            logger.debug(`[addSectionLinksToNote] Found ${headings.length} headings`);

            // Check if translation is needed
            const needsTranslation = this.settings.translateLanguage !== 'en' || this.settings.translateCountry !== 'US';
            
            // If we have more than 5 headings, use chunked processing
            let contentWithLinks;
            if (headings.length > 5) {
                contentWithLinks = await this.addTimestampLinksInChunks(
                    filePath,
                    videoId,
                    content,
                    headings,
                    headingPositions,
                    options
                );
            } else {
                contentWithLinks = await this.addTimestampLinksSinglePass(
                    filePath,
                    videoId,
                    content,
                    headings,
                    options
                );
            }
            
            // If translation is needed and we have content with links
            // (legacy path only: the runner translates in its own stage)
            if (!options?.strict && needsTranslation && contentWithLinks) {
                // Do a second pass for translation
                await this.translateContent(
                    filePath, 
                    contentWithLinks, 
                    this.settings.translateLanguage, 
                    this.settings.translateCountry
                );
            }
        } catch (error) {
            logger.error('[addSectionLinksToNote] Error:', error);
            throw error;
        } finally {
            // Stop the Anthropic proxy server if it was used
            if (this.settings.selectedLLM === 'anthropic') {
                logger.info('[addSectionLinksToNote] Completed Anthropic processing');
            }
        }
    }
    
    // Process document in a single pass to add timestamp links
    private async addTimestampLinksSinglePass(
        filePath: string, 
        videoId: string, 
        originalContent: string,
        headings: string[],
        options?: TimestampPassOptions
    ): Promise<string | null> {
        try {
            // Extract document components using the utility
            const { frontmatter, contentWithoutFrontmatter, transcript } = 
                extractDocumentComponents(originalContent);
            
            // Get the timestamp link configuration
            const timestampConfig = getTimestampLinkConfig(this.settings, videoId, this.getEffectiveMaxTokens());
            
            // Get the safely calculated max tokens from our updated method
            const maxTokens = this.getMaxTokensForTimestampPass();
            
            if (this.settings.debugLogging) {
                llmLogger.debug("[addTimestampLinksSinglePass] Using max tokens: " + maxTokens);
            }
            
            // Truncate transcript for very large transcripts to avoid token overflow
            let processedTranscript = transcript;
            if (transcript && transcript.length > 10000) {
                // For very large transcripts, truncate to a reasonable size
                processedTranscript = transcript.substring(0, 10000) + 
                    "\n[Transcript truncated to prevent token overflow]";
                
                if (this.settings.debugLogging) {
                    llmLogger.debug(`[addTimestampLinksSinglePass] Truncated transcript from ${transcript.length} to 10000 characters`);
                }
            }
            
            // Debug the timestamp config being passed
            const timestampModel = this.getModelForProvider(this.settings.selectedLLM);
            llmLogger.debug(`[TIMESTAMP DEBUG] Model: ${timestampModel}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] Temperature: ${timestampConfig.temperature}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] MaxTokens: ${maxTokens}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] SystemPrompt length: ${timestampConfig.systemPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] UserPrompt length: ${timestampConfig.userPrompt?.length || 'undefined'}`);
            llmLogger.debug(`[TIMESTAMP DEBUG] SelectedLLM: ${this.settings.selectedLLM}`);
            
            // Create specialized summarizer for timestamp linking
            const timestampLinkSummarizer = new TranscriptSummarizer({
                model: timestampModel,
                temperature: timestampConfig.temperature,
                maxTokens: maxTokens,
                systemPrompt: timestampConfig.systemPrompt,
                userPrompt: timestampConfig.userPrompt
            }, this.settings.apiKeys);
            
            // Add debug logging
            if (this.settings.debugLogging) {
                const maxTokens = this.getMaxTokensForTimestampPass();
                llmLogger.debug(`[addTimestampLinksSinglePass] Using ${maxTokens} tokens for timestamp linking`);
            }
            
            // Restructure the prompt with clear section labels for all providers
            const restructuredPrompt = 
                "INSTRUCTIONS:\n" + timestampConfig.userPrompt + "\n\n" +
                "INSTRUCTION INPUT DATA - TIMESTAMPS TRANSCRIPT:\n" + 
                (processedTranscript ? processedTranscript : "No transcript available") + "\n\n" +
                "INPUT NOTE TO BE MODIFIED WITH TIMESTAMPS:\n" + contentWithoutFrontmatter;
            
            // Send to LLM for processing
            this.showNotice(t('notice.timestamps.adding'), 5000);
            
            // Log detailed information when debug logging is enabled
            if (this.settings.debugLogging) {
                llmLogger.debug("==================== TIMESTAMP LINKING DEBUG ====================");
                llmLogger.debug(`Processing file: ${filePath}`);
                llmLogger.debug(`Video ID: ${videoId}`);
                llmLogger.debug(`System Prompt: ${timestampConfig.systemPrompt}`);
                llmLogger.debug(`User Prompt (first 500 chars): ${timestampConfig.userPrompt.substring(0, 500)}...`);
                llmLogger.debug(`Restructured Prompt (first 500 chars): ${restructuredPrompt.substring(0, 500)}...`);
                
                // Check if transcript contains TimeIndex markers
                if (processedTranscript) {
                    const timeIndexInTranscript = processedTranscript.match(/\[TimeIndex:\d+\]/g);
                    if (timeIndexInTranscript) {
                        llmLogger.debug(`✅ Transcript contains ${timeIndexInTranscript.length} TimeIndex markers`);
                        llmLogger.debug(`First few TimeIndex markers: ${timeIndexInTranscript.slice(0, 5).join(', ')}`);
                    } else {
                        llmLogger.debug("❌ No TimeIndex markers found in transcript");
                    }
                } else {
                    llmLogger.debug("❌ No transcript provided to LLM");
                }
                llmLogger.debug(`Number of headings found: ${headings.length}`);
                llmLogger.debug(`First few headings: ${headings.slice(0, 3).join(', ')}${headings.length > 3 ? '...' : ''}`);
                llmLogger.debug(`LLM Provider: ${this.settings.selectedLLM}`);
                llmLogger.debug(`Model: ${this.settings.selectedModels[this.settings.selectedLLM]}`);
                llmLogger.debug(`Max tokens: ${maxTokens}`);
                llmLogger.debug(`Temperature: ${timestampConfig.temperature}`);
                
                // Estimate tokens for log
                const contentTokens = Math.ceil(contentWithoutFrontmatter.length / 4);
                const transcriptTokens = Math.ceil((processedTranscript?.length || 0) / 4);
                llmLogger.debug(`Estimated content tokens: ${contentTokens}`);
                llmLogger.debug(`Estimated transcript tokens: ${transcriptTokens}`);
                llmLogger.debug(`Estimated total input tokens: ${contentTokens + transcriptTokens}`);
                
                // Log the system prompt
                llmLogger.debug("SYSTEM PROMPT:");
                llmLogger.debug("----------------------------------------");
                llmLogger.debug(truncateForLogs(timestampConfig.systemPrompt, 200));
                llmLogger.debug("----------------------------------------");
                
                // Log the user prompt
                llmLogger.debug("USER PROMPT:");
                llmLogger.debug("----------------------------------------");
                llmLogger.debug(truncateForLogs(timestampConfig.userPrompt, 200));
                llmLogger.debug("----------------------------------------");
                
                // Log content being processed
                llmLogger.debug("CONTENT BEING PROCESSED:");
                llmLogger.debug("----------------------------------------");
                llmLogger.debug(truncateForLogs(contentWithoutFrontmatter, 500));
                llmLogger.debug("----------------------------------------");
                
                // Log transcript excerpt
                if (processedTranscript) {
                    llmLogger.debug("TRANSCRIPT EXCERPT:");
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(truncateForLogs(processedTranscript, 300));
                    llmLogger.debug("----------------------------------------");
                } else {
                    llmLogger.debug("NO TRANSCRIPT FOUND IN FRONTMATTER");
                }
                
                // Log the complete formatted prompt
                llmLogger.debug("COMPLETE FORMATTED PROMPT BEING SENT TO LLM:");
                llmLogger.debug("========================================");
                llmLogger.debug(truncateForLogs(restructuredPrompt, 400));
                llmLogger.debug("========================================");
            }
            
            logger.debug("[addTimestampLinksSinglePass] Sending content to LLM (without frontmatter)...");
            
            let enhancedContent;
            try {
                llmLogger.debug(`[TIMESTAMP DEBUG] About to call summarize with provider: '${this.settings.selectedLLM}'`);
                llmLogger.debug(`[TIMESTAMP DEBUG] Full settings.selectedLLM value:`, this.settings.selectedLLM);
                enhancedContent = await timestampLinkSummarizer.summarize(
                    restructuredPrompt, 
                    this.settings.selectedLLM
                );
                
                // Debug log the entire response if debug logging is enabled
                if (this.settings.debugLogging) {
                    llmLogger.debug("LLM RESPONSE:");
                    llmLogger.debug("========================================");
                    llmLogger.debug(truncateForLogs(enhancedContent || "Empty response from LLM", 400));
                    llmLogger.debug("========================================");
                    
                    // Check for TimeIndex markers in the response
                    const timeIndexMatches = enhancedContent ? enhancedContent.match(/\[TimeIndex:\d+\]/g) : null;
                    if (timeIndexMatches) {
                        llmLogger.debug(`✅ Found ${timeIndexMatches.length} TimeIndex markers: ${timeIndexMatches.join(', ')}`);
                    } else {
                        llmLogger.debug("❌ No TimeIndex markers found in LLM response");
                    }
                    
                    // Check for Watch URLs in the response (shouldn't be there with new prompt)
                    const watchMatches = enhancedContent ? enhancedContent.match(/\[Watch\]\(https:\/\/www\.youtube\.com\/watch\?v=[^)]+\)/g) : null;
                    if (watchMatches) {
                        llmLogger.debug(`⚠️ Found ${watchMatches.length} Watch URLs (old format): ${watchMatches.slice(0, 3).join(', ')}`);
                    }
                }
                
                logger.debug("[addTimestampLinksSinglePass] Received LLM response, length:", enhancedContent ? enhancedContent.length : 0);
            } catch (e) {
                logger.error("[addTimestampLinksSinglePass] Error during LLM call:", e);
                const errorMessage = getSafeErrorMessage(e);
                
                // In case of token limit errors, reduce the maxTokens and try again.
                // Not on the strict (runner) path: the retry would be a second
                // billed call inside one counted attempt (spec F6); there the
                // runner's own visible attempt budget is the retry.
                if (!options?.strict && (errorMessage.includes("max_tokens") || errorMessage.includes("token limit"))) {
                    logger.debug("[addTimestampLinksSinglePass] Token limit error detected, retrying with reduced token limit");
                    this.showNotice(t('notice.timestamps.retrying'), 5000);
                    
                    // Significantly reduce token limit for retry (50% of previous)
                    const reducedTokens = Math.floor(maxTokens * 0.5);
                    
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`Retrying with reduced token limit: ${reducedTokens}`);
                    }
                    
                    // Create a new summarizer with reduced tokens but same config otherwise
                    const reducedTokensSummarizer = new TranscriptSummarizer({
                        model: this.getModelForProvider(this.settings.selectedLLM),
                        temperature: timestampConfig.temperature,
                        maxTokens: reducedTokens,
                        systemPrompt: timestampConfig.systemPrompt,
                        userPrompt: timestampConfig.userPrompt
                    }, this.settings.apiKeys);
                    
                    try {
                        enhancedContent = await reducedTokensSummarizer.summarize(
                            restructuredPrompt, 
                            this.settings.selectedLLM
                        );
                        
                        // Debug log the entire response after retry if debug logging is enabled
                        if (this.settings.debugLogging) {
                            llmLogger.debug("LLM RESPONSE AFTER RETRY:");
                            llmLogger.debug("========================================");
                            llmLogger.debug(truncateForLogs(enhancedContent || "Empty response from LLM", 800));
                            llmLogger.debug("========================================");
                        }
                        
                        logger.debug("[addTimestampLinksSinglePass] Second attempt successful with reduced tokens:", reducedTokens);
                    } catch (retryError) {
                        logger.error("[addTimestampLinksSinglePass] Error on second attempt:", retryError);
                        const retryMessage = getSafeErrorMessage(retryError);
                        this.showNotice(t('notice.timestamps.failed', { error: retryMessage }), 5000);
                        return null;
                    }
                } else {
                    const failure = timestampPassFailure(options, `Error adding timestamp links: ${errorMessage}`, e);
                    if (failure.kind === "throw") {
                        throw failure.error;
                    }
                    this.showNotice(failure.notice, 5000);
                    return null;
                }
            }
            
            if (!enhancedContent) {
                logger.error("[addTimestampLinksSinglePass] Failed to add timestamp links (empty response from LLM)");
                const failure = timestampPassFailure(options, "Failed to add timestamp links (empty response from LLM)");
                if (failure.kind === "throw") {
                    throw failure.error;
                }
                this.showNotice(failure.notice, 5000);
                return null;
            }
            
            // First validate that we received TimeIndex markers from the LLM
            if (!enhancedContent.includes('[TimeIndex:')) {
                logger.warn("[addTimestampLinksSinglePass] No TimeIndex markers found in LLM response");
                const failure = timestampPassFailure(options, "LLM did not add TimeIndex markers to headings");
                if (failure.kind === "throw") {
                    throw failure.error;
                }
                this.showNotice(failure.notice, 5000);
                return null;
            }
            
            // Reconstruct the document with original frontmatter and enhanced content
            let enhancedNote = reconstructDocument(frontmatter, enhancedContent);
            
            // Convert TimeIndex markers to Watch URLs ONLY in content, preserving frontmatter transcript
            const { frontmatter: extractedFrontmatter, contentWithoutFrontmatter: extractedContent } = extractDocumentComponents(enhancedNote);
            const convertedContent = convertTimeIndexToWatchUrls(extractedContent, videoId);
            enhancedNote = reconstructDocument(extractedFrontmatter, convertedContent);
            
            // Validate the final enhanced note with Watch URLs
            if (validateEnhancedContent(enhancedNote, contentWithoutFrontmatter, headings, videoId)) {
                // Update the note file with the LLM-enhanced content — only if
                // it still reads exactly as it did before the LLM call (F5).
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    if (!(await writeIfUnchanged(this.app.vault, file, originalContent, enhancedNote))) {
                        throw new NoteChangedError(NOTE_EDITED_DURING_TIMESTAMPS);
                    }
                } else {
                    logger.error(`[addTimestampLinksSinglePass] File not found: ${filePath}`);
                    const failure = timestampPassFailure(options, `Error: File not found: ${filePath}`);
                    if (failure.kind === "throw") {
                        throw failure.error;
                    }
                    this.showNotice(failure.notice, 5000);
                    return null;
                }
                
                // Count number of section headings with links (use final converted note)
                const linkCount = countTimestampLinks(enhancedNote);
                this.showNotice(t('notice.timestamps.added', { count: linkCount }), 5000);
                
                // Log the final output if debug logging is enabled
                if (this.settings.debugLogging) {
                    llmLogger.debug("TIMESTAMP LINKING SUCCESSFUL");
                    llmLogger.debug(`Added ${linkCount} timestamp links`);
                    llmLogger.debug("========================================");
                }
                
                // Return the enhanced content for potential translation
                return enhancedContent;
            }
            
            // Log validation failure if debug logging is enabled
            if (this.settings.debugLogging) {
                llmLogger.debug("TIMESTAMP LINKING VALIDATION FAILED");
                llmLogger.debug("Validation of enhanced content against original content failed");
                llmLogger.debug("========================================");
            }
            
            if (options?.strict) {
                throw new Error("Timestamp links could not be validated against the note");
            }
            return null;
        } catch (error) {
            if (error instanceof NoteChangedError) {
                throw error; // the caller decides; never swallowed into a null return
            }
            logger.error("[addTimestampLinksSinglePass] Error:", error);
            const errorMessage = getSafeErrorMessage(error);
            const failure = timestampPassFailure(options, `Error adding timestamp links: ${errorMessage}`, error);
            if (failure.kind === "throw") {
                throw failure.error;
            }
            this.showNotice(failure.notice, 5000);
            return null;
        }
    }
    
    // New method to translate content
    private async translateContent(
        filePath: string,
        contentToTranslate: string,
        targetLang: string,
        targetCountry: string
    ): Promise<void> {
        try {
            const targetLocale = `${targetLang.toUpperCase()}-${targetCountry}`;
            this.showNotice(t('notice.translate.starting', { locale: targetLocale }), 5000);
            logger.debug("[translateContent] Starting translation process");
            
            // Extract document components using the utility
            const noteFile = this.app.vault.getAbstractFileByPath(filePath);
            if (!(noteFile instanceof TFile)) {
                logger.error(`[translateContent] File not found: ${filePath}`);
                this.showNotice(t('notice.file.notFound', { path: filePath }), 5000);
                return;
            }
            const fileContent = await this.app.vault.read(noteFile);
            const { frontmatter } = extractDocumentComponents(fileContent);
            
            // Create a specialized summarizer for translation
            const translationSummarizer = new TranscriptSummarizer({
                model: this.getModelForProvider(this.settings.selectedLLM),
                temperature: 0.3, // Lower temperature for more accurate translations
                maxTokens: this.getMaxTokensForTimestampPass(),
                systemPrompt: "You are a highly accurate translator who preserves all formatting, links, and structure when translating content.",
                userPrompt: "Translate the following content while preserving all Markdown formatting, links, and structure:"
            }, this.settings.apiKeys);
            
            // Create the translation prompt
            const translationPrompt = `
TRANSLATION TASK: Translate the following content into ${targetLang.toUpperCase()}-${targetCountry}.

RULES:
1. Preserve all Markdown formatting, especially section headings with # syntax
2. Keep all links intact, especially YouTube timestamp [Watch] links
3. Maintain the same overall structure and organization
4. Translate everything else, including headings, paragraphs, and lists
5. Keep technical terms, proper names, and specific terminology in their original form when appropriate
6. Ensure the translation sounds natural in the target language

CONTENT TO TRANSLATE:

${contentToTranslate}
`;
            
            // Send to LLM for translation
            let translatedContent;
            try {
                translatedContent = await translationSummarizer.summarize(translationPrompt, this.settings.selectedLLM);
                logger.debug("[translateContent] Received translated content, length:", translatedContent ? translatedContent.length : 0);
            } catch (e) {
                logger.error("[translateContent] Error during translation:", e);
                const errorMessage = getSafeErrorMessage(e);
                this.showNotice(t('notice.translate.failed', { error: errorMessage }), 5000);
                return;
            }
            
            if (!translatedContent) {
                logger.error("[translateContent] Failed to translate content (empty response)");
                this.showNotice(t('notice.translate.emptyResponse'), 5000);
                return;
            }
            
            // Reconstruct the document with original frontmatter and translated content
            const translatedNote = reconstructDocument(frontmatter, translatedContent);
            
            // Update the note file with the translated content — only if it
            // still reads exactly as it did before the LLM call (F5).
            if (!(await writeIfUnchanged(this.app.vault, noteFile, fileContent, translatedNote))) {
                throw new NoteChangedError(NOTE_EDITED_DURING_TRANSLATION);
            }
            this.showNotice(t('notice.translate.done', { locale: targetLocale }), 5000);
            
        } catch (error) {
            if (error instanceof NoteChangedError) {
                throw error;
            }
            logger.error("[translateContent] Error:", error);
            const errorMessage = getSafeErrorMessage(error);
            this.showNotice(t('notice.translate.failed', { error: errorMessage }), 5000);
        }
    }

    /**
     * Strict translation pass for the job runner's `translation` stage (#3 final review residual). The
     * target pair is the RECORD's frozen one (the adapter passes it), never the live settings. Reads the
     * note, translates its body, and writes back only if the note still reads exactly as it did before
     * the LLM call (F5) — otherwise NoteChangedError. Every other failure is RETHROWN: no Notice, nothing
     * swallowed, so the runner interrupts the job as resumable (or the user finishes without translation)
     * instead of reporting an untranslated note as a success. The prompt and summarizer configuration are
     * those of translateContent (the legacy pass, kept byte-for-byte for the collection path).
     */
    async translateNoteStrict(notePath: string, language: string, country: string): Promise<void> {
        const noteFile = this.app.vault.getAbstractFileByPath(notePath);
        if (!(noteFile instanceof TFile)) {
            logger.error(`[translateNoteStrict] File not found: ${notePath}`);
            throw new Error('Could not find note file');
        }
        const fileContent = await this.app.vault.read(noteFile);
        const { frontmatter, contentWithoutFrontmatter } = extractDocumentComponents(fileContent);

        const translationSummarizer = new TranscriptSummarizer({
            model: this.getModelForProvider(this.settings.selectedLLM),
            temperature: 0.3, // Lower temperature for more accurate translations
            maxTokens: this.getMaxTokensForTimestampPass(),
            systemPrompt: "You are a highly accurate translator who preserves all formatting, links, and structure when translating content.",
            userPrompt: "Translate the following content while preserving all Markdown formatting, links, and structure:"
        }, this.settings.apiKeys);

        const translationPrompt = `
TRANSLATION TASK: Translate the following content into ${language.toUpperCase()}-${country}.

RULES:
1. Preserve all Markdown formatting, especially section headings with # syntax
2. Keep all links intact, especially YouTube timestamp [Watch] links
3. Maintain the same overall structure and organization
4. Translate everything else, including headings, paragraphs, and lists
5. Keep technical terms, proper names, and specific terminology in their original form when appropriate
6. Ensure the translation sounds natural in the target language

CONTENT TO TRANSLATE:

${contentWithoutFrontmatter}
`;

        // Rethrows: the runner classifies the failure (transient → interrupted, resumable).
        const translatedContent = await translationSummarizer.summarize(translationPrompt, this.settings.selectedLLM);
        logger.debug("[translateNoteStrict] Received translated content, length:", translatedContent ? translatedContent.length : 0);
        if (!translatedContent) {
            throw new Error('Failed to translate content (empty response from LLM)');
        }

        const translatedNote = reconstructDocument(frontmatter, translatedContent);
        // Guarded against exactly the content read above (F5).
        if (!(await writeIfUnchanged(this.app.vault, noteFile, fileContent, translatedNote))) {
            throw new NoteChangedError(NOTE_EDITED_DURING_TRANSLATION);
        }
    }

    // Validate just the enhanced content without checking frontmatter
    private validateEnhancedContentOnly(enhancedContent: string, originalContent: string, headings: string[]): boolean {
        // This method has been replaced by the validateEnhancedContent utility
        return validateEnhancedContent(enhancedContent, originalContent, headings, "");
    }

    // Process document in chunks based on section headings
    private async addTimestampLinksInChunks(
        filePath: string,
        videoId: string,
        originalContent: string,
        headings: string[],
        _headingPositions: number[],
        options?: TimestampPassOptions
    ): Promise<string | null> {
        try {
            logger.debug("[addTimestampLinksInChunks] Processing document in chunks");
            
            // Extract document components using the utility
            const { frontmatter, contentWithoutFrontmatter, transcript } = 
                extractDocumentComponents(originalContent);
            
            // Log debug info about chunking if enabled
            if (this.settings.debugLogging) {
                llmLogger.debug("==================== CHUNKED TIMESTAMP LINKING DEBUG ====================");
                llmLogger.debug(`Processing file: ${filePath} in chunks`);
                llmLogger.debug(`Video ID: ${videoId}`);
                llmLogger.debug(`Number of headings found: ${headings.length}`);
                llmLogger.debug(`Original content length: ${contentWithoutFrontmatter.length} characters`);
                llmLogger.debug(`Transcript length: ${transcript ? transcript.length : 0} characters`);
            }
            
            // Create optimized chunks based on heading positions
            const maxTokenLimit = this.getMaxTokensForTimestampPass();
            const chunks = createOptimizedChunks(contentWithoutFrontmatter, maxTokenLimit);
            
            if (this.settings.debugLogging) {
                llmLogger.debug(`Split content into ${chunks.length} optimized chunks`);
                llmLogger.debug(`Chunk sizes: ${chunks.map(c => c.length).join(', ')} characters`);
            }
            
            logger.debug(`[addTimestampLinksInChunks] Split content into ${chunks.length} optimized chunks`);
            
            // Process each chunk separately
            let processedChunks: string[] = [];
            
            // We're still in the second LLM pass, just breaking it into smaller chunks
            // The first LLM pass already created the note content, now we're adding timestamp links
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                
                // Skip chunks without proper heading (including template header)
                if (!hasProperHeading(chunk)) {
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`Chunk ${i+1}: No proper headings found, preserving unchanged`);
                    }
                    
                    logger.debug(`[addTimestampLinksInChunks] Preserving non-section chunk ${i+1} unchanged`);
                    // Ensure chunk ends with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                    continue;
                }
                
                if (this.settings.debugLogging) {
                    llmLogger.debug(`\n===== PROCESSING CHUNK ${i+1} of ${chunks.length} =====`);
                    llmLogger.debug(`Chunk size: ${chunk.length} characters`);
                    
                    // Extract and show headings in this chunk
                    const chunkHeadings: string[] = [];
                    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
                    let match;
                    while ((match = headingRegex.exec(chunk)) !== null) {
                        chunkHeadings.push(match[2].trim());
                    }
                    
                    llmLogger.debug(`Headings in chunk ${i+1}: ${chunkHeadings.join(', ')}`);
                }
                
                logger.debug(`[addTimestampLinksInChunks] Processing chunk ${i+1} of ${chunks.length}, length: ${chunk.length}`);
                this.showNotice(t('notice.timestamps.chunkProgress', { current: i + 1, total: chunks.length }), 2000);
                
                // Get timestamp link configuration
                const timestampConfig = getTimestampLinkConfig(this.settings, videoId, this.getEffectiveMaxTokens());
                
                // Construct reference section with clear instructions not to include in output
                // Reduce transcript size on mobile to prevent token overflow
                let transcriptContent = "";
                if (Platform.isMobile && transcript.length > 5000) {
                    // On mobile with large transcripts, keep only a portion to save tokens
                    transcriptContent = transcript.substring(0, 5000) + "\n[Transcript truncated for mobile processing]";
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`Truncated transcript on mobile from ${transcript.length} to 5000 characters`);
                    }
                } else {
                    transcriptContent = transcript.length > 0 ? 
                        transcript : 
                        "No transcript available, use default timestamps starting at 0 seconds.";
                }
                
                // Restructure the prompt with clear section labels for all providers
                const restructuredPrompt = 
                    "INSTRUCTIONS:\n" + timestampConfig.userPrompt + "\n\n" +
                    "INSTRUCTION INPUT DATA - TIMESTAMPS TRANSCRIPT:\n" + transcriptContent + "\n\n" +
                    "INPUT NOTE TO BE MODIFIED WITH TIMESTAMPS:\n" + chunk;
                
                if (this.settings.debugLogging) {
                    llmLogger.debug(`CHUNK ${i+1} PROMPT:`);
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(truncateForLogs(timestampConfig.userPrompt, 400));
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(`CHUNK ${i+1} CONTENT:`);
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(truncateForLogs(chunk, 400));
                    llmLogger.debug("----------------------------------------");
                    llmLogger.debug(`CHUNK ${i+1} COMPLETE FORMATTED PROMPT:`);
                    llmLogger.debug("========================================");
                    llmLogger.debug(truncateForLogs(restructuredPrompt, 400));
                    llmLogger.debug("========================================");
                }
                
                try {
                    // Get tokens from our simplified method
                    const maxTokens = this.getMaxTokensForTimestampPass();
                    
                    // For debugging, log content and transcript info
                    if (this.settings.debugLogging) {
                        // Estimate token counts for logs only
                        const contentLength = chunk.length;
                        const transcriptLength = transcriptContent.length;
                        const estimatedContentTokens = Math.ceil(contentLength / 4);
                        const estimatedTranscriptTokens = Math.ceil(transcriptLength / 4);
                        
                        llmLogger.debug(`[addTimestampLinksInChunks] Content length: ${contentLength} chars (est. ${estimatedContentTokens} tokens)`);
                        llmLogger.debug(`[addTimestampLinksInChunks] Transcript length: ${transcriptLength} chars (est. ${estimatedTranscriptTokens} tokens)`);
                        llmLogger.debug(`[addTimestampLinksInChunks] Using max tokens: ${maxTokens}`);
                    }
                    
                    logger.debug(`[addTimestampLinksInChunks] Using ${maxTokens} tokens for chunk ${i+1}`);
                    
                    // Safety check - if tokens are invalid, skip processing this chunk
                    if (maxTokens <= 0) {
                        logger.warn(`[addTimestampLinksInChunks] Invalid token value for chunk ${i+1}, skipping processing`);
                        processedChunks.push(ensureTrailingNewline(chunk));
                        continue;
                    }
                    
                    const chunkSummarizer = new TranscriptSummarizer({
                        model: this.getModelForProvider(this.settings.selectedLLM),
                        temperature: timestampConfig.temperature,
                        maxTokens: maxTokens,
                        systemPrompt: timestampConfig.systemPrompt,
                        userPrompt: timestampConfig.userPrompt // Use the base prompt, not the complete chunk prompt
                    }, this.settings.apiKeys);
                    
                    // Process the chunk
                    const processedChunk = await chunkSummarizer.summarize(
                        restructuredPrompt, 
                        this.settings.selectedLLM
                    );
                    
                    // Log LLM response for this chunk if debug is enabled
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`CHUNK ${i+1} LLM RESPONSE:`);
                        llmLogger.debug("========================================");
                        llmLogger.debug(truncateForLogs(processedChunk || "Empty response from LLM", 400));
                        llmLogger.debug("========================================");
                    }
                    
                    if (processedChunk) {
                        // Validate processed chunk has timestamp link
                        const hasLink = hasTimestampLinks(processedChunk, videoId);
                        
                        // Log link validation result if debug is enabled
                        if (this.settings.debugLogging) {
                            llmLogger.debug(`CHUNK ${i+1} has timestamp links: ${hasLink}`);
                            
                            if (hasLink) {
                                const linkCount = countTimestampLinks(processedChunk);
                                llmLogger.debug(`CHUNK ${i+1} contains ${linkCount} timestamp links`);
                            }
                        }
                        
                        // Ensure chunk ends with a newline to prevent wrapping
                        let finalChunk = ensureTrailingNewline(processedChunk);
                        
                        if (hasLink) {
                            processedChunks.push(finalChunk);
                        } else {
                            logger.warn("[addTimestampLinksInChunks] No timestamp link added to chunk", i+1);
                            // Push original chunk with newline
                            processedChunks.push(ensureTrailingNewline(chunk));
                        }
                    } else {
                        logger.warn("[addTimestampLinksInChunks] Empty response for chunk", i+1);
                        // Push original chunk with newline
                        processedChunks.push(ensureTrailingNewline(chunk));
                    }
                } catch (e) {
                    logger.error(`[addTimestampLinksInChunks] Error processing chunk ${i+1}:`, e);
                    
                    // Strict: a failed chunk fails the pass (no partial write).
                    const failure = timestampPassFailure(options, `Error processing chunk ${i+1}: ${getSafeErrorMessage(e)}`, e);
                    if (failure.kind === "throw") {
                        throw failure.error;
                    }
                    
                    if (this.settings.debugLogging) {
                        llmLogger.debug(`ERROR PROCESSING CHUNK ${i+1}:`);
                        llmLogger.debug(getSafeErrorMessage(e));
                        llmLogger.debug(`Using original chunk content instead`);
                    }
                    
                    // Push original chunk with newline
                    processedChunks.push(ensureTrailingNewline(chunk));
                }
            }
            
            // Reconstruct document: frontmatter + processed content
            const combinedContent = processedChunks.join("");
            let combinedNote = reconstructDocument(frontmatter, combinedContent);
            
            // Convert TimeIndex markers to Watch URLs ONLY in content, preserving frontmatter transcript
            const { frontmatter: extractedFrontmatter, contentWithoutFrontmatter: extractedContent } = extractDocumentComponents(combinedNote);
            const convertedContent = convertTimeIndexToWatchUrls(extractedContent, videoId);
            combinedNote = reconstructDocument(extractedFrontmatter, convertedContent);
            
            // Verify we have some timestamp links (count from the converted note)
            const linkCount = countTimestampLinks(combinedNote);
            
            if (this.settings.debugLogging) {
                llmLogger.debug("CHUNKED PROCESSING COMPLETE");
                llmLogger.debug(`Total timestamp links found: ${linkCount}`);
                
                if (linkCount > 0) {
                    llmLogger.debug("CHUNKED PROCESSING SUCCESSFUL");
                } else {
                    llmLogger.debug("CHUNKED PROCESSING FAILED - No timestamp links added");
                }
                
                llmLogger.debug("========================================");
            }
            
            if (linkCount > 0) {
                // Update the note file with the combined content — only if it
                // still reads exactly as it did before the LLM calls (F5).
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    if (!(await writeIfUnchanged(this.app.vault, file, originalContent, combinedNote))) {
                        throw new NoteChangedError(NOTE_EDITED_DURING_TIMESTAMPS);
                    }
                } else {
                    logger.error(`[addTimestampLinksInChunks] File not found: ${filePath}`);
                    const failure = timestampPassFailure(options, `Error: File not found: ${filePath}`);
                    if (failure.kind === "throw") {
                        throw failure.error;
                    }
                    this.showNotice(failure.notice, 5000);
                    return null;
                }
                
                this.showNotice(t('notice.timestamps.addedChunked', { count: linkCount }), 5000);
                
                // Return the combined content for potential translation
                return combinedContent;
            } else {
                logger.error("[addTimestampLinksInChunks] No timestamp links were added in any chunk");
                const failure = timestampPassFailure(options, "Failed to add any timestamp links");
                if (failure.kind === "throw") {
                    throw failure.error;
                }
                this.showNotice(failure.notice, 5000);
                return null;
            }
        } catch (error) {
            if (error instanceof NoteChangedError) {
                throw error;
            }
            logger.error("[addTimestampLinksInChunks] Error:", error);
            const errorMessage = getSafeErrorMessage(error);
            const failure = timestampPassFailure(options, `Error in chunked processing: ${errorMessage}`, error);
            if (failure.kind === "throw") {
                throw failure.error;
            }
            this.showNotice(failure.notice, 5000);
            return null;
        }
    }

    // Validate the enhanced note meets all quality checks
    private validateEnhancedNote(enhancedNote: string, originalContent: string, headings: string[]): boolean {
        // This method has been replaced by the validateEnhancedContent utility
        return validateEnhancedContent(enhancedNote, originalContent, headings, "");
    }

    // Method to get appropriate max tokens for the timestamp linking pass based on the model
    private getMaxTokensForTimestampPass(): number {
        // Get the user's configured maxTokens setting
        const configuredMaxTokens = this.settings.maxTokens;
        
        // Get the selected LLM provider and model
        const selectedProvider = this.settings.selectedLLM as Provider;
        const selectedModel = this.settings.selectedModels[selectedProvider] || 'gpt-4o'; // fallback to gpt-4o if not set
        
        try {
            // Use effective max tokens calculation (same as main summarization, respects custom model params)
            const effectiveMaxTokens = this.getEffectiveMaxTokens();
            
            // Apply 85% multiplier for timestamp linking (conservative approach)
            let tokensToUse = Math.floor(effectiveMaxTokens * 0.85);
            
            if (this.settings.debugLogging) {
                logger.debug(`[getMaxTokensForTimestampPass] Using ${tokensToUse} tokens (85% of effective limit ${effectiveMaxTokens}, configured: ${configuredMaxTokens}, model: ${selectedProvider}:${selectedModel}, platform: ${Platform.isMobile ? 'mobile' : 'desktop'})`);
            }
            
            return tokensToUse;
            
        } catch (error) {
            // Fallback to legacy calculation if dynamic calculation fails
            if (this.settings.debugLogging) {
                logger.debug(`[getMaxTokensForTimestampPass] Dynamic calculation failed, using legacy fallback: ${error}`);
            }
            
            // Legacy hard limits for fallback
            const LEGACY_LIMITS: Record<string, number> = {
                'openai': 4096,
                'anthropic': 4096,
                'google': 8192,
                'ollama': 4096,
                'default': 4096
            };
            
            const providerHardLimit = LEGACY_LIMITS[selectedProvider] || LEGACY_LIMITS.default;
            let tokensToUse = Math.floor(configuredMaxTokens * 0.85);
            tokensToUse = Math.min(tokensToUse, providerHardLimit - 100);
            
            return tokensToUse;
        }
    }

    private sanitizePathComponent(text: string): string {
        // Use the utility function instead of duplicating code
        return sanitizePathComponent(text);
    }

    /**
     * Get the effective maxTokens for the current provider and model
     * Uses registry values for known models, custom model limits for user-defined models, 
     * or falls back to current setting
     */
    public getEffectiveMaxTokens(): number {
        const provider = this.settings.selectedLLM as Provider;
        const model = this.settings.selectedModels[provider];
        const defaultReserve = provider === 'ollama' ? 0.15 : 0.10;

        try {
            // Check if user has defined custom limits for this model — checked
            // first so that a fetched-but-unknown model auto-populated by
            // getCurrentCustomLimits picks up the panel's values rather than
            // falling back to settings.maxTokens (which would be stale from
            // the previous model's effective computation).
            const customKey = `${provider}:${model}`;
            const customLimits = this.settings.customModelLimits[customKey];
            if (customLimits) {
                const reserve = customLimits.reservePct ?? defaultReserve;
                const maxOutput = customLimits.maxOutputK * 1000; // K → tokens
                return Math.floor(maxOutput * (1 - reserve));
            }

            // Then check the registry for known models.
            if (isModelSupported(provider, model)) {
                const limits = getEffectiveLimits(provider, model);
                return limits.maxOutputEff;
            }

            // No override and not in registry — compute from the same
            // conservative defaults the panel uses (16k maxOutput * 0.90 reserve).
            // This keeps the model-change "Output budget" notice consistent with
            // the panel's displayed values, instead of returning whatever was
            // last saved in settings.maxTokens (which is the *previous*
            // model's effective value and confuses the user).
            return Math.floor(16_000 * (1 - defaultReserve));
        } catch {
            // Same conservative fallback if anything goes wrong.
            return Math.floor(16_000 * (1 - defaultReserve));
        }
    }

    /**
     * Register a custom model with the dynamic registry
     */
    public registerCustomModel(provider: Provider, modelId: string, limits: {
        contextK: number;
        maxOutputK: number;
        inputMaxK?: number;
        reservePct?: number;
    }): void {
        // Convert K values to actual tokens and register with the dynamic registry
        upsertModel(provider, modelId, {
            context: limits.contextK * 1000,
            maxOutput: limits.maxOutputK * 1000,
            inputMax: limits.inputMaxK ? limits.inputMaxK * 1000 : undefined,
            reserveOutputPct: limits.reservePct ?? (provider === 'ollama' ? 0.15 : 0.10)
        });
    }

    async fetchOpenAIModels(apiKey: string): Promise<FetchedModelInfo[]> {
        if (!apiKey || apiKey.trim() === "") {
            this.showNotice(t('notice.models.apiKeyMissing', { provider: 'OpenAI' }), 5000);
            logger.warn("[fetchOpenAIModels] OpenAI API key is missing.");
            return [];
        }

        const url = "https://api.openai.com/v1/models";
        try {
            this.showNotice(t('notice.models.fetching', { provider: 'OpenAI' }), 3000);
            const response = await obsidianFetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText })) as ApiErrorResponse;
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchOpenAIModels] Failed to fetch OpenAI models: ${errorMessage}`);
                this.showNotice(t('notice.models.fetchFailed', { provider: 'OpenAI', error: errorMessage }), 5000);
                return [];
            }

            const data = await response.json() as OpenAIModelsResponse;
            if (data && Array.isArray(data.data)) {
                // OpenAI API does not return context/output limits — limits stay in the hardcoded registry
                const models: FetchedModelInfo[] = data.data
                    .map((model: OpenAIModel) => model.id)
                    .filter((id: string) => id.includes('gpt') || id.includes('text-davinci'))
                    .sort()
                    .map(id => ({ id }));

                // Persist discovered IDs so the dropdown survives a settings-tab re-render (update()).
                // OpenAI's API returns no token limits, so customModelLimits is
                // never written to here — fetchedModels is the only signal that
                // these models exist for this provider.
                this.settings.fetchedModels = {
                    ...this.settings.fetchedModels,
                    openai: models.map(m => m.id),
                };
                await this.saveSettings();

                logger.info(`[fetchOpenAIModels] Successfully fetched ${models.length} OpenAI models.`);
                this.showNotice(t('notice.models.updated', { provider: 'OpenAI' }), 3000);
                return models;
            } else {
                logger.warn("[fetchOpenAIModels] Unexpected response structure from OpenAI API.");
                this.showNotice(t('notice.models.parseFailed', { provider: 'OpenAI' }), 5000);
                return [];
            }
        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            logger.error("[fetchOpenAIModels] Error fetching or parsing OpenAI models:", errorMessage);
            this.showNotice(t('notice.models.error', { provider: 'OpenAI', error: errorMessage }), 5000);
            return []; // Or a default list
        }
    }

    async fetchGoogleModels(apiKey: string): Promise<FetchedModelInfo[]> {
        if (!apiKey || apiKey.trim() === "") {
            this.showNotice(t('notice.models.apiKeyMissing', { provider: 'Google' }), 5000);
            logger.warn("[fetchGoogleModels] Google API key is missing.");
            return [];
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        try {
            this.showNotice(t('notice.models.fetching', { provider: 'Google' }), 3000);
            const response = await obsidianFetch(url, { method: 'GET' });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText })) as ApiErrorResponse;
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchGoogleModels] Failed to fetch Google models: ${errorMessage}`);
                this.showNotice(t('notice.models.fetchFailed', { provider: 'Google', error: errorMessage }), 5000);
                return [];
            }

            const data = await response.json() as GoogleModelsResponse;
            if (data && Array.isArray(data.models)) {
                const models: FetchedModelInfo[] = data.models
                    .filter((model: GoogleModel) =>
                        model.name &&
                        !model.name.includes('embed') &&
                        model.supportedGenerationMethods?.includes('generateContent')
                    )
                    .map((model: GoogleModel) => {
                        const id = model.name.startsWith('models/') ? model.name.substring('models/'.length) : model.name;
                        const contextK = model.inputTokenLimit ? Math.round(model.inputTokenLimit / 1000) : undefined;
                        const maxOutputK = model.outputTokenLimit ? Math.round(model.outputTokenLimit / 1000) : undefined;
                        return { id, contextK, maxOutputK };
                    })
                    .sort((a, b) => a.id.localeCompare(b.id));

                // Store token limits in customModelLimits for any model with a
                // context window. Google's API usually returns both, but when
                // max output is absent, derive it (8k, capped to context) — the
                // same approach fetchOpenRouterModels uses — so the model still
                // gets real limits instead of the generic 128/16 fallback.
                let updatedCount = 0;
                for (const m of models) {
                    if (m.contextK) {
                        const key = `google:${m.id}`;
                        this.settings.customModelLimits[key] = {
                            contextK: m.contextK,
                            maxOutputK: m.maxOutputK ?? Math.min(8, m.contextK),
                            reservePct: 0.10
                        };
                        updatedCount++;
                    }
                }
                if (updatedCount > 0) {
                    logger.info(`[fetchGoogleModels] Stored token limits for ${updatedCount} Google models.`);
                }

                // Persist discovered IDs (independent of whether limits were
                // captured) so the dropdown survives a settings-tab re-render (update()).
                this.settings.fetchedModels = {
                    ...this.settings.fetchedModels,
                    google: models.map(m => m.id),
                };
                await this.saveSettings();

                logger.info(`[fetchGoogleModels] Successfully fetched ${models.length} Google models.`);
                this.showNotice(t('notice.models.updated', { provider: 'Google' }), 3000);
                return models;
            } else {
                logger.warn("[fetchGoogleModels] Unexpected response structure from Google API.");
                this.showNotice(t('notice.models.parseFailed', { provider: 'Google' }), 5000);
                return [];
            }
        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            logger.error("[fetchGoogleModels] Error fetching or parsing Google models:", errorMessage);
            this.showNotice(t('notice.models.error', { provider: 'Google', error: errorMessage }), 5000);
            return [];
        }
    }

    async fetchAnthropicModels(apiKey: string): Promise<FetchedModelInfo[]> {
        if (!apiKey || apiKey.trim() === "") {
            this.showNotice(t('notice.models.apiKeyMissing', { provider: 'Anthropic' }), 5000);
            logger.warn("[fetchAnthropicModels] Anthropic API key is missing.");
            return [];
        }

        const url = "https://api.anthropic.com/v1/models";
        try {
            this.showNotice(t('notice.models.fetching', { provider: 'Anthropic' }), 3000);
            const response = await obsidianFetch(url, {
                method: 'GET',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText })) as ApiErrorResponse;
                const errorMessage = errorData.error?.message || errorData.message || `HTTP error ${response.status}`;
                logger.error(`[fetchAnthropicModels] Failed to fetch Anthropic models: ${errorMessage}`);
                this.showNotice(t('notice.models.fetchFailed', { provider: 'Anthropic', error: errorMessage }), 5000);
                return [];
            }

            const data = await response.json() as {
                data?: Array<{
                    id: string;
                    type?: string;
                    max_input_tokens?: number;
                    max_tokens?: number;
                }>
            };
            if (data && Array.isArray(data.data)) {
                const models: FetchedModelInfo[] = data.data
                    .filter(model => model.type === 'model' || !model.type)
                    .map(model => ({
                        id: model.id,
                        contextK: model.max_input_tokens ? Math.round(model.max_input_tokens / 1000) : undefined,
                        maxOutputK: model.max_tokens ? Math.round(model.max_tokens / 1000) : undefined
                    }))
                    .sort((a, b) => b.id.localeCompare(a.id)); // Most recent first

                // Upsert token limits into customModelLimits for any model that has them
                let updatedCount = 0;
                for (const m of models) {
                    if (m.contextK && m.maxOutputK) {
                        const key = `anthropic:${m.id}`;
                        this.settings.customModelLimits[key] = {
                            contextK: m.contextK,
                            maxOutputK: m.maxOutputK,
                            reservePct: 0.10
                        };
                        updatedCount++;
                    }
                }
                if (updatedCount > 0) {
                    logger.info(`[fetchAnthropicModels] Stored token limits for ${updatedCount} Anthropic models.`);
                }

                // Persist discovered IDs (independent of whether limits were
                // captured) so the dropdown survives a settings-tab re-render (update()).
                this.settings.fetchedModels = {
                    ...this.settings.fetchedModels,
                    anthropic: models.map(m => m.id),
                };
                await this.saveSettings();

                logger.info(`[fetchAnthropicModels] Successfully fetched ${models.length} Anthropic models.`);
                this.showNotice(t('notice.models.updated', { provider: 'Anthropic' }), 3000);
                return models;
            } else {
                logger.warn("[fetchAnthropicModels] Unexpected response structure from Anthropic API.");
                this.showNotice(t('notice.models.parseFailed', { provider: 'Anthropic' }), 5000);
                return [];
            }
        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            logger.error("[fetchAnthropicModels] Error fetching or parsing Anthropic models:", errorMessage);
            this.showNotice(t('notice.models.error', { provider: 'Anthropic', error: errorMessage }), 5000);
            return [];
        }
    }

    async fetchOpenRouterModels(): Promise<FetchedModelInfo[]> {
        const url = 'https://openrouter.ai/api/v1/models';
        try {
            this.showNotice(t('notice.models.fetching', { provider: 'OpenRouter' }), 3000);
            const response = await obsidianFetch(url, { method: 'GET' });

            if (!response.ok) {
                const errorMessage = `HTTP error ${response.status}`;
                logger.error(`[fetchOpenRouterModels] Failed to fetch OpenRouter models: ${errorMessage}`);
                this.showNotice(t('notice.models.fetchFailed', { provider: 'OpenRouter', error: errorMessage }), 5000);
                return [];
            }

            const data = await response.json() as {
                data?: Array<{
                    id?: string;
                    context_length?: number;
                    top_provider?: { max_completion_tokens?: number | null };
                }>;
            };

            if (data && Array.isArray(data.data)) {
                const models: FetchedModelInfo[] = data.data
                    .filter((m) => typeof m.id === 'string' && m.id.length > 0)
                    .map((m) => {
                        const id = m.id as string;
                        const contextK = m.context_length ? Math.round(m.context_length / 1000) : undefined;
                        const maxOut = m.top_provider?.max_completion_tokens;
                        const maxOutputK = maxOut ? Math.round(maxOut / 1000) : undefined;
                        return { id, contextK, maxOutputK };
                    })
                    .sort((a, b) => a.id.localeCompare(b.id));

                let updatedCount = 0;
                for (const m of models) {
                    if (m.contextK) {
                        // OpenRouter's API leaves top_provider.max_completion_tokens
                        // null for many models. When it's absent, derive a sensible
                        // default (8k, capped to the context window) so the model
                        // still gets real limits instead of resolving to the generic
                        // 128/16 fallback — which made flipping between such models
                        // look like the override panel never updated.
                        const maxOutputK = m.maxOutputK ?? Math.min(8, m.contextK);
                        this.settings.customModelLimits[`openrouter:${m.id}`] = {
                            contextK: m.contextK,
                            maxOutputK,
                            reservePct: 0.10
                        };
                        updatedCount++;
                    }
                }
                if (updatedCount > 0) {
                    logger.info(`[fetchOpenRouterModels] Stored token limits for ${updatedCount} OpenRouter models.`);
                }

                this.settings.fetchedModels = {
                    ...this.settings.fetchedModels,
                    openrouter: models.map((m) => m.id),
                };
                await this.saveSettings();

                logger.info(`[fetchOpenRouterModels] Successfully fetched ${models.length} OpenRouter models.`);
                this.showNotice(t('notice.models.updated', { provider: 'OpenRouter' }), 3000);
                return models;
            } else {
                logger.warn("[fetchOpenRouterModels] Unexpected response structure from OpenRouter API.");
                this.showNotice(t('notice.models.parseFailed', { provider: 'OpenRouter' }), 5000);
                return [];
            }
        } catch (error) {
            const errorMessage = getSafeErrorMessage(error);
            logger.error("[fetchOpenRouterModels] Error fetching or parsing OpenRouter models:", errorMessage);
            this.showNotice(t('notice.models.error', { provider: 'OpenRouter', error: errorMessage }), 5000);
            return [];
        }
    }
}

class YouTubeTranscriptModal extends Modal {
    plugin: YouTubeTranscriptPlugin;
    private titleInputEl: HTMLInputElement;
    private urlInputEl: HTMLInputElement;
    private errorEl: HTMLElement;
    private isProcessing: boolean = false;
    private selectedFolder: string = '';
    constructor(app: App, plugin: YouTubeTranscriptPlugin) {
        super(app);
        this.plugin = plugin;
    }
    
    // Create a wrapper for Notice that uses the shared utility
    showNotice(message: string, timeout: number = 5000): void {
        showNotice(message, timeout);
    }
    
    // Use imported utility method
    private isYoutubeUrl(this: void, url: string): boolean {
        return isYoutubeUrl(url);
    }
    
    // Use imported utility method
    private isYoutubeChannelOrPlaylistUrl(this: void, url: string): boolean {
        return isYoutubeChannelOrPlaylistUrl(url);
    }
    
    // Use imported utility method
    private extractChannelName(url: string): string {
        return extractChannelName(url);
    }
    
    // Helper method to show error message
    private showError(message: string): void {
        if (this.errorEl) {
            displayValidationResult(
                { isValid: false, message: message },
                { element: this.errorEl }
            );
        }
    }
    
    // Helper method to hide error message
    private hideError(): void {
        if (this.errorEl) {
            // Use class toggling for consistency with displayValidationResult
            this.errorEl.addClass('tubesage-error-hidden');
            this.errorEl.removeClass('tubesage-error-visible');
        }
    }
    
    onOpen() {
        // Initialize
        this.showNotice(t('notice.extractor.ready'), 3000);
        
        // Clear content and create container
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: t('modal.create.title') });
        
        // Build the input stage UI
        this.buildInputStage();
    }
    
    private buildInputStage() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Add header
        contentEl.createEl('h2', { text: t('modal.create.title') });
        
        // Check if we're on mobile
        const isMobile = Platform.isMobile;
        
        // Create the form container - revert to original appearance
        const formEl = contentEl.createDiv({ cls: 'tubesage-transcript-form' });
        
        // URL input group - first input
        const urlGroup = formEl.createDiv({ cls: 'form-group' });
        urlGroup.createEl('label', { text: t('modal.create.urlLabel'), attr: { for: 'url' } });
        const urlText = new TextComponent(urlGroup);
        urlText.setPlaceholder(YOUTUBE_URL_PLACEHOLDER);
        urlText.inputEl.id = 'url';
        this.urlInputEl = urlText.inputEl;
        
        // Create a URL validation message element
        const urlValidationEl = urlGroup.createDiv({ 
            cls: ['validation-message', 'tubesage-validation-hidden']
        });
        
        // Add channel selection container (initially hidden)
        const channelOptionsContainer = formEl.createDiv({ 
            cls: ['channel-options', 'tubesage-display-none']
        });
        
        // Add channel message
        channelOptionsContainer.createDiv({ 
            text: t('modal.create.videoCountPrompt'),
            cls: 'channel-message'
        });
        
        // Create a container for controls with different layout based on device
        const controlsContainer = channelOptionsContainer.createDiv({
            cls: ['tubesage-modal-controls-container', isMobile ? 'tubesage-modal-controls-container-mobile' : 'tubesage-modal-controls-container-desktop'],
        });
        
        // Radio button for "All Videos"
        const allVideosContainer = controlsContainer.createDiv({
            cls: ['tubesage-modal-radio-option', isMobile ? 'tubesage-modal-radio-option-mobile' : '' ],
        });
        
        // Create label first
        allVideosContainer.createEl('label', {
            text: t('modal.create.allVideos'),
            cls: 'tubesage-modal-radio-label',
            attr: { for: 'all-videos-radio' }
        });
        
        // Then add the radio button
        const allVideosRadio = allVideosContainer.createEl('input', {
            type: 'radio',
            attr: { 
                id: 'all-videos-radio',
                name: 'video-count-option',
                checked: 'checked'
            }
        });
        
        // Create container for limited videos option (radio + dropdown together)
        const limitedOptionContainer = controlsContainer.createDiv({
            cls: ['tubesage-modal-limited-option-container', isMobile ? 'tubesage-modal-limited-option-container-mobile' : ''],
        });
        
        // Radio button for "Limited Number"
        const limitedVideosContainer = limitedOptionContainer.createDiv({
            cls: 'tubesage-modal-radio-option',
        });
        
        // Create label first
        limitedVideosContainer.createEl('label', {
            text: t('modal.create.limitedNumber'),
            cls: 'tubesage-modal-radio-label',
            attr: { for: 'limited-videos-radio' }
        });
        
        // Then add the radio button
        limitedVideosContainer.createEl('input', {
            type: 'radio',
            attr: { 
                id: 'limited-videos-radio',
                name: 'video-count-option'
            }
        });
        
        // Dropdown for selecting number of videos - add to the limitedOptionContainer
        const videoCountDropdown = new DropdownComponent(limitedOptionContainer);
        for (let i = 1; i <= 50; i++) {
            videoCountDropdown.addOption(String(i), String(i));
        }
        videoCountDropdown.setValue('1');
        videoCountDropdown.selectEl.addClass('video-count-dropdown');
        
        // Process button in its own container for mobile layout
        const processBtnContainer = controlsContainer.createDiv({
            cls: ['tubesage-modal-process-btn-container', isMobile ? 'tubesage-modal-process-btn-container-mobile' : ''],
        });
        
        const processBtn = new ButtonComponent(processBtnContainer);
        processBtn.setButtonText(t('modal.create.processButton'));
        processBtn.setCta();
        if (isMobile) {
            processBtn.buttonEl.addClass('tubesage-process-btn-mobile');
        }

        // Add event listener for process button
        processBtn.onClick(() => {
            const url = this.urlInputEl.value.trim();

            if (allVideosRadio.checked) {
                // Process all videos
                this.processCollectionVideos(url, 0);
            } else {
                // Process limited number of videos
                const count = parseInt(videoCountDropdown.getValue()) || 10;
                this.processCollectionVideos(url, count);
            }
        });
        
        // Title input group - second input (for single video mode)
        const titleGroup = formEl.createDiv({ cls: 'form-group' });
        titleGroup.createEl('label', { text: t('modal.create.titleLabel'), attr: { for: 'title' } });
        const titleText = new TextComponent(titleGroup);
        titleText.setPlaceholder(t('modal.create.titlePlaceholder'));
        titleText.inputEl.id = 'title';
        this.titleInputEl = titleText.inputEl;
        
        // Add toggle switch for summary mode
        const toggleContainer = formEl.createDiv({ cls: 'toggle-container' });
        
        // Label for the toggle
        const toggleLabel = toggleContainer.createDiv({ cls: 'toggle-label' });
        toggleLabel.createDiv({ text: t('modal.create.fastMode') });
        toggleLabel.createDiv({ 
            text: t('modal.create.fastModeDesc'), 
            cls: 'summary-info' 
        });
        
        // Create the native Obsidian toggle
        const fastToggle = new ToggleComponent(toggleContainer);
        fastToggle.setValue(this.plugin.settings.useFastSummary);
        fastToggle.onChange(value => {
            this.plugin.settings.useFastSummary = value;
            void this.plugin.saveSettings();
        });
        
        // Error message container
        this.errorEl = formEl.createDiv({ cls: ['tubesage-error', 'tubesage-error-hidden'] });
        
        // Add real-time validation on URL change
        this.urlInputEl.addEventListener('input', () => {
            const url = this.urlInputEl.value.trim();
            
            // First check if it's a valid URL
            if (url && !this.isYoutubeUrl(url)) {
                urlValidationEl.setText(t('modal.create.urlInvalid'));
                urlValidationEl.removeClass('tubesage-validation-success', 'tubesage-validation-accent');
                urlValidationEl.addClass('tubesage-validation-error', 'tubesage-validation-visible');
                urlValidationEl.removeClass('tubesage-validation-hidden');
                return;
            }
            
            // Check if it's a channel URL
            if (url && this.isYoutubeChannelOrPlaylistUrl(url)) {
                urlValidationEl.setText(t('modal.create.urlPlaylist'));
                urlValidationEl.removeClass('tubesage-validation-error', 'tubesage-validation-success');
                urlValidationEl.addClass('tubesage-validation-accent', 'tubesage-validation-visible');
                urlValidationEl.removeClass('tubesage-validation-hidden');
                
                // Show channel options, hide title input
                channelOptionsContainer.addClass('tubesage-display-block');
                channelOptionsContainer.removeClass('tubesage-display-none');
                titleGroup.addClass('tubesage-display-none');
                titleGroup.removeClass('tubesage-display-block');
            } else if (url) {
                urlValidationEl.setText(t('modal.create.urlVideo'));
                urlValidationEl.removeClass('tubesage-validation-error', 'tubesage-validation-accent');
                urlValidationEl.addClass('tubesage-validation-success', 'tubesage-validation-visible');
                urlValidationEl.removeClass('tubesage-validation-hidden');
                
                // Hide channel options, show title input
                channelOptionsContainer.addClass('tubesage-display-none');
                channelOptionsContainer.removeClass('tubesage-display-block');
                titleGroup.addClass('tubesage-display-block');
                titleGroup.removeClass('tubesage-display-none');
            } else {
                urlValidationEl.addClass('tubesage-validation-hidden');
                urlValidationEl.removeClass('tubesage-validation-visible');
                channelOptionsContainer.addClass('tubesage-display-none');
                channelOptionsContainer.removeClass('tubesage-display-block');
                titleGroup.addClass('tubesage-display-block');
                titleGroup.removeClass('tubesage-display-none');
            }
        });
        
        // Add event listeners for Enter key
        this.urlInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const url = this.urlInputEl.value.trim();
                
                if (url && this.isYoutubeUrl(url)) {
                    if (this.isYoutubeChannelOrPlaylistUrl(url)) {
                        // If it's a channel or playlist URL, show channel options and hide the title input
                        channelOptionsContainer.addClass('tubesage-display-block');
                        channelOptionsContainer.removeClass('tubesage-display-none');
                        titleGroup.addClass('tubesage-display-none');
                        titleGroup.removeClass('tubesage-display-block');
                    } else if (!titleGroup.hasClass('tubesage-display-none')) {
                        // Only focus title if it's visible (single video mode)
                        this.titleInputEl.focus();
                    }
                }
            }
        });
        
        this.titleInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleInputSubmit();
            }
        });
        
        // Focus the URL input by default
        this.urlInputEl.focus();
    }
    
    private handleInputSubmit = () => {
        // Clear any previous errors
        this.hideError();
        
        // Get values from inputs
        const url = this.urlInputEl.value.trim();
        
        // Create validation rules
        const validations: ValidationResult[] = [
            // URL is required
            validateRequired(url, t('modal.create.urlLabel')),
            
            // URL must be a valid YouTube URL
            validateYouTubeUrl(url, this.isYoutubeUrl)
        ];
        
        // Check if any validation fails
        for (const validation of validations) {
            if (!validation.isValid) {
                displayValidationResult(validation, { element: this.errorEl });
            this.urlInputEl.focus();
            return;
            }
        }
        
        // Check if it's a channel URL
        if (this.isYoutubeChannelOrPlaylistUrl(url)) {
            // Check if Youtube API key is set
            if (!this.plugin.settings.youtubeApiKey || this.plugin.settings.youtubeApiKey.trim() === '') {
                this.showError(
                    'Youtube API key is required to process channels or playlists. ' +
                    'Please set your Youtube data API key in the plugin settings first. ' +
                    'See the README section "Creating a Youtube API key" for instructions.'
                );
                return;
            }
            
            // For channels, we handle this through the channel options UI
            this.showError('Please use the channel options to process this URL');
            return;
        }
        
        // Title is now optional
        // Show folder picker directly, we'll get title later if needed
        this.showFolderPicker();
    }
    
        // Method to handle processing Youtube channel or playlist videos
        private processCollectionVideos(sourceUrl: string, videoCount: number) {
            // Validate the URL once more
            if (!sourceUrl || !this.isYoutubeUrl(sourceUrl) || !this.isYoutubeChannelOrPlaylistUrl(sourceUrl)) {
                this.showError('Invalid Youtube channel or playlist URL');
                return;
            }
            
            // Check if Youtube API key is set
            if (!this.plugin.settings.youtubeApiKey || this.plugin.settings.youtubeApiKey.trim() === '') {
                this.showError(
                    'Youtube API key is required to process channels or playlists. ' +
                    'Please set your Youtube data API key in the plugin settings first. ' +
                    'See the README section "Creating a Youtube API key" for instructions.'
                );
                return;
            }
        
        // Show folder picker - we'll process videos after folder selection
        const folderSelectionModal = new FolderPickerModal(
            this.app,
            this.plugin, // Revert to this.plugin
            (folderPath) => {
                this.selectedFolder = folderPath;
                void this.beginCollectionProcessing(sourceUrl, videoCount);
            }
        );
        void folderSelectionModal.open();
    }
    
    // Method to start the collection processing workflow
    private async beginCollectionProcessing(sourceUrl: string, videoCount: number) {
        if (this.isProcessing) return;

        try {
            this.isProcessing = true;

            // Determine if this is a playlist or channel
            const isPlaylist = sourceUrl.includes('/playlist') || sourceUrl.includes('list=');
            const contentType = isPlaylist ? 'Playlist' : 'Channel';
            
            // Extract name for folder creation (different method depending on type)
            let sourceName = '';
            
            if (isPlaylist) {
                // For playlists, we'll extract the name from the API
                if (sourceUrl.includes('list=')) {
                    const match = sourceUrl.match(/list=([^&]+)/);
                    if (match && match[1]) {
                        const playlistId = match[1];
                        this.showNotice(t('notice.collection.extractingName'), 5000);
                        
                        try {
                            // Get the playlist name from the API
                            const API_KEY = this.plugin.settings.youtubeApiKey;
                            const response = await obsidianFetch(
                                `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`
                            );
                            
                            if (response.ok) {
                                const data = await response.json() as PlaylistResponse;
                                if (data.items && data.items.length > 0) {
                                    sourceName = data.items[0].snippet?.title ?? '';
                                    this.showNotice(t('notice.collection.playlistFound', { name: sourceName }), 5000);
                                }
                            }
                        } catch (error) {
                            logger.error("Error getting playlist name:", error);
                            // Use a generic name if we can't get the real name
                            sourceName = `Playlist-${playlistId}`;
                        }
                    }
                }
                
                // If we still don't have a name, use a fallback
                if (!sourceName) {
            sourceName = "Youtube-Playlist";
                }
            } else {
                // For channels, use the existing method
                sourceName = this.extractChannelName(sourceUrl);
            }
            
            const sanitizedName = this.sanitizePathComponent(sourceName);
            
            // Show starting notice
            this.showNotice(isPlaylist
                ? t('notice.collection.start.playlist', { name: sourceName })
                : t('notice.collection.start.channel', { name: sourceName }), 5000);
            
            // Create the subfolder with content type prefix
            const formattedSourceName = `${contentType} - ${sanitizedName}`;
            const sourceSubfolder = this.selectedFolder 
                ? joinPaths(this.selectedFolder, formattedSourceName)
                : formattedSourceName;
            
            // Ensure the subfolder exists
            await ensureFolder(this.app.vault, sourceSubfolder);
                this.showNotice(isPlaylist
                    ? t('notice.collection.folderCreated.playlist', { path: formattedSourceName })
                    : t('notice.collection.folderCreated.channel', { path: formattedSourceName }), 5000);
            
            // Fetch videos from the source using the source URL
            this.showNotice(isPlaylist
                ? t('notice.collection.fetchingFrom.playlist', { name: sourceName })
                : t('notice.collection.fetchingFrom.channel', { name: sourceName }), 5000);
            
            // Use the plugin's fetchCollectionVideos method
            // @ts-ignore - This is a mistake in our code structure
            const collectionVideos = await this.plugin.fetchCollectionVideos(sourceUrl, videoCount);
            
            if (!collectionVideos || collectionVideos.length === 0) {
                // Two whole sentences rather than one with the noun spliced in:
                // the noun's gender and case differ by language, and this text
                // reaches the user through notice.job.failed's {error}.
                throw new Error(isPlaylist
                    ? t('notice.collection.noVideos.playlist')
                    : t('notice.collection.noVideos.channel'));
            }
            
            this.showNotice(t('notice.collection.videosToProcess', { count: collectionVideos.length }), 5000);
            
            // Get the actual number of videos to process - respect ALL vs Limited options
            const videosToProcess = videoCount === 0 ? collectionVideos : collectionVideos.slice(0, videoCount);
            
            // Process each video
            // Hand the run to the job runner (#9). Each video is submitted as an
            // ordinary single-video job, so a collection inherits generation
            // fencing, the two-phase claim, per-item billing attribution and
            // cancellation unchanged rather than re-implementing any of them —
            // and ONE floating notice reports the whole run.
            const videos: CollectionVideo[] = [];
            for (const video of videosToProcess) {
                const videoId = YouTubeTranscriptExtractor.extractVideoId(video.url);
                if (videoId === null) {
                    // Not fatal: one unparseable entry should not sink the run.
                    logger.warn('[collection] no extractable video id, skipping:', video.url);
                    continue;
                }
                videos.push({ url: video.url, videoId, title: video.title });
            }
            if (videos.length === 0) {
                throw new Error(isPlaylist
                    ? t('notice.collection.noVideos.playlist')
                    : t('notice.collection.noVideos.channel'));
            }

            await this.plugin.collectionRunner?.begin({
                url: sourceUrl,
                folder: sourceSubfolder,
                sourceName,
                contentType,
                videos,
            });

            // The run owns its own notice from here, so the modal has no reason
            // to keep the screen — which is the whole point of this issue.
            this.close();

        } catch (err) {
            logger.error('Error in channel processing workflow:', err);
            
            // Use the getSafeErrorMessage utility instead of duplicating error handling logic
            const errorMessage = getSafeErrorMessage(err);
            
            // Show error notice
            this.showNotice(t('notice.job.failed', { error: errorMessage }), 5000);
            
            // Close the modal on error
            this.close();
        } finally {
            // Only stop the proxy server if currently using Anthropic
            if (this.plugin.settings.selectedLLM === 'anthropic') {
                try {
                    logger.info('[beginCollectionProcessing] Completed Anthropic processing');
                } catch (error) {
                    logger.error('Error during Anthropic processing:', error);
                }
            }
            this.isProcessing = false;
        }
    }

    // Helper method to sanitize file/folder names
    private sanitizePathComponent(text: string): string {
        // Use the utility function instead of duplicating code
        return sanitizePathComponent(text);
    }
    
    private showFolderPicker() {
        // Open folder picker modal
        const folderSelectionModal = new FolderPickerModal(
            this.app,
            this.plugin, // Use plugin instance
            (folderPath) => {
                this.selectedFolder = folderPath;
                void this.processTranscript();
            }
        );
        void folderSelectionModal.open();
    }
    
    private processTranscript = async () => {
        if (this.isProcessing) return;
        
        // Get URL from the input
        const url = this.urlInputEl.value.trim();
        
        // Validate URL using form utilities
        const urlValidations: ValidationResult[] = [
            validateRequired(url, t('modal.create.urlLabel')),
            validateYouTubeUrl(url, this.isYoutubeUrl)
        ];
        
        // Check URL validations
        for (const validation of urlValidations) {
            if (!validation.isValid) {
                displayValidationResult(validation, { element: this.errorEl });
            return;
            }
        }
        
        // Check if it's a channel URL - redirect to channel processing
        if (this.isYoutubeChannelOrPlaylistUrl(url)) {
            this.showError('This is a channel or playlist URL. Please use the channel options to process it.');
            return;
        }
        
        // Ensure a folder has been selected
        if (!this.selectedFolder) {
            this.showError('Please select a folder for the note');
            // Go back to folder selection
            this.handleInputSubmit();
            return;
        }

        const videoId = YouTubeTranscriptExtractor.extractVideoId(url);
        if (!videoId) {
            this.showError(`Invalid Youtube URL: '${url}'. Please ensure the URL is properly formatted without extra characters like quotes.`);
            return;
        }

        // The job runner owns the whole pipeline from here (transcript ->
        // summary -> note -> timestamps) and survives this modal: dismissing it
        // only stops the in-modal spinner, never the job. The folder goes in
        // normalized because the runner derives the note path from
        // `record.folder` verbatim ("Notes/" would drift from "Notes").
        this.isProcessing = true;
        let result: SubmitResult;
        try {
            result = await this.plugin.submitJob({
                url,
                videoId,
                folder: normalizePath(this.selectedFolder),
                customTitle: this.titleInputEl.value.trim(),
                useFastSummary: this.plugin.settings.useFastSummary,
                // Frozen on the record like useFastSummary: false skips the
                // paid timestamps stage (legacy modal parity).
                addTimestampLinks: this.plugin.settings.addTimestampLinks,
            });
        } catch (error) {
            // A rejection means the store failed to flush the new record; the
            // run itself has already started (runner contract), so do not
            // claim nothing is running.
            logger.error('[processTranscript] submit failed to persist the job:', error);
            this.showNotice(
                t('notice.job.saveFailed', { error: getSafeErrorMessage(error) }),
                8000
            );
            this.isProcessing = false;
            this.close();
            return;
        }

        switch (result.kind) {
            case 'already-running':
                this.isProcessing = false;
                this.showNotice(t('notice.job.alreadyRunning'), 5000);
                return;
            case 'recovery':
                // An interrupted job for this video already exists: it needs a
                // decision, not a second job. Open the list on that record.
                this.close();
                this.plugin.openRecoveryModal(result.record.id);
                return;
            case 'started':
                break;
        }

        // Desktop and mobile alike: the job is the runner's from here and its
        // progress is the plugin's floating notice, so this modal has nothing
        // left to show and closes at once — nothing blocks the note
        // underneath (#7). Cancel is not lost with the old panel: "Show
        // active jobs" offers it as the action for a running job, which is
        // what the progress notice points at.
        this.close();
    }

    // Dismissing the modal never touches a job: the runner owns every
    // submitted job and its progress notice outlives this modal.
    onClose() {
        this.isProcessing = false;
        const { contentEl } = this;
        contentEl.empty();
    }

}

/**
 * Recovery surface (spec §6): lists every non-terminal job plus the most recent finished ones, each
 * row rendered VERBATIM from the pure UI model (`buildRecoveryRow`) — no wording or button set is
 * derived here. Buttons drive the runner's resume/cancel/discard (or open the note of a job that died
 * with a previous instance) and the list re-renders after each action and after every runner event.
 * Discard removes only the record; it never deletes notes.
 */
class JobRecoveryModal extends Modal {
    private unsubscribeJobEvents: (() => void) | null = null;
    private renderSeq = 0;
    private isOpen = false;
    private highlightId: string | undefined;
    private hasRendered = false;

    constructor(app: App, private readonly plugin: YouTubeTranscriptPlugin, private readonly onClosed: () => void) {
        super(app);
    }

    onOpen() {
        this.isOpen = true;
        this.setTitle(t('modal.jobs.title'));
        this.unsubscribeJobEvents = this.plugin.subscribeToJobEvents(() => {
            void this.refresh();
        });
        void this.refresh();
    }

    onClose() {
        this.isOpen = false;
        this.unsubscribeJobEvents?.();
        this.unsubscribeJobEvents = null;
        this.contentEl.empty();
        this.onClosed();
    }

    /** The row to mark and scroll into view on the next render (undefined clears it). */
    highlight(id: string | undefined): void {
        this.highlightId = id;
    }

    /**
     * Re-reads the store and re-renders. Overlapping calls resolve to the latest snapshot only. If the
     * rows cannot be built, the previous render is kept (or the modal stays empty) and an error line
     * is shown instead of a misleading "No active jobs".
     */
    async refresh(): Promise<void> {
        const seq = ++this.renderSeq;
        let entries: RecoveryRowEntry[];
        try {
            entries = await this.plugin.recoveryRows();
        } catch (error) {
            logger.error('[jobs] Could not build the recovery rows:', error);
            if (seq === this.renderSeq && this.isOpen) {
                this.renderError(getSafeErrorMessage(error));
            }
            return;
        }
        if (seq !== this.renderSeq || !this.isOpen) {
            return; // superseded by a later refresh, or closed meanwhile
        }
        this.render(entries);
    }

    private renderError(message: string): void {
        const { contentEl } = this;
        if (!this.hasRendered) {
            contentEl.empty();
        }
        contentEl.querySelector('.tubesage-jobs-error')?.remove();
        contentEl.createDiv({ cls: ['tubesage-jobs-status', 'tubesage-jobs-error'], text: t('modal.jobs.loadError', { error: message }) });
    }

    private render(entries: RecoveryRowEntry[]): void {
        const { contentEl } = this;
        contentEl.empty();
        this.hasRendered = true;
        if (entries.length === 0) {
            contentEl.createDiv({ cls: 'tubesage-jobs-empty', text: t('modal.jobs.empty') });
            return;
        }
        const now = Date.now();
        // A running channel/playlist gets one row of its own with a stop
        // control: cancelling the RUN is not the same as cancelling one of its
        // videos, and without this the cooperative-cancel policy had no way in.
        for (const collection of this.plugin.runningCollections()) {
            const runEl = contentEl.createDiv({ cls: 'tubesage-jobs-row' });
            runEl.createDiv({ cls: 'tubesage-jobs-title', text: collection.sourceName });
            runEl.createDiv({
                cls: 'tubesage-jobs-status',
                text: t('notice.collection.progress', {
                    name: collection.sourceName,
                    done: collection.done,
                    total: collection.total,
                }),
            });
            const runActions = runEl.createDiv({ cls: 'tubesage-jobs-actions' });
            new ButtonComponent(runActions)
                .setButtonText(t('modal.jobs.cancelCollection'))
                .onClick(() => {
                    void (async () => {
                        await this.plugin.collectionRunner?.cancel(collection.id);
                        await this.refresh();
                    })();
                });
        }
        const list = contentEl.createDiv({ cls: 'tubesage-jobs-list' });
        let highlighted: HTMLElement | null = null;
        for (const { row, updatedAt } of entries) {
            const rowEl = list.createDiv({ cls: 'tubesage-jobs-row' });
            if (row.id === this.highlightId) {
                rowEl.addClass('tubesage-jobs-row-highlight');
                highlighted = rowEl;
            }
            rowEl.createDiv({ cls: 'tubesage-jobs-title', text: row.title });
            rowEl.createDiv({ cls: 'tubesage-jobs-meta', text: t('modal.jobs.meta', { stage: row.stageLabel, age: formatJobAge(updatedAt, now) }) });
            rowEl.createDiv({ cls: 'tubesage-jobs-status', text: row.statusLine });
            if (row.notePath !== undefined) {
                rowEl.createDiv({ cls: 'tubesage-jobs-path', text: row.notePath });
            }
            const actionsEl = rowEl.createDiv({ cls: 'tubesage-jobs-actions' });
            for (const action of row.actions) {
                const button = new ButtonComponent(actionsEl)
                    .setButtonText(action.label)
                    .onClick(() => {
                        void this.act(row, action);
                    });
                if (action.cta) {
                    button.setCta();
                }
                if (action.warnsAboutBilling) {
                    button.setDestructive().setCta();
                }
            }
        }
        contentEl.createDiv({
            cls: 'tubesage-jobs-meta',
            text: t('modal.jobs.discardHint'),
        });
        if (highlighted !== null) {
            highlighted.scrollIntoView({ block: 'nearest' });
        }
    }

    private async act(row: RecoveryRowModel, action: RecoveryAction): Promise<void> {
        const runner = this.plugin.jobRunner;
        const id = row.id;
        try {
            switch (action.id) {
                case 'resume': {
                    const result = await runner.resume(id, { confirmed: true });
                    if (result.kind === 'prompt') {
                        this.plugin.showNotice(t('notice.job.cannotResume'), 5000);
                    }
                    break;
                }
                case 'finish-without-timestamps': {
                    const result = await runner.resume(id, { confirmed: true, finishWithoutTimestamps: true });
                    if (result.kind === 'prompt') {
                        this.plugin.showNotice(t('notice.job.cannotFinish'), 5000);
                    }
                    break;
                }
                case 'cancel':
                    await runner.cancel(id);
                    break;
                case 'discard':
                    await runner.discard(id);
                    break;
                case 'open-note':
                    // Offered only when the model saw record.notePath and the file exists.
                    if (row.notePath !== undefined) {
                        await this.plugin.openNote(row.notePath);
                    }
                    break;
            }
        } catch (error) {
            logger.error(`[jobs] ${action.id} failed for ${id}:`, error);
            this.plugin.showNotice(t('notice.job.failed', { error: getSafeErrorMessage(error) }), 5000);
        }
        await this.refresh();
    }
}

class YouTubeTranscriptSettingTab extends PluginSettingTab {
    plugin: YouTubeTranscriptPlugin;

    constructor(app: App, plugin: YouTubeTranscriptPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return buildSettingDefinitions(this.host());
    }

    getControlValue(key: string): unknown {
        return readSettingValue(this.plugin.settings, key);
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        await writeSettingValue(this.host(), key, value);
    }

    private host(): SettingsHost {
        const plugin = this.plugin;
        const app = this.app;
        return {
            get settings() { return plugin.settings; },
            defaults: DEFAULT_SETTINGS,
            saveSettings: () => plugin.saveSettings(),
            update: () => { this.update(); },
            showNotice: (message, timeout) => { plugin.showNotice(message, timeout); },
            getEffectiveMaxTokens: () => plugin.getEffectiveMaxTokens(),
            setSecret: (provider, value) => {
                if (CLOUD_PROVIDERS.includes(provider as typeof CLOUD_PROVIDERS[number])) {
                    plugin.app.secretStorage.setSecret(SECRET_IDS[provider], value);
                }
            },
            fetchOpenAIModels: (apiKey) => plugin.fetchOpenAIModels(apiKey),
            fetchGoogleModels: (apiKey) => plugin.fetchGoogleModels(apiKey),
            fetchAnthropicModels: (apiKey) => plugin.fetchAnthropicModels(apiKey),
            fetchOpenRouterModels: () => plugin.fetchOpenRouterModels(),
            openLicenseModal: () => { new LicenseModal(app).open(); },
            openReadmeModal: () => { new READMEModal(app).open(); },
            openTemplateViewModal: () => { new TemplateViewModal(app).open(); },
            pickTemplateFile: (onPick) => { void new TemplateFilePickerModal(app, onPick).open(); },
            createInfoIcon: (container, tooltipText) => this.createInfoIcon(container, tooltipText),
            createExtraButton: (container) => new ExtraButtonComponent(container),
            createToggle: (container) => new ToggleComponent(container),
        };
    }

    // Helper function to create info icons with tooltips
    private createInfoIcon(container: HTMLElement, tooltipText: string): HTMLElement {
        // Add info icon
        const infoIcon = container.createSpan({
            cls: 'tubesage-settings-info-icon', // Apply new class
            attr: { 'aria-label': 'Information' } // Keep aria-label
        });
        
        setIcon(infoIcon, 'info');
        
        // Native Obsidian tooltip — renders reliably, positioned correctly,
        // and works on mobile (unlike the prior hover-only CSS tooltip).
        setTooltip(infoIcon, tooltipText, { placement: 'bottom' });
        
        return infoIcon;
    }
}

class TemplateFilePickerModal extends Modal {
    private result: (path: string) => void;
    private templates: { path: string }[] = [];
    private templatesFolder: string = "Templates"; // Default fallback

    constructor(app: App, callback: (path: string) => void) {
        super(app);
        this.result = callback;
        
        // Try to get template folder from Templater plugin settings if available
        const templaterSettings = getTemplaterSettings(this.app);
        if (templaterSettings?.templates_folder) {
            this.templatesFolder = normalizePath(templaterSettings.templates_folder);
        }
        
        logger.debug("Template picker initialized with templates folder:", this.templatesFolder);
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: t('modal.templatePicker.title') });
        
        // Collect template files by walking only the configured templates
        // folder subtree — no whole-vault enumeration.
        this.templates = collectUnder(this.app.vault, this.templatesFolder, 'markdown')
            .map(file => ({ path: file.path }));
        logger.debug(`Found ${this.templates.length} template files in "${this.templatesFolder}"`);
        
        // Display a message if no template files were found
        if (this.templates.length === 0) {
            contentEl.createDiv({ 
                text: t('modal.templatePicker.empty', { folder: this.templatesFolder }),
                cls: 'setting-item-description'
            });
        }

        // Create search input
        const searchEl = contentEl.createEl('input', {
            type: 'text',
            placeholder: t('modal.templatePicker.searchPlaceholder')
        });
        searchEl.addEventListener('input', () => {
            const query = searchEl.value.toLowerCase();
            this.updateTemplateList(query);
        });

        // Create template list container – reuse folder-list styling for consistency
        const templateListEl = contentEl.createDiv({ cls: ['template-list', 'folder-list'] });
        
        // Populate initial list
        this.updateTemplateList('', templateListEl);
    }

    updateTemplateList(query: string, listEl?: HTMLElement) {
        const templateListEl = listEl || activeDocument.querySelector('.template-list') as HTMLElement;
        if (!templateListEl) return;
        
        templateListEl.empty();
        
        const filteredTemplates = this.templates.filter(t => 
            t.path.toLowerCase().includes(query)
        );
        
        for (const template of filteredTemplates) {
            const item = templateListEl.createDiv({ cls: ['template-item', 'folder-item'] });
            
            // Reuse icon appearance
            const iconEl = item.createSpan({ cls: 'folder-icon' });
            iconEl.setText('📄');
            
            // Path span – mimic folder picker
            item.createSpan({ text: template.path, cls: 'folder-path' });
            
            item.addEventListener('click', () => {
                logger.debug("Selected template file:", template.path);
                this.result(template.path);
                this.close();
            });
        }
        
        if (filteredTemplates.length === 0) {
            templateListEl.createDiv({ text: t('modal.templatePicker.noMatches') });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Simple folder picker modal using Obsidian's Modal class
class FolderPickerModal extends Modal {
    private onSelectFolder: (folderPath: string) => void;
    private folders: FolderItem[] = [];
    private plugin: YouTubeTranscriptPlugin;
    
    constructor(app: App, plugin: YouTubeTranscriptPlugin, onSelectFolder: (folderPath: string) => void) {
        super(app);
        this.onSelectFolder = onSelectFolder;
        this.plugin = plugin;
    }
    
    onOpen() {
        // Run async setup without returning a promise to Modal
        void (async () => {
            await this.loadFolders();
            this.renderFolderPicker();
        })();
    }
    
    private async loadFolders() {
        try {
            // Reset folders array
            this.folders = [];
            
            // Track unique paths to prevent duplicates
            const uniquePaths = new Set<string>();
            
            // Get the root folder from settings
            const rootFolder = this.plugin.settings.transcriptRootFolder || 'Inbox';
            const normalizedRootFolder = normalizePath(rootFolder, false); // Keep leading slash
            
            // Ensure root folder exists
            try {
                // Create root folder from settings if it doesn't exist
                const rootFolderPath = normalizePath(rootFolder);
                if (!this.app.vault.getAbstractFileByPath(rootFolderPath)) {
                    await ensureFolder(this.app.vault, rootFolderPath);
                    logger.debug(`[DEBUG] Created ${rootFolderPath} folder`);
                }
            } catch (e) {
                logger.error('Error ensuring root folder exists:', e);
            }
            
            // Add root folder first — explicit, so the picker always has it
            // even if the subtree walk below returns nothing.
            this.folders.push({
                path: normalizedRootFolder,
                name: rootFolder
            });
            uniquePaths.add(normalizedRootFolder);

            // Collection of folders for summarized logging
            const foundFolders: string[] = [];

            // Walk only the configured root-folder subtree — no whole-vault
            // enumeration. transcriptRootFolder is a free-text setting, so
            // resolve it to the canonical (no leading/trailing slash) form that
            // getAbstractFileByPath expects. collectUnder includes the root
            // folder itself, which is skipped here since it was already added.
            const canonicalRoot = normalizePath(rootFolder);
            for (const folder of collectUnder(this.app.vault, canonicalRoot, 'folder')) {
                const path = folder.path;
                if (path === canonicalRoot) continue;
                const normalizedPath = normalizePath(path, false); // Keep leading slash for display
                if (!uniquePaths.has(normalizedPath)) {
                    this.folders.push({
                        path: normalizedPath,
                        name: path
                    });
                    uniquePaths.add(normalizedPath);
                    foundFolders.push(path);
                }
            }
            
            // Sort folders by path for hierarchical order
            this.folders.sort((a, b) => {
                if (a.path === normalizedRootFolder) return -1;
                if (b.path === normalizedRootFolder) return 1;
                return a.path.localeCompare(b.path);
            });
            
            // Log a summary of folders found - only show first MAX_FOLDERS_TO_LOG folders
            const MAX_FOLDERS_TO_LOG = 5;
            if (foundFolders.length > 0) {
                if (foundFolders.length <= MAX_FOLDERS_TO_LOG) {
                    logger.debug(`[DEBUG] Found folders (${foundFolders.length} total): ${foundFolders.join(', ')}`);
                } else {
                    const shownFolders = foundFolders.slice(0, MAX_FOLDERS_TO_LOG);
                    logger.debug(`[DEBUG] Found folders (${foundFolders.length} total): ${shownFolders.join(', ')}... and ${foundFolders.length - MAX_FOLDERS_TO_LOG} more`);
                }
            }
            
            logger.debug(`[DEBUG] Found ${this.folders.length} folders total, ${this.folders.length - 1} subfolders`);
        } catch (err) {
            logger.error('Error loading folders:', err);
        }
    }
    
    private renderFolderPicker() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Get the root folder name for display
        const rootFolder = this.plugin.settings.transcriptRootFolder || 'Inbox';
        const normalizedRootFolder = normalizePath(rootFolder, false); // Keep leading slash for display
        
        // Simple title only
        contentEl.createEl('h2', { text: t('modal.folderPicker.title') });
        
        // Debug info about folder count
        const rootSubfolderCount = this.folders.length - 1; // Subtract root folder itself
        if (rootSubfolderCount <= 0) {
            contentEl.createDiv({
                text: t('modal.folderPicker.empty', { folder: rootFolder }),
                cls: 'tubesage-folder-picker-status-error' // Apply new class
            });
        } else {
            contentEl.createDiv({
                text: t('modal.folderPicker.found', { count: rootSubfolderCount }),
                cls: 'tubesage-folder-picker-status-info' // Apply new class
            });
        }
        
        // Create search input
        const searchEl = contentEl.createEl('input', {
            type: 'text',
            placeholder: t('modal.folderPicker.searchPlaceholder'),
            cls: 'folder-search-input'
        });
        searchEl.focus();
        
        // Create folder list container
        const folderListEl = contentEl.createDiv({ cls: 'folder-list' });
        
        // Track the currently selected folder item
        let selectedItem: HTMLElement | null = null;
        
        // Function to select a folder item
        const selectFolderItem = (item: HTMLElement) => {
            if (selectedItem) {
                selectedItem.classList.remove('selected');
            }
            item.classList.add('selected');
            selectedItem = item;
        };
        
        // Function to render folders with filter
        const renderFolders = (filter: string = '') => {
            folderListEl.empty();
            
            // Use native JS filter to work directly with folder objects
            const lowerFilter = filter.toLowerCase().trim();
            
            // Filter if needed, otherwise show all
            const foldersToShow = !lowerFilter ? this.folders : 
                this.folders.filter(f => f.path.toLowerCase().includes(lowerFilter));
            
            logger.debug(`Displaying ${foldersToShow.length} folders`);
            
            if (foldersToShow.length === 0) {
                folderListEl.createDiv({
                    text: t('modal.folderPicker.noMatches'),
                    cls: 'empty-state'
                });
                return;
            }
            
            // Create HTML elements for each folder
            foldersToShow.forEach((folder, index) => {
                const folderEl = folderListEl.createDiv({
                    cls: 'folder-item',
                    attr: {
                        'data-path': folder.path,
                        'tabindex': '0'
                    }
                });
                
                // Auto-select the first item
                if (index === 0) {
                    selectFolderItem(folderEl);
                }
                
                // Add folder icon
                const iconEl = folderEl.createSpan({ cls: 'folder-icon' });
                iconEl.setText('📁');
                
                // For the root folder
                if (folder.path === normalizedRootFolder) {
                    folderEl.createSpan({
                        text: rootFolder,
                        cls: 'folder-path'
                    });
                }
                // For subfolders under root folder
                else {
                    // Get the full path without the leading slash using our utility
                    const displayPath = normalizePath(folder.path);
                    
                    // Create the display span with the full path
                    const textSpan = folderEl.createSpan({
                        cls: 'folder-path'
                    });
                    
                    // Set the text with the full path
                    textSpan.textContent = displayPath;
                }
                
                // Add click handler
                folderEl.addEventListener('click', () => {
                    selectFolderItem(folderEl);
                    this.selectFolder(folder.path);
                });
            });
        };
        
        // Initial render
        renderFolders('');
        
        // Filter as user types
        searchEl.addEventListener('input', () => {
            renderFolders(searchEl.value);
        });
        
        // Handle keyboard navigation
        searchEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.close();
            } else if (e.key === 'Enter') {
                if (selectedItem) {
                    selectedItem.click();
                } else {
                    const firstFolder = folderListEl.querySelector('.folder-item');
                    if (firstFolder) {
                        (firstFolder as HTMLElement).click();
                    } else {
                        // Close the modal if no folders are found
                        this.close();
                    }
                }
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                
                const items = Array.from(folderListEl.querySelectorAll('.folder-item'));
                if (items.length === 0) return;
                
                const curIndex = selectedItem ? items.indexOf(selectedItem) : -1;
                
                let newIndex;
                if (e.key === 'ArrowDown') {
                    newIndex = curIndex < items.length - 1 ? curIndex + 1 : 0;
                } else {
                    newIndex = curIndex > 0 ? curIndex - 1 : items.length - 1;
                }
                
                selectFolderItem(items[newIndex] as HTMLElement);
                items[newIndex].scrollIntoView({ block: 'nearest' });
            }
        });
    }
    
    private selectFolder(folderPath: string) {
        // Normalize the folder path - store WITHOUT leading slash for consistency
        const normalizedPath = normalizePath(folderPath);
        logger.debug("[DEBUG] Selected folder path:", folderPath);
        logger.debug("[DEBUG] Normalized folder path:", normalizedPath);
        this.onSelectFolder(normalizedPath);
        this.close();
    }
}

// Add the LicenseModal class
class LicenseModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl.instanceOf(HTMLElement)) {
            modalEl.addClass('tubesage-license-modal-size');
        }
        
        contentEl.createEl('h2', { text: t('license.modal.title') });

        // Run async work without returning a promise to Modal
        void (async () => {
        try {
            // Get the plugin folder path
            const pluginId = getPluginIdFromManifest(this.app, 'tubesage');
            
            // Try to read the license file - from multiple possible locations
            let licenseContent = '';
            let licenseFound = false;
            
            // List of possible file paths to try - use platform-independent paths with forward slashes
            const possiblePaths = [
                // Plugin directory paths
                `${this.app.vault.configDir}/plugins/${pluginId}/MIT-license-tubesage.md`,
                `${this.app.vault.configDir}/plugins/${pluginId}/LICENSE.md`,
                `${this.app.vault.configDir}/plugins/${pluginId}/license.md`,
                
                // Root directory paths
                `MIT-license-tubesage.md`,
                `LICENSE.md`,
                `license.md`
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    // Always normalize path before reading to ensure consistent slashes
                    const normalizedPath = normalizePath(filePath);
                    logger.debug(`Trying to find license file at: ${normalizedPath}`);
                    licenseContent = await this.app.vault.adapter.read(normalizedPath);
                    logger.debug(`License file found at: ${normalizedPath}`);
                    licenseFound = true;
                    break;
                } catch (e) {
                    logger.debug(`Failed to read license file at ${filePath}:`, e);
                    // Continue to next path
                }
            }
            
            if (!licenseFound) {
                throw new Error('Could not find license file in any of the expected locations.');
            }
            
            // Create a div for the license content with scrollable style
            const licenseContainer = contentEl.createDiv({
                cls: 'tubesage-license-container'
            });
            
            // Process the license markdown content
            const lines = licenseContent.split('\n');
            let inList = false;
            
            for (const line of lines) {
                // Handle headers
                if (line.startsWith('# ')) {
                    inList = false;
                    licenseContainer.createEl('h3', { text: line.substring(2), cls: 'tubesage-license-h3' });
                }
                // Handle list items
                else if (line.match(/^\d+\.\s+\*\*.*\*\*/)) {
                    inList = true;
                    const listItem = licenseContainer.createDiv({ cls: 'tubesage-license-list-item' });
                    
                    // Extract and format the list item
                    const match = line.match(/^(\d+)\.\s+\*\*(.*?)\*\*:\s+(.*)/);
                    if (match) {
                        const [, number, title, content] = match;
                        
                        listItem.createSpan({
                            text: t('modal.license.listItem', { number, title }),
                            cls: 'tubesage-license-list-item-title-segment',
                        });
                        
                        listItem.createSpan({ text: content });
                    } else {
                        listItem.setText(line);
                    }
                }
                // Handle list sub-items
                else if (inList && line.match(/^\s+-\s+/)) {
                    const subItem = licenseContainer.createDiv({ cls: 'tubesage-license-sub-item' });
                    subItem.setText(line.replace(/^\s+-\s+/, '• '));
                }
                // Handle normal paragraphs
                else if (line.trim() !== '') {
                    inList = false;
                    licenseContainer.createEl('p', { text: line, cls: 'tubesage-license-paragraph' });
                }
                // Handle empty lines
                else {
                    licenseContainer.createDiv({ cls: 'tubesage-license-spacer' });
                }
            }
        } catch (error) {
            // Handle error if license file can't be read
            logger.error('Error loading license file:', error);
            contentEl.createEl('p', { 
                text: t('license.modal.loadError'),
                cls: 'tubesage-license-load-error' // Apply new class
            });
        }
        
        // Add close button
        const footerEl = contentEl.createDiv({
            cls: 'tubesage-license-footer' // Apply new class
        });
        
        const closeButton = new ButtonComponent(footerEl);
        closeButton.setButtonText(t('common.close'));
        closeButton.buttonEl.addClass('tubesage-license-close-button');
        closeButton.onClick(() => {
            this.close();
        });
        })();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the LicenseRequiredModal class
class LicenseRequiredModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl.instanceOf(HTMLElement)) {
            modalEl.addClass('tubesage-license-required-modal-size');
        }
        
        // Add title
        contentEl.createEl('h2', { 
            text: t('license.required.title'), 
            cls: 'tubesage-license-required-title' // Apply new class
        });
        
        // Add warning icon
        const iconContainer = contentEl.createDiv({ 
            cls: 'tubesage-license-required-icon-container' // Apply new class
        });
        
        iconContainer.createSpan({ 
            cls: 'tubesage-license-required-icon', // Apply new class
            attr: { 'aria-hidden': 'true' },
            text: '⚠️'
        });
        
        // Add message
        const messageDiv = contentEl.createDiv({
            cls: 'tubesage-license-required-message-container' // Apply new class
        });
        
        messageDiv.createEl('p', {
            text: t('license.required.message'),
            cls: 'tubesage-license-required-message-bold' // Apply new class
        });
        
        messageDiv.createEl('p', {
            text: t('license.required.instruction')
        });
        
        // Add instructions with steps
        const stepsDiv = contentEl.createDiv({
            cls: 'tubesage-license-required-steps-container' // Apply new class
        });
        
        stepsDiv.createEl('p', {
            text: t('license.required.stepsTitle'),
            cls: 'tubesage-license-required-steps-title' // Apply new class
        });
        
        const steps = [
            t('license.required.step1'),
            t('license.required.step2'),
            t('license.required.step3'),
            t('license.required.step4'),
            t('license.required.step5'),
        ];
        
        const stepsList = stepsDiv.createEl('ol', {
            cls: 'tubesage-license-required-steps-list' // Apply new class
        });
        
        steps.forEach(step => {
            stepsList.createEl('li', {
                text: step,
                cls: 'tubesage-license-required-step-item' // Apply new class
            });
        });
        
        // Add buttons
        const buttonContainer = contentEl.createDiv({
            cls: 'tubesage-license-required-button-container' // Apply new class
        });
        
        // Open settings button
        const openSettingsButton = new ButtonComponent(buttonContainer);
        openSettingsButton.setButtonText(t('license.required.openSettings'));
        openSettingsButton.buttonEl.addClass('tubesage-license-required-button-primary');
        openSettingsButton.onClick(() => {
            this.close();
            const appWithSettings = this.app as App & { setting?: { open?: (id: string) => void } };
            appWithSettings.setting?.open?.('tubesage');
        });

        // Close button
        const closeButton = new ButtonComponent(buttonContainer);
        closeButton.setButtonText(t('common.close'));
        closeButton.buttonEl.addClass('tubesage-license-required-button-secondary');
        closeButton.onClick(() => {
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the READMEModal class
class READMEModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl.instanceOf(HTMLElement)) {
            modalEl.addClass('tubesage-readme-modal-size');
        }
        
        contentEl.createEl('h2', { text: t('modal.readme.title') });

        // Run async work without returning a promise to Modal
        void (async () => {
        try {
            // Get the plugin folder path
            const pluginId = getPluginIdFromManifest(this.app, 'tubesage');
            
            // Try to read the README file from multiple possible locations
            let readmeContent = '';
            let readmeFound = false;
            
            // List of possible file paths to try - use platform-independent paths with forward slashes
            const possiblePaths = [
                // Plugin directory paths
                `${this.app.vault.configDir}/plugins/${pluginId}/README.md`,
                `${this.app.vault.configDir}/plugins/${pluginId}/readme.md`,
                
                // Root directory paths
                `README.md`,
                `readme.md`
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    // Always normalize path before reading to ensure consistent slashes
                    const normalizedPath = normalizePath(filePath);
                    logger.debug(`Trying to find README file at: ${normalizedPath}`);
                    readmeContent = await this.app.vault.adapter.read(normalizedPath);
                    logger.debug(`README file found at: ${normalizedPath}`);
                    readmeFound = true;
                    break;
                } catch (e) {
                    logger.debug(`Failed to read README file at ${filePath}:`, e);
                    // Continue to next path
                }
            }
            
            if (!readmeFound) {
                throw new Error('Could not find readme file in any of the expected locations.');
            }
            
            // Create a div for the README content with scrollable style
            const readmeContainer = contentEl.createDiv({
                cls: 'tubesage-readme-container'
            });
            
            // Process the README markdown content
            const lines = readmeContent.split('\n');
            let inCodeBlock = false;
            let codeLanguage = '';
            
            for (const line of lines) {
                // Handle code blocks
                if (line.startsWith('```')) {
                    if (!inCodeBlock) {
                        // Start of code block
                        inCodeBlock = true;
                        codeLanguage = line.substring(3).trim();
                        
                        // Create code block container
                        const codeContainer = readmeContainer.createDiv({
                            cls: 'code-block-container' // Style now in CSS
                        });
                        
                        // Add language tag if specified
                        if (codeLanguage) {
                            codeContainer.createDiv({
                                text: codeLanguage,
                                cls: 'tubesage-readme-code-lang' // Apply new class
                            });
                        }
                        
                        // Create pre>code element for the code
                        const pre = codeContainer.createEl('pre', {
                            cls: 'tubesage-readme-code-pre' // Apply new class
                        });
                        pre.createEl('code', {
                            cls: `tubesage-readme-code-inline ${codeLanguage ? 'language-' + codeLanguage : ''}`.trim() // Apply new class and existing language class
                        });
                    } else {
                        // End of code block
                        inCodeBlock = false;
                        codeLanguage = '';
                    }
                    continue;
                }
                
                // Add lines to code block
                if (inCodeBlock) {
                    const codeContainer = readmeContainer.querySelector('.code-block-container:last-child');
                    if (codeContainer) {
                        const code = codeContainer.querySelector('code');
                        if (code) {
                            const textNode = activeDocument.createTextNode(line + '\n');
                            code.appendChild(textNode);
                        }
                    }
                    continue;
                }
                
                // Handle headers
                if (line.startsWith('# ')) {
                    readmeContainer.createEl('h1', { text: line.substring(2), cls: 'tubesage-readme-h1' });
                } else if (line.startsWith('## ')) {
                    readmeContainer.createEl('h2', { text: line.substring(3), cls: 'tubesage-readme-h2' });
                } else if (line.startsWith('### ')) {
                    readmeContainer.createEl('h3', { text: line.substring(4), cls: 'tubesage-readme-h3' });
                } else if (line.startsWith('#### ')) {
                    readmeContainer.createEl('h4', { text: line.substring(5), cls: 'tubesage-readme-h4' });
                }
                // Handle list items
                else if (line.match(/^[*+-]\s/)) {
                    const listItem = readmeContainer.createDiv({ cls: 'tubesage-readme-list-item' });
                    
                    // Bullet
                    listItem.createSpan({ text: '• ', cls: 'tubesage-readme-list-bullet' });
                    
                    // Content
                    const content = line.replace(/^[*+-]\s/, '');
                    if (content.includes('[') && content.includes('](')) {
                        // Handle links in list items
                        const parts = this.splitMarkdownLink(content);
                        const contentSpan = listItem.createSpan();
                        
                        parts.forEach(part => {
                            if (part.isLink) {
                                contentSpan.createEl('a', {
                                    text: part.text,
                                    attr: {
                                        href: part.url || '#',
                                        cls: 'tubesage-readme-link' // Apply new class
                                    }
                                });
                            } else {
                                // Process bold text in list items
                                this.renderTextWithBold(contentSpan, part.text);
                            }
                        });
                    } else {
                        // Process bold text in list items
                        this.renderTextWithBold(listItem, content);
                    }
                }
                // Handle normal paragraphs
                else if (line.trim() !== '') {
                    const para = readmeContainer.createEl('p', { cls: 'tubesage-readme-paragraph' });
                    
                    // Check for links
                    if (line.includes('[') && line.includes('](')) {
                        const parts = this.splitMarkdownLink(line);
                        
                        parts.forEach(part => {
                            if (part.isLink) {
                                para.createEl('a', {
                                    text: part.text,
                                    attr: {
                                        href: part.url || '#',
                                        cls: 'tubesage-readme-link' // Apply new class
                                    }
                                });
                            } else {
                                // Process bold text in paragraphs
                                this.renderTextWithBold(para, part.text);
                            }
                        });
                    } else {
                        // Process bold text in paragraphs
                        this.renderTextWithBold(para, line);
                    }
                }
                // Handle empty lines with more spacing between sections
                else {
                    readmeContainer.createDiv({ cls: 'tubesage-readme-spacer' });
                }
            }
        } catch (error) {
            // Handle error if README file can't be read
            logger.error('Error loading README file:', error);
            contentEl.createEl('p', { 
                text: t('modal.readme.loadError'),
                cls: 'tubesage-license-load-error' // Assumes this class is defined and appropriate
            });
        }
        
        // Add close button
        const footerEl = contentEl.createDiv({
            cls: 'tubesage-license-footer' // Reuse existing class
        });
        
        const closeButton = new ButtonComponent(footerEl);
        closeButton.setButtonText(t('common.close'));
        closeButton.buttonEl.addClass('tubesage-readme-close-button');
        closeButton.onClick(() => {
            this.close();
        });
        })();
    }

    // Helper to handle markdown links
    private splitMarkdownLink(text: string): Array<{text: string, url?: string, isLink: boolean}> {
        const parts: Array<{text: string, url?: string, isLink: boolean}> = [];
        let remaining = text;
        let currentIndex = 0;
        
        // First check for image links inside regular links - pattern: [![alt](image-url)](link-url)
        const imageInsideLinkRegex = /\[!\[(.*?)\]\((.*?)\)\]\((.*?)\)/g;
        let match;

        // Process all image+link combinations first
        while ((match = imageInsideLinkRegex.exec(remaining)) !== null) {
            // Add text before the image+link
            if (match.index > currentIndex) {
                parts.push({
                    text: remaining.substring(currentIndex, match.index),
                    isLink: false
                });
            }
            
            // Extract the link components: alt text, image URL, and target URL
            const [fullMatch, altText, , targetUrl] = match;
            
            // Add as a link (we'll ignore the image and just use the alt text)
            parts.push({
                text: altText || "Link",
                url: targetUrl,
                isLink: true
            });
            
            // Update the current index
            currentIndex = match.index + fullMatch.length;
        }
        
        // If we processed any image+link combinations, update remaining text
        if (currentIndex > 0) {
            remaining = remaining.substring(currentIndex);
            currentIndex = 0;
        }
        
        // Now process regular links as before
        while (currentIndex < remaining.length) {
            // Skip image links - they're not clickable by themselves
            const imageMatch = remaining.indexOf('![', currentIndex);
            if (imageMatch !== -1 && (imageMatch === currentIndex || remaining.charAt(imageMatch-1) !== '\\')) {
                // Find the closing parenthesis for the image
                const closingParen = remaining.indexOf(')', imageMatch);
                if (closingParen !== -1) {
                    // Add text before the image
                    if (imageMatch > currentIndex) {
                        parts.push({
                            text: remaining.substring(currentIndex, imageMatch),
                            isLink: false
                        });
                    }
                    
                    // Skip the image and continue parsing after it
                    currentIndex = closingParen + 1;
                    continue;
                }
            }
            
            // Find opening bracket for regular links
            const openBracketIndex = remaining.indexOf('[', currentIndex);
            
            // No more links, add the rest as plain text
            if (openBracketIndex === -1) {
                parts.push({
                    text: remaining.substring(currentIndex),
                    isLink: false
                });
                break;
            }
            
            // Make sure this is not an escaped bracket or part of an image
            const isEscaped = openBracketIndex > 0 && remaining.charAt(openBracketIndex - 1) === '\\';
            const isImage = openBracketIndex > 0 && remaining.charAt(openBracketIndex - 1) === '!';
            
            if (isEscaped || isImage) {
                // Add text up to and including this bracket, then continue
                parts.push({
                    text: remaining.substring(currentIndex, openBracketIndex + 1),
                    isLink: false
                });
                currentIndex = openBracketIndex + 1;
                continue;
            }
            
            // Add text before the link
            if (openBracketIndex > currentIndex) {
                parts.push({
                    text: remaining.substring(currentIndex, openBracketIndex),
                    isLink: false
                });
            }
            
            // Find closing bracket and opening parenthesis
            const closeBracketIndex = remaining.indexOf(']', openBracketIndex);
            if (closeBracketIndex === -1) {
                // Malformed link, treat as text
                parts.push({
                    text: remaining.substring(openBracketIndex),
                    isLink: false
                });
                break;
            }
            
            // Check for opening parenthesis immediately after closing bracket
            if (remaining.charAt(closeBracketIndex + 1) !== '(') {
                // Not a link, just brackets
                parts.push({
                    text: remaining.substring(openBracketIndex, closeBracketIndex + 1),
                    isLink: false
                });
                currentIndex = closeBracketIndex + 1;
                continue;
            }
            
            // Find closing parenthesis
            const closeParenIndex = remaining.indexOf(')', closeBracketIndex);
            if (closeParenIndex === -1) {
                // Malformed link, treat as text
                parts.push({
                    text: remaining.substring(openBracketIndex),
                    isLink: false
                });
                break;
            }
            
            // Extract link text and URL
            const linkText = remaining.substring(openBracketIndex + 1, closeBracketIndex);
            const linkUrl = remaining.substring(closeBracketIndex + 2, closeParenIndex);
            
            parts.push({
                text: linkText,
                url: linkUrl,
                isLink: true
            });
            
            currentIndex = closeParenIndex + 1;
        }
        
        return parts;
    }
    
    // Helper to render text with bold formatting
    private renderTextWithBold(container: HTMLElement, text: string): void {
        // Split by bold markers
        const parts = text.split(/(\*\*.*?\*\*)/g);
        
        for (const part of parts) {
            // Check if this part is bold (surrounded by **)
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                // Extract the text between ** markers and create a bold element
                const boldText = part.substring(2, part.length - 2);
                container.createEl('strong', { text: boldText });
            } else if (part.trim() !== '') {
                // Regular text
                container.createSpan({ text: part });
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add the TemplateViewModal class
class TemplateViewModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        // Add CSS class for proper styling
        const modalEl = (this as unknown as { modalEl?: HTMLElement }).modalEl;
        if (modalEl && modalEl.instanceOf(HTMLElement)) {
            modalEl.addClass('tubesage-template-view-modal-size');
        }
        
            contentEl.createEl('h2', { 
                text: t('modal.template.title'),
            cls: 'tubesage-template-view-title'
        });

        // Run async work without returning a promise to Modal
        void (async () => {
        try {
            // Get the plugin folder path
            const pluginId = getPluginIdFromManifest(this.app, 'tubesage');
            
            // Try to read the template file from multiple possible locations
            let templateContent = '';
            let templateFound = false;
            
            // List of possible file paths to try
            const possiblePaths = [
                // Plugin directory paths
                normalizePath(`${this.app.vault.configDir}/plugins/${pluginId}/templates/YouTubeTranscript.md`),
                normalizePath(`${this.app.vault.configDir}/plugins/${pluginId}/templates/youtubeTranscript.md`),
                
                // Standard templates directory paths
                normalizePath('templates/YouTubeTranscript.md'),
                normalizePath('templates/youtubeTranscript.md'),
                normalizePath('Templates/YouTubeTranscript.md'),
                normalizePath('Templates/youtubeTranscript.md')
            ];
            
            // Try each path in sequence
            for (const filePath of possiblePaths) {
                try {
                    logger.debug(`Trying to find template file at: ${filePath}`);
                    templateContent = await this.app.vault.adapter.read(filePath);
                    logger.debug(`Template file found at: ${filePath}`);
                    templateFound = true;
                    break;
                } catch (error) {
                    logger.debug(`Failed to read template file at ${filePath}:`, error);
                    // Continue to next path
                }
            }
            
            if (!templateFound) {
                throw new Error('Could not find template file in any of the expected locations.');
            }
            
            // Create a div for the template content with scrollable style
            const templateContainer = contentEl.createDiv({
                cls: ['tubesage-template-view-container', 'tubesage-template-view-container-short']
            });
            
            // Add a subtle separator line for spacing
            contentEl.createDiv({
                cls: 'tubesage-divider'
            });
            
            // Create a container for the copy button
            const copyContainer = contentEl.createDiv({
                cls: ['tubesage-template-view-copy-container', 'tubesage-row-end']
            });
            
            // Add copy text
            copyContainer.createSpan({ 
                text: t('modal.template.copy'),
                cls: 'tubesage-template-view-copy-text'
            });
            
            // Make the text also clickable
            const copyTextElement = copyContainer.querySelector('span');

            // Function to handle copy
            const handleCopy = () => {
                navigator.clipboard.writeText(templateContent)
                    .then(() => {
                        // Show success state
                        if (copyTextElement) {
                            const originalText = copyTextElement.textContent;
                            copyTextElement.textContent = t('modal.template.copied');
                            window.setTimeout(() => {
                                copyTextElement.textContent = originalText;
                            }, 2000);
                        }
                    })
                    .catch(err => {
                        logger.error('Failed to copy template:', err);
                        // Show error state
                        if (copyTextElement) {
                            copyTextElement.textContent = t('modal.template.copyFailed');
                            window.setTimeout(() => {
                                copyTextElement.textContent = t('modal.template.copy');
                            }, 2000);
                        }
                    });
            };

            // Copy icon button
            new ExtraButtonComponent(copyContainer)
                .setIcon('copy')
                .setTooltip(t('modal.template.copy'))
                .onClick(handleCopy);

            if (copyTextElement) {
                copyTextElement.addEventListener('click', handleCopy);
            }
            
            // Display the content with syntax highlighting
            templateContainer.createEl('pre', {
                cls: 'language-markdown',
                text: templateContent
            });
            
            // Add explanation
            contentEl.createDiv({
                text: t('modal.template.explanation'),
                cls: 'tubesage-template-view-explanation'
            });
            
            // Add Templater variables explanation
            const variablesContainer = contentEl.createDiv({
                cls: 'tubesage-template-view-variables-container'
            });
            
            variablesContainer.createEl('h3', {text: t('modal.template.variablesHeading')});
            
            // `desc` carries its own leading separator, so the line is one
            // translated string rather than punctuation glued to a translated
            // fragment. The variable names are Templater identifiers, never translated.
            const variables = [
                {name: 'tp.user.title', desc: t('modal.template.var.title.desc')},
                {name: 'tp.user.videoUrl', desc: t('modal.template.var.videoUrl.desc')},
                {name: 'tp.user.transcript', desc: t('modal.template.var.transcript.desc')},
                {name: 'tp.user.summary', desc: t('modal.template.var.summary.desc')},
                {name: 'tp.user.llmProvider', desc: t('modal.template.var.llmProvider.desc')},
                {name: 'tp.user.llmModel', desc: t('modal.template.var.llmModel.desc')},
                {name: 'tp.user.llmTags', desc: t('modal.template.var.llmTags.desc')}
            ];
            
            const varList = variablesContainer.createEl('ul');
            variables.forEach(v => {
                const item = varList.createEl('li');
                item.createEl('code', {text: v.name});
                item.createSpan({text: v.desc});
            });
        } catch (error) {
            // Handle error if template file can't be read
            logger.error('Error loading template file:', error);
            contentEl.createEl('p', { 
                text: t('modal.template.loadError'),
                cls: 'tubesage-license-load-error' // Reuse existing class for error messages
            });
        }
        
        // Add close button
        const footerEl = contentEl.createDiv({
            cls: ['tubesage-license-footer', 'tubesage-row-end']
        });
        
        const closeButton = new ButtonComponent(footerEl);
        closeButton.setButtonText(t('common.close'));
        closeButton.buttonEl.addClass('tubesage-license-close-button');
        closeButton.onClick(() => {
            this.close();
        });
        })();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Add this interface at the top of the file after the existing imports
