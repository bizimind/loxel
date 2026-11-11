import { describe, expect, test } from "bun:test";

import { ANSI_COLOR_NAMES } from "./terminal-color-schemes";
import { parseTerminalSchemeFile, SchemeImportError } from "./terminal-scheme-import";

/** The names of the schemes a file holds. */
function names(fileName: string, text: string): string[] {
  return parseTerminalSchemeFile(fileName, text).schemes.map((s) => s.name);
}

/** The file's only scheme. */
function parseOne(fileName: string, text: string) {
  const { schemes, skipped } = parseTerminalSchemeFile(fileName, text);
  expect(skipped).toEqual([]);
  expect(schemes).toHaveLength(1);
  const [scheme] = schemes;
  if (!scheme) throw new Error("no scheme");
  return scheme;
}

/** 16 distinct colors: #000000, #111111, … #ffffff. */
const hexAt = (i: number) => `#${i.toString(16).repeat(6)}`;
const HEX = ANSI_COLOR_NAMES.map((_, i) => hexAt(i));

function itermColor(hex: string, colorSpace = "sRGB"): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return `<dict>
    <key>Alpha Component</key><real>1</real>
    <key>Blue Component</key><real>${b}</real>
    <key>Color Space</key><string>${colorSpace}</string>
    <key>Green Component</key><real>${g}</real>
    <key>Red Component</key><real>${r}</real>
  </dict>`;
}

function itermFile(suffixes: string[] = [""], extra = ""): string {
  const entries = suffixes.flatMap((suffix) => [
    ...HEX.map((hex, i) => `<key>Ansi ${i} Color${suffix}</key>${itermColor(hex)}`),
    `<key>Background Color${suffix}</key>${itermColor("#102030")}`,
    `<key>Foreground Color${suffix}</key>${itermColor("#f0e0d0")}`,
    `<key>Cursor Color${suffix}</key>${itermColor("#ff0000")}`,
    `<key>Selection Color${suffix}</key>${itermColor("#334455")}`,
    `<key>Bold Color${suffix}</key>${itermColor("#ffffff")}`,
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- exported by iTerm2 -->
<plist version="1.0">
<dict>
  ${entries.join("\n  ")}${extra}
  <key>Use Bright Bold</key><true/>
</dict>
</plist>`;
}

function windowsTerminalScheme(name = "Campbell"): Record<string, string> {
  const scheme: Record<string, string> = {
    name,
    background: "#0C0C0C",
    foreground: "#CCC",
    cursorColor: "#FFFFFF",
    selectionBackground: "#FFFFFF80",
  };
  const wtKeys: Record<string, string> = { magenta: "purple", brightMagenta: "brightPurple" };
  ANSI_COLOR_NAMES.forEach((color, i) => {
    scheme[wtKeys[color] ?? color] = hexAt(i);
  });
  return scheme;
}

describe("parseTerminalSchemeFile", () => {
  describe("iTerm2", () => {
    test("reads the ANSI, background, foreground, cursor and selection colors", () => {
      const scheme = parseOne("Solar Flare.itermcolors", itermFile());
      expect(scheme.name).toBe("Solar Flare");
      expect(ANSI_COLOR_NAMES.map((c) => scheme.palette[c])).toEqual(HEX);
      expect(scheme.palette.background).toBe("#102030");
      expect(scheme.palette.foreground).toBe("#f0e0d0");
      expect(scheme.palette.cursor).toBe("#ff0000");
      expect(scheme.palette.selection).toBe("#334455");
    });

    test("a file with only light and dark mode colors becomes one scheme per mode", () => {
      const file = itermFile([" (Light)", " (Dark)"]);
      expect(names("Duo.itermcolors", file)).toEqual(["Duo (Light)", "Duo (Dark)"]);
    });

    test("with separate light and dark colors on, the per-mode colors win over the plain ones", () => {
      const separate = `<key>Use Separate Colors for Light and Dark Mode</key><true/>`;
      const file = itermFile(["", " (Light)", " (Dark)"], separate);
      expect(names("Duo.itermcolors", file)).toEqual(["Duo (Light)", "Duo (Dark)"]);
    });

    test("with separate colors off, the plain colors are the scheme", () => {
      expect(names("Duo.itermcolors", itermFile(["", " (Light)", " (Dark)"]))).toEqual(["Duo"]);
    });

    test("converts P3 colors to sRGB", () => {
      const file = itermFile().replace(
        /<key>Background Color<\/key><dict>[\s\S]*?<\/dict>/,
        `<key>Background Color</key>${itermColor("#ff0000", "P3")}`,
      );
      // P3 red is outside sRGB: it clips to pure red, with green and blue at 0.
      expect(parseOne("p3.itermcolors", file).palette.background).toBe("#ff0000");
      const mid = itermFile().replace(
        /<key>Background Color<\/key><dict>[\s\S]*?<\/dict>/,
        `<key>Background Color</key>${itermColor("#808080", "P3")}`,
      );
      // Greys are the same in both spaces.
      expect(parseOne("p3.itermcolors", mid).palette.background).toBe("#808080");
    });

    test("names the colors a file lacks", () => {
      const xml = itermFile().replace(/<key>Ansi 9 Color<\/key>/, "<key>Unused</key>");
      expect(() => parseTerminalSchemeFile("Broken.itermcolors", xml)).toThrow(
        "Broken is missing colors: brightRed.",
      );
    });

    test("rejects a property list without ANSI colors", () => {
      const xml = `<?xml version="1.0"?><plist version="1.0"><dict><key>a</key><string>b</string></dict></plist>`;
      expect(() => parseTerminalSchemeFile("prefs.plist", xml)).toThrow(SchemeImportError);
    });

    test("rejects malformed XML", () => {
      expect(() => parseTerminalSchemeFile("x.itermcolors", "<plist><dict><key>a</key>")).toThrow(
        "x.itermcolors is not a valid property list.",
      );
    });
  });

  describe("Windows Terminal", () => {
    test("reads a scheme object, with purple as magenta and colors normalized", () => {
      const scheme = parseOne("c.json", JSON.stringify(windowsTerminalScheme()));
      expect(scheme.name).toBe("Campbell");
      expect(ANSI_COLOR_NAMES.map((c) => scheme.palette[c])).toEqual(HEX);
      expect(scheme.palette.background).toBe("#0c0c0c");
      expect(scheme.palette.foreground).toBe("#cccccc");
      expect(scheme.palette.cursor).toBe("#ffffff");
      expect(scheme.palette.selection).toBe("#ffffff80");
    });

    test("reads every scheme of a settings.json, comments and trailing commas included", () => {
      const settings = `{
        // Windows Terminal settings
        "profiles": {},
        "schemes": [${JSON.stringify(windowsTerminalScheme("One"))}, ${JSON.stringify(windowsTerminalScheme("Two"))},],
      }`;
      expect(names("settings.json", settings)).toEqual(["One", "Two"]);
    });

    test("reads an array of schemes", () => {
      const json = JSON.stringify([windowsTerminalScheme("A"), windowsTerminalScheme("B")]);
      expect(names("s.json", json)).toEqual(["A", "B"]);
    });

    test("keeps the complete schemes of a file and says why the others were skipped", () => {
      const { red: _, ...broken } = windowsTerminalScheme("Broken");
      const json = JSON.stringify([windowsTerminalScheme("Good"), broken]);
      const { schemes, skipped } = parseTerminalSchemeFile("s.json", json);
      expect(schemes.map((s) => s.name)).toEqual(["Good"]);
      expect(skipped).toEqual(["Broken is missing colors: red."]);
    });

    test("defaults the cursor to the foreground and the selection to a translucent foreground", () => {
      const { cursorColor: _, selectionBackground: __, ...rest } = windowsTerminalScheme();
      const scheme = parseOne("c.json", JSON.stringify(rest));
      expect(scheme.palette.cursor).toBe("#cccccc");
      expect(scheme.palette.selection).toBe("#cccccc4d");
    });

    test("names the file when the scheme has no name", () => {
      const { name: _, ...rest } = windowsTerminalScheme();
      const scheme = parseOne("/x/Night Owl.json", JSON.stringify(rest));
      expect(scheme.name).toBe("Night Owl");
    });

    test("rejects a scheme missing colors or with invalid ones", () => {
      const scheme = { ...windowsTerminalScheme(), red: "not-a-color", background: undefined };
      expect(() => parseTerminalSchemeFile("c.json", JSON.stringify(scheme))).toThrow(
        "Campbell is missing colors: red, background.",
      );
    });
  });

  describe("VS Code", () => {
    function vscodeTheme(colors: Record<string, string>) {
      return JSON.stringify({ name: "Quiet Light", type: "light", colors, tokenColors: [] });
    }
    const ansi = Object.fromEntries(
      ANSI_COLOR_NAMES.map((c, i) => [
        `terminal.ansi${c.charAt(0).toUpperCase()}${c.slice(1)}`,
        hexAt(i),
      ]),
    );

    test("reads the terminal colors", () => {
      const scheme = parseOne(
        "quiet.json",
        vscodeTheme({
          ...ansi,
          "terminal.foreground": "#333333",
          "terminal.background": "#f5f5f5",
          "terminalCursor.foreground": "#5f5f5fcc",
          "terminal.selectionBackground": "#c9d0d9aa",
        }),
      );
      expect(scheme.name).toBe("Quiet Light");
      expect(ANSI_COLOR_NAMES.map((c) => scheme.palette[c])).toEqual(HEX);
      expect(scheme.palette).toMatchObject({
        foreground: "#333333",
        background: "#f5f5f5",
        cursor: "#5f5f5f",
        selection: "#c9d0d9aa",
      });
    });

    test("falls back to the editor's foreground, background and selection", () => {
      const scheme = parseOne(
        "t.json",
        vscodeTheme({
          ...ansi,
          "editor.foreground": "#111",
          "editor.background": "#eee",
          "editor.selectionBackground": "#add6ff",
        }),
      );
      expect(scheme.palette).toMatchObject({
        foreground: "#111111",
        background: "#eeeeee",
        selection: "#add6ff",
      });
    });

    test("rejects a theme without terminal colors", () => {
      expect(() =>
        parseTerminalSchemeFile("t.json", vscodeTheme({ "editor.background": "#fff" })),
      ).toThrow("t.json is a VS Code theme without terminal colors.");
    });

    test("reads a settings.json's color customizations, for all themes and per theme", () => {
      const colors = { ...ansi, "terminal.foreground": "#eeeeee", "terminal.background": "#000" };
      const settings = `{
        "editor.fontSize": 13, // a user's own settings
        "workbench.colorCustomizations": {
          ${JSON.stringify(colors).slice(1, -1)},
          "[Solar Dusk]": ${JSON.stringify(colors)},
          "[Plain]": { "editor.background": "#fff" },
        },
      }`;
      expect(names("settings.json", settings)).toEqual(["settings", "Solar Dusk"]);
    });

    test("rejects a settings.json without terminal color customizations", () => {
      const settings = JSON.stringify({
        "workbench.colorCustomizations": { "editor.background": "#fff" },
      });
      expect(() => parseTerminalSchemeFile("settings.json", settings)).toThrow(
        "settings.json sets no VS Code terminal colors.",
      );
    });
  });

  test("rejects files that are not color schemes", () => {
    expect(() => parseTerminalSchemeFile("a.json", "{ not json")).toThrow(SchemeImportError);
    expect(() => parseTerminalSchemeFile("a.json", '{"editor.fontSize": 12}')).toThrow(
      "a.json is not a Windows Terminal color scheme or a VS Code color theme.",
    );
    expect(() => parseTerminalSchemeFile("a.json", "[]")).toThrow(
      "a.json contains no color schemes.",
    );
    expect(() => parseTerminalSchemeFile("big.json", " ".repeat(2 * 1024 * 1024))).toThrow(
      "big.json is too large to be a color scheme.",
    );
  });
});
