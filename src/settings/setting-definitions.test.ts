import { describe, expect, it, vi } from "vitest";
import type { Setting, SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import { JOBS_KEY } from "../jobs/job-store";
import { COLLECTIONS_KEY } from "../jobs/collection-record";
import { settingsForPersist } from "../runtime/settings-persist";
import { DEFAULT_SETTINGS } from "./settings-defaults";
import type { YouTubeTranscriptSettings } from "./settings-defaults";
import { buildSettingDefinitions, readSettingValue, writeSettingValue } from "./setting-definitions";
import type { SettingsHost } from "./setting-definitions";
import legacy from "./__fixtures__/legacy-display-rows.json";
import { t } from "../i18n";
import { DEFAULT_BASE_URLS } from "../llm/base-url";

// The fixture is a snapshot of every `new Setting(` row the legacy imperative
// display() produced (main.ts @ 80baa72), in render order, taken BEFORE that
// method was deleted. These tests pin the declarative builder to it: same
// rows, same names, same order, one definition per row — and the persistence
// path a `control` change takes.

const PROVIDERS = ["openai", "anthropic", "google", "ollama", "openrouter"] as const;

interface LegacyRow {
  line: number;
  name: string | null;
  kind: string;
  keys: string[];
  provider?: string;
}
const legacyRows: LegacyRow[] = legacy.rows;

function legacyRowsFor(provider: string): LegacyRow[] {
  return legacyRows.filter((r) => r.provider === undefined || r.provider === provider);
}

interface Walked {
  /** Group headings, in order. */
  groupHeadings: string[];
  /** Leaf definitions (groups and pages walked), in order. */
  leaves: SettingDefinition[];
  /** Every heading and leaf name in render order. */
  ordered: string[];
}

function isGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup {
  return "type" in item && (item.type === "group" || item.type === "list");
}

function isPage(item: SettingDefinitionItem): item is SettingDefinitionPage {
  return "type" in item && item.type === "page";
}

function walk(items: SettingDefinitionItem[], acc: Walked = { groupHeadings: [], leaves: [], ordered: [] }): Walked {
  for (const item of items) {
    if (isGroup(item)) {
      if (item.heading) {
        acc.groupHeadings.push(item.heading);
        acc.ordered.push(item.heading);
      }
      walk(item.items ?? [], acc);
    } else if (isPage(item)) {
      acc.ordered.push(item.name);
      walk(item.items ?? [], acc);
    } else {
      acc.leaves.push(item);
      acc.ordered.push(item.name);
    }
  }
  return acc;
}

function liveSettings(overrides: Partial<YouTubeTranscriptSettings> = {}): YouTubeTranscriptSettings {
  const settings: YouTubeTranscriptSettings = { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
  settings.apiKeys = {
    ...settings.apiKeys,
    openai: "sk-openai",
    anthropic: "sk-ant",
    google: "g-key",
    openrouter: "or-key",
  };
  return settings;
}

function hostSpies() {
  return {
    saveSettings: vi.fn(() => Promise.resolve()),
    update: vi.fn(),
    showNotice: vi.fn(),
    getEffectiveMaxTokens: vi.fn(() => 1000),
    setSecret: vi.fn(),
    fetchOpenAIModels: vi.fn(() => Promise.resolve([])),
    fetchGoogleModels: vi.fn(() => Promise.resolve([])),
    fetchAnthropicModels: vi.fn(() => Promise.resolve([])),
    fetchOpenRouterModels: vi.fn(() => Promise.resolve([])),
    openLicenseModal: vi.fn(),
    openReadmeModal: vi.fn(),
    openTemplateViewModal: vi.fn(),
    pickTemplateFile: vi.fn(),
    createInfoIcon: vi.fn(),
    createExtraButton: vi.fn(),
    createToggle: vi.fn(),
  };
}

function makeHost(overrides: Partial<YouTubeTranscriptSettings> = {}) {
  const settings = liveSettings(overrides);
  const spies = hostSpies();
  const host: SettingsHost = { settings, defaults: DEFAULT_SETTINGS, ...spies };
  return { host, spies, settings };
}

const BRAND_WORDS = new Set(["YouTube", "OpenAI", "Anthropic", "Google", "Ollama", "OpenRouter"]);

function isSentenceCase(name: string): boolean {
  const words = name.split(/\s+/);
  if (!/^[A-Z]/.test(words[0]) && !BRAND_WORDS.has(words[0])) return false;
  return words.slice(1).every((word) => {
    const core = word.replace(/^[([]/, "").replace(/[)\],:]$/, "");
    // Title Case is a capital followed by lowercase; acronyms (API, OPENAI) are fine.
    return !/^[A-Z][a-z]/.test(core) || BRAND_WORDS.has(core);
  });
}

/**
 * Rows added deliberately AFTER the legacy migration, by name.
 *
 * The fixture is a snapshot of the imperative display() this builder
 * replaced, and it pins that migration — it is not a promise that the
 * settings tab never gains a row again. Rather than loosening "nothing else"
 * into nothing at all, a genuinely new row is listed here: the legacy rows
 * still have to appear exactly once and in order, and anything that is
 * neither a legacy row nor one of these still fails.
 */
const POST_LEGACY_ROWS: string[] = [
  // #19: the per-request budget, which became a setting once every provider
  // path routed through the shim and it was the only bound left.
  "Request timeout (ms)",
  // #25: the self-hosted OpenAI-compatible server. Its address and key rows
  // are rendered for every provider, as every key row is.
  "OpenAI-compatible server URL",
  "OpenAI-compatible server api key",
  // #29: a custom base URL for each provider that has a vendor default.
  "OpenAI base URL",
  "Anthropic base URL",
  "Google base URL",
  "OpenRouter base URL",
  // #28: the toggle in front of each of those, which shows its field.
  "Custom OpenAI base URL",
  "Custom Anthropic base URL",
  "Custom Google base URL",
  "Custom OpenRouter base URL",
];

describe("buildSettingDefinitions — coverage of the legacy display() rows", () => {
  it.each(PROVIDERS)("with %s selected: every legacy row appears exactly once, in render order, and nothing else", (provider) => {
    const { host } = makeHost({ selectedLLM: provider });
    const { ordered } = walk(buildSettingDefinitions(host));
    expect(ordered.filter((name) => !POST_LEGACY_ROWS.includes(name))).toEqual(
      legacyRowsFor(provider).map((r) => r.name),
    );
  });

  it.each(PROVIDERS)("with %s selected: every post-legacy row appears exactly once", (provider) => {
    // So the list above cannot quietly rot into a list of rows that are no
    // longer there, which would turn the filter into a licence to add rows.
    const { host } = makeHost({ selectedLLM: provider });
    const { ordered } = walk(buildSettingDefinitions(host));
    for (const name of POST_LEGACY_ROWS) {
      expect(ordered.filter((row) => row === name), `"${name}" must appear exactly once`).toHaveLength(1);
    }
  });

  it("legacy heading rows become group headings or non-searchable heading rows (never a control)", () => {
    const { host } = makeHost({ selectedLLM: "openai" });
    const { groupHeadings, leaves } = walk(buildSettingDefinitions(host));
    for (const row of legacyRowsFor("openai").filter((r) => r.kind === "heading")) {
      const name = row.name ?? "";
      if (groupHeadings.includes(name)) continue;
      const leaf = leaves.find((l) => l.name === name);
      expect(leaf, `heading "${name}" is neither a group heading nor a heading row`).toBeDefined();
      expect(leaf?.render, `heading row "${name}" must be rendered (setHeading) not bound`).toBeTypeOf("function");
      expect(leaf?.searchable, `heading row "${name}" must be excluded from search`).toBe(false);
    }
  });

  it("uses sentence case for every name and heading", () => {
    const { host } = makeHost();
    const { ordered } = walk(buildSettingDefinitions(host));
    for (const name of ordered.filter((n) => n !== "")) {
      expect(isSentenceCase(name), `"${name}" is not sentence case`).toBe(true);
    }
  });

  it("gives every definition exactly one of control / render / action", () => {
    const { host } = makeHost();
    const { leaves } = walk(buildSettingDefinitions(host));
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      const kinds = [leaf.control, leaf.render, leaf.action].filter((k) => k !== undefined);
      expect(kinds, `"${leaf.name}" has ${kinds.length} of control/render/action`).toHaveLength(1);
    }
  });

  it("binds every control to a top-level DEFAULT_SETTINGS key that the legacy row read or wrote", () => {
    const { host } = makeHost();
    const { leaves } = walk(buildSettingDefinitions(host));
    let controls = 0;
    for (const leaf of leaves) {
      if (!leaf.control) continue;
      controls++;
      const key = leaf.control.key;
      // customModelLimits keys contain dots (gpt-4.5, llama3.1): never a dot-path.
      expect(key, `"${leaf.name}" key must be a top-level property`).not.toContain(".");
      expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key), `"${leaf.name}" key ${key} is not in DEFAULT_SETTINGS`).toBe(true);
      const legacyRow = legacyRows.find((r) => r.name === leaf.name);
      expect(legacyRow?.keys, `"${leaf.name}" legacy row must have touched ${key}`).toContain(key);
    }
    expect(controls).toBeGreaterThan(0);
  });

  it("performs no I/O and calls nothing on the host while building", () => {
    const { host, spies } = makeHost();
    const defs = buildSettingDefinitions(host);
    expect(Array.isArray(defs)).toBe(true);
    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, `${name} was called during getSettingDefinitions()`).not.toHaveBeenCalled();
    }
  });

  it("disables every control until the license is accepted, and enables it once accepted", () => {
    const evaluate = (def: SettingDefinition): boolean | undefined => {
      if (!def.control) return undefined;
      const disabled = def.control.disabled;
      return typeof disabled === "function" ? disabled() : Boolean(disabled);
    };
    const locked = walk(buildSettingDefinitions(makeHost({ licenseAccepted: false }).host)).leaves.filter((l) => l.control);
    expect(locked.length).toBeGreaterThan(0);
    for (const leaf of locked) expect(evaluate(leaf), `"${leaf.name}" should be disabled before acceptance`).toBe(true);
    const open = walk(buildSettingDefinitions(makeHost({ licenseAccepted: true }).host)).leaves.filter((l) => l.control);
    for (const leaf of open) expect(evaluate(leaf), `"${leaf.name}" should be enabled after acceptance`).toBe(false);
  });
});

// --- control save path (coordinator addendum A) --------------------------

/** A plugin double with the real persist path: settingsForPersist -> saveData. */
function makePluginDouble() {
  const settings = liveSettings({ selectedLLM: "anthropic" });
  // A stale pair as an upgraded data.json still holds it: the composer must
  // not write either key back out.
  const stale = settings as unknown as Record<string, unknown>;
  stale[JOBS_KEY] = [{ id: "stale" }];
  stale[COLLECTIONS_KEY] = [{ id: "stale-collection" }];
  const writes: Record<string, unknown>[] = [];
  const plugin = {
    settings,
    summarizerInits: 0,
    // Raw Plugin.saveData — the default PluginSettingTab.setControlValue calls
    // this directly; the override must never do so.
    saveData: vi.fn(() => Promise.resolve()),
    // main.ts persist(): compose the live settings and write them once.
    saveSettings: vi.fn(() => {
      writes.push(JSON.parse(JSON.stringify(settingsForPersist(settings, DEFAULT_SETTINGS.apiKeys.ollama))) as Record<string, unknown>);
      plugin.summarizerInits++;
      return Promise.resolve();
    }),
  };
  const host: SettingsHost = { ...hostSpies(), settings, defaults: DEFAULT_SETTINGS, saveSettings: plugin.saveSettings };
  return { plugin, writes, host };
}

describe("writeSettingValue / readSettingValue — the control accessors", () => {
  it("a control change makes exactly one saveSettings() call and zero direct saveData calls", async () => {
    const { plugin, writes, host } = makePluginDouble();
    await writeSettingValue(host, "translateLanguage", "fr");
    expect(plugin.settings.translateLanguage).toBe("fr");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.summarizerInits).toBe(1);
    // Exactly one payload reached data.json.
    expect(writes).toHaveLength(1);
  });

  it("the persisted payload never contains cloud keys, and never the reserved _jobs/_collections keys", async () => {
    const { writes, host } = makePluginDouble();
    await writeSettingValue(host, "transcriptRootFolder", "Notes");
    const payload = writes[0];
    expect(payload.transcriptRootFolder).toBe("Notes");
    expect(payload.apiKeys).toEqual({ ollama: DEFAULT_SETTINGS.apiKeys.ollama });
    const json = JSON.stringify(payload);
    for (const secret of ["sk-openai", "sk-ant", "g-key", "or-key"]) expect(json).not.toContain(secret);
    expect(payload).not.toHaveProperty(JOBS_KEY);
    expect(payload).not.toHaveProperty(COLLECTIONS_KEY);
  });

  it("reads and writes dot-notation paths through nested settings", async () => {
    const { host, plugin } = makePluginDouble();
    expect(readSettingValue(plugin.settings, "translateCountry")).toBe("US");
    expect(readSettingValue(plugin.settings, "apiKeys.ollama")).toBe(DEFAULT_SETTINGS.apiKeys.ollama);
    expect(readSettingValue(plugin.settings, "nope.missing")).toBeUndefined();
    await writeSettingValue(host, "apiKeys.ollama", "http://box:11434");
    expect(plugin.settings.apiKeys.ollama).toBe("http://box:11434");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });
});

// --- the OpenAI-compatible server's rows (#25) ----------------------------

/** Just enough of Obsidian's TextComponent for a render row to wire itself up and be typed into. */
function fakeText() {
  const listeners = new Map<string, (() => void)[]>();
  let changed: ((value: string) => void) | null = null;
  const component = {
    value: "",
    placeholder: "",
    inputEl: {
      type: "text",
      addEventListener: (event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    },
    setPlaceholder(placeholder: string) { component.placeholder = placeholder; return component; },
    setValue(value: string) { component.value = value; return component; },
    getValue() { return component.value; },
    onChange(listener: (value: string) => void) { changed = listener; return component; },
  };
  return {
    component,
    /** One edit, as Obsidian reports it: the new value, then onChange. */
    type(value: string) { component.value = value; changed?.(value); },
    blur() { for (const listener of listeners.get("blur") ?? []) listener(); },
  };
}

/** Just enough of Obsidian's ToggleComponent: a value, and a way to flip it as a user would. */
function fakeToggle() {
  let changed: ((value: boolean) => void) | null = null;
  const component = {
    value: false,
    setValue(value: boolean) { component.value = value; return component; },
    onChange(listener: (value: boolean) => void) { changed = listener; return component; },
  };
  return { component, flip(value: boolean) { component.value = value; changed?.(value); } };
}

/** Just enough of Obsidian's DropdownComponent to choose an option as a user would. */
function fakeDropdown() {
  let changed: ((value: string) => void) | null = null;
  const options: string[] = [];
  const component = {
    value: "",
    addOption(value: string) { options.push(value); return component; },
    setValue(value: string) { component.value = value; return component; },
    getValue() { return component.value; },
    onChange(listener: (value: string) => void) { changed = listener; return component; },
  };
  return { component, options, choose(value: string) { component.value = value; changed?.(value); } };
}

/** A Setting that records what a render row added to it. */
function fakeSetting() {
  const texts: ReturnType<typeof fakeText>[] = [];
  const toggles: ReturnType<typeof fakeToggle>[] = [];
  const dropdowns: ReturnType<typeof fakeDropdown>[] = [];
  const added: string[] = [];
  const setting = {
    settingEl: { addClass: () => undefined, toggleClass: () => undefined },
    setClass: () => setting,
    setDisabled: () => setting,
    addText(build: (text: unknown) => unknown) {
      const text = fakeText();
      texts.push(text);
      added.push("text");
      build(text.component);
      return setting;
    },
    addToggle(build: (toggle: unknown) => unknown) {
      const toggle = fakeToggle();
      toggles.push(toggle);
      added.push("toggle");
      build(toggle.component);
      return setting;
    },
    addDropdown(build: (dropdown: unknown) => unknown) {
      const dropdown = fakeDropdown();
      dropdowns.push(dropdown);
      added.push("dropdown");
      build(dropdown.component);
      return setting;
    },
    addExtraButton() { added.push("extraButton"); return setting; },
  };
  return { setting: setting as unknown as Setting, texts, toggles, dropdowns, added };
}

function renderRow(leaf: SettingDefinition | undefined) {
  expect(leaf?.render, "row must be a render row").toBeTypeOf("function");
  const fake = fakeSetting();
  (leaf?.render as (setting: Setting) => void)(fake.setting);
  return fake;
}

function leafNamed(leaves: SettingDefinition[], name: string): SettingDefinition | undefined {
  return leaves.find((leaf) => leaf.name === name);
}

describe("the OpenAI-compatible server (#25)", () => {
  const URL_ROW = "OpenAI-compatible server URL";
  const KEY_ROW = "OpenAI-compatible server api key";

  it("puts its address row directly above its key row, after every other provider's rows", () => {
    const { ordered } = walk(buildSettingDefinitions(makeHost().host));
    const at = ordered.indexOf(URL_ROW);
    expect(ordered.slice(at - 1, at + 2)).toEqual(["OpenRouter base URL", URL_ROW, KEY_ROW]);
  });

  it("round-trips: the address persists to plugin data, the key goes to secret storage and never to data.json", () => {
    const { writes, host: plugin } = makePluginDouble();
    // The real setSecret (main.ts) writes to Obsidian secret storage; this one records the call.
    const setSecret = vi.fn();
    const host: SettingsHost = { ...plugin, setSecret };
    const { leaves } = walk(buildSettingDefinitions(host));

    renderRow(leafNamed(leaves, URL_ROW)).texts[0].type("http://192.168.1.20:1234/v1");
    renderRow(leafNamed(leaves, KEY_ROW)).texts[0].type("local-server-key");

    expect(setSecret).toHaveBeenCalledWith("openai-compatible", "local-server-key");
    expect(host.settings.openaiCompatibleBaseUrl).toBe("http://192.168.1.20:1234/v1");
    const saved = writes[writes.length - 1];
    expect(saved.openaiCompatibleBaseUrl).toBe("http://192.168.1.20:1234/v1");
    for (const payload of writes) expect(JSON.stringify(payload)).not.toContain("local-server-key");
  });

  it("judges the address on blur: a malformed one gets the clear notice, a good or blank one gets none", () => {
    const { host, spies } = makeHost();
    const url = renderRow(leafNamed(walk(buildSettingDefinitions(host)).leaves, URL_ROW)).texts[0];
    expect(url.component.placeholder).toBe("http://localhost:1234/v1");

    url.type("192.168.1.20:1234/v1");
    // Typing alone says nothing: the address is half-written until the field is left.
    expect(spies.showNotice).not.toHaveBeenCalled();
    url.blur();
    expect(spies.showNotice).toHaveBeenCalledWith(t("notice.openaiCompatible.invalidUrl"), 5000);

    spies.showNotice.mockClear();
    url.type("http://192.168.1.20:1234/v1");
    url.blur();
    url.type("");
    url.blur();
    expect(spies.showNotice).not.toHaveBeenCalled();
  });

  it("when selected, takes its model as free text: no dropdown, no refresh, an example model as placeholder", () => {
    // A data.json from before the provider existed: no selectedModels entry.
    const { host, spies } = makeHost({ selectedLLM: "openai-compatible", selectedModels: { openai: "gpt-4o" } });
    const { leaves } = walk(buildSettingDefinitions(host));
    const header = leaves.findIndex((leaf) => leaf.name === "OpenAI-compatible server model");
    expect(leaves[header].desc).toBe(t("settings.llm.model.descFreeText"));

    // The custom-model field's second blur listener schedules a panel refresh on `window`.
    vi.stubGlobal("window", { setTimeout: () => 0 });
    try {
      const controls = renderRow(leaves[header + 1]);
      expect(controls.added).toEqual(["text"]);
      const model = controls.texts[0];
      expect(model.component.placeholder).toBe("llama-3.1-8b-instruct");
      expect(model.component.value).toBe("");

      model.type("qwen2.5-7b-instruct");
      model.blur();
      expect(host.settings.selectedModels["openai-compatible"]).toBe("qwen2.5-7b-instruct");
      expect(host.settings.customModelLimits["openai-compatible:qwen2.5-7b-instruct"]).toBeDefined();
      expect(spies.saveSettings).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a custom base URL for every provider with a vendor default (#29)", () => {
  it("follows each of those providers' key row, behind its toggle, and no other", () => {
    const { ordered } = walk(buildSettingDefinitions(makeHost().host));
    for (const name of ["OpenAI", "Anthropic", "Google", "OpenRouter"]) {
      const at = ordered.indexOf(`${name} api key`);
      expect(ordered.slice(at, at + 3)).toEqual([`${name} api key`, `Custom ${name} base URL`, `${name} base URL`]);
    }
    expect(ordered).not.toContain("Ollama base URL");
    expect(ordered).not.toContain("OpenAI-compatible server base URL");
  });

  it("shows the vendor default as the placeholder, stores what is typed, and never touches the shared defaults", () => {
    const { writes, host } = makePluginDouble();
    // As loadSettings leaves it for anyone who never set one: `{ ...DEFAULT_SETTINGS, ...loaded }`
    // shares the default's map rather than copying it.
    host.settings.customBaseUrls = DEFAULT_SETTINGS.customBaseUrls;
    const field = renderRow(leafNamed(walk(buildSettingDefinitions(host)).leaves, "Anthropic base URL")).texts[0];
    expect(field.component.placeholder).toBe(DEFAULT_BASE_URLS.anthropic);
    expect(field.component.value).toBe("");

    field.type("http://gateway.local:4000/anthropic");
    expect(host.settings.customBaseUrls).toEqual({ anthropic: "http://gateway.local:4000/anthropic" });
    expect(writes[writes.length - 1].customBaseUrls).toEqual({ anthropic: "http://gateway.local:4000/anthropic" });
    // Settings are merged shallowly onto DEFAULT_SETTINGS: a write INTO the
    // map would have changed the default for everyone.
    expect(DEFAULT_SETTINGS.customBaseUrls).toEqual({});
  });

  it("judges an override on blur: malformed gets the clear notice, blank or well-formed none", () => {
    const { host, spies } = makeHost();
    const field = renderRow(leafNamed(walk(buildSettingDefinitions(host)).leaves, "OpenAI base URL")).texts[0];
    field.type("proxy.example.com/v1");
    field.blur();
    expect(spies.showNotice).toHaveBeenCalledWith(t("notice.baseUrl.invalid"), 5000);
    spies.showNotice.mockClear();
    field.type("https://proxy.example.com/v1");
    field.blur();
    field.type("");
    field.blur();
    expect(spies.showNotice).not.toHaveBeenCalled();
  });
});

// --- only the selected provider's configuration is shown (#28) -------------

/** Whether Obsidian would render the row: `visible` absent, true, or a closure answering true. */
function isVisible(leaf: SettingDefinition | undefined): boolean {
  const visible = leaf?.visible;
  return typeof visible === "function" ? visible() : visible !== false;
}

describe("only the selected provider's configuration is shown (#28)", () => {
  const BRANDS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", openrouter: "OpenRouter" };
  const ALL = ["openai", "anthropic", "google", "ollama", "openrouter", "openai-compatible"];
  const keyRow = (provider: string): string =>
    provider === "openai-compatible" ? "OpenAI-compatible server api key" : `${BRANDS[provider] ?? "Ollama"} api key`;

  it.each(ALL)("with %s selected, its connection rows are shown and every other provider's are hidden", (selected) => {
    // Every toggle on, so each base URL field is hidden by the provider choice alone.
    const enabled = { openai: true, anthropic: true, google: true, openrouter: true };
    const { leaves } = walk(buildSettingDefinitions(makeHost({ selectedLLM: selected, customBaseUrlEnabled: enabled }).host));
    for (const provider of ALL) {
      const mine = provider === selected;
      expect(isVisible(leafNamed(leaves, keyRow(provider))), `${keyRow(provider)} with ${selected} selected`).toBe(mine);
      if (provider in BRANDS) {
        expect(isVisible(leafNamed(leaves, `Custom ${BRANDS[provider]} base URL`))).toBe(mine);
        expect(isVisible(leafNamed(leaves, `${BRANDS[provider]} base URL`))).toBe(mine);
      }
    }
    expect(isVisible(leafNamed(leaves, "OpenAI-compatible server URL"))).toBe(selected === "openai-compatible");
  });

  it("hides a base URL field until its toggle is on; the toggle saves, then re-renders through update()", async () => {
    const { host, spies } = makeHost({ selectedLLM: "google" });
    host.settings.customBaseUrlEnabled = DEFAULT_SETTINGS.customBaseUrlEnabled; // shared, as loadSettings leaves it
    const { leaves } = walk(buildSettingDefinitions(host));
    const field = leafNamed(leaves, "Google base URL");
    expect(isVisible(field)).toBe(false);

    const toggle = renderRow(leafNamed(leaves, "Custom Google base URL")).toggles[0];
    expect(toggle.component.value).toBe(false);
    toggle.flip(true);

    expect(host.settings.customBaseUrlEnabled).toEqual({ google: true });
    expect(isVisible(field)).toBe(true);
    await vi.waitFor(() => expect(spies.update).toHaveBeenCalledTimes(1));
    expect(spies.saveSettings).toHaveBeenCalledTimes(1);
    expect(DEFAULT_SETTINGS.customBaseUrlEnabled).toEqual({});
  });

  it("keeps every hidden provider's values through a switch away and back: keys, addresses and toggles", async () => {
    const { writes, host: plugin } = makePluginDouble();
    const setSecret = vi.fn();
    const update = vi.fn();
    const host: SettingsHost = { ...plugin, setSecret, update };
    Object.assign(host.settings, {
      selectedLLM: "openai",
      openaiCompatibleBaseUrl: "http://box:1234/v1",
      customBaseUrls: { openai: "http://proxy.local/v1", google: "http://proxy.local/google" },
      customBaseUrlEnabled: { openai: true, google: false },
    });
    host.settings.apiKeys = { ...host.settings.apiKeys, ollama: "http://box:11434", "openai-compatible": "local-server-key" };
    const snapshot = () => structuredClone({
      apiKeys: host.settings.apiKeys,
      openaiCompatibleBaseUrl: host.settings.openaiCompatibleBaseUrl,
      customBaseUrls: host.settings.customBaseUrls,
      customBaseUrlEnabled: host.settings.customBaseUrlEnabled,
    });
    const before = snapshot();

    const provider = renderRow(leafNamed(walk(buildSettingDefinitions(host)).leaves, "Provider")).dropdowns[0];
    provider.choose("ollama");
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    provider.choose("openai-compatible");
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    provider.choose("openai");
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(3));

    expect(host.settings.selectedLLM).toBe("openai");
    expect(snapshot()).toEqual(before);
    // Hiding a key row is not clearing it: secret storage is never written to.
    expect(setSecret).not.toHaveBeenCalled();
    const saved = writes[writes.length - 1];
    expect(saved.customBaseUrls).toEqual(before.customBaseUrls);
    expect(saved.customBaseUrlEnabled).toEqual(before.customBaseUrlEnabled);
    expect(saved.openaiCompatibleBaseUrl).toBe("http://box:1234/v1");
    expect(saved.apiKeys).toEqual({ ollama: "http://box:11434" });
    for (const secret of ["sk-openai", "sk-ant", "g-key", "or-key", "local-server-key"]) {
      expect(JSON.stringify(writes)).not.toContain(secret);
    }
  });
});
