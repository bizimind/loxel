import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FONT_SETTINGS,
  type FontSettings,
  fontCssVariables,
  quoteFontFamily,
  resolveFont,
} from "./font-settings";

function fonts(overrides: Partial<FontSettings>): FontSettings {
  return { ...structuredClone(DEFAULT_FONT_SETTINGS), ...overrides };
}

describe("resolveFont", () => {
  test("uses the bundled stacks by default", () => {
    expect(resolveFont(DEFAULT_FONT_SETTINGS, "code")).toEqual({
      family: null,
      stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      size: 13,
    });
    expect(resolveFont(DEFAULT_FONT_SETTINGS, "terminal")).toEqual({
      family: null,
      stack: '"JetBrains Mono NL", monospace',
      size: 13,
    });
    expect(resolveFont(DEFAULT_FONT_SETTINGS, "prose").stack).toStartWith('"Inter", system-ui');
  });

  test("puts the chosen family in front of the bundled stack", () => {
    const code = resolveFont(fonts({ code: { family: "Fira Code", size: 14 } }), "code");
    expect(code.stack).toBe(
      '"Fira Code", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    );
    expect(code.size).toBe(14);
  });

  test("the terminal follows the code font until it has its own", () => {
    const followed = fonts({ code: { family: "Fira Code", size: 15 } });
    expect(resolveFont(followed, "terminal")).toEqual({
      family: "Fira Code",
      stack: '"Fira Code", "JetBrains Mono NL", monospace',
      size: 15,
    });
    const own = { ...followed, terminal: { family: "Menlo", size: 18 } };
    expect(resolveFont(own, "terminal")).toEqual({
      family: "Menlo",
      stack: '"Menlo", "JetBrains Mono NL", monospace',
      size: 18,
    });
  });

  test("keeps sizes within the surface's bounds", () => {
    expect(resolveFont(fonts({ code: { family: null, size: 40 } }), "code").size).toBe(16);
    expect(resolveFont(fonts({ prose: { family: null, size: 2 } }), "prose").size).toBe(12);
    expect(resolveFont(fonts({ code: { family: null, size: Number.NaN } }), "code").size).toBe(10);
  });
});

test("quoteFontFamily escapes quotes and backslashes", () => {
  expect(quoteFontFamily('My "Odd" \\ Font')).toBe('"My \\"Odd\\" \\\\ Font"');
});

test("fontCssVariables exposes the code and prose fonts", () => {
  const vars = fontCssVariables(fonts({ prose: { family: "Georgia", size: 17 } }));
  expect(vars["--loxel-font-code-size"]).toBe("13px");
  expect(vars["--loxel-font-prose"]).toStartWith('"Georgia", "Inter"');
  expect(vars["--loxel-font-prose-size"]).toBe("17px");
});
