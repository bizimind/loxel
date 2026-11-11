import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  putStore: jest.fn(async () => ({ success: true })),
}));
// Only Appearance matters here; the other sections load data the test has no server for.
const empty = () => null;
mock.module("./EditorSection", () => ({ EditorSection: empty }));
mock.module("./FileAssociationsSection", () => ({ FileAssociationsSection: empty }));
mock.module("./GeneralSection", () => ({ GeneralSection: empty }));
mock.module("./KeybindingsSection", () => ({ KeybindingsSection: empty }));
mock.module("./LayoutSection", () => ({ LayoutSection: empty }));
mock.module("./SchemasSection", () => ({ SchemasSection: empty }));
mock.module("./SecuritySection", () => ({ SecuritySection: empty }));
mock.module("./TerminalSection", () => ({ TerminalSection: empty }));
mock.module("@/lib/schema-sync", () => ({ syncSchemas: () => {} }));

const { useSettingsStore } = await import("@/store/settings-store");
const { SettingsModal } = await import("./SettingsModal");

afterEach(() => {
  cleanup();
  act(() => useSettingsStore.setState({ theme: "dark", isOpen: false }));
});

describe("SettingsModal", () => {
  test("Cancel restores the theme picked while it was open", () => {
    render(<SettingsModal />);
    act(() => useSettingsStore.getState().openSettings("appearance"));

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(useSettingsStore.getState().theme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(useSettingsStore.getState().isOpen).toBe(false);
  });

  test("Save keeps it", () => {
    render(<SettingsModal />);
    act(() => useSettingsStore.getState().openSettings("appearance"));

    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useSettingsStore.getState().theme).toBe("system");
  });
});
