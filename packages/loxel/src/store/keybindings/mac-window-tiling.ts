/**
 * macOS window tiling shortcuts that must reach the app's Window menu.
 *
 * Since macOS 15 the Window menu carries the system's tiling items (Window ▸ Move & Resize),
 * bound to fn⌃ arrows (halves) and fn⌃⇧ arrows (arrangements). Apple keyboards turn fn + arrow
 * into Home/End/PageUp/PageDown and pages never see fn, so fn⌃← arrives as Ctrl+Home. Chromium
 * hands a key to the menu before the page only when its fn flag counts, which it never does for
 * arrows and other function keys, so the menu runs these only for a keydown the page leaves
 * unhandled. Widgets would handle them (Monaco scrolls a line on ⌃PageUp/⌃PageDown, xterm sends
 * escape sequences).
 *
 * The letter shortcuts (fn⌃F Fill, fn⌃C Center, fn⌃R Return to Previous Size) are not listed:
 * their menu items match the keystroke with fn, so Chromium hands them to the menu before the
 * page, and plain ⌃F / ⌃C must keep working (forward-char and interrupt in the terminal).
 */

import type { KeyCombo } from "./key-combo";
import { normalizeKeyCombo } from "./key-combo";

/** The macOS release whose Window menu gained the tiling items. */
const FIRST_TILING_MACOS_MAJOR = 15;

const TILING_KEYS = ["Home", "End", "PageUp", "PageDown"];

const TILING_KEYSTROKES: ReadonlySet<KeyCombo> = new Set(
  TILING_KEYS.flatMap((key) => [`Ctrl+${key}`, `Ctrl+Shift+${key}`]).map(normalizeKeyCombo),
);

/**
 * Whether `combo` is a window tiling shortcut on this macOS version (as `process.getSystemVersion()`
 * reports it; undefined off macOS).
 */
export function isMacWindowTilingKeystroke(
  combo: KeyCombo,
  macOSVersion: string | undefined,
): boolean {
  if (!macOSVersion) return false;
  if (Number.parseInt(macOSVersion, 10) < FIRST_TILING_MACOS_MAJOR) return false;
  return TILING_KEYSTROKES.has(combo);
}
