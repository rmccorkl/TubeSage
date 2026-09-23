# TERMS — the never-translate glossary

Mirrors the `terms.txt` convention of [obsidian-translations](https://github.com/obsidianmd/obsidian-translations).
Every name below is a product, company or protocol identifier. It must appear
**verbatim** in every locale — translating it produces a string that names
nothing a user can find.

`npm run i18n:check` enforces this: for each term, if the English string
contains it, the translation must contain it too. The match ignores case, so a
locale may follow its own capitalisation conventions around the term, but it
may not replace the term itself.

| Term | What it is |
|---|---|
| TubeSage | This plugin. Some existing UI strings spell it `Tubesage`; either spelling is the name, neither is translated. |
| Obsidian | The host application. |
| YouTube | The video service transcripts are taken from. |
| ScrapeCreators | Transcript service. Appears in UI text as `Scrape creators` / `scrapecreators`. |
| Supadata | Transcript service. Appears in UI text as `Supa data` / `supadata`. |
| Ollama | Local model runner. Also a provider name in the model dropdown. |
| Templater | The Obsidian community plugin whose templates TubeSage applies. |
| OpenRouter | Model routing provider. The internal capital R is intentional. |
| OpenAI | Model provider. |
| Anthropic | Model provider. |
| Google | Model provider. |
| Gemini | Google's model family. |
| README | The plugin's documentation file, opened from the settings tab. |
| Buy Me A Coffee | The donation service the support button links to. |

## Not in the matrix at all

Some user-visible text is deliberately **not** extracted to a key, because
translating it would be wrong rather than merely unnecessary. These stay as
literals in the source:

- **Provider names in the model dropdown** — `OpenAI`, `Anthropic`, `Google`,
  `Ollama`, `OpenRouter`. Glossary terms standing alone; a key would only
  create 51 rows that must all be copied identically.
- **Model identifiers** — `gpt-4o`, `claude-sonnet-4-0`, `gemini-2.5-flash`, …
  These are API values.
- **Credential and address formats** — `sk-...`, `sk-ant-...`, `AIza...`,
  `sk-or-v1-...`, `http://localhost:11434`.
- **Date format labels** — `Yyyy-mm-dd`, `Mm-dd-yyyy`, `Dd-mm-yyyy`. These
  display the literal pattern tokens of the value they set; a translated token
  would describe a format the plugin does not accept.
- **Example values that mirror a real default** — the `Inbox` placeholder (the
  default transcript root folder), the `US` placeholder (the default translate
  country), and `templates/YouTubeTranscript.md` (an example vault path).
- **The MIT licence body.** Read from the shipped licence file and rendered as
  it stands. A translated licence is not the licence; only the dialog's own
  chrome — title, error text, buttons — is translated.

## Working in the matrix

`i18n/strings.csv` is the authoring matrix and the only file a translator
edits: `key`, `context`, `en`, then one column per language.

- `context` says what the string is and where it appears. It is mandatory
  wherever the English is ambiguous out of context — `Fast` as a summary mode
  is not `Fast` as a speed, and the two take different German words.
- `{name}` placeholders are substituted at runtime. Keep every placeholder that
  the English row has, and put it where the target language wants it. Never
  build a sentence by joining fragments: the space in `${a} ${b}` is wrong in
  Japanese and Chinese, and the order is wrong in many more languages.
- Keep it short. CJK glyphs are full width and German compounds are long;
  settings descriptions that just fit in English will overflow.
- Do not case-transform outside Latin script. Sentence case is a Latin-script
  rule and does not exist in Chinese, Japanese or Korean.

Then run:

```bash
npm run i18n:build   # matrix -> src/locales/*.json
npm run i18n:check   # the gate
```
