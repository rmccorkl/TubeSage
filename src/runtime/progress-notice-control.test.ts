import { describe, expect, it, vi } from "vitest";
import { renderProgressNotice } from "./progress-notice-control";
import type { NoticeElementLike } from "./progress-notice-control";

/**
 * A DOM double. No jsdom is installed and none is added for this: the module is
 * written against a small element interface precisely so its behaviour is
 * testable without one, matching how the rest of `src/runtime` injects what it
 * needs. What it MUST model faithfully is event ordering, because that is the
 * whole question for the stop control.
 */
class FakeEl implements NoticeElementLike {
  readonly children: FakeEl[] = [];
  text = "";
  readonly classes: string[] = [];
  readonly listeners = new Map<string, ((ev: FakeEvent) => void)[]>();
  constructor(readonly cls = "", readonly parent?: FakeEl) {
    if (cls) this.classes.push(cls);
  }
  createDiv(o: { cls: string }): NoticeElementLike { const c = new FakeEl(o.cls, this); this.children.push(c); return c; }
  createSpan(o: { cls: string; text?: string }): NoticeElementLike {
    const c = new FakeEl(o.cls, this); c.text = o.text ?? ""; this.children.push(c); return c;
  }
  setText(text: string): void { this.text = text; }
  setAttr(): void { /* aria bookkeeping; not asserted here */ }
  addEventListener(type: string, handler: (ev: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  empty(): void { this.children.length = 0; this.text = ""; }

  /** Every string rendered anywhere in this subtree. */
  allText(): string {
    return [this.text, ...this.children.map((c) => c.allText())].join(" ");
  }

  find(cls: string): FakeEl | undefined {
    if (this.classes.includes(cls)) return this;
    for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
    return undefined;
  }
  /** Dispatch bubbling from this element up through its ancestors, honouring stopPropagation. */
  dispatch(type: string, key?: string): FakeEvent {
    const ev = new FakeEvent(type, key);
    this.bubble(ev);
    return ev;
  }

  /** Recursive rather than a `let node = this` walk, which aliases `this`. */
  private bubble(ev: FakeEvent): void {
    for (const h of this.listeners.get(ev.type) ?? []) h(ev);
    if (!ev.propagationStopped) this.parent?.bubble(ev);
  }
}
class FakeEvent {
  propagationStopped = false;
  constructor(readonly type: string, readonly key?: string) {}
  stopPropagation(): void { this.propagationStopped = true; }
  preventDefault(): void { /* not asserted */ }
}

const setup = (stage = "Adding timestamps") => {
  const onStop = vi.fn();
  // The notice element Obsidian owns: its own click handler is what dismisses.
  const notice = new FakeEl("notice");
  let dismissed = 0;
  notice.addEventListener("click", () => { dismissed += 1; });
  const message = notice.createDiv({ cls: "notice-message" }) as FakeEl;
  renderProgressNotice(message, { stage, hint: "Tap to cancel", onStop });
  return { notice, message, onStop, dismissed: () => dismissed };
};

describe("renderProgressNotice — the control lives IN the notice", () => {
  it("shows the stage on its own, with no instruction to go elsewhere", () => {
    const { message } = setup();
    const label = message.find("tubesage-notice-stage");
    expect(label?.text).toBe("Adding timestamps");
    // The old text told the user to find a command-palette entry. (Walked,
    // not JSON.stringify'd: the double has parent back-references.)
    expect(message.allText()).not.toContain("Show active jobs");
  });

  it("renders the tap hint, so the gesture is stated rather than guessed at", () => {
    const { message } = setup();
    expect(message.find("tubesage-notice-hint")?.text).toBe("Tap to cancel");
  });

  it("renders a liveness indicator", () => {
    const { message } = setup();
    expect(message.find("tubesage-notice-pulse")).toBeDefined();
  });
});

describe("tapping the control acts instead of merely dismissing", () => {
  it("cancels when the stop control is tapped", () => {
    const { message, onStop } = setup();
    message.dispatch("click");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stops the click reaching the notice's own dismiss handler", () => {
    // The defect this closes: Obsidian dismisses a Notice on tap, so without
    // interception the natural gesture destroys the message instead of acting.
    const { message, dismissed } = setup();
    message.dispatch("click");
    expect(dismissed()).toBe(0);
  });

  it("also acts on pointerdown, which fires before any click-based dismiss", () => {
    // Belt and braces: a bubble-phase listener on a descendant always precedes
    // an ancestor's, but a CAPTURE-phase dismiss would run first. pointerdown
    // fires strictly before click either way, so the cancel is never lost —
    // only the notice's persistence would be.
    const { message, onStop } = setup();
    message.dispatch("pointerdown");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does not fire twice when pointerdown is followed by click", () => {
    const { message, onStop } = setup();
    message.dispatch("pointerdown");
    message.dispatch("click");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("cancels from anywhere on the notice, not just one small target", () => {
    // The maintainer's point: a separate Stop button inside a notice that also
    // dismisses on tap is two targets where one will do. Tapping any part of
    // the notice now cancels instead of dismissing.
    const { message, onStop, dismissed } = setup();
    message.find("tubesage-notice-stage")?.dispatch("click");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(dismissed()).toBe(0);
  });
});

describe("a repaint rebinds the control without stacking another one on it", () => {
  // THE DEFECT THIS LOCKS: the contents are redrawn on every progress event,
  // and `empty()` clears an element's CHILDREN, never its own listeners. When
  // the listeners were attached per render, a job that reported five stages
  // carried five sets, and one tap called `onStop` five times. `JobRunner`
  // happens to absorb the extra calls (the record is terminal after the first),
  // so nothing visibly broke — which is exactly why it would have sat there.
  const repaint = (times: number) => {
    const onStop = vi.fn();
    const notice = new FakeEl("notice");
    const message = notice.createDiv({ cls: "notice-message" }) as FakeEl;
    for (let i = 0; i < times; i += 1) {
      renderProgressNotice(message, { stage: `stage ${i}`, hint: "Tap to cancel", onStop });
    }
    return { message, onStop };
  };

  it("cancels once per tap however many stages the job reported", () => {
    const { message, onStop } = repaint(5);
    message.dispatch("pointerdown");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps exactly one handler of each kind on the element", () => {
    const { message } = repaint(5);
    expect(message.listeners.get("pointerdown")).toHaveLength(1);
    expect(message.listeners.get("click")).toHaveLength(1);
    expect(message.listeners.get("keydown")).toHaveLength(1);
  });

  it("acts on the LATEST content, so the action follows the repaint", () => {
    // The reason the control is repainted at all: a job's stage advances, and a
    // collection's notice is rewritten as items land. Whatever `onStop` the most
    // recent render supplied is the one a tap must call.
    const stale = vi.fn();
    const fresh = vi.fn();
    const notice = new FakeEl("notice");
    const message = notice.createDiv({ cls: "notice-message" }) as FakeEl;
    renderProgressNotice(message, { stage: "Fetching transcript", hint: "h", onStop: stale });
    renderProgressNotice(message, { stage: "Summarizing transcript", hint: "h", onStop: fresh });
    message.dispatch("click");
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("still shows the newest stage after a repaint", () => {
    const { message } = repaint(3);
    expect(message.find("tubesage-notice-stage")?.text).toBe("stage 2");
  });
});

describe("the keyboard can activate what role=\"button\" advertises", () => {
  // A div with role="button" gets NO synthesised click from the keyboard — that
  // is a real <button> only — so without an explicit handler the element
  // promised a control no keyboard or switch-control user could reach.
  it("cancels on Enter", () => {
    const { message, onStop } = setup();
    message.dispatch("keydown", "Enter");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("cancels on Space, which arrives as a single space", () => {
    const { message, onStop } = setup();
    message.dispatch("keydown", " ");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores every other key, so typing near it cannot cancel a job", () => {
    const { message, onStop } = setup();
    const events = ["a", "Escape", "Tab", "ArrowDown"].map((key) => message.dispatch("keydown", key));
    expect(onStop).not.toHaveBeenCalled();
    // ...and an ignored key is not swallowed either: `act` is what calls
    // stopPropagation, so a key it declines still reaches the rest of the app.
    expect(events.map((ev) => ev.propagationStopped)).toEqual([false, false, false, false]);
  });

  it("does not cancel twice when a held key repeats", () => {
    const { message, onStop } = setup();
    message.dispatch("keydown", "Enter");
    message.dispatch("keydown", "Enter");
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
