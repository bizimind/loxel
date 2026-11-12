import { expect, test } from "bun:test";

import type { LoxelTheme } from "./loxel-theme";
import { themeStylesheet } from "./theme-stylesheet";

const theme = (base: "light" | "dark", colors: Record<string, string>): LoxelTheme => ({
  id: `custom:${base}`,
  name: base,
  base,
  colors,
  terminal: {},
  syntax: {},
});

test("built-in themes add no styles", () => {
  expect(themeStylesheet(theme("light", {}), theme("dark", {}))).toBe("");
});

test("each mode's overrides go under its selectors, skipping probes and invalid colors", () => {
  const css = themeStylesheet(
    theme("light", { foreground: "#111111" }),
    theme("dark", { "editor-surface": "#0f1a2b", border: "red; } body {" }),
  );
  expect(css).toBe(
    [
      ":root:not(.dark), .light:not([data-theme-probe]) { --foreground: #111111; }",
      ".dark:not([data-theme-probe]) { --editor-surface: #0f1a2b; }",
    ].join("\n"),
  );
});
