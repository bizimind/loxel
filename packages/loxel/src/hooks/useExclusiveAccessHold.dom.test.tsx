import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { stubElectronAPI } from "@/test/electron-api-stub";

import { useExclusiveAccessHold } from "./useExclusiveAccessHold";

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe("useExclusiveAccessHold", () => {
  test("tells main when the window's first modal opens and its last one closes", () => {
    const setExclusiveAccessHold = mock((_held: boolean) => {});
    window.electronAPI = stubElectronAPI({ setExclusiveAccessHold });
    const first = renderHook(({ open }) => useExclusiveAccessHold(open), {
      initialProps: { open: false },
    });
    expect(setExclusiveAccessHold).not.toHaveBeenCalled();
    first.rerender({ open: true });
    const second = renderHook(() => useExclusiveAccessHold(true));
    expect(setExclusiveAccessHold.mock.calls).toEqual([[true]]);
    first.rerender({ open: false });
    expect(setExclusiveAccessHold.mock.calls).toEqual([[true]]);
    second.unmount();
    expect(setExclusiveAccessHold.mock.calls).toEqual([[true], [false]]);
  });
});
