import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { registerHardRefreshTarget } from "@/lib/hard-refresh-targets";

import { useKeybindings } from "./useKeybindings";

function Harness() {
  useKeybindings();
  return null;
}

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe("useKeybindings with an older app bundle", () => {
  // In-app updates replace the renderer but not the preload, so newer renderers must tolerate a
  // preload without the webview keystroke APIs.
  test("mounts when the preload predates the webview keystroke APIs", () => {
    window.electronAPI = {
      onOpenInBrowserTab: () => () => {},
      setDockBadge: () => {},
      onWindowFocusChange: () => () => {},
      openFolderDialog: async () => null,
    };
    expect(() => render(<Harness />)).not.toThrow();
  });

  test("uses the webview keystroke APIs when the preload has them", () => {
    const setKeystrokeInterception = mock();
    const onWebviewFocused = mock(() => () => {});
    window.electronAPI = {
      onOpenInBrowserTab: () => () => {},
      setDockBadge: () => {},
      onWindowFocusChange: () => () => {},
      openFolderDialog: async () => null,
      setKeystrokeInterception,
      onWebviewKeystroke: () => () => {},
      onWebviewFocused,
    };
    render(<Harness />);
    expect(setKeystrokeInterception).toHaveBeenCalled();
    expect(onWebviewFocused).toHaveBeenCalledTimes(1);
  });
});

describe("webview keystroke interception", () => {
  test("takes ⇧⌘R from the page only while a browser panel holds focus", () => {
    const sent: { combos: string[] }[] = [];
    window.electronAPI = {
      onOpenInBrowserTab: () => () => {},
      setDockBadge: () => {},
      onWindowFocusChange: () => () => {},
      openFolderDialog: async () => null,
      setKeystrokeInterception: (interception) => sent.push(interception),
    };
    render(<Harness />);
    const intercepted = () => sent.at(-1)?.combos.includes("Cmd+Shift+R");
    // Nothing may have been sent yet: an unchanged interception set isn't re-sent.
    expect(intercepted()).not.toBe(true);

    // The panel mounts around a webview that already has focus: no focus event to re-sync on.
    const root = document.createElement("div");
    const webview = document.createElement("button");
    root.append(webview);
    document.body.append(root);
    webview.focus();
    const unregister = registerHardRefreshTarget(root, () => {});
    expect(intercepted()).toBe(true);

    unregister();
    root.remove();
    expect(intercepted()).toBe(false);
  });
});
