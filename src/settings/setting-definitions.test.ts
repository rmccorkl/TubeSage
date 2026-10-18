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

/** A Setting that records what a render row added to it. */
function fakeSetting() {
  const texts: ReturnType<typeof fakeText>[] = [];
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
    addDropdown() { added.push("dropdown"); return setting; },
    addExtraButton() { added.push("extraButton"); return setting; },
  };
  return { setting: setting as unknown as Setting, texts, added };
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

  it("puts its address row directly above its key row, after every other provider's key", () => {
    const { ordered } = walk(buildSettingDefinitions(makeHost().host));
    const at = ordered.indexOf(URL_ROW);
    expect(ordered.slice(at - 1, at + 2)).toEqual(["OpenRouter api key", URL_ROW, KEY_ROW]);
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
