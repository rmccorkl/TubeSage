import { COLLECTIONS_KEY } from "../jobs/collection-record";
import { JOBS_KEY } from "../jobs/job-store";

// The settings payload that reaches data.json. Pure and Obsidian-free so the
// exact function main.ts persists through can be tested directly
// (settings-persist.test.ts).
//
// Two invariants:
//
// 1. Cloud-provider API keys live in Obsidian secret storage and never in
//    data.json (only the ollama entry — a server URL, not a secret — is kept).
//    So do the three transcript-service keys (#38).
//    This function is the ONLY thing standing between a live key and disk.
//
// 2. `_jobs` and `_collections` never go back out. Jobs are memory-only since
//    #10, so nothing writes them any more; main.ts deletes a leftover pair
//    from an upgraded data.json once, on load. Stripping them here is the
//    migration guard behind that: a stale key that somehow reached the live
//    settings object would otherwise be rewritten as user configuration and
//    then persist forever.

/**
 * The providers whose apiKeys entry is a secret, kept in Obsidian secret
 * storage under SECRET_IDS. 'ollama' is intentionally excluded — its entry is
 * a server URL, not a secret, and stays in data.json. The OpenAI-compatible
 * server is included although it is self-hosted rather than cloud: its key is
 * optional, but when there is one it is as much a secret as any other (#25).
 */
export const SECRET_KEY_PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter', 'openai-compatible'] as const;

/**
 * Secret-storage IDs, one per provider above. IDs must be lowercase
 * alphanumeric with optional dashes (required by SecretStorage.setSecret).
 */
export const SECRET_IDS: Record<string, string> = {
  openai: 'tubesage-openai-key',
  anthropic: 'tubesage-anthropic-key',
  google: 'tubesage-google-key',
  openrouter: 'tubesage-openrouter-key',
  'openai-compatible': 'tubesage-openai-compatible-key',
};

/**
 * Secret-storage IDs for the transcript-service keys (#38), keyed by their
 * top-level settings field. Same ID rules as SECRET_IDS.
 */
export const TRANSCRIPT_SECRET_IDS = {
  youtubeApiKey: 'tubesage-youtube-data-key',
  scrapcreatorsApiKey: 'tubesage-scrapecreators-key',
  supadataApiKey: 'tubesage-supadata-key',
} as const;

export type TranscriptKeyField = keyof typeof TRANSCRIPT_SECRET_IDS;

const TRANSCRIPT_KEY_FIELDS = Object.keys(TRANSCRIPT_SECRET_IDS) as TranscriptKeyField[];

/** The two calls the migration makes on Obsidian's SecretStorage. */
interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/**
 * Load-time migration for the transcript-service keys, the steps main.ts takes
 * for the provider keys: a non-empty data.json value is copied into secret
 * storage unless storage already holds one, then the runtime field is filled
 * from storage. Returns whether data.json held any of them, so the caller
 * persists once to scrub it, after the copy.
 */
export function loadTranscriptKeys(
  loaded: Partial<Record<TranscriptKeyField, unknown>>,
  settings: Record<TranscriptKeyField, string>,
  store: SecretStore,
): boolean {
  let foundInData = false;
  for (const field of TRANSCRIPT_KEY_FIELDS) {
    const id = TRANSCRIPT_SECRET_IDS[field];
    const fromData = loaded[field];
    if (typeof fromData === 'string' && fromData.trim() !== '') {
      foundInData = true;
      if (!store.getSecret(id)) store.setSecret(id, fromData);
    }
    settings[field] = store.getSecret(id) ?? '';
  }
  return foundInData;
}

/** Structural: any settings object with an optional apiKeys map (the plugin's interface satisfies it). */
export interface PersistableSettings {
  apiKeys?: Record<string, string | undefined>;
}

/** `ollamaDefault` is DEFAULT_SETTINGS.apiKeys.ollama in main.ts; it stays there so this module has no settings dependency. */
export function settingsForPersist(settings: PersistableSettings, ollamaDefault: string): Record<string, unknown> {
  const sanitizedApiKeys: Record<string, string> = { ollama: settings.apiKeys?.ollama ?? ollamaDefault };
  const payload: Record<string, unknown> = { ...settings, apiKeys: sanitizedApiKeys };
  for (const field of TRANSCRIPT_KEY_FIELDS) delete payload[field];
  delete payload[JOBS_KEY];
  delete payload[COLLECTIONS_KEY];
  return payload;
}

interface SaveWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * Serialized writer for the plugin's settings.
 *
 * Obsidian's Plugin.saveData() gives no ordering guarantee, and main.ts calls
 * persist() from a dozen places — including one fire-and-forget
 * `void saveSettings()` in the settings tab. Two saves started close together
 * could otherwise land in the opposite order and leave an OLDER snapshot on
 * disk. So: at most one write in flight, and every save requested while one is
 * running collapses into a SINGLE trailing write.
 *
 * The part that carries the guarantee is where `compose()` is called — inside
 * the loop, at the moment the write actually runs, never when it was
 * requested. A coalesced write therefore carries the newest settings, and the
 * last write to land is always the last settings. That is the property the job
 * store's writer used to provide before jobs became memory-only, minus the
 * records.
 *
 * Obsidian-free and clock-free, so it is driven directly by its tests.
 */
export class SettingsWriter {
  private writing = false;
  private dirty = false;
  private waiters: SaveWaiter[] = [];

  constructor(
    private readonly compose: () => Record<string, unknown>,
    private readonly write: (payload: Record<string, unknown>) => Promise<void>,
  ) {}

  /** Resolves once a write that included this caller's state has completed. */
  save(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.dirty = true;
      if (!this.writing) {
        // Fire-and-forget: runLoop settles every waiter it captures itself.
        void this.runLoop();
      }
    });
  }

  private async runLoop(): Promise<void> {
    this.writing = true;
    // Re-checking `dirty` after each write (rather than returning) is what
    // collapses every save that arrived mid-write into exactly one follow-up.
    while (this.dirty) {
      this.dirty = false;
      const waiters = this.waiters;
      this.waiters = [];
      try {
        // compose() is inside the try AND inside the loop: a throwing
        // composer rejects this write's waiters instead of wedging the
        // writer, and the payload is built from the settings as they stand
        // NOW, not as they stood when save() was called.
        await this.write(this.compose());
        for (const waiter of waiters) {
          waiter.resolve();
        }
      } catch (err) {
        for (const waiter of waiters) {
          waiter.reject(err);
        }
      }
    }
    this.writing = false;
  }
}
