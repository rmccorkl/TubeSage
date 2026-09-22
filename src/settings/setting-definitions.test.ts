import { describe, expect, it, vi } from "vitest";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import { JOBS_KEY, JobStore } from "../jobs/job-store";
import type { JobStoreIO } from "../jobs/job-store";
import { createJobRecord } from "../jobs/job-record";
import { settingsForPersist } from "../runtime/settings-persist";
import { DEFAULT_SETTINGS } from "./settings-defaults";
import type { YouTubeTranscriptSettings } from "./settings-defaults";
import { buildSettingDefinitions, readSettingValue, writeSettingValue } from "./setting-definitions";
import type { SettingsHost } from "./setting-definitions";
import legacy from "./__fixtures__/legacy-display-rows.json";

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

describe("buildSettingDefinitions — coverage of the legacy display() rows", () => {
  it.each(PROVIDERS)("with %s selected: every legacy row appears exactly once, in render order, and nothing else", (provider) => {
    const { host } = makeHost({ selectedLLM: provider });
    const { ordered } = walk(buildSettingDefinitions(host));
    expect(ordered).toEqual(legacyRowsFor(provider).map((r) => r.name));
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

class FakeIO implements JobStoreIO {
  calls: Record<string, unknown>[] = [];
  loadData(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  saveData(data: unknown): Promise<void> {
    this.calls.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
    return Promise.resolve();
  }
}

/** A plugin double with the real persist path: JobStore + settingsForPersist. */
async function makePluginDouble() {
  const settings = liveSettings({ selectedLLM: "anthropic" });
  const io = new FakeIO();
  const store = new JobStore(io, () => settingsForPersist(settings, DEFAULT_SETTINGS.apiKeys.ollama));
  await store.upsert(
    createJobRecord({
      id: "job-1",
      url: "https://youtu.be/abc123",
      videoId: "abc123",
      folder: "",
      customTitle: "",
      useFastSummary: false,
      transcriptBilling: "free",
      now: 1000,
    }),
    1000,
  );
  io.calls = [];
  const plugin = {
    settings,
    summarizerInits: 0,
    // Raw Plugin.saveData — the default PluginSettingTab.setControlValue calls
    // this directly; the override must never do so.
    saveData: vi.fn(() => Promise.resolve()),
    saveSettings: vi.fn(async () => {
      await store.flush();
      plugin.summarizerInits++;
    }),
  };
  const host: SettingsHost = { ...hostSpies(), settings, defaults: DEFAULT_SETTINGS, saveSettings: plugin.saveSettings };
  return { plugin, io, host };
}

describe("writeSettingValue / readSettingValue — the control accessors", () => {
  it("a control change makes exactly one saveSettings() call and zero direct saveData calls", async () => {
    const { plugin, io, host } = await makePluginDouble();
    await writeSettingValue(host, "translateLanguage", "fr");
    expect(plugin.settings.translateLanguage).toBe("fr");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.summarizerInits).toBe(1);
    // The write went through the store's serialized writer exactly once.
    expect(io.calls).toHaveLength(1);
  });

  it("the persisted payload never contains cloud keys and keeps the store's _jobs", async () => {
    const { io, host } = await makePluginDouble();
    await writeSettingValue(host, "transcriptRootFolder", "Notes");
    const payload = io.calls[0];
    expect(payload.transcriptRootFolder).toBe("Notes");
    expect(payload.apiKeys).toEqual({ ollama: DEFAULT_SETTINGS.apiKeys.ollama });
    const json = JSON.stringify(payload);
    for (const secret of ["sk-openai", "sk-ant", "g-key", "or-key"]) expect(json).not.toContain(secret);
    expect(payload[JOBS_KEY]).toEqual([expect.objectContaining({ id: "job-1" })]);
  });

  it("reads and writes dot-notation paths through nested settings", async () => {
    const { host, plugin } = await makePluginDouble();
    expect(readSettingValue(plugin.settings, "translateCountry")).toBe("US");
    expect(readSettingValue(plugin.settings, "apiKeys.ollama")).toBe(DEFAULT_SETTINGS.apiKeys.ollama);
    expect(readSettingValue(plugin.settings, "nope.missing")).toBeUndefined();
    await writeSettingValue(host, "apiKeys.ollama", "http://box:11434");
    expect(plugin.settings.apiKeys.ollama).toBe("http://box:11434");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });
});
