// The text the three informational modals show, taken from the bundle.
//
// WHY THE BUNDLE AND NOT THE PLUGIN FOLDER: Obsidian's community installer
// downloads exactly `main.js`, `manifest.json` and `styles.css` from a release
// and copies those into the plugin folder. The licence, the README and the
// example template are none of those three, so the modals that used to read
// them at runtime found nothing on every store install and showed "could not
// load" instead. `scripts/deploy.sh` copies the files into a local install,
// which is why development never saw it. Inlining is the only mechanism that
// puts this text in front of a user who installed from the catalogue — the
// same conclusion `src/i18n/locales.ts` reached for translations.
//
// These accessors take no arguments: there is deliberately nothing to read
// from and no failure mode to handle. The constants come from generated
// modules written by `npm run bundled-text:build` (run by `npm run build`)
// from the repo files, which remain the single source of truth;
// `scripts/bundled-text-packaging.test.mjs` fails if either drifts from the
// other by one byte.
import { EXAMPLE_TEMPLATE } from './example-template.generated';
import { LICENSE_TEXT } from './license.generated';
import { README_TEXT } from './readme.generated';

/** The licence and disclaimer, verbatim from `MIT-license-tubesage.md`. */
export function licenseText(): string {
    return LICENSE_TEXT;
}

/** The documentation, verbatim from `README.md`. */
export function readmeText(): string {
    return README_TEXT;
}

/** The example Templater template, verbatim from `templates/YouTubeTranscript.md`. */
export function exampleTemplate(): string {
    return EXAMPLE_TEMPLATE;
}
