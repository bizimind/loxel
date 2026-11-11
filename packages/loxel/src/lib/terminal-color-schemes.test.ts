import { describe, expect, test } from "bun:test";

import {
  BUILTIN_TERMINAL_COLOR_SCHEMES,
  DEFAULT_TERMINAL_COLOR_SCHEMES,
  LOXEL_DARK_SCHEME_ID,
  LOXEL_LIGHT_SCHEME_ID,
  parseTerminalColorSchemeSettings,
  resolveTerminalColorScheme,
  type TerminalColorScheme,
  xtermColorOptions,
} from "./terminal-color-schemes";

function builtin(id: string): TerminalColorScheme {
  const scheme = BUILTIN_TERMINAL_COLOR_SCHEMES.find((s) => s.id === id);
  if (!scheme) throw new Error(`no built-in scheme ${id}`);
  return scheme;
}
const loxelDark = builtin(LOXEL_DARK_SCHEME_ID);
const imported: TerminalColorScheme = {
  id: "imported:1",
  name: "Night",
  palette: { ...loxelDark.palette, background: "#001122" },
};

describe("resolveTerminalColorScheme", () => {
  test("defaults to Loxel Light and Loxel Dark", () => {
    expect(resolveTerminalColorScheme(DEFAULT_TERMINAL_COLOR_SCHEMES, false).id).toBe(
      LOXEL_LIGHT_SCHEME_ID,
    );
    expect(resolveTerminalColorScheme(DEFAULT_TERMINAL_COLOR_SCHEMES, true).id).toBe(
      LOXEL_DARK_SCHEME_ID,
    );
  });

  test("each theme uses its own choice, built-in or imported", () => {
    const settings = { light: LOXEL_DARK_SCHEME_ID, dark: imported.id, imported: [imported] };
    expect(resolveTerminalColorScheme(settings, false).id).toBe(LOXEL_DARK_SCHEME_ID);
    expect(resolveTerminalColorScheme(settings, true)).toBe(imported);
  });

  test("a choice naming no scheme falls back to the theme's default", () => {
    const settings = { light: "imported:gone", dark: "imported:gone", imported: [] };
    expect(resolveTerminalColorScheme(settings, false).id).toBe(LOXEL_LIGHT_SCHEME_ID);
    expect(resolveTerminalColorScheme(settings, true).id).toBe(LOXEL_DARK_SCHEME_ID);
  });
});

describe("xtermColorOptions", () => {
  test("Loxel Light keeps its minimum contrast; other schemes draw their colors as set", () => {
    const light = resolveTerminalColorScheme(DEFAULT_TERMINAL_COLOR_SCHEMES, false);
    expect(xtermColorOptions(light).minimumContrastRatio).toBe(4.5);
    expect(xtermColorOptions(loxelDark).minimumContrastRatio).toBe(1);
    expect(xtermColorOptions(imported).minimumContrastRatio).toBe(1);
  });

  test("maps the palette to xterm's theme, the cursor accent on the background", () => {
    const { theme } = xtermColorOptions(imported);
    expect(theme).toMatchObject({
      background: "#001122",
      cursorAccent: "#001122",
      selectionBackground: imported.palette.selection,
      brightMagenta: imported.palette.brightMagenta,
    });
    expect(theme).not.toHaveProperty("selection");
  });
});

describe("parseTerminalColorSchemeSettings", () => {
  test("valid settings come back as the same object", () => {
    const settings = { light: LOXEL_LIGHT_SCHEME_ID, dark: imported.id, imported: [imported] };
    expect(parseTerminalColorSchemeSettings(settings)).toBe(settings);
  });

  test("missing settings take the defaults", () => {
    expect(parseTerminalColorSchemeSettings(undefined)).toEqual(DEFAULT_TERMINAL_COLOR_SCHEMES);
  });

  test("drops imported schemes without a complete palette and fixes malformed choices", () => {
    const { brightWhite: _, ...partial } = imported.palette;
    const parsed = parseTerminalColorSchemeSettings({
      light: 7,
      dark: imported.id,
      imported: [imported, { id: "imported:2", name: "Broken", palette: partial }, "junk"],
    });
    expect(parsed).toEqual({
      light: LOXEL_LIGHT_SCHEME_ID,
      dark: imported.id,
      imported: [imported],
    });
  });
});
