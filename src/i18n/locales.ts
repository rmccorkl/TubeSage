// The locale table, built from static JSON imports. Obsidian plugins ship a
// single `main.js` with no code splitting, so every shipped locale is bundled
// whole — there is no per-locale code splitting to fall back on. Whether to
// load locales from the plugin folder instead (an async read at `onload()`,
// keeping `main.js` flat as the locale count grows) is still an open decision
// for the maintainer, not settled by this module; see the i18n phase 1b/1c
// reports for the measured cost and the threshold that would trigger it.
//
// `en.json` is the source of truth and is already `key -> string`, so it is
// imported as-is. Every other locale is *committed* as `key -> { original,
// translation }` at `src/locales/<code>.json`, mirroring the `original=`/
// `translation=` pairs in Obsidian's own translation files so that an English
// string changing under a translation is detectable (`npm run i18n:check`).
// But esbuild bundles a static JSON import as an object literal — it cannot
// tree-shake a property out of it — so importing that paired file here would
// ship the duplicated `original` (the English text again) in `main.js` for
// every key of every locale, for no runtime benefit: `t()` only ever reads
// `translation`. So `npm run i18n:build` additionally generates a flat,
// translation-only sibling per translated locale at
// `src/locales/flat/<code>.json` (`key -> string`, the same shape `en.json`
// already has), and this module imports *that* — the imported type is the
// runtime shape, with no flattening step and nothing to tree-shake.
// `npm run i18n:check` guards the two artifacts staying in sync: every flat
// value must equal its paired file's `translation` for that key, and the two
// sets of files must cover the same locales and keys.
import type { LocaleTable } from './index';
import en from '../locales/en.json';
import enGB from '../locales/flat/en-GB.json';
import de from '../locales/flat/de.json';
import fr from '../locales/flat/fr.json';
import es from '../locales/flat/es.json';
import ja from '../locales/flat/ja.json';
import zh from '../locales/flat/zh.json';

// Adding a language is a data change: add the column to `i18n/strings.csv`,
// then `npm run i18n:build` generates both `src/locales/<code>.json` (the
// paired original/translation file the drift check reads) and
// `src/locales/flat/<code>.json` (the flat file the bundle imports). One line
// here —
//     import it from '../locales/flat/it.json';
//     ... it,
// The codes are Obsidian's own, so that they match what `getLanguage()`
// returns. `zh` IS Simplified Chinese in that table; Traditional is `zh-TW`.
export const LOCALES: LocaleTable = {
    en,
    'en-GB': enGB,
    de,
    fr,
    es,
    ja,
    zh,
};
