import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

import type {
  JavaScriptDialogClosed,
  JavaScriptDialogRequest,
} from "@/electron/javascript-dialog-protocol";

// BrowserPanel renders its webview only in Electron (read once, at import).
Object.defineProperty(navigator, "userAgent", {
  value: "Mozilla/5.0 Electron/44",
  configurable: true,
});

let openDialog: (request: unknown) => void = () => {};
let closeDialog: (closed: unknown) => void = () => {};
const respondToJavaScriptDialog = mock();
window.electronAPI = {
  onOpenInBrowserTab: () => () => {},
  setDockBadge: () => {},
  onWindowFocusChange: () => () => {},
  openFolderDialog: async () => null,
  onJavaScriptDialog: (onOpen, onClosed) => {
    openDialog = onOpen;
    closeDialog = onClosed;
    return () => {};
  },
  respondToJavaScriptDialog,
};

const { BrowserPanel } = await import("./BrowserPanel");

const WEB_CONTENTS_ID = 42;
let nextId = 1;

const disposable = { dispose: () => {} };
const panelApi = {
  id: "browser-test",
  renderer: "always",
  isActive: false,
  isGroupActive: false,
  onDidActiveChange: () => disposable,
  onDidActiveGroupChange: () => disposable,
  onDidGroupChange: () => disposable,
  updateParameters: () => {},
  setTitle: () => {},
} as unknown as DockviewPanelApi;

function request(fields: Partial<JavaScriptDialogRequest>): JavaScriptDialogRequest {
  return {
    id: nextId++,
    webContentsId: WEB_CONTENTS_ID,
    type: "alert",
    title: "localhost:5173 says",
    message: "",
    defaultValue: "",
    canSuppress: false,
    ...fields,
  };
}

function show(fields: Partial<JavaScriptDialogRequest>): JavaScriptDialogRequest {
  const dialog = request(fields);
  act(() => openDialog(dialog));
  return dialog;
}

/** Render the panel, focus its page, and fire the webview's first dom-ready. */
function renderPanel({ ready = true } = {}) {
  render(
    <>
      <button type="button">Elsewhere</button>
      <BrowserPanel url="about:blank" panelApi={panelApi} />
    </>,
  );
  const webview = document.querySelector<HTMLElement>("webview")!;
  const guest = { id: WEB_CONTENTS_ID };
  // How many dialog answers had been sent when the page was reloaded.
  const reload = mock(() => respondToJavaScriptDialog.mock.calls.length);
  Object.assign(webview, {
    getWebContentsId: () => guest.id,
    loadURL: () => {},
    reload,
    canGoBack: () => false,
    canGoForward: () => false,
  });
  webview.tabIndex = 0;
  webview.focus();
  const fireReady = () => act(() => void webview.dispatchEvent(new Event("dom-ready")));
  if (ready) fireReady();
  return { webview, guest, reload, fireReady };
}

const lastResponse = () => respondToJavaScriptDialog.mock.calls.at(-1)?.[0];

beforeEach(() => respondToJavaScriptDialog.mockClear());
afterEach(cleanup);

describe("page dialogs in a browser panel", () => {
  test("a prompt shows the page's message and default, and answers with the entered text", () => {
    const { webview } = renderPanel();
    const dialog = show({ type: "prompt", message: "Your name?", defaultValue: "Ada" });

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("localhost:5173 says")).toBeInTheDocument();
    const input = screen.getByLabelText("Your name?") as HTMLInputElement;
    expect(input.value).toBe("Ada");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "Grace" } });
    fireEvent.submit(input);
    expect(lastResponse()).toEqual({
      id: dialog.id,
      accepted: true,
      value: "Grace",
      suppress: false,
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Focus goes back to the page.
    expect(document.activeElement).toBe(webview);
  });

  test("a confirm is cancelled with Cancel or Escape", () => {
    renderPanel();
    const first = show({ type: "confirm", message: "Delete?" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(lastResponse()).toMatchObject({ id: first.id, accepted: false });

    const second = show({ type: "confirm" });
    fireEvent.keyDown(screen.getByRole("button", { name: "OK" }), { key: "Escape" });
    expect(lastResponse()).toMatchObject({ id: second.id, accepted: false });
  });

  test("an alert has only OK", () => {
    renderPanel();
    const dialog = show({ type: "alert", message: "Saved" });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(screen.getByRole("alertdialog")).queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastResponse()).toMatchObject({ id: dialog.id, accepted: true });
  });

  test("offers to block the page's further dialogs when main allows it", () => {
    renderPanel();
    show({ type: "alert" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    const dialog = show({ type: "alert", canSuppress: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /more dialogs/ }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastResponse()).toMatchObject({ id: dialog.id, suppress: true });
  });

  test("shows queued dialogs one at a time, and drops withdrawn ones", () => {
    renderPanel();
    const first = show({ message: "first" });
    const second = show({ message: "second" });
    show({ message: "third" });
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.queryByText("second")).toBeNull();

    const closed: JavaScriptDialogClosed = { id: second.id, webContentsId: WEB_CONTENTS_ID };
    act(() => closeDialog(closed));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastResponse()).toMatchObject({ id: first.id });
    expect(screen.getByText("third")).toBeInTheDocument();
  });

  test("a dialog opened before the panel is ready waits for it", () => {
    const { fireReady } = renderPanel({ ready: false });
    show({ message: "early" });
    expect(screen.queryByText("early")).toBeNull();
    fireReady();
    expect(screen.getByText("early")).toBeInTheDocument();
  });

  test("does not take focus from outside the panel", () => {
    renderPanel();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    show({ type: "prompt", message: "Name?" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(document.activeElement).toBe(elsewhere);
  });

  test("reloading from the toolbar first dismisses the page's dialogs", () => {
    const { reload } = renderPanel();
    const first = show({ type: "confirm" });
    const second = show({ type: "prompt" });
    fireEvent.click(screen.getByTitle("Reload"));
    expect(respondToJavaScriptDialog.mock.calls.map(([response]) => response)).toEqual([
      { id: first.id, accepted: false, value: "", suppress: false },
      { id: second.id, accepted: false, value: "", suppress: false },
    ]);
    // The page can't navigate until its dialogs are answered, so the answers go first.
    expect(reload.mock.results).toEqual([{ type: "return", value: 2 }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("returns focus to the page when a focused dialog is withdrawn", () => {
    const { webview } = renderPanel();
    const dialog = show({ type: "confirm" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
    act(() => closeDialog({ id: dialog.id, webContentsId: WEB_CONTENTS_ID }));
    expect(document.activeElement).toBe(webview);
  });

  test("Escape while composing text (IME) does not cancel a prompt", () => {
    renderPanel();
    show({ type: "prompt", message: "Name?" });
    fireEvent.keyDown(screen.getByLabelText("Name?"), { key: "Escape", isComposing: true });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(respondToJavaScriptDialog).not.toHaveBeenCalled();
  });

  test("a re-created guest drops the old guest's dialogs", () => {
    const { guest, fireReady } = renderPanel();
    show({ message: "old page" });
    guest.id = WEB_CONTENTS_ID + 100;
    fireReady();
    expect(screen.queryByText("old page")).toBeNull();
    show({ webContentsId: guest.id, message: "new page" });
    expect(screen.getByText("new page")).toBeInTheDocument();
  });

  test("ignores dialogs of other webviews", () => {
    renderPanel();
    show({ webContentsId: WEB_CONTENTS_ID + 1, message: "not mine" });
    expect(screen.queryByText("not mine")).toBeNull();
  });
});
