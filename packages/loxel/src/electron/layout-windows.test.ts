import { describe, expect, test } from "bun:test";

import { LayoutWindows } from "./layout-windows";

describe("LayoutWindows", () => {
  test("a window closed outside a quit is promoted on its own, at once", () => {
    const windows = new LayoutWindows();
    windows.opened("a");
    windows.opened("b");
    expect(windows.closed("a", false)).toEqual(["a"]);
    expect(windows.takeQuitPromotes()).toEqual([]);
    expect(windows.openWindowIds()).toEqual(["b"]);
  });

  test("a quit promotes its windows together, the one used last at the end", () => {
    const windows = new LayoutWindows();
    windows.opened("main");
    windows.opened("second");
    windows.opened("third");
    windows.focused("main");
    windows.focused("third");
    // Electron's close order says nothing about which window was used last.
    expect(windows.closed("third", true)).toEqual([]);
    expect(windows.closed("main", true)).toEqual([]);
    expect(windows.closed("second", true)).toEqual([]);
    expect(windows.takeQuitPromotes()).toEqual(["second", "main", "third"]);
    expect(windows.takeQuitPromotes()).toEqual([]);
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
    windows.closed("b", true);
    windows.focused("b");
    windows.closed("a", true);
    expect(windows.takeQuitPromotes()).toEqual(["a", "b"]);
  });
});
