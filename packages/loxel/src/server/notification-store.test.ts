import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserNotificationSource, NotificationSource } from "@/api/notification-model";

import { NotificationStore } from "./notification-store";

const terminal: NotificationSource = { kind: "terminal", panelId: "t1", worktreePath: "/wt" };
const browser = (ref: string, panelId = "browser-1"): BrowserNotificationSource => ({
  kind: "browser",
  panelId,
  worktreePath: "/wt",
  origin: "http://localhost:5173",
  ref,
});

describe("NotificationStore", () => {
  test("dismisses a panel's notifications whatever their source", () => {
    const store = new NotificationStore();
    store.add({ source: terminal, urgency: "normal" });
    store.add({ source: browser("a"), urgency: "normal" });
    store.add({ source: browser("b", "browser-2"), urgency: "normal" });
    expect(store.dismissByPanel("browser-1")).toBe(true);
    expect(store.dismissByPanel("t1")).toBe(true);
    expect(store.dismissByPanel("t1")).toBe(false);
    expect(store.getAll().map((n) => n.source)).toEqual([browser("b", "browser-2")]);
  });

  test("dismissWhere returns the ids it removed", () => {
    const store = new NotificationStore();
    const a = store.add({ source: browser("a"), urgency: "normal" });
    store.add({ source: browser("b"), urgency: "normal" });
    expect(store.dismissWhere((s) => s.kind === "browser" && s.ref === "a")).toEqual([a.id]);
    expect(store.getAll()).toHaveLength(1);
  });

  test("a tagged browser notification replaces its origin's earlier one with the tag", () => {
    const store = new NotificationStore();
    const tagged = (ref: string, origin = "http://localhost:5173") => ({
      ...browser(ref),
      origin,
      tag: "build",
    });
    const old = store.add({ source: tagged("a"), urgency: "normal" });
    store.add({ source: tagged("b", "https://example.com"), urgency: "normal" });
    store.add({ source: browser("c"), urgency: "normal" });
    expect(store.dismissReplacedBy(browser("d"))).toEqual([]);
    expect(store.dismissReplacedBy(tagged("e"))).toEqual([old.id]);
    expect(store.getAll()).toHaveLength(2);
  });

  test("dismissing a removed worktree's notifications covers its browser panels", () => {
    const store = new NotificationStore();
    store.add({ source: terminal, urgency: "normal" });
    store.add({ source: browser("a"), urgency: "normal" });
    store.add({ source: { kind: "server" }, urgency: "normal" });
    const inbox = store.add({ source: { kind: "inbox", worktreePath: "/wt" }, urgency: "normal" });
    store.add({ source: { kind: "inbox", worktreePath: "/other" }, urgency: "normal" });
    const { panelIds, inboxIds } = store.dismissByWorktree("/wt");
    expect(panelIds.toSorted()).toEqual(["browser-1", "t1"]);
    expect(inboxIds).toEqual([inbox.id]);
    expect(store.getAll().map((n) => n.source.kind)).toEqual(["inbox", "server"]);
  });

  test("tag replacement stays within one worktree", () => {
    const store = new NotificationStore();
    const inWorktree = (ref: string, worktreePath: string | null) => ({
      ...browser(ref),
      worktreePath,
      tag: "build",
    });
    const a = store.add({ source: inWorktree("a", "/wt"), urgency: "normal" });
    store.add({ source: inWorktree("b", "/other"), urgency: "normal" });
    store.add({ source: inWorktree("c", null), urgency: "normal" });
    expect(store.dismissReplacedBy(inWorktree("d", "/wt"))).toEqual([a.id]);
    expect(store.getAll()).toHaveLength(2);
  });

  test("browser notifications evict their own kind past their share, never terminals'", () => {
    const store = new NotificationStore();
    const agent = store.add({ source: terminal, urgency: "normal" });
    const evicted: string[] = [];
    for (let i = 0; i < 60; i++) {
      evicted.push(...store.addBrowser({ source: browser(`r${i}`), urgency: "normal" }).evicted);
    }
    expect(evicted).toHaveLength(10);
    expect(store.getAll().filter((n) => n.source.kind === "browser")).toHaveLength(50);
    expect(store.getAll()).toContainEqual(agent);
  });
});

describe("NotificationStore persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loxel-notifications-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the list across a restart, dismissals included", () => {
    const path = join(dir, "notifications.db");
    const first = new NotificationStore(path);
    const kept = first.add({ source: terminal, title: "done", urgency: "high" });
    const dismissed = first.add({ source: terminal, title: "seen", urgency: "normal" });
    const inbox = first.add({ source: { kind: "inbox", worktreePath: "/wt" }, urgency: "normal" });
    first.addBrowser({ source: browser("a"), title: "build", urgency: "normal" });
    first.add({ source: { kind: "server" }, title: "socket failed", urgency: "high" });
    first.dismiss(dismissed.id);
    first.close();

    const second = new NotificationStore(path);
    // Newest first, as before. A browser page's is not kept: what sites write stays off disk. Nor
    // is the server's own, which only described that process.
    expect(second.getAll()).toEqual([inbox, kept]);
    second.dismissAll();
    second.close();

    const third = new NotificationStore(path);
    expect(third.getAll()).toEqual([]);
    third.close();
  });

  test("keeps the newest 200 across a restart", () => {
    const path = join(dir, "notifications.db");
    const first = new NotificationStore(path);
    for (let i = 0; i < 205; i++) first.add({ source: terminal, title: String(i), urgency: "low" });
    first.close();

    const titles = new NotificationStore(path).getAll().map((n) => n.title);
    expect(titles).toHaveLength(200);
    expect(titles[0]).toBe("204");
    expect(titles.at(-1)).toBe("5");
  });

  test("goes on in memory when its file cannot be opened", () => {
    // A file where the database's directory should be.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const store = new NotificationStore(join(blocked, "notifications.db"));
    const added = store.add({ source: terminal, urgency: "normal" });
    expect(store.getAll()).toEqual([added]);
  });

  test("starts empty, keeping it, from a file it cannot read", () => {
    const path = join(dir, "notifications.db");
    writeFileSync(path, "not a database");

    const store = new NotificationStore(path);
    const added = store.add({ source: terminal, urgency: "normal" });
    store.close();

    expect(readFileSync(`${path}.unreadable`, "utf8")).toBe("not a database");
    expect(new NotificationStore(path).getAll()).toEqual([added]);
  });
});
