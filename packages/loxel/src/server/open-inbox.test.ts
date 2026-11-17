import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type InboxMessage, OpenInbox, deliveredNotices } from "./open-inbox";

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

  test("hands its requests over oldest first, once", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(file("/wt/a.ts"), "/wt");
    inbox.add(terminal("t1"), "/wt");

    expect(inbox.takeAll().map((entry) => entry.message)).toEqual([
      file("/wt/a.ts"),
      terminal("t1"),
    ]);
    expect(inbox.takeAll()).toEqual([]);
  });

  test("holds a queued terminal until it is handed over", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(terminal("t1"), "/wt");

    expect(inbox.holdsTerminal("t1")).toBe(true);
    expect(inbox.holdsTerminal("t2")).toBe(false);
    inbox.takeAll();
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
    expect(inbox.takeAll().map((entry) => entry.message)).toEqual([file("/wt/a.ts")]);
  });

  test("drops what matches", () => {
    const inbox = new OpenInbox({ now: clock });
    inbox.add(file("/wt/a.ts"), "/wt");
    inbox.add(file("/other/b.ts"), "/other");

    inbox.dropWhere((entry) => entry.worktreePath === "/wt");

    expect(inbox.takeAll().map((entry) => entry.worktreePath)).toEqual(["/other"]);
  });

  test("survives a restart, and an empty inbox stays empty", () => {
    const path = join(dir, "open-inbox.db");
    const first = new OpenInbox({ path, now: clock });
    first.add(terminal("t1", "claude"), "/wt");
    first.add(page("http://localhost:5173/"), "/wt");
    first.add(file("/wt/gone.ts"), "/wt");
    first.dropWhere(({ message }) => message.type === "open_file");
    first.close();

    const second = new OpenInbox({ path, now: clock });
    expect(second.holdsTerminal("t1")).toBe(true);
    expect(second.takeAll().map((entry) => entry.message)).toEqual([
      terminal("t1", "claude"),
      page("http://localhost:5173/"),
    ]);
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
    expect(reopened.takeAll().map((entry) => entry.message)).toEqual([file("/wt/a.ts")]);
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
