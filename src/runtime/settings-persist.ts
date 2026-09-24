import { COLLECTIONS_KEY } from "../jobs/collection-record";
import { JOBS_KEY } from "../jobs/job-store";

// The settings payload that reaches data.json. Pure and Obsidian-free so the
// exact function main.ts hands to the JobStore as `composeSettings` can be
// tested against a real store (settings-persist.test.ts).
//
// Two invariants: cloud-provider API keys live in Obsidian secret storage and
// never in data.json (only the ollama entry — a server URL, not a secret —
// is kept); and the reserved `_jobs` key is owned by the store, which adds
// it at flush time, so it must never leak through from the settings object.
// `_collections` (#9) is reserved the same way and for the same reason: it is a
// sibling of `_jobs`, not a setting, and a run's records must not be rewritten
// as user configuration.

/** Structural: any settings object with an optional apiKeys map (the plugin's interface satisfies it). */
export interface PersistableSettings {
  apiKeys?: Record<string, string | undefined>;
}

/** `ollamaDefault` is DEFAULT_SETTINGS.apiKeys.ollama in main.ts; it stays there so this module has no settings dependency. */
export function settingsForPersist(settings: PersistableSettings, ollamaDefault: string): Record<string, unknown> {
  const sanitizedApiKeys: Record<string, string> = { ollama: settings.apiKeys?.ollama ?? ollamaDefault };
  const payload: Record<string, unknown> = { ...settings, apiKeys: sanitizedApiKeys };
  delete payload[JOBS_KEY];
  delete payload[COLLECTIONS_KEY];
  return payload;
}
