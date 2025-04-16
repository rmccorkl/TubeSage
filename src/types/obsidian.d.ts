declare module 'obsidian' {
    export class App {
        plugins: any;
        vault: any;
    }
    export class Plugin {
        app: App;
        loadData(): Promise<any>;
        saveData(data: any): Promise<void>;
        addSettingTab(tab: any): void;
        addRibbonIcon(icon: string, title: string, callback: () => void): void;
        addCommand(command: { id: string; name: string; callback: () => void }): void;
    }
    export class PluginSettingTab {
        app: App;
        plugin: Plugin;
        containerEl: HTMLElement;
        constructor(app: App, plugin: Plugin);
        display(): void;
    }
    export class Setting {
        constructor(containerEl: HTMLElement);
        setName(name: string): this;
        setDesc(desc: string): this;
        addText(callback: (text: { 
            setPlaceholder(placeholder: string): any;
            setValue(value: string): any;
            onChange(callback: (value: string) => any): any;
        }) => any): this;
        addDropdown(callback: (dropdown: {
            addOption(value: string, display: string): any;
            setValue(value: string): any;
            onChange(callback: (value: string) => any): any;
        }) => any): this;
        addSlider(callback: (slider: {
            setLimits(min: number, max: number, step: number): any;
            setValue(value: number): any;
            setDynamicTooltip(): any;
            onChange(callback: (value: number) => any): any;
        }) => any): this;
        addTextArea(callback: (text: {
            setPlaceholder(placeholder: string): any;
            setValue(value: string): any;
            onChange(callback: (value: string) => any): any;
        }) => any): this;
        addExtraButton(callback: (button: {
            setIcon(icon: string): any;
            setTooltip(tooltip: string): any;
            onClick(callback: () => any): any;
        }) => any): this;
    }
    export class Notice {
        constructor(message: string);
    }
    export class Modal {
        app: App;
        contentEl: HTMLElement;
        constructor(app: App);
        open(): void;
        close(): void;
        onOpen(): void;
        onClose(): void;
    }

    // Extend HTMLElement with Obsidian's custom methods
    interface HTMLElement {
        empty(): void;
        createEl<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, any>): HTMLElementTagNameMap[K];
        createEl(tag: string, attrs?: Record<string, any>): HTMLElement;
    }

    // Add requestUrl function
    export function requestUrl(url: string): Promise<{
        status: number;
        text: string;
    }>;
} 