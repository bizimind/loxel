/**
 * Canonical action registry — single source of truth for all app actions.
 * Used by the keybinding system, future command palette, and toolbar buttons.
 */

/**
 * All action IDs in the application. Adding an action here automatically
 * makes it available for keybinding and command palette lookup.
 */
export type ActionId =
  | "panel.new.terminal"
  | "panel.new.markdown"
  | "panel.new.drawing"
  | "panel.new.agent"
  | "panel.new.browser"
  | "panel.open.localdb"
  | "panel.close"
  | "panel.split.right"
  | "panel.split.down"
  | "panel.next"
  | "panel.prev"
  | "panel.focus.1"
  | "panel.focus.2"
  | "panel.focus.3"
  | "panel.focus.4"
  | "panel.focus.5"
  | "panel.focus.6"
  | "panel.focus.7"
  | "panel.focus.8"
  | "panel.focus.9"
  | "panel.move.groupRight"
  | "panel.move.groupLeft"
  | "panel.move.groupUp"
  | "panel.move.groupDown"
  | "panel.move.newRight"
  | "panel.move.newLeft"
  | "panel.move.newUp"
  | "panel.move.newDown"
  | "panel.focus.right"
  | "panel.focus.left"
  | "panel.focus.up"
  | "panel.focus.down"
  | "toggle.projectFiles"
  | "toggle.changes"
  | "toggle.git"
  | "toggle.comments"
  | "toggle.logs"
  | "toggle.forkTree"
  | "nav.project"
  | "nav.worktree"
  | "nav.commandPalette"
  | "nav.search"
  | "nav.openFile"
  | "nav.recentNotification"
  | "sidebar.project.toggle"
  | "sidebar.worktree.toggle"
  | "worktree.next"
  | "worktree.prev"
  | "worktree.new"
  | "worktree.delete"
  | "worktree.focus.1"
  | "worktree.focus.2"
  | "worktree.focus.3"
  | "worktree.focus.4"
  | "worktree.focus.5"
  | "worktree.focus.6"
  | "worktree.focus.7"
  | "worktree.focus.8"
  | "worktree.focus.9"
  | "worktree.focus.0"
  | "file.revealInExplorer"
  | "tree.focusNext"
  | "tree.focusPrevious"
  | "tree.expandOrFocusChild"
  | "tree.collapseOrFocusParent"
  | "tree.toggleExpanded"
  | "tree.open"
  | "tree.rename"
  | "app.settings";

export type ActionCategory = "panel" | "toggle" | "nav" | "sidebar" | "worktree" | "tree" | "app";

export interface ActionDef {
  id: ActionId;
  label: string;
  category: ActionCategory;
  /** If present and returns true, this action is hidden from the command palette. Evaluated at render time. */
  hidden?: () => boolean;
}

/**
 * Canonical action definitions. Order determines command palette display order.
 * Derived lookups (by id, by category) are built below.
 */
export const ACTIONS: readonly ActionDef[] = [
  // Panel creation
  { id: "panel.new.terminal", label: "New Terminal", category: "panel" },
  { id: "panel.new.markdown", label: "New Markdown Editor", category: "panel" },
  { id: "panel.new.drawing", label: "New Drawing", category: "panel" },
  { id: "panel.new.agent", label: "New Agent", category: "panel" },
  { id: "panel.new.browser", label: "New Browser", category: "panel" },
  { id: "panel.open.localdb", label: "Open Database", category: "panel" },

  // Panel management
  { id: "panel.close", label: "Close Panel", category: "panel" },
  { id: "panel.split.right", label: "Split Right", category: "panel" },
  { id: "panel.split.down", label: "Split Down", category: "panel" },
  { id: "panel.next", label: "Next Panel", category: "panel" },
  { id: "panel.prev", label: "Previous Panel", category: "panel" },
  { id: "panel.focus.1", label: "Focus Panel 1", category: "panel" },
  { id: "panel.focus.2", label: "Focus Panel 2", category: "panel" },
  { id: "panel.focus.3", label: "Focus Panel 3", category: "panel" },
  { id: "panel.focus.4", label: "Focus Panel 4", category: "panel" },
  { id: "panel.focus.5", label: "Focus Panel 5", category: "panel" },
  { id: "panel.focus.6", label: "Focus Panel 6", category: "panel" },
  { id: "panel.focus.7", label: "Focus Panel 7", category: "panel" },
  { id: "panel.focus.8", label: "Focus Panel 8", category: "panel" },
  { id: "panel.focus.9", label: "Focus Panel 9", category: "panel" },

  // Panel movement — to existing adjacent group
  { id: "panel.move.groupRight", label: "Move to Group Right", category: "panel" },
  { id: "panel.move.groupLeft", label: "Move to Group Left", category: "panel" },
  { id: "panel.move.groupUp", label: "Move to Group Above", category: "panel" },
  { id: "panel.move.groupDown", label: "Move to Group Below", category: "panel" },

  // Panel movement — always create new split
  { id: "panel.move.newRight", label: "Move to New Split Right", category: "panel" },
  { id: "panel.move.newLeft", label: "Move to New Split Left", category: "panel" },
  { id: "panel.move.newUp", label: "Move to New Split Above", category: "panel" },
  { id: "panel.move.newDown", label: "Move to New Split Below", category: "panel" },

  // Directional focus navigation
  { id: "panel.focus.right", label: "Focus Right (Tab or Group)", category: "panel" },
  { id: "panel.focus.left", label: "Focus Left (Tab or Group)", category: "panel" },
  { id: "panel.focus.up", label: "Focus Group Above", category: "panel" },
  { id: "panel.focus.down", label: "Focus Group Below", category: "panel" },

  // Sidebar panel toggles
  { id: "toggle.projectFiles", label: "Toggle Project Files", category: "toggle" },
  { id: "toggle.changes", label: "Toggle Changes", category: "toggle" },
  { id: "toggle.git", label: "Toggle Git", category: "toggle" },
  { id: "toggle.comments", label: "Toggle Comments", category: "toggle" },
  { id: "toggle.logs", label: "Toggle Logs", category: "toggle" },
  { id: "toggle.forkTree", label: "Toggle Fork Tree", category: "toggle" },

  // Navigation
  { id: "nav.project", label: "Switch Project", category: "nav" },
  { id: "nav.worktree", label: "Switch Worktree", category: "nav" },
  { id: "nav.commandPalette", label: "Command Palette", category: "nav", hidden: () => true },
  { id: "nav.search", label: "Find in Files", category: "nav" },
  { id: "nav.openFile", label: "Open File", category: "nav" },
  { id: "nav.recentNotification", label: "Go to Recent Notification", category: "nav" },

  // Sidebar collapse
  { id: "sidebar.project.toggle", label: "Toggle Project Sidebar", category: "sidebar" },
  { id: "sidebar.worktree.toggle", label: "Toggle Worktree Sidebar", category: "sidebar" },

  // Worktree management
  { id: "worktree.next", label: "Next Worktree", category: "worktree" },
  { id: "worktree.prev", label: "Previous Worktree", category: "worktree" },
  { id: "worktree.new", label: "New Worktree", category: "worktree" },
  { id: "worktree.delete", label: "Delete Worktree", category: "worktree" },
  { id: "worktree.focus.1", label: "Focus Worktree 1", category: "worktree" },
  { id: "worktree.focus.2", label: "Focus Worktree 2", category: "worktree" },
  { id: "worktree.focus.3", label: "Focus Worktree 3", category: "worktree" },
  { id: "worktree.focus.4", label: "Focus Worktree 4", category: "worktree" },
  { id: "worktree.focus.5", label: "Focus Worktree 5", category: "worktree" },
  { id: "worktree.focus.6", label: "Focus Worktree 6", category: "worktree" },
  { id: "worktree.focus.7", label: "Focus Worktree 7", category: "worktree" },
  { id: "worktree.focus.8", label: "Focus Worktree 8", category: "worktree" },
  { id: "worktree.focus.9", label: "Focus Last Worktree", category: "worktree" },
  { id: "worktree.focus.0", label: "Focus Worktree 10", category: "worktree" },

  // File
  { id: "file.revealInExplorer", label: "Reveal in Project Explorer", category: "nav" },

  // Tree — handled locally by tree components, not shown in command palette
  { id: "tree.focusNext", label: "Tree: Focus Next Row", category: "tree", hidden: () => true },
  {
    id: "tree.focusPrevious",
    label: "Tree: Focus Previous Row",
    category: "tree",
    hidden: () => true,
  },
  {
    id: "tree.expandOrFocusChild",
    label: "Tree: Expand or Focus Child",
    category: "tree",
    hidden: () => true,
  },
  {
    id: "tree.collapseOrFocusParent",
    label: "Tree: Collapse or Focus Parent",
    category: "tree",
    hidden: () => true,
  },
  { id: "tree.toggleExpanded", label: "Tree: Toggle Folder", category: "tree", hidden: () => true },
  { id: "tree.open", label: "Tree: Open", category: "tree", hidden: () => true },
  { id: "tree.rename", label: "Tree: Rename", category: "tree", hidden: () => true },

  // App
  { id: "app.settings", label: "Open Settings", category: "app" },
];

// --- Derived lookups ---

const actionDefMap = new Map<ActionId, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function getActionDef(id: ActionId): ActionDef | undefined {
  return actionDefMap.get(id);
}

export function getActionsByCategory(category: ActionCategory): ActionDef[] {
  return ACTIONS.filter((a) => a.category === category);
}

/** All action IDs as a set, for fast membership checks. */
export const ACTION_IDS = new Set<ActionId>(ACTIONS.map((a) => a.id));
