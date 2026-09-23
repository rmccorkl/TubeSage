// The locale table, built from static JSON imports: every locale is bundled.
//
// WHY BUNDLED AND NOT SHIPPED AS FILES (this reverses issue #8): Obsidian's
// community plugin installer downloads exactly `main.js`, `manifest.json` and
// `styles.css` from a release and copies those into the plugin folder. A
// release asset that is not one of those three never reaches a store install,
// so a locale published as an asset would have been read by nobody and every
// non-English user would have seen English. Bundling is the only mechanism
// that puts a translation in front of a user who installed from the catalogue,
// which is why the whole set is imported here and `main.js` carries it.
//
// `src/i18n/locale-loader.ts` still reads `<manifest.dir>/<code>.json` at load
// time, but as an OVERRIDE: a file a user or translator drops into the plugin
// folder by hand wins over the bundled table for that language. Its absence is
// the normal case and costs nothing — the bundled table answers.
//
// TWO IMPORT DEPTHS, ON PURPOSE. `en.json` is the source of truth and is
// already `key -> string`, so `../locales/en.json` (i.e. `src/locales/`) is
// imported as-is. Every other locale is *committed* as `key -> { original,
// translation }` at `src/locales/<code>.json`, mirroring the `original=`/
// `translation=` pairs in Obsidian's own translation files so that an English
// string changing under a translation is detectable (`npm run i18n:check`).
// But esbuild bundles a static JSON import as an object literal — it cannot
// tree-shake a property out of it — so importing that paired file here would
// ship the duplicated `original` (the English text again) in `main.js` for
// every key of every locale, for no runtime benefit: `t()` only ever reads
// `translation`. So `npm run i18n:build` additionally generates the flat,
// translation-only form at `locales/<code>.json` in the REPO ROOT (`key ->
// string`, the same shape `en.json` already has and the shape the override
// loader parses), and this module imports *that* — hence `../../locales/`.
// `npm run i18n:check` guards the two artifacts staying in sync.
import type { LocaleEntries, LocaleTable } from './index';
import en from '../locales/en.json';
import enGB from '../../locales/en-GB.json';
import de from '../../locales/de.json';
import fr from '../../locales/fr.json';
import es from '../../locales/es.json';
import ja from '../../locales/ja.json';
import zh from '../../locales/zh.json';
import it from '../../locales/it.json';
import pt from '../../locales/pt.json';
import ptBR from '../../locales/pt-BR.json';
import ca from '../../locales/ca.json';
import gl from '../../locales/gl.json';
import ro from '../../locales/ro.json';
import nl from '../../locales/nl.json';
import da from '../../locales/da.json';
import no from '../../locales/no.json';
import sv from '../../locales/sv.json';
import fi from '../../locales/fi.json';
import pl from '../../locales/pl.json';
import cs from '../../locales/cs.json';
import sk from '../../locales/sk.json';
import ru from '../../locales/ru.json';
import uk from '../../locales/uk.json';
import be from '../../locales/be.json';
import bg from '../../locales/bg.json';
import sr from '../../locales/sr.json';
import lv from '../../locales/lv.json';
import hu from '../../locales/hu.json';
import ko from '../../locales/ko.json';
import zhTW from '../../locales/zh-TW.json';
import th from '../../locales/th.json';
import vi from '../../locales/vi.json';
import id from '../../locales/id.json';
import ms from '../../locales/ms.json';
import km from '../../locales/km.json';
import ta from '../../locales/ta.json';
import si from '../../locales/si.json';
import ar from '../../locales/ar.json';
import fa from '../../locales/fa.json';
import he from '../../locales/he.json';
import am from '../../locales/am.json';
import bn from '../../locales/bn.json';
import ne from '../../locales/ne.json';
import sa from '../../locales/sa.json';
import ka from '../../locales/ka.json';
import kab from '../../locales/kab.json';
import el from '../../locales/el.json';
import tr from '../../locales/tr.json';
import uz from '../../locales/uz.json';
import sq from '../../locales/sq.json';
import ga from '../../locales/ga.json';

// `'en'` rather than `BASE_LOCALE`: `./index` imports LOCALES from this module,
// so importing a *value* back from it would close an import cycle. The type-only
// import above does not.
const BASE = 'en';

/**
 * Every locale compiled into `main.js`. Frozen at module load and never
 * mutated: it is the record of what the code shipped, which is what makes
 * `clearRuntimeLocales()` able to restore it and `hasBundledLocale()` able to
 * answer without an installed override masquerading as bundled.
 *
 * Adding a language is a data change plus one import: add the column to
 * `i18n/strings.csv`, run `npm run i18n:build` (which generates both
 * `src/locales/<code>.json` and `locales/<code>.json`), then —
 *     import it from '../../locales/it.json';
 *     ... it,
 * `scripts/i18n-packaging.test.mjs` fails if a generated file has no import
 * here, so a language cannot be authored and then silently left out of the
 * bundle. The codes are Obsidian's own, so that they match what
 * `getLanguage()` returns. `zh` IS Simplified Chinese in that table;
 * Traditional is `zh-TW`. `sr` is Obsidian's single Serbian code and carries no
 * script subtag, so one script has to be chosen for it: this table's `sr` is
 * Cyrillic, matching the native name (`српски језик`) that Obsidian's own
 * translation table gives that row.
 */
export const BUNDLED_LOCALES: LocaleTable = {
    en,
    'en-GB': enGB,
    de,
    fr,
    es,
    ja,
    zh,
    it,
    pt,
    'pt-BR': ptBR,
    ca,
    gl,
    ro,
    nl,
    da,
    no,
    sv,
    fi,
    pl,
    cs,
    sk,
    ru,
    uk,
    be,
    bg,
    sr,
    lv,
    hu,
    ko,
    'zh-TW': zhTW,
    th,
    vi,
    id,
    ms,
    km,
    // ALIAS, not a 51st language: the same Khmer table under a second key.
    //
    // Obsidian's published translations table (the list `getLanguage()`'s own
    // doc comment points at) gives Khmer as `km`. The 1.12.7 binary installed
    // on this machine disagrees — its language map literally reads
    // `kh:"\u1781\u17d2\u1798\u17c2\u179a"`, and contains no `km` key at
    // all. No 1.13.x binary was available to read, and `getLanguage()`'s return
    // set is not enumerated in the 1.13.1 typings, so which code a supported
    // install actually emits could not be established by reading code.
    //
    // The other seven codes 1.12.7 lacks (bg, el, gl, kab, sa, si, ta) are all
    // languages the published table has gained since, which is good reason to
    // think the table is simply newer and `km` is the current spelling. It is
    // not proof. Registering both costs one object reference and nothing else;
    // guessing wrong costs the whole language, silently — Khmer would fall
    // back to English with nothing reporting it, which is precisely how the
    // missing Italian went unnoticed.
    kh: km,
    ta,
    si,
    ar,
    fa,
    he,
    am,
    bn,
    ne,
    sa,
    ka,
    kab,
    el,
    tr,
    uz,
    sq,
    ga,
};

/**
 * The live lookup table `t()` reads: the bundled set, plus whatever single
 * override the loader found in the plugin folder.
 *
 * Mutated in place, never reassigned — `./index` closes over this reference
 * when it calls `translate(LOCALES, ...)`, so a reassignment here would leave
 * `t()` reading the old object.
 */
export const LOCALES: LocaleTable = { ...BUNDLED_LOCALES };

/**
 * Whether the code shipped a table for `code` — overrides do not count.
 *
 * Own keys, not `code in BUNDLED_LOCALES`: `in` walks the prototype, so it
 * would answer true for `constructor` or `toString`. No language code spells
 * either, but a lookup that can be wrong for an input it never has to handle
 * is still a worse answer than one that cannot.
 */
export function hasBundledLocale(code: string): boolean {
    return Object.keys(BUNDLED_LOCALES).includes(code);
}

/**
 * Install an override read from the plugin folder, displacing the bundled
 * table for that language. Called at most once, from `onload()`, before the
 * settings tab can possibly render. Installing English is a no-op: English is
 * the guaranteed fallback and must stay the one the code shipped, so no
 * dropped file can leave a key unanswerable.
 */
export function installRuntimeLocale(code: string, entries: LocaleEntries): void {
    if (code === BASE) return;
    LOCALES[code] = entries;
}

/**
 * Drop every override, restoring the table the code shipped. The symmetric
 * partner of `installRuntimeLocale()`; tests use it so an installed override
 * cannot leak into a later case — and, because every locale is bundled, it
 * restores a displaced language rather than deleting it.
 */
export function clearRuntimeLocales(): void {
    for (const code of Object.keys(LOCALES)) {
        if (!hasBundledLocale(code)) delete LOCALES[code];
    }
    for (const code of Object.keys(BUNDLED_LOCALES)) {
        LOCALES[code] = BUNDLED_LOCALES[code];
    }
}
