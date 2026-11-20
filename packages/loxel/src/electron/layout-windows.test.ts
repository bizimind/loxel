import { describe, expect, test } from "bun:test";

import { LayoutWindows } from "./layout-windows";

describe("LayoutWindows", () => {
  test("a window closed outside a quit is promoted on its own, at once", () => {
    const windows = new LayoutWindows();
    windows.opened("a");
    windows.opened("b");
    expect(windows.closed("a", false)).toEqual(["a"]);
    expect(windows.takeHeld()).toEqual([]);
    expect(windows.openWindowIds()).toEqual(["b"]);
  });

  test("a quit promotes its windows together as the last closes, the one used last at the end", () => {
    const windows = new LayoutWindows();
    windows.opened("main");
    windows.opened("second");
    windows.opened("third");
    windows.focused("main");
    windows.focused("third");
    // Electron's close order says nothing about which window was used last.
    expect(windows.closed("third", true)).toEqual([]);
    expect(windows.closed("main", true)).toEqual([]);
    expect(windows.closed("second", true)).toEqual(["second", "main", "third"]);
    expect(windows.takeHeld()).toEqual([]);
  });

  test("focus while a quit closes the windows does not reorder them", () => {
    const windows = new LayoutWindows();
    windows.opened("first");
    windows.opened("used-last");
    expect(windows.closed("used-last", true)).toEqual([]);
    // macOS makes the remaining window key as the other closes.
    windows.focused("first");
    expect(windows.closed("first", true)).toEqual(["first", "used-last"]);
  });

  test("a window closed after a quit that did not happen promotes the held ones first", () => {
    const windows = new LayoutWindows();
    windows.opened("a");
    windows.opened("b");
    windows.opened("c");
    expect(windows.closed("a", true)).toEqual([]);
    expect(windows.closed("c", false)).toEqual(["a", "c"]);
    // The quit is over: focus counts again.
    windows.focused("b");
    expect(windows.closed("b", false)).toEqual(["b"]);
  });

  test("open windows are every one not yet closed", () => {
    const windows = new LayoutWindows();
    expect(windows.openWindowIds()).toEqual([]);
    windows.opened("a");
    windows.opened("b");
    windows.closed("b", true);
    expect(windows.openWindowIds()).toEqual(["a"]);
  });

  test("focus of a window already closed changes nothing", () => {
    const windows = new LayoutWindows();
    windows.opened("a");
    windows.opened("b");
    windows.closed("b", false);
    windows.focused("b");
    expect(windows.closed("a", true)).toEqual(["a"]);
  });
});
