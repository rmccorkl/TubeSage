// The contents of a job's floating progress notice on MOBILE: a liveness
// pulse, the stage, and a hint — with the WHOLE NOTICE as the cancel control.
//
// It first read `<stage> — cancel from "Show active jobs"`, naming a
// command-palette entry with no ribbon icon: awkward on a phone, and an
// Obsidian Notice dismisses on tap, so the natural gesture destroyed the
// message instead of acting on it. A separate Stop button fixed the action but
// left two targets — the button, and the rest of the notice, which still
// dismissed — where one will do. So the notice itself is the control: tapping
// anywhere on it cancels. Obsidian draws no close control on a Notice — its
// constructor builds `notice-message` inside `notice` and nothing else, and
// `notice-close` appears nowhere in the app (read from the 1.12.7 bundle) — so
// while a job runs, the only ways to clear this one WITHOUT cancelling are the
// phone swipe-to-dismiss Obsidian registers itself and letting the job finish.
//
// WHAT A TAP ACTUALLY DOES. It differs by surface, and the difference is
// spelled out rather than summarised because the kinder of the two must not be
// mistaken for a guarantee the other gives:
//
//   single video — `JobRunner.cancel` bumps the record's generation, so the run
//     loop's next guard fails and NO note is written. An LLM call already in
//     flight cannot be aborted, so a tap during summarising still pays for that
//     call and then discards its result: the user is billed and left with
//     nothing.
//
//   collection — `CollectionRunner.cancel` stops SCHEDULING only. The child
//     actually executing is left alone and lands with its note (`planCancel`,
//     jobs/collection-policy.ts); what gets cancelled is the work that never
//     started, which was never billed.
//
// "Tap to cancel" is therefore honest on both surfaces — a tap does cancel —
// but it is not a promise that paid work survives, and nothing here should be
// written as though it were.
//
// NO OBSIDIAN IMPORT, and no `document`. The element is passed in behind the
// small interface below, which Obsidian's `HTMLElement` satisfies structurally
// (its DOM extensions provide `createDiv`/`createSpan`/`setText`/`empty`).
// That is what lets the event behaviour — the whole risk here — be tested
// without a DOM library.

/** What this module needs of an element; Obsidian's `HTMLElement` satisfies it. */
export interface NoticeElementLike {
  createDiv(options: { cls: string }): NoticeElementLike;
  createSpan(options: { cls: string; text?: string }): NoticeElementLike;
  setText(text: string): void;
  setAttr(name: string, value: string): void;
  addEventListener(type: string, handler: (ev: NoticeEventLike) => void): void;
  empty(): void;
}

/** The parts of a DOM event this module uses. */
export interface NoticeEventLike {
  stopPropagation(): void;
  preventDefault(): void;
  /** Present on a keyboard event only; a pointer event satisfies this by omission. */
  key?: string;
}

export interface ProgressNoticeContent {
  /** The already-translated stage label. */
  stage: string;
  /** The already-translated hint telling the user a tap cancels. */
  hint: string;
  /** Cancels the job or run this notice belongs to. */
  onStop: () => void;
}

/**
 * The content each element's handlers should act on RIGHT NOW.
 *
 * The contents are redrawn on every progress event, but the listeners are
 * attached once per element and read the current content from here. Attaching
 * them per render instead accumulated a set per repaint — `empty()` clears an
 * element's children, never its own listeners — so a five-stage job ended up
 * calling `onStop` five times for one tap. Keyed weakly: an entry dies with the
 * notice element it belongs to.
 */
const current = new WeakMap<NoticeElementLike, ProgressNoticeContent>();

/** Class names; also the CSS contract in styles.css. */
const CLS = {
  body: "tubesage-notice-body",
  pulse: "tubesage-notice-pulse",
  stage: "tubesage-notice-stage",
  hint: "tubesage-notice-hint",
} as const;

/**
 * Fill `el` with the notice's contents and make the whole of it cancel.
 *
 * Both `pointerdown` and `click` are handled, and both call
 * `stopPropagation()`:
 *
 * - `click` + `stopPropagation` is what keeps Obsidian's dismiss from firing,
 *   so a tap cancels rather than merely closing the message. A bubble-phase
 *   listener on a descendant always runs before an ancestor's, so this holds
 *   against any ordinary (non-capture) dismiss handler.
 * - `pointerdown` is the belt to that braces. It fires strictly before `click`,
 *   so even if a dismiss handler were registered in the CAPTURE phase — the one
 *   arrangement `stopPropagation` on click cannot beat — the cancel has already
 *   happened. Only the notice's persistence would be lost, never the action.
 *
 * - `keydown` on Enter or Space is what makes the `role="button"` set below
 *   true. A div carrying that role gets no synthesised click from the keyboard,
 *   so without an explicit handler the element would advertise a control that a
 *   keyboard or switch-control user cannot activate. (VoiceOver activation
 *   arrives as a click and is already covered.)
 *
 * `fired` makes them idempotent: a real tap delivers pointerdown AND click, a
 * held key repeats, and cancelling twice must not be the price of being robust.
 * It spans the ELEMENT's life rather than one render, which is the right scope:
 * an element is one notice is one job, and that job is cancelled once.
 */
export function renderProgressNotice(el: NoticeElementLike, content: ProgressNoticeContent): void {
  el.empty();
  const body = el.createDiv({ cls: CLS.body });
  // Decorative: the animation is the liveness cue, so it carries no text and is
  // hidden from assistive technology, which gets the stage and hint instead.
  const pulse = body.createSpan({ cls: CLS.pulse });
  pulse.setAttr("aria-hidden", "true");
  body.createSpan({ cls: CLS.stage, text: content.stage });
  body.createSpan({ cls: CLS.hint, text: content.hint });

  // The tap target is the notice, not a button inside it.
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  el.setAttr("aria-label", `${content.stage} — ${content.hint}`);

  // The handlers read `current`, so a repaint rebinds the action without
  // attaching a second set of listeners to the same element.
  const alreadyBound = current.has(el);
  current.set(el, content);
  if (alreadyBound) return;

  let fired = false;
  const act = (ev: NoticeEventLike): void => {
    ev.stopPropagation();
    ev.preventDefault();
    if (fired) return;
    fired = true;
    current.get(el)?.onStop();
  };
  el.addEventListener("pointerdown", act);
  el.addEventListener("click", act);
  // Space arrives as " ". `preventDefault` on it also stops the page scrolling.
  el.addEventListener("keydown", (ev: NoticeEventLike): void => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    act(ev);
  });
}
