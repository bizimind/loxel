import { afterEach, describe, expect, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { stubElectronAPI } from "@/test/electron-api-stub";

import { useWindowFullScreen } from "./useWindowFullScreen";

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe("useWindowFullScreen", () => {
  test("is false outside Electron", () => {
    const { result } = renderHook(() => useWindowFullScreen());
    expect(result.current).toBe(false);
  });

  test("starts fullscreen when the window opens into a fullscreen space", () => {
    window.electronAPI = stubElectronAPI({ isFullScreen: () => true });
    const { result } = renderHook(() => useWindowFullScreen());
    expect(result.current).toBe(true);
  });

  test("follows fullscreen changes and unsubscribes on unmount", () => {
    let listener: ((fullScreen: boolean) => void) | null = null;
    window.electronAPI = stubElectronAPI({
      isFullScreen: () => false,
      onWindowFullScreenChange: (callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    });
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
