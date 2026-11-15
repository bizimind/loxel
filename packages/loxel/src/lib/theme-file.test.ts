import { describe, expect, test } from "bun:test";

import type { LoxelTheme } from "./loxel-theme";
import { parseThemeFile, serializeTheme, ThemeFileError, themeFileName } from "./theme-file";

const harbor: LoxelTheme = {
  id: "custom:1",
  name: "Harbor Night",
  base: "dark",
  colors: { "editor-surface": "#0f1a2b" },
  terminal: { red: "#e8676b" },
  syntax: { keyword: "#5fa8e8" },
};

describe("theme.json", () => {
  test("an exported theme imports as the same theme, without its id", () => {
    const { id: _, ...theme } = harbor;
    expect(parseThemeFile("x.json", serializeTheme(harbor))).toEqual({ theme, ignored: [] });
  });

  test("the export is versioned and holds only what the theme changes", () => {
    expect(JSON.parse(serializeTheme(harbor))).toEqual({
      loxelTheme: 1,
      name: "Harbor Night",
      base: "dark",
      colors: { "editor-surface": "#0f1a2b" },
      terminal: { red: "#e8676b" },
      syntax: { keyword: "#5fa8e8" },
    });
    expect(themeFileName({ ...harbor, name: "Harbor / Night: 2" })).toBe(
      "Harbor  Night 2.theme.json",
    );
  });

  test("ignores unknown names and invalid colors, and says which", () => {
    const file = JSON.stringify({
      loxelTheme: 1,
      base: "light",
      colors: { foreground: "#111", glow: "#fff", border: "red; } *{" },
      terminal: { background: "#000", red: "#f00" },
      syntax: "nope",
    });
    const { theme, ignored } = parseThemeFile("Paper Day.theme.json", file);
    expect(theme).toEqual({
      name: "Paper Day",
      base: "light",
      colors: { foreground: "#111" },
      terminal: { red: "#f00" },
      syntax: {},
    });
    expect(ignored).toEqual(["colors.glow", "colors.border", "terminal.background", "syntax"]);
  });

  test("rejects files that are not themes this Loxel reads", () => {
    const reject = (text: string, message: string) =>
      expect(() => parseThemeFile("t.json", text)).toThrow(new ThemeFileError(message));
    reject("{", "t.json is not a Loxel theme: it is not valid JSON.");
    reject('{"name": "x"}', "t.json is not a Loxel theme (theme.json).");
    reject(
      '{"loxelTheme": 2, "base": "dark"}',
      "t.json is a Loxel theme of a version this Loxel does not read; update Loxel to import it.",
    );
    reject('{"loxelTheme": 1}', 't.json has no "base" of "light" or "dark".');
    reject(" ".repeat(300 * 1024), "t.json is too large to be a Loxel theme.");
  });
});
