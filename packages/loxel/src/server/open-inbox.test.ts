import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type InboxMessage, OpenInbox, deliveredNotices, sweepOrphans } from "./open-inbox";

const HOUR = 60 * 60_000;

const terminal = (terminalId: string, title?: string): InboxMessage => ({
  type: "open_terminal",
  data: { terminalId, cwd: "/wt", worktreePath: "/wt", ...(title ? { title } : {}), focus: false },
});
const file = (filePath: string): InboxMessage => ({ type: "open_file", data: { filePath } });
const page = (url: string): InboxMessage => ({ type: "open_url", wtPath: "/wt", data: { url } });

describe("OpenInbox", () => {
  let dir: string;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loxel-inbox-"));
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps its requests, oldest first, until each one's panel is placed", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(file("/wt/a.ts"), "/wt");
    inbox.add(terminal("t1"), "/wt");

    const [first, second] = inbox.list();
    expect([first?.message, second?.message]).toEqual([file("/wt/a.ts"), terminal("t1")]);
    inbox.handTo([first!.id, second!.id], "w1");
    inbox.remove(first!.id);
    expect(inbox.list()).toEqual([{ ...second!, delivered: true, heldBy: "w1" }]);
  });

  test("gives a request to the window holding it, or to any while that one is away", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(file("/wt/a.ts"), "/wt");
    const connected = new Set(["w1", "w2"]);
    const isConnected = (id: string) => connected.has(id);
    const [entry] = inbox.forWindow("w1", isConnected);
    inbox.handTo([entry!.id], "w1");

    expect(inbox.holds("w1")).toBe(true);
    expect(inbox.forWindow("w2", isConnected)).toEqual([]);
    expect(inbox.forWindow("w1", isConnected).map((e) => e.id)).toEqual([entry!.id]);
    connected.delete("w1");
    expect(inbox.forWindow("w2", isConnected).map((e) => [e.id, e.heldBy])).toEqual([
      [entry!.id, "w1"],
    ]);
  });

  test("holds a queued terminal until its panel is placed", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(terminal("t1"), "/wt");

    expect(inbox.holdsTerminal("t1")).toBe(true);
    expect(inbox.holdsTerminal("t2")).toBe(false);
    inbox.handTo(
      inbox.list().map((entry) => entry.id),
      "w1",
    );
    expect(inbox.holdsTerminal("t1")).toBe(true);
    inbox.remove(inbox.list()[0]!.id);
    expect(inbox.holdsTerminal("t1")).toBe(false);
  });

  test("refuses requests past its limit", () => {
    const inbox = new OpenInbox({ now: clock });
    for (let i = 0; i < 100; i++) expect(inbox.add(file(`/wt/${i}`), "/wt")).toBe(true);

    expect(inbox.hasRoom()).toBe(false);
    expect(inbox.add(file("/wt/one-more"), "/wt")).toBe(false);
    expect(inbox.size).toBe(100);
  });

  test("lets requests expire after 72 hours, freeing their terminals", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(terminal("t1"), "/wt");
    now += 71 * HOUR;
    inbox.add(file("/wt/a.ts"), "/wt");
    now += 2 * HOUR;

    expect(inbox.holdsTerminal("t1")).toBe(false);
    expect(inbox.list().map((entry) => entry.message)).toEqual([file("/wt/a.ts")]);
  });

  test("drops what matches", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(file("/wt/a.ts"), "/wt");
    inbox.add(file("/other/b.ts"), "/other");

    inbox.dropWhere((entry) => entry.worktreePath === "/wt");

    expect(inbox.list().map((entry) => entry.worktreePath)).toEqual(["/other"]);
  });

  test("survives a restart, delivered or not, and an empty inbox stays empty", () => {
    const path = join(dir, "open-inbox.db");
    const first = new OpenInbox({ path, now: clock });
    first.add(terminal("t1", "claude"), "/wt");
    first.add(page("http://localhost:5173/"), "/wt");
    first.add(file("/wt/gone.ts"), "/wt");
    first.dropWhere(({ message }) => message.type === "open_file");
    first.handTo([first.list()[0]!.id], "w1");
    first.close();

    const second = new OpenInbox({ path, now: clock });
    expect(second.holdsTerminal("t1")).toBe(true);
    expect(second.list().map((entry) => [entry.message, entry.heldBy])).toEqual([
      [terminal("t1", "claude"), "w1"],
      [page("http://localhost:5173/"), undefined],
    ]);
    for (const entry of second.list()) second.remove(entry.id);
    second.close();

    const third = new OpenInbox({ path, now: clock });
    expect(third.size).toBe(0);
    third.close();
  });

  test("skips rows it cannot read", () => {
    const path = join(dir, "open-inbox.db");
    const inbox = new OpenInbox({ path, now: clock });
    inbox.add(file("/wt/a.ts"), "/wt");
    inbox.close();
    const db = new Database(path);
    db.prepare("INSERT INTO items (id, data) VALUES (?, ?)").run("bad", '{"message":{}}');
    db.close();

    const reopened = new OpenInbox({ path, now: clock });
    expect(reopened.list().map((entry) => entry.message)).toEqual([file("/wt/a.ts")]);
    reopened.close();
  });
});

describe("deliveredNotices", () => {
  const entry = (message: InboxMessage, worktreePath: string | null) => ({
    id: crypto.randomUUID(),
    queuedAt: 0,
    message,
    worktreePath,
  });

  test("says what opened, one notice per worktree", () => {
    const notices = deliveredNotices([
      entry(terminal("t1", "claude"), "/wt/fix-lsp"),
      entry(terminal("t2", "claude"), "/wt/fix-lsp"),
      entry(file("/wt/fix-lsp/plan.md"), "/wt/fix-lsp"),
      entry(page("http://localhost:5173/"), null),
    ]);

    expect(notices).toEqual([
      {
        worktreePath: "/wt/fix-lsp",
        title: "2 terminals and a file opened while you were away",
        body: "claude, plan.md",
      },
      { worktreePath: null, title: "A page opened while you were away", body: "localhost:5173" },
    ]);
  });

  test("names at most five, and leaves out the body with no names", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"].map((name) =>
      entry(file(`/wt/${name}`), "/wt"),
    );

    expect(deliveredNotices(files)[0]!.body).toBe("a, b, c, d, e and 2 more");
    expect(deliveredNotices([entry(terminal("t1"), "/wt")])).toEqual([
      { worktreePath: "/wt", title: "A terminal opened while you were away" },
    ]);
  });
});

describe("sweepOrphans", () => {
  test("spares the terminals the inbox holds, until their requests expire", () => {
    let now = 0;
    const inbox = new OpenInbox({ now: () => now });
    inbox.add(terminal("t1"), "/wt");
    const orphans = new Set(["t1", "t2"]);
    const destroyOrphans = (kept: (id: string) => boolean) => {
      const gone = [...orphans].filter((id) => !kept(id));
      for (const id of gone) orphans.delete(id);
      return gone.length;
    };

    // The first sweep, minutes after the last window closed.
    now = 5 * 60_000;
    const first = sweepOrphans(inbox, destroyOrphans);
    expect(first.destroyed).toBe(1);
    expect([...orphans]).toEqual(["t1"]);
    expect(first.nextSweepInMs).toBe(72 * HOUR + 1 - now);

    now += first.nextSweepInMs!;
    expect(sweepOrphans(inbox, destroyOrphans)).toEqual({ destroyed: 1, nextSweepInMs: null });
    expect(orphans.size).toBe(0);
  });
});
