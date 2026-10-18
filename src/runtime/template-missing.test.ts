import { afterEach, describe, expect, it } from "vitest";
import { PermanentJobError } from "../jobs/job-runner";
import { setLanguageResolver } from "../i18n";
import { LOCALES } from "../i18n/locales";
import { templateNotFoundError } from "./template-missing";

afterEach(() => {
  setLanguageResolver(null);
});

describe("templateNotFoundError — a missing template file, said plainly (#27)", () => {
  const PATH = "Templates/YouTube.md";

  it("is permanent, so the job FAILS and shows it, rather than ending 'interrupted' with nothing said", () => {
    expect(templateNotFoundError(PATH)).toBeInstanceOf(PermanentJobError);
  });

  it("names the exact path, says to check the name and the folder, and names the setting that fixes it", () => {
    const message = templateNotFoundError(PATH).message;
    expect(message).toContain(PATH);
    expect(message).toMatch(/file name/);
    expect(message).toMatch(/folder/);
    expect(message).toContain(LOCALES.en["settings.templates.templaterFile.name"]);
  });

  it("is localised: in every bundled language it carries the path and that language's own name for the setting", () => {
    for (const code of Object.keys(LOCALES)) {
      setLanguageResolver(() => code);
      const message = templateNotFoundError(PATH).message;
      expect(message, code).toContain(PATH);
      expect(message, code).toContain(LOCALES[code]["settings.templates.templaterFile.name"]);
      expect(message, code).not.toContain("{path}");
    }
  });
});
