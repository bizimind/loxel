import { afterEach, describe, expect, test } from "bun:test";

import { requestQuickPick, requestTextInput, useCommandPaletteStore } from "./command-palette";

const items = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta", description: "/path/b" },
];

afterEach(() => useCommandPaletteStore.getState().close());

describe("requestQuickPick", () => {
  test("opens with a loading list, fills it, and resolves with the chosen id", async () => {
    let fill: (value: typeof items) => void = () => {};
    const picked = requestQuickPick({
      placeholder: "Pick",
      items: new Promise((resolve) => {
        fill = resolve;
      }),
    });
    const opened = useCommandPaletteStore.getState();
    expect(opened.isOpen).toBe(true);
    expect(opened.mode).toMatchObject({ kind: "pick", placeholder: "Pick", items: null });

    fill(items);
    await Promise.resolve();
    expect(useCommandPaletteStore.getState().mode).toMatchObject({ items });

    useCommandPaletteStore.getState().submit("b");
    expect(await picked).toBe("b");
    expect(useCommandPaletteStore.getState()).toMatchObject({
      isOpen: false,
      mode: { kind: "commands" },
    });
  });

  test("shows a failed load as an error", async () => {
    void requestQuickPick({ placeholder: "Pick", items: Promise.reject(new Error("offline")) });
    await Promise.resolve();
    await Promise.resolve();
    expect(useCommandPaletteStore.getState().mode).toMatchObject({
      kind: "pick",
      error: "offline",
    });
  });

  test("resolves null when dismissed or replaced", async () => {
    const dismissed = requestQuickPick({ placeholder: "Pick", items: Promise.resolve(items) });
    useCommandPaletteStore.getState().close();
    expect(await dismissed).toBeNull();

    const replaced = requestQuickPick({ placeholder: "Pick", items: Promise.resolve(items) });
    const input = requestTextInput({ placeholder: "Path", value: "/usr/bin/python3" });
    expect(await replaced).toBeNull();
    // The replaced pick's items arriving late do not touch the input.
    await Promise.resolve();
    expect(useCommandPaletteStore.getState()).toMatchObject({
      query: "/usr/bin/python3",
      mode: { kind: "input", placeholder: "Path" },
    });

    useCommandPaletteStore.getState().submit("/opt/python");
    expect(await input).toBe("/opt/python");
  });

  test("opening the command list dismisses a pending request", async () => {
    const pending = requestTextInput({ placeholder: "Path" });
    useCommandPaletteStore.getState().open();
    expect(await pending).toBeNull();
    expect(useCommandPaletteStore.getState().mode).toEqual({ kind: "commands" });
  });
});
