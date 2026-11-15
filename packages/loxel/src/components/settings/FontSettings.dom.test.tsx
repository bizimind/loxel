import { afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  putStore: jest.fn(async () => ({ success: true })),
}));

const { FontSettings } = await import("./FontSettings");
const { useSettingsStore } = await import("@/store/settings-store");
const { DEFAULT_FONT_SETTINGS } = await import("@/lib/font-settings");

const INSTALLED = ["Menlo", "Georgia", ".SF NS", "Courier New", "Menlo"];
const MONOSPACE = new Set(["Menlo", "Courier New"]);

/** A canvas whose text widths make the MONOSPACE families monospace and the rest proportional. */
function fakeMeasureContext() {
  return {
    font: "",
    measureText(text: string) {
      const monospace = [...MONOSPACE].some((family) => this.font.includes(`"${family}"`));
      const narrow = text.split("").filter((ch) => ch === "i").length;
      const width = text.length * 10 - (monospace ? 0 : narrow * 6);
      return { width };
    },
  };
}

beforeAll(() => {
  // No bundled faces: every family is checked against the canvas.
  Object.defineProperty(document, "fonts", { configurable: true, value: [] });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: fakeMeasureContext,
  });
});

function withLocalFonts(families: string[] | null) {
  if (families === null) {
    Reflect.deleteProperty(window, "queryLocalFonts");
    return;
  }
  Object.defineProperty(window, "queryLocalFonts", {
    configurable: true,
    value: async () => families.map((family) => ({ family })),
  });
}

function openPicker(label: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}:`) }));
  const dialog = document.querySelector("dialog[open]");
  if (!(dialog instanceof HTMLElement)) throw new Error("Font picker did not open");
  return dialog;
}

beforeEach(() => {
  useSettingsStore.setState({ fonts: structuredClone(DEFAULT_FONT_SETTINGS) });
});

afterEach(() => {
  cleanup();
  withLocalFonts(null);
});

describe("FontSettings", () => {
  test("the code font picker lists monospace fonts unless all are shown", async () => {
    withLocalFonts(INSTALLED);
    render(<FontSettings />);
    const dialog = openPicker("Code Font");
    await within(dialog).findByText("Menlo");
    expect(within(dialog).getByText("Courier New")).toBeInTheDocument();
    expect(within(dialog).queryByText("Georgia")).toBeNull();
    // Hidden macOS system fonts are left out.
    expect(within(dialog).queryByText(".SF NS")).toBeNull();

    fireEvent.click(within(dialog).getByRole("switch"));
    const names = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["JetBrains Mono (bundled)", "Courier New", "Menlo", "Georgia"]);

    fireEvent.click(within(dialog).getByText("Menlo"));
    expect(useSettingsStore.getState().fonts.code).toEqual({ family: "Menlo", size: 13 });
  });

  test("keys on the Show all switch stay on it", async () => {
    withLocalFonts(INSTALLED);
    useSettingsStore.getState().updateFont("code", { family: "Menlo" });
    render(<FontSettings />);
    const dialog = openPicker("Code Font");
    const toggle = await within(dialog).findByRole("switch");
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.keyDown(toggle, { key: " " });
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
    expect(useSettingsStore.getState().fonts.code.family).toBe("Menlo");
  });

  test("the current font comes first, so Enter on opening keeps it", async () => {
    withLocalFonts(INSTALLED);
    useSettingsStore.getState().updateFont("code", { family: "Menlo" });
    render(<FontSettings />);
    const dialog = openPicker("Code Font");
    await within(dialog).findByText("Courier New");
    const names = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Menlo", "JetBrains Mono (bundled)", "Courier New"]);
    fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Enter" });
    expect(useSettingsStore.getState().fonts.code.family).toBe("Menlo");
  });

  test("a typed name can be picked where fonts cannot be listed", async () => {
    withLocalFonts(null);
    render(<FontSettings />);
    const dialog = openPicker("Markdown Font");
    await within(dialog).findByText(/can't be listed/);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Iowan Old Style" } });
    fireEvent.click(within(dialog).getByText("Iowan Old Style"));
    expect(useSettingsStore.getState().fonts.prose.family).toBe("Iowan Old Style");
  });

  test("the terminal size follows the code size until set", () => {
    render(<FontSettings />);
    const terminalSize = screen.getByLabelText("Terminal Font size");
    expect(terminalSize).toHaveAttribute("placeholder", "13");
    fireEvent.change(terminalSize, { target: { value: "16" } });
    fireEvent.blur(terminalSize);
    expect(useSettingsStore.getState().fonts.terminal.size).toBe(16);
    fireEvent.change(terminalSize, { target: { value: "" } });
    fireEvent.blur(terminalSize);
    expect(useSettingsStore.getState().fonts.terminal.size).toBeNull();
  });

  test("a terminal font that isn't installed falls back to the bundled one", () => {
    useSettingsStore.getState().updateFont("code", { family: "Menlo" });
    useSettingsStore.getState().updateFont("terminal", { family: "Berkeley Mono" });
    render(<FontSettings />);
    expect(
      screen.getByText(
        /Berkeley Mono isn't installed on this computer\. Loxel shows JetBrains Mono NL instead\./,
      ),
    ).toBeInTheDocument();
  });

  test("resetting a font goes back to the default", () => {
    useSettingsStore.getState().updateFont("prose", { family: "Georgia" });
    render(<FontSettings />);
    fireEvent.click(screen.getByLabelText("Reset markdown font"));
    expect(useSettingsStore.getState().fonts.prose.family).toBeNull();
  });
});
