import { t } from "../i18n";
import { PermanentJobError } from "../jobs/job-runner";

/**
 * The error raised when the configured template file is not in the vault (#27).
 *
 * PERMANENT, which is the half of this that decides whether the user sees
 * anything at all: a plain Error from renderNote is read by the runner as
 * transient, so the job ended `interrupted` and the user got "Processing was
 * interrupted", with the path and the reason left in a `lastError` nothing
 * displays. A missing file does not appear by trying again, so the job FAILS,
 * and its message reaches the user through `notice.job.failed`.
 *
 * Localised here, where it is raised, like `common.transcript.unavailable` in
 * job-adapters.ts: the message is TubeSage's own sentence, not a provider's,
 * so it is translated. `path` is the normalised path that was looked up.
 *
 * Out here rather than inline in main.ts so that a test can hold it to all
 * three promises: permanent, names the path, quotes the setting that fixes it.
 */
export function templateNotFoundError(path: string): PermanentJobError {
  return new PermanentJobError(t("notice.template.notFound", { path }));
}
