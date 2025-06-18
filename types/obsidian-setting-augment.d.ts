import 'obsidian';

declare module 'obsidian' {
  interface Setting {
    /** Marks this row as a section heading (no toggle, larger font). */
    setHeading(): this;
    /** The main DOM element for this setting */
    settingEl: HTMLElement & {
      addClass(...classes: string[]): void;
      removeClass(...classes: string[]): void;
      toggleClass(className: string, force?: boolean): void;
    };
  }
}