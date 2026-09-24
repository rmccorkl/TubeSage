// Everything the example-template modal shows, assembled without reading
// anything. `main.ts` renders this view; it decides nothing about content.
//
// WHY IT IS ONE VALUE. The modal used to build its contents inside one `try`
// that began with a file read and threw when the read failed. The Templater
// variable reference and the explanation below it were written AFTER that
// throw even though they are bundled strings that never needed a file — so on
// a store install, where the read could not succeed, the user lost the help
// text as well as the template. Returning the whole view in one value removes
// that ordering: the template body, the explanation and the variable rows are
// produced together, by a function with no failure path, so no part of it can
// be skipped by a failure in another part.
//
// The template itself comes from `src/bundled`, inlined from
// `templates/YouTubeTranscript.md` at build time because the installer never
// copies that file into a store install.
//
// Each `t()` call names its key literally: the i18n usage gate scans for
// exactly that shape, so a computed key would read as an orphan.
import { exampleTemplate } from '../bundled';
import { t } from '../i18n';

/** One row of the Templater variable reference. */
export interface TemplateVariableRow {
    /** The Templater identifier, never translated. */
    name: string;
    /** Its translated description, which carries its own leading separator. */
    description: string;
}

/** The complete contents of the example-template modal. */
export interface ExampleTemplateView {
    /** The example template, verbatim — this is what the copy button copies. */
    template: string;
    explanation: string;
    variablesHeading: string;
    variables: TemplateVariableRow[];
}

/** Build the modal's contents. Takes nothing, reads nothing, cannot fail. */
export function exampleTemplateView(): ExampleTemplateView {
    return {
        template: exampleTemplate(),
        explanation: t('modal.template.explanation'),
        variablesHeading: t('modal.template.variablesHeading'),
        variables: [
            { name: 'tp.user.title', description: t('modal.template.var.title.desc') },
            { name: 'tp.user.videoUrl', description: t('modal.template.var.videoUrl.desc') },
            { name: 'tp.user.transcript', description: t('modal.template.var.transcript.desc') },
            { name: 'tp.user.summary', description: t('modal.template.var.summary.desc') },
            { name: 'tp.user.llmProvider', description: t('modal.template.var.llmProvider.desc') },
            { name: 'tp.user.llmModel', description: t('modal.template.var.llmModel.desc') },
            { name: 'tp.user.llmTags', description: t('modal.template.var.llmTags.desc') },
        ],
    };
}
