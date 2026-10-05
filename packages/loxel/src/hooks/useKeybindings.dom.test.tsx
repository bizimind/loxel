import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

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
