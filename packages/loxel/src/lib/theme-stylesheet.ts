/**
 * Applies the chosen themes' UI colors: a stylesheet that restates the overridden tokens of the
 * light-mode theme under the light selectors of index.css and those of the dark-mode theme under
 * `.dark`, with higher specificity, so every surface (including a `.light` or `.dark` subtree, such
 * as a markdown editor's portal) follows. The CSS is cached for index.html to apply before first
 * paint, as theme-cache.ts does for the mode.
 *
 * `readThemeTokens` reads any theme's resolved token values, applied or not, from a probe element
 * the stylesheet skips: the theme editor's swatches, the terminal background and Monaco's chrome.
 */
import { isThemeColor, type LoxelTheme } from "./loxel-theme";

const STYLE_ELEMENT_ID = "loxel-theme";
/** index.html's inline script reads the same key before first paint; keep the two in step. */
const CSS_CACHE_KEY = "loxel-theme-css";
const PROBE_ATTRIBUTE = "data-theme-probe";

function declarations(theme: LoxelTheme): string {
  return Object.entries(theme.colors)
    .filter(([, value]) => isThemeColor(value))
    .map(([name, value]) => `--${name}: ${value.trim()};`)
    .join(" ");
}

/** The stylesheet for a light-mode and a dark-mode theme; empty when neither overrides a token. */
export function themeStylesheet(light: LoxelTheme, dark: LoxelTheme): string {
  const rules: string[] = [];
  const lightDeclarations = declarations(light);
  const darkDeclarations = declarations(dark);
  if (lightDeclarations) {
    rules.push(`:root:not(.dark), .light:not([${PROBE_ATTRIBUTE}]) { ${lightDeclarations} }`);
  }
  if (darkDeclarations) rules.push(`.dark:not([${PROBE_ATTRIBUTE}]) { ${darkDeclarations} }`);
  return rules.join("\n");
}

/** Apply the two themes' UI colors to this window, and cache them for the next launch. */
export function applyThemeStylesheet(light: LoxelTheme, dark: LoxelTheme): void {
  const css = themeStylesheet(light, dark);
  let style = document.getElementById(STYLE_ELEMENT_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    document.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
  try {
    if (css) localStorage.setItem(CSS_CACHE_KEY, css);
    else localStorage.removeItem(CSS_CACHE_KEY);
  } catch {
    // Storage unavailable: the next launch paints the base colors until the settings load.
  }
}

/**
 * A theme's resolved token values, by token name without `--` (`var()` references resolved). Read
 * from a probe carrying the theme's base class and its overrides inline, which the applied
 * stylesheet skips, so any theme reads the same whether or not it is applied.
 */
export function readThemeTokens(
  theme: LoxelTheme,
  names: readonly string[],
): Record<string, string> {
  const probe = document.createElement("div");
  probe.className = theme.base;
  probe.setAttribute(PROBE_ATTRIBUTE, "");
  probe.hidden = true;
  for (const [name, value] of Object.entries(theme.colors)) {
    if (isThemeColor(value)) probe.style.setProperty(`--${name}`, value.trim());
  }
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const values = Object.fromEntries(
    names.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
  );
  probe.remove();
  return values;
}
