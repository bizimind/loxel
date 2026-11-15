import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** The code actions the focused editor's language servers offer, as the fake reports them. */
const offered = new Set<string>();
mock.module("@/lib/editor-code-actions", () => ({
  canRunEditorCodeAction: (id: string) => offered.has(id),
  runEditorCodeAction: () => {},
}));

const { CommandPaletteModal } = await import("./CommandPaletteModal");
const { useCommandPaletteStore } = await import("@/store/command-palette");
const { useSettingsStore } = await import("@/store/settings-store");

afterEach(() => {
  cleanup();
  offered.clear();
  act(() => useCommandPaletteStore.getState().close());
  act(() => useSettingsStore.setState({ theme: "dark" }));
});

function openPalette() {
  render(<CommandPaletteModal />);
  act(() => useCommandPaletteStore.getState().open());
}

// Rows highlight the matched characters in separate elements and end with their keys.
const rowOf = (label: string) =>
  screen
    .queryAllByRole("button", { hidden: true })
    .find((row) => row.textContent?.startsWith(label));
const listed = (label: string) => rowOf(label) !== undefined;

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

  test("lists the theme choices with the current one checked, and switches the theme", async () => {
    act(() => useSettingsStore.setState({ theme: "system" }));
    openPalette();
    act(() => useCommandPaletteStore.getState().setQuery("theme"));
    const row = (label: string) => {
      const found = rowOf(label);
      if (!found) throw new Error(`${label} is not listed`);
      return found;
    };
    const current = (label: string) => row(label).querySelector('[aria-label="Current"]') !== null;
    expect(current("Theme: System")).toBe(true);
    expect(current("Theme: Dark")).toBe(false);
    expect(current("Theme: Light")).toBe(false);

    fireEvent.click(row("Theme: Light"));
    await waitFor(() => expect(useSettingsStore.getState().theme).toBe("light"));
  });
});
