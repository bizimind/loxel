import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { localServerId } from "@/api/local-server";
import type { NotificationSource, ServerNotification } from "@/api/notification-model";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { DEFAULT_BACKGROUND_TABS, useSettingsStore } from "@/store/settings-store";

const navigateToNotification = mock((_notification: ServerNotification) => {});
void mock.module("@/lib/notification-navigation", () => ({ navigateToNotification }));
const { NotificationBell } = await import("@/components/notifications/NotificationBell");

const site = "https://chat.example";

function notification(source: NotificationSource): ServerNotification {
  return { id: "n1", timestamp: Date.now(), source, title: "New message", urgency: "normal" };
}
const browser = notification({
  kind: "browser",
  panelId: "browser-1",
  worktreePath: null,
  origin: site,
  ref: "1-1",
});
const terminal = notification({ kind: "terminal", panelId: "terminal-1", worktreePath: null });

const mutes = () => useSettingsStore.getState().browser.notificationMutes;

/** The bell, opened on this one notification; the site menu opens inside its popup. */
async function openBell(n: ServerNotification): Promise<void> {
  usePanelNotificationStore.getState().syncAll(localServerId(), [n]);
  render(<NotificationBell />);
  fireEvent.click(screen.getByRole("button"));
  fireEvent.contextMenu(await screen.findByText("New message"));
}

/** A menu item, once the menu has positioned itself. */
const item = (label: string) => screen.findByText(label);

beforeEach(() => {
  navigateToNotification.mockClear();
  useSettingsStore.setState({
    browser: {
      notificationSites: { [site]: "allow" },
      notificationMutes: {},
      backgroundTabs: DEFAULT_BACKGROUND_TABS,
    },
  });
});

afterEach(() => {
  cleanup();
  usePanelNotificationStore.getState().syncAll(localServerId(), []);
});

describe("a browser notification's context menu in the bell", () => {
  test("mutes its site without navigating or closing the bell, keeping the site allowed", async () => {
    await openBell(browser);
    fireEvent.click(await item("Mute until unmuted"));
    expect(mutes()).toEqual({ [site]: {} });
    expect(useSettingsStore.getState().browser.notificationSites).toEqual({ [site]: "allow" });
    expect(navigateToNotification).not.toHaveBeenCalled();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  test("snoozes its site", async () => {
    await openBell(browser);
    fireEvent.click(await item("Snooze for 1 hour"));
    expect(mutes()[site]!.until).toBeGreaterThan(Date.now());
  });

  test("offers Unmute for a muted site", async () => {
    useSettingsStore.getState().setNotificationMute(site, {});
    await openBell(browser);
    fireEvent.click(await item("Unmute"));
    expect(screen.queryByText("Snooze for 1 hour")).toBeNull();
    expect(mutes()).toEqual({});
  });

  test("isn't offered for a site with no decision, or for other notifications", async () => {
    useSettingsStore.getState().setNotificationSite(site, null);
    await openBell(browser);
    expect(screen.queryByText("Mute until unmuted")).toBeNull();
    cleanup();
    await openBell(terminal);
    expect(screen.queryByText("Mute until unmuted")).toBeNull();
  });
});
