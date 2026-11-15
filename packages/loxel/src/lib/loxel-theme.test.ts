import { describe, expect, test } from "bun:test";

import {
  DEFAULT_THEME_SETTINGS,
  isThemeColor,
  type LoxelTheme,
  parseThemeSettings,
  resolveTheme,
  terminalColors,
  uiTokensFor,
  xtermColorOptions,
} from "./loxel-theme";

const harbor: LoxelTheme = {
  id: "custom:1",
  name: "Harbor Night",
  base: "dark",
  colors: { "editor-surface": "#0f1a2b" },
  terminal: { red: "#e8676b", foreground: "#d4dcea" },
  syntax: { keyword: "#5fa8e8" },
};

describe("resolveTheme", () => {
  test("defaults to Loxel Light and Loxel Dark", () => {
    expect(resolveTheme(DEFAULT_THEME_SETTINGS, false).id).toBe("loxel-light");
    expect(resolveTheme(DEFAULT_THEME_SETTINGS, true).id).toBe("loxel-dark");
  });

  test("each mode uses its own choice", () => {
    const settings = { light: "loxel-light", dark: harbor.id, custom: [harbor] };
    expect(resolveTheme(settings, true)).toBe(harbor);
    expect(resolveTheme(settings, false).id).toBe("loxel-light");
  });

  test("a choice naming no theme, or one of the other base, falls back to the mode's built-in", () => {
    const settings = { light: harbor.id, dark: "custom:gone", custom: [harbor] };
    expect(resolveTheme(settings, false).id).toBe("loxel-light");
    expect(resolveTheme(settings, true).id).toBe("loxel-dark");
  });
});

describe("terminal colors", () => {
  test("a theme's terminal colors override its base's", () => {
    const colors = terminalColors(harbor);
    expect(colors.red).toBe("#e8676b");
    expect(colors.green).toBe("#a8c023");
    expect(colors.cursor).toBe("#ced0d6");
  });

  test("xterm draws on the given surface; the light base keeps its minimum contrast", () => {
    const dark = xtermColorOptions(harbor, "#0f1a2b");
    expect(dark.theme).toMatchObject({
      background: "#0f1a2b",
      cursorAccent: "#0f1a2b",
      foreground: "#d4dcea",
      selectionBackground: "rgba(255, 255, 255, 0.18)",
    });
    expect(dark.minimumContrastRatio).toBe(1);
    expect(
      xtermColorOptions(resolveTheme(DEFAULT_THEME_SETTINGS, false), "#fff").minimumContrastRatio,
    ).toBe(4.5);
  });
});

test("dark themes do not offer the tokens only the light base draws", () => {
  const names = (base: "light" | "dark") => uiTokensFor(base).map((t) => t.name);
  expect(names("light")).toContain("vcs-modified");
  expect(names("dark")).not.toContain("vcs-modified");
  expect(names("dark")).toContain("editor-surface");
});

test("isThemeColor accepts colors and nothing that could break out of a declaration", () => {
  for (const color of [
    "#fff",
    "#0f1a2bcc",
    "rgba(255, 255, 255, 0.18)",
    "oklch(0.46 0.18 290)",
    "transparent",
  ]) {
    expect(isThemeColor(color)).toBe(true);
  }
  for (const value of [
    "red; } body {",
    "var(--x)",
    "url(x)",
    "rgb(1,2,3);",
    "",
    7,
    "expression(alert(1))",
  ]) {
    expect(isThemeColor(value)).toBe(false);
  }
});

describe("parseThemeSettings", () => {
  test("valid settings come back as the same object", () => {
    const settings = { light: "loxel-light", dark: harbor.id, custom: [harbor] };
    expect(parseThemeSettings(settings)).toBe(settings);
  });

  test("missing settings take the defaults", () => {
    expect(parseThemeSettings(undefined)).toEqual(DEFAULT_THEME_SETTINGS);
  });

  test("drops malformed themes and invalid colors, and fixes malformed choices", () => {
    const parsed = parseThemeSettings({
      light: 7,
      dark: harbor.id,
      custom: [
        { ...harbor, colors: { ...harbor.colors, border: "red; }", "not-a-token": "#fff" } },
        { ...harbor, id: "custom:2", base: "sepia" },
        { ...harbor, id: "loxel-dark" },
        "junk",
      ],
    });
    expect(parsed).toEqual({ light: "loxel-light", dark: harbor.id, custom: [harbor] });
  });
});
