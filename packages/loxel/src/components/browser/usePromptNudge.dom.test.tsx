import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { stubElectronAPI } from "@/test/electron-api-stub";

import { usePromptNudge } from "./usePromptNudge";

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe("usePromptNudge", () => {
  test("highlights the prompts of the panel whose page was refused, and no other panel's", () => {
    let refused: (webContentsId: unknown) => void = () => {};
    const unsubscribe = mock(() => {});
    window.electronAPI = stubElectronAPI({
      onExclusiveAccessRefused: (callback) => {
        refused = callback;
        return unsubscribe;
      },
    });
    const animate = mock((..._args: unknown[]) => {});
    const otherAnimate = mock((..._args: unknown[]) => {});
    const prompts = { current: { animate } as unknown as HTMLElement };
    const otherPrompts = { current: { animate: otherAnimate } as unknown as HTMLElement };
    const panel = renderHook(() => usePromptNudge(7, prompts));
    const other = renderHook(() => usePromptNudge(8, otherPrompts));

    refused(7);
    refused("7");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(otherAnimate).not.toHaveBeenCalled();

    panel.unmount();
    other.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
