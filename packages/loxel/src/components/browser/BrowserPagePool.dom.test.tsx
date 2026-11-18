import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";

import { attachBrowserPage, useBrowserPages } from "@/store/browser-pages";
import { setDockviewApi } from "@/store/tools-bar";
import { stubElectronAPI } from "@/test/electron-api-stub";

// BrowserPanel renders its webview only in Electron (read once, at import).
Object.defineProperty(navigator, "userAgent", {
  value: "Mozilla/5.0 Electron/44",
  configurable: true,
});

let notifyWebviewFocused = () => {};
const offWebviewFocused = mock(() => {});
window.electronAPI = stubElectronAPI({
  onWebviewFocused: (callback) => {
    notifyWebviewFocused = callback;
    return offWebviewFocused;
  },
});

const { BrowserPagePool } = await import("./BrowserPagePool");

const disposable = { dispose: () => {} };

/** A browser panel's api, activated or not, recording `setActive` calls. */
function fakePanelApi(activated: boolean) {
  const setActive = mock(() => {
    Object.assign(api, { isActive: true, isGroupActive: true });
  });
  const api = {
    id: "browser-test",
    renderer: "always",
    isActive: activated,
    isGroupActive: activated,
    setActive,
    onDidActiveChange: () => disposable,
    onDidActiveGroupChange: () => disposable,
    onDidGroupChange: () => disposable,
    updateParameters: () => {},
    setTitle: () => {},
  } as unknown as DockviewPanelApi;
  return { api, setActive };
}

/** The outer layout, holding the editor area's `centerHost` panel (not the active group). */
function fakeOuterLayout() {
  const setActive = mock(() => {
    centerHost.api.isGroupActive = true;
  });
  const centerHost = { api: { isGroupActive: false, setActive } };
  setDockviewApi({
    getPanel: (id: string) => (id === "centerHost" ? centerHost : undefined),
  } as unknown as DockviewApi);
  return { setActive };
}

/** Render the pool with one page shown over a slot, and an element outside it. */
function renderPage({ activated = false } = {}) {
  const panel = fakePanelApi(activated);
  const editorArea = fakeOuterLayout();
  const slot = document.createElement("div");
  document.body.append(slot);
  act(() =>
    attachBrowserPage(panel.api.id, {
      layoutKey: "/repo",
      url: "about:blank",
      slot: { element: slot, api: panel.api },
    }),
  );
  const view = render(
    <>
      <button type="button">Elsewhere</button>
      <BrowserPagePool />
    </>,
  );
  const webview = document.querySelector<HTMLElement>("webview")!;
  webview.tabIndex = 0;
  const elsewhere = view.getByText("Elsewhere");
  return { ...view, panel, editorArea, webview, elsewhere, slot };
}

/**
 * In Electron, focus moving into a <webview> fires no focus event in the window; happy-dom fires
 * one at the element. Swallow it before the page's host sees it.
 */
function swallowWebviewFocusEvents(event: FocusEvent) {
  if (event.target instanceof HTMLElement && event.target.tagName === "WEBVIEW") {
    event.stopImmediatePropagation();
  }
}

/** Let timers queued so far run (the window blur's check of the active element). */
const nextTick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  offWebviewFocused.mockClear();
  notifyWebviewFocused = () => {};
  window.addEventListener("focus", swallowWebviewFocusEvents, true);
});

afterEach(() => {
  window.removeEventListener("focus", swallowWebviewFocusEvents, true);
  cleanup();
  setDockviewApi(null);
  useBrowserPages.setState({ pages: {} });
  document.body.replaceChildren();
});

describe("BrowserPagePool focus", () => {
  test("focus in the page's toolbar activates its panel and the editor area", () => {
    const { panel, editorArea, getByRole } = renderPage();

    // Hidden to the accessibility tree: the slot has no size here, so the page isn't shown.
    getByRole("textbox", { hidden: true }).focus();

    expect(panel.setActive).toHaveBeenCalledTimes(1);
    expect(editorArea.setActive).toHaveBeenCalledTimes(1);
  });

  test("a click in the page, which only blurs the window, activates its panel", async () => {
    const { panel, editorArea, elsewhere, webview } = renderPage();
    elsewhere.focus();

    webview.focus();
    fireEvent.blur(window);

    await waitFor(() => expect(panel.setActive).toHaveBeenCalledTimes(1));
    expect(editorArea.setActive).toHaveBeenCalledTimes(1);
  });

  test("a click in the page from another page or app, which main reports, activates it", () => {
    const { panel, editorArea, webview } = renderPage();

    // The window has no focus left to lose: no blur, only the main process's report.
    webview.focus();
    act(() => notifyWebviewFocused());

    expect(panel.setActive).toHaveBeenCalledTimes(1);
    expect(editorArea.setActive).toHaveBeenCalledTimes(1);
  });

  test("a window blur with focus outside the page activates nothing", async () => {
    const { panel, editorArea, elsewhere } = renderPage();
    elsewhere.focus();

    fireEvent.blur(window);
    await nextTick();

    expect(panel.setActive).not.toHaveBeenCalled();
    expect(editorArea.setActive).not.toHaveBeenCalled();
  });

  test("an already activated panel is not activated again", () => {
    const { panel, editorArea, webview } = renderPage({ activated: true });

    webview.focus();
    act(() => notifyWebviewFocused());

    expect(panel.setActive).not.toHaveBeenCalled();
    expect(editorArea.setActive).toHaveBeenCalledTimes(1);
  });

  test("unmounting stops listening for the page's focus", async () => {
    const { panel, webview, unmount } = renderPage();

    unmount();
    expect(offWebviewFocused).toHaveBeenCalled();
    document.body.append(webview);
    webview.focus();
    fireEvent.blur(window);
    await nextTick();

    expect(panel.setActive).not.toHaveBeenCalled();
  });
});
