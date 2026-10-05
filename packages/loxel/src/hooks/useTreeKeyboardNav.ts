import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useCallback, useRef } from "react";

import { TREE_NAME_ATTR, TREE_PATH_ATTR, TREE_SECTION_ATTR } from "@/components/tree";
import type { ActionId } from "@/store/keybindings/action-registry";
import { eventToKeyCombo } from "@/store/keybindings/key-combo";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";

type TreeActionId = Extract<ActionId, `tree.${string}`>;

const TREE_ACTION_IDS = new Set<TreeActionId>([
  "tree.focusNext",
  "tree.focusPrevious",
  "tree.focusFirstSibling",
  "tree.focusLastSibling",
  "tree.expandOrFocusChild",
  "tree.collapseOrFocusParent",
  "tree.toggleExpanded",
  "tree.open",
  "tree.rename",
]);

export function getTreeActionForEvent(e: ReactKeyboardEvent): TreeActionId | null {
  const actionId = useKeybindingStore
    .getState()
    .lookup.get(eventToKeyCombo(e as unknown as KeyboardEvent));
  if (!isTreeActionId(actionId)) return null;
  return actionId;
}

function isTreeActionId(actionId: ActionId | undefined): actionId is TreeActionId {
  return actionId !== undefined && TREE_ACTION_IDS.has(actionId as TreeActionId);
}

/**
 * Keyboard navigation for tree views using data-tree-* DOM attributes.
 *
 * tree.focusNext: move focus to next visible row
 * tree.focusPrevious: move focus to previous visible row
 * tree.focusFirstSibling / tree.focusLastSibling: move focus to the first / last row in the
 *   focused row's folder
 * tree.expandOrFocusChild: expand collapsed dir, or focus first child of expanded dir
 * tree.collapseOrFocusParent: collapse expanded dir, or focus parent
 * tree.toggleExpanded: toggle dir expand/collapse
 *
 * Typing a character (no Cmd/Ctrl/Alt) moves focus to the next visible row whose name starts
 * with it; characters typed within TYPEAHEAD_RESET_MS of each other build up one prefix, which
 * may include spaces. Any other tree action ends the prefix.
 *
 * Returns a handler that returns `true` if the key was consumed, `false` otherwise.
 * Open/rename actions are NOT handled here — consumers implement them.
 */
export function useTreeKeyboardNav(
  containerRef: RefObject<HTMLElement | null>,
  toggleDir: (path: string) => void,
) {
  const getVisibleButtons = useCallback(() => {
    const container = containerRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll<HTMLButtonElement>(`button[${TREE_PATH_ATTR}]`));
  }, [containerRef]);

  const typeaheadRef = useRef({ query: "", lastKeyAt: 0 });

  /** Type `e`'s character into the type-ahead query. Returns whether it was typed. */
  const handleTypeahead = useCallback(
    (e: React.KeyboardEvent, isTreeAction: boolean) => {
      // Printable characters only: named keys (Tab, Escape, F2, ...) have multi-character names.
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return false;
      const typeahead = typeaheadRef.current;
      const now = Date.now();
      const continuing = typeahead.query !== "" && now - typeahead.lastKeyAt <= TYPEAHEAD_RESET_MS;
      // Names may contain spaces, so a query in progress takes even keys bound to tree actions
      // (Space), but a query never starts with them.
      if (!continuing && (isTreeAction || e.key === " ")) return false;
      typeahead.query = (continuing ? typeahead.query : "") + e.key.toLowerCase();
      typeahead.lastKeyAt = now;

      e.preventDefault();
      const buttons = getVisibleButtons();
      const focused =
        document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
      const names = buttons.map((b) => (b.getAttribute(TREE_NAME_ATTR) ?? "").toLowerCase());
      const match = findTypeaheadMatch(
        names,
        focused ? buttons.indexOf(focused) : -1,
        typeahead.query,
      );
      if (match !== -1) buttons[match]!.focus();
      return true;
    },
    [getVisibleButtons],
  );

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const actionId = getTreeActionForEvent(e);
      if (handleTypeahead(e, actionId !== null)) return true;
      if (!actionId) return false;
      // Navigating otherwise ends the query: the next character starts a new one.
      typeaheadRef.current.query = "";
      if (actionId === "tree.open" || actionId === "tree.rename") return false;

      e.preventDefault();
      const buttons = getVisibleButtons();
      if (buttons.length === 0) return true;
      const focused =
        document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
      const idx = focused ? buttons.indexOf(focused) : -1;

      switch (actionId) {
        case "tree.focusNext":
          buttons[idx + 1]?.focus();
          break;
        case "tree.focusPrevious":
          buttons[idx - 1]?.focus();
          break;
        case "tree.focusFirstSibling":
        case "tree.focusLastSibling": {
          if (idx === -1) break;
          const [first, last] = siblingRange(buttons, idx);
          buttons[actionId === "tree.focusFirstSibling" ? first : last]!.focus();
          break;
        }
        case "tree.expandOrFocusChild": {
          if (!focused) break;
          const isDir = focused.hasAttribute("data-tree-dir");
          if (!isDir) break;
          const isExpanded = focused.hasAttribute("data-tree-expanded");
          if (!isExpanded) {
            const path = focused.getAttribute(TREE_PATH_ATTR);
            if (path !== null) toggleDir(path);
          } else {
            buttons[idx + 1]?.focus();
          }
          break;
        }
        case "tree.collapseOrFocusParent": {
          if (!focused) break;
          const isDir = focused.hasAttribute("data-tree-dir");
          const isExpanded = focused.hasAttribute("data-tree-expanded");
          if (isDir && isExpanded) {
            const path = focused.getAttribute(TREE_PATH_ATTR);
            if (path !== null) toggleDir(path);
          } else {
            const depth = rowDepth(focused);
            for (let i = idx - 1; i >= 0; i--) {
              if (rowDepth(buttons[i]!) < depth) {
                buttons[i]!.focus();
                break;
              }
            }
          }
          break;
        }
        case "tree.toggleExpanded": {
          if (!focused) break;
          const isDir = focused.hasAttribute("data-tree-dir");
          if (isDir) {
            const path = focused.getAttribute(TREE_PATH_ATTR);
            if (path !== null) toggleDir(path);
          }
          break;
        }
        default:
          break;
      }
      return true;
    },
    [getVisibleButtons, toggleDir, handleTypeahead],
  );

  return handleTreeKeyDown;
}

const TYPEAHEAD_RESET_MS = 500;

const rowDepth = (row: HTMLElement) => Number(row.getAttribute("data-tree-depth") ?? 0);

const rowSection = (row: HTMLElement) => row.closest(`[${TREE_SECTION_ATTR}]`);

/**
 * Indexes of the first and last rows in the same folder as `rows[idx]`: the rows at its depth
 * in the contiguous run of rows at least as deep around it (deeper rows are expanded children),
 * within its section (root rows of other sections are not its siblings).
 */
function siblingRange(rows: HTMLElement[], idx: number): [number, number] {
  const depth = rowDepth(rows[idx]!);
  const section = rowSection(rows[idx]!);
  const inRun = (row: HTMLElement) => rowDepth(row) >= depth && rowSection(row) === section;
  let first = idx;
  for (let i = idx - 1; i >= 0 && inRun(rows[i]!); i--) {
    if (rowDepth(rows[i]!) === depth) first = i;
  }
  let last = idx;
  for (let i = idx + 1; i < rows.length && inRun(rows[i]!); i++) {
    if (rowDepth(rows[i]!) === depth) last = i;
  }
  return [first, last];
}

/**
 * Index of the row to focus for a type-ahead `query` (lowercase), or -1 when no name starts with
 * it. Searching wraps around. A run of one character ("a", "aaa") searches for that character from
 * the row after `current`, so repeating a key steps through the names starting with it; any other
 * prefix searches from `current`, keeping the current row while it still matches.
 */
export function findTypeaheadMatch(names: string[], current: number, query: string): number {
  const search = (prefix: string, start: number) => {
    for (let i = 0; i < names.length; i++) {
      const idx = (start + i) % names.length;
      if (names[idx]!.startsWith(prefix)) return idx;
    }
    return -1;
  };
  const char = query[0]!;
  if (query === char.repeat(query.length)) return search(char, current + 1);
  return search(query, Math.max(current, 0));
}
