import { describe, expect, it, vi } from "vitest";
import { CollectionNotices } from "./collection-notice";
import { planCollection } from "../jobs/collection-record";
import type { NoteJobRecord } from "../jobs/job-record";

const child = (id: string, status: NoteJobRecord["status"]) => ({ id, status }) as NoteJobRecord;

const setup = (n = 3) => {
  const messages: string[] = [];
  const hidden = { count: 0 };
  const handle = {
    setMessage: (m: string) => { messages.push(m); return undefined; },
    hide: () => { hidden.count += 1; },
  };
  // The factory receives the FIRST message (that is `ProgressNoticeFactory`'s
  // contract), so the opening text must be captured here, not from setMessage.
  const create = vi.fn((initial: string) => { messages.push(initial); return handle; });
  const parent = {
    ...planCollection({
      url: "u", folder: "f", sourceName: "Stuff", contentType: "Playlist",
      installationId: "i", createdAt: 0, id: "p", plannedCount: n,
    }),
    childIds: Array.from({ length: n }, (_, i) => `c${i + 1}`),
  };
  // `text` is injected so this module needs no i18n table under test.
  const notices = new CollectionNotices(create, (p) => `${p.done}/${p.total}`);
  return { notices, parent, messages, hidden, create };
};

describe("CollectionNotices — ONE notice per collection, not one per video", () => {
  it("creates exactly one notice however many children report", () => {
    const { notices, parent, create } = setup(3);
    notices.start(parent, []);
    notices.update(parent, [child("c1", "done")]);
    notices.update(parent, [child("c1", "done"), child("c2", "done")]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rewrites the one notice as children finish, rather than stacking", () => {
    const { notices, parent, messages } = setup(3);
    notices.start(parent, []);
    notices.update(parent, [child("c1", "done")]);
    notices.update(parent, [child("c1", "done"), child("c2", "done")]);
    expect(messages).toEqual(["0/3", "1/3", "2/3"]);
  });

  // Ownership of child ids moved to CollectionRunner: a run's `childIds` is
  // empty when its notice opens and fills as `submit()` returns ids, so a
  // notice that captured them at `start()` owned nothing. See
  // collection-runner.test.ts, "owns its children while the run is live".

  it("hides the notice exactly once when the run ends", () => {
    const { notices, parent, hidden } = setup(1);
    notices.start(parent, []);
    notices.finish(parent, [child("c1", "done")], "done");
    notices.finish(parent, [child("c1", "done")], "done");
    expect(hidden.count).toBe(1);
  });

  it("is safe to update after finishing, so a late child event cannot resurrect the notice", () => {
    // A child left running by cancel still reports when it lands. That must not
    // reopen a notice for a run the user already ended.
    const { notices, parent, create, hidden } = setup(2);
    notices.start(parent, []);
    notices.finish(parent, [child("c1", "done")], "cancelled");
    notices.update(parent, [child("c1", "done"), child("c2", "done")]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(hidden.count).toBe(1);
  });
});

describe("dismissAll — unload must leave no surface behind", () => {
  it("hides a live run's notice", () => {
    const { notices, parent, hidden } = setup(3);
    notices.start(parent, []);
    notices.dismissAll();
    expect(hidden.count).toBe(1);
  });

  it("says nothing on the way out", () => {
    // `finish` narrates a final count because the run ended. Unload is not an
    // outcome: the persisted collection is untouched and the next cold start
    // closes it, so writing a last message here would report a result that
    // never happened.
    const { notices, parent, messages } = setup(3);
    notices.start(parent, []);
    notices.dismissAll();
    expect(messages).toEqual(["0/3"]);
  });

  it("is idempotent, and leaves nothing for a second pass to hide", () => {
    const { notices, parent, hidden } = setup(3);
    notices.start(parent, []);
    notices.dismissAll();
    notices.dismissAll();
    expect(hidden.count).toBe(1);
  });

  it("is a no-op when no run was live", () => {
    const { notices, hidden, create } = setup(3);
    notices.dismissAll();
    expect(hidden.count).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("stops a straggling event reopening a surface nothing drives", () => {
    // The child left executing still reports when it lands, and after unload
    // there is no plugin behind the surface it would reopen.
    const { notices, parent, create, hidden } = setup(2);
    notices.start(parent, []);
    notices.dismissAll();
    notices.update(parent, [child("c1", "done")]);
    notices.start(parent, [child("c1", "done")]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(hidden.count).toBe(1);
  });

  it("does not double-hide when finish follows dismissAll", () => {
    const { notices, parent, hidden } = setup(2);
    notices.start(parent, []);
    notices.dismissAll();
    notices.finish(parent, [child("c1", "done")], "closed");
    expect(hidden.count).toBe(1);
  });
});
