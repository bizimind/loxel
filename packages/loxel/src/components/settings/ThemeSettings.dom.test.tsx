import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  putStore: jest.fn(async () => ({ success: true })),
}));
const downloadTextFile = jest.fn();
mock.module("@/lib/download-file", () => ({ downloadTextFile }));

const { ThemeSettings } = await import("./ThemeSettings");
const { useSettingsStore } = await import("@/store/settings-store");
const { ANSI_COLOR_NAMES, DEFAULT_THEME_SETTINGS } = await import("@/lib/loxel-theme");

const themes = () => useSettingsStore.getState().themes;

function pick(testId: string, ...files: File[]) {
  fireEvent.change(screen.getByTestId(testId), { target: { files } });
}

function themeFile(name: string, base: "light" | "dark") {
  const text = JSON.stringify({ loxelTheme: 1, name, base, colors: { foreground: "#111111" } });
  return new File([text], `${name}.theme.json`);
}

beforeEach(() => {
  useSettingsStore.setState({ themes: structuredClone(DEFAULT_THEME_SETTINGS) });
  downloadTextFile.mockClear();
});

afterEach(cleanup);

describe("ThemeSettings", () => {
  test("each mode offers only the themes of its base", () => {
    useSettingsStore
      .getState()
      .importTheme({ name: "Dusk", base: "dark", colors: {}, terminal: {}, syntax: {} });
    render(<ThemeSettings />);
    const light = screen.getByLabelText<HTMLSelectElement>("Light mode");
    const dark = screen.getByLabelText<HTMLSelectElement>("Dark mode");
    expect([...light.options].map((o) => o.text)).toEqual(["Loxel Light"]);
    expect([...dark.options].map((o) => o.text)).toEqual(["Loxel Dark", "Dusk"]);
    expect(dark.value).toBe(themes().dark);
  });

  test("duplicating a built-in opens the copy to edit; colors and names change live", () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Loxel Light" }));
    const [copy] = themes().custom;
    expect(copy?.name).toBe("Loxel Light copy");
    expect(themes().light).toBe(copy!.id);

    const editor = screen.getByRole("region", { name: "Edit Loxel Light copy" });
    const name = within(editor).getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Paper Day" } });
    fireEvent.blur(name);
    const text = within(editor).getByLabelText("Text value");
    fireEvent.change(text, { target: { value: "#222222" } });
    fireEvent.blur(text);
    const keyword = within(editor).getByLabelText("Keywords value");
    fireEvent.change(keyword, { target: { value: "red; }" } });
    fireEvent.blur(keyword);
    expect(themes().custom[0]).toMatchObject({
      name: "Paper Day",
      colors: { foreground: "#222222" },
      syntax: {},
    });

    fireEvent.click(within(editor).getByRole("button", { name: "Reset Text" }));
    expect(themes().custom[0]?.colors).toEqual({});
  });

  test("a theme.json imports as its mode's theme; another file is rejected with the reason", async () => {
    render(<ThemeSettings />);
    pick("theme-file", themeFile("Harbor Night", "dark"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Imported Harbor Night, now the dark mode theme.",
    );
    expect(themes().custom.map((t) => t.name)).toEqual(["Harbor Night"]);
    expect(themes().dark).toBe(themes().custom[0]!.id);

    pick("theme-file", new File(['{"colors": {}}'], "vscode.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent("vscode.json is not a Loxel theme");
  });

  test("export writes the theme's theme.json", () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Export Loxel Dark" }));
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [fileName, text] = downloadTextFile.mock.calls[0] as [string, string];
    expect(fileName).toBe("Loxel Dark.theme.json");
    expect(JSON.parse(text)).toMatchObject({ loxelTheme: 1, name: "Loxel Dark", base: "dark" });
  });

  test("a terminal scheme file sets the edited theme's ANSI colors only", async () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Loxel Dark" }));
    const wtKeys: Record<string, string> = { magenta: "purple", brightMagenta: "brightPurple" };
    const scheme = Object.fromEntries(
      ANSI_COLOR_NAMES.map((c, i) => [wtKeys[c] ?? c, `#${i.toString(16).repeat(6)}`]),
    );
    const file = new File(
      [JSON.stringify({ name: "Night Owl", background: "#011627", ...scheme })],
      "owl.json",
    );
    pick("terminal-scheme-file", file);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Took the ANSI colors of Night Owl.",
    );
    const terminal = themes().custom[0]?.terminal ?? {};
    expect(Object.keys(terminal).sort()).toEqual([...ANSI_COLOR_NAMES].sort());
    expect(terminal.red).toBe("#111111");
  });

  test("removing the theme a mode uses puts the mode back on its built-in", () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Loxel Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Loxel Dark copy" }));
    expect(themes()).toEqual(DEFAULT_THEME_SETTINGS);
    expect(screen.queryByRole("region", { name: /^Edit/ })).toBeNull();
  });
});
