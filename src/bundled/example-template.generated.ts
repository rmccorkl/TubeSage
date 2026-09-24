// GENERATED FILE — DO NOT EDIT. Run `npm run bundled-text:build`.
//
// Inlined from `templates/YouTubeTranscript.md`, which is the single source of truth.
// The example Templater template the user is invited to copy. The modal's job is
// to show the CANONICAL example, so it renders this and does not look on disk:
// a stale local copy shadowing the bundle would show something other than what
// the plugin actually ships.
//
// It is inlined because Obsidian's community installer copies only `main.js`,
// `manifest.json` and `styles.css` into the plugin folder, so a modal that read
// this file at runtime found nothing on a store install. See
// `scripts/bundled-text-lib.mjs`; `scripts/bundled-text-packaging.test.mjs`
// fails if this constant and its source file differ by one byte.
export const EXAMPLE_TEMPLATE = "---\ntitle: \"<% tp.user.title %>\"\nvideo_url: \"<% tp.user.watchUrl || tp.user.videoUrl %>\"\nvideo_id: \"<% tp.user.videoId %>\"\nthumbnail_url: \"<% tp.user.thumbnailUrl %>\"\ncreated: <% tp.date.now() %>\ntubesage_version: <% tp.user.version %>\ntags: <% tp.user.llmTags %>\ntranscript:  |\n<% tp.user.transcript %>\n---\n\n<%*\nconst watchUrl = tp.user.watchUrl || tp.user.videoUrl;\nconst thumbnailUrl = tp.user.thumbnailUrl || `https://img.youtube.com/vi/${tp.user.videoId}/hqdefault.jpg`;\nconst fullSummary = tp.user.summary || '';\nconst headingIndex = fullSummary.search(/^#{1,6}\\s/m);\nconst summaryIntro = headingIndex === -1 ? fullSummary : fullSummary.slice(0, headingIndex);\nconst summaryBody = headingIndex === -1 ? '' : fullSummary.slice(headingIndex);\nconst summaryIntroOneLine = summaryIntro.replace(/\\s*\\n\\s*/g, ' ').trim();\n-%>\n\n# <% tp.user.title %>\n![[Literaturenotes.png|banner+small p+ct]]\n\n> [!tip] Mobile Thumbnail (fallback)\n> <%* if (thumbnailUrl && watchUrl) { %>[![YouTube Thumbnail|400x225](<% thumbnailUrl %>)](<% watchUrl %>)<%* } else { %>Thumbnail unavailable for this URL<%* } %>\n\n\n> [!info] YouTube Video:\n> <%* if (watchUrl) { %>![Url|400x200](<% watchUrl %>)<%* } else { %><% tp.user.originalVideoUrl || tp.user.videoUrl %><%* } %>\n\n>[!summary]\n>>[!danger] AI :luc_bot: Generated with <% tp.user.llmProvider %>/<% tp.user.llmModel %>\n>> <% summaryIntroOneLine %>\n\n<% summaryBody %>\n\n>[!tip] Thoughts while consuming content - As Input to ideas\n";
