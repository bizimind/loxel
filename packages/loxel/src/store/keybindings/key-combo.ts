/**
 * Key combos and bindings: types, normalization, and conversion from keyboard events.
 *
 * Dependency-free so the Electron main process can normalize webview keystrokes without loading
 * the action registry or binding templates.
 */

// ---------------------------------------------------------------------------
// KeyBinding / KeyCombo types
// ---------------------------------------------------------------------------

/**
 * A normalized binding: one or more keystrokes separated by a single space. More than one
 * keystroke is a chord, e.g. "Cmd+Backslash ArrowRight" (press ⌘\, release, press →).
 */
export type KeyBinding = string & { readonly __keyBinding: unique symbol };

/**
 * A single normalized keystroke: its modifiers in the fixed order Cmd, Ctrl, Alt, Shift, then the
 * key name, joined with "+". Examples: "Cmd+N", "Cmd+Shift+Backtick", "Ctrl+Tab"
 *
 * Every KeyCombo is also a one-step KeyBinding.
 */
export type KeyCombo = KeyBinding & { readonly __keyCombo: unique symbol };

/** Separator between the keystrokes of a chord. Key names never contain spaces ("Space"). */
const STEP_SEPARATOR = " ";

/** Map browser key names to canonical names. */
const KEY_NAME_MAP: Record<string, string> = {
  "`": "Backtick",
  "~": "Backtick",
  "\\": "Backslash",
  "|": "Backslash",
  "[": "BracketLeft",
  "{": "BracketLeft",
  "]": "BracketRight",
  "}": "BracketRight",
  ",": "Comma",
  "<": "Comma",
  ".": "Period",
  ">": "Period",
  "/": "Slash",
  "?": "Slash",
  " ": "Space",
  // Digit aliases
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "+": "Plus",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
};

/**
 * Canonical key names for physical key codes whose `key` macOS rewrites while Option is held
 * (Option+N types "˜", Option+[ types "“"). Letters and digits are handled by pattern.
 */
const OPTION_CODE_MAP: Record<string, string> = {
  Backquote: "Backtick",
  Backslash: "Backslash",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Space: "Space",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
};

/**
 * Normalize a raw key combo string to canonical form.
 * Accepts formats like "Cmd+Shift+`", "Meta+N", "Ctrl+Tab".
 */
export function normalizeKeyCombo(raw: string): KeyCombo {
  const parts = raw.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((m) => m.toLowerCase()));

  const ordered: string[] = [];
  if (mods.has("cmd") || mods.has("meta")) ordered.push("Cmd");
  if (mods.has("ctrl") || mods.has("control")) ordered.push("Ctrl");
  if (mods.has("alt") || mods.has("option")) ordered.push("Alt");
  if (mods.has("shift")) ordered.push("Shift");

  // Normalize key: special chars through KEY_NAME_MAP, single letters to uppercase
  const normalized = KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  ordered.push(normalized);

  return ordered.join("+") as KeyCombo;
}

/**
 * Normalize a raw binding: one combo, or a chord of whitespace-separated combos
 * ("Cmd+\\ ArrowRight").
 */
export function normalizeKeyBinding(raw: string): KeyBinding {
  return toKeyBinding(raw.trim().split(/\s+/).map(normalizeKeyCombo));
}

/** Join keystrokes into a binding. */
export function toKeyBinding(steps: readonly KeyCombo[]): KeyBinding {
  return steps.join(STEP_SEPARATOR) as KeyBinding;
}

/** Split a binding into its keystrokes. */
export function getBindingSteps(binding: KeyBinding): KeyCombo[] {
  return binding.split(STEP_SEPARATOR) as KeyCombo[];
}

/** Whether `prefix` is a strict chord prefix of `binding` (e.g. "Cmd+Backslash" of "Cmd+Backslash T"). */
export function isBindingPrefix(prefix: KeyBinding, binding: KeyBinding): boolean {
  return binding.startsWith(prefix + STEP_SEPARATOR);
}

/**
 * Whether two bindings cannot coexist: they are equal, or one is a chord prefix of the other
 * (pressing the shorter one would be ambiguous).
 */
export function bindingsOverlap(a: KeyBinding, b: KeyBinding): boolean {
  return a === b || isBindingPrefix(a, b) || isBindingPrefix(b, a);
}

/**
 * Resolve the canonical key name. While Option is held macOS reports the composed character in
 * `key` (Option+N types "˜"); only then is the physical `code` used, so layouts that type plain
 * letters and digits keep matching by character.
 */
function canonicalKeyName(key: string, code: string | undefined, alt: boolean): string {
  if (alt && code && !/^[\x20-\x7e]$/.test(key)) {
    const letterOrDigit = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
    if (letterOrDigit) return letterOrDigit[1] ?? letterOrDigit[2]!;
    const mapped = OPTION_CODE_MAP[code];
    if (mapped) return mapped;
  }
  return KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** Build a KeyCombo from individual modifier flags and key identity. */
function buildKeyCombo(
  meta: boolean,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  key: string,
  code: string | undefined,
): KeyCombo {
  const parts: string[] = [];
  if (meta) parts.push("Cmd");
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  parts.push(canonicalKeyName(key, code, alt));
  return parts.join("+") as KeyCombo;
}

/**
 * Convert a KeyboardEvent to a normalized KeyCombo string.
 * Called on every keydown — must be fast.
 */
export function eventToKeyCombo(e: KeyboardEvent): KeyCombo {
  return buildKeyCombo(e.metaKey, e.ctrlKey, e.altKey, e.shiftKey, e.key, e.code);
}

/** Convert an Electron Input (from webContents before-input-event) to a normalized KeyCombo. */
export function inputToKeyCombo(input: {
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}): KeyCombo {
  return buildKeyCombo(input.meta, input.control, input.alt, input.shift, input.key, input.code);
}

/** Whether a key name is a bare modifier press (never a binding on its own). */
export function isModifierKey(key: string): boolean {
  return key === "Meta" || key === "Control" || key === "Alt" || key === "Shift";
}
