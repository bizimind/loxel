import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { localServerId } from "@/api/local-server";
import type { NotificationSource } from "@/api/notification-model";
import type { ClientNotification } from "@/store/panel-notifications";

import { NotificationItem } from "./NotificationItem";

afterEach(cleanup);

function renderItem(source: NotificationSource) {
  const notification: ClientNotification = {
    server: localServerId(),
    id: "n1",
    timestamp: Date.now(),
    source,
    title: "Build failed",
    urgency: "normal",
  };
  return render(<NotificationItem notification={notification} />).container;
}

const browserSource = {
  kind: "browser",
  panelId: "browser-1",
  worktreePath: null,
  origin: "https://chat.example",
  ref: "r1",
} as const;

describe("NotificationItem icons", () => {
  test("a browser notification shows its site's favicon", () => {
    const item = renderItem({ ...browserSource, faviconUrl: "https://chat.example/icon.png" });
    expect(item.querySelector("img")?.getAttribute("src")).toBe("https://chat.example/icon.png");
  });

  test("a browser notification without a favicon shows a globe", () => {
    const item = renderItem(browserSource);
    expect(item.querySelector("img")).toBeNull();
    expect(item.querySelector("svg.lucide-globe")).not.toBeNull();
  });

  test("a terminal notification has no site icon", () => {
    const item = renderItem({ kind: "terminal", panelId: "term-1", worktreePath: null });
    expect(item.querySelector("img, svg.lucide-globe")).toBeNull();
  });
});
