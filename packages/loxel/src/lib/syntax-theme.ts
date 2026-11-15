/**
 * Syntax colors of a Loxel theme: its base's TextMate theme (loxel-themes.ts) with the theme's
 * role colors (`SYNTAX_ROLES`) appended as rules over the role's scopes, which outrank the base's
 * rules for the same scopes. A theme without syntax colors uses its base's TextMate theme as is.
 *
 * A theme with syntax colors has a TextMate theme name of its own, which editor-themes.ts reloads
 * when its colors change.
 */
import type { ThemeRegistrationRaw } from "shiki";
import { create } from "zustand";

import { type LoxelTheme, SYNTAX_ROLES, type SyntaxRole, type ThemeBase } from "./loxel-theme";
import { loxelDark, loxelLight } from "./loxel-themes";

export const BASE_TEXTMATE: Record<ThemeBase, ThemeRegistrationRaw> = {
  light: loxelLight,
  dark: loxelDark,
};

type TextmateRule = ThemeRegistrationRaw["settings"][number];

function ruleScopes(rule: TextmateRule): string[] {
  if (!rule.scope) return [];
  return Array.isArray(rule.scope) ? rule.scope : [rule.scope];
}

/** The color the base theme gives a role: its first scope's, or the default text color. */
function baseRoleColor(base: ThemeBase, syntaxRole: SyntaxRole): string | undefined {
  const rules = BASE_TEXTMATE[base].settings;
  const [first] = syntaxRole.scopes;
  const matches = first
    ? rules.filter((r) => ruleScopes(r).includes(first) && r.settings.foreground)
    : rules.filter((r) => !r.scope && r.settings.foreground);
  return matches.at(-1)?.settings.foreground?.toLowerCase();
}

/** Every role's color in a base theme, which a theme's syntax colors override. */
export function baseSyntaxColors(base: ThemeBase): Record<string, string> {
  const fallback = baseRoleColor(base, SYNTAX_ROLES[0]!) ?? "#808080";
  return Object.fromEntries(SYNTAX_ROLES.map((r) => [r.id, baseRoleColor(base, r) ?? fallback]));
}

/** The theme's role colors as hex (`toHex` resolves other CSS colors), in role order. */
function roleOverrides(theme: LoxelTheme, toHex: (color: string) => string) {
  return SYNTAX_ROLES.flatMap((r) => {
    const color = theme.syntax[r.id];
    return color ? [{ role: r, color: toHex(color) }] : [];
  });
}

/**
 * The TextMate theme name a theme's syntax colors use: its base's when it sets none, else one of
 * its own, stable across edits (Monaco theme names allow only letters, digits and `-`).
 */
export function syntaxThemeName(theme: LoxelTheme): string {
  if (Object.keys(theme.syntax).length === 0) return BASE_TEXTMATE[theme.base].name ?? theme.base;
  return `loxel-theme-${theme.id.replaceAll(/[^a-z\d-]+/gi, "-")}`;
}

/** The font style the base theme gives a scope, which its override keeps. */
function baseFontStyle(rules: readonly TextmateRule[], scope: string): string | undefined {
  return rules.findLast((r) => ruleScopes(r).includes(scope) && r.settings.fontStyle !== undefined)
    ?.settings.fontStyle;
}

/**
 * The TextMate theme for a theme's syntax colors; its base's when it sets none. Overridden scopes
 * leave the base's rules and get rules of their own, with the base's font style: Monaco's TextMate
 * bridge maps a token's color and style back to the first rule that has them, so a base rule left
 * on an overridden scope would pull every other token of the old color onto that scope.
 */
export function syntaxTextmateTheme(
  theme: LoxelTheme,
  toHex: (color: string) => string,
): ThemeRegistrationRaw {
  const base = BASE_TEXTMATE[theme.base];
  const overrides = roleOverrides(theme, toHex);
  if (overrides.length === 0) return base;
  const text = overrides.find(({ role: r }) => r.scopes.length === 0)?.color;
  const colorByScope = new Map(
    overrides.flatMap(({ role: r, color }) => r.scopes.map((scope) => [scope, color] as const)),
  );
  const baseRules = base.settings.flatMap((rule): TextmateRule[] => {
    if (!rule.scope) {
      return text && rule.settings.foreground
        ? [{ ...rule, settings: { ...rule.settings, foreground: text } }]
        : [rule];
    }
    const scopes = ruleScopes(rule);
    const kept = scopes.filter((scope) => !colorByScope.has(scope));
    if (kept.length === scopes.length) return [rule];
    return kept.length > 0 ? [{ ...rule, scope: kept }] : [];
  });
  // One rule per color and font style.
  const groups = new Map<string, { color: string; fontStyle?: string; scopes: string[] }>();
  for (const [scope, color] of colorByScope) {
    const fontStyle = baseFontStyle(base.settings, scope);
    const key = `${color}|${fontStyle ?? ""}`;
    const group = groups.get(key) ?? {
      color,
      ...(fontStyle === undefined ? {} : { fontStyle }),
      scopes: [],
    };
    group.scopes.push(scope);
    groups.set(key, group);
  }
  const overrideRules = [...groups.values()].map(({ color, fontStyle, scopes }): TextmateRule => ({
    scope: scopes,
    settings: fontStyle === undefined ? { foreground: color } : { foreground: color, fontStyle },
  }));
  return {
    ...base,
    name: syntaxThemeName(theme),
    colors: text ? { ...base.colors, "editor.foreground": text } : base.colors,
    settings: [...baseRules, ...overrideRules],
  };
}

/** Monaco semantic token rules for a theme's role colors, to append after the base's. */
export function semanticOverrideRules(
  theme: LoxelTheme,
  toHex: (color: string) => string,
): { token: string; foreground: string }[] {
  return roleOverrides(theme, toHex).flatMap(({ role: r, color }) =>
    r.semantic.map((tokenType) => ({ token: tokenType, foreground: color.replace(/^#/, "") })),
  );
}

/** Theme names highlighted code paints with, set once the highlighter has loaded them. */
export interface SyntaxThemeNames {
  /** Light mode's editors and read-only code. */
  light: string;
  /** Dark mode's editors. */
  dark: string;
  /** Dark mode's read-only code: github-dark, unless the dark theme sets syntax colors. */
  readOnlyDark: string;
}

export interface SyntaxThemeState extends SyntaxThemeNames {
  /** Counts reloads of a theme under the same name, after its syntax colors changed. */
  revision: number;
}

export const useSyntaxThemeStore = create<SyntaxThemeState>(() => ({
  light: BASE_TEXTMATE.light.name ?? "loxel-light",
  dark: BASE_TEXTMATE.dark.name ?? "loxel-dark",
  readOnlyDark: "github-dark",
  revision: 0,
}));

/** The names for a light-mode and a dark-mode theme. */
export function syntaxThemeNames(light: LoxelTheme, dark: LoxelTheme): SyntaxThemeNames {
  const darkName = syntaxThemeName(dark);
  return {
    light: syntaxThemeName(light),
    dark: darkName,
    readOnlyDark: Object.keys(dark.syntax).length > 0 ? darkName : "github-dark",
  };
}

/**
 * The theme read-only highlighted code (diff hunks, file previews, log context) paints with: the
 * light-mode theme's syntax colors, and in dark mode `readOnlyDark`. `revision` changes when the
 * theme's colors change under the same name, so highlighting that depends on it should rerun.
 */
export function useReadOnlyCodeTheme(darkMode: boolean): { theme: string; revision: number } {
  const theme = useSyntaxThemeStore((s) => (darkMode ? s.readOnlyDark : s.light));
  const revision = useSyntaxThemeStore((s) => s.revision);
  return { theme, revision };
}
