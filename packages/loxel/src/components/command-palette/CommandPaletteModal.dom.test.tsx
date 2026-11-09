import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, screen } from "@testing-library/react";

/** The code actions the focused editor's language servers offer, as the fake reports them. */
const offered = new Set<string>();
mock.module("@/lib/editor-code-actions", () => ({
  canRunEditorCodeAction: (id: string) => offered.has(id),
  runEditorCodeAction: () => {},
}));

const { CommandPaletteModal } = await import("./CommandPaletteModal");
const { useCommandPaletteStore } = await import("@/store/command-palette");

afterEach(() => {
  cleanup();
  offered.clear();
  act(() => useCommandPaletteStore.getState().close());
});

function openPalette() {
  render(<CommandPaletteModal />);
  act(() => useCommandPaletteStore.getState().open());
}

// Rows highlight the matched characters in separate elements and end with their keys.
const listed = (label: string) =>
  screen
    .queryAllByRole("button", { hidden: true })
    .some((row) => row.textContent?.startsWith(label));

describe("CommandPaletteModal", () => {
  test("lists the actions that apply where focus was when it opened", () => {
    offered.add("codeAction.quickFix");
    openPalette();
    expect(listed("Quick Fix…")).toBe(true);
    expect(listed("Refactor…")).toBe(false);
    expect(listed("Open Settings")).toBe(true);
  });

  test("keeps that list while the palette has focus", () => {
    offered.add("codeAction.fixAll");
    openPalette();
    // Focus is in the palette now, outside the editor.
    offered.clear();
    act(() => useCommandPaletteStore.getState().setQuery("fix"));
    expect(listed("Fix All")).toBe(true);
  });
});
