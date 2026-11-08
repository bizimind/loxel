import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { registerBrowserPanelTarget } from "@/lib/browser-panel-targets";
import { normalizeKeyBinding } from "@/store/keybindings/key-combo";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";
import { stubElectronAPI } from "@/test/electron-api-stub";

import { useKeybindings } from "./useKeybindings";

function Harness() {
  useKeybindings();
  return null;
}

afterEach(() => {
  cleanup();
  useKeybindingStore.getState().resetAllOverrides();
  delete window.electronAPI;
});

describe("useKeybindings in Electron", () => {
  test("uses the webview keystroke APIs", () => {
    const setKeystrokeInterception = mock();
    const onWebviewFocused = mock(() => () => {});
    window.electronAPI = stubElectronAPI({ setKeystrokeInterception, onWebviewFocused });
    render(<Harness />);
    expect(setKeystrokeInterception).toHaveBeenCalled();
    expect(onWebviewFocused).toHaveBeenCalledTimes(1);
  });
});

describe("webview keystroke interception", () => {
  test("takes ⇧⌘R from the page only while a browser panel holds focus", () => {
    const sent: { combos: string[] }[] = [];
    window.electronAPI = stubElectronAPI({
      setKeystrokeInterception: (interception) => {
        sent.push(interception);
      },
    });
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
    const unregister = registerBrowserPanelTarget(root, {
      hardRefresh: () => {},
      toggleBookmark: () => {},
    });
    expect(intercepted()).toBe(true);

    unregister();
    root.remove();
    expect(intercepted()).toBe(false);
  });
});

describe("macOS window tiling shortcuts", () => {
  /** Press `init` in a widget with its own keydown listener; returns whether the widget saw it. */
  function pressInWidget(macOSVersion: string | undefined, init: KeyboardEventInit) {
    window.electronAPI = stubElectronAPI({ macOSVersion });
    render(<Harness />);
    const widget = document.createElement("textarea");
    document.body.append(widget);
    // Like a real widget, it consumes the keys it sees (and keeps them from Monaco's document
    // listeners loaded by this module graph, which throw outside a real editor).
    const widgetKeydown = mock((e: Event) => e.stopPropagation());
    widget.addEventListener("keydown", widgetKeydown);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    widget.dispatchEvent(event);
    widget.remove();
    return { widgetSawKey: widgetKeydown.mock.calls.length > 0, prevented: event.defaultPrevented };
  }

  test("keeps fn⌃← (Ctrl+Home) from widgets but leaves it unhandled for the Window menu", () => {
    expect(pressInWidget("15.0.0", { key: "Home", code: "Home", ctrlKey: true })).toEqual({
      widgetSawKey: false,
      prevented: false,
    });
  });

  test("still delivers Ctrl+Arrow and Ctrl+F to widgets", () => {
    for (const init of [
      { key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true },
      { key: "f", code: "KeyF", ctrlKey: true },
    ]) {
      expect(pressInWidget("15.0.0", init).widgetSawKey).toBe(true);
      cleanup();
    }
  });

  test("a user binding on Ctrl+Home still takes the key", () => {
    useKeybindingStore.getState().setOverride("toggle.logs", [normalizeKeyBinding("Ctrl+Home")]);
    expect(pressInWidget("15.0.0", { key: "Home", code: "Home", ctrlKey: true })).toEqual({
      widgetSawKey: false,
      prevented: true,
    });
  });

  test("delivers Ctrl+Home to widgets before macOS 15", () => {
    expect(pressInWidget("14.6.0", { key: "Home", code: "Home", ctrlKey: true }).widgetSawKey).toBe(
      true,
    );
  });
});
