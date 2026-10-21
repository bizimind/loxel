import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WebviewTag } from "electron";

import type { BrowserContextMenuState } from "./BrowserContextMenu";
import { webSearchUrl } from "./web-search";

const openBrowserTab = mock((_url: string, _options: object) => {});
mock.module("@/lib/panel-creators", () => ({ openBrowserTab }));

const { BrowserContextMenu } = await import("./BrowserContextMenu");

const writeText = mock((_text: string) => Promise.resolve());
const copyWebviewImage = mock((_id: number, _x: number, _y: number) => {});
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function fakeWebview() {
  return {
    focus: mock(() => {}),
    cut: mock(() => {}),
    copy: mock(() => {}),
    paste: mock(() => {}),
    selectAll: mock(() => {}),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    downloadURL: mock((_url: string) => {}),
    inspectElement: mock((_x: number, _y: number) => {}),
    getWebContentsId: () => 7,
  };
}

type Params = BrowserContextMenuState["params"];

const NO_EDIT: Params["editFlags"] = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
};

function renderMenu(overrides: Partial<Params> = {}) {
  const webview = fakeWebview();
  const params = {
    x: 120,
    y: 80,
    linkURL: "",
    srcURL: "",
    pageURL: "https://example.com/page",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    editFlags: NO_EDIT,
    ...overrides,
  } as Params;
  const onOpenChange = mock((_open: boolean) => {});
  render(
    <BrowserContextMenu
      // A test double for the parts of the webview the menu calls.
      menu={{
        open: true,
        webview: webview as unknown as WebviewTag,
        params,
        canGoBack: true,
        canGoForward: false,
      }}
      panelId="browser-1"
      onOpenChange={onOpenChange}
    />,
  );
  return { webview, onOpenChange };
}

function itemLabels(): string[] {
  return screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
}

beforeEach(() => {
  openBrowserTab.mockClear();
  writeText.mockClear();
  copyWebviewImage.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  window.electronAPI = { copyWebviewImage } as unknown as Window["electronAPI"];
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electronAPI");
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("BrowserContextMenu", () => {
  test("shows page actions on the page background", () => {
    const { webview } = renderMenu();

    expect(itemLabels()).toEqual([
      "Back",
      "Forward",
      "Reload",
      "View Page Source",
      "Inspect Element",
    ]);
    expect(screen.getByText("Forward").closest("[role=menuitem]")).toHaveAttribute("data-disabled");

    fireEvent.click(screen.getByText("Back"));
    expect(webview.goBack).toHaveBeenCalled();
  });

  test("views the page source in a new focused tab", () => {
    renderMenu();

    fireEvent.click(screen.getByText("View Page Source"));

    expect(openBrowserTab).toHaveBeenCalledWith("view-source:https://example.com/page", {
      sourcePanelId: "browser-1",
      activate: true,
    });
  });

  test("inspects the element at the clicked point", () => {
    const { webview } = renderMenu();

    fireEvent.click(screen.getByText("Inspect Element"));

    expect(webview.inspectElement).toHaveBeenCalledWith(120, 80);
  });

  test("shows link actions instead of page actions on a link", () => {
    renderMenu({ linkURL: "https://example.com/next" });

    expect(itemLabels()).toEqual([
      "Open Link in New Tab",
      "Open Link in External Browser",
      "Copy Link Address",
      "Inspect Element",
    ]);

    fireEvent.click(screen.getByText("Open Link in New Tab"));
    expect(openBrowserTab).toHaveBeenCalledWith("https://example.com/next", {
      sourcePanelId: "browser-1",
      activate: false,
    });
  });

  test("copies the link address", () => {
    renderMenu({ linkURL: "https://example.com/next" });

    fireEvent.click(screen.getByText("Copy Link Address"));

    expect(writeText).toHaveBeenCalledWith("https://example.com/next");
  });

  test("offers only copying for a link that is not a web page", () => {
    renderMenu({ linkURL: "mailto:someone@example.com" });

    expect(itemLabels()).toEqual(["Copy Link Address", "Inspect Element"]);
  });

  test("shows image actions on an image", () => {
    const { webview } = renderMenu({
      mediaType: "image",
      srcURL: "https://example.com/cat.png",
      hasImageContents: true,
    });

    expect(itemLabels()).toEqual([
      "Open Image in New Tab",
      "Save Image As…",
      "Copy Image",
      "Copy Image Address",
      "Inspect Element",
    ]);

    fireEvent.click(screen.getByText("Copy Image"));
    expect(copyWebviewImage).toHaveBeenCalledWith(7, 120, 80);

    fireEvent.click(screen.getByText("Save Image As…"));
    expect(webview.downloadURL).toHaveBeenCalledWith("https://example.com/cat.png");
  });

  test("hides Copy Image when the app's preload predates it", () => {
    window.electronAPI = {} as Window["electronAPI"];
    renderMenu({
      mediaType: "image",
      srcURL: "https://example.com/cat.png",
      hasImageContents: true,
    });

    expect(screen.queryByText("Copy Image")).toBeNull();
  });

  test("combines link and image actions on a linked image", () => {
    renderMenu({
      linkURL: "https://example.com/next",
      mediaType: "image",
      srcURL: "https://example.com/cat.png",
      hasImageContents: true,
    });

    expect(itemLabels()).toContain("Open Link in New Tab");
    expect(itemLabels()).toContain("Open Image in New Tab");
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  test("copies and searches selected text", () => {
    const { webview } = renderMenu({
      selectionText: "  a selection that is long enough to be cut off  ",
      editFlags: { ...NO_EDIT, canCopy: true },
    });

    expect(itemLabels()).toEqual([
      "Copy",
      "Search the Web for “a selection that is long enoug…”",
      "Inspect Element",
    ]);

    fireEvent.click(screen.getByText("Copy"));
    expect(webview.copy).toHaveBeenCalled();

    fireEvent.click(screen.getByText(/^Search the Web/));
    expect(openBrowserTab).toHaveBeenCalledWith(
      "https://www.google.com/search?q=a%20selection%20that%20is%20long%20enough%20to%20be%20cut%20off",
      { sourcePanelId: "browser-1", activate: true },
    );
  });

  test("searches for a long selection without splitting an emoji", () => {
    renderMenu({ selectionText: `${"a".repeat(499)}😀${"b".repeat(2000)}` });

    fireEvent.click(screen.getByText(/^Search the Web/));

    const [url] = openBrowserTab.mock.calls[0]!;
    expect(url).toBe(webSearchUrl(`${"a".repeat(499)}😀`));
  });

  test("shows editing actions in an editable field", () => {
    const { webview } = renderMenu({
      isEditable: true,
      editFlags: { ...NO_EDIT, canPaste: true, canSelectAll: true },
    });

    expect(itemLabels()).toEqual(["Cut", "Copy", "Paste", "Select All", "Inspect Element"]);
    expect(screen.getByText("Cut").closest("[role=menuitem]")).toHaveAttribute("data-disabled");

    fireEvent.click(screen.getByText("Paste"));
    expect(webview.focus).toHaveBeenCalled();
    expect(webview.paste).toHaveBeenCalled();
  });
});
