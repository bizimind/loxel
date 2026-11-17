import { describe, expect, test } from "bun:test";

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
    expect(store.dismissByWorktree("/wt").toSorted()).toEqual(["browser-1", "t1"]);
    expect(store.getAll().map((n) => n.source.kind)).toEqual(["server"]);
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
