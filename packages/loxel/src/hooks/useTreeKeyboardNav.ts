import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { useCallback } from "react";

import type { ActionId } from "@/store/keybindings/action-registry";

import { TREE_PATH_ATTR } from "@/components/tree";
import { eventToKeyCombo } from "@/store/keybindings/keybinding-schema";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";

type TreeActionId = Extract<ActionId, `tree.${string}`>;

const TREE_ACTION_IDS = new Set<TreeActionId>([
  "tree.focusNext",
  "tree.focusPrevious",
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
 * tree.expandOrFocusChild: expand collapsed dir, or focus first child of expanded dir
 * tree.collapseOrFocusParent: collapse expanded dir, or focus parent
 * tree.toggleExpanded: toggle dir expand/collapse
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

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const actionId = getTreeActionForEvent(e);
      if (!actionId) return false;
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
            const depth = Number(focused.getAttribute("data-tree-depth") ?? 0);
            for (let i = idx - 1; i >= 0; i--) {
              const d = Number(buttons[i]!.getAttribute("data-tree-depth") ?? 0);
              if (d < depth) {
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
    [getVisibleButtons, toggleDir],
  );

  return handleTreeKeyDown;
}
