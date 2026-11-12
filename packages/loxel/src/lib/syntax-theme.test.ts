import { describe, expect, test } from "bun:test";

import type { LoxelTheme } from "./loxel-theme";
import { loxelDark } from "./loxel-themes";
import {
  baseSyntaxColors,
  semanticOverrideRules,
  syntaxTextmateTheme,
  syntaxThemeName,
  syntaxThemeNames,
} from "./syntax-theme";

const identity = (color: string) => color;
const plain: LoxelTheme = {
  id: "custom:1",
  name: "Plain",
  base: "dark",
  colors: {},
  terminal: {},
  syntax: {},
};
const keywords: LoxelTheme = { ...plain, syntax: { keyword: "#ff0000", text: "#eeeeee" } };

describe("syntax themes", () => {
  test("a theme without syntax colors uses its base's TextMate theme", () => {
    expect(syntaxThemeName(plain)).toBe("loxel-dark");
    expect(syntaxTextmateTheme(plain, identity)).toBe(loxelDark);
    expect(syntaxThemeNames(plain, plain).readOnlyDark).toBe("github-dark");
  });

  test("overridden scopes leave the base's rules for rules of their own, under the theme's name", () => {
    const theme = syntaxTextmateTheme(keywords, identity);
    expect(theme.name).toBe("loxel-theme-custom-1");
    const scopes = (rule: (typeof theme.settings)[number]) =>
      rule.scope === undefined ? [] : Array.isArray(rule.scope) ? rule.scope : [rule.scope];
    const withKeyword = theme.settings.filter((rule) => scopes(rule).includes("keyword"));
    expect(withKeyword).toEqual([
      {
        scope: expect.arrayContaining(["keyword", "storage.type"]),
        settings: { foreground: "#ff0000" },
      },
    ]);
    expect(theme.settings.filter((rule) => !rule.scope)).toEqual([
      { settings: { foreground: "#eeeeee" } },
    ]);
    // Scopes no role overrides keep the base's rules.
    expect(theme.settings).toContainEqual(
      loxelDark.settings.find((r) => scopes(r).includes("string"))!,
    );
    expect(syntaxThemeNames(plain, keywords).readOnlyDark).toBe("loxel-theme-custom-1");
  });

  test("an override keeps the base's font style for each of its scopes", () => {
    const comments = syntaxTextmateTheme({ ...plain, syntax: { comment: "#00ff00" } }, identity);
    const overrides = comments.settings.filter((rule) => rule.settings.foreground === "#00ff00");
    expect(overrides).toEqual([
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#00ff00" } },
      {
        scope: ["comment.block.documentation"],
        settings: { foreground: "#00ff00", fontStyle: "italic" },
      },
    ]);
  });

  test("a theme's name stays the same as its colors change", () => {
    expect(syntaxThemeName({ ...plain, syntax: { keyword: "#000001" } })).toBe(
      syntaxThemeName({ ...plain, syntax: { keyword: "#000002" } }),
    );
  });

  test("role colors recolor the role's semantic token types", () => {
    expect(semanticOverrideRules(keywords, identity)).toEqual([
      { token: "variable", foreground: "eeeeee" },
      { token: "parameter", foreground: "eeeeee" },
      { token: "variable.readonly.local", foreground: "eeeeee" },
      { token: "keyword", foreground: "ff0000" },
    ]);
  });

  test("a role's default is its base theme's color", () => {
    const colors = baseSyntaxColors("dark");
    expect(colors.comment).toBe("#7a7e85");
    expect(colors.keyword).toBe("#6da0cf");
    expect(colors.text).toBe("#bcbec4");
    expect(baseSyntaxColors("light").string).toBe("#1f7a2b");
  });
});
