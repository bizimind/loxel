import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useFirstLoadGate } from "./useFirstLoadGate";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("useFirstLoadGate", () => {
  test("gates while the first load is pending and releases when it settles", () => {
    const { result, rerender } = renderHook(({ pending }) => useFirstLoadGate(pending, 500), {
      initialProps: { pending: true },
    });
    expect(result.current).toBe(true);
    rerender({ pending: false });
    expect(result.current).toBe(false);
  });

  test("releases after the cap when the load hangs, and stays released", () => {
    const { result, rerender } = renderHook(({ pending }) => useFirstLoadGate(pending, 500), {
      initialProps: { pending: true },
    });
    act(() => jest.advanceTimersByTime(499));
    expect(result.current).toBe(true);
    act(() => jest.advanceTimersByTime(1));
    expect(result.current).toBe(false);
    rerender({ pending: false });
    rerender({ pending: true });
    expect(result.current).toBe(false);
  });

  test("never gates a later load", () => {
    const { result, rerender } = renderHook(({ pending }) => useFirstLoadGate(pending, 500), {
      initialProps: { pending: false },
    });
    rerender({ pending: true });
    expect(result.current).toBe(false);
  });
});
