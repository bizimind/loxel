import { describe, expect, test } from "bun:test";

import type { NotificationSource, ServerNotification } from "@/api/notification-model";

import { groupNotifications } from "./notification-groups";

let next = 0;
function notification(source: NotificationSource): ServerNotification {
  next += 1;
  return { id: `n${next}`, timestamp: next, source, urgency: "normal" };
}

function browser(origin: string, worktreePath: string | null = "/wt/a"): ServerNotification {
  return notification({ kind: "browser", panelId: "p", worktreePath, origin, ref: "r" });
}

function terminal(): ServerNotification {
  return notification({ kind: "terminal", panelId: "t", worktreePath: "/wt/a" });
}

/** Each entry as the ids it holds. */
function shape(list: ServerNotification[]): string[][] {
  return groupNotifications(list).map((entry) =>
    entry.kind === "single" ? [entry.notification.id] : entry.notifications.map((n) => n.id),
  );
}

describe("groupNotifications", () => {
  test("stacks a site's notifications where its newest is, keeping the rest in order", () => {
    const build1 = browser("http://localhost:5173");
    const agent = terminal();
    const build2 = browser("http://localhost:5173");
    const chat = browser("https://chat.example.com");
    const build3 = browser("http://localhost:5173");
    // Newest first, as the store holds them
    const list = [build3, chat, build2, agent, build1];

    expect(shape(list)).toEqual([[build3.id, build2.id, build1.id], [chat.id], [agent.id]]);
  });

  test("keeps a site in two worktrees, and in Home, apart", () => {
    const a = browser("http://localhost:3000", "/wt/a");
    const b = browser("http://localhost:3000", "/wt/b");
    const home = browser("http://localhost:3000", null);
    const a2 = browser("http://localhost:3000", "/wt/a");

    expect(shape([a2, home, b, a])).toEqual([[a2.id, a.id], [home.id], [b.id]]);
  });

  test("never stacks terminals' or the server's notifications", () => {
    const t1 = terminal();
    const t2 = terminal();
    const host = notification({ kind: "server" });

    expect(shape([host, t2, t1])).toEqual([[host.id], [t2.id], [t1.id]]);
  });
});
