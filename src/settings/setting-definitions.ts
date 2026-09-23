// Declarative settings-tab definitions (Obsidian 1.13 `getSettingDefinitions`).
// Pure: only `import type` from obsidian, so the builder is unit-testable with
// a host double. Everything that needs the Obsidian runtime (modals, secret
// storage, icons, model fetches) is injected through `SettingsHost`.
//
// Migration notes (issue #5). The row handlers were moved out of the legacy
// imperative display() unchanged apart from the mechanical substitutions
// `this.plugin.settings` -> `host.settings`, `this.plugin.saveSettings()` ->
// `host.saveSettings()` and `this.display()` -> `host.update()`. Rows whose
// behaviour is a plain one-key bind are `control` definitions and persist via
// the tab's setControlValue override (which routes through saveSettings, never
// raw saveData). Every other row is a `render` definition and saves itself
// exactly as before.
import type {
    DropdownComponent,
    ExtraButtonComponent,
    Setting,
    SettingDefinitionGroup,
    SettingDefinitionItem,
    SettingDefinitionRender,
    SettingGroupItem,
    TextComponent,
    ToggleComponent,
} from 'obsidian';
import { t } from '../i18n';
import { getLogger, LogLevel, setGlobalLogLevel } from '../utils/logger';
import { getEffectiveLimits, isModelSupported } from '../utils/model-limits-registry';
import type { YouTubeTranscriptSettings } from './settings-defaults';

const logger = getLogger('PLUGIN');

/** A model discovered by one of the per-provider refresh fetchers. */
export interface FetchedModelInfo {
    id: string;
    contextK?: number;   // context window in thousands
    maxOutputK?: number; // max output in thousands
}

/**
 * Everything the definition builder needs from the plugin / settings tab.
 * Deliberately exposes neither `saveData` nor `display`: render rows can only
 * persist through `saveSettings()` and can only refresh through `update()`.
 */
export interface SettingsHost {
    readonly settings: YouTubeTranscriptSettings;
    readonly defaults: Pick<YouTubeTranscriptSettings, 'systemPrompt' | 'userPrompt' | 'extensiveSystemPrompt' | 'extensiveUserPrompt'>;
    saveSettings(): Promise<void>;
    /** SettingTab.update(): re-run getSettingDefinitions() and re-render. */
    update(): void;
    showNotice(message: string, timeout: number): void;
    getEffectiveMaxTokens(): number;
    /** Store a cloud-provider key in Obsidian secret storage (no-op for ollama). */
    setSecret(provider: string, value: string): void;
    fetchOpenAIModels(apiKey: string): Promise<FetchedModelInfo[]>;
    fetchGoogleModels(apiKey: string): Promise<FetchedModelInfo[]>;
    fetchAnthropicModels(apiKey: string): Promise<FetchedModelInfo[]>;
    fetchOpenRouterModels(): Promise<FetchedModelInfo[]>;
    openLicenseModal(): void;
    openReadmeModal(): void;
    openTemplateViewModal(): void;
    pickTemplateFile(onPick: (path: string) => void): void;
    createInfoIcon(container: HTMLElement, tooltipText: string): HTMLElement;
    createExtraButton(container: HTMLElement): ExtraButtonComponent;
    createToggle(container: HTMLElement): ToggleComponent;
}

type Render = SettingDefinitionRender['render'];

// --- control accessors (PluginSettingTab.getControlValue/setControlValue) ---
//
// The default setControlValue writes `this.plugin.settings[key]` and calls raw
// `plugin.saveData(settings)`. That would (1) write the in-memory cloud API
// keys into data.json, bypassing settingsForPersist, (2) bypass the JobStore's
// serialized writer and clobber `_jobs`, and (3) skip initializeSummarizer().
// These accessors are what the tab's overrides delegate to: same dot-notation
// path walk as the official "custom settings storage" recipe, but the write
// is persisted through saveSettings().

function getPath(obj: object, path: string): unknown {
    let cursor: unknown = obj;
    for (const part of path.split('.')) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
}

function setPath(obj: object, path: string, value: unknown): void {
    const parts = path.split('.');
    const last = parts.pop();
    if (last === undefined) return;
    let cursor = obj as Record<string, unknown>;
    for (const part of parts) {
        let next = cursor[part];
        if (next === null || typeof next !== 'object') {
            next = {};
            cursor[part] = next;
        }
        cursor = next as Record<string, unknown>;
    }
    cursor[last] = value;
}

export function readSettingValue(settings: YouTubeTranscriptSettings, key: string): unknown {
    return getPath(settings, key);
}

export async function writeSettingValue(host: SettingsHost, key: string, value: unknown): Promise<void> {
    setPath(host.settings, key, value);
    await host.saveSettings();
}

// --- provider catalog -------------------------------------------------------

// Provider catalog — keys, display names, placeholders, model lists, defaults.
// Defined once so both the always-rendered API key rows and the
// selected-provider-only config block draw from the same source.
interface ProviderCatalogEntry {
    provider: string;
    displayName: string;
    placeholder: string;
    modelOptions: string[];
    defaultModelValue: string;
}

const providerCatalog: ProviderCatalogEntry[] = [
    {
        provider: 'openai',
        displayName: 'OpenAI',
        placeholder: 'sk-...',
        modelOptions: [
            'gpt-5',
            'gpt-4.5',
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-4',
            'gpt-3.5-turbo',
            'o1',
            'o1-pro',
            'o3-mini',
            'o3-mini-high',
        ],
        defaultModelValue: 'gpt-4-turbo',
    },
    {
        provider: 'anthropic',
        displayName: 'Anthropic',
        placeholder: 'sk-ant-...',
        modelOptions: [
            'claude-opus-4-0',
            'claude-opus-4-1',
            'claude-sonnet-4-0',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
        ],
        defaultModelValue: 'claude-3-sonnet-20240229',
    },
    {
        provider: 'google',
        displayName: 'Google',
        placeholder: 'AIza...',
        modelOptions: [
            'gemini-2.5-flash',
            'gemini-2.5-pro-exp-03-25',
            'gemini-2.0-flash-exp',
            'gemini-2.0-pro-exp-02-05',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-1.5-flash-8b',
            'gemini-nano',
            'gemini-ultra (beta)',
            'gemini-pro',
            'gemini-pro-vision',
        ],
        defaultModelValue: 'gemini-1.5-pro',
    },
    {
        provider: 'ollama',
        displayName: 'Ollama',
        placeholder: 'http://localhost:11434',
        modelOptions: [
            'llama3.1',
            'llama3.1:8b',
            'llama3.1:70b',
            'mistral',
            'mixtral',
            'gemma',
            'codellama',
            'phi',
            'wizardcoder',
            'solar',
        ],
        defaultModelValue: 'llama3.1',
    },
    {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        placeholder: 'sk-or-v1-...',
        modelOptions: [
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'anthropic/claude-3.5-sonnet',
            'anthropic/claude-3.5-haiku',
            'google/gemini-2.5-flash',
            'meta-llama/llama-3.1-70b-instruct',
            'mistralai/mistral-large',
        ],
        defaultModelValue: 'openai/gpt-4o',
    },
];

// --- the builder ------------------------------------------------------------

/**
 * Build the settings tab. Cheap and side-effect free: it is called on every
 * update() and once at registration for search indexing. All DOM work and
 * every side effect lives inside the render callbacks.
 */
export function buildSettingDefinitions(host: SettingsHost): SettingDefinitionItem[] {
    // License gate. The legacy tab wrapped everything below the support block
    // in a container that was greyed out and made inert until the license was
    // accepted. Declaratively: every `control` carries this predicate as
    // `disabled`, and every `render` row is wrapped by `gated`, which disables
    // the row's components after it is built and applies the legacy greyed
    // style to the row. The license toggle calls update() so both paths are
    // re-evaluated.
    const locked = (): boolean => !host.settings.licenseAccepted;
    const gated = (render: Render): Render => (setting, group) => {
        const cleanup = render(setting, group);
        const isLocked = locked();
        setting.setDisabled(isLocked);
        setting.settingEl.toggleClass('tubesage-settings-locked', isLocked);
        return cleanup;
    };

    // Section-heading info icons (legacy createInfoIcon on the heading text)
    // become header extra buttons: native tooltip, works on mobile.
    const headingInfo = (tooltipText: string): SettingDefinitionGroup['extraButtons'] => [
        (button: ExtraButtonComponent) => {
            button.setIcon('info').setTooltip(tooltipText, { placement: 'bottom' });
            button.extraSettingsEl.addClass('tubesage-settings-info-icon');
        },
    ];

    // Password-style key inputs: hidden with dots, revealed while focused.
    const maskInput = (inputEl: HTMLInputElement | undefined): void => {
        if (inputEl) {
            inputEl.type = 'password';
            inputEl.addEventListener('focus', () => {
                inputEl.type = 'text';
            });
            inputEl.addEventListener('blur', () => {
                inputEl.type = 'password';
            });
        }
    };

    const items: SettingDefinitionItem[] = [];

    // ---- Support development ------------------------------------------------
    // Free-form block (heading, blurb, Buy Me a Coffee, license + README
    // buttons, license toggle). One heading row whose control cell holds the
    // legacy block: the control cell is the part of a row Obsidian clears
    // before re-rendering it, so nothing duplicates across update() calls.
    // Not gated (the license toggle lives here).
    items.push({
        type: 'group',
        items: [
            {
                name: t('settings.support.name'),
                searchable: false,
                render: (setting) => {
                    setting.setHeading();
                    setting.settingEl.addClass('tubesage-heading', 'tubesage-settings-support-row');
                    const supportContainer = setting.controlEl.createDiv({
                        cls: 'tubesage-settings-support-container',
                    });

                    // Support message in appearance format
                    supportContainer.createDiv({
                        text: t('settings.support.blurb'),
                        cls: 'tubesage-settings-support-desc',
                    });

                    // Add italicized mission statement
                    supportContainer.createDiv({
                        text: t('settings.support.mission'),
                        cls: ['tubesage-settings-support-desc', 'tubesage-mission-italic'],
                    });

                    // Buy Me a Coffee button in a container
                    const bmcContainer = supportContainer.createDiv({
                        cls: 'tubesage-settings-bmc-container',
                    });

                    // Create the link
                    const bmcLink = bmcContainer.createEl('a', {
                        href: 'https://www.buymeacoffee.com/RMcCorkle',
                        attr: {
                            target: '_blank',
                            rel: 'noopener',
                        },
                    });

                    // Add the image (bundled as base64 to avoid external dependencies)
                    bmcLink.createEl('img', {
                        cls: 'tubesage-settings-bmc-img',
                        attr: {
                            src: BMC_IMAGE_DATA_URI,
                            alt: 'Buy Me A Coffee',
                        },
                    });

                    // Create a horizontal container for the remaining buttons
                    const buttonsContainer = supportContainer.createDiv({
                        cls: 'tubesage-settings-action-buttons-container',
                    });

                    // License button - in the middle
                    const licenseButtonContainer = buttonsContainer.createDiv({
                        cls: 'tubesage-settings-action-button-item-container',
                    });

                    // License text
                    licenseButtonContainer.createSpan({
                        text: t('settings.support.license.label'),
                        cls: 'tubesage-settings-action-button-label',
                    });

                    // Eye icon button for viewing license
                    host.createExtraButton(licenseButtonContainer)
                        .setIcon('eye')
                        .setTooltip(t('settings.support.license.viewTooltip'))
                        .onClick(() => {
                            host.openLicenseModal();
                        });

                    // License acceptance toggle - on the right
                    const toggleContainer = buttonsContainer.createDiv({
                        cls: 'tubesage-settings-action-button-item-container',
                    });

                    toggleContainer.createSpan({
                        text: t('settings.support.license.acceptLabel'),
                        cls: 'tubesage-settings-action-button-label',
                    });

                    // Create native Obsidian toggle
                    const licenseToggle = host.createToggle(toggleContainer);
                    licenseToggle.setValue(host.settings.licenseAccepted);

                    // README button - after the license toggle
                    const readmeButtonContainer = buttonsContainer.createDiv({
                        cls: 'tubesage-settings-action-button-item-container',
                    });

                    // README text
                    readmeButtonContainer.createSpan({
                        text: 'README',
                        cls: 'tubesage-settings-action-button-label',
                    });

                    // Eye icon button for viewing README
                    host.createExtraButton(readmeButtonContainer)
                        .setIcon('eye')
                        .setTooltip(t('settings.support.readme.viewTooltip'))
                        .onClick(() => {
                            host.openReadmeModal();
                        });

                    // Add change listener to native toggle. update() re-runs
                    // every license-gate predicate (legacy: updateSettingsState).
                    licenseToggle.onChange((value) => {
                        host.settings.licenseAccepted = value;
                        void host.saveSettings().then(() => host.update());
                    });
                },
            },
        ],
    });

    // ---- Templates ------------------------------------------------------------
    items.push({
        type: 'group',
        heading: t('settings.templates.heading'),
        cls: 'tubesage-heading',
        items: [
            {
                name: t('settings.templates.templaterFile.name'),
                desc: t('settings.templates.templaterFile.desc'),
                render: gated((setting) => {
                    setting.addText(text => text
                        .setPlaceholder('templates/YouTubeTranscript.md')
                        .setValue(host.settings.templaterTemplateFile)
                        .onChange((value: string) => {
                            void (async () => {
                                host.settings.templaterTemplateFile = value;
                                await host.saveSettings();
                            })();
                        }));

                    // Add Browse button
                    setting.addExtraButton(button => {
                        button
                            .setIcon('folder')
                            .setTooltip(t('settings.templates.templaterFile.browseTooltip'))
                            .onClick(() => {
                                // Show a file picker modal
                                host.pickTemplateFile((selectedPath) => {
                                    if (selectedPath) {
                                        host.settings.templaterTemplateFile = selectedPath;
                                        void host.saveSettings();
                                        host.update();
                                    }
                                });
                            });
                    });
                }),
            },
            {
                // Example-template viewer: an unnamed row with "Example" text
                // next to an eye button (legacy: text prepended to the control
                // element via a deferred querySelector; here the control
                // element is at hand).
                name: '',
                searchable: false,
                render: gated((setting) => {
                    setting.controlEl.createSpan({ text: t('settings.templates.example.label') });
                    setting.addExtraButton(button => {
                        button
                            .setIcon('eye')
                            .setTooltip(t('settings.templates.example.viewTooltip'))
                            .onClick(() => {
                                host.openTemplateViewModal();
                            });
                    });
                }),
            },
        ],
    });

    // ---- Transcripts ----------------------------------------------------------
    items.push({
        type: 'group',
        heading: t('settings.transcripts.heading'),
        cls: 'tubesage-heading',
        extraButtons: headingInfo(
            t('settings.transcripts.info')
        ),
        items: [
            {
                name: t('settings.transcripts.rootFolder.name'),
                desc: t('settings.transcripts.rootFolder.desc'),
                control: { type: 'text', key: 'transcriptRootFolder', placeholder: 'Inbox', disabled: locked },
            },
            {
                name: t('settings.transcripts.youtubeApiKey.name'),
                desc: t('settings.transcripts.youtubeApiKey.desc'),
                render: gated((setting) => {
                    setting.addText(text => {
                        const textComponent = text
                            .setPlaceholder(t('settings.transcripts.youtubeApiKey.placeholder'))
                            .setValue(host.settings.youtubeApiKey)
                            .onChange((value: string) => {
                                void (async () => {
                                    host.settings.youtubeApiKey = value;
                                    await host.saveSettings();
                                })();
                            });
                        maskInput(textComponent.inputEl);
                        return textComponent;
                    });
                }),
            },
            {
                name: t('settings.transcripts.scrapeCreatorsApiKey.name'),
                desc: t('settings.transcripts.scrapeCreatorsApiKey.desc'),
                render: gated((setting) => {
                    setting.addText(text => {
                        const textComponent = text
                            .setPlaceholder(t('settings.transcripts.scrapeCreatorsApiKey.placeholder'))
                            .setValue(host.settings.scrapcreatorsApiKey)
                            .onChange((value: string) => {
                                void (async () => {
                                    host.settings.scrapcreatorsApiKey = value;
                                    await host.saveSettings();
                                })();
                            });
                        maskInput(textComponent.inputEl);
                        return textComponent;
                    });
                    host.createInfoIcon(setting.nameEl, 'https://scrapecreators.com/');
                }),
            },
            {
                name: t('settings.transcripts.supadataApiKey.name'),
                desc: t('settings.transcripts.supadataApiKey.desc'),
                render: gated((setting) => {
                    setting.addText(text => {
                        const textComponent = text
                            .setPlaceholder(t('settings.transcripts.supadataApiKey.placeholder'))
                            .setValue(host.settings.supadataApiKey)
                            .onChange((value: string) => {
                                void (async () => {
                                    host.settings.supadataApiKey = value;
                                    await host.saveSettings();
                                })();
                            });
                        maskInput(textComponent.inputEl);
                        return textComponent;
                    });
                    host.createInfoIcon(setting.nameEl, 'https://supadata.ai/');
                }),
            },
            {
                name: t('settings.transcripts.translateLanguage.name'),
                desc: t('settings.transcripts.translateLanguage.desc'),
                control: { type: 'text', key: 'translateLanguage', placeholder: t('settings.transcripts.translateLanguage.placeholder'), disabled: locked },
            },
            {
                name: t('settings.transcripts.translateCountry.name'),
                desc: t('settings.transcripts.translateCountry.desc'),
                control: { type: 'text', key: 'translateCountry', placeholder: 'US', disabled: locked },
            },
        ],
    });

    // ---- Language model -------------------------------------------------------
    const llmItems: SettingGroupItem[] = [];

    llmItems.push({
        name: t('settings.llm.provider.name'),
        desc: t('settings.llm.provider.desc'),
        render: gated((setting) => {
            setting.addDropdown(dropdown => {
                // Add OpenAI option
                dropdown.addOption('openai', 'OpenAI');

                // Always add Anthropic, Google, Ollama, and OpenRouter options since they all work on any platform now
                dropdown.addOption('anthropic', 'Anthropic');
                dropdown.addOption('google', 'Google');
                dropdown.addOption('ollama', 'Ollama');
                dropdown.addOption('openrouter', 'OpenRouter');

                // Set the current value
                const currentValue = host.settings.selectedLLM;

                // Set the current value
                dropdown.setValue(currentValue);

                // Add change handler
                dropdown.onChange((value: string) => {
                    void (async () => {
                        // Update provider first
                        host.settings.selectedLLM = value;

                        // Set appropriate max token value using registry for known models
                        const effectiveMaxTokens = host.getEffectiveMaxTokens();
                        host.settings.maxTokens = effectiveMaxTokens;

                        // Show notice with effective token limit
                        host.showNotice(`Provider set to ${value}. Output budget: ${effectiveMaxTokens} tokens (max output minus reserve).`, 3000);

                        // Update settings
                        await host.saveSettings();

                        // Re-render the settings panel to show the selected provider's model block.
                        host.update();
                    })();
                });

                return dropdown;
            });
        }),
    });

    // API key row for a provider — always rendered for every provider so a
    // user can populate keys independently of which LLM is currently
    // selected. The model dropdown / refresh / custom-name / custom-params
    // are split out into the selected-provider block below (so the LLM
    // section reflects the active provider's context rather than rendering
    // all four providers' full settings at once).
    for (const { provider, displayName, placeholder } of providerCatalog) {
        llmItems.push({
            name: t('settings.llm.apiKey.name', { provider: displayName }),
            desc: provider === 'ollama'
                ? t('settings.llm.apiKey.desc.ollama')
                : t('settings.llm.apiKey.desc.cloud'),
            render: gated((setting) => {
                setting.addText(text => {
                    const textComponent = text
                        .setPlaceholder(placeholder)
                        .setValue(host.settings.apiKeys[provider])
                        .onChange((value: string) => {
                            void (async () => {
                                host.settings.apiKeys[provider] = value;
                                host.setSecret(provider, value);
                                await host.saveSettings();
                            })();
                        });
                    maskInput(textComponent.inputEl);
                    return textComponent;
                });
                if (provider === 'openrouter') {
                    host.createInfoIcon(setting.nameEl, 'https://openrouter.ai/');
                }
            }),
        });
    }

    // Render the model config block for the currently-selected provider only.
    // Switching the provider re-runs update() (the Provider dropdown's
    // onChange calls host.update()), which rebuilds these definitions and
    // produces the new provider's block.
    const selectedEntry = providerCatalog.find(e => e.provider === host.settings.selectedLLM);
    const providerBlock = selectedEntry ? buildProviderBlock(host, selectedEntry, gated) : null;
    if (providerBlock) {
        llmItems.push(...providerBlock.llmItems);
    }

    items.push({
        type: 'group',
        heading: t('settings.llm.heading'),
        cls: 'tubesage-heading',
        extraButtons: headingInfo(
            t('settings.llm.info')
        ),
        items: llmItems,
    });

    if (providerBlock) {
        // The model-parameters box: a headingless group carrying the legacy
        // container class, so the bordered panel renders as before.
        items.push({
            type: 'group',
            cls: 'tubesage-custom-model-params',
            items: providerBlock.paramItems,
        });
    }

    // LLM parameters (a headingless group so the row follows the model box
    // inside the Language model section, as it did before).
    items.push({
        type: 'group',
        items: [
            {
                name: t('settings.llm.temperature.name'),
                desc: t('settings.llm.temperature.desc', { value: host.settings.temperature }),
                render: gated((setting) => {
                    setting.addSlider(slider => slider
                        .setLimits(0, 1, 0.1)
                        .setValue(host.settings.temperature)
                        .onChange((value: number) => {
                            void (async () => {
                                host.settings.temperature = value;
                                // Update the description text to show the current value
                                host.update();
                                await host.saveSettings();
                            })();
                        }));
                }),
            },
        ],
    });

    // ---- Note format ----------------------------------------------------------
    items.push({
        type: 'group',
        heading: t('settings.noteFormat.heading'),
        cls: 'tubesage-heading',
        items: [
            {
                name: t('settings.noteFormat.prependDate.name'),
                desc: t('settings.noteFormat.prependDate.desc'),
                render: gated((setting) => {
                    setting.addDropdown((dropdown) => dropdown
                        .addOption('true', t('common.enabled'))
                        .addOption('false', t('common.disabled'))
                        .setValue(host.settings.prependDate ? 'true' : 'false')
                        .onChange((value: string) => {
                            void (async () => {
                                host.settings.prependDate = value === 'true';
                                await host.saveSettings();
                            })();
                        }));
                }),
            },
            {
                name: t('settings.noteFormat.dateFormat.name'),
                desc: t('settings.noteFormat.dateFormat.desc'),
                control: {
                    type: 'dropdown',
                    key: 'dateFormat',
                    options: {
                        // Displayed verbatim: these are format TOKENS, not
                        // prose. Sentence-casing them ("Yyyy-mm-dd") was an
                        // autofix artefact — it describes a pattern the plugin
                        // does not accept, and it is the UI-text class the
                        // Obsidian review bot flags. Not translated either:
                        // a localised token would name a format `moment` cannot
                        // parse, which is why these stay out of the matrix.
                        'YYYY-MM-DD': 'YYYY-MM-DD',
                        'MM-DD-YYYY': 'MM-DD-YYYY',
                        'DD-MM-YYYY': 'DD-MM-YYYY',
                    },
                    disabled: locked,
                },
            },
        ],
    });

    // ---- Prompts --------------------------------------------------------------
    const promptRow = (
        name: string,
        desc: string,
        placeholder: string,
        key: 'systemPrompt' | 'userPrompt' | 'extensiveSystemPrompt' | 'extensiveUserPrompt',
    ): SettingDefinitionRender => ({
        name,
        desc,
        render: gated((setting) => {
            setting.addTextArea(text => {
                const textComponent = text
                    .setPlaceholder(placeholder)
                    .setValue(host.settings[key])
                    .onChange((value: string) => {
                        void (async () => {
                            host.settings[key] = value;
                            await host.saveSettings();
                        })();
                    });

                // Access the DOM element and set its appearance
                textComponent.inputEl.addClass('tubesage-prompt-textarea');
                // Tag the parent setting-item so CSS can target it without :has()
                setting.settingEl.addClass('tubesage-prompt-setting');

                return textComponent;
            });
            setting.addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip(t('settings.prompts.resetTooltip'))
                    .onClick(() => {
                        void (async () => {
                            host.settings[key] = host.defaults[key];
                            await host.saveSettings();
                            host.update();
                        })();
                    });
            });
        }),
    });

    items.push({
        type: 'group',
        heading: t('settings.prompts.heading'),
        cls: 'tubesage-heading',
        items: [
            {
                // Sub-heading for Fast Summary prompts (groups cannot nest).
                name: t('settings.prompts.fast.heading'),
                searchable: false,
                render: (setting) => {
                    setting.setHeading();
                    setting.settingEl.addClass('tubesage-settings-prompt-subheader');
                },
            },
            promptRow(
                t('settings.prompts.systemFast.name'),
                t('settings.prompts.systemFast.desc'),
                t('settings.prompts.systemFast.placeholder'),
                'systemPrompt',
            ),
            promptRow(
                t('settings.prompts.userFast.name'),
                t('settings.prompts.userFast.desc'),
                t('settings.prompts.userFast.placeholder'),
                'userPrompt',
            ),
            {
                // Sub-heading for Extensive Summary prompts
                name: t('settings.prompts.extensive.heading'),
                searchable: false,
                render: (setting) => {
                    setting.setHeading();
                    setting.settingEl.addClass('tubesage-settings-prompt-subheader');
                    setting.settingEl.addClass('tubesage-settings-prompt-subheader-extensive');
                },
            },
            promptRow(
                t('settings.prompts.systemExtensive.name'),
                t('settings.prompts.systemExtensive.desc'),
                t('settings.prompts.systemExtensive.placeholder'),
                'extensiveSystemPrompt',
            ),
            promptRow(
                t('settings.prompts.userExtensive.name'),
                t('settings.prompts.userExtensive.desc'),
                t('settings.prompts.userExtensive.placeholder'),
                'extensiveUserPrompt',
            ),
            {
                // Default Summary Mode Setting
                name: t('settings.prompts.defaultMode.name'),
                desc: t('settings.prompts.defaultMode.desc'),
                render: gated((setting) => {
                    setting.addDropdown((dropdown) => dropdown
                        .addOption('false', t('settings.prompts.defaultMode.option.extensive'))
                        .addOption('true', t('settings.prompts.defaultMode.option.fast'))
                        .setValue(host.settings.useFastSummary ? 'true' : 'false')
                        .onChange((value: string) => {
                            void (async () => {
                                host.settings.useFastSummary = value === 'true';
                                await host.saveSettings();
                            })();
                        }));
                }),
            },
            {
                // Add timestamp links setting
                name: t('settings.prompts.timestampLinks.name'),
                desc: t('settings.prompts.timestampLinks.desc'),
                render: gated((setting) => {
                    setting.addDropdown(dropdown => dropdown
                        .addOption('true', t('common.enabled'))
                        .addOption('false', t('common.disabled'))
                        .setValue(host.settings.addTimestampLinks ? 'true' : 'false')
                        .onChange((value: string) => {
                            void (async () => {
                                host.settings.addTimestampLinks = value === 'true';
                                await host.saveSettings();
                            })();
                        }))
                    .addExtraButton(button => {
                        button
                            .setIcon('info')
                            .setTooltip(t('settings.prompts.timestampLinks.infoTooltip'));
                    });
                }),
            },
        ],
    });

    // ---- Advanced -------------------------------------------------------------
    items.push({
        type: 'group',
        heading: t('settings.advanced.heading'),
        cls: 'tubesage-heading',
        extraButtons: headingInfo(
            t('settings.advanced.info')
        ),
        items: [
            {
                // Debug logging toggle
                name: t('settings.advanced.debugLogging.name'),
                desc: t('settings.advanced.debugLogging.desc'),
                render: gated((setting) => {
                    setting.addDropdown(dropdown => dropdown
                        .addOption('true', t('common.enabled'))
                        .addOption('false', t('common.disabled'))
                        .setValue(host.settings.debugLogging ? 'true' : 'false')
                        .onChange((value: string) => {
                            void (async () => {
                                host.settings.debugLogging = value === 'true';
                                // Update log level immediately
                                if (host.settings.debugLogging) {
                                    setGlobalLogLevel(LogLevel.DEBUG);
                                    logger.debug('Debug logging enabled from settings');
                                } else {
                                    setGlobalLogLevel(LogLevel.INFO);
                                    logger.info('Debug logging disabled from settings');
                                }
                                await host.saveSettings();
                            })();
                        }))
                    .addExtraButton((button: ExtraButtonComponent) => {
                        button
                            .setIcon('info')
                            .setTooltip(t('settings.advanced.debugLogging.infoTooltip'));
                    });
                }),
            },
        ],
    });

    return items;
}

// --- selected-provider block -------------------------------------------------

interface CustomLimits {
    contextK: number;
    maxOutputK: number;
    inputMaxK?: number;
    reservePct?: number;
}

/**
 * Per-build state shared by the rows of the selected provider's block: the
 * model dropdown and custom-name field (controls row) and the four
 * model-parameter fields. The rows render in definition order, and every
 * reference is read lazily, so a handler that fires after the block is on
 * screen sees all of them. Rebuilt on every update().
 */
interface ProviderBlockState {
    modelDropdown: DropdownComponent | null;
    customField: TextComponent | null;
    headingSetting: Setting | null;
    contextKField: TextComponent | null;
    maxOutputKField: TextComponent | null;
    inputMaxKField: TextComponent | null;
    reservePctField: TextComponent | null;
}

interface ProviderBlock {
    /** Model header row + controls row (inside the Language model group). */
    llmItems: SettingDefinitionRender[];
    /** Model-parameters heading + the four override fields (the boxed group). */
    paramItems: SettingDefinitionRender[];
}

// Full provider config block — only built for the selected provider.
// Includes header, model dropdown, refresh button, custom-model-name field,
// and the model-parameters section (whose label signals "required input" for
// custom models and "optional override" for preset models).
function buildProviderBlock(host: SettingsHost, entry: ProviderCatalogEntry, gated: (render: Render) => Render): ProviderBlock {
    const { provider, displayName, modelOptions, defaultModelValue } = entry;
    const state: ProviderBlockState = {
        modelDropdown: null,
        customField: null,
        headingSetting: null,
        contextKField: null,
        maxOutputKField: null,
        inputMaxKField: null,
        reservePctField: null,
    };

    // Build the dropdown's option list from the hardcoded presets plus
    // any models the user has previously discovered via the per-provider
    // refresh button. Discovered IDs are persisted in
    // settings.fetchedModels[provider] by the three fetch handlers,
    // independent of whether the API exposed token limits — so OpenAI
    // (whose API doesn't return limits) survives a re-render the
    // same way Google and Anthropic do. Deduplicated and sorted.
    const fetched = host.settings.fetchedModels ?? {};
    const fetchedForProvider = fetched[provider] ?? [];
    const mergedOptions = Array.from(new Set([...modelOptions, ...fetchedForProvider])).sort();

    // Resolve which limits to display in the override fields.
    //
    // Priority:
    //   1. User override stored in customModelLimits[provider:model]
    //   2. Registry defaults from getEffectiveLimits (registry stores raw
    //      tokens; the override panel uses k-tokens — divide by 1000)
    //   3. Conservative fallback for genuinely-unknown models
    //
    // This makes the panel populate with the model's actual capabilities
    // when the user picks a registry-known model from the dropdown (or
    // refreshes and the registry gets enriched with vendor-published
    // limits) so the user can see the model's parameters before deciding
    // whether to override them.
    const getCurrentCustomLimits = (): CustomLimits => {
        const model = host.settings.selectedModels[provider];
        const customKey = `${provider}:${model}`;
        const userOverride = host.settings.customModelLimits[customKey];
        if (userOverride) return userOverride;

        // Try the registry. isModelSupported guards getEffectiveLimits
        // (which throws on unknown model). Registry units are raw tokens;
        // the panel speaks k-tokens.
        const providerKey = provider as Parameters<typeof isModelSupported>[0];
        if (model && isModelSupported(providerKey, model)) {
            try {
                const eff = getEffectiveLimits(providerKey, model);
                return {
                    contextK: Math.round(eff.context / 1000),
                    maxOutputK: Math.round(eff.maxOutput / 1000),
                    inputMaxK: eff.inputMax != null ? Math.round(eff.inputMax / 1000) : undefined,
                    reservePct: eff.reserveOutputPct ?? (provider === 'ollama' ? 0.15 : 0.10),
                };
            } catch {
                // Fall through to fallback.
            }
        }

        // Conservative fallback: model is unknown to both the user override
        // map and the registry.  Returned for *display* only — never
        // persisted, because the user might still be typing in the custom
        // model field, and persisting a fallback per keystroke leads to
        // junk entries (`openai:b`, `openai:bd`, ...).  The user explicitly
        // editing the override fields below is what writes to settings.
        return {
            contextK: 128,
            maxOutputK: 16,
            inputMaxK: undefined,
            reservePct: provider === 'ollama' ? 0.15 : 0.10,
        };
    };

    // The box is always visible. We update the heading text and
    // sub-description based on whether 'custom' is the selected dropdown
    // value, so the same panel signals "required input" for custom models
    // and "optional override" for preset models.
    const updateCustomParamsLabel = (): void => {
        const isCustomSelected = state.modelDropdown?.getValue() === 'custom';
        state.headingSetting?.nameEl.setText(
            isCustomSelected
                ? t('settings.llm.modelParams.headingCustom', { provider: provider.toUpperCase() })
                : t('settings.llm.modelParams.headingOverride', { provider: provider.toUpperCase() }),
        );
        state.headingSetting?.descEl.setText(
            isCustomSelected
                ? t('settings.llm.modelParams.descCustom')
                : t('settings.llm.modelParams.descOverride'),
        );
    };

    // Repopulate the four input fields from the resolved limits for the
    // currently-selected model. Called when the model changes (preset →
    // preset, preset → custom, or after a refresh enriches the registry)
    // so the user sees the model's actual capabilities, not the previous
    // model's values stuck in the inputs.
    const refreshFieldValues = (): void => {
        const limits = getCurrentCustomLimits();
        state.contextKField?.setValue(limits.contextK.toString());
        state.maxOutputKField?.setValue(limits.maxOutputK.toString());
        state.inputMaxKField?.setValue(limits.inputMaxK ? limits.inputMaxK.toString() : '');
        state.reservePctField?.setValue(
            limits.reservePct?.toString() ?? (provider === 'ollama' ? '0.15' : '0.10'),
        );
    };

    // Combined refresh: re-apply both label and field values. Invoked from
    // the dropdown's selectEl 'change' listener (after the dropdown's own
    // onChange has written selectedModels) and after the custom-name field
    // blurs.
    const refreshAll = (): void => {
        updateCustomParamsLabel();
        refreshFieldValues();
    };

    // Writes one override field. Initialises the provider:model entry from
    // the resolved limits on first edit, then re-derives maxTokens.
    const writeLimit = (apply: (limits: CustomLimits) => void): Promise<void> => (async () => {
        const model = host.settings.selectedModels[provider];
        const customKey = `${provider}:${model}`;

        if (!host.settings.customModelLimits[customKey]) {
            host.settings.customModelLimits[customKey] = getCurrentCustomLimits();
        }

        apply(host.settings.customModelLimits[customKey]);

        // Re-derive maxTokens from the new limits BEFORE persisting, so one
        // edit is one write. This used to save, recompute, and save again —
        // two writes per keystroke, the first of them storing a maxTokens the
        // very next line replaced.
        //
        // The stored result is unchanged: `getEffectiveMaxTokens()` reads only
        // in-memory settings (`selectedLLM`, `selectedModels` and the
        // `customModelLimits` entry applied on the line above), never anything
        // `saveSettings()` writes, so it returns here exactly what it returned
        // after the first save.
        host.settings.maxTokens = host.getEffectiveMaxTokens();
        await host.saveSettings();
    })();

    const llmItems: SettingDefinitionRender[] = [
        {
            // Header row
            name: t('settings.llm.model.name', { provider: displayName }),
            desc: t('settings.llm.model.desc'),
            render: gated((setting) => {
                setting.settingEl.addClass('tubesage-provider-header');
            }),
        },
        {
            // Controls row: model dropdown, refresh, custom model name
            name: '',
            searchable: false,
            render: gated((setting) => {
                setting.setClass('tubesage-provider-controls');

                // Add dropdown for preset + fetched models
                setting.addDropdown(dropdown => {
                    state.modelDropdown = dropdown;
                    if (provider === 'openrouter') {
                        let currentVendor = '';
                        let group: HTMLElement | null = null;
                        for (const model of mergedOptions) {
                            const vendor = model.includes('/') ? model.slice(0, model.indexOf('/')) : 'other';
                            if (vendor !== currentVendor) {
                                currentVendor = vendor;
                                group = dropdown.selectEl.createEl('optgroup', { attr: { label: vendor } });
                            }
                            (group ?? dropdown.selectEl).createEl('option', { value: model, text: model });
                        }
                    } else {
                        mergedOptions.forEach((model) => {
                            dropdown.addOption(model, model);
                        });
                    }
                    dropdown.addOption('custom', t('settings.llm.model.customOption'));
                    const currentModel = host.settings.selectedModels[provider];
                    const validSelection = mergedOptions.includes(currentModel) ? currentModel : 'custom';
                    dropdown.setValue(validSelection)
                        .onChange((value: string) => {
                            // Synchronous part of the write must run before the
                            // selectEl 'change' DOM listener fires (see the wiring
                            // below). The listener calls refreshAll() which reads
                            // selectedModels[provider] via getCurrentCustomLimits;
                            // if the write is inside the async IIFE the listener
                            // sees the previous model and the params panel keeps
                            // showing stale values.
                            if (value !== 'custom') {
                                host.settings.selectedModels[provider] = value;
                                state.customField?.setValue(''); // Clear custom if a preset is chosen
                                host.settings.maxTokens = host.getEffectiveMaxTokens();
                            }

                            void (async () => {
                                if (value !== 'custom') {
                                    await host.saveSettings();
                                    host.showNotice(`Model changed to ${value}. Output budget: ${host.settings.maxTokens} tokens (max output minus reserve).`, 3000);
                                } else {
                                    // Custom model selected - initialize custom model limits if they don't exist
                                    const currentModel = host.settings.selectedModels[provider];
                                    if (currentModel && currentModel !== '') {
                                        const customKey = `${provider}:${currentModel}`;

                                        // Initialize custom limits if they don't exist
                                        if (!host.settings.customModelLimits[customKey]) {
                                            host.settings.customModelLimits[customKey] = {
                                                contextK: 128,
                                                maxOutputK: 16,
                                                inputMaxK: undefined,
                                                reservePct: 0.1
                                            };

                                            // Update maxTokens setting based on new custom limits
                                            host.settings.maxTokens = host.getEffectiveMaxTokens();
                                            await host.saveSettings();

                                            // Refresh display to show custom parameters
                                            host.update();
                                        }
                                    }
                                }
                            })();
                        });
                    return dropdown;
                });

                // Add refresh button for OpenAI, Google, Anthropic, and OpenRouter providers
                if (provider === 'openai' || provider === 'google' || provider === 'anthropic' || provider === 'openrouter') {
                    setting.addExtraButton(button => {
                        button
                            .setIcon('refresh-cw') // Refresh icon
                            .setTooltip(t('settings.llm.model.refreshTooltip', { provider: displayName }))
                            .onClick(() => {
                                void (async () => {
                                const apiKey = host.settings.apiKeys[provider];
                                if (provider !== 'openrouter' && (!apiKey || apiKey.trim() === '')) {
                                    host.showNotice(`${displayName} API key is required to refresh models.`, 5000);
                                    return;
                                }

                                let fetchedModels: FetchedModelInfo[] = [];
                                if (provider === 'openai') {
                                    fetchedModels = await host.fetchOpenAIModels(apiKey);
                                } else if (provider === 'google') {
                                    fetchedModels = await host.fetchGoogleModels(apiKey);
                                } else if (provider === 'anthropic') {
                                    fetchedModels = await host.fetchAnthropicModels(apiKey);
                                } else if (provider === 'openrouter') {
                                    fetchedModels = await host.fetchOpenRouterModels();
                                }

                                const fetchedIds = fetchedModels.map(m => m.id);

                                if (fetchedIds.length > 0) {
                                    // Pick the selected model after refresh:
                                    //   1. keep current if still in fetched list
                                    //   2. fall back to the hardcoded preset default if it's now fetched
                                    //   3. otherwise pick the first fetched id
                                    // No 'custom' fallback path here — fetchedIds.length > 0 guarantees
                                    // we have at least one real model id to point at.
                                    const currentSelectedModel = host.settings.selectedModels[provider];
                                    if (fetchedIds.includes(currentSelectedModel)) {
                                        // No change needed.
                                    } else if (fetchedIds.includes(defaultModelValue)) {
                                        host.settings.selectedModels[provider] = defaultModelValue;
                                    } else {
                                        host.settings.selectedModels[provider] = fetchedIds[0];
                                    }
                                    host.settings.maxTokens = host.getEffectiveMaxTokens();
                                    await host.saveSettings();

                                    const limitedCount = fetchedModels.filter(m => m.contextK).length;
                                    const limitMsg = limitedCount > 0 ? ` Token limits auto-populated for ${limitedCount} models.` : '';
                                    host.showNotice(`${displayName} model list refreshed.${limitMsg}`, 4000);

                                    // Re-render the whole settings panel. The fetch
                                    // handlers have already upserted limits into
                                    // settings.customModelLimits and discovered IDs
                                    // into settings.fetchedModels — so the rebuilt
                                    // dropdown picks up the fresh model list automatically.
                                    host.update();
                                } else {
                                    host.showNotice(`Could not refresh ${displayName} models. Using existing list.`, 4000);
                                }
                                })();
                            });
                    });
                }

                // Add custom model field — commits on blur, NOT on every keystroke.
                // The previous per-keystroke onChange wrote one customModelLimits
                // entry per character, polluting settings.json with junk like
                // `openai:b`, `openai:bd`, `openai:bdd` for someone typing "bdd".
                // Blur-only commit makes typing transient and only the final value
                // becomes a real custom model entry.
                setting.addText(text => {
                    state.customField = text;
                    text.setPlaceholder(t('settings.llm.model.customPlaceholder'))
                        .setValue(
                            // Show current model in custom field only when it's not
                            // in the merged dropdown options (preset + previously-
                            // fetched). A fetched-but-not-preset model is a normal
                            // dropdown selection, not a custom one.
                            !mergedOptions.includes(host.settings.selectedModels[provider])
                                ? host.settings.selectedModels[provider]
                                : ''
                        );

                    text.inputEl?.addEventListener('blur', () => {
                        void (async () => {
                            const value = text.getValue();
                            const modelDropdown = state.modelDropdown;
                            if (value && value.trim() !== '') {
                                // Commit the typed model as the active custom model.
                                host.settings.selectedModels[provider] = value;
                                if (modelDropdown && modelDropdown.getValue() !== 'custom') {
                                    modelDropdown.setValue('custom');
                                }

                                // Initialise customModelLimits with conservative
                                // defaults if this provider:model is brand-new.
                                const customKey = `${provider}:${value}`;
                                if (!host.settings.customModelLimits[customKey]) {
                                    host.settings.customModelLimits[customKey] = {
                                        contextK: 128,
                                        maxOutputK: 16,
                                        inputMaxK: undefined,
                                        reservePct: provider === 'ollama' ? 0.15 : 0.10,
                                    };
                                    host.settings.maxTokens = host.getEffectiveMaxTokens();
                                }

                                await host.saveSettings();
                            } else if (modelDropdown && modelDropdown.getValue() === 'custom') {
                                // Custom field cleared while dropdown was on 'custom':
                                // revert to the provider's preset default.
                                modelDropdown.setValue(defaultModelValue);
                                host.settings.selectedModels[provider] = defaultModelValue;
                                await host.saveSettings();
                            }
                        })();
                    });

                    // Custom-name field blur is a secondary path: typing into the
                    // custom field can switch the dropdown to 'custom' implicitly.
                    text.inputEl?.addEventListener('blur', () => {
                        window.setTimeout(refreshAll, 100);
                    });

                    return text;
                });

                // A model switch immediately repopulates the override fields
                // with the new model's resolved limits (registry default or
                // saved override). Without this the panel would keep showing
                // the previous model's values until the user touched another
                // control.
                state.modelDropdown?.selectEl?.addEventListener('change', () => {
                    refreshAll();
                });
            }),
        },
    ];

    const paramItems: SettingDefinitionRender[] = [
        {
            // Header (text and sub-description updated by updateCustomParamsLabel).
            name: t('settings.llm.modelParams.heading', { provider: provider.toUpperCase() }),
            searchable: false,
            render: (setting) => {
                setting.setHeading();
                setting.settingEl.addClass('tubesage-custom-params-header');
                setting.descEl.addClass('tubesage-custom-params-subdesc');
                state.headingSetting = setting;
            },
        },
        {
            // Context window field
            name: t('settings.llm.contextWindow.name'),
            desc: t('settings.llm.contextWindow.desc'),
            render: gated((setting) => {
                setting.addText(text => {
                    state.contextKField = text;
                    text.setValue(getCurrentCustomLimits().contextK.toString())
                        .onChange((value: string) => {
                            const numValue = parseInt(value) || 128;
                            void writeLimit((limits) => { limits.contextK = numValue; });
                        });
                });
            }),
        },
        {
            // Max output field
            name: t('settings.llm.maxOutput.name'),
            desc: t('settings.llm.maxOutput.desc'),
            render: gated((setting) => {
                setting.addText(text => {
                    state.maxOutputKField = text;
                    text.setValue(getCurrentCustomLimits().maxOutputK.toString())
                        .onChange((value: string) => {
                            const numValue = parseInt(value) || 16;
                            void writeLimit((limits) => { limits.maxOutputK = numValue; });
                        });
                });
            }),
        },
        {
            // Input max field (optional)
            name: t('settings.llm.inputMax.name'),
            desc: t('settings.llm.inputMax.desc'),
            render: gated((setting) => {
                setting.addText(text => {
                    state.inputMaxKField = text;
                    const currentLimits = getCurrentCustomLimits();
                    text.setValue(currentLimits.inputMaxK ? currentLimits.inputMaxK.toString() : '')
                        .onChange((value: string) => {
                            const numValue = value.trim() ? parseInt(value) || undefined : undefined;
                            void writeLimit((limits) => { limits.inputMaxK = numValue; });
                        });
                });
            }),
        },
        {
            // Reserve percentage field
            name: t('settings.llm.reservePct.name'),
            desc: t('settings.llm.reservePct.desc', { default: provider === 'ollama' ? '15%' : '10%' }),
            render: gated((setting) => {
                setting.addText(text => {
                    state.reservePctField = text;
                    text.setValue(getCurrentCustomLimits().reservePct?.toString() || (provider === 'ollama' ? '0.15' : '0.10'))
                        .onChange((value: string) => {
                            const numValue = parseFloat(value) || (provider === 'ollama' ? 0.15 : 0.10);
                            void writeLimit((limits) => { limits.reservePct = Math.max(0, Math.min(1, numValue)); });
                        });
                });

                // Initial label + field check, once the last field exists.
                refreshAll();
            }),
        },
    ];

    return { llmItems, paramItems };
}

// Buy Me a Coffee button image, bundled as base64 to avoid external dependencies.
const BMC_IMAGE_DATA_URI = 'data:image/png;base64,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';
