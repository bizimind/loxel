import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { wsClient } from "@/api/client";
import { localServerId } from "@/api/local-server";
import type { ServerNotification } from "@/api/notification-model";
import { usePanelNotificationStore } from "@/store/panel-notifications";

import { NotificationBell } from "./NotificationBell";

function build(n: number): ServerNotification {
  return {
    id: `build-${n}`,
    timestamp: n,
    source: {
      kind: "browser",
      panelId: "panel-1",
      worktreePath: "/wt/feature",
      origin: "http://localhost:5173",
      ref: `ref-${n}`,
    },
    title: `Build ${n}`,
    urgency: "normal",
  };
}

const AGENT: ServerNotification = {
  id: "agent",
  timestamp: 0,
  source: { kind: "terminal", panelId: "terminal-1", worktreePath: "/wt/feature" },
  title: "Agent needs input",
  urgency: "normal",
};

let send: ReturnType<typeof spyOn<typeof wsClient, "send">>;

beforeEach(() => {
  send = spyOn(wsClient, "send").mockImplementation(() => {});
  usePanelNotificationStore.getState().syncAll(localServerId(), [build(2), build(1), AGENT]);
});

afterEach(() => {
  cleanup();
  send.mockRestore();
  usePanelNotificationStore.getState().clearFromServer();
});

async function openBell() {
  render(<NotificationBell />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Notifications");
}

/** The rows' titles, in order. */
const titles = () =>
  screen.getAllByText(/^(Build \d|Agent needs input)$/).map((el) => el.textContent);

describe("the notification bell", () => {
  test("stacks a site's notifications above the older terminal one", async () => {
    await openBell();

    expect(titles()).toEqual(["Build 2", "Agent needs input"]);
    expect(screen.getByRole("button", { name: /^\+1 more/ })).toBeInTheDocument();
  });

  test("keeps an expanded stack open as the site notifies again", async () => {
    await openBell();
    fireEvent.click(screen.getByRole("button", { name: /^\+1 more/ }));

    act(() => usePanelNotificationStore.getState().addFromServer(localServerId(), build(3)));

    expect(titles()).toEqual(["Build 3", "Build 2", "Build 1", "Agent needs input"]);
  });

  test("shows a stack left with one notification as a plain row", async () => {
    await openBell();
    fireEvent.click(screen.getByRole("button", { name: /^\+1 more/ }));

    act(() => usePanelNotificationStore.getState().removeFromServer("build-1"));

    expect(titles()).toEqual(["Build 2", "Agent needs input"]);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: /more from/ })).toBeNull();
  });
});
