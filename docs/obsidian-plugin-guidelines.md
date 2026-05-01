# Comprehensive Obsidian Plugin Development Guidelines

*Retrieved from Obsidian Developer Documentation via Context7*

## Core Development Principles

### 1. App Instance Management

**NEVER use the global app object:**
```typescript
// ❌ Bad - Avoid global app
const globalApp = app;

// ✅ Good - Use plugin instance
class MyPlugin extends Plugin {
  onload() {
    this.app.vault.read("path/to/file.md");
  }
}
```

### 2. Resource Management

**Always clean up resources on unload:**
```typescript
export default class MyPlugin extends Plugin {
  onload() {
    // Use registerEvent for automatic cleanup
    this.registerEvent(this.app.vault.on('create', this.onCreate));
  }

  onCreate: (file: TAbstractFile) => {
    // Handle file creation
  }
}
```

### 3. Security Best Practices

**Never use innerHTML for user input:**
```typescript
// ❌ Vulnerable to XSS
function showNameUnsafe(name: string) {
  let containerElement = document.querySelector('.my-container');
  containerElement.innerHTML = `<div class="my-class"><b>Your name is: </b>${name}</div>`;
}

// ✅ Safe DOM construction
function showNameSecure(name: string) {
  let containerElement = document.querySelector('.my-container');
  if (containerElement) {
    containerElement.empty();
    const div = containerElement.createDiv({ cls: "my-class" });
    div.createEl("b", { text: "Your name is: " });
    div.createSpan({ text: name });
  }
}
```

## File System Operations

### Prefer Vault API Over Adapter API

```typescript
// ✅ Good - Use Vault API
this.app.vault.create('path/to/new-file.md', 'content');
this.app.vault.read(file);

// ❌ Bad - Direct Adapter API
this.app.vault.adapter.write('path/to/file', 'content');
```

### Optimize File Access

```typescript
// ❌ Inefficient - Don't iterate all files
this.app.vault.getFiles().find(file => file.path === filePath);

// ✅ Efficient - Direct access
const file = this.app.vault.getFileByPath(filePath);
const folder = this.app.vault.getFolderByPath(folderPath);
const abstractFile = this.app.vault.getAbstractFileByPath(filePath);

// Type checking
if (file instanceof TFile) {
  // it's a file
}
if (file instanceof TFolder) {
  // it's a folder
}
```

### Handle Frontmatter Properly

```typescript
// ✅ Use FileManager.processFrontMatter
// Atomic operation, avoids conflicts with other plugins
await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
  frontmatter.title = 'New Title';
});
```

### File Editing Best Practices

```typescript
// ✅ For active files - Use Editor API (preserves cursor position)
const editor = this.app.workspace.activeEditor?.editor;
if (editor) {
  editor.replaceRange('new text', { line: 0, ch: 0 });
}

// ✅ For background files - Use Vault.process (atomic)
await this.app.vault.process(file, (content) => {
  return content.replace(/old/g, 'new');
});
```

## Network Operations

### Use Obsidian's requestUrl

```typescript
// ✅ Good - Cross-platform compatible
import { requestUrl } from 'obsidian';

async function fetchData(url: string) {
  try {
    const response = await requestUrl(url);
    console.log(response.json);
  } catch (error) {
    console.error('Request failed:', error);
  }
}

// ❌ Bad - Won't work on mobile
// fetch(url).then(...)
// axios.get(url).then(...)
```

## Path Handling

### Always Normalize User Paths

```typescript
import { normalizePath } from 'obsidian';

// ✅ Safe path handling
const pathToPlugin = normalizePath('//my-folder\\file');
// Result: "my-folder/file" not "//my-folder\"
```

## Async Operations

### Use async/await Over Promises

```typescript
// ❌ Hard to read Promise chains
function test(): Promise<string | null> {
  return requestUrl('https://example.com')
    .then(res => res.text)
    .catch(e => {
      console.log(e);
      return null;
    });
}

// ✅ Clean async/await
async function AsyncTest(): Promise<string | null> {
  try {
    let res = await requestUrl('https://example.com');
    let text = await res.text;
    return text;
  } catch (e) {
    console.log(e);
    return null;
  }
}
```

## Workspace and View Management

### Access Views Safely

```typescript
// ✅ Safe view access
const view = this.app.workspace.getActiveViewOfType(MarkdownView);
if (view) {
  // Work with view
}

const editor = this.app.workspace.activeEditor?.editor;
if (editor) {
  // Work with editor
}
```

### Handle Custom Views Properly

```typescript
// ❌ Bad - Storing view references
this.registerView(MY_VIEW_TYPE, () => this.view = new MyCustomView());

// ✅ Good - Factory function
this.registerView(MY_VIEW_TYPE, () => new MyCustomView());

// ✅ Access views when needed
for (let leaf of app.workspace.getActiveLeavesOfType(MY_VIEW_TYPE)) {
  let view = leaf.view;
  if (view instanceof MyCustomView) {
    // Work with view
  }
}
```

### Handle Deferred Views (Obsidian 1.7.2+)

```typescript
// ✅ Good - Safe instanceof check
workspace.iterateAllLeaves(leaf => {
    if (leaf.view instanceof MyCustomView) {
        // View is fully loaded
    }
});

// ❌ Bad - Unsafe type assertion
workspace.iterateAllLeaves(leaf => {
    if (leaf.view.getViewType() === 'my-view') {
        let view = leaf.view as MyCustomView; // Dangerous!
    }
});
```

## Plugin Data Management

### Use Plugin Data Methods

```typescript
// ✅ Good - Use built-in methods
export default class MyPlugin extends Plugin {
  async onload() {
    const myData = await this.loadData();
    if (myData) {
      console.log('Loaded data:', myData);
    }
  }

  async saveMyData(data: any) {
    await this.saveData(data);
  }
}

// ❌ Bad - Manual file management
// fs.writeFileSync(this.manifest.dir + '/data.json', JSON.stringify(data));
```

## Settings and UI

### Use Proper Setting Creation

```typescript
// ✅ Good - Use setHeading() API
new Setting(containerEl).setName('Your Heading Title').setHeading();

// ❌ Bad - Direct HTML
// containerEl.innerHTML = '<h1>Your Heading Title</h1>';
```

### Command Registration Best Practices

```typescript
// ❌ Bad - Redundant plugin name
this.addCommand({
  id: 'my-plugin-do-something',
  name: 'My Plugin: Do Something',
  callback: () => { /* ... */ }
});

// ✅ Good - Clean naming
this.addCommand({
  id: 'do-something',
  name: 'Do Something',
  callback: () => { /* ... */ }
});
```

### Avoid Default Hotkeys

```typescript
// ❌ Bad - Setting default hotkeys causes conflicts
this.addCommand({
  id: 'my-command',
  name: 'My Command',
  hotkeys: [{ modifiers: ['Ctrl'], key: 'k' }], // Don't do this
  callback: () => {}
});

// ✅ Good - Let users set their own hotkeys
this.addCommand({
  id: 'my-command',
  name: 'My Command',
  callback: () => {}
});
```

## Editor Extensions

### Update Extensions Dynamically

```typescript
class MyPlugin extends Plugin {
  private editorExtension: Extension[] = [];

  onload() {
    this.registerEditorExtension(this.editorExtension);
  }

  updateEditorExtension() {
    // Empty array while keeping same reference
    this.editorExtension.length = 0;
    
    // Add new extension
    let myNewExtension = this.createEditorExtension();
    this.editorExtension.push(myNewExtension);
    
    // Flush changes to all editors
    this.app.workspace.updateOptions();
  }
}
```

## Platform Detection

### Use Obsidian's Platform API

```typescript
import { Platform } from 'obsidian';

// ✅ Good - Cross-platform compatible
if (Platform.isMobile) {
  console.log('Running on mobile');
}

if (Platform.isIosApp) {
  // iOS-specific code
}

if (Platform.isAndroidApp) {
  // Android-specific code
}

// ❌ Bad - Node.js specific
// if (process.platform === 'darwin') {
//   console.log('Running on macOS');
// }
```

## Performance Optimization

### Optimize Plugin Load Time

```typescript
// ✅ Defer non-critical setup
class MyPlugin extends Plugin {
    onload() {
        // Critical setup only
        this.app.workspace.onLayoutReady(() => {
            // Defer heavy operations
            this.registerEvent(this.app.vault.on('create', this.onCreate));
        });
    }

    onCreate() {
        if (!this.app.workspace.layoutReady) {
            return; // Skip during initial load
        }
        // Handle file creation
    }
}
```

## Modern JavaScript Practices

### Use Modern Variable Declarations

```typescript
// ✅ Good - Modern JavaScript
let count = 0;
const MAX_COUNT = 10;

// ❌ Bad - Avoid var
// var oldVar = 'value';
```

### Avoid Global Variables

```typescript
// ✅ Good - Encapsulated scope
class MyClass {
  private myVariable: string = 'local';
  constructor() {
    console.log(this.myVariable);
  }
}

// ❌ Bad - Global variables
// let globalVar = 'global';
```

### Strong TypeScript Typing

```typescript
// ✅ Good - Proper typing
interface MyData { id: number; name: string; }
const data: MyData = { id: 1, name: 'Example' };

// ❌ Bad - Using 'as any'
// const data: any = { id: 1, name: 'Example' };
// const id = (data as any).id;
```

## Dependencies

### Import from Obsidian When Available

```typescript
// ✅ Good - Use Obsidian's bundled libraries
import { moment } from 'obsidian';

// ❌ Bad - Bundling your own copy
// import moment from 'moment';
```

## CSS Styling Guidelines

### Use CSS Classes, Not Inline Styles

```typescript
// ❌ Bad - Inline styles via JavaScript
const el = containerEl.createDiv();
el.style.color = 'white';
el.style.backgroundColor = 'red';
el.style.display = 'none'; // Avoid this pattern

// ✅ Good - CSS classes for styling and visibility
const el = containerEl.createDiv({cls: 'warning-container hidden'});

// ✅ Good - Dynamic class toggling instead of style assignments
if (shouldHide) {
    el.addClass('hidden');
} else {
    el.removeClass('hidden');
}
```

```css
/* styles.css */
.warning-container {
	color: var(--text-normal);
	background-color: var(--background-modifier-error);
}
```

### Scope Your CSS

```css
/* ❌ Bad - Overriding core styles */
.some-obsidian-core-class {
  color: red;
}

/* ✅ Good - Scoped to plugin */
.my-plugin-container .some-element {
  color: blue;
}
```

## Plugin Release Guidelines

### Required Files

Your repository must contain:
- `README.md` - Plugin description and usage
- `LICENSE` - Usage terms and conditions  
- `manifest.json` - Plugin metadata

### Manifest.json Structure

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "minAppVersion": "0.15.0",
  "description": "A description of my plugin.",
  "author": "Your Name",
  "authorUrl": "https://yourwebsite.com",
  "fundingUrl": "https://ko-fi.com/yourname",
  "isDesktopOnly": false
}
```

### Version Management

```json
// manifest.json
{
  "version": "1.0.0",
  "minAppVersion": "1.2.0"
}
```

```json
// versions.json (optional fallbacks)
{
  "0.1.0": "1.0.0",
  "0.12.0": "1.1.0"
}
```

### GitHub Actions Release

```yaml
name: Release Obsidian plugin

on:
  push:
    tags:
      - "*"

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v3

      - name: Use Node.js
        uses: actions/setup-node@v3
        with:
          node-version: "18.x"

      - name: Build plugin
        run: |
          npm install
          npm run build

      - name: Create release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"

          gh release create "$tag" \
            --title="$tag" \
            --draft \
            main.js manifest.json styles.css
```

## Common Anti-Patterns to Avoid

### ❌ Things to Avoid

1. **Don't use global app object**
2. **Don't include 'Obsidian' in plugin name** (unless essential)
3. **Don't use innerHTML with user input** (XSS vulnerability)
4. **Don't set default hotkeys** (causes conflicts)
5. **Don't use deprecated methods** (check for strikethrough in IDE)
6. **Don't detach leaves in onunload** (breaks user layout)
7. **Don't manage view references** (causes memory leaks)
8. **Don't use Node.js APIs on mobile**
9. **Don't include main.js in repository** (only in releases)
10. **Don't leave console.log statements** (unless necessary)
11. **Don't use placeholder names** (MyPlugin, SampleSettingTab)
12. **Don't override core CSS classes**
13. **Don't use `!important` in CSS**
14. **Don't use `:has()` CSS selector** (performance issues)
15. **Don't manually manage plugin data files**

## Plugin Development Checklist

### Before Release

- [ ] Replace all placeholder names
- [ ] Remove unnecessary console.log statements
- [ ] Scan for deprecated methods
- [ ] Optimize plugin load time
- [ ] Test on mobile (if not desktop-only)
- [ ] Ensure CSS is scoped to plugin
- [ ] Use strong TypeScript typing
- [ ] Add funding URL to manifest
- [ ] Minimize main.js file
- [ ] Test with DeferredViews (Obsidian 1.7.2+)
- [ ] Use proper heading methods in settings
- [ ] Avoid setting default hotkeys
- [ ] Clean up resources on unload
- [ ] Use Vault API over Adapter API
- [ ] Handle paths with normalizePath()
- [ ] Use requestUrl for network requests

### Repository Structure

```
my-plugin/
├── README.md
├── LICENSE
├── manifest.json
├── main.ts
├── styles.css
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
└── .gitignore (exclude main.js)
```

This comprehensive guide covers all essential aspects of Obsidian plugin development, from basic setup to advanced performance optimization and security considerations. Following these guidelines ensures your plugin is robust, secure, and compatible with Obsidian's ecosystem.