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
    store.add({ source: { kind: "terminal_host" }, urgency: "normal" });
    expect(store.dismissByWorktree("/wt")).toEqual(["t1", "browser-1"]);
    expect(store.getAll().map((n) => n.source.kind)).toEqual(["terminal_host"]);
  });
});
