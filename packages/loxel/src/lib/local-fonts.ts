/**
 * The fonts installed on this machine, for the font pickers in Settings.
 *
 * The list identifies the machine as well as any fingerprint, so it never leaves the renderer:
 * it is not logged, persisted or sent anywhere. Only the family the user picks is saved.
 */

import { quoteFontFamily } from "./font-settings";

export type LocalFontsResult =
  | { status: "ok"; families: string[] }
  /** The Local Font Access API is missing (Safari, Firefox) or the permission was refused. */
  | { status: "unavailable" };

/**
 * The font families installed on this machine, sorted by name. Call it from a click handler:
 * outside Loxel's window a browser asks for the permission only with a user gesture, and the call
 * must start before the handler's first `await` to keep it.
 */
export async function queryLocalFontFamilies(): Promise<LocalFontsResult> {
  const query: unknown = Reflect.get(window, "queryLocalFonts");
  if (typeof query !== "function") return { status: "unavailable" };
  let fonts: unknown;
  try {
    fonts = await Reflect.apply(query, window, []);
  } catch {
    // NotAllowedError (no user gesture, a frame the permissions policy excludes) or SecurityError.
    return { status: "unavailable" };
  }
  if (!Array.isArray(fonts)) return { status: "unavailable" };
  const families = new Set<string>();
  for (const font of fonts) {
    const family: unknown =
      typeof font === "object" && font !== null && "family" in font ? font.family : undefined;
    // A leading dot marks macOS system fonts that apps are not meant to name.
    if (typeof family === "string" && family && !family.startsWith(".")) families.add(family);
  }
  // Blink answers a refused permission with an empty list rather than an error.
  if (families.size === 0) return { status: "unavailable" };
  return { status: "ok", families: [...families].sort((a, b) => a.localeCompare(b)) };
}

let measureContext: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number | null {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return null;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

const monospaceCache = new Map<string, boolean>();

/**
 * Whether a family's narrow and wide glyphs have the same advance. The fallback is proportional,
 * so a family that is missing or lacks these glyphs is not taken for a monospace one.
 */
export function isMonospaceFamily(family: string): boolean {
  const cached = monospaceCache.get(family);
  if (cached !== undefined) return cached;
  const font = `16px ${quoteFontFamily(family)}, serif`;
  const narrow = textWidth("iiiiiiiiii", font);
  const wide = textWidth("MMMMMMMMMM", font);
  const monospace = narrow !== null && wide !== null && Math.abs(narrow - wide) < 0.5;
  monospaceCache.set(family, monospace);
  return monospace;
}

const PROBE_TEXT = "mmmmmmmmmmlli1WQ@#";

/**
 * Whether the family renders on this machine: a bundled face, or an installed font that changes
 * the width of a probe text from both generic fallbacks. Works without the font permission.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const bundled = [...document.fonts].some((face) => face.family.replaceAll('"', "") === family);
  if (bundled) return true;
  return ["monospace", "serif"].some((generic) => {
    const withFamily = textWidth(PROBE_TEXT, `16px ${quoteFontFamily(family)}, ${generic}`);
    const genericOnly = textWidth(PROBE_TEXT, `16px ${generic}`);
    // Without a canvas there is nothing to measure with; do not claim the font is missing.
    return withFamily === null || genericOnly === null || withFamily !== genericOnly;
  });
}
