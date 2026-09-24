// The example-template modal, minus Obsidian. Two failures are being pinned
// here, both of which shipped:
//
// ONE: the modal read `templates/YouTubeTranscript.md` off disk, and the
// installer never copies that file into a store install, so the modal said
// "could not load" to every catalogue user.
//
// TWO — the collateral damage: the Templater variable reference and the
// explanation were built after the failing read, inside the same `try`, so
// they disappeared too. They are bundled strings that never needed a file.
// The assertions below therefore check the WHOLE view, not just the template
// body: help text that goes missing when the template does is the regression.
import { beforeAll, describe, expect, it } from "vitest";
import { exampleTemplate } from "../bundled";
import { setLanguageResolver } from "../i18n";
import { exampleTemplateView } from "./example-template-view";

/**
 * An `App` that fails the test the moment anything is read off it. The view
 * takes no arguments — there is no seam to reach a vault through, which is the
 * fix — so it is handed in anyway: if a future change gives the view a
 * parameter and starts reading files again, the first property access throws
 * instead of quietly working in development and failing for everyone else.
 */
const hostileApp = new Proxy(
    {},
    {
        get(_target, property) {
            throw new Error(`the example-template view read app.${String(property)} — it must touch no file at all`);
        },
    },
);

describe("the example-template modal's contents", () => {
    beforeAll(() => {
        setLanguageResolver(() => "en");
    });

    it("renders with no filesystem access at all", () => {
        expect(exampleTemplateView.length, "the view must take nothing — there is no file to hand it").toBe(0);
        const handedAnApp: (app?: unknown) => ReturnType<typeof exampleTemplateView> = exampleTemplateView;
        const view = handedAnApp(hostileApp);
        expect(view.template).toBe(exampleTemplate());
    });

    it("shows the bundled template, not a copy of it", () => {
        // A simulated store install is exactly this: nothing on disk, no vault
        // copy, no plugin-folder file. The body still arrives.
        expect(exampleTemplateView().template).toBe(exampleTemplate());
        expect(exampleTemplateView().template).toContain("tp.user.watchUrl");
    });

    it("shows the explanation and the variable reference on the same unskippable path", () => {
        // The bug: these were written after a throw. They are returned by the
        // same call that returns the template now, so one cannot survive
        // without the other.
        const view = exampleTemplateView();
        expect(view.explanation.trim()).not.toBe("");
        expect(view.explanation).not.toBe("modal.template.explanation");
        expect(view.variablesHeading.trim()).not.toBe("");
        expect(view.variablesHeading).not.toBe("modal.template.variablesHeading");
    });

    it("documents every Templater variable the example template uses", () => {
        const view = exampleTemplateView();
        expect(view.variables.map((row) => row.name)).toEqual([
            "tp.user.title",
            "tp.user.videoUrl",
            "tp.user.transcript",
            "tp.user.summary",
            "tp.user.llmProvider",
            "tp.user.llmModel",
            "tp.user.llmTags",
        ]);
        for (const row of view.variables) {
            expect(row.description.trim(), `${row.name} has no description`).not.toBe("");
            expect(row.description, `${row.name} shows a raw key`).not.toMatch(/^modal\.template\.var\./);
        }
    });
});
