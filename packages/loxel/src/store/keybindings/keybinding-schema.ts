/**
 * Keybinding schema: binding templates, display labels, and validation.
 */

import type { ActionId, SplitDirection, SplitPanelType } from "./action-registry";
import { ACTIONS, ACTION_IDS, SPLIT_DIRECTIONS, SPLIT_PANEL_TYPES } from "./action-registry";
import type { KeyBinding } from "./key-combo";
import { bindingsOverlap, normalizeKeyBinding } from "./key-combo";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Maps every action to one or more key bindings. */
export type BindingTemplate = Readonly<Record<ActionId, readonly KeyBinding[]>>;

// Additional templates (vscode, jetbrains) tracked in #493 — add here when real bindings exist.
export type TemplateName = "loxel";

/** Build a BindingTemplate from raw string definitions, normalizing all bindings. */
function buildTemplate(raw: Record<string, readonly string[]>): BindingTemplate {
  const result = {} as Record<ActionId, KeyBinding[]>;
  for (const [actionId, bindings] of Object.entries(raw)) {
    if (!ACTION_IDS.has(actionId as ActionId)) {
      throw new Error(`buildTemplate: unknown action id "${actionId}"`);
    }
    result[actionId as ActionId] = bindings.map(normalizeKeyBinding);
  }
  return result as BindingTemplate;
}

/**
 * Chord leader for split actions: ⌘\ then an arrow splits the active panel, ⌘\ then a panel-type
 * key then an arrow splits as that type, ⌘\ then ⇧+arrow moves the active tab into a new split.
 */
const SPLIT_LEADER = "Cmd+Backslash";

const DIRECTION_KEYS: Record<SplitDirection, string> = {
  right: "ArrowRight",
  left: "ArrowLeft",
  up: "ArrowUp",
  down: "ArrowDown",
};

const SPLIT_TYPE_KEYS: Record<SplitPanelType, string> = {
  terminal: "T",
  agent: "A",
  editor: "M",
  excalidraw: "D",
  browser: "B",
};

const MOVE_TO_NEW_SPLIT_ACTIONS = {
  right: "panel.move.newRight",
  left: "panel.move.newLeft",
  up: "panel.move.newUp",
  down: "panel.move.newDown",
} as const satisfies Record<SplitDirection, ActionId>;

const SPLIT_CHORDS: Record<string, readonly string[]> = Object.fromEntries(
  SPLIT_DIRECTIONS.flatMap((dir) => {
    const arrow = DIRECTION_KEYS[dir];
    return [
      [`panel.split.${dir}`, [`${SPLIT_LEADER} ${arrow}`]],
      [MOVE_TO_NEW_SPLIT_ACTIONS[dir], [`${SPLIT_LEADER} Shift+${arrow}`]],
      ...SPLIT_PANEL_TYPES.map(({ type }) => [
        `panel.split.${type}.${dir}`,
        [`${SPLIT_LEADER} ${SPLIT_TYPE_KEYS[type]} ${arrow}`],
      ]),
    ];
  }),
);

/**
 * Default bindings. Arrow-key layers were picked to avoid macOS text editing, Monaco and common
 * window managers (Rectangle): ⌃⇧+arrow moves focus, ⌃⌘+arrow moves the active tab, and splits
 * live behind the ⌘\ chord.
 */
export const LOXEL_DEFAULT_TEMPLATE: BindingTemplate = buildTemplate({
  "panel.new.terminal": ["Cmd+T", "Ctrl+Shift+Backtick"],
  "panel.new.markdown": ["Cmd+N"],
  "panel.new.drawing": ["Cmd+Shift+D"],
  "panel.new.agent": ["Cmd+Shift+A"],
  "panel.new.browser": ["Cmd+Shift+O"],
  "panel.open.localdb": [],
  "panel.close": ["Cmd+W"],
  ...SPLIT_CHORDS,
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
  // Directional focus navigation: center tabs/groups, side tool bars and the worktree sidebar
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
  "sidebar.worktree.toggle": ["Ctrl+Alt+B"],
  // Context-aware: collapses/expands the worktree sidebar or side zone that holds focus
  "sidebar.toggleFocused": ["Ctrl+Shift+Space"],
  "nav.project": ["Cmd+Alt+P"],
  "nav.worktree": ["Cmd+Alt+W"],
  "nav.commandPalette": ["Cmd+Shift+P"],
  "nav.search": ["Cmd+Shift+F"],
  "nav.openFile": ["Cmd+P"],
  "nav.recentNotification": ["Ctrl+Backtick"],
  "file.revealInExplorer": ["Cmd+Alt+E"],
  // Worktree management
  "worktree.back": ["Ctrl+Alt+BracketLeft"],
  "worktree.forward": ["Ctrl+Alt+BracketRight"],
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
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Backspace: "⌫",
  Delete: "⌦",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a binding template has no ambiguous bindings: no binding is used twice and no
 * binding is a chord prefix of another.
 * Called at module load time for built-in templates and from tests for CI coverage.
 */
export function validateBindings(template: BindingTemplate): void {
  const seen: { binding: KeyBinding; actionId: string }[] = [];
  for (const [actionId, bindings] of Object.entries(template)) {
    for (const binding of bindings) {
      const existing = seen.find((s) => bindingsOverlap(s.binding, binding));
      if (existing) {
        throw new Error(
          `Keybinding conflict: "${binding}" (${actionId}) overlaps "${existing.binding}" (${existing.actionId})`,
        );
      }
      seen.push({ binding, actionId });
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
