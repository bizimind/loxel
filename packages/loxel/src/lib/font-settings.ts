/**
 * The fonts the user picks in Settings > Fonts. A family is only a name: settings move between
 * machines, so every stack is built here at runtime with the bundled font and a generic family
 * behind the user's choice, which covers a font missing on this machine and glyphs it lacks.
 */

/** A font for one surface. A null family uses the bundled font. */
export interface FontChoice {
  family: string | null;
  size: number;
}

export interface FontSettings {
  /** Code editors and markdown code blocks. */
  code: FontChoice;
  /** Terminals. A null family or size follows the code font. */
  terminal: { family: string | null; size: number | null };
  /** Markdown body text and headings. */
  prose: FontChoice;
}

export type FontKind = keyof FontSettings;

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  code: { family: null, size: 13 },
  terminal: { family: null, size: null },
  prose: { family: null, size: 16 },
};

/**
 * Size bounds per surface. Code stays within the editors' fixed 22px line height, which the diff
 * view's gutters and the frontmatter editor's height are laid out on.
 */
export const FONT_SIZE_LIMITS: Record<FontKind, { min: number; max: number }> = {
  code: { min: 10, max: 16 },
  terminal: { min: 8, max: 32 },
  prose: { min: 12, max: 24 },
};

/** The bundled family each surface uses when the user has not picked one. */
export const BUNDLED_FONT_FAMILY: Record<FontKind, string> = {
  code: "JetBrains Mono",
  // Without ligatures: a terminal draws each cell on its own.
  terminal: "JetBrains Mono NL",
  prose: "Literata",
};

const FALLBACK_STACK: Record<FontKind, string> = {
  code: `${quoteFontFamily(BUNDLED_FONT_FAMILY.code)}, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`,
  terminal: `${quoteFontFamily(BUNDLED_FONT_FAMILY.terminal)}, monospace`,
  prose: `${quoteFontFamily(BUNDLED_FONT_FAMILY.prose)}, "Iowan Old Style", Georgia, serif`,
};

/** The generic family a font picker previews a row's font over. */
export const GENERIC_FAMILY: Record<FontKind, string> = {
  code: "monospace",
  terminal: "monospace",
  prose: "serif",
};

export interface ResolvedFont {
  /** The family the user picked, or null for the bundled one. */
  family: string | null;
  /** A CSS `font-family` value. */
  stack: string;
  /** In pixels. */
  size: number;
}

/** Quote a family name for a CSS `font-family` value. */
export function quoteFontFamily(family: string): string {
  return `"${family.replaceAll(/["\\]/g, "\\$&")}"`;
}

function resolve(kind: FontKind, family: string | null, size: number): ResolvedFont {
  const { min, max } = FONT_SIZE_LIMITS[kind];
  const fallback = FALLBACK_STACK[kind];
  return {
    family,
    stack: family ? `${quoteFontFamily(family)}, ${fallback}` : fallback,
    size: Number.isFinite(size) ? Math.min(max, Math.max(min, Math.round(size))) : min,
  };
}

export function resolveFont(fonts: FontSettings, kind: FontKind): ResolvedFont {
  if (kind === "terminal") {
    const { terminal, code } = fonts;
    return resolve(kind, terminal.family ?? code.family, terminal.size ?? code.size);
  }
  const { family, size } = fonts[kind];
  return resolve(kind, family, size);
}

/**
 * The CSS variables the stylesheets read the fonts from (the markdown editor; DOM widgets drawn
 * over code). Monaco and xterm take the resolved values as options instead.
 */
export function fontCssVariables(fonts: FontSettings): Record<string, string> {
  const code = resolveFont(fonts, "code");
  const prose = resolveFont(fonts, "prose");
  return {
    "--loxel-font-code": code.stack,
    "--loxel-font-code-size": `${code.size}px`,
    "--loxel-font-prose": prose.stack,
    "--loxel-font-prose-size": `${prose.size}px`,
  };
}
