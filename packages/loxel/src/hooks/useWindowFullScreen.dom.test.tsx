import { afterEach, describe, expect, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useWindowFullScreen } from "./useWindowFullScreen";

const baseElectronAPI = {
  onOpenInBrowserTab: () => () => {},
  setDockBadge: () => {},
  onWindowFocusChange: () => () => {},
  openFolderDialog: async () => null,
};

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe("useWindowFullScreen", () => {
  test("is false outside Electron", () => {
    const { result } = renderHook(() => useWindowFullScreen());
    expect(result.current).toBe(false);
  });

  // In-app updates replace the renderer but not the preload.
  test("is false when the preload predates the fullscreen APIs", () => {
    window.electronAPI = baseElectronAPI;
    const { result } = renderHook(() => useWindowFullScreen());
    expect(result.current).toBe(false);
  });

  test("starts fullscreen when the window opens into a fullscreen space", () => {
    window.electronAPI = { ...baseElectronAPI, isFullScreen: () => true };
    const { result } = renderHook(() => useWindowFullScreen());
    expect(result.current).toBe(true);
  });

  test("follows fullscreen changes and unsubscribes on unmount", () => {
    let listener: ((fullScreen: boolean) => void) | null = null;
    window.electronAPI = {
      ...baseElectronAPI,
      isFullScreen: () => false,
      onWindowFullScreenChange: (callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    };
    const { result, unmount } = renderHook(() => useWindowFullScreen());
    expect(result.current).toBe(false);

    act(() => listener?.(true));
    expect(result.current).toBe(true);
    act(() => listener?.(false));
    expect(result.current).toBe(false);

    unmount();
    expect(listener).toBeNull();
  });
});
