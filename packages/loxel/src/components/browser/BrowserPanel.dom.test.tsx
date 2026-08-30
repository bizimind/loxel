import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

const originalUserAgent = navigator.userAgent;
const loadURL = mock(() => {});

Object.defineProperty(navigator, "userAgent", {
  configurable: true,
  value: `${originalUserAgent} Electron/42.3.0`,
});
Object.assign(HTMLElement.prototype, {
  loadURL,
  goBack: () => {},
  goForward: () => {},
  reload: () => {},
  stop: () => {},
  canGoBack: () => false,
  canGoForward: () => false,
  openDevTools: () => {},
  closeDevTools: () => {},
  isDevToolsOpened: () => false,
});

afterAll(() => {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
});

const { BrowserPanel } = await import("./BrowserPanel");

function panelApi(): DockviewPanelApi {
  return {
    updateParameters: mock(() => {}),
    setTitle: mock(() => {}),
  } as unknown as DockviewPanelApi;
}

function markWebviewReady(): void {
  const webview = document.querySelector("webview");
  if (!webview) throw new Error("Expected a webview");
  fireEvent(webview, new Event("dom-ready"));
}

function electronApi(
  authenticateInChrome: NonNullable<Window["electronAPI"]>["authenticateInChrome"],
): NonNullable<Window["electronAPI"]> {
  return {
    onOpenInBrowserTab: () => () => {},
    setDockBadge: () => {},
    onWindowFocusChange: () => () => {},
    openFolderDialog: async () => null,
    supportsChromeAuthentication: true,
    authenticateInChrome,
  };
}

describe("BrowserPanel Chrome authentication", () => {
  beforeEach(() => {
    loadURL.mockClear();
    window.electronAPI = undefined;
  });

  test("disables the action while authenticating and navigates to the final URL", async () => {
    const authentication = Promise.withResolvers<{
      status: "success";
      finalUrl: string;
      importedCount: number;
      skippedCount: number;
      persistence: "persistent";
    }>();
    const authenticateInChrome = mock(() => authentication.promise);
    window.electronAPI = electronApi(authenticateInChrome);

    render(<BrowserPanel url="https://accounts.example.com/" panelApi={panelApi()} />);
    markWebviewReady();
    loadURL.mockClear();

    const button = screen.getByTitle("Authenticate in Chrome");
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(authenticateInChrome).toHaveBeenCalledWith("https://accounts.example.com/");

    authentication.resolve({
      status: "success",
      finalUrl: "https://example.com/dashboard",
      importedCount: 2,
      skippedCount: 0,
      persistence: "persistent",
    });

    await waitFor(() => {
      expect(loadURL).toHaveBeenCalledWith("https://example.com/dashboard");
      expect(button).not.toBeDisabled();
    });
  });

  test("shows sanitized helper errors without navigating", async () => {
    const authenticateInChrome = mock(async () => ({
      status: "error" as const,
      code: "chrome-not-found" as const,
      message: "Google Chrome was not found in Applications.",
    }));
    window.electronAPI = electronApi(authenticateInChrome);

    render(<BrowserPanel url="https://example.com/" panelApi={panelApi()} />);
    markWebviewReady();
    loadURL.mockClear();
    fireEvent.click(screen.getByTitle("Authenticate in Chrome"));

    expect(await screen.findByText("Google Chrome was not found in Applications.")).toBeVisible();
    expect(loadURL).not.toHaveBeenCalled();
  });
});
