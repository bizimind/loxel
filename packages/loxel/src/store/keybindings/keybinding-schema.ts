/**
 * Keybinding schema: KeyCombo type, normalization, templates, and validation.
 */

import type { ActionId } from "./action-registry";
import { ACTIONS, ACTION_IDS } from "./action-registry";

// ---------------------------------------------------------------------------
// KeyCombo type
// ---------------------------------------------------------------------------

/**
 * A normalized key combo string. Format: "Cmd+Ctrl+Alt+Shift+Key"
 * Modifiers appear in fixed order, then the key name.
 * Examples: "Cmd+N", "Cmd+Shift+Backtick", "Ctrl+Tab"
 */
export type KeyCombo = string & { readonly __brand: unique symbol };

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

/** Build a KeyCombo from individual modifier flags and a key name. */
function buildKeyCombo(
  meta: boolean,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  key: string,
): KeyCombo {
  const parts: string[] = [];
  if (meta) parts.push("Cmd");
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  const normalized = KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  parts.push(normalized);
  return parts.join("+") as KeyCombo;
}

/**
 * Convert a KeyboardEvent to a normalized KeyCombo string.
 * Called on every keydown — must be fast.
 */
export function eventToKeyCombo(e: KeyboardEvent): KeyCombo {
  return buildKeyCombo(e.metaKey, e.ctrlKey, e.altKey, e.shiftKey, e.key);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Maps every action to one or more key combos. */
export type BindingTemplate = Readonly<Record<ActionId, readonly KeyCombo[]>>;

// Additional templates (vscode, jetbrains) tracked in #493 — add here when real bindings exist.
export type TemplateName = "loxel";

/** Build a BindingTemplate from raw string definitions, normalizing all combos. */
function buildTemplate(raw: Record<string, readonly string[]>): BindingTemplate {
  const result = {} as Record<ActionId, KeyCombo[]>;
  for (const [actionId, combos] of Object.entries(raw)) {
    if (!ACTION_IDS.has(actionId as ActionId)) {
      throw new Error(`buildTemplate: unknown action id "${actionId}"`);
    }
    result[actionId as ActionId] = combos.map(normalizeKeyCombo);
  }
  return result as BindingTemplate;
}

export const LOXEL_DEFAULT_TEMPLATE: BindingTemplate = buildTemplate({
  "panel.new.terminal": ["Cmd+T", "Ctrl+Shift+Backtick"],
  "panel.new.markdown": ["Cmd+N"],
  "panel.new.drawing": ["Cmd+Shift+D"],
  "panel.new.agent": ["Cmd+Shift+A"],
  "panel.new.browser": ["Cmd+Shift+O"],
  "panel.open.localdb": [],
  "panel.close": ["Cmd+W"],
  "panel.split.right": ["Cmd+Backslash"],
  "panel.split.down": ["Cmd+Shift+Backslash"],
  "panel.next": ["Cmd+Shift+BracketRight", "Ctrl+Tab"],
  "panel.prev": ["Cmd+Shift+BracketLeft", "Ctrl+Shift+Tab"],
  "panel.focus.1": ["Cmd+1"],
  "panel.focus.2": ["Cmd+2"],
  "panel.focus.3": ["Cmd+3"],
  "panel.focus.4": ["Cmd+4"],
  "panel.focus.5": ["Cmd+5"],
  "panel.focus.6": ["Cmd+6"],
  "panel.focus.7": ["Cmd+7"],
  "panel.focus.8": ["Cmd+8"],
  "panel.focus.9": ["Cmd+9"],
  // Panel move to existing group (fallback: new split)
  "panel.move.groupRight": ["Ctrl+Cmd+ArrowRight"],
  "panel.move.groupLeft": ["Ctrl+Cmd+ArrowLeft"],
  "panel.move.groupUp": ["Ctrl+Cmd+ArrowUp"],
  "panel.move.groupDown": ["Ctrl+Cmd+ArrowDown"],
  // Panel move to new split
  "panel.move.newRight": ["Ctrl+Cmd+Shift+ArrowRight"],
  "panel.move.newLeft": ["Ctrl+Cmd+Shift+ArrowLeft"],
  "panel.move.newUp": ["Ctrl+Cmd+Shift+ArrowUp"],
  "panel.move.newDown": ["Ctrl+Cmd+Shift+ArrowDown"],
  // Directional focus navigation
  "panel.focus.right": ["Ctrl+Shift+ArrowRight"],
  "panel.focus.left": ["Ctrl+Shift+ArrowLeft"],
  "panel.focus.up": ["Ctrl+Shift+ArrowUp"],
  "panel.focus.down": ["Ctrl+Shift+ArrowDown"],
  "toggle.projectFiles": ["Cmd+Shift+E"],
  "toggle.changes": ["Cmd+Shift+C"],
  "toggle.git": ["Ctrl+Shift+G"],
  "toggle.comments": ["Ctrl+Shift+R"],
  "toggle.logs": ["Ctrl+Shift+L"],
  "toggle.forkTree": ["Ctrl+Shift+K"],
  "sidebar.project.toggle": ["Cmd+Shift+B"],
  "sidebar.worktree.toggle": ["Cmd+Alt+B"],
  "nav.project": ["Cmd+Alt+P"],
  "nav.worktree": ["Cmd+Alt+W"],
  "nav.commandPalette": ["Cmd+Shift+P"],
  "nav.search": ["Cmd+Shift+F"],
  "nav.openFile": ["Cmd+P"],
  "nav.recentNotification": ["Ctrl+Backtick"],
  "file.revealInExplorer": ["Cmd+Alt+E"],
  // Worktree management
  "worktree.next": ["Ctrl+Alt+ArrowRight"],
  "worktree.prev": ["Ctrl+Alt+ArrowLeft"],
  "worktree.new": ["Ctrl+Alt+N"],
  "worktree.delete": ["Ctrl+Alt+Backspace"],
  "worktree.focus.1": ["Ctrl+Alt+1"],
  "worktree.focus.2": ["Ctrl+Alt+2"],
  "worktree.focus.3": ["Ctrl+Alt+3"],
  "worktree.focus.4": ["Ctrl+Alt+4"],
  "worktree.focus.5": ["Ctrl+Alt+5"],
  "worktree.focus.6": ["Ctrl+Alt+6"],
  "worktree.focus.7": ["Ctrl+Alt+7"],
  "worktree.focus.8": ["Ctrl+Alt+8"],
  "worktree.focus.9": ["Ctrl+Alt+9"],
  "worktree.focus.0": ["Ctrl+Alt+0"],
  // Tree-local actions. The global keybinding listener ignores these; tree panels resolve them
  // when focus is inside the tree.
  "tree.focusNext": ["ArrowDown"],
  "tree.focusPrevious": ["ArrowUp"],
  "tree.expandOrFocusChild": ["ArrowRight"],
  "tree.collapseOrFocusParent": ["ArrowLeft"],
  "tree.toggleExpanded": ["Space"],
  "tree.open": ["Enter"],
  "tree.rename": ["F2", "Shift+F6"],
  "app.settings": ["Cmd+Comma"],
});

export const TEMPLATES: Record<TemplateName, BindingTemplate> = { loxel: LOXEL_DEFAULT_TEMPLATE };

export const TEMPLATE_LABELS: Record<TemplateName, string> = { loxel: "Loxel Default" };

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Canonical display labels for non-modifier key names. Single source of truth. */
export const KEY_LABELS: Record<string, string> = {
  Backtick: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Plus: "+",
  Space: "Space",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
  Enter: "\u23CE",
  Backspace: "\u232B",
  Delete: "\u2326",
};

/** Modifier Unicode symbols + key labels for text-only display (e.g. logging). */
const DISPLAY_MAP: Record<string, string> = {
  Cmd: "\u2318",
  Ctrl: "\u2303",
  Alt: "\u2325",
  Shift: "\u21E7",
  ...KEY_LABELS,
};

/** Convert an Electron Input (from webview before-input-event) to a normalized KeyCombo. */
export function inputToKeyCombo(input: {
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}): KeyCombo {
  return buildKeyCombo(input.meta, input.control, input.alt, input.shift, input.key);
}

/** Format a KeyCombo for display (e.g. "Cmd+Shift+Backtick" -> "\u2318\u21E7`"). */
export function formatKeyCombo(combo: KeyCombo): string {
  return (combo as string)
    .split("+")
    .map((part) => DISPLAY_MAP[part] ?? part)
    .join("");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a binding template has no duplicate key combos.
 * Called at module load time for built-in templates and from tests for CI coverage.
 */
export function validateBindings(template: BindingTemplate): void {
  const seen = new Map<KeyCombo, string>();
  for (const [actionId, combos] of Object.entries(template)) {
    for (const combo of combos) {
      const existing = seen.get(combo);
      if (existing) {
        throw new Error(
          `Keybinding conflict: "${combo}" is bound to both "${existing}" and "${actionId}"`,
        );
      }
      seen.set(combo, actionId);
    }
  }
}

/** Validate that a template covers all actions from the registry. */
export function validateCoverage(template: BindingTemplate): string[] {
  const covered = new Set(Object.keys(template));
  return ACTIONS.filter((a) => !covered.has(a.id)).map((a) => a.id);
}

// Module-level validation — a duplicate in a built-in template is a programmer error.
// The test suite (keybinding-validation.test.ts) also provides a CI gate.
for (const [, template] of Object.entries(TEMPLATES)) {
  validateBindings(template);
}
