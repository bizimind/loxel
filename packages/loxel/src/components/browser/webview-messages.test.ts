import { describe, expect, mock, test } from "bun:test";

import { createWebviewRouter } from "./webview-messages";

type Item = { id: number };

describe("createWebviewRouter", () => {
  test("holds items until the webview's panel subscribes, then hands them over", () => {
    const router = createWebviewRouter<(item: Item) => void, Item>((listener, item) =>
      listener(item),
    );
    router.deliver(1, { id: 1 });
    router.deliver(2, { id: 2 });
    const panel = mock((_item: Item) => {});
    router.subscribe(1, panel);
    router.deliver(1, { id: 3 });
    expect(panel.mock.calls.map(([item]) => item.id)).toEqual([1, 3]);
  });

  test("keeps at most the newest items for a webview nobody claims", () => {
    const router = createWebviewRouter<(item: Item) => void, Item>(
      (listener, item) => listener(item),
      2,
    );
    for (const id of [1, 2, 3]) router.deliver(1, { id });
    const panel = mock((_item: Item) => {});
    router.subscribe(1, panel);
    expect(panel.mock.calls.map(([item]) => item.id)).toEqual([2, 3]);
  });

  test("withdraws held items, and returns the listener of a subscribed panel", () => {
    const router = createWebviewRouter<(item: Item) => void, Item>((listener, item) =>
      listener(item),
    );
    router.deliver(1, { id: 1 });
    router.deliver(1, { id: 2 });
    expect(router.withdraw(1, (item) => item.id === 1)).toBeUndefined();
    const panel = mock((_item: Item) => {});
    const unsubscribe = router.subscribe(1, panel);
    expect(panel.mock.calls.map(([item]) => item.id)).toEqual([2]);
    expect(router.withdraw(1, () => true)).toBe(panel);
    unsubscribe();
    expect(router.withdraw(1, () => true)).toBeUndefined();
  });

  test("an old panel unsubscribing leaves the panel that replaced it", () => {
    const router = createWebviewRouter<(item: Item) => void, Item>((listener, item) =>
      listener(item),
    );
    const old = router.subscribe(1, () => {});
    const replacement = mock((_item: Item) => {});
    router.subscribe(1, replacement);
    old();
    router.deliver(1, { id: 1 });
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
