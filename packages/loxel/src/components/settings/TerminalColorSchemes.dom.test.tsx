import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  putStore: jest.fn(async () => ({ success: true })),
}));

const { TerminalColorSchemes } = await import("./TerminalColorSchemes");
const { useSettingsStore } = await import("@/store/settings-store");
const { ANSI_COLOR_NAMES, DEFAULT_TERMINAL_COLOR_SCHEMES } =
  await import("@/lib/terminal-color-schemes");

function windowsTerminalScheme(name: string): string {
  const wtKeys: Record<string, string> = { magenta: "purple", brightMagenta: "brightPurple" };
  const colors = Object.fromEntries(
    ANSI_COLOR_NAMES.map((c, i) => [wtKeys[c] ?? c, `#${i.toString(16).repeat(6)}`]),
  );
  return JSON.stringify({ name, foreground: "#eeeeee", background: "#101010", ...colors });
}

function pickFiles(...files: File[]) {
  fireEvent.change(screen.getByTestId("terminal-scheme-file"), { target: { files } });
}

beforeEach(() => {
  useSettingsStore
    .getState()
    .updateTerminal({ colorSchemes: structuredClone(DEFAULT_TERMINAL_COLOR_SCHEMES) });
});

afterEach(cleanup);

describe("TerminalColorSchemes", () => {
  test("each theme shows its default scheme", () => {
    render(<TerminalColorSchemes />);
    expect(screen.getByLabelText<HTMLSelectElement>("Light theme").value).toBe("loxel-light");
    expect(screen.getByLabelText<HTMLSelectElement>("Dark theme").value).toBe("loxel-dark");
  });

  test("an imported scheme can be picked for a theme and removed again", async () => {
    render(<TerminalColorSchemes />);
    pickFiles(new File([windowsTerminalScheme("Night Owl")], "night-owl.json"));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported Night Owl.");

    const dark = screen.getByLabelText<HTMLSelectElement>("Dark theme");
    const option = screen.getAllByRole<HTMLOptionElement>("option", { name: "Night Owl" })[1];
    fireEvent.change(dark, { target: { value: option?.value } });
    const { colorSchemes } = useSettingsStore.getState().terminal;
    expect(colorSchemes.dark).toBe(colorSchemes.imported[0]!.id);
    expect(colorSchemes.light).toBe("loxel-light");

    fireEvent.click(screen.getByRole("button", { name: "Remove Night Owl" }));
    expect(useSettingsStore.getState().terminal.colorSchemes).toEqual(
      DEFAULT_TERMINAL_COLOR_SCHEMES,
    );
    expect(dark.value).toBe("loxel-dark");
  });

  test("a file without a usable palette is rejected with the reason, the others imported", async () => {
    render(<TerminalColorSchemes />);
    pickFiles(
      new File(['{"colors": {"editor.background": "#fff"}}'], "plain.json"),
      new File([windowsTerminalScheme("Dusk")], "dusk.json"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "plain.json is a VS Code theme without terminal colors. Imported Dusk.",
    );
    expect(useSettingsStore.getState().terminal.colorSchemes.imported.map((s) => s.name)).toEqual([
      "Dusk",
    ]);
  });

  test("a file that can't be read is reported, not dropped silently", async () => {
    render(<TerminalColorSchemes />);
    const gone = new File(["{}"], "moved.json");
    Object.defineProperty(gone, "text", {
      value: async () => Promise.reject(new DOMException("gone", "NotReadableError")),
    });
    pickFiles(gone);
    expect(await screen.findByRole("alert")).toHaveTextContent("moved.json could not be read.");
  });
});
