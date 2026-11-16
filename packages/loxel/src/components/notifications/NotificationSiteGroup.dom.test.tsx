import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

import { wsClient } from "@/api/client";
import type { ServerNotification } from "@/api/notification-model";
import { HOME_LAYOUT_KEY } from "@/store/active-worktree";
import { attachBrowserPage, closeBrowserPage } from "@/store/browser-pages";
import { stubElectronAPI } from "@/test/electron-api-stub";

import { NotificationSiteGroup } from "./NotificationSiteGroup";

function build(n: number, faviconUrl?: string): ServerNotification {
  return {
    id: `build-${n}`,
    timestamp: Date.now() - (10 - n) * 60_000,
    source: {
      kind: "browser",
      panelId: "panel-1",
      worktreePath: null,
      origin: "http://localhost:5173",
      ref: `ref-${n}`,
      ...(faviconUrl && { faviconUrl }),
    },
    title: `Build ${n} finished`,
    urgency: "normal",
  };
}

const SITE = [build(3), build(2), build(1)] as const;
const clickBrowserNotification = jest.fn();
let send: ReturnType<typeof spyOn<typeof wsClient, "send">>;

beforeEach(() => {
  clickBrowserNotification.mockClear();
  window.electronAPI = stubElectronAPI({ clickBrowserNotification });
  send = spyOn(wsClient, "send").mockImplementation(() => {});
  // The site's page, shown in Home's layout: a click reaches it at once.
  attachBrowserPage("panel-1", {
    layoutKey: HOME_LAYOUT_KEY,
    url: "http://localhost:5173/",
    slot: {
      element: document.createElement("div"),
      api: { setActive: () => {} } as DockviewPanelApi,
    },
  });
});

afterEach(() => {
  cleanup();
  send.mockRestore();
  window.electronAPI = undefined;
  closeBrowserPage("panel-1");
});

describe("a site's stacked notifications", () => {
  test("show the newest and how many more", () => {
    render(<NotificationSiteGroup notifications={SITE} />);

    expect(screen.getByText("Build 3 finished")).toBeInTheDocument();
    expect(screen.queryByText("Build 2 finished")).toBeNull();
    expect(
      screen.getByRole("button", { name: "+2 more from localhost:5173 · Home" }),
    ).toHaveTextContent("+2");
  });

  test("open the newest on a click, firing its page's click handler", () => {
    const onNavigate = jest.fn();
    render(<NotificationSiteGroup notifications={SITE} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Build 3 finished"));

    expect(clickBrowserNotification).toHaveBeenCalledWith({ ref: "ref-3" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  test("expand to each one, which opens on its own, and collapse again", () => {
    render(<NotificationSiteGroup notifications={SITE} />);

    fireEvent.click(screen.getByRole("button", { name: /^\+2 more/ }));
    expect(clickBrowserNotification).not.toHaveBeenCalled();
    for (const n of SITE) expect(screen.getByText(n.title ?? "")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Build 2 finished"));
    expect(clickBrowserNotification).toHaveBeenCalledWith({ ref: "ref-2" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse localhost:5173 · Home" }));
    expect(screen.queryByText("Build 2 finished")).toBeNull();
  });

  test("show the site's newest favicon once: on the stack, then on the expanded header", () => {
    const icon = (n: number) => `http://localhost:5173/icon-${n}.png`;
    const site = [build(3, icon(3)), build(2, icon(2)), build(1, icon(1))] as const;
    const { container } = render(<NotificationSiteGroup notifications={site} />);
    const icons = () => [...container.querySelectorAll("img")].map((img) => img.src);
    expect(icons()).toEqual([icon(3)]);

    fireEvent.click(screen.getByRole("button", { name: /^\+2 more/ }));
    expect(icons()).toEqual([icon(3)]);
  });

  test("dismiss one when expanded, or all of them collapsed or expanded", () => {
    render(<NotificationSiteGroup notifications={SITE} />);
    const allIds = SITE.map((n) => ({ type: "notification_dismiss" as const, id: n.id }));

    fireEvent.click(screen.getByRole("button", { name: /^Dismiss all 3/ }));
    expect(send.mock.calls.flat()).toEqual(allIds);
    expect(clickBrowserNotification).not.toHaveBeenCalled();

    // The send is mocked, so the stack is still there to expand
    send.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^\+2 more/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]!);
    expect(send.mock.calls.flat()).toEqual([{ type: "notification_dismiss", id: "build-2" }]);

    send.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss all 3/ }));
    expect(send.mock.calls.flat()).toEqual(allIds);
  });
});
